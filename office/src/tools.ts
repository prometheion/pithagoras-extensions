/**
 * The agent's office tools: list, create, read, edit and list the comments of the documents the agent's or project's
 * folder sees (store.visibleTo: what it made or was granted, the scanned documents in its own folder, and the person's
 * library documents), in the style of the portal's document tools -- named by id, coded error prefixes
 * ("error:<code> <message>").
 *
 * Ownership scope: `registerTools` walks every chat through portal.chats.extend; for a chat it resolves the
 * workspace folder (chats.folder(chat.id)), finds it in folders.list() by path and REGISTERS ONLY when its kind is
 * "agent" or "project". That folder is the home: a document is owned by and granted to a folder, not a chat, as an
 * agent's chats come and go. Docs outside the scope are invisible to every tool: office_read asks for them and hears
 * the same "no document with that id" as for a nonexistent one, and no editor is opened for them.
 *
 * Reading and editing go through the agent's own editor in the document (seat.ts): an OnlyOffice editor of the
 * agent's home, beside the people in it, so office_read gives the text as it stands in the editor, what people typed
 * and did not save among it, and office_edit's ops show in their editors at once. After an edit the Document Server
 * is asked to save the session (editing.saveNow), and the save goes through the callback's revision gate as any save
 * of the editor. Where the person stopped Office, office_read reads the saved file and office_edit is refused: there
 * is one way to write.
 *
 * A scanned document is opened for the agent only where the agent could read its file itself (portal.files.open, as
 * the chat's agent: with the sandbox on, a file the agent could not read is refused, and a link is not followed), and
 * in edit mode only where it could change it (portal.files.identity); otherwise its editor opens in view mode and
 * office_edit is refused (`read_only`).
 *
 * Wakes (the drain side): ping.ts only QUEUES wakes server-side and rings the bell with chats.tell(chatId,
 * {type:"ping"}). The office pi extension registered from THIS factory listens on the UI_RECEIVE bus event
 * ("pithagoras:v1:ui:receive", the portal's UI event for a chat's extension) and drains the queue per entry via
 * pi.sendMessage({customType:"office-comment-ping", ...}, {deliverAs:"followUp", triggerTurn:true}).
 *
 * Injection seams (unit tests must never reach portal()): registerTools(opts) takes the portal bits -- chats.extend
 * registrar, chat->folder lookup, folders list, the file reader, store root, audit record fn, log fn, the seats, the
 * save after an edit and whether Office runs. EVERY one defaults LAZY: the real portal() is read only when a default
 * is used (in production). office_create and office_edit call record({subject, reason, chatId}) after the write.
 */
import fs from "node:fs";
import path from "node:path";
import { portal } from "./host";
import { canonical, createDoc, docsForHome, MAX_IMPORT_BYTES, readDoc, refresh, refreshAll, tooLarge, type DocMeta } from "./store";
import { parseDocx, parseXlsx } from "./ooxml";
import { agentsOf, usersOf, isLocked } from "./live";
import { saveNow, type SaveAfterEdit } from "./editing";
import { editJob, OpError, type EditJob } from "./ops";
import * as seat from "./seat";
import { drainWakeQueue } from "./ping";

/** The UI_RECEIVE bus event chats.tell rings (the portal's own document tools listen on the same name). */
const UI_RECEIVE = "pithagoras:v1:ui:receive";

/** Marks a text to be translated where it is shown: a label kept in a table (de.ts has its German). */
const msg = <T extends string>(text: T): T => text;

/** What a call of each tool is labelled with in pi, and on its card in the chat while it runs, in English. */
export const LABELS: Record<string, string> = {
  office_list: msg("Listing office documents"),
  office_create: msg("Creating an office document"),
  office_read: msg("Reading an office document"),
  office_edit: msg("Editing an office document"),
  office_comments: msg("Reading the comments of a document"),
};

/**
 * What the guard holds each tool to. What they return is outside content: the text and comments of files found in
 * the agents' folders, written by anybody, and their titles (file names). None of them is the shape of one of the
 * guard's rules after a suspected prompt injection (`acts`): office_create makes a blank document in the extension's
 * own library, and office_edit changes text in a document of the agent's own scope through its editor, which runs
 * nothing, carries nothing out and lands nowhere a later run reads as instructions.
 */
export const GUARDS: Record<string, { outside: boolean; acts: string[] }> = {
  office_list: { outside: true, acts: [] },
  office_create: { outside: true, acts: [] },
  office_read: { outside: true, acts: [] },
  office_edit: { outside: true, acts: [] },
  office_comments: { outside: true, acts: [] },
};

/** An audit line recorded after every mutating op. `subject` is the doc title, `chatId` the acting home chat. */
export type OfficeAuditEntry = { subject: string; reason: string; chatId: string };

