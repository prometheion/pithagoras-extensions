/**
 * Wake on comment mention. Server-side only.
 *
 * On every docx persist (callback status 2/6 fires the `onPersisted` hooks), the saved buffer is re-parsed
 * (`parseDocx`: word/comments.xml and OnlyOffice's document comments) and its comments are compared with the
 * last-seen set kept in `<root>/state/<docId>.json`, by their keys (ooxml.commentKeys: author and text, as the
 * Document Server numbers the comments anew at every save). Each NEW comment is scanned for mentions (grammar below);
 * per resolved mention, per target folder: a grant on this one doc (deduped by comment key), an audit line, a queued
 * wake text (`officeWakeMessage`) for a chat of that folder, and `chats.tell(chatId, {type:"ping"})` so the target's
 * pi extension drains the queue off its UI_RECEIVE bell (drain side = the tools' factory in tools.ts; this module
 * only QUEUES). The seen set is written back AFTER processing.
 *
 * First-save decision: a SCANNED (or imported) document arrives with its own comment history -- the scan records the
 * file's comment keys in DocMeta.importedKeys AT INDEX TIME, and a persist with NO prior state file takes exactly those
 * as seen WITHOUT resolving mentions (they predate this library and must not ring bells). A comment that appears after
 * indexing but before the first save is NEW and IS processed on that first save, so its wake is not lost. Where the
 * keys are not known (the source did not parse, or an index of the version before, which kept ids) everything the first
 * save holds is taken as seen. A CREATED blank document gets no baseline: its seen set starts empty, so an @mention
 * typed during the very first editing session is processed on its first save like any later one.
 * Corrupt/undecodable state file: logged, previous set treated as EMPTY (every current comment is then "new", its
 * mentions processed once; the immediately-following write restores a sane file). A re-send of an already-seen
 * comment adds nothing, so normal re-saves never double-ping or double-grant; a comment whose text is changed is a
 * new one.
 *
 * v1 wakes docx ONLY: xlsx comments live in xl/commentsN.xml + VML anchors (not read yet), so the hook is a no-op for
 * non-docx docs. onPersisted hands over (docId, buffer) only, so this module resolves the meta
 * itself via store.getDoc(docId, root) and checks meta.ext.
 */
import fs from "node:fs";
import path from "node:path";
import { portal } from "./host";
import { addGrant as storeAddGrant, canonical, getDoc, within } from "./store";
import { commentKeys, parseDocx, type Comment } from "./ooxml";
import { onPersisted } from "./callback";

/** A line the audit seam records per resolved mention (subject = doc title; reason carries what happened; chatId = woken home). */
export type PingAuditEntry = { subject: string; reason: string; chatId: string };

/** Injection seams for wirePing. Every function form is LAZY by design: the defaults read portal() only when actually used, and tests pass plain fns so they never reach the real portal. `root` overrides dataDir() for the store/state layout. */
export type PingDeps = {
  root?: string;
  folders?: () => { path: string; name: string; kind: "agent" | "project" | "chat"; home?: boolean }[];
  inFolder?: (folderPath: string) => { id: string; title?: string }[];
  tell?: (chatId: string, data: unknown) => Promise<boolean> | boolean;
  record?: (entry: PingAuditEntry) => void;
  log?: (line: string) => void;
};

/** One queued wake entry: text is what pi is handed, details ride along for the drain side. */
export type WakeEntry = { text: string; details: { docId: string; commentId: string } };

let cfg: PingDeps = {};
let hookRegistered = false;
/** chatId -> wake entries queued server-side. Drained by the office pi extension on UI_RECEIVE. */
const wakes = new Map<string, WakeEntry[]>();

function root(): string {
  return cfg.root ?? portal().dataDir();
}
function folders(): { path: string; name: string; kind: "agent" | "project" | "chat"; home?: boolean }[] {
  return (cfg.folders ?? (() => portal().folders.list()))();
}
function inFolder(p: string): { id: string; title?: string }[] {
  return (cfg.inFolder ?? ((fp) => portal().chats.inFolder(fp)))(p);
}
function logLine(line: string): void {
  (cfg.log ?? ((l) => portal().log(l)))(line);
}
function record(entry: PingAuditEntry): void {
  // Lazy default is a one-line log (a real audit sink can be passed via wirePing({record})).
  (cfg.record ?? ((e: PingAuditEntry) => logLine(`office ping: ${e.subject}: ${e.reason} (woken ${e.chatId})`)))(entry);
}

/** server.ts calls ONCE at boot. Later calls (unit tests) only update the seams -- the onPersisted hook is registered exactly once per process. */
export function wirePing(opts?: PingDeps): void {
  if (opts) cfg = { ...cfg, ...opts };
  if (!hookRegistered) {
    hookRegistered = true;
    onPersisted(handlePersisted);
  }
}

