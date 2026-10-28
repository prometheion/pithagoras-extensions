import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { EDITOR_HTML, editorPageJs } from "./page.mts";

/**
 * The people's editor's half of comments and the editor's chat with agents (src/web/docchat-page.ts, through
 * office-editor.tsx), in a browser with the portal's own React, against routes that answer as the server half does and
 * a stand-in for the Document Server's api.js whose frame has an `Asc.editor` that calls its listeners as the real one
 * does: in Word inside the call, in a spreadsheet after it. What the real editor does is docchat-spike.test.mts's.
 */

const DIR = process.env.PITHAGORAS_DIR;
if (!DIR) throw new Error("PITHAGORAS_DIR is not set: run scripts/pithagoras.sh, then PITHAGORAS_DIR=.pithagoras npm run test:portal");
const BASE = "/api/x/%40pithagoras/office";

/**
 * The stand-in: an editor whose frame (same origin) holds `Asc.editor` with the five calls and asc_registerCallback.
 * `window.__mode` says when a call's event comes: "word" inside it, "cell" after it, "lost" never. `window.__emit(name,
 * ...args)` raises an event as the editor would for what nobody on this page called (a co-author, an undo, a load).
 * `window.__data(fields)` makes a comment's data as the editor's API gives it.
 */
const FAKE_API = `
window.__data = function (f) {
  return {
    asc_getText: () => f.text || "", asc_getGuid: () => f.guid || "", asc_getUserId: () => f.userId || "", asc_getUserName: () => f.userName || "",
    asc_getSolved: () => Boolean(f.solved), asc_getQuoteText: () => f.quote || "", asc_getId: () => f.id || "",
    asc_getRepliesCount: () => (f.replies || []).length, asc_getReply: (i) => window.__data(f.replies[i]),
    asc_getOnlyOfficeTime: () => f.ooTime || "",
  };
};
window.DocsAPI = { DocEditor: function (id, config) {
  const frame = document.createElement("iframe");
  document.getElementById(id).replaceWith(frame);
  window.__fake = window.__fake || { opened: [], setUsers: [], config: null };
  window.__fake.opened.push(config.document.key);
  window.__fake.config = config;
  const listeners = {};
  const emit = (name, ...args) => (listeners[name] || []).forEach((fn) => fn(...args));
  window.__emit = emit;
  const later = (fn) => (window.__mode === "cell" ? setTimeout(fn, 50) : window.__mode === "lost" ? null : fn());
  const api = {
    asc_registerCallback: (name, fn) => (listeners[name] = listeners[name] || []).push(fn),
    asc_addComment: (data) => later(() => emit("asc_onAddComment", "1_" + (++window.__ids), data)),
    asc_changeComment: (id, data) => later(() => emit("asc_onChangeCommentData", id, data)),
    asc_removeComment: (id) => emit("asc_onRemoveComment", id),
    asc_RemoveAllComments: () => {},
    asc_coAuthoringChatSendMessage: (text) => window.__mode !== "lost" && setTimeout(() => emit("asc_onCoAuthoringChatReceiveMessage", [{ message: text, useridoriginal: "portal-user", username: "Portal" }], false), 20),
  };
  window.__ids = window.__ids || 0;
  window.__api = api;
  frame.contentWindow.Asc = { editor: api };
  // The editor app's comments panel, with what it loaded before the page listened (window.__panel).
  if (window.__panel) frame.contentWindow.DE = { getController: () => ({ collection: { models: window.__panel.map((c) => ({ get: (k) => c[k] })) } }) };
  setTimeout(() => (config.events.onAppReady && config.events.onAppReady(), config.events.onDocumentReady && config.events.onDocumentReady()), 0);
  return { destroyEditor() { frame.remove(); }, setUsers: (data) => window.__fake.setUsers.push(data) };
} };`;

