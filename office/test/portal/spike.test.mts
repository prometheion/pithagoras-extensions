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
import JSZip from "jszip";
import { parseDocx } from "../../src/ooxml.ts";
import type * as Seat from "../../src/seat.ts";
import { EDITOR_HTML, editorPageJs } from "./page.mts";

/**
 * The gate of the agent's own editor (step 1 of the plan): inside Office's real island and relay, with the real
 * Document Server and the pinned headless Chromium, the mechanics the design stands on hold:
 * - the agents' browser loads the seat page through relay:3891 and stays up, with no debugging port;
 * - the plugin served from the listener (CORS to the Document Server's origin) loads and polls;
 * - a person's unsaved typing is in the agent's live read;
 * - a range replace (delete, then add), a paragraph and a table after an anchor land in the person's open editor;
 * - a command that throws after it changed something leaves the document as it was (the plugin's Undo);
 * - an xlsx write with a formula lands in the person's open sheet and is saved with its value;
 * - a forcesave persists the agent's edits and the person's typing through the callback's revision gate;
 * - a seat in view mode reads live;
 * - the way back's tunnel pool holds with the page's and three plugins' long-polls and the callbacks of three saves.
 *
 * Opt-in like e2e.test.mts (OFFICE_E2E=1 and PITHAGORAS_DIR), with names of its own (`office-spike-ds…`).
 */

const DIR = process.env.PITHAGORAS_DIR;
if (process.env.OFFICE_E2E !== "1" || !DIR) {
  test("the agent's own editor, inside Office's island", { skip: "set OFFICE_E2E=1 and PITHAGORAS_DIR (see e2e.test.mts)" }, () => {});
} else {
  await run(path.resolve(DIR));
}

