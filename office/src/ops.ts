/**
 * The ops of office_edit, checked before anything reaches the editor: their shapes, that they fit the document's
 * format, and the caps (MAX_OPS, MAX_ARGS_BYTES). What they find in the document is checked by the command itself
 * (seat-page.ts), on the document as it stands when the command runs: `simulateWord` is that check, the same source,
 * for the tests and for reading.
 *
 * Word ops:
 * - `{quote, replacement}`: the quote's text (exactly once, inside one paragraph) becomes the replacement;
 * - `{after?, paragraphs, style?}`: new paragraphs after the paragraph that holds `after`, or at the end;
 * - `{after?, table}`: a table (its first row the header) at the same place;
 * - `{remove}`: the paragraph that holds the quote goes.
 * Excel ops: `{sheet?, range, values}`: the values into the range (A1 or A1:B2, on the first sheet where none is
 * named), one row of values per row of the range; a string that starts with "=" is a formula, "" clears the cell.
 */
import { WORD_MODEL_SRC } from "./seat-page";

export type WordStyle = (typeof STYLES)[number];
export type WordOp =
  | { quote: string; replacement: string }
  | { after?: string; paragraphs: string[]; style?: WordStyle }
  | { after?: string; table: string[][] }
  | { remove: string };
export type CellValue = string | number | boolean;
export type CellOp = { sheet?: string; range: string; values: CellValue[][] };
export type EditJob = { kind: "word.edit"; args: { ops: WordOp[] } } | { kind: "cell.edit"; args: { ops: CellOp[] } };

/** The paragraph styles an insert may name: the built-in ones every document the editor opens has. */
export const STYLES = ["Normal", "Heading 1", "Heading 2", "Heading 3", "Title", "List Paragraph"] as const;
/** The most ops one call carries, and the most their arguments may take as JSON. */
export const MAX_OPS = 200;
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
  if (!Array.isArray(ops) || ops.length === 0) throw new OpError("bad_op", "ops is a non-empty list of edits");
  if (ops.length > MAX_OPS) throw new OpError("bad_op", `one call takes at most ${MAX_OPS} ops (got ${ops.length}); split the edit into several calls`);
  if (JSON.stringify(ops).length > MAX_ARGS_BYTES) throw new OpError("bad_op", `the ops take more than ${MAX_ARGS_BYTES / 1024} KB; split the edit into several calls`);
  if (ext === "docx") return { kind: "word.edit", args: { ops: ops.map(wordOp) } };
  return { kind: "cell.edit", args: { ops: ops.map(cellOp) } };
}

function wordOp(op: unknown, i: number): WordOp {
  const n = i + 1;
  if (!isObject(op)) throw new OpError("bad_op", `op ${n} is not an object`, i);
  if ("range" in op || "values" in op) throw new OpError("unsupported_format", `op ${n} is a spreadsheet edit ({range, values}), and this is a Word document: its ops are {quote, replacement}, {after?, paragraphs, style?}, {after?, table} and {remove}`, i);
  const shapes = ["quote", "paragraphs", "table", "remove"].filter((k) => k in op);
  if (shapes.length !== 1) throw new OpError("bad_op", `op ${n} must be exactly one of {quote, replacement}, {after?, paragraphs, style?}, {after?, table} or {remove} (it has ${shapes.length ? shapes.join(" and ") : "none of them"})`, i);
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
  if ("quote" in op) {
    only(["quote", "replacement"]);
    return { quote: text("quote", "the text to replace, exactly as office_read shows it (not empty)"), replacement: text("replacement", "the text that takes its place (empty removes the quote)", true) };
  }
  if ("remove" in op) {
    only(["remove"]);
    return { remove: text("remove", "text of the paragraph to remove (not empty)") };
  }
  if ("paragraphs" in op) {
    only(["after", "paragraphs", "style"]);
    const list = op.paragraphs;
    if (!Array.isArray(list) || list.length === 0 || !list.every((p) => typeof p === "string")) throw new OpError("bad_op", `op ${n}: paragraphs is a non-empty list of texts, one per paragraph`, i);
    if (!list.every(oneLine)) throw new OpError("bad_op", `op ${n}: a paragraph may not hold a line break: give each paragraph as an item of its own`, i);
    if ("style" in op && op.style !== undefined && !STYLES.includes(op.style as WordStyle)) throw new OpError("bad_op", `op ${n}: style is one of ${STYLES.map((s) => JSON.stringify(s)).join(", ")}`, i);
    return { ...after(), paragraphs: list as string[], ...(op.style !== undefined ? { style: op.style as WordStyle } : {}) };
  }
  only(["after", "table"]);
  const rows = op.table;
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every((r) => Array.isArray(r) && r.length > 0 && r.every((c) => typeof c === "string"))) throw new OpError("bad_op", `op ${n}: table is a non-empty list of rows, each a non-empty list of cell texts (the first row is the header)`, i);
  if (rows.some((r) => (r as unknown[]).length !== (rows[0] as unknown[]).length)) throw new OpError("bad_op", `op ${n}: every row of the table has the same number of cells (the first has ${(rows[0] as unknown[]).length})`, i);
  if (!rows.every((r) => (r as string[]).every(oneLine))) throw new OpError("bad_op", `op ${n}: a cell's text may not hold a line break`, i);
  return { ...after(), table: rows as string[][] };
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

function cellOp(op: unknown, i: number): CellOp {
  const n = i + 1;
  if (!isObject(op)) throw new OpError("bad_op", `op ${n} is not an object`, i);
  if (["quote", "paragraphs", "table", "remove"].some((k) => k in op)) throw new OpError("unsupported_format", `op ${n} is a Word edit, and this is a spreadsheet: its ops are {sheet?, range, values}`, i);
  const extra = Object.keys(op).filter((k) => !["sheet", "range", "values"].includes(k));
  if (extra.length) throw new OpError("bad_op", `op ${n}: ${extra.map((k) => JSON.stringify(k)).join(", ")} is not part of a spreadsheet op ({sheet?, range, values})`, i);
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

/** The command's own check (WORD_MODEL_SRC), run here: on paragraphs' texts in reading order, null where every op
 * holds in turn, or the first failure (`quote_not_found` / `quote_ambiguous`, the op's index, a message). */
export const simulateWord: (paras: string[], ops: WordOp[]) => { code: string; op: number; message: string } | null = new Function(`${WORD_MODEL_SRC}\nreturn simulateWord;`)();
