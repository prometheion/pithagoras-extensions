/**
 * Unit tests for src/ops.ts: the shapes, formats and caps of office_edit's ops, the A1 ranges, and the check the
 * Word command makes before it touches anything (simulateWord, the command's own source): every quote exactly once
 * at its turn, an earlier op that makes or takes away a later op's quote taken into account, the failing op named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { editJob, MAX_ARGS_BYTES, MAX_OPS, MAX_SHEET_OPS, OpError, parseRange, sheetNameProblem, type CellOp, type SheetOp, type WordOp } from "../src/ops";
import { SHEET_MODEL_SRC, WORD_MODEL_SRC } from "../src/seat-page";

/** The command's own check (WORD_MODEL_SRC), run here: on paragraphs' texts in reading order, null where every op
 * holds in turn, or the first failure (`quote_not_found` / `quote_ambiguous`, the op's index, a message). */
const simulateWord: (paras: string[], ops: WordOp[]) => { code: string; op: number; message: string } | null = new Function(`${WORD_MODEL_SRC}\nreturn simulateWord;`)();

/** The spreadsheet command's own check (SHEET_MODEL_SRC), run here on the workbook's sheets in order. */
const simulateSheets: (sheets: { name: string; hidden?: boolean }[], ops: (CellOp | SheetOp)[]) => { code: string; op: number; message: string } | null = new Function(`${SHEET_MODEL_SRC}\nreturn simulateSheets;`)();

const refused = (code: string, op?: number) => (e: unknown) => {
  assert.ok(e instanceof OpError, String(e));
  assert.equal(e.code, code, e.message);
  if (op !== undefined) assert.equal(e.op, op, e.message);
  return true;
};

test("Word ops: each of the four shapes is taken as it is", () => {
  const ops = [
    { quote: "were revised", replacement: "were updated" },
    { quote: "drop me", replacement: "" },
    { after: "the audit", paragraphs: ["Findings", ""], style: "Heading 1" },
    { paragraphs: ["At the end"] },
    { after: "Findings", table: [["Item", "Amount"], ["Ledger", "42"]] },
    { remove: "Footnote" },
  ];
  assert.deepEqual(editJob("docx", ops), { kind: "word.edit", args: { ops } });
});

test("Word ops: empty lists, missing or extra fields, mixed shapes, line breaks and unknown styles are bad_op, naming the op", () => {
  assert.throws(() => editJob("docx", []), refused("bad_op"));
  assert.throws(() => editJob("docx", "x"), refused("bad_op"));
  assert.throws(() => editJob("docx", [{ quote: "a", replacement: "b" }, 7]), refused("bad_op", 1));
  assert.throws(() => editJob("docx", [{ quote: "", replacement: "b" }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ quote: "a" }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ quote: "a", replacement: "b", baseRevision: 1 }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ quote: "a", replacement: "b", paragraphs: ["c"] }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ quote: "a\nb", replacement: "c" }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ quote: "a", replacement: "b\r\nc" }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ paragraphs: [] }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ paragraphs: ["one\ntwo"] }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ paragraphs: ["x"], style: "Heading 7" }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ after: "", paragraphs: ["x"] }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ remove: "" }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{}]), refused("bad_op", 0));
});

test("Word tables: ragged rows and empty tables are bad_op", () => {
  assert.throws(() => editJob("docx", [{ table: [] }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ table: [[]] }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ table: [["a", "b"], ["c"]] }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ table: [["a", 1]] }]), refused("bad_op", 0));
});

test("Word ops on a spreadsheet and spreadsheet ops on a Word document are unsupported_format", () => {
  assert.throws(() => editJob("xlsx", [{ quote: "a", replacement: "b" }]), refused("unsupported_format", 0));
  assert.throws(() => editJob("xlsx", [{ range: "A1", values: [[1]] }, { remove: "x" }]), refused("unsupported_format", 1));
  assert.throws(() => editJob("docx", [{ range: "A1", values: [[1]] }]), refused("unsupported_format", 0));
});

