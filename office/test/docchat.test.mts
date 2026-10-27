/**
 * Unit tests for src/docchat.ts: comments and the editor's chat as the way to talk to agents, with the portal's chats,
 * the folders and the agents' editors faked (configureDocchat), a data folder of its own per test, and documents made
 * by store.createDoc. Short limits, real timers.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import * as docchat from "../src/docchat";
import { createDoc, getDoc, rewriteZipFor } from "./docchat-helpers.mts";

const FOLDERS = [
  { path: "/f/aegis", name: "Aegis", kind: "agent" as const },
  { path: "/f/my-agent", name: "My Agent", kind: "agent" as const },
  { path: "/f/report", name: "Report", kind: "project" as const },
  { path: "/f/twin-a", name: "Twin", kind: "agent" as const },
  { path: "/f/twin-b", name: "twin", kind: "agent" as const },
  { path: "/f/notes", name: "Notes", kind: "chat" as const },
];

type Chat = { id: string; title?: string; kind?: string; parent?: string; status?: string; folder: string; listed?: boolean };
type Deferred = { chatId: string; message: string; resolve: (r: docchat.ChildRun) => void };

let root = "";
let chats: Chat[] = [];
let prompts: Deferred[] = [];
let aborted: string[] = [];
let removed: string[] = [];
let posts: { home: string; docId: string; mode: string; job: { kind: string; args: any }; post?: boolean }[] = [];
let audits: { subject: string; reason: string; chatId?: string }[] = [];
let saves: string[] = [];
let mayWrite = true;
let officeState: "running" | "stopped" = "running";
let seatFails: { code: string; message: string } | null = null;
let limits: docchat.DocchatLimits = { ...docchat.DEFAULT_LIMITS };
let created = 0;

function configure(): void {
  docchat.configureDocchat({
    root,
    folders: () => FOLDERS,
    chats: {
      get: (id) => chats.find((c) => c.id === id),
      list: () => chats.filter((c) => c.listed !== false),
      folder: (id) => {
        const c = chats.find((x) => x.id === id);
        if (!c) throw new Error("no chat");
        return c.folder;
      },
      create: ({ parent, title, listed }) => {
        const p = chats.find((c) => c.id === parent)!;
        const chat = { id: `child-${++created}`, title, parent, folder: p.folder, listed };
        chats.push(chat);
        return chat;
      },
      prompt: (chatId, message) => new Promise((resolve) => prompts.push({ chatId, message, resolve })),
      abort: async (id) => void aborted.push(id),
      remove: async (id) => {
        removed.push(id);
        chats = chats.filter((c) => c.id !== id);
      },
    },
    seatRun: async (home, docId, mode, job, options) => {
      if (seatFails) throw Object.assign(new Error(seatFails.message), { code: seatFails.code });
      posts.push({ home, docId, mode, job: job as never, post: options?.post });
      if (job.kind.endsWith(".comments")) return { comments: [] };
      return {};
    },
    keyOf: () => "key-1",
    save: async (key) => void saves.push(key),
    command: async () => ({ error: 0, users: ["portal-user"] }),
    mayWrite: () => mayWrite,
    officeState: () => officeState,
    limits: () => limits,
    record: (e) => audits.push(e),
    log: () => {},
  });
}

beforeEach(() => {
  docchat.__resetDocchatForTests();
  root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "office-docchat-test-"));
  chats = [
    { id: "aegis-main", folder: "/f/aegis" },
    { id: "aegis-channel", folder: "/f/aegis", kind: "agent" },
    { id: "aegis-other", folder: "/f/aegis" },
    { id: "report-main", folder: "/f/report" },
    { id: "my-main", folder: "/f/my-agent" },
  ];
  prompts = [];
  aborted = [];
  removed = [];
  posts = [];
  audits = [];
  saves = [];
  mayWrite = true;
  officeState = "running";
  seatFails = null;
  limits = { ...docchat.DEFAULT_LIMITS };
  created = 0;
  configure();
});

afterEach(() => {
  docchat.__resetDocchatForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const settle = async () => {
  for (let i = 0; i < 40; i++) await tick();
};
const ui = (id: string, kind: "comment" | "reply" | "edit" | "editReply" | "resolve" | "chat", guid: string | undefined, text: string, more: Record<string, unknown> = {}): docchat.PageEvent => ({ type: "ui", id, kind, ...(guid ? { guid } : {}), text, ...more }) as docchat.PageEvent;
const word = async (owner: string | null = "/f/aegis") => (await createDoc({ title: `Doc ${Math.random().toString(36).slice(2, 8)}`, type: "word", owner }, root)).docId;
const childOf = (parent: string) => chats.filter((c) => c.parent === parent);

/* ---------------- mentions ---------------- */

