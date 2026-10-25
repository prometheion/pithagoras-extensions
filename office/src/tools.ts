/**
 * The agent's office tools: list, create, read, edit and list the comments of the documents
 * the agent's or project's folder sees (store.visibleTo: what it made or was granted, the scanned documents in its
 * own folder, and the person's library documents), in the style of the portal's document tools -- named by id,
 * base-revision writes, coded error prefixes ("error:<code> <message>").
 *
 * Ownership scope: `registerTools` walks every chat through portal.chats.extend; for a chat it resolves the
 * workspace folder (chats.folder(chat.id)), finds it in folders.list() by path and REGISTERS ONLY when its kind is
 * "agent" or "project". That folder is the home: a document is owned by and granted to a folder, not a chat, as an
 * agent's chats come and go. Docs outside the scope are invisible to every tool: office_read asks for them and hears
 * the same "no document with that id" as for a nonexistent one.
 *
 * Reading: a scanned document is read through the portal's own file functions (portal.files.open), as the chat's
 * agent would read it: with the sandbox on, a file the agent could not read itself is refused, and a name that a link
 * leads elsewhere is not followed.
 *
 * Revision model: the mtimeMs of the library file IS the revision. office_edit takes baseRevision (= the mtimeMs
 * office_read showed), GATES FIRST (>1 ms drift -> "error:revision_mismatch ..." with the fresh mtime, nothing
 * written), and store.persistBytes re-gates strictly at write time anyway (ZERO tolerance). While the document is open
 * in the editor, office_edit refuses (error:open_in_editor): the Document Server saves what was typed only as the
 * last editor closes, under the revision it opened, and an agent's edit landing first would turn that save stale.
 *
 * Wakes (the drain side): ping.ts only QUEUES wakes server-side and rings the
 * bell with chats.tell(chatId, {type:"ping"}). The office pi extension registered from THIS factory
 * listens on the UI_RECEIVE bus event ("pithagoras:v1:ui:receive", the portal's UI event for a chat's extension) and drains
 * the queue per entry via pi.sendMessage({customType:"office-comment-ping", ...},
 * {deliverAs:"followUp", triggerTurn:true}).
 *
 * Injection seams (unit tests must never reach portal()): registerTools(opts) takes the portal bits
 * -- chats.extend registrar, chat->folder lookup, folders list, the file reader, store root, audit
 * record fn, log fn. EVERY one defaults LAZY: the real portal() is read only when a default is used
 * (in production). Mutating ops (office_create, office_edit) call record({subject, reason, chatId})
 * after the write.
 */
import fs from "node:fs";
import path from "node:path";
import { portal } from "./host";
import { canonical, createDoc, docPath, docsForHome, persistBytes, refresh, refreshAll, type DocMeta } from "./store";
import { parseDocx, parseXlsx, editDocx, readPart, rewriteZip, type EditOp } from "./ooxml";
import { inSession, usersOf, isLocked } from "./live";
import { drainWakeQueue } from "./ping";

/** The UI_RECEIVE bus event chats.tell rings (the portal's own document tools listen on the same name). */
const UI_RECEIVE = "pithagoras:v1:ui:receive";

/** An audit line recorded after every mutating op. `subject` is the doc title, `chatId` the acting home chat. */
export type OfficeAuditEntry = { subject: string; reason: string; chatId: string };

/** The folders list entries the factory resolves against (the shape of portal.folders.list() minus nothing it needs). */
export type ToolsFolderInfo = { path: string; name: string; kind: "agent" | "project" | "chat"; home?: boolean };