async function run(PITHAGORAS: string): Promise<void> {
  const from = (file: string) => pathToFileURL(path.join(PITHAGORAS, file)).href;
  const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const IMAGE = process.env.OFFICE_E2E_IMAGE ?? "onlyoffice/documentserver:10.0.0.1";
  const PREFIX = process.env.PITHAGORAS_OFFICE_CONTAINER ?? "office-spike-ds";

  const { inProcessHome } = await import(from("tests/helpers.mts"));
  inProcessHome("office-spike-");
  process.env.PORTAL_PASSWORD = "";
  process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
  process.env.PITHAGORAS_OFFICE_CONTAINER = PREFIX;
  process.env.PITHAGORAS_OFFICE_PORT = process.env.OFFICE_E2E_PORT ?? "3991";
  // Office's modules after the environment: their names (container.ts NAMES) are read as they load. The half the
  // portal starts imports the same files, at the same addresses, so these are its own modules.
  const seat = await import("../../src/seat.ts");
  const callback = await import("../../src/callback.ts");
  const container = await import("../../src/container.ts");
  const { canonical } = await import("../../src/store.ts");
  assert.equal(container.NAMES.container, PREFIX, "the names are read after the environment is set");

  const data = path.join(process.env.DATA_DIR!, "extension-data", "%40pithagoras%2Foffice");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(data, "settings.json"), JSON.stringify({ enabled: true, imageTag: IMAGE }));

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

  // An agent and its tools, as a chat of a project gets them.
  const project = path.join(process.env.WORKSPACE_ROOT!, "acme");
  mkdirSync(project, { recursive: true });
  const home = canonical(project);
  const chatId = `office-spike-${randomUUID().slice(0, 8)}`;
  type Tool = { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> };
  const tools: Record<string, Tool> = {};
  const docFile = async (docId: string, ext: "docx" | "xlsx") => {
    const file = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === docId);
    return readFileSync(path.join(data, "docs", docId, `${file.title}.${ext}`));
  };

  test("the Document Server, its relay and its network come up", { timeout: 600_000 }, async () => {
    await host.syncServerHalves([half(path.join(PITHAGORAS, "extensions/docker"), "src/server.ts"), half(PACKAGE, "src/server.ts")]);
    assert.equal(host.serverFailure("@pithagoras/office"), undefined);
    assert.match(seat.pageUrl(), /^http:\/\/office-spike-ds-relay:3891\/seat\/[0-9a-f]{64}\/$/, "the test reaches the half's own seat module");
    let state = "";
    for (let i = 0; i < 300 && state !== "running"; i++) {
      state = (await json(`${at}/container/status`)).body.state;
      if (state !== "running") await delay(2000);
    }
    assert.equal(state, "running", "the Document Server is set up");
    db.createSession({ id: chatId, title: chatId, workspace: project, executor: "host", kind: "task" });
    for (const { factory } of host.hostExtensions(chatId)) factory({ registerTool: (t: { name: string }) => (tools[t.name] = t as never), on() {}, registerCommand() {}, events: { on: () => () => {} } });
    assert.ok(tools.office_create, "the office tools are there for a project's chat");
  });

  /** A person's editor of `docId` in Chromium, as the Office page opens it. */
  async function personOpens(docId: string): Promise<{ page: Page; frame: Frame }> {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page.goto(`${origin}/editor.html?doc=${encodeURIComponent(docId)}`);
    const events = () => page.evaluate(() => (window as unknown as { __events: unknown[][] }).__events);
    for (let i = 0; i < 120 && !(await events()).some((e) => e[0] === "ready"); i++) await delay(1000);
    assert.ok((await events()).some((e) => e[0] === "ready"), JSON.stringify(await events()));
    // The editor's frame, once its API is up (a spreadsheet's comes a little after the document is ready).
    let frame: Frame | undefined;
    for (let i = 0; i < 60 && !frame; i++) {
      for (const f of page.frames().filter((f) => /editor\/main\//.test(f.url()))) if (await f.evaluate("Boolean(window.Asc && window.Asc.editor)").catch(() => false)) frame = f;
      if (!frame) await delay(500);
    }
    assert.ok(frame, "the person's editor frame");
    return { page, frame };
  }
  /** What the person's editor holds now, as its own selection reads it (a select-all moves their selection). */
  const personText = (frame: Frame) => frame.evaluate(`(function () { var e = window.Asc.editor; e.asc_EditSelectAll(); return e.pluginMethod_GetSelectedText(); })()`) as Promise<string>;
  const waitFor = async (what: () => Promise<boolean>, ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await what()) return true;
      await delay(150);
    }
    return false;
  };
  /** A forcesave of the seat's session, waited for: what the session holds is on disk. */
  async function forcesave(docId: string, as = home): Promise<void> {
    const key = seat.keyOf(as, docId)!;
    const userdata = `office-${randomUUID()}`;
    const waiting = callback.awaitForcesave(userdata, key);
    const answer = await callback.command({ c: "forcesave", key, userdata });
    assert.equal(answer.error, 0, JSON.stringify(answer));
    const saved = await Promise.race([waiting.done, delay(30_000).then(() => "timeout")]);
    assert.equal(saved, true, "the forcesave's callback was persisted");
  }
  type Blocks = { blocks: ({ p: string; style?: string } | { table: string[][] })[] };
  const texts = (r: unknown) => (r as Blocks).blocks.map((b) => ("p" in b ? b.p : `table ${JSON.stringify(b.table)}`));

  test("a Word document: the agent's editor joins the person's session, reads their unsaved typing, and its edits land live and are saved", { timeout: 600_000 }, async () => {
    const made = await tools.office_create.execute("c1", { title: "Agent seat", type: "word" });
    const docId = String(made.details.id);
    const { page, frame } = await personOpens(docId);
    await frame.locator("#editor_sdk").click({ position: { x: 300, y: 200 } });
    await page.keyboard.type("Revenue figures were revised after the audit.", { delay: 20 });
    await delay(2500);

    const started = Date.now();
    const first = await seat.run(home, docId, "edit", { kind: "word.read", args: {} });
    console.log(`the first read (browser started, editor opened) took ${Date.now() - started} ms: ${JSON.stringify(first)}`);
    assert.ok(texts(first).some((t) => t.includes("Revenue figures were revised after the audit.")), "the agent reads what the person typed and did not save");

    // The browser: on the island alone, nothing published, hardened, and no debugging port.
    const agent = JSON.parse(execFileSync("docker", ["inspect", `${PREFIX}-agent`], { encoding: "utf8" }))[0];
    assert.equal(agent.HostConfig.NetworkMode, `${PREFIX}-net`);
    assert.deepEqual(agent.HostConfig.PortBindings ?? {}, {});
    assert.equal(agent.Config.User, "1000:1000");
    assert.equal(agent.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(agent.HostConfig.CapDrop, ["ALL"]);
    assert.equal(agent.Config.Image, container.AGENT_IMAGE);
    assert.ok(!agent.Config.Cmd.join(" ").includes("remote-debugging"), "no debugging port");
    assert.ok(Object.keys(agent.NetworkSettings.Networks).length === 1, "on one network");

    // A range replace, a heading and a table after an anchor, in one command; the person sees them without a reload.
    const t0 = Date.now();
    const edited = await seat.run(home, docId, "edit", {
      kind: "word.edit",
      args: { ops: [{ quote: "were revised after", replacement: "were updated after" }, { after: "the audit.", paragraphs: ["Findings"], style: "Heading 1" }, { after: "Findings", table: [["Item", "Amount"], ["Ledger", "42"]] }] },
    });
    console.log(`the edit took ${Date.now() - t0} ms: ${JSON.stringify(edited)}`);
    let seen = "";
    const live = await waitFor(async () => {
      seen = await personText(frame);
      return seen.includes("were updated after") && seen.includes("Findings") && seen.includes("Ledger");
    }, 5000);
    console.log(`the person's editor holds after ${Date.now() - t0} ms: ${JSON.stringify(seen)}`);
    assert.ok(live, "the edit is in the person's open editor within 5 s");
    const read = texts(await seat.run(home, docId, "edit", { kind: "word.read", args: {} }));
    console.log(`the agent reads: ${JSON.stringify(read)}`);
    assert.ok(read.some((t) => t.includes("Revenue figures were updated after the audit.")));
    assert.ok(read.indexOf("Findings") >= 0 && read[read.indexOf("Findings") + 1]?.startsWith("table"), "the table follows its anchor");

    // Ops checked before anything is touched: the second quote is not there, nothing changed.
    await assert.rejects(seat.run(home, docId, "edit", { kind: "word.edit", args: { ops: [{ quote: "Findings", replacement: "Results" }, { quote: "not in the document", replacement: "x" }] } }), (e: Seat.SeatError) => e.code === "quote_not_found" && e.op === 1);
    // A command that throws after it changed something: the plugin takes it back (a table with no columns is made
    // after the first op ran; ops.ts would refuse it, which the call here does not go through).
    await assert.rejects(seat.run(home, docId, "edit", { kind: "word.edit", args: { ops: [{ quote: "Findings", replacement: "Results" }, { after: "Results", table: [[]] }] } }), (e: Seat.SeatError) => {
      console.log(`a command that threw: ${e.code} ${e.message}`);
      return true;
    });
    await delay(1000);
    const after = texts(await seat.run(home, docId, "edit", { kind: "word.read", args: {} }));
    assert.deepEqual(after, read, "the document is as it was before the command that threw");
    assert.ok(!(await personText(frame)).includes("Results"), "and so is the person's editor");

    // The person types on, unsaved; the forcesave keeps both.
    await frame.locator("#editor_sdk").click({ position: { x: 300, y: 200 } });
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" Typed after the edit", { delay: 20 });
    await delay(2500);
    await forcesave(docId);
    const saved = parseDocx(await docFile(docId, "docx")).text;
    console.log(`the file: ${JSON.stringify(saved)}`);
    assert.match(saved, /Revenue figures were updated after the audit\./);
    assert.match(saved, /Findings/);
    assert.match(saved, /Ledger/);
    assert.match(saved, /Typed after the edit/);
    const xml = await (await JSZip.loadAsync(await docFile(docId, "docx"))).file("word/document.xml")!.async("string");
    assert.match(xml, /<w:tbl>/, "the table is a table in the file");
    await page.screenshot({ path: path.join(process.env.TMPDIR ?? "/var/tmp", "office-spike-word.png") });
    await page.context().close();
  });

  test("a spreadsheet: a write with a formula lands in the person's open sheet and is saved with its value", { timeout: 600_000 }, async () => {
    const made = await tools.office_create.execute("c2", { title: "Agent sheet", type: "cell" });
    const docId = String(made.details.id);
    const { page, frame } = await personOpens(docId);
    // The person types into C1, unsaved.
    await frame.evaluate(`window.Asc.editor.asc_findCell("C1")`);
    await page.keyboard.type("person\n", { delay: 30 });
    await delay(2000);
    const t0 = Date.now();
    await seat.run(home, docId, "edit", { kind: "cell.edit", args: { ops: [{ range: "A1:A3", values: [[2], [3], ["=A1*A2"]] }] } });
    // What the person's sheet holds in a cell, as its formula bar shows it (the selection is moved away and back, as
    // the bar is read where the selection changes).
    const cellText = (cell: string) => frame.evaluate(`(function () { var e = window.Asc.editor; e.asc_findCell("Z99"); e.asc_findCell(${JSON.stringify(cell)}); return e.asc_getCellInfo().asc_getText(); })()`) as Promise<string>;
    let a3 = "";
    const live = await waitFor(async () => (a3 = String(await cellText("A3")).trim()) === "=A1*A2" && String(await cellText("A1")).trim() === "2", 5000);
    console.log(`the person's A3 after ${Date.now() - t0} ms: ${JSON.stringify(a3)}`);
    assert.ok(live, "the agent's cells are in the person's open sheet within 5 s");
    const read = (await seat.run(home, docId, "edit", { kind: "cell.read", args: {} })) as { sheets: { name: string; cells: { a: string; v: unknown; f?: string }[] }[] };
    console.log(`the agent reads: ${JSON.stringify(read)}`);
    const cells = Object.fromEntries(read.sheets[0].cells.map((c) => [c.a, c]));
    assert.equal(cells.A3.v, 6);
    assert.equal(cells.A3.f, "=A1*A2");
    assert.equal(cells.C1.v, "person", "the person's unsaved cell is in the live read");
    await forcesave(docId);
    const sheet = await (await JSZip.loadAsync(await docFile(docId, "xlsx"))).file("xl/worksheets/sheet1.xml")!.async("string");
    console.log(`the saved sheet: ${sheet.slice(sheet.indexOf("<sheetData"), sheet.indexOf("</sheetData>") + 12)}`);
    assert.match(sheet, /<c r="A3"[^>]*><f>A1\*A2<\/f><v>6<\/v><\/c>/);
    await page.screenshot({ path: path.join(process.env.TMPDIR ?? "/var/tmp", "office-spike-cell.png") });
    await page.context().close();
  });

  test("a closed document is opened by the seat alone, three seats poll at once, a view seat reads live, and the way back holds", { timeout: 600_000 }, async () => {
    const ids: string[] = [];
    for (const title of ["Pool one", "Pool two", "Pool three"]) ids.push(String((await tools.office_create.execute(title, { title, type: "word" })).details.id));
    // Three seats at once, each writing: the page's and three plugins' long-polls are held through the relay.
    await Promise.all(ids.map((id, i) => seat.run(home, id, "edit", { kind: "word.edit", args: { ops: [{ paragraphs: [`Written by seat ${i}`] }] } })));
    assert.equal(seat.seats().length, 3);
    // Their saves' callbacks and downloads come through the way back while those polls are held.
    await Promise.all(ids.map((id) => forcesave(id)));
    for (const [i, id] of ids.entries()) assert.match(parseDocx(await docFile(id, "docx")).text, new RegExp(`Written by seat ${i}`));
    // Each answers again after a full long-poll cycle.
    await delay(27_000);
    await Promise.all(ids.map((id, i) => seat.run(home, id, "edit", { kind: "word.read", args: {} }).then((r) => assert.ok(texts(r).includes(`Written by seat ${i}`)))));

    // A fourth document takes the place of the least recently used one.
    const fourth = String((await tools.office_create.execute("Pool four", { title: "Pool four", type: "word" })).details.id);
    await seat.run(home, fourth, "edit", { kind: "word.read", args: {} });
    assert.equal(seat.seats().length, 3);

    // A seat in view mode of another agent home reads the person's live typing.
    const other = canonical(path.join(process.env.WORKSPACE_ROOT!, "beta"));
    const { page, frame } = await personOpens(ids[1]);
    await frame.locator("#editor_sdk").click({ position: { x: 300, y: 200 } });
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" and the person", { delay: 20 });
    await delay(2500);
    const viewed = texts(await seat.run(other, ids[1], "view", { kind: "word.read", args: {} }));
    console.log(`the view seat reads: ${JSON.stringify(viewed)}`);
    assert.ok(viewed.some((t) => t.includes("and the person")), "a view seat reads live");
    await page.context().close();

    // The browser stayed up the whole time, with no debugging port to keep it.
    const agent = JSON.parse(execFileSync("docker", ["inspect", `${PREFIX}-agent`], { encoding: "utf8" }))[0];
    assert.equal(agent.State.Running, true);
    assert.equal(agent.RestartCount, 0);
    console.log(`the agents' browser: ${execFileSync("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", `${PREFIX}-agent`], { encoding: "utf8" }).trim()}`);
  });
}