test("mentions: +Name and @Name an agent (names with spaces too, any case), +project:Name and @project:Name a project, @agent the owner; nothing for an e-mail, an unknown or an ambiguous name", () => {
  assert.deepEqual(docchat.parseMentions("Bitte übersetzen +Aegis und @project:Report, auch +My Agent!"), ["/f/aegis", "/f/report", "/f/my-agent"]);
  assert.deepEqual(docchat.parseMentions("@aegis kannste das mal übersetzen"), ["/f/aegis"]);
  assert.deepEqual(docchat.parseMentions("+project:report"), ["/f/report"]);
  assert.deepEqual(docchat.parseMentions("@Report (a project named bare)"), ["/f/report"]);
  assert.deepEqual(docchat.parseMentions("@agent bitte", { owner: "/f/aegis" }), ["/f/aegis"]);
  assert.deepEqual(docchat.parseMentions("mail@aegis.org, @Aegisx, @Nobody, @Twin, @Notes"), []);
  assert.deepEqual(
    docchat.mentionables(),
    [
      { name: "Aegis", email: "Aegis" },
      { name: "My Agent", email: "My Agent" },
      { name: "Report (project)", email: "project:Report" },
      { name: "twin", email: "twin" },
      { name: "Twin", email: "Twin" },
    ],
  );
});

/* ---------------- threads ---------------- */

test("a person's comment that mentions an agent makes one internal chat under the agent's first task chat, prompted with the document, the thread and the person's words; the grant is made; a state event never prompts, a retried report is taken once", async () => {
  const docId = await word();
  docchat.report(docId, "k", [{ type: "comment", guid: "626360df", text: "Bitte übersetzen +Aegis", userId: "portal-user" }]);
  assert.equal(prompts.length, 0, "a state event prompts nobody");
  const event = ui("u1", "comment", "626360df", "Bitte übersetzen +Aegis");
  docchat.report(docId, "k", [event]);
  docchat.report(docId, "k", [event]);
  await settle();
  const made = childOf("aegis-main");
  assert.equal(made.length, 1, "one chat, under the first task chat (not the channel conversation)");
  assert.equal(made[0].listed, false, "listed nowhere");
  assert.equal(made[0].title, "Comment: Bitte übersetzen @Aegis");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, new RegExp(`office document ${docId} \\(comment thread 626360df\\)`));
  assert.match(prompts[0].message, /Bitte übersetzen @Aegis/);
  assert.match(prompts[0].message, /nobody|Nobody/);
  assert.ok(docchat.isInternal(made[0].id));
  assert.ok(getDoc(docId, root)!.grants.some((g) => g.folder === "/f/aegis" && g.commentId === "626360df"), "granted");
  // Nothing without a mention.
  docchat.report(docId, "k", [ui("u2", "comment", "aaaa0001", "Nur eine Notiz")]);
  await settle();
  assert.equal(prompts.length, 1);
});

