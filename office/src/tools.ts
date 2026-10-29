/**
 * The agent's office tools: list, create, read, edit and list the comments of the documents the agent's or project's
 * folder sees (store.visibleTo: what it owns or was granted, and the documents in its own folder), in the style of the portal's document tools -- named by id, coded error prefixes
 * ("error:<code> <message>").
 *
 * Ownership scope: `registerTools` walks every chat through portal.chats.extend; for a chat it asks whose the chat is
 * (owner.ts `chatOwner`: chats.owner, an agent's home or a project's folder, a folder inside a project included) and
 * REGISTERS ONLY for a chat that is an agent's or a project's. That folder is the home: a document is owned by and
 * granted to a folder, not a chat, as an agent's chats come and go. The Office panel beside a chat lists by the same
 * rule (server.ts `folderForChat`). Docs outside the scope are invisible to every tool: office_read asks for them and hears
 * the same "no document with that id" as for a nonexistent one, and no editor is opened for them.
 *
 * Reading and editing go through the agent's own editor in the document (seat.ts): an OnlyOffice editor of the
 * agent's home, beside the people in it, so office_read gives the text as it stands in the editor, what people typed
 * and did not save among it, and office_edit's ops show in their editors at once. After an edit the Document Server
 * is asked to save the session (editing.saveNow), and the save goes through the callback's revision gate as any save
 * of the editor. Where the person stopped Office, office_read reads the saved file and office_edit is refused: there
 * is one way to write.
 *
 * A document is opened for the agent only where the agent could read its file itself (portal.files.open, as
 * the chat's agent: with the sandbox on, a file the agent could not read is refused, and a link is not followed), and
 * in edit mode only where it could change it (portal.files.identity); otherwise its editor opens in view mode and
 * office_edit is refused (`read_only`). A document in another agent's or project's folder that a person opened to it
 * by a mention is read with the portal's rights instead (byGrantOnly): the mention is the person's word that it may.
 *
 * Comments that mention an agent, and the editor's chat, are no wake of these tools: each gets an internal chat of
 * its own (docchat.ts), started in the agent's home or the project's folder, which this factory gives the tools as any
 * chat of the folder. Nobody attends it, which the portal holds it to (no question tool, no dialog that waits).
 *
 * Injection seams (unit tests must never reach portal()): registerTools(opts) takes the portal bits -- chats.extend
 * registrar, whose a chat is, the file reader, store root, audit record fn, log fn, the seats, the
 * save after an edit and whether Office runs. EVERY one defaults LAZY: the real portal() is read only when a default
 * is used (in production). office_create and office_edit call record({subject, reason, chatId}) after the write.
 */
import fs from "node:fs";
import path from "node:path";
import { portal } from "./host";
import { chatOwner } from "./owner";
import { canonical, createDoc, docSize, docsForHome, MAX_IMPORT_BYTES, readDoc, refresh, refreshAll, tooLarge, within, type DocMeta } from "./store";
import { docxThreads, parseDocx, parseXlsx, xlsxThreads, type CommentThread } from "./ooxml";
import { agentsOf, usersOf, isLocked } from "./live";
import { saveNow, type SaveAfterEdit } from "./editing";
import { editJob, formatJob, OpError, viewJob, type EditJob, type FormatJob } from "./ops";
import * as seat from "./seat";
import { MAX_READ_FORMAT, MAX_SHOWN_TEXT } from "./seat-page";
import * as docchat from "./docchat";

/** Marks a text to be translated where it is shown: a label kept in a table (de.ts has its German). */
const msg = <T extends string>(text: T): T => text;

/** What a call of each tool is labelled with in pi, and on its card in the chat while it runs, in English. */
export const LABELS: Record<string, string> = {
  office_list: msg("Listing office documents"),
  office_create: msg("Creating an office document"),
  office_read: msg("Reading an office document"),
  office_edit: msg("Editing an office document"),
  office_format: msg("Formatting an office document"),
  office_comments: msg("Reading the comments of a document"),
  office_screenshot: msg("Taking a picture of an office document"),
};

/**
 * What the guard holds each tool to. What they return is outside content: the text and comments of files found in
 * the agents' folders, written by anybody, and their titles (file names). None of them is the shape of one of the
 * guard's rules after a suspected prompt injection (`acts`): office_create makes a blank document in the agent's own
 * folder (its home, or its project's), where it writes anyway, and office_edit and office_format change a document of the agent's own scope through its
 * editor, which runs nothing, carries nothing out and lands nowhere a later run reads as instructions. office_screenshot's picture is the
 * document too: its text part carries a Word page's body text and a sheet range's cells (20,000 characters at most),
 * which the guard reads. Only in the picture, and not read by the guard: a page's header, footer and footnotes, text boxes,
 * shapes and charts, text inside the document's own pictures, and a long text that runs into the range from a cell
 * outside it.
 */
export const GUARDS: Record<string, { outside: boolean; acts: string[] }> = {
  office_list: { outside: true, acts: [] },
  office_create: { outside: true, acts: [] },
  office_read: { outside: true, acts: [] },
  office_edit: { outside: true, acts: [] },
  office_format: { outside: true, acts: [] },
  office_comments: { outside: true, acts: [] },
  office_screenshot: { outside: true, acts: [] },
};

/** An audit line recorded after every mutating op. `subject` is the doc title, `chatId` the acting home chat. */
export type OfficeAuditEntry = { subject: string; reason: string; chatId: string };

/** Whether Office runs: its Document Server set up and settled, setting itself up, or stopped by the person (or never
 * started). */
export type OfficeState = "running" | "starting" | "stopped";

/** The seats as the tools use them (seat.ts by default). */
export type ToolsSeat = {
  run(home: string, docId: string, mode: seat.SeatMode, job: seat.SeatJob, options?: { signal?: AbortSignal; timeoutMs?: number; post?: boolean }): Promise<unknown>;
  keyOf(home: string, docId: string): string | undefined;
  closeDoc(docId: string, why?: string): void;
  shot(home: string, docId: string, mode: seat.SeatMode, locate: seat.SeatJob, options?: { signal?: AbortSignal; large?: boolean }): Promise<{ located: Record<string, unknown>; image: { data: string; width: number; height: number; zoom?: number; pages?: number } }>;
};