/** The folders list entries the factory resolves against (the shape of portal.folders.list() minus nothing it needs). */
export type ToolsFolderInfo = { path: string; name: string; kind: "agent" | "project" | "chat"; home?: boolean };

/** Whether Office runs: its Document Server set up and settled, setting itself up, or stopped by the person (or never
 * started). */
export type OfficeState = "running" | "starting" | "stopped";

/** The seats as the tools use them (seat.ts by default). */
export type ToolsSeat = {
  run(home: string, docId: string, mode: seat.SeatMode, job: seat.SeatJob, options?: { signal?: AbortSignal }): Promise<unknown>;
  keyOf(home: string, docId: string): string | undefined;
  closeDoc(docId: string, why?: string): void;
};

/** Injection seams for registerTools. Every field is optional and LAZY -- defaults read portal() only when actually used, so unit tests pass plain values and never reach the real portal. */
export type ToolsDeps = {
  /** The chats.extend registrar. Default: (factory) => portal().chats.extend(factory). */
  extend?: (factory: (pi: unknown, chat: { id: string }) => void) => void;
  /** A chat's workspace folder path (throws when the chat or its folder is gone). Default: (id) => portal().chats.folder(id). */
  chatFolder?: (chatId: string) => string;
  /** The folders the agents work in. Default: () => portal().folders.list(). */
  folders?: () => ToolsFolderInfo[];
  /** A scanned document's file, opened for `chatId`'s agent as it could open it itself (`file` is the document's own
   * path): its descriptor, which the caller closes, and its size. Default: portal().files.open with likeParent, the
   * chat, and no link followed. */
  openFile?: (file: string, chatId: string) => { fd: number; size: number };
  /** Throws where `chatId`'s agent could not change the scanned document `file` itself: its folder is not one the agent
   * may write in, as the kernel would tell it. Default: portal().files.identity of the folder with likeParent and the
   * chat, which asks for that. */
  mayWrite?: (file: string, chatId: string) => void;
  /** Store/state root override. Default: lazy portal().dataDir(). */
  root?: string;
  /** The agents' editors (seat.ts). */
  seat?: ToolsSeat;
  /** The save after an edit (editing.saveNow). */
  save?: (key: string) => Promise<SaveAfterEdit>;
  /** Whether Office runs (server.ts gives it from container.ts). Default: "running". */
  officeState?: () => Promise<OfficeState> | OfficeState;
  /** The audit sink for mutating ops. Default: a one-line log via the log seam (ping.ts pattern). */
  record?: (entry: OfficeAuditEntry) => void;
  /** Log line. Default: lazy portal().log. */
  log?: (line: string) => void;
};

let cfg: ToolsDeps = {};

/** Test seam: drop the module-level seams (the tests' injections are back to the lazy portal defaults). */
export function __resetToolsForTests(): void {
  cfg = {};
}

/* ------------------------------------------------------------------ */
/* lazy defaults (portal() only when actually used)                     */
/* ------------------------------------------------------------------ */

function rootDir(): string {
  return cfg.root ?? portal().dataDir();
}
function chatFolder(chatId: string): string {
  return (cfg.chatFolder ?? ((id: string) => portal().chats.folder(id)))(chatId);
}
function folders(): ToolsFolderInfo[] {
  return (cfg.folders ?? (() => portal().folders.list()))();
}
function seats(): ToolsSeat {
  return cfg.seat ?? seat;
}
/** The file of a scanned document opened as the agent of `chatId` would open it: refused where that agent could not
 * read it, and never through a link. */
function openAsAgent(file: string, chatId: string): { fd: number; size: number } {
  return (cfg.openFile ?? ((f: string, c: string) => portal().files.open(path.dirname(f), path.basename(f), { likeParent: true, chats: [c], direct: true })))(file, chatId);
}
/** A file read through the portal as the agent of `chatId` reads: refused where that agent could not read it, and
 * never through a link. Whole, from the descriptor the portal opened (not files.readBytes, whose cap is 1 MB: a .docx
 * is often more), up to the library's own cap (store.MAX_IMPORT_BYTES): a file that grew past it since it was indexed
 * is refused before a byte is read. */