test("the parent: the chat whose panel the editor is in, else the one the document's other threads use, else the folder's first task chat; never a channel conversation; a folder with none says so", async () => {
  const docId = await word();
  docchat.report(docId, "k", [ui("u1", "comment", "00000001", "+Aegis eins")], "aegis-other");
  docchat.report(docId, "k", [ui("u2", "comment", "00000002", "+Aegis zwei")]);
  await settle();
  assert.deepEqual(chats.filter((c) => c.parent).map((c) => c.parent), ["aegis-other", "aegis-other"]);
  // A panel of a chat of another folder is no parent for Aegis's thread.
  const other = await word();
  docchat.report(other, "k", [ui("u3", "comment", "00000003", "+Aegis drei")], "report-main");
  await settle();
  assert.equal(chats.at(-1)!.parent, "aegis-main");
  chats = chats.filter((c) => c.folder !== "/f/my-agent");
  docchat.report(other, "k", [ui("u4", "comment", "00000004", "+My Agent vier")]);
  await settle();
  assert.deepEqual(docchat.statesOf(other).find((s) => s.label === "My Agent"), { kind: "thread", label: "My Agent", state: "no_chat", error: "My Agent has no chat to work from: start one with My Agent" });
});

test("a reply in the thread goes to the same chat; one that names another agent adds it; an edit that adds a mention adds it; resolve and a reply's edit prompt nobody; a plain reply in a thread with no record does nothing", async () => {
  const docId = await word();
  docchat.report(docId, "k", [ui("u1", "comment", "00000001", "+Aegis bitte")]);
  await settle();
  prompts[0].resolve({ status: "done", answer: "" });
  await settle();
  docchat.report(docId, "k", [ui("u2", "reply", "00000001", "Und noch etwas")]);
  await settle();
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].chatId, prompts[0].chatId, "the same chat");
  assert.equal(prompts[1].message, "A reply in the thread:\nUnd noch etwas");
  docchat.report(docId, "k", [ui("u3", "reply", "00000001", "Frag auch @project:Report")]);
  await settle();
  const report = prompts.find((p) => chats.find((c) => c.id === p.chatId)?.parent === "report-main");
  assert.ok(report, "Report joins the thread with its own chat");
  assert.match(report!.message, /\+Aegis bitte|@Aegis bitte/);
  assert.match(report!.message, /Frag auch @project:Report/);
  const before = prompts.length;
  docchat.report(docId, "k", [ui("u4", "resolve", "00000001", "", { solved: true }), ui("u5", "editReply", "00000001", "geändert")]);
  docchat.report(docId, "k", [ui("u6", "edit", "00000001", "+Aegis bitte, und +My Agent")]);
  await settle();
  assert.equal(prompts.length, before + 1, "only the edit's new mention prompts");
  assert.equal(chats.find((c) => c.id === prompts.at(-1)!.chatId)?.parent, "my-main");
  docchat.report(docId, "k", [ui("u7", "reply", "0000dead", "eine Antwort ohne Faden")]);
  await settle();
  assert.equal(prompts.length, before + 1);
});

test("an answer is posted as the agent's reply in its thread, cut at the limit, saved and recorded; one the agent may only view goes through an editor that may only comment", async () => {
  limits = { ...limits, replyChars: 200 };
  const docId = await word();
  docchat.report(docId, "k", [ui("u1", "comment", "626360df", "+Aegis bitte")]);
  await settle();
  prompts[0].resolve({ status: "done", answer: "x".repeat(300) });
  await settle();
  const reply = posts.find((p) => p.job.kind === "word.reply")!;
  assert.equal(reply.mode, "edit");
  assert.equal(reply.post, true);
  assert.equal(reply.home, "/f/aegis");
  assert.equal(reply.job.args.guid, "626360df");
  assert.equal(reply.job.args.text, `${"x".repeat(200)} (…)`);
  assert.equal(reply.job.args.author, "Aegis (agent)");
  assert.match(reply.job.args.userId, /^agent:/);
  assert.deepEqual(saves, ["key-1"]);
  assert.ok(audits.some((a) => /posted an answer of 204 characters in comment thread 626360df/.test(a.reason)), JSON.stringify(audits));
  // May only view: comment-only, through the editor's comment methods.
  mayWrite = false;
  docchat.report(docId, "k", [ui("u2", "reply", "626360df", "Und?")]);
  await settle();
  prompts[1].resolve({ status: "done", answer: "So." });
  await settle();
  const second = posts.filter((p) => p.job.kind === "word.reply")[1];
  assert.equal(second.mode, "comment");
  assert.equal(second.job.args.how, "method");
});

