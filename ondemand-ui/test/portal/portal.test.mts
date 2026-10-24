import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * On-demand UI as Pithagoras runs it: its server half started by the portal's own extension host from its source,
 * its tools in a real pi with the portal's own client, a scripted model (core's fake-model), the portal's session
 * manager carrying a card's event to the chat (`chats.tell`, its pi's bus, `pi.sendMessage`), and the portal's routes in
 * front of the extension's. Against the Pithagoras this repository builds with: fetch and build it with
 * scripts/pithagoras.sh, then PITHAGORAS_DIR=.pithagoras npm run test:portal.
 */

const DIR = process.env.PITHAGORAS_DIR;
if (!DIR) throw new Error("PITHAGORAS_DIR is not set: run scripts/pithagoras.sh, then PITHAGORAS_DIR=.pithagoras npm run test:portal");
const PITHAGORAS = path.resolve(DIR);
const from = (file: string) => pathToFileURL(path.join(PITHAGORAS, file)).href;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, "../..");

const { inProcessHome } = await import(from("tests/helpers.mts"));
const home = inProcessHome("odui-portal-");
process.env.PORTAL_PASSWORD = "";
process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
process.env.EXECUTOR = "host";
mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });

/** What the model does at each request: the test in hand says. */
let script: (request: any) => unknown = () => "Done.";
const { fakeModel, resultsIn } = await import(from("core/server/test/fake-model.mjs"));
const model = await fakeModel((request: any) => script(request));
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify(model.models()));

const host = await import(from("core/server/dist/extension-host.js"));
const db = await import(from("core/server/dist/db.js"));
const { sessions } = await import(from("core/server/dist/session-manager.js"));
const { SdkPiClient } = await import(from("core/server/dist/pi/sdk-client.js"));
const { buildTranscript } = await import(from("core/web/src/transcript.ts"));
db.getDb();
db.setSettings({ ...db.getSettings(), provider: "fake", model: "m" });

const meta = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
const own = { name: meta.name, version: meta.version, file: path.join(PACKAGE, "src/server.ts"), rev: meta.version };
await host.syncServerHalves([own]);