test("spreadsheet ops: a range and exactly its values; formulas, numbers, booleans and empty strings are values", () => {
  assert.deepEqual(editJob("xlsx", [{ range: "a1:a3", values: [[2], [3], ["=A1*A2"]] }, { sheet: "Notes", range: "B2:C2", values: [[true, ""]] }]), {
    kind: "cell.edit",
    args: { ops: [{ range: "A1:A3", values: [[2], [3], ["=A1*A2"]] }, { sheet: "Notes", range: "B2:C2", values: [[true, ""]] }] },
  });
  assert.throws(() => editJob("xlsx", [{ range: "A1:B2", values: [[1, 2]] }]), refused("bad_op", 0));
  assert.throws(() => editJob("xlsx", [{ range: "A1:B2", values: [[1, 2], [3]] }]), refused("bad_op", 0));
  assert.throws(() => editJob("xlsx", [{ range: "A1", values: [1] }]), refused("bad_op", 0));
  assert.throws(() => editJob("xlsx", [{ range: "A1", values: [[null]] }]), refused("bad_op", 0));
  assert.throws(() => editJob("xlsx", [{ range: "A1", values: [[Number.NaN]] }]), refused("bad_op", 0));
  assert.throws(() => editJob("xlsx", [{ range: "A1", values: [[{ a: 1 }]] }]), refused("bad_op", 0));
  assert.throws(() => editJob("xlsx", [{ range: "1A", values: [[1]] }]), refused("bad_op", 0));
  assert.throws(() => editJob("xlsx", [{ range: "A1", values: [[1]], sheet: "" }]), refused("bad_op", 0));
  assert.throws(() => editJob("xlsx", [{ range: "A1", values: [[1]], formula: "=1" }]), refused("bad_op", 0));
});

test("A1 ranges: either corner first, $ anchors, and nothing past XFD1048576", () => {
  assert.deepEqual(parseRange("B2"), { col: 1, row: 1, cols: 1, rows: 1 });
  assert.deepEqual(parseRange("$C$3:A1"), { col: 0, row: 0, cols: 3, rows: 3 });
  assert.deepEqual(parseRange("aa10:ab11"), { col: 26, row: 9, cols: 2, rows: 2 });
  assert.deepEqual(parseRange("XFD1048576"), { col: 16_383, row: 1_048_575, cols: 1, rows: 1 });
  assert.equal(parseRange("XFE1"), null);
  assert.equal(parseRange("A1048577"), null);
  assert.equal(parseRange("A0"), null);
  assert.equal(parseRange("A1:B"), null);
  assert.equal(parseRange("Sheet1!A1"), null);
});

test("the caps: more than MAX_OPS ops or MAX_ARGS_BYTES of arguments are bad_op", () => {
  assert.throws(() => editJob("docx", Array.from({ length: MAX_OPS + 1 }, () => ({ remove: "x" }))), refused("bad_op"));
  assert.doesNotThrow(() => editJob("docx", Array.from({ length: MAX_OPS }, () => ({ remove: "x" }))));
  assert.throws(() => editJob("docx", [{ paragraphs: ["x".repeat(MAX_ARGS_BYTES)] }]), refused("bad_op"));
  // Counted in bytes: a text of fewer characters than the cap, but more bytes, is refused too.
  assert.throws(() => editJob("docx", [{ paragraphs: ["€".repeat(MAX_ARGS_BYTES / 2)] }]), refused("bad_op"));
});