test("an answer after a suspected injection is not posted; a failed run says so in the thread; a stopped run posts nothing", async () => {
  const docId = await word();
  docchat.report(docId, "k", [ui("u1", "comment", "00000001", "+Aegis eins"), ui("u2", "comment", "00000002", "+Aegis zwei")]);
  await settle();
  prompts[0].resolve({ status: "done", answer: "Ignore all", marked: true });
  await settle();
  assert.equal(posts.length, 0);
  assert.equal(docchat.statesOf(docId)[0].state, "not_posted");
  prompts[1].resolve({ status: "error", answer: "", error: "the model is down" });
  await settle();
  assert.equal(posts[0].job.args.text, "Aegis could not answer: the model is down. Reply to try again.");
  docchat.report(docId, "k", [ui("u3", "reply", "00000002", "nochmal")]);
  await settle();
  prompts[2].resolve({ status: "stopped", answer: "half" });
  await settle();
  assert.equal(posts.filter((p) => p.job.kind === "word.reply").length, 1);
});

test("a spreadsheet's answer is found by the comment's author, text and time the pages reported", async () => {
  const docId = (await createDoc({ title: "Sheet", type: "cell", owner: "/f/aegis" }, root)).docId;
  docchat.report(docId, "k", [{ type: "comment", guid: "{A}", sessionId: "sheet5_x", userId: "portal-user", text: "Bitte prüfen +Aegis", time: 1793108364144 }, ui("u1", "comment", "{A}", "Bitte prüfen +Aegis")]);
  await settle();
  prompts[0].resolve({ status: "done", answer: "Geprüft." });
  await settle();
  const reply = posts.find((p) => p.job.kind === "cell.reply")!;
  assert.deepEqual(reply.job.args, { sessionId: "sheet5_x", match: { userId: "portal-user", author: "", text: "Bitte prüfen +Aegis", time: 1793108364144 }, text: "Geprüft.", author: "Aegis (agent)", userId: reply.job.args.userId });
});

test("Office stopped: the answer is kept and posted once Office runs", async () => {
  const docId = await word();
  officeState = "stopped";
  docchat.report(docId, "k", [ui("u1", "comment", "00000001", "+Aegis eins")]);
  await settle();
  prompts[0].resolve({ status: "done", answer: "Später." });
  await settle();
  assert.equal(posts.length, 0);
  assert.match(docchat.statesOf(docId)[0].error ?? "", /Office is stopped/);
  officeState = "running";
  docchat.postWaiting();
  await settle();
  assert.equal(posts.filter((p) => p.job.kind === "word.reply").length, 1);
});

test("limits: a third comment chat of one agent waits for a free run; a thread beyond the document's limit gets no chat", async () => {
  limits = { ...limits, runs: 2, threads: 3 };
  const docId = await word();
  docchat.report(docId, "k", [1, 2, 3].map((n) => ui(`u${n}`, "comment", `0000000${n}`, `+Aegis ${n}`)));
  await settle();
  assert.equal(prompts.length, 2, "two run at once");
  assert.equal(docchat.statesOf(docId).filter((s) => s.state === "queued").length, 1);
  prompts[0].resolve({ status: "done", answer: "" });
  await settle();
  assert.equal(prompts.length, 3, "the third once one ended");
  docchat.report(docId, "k", [ui("u4", "comment", "00000004", "+Aegis vier")]);
  await settle();
  assert.deepEqual(docchat.statesOf(docId).find((s) => s.state === "limit"), { kind: "thread", label: "Aegis", state: "limit", error: "Too many comment chats in this document: delete some comments" });
  assert.equal(chats.filter((c) => c.parent).length, 3);
});

