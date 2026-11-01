/**
 * The ops of office_edit, checked before anything reaches the editor: their shapes, that they fit the document's
 * format, and the caps (MAX_OPS, MAX_ARGS_BYTES). What they find in the document is checked by the command itself
 * (seat-page.ts, WORD_MODEL_SRC), on the document as it stands when the command runs; ops.test runs that same source.
 *
 * Word ops (a quote is found in the body's text only, not in headers, footers, footnotes or a table of contents; one
 * found more than once needs `nth`, from 1, in reading order):
 * - `{quote, replacement, nth?}`: the quote's text (inside one paragraph) becomes the replacement;
 * - `{after?, nth?, paragraphs, style?}`: new paragraphs after the paragraph that holds `after`, or at the end, in any
 *   paragraph style the document has (the command checks it);
 * - `{after?, nth?, table}`: a table (its first row the header) at the same place;
 * - `{remove, nth?}`: the paragraph that holds the quote goes.
 * office_format's ops (how a Word document looks) are formatJob's, below; an op of the one tool given to the other is
 * refused with the other's name.
 * Excel ops: `{sheet?, range, values}`: the values into the range (A1 or A1:B2, on the first sheet where none is
 * named), one row of values per row of the range; a string that starts with "=" is a formula, "" clears the cell.
 * And the sheets themselves (SheetOp), a sheet named case-insensitively as Excel does, a position counted from 1:
 * - `{addSheet, position?}`: a new empty sheet of that name, at the position or after the last sheet;
 * - `{renameSheet, to}`, `{moveSheet, position}` (a visible sheet), `{copySheet, to, position?}` (the copy right after
 *   its sheet where no position is given), `{hideSheet}`, `{showSheet}`, `{deleteSheet}`; MAX_SHEET_OPS of them a call.
 * A new name must be one Excel takes (sheetNameProblem); whether the sheets named are there, a new name is free, a
 * position is inside the workbook and a visible sheet is left is checked by the command (seat-page.ts,
 * SHEET_MODEL_SRC), on the sheets as they stand when it runs.
 */
export type WordOp =
  | { quote: string; replacement: string; nth?: number }
  | { after?: string; nth?: number; paragraphs: string[]; style?: string }
  | { after?: string; nth?: number; table: string[][] }
  | { remove: string; nth?: number };
export type CellValue = string | number | boolean;
export type CellOp = { sheet?: string; range: string; values: CellValue[][] };
export type SheetOp =
  | { addSheet: string; position?: number }
  | { renameSheet: string; to: string }
  | { moveSheet: string; position: number }
  | { copySheet: string; to: string; position?: number }
  | { hideSheet: string }
  | { showSheet: string }
  | { deleteSheet: string };
/** Rows or columns of a sheet made (before the first named) or taken away, as "5:6" or "C:D": the first one (from 0)
 * and how many. A delete cannot be taken back, so it comes after every op that can (lastWithoutInverse). */
export type LineOp =
  | { sheet?: string; insertRows: string; from: number; count: number }
  | { sheet?: string; insertColumns: string; from: number; count: number }
  | { sheet?: string; deleteRows: string; from: number; count: number }
  | { sheet?: string; deleteColumns: string; from: number; count: number };
export type EditJob = { kind: "word.edit"; args: { ops: WordOp[] } } | { kind: "cell.edit"; args: { ops: (CellOp | SheetOp | LineOp)[] } };
/** The row and column ops of office_edit, by their key: rows or columns. */
export const LINE_OPS: Record<string, "rows" | "columns"> = { insertRows: "rows", insertColumns: "columns", deleteRows: "rows", deleteColumns: "columns" };

/** The sheet ops, by the key that names each: the other keys it may have (`with`), and those of them it must (`needs`). */
export const SHEET_OPS: Record<string, { with: string[]; needs: string[] }> = {
  addSheet: { with: ["position"], needs: [] },
  renameSheet: { with: ["to"], needs: ["to"] },
  moveSheet: { with: ["position"], needs: ["position"] },
  copySheet: { with: ["to", "position"], needs: ["to"] },
  hideSheet: { with: [], needs: [] },
  showSheet: { with: [], needs: [] },
  deleteSheet: { with: [], needs: [] },
};
/** The longest name Excel takes for a sheet, and the characters it refuses in one. */
export const MAX_SHEET_NAME = 31;
const SHEET_NAME_BANNED = /[[\]:*?/\\]/;

/** The most ops one call carries, and the most their arguments may take as JSON. */
export const MAX_OPS = 200;
/** The most sheet ops one call carries: each waits for the Document Server's answer (seat-page.ts, cellEdit), and an
 * edit has two minutes (tools.ts, MAX_EDIT_MS). */
export const MAX_SHEET_OPS = 20;
export const MAX_ARGS_BYTES = 1024 * 1024;
/** The largest sheet address: XFD1048576. */
const MAX_COLS = 16_384;
const MAX_ROWS = 1_048_576;

/** A refusal of the ops, with the op's index (from 0) where one is to blame. */
export class OpError extends Error {
  constructor(public readonly code: "bad_op" | "unsupported_format", message: string, public readonly op?: number) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (s: string) => !/[\r\n]/.test(s);

/** The ops of a call for a document of `ext`, checked: the job the seat runs, or an OpError. */
export function editJob(ext: "docx" | "xlsx", ops: unknown): EditJob {
  capped(ops);
  if (ext === "docx") return { kind: "word.edit", args: { ops: (ops as unknown[]).map(wordOp) } };
  const cells = (ops as unknown[]).map(cellOp);
  const sheetOps = cells.filter(isSheetOp).length;
  if (sheetOps > MAX_SHEET_OPS) throw new OpError("bad_op", `one call takes at most ${MAX_SHEET_OPS} sheet ops (got ${sheetOps}); split the edit into several calls`);
  lastWithoutInverse(cells, (op) => "deleteRows" in op || "deleteColumns" in op);
  // An insert taken back reads what was written into its rows or columns, and a delete moves as many: as many lines a
  // call as a format reads cells.
  const lines = cells.reduce((n, op) => n + ("count" in op ? op.count : 0), 0);
  if (lines > MAX_FORMAT_CELLS) throw new OpError("bad_op", `one call inserts and deletes ${MAX_FORMAT_CELLS.toLocaleString("en")} rows and columns at most (got ${lines.toLocaleString("en")}); split it into several calls`);
  return { kind: "cell.edit", args: { ops: cells } };
}

/** Whether an op of a spreadsheet edit makes, moves, hides or deletes a sheet: it waits for the Document Server. */
export function isSheetOp(op: object): op is SheetOp {
  return Object.keys(SHEET_OPS).some((k) => k in op);
}

/**
 * Ops that cannot be taken back (rows and columns deleted) come after every op that can: where a later op fails, the
 * ones before it are taken back, which such an op cannot be (seat-page.ts, cellEdit).
 */
function lastWithoutInverse<T>(ops: T[], none: (op: T) => boolean): void {
  const first = ops.findIndex(none);
  if (first === -1) return;
  const later = ops.findIndex((op, k) => k > first && !none(op));
  if (later !== -1) throw new OpError("bad_op", `op ${first + 1} cannot be taken back once made (${describeNone(ops[first] as object)}), so it goes after every op that can: put it last in the call (op ${later + 1} comes after it), or make it in a call of its own`, first);
}
const describeNone = (op: object) => ("deleteRows" in op ? "deleted rows" : "deleteColumns" in op ? "deleted columns" : "it has no inverse");

/** The list of ops is one, of MAX_OPS at most, and its JSON within MAX_ARGS_BYTES. */
function capped(ops: unknown): void {
  if (!Array.isArray(ops) || ops.length === 0) throw new OpError("bad_op", "ops is a non-empty list of edits");
  if (ops.length > MAX_OPS) throw new OpError("bad_op", `one call takes at most ${MAX_OPS} ops (got ${ops.length}); split the edit into several calls`);
  if (Buffer.byteLength(JSON.stringify(ops)) > MAX_ARGS_BYTES) throw new OpError("bad_op", `the ops take more than ${MAX_ARGS_BYTES / 1024} KB; split the edit into several calls`);
}

/** `nth`, where an op has it: which of the places its quote is found it means, from 1 in reading order. */
function nthOf(op: Record<string, unknown>, n: number, i: number): { nth?: number } {
  if (op.nth === undefined) return {};
  if (typeof op.nth !== "number" || !Number.isSafeInteger(op.nth) || op.nth < 1) throw new OpError("bad_op", `op ${n}: nth is a whole number from 1 (the first place the quote is found, in reading order)`, i);
  return { nth: op.nth };
}

const WORD_SHAPES = "{quote, replacement, nth?}, {after?, nth?, paragraphs, style?}, {after?, nth?, table} and {remove, nth?}";

function wordOp(op: unknown, i: number): WordOp {
  const n = i + 1;
  if (!isObject(op)) throw new OpError("bad_op", `op ${n} is not an object`, i);
  if ("range" in op || "values" in op) throw new OpError("unsupported_format", `op ${n} is a spreadsheet edit ({range, values}), and this is a Word document: its ops are ${WORD_SHAPES}`, i);
  const looks = FORMAT_SHAPES.find((k) => k in op);
  if (looks) throw new OpError("bad_op", `op ${n}: \`${looks}\` is an office_format op (how the document looks): make it with office_format`, i);
  const shapes = ["quote", "paragraphs", "table", "remove"].filter((k) => k in op);
  if (shapes.length !== 1) throw new OpError("bad_op", `op ${n} must be exactly one of ${WORD_SHAPES} (it has ${shapes.length ? shapes.join(" and ") : "none of them"})`, i);
  const text = (key: string, what: string, empty = false) => {
    const v = op[key];
    if (typeof v !== "string" || (!empty && v === "")) throw new OpError("bad_op", `op ${n}: ${key} is ${what}`, i);
    if (!oneLine(v)) throw new OpError("bad_op", `op ${n}: ${key} may not hold a line break (a quote lies inside one paragraph; new paragraphs are an insert's)`, i);
    return v;
  };
  const only = (keys: string[]) => {
    const extra = Object.keys(op).filter((k) => !keys.includes(k));
    if (extra.length) throw new OpError("bad_op", `op ${n}: ${extra.map((k) => JSON.stringify(k)).join(", ")} is not part of this op`, i);
  };
  const after = () => ("after" in op && op.after !== undefined ? { after: text("after", "the text of the paragraph to insert after (not empty)") } : {});
  // nth picks among the places of the op's quote (`after` of an insert): without one it means nothing.
  const nth = () => {
    if (op.nth !== undefined && !("quote" in op || "remove" in op || op.after !== undefined)) throw new OpError("bad_op", `op ${n}: nth picks among the places \`after\` is found: give after with it`, i);
    return nthOf(op, n, i);
  };
  if ("quote" in op) {
    only(["quote", "replacement", "nth"]);
    return { quote: text("quote", "the text to replace, exactly as office_read shows it (not empty)"), replacement: text("replacement", "the text that takes its place (empty removes the quote)", true), ...nth() };
  }
  if ("remove" in op) {
    only(["remove", "nth"]);
    return { remove: text("remove", "text of the paragraph to remove (not empty)"), ...nth() };
  }
  if ("paragraphs" in op) {
    only(["after", "nth", "paragraphs", "style"]);
    const list = op.paragraphs;
    if (!Array.isArray(list) || list.length === 0 || !list.every((p) => typeof p === "string")) throw new OpError("bad_op", `op ${n}: paragraphs is a non-empty list of texts, one per paragraph`, i);
    if (!list.every(oneLine)) throw new OpError("bad_op", `op ${n}: a paragraph may not hold a line break: give each paragraph as an item of its own`, i);
    const style = op.style !== undefined ? { style: text("style", "the name of a paragraph style the document has, as office_read shows it (\"Heading 1\")") } : {};
    return { ...after(), ...nth(), paragraphs: list as string[], ...style };
  }
  only(["after", "nth", "table"]);
  const rows = op.table;
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every((r) => Array.isArray(r) && r.length > 0 && r.every((c) => typeof c === "string"))) throw new OpError("bad_op", `op ${n}: table is a non-empty list of rows, each a non-empty list of cell texts (the first row is the header)`, i);
  if (rows.some((r) => (r as unknown[]).length !== (rows[0] as unknown[]).length)) throw new OpError("bad_op", `op ${n}: every row of the table has the same number of cells (the first has ${(rows[0] as unknown[]).length})`, i);
  if (!rows.every((r) => (r as string[]).every(oneLine))) throw new OpError("bad_op", `op ${n}: a cell's text may not hold a line break`, i);
  return { ...after(), ...nth(), table: rows as string[][] };
}