const express = (await import(pathToFileURL(path.join(PITHAGORAS, "node_modules/express/index.js")).href)).default;
const server = http.createServer(express().use("/api/x", host.extensionRoutes));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/x/%40pithagoras/ondemand-ui`;
after(async () => {
  await host.stopServerHalves();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** A request of the portal's own pages: from its origin. */
const json = async (url: string, init?: RequestInit) => {
  const answer = await fetch(url, { ...init, headers: { "content-type": "application/json", origin: new URL(at).origin, ...init?.headers } });
  return { status: answer.status, body: await answer.json().catch(() => null) };
};
const chat = () => {
  const id = `odui-${Math.random().toString(36).slice(2)}`;
  db.createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind: "task" });
  latest = id;
  return id;
};
async function until(check: () => unknown | Promise<unknown>, what: string, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await delay(20)) if (await check()) return;
  assert.fail(`timed out waiting for ${what} (${JSON.stringify(standing())})`);
}
/** The chat of the test in hand, and how it stands: said when a wait times out. */
let latest = "";
const standing = () => ({ status: db.getSession(latest)?.status, running: latest && sessions.isRunning(latest), err: db.getSession(latest)?.last_error, requests: model.requests.length, unexpected: model.unexpected });
const cards = async (id: string) => (await json(`${at}/chats/${id}/cards`)).body?.cards ?? [];
/** As the portal tells the extensions (`chats.get(id).status`): the chat's run is over. */
const idle = (id: string) => db.getSession(id)?.status === "idle";
const lastUser = (request: any) => JSON.stringify(request.messages.filter((m: any) => m.role === "user").at(-1)?.content ?? "");
const said = (request: any) => JSON.stringify(request.messages);
const HTML = '<button onclick="pithagoras.emit(\'submit\', {answer: 42})" class="primary">Done</button>';

test("the tools are registered in a chat's pi, filed under the package", async () => {
  const id = chat();
  const found: string[] = [];
  for (const { name, factory } of host.hostExtensions(id)) if (name === meta.name) factory({ registerTool: (t: any) => found.push(t.name), on() {}, events: { on() {} } });
  assert.deepEqual(found.sort(), ["ui_close", "ui_show", "ui_update"]);
  const client = await SdkPiClient.create({ cwd: process.env.WORKSPACE_ROOT, sessionDir: mkdtempSync(path.join(home, "pi-")), provider: "fake", modelId: "m", sessionId: id });
  try {
    const tools = (await client.getTools()).filter((t: any) => t.name.startsWith("ui_"));
    assert.deepEqual(Object.fromEntries(tools.map((t: any) => [t.name, t.source])), { ui_close: meta.name, ui_show: meta.name, ui_update: meta.name });
  } finally {
    client.dispose();
  }
});

test("a card made by a call is served through the portal's routes in its frame, and its events only from the portal's pages", async () => {
  const id = chat();
  let show: any;
  for (const { name, factory } of host.hostExtensions(id)) if (name === meta.name) factory({ registerTool: (t: any) => t.name === "ui_show" && (show = t), on() {}, events: { on() {} } });
  const result = await show.execute("call-1", { title: "Pick", html: HTML, events: { submit: {} } });
  assert.match(result.content[0].text, /^Card c1 \("Pick"\) is open/);
  const frame = await fetch(`${at}/frame/${id}/c1?n=abcdefgh12&o=${encodeURIComponent("http://portal.test")}`);
  assert.equal(frame.status, 200);
  assert.match(frame.headers.get("content-security-policy")!, /^sandbox allow-scripts allow-forms; default-src 'none'.*frame-src 'none'; frame-ancestors 'self'$/);
  assert.match(await frame.text(), /srcdoc="[^"]*pithagoras\.emit/);
  assert.equal((await json(`${at}/chats/${id}/cards/c1/events`, { method: "POST", body: JSON.stringify({ event: "submit", data: 1 }), headers: { origin: "http://elsewhere.example" } })).status, 403);
  assert.deepEqual((await json(`${at}/chats/${id}/cards/c1/events`, { method: "POST", body: JSON.stringify({ event: "submit", data: 1 }) })).body, { delivery: "queued" });
});

test("an event marked wake reaches the idle chat as a message that starts the agent's turn, shown as one line", async () => {
  const id = chat();
  script = (request) => (lastUser(request).includes("Show me") && resultsIn(request) === 0 ? { name: "ui_show", args: { title: "Pick", html: HTML, events: { submit: { wake: true } } } } : "Done.");
  await sessions.prompt(id, "Show me a card");
  await until(async () => (await cards(id)).length === 1 && idle(id), "the card, and the run to end");
  const before = model.requests.length;

  assert.deepEqual((await json(`${at}/chats/${id}/cards/c1/events`, { method: "POST", body: JSON.stringify({ event: "submit", data: { answer: 42 } }) })).body, { delivery: "wake" });
  await until(() => model.requests.length > before, "the turn the event starts");
  const request = model.requests.at(-1);
  assert.match(said(request), /UI: Pick · submit/);
  assert.match(said(request), /name=\\"submit\\">\{\\"answer\\":42\}/);
  assert.match(said(request), /the person's own input through the card/);
  await until(() => idle(id), "the turn to end");

  // The portal's transcript of the chat: the message is a notice, its one line.
  const events = db.getDb().prepare("SELECT seq, type, payload FROM events WHERE session_id = ? ORDER BY seq").all(id).map((r: any) => ({ seq: r.seq, type: r.type, payload: JSON.parse(r.payload) }));
  const notices = buildTranscript(events).filter((i: any) => i.kind === "notice").map((i: any) => i.text);
  assert.deepEqual(notices, ["UI: Pick · submit"]);
});

test("an ordinary event while the chat is idle starts nothing, and goes in with the person's next message", async () => {
  const id = chat();
  script = (request) => (lastUser(request).includes("Show me") && resultsIn(request) === 0 ? { name: "ui_show", args: { title: "Colours", html: HTML, events: { submit: {} } } } : "Done.");
  await sessions.prompt(id, "Show me a card");
  await until(async () => (await cards(id)).length === 1 && idle(id), "the card, and the run to end");
  const before = model.requests.length;
  assert.deepEqual((await json(`${at}/chats/${id}/cards/c1/events`, { method: "POST", body: JSON.stringify({ event: "submit", data: { answer: 7 } }) })).body, { delivery: "queued" });
  await delay(800);
  assert.equal(model.requests.length, before, "no turn");
  await sessions.prompt(id, "What did I pick?");
  await until(() => model.requests.length > before, "the next turn");
  const request = model.requests.at(-1);
  assert.match(said(request), /What did I pick\?/);
  assert.match(said(request), /UI: Colours · submit/);
  assert.match(said(request), /\{\\"answer\\":7\}/);
  await until(() => idle(id), "the turn to end");
});

test("ui_show with wait returns the event the card sends, to the model, in the same run", async () => {
  const id = chat();
  script = (request) => (lastUser(request).includes("Ask me") && resultsIn(request) === 0 ? { name: "ui_show", args: { title: "Question", html: HTML, wait: { event: "submit", timeoutSec: 60 } } } : "Thanks.");
  await sessions.prompt(id, "Ask me something");
  await until(async () => (await cards(id)).length === 1, "the card");
  assert.equal(db.getSession(id)?.status, "running", "the run waits on it");
  const before = model.requests.length;
  assert.deepEqual((await json(`${at}/chats/${id}/cards/c1/events`, { method: "POST", body: JSON.stringify({ event: "submit", data: { answer: 42 } }) })).body, { delivery: "wait" });
  await until(() => model.requests.length > before, "the run to go on");
  const tool = model.requests.at(-1).messages.find((m: any) => m.role === "tool");
  assert.match(JSON.stringify(tool.content), /The person sent \\"submit\\" from card c1 \(\\"Question\\"\)/);
  assert.match(JSON.stringify(tool.content), /\{\\"answer\\":42\}/);
  await until(() => idle(id), "the run to end");
});

test("lazy, through the tools gateway, ui_show waits and returns the same, and its card is drawn at the gateway's call", async () => {
  const id = chat();
  const calls = [{ name: "tools", args: { action: "call", name: "ui_show", args: { title: "Lazy", html: HTML, wait: { event: "submit", timeoutSec: 60 } } } }];
  script = (request) => calls[resultsIn(request)] ?? "Done.";
  const client = await SdkPiClient.create({ cwd: process.env.WORKSPACE_ROOT, sessionDir: mkdtempSync(path.join(home, "pi-")), provider: "fake", modelId: "m", sessionId: id, toolsLazy: ["ui_show", "ui_update", "ui_close"], lazySets: [meta.name] });
  const starts: any[] = [];
  const ends: any[] = [];
  client.on("event", (e: any) => {
    if (e?.type === "tool_execution_start") starts.push(e);
    if (e?.type === "tool_execution_end") ends.push(e);
  });
  try {
    const offered = new Set<string>();
    const before = model.requests.length;
    const running = client.prompt("Ask me lazily");
    await until(async () => (await cards(id)).length === 1, "the card");
    for (const r of model.requests.slice(before)) for (const t of r.tools ?? []) offered.add(t.function.name);
    assert.ok(offered.has("tools") && !offered.has("ui_show"), "ui_show is reached through the gateway alone");
    const [card] = await cards(id);
    assert.equal(card.callId, starts.find((s) => s.toolName === "tools").toolCallId, "the card is the gateway call's");
    assert.deepEqual((await json(`${at}/chats/${id}/cards/c1/events`, { method: "POST", body: JSON.stringify({ event: "submit", data: { answer: 5 } }) })).body, { delivery: "wait" });
    await running;
    await until(() => ends.some((e) => e.toolName === "tools"), "the call to end");
    assert.match(JSON.stringify(ends.find((e) => e.toolName === "tools").result), /The person sent \\"submit\\" from card c1/);
  } finally {
    client.dispose();
  }
});