const routes = { docchat: [] as unknown[], reports: [] as { path: string; body: any }[], mentionables: [] as { name: string; email: string }[], refuse: 0, off: undefined as string | undefined };
let pageJs = "";
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
  if (url.pathname === "/editor.html") return send(200, "text/html", EDITOR_HTML);
  if (url.pathname === "/editor-page.js") return send(200, "text/javascript", pageJs);
  if (url.pathname === "/fake-api.js") return send(200, "text/javascript", FAKE_API);
  if (url.pathname === `${BASE}/editor-config` && req.method === "POST") {
    return send(200, "application/json", JSON.stringify({ document: { key: "k1", fileType: "docx" }, editorConfig: { user: { id: "portal-user", name: "Portal" } }, token: "t", apiJs: "/fake-api.js" }));
  }
  if (url.pathname === `${BASE}/editor-state`) return send(200, "application/json", JSON.stringify({ standing: "current", docchat: routes.docchat, ...(routes.off ? { docchatOff: routes.off } : {}) }));
  if (url.pathname === `${BASE}/mentionables`) return send(200, "application/json", JSON.stringify({ users: routes.mentionables }));
  if (url.pathname.startsWith(`${BASE}/docchat/`) && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    // The route's body limit (docchat.CAPS.bytes): a larger request is refused whole.
    if (Buffer.concat(chunks).length > 256 * 1024) return send(413, "application/json", JSON.stringify({ error: "too large" }));
    routes.reports.push({ path: url.pathname.slice(BASE.length), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    // A portal too old for agents to answer: every report is refused, as the server half does.
    if (routes.off) return send(501, "application/json", JSON.stringify({ error: routes.off, code: "portal_too_old" }));
    if (routes.refuse) {
      routes.refuse--;
      return send(503, "application/json", JSON.stringify({ error: "away" }));
    }
    return send(200, "application/json", "{}");
  }
  if (url.pathname === `${BASE}/state`) {
    return send(200, "application/json", JSON.stringify({ enabled: true, imageTag: "x", container: { state: "running" }, docs: [{ docId: "d1", title: "Doc", ext: "docx", createdAt: 0, updatedAt: 0, sizeBytes: 1, mtimeMs: 1, owner: "/agents/home", path: "/agents/home/Doc.docx", grants: [] }], locks: { d1: [] } }));
  }
  send(404, "application/json", "{}");
});
let origin = "";
let browser: Browser;

before(async () => {
  pageJs = await editorPageJs(path.resolve(DIR), BASE);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => Object.assign(routes, { docchat: [], reports: [], mentionables: [{ name: "Aegis", email: "Aegis" }, { name: "Report (project)", email: "project:Report" }], refuse: 0, off: undefined }));

async function opened(mode: "word" | "cell" | "lost" = "word", query = ""): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript((m) => Object.assign(window, { __mode: m, __confirmMs: 600 }), mode);
  await page.goto(`${origin}/editor.html?doc=d1${query}`);
  await page.waitForFunction(() => (window as unknown as { __events: unknown[][] }).__events.some((e) => e[0] === "ready"), undefined, { timeout: 5000 });
  // The page hooks the frame once it is there.
  await page.waitForFunction(() => {
    const api = (window as unknown as { __api?: Record<string, unknown> }).__api;
    return Boolean(api && String(api.asc_addComment).includes("realAdd"));
  }, undefined, { timeout: 5000 }).catch(() => {});
  await delay(300);
  return page;
}

/** The events the page reported so far, of every request. */
const events = () => routes.reports.filter((r) => r.path === "/docchat/events").flatMap((r) => r.body.events as any[]);
const ui = () => events().filter((e) => e.type === "ui");
const until = async (what: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !what()) await delay(50);
  return what();
};