/** What office_screenshot is to show, as the locate command takes it (seat-page.ts VIEW_LOCATE). */
export type ViewJob = {
  kind: "view.locate";
  args: { kind: "word"; page?: number; quote?: string; nth?: number } | { kind: "cell"; sheet?: string; range?: { col: number; row: number; cols: number; rows: number } };
};

/** The longest quote office_screenshot looks for. */
const MAX_VIEW_QUOTE = 1000;

/** office_screenshot's parameters for a document of `ext`, checked: the locate job, or an OpError. Word takes `page`
 * (from 1) or `quote` (with `nth`, from 1); a spreadsheet `sheet` and `range`. */
export function viewJob(ext: "docx" | "xlsx", params: Record<string, unknown>): ViewJob {
  const given = (key: string) => params[key] !== undefined;
  const whole = (key: string) => {
    const v = params[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new OpError("bad_op", `${key} is a whole number from 1`);
    return v;
  };
  if (ext === "docx") {
    const other = ["sheet", "range"].filter(given);
    if (other.length) throw new OpError("unsupported_format", `${other.join(" and ")} ${other.length === 1 ? "is" : "are"} for spreadsheets; a Word document is shown by page or quote`);
    if (given("page") && given("quote")) throw new OpError("bad_op", "give page or quote, not both");
    if (given("nth") && !given("quote")) throw new OpError("bad_op", "nth picks among the places a quote is found: give quote with it");
    if (given("quote")) {
      const quote = params.quote;
      if (typeof quote !== "string" || quote === "" || !oneLine(quote) || quote.length > MAX_VIEW_QUOTE) throw new OpError("bad_op", `quote is text of the page to show, as office_read shows it (one line, at most ${MAX_VIEW_QUOTE} characters)`);
      return { kind: "view.locate", args: { kind: "word", quote, ...(given("nth") ? { nth: whole("nth") } : {}) } };
    }
    return { kind: "view.locate", args: { kind: "word", page: given("page") ? whole("page") : 1 } };
  }
  const other = ["page", "quote", "nth"].filter(given);
  if (other.length) throw new OpError("unsupported_format", `${other.join(" and ")} ${other.length === 1 ? "is" : "are"} for Word documents; a spreadsheet is shown by sheet and range`);
  const args: { kind: "cell"; sheet?: string; range?: { col: number; row: number; cols: number; rows: number } } = { kind: "cell" };
  if (given("sheet")) {
    if (typeof params.sheet !== "string" || params.sheet === "") throw new OpError("bad_op", "sheet is a sheet's name");
    args.sheet = params.sheet;
  }
  if (given("range")) {
    const range = typeof params.range === "string" ? parseRange(params.range) : null;
    if (!range) throw new OpError("bad_op", `range is cells as A1:H30 (got ${JSON.stringify(params.range)})`);
    args.range = range;
  }
  return { kind: "view.locate", args };
}

/** An A1 address or range ("B2", "$B$2", "A1:C3", either corner first): its first column and row (from 0) and size. */
export function parseRange(range: string): { col: number; row: number; cols: number; rows: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?$/.exec(range.trim().toUpperCase());
  if (!m) return null;
  const col = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const c1 = col(m[1]);
  const r1 = Number(m[2]) - 1;
  const c2 = m[3] ? col(m[3]) : c1;
  const r2 = m[4] ? Number(m[4]) - 1 : r1;
  if (r1 < 0 || r2 < 0 || Math.max(c1, c2) >= MAX_COLS || Math.max(r1, r2) >= MAX_ROWS) return null;
  return { col: Math.min(c1, c2), row: Math.min(r1, r2), cols: Math.abs(c2 - c1) + 1, rows: Math.abs(r2 - r1) + 1 };
}

/** Why Excel would not take `name` for a sheet, or null where it would: 1 to 31 characters, none of []:*?/\, no
 * apostrophe first or last, no line break or other control character, and not "History" (Excel keeps that one). */
export function sheetNameProblem(name: string): string | null {
  if (name.length === 0) return "a sheet's name is not empty";
  if (name.length > MAX_SHEET_NAME) return `a sheet's name has at most ${MAX_SHEET_NAME} characters (${JSON.stringify(name)} has ${name.length})`;
  if (SHEET_NAME_BANNED.test(name)) return `a sheet's name may not hold any of [ ] : * ? / \\ (got ${JSON.stringify(name)})`;
  if (/[\u0000-\u001f\u007f]/.test(name)) return `a sheet's name may not hold a line break or another control character (got ${JSON.stringify(name)})`;
  if (name.startsWith("'") || name.endsWith("'")) return `a sheet's name may not start or end with an apostrophe (got ${JSON.stringify(name)})`;
  if (name.toLowerCase() === "history") return `"History" is a name Excel keeps for itself`;
  return null;
}

const SHEET_SHAPES = "{sheet?, range, values}, {sheet?, insertRows | insertColumns | deleteRows | deleteColumns}, {addSheet, position?}, {renameSheet, to}, {moveSheet, position}, {copySheet, to, position?}, {hideSheet}, {showSheet} and {deleteSheet}";

function sheetOp(op: Record<string, unknown>, key: string, i: number): SheetOp {
  const n = i + 1;
  const shape = SHEET_OPS[key];
  const extra = Object.keys(op).filter((k) => k !== key && !shape.with.includes(k));
  if (extra.length) throw new OpError("bad_op", `op ${n}: ${extra.map((k) => JSON.stringify(k)).join(", ")} is not part of {${[key, ...shape.with.map((k) => (shape.needs.includes(k) ? k : `${k}?`))].join(", ")}}`, i);
  const name = (k: string, made: boolean) => {
    const v = op[k];
    if (typeof v !== "string" || v === "") throw new OpError("bad_op", `op ${n}: ${k} is ${made ? "the new sheet's name" : "a sheet's name"}`, i);
    const problem = made ? sheetNameProblem(v) : null;
    if (problem) throw new OpError("bad_op", `op ${n}: ${problem}`, i);
    return v;
  };
  const out: Record<string, unknown> = { [key]: name(key, key === "addSheet") };
  if (shape.with.includes("to")) out.to = name("to", true);
  if (shape.with.includes("position") && (op.position !== undefined || shape.needs.includes("position"))) {
    const at = op.position;
    if (typeof at !== "number" || !Number.isInteger(at) || at < 1) throw new OpError("bad_op", `op ${n}: position is a whole number from 1 (1 is the first sheet)`, i);
    out.position = at;
  }
  return out as SheetOp;
}

function cellOp(op: unknown, i: number): CellOp | SheetOp | LineOp {
  const n = i + 1;
  if (!isObject(op)) throw new OpError("bad_op", `op ${n} is not an object`, i);
  if (["quote", "paragraphs", "table", "remove", ...FORMAT_SHAPES.filter((k) => k !== "format" && k !== "set")].some((k) => k in op)) throw new OpError("unsupported_format", `op ${n} is a Word edit, and this is a spreadsheet: its ops are ${SHEET_SHAPES}`, i);
  const looks = SHEET_FORMAT_SHAPES.find((k) => k in op);
  if (looks) throw new OpError("bad_op", `op ${n}: \`${looks}\` is an office_format op (how the sheet looks): make it with office_format`, i);
  const sheetKeys = Object.keys(SHEET_OPS).filter((k) => k in op);
  const lineKeys = Object.keys(LINE_OPS).filter((k) => k in op);
  if (sheetKeys.length + lineKeys.length > 1 || (sheetKeys.length && ("range" in op || "values" in op || "sheet" in op)) || (lineKeys.length && ("range" in op || "values" in op))) throw new OpError("bad_op", `op ${n} must be exactly one of ${SHEET_SHAPES} (it has ${[...sheetKeys, ...lineKeys, ...["sheet", "range", "values"].filter((k) => k in op)].join(" and ")})`, i);
  if (sheetKeys.length) return sheetOp(op, sheetKeys[0], i);
  if (lineKeys.length) return lineOp(op, lineKeys[0], i);
  const extra = Object.keys(op).filter((k) => !["sheet", "range", "values"].includes(k));
  if (extra.length) throw new OpError("bad_op", `op ${n}: ${extra.map((k) => JSON.stringify(k)).join(", ")} is not part of a spreadsheet op (they are ${SHEET_SHAPES})`, i);
  if ("sheet" in op && op.sheet !== undefined && (typeof op.sheet !== "string" || op.sheet === "")) throw new OpError("bad_op", `op ${n}: sheet is a sheet's name`, i);
  const range = typeof op.range === "string" ? parseRange(op.range) : null;
  if (!range) throw new OpError("bad_op", `op ${n}: range is an A1 address or range like "B2" or "A1:C3" (got ${JSON.stringify(op.range)})`, i);
  const values = op.values;
  if (!Array.isArray(values) || !values.every((r) => Array.isArray(r))) throw new OpError("bad_op", `op ${n}: values is a list of rows, each a list of values`, i);
  if (values.length !== range.rows || values.some((r) => (r as unknown[]).length !== range.cols)) throw new OpError("bad_op", `op ${n}: ${op.range} is ${range.rows} row(s) of ${range.cols} cell(s), and values must be exactly that (one list per row)`, i);
  for (const row of values as unknown[][]) {
    for (const v of row) {
      if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) continue;
      throw new OpError("bad_op", `op ${n}: a value is text, a number or true/false (got ${JSON.stringify(v) ?? String(v)})`, i);
    }
  }
  return { ...(op.sheet !== undefined ? { sheet: op.sheet as string } : {}), range: (op.range as string).trim().toUpperCase(), values: values as CellValue[][] };
}