function readAsAgent(file: string, chatId: string): Buffer {
  const opened = openAsAgent(file, chatId);
  try {
    if (opened.size > MAX_IMPORT_BYTES) throw tooLarge(file, opened.size);
    const out = Buffer.alloc(opened.size);
    let read = 0;
    while (read < out.length) {
      const n = fs.readSync(opened.fd, out, read, out.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return out.subarray(0, read);
  } finally {
    fs.closeSync(opened.fd);
  }
}
/** Whether the agent of `chatId` could change the scanned document `file` itself: the portal (and the Document
 * Server's save) writes it with its own rights, which may be root's. */
function mayWrite(file: string, chatId: string): boolean {
  try {
    (cfg.mayWrite ?? ((f: string, c: string) => void portal().files.identity(path.dirname(f), ".", { likeParent: true, chats: [c] })))(file, chatId);
    return true;
  } catch {
    return false;
  }
}
function logLine(line: string): void {
  (cfg.log ?? ((l: string) => portal().log(l)))(line);
}
function record(entry: OfficeAuditEntry): void {
  // Lazy default is a one-line log (a real audit sink can be passed via registerTools({record})).
  (cfg.record ?? ((e: OfficeAuditEntry) => logLine(`office audit: ${e.subject}: ${e.reason} (chat ${e.chatId})`)))(entry);
}
async function officeState(): Promise<OfficeState> {
  return (await cfg.officeState?.()) ?? "running";
}

/** docId -> the end of the last job queued on it. */
const queued = new Map<string, Promise<unknown>>();

/** Runs the jobs of one document one at a time, in the order they came: an edit and its save, and a read, are never
 * interleaved with another call's on the same document. */
function oneAtATime<T>(docId: string, work: () => Promise<T>): Promise<T> {
  const run = (queued.get(docId) ?? Promise.resolve()).then(work);
  const end = run.catch(() => {});
  queued.set(docId, end);
  void end.then(() => {
    if (queued.get(docId) === end) queued.delete(docId);
  });
  return run;
}

/* ------------------------------------------------------------------ */
/* registration                                                         */
/* ------------------------------------------------------------------ */

/**
 * server.ts calls ONCE at boot. Later calls (unit tests) update the seams and register again through
 * whatever registrar is configured -- production registers exactly once, tests each get their own fake
 * `extend`, so no once-guard here (unlike wirePing's onPersisted hook, which truly can only attach once).
 */
export function registerTools(opts?: ToolsDeps): void {
  if (opts) cfg = { ...cfg, ...opts };
  const registrar = cfg.extend ?? ((factory: (pi: unknown, chat: { id: string }) => void) => portal().chats.extend(factory));
  registrar((pi, chat) => installForChat(pi, chat));
}

/** The chats.extend factory body: resolve the chat's folder via chats.folder -> folders.list() by path -> kind; RETURN UNLESS "agent" or "project"; then register the tools on that chat's pi, for that folder. */
function installForChat(pi: unknown, chat: { id: string }): void {
  let folderPath: string;
  try {
    folderPath = chatFolder(chat.id);
  } catch (e) {
    logLine(`office tools: no workspace folder for chat ${chat.id} (${(e as Error)?.message ?? e}) -- no office_* tools`);
    return; // gone chat or folder: nothing to register into
  }
  const folder = folders().find((f) => f.path === folderPath);
  if (!folder || (folder.kind !== "agent" && folder.kind !== "project")) return; // not an agent/project home: no tools
  installTools(pi, canonical(folder.path), chat.id);
  hearOfficePings(pi, chat.id); // the same factory owns the drain side of the wake queue
}

/* ------------------------------------------------------------------ */
/* refusals + tool plumbing                                           */
/* ------------------------------------------------------------------ */

/** A refusal the agent reads: it starts with its code, "error:<code> <message>". */
class Refusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(`error:${code} ${message}`);
  }
}

/** What each refusal of the agent's editor says to do, after its own message. */
const SEAT_ADVICE: Record<string, string> = {
  office_stopped: "The person stopped Office: ask them to start it on the Office page. office_read still reads the saved file.",
  agent_editor_missing: "Ask the person to download it on the Office page.",
  agent_unavailable: "Try again in a moment; if it keeps failing, ask the person to look at Office on the Office page.",
  editor_not_ready: "Try again in a moment.",
  busy: "",
  behind: "Read it again with office_read before you edit.",
  timeout: "",
  editor_closed: "",
  too_large: "Read a spreadsheet one sheet at a time (sheet).",
  editor_not_saved: "Do not make it again: read the document if you need to see it.",
};

/** What a tool may throw out to the agent: refusals as-is, the seat's and the ops' coded errors by their code, coded
 * store/ooxml errors by their code (zip/part damage -> `corrupt`), anything else logged and generic. */
function failed(e: unknown): unknown {
  if (e instanceof Refusal) return e;
  if (e instanceof OpError) return new Refusal(e.code, e.message);
  if (e instanceof seat.SeatError) {
    const advice = SEAT_ADVICE[e.code];
    const quote = e.code === "quote_not_found" || e.code === "quote_ambiguous" ? " Nothing was changed: read the document again with office_read and quote it as it stands." : "";
    return new Refusal(e.code, `${e.message}.${quote}${advice ? ` ${advice}` : ""}`.replace(/\.\./g, "."));
  }
  const err = e as (Error & { code?: string }) | null;
  if (err && typeof err.message === "string" && typeof err.code === "string") {
    const code = err.code === "invalid_zip" || err.code === "missing_part" ? "corrupt" : err.code;
    const advice = SEAT_ADVICE[code];
    return new Refusal(code, advice ? `${err.message}. ${advice}` : err.message);
  }
  logLine(`an office tool failed: ${err?.stack ?? e}`);
  return new Refusal("failed", String(e));
}

