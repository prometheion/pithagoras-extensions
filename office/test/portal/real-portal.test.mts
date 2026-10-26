import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Frame, type Page } from "@playwright/test";
import JSZip from "jszip";
import { parseDocx } from "../../src/ooxml.ts";

/**
 * Office in a real portal, end to end: the portal's own server (`core/server/dist/index.js` of PITHAGORAS_DIR, built),
 * started as a person runs it, Docker for extensions and Office installed into it through POST /api/packages, Office
 * switched on through its own settings route (the real Document Server and the agents' editor, both on Docker), a
 * person in the real Office page in Chromium, and the agent working through its office tools from a real chat. The
 * chat's model is a script (scripted-model.mjs): each message names the tool calls it makes, so nothing needs a GPU.
 *
 * OFFICE_PORTAL_MODE picks where the portal runs: `host` (the default) on the machine itself, `container` in a
 * container of its own, with its own network namespace (Node's alpine image, the one Office's relay runs on, with this
 * machine's Docker socket), where Docker for extensions puts it on the Document Server's network.
 *
 * Opt-in, as e2e.test.mts: Docker Engine 28 or later, the images (`onlyoffice/documentserver:10.0.0.1` unless
 * OFFICE_E2E_IMAGE names another, `chromedp/headless-shell:157.0.8103.15`, `node:22.23.4-alpine3.23`), Chromium for
 * Playwright, and a few minutes. Its containers, networks and volumes go by names of their own (`office-portal-ds…`,
 * `office-portal-<pid>`), and are removed at its end.
 *
 *   OFFICE_E2E=1 PITHAGORAS_DIR=<a built Pithagoras> [OFFICE_PORTAL_MODE=container] node --import tsx --test test/portal/real-portal.test.mts
 */

const DIR = process.env.PITHAGORAS_DIR;
if (process.env.OFFICE_E2E !== "1" || !DIR) {
  test("Office in a real portal", { skip: "set OFFICE_E2E=1 and PITHAGORAS_DIR (see the file's header)" }, () => {});
} else {
  await run(path.resolve(DIR), process.env.OFFICE_PORTAL_MODE === "container" ? "container" : "host");
}

async function freePort(): Promise<number> {
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const until = async (what: () => Promise<boolean> | boolean, ms: number, every = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await what()) return true;
    await delay(every);
  }
  return false;
};

