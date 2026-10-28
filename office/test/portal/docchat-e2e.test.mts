import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Frame, type Page } from "@playwright/test";
import { EDITOR_HTML, editorPageJs } from "./page.mts";

/**
 * Comments and the editor's chat as the way to talk to agents, end to end in the real Document Server 10.0.0.1: the
 * Office page's editor (office-editor.tsx with its docchat hook) for the people, the server half with its routes, its
 * agents' editors and docchat, and a stand-in for the portal's chats (the child chats, their prompts and answers),
 * which docchat is given in place of the portal's. What the model does in a real chat is test:real's.
 * - A comment with a picked mention makes one chat for the agent; its answer shows as the agent's reply in the people's
 *   editors; a reply in the thread goes to the same chat; resolve keeps it; the comment deleted, its chat goes after
 *   the grace; the agent's edit of a larger text keeps the comment and its thread.
 * - A message in the editor's chat makes the session's chat; its answer comes in the editor's chat as the agent's; the
 *   last person gone, the chat goes after its time.
 * - A spreadsheet's cell comment, the same.
 *
 * Opt-in like e2e.test.mts (OFFICE_E2E=1 and PITHAGORAS_DIR), with names of its own (`office-docchat-e2e…`).
 */

const DIR = process.env.PITHAGORAS_DIR;
if (process.env.OFFICE_E2E !== "1" || !DIR) {
  test("comments and the editor's chat with agents, end to end", { skip: "set OFFICE_E2E=1 and PITHAGORAS_DIR (see e2e.test.mts)" }, () => {});
} else {
  await run(path.resolve(DIR));
}

type Prompt = { chatId: string; message: string; resolve: (r: { status: "done" | "stopped" | "error"; answer: string; error?: string }) => void };