test("the mention list: typing @ asks the page, which answers from /mentionables, filtered by what was typed", async () => {
  const page = await opened();
  await page.evaluate(() => (window as any).__fake.config.events.onRequestUsers({ data: { c: "mention", search: "rep" } }));
  await page.evaluate(() => (window as any).__fake.config.events.onRequestUsers({ data: { c: "info", id: ["portal-user"] } }));
  await page.waitForFunction(() => (window as any).__fake.setUsers.length > 0);
  await delay(200);
  assert.deepEqual(await page.evaluate(() => (window as any).__fake.setUsers), [{ c: "mention", users: [{ name: "Report (project)", email: "project:Report" }] }], "only the mention is answered");
  await page.context().close();
});

test("Word: the UI's comment, reply, edit and resolve are ui reports once the editor heard them (inside the call); events nobody here called are state reports only", async () => {
  const page = await opened("word");
  await page.evaluate(() => {
    const w = window as any;
    w.__api.asc_addComment(w.__data({ text: "Bitte +Aegis", guid: "626360df", userId: "portal-user" }));
  });
  assert.ok(await until(() => ui().length === 1));
  assert.deepEqual(ui()[0], { ...ui()[0], kind: "comment", guid: "626360df", text: "Bitte +Aegis" });
  assert.deepEqual(Object.keys(routes.reports.find((r) => r.path === "/docchat/events")!.body).sort(), ["docId", "events", "key", "v"], "no chat rides along: the agent's own chat answers");
  assert.equal(routes.reports[0].body.v, 1);
  await page.evaluate(() => {
    const w = window as any;
    w.__api.asc_changeComment("1_1", w.__data({ text: "Bitte +Aegis", guid: "626360df", replies: [{ text: "Und das", userId: "portal-user" }] }));
    w.__api.asc_changeComment("1_1", w.__data({ text: "Bitte +Aegis und +Report", guid: "626360df", replies: [{ text: "Und das", userId: "portal-user" }] }));
    w.__api.asc_changeComment("1_1", w.__data({ text: "Bitte +Aegis und +Report", guid: "626360df", solved: true, replies: [{ text: "Und das", userId: "portal-user" }] }));
    // A co-author's comment and an undo's: heard, called by nobody here.
    w.__emit("asc_onAddComment", "2_1", w.__data({ text: "Von jemand anderem +Aegis", guid: "0badf00d", userId: "portal-user" }));
  });
  assert.ok(await until(() => ui().length === 4));
  assert.deepEqual(ui().map((e) => [e.kind, e.guid, e.text ?? e.solved]), [["comment", "626360df", "Bitte +Aegis"], ["reply", "626360df", "Und das"], ["edit", "626360df", "Bitte +Aegis und +Report"], ["resolve", "626360df", true]]);
  await delay(800);
  assert.equal(ui().length, 4, "the co-author's comment is no ui report");
  assert.ok(events().some((e) => e.type === "comment" && e.guid === "0badf00d"), "but a state report");
  await page.context().close();
});

test("a spreadsheet: the event after the call still makes the report; a call whose event never comes is dropped; the plural events are heard", async () => {
  const page = await opened("cell");
  await page.evaluate(() => {
    const w = window as any;
    w.__api.asc_addComment(w.__data({ text: "Prüfen +Aegis", guid: "{A}", userId: "portal-user" }));
  });
  assert.ok(await until(() => ui().length === 1));
  await page.evaluate(() => {
    const w = window as any;
    w.__mode = "lost";
    w.__api.asc_addComment(w.__data({ text: "Verloren +Aegis", guid: "{B}", userId: "portal-user" }));
    w.__emit("asc_onAddComments", [w.__data({ id: "sheet5_x", text: "Geladen", guid: "{C}" })]);
    w.__emit("asc_onChangeComments", [{ Id: "sheet5_x", Comment: w.__data({ id: "sheet5_x", text: "Geladen", guid: "{C}" }) }]);
    w.__emit("asc_onRemoveComments", ["sheet5_x"]);
  });
  await delay(1500);
  assert.deepEqual(ui().map((e) => e.guid), ["{A}"], "the one never heard is dropped");
  assert.ok(events().some((e) => e.type === "comment" && e.guid === "{C}" && e.sessionId === "sheet5_x"));
  assert.ok(events().some((e) => e.type === "removed" && e.guids.includes("{C}")));
  await page.context().close();
});

