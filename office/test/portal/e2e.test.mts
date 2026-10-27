import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import JSZip from "jszip";
import { parseDocx, rewriteZip } from "../../src/ooxml.ts";
import { signJwt } from "../../src/jwt.ts";
import type * as Seat from "../../src/seat.ts";
import { EDITOR_HTML, editorPageJs } from "./page.mts";

/**
 * Office end to end, against the real Document Server: its server half started by the portal's own extension host,
 * after Docker for extensions, each from its source, Docker for extensions speaking to the machine's own Docker. The
 * portal is "on the machine" (host network), so the way in is Docker for extensions' forwarder on 127.0.0.1. A
 * Chromium opens a document in the Office page's own editor (office-editor.tsx, bundled with the portal's React:
 * page.mts), types into it and closes it, and the text must be in the file: what "Download failed", the refused key,
 * the refused callback token and the embed viewer each broke. Then the agent works in documents through its own editor
 * (the agents' browser, `chromedp/headless-shell`): a closed document, one a person types in, a spreadsheet, a
 * read-only seat, a file changed outside, a failed op, each Word op in the real editor, a used range away from A1, the
 * sheets of a workbook (made, written, renamed, moved, copied, hidden, shown, deleted) while a person has it open,
 * hidden ones kept hidden, an op the editor does not take with every op before it taken back, and how long large
 * edits take; people's editors run no plugin, the agents' browser reaches nothing but the relay, and with Office
 * stopped the agent reads the saved file and edits nothing. And once more through a reverse proxy that ends TLS and
 * sends no forwarded headers, as a plain nginx in front does.
 *
 * Opt-in: it needs Docker Engine 28 or later, the images (about 3 GB, `onlyoffice/documentserver:10.0.0.1` unless
 * OFFICE_E2E_IMAGE names another, and the agents' editor, which the test downloads through the Office page's route
 * where it is not there), Chromium for Playwright, and a few minutes. Its containers, network and volumes go by names
 * of their own (`office-e2e-ds…`, or OFFICE_E2E_CONTAINER's), and are removed at its end.
 *
 *   ./scripts/pithagoras.sh && OFFICE_E2E=1 PITHAGORAS_DIR=$PWD/.pithagoras npm run test:e2e -w office
 */

const DIR = process.env.PITHAGORAS_DIR;
if (process.env.OFFICE_E2E !== "1" || !DIR) {
  test("Office end to end against the real Document Server", { skip: "set OFFICE_E2E=1 and PITHAGORAS_DIR (see the file's header)" }, () => {});
} else {
  await run(path.resolve(DIR));
}