/** `text` with a details side-channel (the same shape as the portal's document tools). */
const text = (content: string, details?: unknown) => ({ content: [{ type: "text", text: content }], ...(details !== undefined ? { details } : {}) });

/** One office_* tool result must not blow the agent context on a huge grid or document; both office_read and
 * office_read's sibling office_comments truncate at this length with an explicit marker. */
const MAX_READ_CHARS = 200_000;

/** A doc's saved bytes, for the agent of `chatId`: a scanned doc's own file as that agent could read it
 * (portal.files), a library doc's from the extension's own folder, which no agent can write; a not_found refusal
 * where it is gone. */
function readBytes(doc: DocMeta, chatId: string): Buffer {
  try {
    return doc.path ? readAsAgent(doc.path, chatId) : readDoc(doc, rootDir());
  } catch (e) {
    throw unreadable(doc, e);
  }
}

/** The refusal for a file the agent cannot read (or that is gone), or the error itself for anything else. */
function unreadable(doc: DocMeta, e: unknown): unknown {
  const err = e as NodeJS.ErrnoException & { code?: string };
  if (err.code === "ENOENT" || err.code === "missing" || err.code === "not_found") return new Refusal("not_found", `the file of "${doc.title}" is missing from disk`);
  if (err.code === "invalid") return new Refusal("not_found", `"${doc.title}" is not a file your agent can read (${err.message})`);
  if (typeof err.code === "string" && err.code !== "too_large") return new Refusal("not_found", `"${doc.title}" is not a file your agent can read (${err.message})`);
  return e;
}

/** A scanned document's file opened as the agent would and closed again: where it could not read it, the Document
 * Server (which reads as the portal) is never handed it. */
function assertMayRead(doc: DocMeta, chatId: string): void {
  if (!doc.path) return;
  let opened: { fd: number; size: number };
  try {
    opened = openAsAgent(doc.path, chatId);
  } catch (e) {
    throw unreadable(doc, e);
  }
  fs.closeSync(opened.fd);
  if (opened.size > MAX_IMPORT_BYTES) throw tooLarge(doc.path, opened.size);
}

/** "N people" for a count. */
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** Word blocks as the agent reads them: `[n] text`, a style in brackets, a table as its rows. */
type WordBlocks = { blocks: ({ p: string; style?: string } | { table: string[][] })[]; truncated?: boolean };
function wordText(read: WordBlocks): string {
  if (!read.blocks.length) return "(empty document)";
  return (
    read.blocks
      .map((b, i) => ("table" in b ? `[${i + 1}] table\n${b.table.map((row) => `| ${row.join(" | ")} |`).join("\n")}` : `[${i + 1}]${b.style ? ` (${b.style})` : ""} ${b.p}`))
      .join("\n") + (read.truncated ? "\n\n(the document goes on: only its first 200,000 characters were read)" : "")
  );
}

/** A spreadsheet's cells as the agent reads them: `A1: value`, a text in quotes, a formula after its value. */
type CellSheets = { sheets: { name: string; range: string; cells: { a: string; v: unknown; f?: string }[]; truncated: boolean; skipped?: boolean }[] };
function cellText(read: CellSheets): string {
  const value = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));
  return read.sheets
    .map((s) => {
      const cells = s.cells.map((c) => `${c.a}: ${value(c.v)}${c.f ? ` (${c.f})` : ""}`).join("\n");
      if (s.skipped) return `Sheet "${s.name}": not read (the sheets before it filled the read; read it with sheet)`;
      return `Sheet "${s.name}" (${s.range}):\n${cells || "(empty)"}${s.truncated ? "\n(not all of its cells are shown: a read gives 20,000 cells of a sheet and 200,000 characters at most)" : ""}`;
    })
    .join("\n\n");
}

/** Why office_read reads the saved file: Office does not run, or the agent's editor is not downloaded. */
const SAVED_BECAUSE = {
  starting: "Office is still starting",
  stopped: "Office is stopped",
  missing: "your editor is not downloaded: the person downloads it on the Office page",
};

/** What office_read says first: the document, and where the text comes from (`saved`: why it is the saved file). */
function readHeader(doc: DocMeta, saved?: keyof typeof SAVED_BECAUSE): string {
  const head = `"${doc.title}" (id ${doc.docId}, ${doc.ext}, revision ${doc.mtimeMs})`;
  if (saved) return `${head}\nSaved copy (${SAVED_BECAUSE[saved]}): what the file holds. What is typed in an open editor is not in it, and office_edit waits until ${saved === "missing" ? "it is there" : "Office runs"}.`;
  const n = usersOf(doc.docId).length;
  return `${head}\nLive: the document as it stands in the editor${n ? `, including what ${people(n)} in it typed and have not saved yet` : ""}.`;
}