test("the check: a quote found once passes; not found, or found twice, names its op and code", () => {
  const paras = ["Revenue figures were revised after the audit.", "", "Note: checked against the ledger.", "Footnote: total"];
  assert.equal(simulateWord(paras, [{ quote: "were revised", replacement: "were updated" }, { remove: "Footnote" }]), null);
  const missing = simulateWord(paras, [{ quote: "were revised", replacement: "x" }, { quote: "not there", replacement: "y" }]);
  assert.equal(missing?.code, "quote_not_found");
  assert.equal(missing?.op, 1);
  const twice = simulateWord(paras, [{ quote: "the", replacement: "a" }]);
  assert.equal(twice?.code, "quote_ambiguous");
  assert.equal(twice?.op, 0);
  assert.match(twice!.message, /2 times/);
  // A quote across two paragraphs is not in the text.
  assert.equal(simulateWord(paras, [{ quote: "audit. Note", replacement: "x" }])?.code, "quote_not_found");
  // An anchor is held to the same rule.
  assert.equal(simulateWord(paras, [{ after: "e", paragraphs: ["x"] }])?.code, "quote_ambiguous");
});

test("the check: an earlier op that makes or takes away a later op's quote is taken into account", () => {
  const paras = ["Alpha beta", "Gamma"];
  // Made by op 0, used by op 1.
  assert.equal(simulateWord(paras, [{ quote: "beta", replacement: "delta" }, { quote: "delta", replacement: "epsilon" }]), null);
  // Taken away by op 0.
  const gone = simulateWord(paras, [{ quote: "beta", replacement: "delta" }, { quote: "beta", replacement: "x" }]);
  assert.deepEqual([gone?.code, gone?.op], ["quote_not_found", 1]);
  // A second copy made by op 0 makes op 1 ambiguous.
  const two = simulateWord(paras, [{ paragraphs: ["Gamma again"] }, { quote: "Gamma", replacement: "x" }]);
  assert.deepEqual([two?.code, two?.op], ["quote_ambiguous", 1]);
  // A paragraph inserted by op 0 is an anchor for op 1, and a table's cells are text for op 2.
  const ops: WordOp[] = [{ after: "Gamma", paragraphs: ["Findings"] }, { after: "Findings", table: [["Item", "Amount"]] }, { quote: "Amount", replacement: "Sum" }];
  assert.equal(simulateWord(paras, ops), null);
  // A removed paragraph's text is gone for the ops after it.
  const removed = simulateWord(paras, [{ remove: "Gamma" }, { after: "Gamma", paragraphs: ["x"] }]);
  assert.deepEqual([removed?.code, removed?.op], ["quote_not_found", 1]);
  // A replacement that holds "$&" is text, not a pattern.
  assert.equal(simulateWord(["cost"], [{ quote: "cost", replacement: "$& more" }, { quote: "$& more", replacement: "x" }]), null);
});