/** `{sheet?, insertRows: "5:6"}` and the like: rows ("5", "5:6") or columns ("C", "C:D") of a sheet. */
function lineOp(op: Record<string, unknown>, key: string, i: number): LineOp {
  const n = i + 1;
  const extra = Object.keys(op).filter((k) => k !== key && k !== "sheet");
  if (extra.length) throw new OpError("bad_op", `op ${n}: ${extra.map((k) => JSON.stringify(k)).join(", ")} is not part of {sheet?, ${key}}`, i);
  if (op.sheet !== undefined && (typeof op.sheet !== "string" || op.sheet === "")) throw new OpError("bad_op", `op ${n}: sheet is a sheet's name`, i);
  const kind = LINE_OPS[key];
  const lines = typeof op[key] === "string" ? parseLines(op[key] as string, kind) : null;
  if (!lines) throw new OpError("bad_op", `op ${n}: ${key} is ${kind === "rows" ? 'rows by their numbers, "5" or "5:7"' : 'columns by their letters, "C" or "C:E"'} (got ${JSON.stringify(op[key])})`, i);
  return { ...(op.sheet !== undefined ? { sheet: op.sheet as string } : {}), [key]: lines.text, from: lines.from, count: lines.count } as LineOp;
}

/** Rows ("5", "5:7") or columns ("C", "C:E"), either end first, `$` anchors taken: the first (from 0), how many, and
 * the text as the command names them ("5:7", "C:E"); null where it is neither. */
export function parseLines(v: string, kind: "rows" | "columns"): { from: number; count: number; text: string } | null {
  const t = v.trim().toUpperCase().replace(/\$/g, "");
  const m = kind === "rows" ? /^(\d{1,7})(?::(\d{1,7}))?$/.exec(t) : /^([A-Z]{1,3})(?::([A-Z]{1,3}))?$/.exec(t);
  if (!m) return null;
  const at = (x: string) => (kind === "rows" ? Number(x) - 1 : [...x].reduce((k, ch) => k * 26 + ch.charCodeAt(0) - 64, 0) - 1);
  const a = at(m[1]);
  const b = m[2] ? at(m[2]) : a;
  const most = kind === "rows" ? MAX_ROWS : MAX_COLS;
  if (Math.min(a, b) < 0 || Math.max(a, b) >= most) return null;
  const from = Math.min(a, b);
  const count = Math.abs(b - a) + 1;
  const name = (k: number) => (kind === "rows" ? String(k + 1) : colLetters(k));
  return { from, count, text: `${name(from)}:${name(from + count - 1)}` };
}
const colLetters = (n: number) => {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/* ------------------------------------------------------------------ */
/* office_format (Word)                                                 */
/* ------------------------------------------------------------------ */

/**
 * office_format's ops for a Word document (how it looks; office_edit changes what is in it). Each names its place by a
 * quote of the body's text, as office_edit's do (`nth` picks a repeat), and carries what to set in `set`. They are
 * checked here (shape, keys, types, values, units) and handed to the command (seat-page.ts, `word.format`) with every
 * value in the unit the builder API takes: lengths in twips, font sizes in half-points, colours as {r, g, b}. What
 * they find in the document (quotes, styles, tables, sections, headers) the command checks before it changes anything.
 * - `{format, through?, nth?, set}`: the text from the start of `format` to the end of `through` (the quote itself by
 *   default); its text keys go to that text, its paragraph keys to every paragraph it touches;
 * - `{defineStyle, type?, basedOn?, change?, set}`: a new paragraph (or "character") style; an existing one changes
 *   only with `change: true`;
 * - `{formatTable, nth?, cells?, set}`: the table that holds the quote, or its cells ("A1:C2", a row's cells counted
 *   as office_read shows them);
 * - `{page, nth?, set}`: page setup of the section that holds the quote ("*": every section);
 * - `{sectionBreak, nth?, type?}`: a new section after the paragraph that holds the quote;
 * - `{after?, nth?, pageBreak: true}`: a page break after the paragraph, or at the end;
 * - `{footnote, nth?, text}`: a footnote at the end of the quote;
 * - `{after?, nth?, toc: true, levels?}`: a table of contents of the headings 1 to `levels` (3).
 */
export type FormatJob = { kind: "word.format"; args: { ops: FormatOp[] } };
export type Rgb = { r: number; g: number; b: number };
/** A border side as the builder draws it: DS 10.0 takes "single" and "none" only (measured: "double", "dotted" and
 * the others come out as none). `size` in eighths of a point. */
export type Border = { type: "single"; size: number; color: Rgb } | { type: "none" };
export type TextSet = {
  font?: string;
  /** Half-points. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** "superscript", "subscript" or "baseline" (one of the two given false). */
  vertAlign?: "superscript" | "subscript" | "baseline";
  color?: Rgb | "auto";
  highlight?: string;
  /** A URL, or "" to take the link off. */
  link?: string;
  style?: string;
  clear?: true;
};
export type ParaSet = {
  align?: "left" | "center" | "right" | "justify";
  /** Twips. */
  spaceBefore?: number;
  spaceAfter?: number;
  /** A multiple (`rule` "auto", `line` in 240ths), or exact twips. */
  lineSpacing?: { line: number; rule: "auto" | "exact" };
  indentLeft?: number;
  indentRight?: number;
  firstLine?: number;
  list?: "bullet" | "number" | "none";
  /** 0-8 (the agent's 1-9). */
  level?: number;
  listStart?: number;
  pageBreakBefore?: boolean;
  keepWithNext?: boolean;
};
export type CellSet = { borders?: Partial<Record<"top" | "bottom" | "left" | "right" | "insideH" | "insideV", Border>>; fill?: Rgb | "none"; align?: ParaSet["align"]; valign?: "top" | "center" | "bottom"; rowHeight?: number; merge?: true };
export type TableSet = { tableStyle?: string; width?: { percent: number } | { twips: number }; columnWidths?: number[]; headerRows?: number };
/** A header's or footer's text: its pieces, the page number and count as fields. */
export type HeaderPart = { text: string } | { field: "page" | "pages" };
export type PageSet = { size?: { width: number; height: number }; orientation?: "portrait" | "landscape"; margins?: { top: number; right: number; bottom: number; left: number }; header?: HeaderPart[]; footer?: HeaderPart[]; differentFirstPage?: boolean; replace?: true };
export type FormatOp =
  | { format: string; through?: string; nth?: number; text?: TextSet; para?: ParaSet }
  | { defineStyle: string; type: "paragraph" | "character"; basedOn?: string; change?: true; text?: TextSet; para?: ParaSet }
  | { formatTable: string; nth?: number; cells?: { col: number; row: number; cols: number; rows: number }; table?: TableSet; cell?: CellSet; text?: TextSet }
  | { page: string; nth?: number; set: PageSet }
  | { sectionBreak: string; nth?: number; type: "nextPage" | "continuous" | "evenPage" | "oddPage" }
  | { after?: string; nth?: number; pageBreak: true }
  | { footnote: string; nth?: number; text: string }
  | { after?: string; nth?: number; toc: true; levels: number };

/** The keys that name an office_format op: one of them makes an op office_format's. */
export const FORMAT_SHAPES = ["format", "defineStyle", "formatTable", "page", "sectionBreak", "pageBreak", "footnote", "toc", "set"];
/** The most keys one `set` holds, and the most cells one table merge takes. */
export const MAX_SET_KEYS = 30;
export const MAX_MERGE_CELLS = 200;

const TEXT_KEYS = ["font", "fontSize", "bold", "italic", "underline", "strike", "superscript", "subscript", "color", "highlight", "link", "style", "clear"];
const PARA_KEYS = ["align", "spaceBefore", "spaceAfter", "lineSpacing", "indentLeft", "indentRight", "firstLine", "list", "level", "listStart", "pageBreakBefore", "keepWithNext"];
const TABLE_KEYS = ["tableStyle", "width", "columnWidths", "headerRows"];
const CELL_KEYS = ["borders", "fill", "align", "valign", "rowHeight", "merge"];
const PAGE_KEYS = ["pageSize", "orientation", "margins", "header", "footer", "differentFirstPage", "replace"];
/** What a style may say of itself: no link, no other style, and no list (a list is the paragraphs'). */
const STYLE_TEXT_KEYS = TEXT_KEYS.filter((k) => !["link", "style", "clear"].includes(k));
const STYLE_PARA_KEYS = PARA_KEYS.filter((k) => !["list", "level", "listStart"].includes(k));

/** The highlight colours the editor has (ApiRange.SetHighlight; any other name sets none, measured in DS 10.0), and
 * each one's colour as the builder reads it back. */
export const HIGHLIGHTS = ["yellow", "green", "cyan", "magenta", "blue", "red", "darkBlue", "darkCyan", "darkGreen", "darkMagenta", "darkRed", "darkYellow", "darkGray", "lightGray", "black", "white"];
const HIGHLIGHT_HEX = ["#FFFF00", "#00FF00", "#00FFFF", "#FF00FF", "#0000FF", "#FF0000", "#00008B", "#008B8B", "#006400", "#800080", "#8B0000", "#808000", "#A9A9A9", "#D3D3D3", "#000000", "#FFFFFF"];
/** Paper sizes by name, in twips (portrait). */
export const PAGE_SIZES: Record<string, [number, number]> = { A3: [16838, 23811], A4: [11906, 16838], A5: [8391, 11906], Letter: [12240, 15840], Legal: [12240, 20160] };
/** The largest length taken anywhere (a page side of 22 inches, Word's own limit), in twips. */
const MAX_TWIPS = 31_680;
const TWIPS: Record<string, number> = { pt: 20, cm: 1440 / 2.54, mm: 144 / 2.54, in: 1440 };

/** A length as the agent gives it: a number (points) or a text with its unit ("2.5cm", "10mm", "1in", "12pt"), in
 * twips; null where it is neither. */
export function length(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 20) : null;
  if (typeof v !== "string") return null;
  const m = /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*(pt|cm|mm|in)\s*$/i.exec(v);
  return m ? Math.round(Number(m[1]) * TWIPS[m[2].toLowerCase()]) : null;
}