/** A saved file read as office_read shows it when Office does not run (a spreadsheet's `sheet` alone, where named). */
function savedText(doc: DocMeta, chatId: string, sheet?: string): string {
  const buf = readBytes(doc, chatId);
  if (doc.ext === "xlsx") {
    const parsed = parseXlsx(buf); // throws {code:"invalid_zip"} -> corrupt
    if (sheet !== undefined && !parsed.sheetNames.includes(sheet)) throw new Refusal("not_found", `there is no sheet named ${JSON.stringify(sheet)} (the sheets: ${parsed.sheetNames.join(", ")})`);
    const col = (n: number) => {
      let s = "";
      for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
      return s;
    };
    return parsed.sheetNames
      .filter((name) => sheet === undefined || name === sheet)
      .map((name) => {
        const cells = (parsed.sheets[name] ?? []).flatMap((row, r) => row.map((v, c) => (v === "" ? "" : `${col(c)}${r + 1}: ${v}`)).filter(Boolean));
        return `Sheet "${name}":\n${cells.join("\n") || "(empty)"}${parsed.truncatedSheets[name] ? "\n(cells far out were not read)" : ""}`;
      })
      .join("\n\n");
  }
  const parsed = parseDocx(buf); // throws {code:"invalid_zip"|"missing_part"} -> corrupt
  return parsed.paragraphs.length ? parsed.paragraphs.map((p, i) => `[${i + 1}] ${p}`).join("\n") : "(empty document)";
}

/* ------------------------------------------------------------------ */
/* per-chat tools                                                       */
/* ------------------------------------------------------------------ */