test("the check names the nearest text where a quote is not found", () => {
  const miss = simulateWord(["Revenue figures were revised after the audit."], [{ quote: "REVENUE  figures", replacement: "x" }]);
  assert.match(miss!.message, /nearest: "Revenue figures were revised after the audit\."/);
  const head = simulateWord(["the quarterly revenue report, final"], [{ quote: "quarterly revenue reports", replacement: "x" }]);
  assert.match(head!.message, /nearest: ".*quarterly revenue report/);
});

test("sheet ops: each shape is taken as it is, beside cell writes", () => {
  const ops = [
    { addSheet: "Data" },
    { addSheet: "Front", position: 1 },
    { renameSheet: "Sheet1", to: "Q1 2026" },
    { moveSheet: "Data", position: 2 },
    { copySheet: "Data", to: "Data (2)" },
    { copySheet: "Data", to: "Data (3)", position: 4 },
    { hideSheet: "Data (2)" },
    { showSheet: "Data (2)" },
    { deleteSheet: "Data (3)" },
    { sheet: "Data", range: "A1", values: [[1]] },
  ];
  assert.deepEqual(editJob("xlsx", ops), { kind: "cell.edit", args: { ops } });
});

test("sheet ops: missing or extra fields, two shapes in one op, names Excel refuses and bad positions are bad_op, naming the op", () => {
  const bad = (op: unknown) => assert.throws(() => editJob("xlsx", [{ range: "A1", values: [[1]] }, op]), refused("bad_op", 1), JSON.stringify(op));
  bad({ addSheet: "" });
  bad({ addSheet: 7 });
  bad({ addSheet: "x".repeat(32) });
  for (const ch of ["[", "]", ":", "*", "?", "/", "\\"]) bad({ addSheet: `a${ch}b` });
  bad({ addSheet: "'quoted" });
  bad({ addSheet: "quoted'" });
  bad({ addSheet: "two\nlines" });
  bad({ addSheet: "history" });
  bad({ addSheet: "Data", position: 0 });
  bad({ addSheet: "Data", position: 1.5 });
  bad({ addSheet: "Data", position: "2" });
  bad({ addSheet: "Data", to: "Other" });
  bad({ renameSheet: "Sheet1" });
  bad({ renameSheet: "Sheet1", to: "a/b" });
  bad({ moveSheet: "Sheet1" });
  bad({ copySheet: "Sheet1" });
  bad({ copySheet: "Sheet1", to: "x".repeat(40) });
  bad({ hideSheet: "Sheet1", position: 2 });
  bad({ deleteSheet: "" });
  bad({ deleteSheet: "Sheet1", hideSheet: "Sheet2" });
  bad({ addSheet: "Data", range: "A1", values: [[1]] });
  bad({ deleteSheet: "Data", sheet: "Data" });
  // A name of 31 characters, spaces, an apostrophe inside and other scripts are Excel's own.
  assert.doesNotThrow(() => editJob("xlsx", [{ addSheet: "x".repeat(31) }, { addSheet: "Bob's sheet" }, { addSheet: "Übersicht 2026" }]));
  assert.equal(sheetNameProblem("History 2"), null);
});

test("the sheets check: names in the workbook are found case-insensitively, and a name taken (in any case) is refused", () => {
  const book = [{ name: "Sheet1" }, { name: "Data" }];
  assert.equal(simulateSheets(book, [{ sheet: "data", range: "A1", values: [[1]] }, { renameSheet: "SHEET1", to: "Front" }]), null);
  const taken = simulateSheets(book, [{ addSheet: "DATA" }]);
  assert.deepEqual([taken?.code, taken?.op], ["sheet_exists", 0]);
  assert.match(taken!.message, /"Data" already/);
  assert.equal(simulateSheets(book, [{ copySheet: "Data", to: "sheet1" }])?.code, "sheet_exists");
  assert.equal(simulateSheets(book, [{ renameSheet: "Data", to: "Sheet1" }])?.code, "sheet_exists");
  // A sheet renamed to another case of its own name is fine.
  assert.equal(simulateSheets(book, [{ renameSheet: "Data", to: "DATA" }]), null);
  const missing = simulateSheets(book, [{ addSheet: "New" }, { deleteSheet: "Gone" }]);
  assert.deepEqual([missing?.code, missing?.op], ["not_found", 1]);
  assert.match(missing!.message, /the sheets: "Sheet1", "Data", "New"/);
});

test("the sheets check: an earlier op's sheets are taken into account", () => {
  const book = [{ name: "Sheet1" }];
  // Made, then written into, renamed, copied and moved.
  assert.equal(simulateSheets(book, [{ addSheet: "Data" }, { sheet: "Data", range: "A1", values: [[1]] }, { renameSheet: "Data", to: "Q1" }, { copySheet: "Q1", to: "Q2" }, { moveSheet: "Q2", position: 1 }]), null);
  // Renamed: the old name is gone for the ops after it, and free again.
  assert.deepEqual(simulateSheets(book, [{ renameSheet: "Sheet1", to: "Front" }, { sheet: "Sheet1", range: "A1", values: [[1]] }])?.op, 1);
  assert.equal(simulateSheets(book, [{ renameSheet: "Sheet1", to: "Front" }, { addSheet: "Sheet1" }]), null);
  // Deleted: gone for the ops after it.
  assert.equal(simulateSheets([{ name: "A" }, { name: "B" }], [{ deleteSheet: "B" }, { showSheet: "B" }])?.code, "not_found");
  // Two made with one name in one call.
  assert.equal(simulateSheets(book, [{ addSheet: "X" }, { copySheet: "Sheet1", to: "x" }])?.code, "sheet_exists");
});

test("the sheets check: positions inside the workbook as it stands at the op's turn", () => {
  const book = [{ name: "A" }, { name: "B" }];
  assert.equal(simulateSheets(book, [{ addSheet: "C", position: 3 }]), null, "after the last");
  assert.equal(simulateSheets(book, [{ addSheet: "C", position: 4 }])?.code, "bad_op");
  assert.equal(simulateSheets(book, [{ moveSheet: "A", position: 2 }]), null);
  assert.equal(simulateSheets(book, [{ moveSheet: "A", position: 3 }])?.code, "bad_op", "a move stays inside");
  assert.equal(simulateSheets(book, [{ copySheet: "A", to: "A2", position: 3 }]), null);
  assert.equal(simulateSheets(book, [{ addSheet: "C" }, { moveSheet: "A", position: 3 }]), null, "the sheet made before counts");
});

test("the sheets check: the last visible sheet is never hidden or deleted", () => {
  const one = simulateSheets([{ name: "Only" }], [{ deleteSheet: "Only" }]);
  assert.deepEqual([one?.code, one?.op], ["last_visible_sheet", 0]);
  assert.match(one!.message, /only sheet/);
  assert.equal(simulateSheets([{ name: "Only" }], [{ hideSheet: "Only" }])?.code, "last_visible_sheet");
  const book = [{ name: "A" }, { name: "B", hidden: true }];
  assert.equal(simulateSheets(book, [{ deleteSheet: "A" }])?.code, "last_visible_sheet", "a hidden sheet does not count");
  assert.equal(simulateSheets(book, [{ hideSheet: "A" }])?.code, "last_visible_sheet");
  assert.equal(simulateSheets(book, [{ deleteSheet: "B" }]), null, "a hidden sheet may go");
  assert.equal(simulateSheets(book, [{ showSheet: "B" }, { hideSheet: "A" }, { deleteSheet: "A" }]), null, "shown first, the other may go");
  assert.equal(simulateSheets(book, [{ hideSheet: "B" }]), null, "hiding a hidden sheet changes nothing");
  assert.equal(simulateSheets([{ name: "A" }, { name: "B" }], [{ hideSheet: "A" }, { deleteSheet: "B" }])?.op, 1);
  // A copy is visible.
  assert.equal(simulateSheets([{ name: "A" }], [{ copySheet: "A", to: "B" }, { deleteSheet: "A" }]), null);
});

test("the sheets check: a hidden sheet is not moved; shown, moved and hidden again in one call it is", () => {
  const book = [{ name: "A" }, { name: "Secret", hidden: true }];
  const hidden = simulateSheets(book, [{ range: "A1", values: [[1]] }, { moveSheet: "secret", position: 1 }]);
  assert.deepEqual([hidden?.code, hidden?.op], ["sheet_hidden", 1]);
  assert.match(hidden!.message, /^op 2: "Secret" is hidden, and the editor moves visible sheets only: show it, move it and hide it again/);
  assert.equal(simulateSheets(book, [{ showSheet: "Secret" }, { moveSheet: "Secret", position: 1 }, { hideSheet: "Secret" }]), null);
  assert.equal(simulateSheets([{ name: "A" }, { name: "B" }], [{ hideSheet: "B" }, { moveSheet: "B", position: 1 }])?.code, "sheet_hidden", "hidden by an op before it");
});

test("sheet ops: at most MAX_SHEET_OPS of them in one call, cell ops beside them not counted", () => {
  const adds = (n: number) => Array.from({ length: n }, (_, k) => ({ addSheet: `S${k}` }));
  assert.doesNotThrow(() => editJob("xlsx", [...adds(MAX_SHEET_OPS), { range: "A1", values: [[1]] }]));
  assert.throws(() => editJob("xlsx", adds(MAX_SHEET_OPS + 1)), (e: unknown) => e instanceof OpError && e.code === "bad_op" && /at most 20 sheet ops \(got 21\)/.test(e.message));
});