async function run(PITHAGORAS: string): Promise<void> {
  const from = (file: string) => pathToFileURL(path.join(PITHAGORAS, file)).href;
  const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const IMAGE = process.env.OFFICE_E2E_IMAGE ?? "onlyoffice/documentserver:10.0.0.1";
  // Names of its own where another run on the machine has the default ones (OFFICE_E2E_CONTAINER, OFFICE_E2E_PORT).
  const PREFIX = process.env.OFFICE_E2E_CONTAINER ?? "office-e2e-ds";

  const { inProcessHome } = await import(from("tests/helpers.mts"));
  inProcessHome("office-e2e-");
  process.env.PORTAL_PASSWORD = "";
  process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
  process.env.PITHAGORAS_OFFICE_CONTAINER = PREFIX;
  process.env.PITHAGORAS_OFFICE_PORT = process.env.OFFICE_E2E_PORT ?? "3990";

  // Office switched on, with the image under test, before its half starts: its first look starts it all.
  const data = path.join(process.env.DATA_DIR!, "extension-data", "%40pithagoras%2Foffice");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(data, "settings.json"), JSON.stringify({ enabled: true, imageTag: IMAGE }));

  // (After the environment above: the module names its containers when it loads.)
  const { MEM_COMMAND } = await import("../../src/container.ts");
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
  // The Office page's editor itself, with the portal's React, at the address the portal gives Office's routes.
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

  /**
   * What the page shows as Office's memory (GET /container/status) against what the containers use: each container's
   * own cgroup less its droppable file cache, read before and after the status call (the figure lies between), and
   * `docker stats`, which counts the same way. With the agents' browser up the figure is both containers', and with it
   * stopped the Document Server's alone. The numbers go to the log (the owner's RAM line rests on them).
   */
  async function measure(label: string, browserUp: boolean): Promise<{ figure: number; ds: number; browser: number }> {
    const cgroup = (name: string) => Number(execFileSync("docker", ["exec", name, "sh", "-c", MEM_COMMAND], { encoding: "utf8" }).trim());
    const running = (name: string) => execFileSync("docker", ["ps", "-q", "--filter", `name=^${name}$`], { encoding: "utf8" }).trim() !== "";
    assert.equal(running(`${PREFIX}-agent`), browserUp, `${label}: the agents' browser ${browserUp ? "runs" : "is stopped"}`);
    await delay(16_000); // the status keeps what it read for 15 s
    const ds0 = cgroup(PREFIX);
    const br0 = browserUp ? cgroup(`${PREFIX}-agent`) : 0;
    const status = (await json(`${at}/container/status`)).body;
    const ds1 = cgroup(PREFIX);
    const br1 = browserUp ? cgroup(`${PREFIX}-agent`) : 0;
    const stats = execFileSync("docker", ["stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}}", PREFIX, ...(browserUp ? [`${PREFIX}-agent`] : [])], { encoding: "utf8" }).trim().split("\n");
    const statsBytes = stats.reduce((sum, line) => {
      const [, n, unit] = / ([\d.]+)(KiB|MiB|GiB) \//.exec(line)!;
      return sum + Number(n) * 1024 ** ({ KiB: 1, MiB: 2, GiB: 3 } as Record<string, number>)[unit];
    }, 0);
    const figure = status.memBytes as number;
    const mib = (n: number) => `${(n / 1048576).toFixed(0)} MiB`;
    console.log(`MEM ${label}: page ${mib(figure)}; Document Server cgroup ${mib(ds0)}..${mib(ds1)}; browser cgroup ${browserUp ? `${mib(br0)}..${mib(br1)}` : "stopped"}; docker stats: ${stats.join("; ")}`);
    const slack = 64 * 1048576;
    assert.ok(figure >= Math.min(ds0, ds1) + Math.min(br0, br1) - slack && figure <= Math.max(ds0, ds1) + Math.max(br0, br1) + slack, `${label}: the page's figure is the Document Server's plus ${browserUp ? "the browser's" : "nothing (the browser is stopped)"}`);
    assert.ok(Math.abs(figure - statsBytes) <= 0.25 * statsBytes + slack, `${label}: the figure (${mib(figure)}) is what docker stats shows (${mib(statsBytes)})`);
    return { figure, ds: Math.max(ds0, ds1), browser: Math.max(br0, br1) };
  }

  after(async () => {
    // OFFICE_E2E_KEEP=1 leaves the containers for a look at the Document Server's logs; `docker rm -f` them after.
    const keep = process.env.OFFICE_E2E_KEEP === "1";
    if (!keep) await json(`${at}/container/remove`, { method: "POST", body: JSON.stringify({ data: true }) }).catch(() => {});
    await host.stopServerHalves();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (keep) return;
    // What Docker for extensions made for the way in goes with the network; anything a failed run left, by name.
    for (const name of [`${PREFIX}-agent`, `${PREFIX}-relay`, `${PREFIX}-relay-forward`, PREFIX]) execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    for (const name of [`${PREFIX}-agents`, `${PREFIX}-net`]) {
      try {
        execFileSync("docker", ["network", "rm", name], { stdio: "ignore" });
      } catch {
        // gone with Office's own removal
      }
    }
    for (const end of ["data", "cache", "logs", "fonts"]) execFileSync("docker", ["volume", "rm", "-f", `${PREFIX}-${end}`], { stdio: "ignore" });
  });

  test("the Document Server, its relay and its network come up through Docker for extensions, and it answers through the way in", { timeout: 600_000 }, async () => {
    await host.syncServerHalves([half(path.join(PITHAGORAS, "extensions/docker"), "src/server.ts"), half(PACKAGE, "src/server.ts")]);
    assert.equal(host.serverFailure("@pithagoras/office"), undefined);
    let answer = "";
    for (let i = 0; i < 300 && answer !== "true"; i++) {
      await delay(2000);
      answer = await fetch(`${at}/ds/healthcheck`).then((r) => (r.ok ? r.text() : ""), () => "");
    }
    assert.equal(answer, "true", "the Document Server answers its health check through the relay");
    // It answers long before it is set up: a new container makes its fonts and then restarts its services, which an
    // editor opened before would not survive. Running, in the status, is after that.
    let state = "";
    for (let i = 0; i < 150 && state !== "running"; i++) {
      state = (await json(`${at}/container/status`)).body.state;
      if (state !== "running") await delay(2000);
    }
    assert.equal(state, "running", "the Document Server is set up");
    await measure("Document Server idle, no editor, no browser", false);
    const inspect = (name: string) => JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8" }))[0];
    assert.equal(inspect(PREFIX).HostConfig.NetworkMode, `${PREFIX}-net`);
    assert.deepEqual(inspect(PREFIX).HostConfig.PortBindings ?? {}, {}, "nothing of the Document Server's is published");
    assert.equal(inspect(`${PREFIX}-relay`).HostConfig.NetworkMode, `${PREFIX}-net`, "the way back runs over the way in: nothing of Office's is on the portal's network");
    const net = JSON.parse(execFileSync("docker", ["network", "inspect", `${PREFIX}-net`], { encoding: "utf8" }))[0];
    assert.equal(net.Internal, true);
    // Every folder the image keeps apart is a named volume of Office's: none is anonymous, which a re-create drops.
    const declared = Object.keys(JSON.parse(execFileSync("docker", ["image", "inspect", IMAGE, "--format", "{{json .Config.Volumes}}"], { encoding: "utf8" }))).sort();
    const mounts = inspect(PREFIX).Mounts as { Type: string; Name: string; Destination: string }[];
    assert.deepEqual(mounts.map((m) => m.Destination).sort(), declared);
    for (const m of mounts) assert.ok(m.Type === "volume" && m.Name.startsWith(`${PREFIX}-`), `${m.Destination} is in ${m.Name}`);
  });

  /** A document made, opened in the editor from `pageOrigin` as the Office page does, typed into and closed: the text
   * must be in the file. */
  async function openTypeSave(pageOrigin: string, title: string, typed: string, measured = false): Promise<void> {
    const made = await json(`${at}/documents`, { method: "POST", body: JSON.stringify({ title, type: "word" }) });
    assert.equal(made.status, 201);
    const doc = made.body as { docId: string };
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
      const failed: string[] = [];
      page.on("requestfailed", (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
      await page.goto(`${pageOrigin}/editor.html?doc=${encodeURIComponent(doc.docId)}`);
      let events: unknown[][] = [];
      for (let i = 0; i < 120 && !events.some((e) => e[0] !== "warning"); i++) {
        await delay(1000);
        events = await page.evaluate(() => (window as unknown as { __events: unknown[][] }).__events);
      }
      assert.deepEqual(events.filter((e) => e[0] !== "warning"), [["ready"]], `the editor opened the document (${JSON.stringify(events)}; failed loads: ${failed.join(", ")})`);
      const frame = page.frames().find((f) => /documenteditor\/main\//.test(f.url()));
      assert.ok(frame, "the full editor, not the embed viewer");
      // Somebody is in it: the Document Server said so through the callback.
      let locks: unknown[] = [];
      for (let i = 0; i < 30 && !locks.length; i++) {
        await delay(1000);
        locks = (await json(`${at}/state`)).body.locks[doc.docId];
      }
      assert.equal(locks.length, 1, "the editing seat shows while the editor is open");

      // The Document Server's own `info` for the document's key answers 0 while the session is open.
      const info = async () => {
        const secret = readFileSync(path.join(data, "jwt-secret"), "utf8").trim();
        const meta = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === doc.docId);
        const body = { c: "info", key: (await import("../../src/callback.ts")).makeKey(doc.docId, meta.mtimeMs) };
        const answer = await fetch(`http://127.0.0.1:${process.env.PITHAGORAS_OFFICE_PORT}/command`, { method: "POST", headers: { "content-type": "application/json", "X-Auth-Token": `Bearer ${signJwt(body, 60_000, secret)}` }, body: JSON.stringify(body) });
        return ((await answer.json()) as { error: number }).error;
      };
      assert.equal(await info(), 0, "the Document Server says the session is open");

      await frame.locator("#editor_sdk").click({ position: { x: 300, y: 150 } });
      await page.keyboard.type(typed, { delay: 30 });
      await delay(3000);
      if (measured) await measure("Document Server with one person editing, no browser", false);
      await page.evaluate(() => (window as unknown as { __editor: { destroyEditor(): void } }).__editor.destroyEditor());
      const file = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === doc.docId);
      const onDisk = path.join(data, "docs", doc.docId, `${file.title}.docx`);
      let text = "";
      for (let i = 0; i < 90 && !text.includes(typed); i++) {
        await delay(1000);
        text = parseDocx(readFileSync(onDisk)).text;
      }
      assert.ok(text.includes(typed), "the Document Server's save was taken and written to the file");
      assert.deepEqual((await json(`${at}/state`)).body.locks[doc.docId], [], "nobody is in it once it closed");
      assert.equal(await info(), 1, "and that none is open once it closed");
    } finally {
      await browser.close();
    }
  }

  test("a document opens in the editor, takes what is typed, and the save lands in the file", { timeout: 600_000 }, async () => {
    await openTypeSave(origin, "End to end", "Typed end to end", true);
  });

  /* ------------------------------------------------------------------ */
  /* the agent's own editor                                               */
  /* ------------------------------------------------------------------ */

  // The half's own modules, as the portal loaded them (the first revision of a half is at its files' own addresses).
  const seat = await import("../../src/seat.ts");
  const { canonical } = await import("../../src/store.ts");
  const project = path.join(process.env.WORKSPACE_ROOT!, "acme");
  mkdirSync(project, { recursive: true });
  const home = canonical(project);
  const chatId = `office-e2e-${Math.random().toString(36).slice(2)}`;
  type Tool = { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: Record<string, any> }> };
  const tools: Record<string, Tool> = {};
  const agentContainer = () => {
    try {
      return JSON.parse(execFileSync("docker", ["inspect", `${PREFIX}-agent`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0];
    } catch {
      return undefined;
    }
  };
  /** A document of the project's agent, made with its own tool. */
  const agentDoc = async (title: string, type: "word" | "cell") => String((await tools.office_create.execute(`c-${title}`, { title, type })).details.id);
  const fileOf = async (docId: string) => {
    const doc = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === docId);
    return path.join(data, "docs", docId, `${doc.title}.${doc.ext}`);
  };
  const partOf = async (docId: string, part: string) => (await JSZip.loadAsync(readFileSync(await fileOf(docId)))).file(part)!.async("string");
  const browser = await chromium.launch();
  after(() => browser.close());

  /** A person's editor of `docId`, as the Office page opens it. */
  async function personOpens(docId: string) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page.goto(`${origin}/editor.html?doc=${encodeURIComponent(docId)}`);
    const events = () => page.evaluate(() => (window as unknown as { __events: unknown[][] }).__events);
    for (let i = 0; i < 120 && !(await events()).some((e) => e[0] === "ready"); i++) await delay(1000);
    assert.ok((await events()).some((e) => e[0] === "ready"), JSON.stringify(await events()));
    let frame: import("@playwright/test").Frame | undefined;
    for (let i = 0; i < 60 && !frame; i++) {
      for (const f of page.frames().filter((f) => /editor\/main\//.test(f.url()))) if (await f.evaluate("Boolean(window.Asc && window.Asc.editor)").catch(() => false)) frame = f;
      if (!frame) await delay(500);
    }
    assert.ok(frame, "the person's editor frame");
    return { page, frame };
  }
  /** The sheets the person's spreadsheet editor shows, in order, as "Name" or "Name (hidden)". */
  const sheetsOf = (frame: import("@playwright/test").Frame) => frame.evaluate(`(function () { var e = window.Asc.editor, out = []; for (var i = 0; i < e.asc_getWorksheetsCount(); i++) out.push(e.asc_getWorksheetName(i) + (e.asc_isWorksheetHidden(i) ? " (hidden)" : "")); return out.join(", "); })()`) as Promise<string>;
  /** office_edit of `doc`, and how soon the person's editor (`frame`) shows `want`, logged under `label`. */
  const sheetEdit = (label: string, doc: string, frame: import("@playwright/test").Frame) => async (step: string, ops: unknown[], want: string) => {
    const t0 = Date.now();
    const edited = await tools.office_edit.execute(`s-${step}`, { id: doc, ops });
    const took = Date.now() - t0;
    let seen = "";
    const live = await until(async () => (seen = await sheetsOf(frame)) === want, 5000);
    console.log(`${label}. ${step}: ${edited.content[0].text} (${took} ms); the person's sheets ${JSON.stringify(seen)} ${Date.now() - t0} ms after the call`);
    assert.ok(live, `${step}: the person sees ${want} (they see ${seen})`);
  };
  /** What the person's Word editor holds, as its own select-all reads it. */
  const personText = (frame: import("@playwright/test").Frame) => frame.evaluate(`(function () { var e = window.Asc.editor; e.asc_EditSelectAll(); return e.pluginMethod_GetSelectedText(); })()`) as Promise<string>;
  const until = async (what: () => Promise<boolean>, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await what()) return true;
      await delay(150);
    }
    return false;
  };

  test("the agents' editor is downloaded by Start (the Office page's route), and the project's agent has its tools", { timeout: 900_000 }, async () => {
    assert.equal((await json(`${at}/container/start`, { method: "POST" })).status, 200);
    let agent = (await json(`${at}/state`)).body.agent;
    for (let i = 0; i < 900 && !agent.present && !agent.pull?.error; i++) {
      await delay(1000);
      agent = (await json(`${at}/state`)).body.agent;
    }
    assert.equal(agent.present, true, JSON.stringify(agent));
    db.createSession({ id: chatId, title: chatId, workspace: project, executor: "host", kind: "task" });
    for (const { factory } of host.hostExtensions(chatId)) factory({ registerTool: (t: { name: string }) => (tools[t.name] = t as never), on() {}, registerCommand() {}, events: { on: () => () => {} } });
    assert.ok(tools.office_edit);
  });

  test("1. a closed document: replace, heading and table in one edit, saved as the new revision; idle, its editor closes with no change of its own, and the browser stops", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Closed one", "word");
    const before = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === doc).mtimeMs;
    const edited = await tools.office_edit.execute("e1", { id: doc, ops: [{ quote: "New document", replacement: "Quarterly report" }, { after: "Quarterly report", paragraphs: ["Findings"], style: "Heading 1" }, { after: "Findings", table: [["Item", "Amount"], ["Ledger", "42"]] }] });
    console.log(`1. ${edited.content[0].text}`);
    const to = edited.details.to as number;
    assert.ok(to > before, "a new revision");
    assert.equal((await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === doc).mtimeMs, to);
    const xml = await partOf(doc, "word/document.xml");
    assert.match(xml, /Quarterly report/);
    assert.match(xml, /<w:pStyle w:val="[^"]+"\s*\/>(?:(?!<\/w:p>)[\s\S])*Findings/, "the heading paragraph has a style");
    assert.match(xml, /<w:tbl>[\s\S]*Ledger[\s\S]*42[\s\S]*<\/w:tbl>/);
    const read = (await tools.office_read.execute("r1", { id: doc })).content[0].text;
    assert.match(read, /\[1\] Quarterly report\n\[2\] \(Heading 1\) Findings\n\[3\] table\n\| Item \| Amount \|\n\| Ledger \| 42 \|/);
    assert.equal(agentContainer()?.State.Running, true);
    const withBrowser = await measure("Document Server + agents' browser, one agent document open", true);
    assert.ok(withBrowser.figure > withBrowser.ds, "the browser's memory is on top of the Document Server's");
    // Idle: the editor closes, its session closes with nothing new (the document as it was saved), the browser stops.
    seat.tuneSeats({ idleMs: 3000, agentIdleMs: 4000 });
    try {
      assert.ok(await until(async () => seat.seats().length === 0, 30_000), "the idle editor closed");
      await delay(8000); // the Document Server closes the session a few seconds after its last editor left
      // (The close's save may be written again, the same document in a new file: its properties hold the time.)
      assert.equal(await partOf(doc, "word/document.xml"), xml, "its close changed nothing of the document");
      assert.ok(await until(async () => agentContainer() === undefined, 60_000), "the browser stopped");
      await measure("Document Server alone again after the browser stopped", false);
    } finally {
      seat.tuneSeats({ idleMs: seat.LIMITS.idleMs, agentIdleMs: seat.LIMITS.agentIdleMs });
    }
  });

  test("2. a person types and does not save: office_read has it; office_edit's paragraph shows in their editor without a reload while they type on; the file gets both, and no copy", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Typed in", "word");
    const { page, frame } = await personOpens(doc);
    const key = await page.evaluate(() => (window as unknown as { __key: string }).__key);
    await frame.locator("#editor_sdk").click({ position: { x: 300, y: 200 } });
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" Typed by the person", { delay: 25 });
    await delay(2500);
    const read = await tools.office_read.execute("r2", { id: doc });
    console.log(`2. read: ${read.content[0].text}`);
    assert.match(read.content[0].text, /Live: the document as it stands in the editor, including what 1 person in it typed and have not saved yet/);
    assert.match(read.content[0].text, /Typed by the person/);
    // The person types at the start while the agent adds a paragraph at the end.
    await page.keyboard.press("Control+Home");
    const words = Array.from({ length: 12 }, (_, i) => `w${i}`);
    const typing = page.keyboard.type(`${words.join(" ")} `, { delay: 30 });
    await delay(300);
    const t0 = Date.now();
    const edited = await tools.office_edit.execute("e2", { id: doc, ops: [{ paragraphs: ["Added by the agent"] }] });
    console.log(`2. ${edited.content[0].text}`);
    assert.equal(edited.details.live, 1, "one person saw it live");
    await typing;
    let seen = "";
    assert.ok(await until(async () => (seen = await personText(frame)).includes("Added by the agent"), Math.max(500, 5000 - (Date.now() - t0))), `in the person's editor within 5 s: ${JSON.stringify(seen)}`);
    // (The editor capitalizes the first word of a sentence as it is typed.)
    assert.ok(words.every((w) => seen.toLowerCase().includes(w)), `every word typed is in their editor: ${JSON.stringify(seen)}`);
    const events = await page.evaluate(() => (window as unknown as { __events: unknown[][] }).__events);
    assert.ok(!events.some((e) => e[0] === "refresh"), "never reloaded");
    assert.equal(await page.evaluate(() => (window as unknown as { __key: string }).__key), key, "the same session");
    // The person leaves; the agent's editor stays in the session, which is saved as they leave: the file has everything.
    await delay(2000);
    await measure("Document Server + agents' browser, a person and the agent in one document", true);
    await page.evaluate(() => (window as unknown as { __editor: { destroyEditor(): void } }).__editor.destroyEditor());
    let text = "";
    const file = await fileOf(doc);
    assert.ok(await until(async () => words.every((w) => (text = parseDocx(readFileSync(file)).text).toLowerCase().includes(w)), 60_000), `the file: ${JSON.stringify(text)}`);
    assert.match(text, /Typed by the person/);
    assert.match(text, /Added by the agent/);
    const docs = (await json(`${at}/state`)).body.docs as { title: string }[];
    assert.deepEqual(docs.filter((d) => d.title.startsWith("Typed in (conflict")), [], "no conflict copy");
    await page.context().close();
  });

  test("3. a spreadsheet: the agent's formula lands in the person's open sheet, computed, and is saved with its value beside their typed cell", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Numbers", "cell");
    const { page, frame } = await personOpens(doc);
    await frame.evaluate(`window.Asc.editor.asc_findCell("C1")`);
    await page.keyboard.type("person\n", { delay: 30 });
    await delay(2000);
    const t0 = Date.now();
    const edited = await tools.office_edit.execute("e3", { id: doc, ops: [{ range: "A1:A3", values: [[2], [3], ["=A1*A2"]] }, { range: "B2", values: [[7]] }] });
    console.log(`3. ${edited.content[0].text}`);
    // The person's status bar over A1:A3: its largest value is the formula's, 6.
    let max = "";
    const live = await until(async () => {
      await frame.evaluate(`window.Asc.editor.asc_findCell("A1:A3")`);
      max = String(await frame.evaluate(`(document.getElementById("status-math-max") || {}).textContent || ""`)).trim();
      return /\b6\b/.test(max);
    }, 5000);
    console.log(`3. the person's sheet shows "${max}" after ${Date.now() - t0} ms`);
    assert.ok(live, "the person sees 6");
    const sheet = await partOf(doc, "xl/worksheets/sheet1.xml");
    assert.match(sheet, /<c r="A3"[^>]*><f>A1\*A2<\/f><v>6<\/v><\/c>/);
    assert.match(sheet, /<c r="B2"[^>]*><v>7<\/v><\/c>/, "a single cell takes its value");
    assert.match(sheet, /<c r="C1"[^>]*t="s"/, "the person's cell is in the same save");
    assert.match(await partOf(doc, "xl/sharedStrings.xml"), /person/);
    const read = await tools.office_read.execute("r3", { id: doc });
    assert.match(read.content[0].text, /A3: 6 \(=A1\*A2\)/);
    assert.match(read.content[0].text, /C1: "person"/);
    await page.context().close();
  });

  test("4. a seat in view mode reads, and cannot change the document or its file", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Read only", "word");
    const file = await fileOf(doc);
    const bytes = readFileSync(file);
    const reader = canonical(path.join(process.env.WORKSPACE_ROOT!, "readers"));
    const read = (await seat.run(reader, doc, "view", { kind: "word.read", args: {} })) as { blocks: { p: string }[] };
    assert.deepEqual(read.blocks.map((b) => b.p), ["New document"]);
    const tried = await seat.run(reader, doc, "view", { kind: "word.edit", args: { ops: [{ paragraphs: ["Written by a viewer"] }] } }).then((r) => JSON.stringify(r), (e: Seat.SeatError) => `${e.code}: ${e.message}`);
    console.log(`4. an edit in a view seat: ${tried}`);
    assert.match(tried, /^read_only: /, "a view seat is handed no edit");
    // Whatever the viewer's editor did locally, nothing of it reached the session: an editor of the document sees none,
    // and a save of the session finds nothing to save.
    const seen = (await seat.run(home, doc, "edit", { kind: "word.read", args: {} })) as { blocks: { p: string }[] };
    assert.ok(!seen.blocks.some((b) => b.p.includes("Written by a viewer")), JSON.stringify(seen));
    const { saveNow } = await import("../../src/editing.ts");
    assert.equal(await saveNow(seat.keyOf(home, doc)!), "nothing");
    assert.ok(readFileSync(file).equals(bytes), "the file is as it was");
  });

  test("5. the file changed outside while the agent's editor had it open: the next edit is refused as behind, and the outside write is not overwritten", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Changed outside", "word");
    await tools.office_read.execute("r5", { id: doc });
    const file = await fileOf(doc);
    const outside = rewriteZip(readFileSync(file), { "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Written by a script</w:t></w:r></w:p></w:body></w:document>' });
    writeFileSync(file, outside);
    const later = new Date(Date.now() + 5000);
    (await import("node:fs")).utimesSync(file, later, later);
    const refused = await tools.office_edit.execute("e5", { id: doc, ops: [{ paragraphs: ["Over the script"] }] }).then(() => "", (e: Error) => e.message);
    console.log(`5. ${refused}`);
    assert.match(refused, /^error:behind /);
    assert.ok(readFileSync(file).equals(outside), "the outside write stands");
    // The next call opens the file as it is now.
    const read = await tools.office_read.execute("r5b", { id: doc });
    assert.match(read.content[0].text, /Written by a script/);
  });

  test("6. a failed op changes nothing: the live document and the file are as they were", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Failed op", "word");
    const before = (await tools.office_read.execute("r6", { id: doc })).content[0].text;
    const file = await fileOf(doc);
    const bytes = readFileSync(file);
    const refused = await tools.office_edit.execute("e6", { id: doc, ops: [{ quote: "New document", replacement: "Changed" }, { quote: "not in the document", replacement: "x" }] }).then(() => "", (e: Error) => e.message);
    assert.match(refused, /^error:quote_not_found op 2: /);
    assert.equal((await tools.office_read.execute("r6b", { id: doc })).content[0].text, before);
    assert.ok(readFileSync(file).equals(bytes));
  });

  test("7. people's editors run no plugin: their config has none, their page no plugin frame, and a page that adds the agents' plugin to its config reaches nothing", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("No plugins", "word");
    await tools.office_read.execute("r7", { id: doc }); // an agent's editor is in it, with its plugin
    const config = (await json(`${at}/editor-config`, { method: "POST", body: JSON.stringify({ doc }) })).body;
    assert.deepEqual(config.editorConfig.customization, { macros: false, plugins: false });
    assert.equal(config.editorConfig.plugins, undefined);
    const { page } = await personOpens(doc);
    await delay(3000);
    assert.deepEqual(page.frames().map((f) => f.url()).filter((u) => /\/plugin\/|sdkjs-plugins/.test(u)), [], "no plugin frame");
    // The relay is not the browser's to reach.
    const relay = `http://${PREFIX}-relay:3891/seat/${"0".repeat(64)}/poll`;
    assert.equal(await page.evaluate((u) => fetch(u).then(() => "reached", () => "failed"), relay), "failed");
    await page.context().close();
    // A page that changes its config before it hands it on: plugins on, and the agents' own plugin (its address in an
    // agent's editor config). Nothing of it can load in a person's browser.
    const tampered = await (await browser.newContext()).newPage();
    const asked: string[] = [];
    tampered.on("request", (r) => {
      if (/\/plugin\//.test(r.url())) asked.push(r.url());
    });
    const pluginUrl = `http://${PREFIX}-relay:3891/plugin/${"a".repeat(32)}/config.json`;
    await tampered.addInitScript((url) => {
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const answer = await realFetch(input, init);
        if (!String(typeof input === "string" ? input : (input as Request).url).includes("/editor-config")) return answer;
        const body = await answer.json();
        body.editorConfig.customization = { ...body.editorConfig.customization, plugins: true };
        body.editorConfig.plugins = { pluginsData: [url], autostart: ["asc.{6f1e2d3c-4b5a-4c69-8e7f-a0b1c2d3e4f5}"] };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      };
    }, pluginUrl);
    await tampered.goto(`${origin}/editor.html?doc=${encodeURIComponent(doc)}`);
    for (let i = 0; i < 60 && !(await tampered.evaluate(() => (window as unknown as { __events: unknown[][] }).__events.some((e) => e[0] === "ready"))); i++) await delay(1000);
    await delay(4000);
    assert.deepEqual(tampered.frames().map((f) => f.url()).filter((u) => /\/plugin\//.test(u)), [], "no plugin frame in a tampered editor");
    console.log(`7. what a tampered person's editor asked of the agents' plugin: ${JSON.stringify(asked)} (none of it reachable)`);
    await tampered.context().close();
  });

  test("8. the agents' browser reaches the Document Server through the relay and nothing else: not its own ports, not the portal, not the internet, not the seat page without its secret", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Contained", "word");
    await tools.office_read.execute("r8", { id: doc }); // the browser runs
    // A listener on every address of this machine, standing in for the portal: the browser must not reach it.
    const portalLike = http.createServer((_req, res) => res.end("reached the machine"));
    portalLike.listen(0, "0.0.0.0");
    await once(portalLike, "listening");
    const port = (portalLike.address() as AddressInfo).port;
    const addresses = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4").map((a) => a!.address);
    /** What `host:port` answers to a GET of `path` from inside the agents' container (its network, its user), through
     * bash's own /dev/tcp (the image has no curl): the answer, or how the connection failed. Asked without blocking:
     * the way back through the relay runs in this process. */
    const fetched = async (host: string, port: number, path: string) => {
      const script = `exec 3<>"/dev/tcp/$1/$2" || { echo "NO CONNECTION"; exit 0; }; printf 'GET %s HTTP/1.0\\r\\nHost: %s\\r\\n\\r\\n' "$3" "$1" >&3; while IFS= read -r -t 5 line <&3 || [ -n "$line" ]; do printf '%s\\n' "$line"; line=; done`;
      try {
        return (await promisify(execFile)("docker", ["exec", `${PREFIX}-agent`, "bash", "-c", script, "fetch", host, String(port), path], { encoding: "utf8", timeout: 20_000 })).stdout;
      } catch (e) {
        return `FAILED ${(e as { stderr?: string }).stderr ?? ""}`;
      }
    };
    try {
      // On a network of its own: the agents' browser and the relay, nothing else.
      const agent = agentContainer();
      assert.deepEqual(Object.keys(agent.NetworkSettings.Networks), [`${PREFIX}-agents`]);
      const members = JSON.parse(execFileSync("docker", ["network", "inspect", `${PREFIX}-agents`], { encoding: "utf8" }))[0];
      assert.equal(members.Internal, true);
      assert.deepEqual(Object.values(members.Containers as Record<string, { Name: string }>).map((c) => c.Name).sort(), [`${PREFIX}-agent`, `${PREFIX}-relay`]);
      const relayIn = Number(process.env.PITHAGORAS_OFFICE_PORT);
      const ds = await fetched(`${PREFIX}-relay`, relayIn, "/healthcheck");
      console.log(`8. the Document Server through the relay: ${ds.split("\n")[0]}`);
      assert.match(ds, /^true$/m, "the Document Server, through the relay's way in");
      const info = await fetched(`${PREFIX}-relay`, relayIn, "/info/info.json");
      console.log(`8. its statistics through the relay: ${info.split("\n")[0]}`);
      assert.match(info, /^HTTP\/1\.1 403/, "its nginx keeps its own endpoints to itself");
      for (const [host, at] of [[PREFIX, 80], [PREFIX, 8000]] as const) {
        const direct = await fetched(host, at, "/info/info.json");
        console.log(`8. the Document Server's own ${host}:${at}: ${direct.trim().split("\n")[0]}`);
        assert.doesNotMatch(direct, /HTTP\/1/, `${host}:${at} is out of reach`);
      }
      for (const address of [...addresses, "host.docker.internal"]) {
        const got = await fetched(address, port, "/");
        console.log(`8. ${address}:${port}: ${got.trim().split("\n")[0]}`);
        assert.doesNotMatch(got, /reached the machine/, `${address}:${port}`);
      }
      assert.doesNotMatch(await fetched("127.0.0.1", (server.address() as AddressInfo).port, "/api/x/%40pithagoras/office/state"), /imageTag/, "not the portal");
      const internet = await fetched("example.com", 80, "/");
      console.log(`8. example.com: ${internet.trim().split("\n")[0]}`);
      assert.doesNotMatch(internet, /HTTP\/1/, "not the internet");
      const doc0 = await fetched(`${PREFIX}-relay`, 3891, "/doc/x");
      console.log(`8. the listener's /doc without a ticket: ${doc0.trim().split("\n")[0]}`);
      const started = Date.now();
      const seat0 = await fetched(`${PREFIX}-relay`, 3891, `/seat/${"0".repeat(64)}/poll`);
      console.log(`8. /seat without the secret, after ${Date.now() - started} ms: ${JSON.stringify(seat0.slice(0, 300))}`);
      assert.match(seat0, /no such endpoint on the office loopback listener/, "the seat page without its secret is an unknown address");
      assert.match(await fetched(`${PREFIX}-relay`, 3891, `/plugin/${"0".repeat(32)}/next`), /no such endpoint on the office loopback listener/, "nor a plugin's without its token");
    } finally {
      portalLike.close();
    }
  });

  test("behind a reverse proxy that ends TLS and says nothing of it, the editor opens and saves as well", { timeout: 600_000 }, async () => {
    // A self-signed certificate for localhost, and a front that passes each request on as it came (Host kept), with no
    // X-Forwarded-* header: the portal behind it sees plain HTTP. The Document Server must still name https:// in what
    // it hands the page, or the browser refuses it as mixed content.
    const certs = mkdtempSync(path.join(os.tmpdir(), "office-e2e-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(certs, "key.pem"), "-out", path.join(certs, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    const upstream = new URL(origin);
    const front = https.createServer({ key: readFileSync(path.join(certs, "key.pem")), cert: readFileSync(path.join(certs, "cert.pem")) }, (req, res) => {
      const on = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      on.on("error", () => res.destroy());
      req.pipe(on);
    });
    front.listen(0, "127.0.0.1");
    await once(front, "listening");
    try {
      await openTypeSave(`https://localhost:${(front.address() as AddressInfo).port}`, "Behind TLS", "Typed behind a proxy");
    } finally {
      front.closeAllConnections();
      await new Promise((resolve) => front.close(resolve));
      rmSync(certs, { recursive: true, force: true });
    }
  });

  test("10. each Word op in the real editor: a middle and the last paragraph removed, a quote in a table cell replaced, a table at the end", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Every op", "word");
    const edit = async (id: string, ops: unknown[]) => (await tools.office_edit.execute(id, { id: doc, ops })).content[0].text;
    const read = async () => (await tools.office_read.execute(`r-${Math.random()}`, { id: doc })).content[0].text.split("\n\n").slice(1).join("\n\n");
    await edit("o1", [{ quote: "New document", replacement: "Alpha" }, { after: "Alpha", paragraphs: ["Beta", "Gamma"] }, { after: "Gamma", table: [["Cell text", "Other"]] }]);
    console.log(`10. made: ${JSON.stringify(await read())}`);
    await edit("o2", [{ remove: "Beta" }]);
    assert.match(await read(), /^\[1\] Alpha\n\[2\] Gamma\n\[3\] table\n\| Cell text \| Other \|/, "the middle paragraph is gone");
    await edit("o3", [{ quote: "Cell text", replacement: "Changed cell" }]);
    assert.match(await read(), /\| Changed cell \| Other \|/, "the quote in the cell is replaced");
    await edit("o4", [{ table: [["End", "Table"]] }]);
    const withEnd = await read();
    console.log(`10. a table at the end: ${JSON.stringify(withEnd)}`);
    assert.match(withEnd, /\| Changed cell \| Other \|[\s\S]*table\n\| End \| Table \|/, "the table is at the end");
    await edit("o5", [{ paragraphs: ["Last line"] }]);
    assert.match(await read(), /\] Last line$/);
    await edit("o6", [{ remove: "Last line" }]);
    const without = await read();
    console.log(`10. the last paragraph removed: ${JSON.stringify(without)}`);
    assert.doesNotMatch(without, /Last line/, "the last paragraph is gone");
    const xml = await partOf(doc, "word/document.xml");
    assert.match(xml, /Changed cell[\s\S]*End/);
    assert.doesNotMatch(xml, /Beta|Last line|Cell text/);
    // The only paragraph of a document: removed, or refused as a whole; never a half-made edit.
    const lone = await agentDoc("Only one", "word");
    const removed = await tools.office_edit.execute("o7", { id: lone, ops: [{ remove: "New document" }] }).then((r) => r.content[0].text, (e: Error) => e.message);
    const left = (await tools.office_read.execute("r7", { id: lone })).content[0].text;
    console.log(`10. the only paragraph removed: ${removed} -> ${JSON.stringify(left.split("\n\n").slice(1).join(" "))}`);
    assert.doesNotMatch(left, /New document/, "its text is gone");
  });

  test("11. a spreadsheet whose cells start away from A1 is read by the cells' own addresses", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Offset", "cell");
    await tools.office_edit.execute("c1", { id: doc, ops: [{ range: "C3:D4", values: [[1, 2], [3, "=C3+D3"]] }] });
    const text = (await tools.office_read.execute("c2", { id: doc })).content[0].text;
    console.log(`11. ${JSON.stringify(text.split("\n\n").slice(1).join("\n\n"))}`);
    // (The editor gives a sheet's used range from A1 on, so its cells are named from there: the arithmetic for a range
    // that starts elsewhere is seat-page.test's.)
    assert.match(text, /Sheet "Sheet1" \([A-D]\d:D4\):\nC3: 1\nD3: 2\nC4: 3\nD4: 3 \(=C3\+D3\)$/);
  });

  test("12. sheets while a person has the workbook open: made, written into and read by a formula on the first sheet, renamed and moved, copied, hidden and shown, deleted; each shows in the person's editor, and the file holds them in order", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Sheets", "cell");
    const { page, frame } = await personOpens(doc);
    const personSheets = () => sheetsOf(frame);
    const edit = sheetEdit("12", doc, frame);
    const read = async () => (await tools.office_read.execute("s-read", { id: doc })).content[0].text.split("\n\n").slice(1).join("\n\n");

    await edit("made and written", [{ addSheet: "Data" }, { sheet: "Data", range: "A1:B1", values: [[2, 3]] }, { range: "A1", values: [["=Data!A1+Data!B1"]] }], "Sheet1, Data");
    assert.match(await read(), /^Sheets: 1 "Sheet1", 2 "Data"\n\nSheet "Sheet1" \(A1\):\nA1: 5 \(=Data!A1\+Data!B1\)\n\nSheet "Data" \(A1:B1\):\nA1: 2\nB1: 3$/);

    await edit("renamed and moved", [{ renameSheet: "data", to: "My data" }, { moveSheet: "My data", position: 1 }, { sheet: "Sheet1", range: "B1", values: [["='My data'!B1*2"]] }], "My data, Sheet1");
    let text = await read();
    assert.match(text, /^Sheets: 1 "My data", 2 "Sheet1"\n/);
    assert.match(text, /A1: 5 \(='My data'!A1\+'My data'!B1\)\nB1: 6 \(='My data'!B1\*2\)/, "the formula follows the rename, and one written with the quoted name reads it");

    await edit("copied", [{ copySheet: "My data", to: "Copy" }], "My data, Copy, Sheet1");
    assert.match(await read(), /\n\nSheet "Copy" \(A1:B1\):\nA1: 2\nB1: 3\n/);
    await edit("hidden", [{ hideSheet: "Copy" }], "My data, Copy (hidden), Sheet1");
    assert.match(await read(), /^Sheets: 1 "My data", 2 "Copy" \(hidden\), 3 "Sheet1"\n/);
    await edit("shown", [{ showSheet: "Copy" }], "My data, Copy, Sheet1");
    await edit("deleted", [{ deleteSheet: "Copy" }, { addSheet: "Empty" }], "My data, Sheet1, Empty");
    text = await read();
    assert.match(text, /^Sheets: 1 "My data", 2 "Sheet1", 3 "Empty"\n/);
    assert.match(text, /\n\nSheet "Empty" \(A1\):\n\(empty\)$/, "an empty sheet is read too");

    // Refused whole, before anything is made: the person's sheets stay as they are.
    const refused = async (ops: unknown[]) => tools.office_edit.execute("s-refused", { id: doc, ops }).then(() => "", (e: Error) => e.message);
    assert.match(await refused([{ addSheet: "Temp" }, { renameSheet: "Nope", to: "x" }]), /^error:not_found op 2: there is no sheet named "Nope"/);
    assert.match(await refused([{ hideSheet: "Sheet1" }, { hideSheet: "Empty" }, { deleteSheet: "My data" }]), /^error:last_visible_sheet op 3: /);
    assert.match(await refused([{ addSheet: "SHEET1" }]), /^error:sheet_exists op 1: /);
    await delay(1500);
    assert.equal(await personSheets(), "My data, Sheet1, Empty");

    // The file: the sheets in order, with their values.
    const { parseXlsx } = await import("../../src/ooxml.ts");
    const book = parseXlsx(readFileSync(await fileOf(doc)));
    assert.deepEqual(book.sheetNames, ["My data", "Sheet1", "Empty"]);
    assert.deepEqual(book.hiddenSheets, []);
    assert.deepEqual(book.sheets["My data"][0], ["2", "3"]);
    assert.deepEqual(book.sheets["Sheet1"][0], ["5", "6"]);
    assert.match(await partOf(doc, "xl/workbook.xml"), /<sheet name="My data"[^>]*\/><sheet name="Sheet1"[^>]*\/><sheet name="Empty"/);
    await page.context().close();
  });

  test("13. hidden sheets stay hidden: the first sheet hidden, then a sheet added and copied; a hidden sheet's move refused, and shown, moved and hidden again in one call; the first sheet deleted and one added in one call", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Hidden sheets", "cell");
    const { page, frame } = await personOpens(doc);
    const edit = sheetEdit("13", doc, frame);
    const refused = async (ops: unknown[]) => tools.office_edit.execute("h-refused", { id: doc, ops }).then(() => "", (e: Error) => e.message);
    await edit("made", [{ addSheet: "Data" }, { sheet: "Data", range: "A1:B1", values: [[1, "=A1*2"]] }], "Sheet1, Data");
    // The agent's editor is on its first sheet: hidden, the next one is its active sheet, after which a sheet is added.
    await edit("first hidden, then added and copied", [{ hideSheet: "Sheet1" }, { addSheet: "Added" }, { copySheet: "Data", to: "Data copy" }], "Sheet1 (hidden), Data, Data copy, Added");
    // The copied sheet computes on, and so does its copy, each from its own cells.
    await edit("written after the copy", [{ sheet: "Data", range: "A1", values: [[5]] }, { sheet: "Data copy", range: "A1", values: [[7]] }], "Sheet1 (hidden), Data, Data copy, Added");
    const copied = (await tools.office_read.execute("h-copied", { id: doc })).content[0].text;
    assert.match(copied, /Sheet "Data" \(A1:B1\):\nA1: 5\nB1: 10 \(=A1\*2\)/);
    assert.match(copied, /Sheet "Data copy" \(A1:B1\):\nA1: 7\nB1: 14 \(=A1\*2\)/);
    await edit("added in a later call", [{ addSheet: "Later" }], "Sheet1 (hidden), Data, Data copy, Added, Later");
    assert.match(await refused([{ addSheet: "Not made" }, { moveSheet: "Sheet1", position: 3 }]), /^error:sheet_hidden op 2: "Sheet1" is hidden/);
    await delay(1500);
    assert.equal(await sheetsOf(frame), "Sheet1 (hidden), Data, Data copy, Added, Later", "the refused call changed nothing");
    await edit("shown, moved and hidden again", [{ showSheet: "Sheet1" }, { moveSheet: "Sheet1", position: 3 }, { hideSheet: "Sheet1" }], "Data, Data copy, Sheet1 (hidden), Added, Later");
    await edit("added after the move", [{ addSheet: "After" }, { copySheet: "Added", to: "Added copy", position: 1 }], "Added copy, Data, Data copy, Sheet1 (hidden), Added, Later, After");
    await edit("first deleted and one added in one call", [{ deleteSheet: "Added copy" }, { addSheet: "Fresh" }, { sheet: "Fresh", range: "A1", values: [["=Data!A1+1"]] }], "Data, Data copy, Sheet1 (hidden), Added, Later, After, Fresh");
    const text = (await tools.office_read.execute("h-read", { id: doc })).content[0].text;
    assert.match(text, /\nSheets: 1 "Data", 2 "Data copy", 3 "Sheet1" \(hidden\), 4 "Added", 5 "Later", 6 "After", 7 "Fresh"\n/);
    assert.match(text, /Sheet "Fresh" \(A1\):\nA1: 6 \(=Data!A1\+1\)/);
    const { parseXlsx } = await import("../../src/ooxml.ts");
    const book = parseXlsx(readFileSync(await fileOf(doc)));
    assert.deepEqual(book.sheetNames, ["Data", "Data copy", "Sheet1", "Added", "Later", "After", "Fresh"]);
    assert.deepEqual(book.hiddenSheets, ["Sheet1"]);
    await page.context().close();
  });

  test("14. an op the editor does not take, after a write, a rename, a move, a hide, a delete, an add and a copy: every one of them taken back in the real editor, the cells with their formats and texts", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Taken back", "cell");
    const { page, frame } = await personOpens(doc);
    const edit = sheetEdit("14", doc, frame);
    // "'00123" is the text 00123, as typed into Excel.
    await edit("made", [{ range: "B2:D2", values: [[3, "'00123", "=B2*2"]] }, { addSheet: "Keep" }, { addSheet: "Other" }, { sheet: "Other", range: "A1", values: [["other"]] }], "Sheet1, Keep, Other");
    const read = async () => (await tools.office_read.execute("t-read", { id: doc })).content[0].text.split("\n\n").slice(1).join("\n\n");
    const before = await read();
    console.log(`14. before: ${JSON.stringify(before)}`);
    assert.match(before, /B2: 3\nC2: "00123"\nD2: 6 \(=B2\*2\)/);
    const t0 = Date.now();
    const failed = await tools.office_edit.execute("t-fail", {
      id: doc,
      ops: [
        { range: "B2:C2", values: [["10%", "7"]] },
        { renameSheet: "Keep", to: "Kept" },
        { moveSheet: "Other", position: 1 },
        { hideSheet: "Kept" },
        { deleteSheet: "Other" },
        { addSheet: "Temp" },
        { copySheet: "Sheet1", to: "Copy" },
        { range: "E1", values: [["=SUM("]] },
      ],
    }).then(() => "", (e: Error) => e.message);
    console.log(`14. the failing call (${Date.now() - t0} ms): ${failed}`);
    assert.match(failed, /^error:bad_value op 8: the editor did not take the values for E1 of "Sheet1": a formula it cannot read/);
    let seen = "";
    assert.ok(await until(async () => (seen = await sheetsOf(frame)) === "Sheet1, Keep, Other", 5000), `the person's sheets are as they were (they see ${seen})`);
    await delay(1500);
    assert.equal(await sheetsOf(frame), "Sheet1, Keep, Other", "and stay so");
    assert.equal(await read(), before, "every cell and sheet as it was");
    // A later write into B2 is computed into D2 as before.
    await edit("written after", [{ range: "B2", values: [[4]] }], "Sheet1, Keep, Other");
    assert.match(await read(), /B2: 4\nC2: "00123"\nD2: 8 \(=B2\*2\)/);
    // Saved with that edit: B2 has its own format again (not a percent one), C2 is still text.
    const { parseXlsx } = await import("../../src/ooxml.ts");
    const book = parseXlsx(readFileSync(await fileOf(doc)));
    assert.deepEqual(book.sheetNames, ["Sheet1", "Keep", "Other"]);
    assert.deepEqual(book.sheets["Sheet1"][1].slice(1, 4), ["4", "00123", "8"]);
    const sheetXml = await partOf(doc, "xl/worksheets/sheet1.xml");
    const styles = await partOf(doc, "xl/styles.xml");
    const cell = (ref: string) => new RegExp(`<c r="${ref}"([^>]*)>`).exec(sheetXml)?.[1] ?? "";
    const numFmt = (ref: string) => {
      const s = /\bs="(\d+)"/.exec(cell(ref));
      const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)![1].match(/<xf\b[^>]*>/g)!;
      return s ? Number(/numFmtId="(\d+)"/.exec(xfs[Number(s[1])])?.[1] ?? 0) : 0;
    };
    console.log(`14. B2 <c${cell("B2")}> numFmt ${numFmt("B2")}; C2 <c${cell("C2")}> numFmt ${numFmt("C2")}`);
    assert.equal(numFmt("B2"), 0, "B2 is General again");
    assert.match(cell("C2"), /\bt="(s|str|inlineStr)"/, "C2 holds text");
    await page.context().close();
  });

  test("15. how long the edits take in the real editor: 200 cell ops in one call, and 20 sheet ops in one call", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Timings", "cell");
    const { page, frame } = await personOpens(doc);
    let t0 = Date.now();
    await tools.office_edit.execute("m-cells", { id: doc, ops: Array.from({ length: 200 }, (_, n) => ({ range: `A${n + 1}`, values: [[n]] })) });
    const cells = Date.now() - t0;
    t0 = Date.now();
    await tools.office_edit.execute("m-sheets", { id: doc, ops: [...Array.from({ length: 10 }, (_, n) => ({ addSheet: `S${n}` })), ...Array.from({ length: 10 }, (_, n) => ({ copySheet: "Sheet1", to: `C${n}` }))] });
    const sheets = Date.now() - t0;
    console.log(`15. 200 cell ops: ${cells} ms; 10 adds and 10 copies: ${sheets} ms`);
    assert.match((await tools.office_read.execute("m-read", { id: doc, sheet: "C9" })).content[0].text, /A200: 199/);
    assert.equal((await sheetsOf(frame)).split(", ").length, 21);
    await page.context().close();
  });

  test("9. Office stopped: office_read reads the saved file and says so, office_edit is refused, and the agents' browser is gone", { timeout: 600_000 }, async () => {
    const doc = await agentDoc("Stopped", "word");
    await tools.office_edit.execute("s1", { id: doc, ops: [{ paragraphs: ["Saved before the stop"] }] });
    assert.equal((await json(`${at}/container/stop`, { method: "POST" })).status, 200);
    const read = await tools.office_read.execute("s2", { id: doc });
    assert.match(read.content[0].text, /\nSaved copy \(Office is stopped\): what the file holds\./);
    assert.match(read.content[0].text, /Saved before the stop/);
    await assert.rejects(tools.office_edit.execute("s3", { id: doc, ops: [{ paragraphs: ["x"] }] }), (e: Error) => /^error:office_stopped /.test(e.message));
    assert.equal(agentContainer(), undefined, "the agents' browser went with the Document Server");
    assert.equal(seat.seats().length, 0);
  });
}