function installTools(pi: unknown, home: string, chatId: string): void {
  const p = pi as any; // portal's extend factory hands a pi that carries registerTool (host mode) or not.

  /** A doc in THIS home's scope by id (store.visibleTo); anything else is `not_found` with the SAME words as a nonexistent id, so another home's docs do not leak into view. */
  function visibleDoc(id: unknown): DocMeta {
    if (typeof id !== "string" || !id) throw new Refusal("not_found", "There is no document with that id. Ids come from office_list and office_create");
    const doc = docsForHome(home, rootDir()).find((d) => d.docId === id);
    if (!doc) throw new Refusal("not_found", "There is no document with that id. Ids come from office_list and office_create (a document of another agent/project is invisible to you until it mentions you in a comment)");
    // As its file is now: one written outside the extension (a script, a git pull) is at its new revision already.
    return refresh(doc.docId, rootDir()) ?? doc;
  }

  const guarded = (work: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> | unknown) => async (_callId: unknown, params: Record<string, unknown>, signal?: AbortSignal) => {
    try {
      return await work(params ?? {}, signal instanceof AbortSignal ? signal : undefined);
    } catch (e) {
      throw failed(e);
    }
  };

  p.registerTool({
    name: "office_list",
    label: LABELS.office_list,
    guard: GUARDS.office_list,
    description: "List the office documents of your library: every Word (.docx) and spreadsheet (.xlsx) document in your folder, the ones you made or were granted (by being mentioned in one of its comments), and the ones the person made in the library. Each line has the id, title, format, owner, how many grants it holds, its revision, how many people are editing it right now, and which agents have it open.",
    promptSnippet: "List the office documents you own or were granted",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: guarded(() => {
      refreshAll(rootDir());
      const docs = docsForHome(home, rootDir());
      if (!docs.length) return text("No documents in your office library yet. Make one with office_create.", { action: "list", home, documents: [] });
      const lines = docs.map((doc) => {
        const users = usersOf(doc.docId);
        const agents = agentsOf(doc.docId);
        return `- ${doc.docId}  "${doc.title}"  ${doc.ext}  owner ${doc.owner === home ? "you" : doc.owner ?? "(nobody)"}  ${doc.grants.length} grant${doc.grants.length === 1 ? "" : "s"}  revision ${doc.mtimeMs}${users.length ? `  ${users.length} editing now` : ""}${agents.length ? `  agents in it: ${agents.map((a) => a.name).join(", ")}` : ""}`;
      });
      return text(`${docs.length} document${docs.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, {
        action: "list",
        home,
        documents: docs.map((doc) => ({ id: doc.docId, title: doc.title, ext: doc.ext, owner: doc.owner, grants: doc.grants.length, sizeBytes: doc.sizeBytes, mtimeMs: doc.mtimeMs, locked: isLocked(doc.docId) || usersOf(doc.docId).length > 0, agents: agentsOf(doc.docId).map((a) => a.name) })),
      });
    }),
  });

  p.registerTool({
    name: "office_create",
    label: LABELS.office_create,
    guard: GUARDS.office_create,
    description: "Make a new blank office document in the shared library: type \"word\" (a .docx) or \"cell\" (an .xlsx spreadsheet), both starting empty; fill it with office_edit, or the person opens it in the editor. It is owned by you, so every chat of your home sees it; other agents get access only when it mentions them in a comment. A title+type pair already taken is refused.",
    promptSnippet: "Create a blank Word or spreadsheet document",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The document's title (not empty)." },
        type: { type: "string", enum: ["word", "cell"], description: "\"word\" makes a .docx, \"cell\" an .xlsx spreadsheet." },
      },
      required: ["title", "type"],
    },
    execute: guarded(async ({ title, type }) => {
      const t = typeof title === "string" ? title.trim() : "";
      if (!t) throw new Refusal("invalid", "A document needs a title");
      if (type !== "word" && type !== "cell") throw new Refusal("unsupported_format", `type is \"word\" or \"cell\" (got ${typeof type === "string" ? `"${type}"` : String(type)})`);
      const doc = await createDoc({ title: t, type, owner: home, createdBy: "agent" }, rootDir()); // throws {code:"exists"} on a duplicate title+type
      record({ subject: doc.title, reason: `office_create: new ${doc.ext} document ${doc.docId}, owner ${home}`, chatId });
      return text(`Created "${doc.title}" (id ${doc.docId}, ${doc.ext}, revision ${doc.mtimeMs}). Fill it with office_edit.`, { action: "create", id: doc.docId, title: doc.title, ext: doc.ext, mtimeMs: doc.mtimeMs, owner: doc.owner });
    }),
  });

  p.registerTool({
    name: "office_read",
    label: LABELS.office_read,
    guard: GUARDS.office_read,
    description: "Read a document of your library by its id, as it stands in the editor right now, with what people typed and have not saved yet. A Word document comes as numbered blocks, \"[3] text\", a paragraph's style in brackets (\"[2] (Heading 1) Findings\"), a table as \"[4] table\" and its rows \"| a | b |\". A spreadsheet comes per sheet as its cells, \"A1: 2\", a text in quotes, a formula after the value (\"A3: 6 (=A1*A2)\"); `sheet` reads one sheet only. Quote text for office_edit exactly as it is shown here. Comments: office_comments. When the person stopped Office it reads the saved file and says so.",
    promptSnippet: "Read an office document as it stands in the editor",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from office_list or office_create." },
        sheet: { type: "string", description: "A spreadsheet's sheet to read, by its name (all sheets where none is given)." },
      },
      required: ["id"],
    },
    execute: guarded(async ({ id, sheet }, signal) => {
      const doc = visibleDoc(id);
      if (sheet !== undefined && (typeof sheet !== "string" || doc.ext !== "xlsx")) throw new Refusal("bad_op", doc.ext === "xlsx" ? "sheet is a sheet's name" : "sheet is for spreadsheets; a Word document has none");
      assertMayRead(doc, chatId);
      const state = await officeState();
      let said = "";
      let live = false;
      if (state === "running") {
        const mode = doc.path && !mayWrite(doc.path, chatId) ? "view" : "edit";
        const job = doc.ext === "docx" ? { kind: "word.read", args: {} } : { kind: "cell.read", args: sheet ? { sheet } : {} };
        try {
          const read = await oneAtATime(doc.docId, () => seats().run(home, doc.docId, mode, job, { signal }));
          said = `${readHeader(doc)}\n\n${doc.ext === "docx" ? wordText(read as WordBlocks) : cellText(read as CellSheets)}`;
          live = true;
        } catch (e) {
          // Without its editor the agent still reads the file; an edit waits for the download. Office found stopped
          // as the editor starts (its network gone): the saved file too, as when it is stopped.
          const code = (e as { code?: string } | null)?.code;
          if (code !== "agent_editor_missing" && code !== "office_stopped") throw e;
          said = `${readHeader(doc, code === "office_stopped" ? "stopped" : "missing")}\n\n${savedText(doc, chatId, sheet as string | undefined)}`;
        }
      } else said = `${readHeader(doc, state)}\n\n${savedText(doc, chatId, sheet as string | undefined)}`;
      if (said.length > MAX_READ_CHARS) said = said.slice(0, MAX_READ_CHARS) + "\n\n[output truncated by office_read: it exceeds 200,000 characters]";
      return text(said, { action: "read", id: doc.docId, ext: doc.ext, mtimeMs: doc.mtimeMs, live });
    }),
  });

  p.registerTool({
    name: "office_edit",
    label: LABELS.office_edit,
    guard: GUARDS.office_edit,
    description: `Edit a document of your library through your own editor in it: people who have it open see your change at once, and nothing they typed is lost. One call is one edit, made whole or not at all; every quote is checked first against the document as it stands then. Word ops: {quote, replacement} replaces text (the quote exactly once in the document, inside one paragraph, as office_read shows it; an empty replacement removes it); {after?, paragraphs, style?} adds paragraphs after the paragraph that holds \`after\`, or at the end (style: "Normal", "Heading 1", "Heading 2", "Heading 3", "Title" or "List Paragraph"); {after?, table} adds a table, its first row the header; {remove} removes the paragraph that holds the quote. Spreadsheet ops: {sheet?, range, values}: values for exactly the range, one list per row ("B2:C3" takes [[1, 2], [3, 4]]), on the first sheet where none is named; a text starting with "=" is a formula, "" clears the cell. After the edit the document is saved, with what people typed until then, and you hear the new revision. A quote that is not found or found twice changes nothing (error:quote_not_found, error:quote_ambiguous): read again and quote more.`,
    promptSnippet: "Edit a Word or spreadsheet document live, through your own editor",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from office_list or office_create." },
        ops: {
          type: "array",
          minItems: 1,
          description: "The edits, made in order: Word {quote, replacement} | {after?, paragraphs, style?} | {after?, table} | {remove}; spreadsheet {sheet?, range, values}.",
          items: {
            type: "object",
            properties: {
              quote: { type: "string", description: "Word: text to replace, exactly as office_read shows it." },
              replacement: { type: "string", description: "Word: what takes the quote's place; empty removes it." },
              after: { type: "string", description: "Word: text of the paragraph the new paragraphs or table go after (they go at the end where none is given)." },
              paragraphs: { type: "array", items: { type: "string" }, description: "Word: new paragraphs, one text each." },
              style: { type: "string", enum: ["Normal", "Heading 1", "Heading 2", "Heading 3", "Title", "List Paragraph"], description: "Word: the new paragraphs' style." },
              table: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Word: a table's rows of cell texts, the first row the header." },
              remove: { type: "string", description: "Word: text of the paragraph to remove." },
              sheet: { type: "string", description: "Spreadsheet: the sheet's name (the first sheet where none is given)." },
              range: { type: "string", description: "Spreadsheet: the cells, A1 or A1:C3." },
              values: { type: "array", items: { type: "array", items: { type: ["string", "number", "boolean"] } }, description: "Spreadsheet: one list of values per row of the range." },
            },
          },
        },
      },
      required: ["id", "ops"],
    },
    execute: guarded(async ({ id, ops }, signal) => {
      const doc = visibleDoc(id);
      const job: EditJob = editJob(doc.ext, ops);
      assertMayRead(doc, chatId);
      // Written with the portal's rights (and the Document Server's save): only where the agent could have written it.
      if (doc.path && !mayWrite(doc.path, chatId)) throw new Refusal("read_only", `"${doc.title}" is not a file your agent may change: you can read it, not edit it`);
      const state = await officeState();
      if (state === "stopped") throw new Refusal("office_stopped", `Office is stopped, so "${doc.title}" cannot be edited: ask the person to start it on the Office page. office_read reads the saved file meanwhile.`);
      if (state === "starting") throw new Refusal("ds_starting", "Office is still starting (its Document Server sets itself up after its first start, about two minutes): try again in a moment.");

      return oneAtATime(doc.docId, async () => {
        // The revision as it is now: an edit queued behind another starts from that one's.
        const from = refresh(doc.docId, rootDir())?.mtimeMs ?? doc.mtimeMs;
        const n = job.args.ops.length;
        const kinds = [...new Set(job.args.ops.map((op) => ("quote" in op ? "replace" : "remove" in op ? "remove" : "table" in op ? "table" : "paragraphs" in op ? "insert" : "cells")))].join(", ");
        const what = `office_edit: ${n} op(s) (${kinds}) on ${doc.docId} by ${home}`;
        let made: unknown;
        try {
          made = await seats().run(home, doc.docId, "edit", job, { signal });
        } catch (e) {
          // The editor took the edit and then gave no clear answer: it may be in the document, and reach the file with
          // a later save. Recorded all the same, so that every change an agent may have made is in the audit log.
          if (e instanceof seat.SeatError && e.ran) record({ subject: doc.title, reason: `${what}; ${e.code === "editor_not_saved" ? "made in the editor, not saved yet" : "outcome unknown"} (${e.code})`, chatId });
          throw e;
        }
        const changed = (made as { changed?: unknown } | null)?.changed !== false;
        const watching = usersOf(doc.docId).length;
        const key = seats().keyOf(home, doc.docId);
        const outcome: SaveAfterEdit = key ? await (cfg.save ?? ((k: string) => saveNow(k)))(key) : "failed";
        const now = refresh(doc.docId, rootDir());
        const to = now?.mtimeMs ?? from;
        // Nothing to save after an edit that changed nothing (a cell given the value it holds): the file is as it was.
        const unchanged = outcome === "nothing" && !changed;
        record({ subject: doc.title, reason: `${what}; ${unchanged ? `no change, revision ${to}` : outcome === "saved" || outcome === "same" ? `saved as revision ${to}` : outcome === "copy" ? "the save was kept as a conflict copy" : `not saved yet (${outcome})`}`, chatId });
        if (unchanged) return text(`Edited "${doc.title}" (${n} op${n === 1 ? "" : "s"}): that changed nothing, so there was nothing to save; the document is at revision ${to}, as it was.`, { action: "edit", id: doc.docId, ops: n, from, to, live: watching, changed: false });
        if (outcome === "copy") {
          seats().closeDoc(doc.docId, "its save was kept as a conflict copy");
          throw new Refusal("behind", `"${doc.title}" changed on disk outside the editor while your editor had it open: your edit is in the editor, and its save was kept beside the document as "${doc.title} (conflict <date time>)" rather than written over the newer file. Read the document again with office_read and redo the edit.`);
        }
        if (outcome === "timeout" || outcome === "failed" || outcome === "nothing") {
          throw new Refusal("editor_not_saved", `your edit of "${doc.title}" (${n} op${n === 1 ? "" : "s"}) is made and live in the document, but the Document Server did not save it ${outcome === "timeout" ? "in time" : "now"}: it reaches the file with the editor's next save or when the document closes. Do not make it again.`);
        }
        const seen = watching ? ` ${people(watching)} in the document saw it live.` : "";
        return text(`Edited "${doc.title}" (${n} op${n === 1 ? "" : "s"}), saved as revision ${to}.${seen}`, { action: "edit", id: doc.docId, ops: n, from, to, live: watching });
      });
    }),
  });

  p.registerTool({
    name: "office_comments",
    label: LABELS.office_comments,
    guard: GUARDS.office_comments,
    description: "Read-only: the comments of a Word document (id, author, date, text) as its saved file holds them, plus its grants -- which other agent/project homes hold access to it by mention. Spreadsheets have no comment reading in v1.",
    promptSnippet: "List the comments and grants of an office document",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from office_list or office_create." },
      },
      required: ["id"],
    },
    execute: guarded(async ({ id }) => {
      const doc = visibleDoc(id);
      if (doc.ext === "xlsx") throw new Refusal("unsupported_format", `"${doc.title}" is an .xlsx spreadsheet: its comments live in a different part layout and are not read yet`);
      const parsed = parseDocx(readBytes(doc, chatId)); // corrupt mapping via failed()
      const commentLines = parsed.comments.length ? parsed.comments.map((c) => `- ${c.id}  ${c.author}${c.date ? `  ${c.date}` : ""}: ${c.text.replace(/\n/g, " ")}`).join("\n") : "(none)";
      const grantLines = doc.grants.length ? doc.grants.map((g) => `- ${g.folder}  via comment ${g.commentId}  at ${new Date(g.at).toISOString()}`).join("\n") : "(none)";
      let said = `"${doc.title}" (id ${doc.docId})\n\nComments (${parsed.comments.length}):\n${commentLines}\n\nGrants:\n${grantLines}`;
      // Same cap and marker as office_read: aggregated comment text is unbounded input and must not blow the agent context.
      if (said.length > MAX_READ_CHARS) said = said.slice(0, MAX_READ_CHARS) + "\n\n[output truncated by office_comments: it exceeds 200,000 characters]";
      // details lands in the portal tool-event store and the web transcript -- bound it like office_read does
      // (100 at 500 chars each, worst case ~50 KB); commentCount keeps the true total.
      const detailComments = parsed.comments.slice(0, 100).map((c) => ({ id: c.id, author: c.author, date: c.date, text: c.text.slice(0, 500) }));
      return text(said, { action: "comments", id: doc.docId, comments: detailComments, grants: doc.grants, commentCount: parsed.comments.length });
    }),
  });
}