test("the GUID a comment's events carry is the one the page names it by, also after it changed; the editor's chat: a sent message once heard back, chunks of one send joined", async () => {
  const page = await opened();
  await page.evaluate(() => {
    const w = window as any;
    // An agent's comment: it comes with one GUID and changes to its lasting one.
    w.__emit("asc_onAddComment", "1_1", w.__data({ text: "Agent", guid: "4febae3a", userId: "agent:x" }));
    w.__emit("asc_onChangeCommentData", "1_1", w.__data({ text: "Agent", guid: "76d0b32d", userId: "agent:x" }));
    w.__api.asc_changeComment("1_1", w.__data({ text: "Agent", guid: "4febae3a", replies: [{ text: "Danke", userId: "portal-user" }] }));
    w.__api.asc_coAuthoringChatSendMessage("Teil eins, ");
    w.__api.asc_coAuthoringChatSendMessage("Teil zwei");
  });
  assert.ok(await until(() => ui().length === 2));
  assert.deepEqual(ui().map((e) => [e.kind, e.guid, e.text]).sort(), [["chat", undefined, "Teil eins, Teil zwei"], ["reply", "76d0b32d", "Danke"]]);
  await page.evaluate(() => (window as any).__api.asc_removeComment("1_1"));
  assert.ok(await until(() => events().some((e) => e.type === "removed")));
  assert.deepEqual(events().find((e) => e.type === "removed").guids, ["76d0b32d"]);
  await page.context().close();
});

test("ready: the comments the editor sees are reported, the comments panel's among them; a report that failed is tried again; the last ones go out as the page goes", async () => {
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => Object.assign(window, { __mode: "word", __confirmMs: 600, __panel: [{ uid: "9_9", guid: "0000beef", comment: "Vorher", userid: "portal-user", username: "Portal", resolved: false, quote: "", replys: [] }] }));
  await page.goto(`${origin}/editor.html?doc=d1`);
  assert.ok(await until(() => routes.reports.some((r) => r.path === "/docchat/ready"), 6000));
  assert.deepEqual(routes.reports.find((r) => r.path === "/docchat/ready")!.body.comments.map((c: any) => [c.guid, c.text]), [["0000beef", "Vorher"]], "the panel's comment is in the list");
  routes.refuse = 1;
  await page.evaluate(() => {
    const w = window as any;
    w.__api.asc_addComment(w.__data({ text: "Erst +Aegis", guid: "00000001", userId: "portal-user" }));
  });
  assert.ok(await until(() => routes.reports.filter((r) => r.path === "/docchat/events" && r.body.events.some((e: any) => e.type === "ui")).length >= 2));
  assert.equal(routes.reports.filter((r) => r.path === "/docchat/events" && r.body.events.some((e: any) => e.type === "ui")).length, 2, `sent again after the refusal: ${JSON.stringify(routes.reports)}`);
  await page.evaluate(() => {
    const w = window as any;
    w.__api.asc_addComment(w.__data({ text: "Zuletzt +Aegis", guid: "00000002", userId: "portal-user" }));
  });
  // Gone before the batch went out: the page's last reports leave with it.
  await page.goto("about:blank");
  assert.ok(await until(() => ui().some((e) => e.guid === "00000002")), "sent on pagehide");
  await page.context().close();
});