/** A colour as "#RRGGBB" (either case), or null. */
export function colour(v: unknown): Rgb | null {
  const m = typeof v === "string" ? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v.trim()) : null;
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

/** Whether a link's address is one a document may carry: http, https or mailto, at most 2,000 characters. */
function linkable(v: string): boolean {
  if (v.length > 2000 || !oneLine(v)) return false;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(v).protocol);
  } catch {
    return false;
  }
}

/** The ops of an office_format call for a document of `ext`, checked: the job the seat runs, or an OpError. */
export function formatJob(ext: "docx" | "xlsx", ops: unknown): FormatJob | SheetFormatJob {
  capped(ops);
  if (ext === "xlsx") return sheetFormatJob(ops as unknown[]);
  return { kind: "word.format", args: { ops: (ops as unknown[]).map(formatOp) } };
}

const FORMAT_LIST = "{format, through?, nth?, set}, {defineStyle, type?, basedOn?, change?, set}, {formatTable, nth?, cells?, set}, {page, nth?, set}, {sectionBreak, nth?, type?}, {after?, nth?, pageBreak: true}, {footnote, nth?, text} and {after?, nth?, toc: true, levels?}";

function formatOp(op: unknown, i: number): FormatOp {
  const n = i + 1;
  const bad = (message: string) => new OpError("bad_op", `op ${n}: ${message}`, i);
  if (!isObject(op)) throw new OpError("bad_op", `op ${n} is not an object`, i);
  if ("range" in op || "values" in op) throw new OpError("unsupported_format", `op ${n} is a spreadsheet edit ({range, values}), and this is a Word document`, i);
  const content = ["quote", "replacement", "paragraphs", "table", "remove"].find((k) => k in op);
  if (content) throw bad(`\`${content}\` is an office_edit op (what the document says): make it with office_edit, and its look here`);
  const shapes = FORMAT_SHAPES.filter((k) => k !== "set" && k in op);
  if (shapes.length !== 1) throw new OpError("bad_op", `op ${n} must be exactly one of ${FORMAT_LIST} (it has ${shapes.length ? shapes.join(" and ") : "none of them"})${shapes.length > 1 ? `: each is an op of its own, its quote the value of its first key ({${shapes[1]}: "<quote>", …})` : ""}`, i);
  const shape = shapes[0];
  // An op that sets nothing given an empty `set` all the same (a model's habit): nothing to refuse.
  const empty = !["format", "defineStyle", "formatTable", "page"].includes(shape) && isObject(op.set) && Object.keys(op.set).length === 0;
  const only = (keys: string[]) => {
    const extra = Object.keys(op).filter((k) => !keys.includes(k) && !(empty && k === "set"));
    if (extra.length) throw bad(`${extra.map((k) => JSON.stringify(k)).join(", ")} is not part of {${keys.join(", ")}}`);
  };
  const quote = (key: string) => {
    const v = op[key];
    if (typeof v !== "string" || v === "" || !oneLine(v)) throw bad(`${key} is text of the document's body, exactly as office_read shows it (one line, not empty)`);
    return v;
  };
  const after = () => (op.after !== undefined ? { after: quote("after") } : {});
  const nth = () => {
    if (op.nth !== undefined && shape !== "pageBreak" && shape !== "toc" && op[shape] === "*") throw bad("nth picks among the places a quote is found, and \"*\" is every section");
    if (op.nth !== undefined && (shape === "pageBreak" || shape === "toc") && op.after === undefined) throw bad("nth picks among the places `after` is found: give after with it");
    return nthOf(op, n, i);
  };
  const set = (keys: string[], what: string): Record<string, unknown> => {
    const v = op.set;
    if (!isObject(v) || Object.keys(v).length === 0) throw bad(`set is an object of what to set (${what}: ${keys.join(", ")})`);
    if (Object.keys(v).length > MAX_SET_KEYS) throw bad(`set holds at most ${MAX_SET_KEYS} keys`);
    const extra = Object.keys(v).filter((k) => !keys.includes(k));
    // A model may group the keys as the description lists them ({paragraph: {list: "bullet"}}): set is flat.
    const grouped = extra.some((k) => isObject(v[k]) && k !== "borders") ? `; set is flat: its keys go in it directly ({"list": "bullet"}, not {"paragraph": {"list": "bullet"}})` : "";
    if (extra.length) throw bad(`set has ${extra.map((k) => JSON.stringify(k)).join(", ")}, which ${extra.length === 1 ? "is not a key" : "are not keys"} of ${what} (they are ${keys.join(", ")})${grouped}`);
    return v;
  };
  switch (shape) {
    case "format": {
      only(["format", "through", "nth", "set"]);
      const given = set([...TEXT_KEYS, ...PARA_KEYS], "text and paragraphs");
      const out: FormatOp = { format: quote("format"), ...(op.through !== undefined ? { through: quote("through") } : {}), ...nth() };
      return { ...out, ...textSet(given, bad, TEXT_KEYS), ...paraSet(given, bad, PARA_KEYS) };
    }
    case "defineStyle": {
      only(["defineStyle", "type", "basedOn", "change", "set"]);
      const name = op.defineStyle;
      if (typeof name !== "string" || !name.trim() || name.length > 100 || !oneLine(name)) throw bad("defineStyle is the style's name (one line, at most 100 characters)");
      const type = op.type === undefined ? "paragraph" : op.type;
      if (type !== "paragraph" && type !== "character") throw bad(`type is "paragraph" (the default) or "character"`);
      if (op.change !== undefined && op.change !== true) throw bad("change is true, to change a style the document has (it changes every paragraph that uses it)");
      if (op.basedOn !== undefined && (typeof op.basedOn !== "string" || !op.basedOn.trim() || op.basedOn.length > 100 || !oneLine(op.basedOn))) throw bad(`basedOn is the name of a ${type} style the document has (or one this call makes), as office_read with formatting names it`);
      const basedOn = op.basedOn === undefined ? {} : { basedOn: op.basedOn.trim() };
      const keys = type === "paragraph" ? [...STYLE_TEXT_KEYS, ...STYLE_PARA_KEYS] : STYLE_TEXT_KEYS;
      const given = set(keys, `a ${type} style`);
      return { defineStyle: name.trim(), type, ...basedOn, ...(op.change ? { change: true as const } : {}), ...textSet(given, bad, STYLE_TEXT_KEYS), ...(type === "paragraph" ? paraSet(given, bad, STYLE_PARA_KEYS) : {}) };
    }
    case "formatTable": {
      only(["formatTable", "nth", "cells", "set"]);
      let cells: { col: number; row: number; cols: number; rows: number } | undefined;
      if (op.cells !== undefined) {
        cells = typeof op.cells === "string" ? (parseRange(op.cells) ?? undefined) : undefined;
        if (!cells) throw bad(`cells is a table's cells as A1:C2 (column letters, row numbers from 1, as office_read shows the table; got ${JSON.stringify(op.cells)})`);
      }
      // A cell's text keys leave out a style and a link: a link lies inside one paragraph (and a cell may hold several).
      const cellText = TEXT_KEYS.filter((k) => k !== "style" && k !== "link");
      const given = set(cells ? [...CELL_KEYS, ...cellText] : [...TABLE_KEYS, ...CELL_KEYS, ...cellText], cells ? "cells" : "a table");
      if (given.merge !== undefined && !cells) throw bad("merge takes cells: the rectangle to merge, as A1:B1");
      if (given.merge !== undefined && cells && cells.cols * cells.rows > MAX_MERGE_CELLS) throw bad(`a merge takes ${MAX_MERGE_CELLS} cells at most`);
      if (given.merge !== undefined && cells && cells.cols * cells.rows < 2) throw bad("a merge takes two cells or more");
      const text = textSet(given, bad, cellText);
      return { formatTable: quote("formatTable"), ...nth(), ...(cells ? { cells } : {}), ...tableSet(given, bad), ...cellSet(given, bad), ...text };
    }
    case "page": {
      only(["page", "nth", "set"]);
      const where = op.page === "*" ? "*" : quote("page");
      return { page: where, ...nth(), set: pageSet(set(PAGE_KEYS, "page setup"), bad) };
    }
    case "sectionBreak": {
      only(["sectionBreak", "nth", "type"]);
      const type = op.type === undefined ? "nextPage" : op.type;
      if (!["nextPage", "continuous", "evenPage", "oddPage"].includes(type as string)) throw bad(`type is "nextPage" (the default), "continuous", "evenPage" or "oddPage"`);
      return { sectionBreak: quote("sectionBreak"), ...nth(), type: type as "nextPage" };
    }
    case "pageBreak": {
      only(["after", "nth", "pageBreak"]);
      if (op.pageBreak !== true) throw bad("pageBreak is true");
      return { ...after(), ...nth(), pageBreak: true };
    }
    case "footnote": {
      only(["footnote", "nth", "text"]);
      if (typeof op.text !== "string" || !op.text.trim() || !oneLine(op.text) || op.text.length > 5000) throw bad("text is the footnote's text (one line, not empty)");
      return { footnote: quote("footnote"), ...nth(), text: op.text };
    }
    default: {
      only(["after", "nth", "toc", "levels"]);
      if (op.toc !== true) throw bad("toc is true");
      const levels = op.levels === undefined ? 3 : op.levels;
      if (typeof levels !== "number" || !Number.isInteger(levels) || levels < 1 || levels > 9) throw bad("levels is a whole number from 1 to 9 (the headings the table of contents lists; 3 by default)");
      return { ...after(), ...nth(), toc: true, levels };
    }
  }
}