/** Injection seams for registerTools. Every field is optional and LAZY -- defaults read portal() only when actually used, so unit tests pass plain values and never reach the real portal. */
export type ToolsDeps = {
  /** The chats.extend registrar. Default: (factory) => portal().chats.extend(factory). */
  extend?: (factory: (pi: unknown, chat: { id: string }) => void) => void;
  /** The agent's home or project's folder a chat is (its tools' home), none for a chat that is neither's; throws when
   * the chat or its folder is gone. Default: owner.ts `chatOwner`. */
  owner?: (chatId: string) => string | undefined;
  /** A document's file, opened for `chatId`'s agent as it could open it itself (`file` is the document's own
   * path): its descriptor, which the caller closes, and its size. Default: portal().files.open with likeParent, the
   * chat, and no link followed. */
  openFile?: (file: string, chatId: string) => { fd: number; size: number };
  /** Throws where `chatId`'s agent could not change the document `file` itself: its folder is not one the agent
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
  /** What Office says where the portal is too old for agents to answer comments and the editor's chat (host.ts
   * `tooOld`), else nothing. Default: nothing. */
  docchatOff?: () => string | undefined;
  /** The audit sink for mutating ops. Default: a one-line log via the log seam. */
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
function ownerOf(chatId: string): string | undefined {
  return (cfg.owner ?? chatOwner)(chatId);
}
function seats(): ToolsSeat {
  return cfg.seat ?? seat;
}
/** The words office_list and office_comments end with where agents cannot answer comments here. */
function offNote(): string {
  const off = cfg.docchatOff?.();
  return off ? `\n\n${off}` : "";
}
/** The file of a document opened as the agent of `chatId` would open it: refused where that agent could not
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
/** Whether the agent of `chatId` could change the document `file` itself: the portal (and the Document
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
 * `extend`, so no once-guard here.
 */
export function registerTools(opts?: ToolsDeps): void {
  if (opts) cfg = { ...cfg, ...opts };
  const registrar = cfg.extend ?? ((factory: (pi: unknown, chat: { id: string }) => void) => portal().chats.extend(factory));
  registrar((pi, chat) => installForChat(pi, chat));
}

/** The chats.extend factory body: whose the chat is (`ownerOf`); RETURN where it is no agent's nor project's; then
 * register the tools on that chat's pi, for that folder. */
function installForChat(pi: unknown, chat: { id: string }): void {
  let home: string | undefined;
  try {
    home = ownerOf(chat.id);
  } catch (e) {
    logLine(`office tools: no workspace folder for chat ${chat.id} (${(e as Error)?.message ?? e}) -- no office_* tools`);
    return; // gone chat or folder: nothing to register into
  }
  if (!home) return; // no agent's nor project's: no tools
  installTools(pi, canonical(home), chat.id);
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
  office_stopped: "The person stopped Office: ask them to start it in Settings → Office. office_read still reads the saved file.",
  agent_editor_missing: "Ask the person to start Office (Start container in Settings → Office): that downloads it.",
  agent_unavailable: "Try again in a moment; if it keeps failing, ask the person to look at Settings → Office.",
  editor_not_ready: "Try again in a moment.",
  busy: "",
  behind: "Read it again with office_read before you edit.",
  timeout: "",
  editor_closed: "",
  too_large: "Read a spreadsheet one sheet at a time (sheet).",
  editor_not_saved: "Do not make it again: read the document if you need to see it.",
  partial: "Part of this call may be in the document: read it with office_read before you go on, and do not repeat the call as it was.",
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

/** What one sheet op may add to the time an edit takes in the agent's editor: up to two waits for the Document Server
 * (a copy is made, then moved), each bounded by the plugin's own wait (SHEET_WAIT, 10 s). An edit has MAX_EDIT_MS at
 * most: the editor answers a sheet change in about half a second, and one that answers none in 10 s fails the call. */
const SHEET_OP_MS = 20_000;
const MAX_EDIT_MS = 120_000;

/** Of what pi hands a tool's execute last (its ExtensionContext), what office_screenshot reads: the chat's model, and
 * whether it takes pictures (`input`). */
type ToolContext = { model?: { id?: string; name?: string; input?: unknown } };

/** office_format's description: what the model reads of it (ops.ts formatJob has the full grammar, and its refusals
 * name what a key takes, so value lists that a refusal gives stay out of here). */
const FORMAT_DESCRIPTION =
  'Change how a Word document of your library looks, through your own editor in it (office_edit changes what it says); people in it see it at once. One call is made whole or not at all. Each op\'s first key holds the quote of the body\'s text that is its place, exactly as office_read shows it ({format: "Q3 results", set}, {footnote: "unaudited", text}; `nth` picks a repeat, from 1), and `set` what to set. Ops: {format, through?, set}: the quote\'s text, or from it to the end of `through`, and its paragraphs; {defineStyle, type?, basedOn?, change?, set}: a new paragraph style ("character" for text; an existing one changes only with change: true); {formatTable, cells?, set}: the table holding the quote, or its cells ("A1:C2" as office_read shows it); {page, set}: page setup of the quote\'s section ("*" all); {sectionBreak, type?}: a new section after the quote\'s paragraph; {after?, pageBreak: true}; {footnote, text}: at the quote\'s end; {after?, toc: true, levels?}: a table of contents (at the start by default). set is flat ({bold: true, list: "bullet"}), its keys: for text font, fontSize, bold, italic, underline, strike, superscript, subscript, color, highlight, link ("" removes), style (character or paragraph style), clear (direct formatting off); for paragraphs align (left, center, right, justify), spaceBefore, spaceAfter, lineSpacing (1.5, or "14pt" exact), indentLeft, indentRight, firstLine (negative hangs), list ("bullet", "number", "none"; continues the list before), level (1-9), listStart, pageBreakBefore, keepWithNext; for tables tableStyle, width ("100%" or a length), columnWidths, headerRows, and the cell keys for all cells; for cells borders ("all", "outside", "inside", "none" or {top, bottom, left, right, insideH, insideV}, each "single 1pt #000000" or "none"), fill, align, valign, rowHeight, merge (true), and the text keys but link; for the page pageSize (A4, Letter, ... or [w, h]), orientation, margins (one or [top, right, bottom, left]), header, footer ({page}, {pages}; "" removes), differentFirstPage, replace (a header holding more than text). Lengths in points, or "2.5cm", "10mm", "1in"; colours "#RRGGBB". office_read with formatting: true shows the result, office_screenshot a picture of it.';

/** What office_format's answer adds about the call: the styles it made or changed, and whether the pages moved. */
function formatSaid(made: unknown): string {
  const r = (made ?? {}) as { styles?: { style: string; made?: boolean; changed?: boolean; paragraphs?: number }[]; reflowed?: boolean };
  const styles = (r.styles ?? []).map((s) => (s.made ? ` Made the style "${s.style}".` : ` Changed the style "${s.style}"${typeof s.paragraphs === "number" ? ` (${s.paragraphs} paragraph${s.paragraphs === 1 ? " uses" : "s use"} it)` : ""}.`));
  return `${styles.join("")}${r.reflowed ? " The document reflowed; office_screenshot shows the pages." : ""}`;
}

/** `text` with a details side-channel (the same shape as the portal's document tools). */
const text = (content: string, details?: unknown) => ({ content: [{ type: "text", text: content }], ...(details !== undefined ? { details } : {}) });

/** One office_* tool result must not blow the agent context on a huge grid or document; both office_read and
 * office_read's sibling office_comments truncate at this length with an explicit marker. */
const MAX_READ_CHARS = 200_000;

/** Whether the agent or project of `home` sees `doc` only by a grant: a person mentioned it in one of the document's
 * comments, and the document is in another agent's home or project folder. That mention is the person's word that it
 * may read the document, which its own rights may not allow (with the sandbox on, an agent's home is closed to the
 * other agents, and a project's chats run as the default agent): such a document is read with the portal's rights,
 * from its own file and never through a link (store.readDoc). Whether it may also change it stays the agent's own
 * rights' (mayWrite), so a grant never lets an agent write into a folder it could not write itself. */
function byGrantOnly(doc: DocMeta, home: string): boolean {
  return doc.owner !== home && !within(home, doc.path) && doc.grants.some((g) => g.folder === home);
}

/** A doc's saved bytes, for the agent of `chatId` (of `home`): its own file as that agent could read it (portal.files),
 * or, for a document it was granted (byGrantOnly), as the portal reads it; a not_found refusal where it is gone. */
function readBytes(doc: DocMeta, chatId: string, home: string): Buffer {
  try {
    return byGrantOnly(doc, home) ? readDoc(doc) : readAsAgent(doc.path, chatId);
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

/** A document's file opened as the agent would and closed again: where it could not read it, the Document Server
 * (which reads as the portal) is never handed it. A document it was granted is checked as the portal reads it
 * (byGrantOnly): a plain file at its own name, within the library's cap. */
function assertMayRead(doc: DocMeta, chatId: string, home: string): void {
  if (byGrantOnly(doc, home)) {
    try {
      docSize(doc);
    } catch (e) {
      throw unreadable(doc, e);
    }
    return;
  }
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

/** A run's or paragraph's direct formatting as the read commands give it (seat-page.ts WORD_LOOK_SRC): lengths in
 * twips, sizes in half-points. */
type RunLook = { font?: string; size?: number; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; superscript?: true; subscript?: true; color?: string; highlight?: string; style?: string; link?: string };
type ParaLook = { align?: string; spaceBefore?: number; spaceAfter?: number; line?: { multiple: number } | { exact: number } | { atLeast: number }; indentLeft?: number; indentRight?: number; firstLine?: number; keepWithNext?: boolean; pageBreakBefore?: boolean };
/** A footnote's mark: the text before it (its last 40 characters), the note's text, and in a table its cell. */
type NoteMark = { at: string; note: string; row?: number; cell?: number };
type BlockLook = { para?: ParaLook; runs?: { t: string; look: RunLook }[]; notes?: NoteMark[]; pictures?: [number, number][] };
type TableLook = { style?: string; headerRows?: number; merged?: { row: number; cell: number; across?: number; above?: true }[]; notes?: NoteMark[]; pictures?: true };
type WordBlock = ({ p: string; style?: string; list?: "bullet" | "number"; level?: number; format?: string; label?: string; look?: BlockLook } | { table: string[][]; row?: number; of?: number; look?: TableLook });
type WordFormat = {
  defaults?: RunLook;
  styles: { name: string; type: string; basedOn?: string; text?: RunLook; para?: ParaLook }[];
  sections: { width: number; height: number; margins: number[]; ends: number; header?: { text: string; more: boolean }; footer?: { text: string; more: boolean }; headerAs?: number; footerAs?: number; firstPage?: true; firstHeader?: { text: string; more: boolean }; firstFooter?: { text: string; more: boolean } }[];
  footnotes: string[];
};
/** Word blocks as the agent reads them: `[n] text`, a style and a list in brackets, a table as its rows; with the
 * formatting read, the paragraph's own formatting in the brackets too and its runs' on a line under it. */
type WordBlocks = { blocks: WordBlock[]; truncated?: boolean; format?: WordFormat; formatCut?: number };

const pt = (twips: number) => `${+(twips / 20).toFixed(1)}pt`;
const cm = (twips: number) => `${+((twips / 1440) * 2.54).toFixed(2)}cm`;
/** A list's words in a block's brackets: "bullet", "numbered", its numbering where it is not 1, 2, 3, its label (a
 * formatting read's: "3."), its level. */
function listWords(b: { list?: string; level?: number; format?: string; label?: string }): string {
  if (!b.list) return "";
  return `${b.list === "bullet" ? "bullet" : `numbered${b.format ? ` ${b.format}` : ""}${b.label ? ` ${JSON.stringify(b.label)}` : ""}`}${b.level && b.level > 1 ? `, level ${b.level}` : ""}`;
}
function runWords(l: RunLook): string {
  const out: string[] = [];
  if (l.style) out.push(`style ${JSON.stringify(l.style)}`);
  if (l.font || l.size) out.push([l.font, l.size ? `${l.size / 2}` : ""].filter(Boolean).join(" "));
  // Off is said too: a run's own "not bold" hides its style's bold.
  for (const k of ["bold", "italic", "underline", "strike", "superscript", "subscript"] as const) if (l[k]) out.push(k);
  else if (l[k] === false) out.push(k === "bold" || k === "italic" ? `not ${k}` : `no ${k}`);
  if (l.color) out.push(l.color === "auto" ? "colour auto" : l.color);
  if (l.highlight) out.push(`highlight ${l.highlight}`);
  if (l.link) out.push(`link ${l.link}`);
  return out.join(", ");
}
function paraWords(l: ParaLook): string {
  const out: string[] = [];
  if (l.align) out.push(l.align);
  if (l.spaceBefore !== undefined) out.push(`space before ${pt(l.spaceBefore)}`);
  if (l.spaceAfter !== undefined) out.push(`space after ${pt(l.spaceAfter)}`);
  if (l.line) out.push("multiple" in l.line ? `line spacing ${+l.line.multiple.toFixed(2)}` : "atLeast" in l.line ? `line spacing at least ${pt(l.line.atLeast)}` : `line spacing ${pt(l.line.exact)} exact`);
  // A zero indent and a flag set off are the paragraph's own too (over its style's).
  if (l.indentLeft !== undefined) out.push(`indent left ${cm(l.indentLeft)}`);
  if (l.indentRight !== undefined) out.push(`indent right ${cm(l.indentRight)}`);
  if (l.firstLine !== undefined) out.push(l.firstLine < 0 ? `hanging ${cm(-l.firstLine)}` : `first line ${cm(l.firstLine)}`);
  if (l.keepWithNext !== undefined) out.push(l.keepWithNext ? "keep with next" : "not keep with next");
  if (l.pageBreakBefore !== undefined) out.push(l.pageBreakBefore ? "page break before" : "no page break before");
  return out.join(", ");
}
/** A run's text as the formatting line quotes it: cut where it is long (what it says is in the block's text). */
const quoted = (t: string) => JSON.stringify(t.length > 80 ? `${t.slice(0, 77)}…` : t);
const colName = (n: number) => {
  let out = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
};

/** `first`: the number of the first block (a page's blocks are numbered as office_read numbers the document's). A
 * table of which only some rows are given (a page's) says which. */
function wordText(read: WordBlocks, first = 1): string {
  if (!read.blocks.length) return "(empty document)";
  const rows = (b: { table: string[][]; row?: number; of?: number }) => (b.row ? `, rows ${b.row}-${b.row + b.table.length - 1} of ${b.of}` : "");
  return read.blocks
    .map((b, i) => {
      if ("table" in b) {
        const l = b.look;
        const words = l ? [l.style ? `style ${JSON.stringify(l.style)}` : "", l.headerRows ? `header row${l.headerRows === 1 ? "" : "s"} ${l.headerRows}` : "", ...(l.merged ?? []).map((m) => `${colName(m.cell)}${m.row + 1} ${m.above ? "merged with the cell above" : `spans ${m.across} columns`}`), l.pictures ? "holds pictures (not read)" : ""].filter(Boolean) : [];
        return `[${i + first}] table${rows(b)}${words.length ? ` (${words.join(", ")})` : ""}\n${b.table.map((row) => `| ${row.join(" | ")} |`).join("\n")}`;
      }
      const look = b.look;
      const bracket = [b.style, listWords(b), look?.para ? paraWords(look.para) : ""].filter(Boolean).join(", ");
      const under = [...(look?.runs ?? []).map((r) => `${quoted(r.t)}: ${runWords(r.look)}`), ...(look?.pictures ?? []).map(([w, h]) => `a picture ${+(w / 360000).toFixed(1)} × ${+(h / 360000).toFixed(1)} cm`)];
      return `[${i + first}]${bracket ? ` (${bracket})` : ""} ${b.p}${under.length ? `\n    ${under.join("; ")}` : ""}`;
    })
    .join("\n");
}

/** The paper sizes office_format names, to say a page's by name (either way round). */
const PAPER: [string, number, number][] = [["A3", 16838, 23811], ["A4", 11906, 16838], ["A5", 8391, 11906], ["Letter", 12240, 15840], ["Legal", 12240, 20160]];
/** What office_read says first with `formatting`: the document's defaults, the styles in use (each as it is itself),
 * each section's page and header and footer, the footnotes and where they are. */
function formatHead(read: WordBlocks): string {
  const f = read.format;
  if (!f) return "";
  const lines: string[] = ["Formatting: each paragraph's and run's own (direct) formatting is shown with it; a style's look is here once, as the style is itself (what it inherits is not added)."];
  if (f.defaults && (f.defaults.font || f.defaults.size)) lines.push(`Document defaults: ${runWords({ font: f.defaults.font, size: f.defaults.size })}.`);
  if (f.styles.length) {
    const style = (s: WordFormat["styles"][number]) => {
      const own = [s.text ? runWords(s.text) : "", s.para ? paraWords(s.para) : ""].filter(Boolean).join("; ");
      return `${s.name} (${s.type === "run" ? "character" : s.type}${s.basedOn ? `, based on ${s.basedOn}` : ""}${own ? `: ${own}` : ""})`;
    };
    lines.push(`Styles in use: ${f.styles.map(style).join(", ")}.`);
  }
  const hf = (what: string, x?: { text: string; more: boolean }, as?: number) => (x ? ` ${what}: ${JSON.stringify(x.text)}${x.more ? " (and more than text: pictures or tables)" : ""}.` : as ? ` ${what}: section ${as}'s (none of its own).` : "");
  f.sections.forEach((s, k) => {
    const paper = PAPER.find(([, w, h]) => (Math.abs(w - s.width) <= 20 && Math.abs(h - s.height) <= 20) || (Math.abs(h - s.width) <= 20 && Math.abs(w - s.height) <= 20));
    const size = paper ? paper[0] : `${cm(s.width)} × ${cm(s.height)}`;
    const from = k === 0 ? "" : ` (from [${(f.sections[k - 1].ends || 0) + 1}])`;
    const head = f.sections.length === 1 ? "Page" : `Section ${k + 1}${from}`;
    lines.push(`${head}: ${size} ${s.width > s.height ? "landscape" : "portrait"}, margins ${s.margins.map((m) => +((m / 1440) * 2.54).toFixed(2)).join("/")} cm (top/right/bottom/left).${hf("Header", s.header, s.headerAs)}${hf("Footer", s.footer, s.footerAs)}${s.firstPage ? ` A first page of its own.${hf("First page's header", s.firstHeader)}${hf("First page's footer", s.firstFooter)}` : ""}`);
  });
  // The footnotes in reading order, each after the text its own mark follows (a table's in its cell). A note whose mark
  // is where the read takes no text (beside a picture) is said without a place, never at another one's.
  const marks = read.blocks.flatMap((b, i) => (b.look?.notes ?? []).map((m) => ({ block: i + 1, ...m })));
  const rest = f.footnotes.map((t) => t.trim());
  for (const m of marks) {
    const at = rest.indexOf(m.note.trim());
    if (at >= 0) rest.splice(at, 1);
  }
  const said = [
    ...marks.map((m, k) => `[${k + 1}] in [${m.block}]${m.cell !== undefined ? ` cell ${colName(m.cell)}${(m.row ?? 0) + 1}` : ""} after ${JSON.stringify(m.at.length >= 40 ? `…${m.at}` : m.at)}: ${m.note.trim()}`),
    ...rest.map((t) => `(its place not read) ${t}`),
  ];
  if (said.length) lines.push(`Footnotes: ${said.join("; ")}`.replace(/([^.!?])$/, "$1."));
  return `${lines.join("\n")}\n\n`;
}

/** A spreadsheet's cells as the agent reads them: every sheet of the workbook first, by its position (from 1) and
 * whether it is hidden, then the cells of each sheet read, `A1: value`, a text in quotes, a formula after its value. */
type CellSheets = { book: { name: string; hidden: boolean }[]; sheets: { name: string; range: string; cells: { a: string; v: unknown; f?: string }[]; truncated: boolean; skipped?: boolean }[] };
function sheetList(book: CellSheets["book"]): string {
  return `Sheets: ${book.map((s, i) => `${i + 1} ${JSON.stringify(s.name)}${s.hidden ? " (hidden)" : ""}`).join(", ")}`;
}
/** Cells as office_read shows them, one a line. */
function cellLines(cells: { a: string; v: unknown; f?: string }[]): string {
  const value = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));
  return cells.map((c) => `${c.a}: ${value(c.v)}${c.f ? ` (${c.f})` : ""}`).join("\n");
}
function cellText(read: CellSheets): string {
  const sheets = read.sheets.map((s) => {
    const cells = cellLines(s.cells);
    if (s.skipped) return `Sheet "${s.name}": not read (the sheets before it filled the read; read it with sheet)`;
    return `Sheet "${s.name}" (${s.range}):\n${cells || "(empty)"}${s.truncated ? "\n(not all of its cells are shown: a read gives 20,000 cells of a sheet and 200,000 characters at most)" : ""}`;
  });
  return [sheetList(read.book), ...sheets].join("\n\n");
}

/** Why office_read reads the saved file: Office does not run, or the agent's editor is not downloaded. */
const SAVED_BECAUSE = {
  starting: "Office is still starting",
  stopped: "Office is stopped",
  missing: "your editor is not downloaded: the person starts Office in Settings → Office, which downloads it",
};

/** What office_read says where `formatting` cannot be given: of a spreadsheet (not read yet), and of a saved file. */
const NO_SHEET_LOOKS = "\n\n(a spreadsheet's formatting is not read yet: office_screenshot shows it)";
const NO_SAVED_LOOKS = "\n\n(formatting is read from the editor only, and this is the saved file)";

/** What office_read says first: the document, and where the text comes from (`saved`: why it is the saved file). */
function readHeader(doc: DocMeta, saved?: keyof typeof SAVED_BECAUSE): string {
  const head = `"${doc.title}" (id ${doc.docId}, ${doc.ext}, revision ${doc.mtimeMs})`;
  if (saved) return `${head}\nSaved copy (${SAVED_BECAUSE[saved]}): what the file holds. What is typed in an open editor is not in it, and office_edit waits until ${saved === "missing" ? "it is there" : "Office runs"}.`;
  const n = usersOf(doc.docId).length;
  return `${head}\nLive: the document as it stands in the editor${n ? `, including what ${people(n)} in it typed and have not saved yet` : ""}.`;
}

/** A saved file read as office_read shows it when Office does not run (a spreadsheet's `sheet` alone, where named). */
function savedText(doc: DocMeta, chatId: string, home: string, sheet?: string): string {
  const buf = readBytes(doc, chatId, home);
  if (doc.ext === "xlsx") {
    const parsed = parseXlsx(buf); // throws {code:"invalid_zip"} -> corrupt
    // A sheet is named case-insensitively, as Excel and the live read do.
    const asked = sheet === undefined ? undefined : parsed.sheetNames.find((name) => name.toLowerCase() === sheet.toLowerCase());
    if (sheet !== undefined && asked === undefined) throw new Refusal("not_found", `there is no sheet named ${JSON.stringify(sheet)} (the sheets: ${parsed.sheetNames.map((name) => JSON.stringify(name)).join(", ")})`);
    const col = (n: number) => {
      let s = "";
      for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
      return s;
    };
    const book = parsed.sheetNames.map((name) => ({ name, hidden: parsed.hiddenSheets.includes(name) }));
    const sheets = parsed.sheetNames
      .filter((name) => asked === undefined || name === asked)
      .map((name) => {
        const cells = (parsed.sheets[name] ?? []).flatMap((row, r) => row.map((v, c) => (v === "" ? "" : `${col(c)}${r + 1}: ${v}`)).filter(Boolean));
        return `Sheet "${name}":\n${cells.join("\n") || "(empty)"}${parsed.truncatedSheets[name] ? "\n(cells far out were not read)" : ""}`;
      });
    return [sheetList(book), ...sheets].join("\n\n");
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

  // pi hands execute the call's id, its parameters, the abort signal, an update callback and the context (`ctx`, with
  // the chat's model), which office_screenshot reads.
  const guarded = (work: (params: Record<string, unknown>, signal?: AbortSignal, ctx?: ToolContext) => Promise<unknown> | unknown) => async (_callId: unknown, params: Record<string, unknown>, signal?: AbortSignal, _onUpdate?: unknown, ctx?: unknown) => {
    try {
      return await work(params ?? {}, signal instanceof AbortSignal ? signal : undefined, ctx && typeof ctx === "object" ? (ctx as ToolContext) : undefined);
    } catch (e) {
      throw failed(e);
    }
  };

  p.registerTool({
    name: "office_list",
    label: LABELS.office_list,
    guard: GUARDS.office_list,
    description: "List the office documents of your library: every Word (.docx) and spreadsheet (.xlsx) document in your folder (yours), and the ones you were granted (by being mentioned in one of its comments). Each line has the id, title, format, owner, how many grants it holds, its revision, how many people are editing it right now, and which agents have it open.",
    promptSnippet: "List the office documents you own or were granted",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: guarded(() => {
      refreshAll(rootDir());
      const docs = docsForHome(home, rootDir());
      if (!docs.length) return text(`No documents in your office library yet. Make one with office_create.${offNote()}`, { action: "list", home, documents: [] });
      const lines = docs.map((doc) => {
        const users = usersOf(doc.docId);
        const agents = agentsOf(doc.docId);
        return `- ${doc.docId}  "${doc.title}"  ${doc.ext}  owner ${doc.owner === home ? "you" : doc.owner}  ${doc.grants.length} grant${doc.grants.length === 1 ? "" : "s"}  revision ${doc.mtimeMs}${users.length ? `  ${users.length} editing now` : ""}${agents.length ? `  agents in it: ${agents.map((a) => a.name).join(", ")}` : ""}`;
      });
      return text(`${docs.length} document${docs.length === 1 ? "" : "s"}:\n${lines.join("\n")}${offNote()}`, {
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
    description: "Make a new blank office document in your folder (your home, or the project's folder): type \"word\" (a .docx, its one paragraph \"New document\", which you replace) or \"cell\" (an empty .xlsx spreadsheet), as \"<title>.docx\" or \"<title>.xlsx\"; fill it with office_edit, or the person opens it in the editor. It is yours, so every chat of your home sees it; other agents get access only when it mentions them in a comment. A document or file of that name already in your folder is refused.",
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
      // In the chat's own folder, which the tools are only there for: an agent's home or a project's.
      const doc = await createDoc({ title: t, type, folder: home, createdBy: "agent" }, rootDir()); // throws {code:"exists"} on a duplicate title+type or file
      record({ subject: doc.title, reason: `office_create: new ${doc.ext} document ${doc.docId} at ${doc.path}`, chatId });
      return text(`Created "${doc.title}" (id ${doc.docId}, ${doc.ext}, revision ${doc.mtimeMs}) at ${doc.path}. Fill it with office_edit.`, { action: "create", id: doc.docId, title: doc.title, ext: doc.ext, mtimeMs: doc.mtimeMs, owner: doc.owner, path: doc.path });
    }),
  });

  p.registerTool({
    name: "office_read",
    label: LABELS.office_read,
    guard: GUARDS.office_read,
    description: "Read a document of your library by its id, as it stands in the editor right now, with what people typed and have not saved yet. A Word document comes as numbered blocks, \"[3] text\", a paragraph's style and list in brackets (\"[2] (Heading 1) Findings\", \"[5] (bullet) Point\"), a table as \"[4] table\" and its rows \"| a | b |\"; `formatting: true` adds how it looks (styles in use, page setup, headers and footers, footnotes, each paragraph's and run's own formatting, table styles). A spreadsheet comes as the list of its sheets (position, name, hidden or not), then per sheet its cells, \"A1: 2\", a text in quotes, a formula after the value (\"A3: 6 (=A1*A2)\"); `sheet` reads one sheet only. Quote text for office_edit exactly as it is shown here. Comments: office_comments. When the person stopped Office it reads the saved file and says so.",
    promptSnippet: "Read an office document as it stands in the editor",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from office_list or office_create." },
        sheet: { type: "string", description: "A spreadsheet's sheet to read, by its name (all sheets where none is given)." },
        formatting: { type: "boolean" },
      },
      required: ["id"],
    },
    execute: guarded(async ({ id, sheet, formatting }, signal) => {
      const doc = visibleDoc(id);
      if (sheet !== undefined && (typeof sheet !== "string" || doc.ext !== "xlsx")) throw new Refusal("bad_op", doc.ext === "xlsx" ? "sheet is a sheet's name" : "sheet is for spreadsheets; a Word document has none");
      if (formatting !== undefined && typeof formatting !== "boolean") throw new Refusal("bad_op", "formatting is true or false");
      const looks = formatting === true;
      assertMayRead(doc, chatId, home);
      const state = await officeState();
      let said = "";
      let live = false;
      if (state === "running") {
        const mode = mayWrite(doc.path, chatId) ? "edit" : "view";
        const job = doc.ext === "docx" ? { kind: "word.read", args: looks ? { formatting: true } : {} } : { kind: "cell.read", args: sheet ? { sheet } : {} };
        try {
          const read = await oneAtATime(doc.docId, () => seats().run(home, doc.docId, mode, job, { signal }));
          const words = read as WordBlocks;
          const cut = words.formatCut ? `\n\n(formatting is shown up to [${words.formatCut}]: a read gives ${MAX_READ_FORMAT.toLocaleString("en")} characters of it at most; office_screenshot shows the pages after it)` : "";
          said = `${readHeader(doc)}\n\n${doc.ext === "docx" ? formatHead(words) + wordText(words) + (words.truncated ? "\n\n(the document goes on: only its first 200,000 characters were read)" : "") + cut : cellText(read as CellSheets) + (looks ? NO_SHEET_LOOKS : "")}`;
          live = true;
        } catch (e) {
          // Without its editor the agent still reads the file; an edit waits until a Start downloads it. Office found stopped
          // as the editor starts (its network gone): the saved file too, as when it is stopped.
          const code = (e as { code?: string } | null)?.code;
          if (code !== "agent_editor_missing" && code !== "office_stopped") throw e;
          said = `${readHeader(doc, code === "office_stopped" ? "stopped" : "missing")}\n\n${savedText(doc, chatId, home, sheet as string | undefined)}${looks ? NO_SAVED_LOOKS : ""}`;
        }
      } else said = `${readHeader(doc, state)}\n\n${savedText(doc, chatId, home, sheet as string | undefined)}${looks ? NO_SAVED_LOOKS : ""}`;
      if (said.length > MAX_READ_CHARS) said = said.slice(0, MAX_READ_CHARS) + "\n\n[output truncated by office_read: it exceeds 200,000 characters]";
      return text(said, { action: "read", id: doc.docId, ext: doc.ext, mtimeMs: doc.mtimeMs, live });
    }),
  });

  p.registerTool({
    name: "office_edit",
    label: LABELS.office_edit,
    guard: GUARDS.office_edit,
    description: `Edit a document of your library through your own editor in it: people who have it open see your change at once, and nothing they typed is lost. One call is one edit, made whole or not at all (error:partial where even that failed: read again); every quote is checked first against the document as it stands then. Word ops (a quote is the body's text inside one paragraph, as office_read shows it; \`nth\` picks a repeat, from 1): {quote, replacement} replaces text (an empty replacement removes it); {after?, paragraphs, style?} adds paragraphs after the paragraph that holds \`after\`, or at the end (style: a paragraph style of the document, "Heading 1"); {after?, table} adds a table, its first row the header; {remove} removes the paragraph that holds the quote. Formatting: office_format. Spreadsheet ops: {sheet?, range, values}: values for exactly the range, one list per row ("B2:C3" takes [[1, 2], [3, 4]]), on the first sheet where none is named; a text starting with "=" is a formula ("=Data!A1", "='My data'!A1" reach other sheets), "" clears the cell. Sheets, up to 20 a call: {addSheet, position?} (at the end by default), {renameSheet, to}, {moveSheet, position} (a visible sheet), {copySheet, to, position?} (right after it by default; values, formulas, number formats and column widths only), {hideSheet}, {showSheet}, {deleteSheet} (formulas naming it turn #REF!); names match in any case, positions count from 1 as office_read lists them, a name has at most 31 characters and none of []:*?/\\, and one sheet stays visible. After the edit the document is saved, with what people typed until then, and you hear the new revision. A quote that is not found or found twice changes nothing (error:quote_not_found, error:quote_ambiguous): read again and quote more, or give nth.`,
    promptSnippet: "Edit a Word or spreadsheet document live, through your own editor",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from office_list or office_create." },
        ops: {
          type: "array",
          minItems: 1,
          description: "The edits, made in order: Word {quote, replacement} | {after?, paragraphs, style?} | {after?, table} | {remove}; spreadsheet {sheet?, range, values} and the sheet ops.",
          items: {
            type: "object",
            properties: {
              quote: { type: "string", description: "Word: text to replace, exactly as office_read shows it." },
              replacement: { type: "string", description: "Word: what takes the quote's place; empty removes it." },
              after: { type: "string", description: "Word: text of the paragraph the new paragraphs or table go after (they go at the end where none is given)." },
              paragraphs: { type: "array", items: { type: "string" }, description: "Word: new paragraphs, one text each." },
              style: { type: "string", description: "Word: the new paragraphs' style." },
              nth: { type: "integer", minimum: 1, description: "Word: which place of the quote (or after) is meant, from 1." },
              table: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Word: a table's rows of cell texts, the first row the header." },
              remove: { type: "string", description: "Word: text of the paragraph to remove." },
              sheet: { type: "string", description: "Spreadsheet: the sheet's name (the first sheet where none is given)." },
              range: { type: "string", description: "Spreadsheet: the cells, A1 or A1:C3." },
              values: { type: "array", items: { type: "array", items: { type: ["string", "number", "boolean"] } }, description: "Spreadsheet: one list of values per row of the range." },
              // The sheet ops' fields: what each takes is in the tool's description.
              addSheet: { type: "string" },
              renameSheet: { type: "string" },
              moveSheet: { type: "string" },
              copySheet: { type: "string" },
              hideSheet: { type: "string" },
              showSheet: { type: "string" },
              deleteSheet: { type: "string" },
              to: { type: "string", description: "Spreadsheet: the new name." },
              position: { type: "integer", minimum: 1, description: "Spreadsheet: the sheet's place, 1 = first." },
            },
          },
        },
      },
      required: ["id", "ops"],
    },
    execute: guarded(async ({ id, ops }, signal) => {
      const doc = visibleDoc(id);
      const job: EditJob = editJob(doc.ext, ops);
      const kinds = [...new Set(job.args.ops.map((op) => ("quote" in op ? "replace" : "remove" in op ? "remove" : "table" in op ? "table" : "paragraphs" in op ? "insert" : "range" in op ? "cells" : "sheets")))].join(", ");
      return change(doc, job, "office_edit", "Edited", kinds, signal);
    }),
  });

  p.registerTool({
    name: "office_format",
    label: LABELS.office_format,
    guard: GUARDS.office_format,
    description: FORMAT_DESCRIPTION,
    promptSnippet: "Format a Word document: text, paragraphs, lists, styles, tables, pages",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id." },
        ops: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            // The ops' keys: what each takes is in the tool's description, and ops.ts refuses anything else.
            properties: Object.fromEntries(["format", "through", "defineStyle", "type", "basedOn", "change", "formatTable", "cells", "page", "sectionBreak", "after", "pageBreak", "footnote", "text", "toc"].map((k) => [k, {}]).concat([["nth", { type: "integer", minimum: 1 }], ["levels", { type: "integer", minimum: 1, maximum: 9 }], ["set", { type: "object" }]])),
          },
        },
      },
      required: ["id", "ops"],
    },
    execute: guarded(async ({ id, ops }, signal) => {
      const doc = visibleDoc(id);
      const job = formatJob(doc.ext, ops);
      const kinds = [...new Set(job.args.ops.map((op) => ("format" in op ? "text" : "defineStyle" in op ? "style" : "formatTable" in op ? "table" : "page" in op ? "page" : "sectionBreak" in op ? "section" : "footnote" in op ? "footnote" : "toc" in op ? "toc" : "page break")))].join(", ");
      return change(doc, job, "office_format", "Formatted", kinds, signal);
    }),
  });

  /**
   * An office_edit or office_format call of `doc` (`job`, checked by ops.ts) made in the agent's own editor, then
   * saved: the agent hears the new revision, or what came of it. Both write the same way, so only where the agent
   * could have written the file, and only while Office runs; every change an agent may have made is in the audit log.
   */
  async function change(doc: DocMeta, job: EditJob | FormatJob, tool: string, did: string, kinds: string, signal?: AbortSignal) {
    assertMayRead(doc, chatId, home);
    // Written with the portal's rights (and the Document Server's save): only where the agent could have written it.
    if (!mayWrite(doc.path, chatId)) throw new Refusal("read_only", `"${doc.title}" is not a file your agent may change: you can read it, not edit it`);
    const state = await officeState();
    if (state === "stopped") throw new Refusal("office_stopped", `Office is stopped, so "${doc.title}" cannot be edited: ask the person to start it in Settings → Office. office_read reads the saved file meanwhile.`);
    if (state === "starting") throw new Refusal("ds_starting", "Office is still starting (its Document Server sets itself up after its first start, about two minutes): try again in a moment.");

    return oneAtATime(doc.docId, async () => {
      // The revision as it is now: an edit queued behind another starts from that one's.
      const from = refresh(doc.docId, rootDir())?.mtimeMs ?? doc.mtimeMs;
      const n = job.args.ops.length;
      // An op that makes, moves or deletes a sheet waits for the Document Server's answer (seat-page.ts, cellEdit).
      const sheetOps = job.kind === "cell.edit" ? job.args.ops.filter((op) => !("range" in op)).length : 0;
      const what = `${tool}: ${n} op(s) (${kinds}) on ${doc.docId} by ${home}`;
      let made: unknown;
      try {
        made = await seats().run(home, doc.docId, "edit", job, { signal, ...(sheetOps ? { timeoutMs: Math.min(seat.LIMITS.jobMs + SHEET_OP_MS * sheetOps, MAX_EDIT_MS) } : {}) });
      } catch (e) {
        // Cut off: a sheet the call deletes waits hidden under another name until the end (seat-page.ts, cellEdit).
        if (e instanceof seat.SeatError && (e.code === "timeout" || e.code === "editor_closed") && job.kind === "cell.edit" && job.args.ops.some((op) => "deleteSheet" in op)) {
          e = new seat.SeatError(e.code, `${e.message}; a sheet the call deletes may be left as a hidden sheet named "~deleted …", which you can delete`, e.op, e.ran);
        }
        // The editor took the edit and then gave no clear answer: it may be in the document, and reach the file with
        // a later save. Recorded all the same, so that every change an agent may have made is in the audit log.
        if (e instanceof seat.SeatError && e.ran) record({ subject: doc.title, reason: `${what}; ${e.code === "editor_not_saved" ? "made in the editor, not saved yet" : e.code === "partial" ? "failed, and not taken back whole" : "outcome unknown"} (${e.code})`, chatId });
        throw e;
      }
      const changed = (made as { changed?: unknown } | null)?.changed !== false;
      // Comments the edit would have taken away with their text were made again on the new text: their threads, and
      // the chats of those threads, go on under the comments' new GUIDs.
      const movedComments = Array.isArray((made as { moved?: unknown } | null)?.moved) ? ((made as { moved: [string, string][] }).moved) : [];
      if (movedComments.length) docchat.moved(doc.docId, movedComments);
      const movedSaid = movedComments.length ? ` ${movedComments.length === 1 ? "1 comment was" : `${movedComments.length} comments were`} moved onto your new text.` : "";
      const looks = job.kind === "word.format" ? formatSaid(made) : "";
      const watching = usersOf(doc.docId).length;
      const key = seats().keyOf(home, doc.docId);
      const outcome: SaveAfterEdit = key ? await (cfg.save ?? ((k: string) => saveNow(k)))(key) : "failed";
      const now = refresh(doc.docId, rootDir());
      const to = now?.mtimeMs ?? from;
      // Nothing to save after an edit that changed nothing (a cell given the value it holds): the file is as it was.
      const unchanged = outcome === "nothing" && !changed;
      record({ subject: doc.title, reason: `${what}; ${unchanged ? `no change, revision ${to}` : outcome === "saved" || outcome === "same" ? `saved as revision ${to}` : outcome === "copy" ? "the save was kept as a conflict copy" : `not saved yet (${outcome})`}`, chatId });
      const action = tool === "office_format" ? "format" : "edit";
      if (unchanged) return text(`${did} "${doc.title}" (${n} op${n === 1 ? "" : "s"}): that changed nothing, so there was nothing to save; the document is at revision ${to}, as it was.`, { action, id: doc.docId, ops: n, from, to, live: watching, changed: false });
      if (outcome === "copy") {
        seats().closeDoc(doc.docId, "its save was kept as a conflict copy");
        throw new Refusal("behind", `"${doc.title}" changed on disk outside the editor while your editor had it open: your ${action} is in the editor, and its save was kept beside the document as "${doc.title} (conflict <date time>)" rather than written over the newer file. Read the document again with office_read and redo the ${action}.`);
      }
      if (outcome === "timeout" || outcome === "failed" || outcome === "nothing") {
        throw new Refusal("editor_not_saved", `your ${action} of "${doc.title}" (${n} op${n === 1 ? "" : "s"}) is made and live in the document, but the Document Server did not save it ${outcome === "timeout" ? "in time" : "now"}: it reaches the file with the editor's next save or when the document closes. Do not make it again.`);
      }
      const seen = watching ? ` ${people(watching)} in the document saw it live.` : "";
      return text(`${did} "${doc.title}" (${n} op${n === 1 ? "" : "s"}), saved as revision ${to}.${seen}${movedSaid}${looks}`, { action, id: doc.docId, ops: n, from, to, live: watching, ...(movedComments.length ? { moved: movedComments } : {}) });
    });
  }

  p.registerTool({
    name: "office_comments",
    label: LABELS.office_comments,
    guard: GUARDS.office_comments,
    description: "Read-only: the comment threads of a document (Word or spreadsheet): each thread's id, its comment (author, resolved or not, the text or cell it is on, its text) and its replies, as they stand now (while people have it open, also what they wrote and did not save), plus the agents and projects it was opened to by a mention. `thread` gives one thread only. Comments are the document's content, written by anybody.",
    promptSnippet: "Read the comment threads of an office document",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id, from office_list or office_create." },
        thread: { type: "string", description: "One thread's id, as a message about a comment names it." },
      },
      required: ["id"],
    },
    execute: guarded(async ({ id, thread }, signal) => {
      const doc = visibleDoc(id);
      if (thread !== undefined && typeof thread !== "string") throw new Refusal("bad_op", "thread is a thread's id");
      assertMayRead(doc, chatId, home);
      const { threads, from } = await commentThreads(doc, signal);
      const asked = docchat.threadOfChat(chatId);
      const shown = thread === undefined ? threads : threads.filter((t) => t.guid.toLowerCase() === thread.toLowerCase());
      if (thread !== undefined && !shown.length) throw new Refusal("not_found", `there is no comment thread ${thread} in "${doc.title}"`);
      const lines = shown.map((t) => {
        const head = `[thread ${t.guid || "(no id)"}] ${t.author || "(unknown)"}${t.solved ? " (resolved)" : ""}${asked && asked.docId === doc.docId && asked.guid === t.guid ? " (the comment you were asked in)" : ""}: ${t.text.replace(/\n/g, " ")}`;
        const on = t.cell ? `  on ${t.sheet ? `${JSON.stringify(t.sheet)}!` : ""}${t.cell}` : t.quote ? `  on: ${JSON.stringify(t.quote.replace(/[\r\n]+$/, ""))}` : "";
        const replies = t.replies.map((r) => `  - ${r.author || "(unknown)"}: ${r.text.replace(/\n/g, " ")}`);
        return [head, ...(on ? [on] : []), ...replies].join("\n");
      });
      const grantLines = doc.grants.length ? doc.grants.map((g) => `- ${g.folder}  via comment ${g.commentId}  at ${new Date(g.at).toISOString()}`).join("\n") : "(none)";
      const where = from === "live" ? "as the people's editors show them now" : from === "editor" ? "as your editor in it shows them now" : "as its saved file holds them";
      let said = `"${doc.title}" (id ${doc.docId}): comment threads ${where}\n\nThreads (${shown.length}):\n${lines.join("\n") || "(none)"}\n\nGrants:\n${grantLines}`;
      // Same cap and marker as office_read: aggregated comment text is unbounded input and must not blow the agent context.
      if (said.length > MAX_READ_CHARS) said = said.slice(0, MAX_READ_CHARS) + "\n\n[output truncated by office_comments: it exceeds 200,000 characters]";
      said += offNote();
      // details lands in the portal tool-event store and the web transcript -- bound it like office_read does
      // (100 at 500 chars each, worst case ~50 KB); commentCount keeps the true total.
      const detailComments = shown.slice(0, 100).map((t) => ({ id: t.guid, author: t.author, text: t.text.slice(0, 500), solved: t.solved, replies: t.replies.length }));
      return text(said, { action: "comments", id: doc.docId, from, comments: detailComments, grants: doc.grants, commentCount: shown.length });
    }),
  });

  p.registerTool({
    name: "office_screenshot",
    label: LABELS.office_screenshot,
    guard: GUARDS.office_screenshot,
    description:
      "A picture (JPEG) of a document of your library as your editor shows it now, with the text it shows: a Word page, or a spreadsheet range with its column letters and row numbers. For how it looks (layout, formatting, tables); office_read is cheaper for text. Word: `page` (default 1) or the page holding `quote` (`nth` picks a repeat). Spreadsheet: `sheet` (default the first visible) and `range` (default the used range from A1, as much as fits), at 100 %, else 75 %; larger is refused with the part that fits. 1,024 px; `large` as large as the editor draws it, at most 1,568. A picture costs about 1,000-1,600 input tokens on every later turn.",
    promptSnippet: "See a Word page or a spreadsheet range as your editor shows it",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document's id." },
        page: { type: "integer", minimum: 1 },
        quote: { type: "string" },
        nth: { type: "integer", minimum: 1 },
        sheet: { type: "string" },
        range: { type: "string" },
        large: { type: "boolean" },
      },
      required: ["id"],
    },
    execute: guarded(async (params, signal, ctx) => {
      // Before anything is done: a model that cannot see the picture gets none.
      const input = ctx?.model?.input;
      if (Array.isArray(input) && !input.includes("image")) throw new Refusal("no_images", `${ctx?.model?.name || ctx?.model?.id || "This model"} cannot see images; office_read gives the document's text`);
      const doc = visibleDoc(params.id);
      if (params.large !== undefined && typeof params.large !== "boolean") throw new Refusal("bad_op", "large is true or false");
      const job = viewJob(doc.ext, params);
      assertMayRead(doc, chatId, home);
      const state = await officeState();
      if (state === "stopped") throw new Refusal("office_stopped", `Office is stopped, so there is no editor to take a picture of "${doc.title}" in: ask the person to start it in Settings → Office. office_read reads the saved file meanwhile.`);
      if (state === "starting") throw new Refusal("ds_starting", "Office is still starting (its Document Server sets itself up after its first start, about two minutes): try again in a moment.");
      const mode = mayWrite(doc.path, chatId) ? "edit" : "view";
      let taken: Awaited<ReturnType<ToolsSeat["shot"]>>;
      try {
        taken = await oneAtATime(doc.docId, () => seats().shot(home, doc.docId, mode, job, { signal, large: params.large === true }));
      } catch (e) {
        // A quote here changes nothing: the edit's advice is not this one's.
        if (e instanceof seat.SeatError && (e.code === "quote_not_found" || e.code === "quote_ambiguous")) throw new Refusal(e.code, `${e.message}. Read the document with office_read and quote it as it stands.`);
        throw e;
      }
      const { located, image } = taken;
      const bytes = Buffer.byteLength(image.data, "base64");
      let said: string;
      let shown: Record<string, unknown>;
      if (doc.ext === "docx") {
        const page = Number(located.page);
        const pages = image.pages ?? Number(located.pages);
        const blocks = located as unknown as WordBlocks & { first?: number };
        said = `Page ${page} of ${pages} of "${doc.title}" (id ${doc.docId}), as your editor shows it now. Its text:\n\n${wordText(blocks, blocks.first ?? 1)}${blocks.truncated ? `\n(the text is cut here: a picture gives ${MAX_SHOWN_TEXT.toLocaleString("en")} characters of text at most; office_read gives all of it)` : ""}`;
        shown = { page, pages };
      } else {
        const zoom = Math.round((image.zoom ?? Number(located.zoom)) * 100);
        const cells = Array.isArray(located.cells) ? (located.cells as { a: string; v: unknown; f?: string }[]) : [];
        const cut = located.cut === true ? ` The sheet's used range is ${located.used}: this is the part that fits from A1; take the rest with range.` : "";
        const hidden = located.hidden === true ? " Its hidden rows and columns are not in the picture, and their cells are not listed." : "";
        const more = located.truncated === true ? `\n(not all of the cells it shows are listed: a picture gives ${MAX_SHOWN_TEXT.toLocaleString("en")} characters of text at most; office_read gives them)` : "";
        said = `Sheet ${JSON.stringify(located.sheet)} ${located.range} at ${zoom} %, as your editor shows it now.${cut}${hidden} Its cells:\n\n${cellLines(cells) || "(empty)"}${more}`;
        shown = { sheet: located.sheet, range: located.range, zoom };
      }
      return {
        content: [
          { type: "text", text: said },
          { type: "image", data: image.data, mimeType: "image/jpeg" },
        ],
        details: { action: "screenshot", id: doc.docId, ...shown, width: image.width, height: image.height, bytes },
      };
    }),
  });

  /**
   * A document's comment threads where they are now: what the people's editors reported while a person is in it (the
   * session's comments, unsaved ones among them, read with no editor of the agent's opened); else, while the agent's
   * own editor is in it, what that editor has; else the saved file.
   */
  async function commentThreads(doc: DocMeta, signal?: AbortSignal): Promise<{ threads: CommentThread[]; from: "live" | "editor" | "file" }> {
    const pages = usersOf(doc.docId).length ? docchat.liveComments(doc.docId) : null;
    if (pages) {
      return {
        from: "live",
        threads: pages.map((c) => ({ guid: c.guid, author: c.author ?? "", ...(c.userId ? { userId: c.userId } : {}), text: c.text, solved: Boolean(c.solved), ...(c.quote ? { quote: c.quote } : {}), replies: (c.replies ?? []).map((r) => ({ author: r.author ?? "", text: r.text })) })),
      };
    }
    if (seats().keyOf(home, doc.docId) && (await officeState()) === "running") {
      const mode = mayWrite(doc.path, chatId) ? "edit" : "view";
      const read = (await oneAtATime(doc.docId, () => seats().run(home, doc.docId, mode, { kind: doc.ext === "docx" ? "word.comments" : "cell.comments", args: {} }, { signal }))) as {
        comments?: { guid?: string; sessionId?: string; author: string; userId: string; text: string; solved: boolean; quote: string; replies: { author: string; text: string }[] }[];
      };
      return {
        from: "editor",
        threads: (read.comments ?? []).map((c) => ({ guid: c.guid ?? c.sessionId ?? "", author: c.author, userId: c.userId, text: c.text, solved: c.solved, ...(c.quote ? { quote: c.quote } : {}), replies: c.replies.map((r) => ({ author: r.author, text: r.text })) })),
      };
    }
    const buf = readBytes(doc, chatId, home);
    return { from: "file", threads: doc.ext === "docx" ? docxThreads(buf) : xlsxThreads(buf) };
  }
}