/** Test seam: drop the module-level seams, hook flag and queued wakes. */
export function __resetPingForTests(): void {
  cfg = {};
  hookRegistered = false;
  wakes.clear();
}

/** Remove and return what is queued for a chat (the office pi extension calls this on its UI_RECEIVE bell). */
export function drainWakeQueue(chatId: string): WakeEntry[] {
  const entries = wakes.get(chatId);
  if (!entries) return [];
  wakes.delete(chatId);
  return entries;
}

/** The wake text shape, following the portal's document wake text: doc title, quoted comment (every line prefixed "> "), and the grant sentence with the office_* pointer -- "given access", NOT "for this task": the added grants are permanent in v1 (per-comment expiry is deferred), so the text must not promise a scope that does not exist. The doc id is NOT embedded in the text: it rides in WakeEntry.details ({docId, commentId}), which the drain side hands to pi's sendMessage. `author` is included because an office mention is one specific person's ask (the portal's document template omits it; the office one does not). */
export function officeWakeMessage(docTitle: string, author: string, commentText: string): string {
  return [
    `${author} asked you in a comment on the office document "${docTitle}":`,
    ...commentText.split("\n").map((line) => `> ${line}`),
    "You have been given edit access to this document; answer with the office_* tools.",
  ].join("\n");
}

/** The mention grammar:
 *  - literal "@agent" token -> the doc's OWNER folder (meta.owner), or for a scanned doc the agent or project whose
 *    folder it is in; a doc that is neither's: logged + skipped.
 *  - "@project:<name>" and any other bare "@<name>" -> case-insensitive EXACT display-name match among folders of kind "project"|"agent". Both forms search both kinds; names are non-whitespace runs, so folder names containing spaces cannot be mentioned in v1 (documented limitation).
 *  Unresolvable names and DUPLICATE names (two folders sharing a display name, e.g. agent "Twin" and project "Twin") get no wake and a log line -- no silent disambiguation. */
const MENTION_RE = /(?<![\w.])(?:@(project:(\S+)|agent(?![\w-])|([A-Za-z0-9_][\w-]*)))/g;

type Mention = { owner: boolean; name: string | null };

function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    if (m[1] === "agent") out.push({ owner: true, name: null });
    else if (m[2] !== undefined) out.push({ owner: false, name: m[2].replace(/[.,;:!?)\]}"']+$/, "") }); // trailing sentence punctuation is not part of the folder name
    else out.push({ owner: false, name: m[3] });
  }
  return out;
}

function statePath(rootDir: string, docId: string): string {
  return path.join(rootDir, "state", `${docId}.json`);
}

/** The comments last seen, by their keys (ooxml.commentKeys). Missing file -> null (first save). A file of the version
 * before, which kept the Document Server's ids (renumbered at every save, so they name nothing), is a first save of
 * which nothing may wake: `stale`. Undecodable or bad shape -> empty set with a log line (module header). */
function readSeen(rootDir: string, docId: string): { keys: Set<string>; stale?: boolean } | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(statePath(rootDir, docId), "utf8"));
    if (typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>).keys)) {
      return { keys: new Set((raw as { keys: unknown[] }).keys.filter((x): x is string => typeof x === "string")) };
    }
    if (typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>).ids)) return { keys: new Set(), stale: true };
    throw new Error("bad shape");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    logLine(`office ping: state file ${statePath(rootDir, docId)} is corrupt -- treating the last-seen set as empty`);
    return { keys: new Set() };
  }
}

function writeSeen(rootDir: string, docId: string, ids: Iterable<string>): void {
  const p = statePath(rootDir, docId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ keys: [...new Set(ids)] }, null, 2));
  fs.renameSync(tmp, p);
}

/** The store's index writer (its ONE path for index.json -- fresh read, dedupe by (chatId, commentId), atomic
 * temp+rename): the grant must be persisted BEFORE the bell rings (the woken pi's office_* tools read
 * docsForHome, which reads index.json). This wrapper keeps this module's log lines: a vanished doc is logged,
 * a duplicate adds nothing; "added"/"duplicate" are both fine to ring the bell for. */
function addGrant(rootDir: string, docId: string, folder: string, commentId: string, at: number): void {
  const outcome = storeAddGrant(docId, folder, commentId, at, rootDir);
  if (outcome === null) logLine(`office ping: document ${docId} vanished from index between resolve and grant -- skipped`);
}

/** The agent's or project's folder that `file` (a scanned document) is in: the deepest one that holds it. */
function homeOf(file: string): string | null {
  let best: string | null = null;
  for (const f of folders()) {
    if (f.kind !== "agent" && f.kind !== "project") continue;
    const at = canonical(f.path);
    if (within(at, file) && (!best || at.length > best.length)) best = at;
  }
  return best;
}

/** Resolve one mention to the folder of the agent or project it names, or null (reason logged). `@agent` names the
 * document's owner, or for a scanned document the agent or project whose folder it is in. */