type Bad = (message: string) => OpError;
const bool = (set: Record<string, unknown>, key: string, bad: Bad) => {
  if (typeof set[key] !== "boolean") throw bad(`set.${key} is true or false`);
  return set[key] as boolean;
};
/** A length of `set[key]` in twips, from `min`. */
const lengthOf = (set: Record<string, unknown>, key: string, bad: Bad, min = 0) => {
  const v = length(set[key]);
  if (v === null || v < min || Math.abs(v) > MAX_TWIPS) throw bad(`set.${key} is a length: a number of points, or a text with its unit ("2.5cm", "10mm", "1in", "12pt")${min < 0 ? "" : ", not negative"}`);
  return v;
};

/** The text keys of `set` among `keys`; a size in points up to `maxSize` (Word's 1638, a sheet's 409). */
function textSet(set: Record<string, unknown>, bad: Bad, keys: string[], maxSize = 1638): { text?: TextSet } {
  const out: TextSet = {};
  const has = (k: string) => keys.includes(k) && set[k] !== undefined;
  if (has("font")) {
    if (typeof set.font !== "string" || !set.font.trim() || set.font.length > 100 || !oneLine(set.font)) throw bad("set.font is a font's name (\"Arial\")");
    out.font = set.font.trim();
  }
  if (has("fontSize")) {
    const v = set.fontSize;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > maxSize) throw bad(`set.fontSize is the size in points, from 1 to ${maxSize} (halves too: 10.5)`);
    out.size = Math.round(v * 2);
  }
  for (const k of ["bold", "italic", "underline", "strike"] as const) if (has(k)) out[k] = bool(set, k, bad);
  if (has("superscript") && has("subscript") && set.superscript === true && set.subscript === true) throw bad("text is superscript or subscript, not both");
  if (has("superscript") || has("subscript")) {
    const sup = has("superscript") ? bool(set, "superscript", bad) : undefined;
    const sub = has("subscript") ? bool(set, "subscript", bad) : undefined;
    out.vertAlign = sup ? "superscript" : sub ? "subscript" : "baseline";
  }
  if (has("color")) {
    const c = set.color === "auto" ? "auto" : colour(set.color);
    if (!c) throw bad(`set.color is "#RRGGBB" or "auto" (the style's own)`);
    out.color = c;
  }
  if (has("highlight")) {
    // A name, or the colour of one ("#FFFF00" is yellow): a model given colours as "#RRGGBB" says it so.
    const given = typeof set.highlight === "string" ? set.highlight.trim().toLowerCase() : "";
    const name = [...HIGHLIGHTS, "none"].find((h) => h.toLowerCase() === given) ?? HIGHLIGHTS[HIGHLIGHT_HEX.findIndex((x) => x.toLowerCase() === given)];
    if (!name) throw bad(`set.highlight is one of ${HIGHLIGHTS.join(", ")}, or "none" (or the colour of one: "#FFFF00" is yellow)`);
    out.highlight = name;
  }
  if (has("link")) {
    if (typeof set.link !== "string" || (set.link !== "" && !linkable(set.link))) throw bad(`set.link is a link's address (http, https or mailto), or "" to take the link off`);
    out.link = set.link;
  }
  if (has("style")) {
    if (typeof set.style !== "string" || !set.style.trim() || !oneLine(set.style)) throw bad("set.style is the name of a paragraph or character style the document has (office_read with formatting lists them)");
    out.style = set.style.trim();
  }
  if (has("clear")) {
    if (set.clear !== true) throw bad("set.clear is true: the text's own formatting is taken off (its style's stays)");
    out.clear = true;
  }
  return Object.keys(out).length ? { text: out } : {};
}

const ALIGN = ["left", "center", "right", "justify"];

function paraSet(set: Record<string, unknown>, bad: Bad, keys: string[]): { para?: ParaSet } {
  const out: ParaSet = {};
  const has = (k: string) => keys.includes(k) && set[k] !== undefined;
  if (has("align")) {
    if (!ALIGN.includes(set.align as string)) throw bad(`set.align is ${ALIGN.join(", ")}`);
    out.align = set.align as ParaSet["align"];
  }
  for (const k of ["spaceBefore", "spaceAfter", "indentLeft", "indentRight"] as const) if (has(k)) out[k] = lengthOf(set, k, bad);
  if (has("firstLine")) out.firstLine = lengthOf(set, "firstLine", bad, -MAX_TWIPS);
  if (has("lineSpacing")) {
    const v = set.lineSpacing;
    if (typeof v === "number") {
      if (!Number.isFinite(v) || v < 0.5 || v > 10) throw bad("set.lineSpacing is a multiple (1, 1.5, 2) or an exact length (\"14pt\")");
      out.lineSpacing = { line: Math.round(v * 240), rule: "auto" };
    } else {
      const t = length(v);
      if (t === null || t <= 0 || t > MAX_TWIPS) throw bad("set.lineSpacing is a multiple (1, 1.5, 2) or an exact length (\"14pt\")");
      out.lineSpacing = { line: t, rule: "exact" };
    }
  }
  if (has("list")) {
    if (!["bullet", "number", "none"].includes(set.list as string)) throw bad(`set.list is "bullet", "number" or "none"`);
    out.list = set.list as ParaSet["list"];
  }
  if (has("level")) {
    const v = set.level;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 9) throw bad("set.level is a list level from 1 to 9");
    out.level = v - 1;
  }
  if (has("listStart")) {
    const v = set.listStart;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 32767) throw bad("set.listStart is the number the list starts at again (a whole number)");
    out.listStart = v;
  }
  if (out.list === "none" && (out.level !== undefined || out.listStart !== undefined)) throw bad(`list "none" takes the paragraphs out of their list: no level or listStart with it`);
  for (const k of ["pageBreakBefore", "keepWithNext"] as const) if (has(k)) out[k] = bool(set, k, bad);
  return Object.keys(out).length ? { para: out } : {};
}

