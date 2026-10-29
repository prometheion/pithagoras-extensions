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
export type EditJob = { kind: "word.edit"; args: { ops: WordOp[] } } | { kind: "cell.edit"; args: { ops: (CellOp | SheetOp)[] } };

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
  const sheetOps = cells.filter((op) => !("range" in op)).length;
  if (sheetOps > MAX_SHEET_OPS) throw new OpError("bad_op", `one call takes at most ${MAX_SHEET_OPS} sheet ops (got ${sheetOps}); split the edit into several calls`);
  return { kind: "cell.edit", args: { ops: cells } };
}

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

const SHEET_SHAPES = "{sheet?, range, values}, {addSheet, position?}, {renameSheet, to}, {moveSheet, position}, {copySheet, to, position?}, {hideSheet}, {showSheet} and {deleteSheet}";

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

function cellOp(op: unknown, i: number): CellOp | SheetOp {
  const n = i + 1;
  if (!isObject(op)) throw new OpError("bad_op", `op ${n} is not an object`, i);
  if (["quote", "paragraphs", "table", "remove", ...FORMAT_SHAPES].some((k) => k in op)) throw new OpError("unsupported_format", `op ${n} is a Word edit, and this is a spreadsheet: its ops are ${SHEET_SHAPES}`, i);
  const sheetKeys = Object.keys(SHEET_OPS).filter((k) => k in op);
  if (sheetKeys.length > 1 || (sheetKeys.length && ("range" in op || "values" in op || "sheet" in op))) throw new OpError("bad_op", `op ${n} must be exactly one of ${SHEET_SHAPES} (it has ${[...sheetKeys, ...["sheet", "range", "values"].filter((k) => k in op)].join(" and ")})`, i);
  if (sheetKeys.length) return sheetOp(op, sheetKeys[0], i);
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
export function formatJob(ext: "docx" | "xlsx", ops: unknown): FormatJob {
  capped(ops);
  if (ext === "xlsx") throw new OpError("unsupported_format", "office_format changes how Word documents look; a spreadsheet's look cannot be changed with it yet (office_edit writes its values)");
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
      const basedOn = op.basedOn === undefined ? {} : { basedOn: quote("basedOn") };
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
      const given = set(cells ? [...CELL_KEYS, ...TEXT_KEYS.filter((k) => k !== "style")] : [...TABLE_KEYS, ...CELL_KEYS, ...TEXT_KEYS.filter((k) => k !== "style")], cells ? "cells" : "a table");
      if (given.merge !== undefined && !cells) throw bad("merge takes cells: the rectangle to merge, as A1:B1");
      if (given.merge !== undefined && cells && cells.cols * cells.rows > MAX_MERGE_CELLS) throw bad(`a merge takes ${MAX_MERGE_CELLS} cells at most`);
      if (given.merge !== undefined && cells && cells.cols * cells.rows < 2) throw bad("a merge takes two cells or more");
      const text = textSet(given, bad, TEXT_KEYS.filter((k) => k !== "style"));
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

function textSet(set: Record<string, unknown>, bad: Bad, keys: string[]): { text?: TextSet } {
  const out: TextSet = {};
  const has = (k: string) => keys.includes(k) && set[k] !== undefined;
  if (has("font")) {
    if (typeof set.font !== "string" || !set.font.trim() || set.font.length > 100 || !oneLine(set.font)) throw bad("set.font is a font's name (\"Arial\")");
    out.font = set.font.trim();
  }
  if (has("fontSize")) {
    const v = set.fontSize;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 1638) throw bad("set.fontSize is the size in points, from 1 to 1638 (halves too: 10.5)");
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