/**
 * The drain side of the wake queue: on the UI_RECEIVE bell with data.type "ping"
 * -- which ping.ts rings per woken home via chats.tell(chatId, {type:"ping"}) -- take this chat's queued
 * wake entries off ping.ts' server-side queue and hand each to pi: shown to the person, delivered as a
 * follow-up that triggers a turn, carrying {docId, commentId} in details. A reloaded pi keeps the bus:
 * the handler of the one that went is removed on session shutdown.
 */
function hearOfficePings(pi: unknown, chatId: string): void {
  const p = pi as any;
  if (typeof p?.events?.on !== "function") return; // no event bus in this pi build: the tools still work, wakes just wait for a drain by another means
  const off = p.events.on(UI_RECEIVE, (message: { data?: unknown }) => {
    if ((message as { data?: { type?: string } })?.data?.type !== "ping") return; // ours is data.type "ping" (ping.ts sets it)
    for (const entry of drainWakeQueue(chatId)) {
      try {
        p.sendMessage({ customType: "office-comment-ping", content: entry.text, display: true, details: entry.details }, { deliverAs: "followUp", triggerTurn: true });
      } catch (e) {
        logLine(`could not deliver a queued office wake to chat ${chatId}: ${(e as Error)?.message ?? e}`);
      }
    }
  });
  p.on?.("session_shutdown", () => off?.());
}