/** A border as the agent gives it: "single 1pt #000000" (each part may go: single, 0.5pt, black), or "none". */
function border(v: unknown, what: string, bad: Bad): Border {
  if (v === "none") return { type: "none" };
  const parts = typeof v === "string" ? v.trim().split(/\s+/) : [];
  let size = 4;
  let color: Rgb = { r: 0, g: 0, b: 0 };
  let ok = parts.length > 0;
  for (const part of parts) {
    if (part === "single") continue;
    const c = colour(part);
    const t = length(part);
    if (c) color = c;
    else if (t !== null && /[a-z]$/i.test(part) && t > 0 && t <= 240) size = Math.max(2, Math.round((t / 20) * 8));
    else ok = false;
  }
  if (!ok) throw bad(`${what} is "single 1pt #000000" (a single line, its width and colour) or "none" (the editor draws single borders only)`);
  return { type: "single", size, color };
}

function cellSet(set: Record<string, unknown>, bad: Bad): { cell?: CellSet } {
  const out: CellSet = {};
  if (set.borders !== undefined) {
    const v = set.borders;
    const line: Border = { type: "single", size: 4, color: { r: 0, g: 0, b: 0 } };
    const none: Border = { type: "none" };
    const sides = ["top", "bottom", "left", "right", "insideH", "insideV"] as const;
    if (v === "all") out.borders = Object.fromEntries(sides.map((k) => [k, line]));
    else if (v === "none") out.borders = Object.fromEntries(sides.map((k) => [k, none]));
    else if (v === "outside") out.borders = { top: line, bottom: line, left: line, right: line };
    else if (v === "inside") out.borders = { insideH: line, insideV: line };
    else if (isObject(v) && Object.keys(v).length) {
      const extra = Object.keys(v).filter((k) => !(sides as readonly string[]).includes(k));
      if (extra.length) throw bad(`set.borders has ${extra.map((k) => JSON.stringify(k)).join(", ")}: its sides are ${sides.join(", ")}`);
      out.borders = Object.fromEntries(Object.entries(v).map(([k, s]) => [k, border(s, `set.borders.${k}`, bad)]));
    } else throw bad(`set.borders is "all", "outside", "inside", "none", or {top, bottom, left, right, insideH, insideV}, each "single 1pt #000000" or "none"`);
  }
  if (set.fill !== undefined) {
    const c = set.fill === "none" ? "none" : colour(set.fill);
    if (!c) throw bad(`set.fill is "#RRGGBB" or "none"`);
    out.fill = c;
  }
  if (set.align !== undefined) {
    if (!ALIGN.includes(set.align as string)) throw bad(`set.align is ${ALIGN.join(", ")}`);
    out.align = set.align as CellSet["align"];
  }
  if (set.valign !== undefined) {
    if (!["top", "center", "bottom"].includes(set.valign as string)) throw bad(`set.valign is "top", "center" or "bottom"`);
    out.valign = set.valign as CellSet["valign"];
  }
  if (set.rowHeight !== undefined) out.rowHeight = lengthOf(set, "rowHeight", bad);
  if (set.merge !== undefined) {
    if (set.merge !== true) throw bad("set.merge is true: the cells become one");
    out.merge = true;
  }
  return Object.keys(out).length ? { cell: out } : {};
}

function tableSet(set: Record<string, unknown>, bad: Bad): { table?: TableSet } {
  const out: TableSet = {};
  if (set.tableStyle !== undefined) {
    if (typeof set.tableStyle !== "string" || !set.tableStyle.trim() || !oneLine(set.tableStyle)) throw bad("set.tableStyle is the name of a table style the document has (\"Table Grid\", \"Grid Table 4 - Accent 1\")");
    out.tableStyle = set.tableStyle.trim();
  }
  if (set.width !== undefined) {
    const pct = typeof set.width === "string" ? /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(set.width) : null;
    if (pct && Number(pct[1]) > 0 && Number(pct[1]) <= 100) out.width = { percent: Number(pct[1]) };
    else if (!pct) out.width = { twips: lengthOf(set, "width", bad) };
    else throw bad("set.width is a share of the page's text width (\"100%\") or a length");
  }
  if (set.columnWidths !== undefined) {
    const v = set.columnWidths;
    if (!Array.isArray(v) || v.length === 0 || v.length > 63) throw bad("set.columnWidths is a list of lengths, one per column");
    out.columnWidths = v.map((w, k) => {
      const t = length(w);
      if (t === null || t <= 0 || t > MAX_TWIPS) throw bad(`set.columnWidths[${k}] is a length (a number of points, or "3cm")`);
      return t;
    });
  }
  if (set.headerRows !== undefined) {
    // true is the one header row a model means by it.
    const v = set.headerRows === true ? 1 : set.headerRows === false ? 0 : set.headerRows;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1000) throw bad("set.headerRows is how many rows from the top repeat on each page as the header (0: none)");
    out.headerRows = v;
  }
  return Object.keys(out).length ? { table: out } : {};
}

/** A header's or footer's text, its {page} and {pages} as the fields. */
function headerParts(v: unknown, key: string, bad: Bad): HeaderPart[] {
  if (typeof v !== "string" || !oneLine(v) || v.length > 2000) throw bad(`set.${key} is its text, one line ({page} and {pages} become the page number and count; "" removes it)`);
  const out: HeaderPart[] = [];
  for (const piece of v.split(/(\{page\}|\{pages\})/)) {
    if (piece === "{page}") out.push({ field: "page" });
    else if (piece === "{pages}") out.push({ field: "pages" });
    else if (piece) out.push({ text: piece });
  }
  return out;
}

function pageSet(set: Record<string, unknown>, bad: Bad): PageSet {
  const out: PageSet = {};
  if (set.pageSize !== undefined) {
    const v = set.pageSize;
    const named = typeof v === "string" ? Object.keys(PAGE_SIZES).find((k) => k.toLowerCase() === v.trim().toLowerCase()) : undefined;
    if (named) out.size = { width: PAGE_SIZES[named][0], height: PAGE_SIZES[named][1] };
    else if (Array.isArray(v) && v.length === 2) {
      const [w, h] = v.map((x) => length(x));
      if (w === null || h === null || w < 1440 || h < 1440 || w > MAX_TWIPS || h > MAX_TWIPS) throw bad("set.pageSize is [width, height], each a length from 1 to 22 inches");
      out.size = { width: w, height: h };
    } else throw bad(`set.pageSize is ${Object.keys(PAGE_SIZES).join(", ")}, or [width, height]`);
  }
  if (set.orientation !== undefined) {
    if (set.orientation !== "portrait" && set.orientation !== "landscape") throw bad(`set.orientation is "portrait" or "landscape"`);
    out.orientation = set.orientation;
  }
  if (set.margins !== undefined) {
    const v = set.margins;
    const all = Array.isArray(v) ? v.map((x) => length(x)) : [length(v)];
    if ((all.length !== 1 && all.length !== 4) || all.some((x) => x === null || x < 0 || x > MAX_TWIPS / 2)) throw bad("set.margins is one length for all four, or [top, right, bottom, left]");
    const [t, r, b, l] = all.length === 1 ? [all[0], all[0], all[0], all[0]] : all;
    out.margins = { top: t!, right: r!, bottom: b!, left: l! };
  }
  if (set.header !== undefined) out.header = headerParts(set.header, "header", bad);
  if (set.footer !== undefined) out.footer = headerParts(set.footer, "footer", bad);
  if (set.differentFirstPage !== undefined) out.differentFirstPage = bool(set, "differentFirstPage", bad);
  if (set.replace !== undefined) {
    if (set.replace !== true) throw bad("set.replace is true: a header or footer that holds more than text (a picture, a table, a field) is replaced all the same");
    out.replace = true;
  }
  if (out.replace && out.header === undefined && out.footer === undefined) throw bad("set.replace goes with header or footer");
  return out;
}

/* ------------------------------------------------------------------ */
/* office_format (spreadsheets)                                         */
/* ------------------------------------------------------------------ */

/**
 * office_format's ops for a spreadsheet, made in the spreadsheet command's stepped executor (seat-page.ts, cellEdit),
 * each step answering what takes it back:
 * - `{sheet?, format: "A1:D9" | "C:D" | "5:6", set}`: cells, or whole columns or rows; `set` as below;
 * - `{sheet?, columns: "C:D", width?, hide?, show?, autofit?}`: columns, `width` in characters as the sheet shows it;
 * - `{sheet?, rows: "5:7", height?, hide?, show?, autofit?}`: rows, `height` in points;
 * - `{sheet?, freeze: "B2" | "none"}`: the rows above and the columns left of the cell stay in view ("A2": the first
 *   row; "none": nothing).
 * The sheet is the first one where none is named. `set` keys (measured in DS 10.0 with docbuilder and the editor):
 * numberFormat, font, fontSize, bold, italic, underline, strike, superscript and subscript (text cells only: the
 * builder sets them on a cell's characters), color, fill ("none" takes it off), align (left, center, right, justify:
 * the builder sets no "general" back, only clear does), valign, wrap, rotation (degrees from -90 to 90, or
 * "vertical"), borders (as Word's, and dashed, dotted, double: the builder takes no border off, so there is no
 * "none"), merge (true merges, false splits), clear (every format off, merges too, the values kept).
 */