function resolveMention(mention: Mention, meta: { owner: string | null; path?: string }): string | null {
  if (mention.owner) {
    const home = meta.owner ?? (meta.path ? homeOf(meta.path) : null);
    if (!home) logLine("office ping: @agent in a comment on a document no agent or project owns -- no wake");
    return home;
  }
  const name = mention.name;
  if (!name) return null;
  const matches = folders().filter((f) => (f.kind === "project" || f.kind === "agent") && f.name.toLowerCase() === name!.toLowerCase());
  if (matches.length === 0) {
    logLine(`office ping: @${name} in a comment matches no agent or project -- no wake`);
    return null;
  }
  if (matches.length > 1) {
    logLine(`office ping: @${name} is ambiguous (${matches.map((f) => `${f.kind}:${f.name}`).join(", ")}) -- no silent disambiguation, no wake`);
    return null;
  }
  return canonical(matches[0]!.path);
}

/** The chat a folder's wake goes to, found when it is woken: the sessions working in the folder (chats.inFolder) all
 * stand for it, the lowest id is asked. Null where none works there. */
function wakeChat(folder: string): string | null {
  const known = folders().find((f) => canonical(f.path) === folder);
  const chats = inFolder(known?.path ?? folder).sort((a, b) => a.id.localeCompare(b.id));
  return chats[0]?.id ?? null;
}

function processComment(docId: string, meta: { title: string; owner: string | null; path?: string }, c: Comment, key: string): void {
  const mentions = parseMentions(c.text);
  if (mentions.length === 0) return;
  const at = Date.now();
  // Dedupe per comment AND per pass: one audit/grant/queue/tell per target folder, however often it is mentioned.
  for (const folder of new Set(mentions.map((m) => resolveMention(m, meta)).filter((x): x is string => x !== null))) {
    addGrant(root(), docId, folder, key, at);
    const chatId = wakeChat(folder);
    if (!chatId) {
      record({ subject: meta.title, reason: `comment mention ${key} by ${c.author}: access to this document granted to ${folder}, which has no chat to wake`, chatId: "" });
      continue;
    }
    record({ subject: meta.title, reason: `comment mention ${key} by ${c.author}: access to this document granted and home woken`, chatId });
    const queue = wakes.get(chatId) ?? [];
    if (!queue.some((e) => e.details.docId === docId && e.details.commentId === key)) {
      queue.push({ text: officeWakeMessage(meta.title, c.author, c.text), details: { docId, commentId: key } });
      wakes.set(chatId, queue);
    }
    const told = (cfg.tell ?? ((id: string, data: unknown) => portal().chats.tell(id, data)))(chatId, { type: "ping" });
    if (told && typeof (told as Promise<boolean>).catch === "function") {
      (told as Promise<boolean>).catch((e: unknown) => logLine(`office ping: tell ${chatId} failed: ${(e as Error)?.message ?? e}`));
    }
  }
}

/** The registered onPersisted handler. Exported so unit tests call it directly without the real callback machinery. */
export function handlePersisted(docId: string, buffer: Buffer): void {
  try {
    const rootDir = cfg.root ?? portal().dataDir();
    const meta = getDoc(docId, rootDir);
    if (!meta) return; // deleted between fetch and persist -- nothing to diff
    if (meta.ext !== "docx") return; // v1: docx only, xlsx comments are not read yet
    const { comments } = parseDocx(buffer);
    const keys = commentKeys(comments);
    const prev = readSeen(rootDir, docId);
    // What is seen before this save: the comments seen at the save before; for a document scanned (or imported) with
    // comments of its own, at its first save, those it had when it was indexed (`importedKeys`) -- a comment not among
    // them appeared since (a mention added before the first save) and is new. Where that is not known (a source that
    // did not parse, an index or a state file of the version before, which kept ids), everything this save holds is
    // taken as seen: a pre-existing mention never wakes anybody.
    let seen: Set<string>;
    if (prev && !prev.stale) seen = new Set(prev.keys);
    else if (prev === null && !meta.imported) seen = new Set(); // a created doc's first save: every mention is new
    else if (prev === null && meta.importedKeys !== undefined) seen = new Set(meta.importedKeys);
    else seen = new Set(keys);
    // Write the seen set AFTER processing and only with keys handled successfully: a comment whose wake failed
    // stays unseen and is reported again at the next persist (retry).
    comments.forEach((c, i) => {
      const key = keys[i]!;
      if (seen.has(key)) return;
      try {
        processComment(docId, meta, c, key);
        seen.add(key);
      } catch (err) {
        logLine("office ping: comment " + key + " of " + docId + " could not be processed and stays unseen for retry: " + ((err as Error)?.message ?? err));
      }
    });
    writeSeen(rootDir, docId, [...seen]);
  } catch (err) {
    logLine(`office ping: persist of ${docId} failed: ${(err as Error)?.message ?? err}`);
  }
}
