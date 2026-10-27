/**
 * Comments and the editor's chat as the way people talk to agents in a document (office-docchat-plan.md, with the
 * owner's answers of 2026-10-27).
 *
 * - A comment that mentions an agent or a project (`@Aegis`, `@project:Report`; the editor's mention list inserts
 *   `+Aegis`, `+project:Report`) starts a chat of its own with that agent or project: an internal child chat (listed
 *   nowhere) of one of its task chats, with only that comment's context. Replies a person writes in the thread go to
 *   the same chat; its answers are posted as the agent's replies in the thread. The chat stays while the comment does
 *   (resolved and unresolved again too), and goes when the comment is deleted (after a grace, which an undo or a save
 *   that still has it cancels).
 * - What a person writes in the editor's own chat goes to the agent or project that owns the document, in one internal
 *   chat per editing session (Document Server key), whose answers are posted in the editor's chat; it goes 60 s after
 *   the last person left the session.
 * - Only what a person did through the editor's own UI on their page counts as their words (a "ui report", see
 *   web/docchat-page.ts): paste, undo, a co-author's change and the file's own comments never prompt anybody.
 * - Nothing in these chats may wait for a person: the question tool is taken away (tools.ts asks `isInternal`), and a
 *   dialog or a guard question the chat opens anyway stops the run at once; it is told why and goes on without it.
 *
 * Records under `<data>/state/`: `threads/<docId>.json` (each thread's agents with their chats, what waits to be
 * posted, a removal under way) and `sessions.json` (the chats of the editor's chat, by key), written whole through a
 * file beside them. Every limit is a setting of the Office page (settings.ts, `docchat*`).
 *
 * Seams: `configureDocchat(deps)` takes the portal's chats and folders, the seats, the save, the command service, the
 * audit and the clock's timers; the defaults reach the real portal lazily (tests pass their own).
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { portal } from "./host";
import { addGrant, canonical, getDoc, listDocs, readDoc, within, type DocMeta } from "./store";
import { docxThreads, xlsxThreads, type CommentThread } from "./ooxml";
import { keyIdOf } from "./callback";
import { DEFAULT_SETTINGS, loadSettings } from "./settings";

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

/** What the person sees of a thread's or a session's chat (the editor's bar, GET /editor-state). */
export type ChatState = "queued" | "working" | "answered" | "not_posted" | "failed" | "no_chat" | "nobody" | "interrupted" | "limit" | "idle";

type Pending = { since: number; pid: number; asked?: string };
type ToPost = { text: string; at: number };

/** One agent or project in a thread. */
type AgentEntry = {
  chatId: string | null;
  parent: string | null;
  state: ChatState;
  error?: string;
  /** Messages for its chat not given to it yet: a run is going, or it waits for its turn. */
  queue: string[];
  pending?: Pending;
  toPost?: ToPost;
  /** It had a chat before, which was deleted: the next one is told the thread had an earlier conversation. */
  earlier?: boolean;
};

type Thread = {
  createdAt: number;
  /** The comment's text, as the person last wrote it. */
  text: string;
  /** An earlier saved file of the document had it (only then can a save that lacks it remove it). */
  inFile: boolean;
  /** Author's user id and time, as the file and the comment commands give them: what a spreadsheet's reply is found by. */
  userId?: string;
  author?: string;
  time?: number;
  sessionId?: string;
  agents: Record<string, AgentEntry>;
  removing?: { at: number; reason: string };
};

type DocRecord = { version: 1; threads: Record<string, Thread>; uiSeen: string[] };

type SessionRecord = {
  docId: string;
  folder: string;
  chatId: string | null;
  parent: string | null;
  state: ChatState;
  error?: string;
  /** The people's messages of the session (the last 50, at most 20,000 characters): what a new chat is given when the
   * first one was lost. */
  people: { text: string; at: number }[];
  queue: string[];
  pending?: Pending;
  toPost?: ToPost;
  ending?: number;
};

/** A comment as a page reports it (its state report, and a ready list). */
export type PageComment = { guid: string; sessionId?: string; userId?: string; author?: string; text: string; time?: number; solved?: boolean; quote?: string; replies?: { userId?: string; author?: string; text: string }[] };

/** What a page reports: what a person did in the editor's own UI (`ui`), or what its editor heard (a comment's state,
 * comments removed). */
export type PageEvent =
  | { type: "ui"; id: string; kind: "comment" | "reply" | "edit" | "editReply" | "resolve" | "chat"; guid?: string; text?: string; solved?: boolean }
  | ({ type: "comment" } & PageComment)
  | { type: "removed"; guids: string[] };

/** The limits, as the Office page sets them (settings.ts). */
export type DocchatLimits = {
  /** Comment chats of one agent or project that run at once; the others wait their turn. */
  runs: number;
  /** Comment threads with agents in one document. */
  threads: number;
  /** The longest answer posted in a thread, in characters. */
  replyChars: number;
  /** The most messages of 2,048 characters an answer in the editor's chat is posted as. */
  chatMessages: number;
  /** Seconds a deleted comment's chat waits before it goes (an undo in that time keeps it). */
  removeAfterS: number;
  /** Seconds after the last person left an editing session before its chat goes. */
  chatEndS: number;
};

export type DocchatChat = { id: string; title?: string; workspace?: string; kind?: string; parent?: string; status?: string };
export type ChildRun = { status: "done" | "stopped" | "error"; answer: string; marked?: true; error?: string };

/** What the module needs of the rest of the half and the portal. */
export type DocchatDeps = {
  root?: string;
  chats?: {
    get(id: string): DocchatChat | undefined;
    list(): DocchatChat[];
    folder(id: string): string;
    create(options: { parent: string; title: string; listed?: boolean }): DocchatChat;
    prompt(id: string, message: string): Promise<ChildRun>;
    abort(id: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
  folders?: () => { path: string; name: string; kind: "agent" | "project" | "chat" }[];
  /** An agent's editor of the document running a job (seat.run). */
  seatRun?: (home: string, docId: string, mode: "edit" | "view" | "comment", job: { kind: string; args: unknown }, options?: { post?: boolean }) => Promise<unknown>;
  /** The key the agent's editor of the document has open (seat.keyOf). */
  keyOf?: (home: string, docId: string) => string | undefined;
  /** A save of the session of `key` (editing.saveNow). */
  save?: (key: string) => Promise<unknown>;
  /** One command to the Document Server's command service (callback.command). */
  command?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Whether the agent of `folder` may change the document's file itself (else it answers through an editor that may
   * only comment). */
  mayWrite?: (doc: DocMeta, folder: string, chatId: string | null) => boolean;
  /** Whether Office runs (server.ts). */
  officeState?: () => Promise<"running" | "starting" | "stopped"> | "running" | "starting" | "stopped";
  limits?: () => DocchatLimits;
  record?: (entry: { subject: string; reason: string; chatId?: string }) => void;
  log?: (line: string) => void;
  now?: () => number;
};

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

/** The protocol of the page's reports: another one is a page of an older or newer Office, which reloads. */
export const PROTOCOL = 1;
/** One message of the editor's chat at most, as its panel splits them. */
export const CHAT_CHUNK = 2048;
/** The page's reports: events in one request, its size, a text, requests per page in 10 s. */
export const CAPS = { events: 64, bytes: 256 * 1024, text: 20_000, perTenSeconds: 20 };
/** Report ids kept per document against a retried request. */
const UI_SEEN = 2000;
/** A session's people's messages kept for a chat made anew. */
const PEOPLE_KEPT = 50;
const PEOPLE_CHARS = 20_000;
/** A thread's chat title: the first characters of the comment. */
const TITLE_CHARS = 60;
/** Saves after posts: at most one per document in this time. */
const SAVE_EVERY_MS = 3_000;

export const DEFAULT_LIMITS: DocchatLimits = {
  runs: DEFAULT_SETTINGS.docchatRuns,
  threads: DEFAULT_SETTINGS.docchatThreads,
  replyChars: DEFAULT_SETTINGS.docchatReplyChars,
  chatMessages: DEFAULT_SETTINGS.docchatChatMessages,
  removeAfterS: DEFAULT_SETTINGS.docchatRemoveAfterS,
  chatEndS: DEFAULT_SETTINGS.docchatChatEndS,
};

/** What an agent in one of these chats is told about the people it cannot ask. */
const NOBODY_TO_ASK =
  "Nobody watches this chat while you work: there is no one to answer a question or a confirmation, so do not ask any. Decide for yourself, or say in your answer what you need.";

/** The dialogs of pi's UI requests: what waits for somebody (ui-requests.ts of the portal). */
const DIALOGS = new Set(["select", "confirm", "input", "editor", "questions"]);

/** The question tool the portal gives a chat with a person, which these chats must not have. */
export const QUESTION_TOOL = "ask_question";

/* ------------------------------------------------------------------ */
/* seams                                                               */
/* ------------------------------------------------------------------ */

let cfg: DocchatDeps = {};

export function configureDocchat(deps: DocchatDeps): void {
  cfg = { ...cfg, ...deps };
}

/** Test seam: everything back to the start, timers stopped. */
export function __resetDocchatForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  cfg = {};
  docs.clear();
  sessions = null;
  internal.clear();
  running.clear();
  waiting.clear();
  rates.clear();
  live.clear();
  lastSave.clear();
  dialogs.clear();
  listening.clear();
  loaded = false;
}