test("removal: a deleted comment's chat goes after the grace; seen again within it (an undo), it stays; a moved comment carries its thread", async () => {
  limits = { ...limits, removeAfterS: 0.2 };
  const docId = await word();
  docchat.report(docId, "k", [ui("u1", "comment", "00000001", "+Aegis eins"), ui("u2", "comment", "00000002", "+Aegis zwei")]);
  await settle();
  const [one, two] = [prompts[0].chatId, prompts[1].chatId];
  docchat.report(docId, "k", [{ type: "removed", guids: ["00000001", "00000002"] }]);
  docchat.report(docId, "k", [{ type: "comment", guid: "00000002", text: "+Aegis zwei" }]);
  docchat.moved(docId, [["00000002", "7164b85f"]]);
  await delay(400);
  assert.deepEqual(removed, [one]);
  assert.deepEqual(Object.keys(docchat.threadsOf(docId)), ["7164b85f"]);
  assert.ok(chats.some((c) => c.id === two));
  // The answer of the moved thread's run lands in its new thread.
  prompts[1].resolve({ status: "done", answer: "Fertig." });
  await settle();
  assert.equal(posts.find((p) => p.job.kind === "word.reply")?.job.args.guid, "7164b85f");
});

test("a save removes only threads an earlier saved file had, after the grace; a comment the save has by author and text under another GUID renames the thread", async () => {
  limits = { ...limits, removeAfterS: 0.2 };
  const docId = await word();
  docchat.report(docId, "k", [{ type: "comment", guid: "00000001", text: "+Aegis eins", userId: "portal-user" }, ui("u1", "comment", "00000001", "+Aegis eins"), ui("u2", "comment", "00000002", "+Aegis zwei")]);
  await settle();
  const file = (threads: [string, string][]) => rewriteZipFor(threads);
  // A save made before the comments reached it: nothing goes, nothing was in a file yet.
  docchat.persisted(docId, await file([]));
  await delay(300);
  assert.equal(removed.length, 0);
  docchat.persisted(docId, await file([["00000001", "+Aegis eins"], ["00000002", "+Aegis zwei"]]));
  // An outside tool saved it with new GUIDs: the first is found by its text; the second is gone.
  docchat.persisted(docId, await file([["0000abcd", "+Aegis eins"]]));
  await delay(400);
  assert.deepEqual(Object.keys(docchat.threadsOf(docId)), ["0000abcd"]);
  assert.equal(removed.length, 1);
});

test("the editor's chat: the first message makes one internal chat of the document's owner, messages during its run come together as the next prompt, the answer is posted in chunks of 2,048 characters, at most the limit; nobody answers where nobody owns the document", async () => {
  limits = { ...limits, chatMessages: 2 };
  const docId = await word();
  docchat.report(docId, "key-a", [ui("c1", "chat", undefined, "Hallo, fasse zusammen")]);
  await settle();
  assert.equal(chats.at(-1)!.title, "Office chat");
  assert.equal(chats.at(-1)!.listed, false);
  assert.match(prompts[0].message, /editor's chat/);
  assert.match(prompts[0].message, /Hallo, fasse zusammen$/);
  docchat.report(docId, "key-a", [ui("c2", "chat", undefined, "Und kürzer"), ui("c3", "chat", undefined, "Auf Deutsch")]);
  await settle();
  assert.equal(prompts.length, 1, "nothing given while it runs");
  prompts[0].resolve({ status: "done", answer: "a".repeat(5000) });
  await settle();
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].message, "Und kürzer\n\nAuf Deutsch");
  const sent = posts.filter((p) => p.job.kind === "chat.send");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].job.args.text.length, 2048);
  assert.match(sent[1].job.args.text, / \(…\)$/);
  const ownerless = await word(null);
  docchat.report(ownerless, "key-b", [ui("c4", "chat", undefined, "Hallo?")]);
  await settle();
  assert.equal(prompts.length, 2);
  assert.deepEqual(docchat.statesOf(ownerless), [{ kind: "chat", label: "", state: "nobody" }]);
});