/** Injection seams for registerTools. Every field is optional and LAZY -- defaults read portal() only when actually used, so unit tests pass plain values and never reach the real portal. */
export type ToolsDeps = {
  /** The chats.extend registrar. Default: (factory) => portal().chats.extend(factory). */
  extend?: (factory: (pi: unknown, chat: { id: string }) => void) => void;
  /** A chat's workspace folder path (throws when the chat or its folder is gone). Default: (id) => portal().chats.folder(id). */
  chatFolder?: (chatId: string) => string;
  /** The folders the agents work in. Default: () => portal().folders.list(). */
  folders?: () => ToolsFolderInfo[];
  /** A scanned document's bytes, read for `chatId`'s agent as it could read them itself (`file` is the document's own
   * path). Default: portal().files.open with likeParent, the chat, and no link followed. */
  readFile?: (file: string, chatId: string) => Buffer;
  /** Store/state root override. Default: lazy portal().dataDir(). */
  root?: string;
  /** Whether the Document Server has an editing session open on the document at its current revision. Default:
   * a seat the Document Server confirmed (live.inSession); server.ts gives its own, which also asks the Document
   * Server. */
  sessionOpen?: (doc: DocMeta) => Promise<boolean>;
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
/** A file read through the portal as the agent of `chatId` reads: refused where that agent could not read it, and
 * never through a link. Whole, from the descriptor the portal opened (no size cap: a .docx is often over 1 MB). */
function readAsAgent(file: string, chatId: string): Buffer {
  if (cfg.readFile) return cfg.readFile(file, chatId);
  const opened = portal().files.open(path.dirname(file), path.basename(file), { likeParent: true, chats: [chatId], direct: true });
  try {
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
function logLine(line: string): void {
  (cfg.log ?? ((l: string) => portal().log(l)))(line);
}
function record(entry: OfficeAuditEntry): void {
  // Lazy default is a one-line log (a real audit sink can be passed via registerTools({record})).
  (cfg.record ?? ((e: OfficeAuditEntry) => logLine(`office audit: ${e.subject}: ${e.reason} (chat ${e.chatId})`)))(entry);
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

/** What a tool may throw out to the agent: refusals as-is, coded store/ooxml errors by their code (zip/part damage -> `corrupt`, revision_mismatch with the FRESH mtime in the message), anything else logged and generic. */
function failed(e: unknown): unknown {
  if (e instanceof Refusal) return e;
  const err = e as (Error & { code?: string; currentMtimeMs?: number }) | null;
  if (err && typeof err.message === "string" && typeof err.code === "string") {
    if (err.code === "revision_mismatch") {
      // The gate refused: tell the agent where the document really is so it can re-read and redo.
      return new Refusal("revision_mismatch", `${err.message} Current revision: ${err.currentMtimeMs ?? "unknown"} -- office_read again, then redo the edit with that mtimeMs as baseRevision. Nothing was written.`);
    }
    const code = err.code === "invalid_zip" || err.code === "missing_part" ? "corrupt" : err.code;
    return new Refusal(code, err.message);
  }
  logLine(`an office tool failed: ${err?.stack ?? e}`);
  return new Refusal("failed", String(e));
}

/** `text` with a details side-channel (the same shape as the portal's document tools). */
const text = (content: string, details?: unknown) => ({ content: [{ type: "text", text: content }], ...(details !== undefined ? { details } : {}) });

/** One office_* tool result must not blow the agent context on a huge grid or document; both office_read and
 * office_read's sibling office_comments truncate at this length with an explicit marker. */
const MAX_READ_CHARS = 200_000;

/** A doc's bytes, for the agent of `chatId`: a scanned doc's own file as that agent could read it (portal.files), a
 * library doc's from the extension's own folder, which no agent can write; a not_found refusal where it is gone. */
function readBytes(doc: DocMeta, chatId: string): Buffer {
  try {
    return doc.path ? readAsAgent(doc.path, chatId) : fs.readFileSync(docPath(doc, rootDir()));
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { code?: string };
    if (err.code === "ENOENT" || err.code === "missing") throw new Refusal("not_found", `the file of "${doc.title}" is missing from disk`);
    if (err.code === "invalid") throw new Refusal("not_found", `"${doc.title}" is not a file your agent can read (${err.message})`);
    throw e;
  }
}

/** The most editing humans, and whether the doc is locked right now, as one readable line ("" when nobody). */
const lockLine = (doc: DocMeta) => {
  const users = usersOf(doc.docId);
  if (!users.length && !isLocked(doc.docId)) return "";
  const who = users.map((u) => u.name || u.id).join(", ");
  return `\n${users.length ? `${users.length} person${users.length === 1 ? "" : "s"} editing now (${who}).` : ""}${isLocked(doc.docId) && !users.length ? "\nThe document is currently locked by the editor." : ""}`;
};

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

  const guarded = (work: (params: Record<string, unknown>) => Promise<unknown> | unknown) => async (_callId: unknown, params: Record<string, unknown>) => {
    try {
      return await work(params ?? {});
    } catch (e) {
      throw failed(e);
    }
  };

  p.registerTool({
    name: "office_list",
    label: "List office documents",
    description: "List the office documents of your library: every Word (.docx) and spreadsheet (.xlsx) document in your folder, the ones you made or were granted (by being mentioned in one of its comments), and the ones the person made in the library. Each line has the id, title, format, owner, how many grants it holds, its current revision (mtimeMs -- pass that back as baseRevision to office_edit) and whether a human is editing it right now.",
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
        return `- ${doc.docId}  "${doc.title}"  ${doc.ext}  owner ${doc.owner === home ? "you" : doc.owner ?? "(nobody)"}  ${doc.grants.length} grant${doc.grants.length === 1 ? "" : "s"}  revision ${doc.mtimeMs}${users.length ? `  ${users.length} editing now` : ""}`;
      });
      return text(`${docs.length} document${docs.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, {
        action: "list",
        home,
        documents: docs.map((doc) => ({ id: doc.docId, title: doc.title, ext: doc.ext, owner: doc.owner, grants: doc.grants.length, sizeBytes: doc.sizeBytes, mtimeMs: doc.mtimeMs, locked: isLocked(doc.docId) || usersOf(doc.docId).length > 0 })),
      });
    }),
  });

  p.registerTool({
    name: "office_create",
    label: "Create an office document",
    description: "Make a new blank office document in the shared library: type \"word\" (a .docx) or \"cell\" (an .xlsx sheet), both starting from a minimal template you edit with office_edit or open in the editor. It is owned by you, so every chat of your home sees it; other agents get access only when it mentions them in a comment. A title+type pair already taken is refused.",
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
      return text(`Created "${doc.title}" (id ${doc.docId}, ${doc.ext}, revision ${doc.mtimeMs}). Edit it with office_edit, which needs that revision as baseRevision.`, { action: "create", id: doc.docId, title: doc.title, ext: doc.ext, mtimeMs: doc.mtimeMs, owner: doc.owner });
    }),
  });

  p.registerTool({
    name: "office_read",
    label: "Read an office document",
    description: "Read a document of your library by its id: the extracted text (paragraph-delimited for Word; a per-sheet grid of cell values for spreadsheets) plus, for Word, its comments (id, author, date, text). The revision line shows mtimeMs -- hand it to office_edit as baseRevision. It also says whether a human is editing right now.",
    promptSnippet: "Read the text and comments of an office document by id",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from office_list or office_create." },
      },
      required: ["id"],
    },
    execute: guarded(async ({ id }) => {
      const doc = visibleDoc(id);
      const buf = readBytes(doc, chatId);
      const lock = lockLine(doc);
      if (doc.ext === "xlsx") {
        // office_read returns a grid of cell values for xlsx; its COMMENTS are not read yet (xl/commentsN.xml + VML).
        const parsed = parseXlsx(buf); // throws {code:"invalid_zip"} -> corrupt
        const sheets = parsed.sheetNames.map((name) => {
          const rows = parsed.sheets[name] ?? [];
          return `Sheet "${name}" (${rows.length} row${rows.length === 1 ? "" : "s"}):\n${rows.map((r) => "| " + r.join(" | ") + " |").join("\n")}`;
        }).join("\n\n");
        const truncatedSheets = Object.keys(parsed.truncatedSheets);
        let said = `"${doc.title}" (id ${doc.docId}, xlsx, revision ${doc.mtimeMs})${lock}\n\n${sheets || "(empty workbook)"}\n\nNo comments: spreadsheet comments are not read in v1 (they arrive later).`;
        if (truncatedSheets.length) said += `\n\n(truncation: sheet ${truncatedSheets.map((n) => `"${n}"`).join(", ")} referenced cells beyond the supported grid size; those far-out cells were not read)`;
        if (said.length > MAX_READ_CHARS) said = said.slice(0, MAX_READ_CHARS) + "\n\n[output truncated by office_read: it exceeds 200,000 characters]";
        return text(said, { action: "read", id: doc.docId, ext: doc.ext, mtimeMs: doc.mtimeMs, sheets: parsed.sheetNames });
      }
      const parsed = parseDocx(buf); // throws {code:"invalid_zip"|"missing_part"} -> corrupt
      let comments = "";
      if (parsed.comments.length) {
        const lines = parsed.comments.map((c) => `- ${c.id}  ${c.author}${c.date ? `  ${c.date}` : ""}: ${c.text.replace(/\n/g, " ")}`);
        comments = `\n\nComments (${parsed.comments.length}):\n${lines.join("\n")}`;
      }
      let said = `"${doc.title}" (id ${doc.docId}, docx, revision ${doc.mtimeMs})${lock}\n\n${parsed.text}${comments}`;
      if (said.length > MAX_READ_CHARS) said = said.slice(0, MAX_READ_CHARS) + "\n\n[output truncated by office_read: it exceeds 200,000 characters]";
      // details lands in the portal tool-event store and the web transcript -- MAX_READ_CHARS caps only the text above,
      // so bound the comments HERE too (100 at 500 chars each, worst case ~50 KB); commentCount keeps the true total.
      const detailComments = parsed.comments.slice(0, 100).map((c) => ({ id: c.id, author: c.author, date: c.date, text: c.text.slice(0, 500) }));
      return text(said, { action: "read", id: doc.docId, ext: doc.ext, mtimeMs: doc.mtimeMs, comments: detailComments, commentCount: parsed.comments.length });
    }),
  });

  p.registerTool({
    name: "office_edit",
    label: "Edit an office document",
    description: `Change a Word document of your library by replacing quoted text, as office_read shows it. Each op is {quote, replacement}: the quote must appear in the extracted text (empty replacement removes it), ops apply one after another. While a person has the document open in the editor, the edit is refused (error:open_in_editor): what they type is saved when they close it, so wait and try again then. Every edit goes through the revision gate: baseRevision is the mtimeMs you read (or that your last edit returned), and if the document moved on since NOTHING is written and you hear a CONFLICT with the fresh revision -- re-read and retry. You never clobber a newer revision. Spreadsheets cannot be edited in v1 (a later milestone). All ops are made or none.`,
    promptSnippet: "Edit a Word document: quoted replacements on the revision you read",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from office_list or office_create." },
        ops: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              quote: { type: "string", description: "Text to replace, exactly as office_read shows it (may not be empty)." },
              replacement: { type: "string", description: "What takes its place; empty removes the quote." },
            },
            required: ["quote", "replacement"],
          },
        },
        baseRevision: { type: "number", description: "The revision (mtimeMs) you read or last edited at." },
      },
      required: ["id", "ops", "baseRevision"],
    },
    execute: guarded(async ({ id, ops, baseRevision }) => {
      const doc = visibleDoc(id);
      if (doc.ext !== "docx") throw new Refusal("unsupported_format", `"${doc.title}" is an .xlsx spreadsheet: editing spreadsheets is not in v1 (a later milestone) -- read it with office_read`);
      if (!Array.isArray(ops) || ops.length === 0) throw new Refusal("invalid", "ops is a non-empty list of {quote, replacement}");
      ops.forEach((op, i) => {
        if (typeof op?.quote !== "string" || !op.quote || typeof op.replacement !== "string") throw new Refusal("invalid", `op ${i + 1} needs a quote (not empty) and a replacement (text, or empty to remove)`);
      });
      const base = Number(baseRevision);
      if (baseRevision === undefined || baseRevision === null || !Number.isFinite(base)) throw new Refusal("invalid", "baseRevision is the mtimeMs revision office_list/office_read showed you");

      // GATE FIRST: the meta as it stands now vs what the agent read; >1 ms drift means a save
      // moved since -- refuse with the FRESH mtime in the message, and write nothing. store.persistBytes
      // re-gates strictly at write time too, so this is belt and not only braces.
      let meta = refresh(doc.docId, rootDir());
      if (!meta) throw new Refusal("not_found", `"${doc.title}" vanished from the library between list and edit`);
      // Not while the document is open in the editor: the Document Server saves what is typed there only when the
      // last editor closes, under the revision it opened, and an edit landing first would make that save stale --
      // the person's whole session would be refused. So the agent waits until it is closed.
      if (await (cfg.sessionOpen ?? (async (d: DocMeta) => inSession(d.docId)))(meta)) {
        throw new Refusal("open_in_editor", `"${meta.title}" is open in the editor right now: what is typed there is saved when it is closed, and an edit now would be in its way. Nothing was written. Try again once it is closed (office_list says when nobody is editing it).`);
      }
      // When the revision gate refuses, say LOUDLY that this is a CONFLICT and point at the fresh revision to re-read + retry.
      const stale = (fresh: DocMeta) => {
        const humans = usersOf(fresh.docId);
        const openEditorNote = humans.length > 0 ? ` A human editor (${humans.map((h) => h.name ?? h.id).join(", ")}) still has the document open, so a co-editor is likely behind the change.` : "";
        return new Refusal("revision_mismatch", `CONFLICT: "${fresh.title}" is at revision ${fresh.mtimeMs}, not ${base}: it changed since you read it. Nothing was written.${openEditorNote} Read it again with office_read, then redo the edit with baseRevision ${fresh.mtimeMs}.`);
      };
      if (Math.abs(meta.mtimeMs - base) > 1) throw stale(meta);

      // word/document.xml out of the archive; damage is `corrupt`, quote problems pass through ooxml's codes.
      const buf = readBytes(doc, chatId);
      let documentXml: string;
      try {
        // Within the caps every other read here keeps (256 MiB an entry, 1 GiB a zip): a part that inflates to gigabytes
        // is refused before it is inflated, not held whole in the portal's memory.
        const part = readPart(buf, "word/document.xml");
        if (part === undefined) throw new Refusal("corrupt", `"${doc.title}" has no word/document.xml: it is not a Word document`);
        documentXml = part;
      } catch (e) {
        if (e instanceof Refusal) throw e;
        throw new Refusal("corrupt", `"${doc.title}" could not be opened as a zip archive: ${e instanceof Error ? e.message : String(e)}`);
      }

      const editedXml = editDocx(documentXml, ops as EditOp[]); // throws {code:"quote_not_found"|"quote_ambiguous"} -- surfaced unchanged by failed()
      const out = rewriteZip(buf, { "word/document.xml": editedXml }); // {code:"invalid_zip"} -> corrupt
      let saved: { mtimeMs: number };
      try {
        saved = persistBytes(meta, out, rootDir()); // the strict ZERO-tolerance final gate + index update
      } catch (e) {
        const err = e as (Error & { code?: string; currentMtimeMs?: number }) | null;
        if (err?.code === "revision_mismatch") {
          // The file moved underneath us between the pre-gate read and the write (a co-editor's save landing
          // on disk through the DS callback persist path). Refuse LOUD as a conflict with the FRESH revision,
          // generic wording here: this is the safety mechanism of the co-editor model (fail loud, re-read + retry).
          const humans = usersOf(doc.docId);
          const note = humans.length > 0 ? ` A human editor (${humans.map((h) => h.name ?? h.id).join(", ")}) has the document open -- a co-editor's save is the likely change.` : "";
          throw new Refusal("revision_mismatch", `CONFLICT: "${doc.title}" changed while this edit was in flight: it is now at revision ${err.currentMtimeMs ?? "unknown"}, you based the edit on ${base}. Nothing was written.${note} Read it again with office_read, then redo the edit with baseRevision ${err.currentMtimeMs ?? "the fresh revision office_list shows"}.`);
        }
        throw e;
      }
      record({ subject: doc.title, reason: `office_edit: ${ops.length} op(s) applied, revision ${meta.mtimeMs} -> ${saved.mtimeMs}`, chatId });
      const n = ops.length;
      return text(`Edited "${doc.title}" (${n} op${n === 1 ? "" : "s"} made): now at revision ${saved.mtimeMs}. Pass that as baseRevision for the next edit.`, { action: "edit", id: doc.docId, from: meta.mtimeMs, to: saved.mtimeMs, ops: n });
    }),
  });

  p.registerTool({
    name: "office_comments",
    label: "List document comments and grants",
    description: "Read-only: the comments of a Word document (id, author, date, text) plus its grants -- which other agent/project homes hold access to it by mention. Spreadsheets have no comment reading in v1.",
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