const root = () => cfg.root ?? portal().dataDir();
const chats = () => cfg.chats ?? (portal().chats as unknown as NonNullable<DocchatDeps["chats"]>);
const folders = () => (cfg.folders ?? (() => portal().folders.list()))();
const now = () => (cfg.now ?? Date.now)();
const log = (line: string) => (cfg.log ?? ((l: string) => portal().log(`@pithagoras/office: docchat: ${l}`)))(line);
const record = (entry: { subject: string; reason: string; chatId?: string }) => (cfg.record ?? ((e) => log(`${e.subject}: ${e.reason}`)))(entry);

export function limits(): DocchatLimits {
  if (cfg.limits) return cfg.limits();
  try {
    const s = loadSettings(root());
    return { runs: s.docchatRuns, threads: s.docchatThreads, replyChars: s.docchatReplyChars, chatMessages: s.docchatChatMessages, removeAfterS: s.docchatRemoveAfterS, chatEndS: s.docchatChatEndS };
  } catch {
    return DEFAULT_LIMITS;
  }
}

/* ------------------------------------------------------------------ */
/* records                                                             */
/* ------------------------------------------------------------------ */

const docs = new Map<string, DocRecord>();
let sessions: Record<string, SessionRecord> | null = null;

function writeWhole(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

const threadsFile = (docId: string) => path.join(root(), "state", "threads", `${docId}.json`);
const sessionsFile = () => path.join(root(), "state", "sessions.json");

function docRecord(docId: string): DocRecord {
  let rec = docs.get(docId);
  if (rec) return rec;
  try {
    const raw = JSON.parse(fs.readFileSync(threadsFile(docId), "utf8"));
    if (raw?.version === 1 && raw.threads && typeof raw.threads === "object") rec = { version: 1, threads: raw.threads, uiSeen: Array.isArray(raw.uiSeen) ? raw.uiSeen : [] };
  } catch {
    // none yet, or unreadable: a new one
  }
  rec ??= { version: 1, threads: {}, uiSeen: [] };
  docs.set(docId, rec);
  return rec;
}

function saveDoc(docId: string): void {
  const rec = docs.get(docId);
  if (!rec) return;
  try {
    if (!Object.keys(rec.threads).length && !rec.uiSeen.length) fs.rmSync(threadsFile(docId), { force: true });
    else writeWhole(threadsFile(docId), rec);
  } catch (e) {
    log(`the threads of ${docId} could not be written: ${(e as Error).message}`);
  }
}

function sessionRecords(): Record<string, SessionRecord> {
  if (sessions) return sessions;
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsFile(), "utf8"));
    sessions = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    sessions = {};
  }
  return sessions!;
}

function saveSessions(): void {
  try {
    writeWhole(sessionsFile(), sessionRecords());
  } catch (e) {
    log(`the editor chats could not be written: ${(e as Error).message}`);
  }
}