export type SheetArea = { col: number; row: number; cols: number; rows: number; whole?: "columns" | "rows" };
/** A border side as the sheet builder draws it (ApiRange.SetBorders' line styles). */
export type SheetBorder = { style: "Thin" | "Medium" | "Thick" | "Double" | "Dashed" | "MediumDashed" | "Dotted"; color: Rgb };
export type SheetLooks = {
  numberFormat?: string;
  font?: string;
  /** Points. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  vertAlign?: "superscript" | "subscript" | "baseline";
  color?: Rgb;
  fill?: Rgb | "none";
  align?: "left" | "center" | "right" | "justify";
  valign?: "top" | "center" | "bottom";
  wrap?: boolean;
  /** Degrees, -90 to 90, or 255 (stacked, "vertical"). */
  rotation?: number;
  borders?: Partial<Record<"top" | "bottom" | "left" | "right" | "insideH" | "insideV", SheetBorder>>;
  merge?: boolean;
  clear?: true;
};
export type SheetFormatOp =
  | { sheet?: string; format: string; area: SheetArea; looks: SheetLooks }
  | { sheet?: string; columns: string; from: number; count: number; width?: number; hidden?: boolean; autofit?: true }
  | { sheet?: string; rows: string; from: number; count: number; height?: number; hidden?: boolean; autofit?: true }
  | { sheet?: string; freeze: string; cols: number; rows: number };
export type SheetFormatJob = { kind: "cell.format"; args: { ops: SheetFormatOp[] } };

/** The keys that name a spreadsheet's office_format op (`set` alone too: a format given to office_edit). */
export const SHEET_FORMAT_SHAPES = ["format", "columns", "rows", "freeze", "set"];
/** The most cells one call formats by their addresses (each one's state is read first, to take the call back), and the
 * most columns and rows its columns and rows ops take; whole columns and rows count the cells of the sheet's used range
 * among them, which the command counts (seat-page.ts, CELL_STEP). */
export const MAX_FORMAT_CELLS = 20_000;
/** The widest column (characters) and the highest row (points) Excel takes. */
const MAX_WIDTH = 255;
const MAX_HEIGHT = 409;

const SHEET_TEXT_KEYS = ["numberFormat", "font", "fontSize", "bold", "italic", "underline", "strike", "superscript", "subscript", "color"];
const SHEET_CELL_KEYS = ["fill", "align", "valign", "wrap", "rotation", "borders", "merge", "clear"];
const SHEET_FORMAT_LIST = "{sheet?, format, set}, {sheet?, columns, width? | hide? | show? | autofit?}, {sheet?, rows, height? | hide? | show? | autofit?} and {sheet?, freeze}";

/** A sheet's cells ("A1", "A1:D9"), whole columns ("C:D") or whole rows ("5:6") as office_format takes them. */
export function parseArea(v: string): { area: SheetArea; text: string } | null {
  const range = parseRange(v);
  if (range) {
    const end = range.cols === 1 && range.rows === 1 ? "" : `:${colLetters(range.col + range.cols - 1)}${range.row + range.rows}`;
    return { area: range, text: `${colLetters(range.col)}${range.row + 1}${end}` };
  }
  // Whole ones only with both ends ("C:C", "5:5"): a bare "C" or "5" is no address.
  if (!/:/.test(v)) return null;
  for (const kind of ["columns", "rows"] as const) {
    const lines = parseLines(v, kind);
    if (lines) return { area: kind === "columns" ? { col: lines.from, row: 0, cols: lines.count, rows: MAX_ROWS, whole: "columns" } : { col: 0, row: lines.from, cols: MAX_COLS, rows: lines.count, whole: "rows" }, text: lines.text };
  }
  return null;
}

function sheetFormatJob(ops: unknown[]): SheetFormatJob {
  const out = ops.map(sheetFormatOp);
  // Whole columns and rows count one each here (the command counts the used cells among them besides): "1:1048576"
  // never gets as far as the agents' browser.
  const cells = out.reduce((n, op) => n + ("format" in op ? (op.area.whole === "columns" ? op.area.cols : op.area.whole === "rows" ? op.area.rows : op.area.cols * op.area.rows) : 0), 0);
  if (cells > MAX_FORMAT_CELLS) throw new OpError("bad_op", `one call formats ${MAX_FORMAT_CELLS.toLocaleString("en")} cells at most (got ${cells.toLocaleString("en")}, a whole column or row counting one): each one's formats are read first, so that the call can be taken back; split it into several calls, or format whole columns ("C:D") or rows ("5:6")`);
  const lines = out.reduce((n, op) => n + ("count" in op ? op.count : 0), 0);
  if (lines > MAX_FORMAT_CELLS) throw new OpError("bad_op", `one call's columns and rows ops take ${MAX_FORMAT_CELLS.toLocaleString("en")} columns and rows at most (got ${lines.toLocaleString("en")}); split it into several calls`);
  return { kind: "cell.format", args: { ops: out } };
}

function sheetFormatOp(op: unknown, i: number): SheetFormatOp {
  const n = i + 1;
  const bad = (message: string) => new OpError("bad_op", `op ${n}: ${message}`, i);
  if (!isObject(op)) throw new OpError("bad_op", `op ${n} is not an object`, i);
  const content = ["range", "values", ...Object.keys(SHEET_OPS), ...Object.keys(LINE_OPS)].find((k) => k in op);
  if (content) throw bad(`\`${content}\` is an office_edit op (what the sheet holds): make it with office_edit, and its look here`);
  const word = ["quote", "paragraphs", "table", "remove", ...FORMAT_SHAPES.filter((k) => k !== "format" && k !== "set")].find((k) => k in op);
  if (word) throw new OpError("unsupported_format", `op ${n} is a Word op (\`${word}\`), and this is a spreadsheet: its office_format ops are ${SHEET_FORMAT_LIST}`, i);
  const shapes = ["format", "columns", "rows", "freeze"].filter((k) => k in op);
  if (shapes.length !== 1) throw new OpError("bad_op", `op ${n} must be exactly one of ${SHEET_FORMAT_LIST} (it has ${shapes.length ? shapes.join(" and ") : "none of them"})${shapes.length > 1 ? `: each is an op of its own, its cells the value of its first key ({${shapes[1]}: "…", …})` : ""}`, i);
  const shape = shapes[0];
  if (op.sheet !== undefined && (typeof op.sheet !== "string" || op.sheet === "")) throw bad("sheet is a sheet's name (the first sheet where none is given)");
  const sheet = op.sheet !== undefined ? { sheet: op.sheet as string } : {};
  if (shape === "format") {
    const extra = Object.keys(op).filter((k) => !["sheet", "format", "set"].includes(k));
    if (extra.length) throw bad(`${extra.map((k) => JSON.stringify(k)).join(", ")} is not part of {sheet?, format, set}${extra.some((k) => SHEET_TEXT_KEYS.includes(k) || SHEET_CELL_KEYS.includes(k)) ? ": what to set goes in set" : ""}`);
    const where = typeof op.format === "string" ? parseArea(op.format) : null;
    if (!where) throw bad(`format is the cells, as "A1:D9", or whole columns "C:D" or rows "5:6" (got ${JSON.stringify(op.format)})`);
    const keys = [...SHEET_TEXT_KEYS, ...SHEET_CELL_KEYS];
    const given = op.set;
    if (!isObject(given) || Object.keys(given).length === 0) throw bad(`set is an object of what to set (for cells: ${keys.join(", ")})`);
    if (Object.keys(given).length > MAX_SET_KEYS) throw bad(`set holds at most ${MAX_SET_KEYS} keys`);
    const unknown = Object.keys(given).filter((k) => !keys.includes(k));
    if (unknown.length) {
      const grouped = unknown.some((k) => isObject(given[k]) && k !== "borders") ? "; set is flat: its keys go in it directly ({\"bold\": true}, not {\"font\": {\"bold\": true}})" : "";
      const word = unknown.some((k) => ["highlight", "link", "style"].includes(k)) ? " (highlight, link and style are Word's)" : "";
      throw bad(`set has ${unknown.map((k) => JSON.stringify(k)).join(", ")}, which ${unknown.length === 1 ? "is not a key" : "are not keys"} of cells (they are ${keys.join(", ")})${word}${grouped}`);
    }
    const looks = sheetLooks(given, bad);
    if (looks.merge === true && !where.area.whole && where.area.cols * where.area.rows < 2) throw bad("a merge takes two cells or more");
    if (looks.merge !== undefined && where.area.whole) throw bad("merge takes cells (\"A1:D1\"), not whole columns or rows");
    return { ...sheet, format: where.text, area: where.area, looks };
  }
  if (shape === "freeze") {
    const extra = Object.keys(op).filter((k) => !["sheet", "freeze"].includes(k));
    if (extra.length) throw bad(`${extra.map((k) => JSON.stringify(k)).join(", ")} is not part of {sheet?, freeze}`);
    const v = typeof op.freeze === "string" ? op.freeze.trim() : "";
    if (v.toLowerCase() === "none") return { ...sheet, freeze: "none", cols: 0, rows: 0 };
    const at = parseRange(v);
    if (!at || at.cols !== 1 || at.rows !== 1) throw bad(`freeze is the first cell that scrolls: the rows above it and the columns left of it stay in view ("B2": row 1 and column A; "A2": row 1 only), or "none" (got ${JSON.stringify(op.freeze)})`);
    if (at.col === 0 && at.row === 0) return { ...sheet, freeze: "none", cols: 0, rows: 0 };
    if (at.col > 100 || at.row > 1000) throw bad("freeze keeps at most 100 columns and 1,000 rows in view");
    return { ...sheet, freeze: `${colLetters(at.col)}${at.row + 1}`, cols: at.col, rows: at.row };
  }
  // Columns and rows: their keys beside the op's, or (a model's habit) in a set.
  const kind = shape as "columns" | "rows";
  const size = kind === "columns" ? "width" : "height";
  const keys = [size, "hide", "show", "autofit"];
  const fromSet = isObject(op.set) ? op.set : {};
  const extra = [...Object.keys(op).filter((k) => !["sheet", kind, "set", ...keys].includes(k)), ...Object.keys(fromSet).filter((k) => !keys.includes(k))];
  if (op.set !== undefined && !isObject(op.set)) throw bad(`{sheet?, ${kind}, ${size}?, hide?, show?, autofit?} takes its keys beside ${kind}`);
  if (extra.length) throw bad(`${extra.map((k) => JSON.stringify(k)).join(", ")} is not part of {sheet?, ${kind}, ${size}?, hide?, show?, autofit?}${extra.includes("width") || extra.includes("height") ? ` (${kind === "columns" ? "columns take a width in characters" : "rows take a height in points"})` : ""}`);
  const v: Record<string, unknown> = { ...fromSet, ...Object.fromEntries(keys.filter((k) => op[k] !== undefined).map((k) => [k, op[k]])) };
  const lines = typeof op[kind] === "string" ? parseLines(op[kind] as string, kind) : null;
  if (!lines) throw bad(`${kind} is ${kind === "rows" ? 'rows by their numbers, "5" or "5:7"' : 'columns by their letters, "C" or "C:E"'} (got ${JSON.stringify(op[kind])})`);
  if (!keys.some((k) => v[k] !== undefined)) throw bad(`give what to do with the ${kind}: ${size}, hide, show or autofit`);
  for (const k of ["hide", "show", "autofit"]) if (v[k] !== undefined && v[k] !== true) throw bad(`${k} is true`);
  if (v.hide && v.show) throw bad("hide or show, not both");
  if (v[size] !== undefined && v.autofit) throw bad(`${size} or autofit, not both`);
  const out: SheetFormatOp = kind === "columns" ? { ...sheet, columns: lines.text, from: lines.from, count: lines.count } : { ...sheet, rows: lines.text, from: lines.from, count: lines.count };
  if (v[size] !== undefined) {
    const x = v[size];
    const most = kind === "columns" ? MAX_WIDTH : MAX_HEIGHT;
    if (typeof x !== "number" || !Number.isFinite(x) || x <= 0 || x > most) throw bad(kind === "columns" ? `width is the columns' width in characters, as the sheet shows it (8.43 is the default), from 0 to ${MAX_WIDTH}; hide hides them` : `height is the rows' height in points (15 is about the default), from 0 to ${MAX_HEIGHT}; hide hides them`);
    (out as Record<string, unknown>)[size] = Math.round(x * 100) / 100;
  }
  if (v.hide || v.show) (out as { hidden?: boolean }).hidden = v.hide === true;
  if (v.autofit) (out as { autofit?: true }).autofit = true;
  return out;
}