test("the editor's chat ends after the last person left (only agents in its session, or its end), unless a person comes back in time; a Document Server started again ends it at once", async () => {
  limits = { ...limits, chatEndS: 0.2 };
  const docId = await word();
  docchat.report(docId, "key-a", [ui("c1", "chat", undefined, "Hallo")]);
  docchat.report(docId, "key-b", [ui("c2", "chat", undefined, "Hallo")]);
  await settle();
  const [a, b] = [prompts[0].chatId, prompts[1].chatId];
  docchat.sessionUsers("key-a", ["agent:x"]);
  docchat.sessionUsers("key-b", ["agent:x"]);
  docchat.sessionUsers("key-b", ["portal-user", "agent:x"]);
  await delay(400);
  assert.deepEqual(removed, [a]);
  await docchat.dsStarted();
  assert.deepEqual(removed, [a, b]);
  assert.deepEqual(docchat.sessionsNow(), {});
});

test("a dialog or a guard question in one of these chats stops its run at once, which is told and goes on; a second one ends it with an error in the thread", async () => {
  const docId = await word();
  docchat.report(docId, "k", [ui("u1", "comment", "00000001", "+Aegis eins")]);
  await settle();
  const chatId = prompts[0].chatId;
  docchat.chatEvent(chatId, { type: "extension_ui_request", method: "notify", message: "fyi" });
  assert.deepEqual(aborted, [], "news is no dialog");
  docchat.chatEvent(chatId, { type: "extension_ui_request", method: "confirm", title: "Allow the write?" });
  assert.deepEqual(aborted, [chatId]);
  prompts[0].resolve({ status: "stopped", answer: "" });
  await settle();
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].message, /waited for a person's answer \(Allow the write\?\)/);
  docchat.chatEvent(chatId, { type: "extension_ui_request", method: "questions", title: "Which?" });
  prompts[1].resolve({ status: "stopped", answer: "" });
  await settle();
  assert.match(posts[0].job.args.text, /^Aegis could not answer: it waited for a person's answer/);
  // Another chat's dialog is none of ours.
  docchat.chatEvent("aegis-main", { type: "extension_ui_request", method: "confirm" });
  assert.equal(aborted.length, 2);
});

test("the question tool: taken away from the chat's tools at its start and before each run, and refused at once where it is called", () => {
  const handlers: Record<string, ((e: any) => any)[]> = {};
  let active = ["read", "ask_question", "office_read"];
  const pi = { on: (name: string, fn: (e: any) => any) => (handlers[name] ??= []).push(fn), getActiveTools: () => active, setActiveTools: (names: string[]) => (active = names) };
  docchat.hush(pi);
  handlers.session_start[0]({});
  assert.deepEqual(active, ["read", "office_read"]);
  active = [...active, "ask_question"];
  handlers.before_agent_start[0]({});
  assert.deepEqual(active, ["read", "office_read"]);
  assert.deepEqual(handlers.tool_call[0]({ toolName: "ask_question" }).block, true);
  assert.match(handlers.tool_call[0]({ toolName: "ask_question" }).reason, /not available in this chat/);
  assert.equal(handlers.tool_call[0]({ toolName: "office_read" }), undefined);
});