test("the chip follows how the comments and the chat with agents stand: the most urgent, a count of the busy", async () => {
  routes.docchat = [{ kind: "thread", label: "Aegis", state: "working" }];
  const page = await opened();
  const chip = page.locator(".po-chip-talk");
  await chip.waitFor({ timeout: 5000 });
  assert.equal(await chip.innerText(), "Aegis is answering a comment");
  routes.docchat = [{ kind: "thread", label: "Aegis", state: "working" }, { kind: "chat", label: "Report", state: "queued" }];
  await page.waitForFunction(() => document.querySelector(".po-chip-talk")?.textContent === "Agents are answering (2)", undefined, { timeout: 5000 });
  routes.docchat = [{ kind: "thread", label: "Aegis", state: "working" }, { kind: "thread", label: "Report", state: "failed", error: "the model is down" }];
  await page.waitForFunction(() => document.querySelector(".po-chip-talk-problem")?.textContent === "Report could not answer", undefined, { timeout: 5000 });
  assert.match((await chip.getAttribute("title")) ?? "", /the model is down/);
  routes.docchat = [{ kind: "thread", label: "Aegis", state: "answered" }];
  await chip.waitFor({ state: "detached", timeout: 5000 });
  await page.context().close();
});

test("a portal too old for agents to answer: the chip says so with the server half's words, and the page reports nothing more after the first refusal, never tried again", async () => {
  routes.off = "Agents do not answer comments or the editor's chat here: this portal is too old for it (it lacks chats.start).";
  const page = await opened();
  const chip = page.locator(".po-chip-talk-problem");
  await chip.waitFor({ timeout: 5000 });
  assert.equal(await chip.innerText(), "Agents do not answer comments or the chat here: the portal is too old");
  assert.match((await chip.getAttribute("title")) ?? "", /it lacks chats\.start/);
  await page.evaluate(() => {
    const w = window as any;
    w.__api.asc_addComment(w.__data({ text: "Bitte +Aegis", guid: "626360df", userId: "portal-user" }));
  });
  assert.ok(await until(() => routes.reports.some((r) => r.path === "/docchat/events")));
  await delay(1500);
  const sent = routes.reports.filter((r) => r.path === "/docchat/events").length;
  assert.equal(sent, 1, "refused once, not tried again");
  await page.evaluate(() => {
    const w = window as any;
    w.__api.asc_addComment(w.__data({ text: "Noch einmal +Aegis", guid: "0000abcd", userId: "portal-user" }));
  });
  await delay(1500);
  assert.equal(routes.reports.filter((r) => r.path === "/docchat/events").length, sent, "nothing more from this page");
  await page.context().close();
});

test("a long thread: its state keeps its latest replies within a request's size, batches are cut by size, and a person's reply in it gets through; a comment's UTC time and an edit's text before it are reported", async () => {
  const page = await opened("word");
  const long = Array.from({ length: 70 }, (_, i) => ({ text: `${i} ${"x".repeat(4000)}`, userId: "agent:a", userName: "Aegis (agent)" }));
  await page.evaluate((replies) => {
    const w = window as any;
    w.__emit("asc_onAddComment", "1_1", w.__data({ guid: "0000000a", text: "+Aegis bitte", userId: "portal-user", replies, ooTime: "1793108364144" }));
    w.__api.asc_changeComment("1_1", w.__data({ guid: "0000000a", text: "+Aegis bitte", userId: "portal-user", replies: [...replies, { text: "Und?", userId: "portal-user" }], ooTime: "1793108364144" }));
  }, long);
  assert.ok(await until(() => ui().some((e) => e.kind === "reply" && e.text === "Und?")), "the reply got through");
  const states = events().filter((e) => e.type === "comment");
  assert.ok(states.length >= 2);
  assert.ok(states.every((e) => JSON.stringify(e).length < 128 * 1024), "each state within its size");
  assert.equal(states.at(-1).time, 1793108364144);
  assert.ok(states.at(-1).repliesCut > 0);
  assert.equal(states.at(-1).replies.at(-1).text, "Und?", "the latest replies kept");
  await page.evaluate(() => {
    const w = window as any;
    w.__api.asc_changeComment("1_1", w.__data({ guid: "0000000a", text: "+Aegis bitte, und +Report", userId: "portal-user", replies: [], ooTime: "1793108364144" }));
  });
  assert.ok(await until(() => ui().some((e) => e.kind === "edit")));
  assert.equal(ui().find((e) => e.kind === "edit").before, "+Aegis bitte");
  await page.context().close();
});