async function run(PITHAGORAS: string): Promise<void> {
  const from = (file: string) => pathToFileURL(path.join(PITHAGORAS, file)).href;
  const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const IMAGE = process.env.OFFICE_E2E_IMAGE ?? "onlyoffice/documentserver:10.0.0.1";
  const PREFIX = process.env.OFFICE_E2E_CONTAINER ?? "office-docchat-e2e";

  const { inProcessHome } = await import(from("tests/helpers.mts"));
  inProcessHome("office-docchat-e2e-");
  process.env.PORTAL_PASSWORD = "";
  process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
  process.env.PITHAGORAS_OFFICE_CONTAINER = PREFIX;
  process.env.PITHAGORAS_OFFICE_PORT = process.env.OFFICE_E2E_PORT ?? "3984";
  const container = await import("../../src/container.ts");
  const docchat = await import("../../src/docchat.ts");
  const { canonical } = await import("../../src/store.ts");
  assert.equal(container.NAMES.container, PREFIX);

  const data = path.join(process.env.DATA_DIR!, "extension-data", "%40pithagoras%2Foffice");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(data, "settings.json"), JSON.stringify({ enabled: true, imageTag: IMAGE, docchatRemoveAfterS: 3, docchatChatEndS: 3 }));

  const host = await import(from("core/server/dist/extension-host.js"));
  const { requiresOf } = await import(from("core/server/dist/extension-ui.js"));
  const db = await import(from("core/server/dist/db.js"));
  db.getDb();
  const half = (folder: string, file: string) => {
    const meta = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8"));
    return { name: meta.name, version: meta.version, file: path.join(folder, file), rev: meta.version, requires: requiresOf(meta) };
  };
  const express = (await import(pathToFileURL(path.join(PITHAGORAS, "node_modules/express/index.js")).href)).default;
  const app = express().use("/api/x", host.extensionRoutes);
  const pageJs = await editorPageJs(PITHAGORAS, "/api/x/%40pithagoras/office");
  app.get("/editor.html", (_req: unknown, res: { type: (t: string) => { send: (b: string) => void } }) => res.type("html").send(EDITOR_HTML));
  app.get("/editor-page.js", (_req: unknown, res: { type: (t: string) => { send: (b: string) => void } }) => res.type("js").send(pageJs));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const at = `${origin}/api/x/%40pithagoras/office`;
  const json = async (url: string, init?: RequestInit) => {
    const answer = await fetch(url, { ...init, headers: { "content-type": "application/json", origin, ...init?.headers } });
    return { status: answer.status, body: await answer.json() };
  };
  const browser = await chromium.launch();

  after(async () => {
    await browser.close().catch(() => {});
    const keep = process.env.OFFICE_E2E_KEEP === "1";
    if (!keep) await json(`${at}/container/remove`, { method: "POST", body: JSON.stringify({ data: true }) }).catch(() => {});
    await host.stopServerHalves();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (keep) return;
    for (const name of [`${PREFIX}-agent`, `${PREFIX}-relay`, `${PREFIX}-relay-forward`, PREFIX]) execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    for (const end of ["data", "cache", "logs", "fonts"]) execFileSync("docker", ["volume", "rm", "-f", `${PREFIX}-${end}`], { stdio: "ignore" });
  });

  const project = path.join(process.env.WORKSPACE_ROOT!, "acme");
  mkdirSync(project, { recursive: true });
  const home = canonical(project);
  const chatId = `office-docchat-e2e-${randomUUID().slice(0, 8)}`;
  type Tool = { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> };
  const tools: Record<string, Tool> = {};

  /** The portal's chats as docchat sees them: the project's task chat, the children docchat makes, the prompts they
   * are given (answered by the test), and the ones removed. */
  const fake = { chats: [{ id: "acme-main", folder: home }] as { id: string; folder: string; parent?: string; title?: string; listed?: boolean; kind?: string }[], prompts: [] as Prompt[], removed: [] as string[] };

  test("the Document Server comes up, and docchat is given the stand-in chats", { timeout: 600_000 }, async () => {
    await host.syncServerHalves([half(path.join(PITHAGORAS, "extensions/docker"), "src/server.ts"), half(PACKAGE, "src/server.ts")]);
    assert.equal(host.serverFailure("@pithagoras/office"), undefined);
    let state = "";
    for (let i = 0; i < 300 && state !== "running"; i++) {
      state = (await json(`${at}/container/status`)).body.state;
      if (state !== "running") await delay(2000);
    }
    assert.equal(state, "running");
    for (let i = 0; i < 300 && !(await container.settled()); i++) await delay(2000);
    db.createSession({ id: chatId, title: chatId, workspace: project, executor: "host", kind: "task" });
    for (const { factory } of host.hostExtensions(chatId)) factory({ registerTool: (t: { name: string }) => (tools[t.name] = t as never), on() {}, registerCommand() {}, events: { on: () => () => {} } });
    docchat.configureDocchat({
      folders: () => [{ path: project, name: "Acme", kind: "project" }],
      chats: {
        get: (id) => fake.chats.find((c) => c.id === id),
        list: () => fake.chats.filter((c) => c.listed !== false),
        folder: (id) => {
          const c = fake.chats.find((x) => x.id === id);
          if (!c) throw new Error("no chat");
          return c.folder;
        },
        create: ({ parent, title, listed }) => {
          const chat = { id: `child-${fake.chats.length}`, parent, title, listed, folder: home };
          fake.chats.push(chat);
          return chat;
        },
        prompt: (id, message) => new Promise((resolve) => fake.prompts.push({ chatId: id, message, resolve })),
        abort: async () => {},
        remove: async (id) => {
          fake.removed.push(id);
          fake.chats = fake.chats.filter((c) => c.id !== id);
        },
      },
    });
  });

  async function personOpens(docId: string): Promise<{ page: Page; frame: Frame }> {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(`${origin}/editor.html?doc=${encodeURIComponent(docId)}`);
    const events = () => page.evaluate(() => (window as unknown as { __events: unknown[][] }).__events);
    for (let i = 0; i < 120 && !(await events()).some((e) => e[0] === "ready"); i++) await delay(1000);
    assert.ok((await events()).some((e) => e[0] === "ready"), JSON.stringify(await events()));
    let frame: Frame | undefined;
    for (let i = 0; i < 60 && !frame; i++) {
      for (const f of page.frames().filter((f) => /editor\/main\//.test(f.url()))) if (await f.evaluate("Boolean(window.Asc && window.Asc.editor)").catch(() => false)) frame = f;
      if (!frame) await delay(500);
    }
    assert.ok(frame);
    await delay(2000); // the page's ready report
    return { page, frame };
  }
  const waitFor = async (what: () => Promise<boolean> | boolean, ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await what()) return true;
      await delay(200);
    }
    return false;
  };
  const controller = `(window.DE || window.SSE).getController("Common.Controllers.Comments")`;
  const threads = (frame: Frame) => frame.evaluate(`JSON.stringify(${controller}.collection.map(function (c) { return { uid: c.get("uid"), guid: c.get("guid"), text: c.get("comment"), replies: (c.get("replys") || []).map(function (r) { return [r.get("username"), r.get("reply")]; }) }; }))`).then((s) => JSON.parse(s as string) as { uid: string; guid: string; text: string; replies: string[][] }[]);
  /** A comment made in the popover, the agent picked from the mention list. */
  async function mentionInPopover(page: Page, frame: Frame, before: string, search: string, pick: string, afterText = ""): Promise<void> {
    await frame.evaluate(`${controller}.addDummyComment()`);
    await delay(800);
    await frame.locator("textarea.msg-reply").first().click();
    await page.keyboard.type(before, { delay: 20 });
    await page.keyboard.type(`@${search}`, { delay: 60 });
    await delay(1200);
    await frame.locator("li", { hasText: pick }).first().click();
    await delay(300);
    if (afterText) await page.keyboard.type(afterText, { delay: 20 });
    await frame.locator("button", { hasText: /^Add$/ }).first().click();
  }
  const nextPrompt = async (n: number) => {
    assert.ok(await waitFor(() => fake.prompts.length >= n, 15_000), `prompt ${n} came (${fake.prompts.length})`);
    return fake.prompts[n - 1];
  };

  test("Word: a picked mention makes the agent's chat, its answer is the agent's reply in the thread; a reply goes to the same chat; resolve keeps it; the agent's edit keeps the comment; deleted, its chat goes after the grace", { timeout: 600_000 }, async () => {
    const docId = String((await tools.office_create.execute("w", { title: "Thread", type: "word" })).details.id);
    const person = await personOpens(docId);
    await person.frame.locator("#editor_sdk").click({ position: { x: 300, y: 200 } });
    await person.page.keyboard.type("Revenue figures were revised after the audit.", { delay: 10 });
    await delay(500);
    await person.page.keyboard.press("Control+Home");
    for (let i = 0; i < 21; i++) await person.page.keyboard.press("ArrowRight");
    for (let i = 0; i < 7; i++) await person.page.keyboard.press("Shift+ArrowRight");
    await mentionInPopover(person.page, person.frame, "Bitte übersetzen ", "proj", "Acme");

    const first = await nextPrompt(1);
    const child = fake.chats.find((c) => c.id === first.chatId)!;
    assert.equal(child.parent, "acme-main");
    assert.equal(child.listed, false);
    const guid = (await threads(person.frame))[0].guid;
    assert.match(first.message, new RegExp(`comment thread ${guid}`));
    assert.match(first.message, /Bitte übersetzen @project:Acme/);
    first.resolve({ status: "done", answer: "Übersetzt: wurden nach." });
    assert.ok(await waitFor(async () => (await threads(person.frame))[0].replies.some((r) => r[1] === "Übersetzt: wurden nach." && /Acme \(agent\)/.test(r[0])), 30_000), JSON.stringify(await threads(person.frame)));

    // A reply in the thread: the same chat.
    await person.frame.evaluate(`${controller}.onAddReplyComment(${JSON.stringify((await threads(person.frame))[0].uid)}, "Und kürzer bitte")`);
    const second = await nextPrompt(2);
    assert.equal(second.chatId, first.chatId);
    assert.equal(second.message, "A reply in the thread:\nUnd kürzer bitte");
    // The agent's edit of the larger text: the comment is made again on the new text, and its thread goes on.
    const edited = await tools.office_edit.execute("e", { id: docId, ops: [{ quote: "were revised after", replacement: "wurden nach" }] });
    assert.match(edited.content[0].text, /1 comment was moved onto your new text/);
    const movedTo = (edited.details.moved as string[][])[0][1];
    assert.deepEqual(Object.keys(docchat.threadsOf(docId)), [movedTo]);
    second.resolve({ status: "done", answer: "Kürzer." });
    assert.ok(await waitFor(async () => (await threads(person.frame)).some((t) => t.replies.some((r) => r[1] === "Kürzer.")), 30_000), "the answer lands in the moved thread");
    // Resolve: nothing.
    await person.frame.evaluate(`${controller}.onResolveComment(${JSON.stringify((await threads(person.frame))[0].uid)})`);
    await delay(3000);
    assert.equal(fake.prompts.length, 2);
    // Deleted: its chat goes after the grace (3 s here).
    await person.frame.evaluate(`${controller}.onRemoveComment(${JSON.stringify((await threads(person.frame))[0].uid)})`);
    assert.ok(await waitFor(() => fake.removed.includes(first.chatId), 15_000), "the thread's chat is removed");
    assert.deepEqual({ ...docchat.threadsOf(docId) }, {});
    await person.page.context().close();
  });

  test("the editor's chat: a message makes the session's chat of the document's owner, the answer is the agent's message in the editor's chat; the last person gone, the chat goes", { timeout: 600_000 }, async () => {
    const docId = String((await tools.office_create.execute("c", { title: "Talk", type: "word" })).details.id);
    const person = await personOpens(docId);
    await person.frame.evaluate(`window.__chat = []; window.Asc.editor.asc_registerCallback("asc_onCoAuthoringChatReceiveMessage", function (m) { (m || []).forEach(function (x) { window.__chat.push([x.useridoriginal, x.message]); }); })`);
    await person.frame.locator("#left-btn-chat").click();
    await delay(500);
    await person.frame.locator("#chat-msg-text").click();
    await person.page.keyboard.type("Fasse das Dokument zusammen", { delay: 10 });
    await person.frame.locator("#chat-msg-btn-add").click();
    const asked = await nextPrompt(fake.prompts.length + 1);
    const chat = fake.chats.find((c) => c.id === asked.chatId)!;
    assert.equal(chat.title, "Office chat");
    assert.match(asked.message, /editor's chat/);
    assert.match(asked.message, /Fasse das Dokument zusammen$/);
    asked.resolve({ status: "done", answer: "Eine Zusammenfassung." });
    const said = () => person.frame.evaluate("window.__chat") as Promise<string[][]>;
    assert.ok(await waitFor(async () => (await said()).some(([who, text]) => /^agent:/.test(who) && text === "Eine Zusammenfassung."), 30_000), JSON.stringify(await said()));
    await person.page.context().close();
    assert.ok(await waitFor(() => fake.removed.includes(asked.chatId), 60_000), "the session's chat goes after the last person left");
  });

  test("a spreadsheet: a cell comment with a picked mention gets its answer as the agent's reply", { timeout: 600_000 }, async () => {
    const docId = String((await tools.office_create.execute("s", { title: "Sheet thread", type: "cell" })).details.id);
    const person = await personOpens(docId);
    await person.frame.evaluate(`window.Asc.editor.asc_findCell("B2")`);
    const before = fake.prompts.length;
    await mentionInPopover(person.page, person.frame, "Bitte prüfen ", "proj", "Acme");
    const asked = await nextPrompt(before + 1);
    assert.match(asked.message, /Bitte prüfen @project:Acme/);
    asked.resolve({ status: "done", answer: "Geprüft." });
    assert.ok(await waitFor(async () => (await threads(person.frame))[0]?.replies.some((r) => r[1] === "Geprüft."), 30_000), JSON.stringify(await threads(person.frame)));
    await person.page.context().close();
  });
}