test("after a restart of the half, a run that goes on gives its answer through the chat's events; after a restart of the portal the thread says it was interrupted", async () => {
  const docId = await word();
  docchat.report(docId, "k", [ui("u1", "comment", "00000001", "+Aegis eins"), ui("u2", "comment", "00000002", "+Aegis zwei")]);
  await settle();
  const [one, two] = [prompts[0].chatId, prompts[1].chatId];
  // The records as a run left them: the second's from another process (the portal restarted).
  const file = path.join(root, "state", "threads", `${docId}.json`);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  rec.threads["00000002"].agents["/f/aegis"].pending.pid = -1;
  fs.writeFileSync(file, JSON.stringify(rec));
  docchat.__resetDocchatForTests();
  configure();
  chats.find((c) => c.id === one)!.status = "running";
  await docchat.boot();
  await settle();
  assert.equal(posts.find((p) => p.job.kind === "word.reply")?.job.args.text, "Aegis was interrupted before it answered. Reply to try again.");
  assert.ok(docchat.isInternal(one) && docchat.isInternal(two), "known as internal after the restart");
  docchat.chatEvent(one, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Übersetzt." }] } });
  docchat.chatEvent(one, { type: "agent_end" });
  await settle();
  assert.deepEqual(posts.filter((p) => p.job.kind === "word.reply").map((p) => [p.job.args.guid, p.job.args.text]), [["00000002", "Aegis was interrupted before it answered. Reply to try again."], ["00000001", "Übersetzt."]]);
});

test("a chat deleted by hand: the thread keeps its record, and its next reply makes a new chat told of the earlier one; a folder removed takes its entries away", async () => {
  const docId = await word();
  docchat.report(docId, "k", [ui("u1", "comment", "00000001", "+Aegis eins")]);
  await settle();
  prompts[0].resolve({ status: "done", answer: "" });
  await settle();
  const first = prompts[0].chatId;
  chats = chats.filter((c) => c.id !== first);
  docchat.chatDeleted(first);
  assert.equal(docchat.isInternal(first), false);
  docchat.report(docId, "k", [ui("u2", "reply", "00000001", "Noch da?")]);
  await settle();
  assert.notEqual(prompts[1].chatId, first);
  assert.match(prompts[1].message, /earlier conversation/);
  assert.match(prompts[1].message, /Noch da\?/);
  docchat.folderRemoved("/f/aegis");
  assert.deepEqual(docchat.threadsOf(docId)["00000001"].agents, {});
});

test("a post that fails is tried again a little later; a reply a person's change took away is posted again; one that keeps failing says so", async () => {
  Object.assign(docchat.postTimings, { repostMs: 50, retryMs: 50 });
  try {
    const docId = await word();
    seatFails = { code: "agent_unavailable", message: "Docker did not answer in time" };
    docchat.report(docId, "k", [ui("u1", "comment", "00000001", "+Aegis eins")]);
    await settle();
    prompts[0].resolve({ status: "done", answer: "Erledigt." });
    await settle();
    assert.equal(posts.length, 0);
    seatFails = null;
    await delay(200);
    assert.equal(posts.filter((p) => p.job.kind === "word.reply").length, 1, "tried again");
    // A reply the read back does not find is posted again, until it is there.
    let lost = 2;
    configure();
    docchat.configureDocchat({
      seatRun: async (home, d, mode, job) => {
        posts.push({ home, docId: d, mode, job: job as never });
        if (job.kind === "word.comments") return { comments: [{ guid: "00000001", userId: "portal-user", text: "+Aegis eins", replies: lost-- > 0 ? [] : [{ text: "Nochmal." }] }] };
        return {};
      },
    });
    posts = [];
    docchat.report(docId, "k", [ui("u2", "reply", "00000001", "Und?")]);
    await settle();
    prompts[1].resolve({ status: "done", answer: "Nochmal." });
    await delay(500);
    assert.equal(posts.filter((p) => p.job.kind === "word.reply").length, 3, "posted again twice");
    assert.notEqual(docchat.statesOf(docId)[0].state, "failed");
  } finally {
    Object.assign(docchat.postTimings, { repostMs: 5_000, retryMs: 10_000 });
  }
});
