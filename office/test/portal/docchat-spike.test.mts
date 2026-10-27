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
import { EDITOR_HTML, editorPageJs } from "./page.mts";
import { docxThreads, xlsxThreads } from "../../src/ooxml.ts";

/**
 * The gate of comments and the editor's chat as the way to talk to agents (step 1 of office-docchat-plan.md): in the
 * real Document Server 10.0.0.1, what the design stands on for the people's pages.
 * - The editor's own UI calls its API (`Asc.editor`) through five names the page can wrap: a comment
 *   (`asc_addComment`, the GUID in the call's argument), a reply and a resolve (`asc_changeComment`), a delete
 *   (`asc_removeComment`), a chat message (`asc_coAuthoringChatSendMessage`). Only the author's page calls them; the
 *   others, and a late joiner, hear the same events with no call. An undo of a delete brings the comment back with
 *   the same GUID and no call. In Word the event comes inside the call, in a spreadsheet after it.
 * - The mention list (onRequestUsers / setUsers) takes a bare name as its "email" and inserts it after a "+":
 *   `+Aegis`, `+project:Report`, `+My Agent`, in Word and in a cell comment.
 * - A Word thread's GUID is its durableId in the saved file (word/commentsIds.xml); a cell thread's GUID is its
 *   threaded comment's id. A deleted row's comment goes with `asc_onRemoveComments` (plural).
 * - The command service's `info` answers the users of a session.
 *
 * Opt-in like e2e.test.mts (OFFICE_E2E=1 and PITHAGORAS_DIR), with names of its own (`office-docchat-spike…`).
 */

const DIR = process.env.PITHAGORAS_DIR;
if (process.env.OFFICE_E2E !== "1" || !DIR) {
  test("comments and the editor's chat in the real Document Server", { skip: "set OFFICE_E2E=1 and PITHAGORAS_DIR (see e2e.test.mts)" }, () => {});
} else {
  await run(path.resolve(DIR));
}

/** What the page installs in an editor's frame: the five calls wrapped (each call recorded with what it was given,
 * and a mark when it returned), and the events recorded in the order they came. */
export const INSTRUMENT = `(function () {
  if (window.__instrumented) return;
  window.__instrumented = true;
  window.__log = [];
  var a = window.Asc.editor;
  var data = function (x) {
    try {
      if (x && typeof x.asc_getText === "function") return { text: x.asc_getText(), guid: x.asc_getGuid ? x.asc_getGuid() : undefined, user: x.asc_getUserId ? x.asc_getUserId() : undefined, solved: x.asc_getSolved ? x.asc_getSolved() : undefined, replies: x.asc_getRepliesCount ? x.asc_getRepliesCount() : undefined };
      if (Array.isArray(x)) return x.map(data);
      if (x && typeof x === "object" && x.Comment) return { id: x.Id, comment: data(x.Comment) };
      return x;
    } catch (e) { return String(e); }
  };
  ["asc_addComment", "asc_changeComment", "asc_removeComment", "asc_RemoveAllComments", "asc_coAuthoringChatSendMessage"].forEach(function (name) {
    var real = a[name];
    a[name] = function () {
      window.__log.push({ call: name, args: Array.prototype.map.call(arguments, data) });
      var out = real.apply(this, arguments);
      window.__log.push({ returned: name });
      return out;
    };
  });
  ["asc_onAddComment", "asc_onChangeCommentData", "asc_onRemoveComment", "asc_onAddComments", "asc_onRemoveComments", "asc_onChangeComments", "asc_onCoAuthoringChatReceiveMessage"].forEach(function (name) {
    a.asc_registerCallback(name, function () { window.__log.push({ event: name, args: Array.prototype.map.call(arguments, data) }); });
  });
})()`;

type Logged = { call?: string; returned?: string; event?: string; args?: unknown[] };