/** Every document that has thread records on disk. */
function docsWithThreads(): string[] {
  try {
    return fs.readdirSync(path.join(root(), "state", "threads")).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* the chats that are ours                                             */
/* ------------------------------------------------------------------ */

/** The chat ids of the thread and session chats: they get no question tool (tools.ts). */
const internal = new Set<string>();

/** Whether `chatId` is one of the internal chats of comments and the editor's chat. */
export function isInternal(chatId: string): boolean {
  if (internal.has(chatId)) return true;
  // Loaded lazily: a chat's pi can start before anything here was asked (after a restart, a reply's prompt).
  loadAll();
  return internal.has(chatId);
}

let loaded = false;
function loadAll(): void {
  if (loaded) return;
  try {
    root();
  } catch {
    return; // no portal yet (a test of another module): nothing recorded to load
  }
  loaded = true;
  for (const docId of docsWithThreads()) for (const t of Object.values(docRecord(docId).threads)) for (const a of Object.values(t.agents)) if (a.chatId) internal.add(a.chatId);
  for (const s of Object.values(sessionRecords())) if (s.chatId) internal.add(s.chatId);
}

/**
 * Takes the question tool away from an internal chat's pi, and refuses it at once where it is called all the same
 * (through a script, or a pi that gave it back): `pi` is what chats.extend's factory is given.
 */
export function hush(pi: any): void {
  const drop = () => {
    try {
      const active: string[] = pi.getActiveTools?.() ?? [];
      if (active.includes(QUESTION_TOOL)) pi.setActiveTools(active.filter((n) => n !== QUESTION_TOOL));
    } catch (e) {
      log(`the question tool could not be taken away: ${(e as Error).message}`);
    }
  };
  pi.on?.("session_start", drop);
  pi.on?.("before_agent_start", drop);
  pi.on?.("tool_call", (event: { toolName?: string }) => {
    if (event?.toolName !== QUESTION_TOOL) return undefined;
    return { block: true, reason: `${QUESTION_TOOL} is not available in this chat: nobody is there to answer. Decide for yourself, or say in your answer what you need.` };
  });
}

/* ------------------------------------------------------------------ */
/* mentions                                                            */
/* ------------------------------------------------------------------ */

type Folder = { path: string; name: string; kind: "agent" | "project" };

function mentionable(): Folder[] {
  return folders().filter((f): f is Folder => f.kind === "agent" || f.kind === "project");
}

/** The editor's mention list: each agent by its name, each project as "project:<name>". OnlyOffice lists an entry
 * with a name and an e-mail, and inserts "+<e-mail>": so the e-mail is what a person types, `Aegis` and
 * `project:Report`, and the inserted `+Aegis` reads as the typed `@Aegis` does. */
export function mentionables(): { name: string; email: string }[] {
  return mentionable()
    .map((f) => (f.kind === "agent" ? { name: f.name, email: f.name } : { name: `${f.name} (project)`, email: `project:${f.name}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The agent or project folder that holds a scanned document's file: the deepest one. */
export function homeOf(file: string): string | null {
  let best: string | null = null;
  for (const f of mentionable()) {
    const at = canonical(f.path);
    if (within(at, file) && (!best || at.length > best.length)) best = at;
  }
  return best;
}

/** Who owns a document: its owner folder, or for a scanned one the agent or project whose folder it is in. */
export function ownerOf(doc: Pick<DocMeta, "owner" | "path">): string | null {
  return doc.owner ?? (doc.path ? homeOf(doc.path) : null);
}

/**
 * The folders a text mentions, each once, in order: `@Name` / `+Name` an agent by its name (a project of that name
 * where no agent has it), `@project:Name` / `+project:Name` a project, `@agent` the document's owner. Names match in any
 * case, the longest first, so names with spaces work as the list inserts them; a name two folders of the kind share is
 * skipped (logged), as is one that matches nothing.
 */
export function parseMentions(text: string, doc?: Pick<DocMeta, "owner" | "path">): string[] {
  const all = mentionable();
  const agents = all.filter((f) => f.kind === "agent").sort((a, b) => b.name.length - a.name.length);
  const projects = all.filter((f) => f.kind === "project").sort((a, b) => b.name.length - a.name.length);
  const out: string[] = [];
  const add = (folder: string | null) => {
    if (folder && !out.includes(folder)) out.push(folder);
  };
  const ends = (rest: string, name: string) => rest.toLowerCase().startsWith(name.toLowerCase()) && !/^[\p{L}\p{N}_]/u.test(rest.slice(name.length));
  const pick = (rest: string, among: Folder[]): string | null | undefined => {
    const hit = among.find((f) => ends(rest, f.name));
    if (!hit) return undefined;
    const same = among.filter((f) => f.name.toLowerCase() === hit.name.toLowerCase());
    if (same.length > 1) {
      log(`a mention of "${hit.name}" is ambiguous (${same.length} folders): skipped`);
      return null;
    }
    return canonical(hit.path);
  };
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_.@+])[@+]/gu)) {
    const rest = text.slice(m.index! + 1);
    if (/^project:/i.test(rest)) {
      const found = pick(rest.slice(8), projects);
      if (found === undefined) log(`a mention of a project matches none: skipped`);
      add(found ?? null);
      continue;
    }
    const agent = pick(rest, agents);
    if (agent !== undefined) {
      add(agent);
      continue;
    }
    const project = pick(rest, projects);
    if (project !== undefined) {
      add(project);
      continue;
    }
    if (/^agent(?![\p{L}\p{N}_-])/iu.test(rest) && doc) {
      const owner = ownerOf(doc);
      if (!owner) log("@agent in a comment on a document no agent or project owns: skipped");
      add(owner);
    }
  }
  return out;
}

/** A text as a prompt shows it: the list's `+Name` as the typed `@Name`. */
function asTyped(text: string): string {
  let out = text;
  for (const f of mentionable()) {
    const token = f.kind === "agent" ? f.name : `project:${f.name}`;
    out = out.split(`+${token}`).join(`@${token}`);
  }
  return out;
}

const labelOf = (folder: string) => mentionable().find((f) => canonical(f.path) === folder)?.name ?? (path.basename(folder) || "Agent");

/* ------------------------------------------------------------------ */
/* the parent chat                                                     */
/* ------------------------------------------------------------------ */

/**
 * The chat a new thread or session chat is made under, for `folder`: the chat whose Office panel the editor is in
 * where that is a task chat of the folder; else the parent this document's other chats of that folder use; else the
 * folder's first task chat in the order the portal lists them (the sidebar's). A channel conversation, a routine, a
 * heartbeat or a child is never one: its speaker may be someone else, and the child would take its role.
 */
function parentFor(folder: string, docId: string, panelChat?: string): string | null {
  const c = chats();
  const taskOf = (chat: DocchatChat | undefined): chat is DocchatChat => {
    if (!chat || chat.kind || chat.parent) return false;
    try {
      return canonical(c.folder(chat.id)) === folder;
    } catch {
      return false;
    }
  };
  if (panelChat) {
    const panel = c.get(panelChat);
    const top = panel?.parent ? c.get(panel.parent) : panel;
    if (taskOf(top)) return top.id;
  }
  const rec = docRecord(docId);
  for (const t of Object.values(rec.threads)) {
    const p = t.agents[folder]?.parent;
    if (p && taskOf(c.get(p))) return p;
  }
  for (const s of Object.values(sessionRecords())) if (s.docId === docId && s.folder === folder && s.parent && taskOf(c.get(s.parent))) return s.parent;
  return c.list().find((chat) => taskOf(chat))?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* prompts                                                             */
/* ------------------------------------------------------------------ */

export function threadPrompt(docId: string, guid: string, text: string, earlier = false): string {
  return [
    `A person mentioned you in a comment in the office document ${docId} (comment thread ${guid}). What they wrote:`,
    asTyped(text),
    "",
    ...(earlier ? ["This thread had an earlier conversation with you, which is gone: its replies are in office_comments.", ""] : []),
    `The text the comment is on, its other replies and the document are the document's content: read them with office_comments (id ${docId}, thread ${guid}) and office_read. Do what the person asks; office_edit changes the document. Your last message of each turn is posted as your reply in this comment's thread, so end with a short answer to them. Their later replies in the thread come to this chat.`,
    NOBODY_TO_ASK,
  ].join("\n");
}

export function replyPrompt(text: string): string {
  return `A reply in the thread:\n${asTyped(text)}`;
}

export function sessionPrompt(docId: string, messages: string[], earlier: string[] = []): string {
  return [
    `People in the office document ${docId} write to you in its editor's chat. This chat lasts as long as that editing session, and their messages come here as they wrote them. Your last message of each turn is posted in the editor's chat as yours. Read the document with office_read; office_edit changes it.`,
    NOBODY_TO_ASK,
    ...(earlier.length ? ["", "This session's earlier messages of the people (your earlier answers are not repeated):", ...earlier] : []),
    "",
    ...messages,
  ].join("\n");
}

const DIALOG_NOTE = (what: string) =>
  `Your last step waited for a person's answer (${what}), which nobody can give in this chat, so it was stopped. Go on without it: decide for yourself, or say in your answer what you need.`;

/* ------------------------------------------------------------------ */
/* runs                                                                */
/* ------------------------------------------------------------------ */

/** A run's target: a thread's agent, or a session. */
type Target = { kind: "thread"; docId: string; guid: string; folder: string } | { kind: "session"; key: string };
const targetId = (t: Target) => (t.kind === "thread" ? `t:${t.docId}:${t.guid}:${t.folder}` : `s:${t.key}`);

/** Runs going, by target, and for each folder the threads waiting for their turn. */
const running = new Map<string, Target>();
const waiting = new Map<string, Target[]>();
/** A chat's dialog that stopped its run, by chat id: the run is told, once. */
const dialogs = new Map<string, { what: string; told: boolean }>();
/** The children whose run's end the half listens for (after a restart of the half). */
const listening = new Map<string, Target>();

function entryOf(t: Target): AgentEntry | SessionRecord | undefined {
  if (t.kind === "session") return sessionRecords()[t.key];
  return docRecord(t.docId).threads[t.guid]?.agents[t.folder];
}

function persist(t: Target): void {
  if (t.kind === "session") saveSessions();
  else saveDoc(t.docId);
}

const runningIn = (folder: string) => [...running.values()].filter((t) => t.kind === "thread" && t.folder === folder).length;

/** Gives `message` to the target's chat: at once where nothing runs there (and, for a thread, its folder has a free
 * run), else after: messages that come meanwhile are given together as the next prompt. */
function deliver(t: Target, message: string): void {
  const entry = entryOf(t);
  if (!entry) return;
  entry.queue.push(message);
  persist(t);
  next(t);
}

function next(t: Target): void {
  const entry = entryOf(t);
  const id = targetId(t);
  if (!entry || !entry.chatId || running.has(id) || !entry.queue.length) return;
  if (t.kind === "thread" && runningIn(t.folder) >= limits().runs) {
    const line = waiting.get(t.folder) ?? [];
    if (!line.some((w) => targetId(w) === id)) line.push(t);
    waiting.set(t.folder, line);
    entry.state = "queued";
    persist(t);
    return;
  }
  const message = entry.queue.join("\n\n");
  entry.queue = [];
  start(t, entry, message);
}

function start(t: Target, entry: AgentEntry | SessionRecord, message: string): void {
  const id = targetId(t);
  const chatId = entry.chatId!;
  running.set(id, t);
  entry.state = "working";
  delete entry.error;
  entry.pending = { since: now(), pid: process.pid };
  persist(t);
  let run: Promise<ChildRun>;
  try {
    run = chats().prompt(chatId, message);
  } catch (e) {
    run = Promise.resolve({ status: "error", answer: "", error: (e as Error).message });
  }
  run.then(
    (r) => ended(t, chatId, r),
    (e) => ended(t, chatId, { status: "error", answer: "", error: (e as Error)?.message ?? String(e) }),
  );
}

function ended(t: Target, chatId: string, r: ChildRun): void {
  const id = targetId(t);
  running.delete(id);
  const entry = entryOf(t);
  const dialog = dialogs.get(chatId);
  if (entry && entry.chatId === chatId) {
    delete entry.pending;
    if (dialog && r.status === "stopped") {
      // Stopped for a dialog nobody can answer: told once, and it goes on; a second one ends it.
      if (!dialog.told) {
        dialog.told = true;
        entry.queue.unshift(DIALOG_NOTE(dialog.what));
      } else {
        dialogs.delete(chatId);
        answered(t, entry, { status: "error", answer: "", error: `it waited for a person's answer (${dialog.what}), which nobody can give here` });
      }
    } else {
      dialogs.delete(chatId);
      answered(t, entry, r);
    }
    persist(t);
  }
  next(t);
  if (t.kind === "thread") {
    const line = waiting.get(t.folder) ?? [];
    while (line.length && runningIn(t.folder) < limits().runs) next(line.shift()!);
  }
}

/** What a run's end comes to: an answer posted, not posted, an error said, or nothing (stopped). */
function answered(t: Target, entry: AgentEntry | SessionRecord, r: ChildRun): void {
  const who = t.kind === "thread" ? labelOf(t.folder) : labelOf((entry as SessionRecord).folder);
  if (r.status === "stopped") {
    entry.state = "idle";
    return;
  }
  if (r.status === "error") {
    entry.state = "failed";
    entry.error = (r.error ?? "the run failed").slice(0, 200);
    if (t.kind === "thread") post(t, `${who} could not answer: ${entry.error}. Reply to try again.`);
    return;
  }
  if (!r.answer.trim()) {
    entry.state = "answered";
    return;
  }
  if (r.marked) {
    entry.state = "not_posted";
    record({ subject: subjectOf(t), reason: "an answer was not posted: its chat had read a suspected prompt injection", chatId: entry.chatId ?? undefined });
    return;
  }
  entry.state = "answered";
  post(t, r.answer);
}

const subjectOf = (t: Target) => {
  const docId = t.kind === "thread" ? t.docId : sessionRecords()[t.key]?.docId ?? "";
  return getDoc(docId, root())?.title ?? docId;
};

/* ------------------------------------------------------------------ */
/* posting                                                             */
/* ------------------------------------------------------------------ */

const lastSave = new Map<string, number>();

/** Keeps `text` to post for the target, and posts it now where Office runs. */
function post(t: Target, text: string): void {
  const entry = entryOf(t);
  if (!entry) return;
  entry.toPost = { text, at: now() };
  persist(t);
  void postNow(t);
}

/** The mode the agent's editor of the document opens in for a post: edit where its agent may change the file, else
 * comment-only for a thread (it still answers there) and view for the editor's chat. */
function modeFor(doc: DocMeta, folder: string, thread: boolean, chatId: string | null): "edit" | "view" | "comment" {
  const may = cfg.mayWrite ? cfg.mayWrite(doc, folder, chatId) : true;
  return may ? "edit" : thread ? "comment" : "view";
}

const posting = new Set<string>();

async function postNow(t: Target): Promise<void> {
  const id = targetId(t);
  if (posting.has(id)) return;
  const entry = entryOf(t);
  if (!entry?.toPost) return;
  posting.add(id);
  try {
    const state = (await cfg.officeState?.()) ?? "running";
    if (state !== "running") {
      entry.error = state === "starting" ? "Office is starting; the answer is posted once it runs" : "Office is stopped; the answer is posted once it runs again";
      persist(t);
      return;
    }
    const run = cfg.seatRun ?? (async () => Promise.reject(new Error("no seats")));
    const docId = t.kind === "thread" ? t.docId : (entry as SessionRecord).docId;
    const folder = t.kind === "thread" ? t.folder : (entry as SessionRecord).folder;
    const doc = getDoc(docId, root());
    if (!doc) {
      delete entry.toPost;
      persist(t);
      return;
    }
    const author = `${labelOf(folder)} (agent)`;
    const userId = `agent:${keyIdOf(folder)}`;
    const text = entry.toPost.text;
    if (t.kind === "session") {
      const mode = modeFor(doc, folder, false, entry.chatId);
      const chunks: string[] = [];
      for (let i = 0; i < text.length && chunks.length < limits().chatMessages; i += CHAT_CHUNK) chunks.push(text.slice(i, i + CHAT_CHUNK));
      if (text.length > CHAT_CHUNK * limits().chatMessages) chunks[chunks.length - 1] = `${chunks[chunks.length - 1].slice(0, CHAT_CHUNK - 4)} (…)`;
      for (const chunk of chunks) await run(folder, docId, mode, { kind: "chat.send", args: { text: chunk } }, { post: true });
      record({ subject: doc.title, reason: `posted an answer of ${text.length} characters in the editor's chat for ${folder}`, chatId: entry.chatId ?? undefined });
    } else {
      const thread = docRecord(docId).threads[t.guid];
      if (!thread) {
        delete entry.toPost;
        persist(t);
        return;
      }
      const mode = modeFor(doc, folder, true, entry.chatId);
      const max = limits().replyChars;
      const reply = text.length > max ? `${text.slice(0, max)} (…)` : text;
      // An editor that may only comment: Word rolls a builder command's reply back there, and takes it through its
      // comment methods (`how: "method"`); the spreadsheet editor takes the builder's reply in either mode.
      const job =
        doc.ext === "docx"
          ? { kind: "word.reply", args: { guid: t.guid, text: reply, author, userId, ...(mode === "comment" ? { how: "method" } : {}) } }
          : { kind: "cell.reply", args: { sessionId: thread.sessionId, match: { userId: thread.userId ?? "", author: thread.author ?? "", text: thread.text, time: thread.time ?? 0 }, text: reply, author, userId } };
      const made = (await run(folder, docId, mode, job, { post: true })) as { guid?: unknown } | null;
      // A Word comment answered through the comment methods comes back under a GUID of its own: the thread follows it.
      if (typeof made?.guid === "string" && made.guid !== t.guid) {
        moved(docId, [[t.guid, made.guid]]);
        t.guid = made.guid;
        (job.args as { guid?: string }).guid = made.guid;
      }
      await saveSoon(folder, docId);
      // Each change of a thread rewrites it whole from the changing page's view: a person's change at the same moment
      // can write it back without the reply. Read back once, and posted again where it is not there.
      if (!(await replyThere(folder, docId, mode, t.guid, thread, reply))) {
        log(`the answer in thread ${t.guid} of ${docId} was lost to a change at the same time: posted again`);
        await run(folder, docId, mode, job, { post: true });
        await saveSoon(folder, docId);
      }
      record({ subject: doc.title, reason: `posted an answer of ${reply.length} characters in comment thread ${t.guid} for ${folder}`, chatId: entry.chatId ?? undefined });
    }
    delete entry.toPost;
    delete entry.error;
    persist(t);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    entry.state = "failed";
    entry.error = err.code === "comment_gone" ? "the comment is gone" : err.code === "office_stopped" ? "Office is stopped; the answer is posted once it runs again" : err.code === "agent_editor_missing" ? "the agents' editor is not downloaded: Start in Settings → Office downloads it" : String(err.message ?? e).slice(0, 200);
    // Gone for good: nothing left to post it to.
    if (err.code === "comment_gone" || err.code === "comment_ambiguous" || err.code === "not_found") delete entry.toPost;
    log(`an answer could not be posted (${t.kind === "thread" ? `thread ${t.guid}` : `session ${t.key}`}): ${err.code ?? ""} ${err.message ?? e}`);
    persist(t);
  } finally {
    posting.delete(id);
  }
}

/** A save of the session the agent's editor of the document is in, at most once per document in SAVE_EVERY_MS: the
 * reply is in the file also when nobody is in the document. */
async function saveSoon(folder: string, docId: string): Promise<void> {
  if (now() - (lastSave.get(docId) ?? 0) < SAVE_EVERY_MS) return;
  lastSave.set(docId, now());
  const key = cfg.keyOf?.(folder, docId);
  if (!key || !cfg.save) return;
  try {
    await cfg.save(key);
  } catch (e) {
    log(`the save after a reply in ${docId} failed: ${(e as Error).message}`);
  }
}

async function replyThere(folder: string, docId: string, mode: "edit" | "view" | "comment", guid: string, thread: Thread, reply: string): Promise<boolean> {
  try {
    const doc = getDoc(docId, root());
    const listed = (await cfg.seatRun!(folder, docId, mode === "comment" ? "comment" : mode, { kind: doc?.ext === "xlsx" ? "cell.comments" : "word.comments", args: {} }, { post: true })) as { comments?: { guid?: string; userId: string; text: string; replies: { text: string }[] }[] };
    const comment = (listed.comments ?? []).find((c) => (c.guid ? c.guid === guid : c.userId === (thread.userId ?? "") && c.text === thread.text));
    return !comment || comment.replies.some((r) => r.text === reply);
  } catch {
    // Not known: taken as there, rather than posted twice.
    return true;
  }
}

/** Everything kept to post, posted where it can be: at boot, at a page's ready, after the Document Server started. */
export function postWaiting(): void {
  for (const docId of new Set([...docsWithThreads(), ...docs.keys()])) {
    for (const [guid, thread] of Object.entries(docRecord(docId).threads)) for (const [folder, a] of Object.entries(thread.agents)) if (a.toPost) void postNow({ kind: "thread", docId, guid, folder });
  }
  for (const [key, s] of Object.entries(sessionRecords())) if (s.toPost) void postNow({ kind: "session", key });
}

/* ------------------------------------------------------------------ */
/* threads                                                             */
/* ------------------------------------------------------------------ */

/** Live state the pages report, per document: each comment as they last saw it (for office_comments and a sheet's
 * reply), and which pages (by key) reported. Kept in memory: it is the open session's. */
const live = new Map<string, { comments: Map<string, PageComment>; at: number }>();

/** The comments the people's pages last reported for `docId`, while a page reported in the last `withinMs`. */
export function liveComments(docId: string, withinMs = 10 * 60_000): PageComment[] | null {
  const l = live.get(docId);
  if (!l || now() - l.at > withinMs) return null;
  return [...l.comments.values()];
}

function seen(docId: string, c: PageComment): void {
  const l = live.get(docId) ?? { comments: new Map(), at: now() };
  l.at = now();
  l.comments.set(c.guid, c);
  live.set(docId, l);
  const thread = docRecord(docId).threads[c.guid];
  if (!thread) return;
  if (thread.removing) cancelRemoval(docId, c.guid);
  let changed = false;
  if (c.sessionId && c.sessionId !== thread.sessionId) (thread.sessionId = c.sessionId), (changed = true);
  if (c.userId && c.userId !== thread.userId) (thread.userId = c.userId), (changed = true);
  if (c.author && c.author !== thread.author) (thread.author = c.author), (changed = true);
  if (c.time && c.time !== thread.time) (thread.time = c.time), (changed = true);
  if (changed) saveDoc(docId);
}

/** What one thread's state says for the editor's bar. */
export type DocchatItem = { kind: "thread" | "chat"; label: string; state: ChatState; error?: string };

/** The states of a document's thread and session chats that are worth showing. */
export function statesOf(docId: string): DocchatItem[] {
  const out: DocchatItem[] = [];
  for (const thread of Object.values(docRecord(docId).threads)) {
    for (const [folder, a] of Object.entries(thread.agents)) if (a.state !== "idle") out.push({ kind: "thread", label: labelOf(folder), state: a.state, ...(a.error ? { error: a.error } : {}) });
  }
  for (const s of Object.values(sessionRecords())) if (s.docId === docId && s.state !== "idle") out.push({ kind: "chat", label: labelOf(s.folder), state: s.state, ...(s.error ? { error: s.error } : {}) });
  const nobody = noOwner.get(docId);
  if (nobody) out.push({ kind: "chat", label: "", state: "nobody" });
  return out;
}

/** Documents whose editor's chat had a message with nobody to answer it (no owner). */
const noOwner = new Map<string, number>();

/** A thread's chat for `folder`, made where it has none: under the parent chosen for it; null where there is none. */
function chatFor(docId: string, guid: string, folder: string, entry: AgentEntry, text: string, panelChat?: string): string | null {
  if (entry.chatId && chats().get(entry.chatId)) return entry.chatId;
  if (entry.chatId) {
    internal.delete(entry.chatId);
    entry.chatId = null;
    entry.earlier = true;
  }
  const parent = parentFor(folder, docId, panelChat);
  if (!parent) {
    entry.state = "no_chat";
    entry.error = `${labelOf(folder)} has no chat to work from: start one with ${labelOf(folder)}`;
    return null;
  }
  const title = `Comment: ${asTyped(text).replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS)}`;
  const chat = chats().create({ parent, title, listed: false });
  internal.add(chat.id);
  entry.chatId = chat.id;
  entry.parent = parent;
  return chat.id;
}

/** An agent or project mentioned in a thread: its entry made (within the document's limit) and its chat given `first`
 * where it is new, else `later`. */
function mention(docId: string, guid: string, folder: string, text: string, panelChat: string | undefined, later?: string): void {
  const rec = docRecord(docId);
  const thread = rec.threads[guid];
  let entry = thread.agents[folder];
  const fresh = !entry;
  if (!entry) {
    const withAgents = Object.values(rec.threads).filter((t) => Object.keys(t.agents).length).length;
    if (!Object.keys(thread.agents).length && withAgents >= limits().threads) {
      thread.agents[folder] = { chatId: null, parent: null, state: "limit", error: "Too many comment chats in this document: delete some comments", queue: [] };
      saveDoc(docId);
      return;
    }
    entry = thread.agents[folder] = { chatId: null, parent: null, state: "idle", queue: [] };
    // Granted the document for good, keyed by the thread (store.addGrant).
    addGrant(docId, folder, guid, now(), root());
    record({ subject: getDoc(docId, root())?.title ?? docId, reason: `comment thread ${guid}: ${folder} mentioned, given access to the document` });
  }
  if (entry.state === "limit") return;
  const hadChat = Boolean(entry.chatId && chats().get(entry.chatId));
  let chatId: string | null;
  try {
    chatId = chatFor(docId, guid, folder, entry, text, panelChat);
  } catch (e) {
    entry.state = "failed";
    entry.error = `its chat could not be made: ${(e as Error).message}`.slice(0, 200);
    saveDoc(docId);
    return;
  }
  saveDoc(docId);
  if (!chatId) return;
  const target: Target = { kind: "thread", docId, guid, folder };
  // A new chat is given the comment; one added by a reply, or made anew after its chat was lost, the reply too.
  if (fresh || !hadChat) deliver(target, `${threadPrompt(docId, guid, text, entry.earlier)}${later ? `\n\n${replyPrompt(later)}` : ""}`);
  else if (later) deliver(target, replyPrompt(later));
}

/** A person's own act in the editor (a ui report): what it starts or tells. */
function onUi(docId: string, key: string, e: Extract<PageEvent, { type: "ui" }>, panelChat?: string): void {
  const doc = getDoc(docId, root());
  if (!doc) return;
  const text = String(e.text ?? "").slice(0, CAPS.text);
  if (e.kind === "chat") return onChat(doc, key, text, panelChat);
  const guid = typeof e.guid === "string" ? e.guid : "";
  if (!guid) return;
  const rec = docRecord(docId);
  if (e.kind === "comment") {
    const folders = parseMentions(text, doc);
    if (!folders.length) return;
    rec.threads[guid] ??= { createdAt: now(), text, inFile: false, agents: {} };
    rec.threads[guid].text = text;
    const c = live.get(docId)?.comments.get(guid);
    if (c) seen(docId, c);
    for (const folder of folders) mention(docId, guid, folder, text, panelChat);
    return;
  }
  if (e.kind === "edit") {
    const thread = rec.threads[guid];
    if (thread) thread.text = text;
    const folders = parseMentions(text, doc).filter((f) => !thread?.agents[f]);
    if (!folders.length) return saveDoc(docId);
    rec.threads[guid] ??= { createdAt: now(), text, inFile: false, agents: {} };
    for (const folder of folders) mention(docId, guid, folder, text, panelChat);
    return;
  }
  if (e.kind === "reply") {
    const thread = rec.threads[guid];
    const named = parseMentions(text, doc);
    if (!thread) {
      // A thread with no record (an undo after its grace, a comment that mentioned nobody): a reply that mentions
      // someone starts it; any other does nothing.
      if (!named.length) return;
      const original = live.get(docId)?.comments.get(guid)?.text ?? "";
      rec.threads[guid] = { createdAt: now(), text: original, inFile: false, agents: {} };
      for (const folder of named) mention(docId, guid, folder, original || text, panelChat, original ? text : undefined);
      return;
    }
    const newcomers = named.filter((f) => !thread.agents[f]);
    for (const folder of newcomers) mention(docId, guid, folder, thread.text, panelChat, text);
    // The reply goes to every chat of the thread, or to the ones it names where it names any.
    const to = Object.keys(thread.agents).filter((f) => !newcomers.includes(f) && (!named.length || named.includes(f)));
    for (const folder of to) {
      const entry = thread.agents[folder];
      if (entry.state === "limit") continue;
      if (!entry.chatId || !chats().get(entry.chatId)) mention(docId, guid, folder, thread.text, panelChat, text);
      else deliver({ kind: "thread", docId, guid, folder }, replyPrompt(text));
    }
    return;
  }
  // Edits of a reply, resolve and unresolve: nobody is prompted, and the thread stays.
}

/* ------------------------------------------------------------------ */
/* the editor's chat                                                   */
/* ------------------------------------------------------------------ */

function onChat(doc: DocMeta, key: string, text: string, panelChat?: string): void {
  if (!text.trim()) return;
  const folder = ownerOf(doc);
  if (!folder) {
    noOwner.set(doc.docId, now());
    return;
  }
  const all = sessionRecords();
  let s = all[key];
  if (!s || s.docId !== doc.docId) s = all[key] = { docId: doc.docId, folder, chatId: null, parent: null, state: "idle", people: [], queue: [] };
  delete s.ending;
  const earlier = s.people.map((p) => p.text);
  s.people.push({ text, at: now() });
  while (s.people.length > PEOPLE_KEPT || s.people.reduce((n, p) => n + p.text.length, 0) > PEOPLE_CHARS) s.people.shift();
  let fresh = false;
  if (!s.chatId || !chats().get(s.chatId)) {
    if (s.chatId) internal.delete(s.chatId);
    const parent = parentFor(folder, doc.docId, panelChat);
    if (!parent) {
      s.chatId = null;
      s.state = "no_chat";
      s.error = `${labelOf(folder)} has no chat to work from: start one with ${labelOf(folder)}`;
      saveSessions();
      return;
    }
    try {
      const chat = chats().create({ parent, title: "Office chat", listed: false });
      internal.add(chat.id);
      fresh = true;
      s.chatId = chat.id;
      s.parent = parent;
    } catch (e) {
      s.state = "failed";
      s.error = `its chat could not be made: ${(e as Error).message}`.slice(0, 200);
      saveSessions();
      return;
    }
  }
  saveSessions();
  // A chat made anew while the session went on is given the people's earlier messages, not its own lost answers.
  deliver({ kind: "session", key }, fresh ? sessionPrompt(doc.docId, [text], earlier) : text);
}

/** The Document Server said who is in the session of `key` (a status-1 callback: `users`), or that it ended (2, 4):
 * the session's chat goes `chatEndS` after the last person left, unless one comes back. */
export function sessionUsers(key: string, users: string[] | null): void {
  const s = sessionRecords()[key];
  if (!s) return;
  const people = (users ?? []).filter((u) => !u.startsWith("agent:"));
  if (people.length) {
    if (s.ending) {
      delete s.ending;
      clearTimer(`end:${key}`);
      saveSessions();
    }
    return;
  }
  if (s.ending) return;
  s.ending = now() + limits().chatEndS * 1000;
  saveSessions();
  timer(`end:${key}`, limits().chatEndS * 1000, () => void endSession(key));
}

async function endSession(key: string): Promise<void> {
  const s = sessionRecords()[key];
  if (!s) return;
  delete sessionRecords()[key];
  saveSessions();
  running.delete(targetId({ kind: "session", key }));
  if (s.chatId) await removeChat(s.chatId);
}

/** The Document Server started again: every editing session is over, and their chats go. */
export async function dsStarted(): Promise<void> {
  for (const key of Object.keys(sessionRecords())) await endSession(key);
}

/* ------------------------------------------------------------------ */
/* removal                                                             */
/* ------------------------------------------------------------------ */

const timers = new Map<string, NodeJS.Timeout>();
function timer(name: string, ms: number, fn: () => void): void {
  clearTimer(name);
  const t = setTimeout(() => {
    timers.delete(name);
    fn();
  }, Math.max(0, ms));
  t.unref?.();
  timers.set(name, t);
}
function clearTimer(name: string): void {
  const t = timers.get(name);
  if (t) clearTimeout(t);
  timers.delete(name);
}

/** A thread seen gone (`reason`): it and its chats go after the grace, unless it is seen again in that time. */
function startRemoval(docId: string, guid: string, reason: string): void {
  const thread = docRecord(docId).threads[guid];
  if (!thread || thread.removing) return;
  thread.removing = { at: now() + limits().removeAfterS * 1000, reason };
  saveDoc(docId);
  timer(`rm:${docId}:${guid}`, limits().removeAfterS * 1000, () => void removeThread(docId, guid));
}

function cancelRemoval(docId: string, guid: string): void {
  const thread = docRecord(docId).threads[guid];
  if (!thread?.removing) return;
  delete thread.removing;
  clearTimer(`rm:${docId}:${guid}`);
  saveDoc(docId);
}

async function removeChat(chatId: string): Promise<void> {
  internal.delete(chatId);
  try {
    if (chats().get(chatId)) await chats().remove(chatId);
  } catch (e) {
    log(`the chat ${chatId} could not be removed: ${(e as Error).message}`);
  }
}

async function removeThread(docId: string, guid: string): Promise<void> {
  const rec = docRecord(docId);
  const thread = rec.threads[guid];
  if (!thread) return;
  delete rec.threads[guid];
  saveDoc(docId);
  for (const [folder, a] of Object.entries(thread.agents)) {
    running.delete(targetId({ kind: "thread", docId, guid, folder }));
    if (a.chatId) await removeChat(a.chatId);
  }
}

/** The agent's edit moved comments onto its new text (office_edit's `moved`): their threads go on under the new GUID. */
export function moved(docId: string, pairs: [string, string][]): void {
  const rec = docRecord(docId);
  let changed = false;
  for (const [from, to] of pairs) {
    const thread = rec.threads[from];
    if (!thread || rec.threads[to]) continue;
    delete rec.threads[from];
    rec.threads[to] = thread;
    if (thread.removing) {
      delete thread.removing;
      clearTimer(`rm:${docId}:${from}`);
    }
    // A run that goes on, and a thread waiting for its turn, carry the thread by its GUID: their targets follow it.
    for (const [id, t] of [...running]) {
      if (t.kind !== "thread" || t.docId !== docId || t.guid !== from) continue;
      running.delete(id);
      t.guid = to;
      running.set(targetId(t), t);
    }
    for (const line of waiting.values()) for (const t of line) if (t.kind === "thread" && t.docId === docId && t.guid === from) t.guid = to;
    changed = true;
  }
  if (changed) saveDoc(docId);
}

/** A saved file of `docId` (callback's onPersisted): threads an earlier saved file had and this one lacks go after the
 * grace, unless one of this file's comments without a known thread is theirs by author and text (an outside tool that
 * dropped the GUIDs), which renames them; the threads this file has are known to be in the file from now on. */
export function persisted(docId: string, buffer: Buffer): void {
  const doc = getDoc(docId, root());
  if (!doc) return;
  let file: CommentThread[];
  try {
    file = doc.ext === "docx" ? docxThreads(buffer) : xlsxThreads(buffer);
  } catch (e) {
    log(`the comments of a save of ${docId} could not be read: ${(e as Error).message}`);
    return;
  }
  reconcile(docId, file, "saved");
}

function reconcile(docId: string, file: CommentThread[], reason: string): void {
  const rec = docRecord(docId);
  if (!Object.keys(rec.threads).length) return;
  const guids = new Set(file.map((t) => t.guid).filter(Boolean));
  let changed = false;
  for (const [guid, thread] of Object.entries({ ...rec.threads })) {
    if (guids.has(guid)) {
      if (!thread.inFile) (thread.inFile = true), (changed = true);
      if (thread.removing) cancelRemoval(docId, guid);
      continue;
    }
    if (!thread.inFile) continue;
    const match = file.find((f) => (!f.guid || !rec.threads[f.guid]) && f.text.trim() === thread.text.trim() && (!thread.userId || !f.userId || f.userId === thread.userId));
    if (match?.guid) {
      moved(docId, [[guid, match.guid]]);
      continue;
    }
    if (match) continue; // the same comment without a GUID (an outside tool): it is still there
    startRemoval(docId, guid, reason);
  }
  if (changed) saveDoc(docId);
}

/** A document deleted (or pruned): all its threads and its sessions' chats go at once. */
export async function documentGone(docId: string): Promise<void> {
  const rec = docRecord(docId);
  for (const guid of Object.keys(rec.threads)) await removeThread(docId, guid);
  docs.delete(docId);
  try {
    fs.rmSync(threadsFile(docId), { force: true });
  } catch {
    // gone already
  }
  for (const [key, s] of Object.entries(sessionRecords())) if (s.docId === docId) await endSession(key);
}

/** A folder the portal deleted: its entries go from every thread and session (its chats went with it). */
export function folderRemoved(folder: string): void {
  const f = canonical(folder);
  for (const docId of new Set([...docsWithThreads(), ...docs.keys()])) {
    const rec = docRecord(docId);
    let changed = false;
    for (const thread of Object.values(rec.threads)) {
      if (thread.agents[f]) {
        if (thread.agents[f].chatId) internal.delete(thread.agents[f].chatId!);
        delete thread.agents[f];
        changed = true;
      }
    }
    if (changed) saveDoc(docId);
  }
  for (const [key, s] of Object.entries(sessionRecords())) if (s.folder === f) delete sessionRecords()[key];
  saveSessions();
}

/** A chat deleted (by the person, or with its parent): the records keep their thread without it; the next message
 * makes a new one. */
export function chatDeleted(chatId: string): void {
  if (!internal.has(chatId)) return;
  internal.delete(chatId);
  for (const docId of docs.keys()) {
    const rec = docRecord(docId);
    for (const [guid, thread] of Object.entries(rec.threads)) {
      for (const [folder, a] of Object.entries(thread.agents)) {
        if (a.chatId !== chatId) continue;
        a.chatId = null;
        a.earlier = true;
        a.state = "idle";
        delete a.pending;
        running.delete(targetId({ kind: "thread", docId, guid, folder }));
        saveDoc(docId);
      }
    }
  }
  for (const [key, s] of Object.entries(sessionRecords())) {
    if (s.chatId !== chatId) continue;
    s.chatId = null;
    s.state = "idle";
    delete s.pending;
    running.delete(targetId({ kind: "session", key }));
    saveSessions();
  }
}

/* ------------------------------------------------------------------ */
/* a chat's events                                                     */
/* ------------------------------------------------------------------ */

/** Every event of every chat (chats.onEvent): a dialog of one of ours stops its run at once; after a restart of the
 * half, the end of a run it no longer waits for gives the answer. */
export function chatEvent(chatId: string, event: Record<string, unknown>): void {
  if (!internal.has(chatId)) return;
  if (event?.type === "extension_ui_request" && DIALOGS.has(String(event.method))) {
    const what = String(event.title ?? event.method).slice(0, 120);
    const known = dialogs.get(chatId);
    dialogs.set(chatId, { what, told: known?.told ?? false });
    log(`chat ${chatId} opened a dialog (${event.method}) nobody can answer: stopped`);
    chats()
      .abort(chatId)
      .catch((e: unknown) => log(`chat ${chatId} could not be stopped: ${(e as Error)?.message ?? e}`));
    return;
  }
  const t = listening.get(chatId);
  if (!t) return;
  if (event?.type === "message_end") {
    const m = event.message as { role?: string; content?: { type: string; text?: string }[] } | undefined;
    if (m?.role === "assistant") {
      const said = (m.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("");
      if (said.trim()) lastSaid.set(chatId, said);
    }
  }
  if (event?.type === "agent_end") {
    listening.delete(chatId);
    const answer = lastSaid.get(chatId) ?? "";
    lastSaid.delete(chatId);
    ended(t, chatId, { status: "done", answer });
  }
}
const lastSaid = new Map<string, string>();

/* ------------------------------------------------------------------ */
/* the page's reports                                                  */
/* ------------------------------------------------------------------ */

const rates = new Map<string, number[]>();

/** Whether a page (by its key) may report once more now: CAPS.perTenSeconds requests in 10 s. */
export function rateOk(page: string): boolean {
  const t = now();
  const list = (rates.get(page) ?? []).filter((at) => t - at < 10_000);
  if (list.length >= CAPS.perTenSeconds) {
    rates.set(page, list);
    return false;
  }
  list.push(t);
  rates.set(page, list);
  return true;
}

/** A page's batch of events for `docId` in the session of `key`. A ui report whose id was taken already is taken
 * once (a retried request). */
export function report(docId: string, key: string, events: PageEvent[], panelChat?: string): void {
  const rec = docRecord(docId);
  for (const e of events) {
    try {
      if (e.type === "ui") {
        if (typeof e.id !== "string" || !e.id || rec.uiSeen.includes(e.id)) continue;
        rec.uiSeen.push(e.id);
        if (rec.uiSeen.length > UI_SEEN) rec.uiSeen.splice(0, rec.uiSeen.length - UI_SEEN);
        saveDoc(docId);
        onUi(docId, key, e, panelChat);
      } else if (e.type === "comment") {
        if (typeof e.guid === "string" && e.guid) seen(docId, e);
      } else if (e.type === "removed") {
        for (const guid of Array.isArray(e.guids) ? e.guids : []) {
          live.get(docId)?.comments.delete(guid);
          startRemoval(docId, String(guid), "deleted in the editor");
        }
      }
    } catch (err) {
      log(`a report of ${docId} failed: ${(err as Error)?.stack ?? err}`);
    }
  }
}

/** A page's editor is ready: the comments it sees. A thread it lacks may be gone (its grace starts, which another
 * page's list or a save that has it cancels); the ones it has are there. What waits to be posted is posted. */
export function ready(docId: string, key: string, comments: PageComment[]): void {
  const rec = docRecord(docId);
  const there = new Set<string>();
  for (const c of comments) {
    if (typeof c.guid !== "string" || !c.guid) continue;
    there.add(c.guid);
    seen(docId, c);
  }
  for (const guid of Object.keys(rec.threads)) if (!there.has(guid)) startRemoval(docId, guid, "not in an editor that opened");
  void key;
  postWaiting();
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

/**
 * At the half's start: every record read; a run that was going when the half stopped is listened for where the portal
 * went on (the same process: its run goes on, and its end gives the answer), else the chat was cut off with the
 * portal and the thread says so; a removal past its grace is done, one under way waits on; each session's key is asked
 * whether a person is still in it (the command service's `info`), and one that has none ends; a chat the portal no
 * longer knows is dropped from its record; then what waits to be posted is posted.
 */
export async function boot(): Promise<void> {
  loadAll();
  const c = chats();
  for (const docId of docsWithThreads()) {
    const rec = docRecord(docId);
    if (!getDoc(docId, root())) {
      await documentGone(docId);
      continue;
    }
    for (const [guid, thread] of Object.entries(rec.threads)) {
      if (thread.removing) {
        const left = thread.removing.at - now();
        if (left <= 0) {
          await removeThread(docId, guid);
          continue;
        }
        timer(`rm:${docId}:${guid}`, left, () => void removeThread(docId, guid));
      }
      for (const [folder, a] of Object.entries(thread.agents)) {
        if (a.chatId && !c.get(a.chatId)) {
          internal.delete(a.chatId);
          a.chatId = null;
          a.earlier = true;
          delete a.pending;
          a.state = "idle";
        }
        resume({ kind: "thread", docId, guid, folder }, a);
      }
    }
    saveDoc(docId);
  }
  const all = sessionRecords();
  for (const [key, s] of Object.entries(all)) {
    if (s.chatId && !c.get(s.chatId)) {
      internal.delete(s.chatId);
      s.chatId = null;
      delete s.pending;
      s.state = "idle";
    }
    resume({ kind: "session", key }, s);
    let users: string[] | null = null;
    try {
      const info = cfg.command ? await cfg.command({ c: "info", key }) : { error: 1 };
      users = info.error === 0 && Array.isArray(info.users) ? (info.users as unknown[]).map(String) : null;
    } catch {
      users = null;
    }
    sessionUsers(key, users);
  }
  saveSessions();
  postWaiting();
}

/** A run that was going when the half stopped: listened for where the portal went on, else said to be cut off. */
function resume(t: Target, entry: AgentEntry | SessionRecord): void {
  if (!entry.pending || !entry.chatId) {
    if (entry.queue.length) next(t);
    return;
  }
  if (entry.pending.pid === process.pid && chats().get(entry.chatId)?.status === "running") {
    running.set(targetId(t), t);
    listening.set(entry.chatId, t);
    return;
  }
  delete entry.pending;
  entry.state = "interrupted";
  const who = labelOf(t.kind === "thread" ? t.folder : (entry as SessionRecord).folder);
  if (t.kind === "thread") post(t, `${who} was interrupted before it answered. Reply to try again.`);
}

/** The thread a chat of ours was made for: what office_comments marks as the comment the agent was asked in. */
export function threadOfChat(chatId: string): { docId: string; guid: string } | null {
  if (!isInternal(chatId)) return null;
  for (const docId of new Set([...docsWithThreads(), ...docs.keys()])) {
    for (const [guid, thread] of Object.entries(docRecord(docId).threads)) if (Object.values(thread.agents).some((a) => a.chatId === chatId)) return { docId, guid };
  }
  return null;
}

/** All documents' threads, for a test or a look: the record as it is now. */
export function threadsOf(docId: string): Record<string, Thread> {
  return docRecord(docId).threads;
}

/** The session records, for a test or a look. */
export function sessionsNow(): Record<string, SessionRecord> {
  return sessionRecords();
}

/** Keeps the documents' comments for office_comments while nothing reported them: the saved file's threads. */
export function savedThreads(doc: DocMeta): CommentThread[] {
  const buf = readDoc(doc, root());
  return doc.ext === "docx" ? docxThreads(buf) : xlsxThreads(buf);
}

/** The documents the records name: for the boot's sweep of documents that are gone. */
export function knownDocs(): string[] {
  return [...new Set([...docsWithThreads(), ...listDocs(root()).map((d) => d.docId)])];
}