async function run(PITHAGORAS: string, mode: "host" | "container"): Promise<void> {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const PACKAGE = path.resolve(HERE, "../..");
  const IMAGE = process.env.OFFICE_E2E_IMAGE ?? "onlyoffice/documentserver:10.0.0.1";
  const PREFIX = "office-portal-ds";
  const NODE_IMAGE = "node:22.23.4-alpine3.23";
  const portalName = `office-portal-${process.pid}`;

  const root = mkdtempSync(path.join(os.tmpdir(), "office-portal-"));
  const d = (name: string) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const data = d("data");
  const piAgent = d("pi-agent");
  const bin = d("bin");
  const log = path.join(root, "model.jsonl");
  writeFileSync(log, "");
  const port = await freePort();
  const modelPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const at = `${origin}/api/x/%40pithagoras/office`;
  const officeData = path.join(data, "extension-data", "%40pithagoras%2Foffice");

  // The chat's model is the script, the only one there is.
  writeFileSync(path.join(piAgent, "models.json"), JSON.stringify({ providers: { scripted: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", apiKey: "none", models: [{ id: "scripted", name: "scripted", contextWindow: 32768, maxTokens: 4096 }] } } }));
  writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted" }));
  // The portal runs `pi` for installs, as a real install has it on PATH: the one of its own packages.
  writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec node "${PITHAGORAS}/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"\n`, { mode: 0o755 });
  const env: Record<string, string> = {
    HOME: d("home"),
    DATA_DIR: data,
    SESSION_DIR: d("sessions"),
    BIN_DIR: bin,
    AGENT_HOME: d("agent-home"),
    CHANNELS_DIR: d("channels"),
    WORKSPACE_ROOT: d("workspaces"),
    PI_CODING_AGENT_DIR: piAgent,
    PORTAL_ALLOW_NO_PASSWORD: "1",
    PORT: String(port),
    PITHAGORAS_OFFICE_CONTAINER: PREFIX,
    PITHAGORAS_OFFICE_PORT: process.env.OFFICE_E2E_PORT ?? "3996",
  };
  const portalOut = openSync(path.join(root, "portal.log"), "a");
  const children: ChildProcess[] = [];
  const model = path.join(HERE, "scripted-model.mjs");
  const entry = path.join(PITHAGORAS, "core/server/dist/index.js");
  if (mode === "host") {
    children.push(spawn(process.execPath, [model, String(modelPort), log], { stdio: ["ignore", portalOut, portalOut] }));
    children.push(spawn(process.execPath, [entry], { cwd: PITHAGORAS, env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", portalOut, portalOut] }));
  } else {
    // A container of its own: its own network namespace, the portal's port published on 127.0.0.1, the folders it
    // reads and writes mounted where they are on the machine, Docker's socket as both Compose files give it.
    const sock = "/var/run/docker.sock";
    const args = ["run", "-d", "--name", portalName, "--user", `${process.getuid!()}:${process.getgid!()}`, "--group-add", String(statSync(sock).gid), "-p", `127.0.0.1:${port}:${port}`, "-v", `${sock}:${sock}`];
    for (const dir of [PITHAGORAS, PACKAGE, root]) args.push("-v", `${dir}:${dir}`);
    for (const [k, v] of Object.entries({ ...env, PATH: `${bin}:/usr/local/bin:/usr/bin:/bin` })) args.push("-e", `${k}=${v}`);
    args.push("-w", PITHAGORAS, NODE_IMAGE, "sh", "-c", `node "${model}" ${modelPort} "${log}" & exec node "${entry}"`);
    execFileSync("docker", args, { stdio: ["ignore", "ignore", "inherit"] });
    children.push(spawn("docker", ["logs", "-f", portalName], { stdio: ["ignore", portalOut, portalOut] }));
  }

  const json = async (url: string, init?: RequestInit) => {
    const answer = await fetch(url, { ...init, headers: { "content-type": "application/json", origin, ...init?.headers } });
    const text = await answer.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: kept as text
    }
    return { status: answer.status, body };
  };
  const state = async () => (await json(`${at}/state`)).body as { docs: { docId: string; title: string; ext: string; mtimeMs: number }[]; locks: Record<string, { id: string; name?: string }[]>; agent: { present: boolean }; container: { state: string } };
  const fileOf = async (docId: string) => {
    const doc = (await state()).docs.find((x) => x.docId === docId)!;
    return path.join(officeData, "docs", docId, `${doc.title}.${doc.ext}`);
  };
  const partOf = async (docId: string, part: string) => (await JSZip.loadAsync(readFileSync(await fileOf(docId)))).file(part)!.async("string");
  const noConflictCopy = async (title: string) => assert.deepEqual((await state()).docs.filter((x) => x.title.startsWith(`${title} (conflict`)).map((x) => x.title), [], "no conflict copy");
  const newDoc = async (title: string, type: "word" | "cell") => {
    const made = await json(`${at}/documents`, { method: "POST", body: JSON.stringify({ title, type }) });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.docId as string;
  };

  /** A chat of the default agent, and what its scripted model calls in it: each call's result, as the model got it. */
  const chat = async () => {
    const made = await json(`${origin}/api/sessions`, { method: "POST", body: "{}" });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return made.body.id as string;
  };
  let scripts = 0;
  const say = async (chatId: string, calls: { name: string; arguments: Record<string, unknown> }[]): Promise<string[]> => {
    const id = `s${++scripts}-${process.pid}`;
    const sent = await json(`${origin}/api/sessions/${chatId}/prompt`, { method: "POST", body: JSON.stringify({ message: `Do as scripted. SCRIPT#${id} <<<${JSON.stringify(calls)}>>>` }) });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    let done: { results: string[] } | undefined;
    await until(() => {
      done = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.id === id && l.final);
      return !!done;
    }, 180_000);
    assert.ok(done, `the chat ran script ${id} to its end (portal log: ${path.join(root, "portal.log")})`);
    return done.results;
  };

  let browser: Browser;

  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    const keep = process.env.OFFICE_E2E_KEEP === "1";
    await browser?.close().catch(() => {});
    if (!keep) await json(`${at}/container/remove`, { method: "POST", body: JSON.stringify({ data: true }) }).catch(() => {});
    for (const child of children) child.kill();
    if (mode === "container") execFileSync("docker", ["rm", "-f", portalName], { stdio: "ignore" });
    if (keep) return;
    for (const name of [`${PREFIX}-agent`, `${PREFIX}-relay`, `${PREFIX}-relay-forward`, PREFIX]) execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    for (const name of [`${PREFIX}-agents`, `${PREFIX}-net`]) {
      try {
        execFileSync("docker", ["network", "rm", name], { stdio: "ignore" });
      } catch {
        // gone with Office's own removal
      }
    }
    for (const end of ["data", "cache", "logs", "fonts"]) execFileSync("docker", ["volume", "rm", "-f", `${PREFIX}-${end}`], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  test(`the portal (${mode === "host" ? "on the machine" : "in a container of its own"}) takes Docker for extensions and Office through POST /api/packages, and Office starts its Document Server`, { timeout: 900_000 }, async () => {
    assert.ok(await until(async () => (await json(`${origin}/api/sessions`).catch(() => ({ status: 0 }))).status === 200, 120_000), "the portal is up");
    for (const spec of [path.join(PITHAGORAS, "extensions/docker"), PACKAGE]) {
      const installed = await json(`${origin}/api/packages`, { method: "POST", body: JSON.stringify({ spec }) });
      assert.equal(installed.status, 200, JSON.stringify(installed.body));
    }
    assert.ok(await until(async () => (await json(`${at}/state`)).status === 200, 60_000, 1000), "Office's server half answers");
    const on = await json(`${at}/settings`, { method: "POST", body: JSON.stringify({ enabled: true, imageTag: IMAGE }) });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    let seen = "";
    assert.ok(await until(async () => (seen = (await json(`${at}/container/status`)).body.state) === "running", 600_000, 2000), `the Document Server is set up (${seen})`);
    if (!(await state()).agent.present) {
      assert.equal((await json(`${at}/agent/pull`, { method: "POST" })).status, 202);
      assert.ok(await until(async () => (await state()).agent.present, 900_000, 2000), "the agents' editor downloaded");
    }
    if (mode === "container") {
      const portal = JSON.parse(execFileSync("docker", ["inspect", portalName], { encoding: "utf8" }))[0];
      console.log(`portal container networks: ${Object.keys(portal.NetworkSettings.Networks).join(", ")}`);
      assert.ok(Object.keys(portal.NetworkSettings.Networks).includes(`${PREFIX}-net`), "Docker for extensions put the portal's container on the Document Server's network");
      assert.ok(!Object.keys(portal.NetworkSettings.Networks).includes(`${PREFIX}-agents`), "and not on the agents' editor's");
    }
  });

  /** A person in the real Office page, with `docId` open in its editor: the page and the editor's frame. */
  async function personOpens(docId: string, kind: "word" | "cell") {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(`${origin}/x/@pithagoras/office/office?doc=${encodeURIComponent(docId)}`);
    let frame: Frame | undefined;
    const pattern = kind === "word" ? /documenteditor\/main\// : /spreadsheeteditor\/main\//;
    await until(async () => {
      for (const f of page.frames().filter((f) => pattern.test(f.url()))) if (await f.evaluate("Boolean(window.Asc && window.Asc.editor)").catch(() => false)) frame = f;
      return !!frame;
    }, 120_000, 500);
    assert.ok(frame, "the person's editor frame in the Office page");
    assert.ok(await until(async () => ((await state()).locks[docId] ?? []).length === 1, 60_000, 500), "the person is in the document");
    // A mark in the frame's window: a reload of the editor would lose it.
    await frame.evaluate("window.__personMark = 1");
    return { page, frame };
  }
  /** What the person's Word editor holds, as its own select-all reads it. */
  const personText = (frame: Frame) => frame.evaluate(`(function () { var e = window.Asc.editor; e.asc_EditSelectAll(); return e.pluginMethod_GetSelectedText(); })()`) as Promise<string>;
  /** Who the person's editor lists as editing the file with them (its header's list of users), each as it is shown:
   * the initial in its badge, then the name. */
  const personSees = (frame: Frame) => frame.evaluate(`Array.from(document.querySelectorAll(".cousers-list .user-name")).map(function (e) { return (e.textContent || "").replace(/Follow$/, "").trim(); })`) as Promise<string[]>;
  const notReloaded = async (page: Page, frame: Frame) => {
    assert.equal(await frame.evaluate("window.__personMark").catch(() => undefined), 1, "the person's editor was never reloaded");
    assert.ok(page.frames().includes(frame));
  };
  /** The person leaves the document as the Office page has it: "All documents". */
  const personCloses = async (page: Page) => {
    await page.getByRole("button", { name: /All documents|Alle Dokumente/ }).click();
    await delay(500);
    await page.context().close();
  };

  test("a: a person types in a Word document; the agent's office_read has the unsaved text, its office_edit shows live in their editor under the agent's name while they type on, and closing saves everything with no conflict copy", { timeout: 900_000 }, async () => {
    const doc = await newDoc("Shared notes", "word");
    const { page, frame } = await personOpens(doc, "word");
    assert.ok(await until(async () => (await personText(frame)).includes("New document"), 30_000), "the document is loaded");
    await frame.locator("#editor_sdk").click({ position: { x: 400, y: 120 } });
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Person line one", { delay: 25 });
    await delay(2500);
    const id = await chat();

    const [read] = await say(id, [{ name: "office_read", arguments: { id: doc } }]);
    console.log(`a. office_read: ${JSON.stringify(read)}`);
    assert.match(read, /Live: the document as it stands in the editor, including what 1 person in it typed and have not saved yet/);
    assert.match(read, /\[1\] New document\n\[2\] Person line one/);

    // The person types on in their own line while the agent edits.
    const typing = page.keyboard.type(" and two", { delay: 40 });
    const t0 = Date.now();
    const [edited] = await say(id, [{ name: "office_edit", arguments: { id: doc, ops: [{ quote: "New document", replacement: "Meeting notes" }, { after: "Meeting notes", paragraphs: ["Agenda"], style: "Heading 1" }, { after: "Agenda", table: [["Item", "Owner"], ["Budget", "Ann"]] }, { after: "Person line one", paragraphs: ["Temporary line"] }] } }]);
    await typing;
    console.log(`a. office_edit (${Date.now() - t0} ms): ${JSON.stringify(edited)}`);
    assert.match(edited, /Edited "Shared notes" \(4 ops\), saved as revision \d+(\.\d+)?\. 1 person in the document saw it live\./);
    let seen = "";
    assert.ok(await until(async () => /Meeting notes[\s\S]*Agenda[\s\S]*Budget[\s\S]*Ann[\s\S]*Temporary line/.test((seen = await personText(frame))), 5000), `the agent's edit in the person's editor: ${JSON.stringify(seen)}`);
    const names = await personSees(frame);
    console.log(`a. the person's editor shows in the document: ${JSON.stringify(names)}`);
    const agentName = (await json(`${origin}/api/agent/avatar?session=${id}`)).body.agent.name as string;
    assert.ok(names.some((n) => n.slice(1) === `${agentName} (agent)`), `the agent is in the person's editor under its own name, "${agentName} (agent)": ${JSON.stringify(names)}`);

    const [removed] = await say(id, [{ name: "office_edit", arguments: { id: doc, ops: [{ remove: "Temporary line" }] } }]);
    console.log(`a. remove: ${JSON.stringify(removed)}`);
    assert.ok(await until(async () => !(seen = await personText(frame)).includes("Temporary line"), 5000), `the removed paragraph is gone from the person's editor: ${JSON.stringify(seen)}`);
    await notReloaded(page, frame);

    // The person keeps typing after the agent's edits, and leaves.
    await frame.locator("#editor_sdk").click({ position: { x: 400, y: 120 } });
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    // (A key pressed at once after the click may go before the editor has the focus back.)
    await delay(500);
    await page.keyboard.type("Person line after the agent", { delay: 25 });
    await delay(2000);
    assert.match(await personText(frame), /Person line one and two[\s\S]*Person line after the agent/);
    await personCloses(page);
    let text = "";
    const want = ["Meeting notes", "Agenda", "Budget", "Ann", "Person line one and two", "Person line after the agent"];
    const file = await fileOf(doc);
    assert.ok(await until(() => want.every((w) => (text = parseDocx(readFileSync(file)).text).includes(w)), 90_000, 1000), `the file has everything: ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /Temporary line|New document/);
    assert.match(await partOf(doc, "word/document.xml"), /<w:tbl>[\s\S]*Budget[\s\S]*Ann[\s\S]*<\/w:tbl>/);
    await noConflictCopy("Shared notes");
    assert.deepEqual((await state()).locks[doc], [], "nobody is in it once the person left");
  });

  test("b: a person in a spreadsheet; the agent's range write with a formula shows live, computed, and is saved with what the person typed", { timeout: 900_000 }, async () => {
    const doc = await newDoc("Budget", "cell");
    const { page, frame } = await personOpens(doc, "cell");
    await frame.locator("#editor_sdk").click({ position: { x: 600, y: 400 } });
    await frame.evaluate(`window.Asc.editor.asc_findCell("C1")`);
    await page.keyboard.type("person\n", { delay: 30 });
    await delay(2500);
    const id = await chat();
    const [read] = await say(id, [{ name: "office_read", arguments: { id: doc } }]);
    console.log(`b. office_read: ${JSON.stringify(read)}`);
    assert.match(read, /C1: "person"/);
    const t0 = Date.now();
    const [edited] = await say(id, [{ name: "office_edit", arguments: { id: doc, ops: [{ range: "A1:A3", values: [[2], [3], ["=A1*A2"]] }] } }]);
    console.log(`b. office_edit (${Date.now() - t0} ms): ${JSON.stringify(edited)}`);
    assert.match(edited, /Edited "Budget" \(1 op\), saved as revision .* 1 person in the document saw it live\./);
    let max = "";
    assert.ok(
      await until(async () => {
        await frame.evaluate(`window.Asc.editor.asc_findCell("A1:A3")`);
        max = String(await frame.evaluate(`(document.getElementById("status-math-max") || {}).textContent || ""`)).trim();
        return /\b6\b/.test(max);
      }, 5000),
      `the person sees the formula computed: ${max}`,
    );
    await notReloaded(page, frame);
    // The person types on, and leaves.
    await frame.evaluate(`window.Asc.editor.asc_findCell("D1")`);
    await page.keyboard.type("later\n", { delay: 30 });
    await delay(2000);
    await personCloses(page);
    let sheet = "";
    assert.ok(await until(async () => /r="D1"/.test((sheet = await partOf(doc, "xl/worksheets/sheet1.xml"))), 90_000, 1000), `the person's later cell is in the file: ${sheet}`);
    assert.match(sheet, /<c r="A3"[^>]*><f>A1\*A2<\/f><v>6<\/v><\/c>/);
    const strings = await partOf(doc, "xl/sharedStrings.xml");
    assert.match(strings, /person/);
    assert.match(strings, /later/);
    await noConflictCopy("Budget");
  });

  test("c: with nobody in the document, the agent's edit lands and is saved as a new revision", { timeout: 900_000 }, async () => {
    const doc = await newDoc("Unopened", "word");
    const before = (await state()).docs.find((x) => x.docId === doc)!.mtimeMs;
    const id = await chat();
    const [edited] = await say(id, [{ name: "office_edit", arguments: { id: doc, ops: [{ after: "New document", paragraphs: ["Written with nobody in it"] }] } }]);
    console.log(`c. office_edit: ${JSON.stringify(edited)}`);
    const revision = Number(/saved as revision (\d+(?:\.\d+)?)/.exec(edited)?.[1]);
    assert.ok(revision > before, `a new revision: ${revision} after ${before}`);
    assert.doesNotMatch(edited, /saw it live/, "nobody saw it");
    assert.equal((await state()).docs.find((x) => x.docId === doc)!.mtimeMs, revision);
    assert.deepEqual(parseDocx(readFileSync(await fileOf(doc))).paragraphs, ["New document", "Written with nobody in it"]);
    assert.deepEqual((await state()).locks[doc], [], "and no person is in it");
  });

  test("e: a person's editor config never has plugins on, and a tampered client config loads no plugin", { timeout: 900_000 }, async () => {
    const doc = await newDoc("No plugins", "word");
    const id = await chat();
    await say(id, [{ name: "office_read", arguments: { id: doc } }]); // the agent's editor is in it, with its plugin
    const config = (await json(`${at}/editor-config`, { method: "POST", body: JSON.stringify({ doc }) })).body;
    assert.deepEqual(config.editorConfig.customization, { macros: false, plugins: false });
    assert.equal(config.editorConfig.plugins, undefined);
    const { page } = await personOpens(doc, "word");
    await delay(3000);
    assert.deepEqual(page.frames().map((f) => f.url()).filter((u) => /\/plugin\/|sdkjs-plugins|config\.json/.test(u)), [], "no plugin frame in the person's editor");
    await personCloses(page);

    // A plugin a tampered page could reach: served here, on the machine, open to any origin. It writes into the
    // document and says so where it runs.
    const asked: string[] = [];
    const rogue = http.createServer((req, res) => {
      asked.push(req.url ?? "");
      res.setHeader("access-control-allow-origin", "*");
      if (req.url === "/config.json") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ name: "Rogue", guid: "asc.{11111111-2222-4333-8444-555555555555}", version: "1.0.0", variations: [{ description: "rogue", url: "index.html", icons: [], isViewer: true, EditorsSupport: ["word", "cell"], type: "system", isVisual: false, isModal: false, isInsideMode: false, initDataType: "none", initData: "", buttons: [], events: [] }] }));
      }
      if (req.url === "/index.html") {
        res.setHeader("content-type", "text/html");
        return res.end(`<!doctype html><html><head><script src="${origin}/api/x/%40pithagoras/office/ds/sdkjs-plugins/v1/plugins.js"></script><script>fetch("/loaded");window.Asc.plugin.init=function(){fetch("/ran");this.callCommand(function(){var p=Api.CreateParagraph();p.AddText("Written by a rogue plugin");Api.GetDocument().Push(p);},false,true);};window.Asc.plugin.button=function(){};</script></head><body></body></html>`);
      }
      res.end();
    });
    rogue.listen(0, "127.0.0.1");
    await once(rogue, "listening");
    const rogueAt = `http://127.0.0.1:${(rogue.address() as AddressInfo).port}`;
    try {
      // Its config changed as it comes in, before the page hands it on: plugins on, the agents' own plugin (its address
      // as an agent's config has it, on the island) and the rogue one.
      const tampered = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
      await tampered.route("**/editor-config", async (route) => {
        const answer = await route.fetch();
        const body = await answer.json();
        body.editorConfig.customization = { ...body.editorConfig.customization, plugins: true };
        body.editorConfig.plugins = { pluginsData: [`http://${PREFIX}-relay:3891/plugin/${"a".repeat(32)}/config.json`, `${rogueAt}/config.json`], autostart: ["asc.{6f1e2d3c-4b5a-4c69-8e7f-a0b1c2d3e4f5}", "asc.{11111111-2222-4333-8444-555555555555}"] };
        await route.fulfill({ response: answer, json: body });
      });
      await tampered.goto(`${origin}/x/@pithagoras/office/office?doc=${encodeURIComponent(doc)}`);
      let frame: Frame | undefined;
      await until(async () => {
        for (const f of tampered.frames().filter((f) => /documenteditor\/main\//.test(f.url()))) if (await f.evaluate("Boolean(window.Asc && window.Asc.editor)").catch(() => false)) frame = f;
        return !!frame;
      }, 120_000, 500);
      assert.ok(frame, "the tampered page's editor");
      await until(async () => (await personText(frame!)).includes("New document"), 30_000);
      // A plugin that loads runs within seconds (about 5 s with this one, measured without the fix).
      await delay(15_000);
      const text = await personText(frame!);
      const frames = tampered.frames().map((f) => f.url()).filter((u) => /\/plugin\/|config\.json|index\.html|127\.0\.0\.1:\d+\/(?!api)/.test(u) && !u.startsWith(origin));
      console.log(`e. a tampered person's editor: asked of the rogue plugin ${JSON.stringify(asked)}, plugin frames ${JSON.stringify(frames)}, text ${JSON.stringify(text)}`);
      await tampered.context().close();
      assert.doesNotMatch(text, /Written by a rogue plugin/, "no plugin wrote into the document");
      assert.ok(!asked.includes("/ran"), "no plugin ran");
      assert.deepEqual(frames, [], "no plugin frame");
    } finally {
      rogue.close();
    }
  });

  test("d: Office stopped: office_edit is refused with office_stopped, office_read reads the saved file", { timeout: 900_000 }, async () => {
    const doc = await newDoc("Stopped", "word");
    const id = await chat();
    const [edited] = await say(id, [{ name: "office_edit", arguments: { id: doc, ops: [{ paragraphs: ["Saved before the stop"] }] } }]);
    assert.match(edited, /saved as revision/);
    const stopped = await json(`${at}/container/stop`, { method: "POST" });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    const [refused, read] = await say(id, [
      { name: "office_edit", arguments: { id: doc, ops: [{ paragraphs: ["Written while stopped"] }] } },
      { name: "office_read", arguments: { id: doc } },
    ]);
    console.log(`d. office_edit: ${JSON.stringify(refused)}\nd. office_read: ${JSON.stringify(read)}`);
    assert.match(refused, /error:office_stopped /);
    assert.match(read, /Saved copy \(Office is stopped\): what the file holds\./);
    assert.match(read, /Saved before the stop/);
    assert.doesNotMatch(parseDocx(readFileSync(await fileOf(doc))).text, /Written while stopped/);
    const agent = execFileSync("docker", ["ps", "-a", "--filter", `name=^${PREFIX}-agent$`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
    assert.equal(agent, "", "the agents' browser went with the Document Server");
  });
}