const SHEET_ALIGN = ["left", "center", "right", "justify"];
const SHEET_LINES: Record<string, true> = { single: true, double: true, dashed: true, dotted: true };

/** A sheet's border as the agent gives it: "single 1pt #000000" (each part may go: single, thin, black), or double,
 * dashed, dotted. A width up to 1pt is the sheet's thin line, up to 2pt its medium one, above that its thick one. */
function sheetBorder(v: unknown, what: string, bad: Bad): SheetBorder {
  const parts = typeof v === "string" ? v.trim().split(/\s+/) : [];
  let kind = "single";
  let width = 0.75;
  let color: Rgb = { r: 0, g: 0, b: 0 };
  let ok = parts.length > 0 && v !== "none";
  for (const part of parts) {
    const c = colour(part);
    const t = length(part);
    if (SHEET_LINES[part.toLowerCase()]) kind = part.toLowerCase();
    else if (c) color = c;
    else if (t !== null && /[a-z]$/i.test(part) && t > 0 && t <= 240) width = t / 20;
    else ok = false;
  }
  if (!ok) throw bad(`${what} is a line, as "single 1pt #000000" (single, double, dashed or dotted; its width and colour)${v === "none" ? `: the editor's API takes no border off, so there is no "none" (clear: true takes all of the cells' formatting off)` : ""}`);
  const style = kind === "double" ? "Double" : kind === "dotted" ? "Dotted" : kind === "dashed" ? (width > 1 ? "MediumDashed" : "Dashed") : width <= 1 ? "Thin" : width <= 2 ? "Medium" : "Thick";
  return { style, color };
}

function sheetLooks(set: Record<string, unknown>, bad: Bad): SheetLooks {
  const out: SheetLooks = {};
  if (set.numberFormat !== undefined) {
    if (typeof set.numberFormat !== "string" || !set.numberFormat || set.numberFormat.length > 255 || !oneLine(set.numberFormat)) throw bad(`set.numberFormat is a number format as Excel writes it ("#,##0.00", "0%", "dd.mm.yyyy", '#,##0.00 "€"', "@" for text, "General")`);
    out.numberFormat = set.numberFormat;
  }
  // The text keys as Word's (textSet), in the sheet's units: points, not half-points.
  const text = textSet(set, bad, ["font", "fontSize", "bold", "italic", "underline", "strike", "superscript", "subscript"], 409).text ?? {};
  if (text.font) out.font = text.font;
  if (text.size !== undefined) out.size = text.size / 2;
  for (const k of ["bold", "italic", "underline", "strike"] as const) if (text[k] !== undefined) out[k] = text[k];
  if (text.vertAlign) out.vertAlign = text.vertAlign;
  if (set.color !== undefined) {
    const c = colour(set.color);
    if (!c) throw bad(`set.color is "#RRGGBB"`);
    out.color = c;
  }
  if (set.fill !== undefined) {
    const c = set.fill === "none" ? "none" : colour(set.fill);
    if (!c) throw bad(`set.fill is "#RRGGBB" or "none"`);
    out.fill = c;
  }
  if (set.align !== undefined) {
    if (!SHEET_ALIGN.includes(set.align as string)) throw bad(`set.align is ${SHEET_ALIGN.join(", ")}${set.align === "general" ? ` (the editor's API sets no "general" back: clear: true takes all of the cells' formatting off)` : ""}`);
    out.align = set.align as SheetLooks["align"];
  }
  if (set.valign !== undefined) {
    if (!["top", "center", "bottom"].includes(set.valign as string)) throw bad(`set.valign is "top", "center" or "bottom"`);
    out.valign = set.valign as SheetLooks["valign"];
  }
  if (set.wrap !== undefined) out.wrap = bool(set, "wrap", bad);
  if (set.rotation !== undefined) {
    const r = set.rotation;
    if (r === "vertical") out.rotation = 255;
    else if (typeof r === "number" && Number.isInteger(r) && r >= -90 && r <= 90) out.rotation = r;
    else throw bad(`set.rotation is the text's angle in degrees, a whole number from -90 to 90 (90 reads upwards), or "vertical" (letters stacked)`);
  }
  if (set.borders !== undefined) {
    const v = set.borders;
    const sides = ["top", "bottom", "left", "right", "insideH", "insideV"] as const;
    const line: SheetBorder = { style: "Thin", color: { r: 0, g: 0, b: 0 } };
    if (v === "all") out.borders = Object.fromEntries(sides.map((k) => [k, line]));
    else if (v === "outside") out.borders = { top: line, bottom: line, left: line, right: line };
    else if (v === "inside") out.borders = { insideH: line, insideV: line };
    else if (isObject(v) && Object.keys(v).length) {
      const extra = Object.keys(v).filter((k) => !(sides as readonly string[]).includes(k));
      if (extra.length) throw bad(`set.borders has ${extra.map((k) => JSON.stringify(k)).join(", ")}: its sides are ${sides.join(", ")}`);
      out.borders = Object.fromEntries(Object.entries(v).map(([k, s]) => [k, sheetBorder(s, `set.borders.${k}`, bad)]));
    } else throw bad(`set.borders is "all", "outside", "inside", or {top, bottom, left, right, insideH, insideV}, each a line as "single 1pt #000000"${v === "none" ? `; the editor's API takes no border off, so there is no "none" (clear: true takes all of the cells' formatting off)` : ""}`);
  }
  if (set.merge !== undefined) out.merge = bool(set, "merge", bad);
  if (set.clear !== undefined) {
    if (set.clear !== true) throw bad("set.clear is true: all of the cells' formatting is taken off (merges too; their values stay)");
    out.clear = true;
  }
  return out;
}