async function run(PITHAGORAS: string): Promise<void> {
  const from = (file: string) => pathToFileURL(path.join(PITHAGORAS, file)).href;
  const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const IMAGE = process.env.OFFICE_E2E_IMAGE ?? "onlyoffice/documentserver:10.0.0.1";
  const PREFIX = process.env.OFFICE_E2E_CONTAINER ?? "office-docchat-spike";

  const { inProcessHome } = await import(from("tests/helpers.mts"));
  inProcessHome("office-docchat-spike-");
  process.env.PORTAL_PASSWORD = "";
  process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
  process.env.PITHAGORAS_OFFICE_CONTAINER = PREFIX;
  process.env.PITHAGORAS_OFFICE_PORT = process.env.OFFICE_E2E_PORT ?? "3985";
  const seat = await import("../../src/seat.ts");
  const callback = await import("../../src/callback.ts");
  const container = await import("../../src/container.ts");
  const { canonical } = await import("../../src/store.ts");
  const live = await import("../../src/live.ts");
  assert.equal(container.NAMES.container, PREFIX);

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

  const project = path.join(process.env.WORKSPACE_ROOT!, "acme");
  mkdirSync(project, { recursive: true });
  const home = canonical(project);
  const chatId = `office-docchat-spike-${randomUUID().slice(0, 8)}`;
  type Tool = { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> };
  const tools: Record<string, Tool> = {};
  const docFile = async (docId: string, ext: "docx" | "xlsx") => {
    const file = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === docId);
    return readFileSync(path.join(data, "docs", docId, `${file.title}.${ext}`));
  };

  test("the Document Server comes up", { timeout: 600_000 }, async () => {
    await host.syncServerHalves([half(path.join(PITHAGORAS, "extensions/docker"), "src/server.ts"), half(PACKAGE, "src/server.ts")]);
    assert.equal(host.serverFailure("@pithagoras/office"), undefined);
    let state = "";
    for (let i = 0; i < 300 && state !== "running"; i++) {
      state = (await json(`${at}/container/status`)).body.state;
      if (state !== "running") await delay(2000);
    }
    assert.equal(state, "running", "the Document Server is set up");
    // And done making its fonts, which a Document Server made anew (a new secret: a new data folder) does first.
    for (let i = 0; i < 300 && !(await container.settled()); i++) await delay(2000);
    db.createSession({ id: chatId, title: chatId, workspace: project, executor: "host", kind: "task" });
    for (const { factory } of host.hostExtensions(chatId)) factory({ registerTool: (t: { name: string }) => (tools[t.name] = t as never), on() {}, registerCommand() {}, events: { on: () => () => {} } });
    assert.ok(tools.office_create);
  });

  /** The people's mention list as the plan's page gives it: a bare name where OnlyOffice wants an e-mail. */
  const MENTION_HOOK = `window.__asked = [];
window.__configHook = function (config) {
  config.events = config.events || {};
  config.events.onRequestUsers = function (e) {
    var asked = e && e.data || {};
    window.__asked.push(asked);
    if (asked.c !== "mention") return;
    window.__editor.setUsers({ c: "mention", users: [{ name: "Aegis", email: "Aegis" }, { name: "Report (project)", email: "project:Report" }, { name: "My Agent", email: "My Agent" }] });
  };
};`;

  /** A person's editor of `docId`, as the Office page opens it, with the mention list and the frame instrumented. */
  async function personOpens(docId: string): Promise<{ page: Page; frame: Frame }> {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.addInitScript(MENTION_HOOK);
    page.on("console", (m) => process.env.OFFICE_E2E_DEBUG && console.log(`[page] ${m.text()}`.slice(0, 300)));
    page.on("pageerror", (e) => process.env.OFFICE_E2E_DEBUG && console.log(`[pageerror] ${e.message}`));
    await page.goto(`${origin}/editor.html?doc=${encodeURIComponent(docId)}`);
    const events = () => page.evaluate(() => (window as unknown as { __events: unknown[][] }).__events);
    for (let i = 0; i < 120 && !(await events()).some((e) => e[0] === "ready"); i++) await delay(1000);
    assert.ok((await events()).some((e) => e[0] === "ready"), JSON.stringify(await events()));
    let frame: Frame | undefined;
    for (let i = 0; i < 60 && !frame; i++) {
      for (const f of page.frames().filter((f) => /editor\/main\//.test(f.url()))) if (await f.evaluate("Boolean(window.Asc && window.Asc.editor)").catch(() => false)) frame = f;
      if (!frame) await delay(500);
    }
    assert.ok(frame, "the person's editor frame");
    await frame.evaluate(INSTRUMENT);
    return { page, frame };
  }
  const logOf = (frame: Frame) => frame.evaluate("window.__log") as Promise<Logged[]>;
  const clearLog = (frame: Frame) => frame.evaluate("window.__log.length = 0");
  const waitFor = async (what: () => Promise<boolean>, ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await what()) return true;
      await delay(150);
    }
    return false;
  };
  /** The comments controller of the editor's UI (Word's DE, the spreadsheet's SSE): what its buttons call. */
  const controller = (frame: Frame) => `(window.DE || window.SSE).getController("Common.Controllers.Comments")`;
  /** A comment made in the popover, as a person makes one: the selection's Comment, typed with a pick from the list
   * after each "@…" of `parts` ([text, search, name to pick, text …]), then Add. */
  async function commentThroughPopover(page: Page, frame: Frame, parts: string[]): Promise<string> {
    await frame.evaluate(`${controller(frame)}.addDummyComment()`);
    await delay(800);
    await frame.locator("textarea.msg-reply").first().click();
    for (let i = 0; i < parts.length; i += 3) {
      await page.keyboard.type(parts[i], { delay: 30 });
      if (parts[i + 1] === undefined) break;
      await page.keyboard.type(`@${parts[i + 1]}`, { delay: 60 });
      await delay(1000);
      await frame.locator("li", { hasText: parts[i + 2] }).first().click();
      await delay(300);
    }
    const typed = (await frame.evaluate(`Array.from(document.querySelectorAll("textarea.msg-reply")).filter(function (t) { return t.offsetParent; }).map(function (t) { return t.value; })[0]`)) as string;
    await frame.locator("button", { hasText: /^Add$/ }).first().click();
    return typed;
  }

  test("Word: the UI's calls go through the page's wrappers in the author's page only, a picked mention reads +Name, and the GUID is the durableId in the saved file", { timeout: 600_000 }, async () => {
    const docId = String((await tools.office_create.execute("w", { title: "Word mentions", type: "word" })).details.id);
    const author = await personOpens(docId);
    const other = await personOpens(docId);
    await author.frame.locator("#editor_sdk").click({ position: { x: 300, y: 200 } });
    await author.page.keyboard.type("Revenue figures were revised after the audit.", { delay: 10 });
    await author.page.keyboard.press("Control+a");
    await clearLog(author.frame);
    await clearLog(other.frame);

    const typed = await commentThroughPopover(author.page, author.frame, ["Bitte übersetzen ", "Ae", "Aegis", "und ", "project:Re", "Report", "auch ", "My", "My Agent", "danke"]);
    assert.equal(typed.trim(), "Bitte übersetzen +Aegis und +project:Report auch +My Agent danke", "a picked name is inserted as +Name");
    const asked = await author.page.evaluate(() => (window as unknown as { __asked: { c: string; search?: string }[] }).__asked);
    assert.ok(asked.some((a) => a.c === "mention" && a.search === "Ae"), JSON.stringify(asked));
    assert.ok(await waitFor(async () => (await logOf(other.frame)).some((e) => e.event === "asc_onAddComment"), 5000), "the other page hears the comment");

    const log = await logOf(author.frame);
    const call = log.findIndex((e) => e.call === "asc_addComment");
    assert.ok(call >= 0, JSON.stringify(log));
    const guid = (log[call].args![0] as { guid: string }).guid;
    assert.match(guid, /^[0-9a-f]{8}$/);
    const added = log.findIndex((e) => e.event === "asc_onAddComment");
    const returned = log.findIndex((e) => e.returned === "asc_addComment");
    assert.ok(call < added && added < returned, `in Word the event comes inside the call: ${JSON.stringify(log)}`);
    assert.equal(((log[added].args![1]) as { guid: string }).guid, guid, "the event carries the call's GUID");
    assert.ok(!(await logOf(other.frame)).some((e) => e.call), "the other page calls nothing");
    const sessionId = String(log[added].args![0]);

    // A reply and a resolve, as their buttons do; an unresolve; then a delete, and its undo.
    await clearLog(author.frame);
    await author.frame.evaluate(`${controller(author.frame)}.onAddReplyComment(${JSON.stringify(sessionId)}, "Noch eine Frage +Aegis")`);
    await author.frame.evaluate(`${controller(author.frame)}.onResolveComment(${JSON.stringify(sessionId)})`);
    await delay(1000);
    const changes = (await logOf(author.frame)).filter((e) => e.call === "asc_changeComment");
    assert.equal(changes.length, 2, "a reply and a resolve are each one asc_changeComment");
    assert.equal((changes[0].args![1] as { replies: number }).replies, 1);
    assert.equal((changes[1].args![1] as { solved: boolean }).solved, true);
    await clearLog(other.frame);
    await author.frame.evaluate(`${controller(author.frame)}.onRemoveComment(${JSON.stringify(sessionId)})`);
    assert.ok(await waitFor(async () => (await logOf(other.frame)).some((e) => e.event === "asc_onRemoveComment"), 5000));
    assert.ok((await logOf(author.frame)).some((e) => e.call === "asc_removeComment"), "a delete is asc_removeComment");
    await clearLog(author.frame);
    await author.frame.evaluate("window.Asc.editor.Undo()");
    assert.ok(await waitFor(async () => (await logOf(author.frame)).some((e) => e.event === "asc_onAddComment"), 5000));
    const undone = await logOf(author.frame);
    assert.ok(!undone.some((e) => e.call), `an undo calls none of the five: ${JSON.stringify(undone)}`);
    assert.equal((undone.find((e) => e.event === "asc_onAddComment")!.args![1] as { guid: string }).guid, guid, "the undo brings the same GUID back");

    // Saved: the GUID is the comment's durableId.
    const key = (await other.page.evaluate(() => (window as unknown as { __key: string }).__key)) as string;
    const userdata = `office-${randomUUID()}`;
    const waiting = callback.awaitForcesave(userdata);
    assert.equal((await callback.command({ c: "forcesave", key, userdata })).error, 0);
    assert.equal(await Promise.race([waiting.done, delay(30_000).then(() => "timeout")]), "saved");
    const zip = await JSZip.loadAsync(await docFile(docId, "docx"));
    const ids = (await zip.file("word/commentsIds.xml")?.async("string")) ?? "";
    assert.match(ids, new RegExp(`durableId="${guid}"`, "i"), `the durableId is the GUID: ${ids}`);

    // The command service's info answers who is in the session.
    const info = await callback.command({ c: "info", key });
    assert.equal(info.error, 0);
    assert.ok(Array.isArray(info.users) && (info.users as string[]).includes("portal-user"), JSON.stringify(info));
    await author.page.context().close();
    await other.page.context().close();
  });

  test("the editor's chat: the panel's Send is asc_coAuthoringChatSendMessage in the sender's page; everyone hears it, a late joiner its history, with no call", { timeout: 600_000 }, async () => {
    const docId = String((await tools.office_create.execute("c", { title: "Chat", type: "word" })).details.id);
    const sender = await personOpens(docId);
    await sender.frame.locator("#left-btn-chat").click();
    await delay(500);
    await sender.frame.locator("#chat-msg-text").click();
    await sender.page.keyboard.type("Hallo Agent, fasse bitte zusammen", { delay: 10 });
    await sender.frame.locator("#chat-msg-btn-add").click();
    assert.ok(await waitFor(async () => (await logOf(sender.frame)).some((e) => e.event === "asc_onCoAuthoringChatReceiveMessage"), 5000));
    const log = await logOf(sender.frame);
    const sent = log.find((e) => e.call === "asc_coAuthoringChatSendMessage");
    assert.equal(sent?.args?.[0], "Hallo Agent, fasse bitte zusammen");
    const heard = log.find((e) => e.event === "asc_onCoAuthoringChatReceiveMessage")!.args![0] as { message: string; useridoriginal: string }[];
    assert.equal(heard[0].useridoriginal, "portal-user");
    // A late joiner: the history comes as events, with no call of its own.
    const late = await personOpens(docId);
    await delay(1500);
    // Its instrument was put in after the document was ready: the history it was sent then is asked again by its chat
    // panel when that opens.
    await late.frame.locator("#left-btn-chat").click();
    await delay(1500);
    const lateLog = await logOf(late.frame);
    assert.ok(!lateLog.some((e) => e.call), `a late joiner calls nothing: ${JSON.stringify(lateLog)}`);
    await sender.page.context().close();
    await late.page.context().close();
  });

  test("a spreadsheet: a cell comment through the popover, with its picked mention, goes through asc_addComment, its event after the call; a deleted row removes it with the plural event; its GUID is the threaded comment's id", { timeout: 600_000 }, async () => {
    const docId = String((await tools.office_create.execute("s", { title: "Sheet mentions", type: "cell" })).details.id);
    const author = await personOpens(docId);
    const other = await personOpens(docId);
    await author.frame.evaluate(`window.Asc.editor.asc_findCell("B2")`);
    await clearLog(author.frame);
    const typed = await commentThroughPopover(author.page, author.frame, ["Bitte prüfen ", "Ae", "Aegis", "danke"]);
    assert.equal(typed.trim(), "Bitte prüfen +Aegis danke");
    assert.ok(await waitFor(async () => (await logOf(author.frame)).some((e) => e.event === "asc_onAddComment"), 5000));
    const log = await logOf(author.frame);
    const call = log.findIndex((e) => e.call === "asc_addComment");
    const guid = (log[call].args![0] as { guid: string }).guid;
    assert.match(guid, /^\{[0-9A-F-]{36}\}$/i);
    const returned = log.findIndex((e) => e.returned === "asc_addComment");
    const added = log.findIndex((e) => e.event === "asc_onAddComment");
    assert.ok(returned < added, `in a spreadsheet the event comes after the call: ${JSON.stringify(log)}`);
    assert.equal((log[added].args![1] as { guid: string }).guid, guid);
    assert.ok(await waitFor(async () => (await logOf(other.frame)).some((e) => e.event === "asc_onAddComment"), 5000));
    assert.ok(!(await logOf(other.frame)).some((e) => e.call));

    // Saved: the threaded comment's id is the GUID.
    const key = (await other.page.evaluate(() => (window as unknown as { __key: string }).__key)) as string;
    const userdata = `office-${randomUUID()}`;
    const waiting = callback.awaitForcesave(userdata);
    assert.equal((await callback.command({ c: "forcesave", key, userdata })).error, 0);
    assert.equal(await Promise.race([waiting.done, delay(30_000).then(() => "timeout")]), "saved");
    const zip = await JSZip.loadAsync(await docFile(docId, "xlsx"));
    const threaded = Object.keys(zip.files).filter((n) => /^xl\/threadedComments\//.test(n));
    const xml = (await Promise.all(threaded.map((n) => zip.file(n)!.async("string")))).join("\n");
    assert.ok(xml.toUpperCase().includes(`ID="${guid.toUpperCase()}"`), `the threaded comment's id is the GUID: ${xml.slice(0, 400)}`);

    // The row deleted: the comment goes with asc_onRemoveComments, called by nobody's comment code.
    await clearLog(author.frame);
    await clearLog(other.frame);
    await author.frame.evaluate(`(function () { var e = window.Asc.editor; e.asc_findCell("B2"); e.asc_deleteCells(Asc.c_oAscDeleteOptions.DeleteRows); })()`);
    assert.ok(await waitFor(async () => (await logOf(other.frame)).some((e) => e.event === "asc_onRemoveComments" || e.event === "asc_onRemoveComment"), 5000), "the other page hears the removal");
    const removed = [...(await logOf(author.frame)), ...(await logOf(other.frame))];
    assert.ok(removed.some((e) => e.event === "asc_onRemoveComments"), `the plural event: ${JSON.stringify(removed)}`);
    assert.ok(!removed.some((e) => e.call), "no wrapped call for a deleted row");
    await author.page.context().close();
    await other.page.context().close();
  });

  /** A forcesave of the session `key`, waited for. */
  /** A forcesave of the session `key`, waited for; with `maybeSaved`, one that has nothing new to save (4) is fine. */
  async function forcesave(key: string, maybeSaved = false): Promise<void> {
    const userdata = `office-${randomUUID()}`;
    const waiting = callback.awaitForcesave(userdata);
    const asked = (await callback.command({ c: "forcesave", key, userdata })).error;
    if (maybeSaved && asked === 4) return waiting.forget();
    assert.equal(asked, 0);
    assert.equal(await Promise.race([waiting.done, delay(30_000).then(() => "timeout")]), "saved");
  }
  const repliesOf = (frame: Frame) => frame.evaluate(`JSON.stringify(${controller(frame)}.collection.map(function (c) { return { guid: c.get("guid"), text: c.get("comment"), replies: (c.get("replys") || []).map(function (r) { return [r.get("username"), r.get("reply"), r.get("userid")]; }) }; }))`).then((s) => JSON.parse(s as string) as { guid: string; text: string; replies: string[][] }[]);
  const commenter = () => canonical(path.join(process.env.WORKSPACE_ROOT!, "beta"));

  test("the agents' side in Word: the comments with their GUIDs, a reply by GUID in both people's editors, a reply from an editor that may only comment, a chat message as the agent, an edit of a larger text that keeps the comment on the new text, and the saved file read as threads", { timeout: 600_000 }, async () => {
    const docId = String((await tools.office_create.execute("a", { title: "Agent replies", type: "word" })).details.id);
    const author = await personOpens(docId);
    const other = await personOpens(docId);
    await author.frame.locator("#editor_sdk").click({ position: { x: 300, y: 200 } });
    await author.page.keyboard.type("Revenue figures were revised after the audit.", { delay: 10 });
    await delay(500);
    // A comment on one word of the sentence: a replace of the larger text would take it away.
    await author.page.keyboard.press("Control+Home");
    for (let i = 0; i < 21; i++) await author.page.keyboard.press("ArrowRight");
    for (let i = 0; i < 7; i++) await author.page.keyboard.press("Shift+ArrowRight");
    await commentThroughPopover(author.page, author.frame, ["Bitte übersetzen ", "Ae", "Aegis"]);
    assert.ok(await waitFor(async () => (await repliesOf(other.frame)).length === 1, 5000));
    const guid = (await repliesOf(author.frame))[0].guid;

    const listed = (await seat.run(home, docId, "edit", { kind: "word.comments", args: {} })) as { comments: { guid: string; text: string; userId: string; quote: string }[] };
    assert.deepEqual(listed.comments.map((c) => [c.guid, c.text.trim(), c.userId]), [[guid, "Bitte übersetzen +Aegis", "portal-user"]]);
    assert.match(listed.comments[0].quote, /^revised/);

    await seat.run(home, docId, "edit", { kind: "word.reply", args: { guid, text: "Übersetzt.", author: "Acme (agent)", userId: "agent:acme" } });
    for (const page of [author, other]) {
      assert.ok(await waitFor(async () => (await repliesOf(page.frame))[0].replies.some((r) => r[1] === "Übersetzt." && r[0] === "Acme (agent)" && r[2] === "agent:acme"), 5000), "the reply shows as the agent's");
    }
    // An agent that may only view the document comments through an editor that may only comment: Word makes the
    // comment anew for it, under a GUID of its own, which the answer names and the people's editors hear.
    await other.frame.evaluate(`window.__log.length = 0`);
    const methodReply = (await seat.run(commenter(), docId, "comment", { kind: "word.reply", args: { how: "method", guid, text: "Gelesen.", author: "Beta (agent)", userId: "agent:beta" } })) as { guid?: string };
    assert.ok(await waitFor(async () => (await repliesOf(other.frame))[0].replies.some((r) => r[1] === "Gelesen." && r[0] === "Beta (agent)"), 5000), "the comment-only editor's reply shows");
    const nowGuid = ((await seat.run(home, docId, "edit", { kind: "word.comments", args: {} })) as { comments: { guid: string }[] }).comments[0].guid;
    assert.equal(methodReply.guid ?? guid, nowGuid, "the answer names the thread's GUID as it is now");
    const heard = (await logOf(other.frame)).filter((e) => e.event === "asc_onChangeCommentData" || e.event === "asc_onAddComment").map((e) => (e.args![1] as { guid: string }).guid);
    console.log(`after the comment-only reply: the builder's GUID ${nowGuid}, the people's editor heard ${JSON.stringify(heard)}`);
    assert.ok(heard.includes(nowGuid), "the people's editor hears the comment under that GUID");
    await assert.rejects(seat.run(commenter(), docId, "comment", { kind: "word.edit", args: { ops: [{ paragraphs: ["x"] }] } }), (e: { code?: string }) => e.code === "read_only");

    // A chat message as the agent, from an editor that may only view as well.
    await other.frame.evaluate(`window.__log.length = 0`);
    await seat.run(commenter(), docId, "view", { kind: "chat.send", args: { text: "Hallo von Beta" } });
    assert.ok(await waitFor(async () => (await logOf(other.frame)).some((e) => e.event === "asc_onCoAuthoringChatReceiveMessage" && JSON.stringify(e.args).includes("Hallo von Beta") && JSON.stringify(e.args).includes("agent:")), 5000), "the chat message comes from the agent's editor");

    // The agent replaces the whole sentence's middle: the comment on "revised" would go; it is made again on the new
    // text, with its replies, and the move is answered.
    const edited = (await seat.run(home, docId, "edit", { kind: "word.edit", args: { ops: [{ quote: "were revised after", replacement: "wurden nach" }] } })) as { moved?: string[][] };
    assert.equal(edited.moved?.length, 1, JSON.stringify(edited));
    assert.equal(edited.moved![0][0], nowGuid);
    const moved = edited.moved![0][1];
    let now: { guid: string; text: string; replies: string[][] }[] = [];
    assert.ok(await waitFor(async () => (now = await repliesOf(other.frame)).length === 1 && now[0].text.includes("Bitte übersetzen") && now[0].replies.length === 2, 5000), JSON.stringify(now));
    const after = (await seat.run(home, docId, "edit", { kind: "word.comments", args: {} })) as { comments: { guid: string; quote: string; replies: unknown[] }[] };
    assert.equal(after.comments[0].guid, moved);
    assert.match(after.comments[0].quote, /^wurden nach/, "on the replacement");

    // Saved: the moved comment's GUID is its durableId, and the file reads as one thread with both replies.
    await forcesave(seat.keyOf(home, docId)!);
    const threads = docxThreads(await docFile(docId, "docx"));
    assert.equal(threads.length, 1, JSON.stringify(threads));
    assert.equal(threads[0].guid, moved);
    assert.equal(threads[0].userId, "portal-user");
    assert.deepEqual(threads[0].replies.map((r) => [r.author, r.text, r.userId]), [["Acme (agent)", "Übersetzt.", "agent:acme"], ["Beta (agent)", "Gelesen.", "agent:beta"]]);
    await author.page.context().close();
    await other.page.context().close();
  });

  test("the agents' side in a spreadsheet: the comments by session id, a reply found by author, text and time, from an editor that may only comment too, and the saved file read as threads", { timeout: 600_000 }, async () => {
    const docId = String((await tools.office_create.execute("b", { title: "Agent sheet replies", type: "cell" })).details.id);
    const person = await personOpens(docId);
    await person.frame.evaluate(`window.Asc.editor.asc_findCell("C3")`);
    await commentThroughPopover(person.page, person.frame, ["Bitte prüfen ", "Ae", "Aegis"]);
    assert.ok(await waitFor(async () => (await repliesOf(person.frame)).length === 1, 5000));
    const listed = (await seat.run(home, docId, "edit", { kind: "cell.comments", args: {} })) as { comments: { sessionId: string; text: string; userId: string; time: number }[] };
    assert.equal(listed.comments.length, 1);
    const c = listed.comments[0];
    const match = { userId: c.userId, author: (c as { author?: string }).author, text: c.text, time: c.time };
    // A reply on a cell comment the person had just made, from an editor of the agent's that opened at that moment, was
    // now and then lost for good (in the agent's editor too). docchat waits until a cell comment is 5 s old, and posts
    // a lost reply again from an editor opened anew: so does this.
    await delay(5000);
    const reply = { kind: "cell.reply", args: { sessionId: "no-such-id", match, text: "Geprüft.", author: "Acme (agent)", userId: "agent:acme" } };
    await seat.run(home, docId, "edit", reply);
    if (!(await waitFor(async () => (await repliesOf(person.frame))[0].replies.length === 1, 10_000))) {
      console.log("the reply on the fresh cell comment was lost: posted again from an editor opened anew");
      seat.closeEditor(home, docId, "a lost reply");
      await seat.run(home, docId, "edit", reply);
    }
    // Each change rewrites the thread from the changing editor's view: the next waits until the first is everywhere.
    assert.ok(await waitFor(async () => (await repliesOf(person.frame))[0].replies.length === 1, 20_000), JSON.stringify(await repliesOf(person.frame)));
    await delay(1000);
    // The spreadsheet editor takes the builder's reply in an editor that may only comment (Word's rolls it back).
    await seat.run(commenter(), docId, "comment", { kind: "cell.reply", args: { match, text: "Gesehen.", author: "Beta (agent)", userId: "agent:beta" } });
    assert.ok(await waitFor(async () => (await repliesOf(person.frame))[0].replies.length === 2, 8000), JSON.stringify(await repliesOf(person.frame)));
    await forcesave(seat.keyOf(home, docId)!);
    const threads = xlsxThreads(await docFile(docId, "xlsx"));
    assert.equal(threads.length, 1, JSON.stringify(threads));
    assert.equal(threads[0].guid, (await repliesOf(person.frame))[0].guid);
    assert.equal(threads[0].cell, "C3");
    assert.deepEqual(threads[0].replies.map((r) => [r.author, r.text]), [["Acme (agent)", "Geprüft."], ["Beta (agent)", "Gesehen."]]);
    await person.page.context().close();
  });

  test("a later session with nobody in the document: the agent's editor replies by the GUID the file keeps", { timeout: 600_000 }, async () => {
    const docId = String((await tools.office_create.execute("l", { title: "Later reply", type: "word" })).details.id);
    const person = await personOpens(docId);
    await person.frame.locator("#editor_sdk").click({ position: { x: 300, y: 200 } });
    await person.page.keyboard.type("Later.", { delay: 10 });
    await person.page.keyboard.press("Control+a");
    await commentThroughPopover(person.page, person.frame, ["Später bitte"]);
    assert.ok(await waitFor(async () => (await repliesOf(person.frame)).length === 1, 5000));
    const guid = (await repliesOf(person.frame))[0].guid;
    await delay(3000); // the editor sends the comment a moment after it was made
    await person.page.context().close();
    // The session ends (the person left), and its close saves the comment; the next editor opens a new session.
    assert.ok(await waitFor(async () => live.sessionKeys(docId).length === 0, 60_000), "the session ended");
    assert.ok(await waitFor(async () => docxThreads(await docFile(docId, "docx")).some((t) => t.guid === guid), 30_000), JSON.stringify(docxThreads(await docFile(docId, "docx"))));
    await seat.run(home, docId, "edit", { kind: "word.reply", args: { guid, text: "Jetzt.", author: "Acme (agent)", userId: "agent:acme" } });
    await forcesave(seat.keyOf(home, docId)!, true);
    assert.ok(await waitFor(async () => docxThreads(await docFile(docId, "docx")).find((t) => t.guid === guid)?.replies.some((r) => r.text === "Jetzt.") ?? false, 30_000), JSON.stringify(docxThreads(await docFile(docId, "docx"))));
  });
}
