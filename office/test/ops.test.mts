/**
 * Unit tests for src/ops.ts: the shapes, formats and caps of office_edit's ops, the A1 ranges, and the check the
 * Word command makes before it touches anything (simulateWord, the command's own source): every quote exactly once
 * at its turn, an earlier op that makes or takes away a later op's quote taken into account, the failing op named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { colour, editJob, formatJob, length, nameProblem, sheetRef, MAX_ARGS_BYTES, MAX_FORMAT_CELLS, MAX_MERGE_CELLS, MAX_OPS, MAX_SET_KEYS, MAX_SHEET_OPS, OpError, parseArea, parseLines, parseRange, sheetNameProblem, type CellOp, type SheetOp, type WordOp } from "../src/ops";
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
  assert.throws(() => editJob("docx", [{ paragraphs: ["x"], style: "" }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ paragraphs: ["x"], style: "Heading\n1" }]), refused("bad_op", 0));
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

test("Word ops take nth, from 1, where they have a quote (or an insert's after); a format op is office_format's and is refused with its name", () => {
  const ops = [
    { quote: "Total", replacement: "Sum", nth: 2 },
    { after: "Findings", nth: 1, paragraphs: ["x"], style: "Callout" },
    { after: "Findings", nth: 3, table: [["a"]] },
    { remove: "Note", nth: 2 },
  ];
  assert.deepEqual(editJob("docx", ops), { kind: "word.edit", args: { ops } });
  assert.throws(() => editJob("docx", [{ paragraphs: ["x"], nth: 1 }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ quote: "a", replacement: "b", nth: 0 }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ quote: "a", replacement: "b", nth: "2" }]), refused("bad_op", 0));
  assert.throws(() => editJob("docx", [{ format: "a", set: { bold: true } }]), (e: unknown) => e instanceof OpError && e.code === "bad_op" && /`format` is an office_format op/.test(e.message));
  assert.throws(() => editJob("xlsx", [{ format: "A1", set: { bold: true } }]), (e: unknown) => e instanceof OpError && e.code === "bad_op" && /`format` is an office_format op \(how the sheet looks\)/.test(e.message));
  assert.throws(() => editJob("xlsx", [{ page: "a", set: { margins: 1 } }]), refused("unsupported_format", 0));
});

test("lengths are points as numbers, or texts with their unit, in twips; colours are #RRGGBB in either case", () => {
  assert.equal(length(12), 240);
  assert.equal(length("12pt"), 240);
  assert.equal(length("2.54cm"), 1440);
  assert.equal(length("10mm"), 567);
  assert.equal(length("1in"), 1440);
  assert.equal(length(" 0.5 IN "), 720);
  assert.equal(length("-0.5cm"), -283);
  for (const bad of ["12", "1 furlong", "cm", "", null, Number.NaN, "1.2.3cm"]) assert.equal(length(bad), null, String(bad));
  assert.deepEqual(colour("#c81E1e"), { r: 200, g: 30, b: 30 });
  for (const bad of ["red", "#FFF", "C81E1E", "#GG0000", 0xff0000]) assert.equal(colour(bad), null, String(bad));
});

test("office_format (Word): every op and set key, given in the agent's words, reaches the command in the builder's units", () => {
  const job = formatJob("docx", [
    { format: "annual report", through: "end", nth: 2, set: { font: "Arial", fontSize: 10.5, bold: true, italic: false, underline: true, strike: false, superscript: true, color: "#C81E1E", highlight: "Yellow", link: "https://example.com/a", style: "Callout", clear: true, align: "justify", spaceBefore: 12, spaceAfter: "6pt", lineSpacing: 1.5, indentLeft: "1.27cm", indentRight: 0, firstLine: "-0.5cm", list: "number", level: 2, listStart: 3, pageBreakBefore: true, keepWithNext: false } },
    { format: "x", set: { subscript: true, color: "auto", link: "", lineSpacing: "14pt" } },
    { format: "x", set: { superscript: false, highlight: "none" } },
    { format: "x", set: { highlight: "#ffff00" } },
    { defineStyle: "Callout", basedOn: "Normal", set: { italic: true, color: "#005AA0", indentLeft: "1.27cm", spaceAfter: 6 } },
    { defineStyle: "Mark", type: "character", change: true, set: { bold: true } },
    { formatTable: "Ledger", set: { tableStyle: "Grid Table 4 - Accent 1", width: "100%", columnWidths: ["7cm", 85], headerRows: 1, borders: "all", fill: "#FFFF00", valign: "center", bold: true } },
    { formatTable: "Ledger", nth: 1, cells: "a1:b1", set: { merge: true, borders: { top: "single 1.5pt #C00000", insideV: "none" }, align: "right", rowHeight: "1cm" } },
    { formatTable: "Ledger", set: { width: "12cm", borders: "outside" } },
    { page: "*", set: { pageSize: "a4", orientation: "landscape", margins: "2cm", header: "Meridian Labs — confidential", footer: "Page {page} of {pages}", differentFirstPage: true, replace: true } },
    { page: "Findings", set: { pageSize: ["21cm", "29.7cm"], margins: [72, "2cm", 72, "1in"], header: "" } },
    { sectionBreak: "Findings", type: "continuous" },
    { sectionBreak: "Findings" },
    { pageBreak: true },
    { after: "Findings", nth: 2, pageBreak: true },
    { footnote: "discrepancy", text: "The audit of March." },
    { toc: true, set: {} },
    { after: "Title", toc: true, levels: 2 },
    { formatTable: "Ledger", set: { headerRows: true } },
  ]);
  assert.equal(job.kind, "word.format");
  assert.deepEqual(job.args.ops, [
    {
      format: "annual report",
      through: "end",
      nth: 2,
      text: { font: "Arial", size: 21, bold: true, italic: false, underline: true, strike: false, vertAlign: "superscript", color: { r: 200, g: 30, b: 30 }, highlight: "yellow", link: "https://example.com/a", style: "Callout", clear: true },
      para: { align: "justify", spaceBefore: 240, spaceAfter: 120, indentLeft: 720, indentRight: 0, firstLine: -283, lineSpacing: { line: 360, rule: "auto" }, list: "number", level: 1, listStart: 3, pageBreakBefore: true, keepWithNext: false },
    },
    { format: "x", text: { vertAlign: "subscript", color: "auto", link: "" }, para: { lineSpacing: { line: 280, rule: "exact" } } },
    { format: "x", text: { vertAlign: "baseline", highlight: "none" } },
    { format: "x", text: { highlight: "yellow" } },
    { defineStyle: "Callout", type: "paragraph", basedOn: "Normal", text: { italic: true, color: { r: 0, g: 90, b: 160 } }, para: { spaceAfter: 120, indentLeft: 720 } },
    { defineStyle: "Mark", type: "character", change: true, text: { bold: true } },
    {
      formatTable: "Ledger",
      table: { tableStyle: "Grid Table 4 - Accent 1", width: { percent: 100 }, columnWidths: [3969, 1700], headerRows: 1 },
      cell: { borders: Object.fromEntries(["top", "bottom", "left", "right", "insideH", "insideV"].map((k) => [k, { type: "single", size: 4, color: { r: 0, g: 0, b: 0 } }])), fill: { r: 255, g: 255, b: 0 }, valign: "center" },
      text: { bold: true },
    },
    { formatTable: "Ledger", nth: 1, cells: { col: 0, row: 0, cols: 2, rows: 1 }, cell: { borders: { top: { type: "single", size: 12, color: { r: 192, g: 0, b: 0 } }, insideV: { type: "none" } }, align: "right", rowHeight: 567, merge: true } },
    { formatTable: "Ledger", table: { width: { twips: 6803 } }, cell: { borders: Object.fromEntries(["top", "bottom", "left", "right"].map((k) => [k, { type: "single", size: 4, color: { r: 0, g: 0, b: 0 } }])) } },
    { page: "*", set: { size: { width: 11906, height: 16838 }, orientation: "landscape", margins: { top: 1134, right: 1134, bottom: 1134, left: 1134 }, header: [{ text: "Meridian Labs — confidential" }], footer: [{ text: "Page " }, { field: "page" }, { text: " of " }, { field: "pages" }], differentFirstPage: true, replace: true } },
    { page: "Findings", set: { size: { width: 11906, height: 16838 }, margins: { top: 1440, right: 1134, bottom: 1440, left: 1440 }, header: [] } },
    { sectionBreak: "Findings", type: "continuous" },
    { sectionBreak: "Findings", type: "nextPage" },
    { pageBreak: true },
    { after: "Findings", nth: 2, pageBreak: true },
    { footnote: "discrepancy", text: "The audit of March." },
    { toc: true, levels: 3 },
    { after: "Title", toc: true, levels: 2 },
    { formatTable: "Ledger", table: { headerRows: 1 } },
  ]);
  // An op that takes no set refuses one that sets something.
  assert.throws(() => formatJob("docx", [{ toc: true, set: { bold: true } }]), refused("bad_op", 0));
});

test("office_format refuses what does not hold before anything is sent, naming the op and what it takes", () => {
  const no = (ops: unknown[], pattern: RegExp, code = "bad_op", op = 0) =>
    assert.throws(() => formatJob("docx", ops), (e: unknown) => {
      assert.ok(e instanceof OpError, String(e));
      assert.equal(e.code, code, e.message);
      assert.equal(e.op, op, e.message);
      assert.match(e.message, pattern);
      return true;
    });
  // Unknown keys: the refusal lists the ones the op takes.
  no([{ format: "a", set: { bolt: true } }], /set has "bolt", which is not a key of text and paragraphs \(they are font, fontSize, bold,/);
  no([{ format: "a", set: { paragraph: { list: "bullet" } } }], /set has "paragraph", which is not a key of text and paragraphs \(they are [^)]*\); set is flat: its keys go in it directly/);
  no([{ format: "a", set: { bold: true }, colour: "x" }], /"colour" is not part of \{format, through, nth, set\}/);
  no([{ defineStyle: "S", type: "character", set: { align: "center" } }], /not a key of a character style/);
  no([{ defineStyle: "S", set: { link: "https://x.org" } }], /not a key of a paragraph style/);
  no([{ formatTable: "a", cells: "A1", set: { tableStyle: "x" } }], /not a key of cells/);
  // A link lies inside one paragraph, and a cell may hold several: no cell or table key.
  no([{ formatTable: "a", cells: "A1", set: { link: "https://example.com/" } }], /set has "link", which is not a key of cells/);
  no([{ formatTable: "a", set: { link: "" } }], /set has "link", which is not a key of a table/);
  // basedOn is a style's name, refused as one.
  no([{ defineStyle: "N", basedOn: "", set: { bold: true } }], /^op 1: basedOn is the name of a paragraph style the document has \(or one this call makes\), as office_read with formatting names it$/);
  no([{ defineStyle: "N", type: "character", basedOn: 3, set: { bold: true } }], /basedOn is the name of a character style/);
  no([{ page: "a", set: { bold: true } }], /not a key of page setup/);
  // Shapes.
  no([{ through: "b", set: { bold: true } }], /must be exactly one of .* \(it has none of them\): through goes in \{format: "<quote>", through, set\}, whose first key names its place$/);
  // A real model's op without its first key (ten times in a run): the refusal writes out the op its keys belong to.
  no([{ cells: "B1:B4", set: { align: "right" } }], /\(it has none of them\): cells goes in \{formatTable: "<text in the table>", cells, set\}, whose first key names its place$/);
  no([{ set: { align: "right" } }], /\(it has none of them\): set goes in \{format: "<quote>", set\}, \{formatTable: "<text in the table>", set\} or \{page: "<quote>" or "\*", set\}/);
  no([{ levels: 2 }], /levels goes in \{toc: true, levels\}/);
  no([{ text: "Audit due." }], /text goes in \{footnote: "<quote>", text\}/);
  no([{ basedOn: "Normal", set: { italic: true } }], /basedOn goes in \{defineStyle: "<style name>", basedOn, set\}/);
  no([{ format: "a", page: "b", set: {} }], /it has format and page/);
  no([{ format: "unaudited", footnote: true, text: "x" }], /\(it has format and footnote\): each is an op of its own, its quote the value of its first key \(\{footnote: "<quote>", …\}\)$/);
  no([{ format: "a" }], /set is an object of what to set/);
  no([{ format: "a", set: {} }], /set is an object/);
  no([{ format: "a", set: Object.fromEntries(Array.from({ length: MAX_SET_KEYS + 1 }, (_, k) => [`k${k}`, 1])) }], new RegExp(`at most ${MAX_SET_KEYS} keys`));
  no([{ format: "", set: { bold: true } }], /format is text of the document's body/);
  no([{ format: "a\nb", set: { bold: true } }], /one line/);
  no([{ format: "a", nth: 0, set: { bold: true } }], /nth is a whole number from 1/);
  no([{ page: "*", nth: 2, set: { margins: 72 } }], /"\*" is every section/);
  no([{ pageBreak: true, nth: 2 }], /give after with it/);
  // Content ops are office_edit's, spreadsheet ops a spreadsheet's.
  no([{ quote: "a", replacement: "b" }], /`quote` is an office_edit op/);
  no([{ format: "a", set: { bold: true } }, { paragraphs: ["x"] }], /`paragraphs` is an office_edit op/, "bad_op", 1);
  no([{ range: "A1", values: [[1]] }], /spreadsheet edit/, "unsupported_format");
  assert.throws(() => formatJob("xlsx", [{ footnote: "a", text: "b" }]), refused("unsupported_format"));
  // Values.
  no([{ format: "a", set: { bold: "yes" } }], /set.bold is true or false/);
  no([{ format: "a", set: { fontSize: 0 } }], /set.fontSize is the size in points/);
  no([{ format: "a", set: { color: "red" } }], /set.color is "#RRGGBB" or "auto"/);
  no([{ format: "a", set: { highlight: "purple" } }], /set.highlight is one of yellow, green/);
  no([{ format: "a", set: { highlight: "#FFFF01" } }], /or the colour of one: "#FFFF00" is yellow/);
  no([{ format: "a", set: { link: "javascript:alert(1)" } }], /http, https or mailto/);
  no([{ format: "a", set: { link: "ftp://x.org/f" } }], /http, https or mailto/);
  no([{ format: "a", set: { superscript: true, subscript: true } }], /superscript or subscript, not both/);
  no([{ format: "a", set: { clear: false } }], /set.clear is true/);
  no([{ format: "a", set: { align: "middle" } }], /set.align is left, center, right, justify/);
  no([{ format: "a", set: { spaceBefore: "1 furlong" } }], /set.spaceBefore is a length/);
  no([{ format: "a", set: { spaceBefore: -12 } }], /not negative/);
  no([{ format: "a", set: { lineSpacing: 20 } }], /set.lineSpacing is a multiple/);
  no([{ format: "a", set: { list: "dash" } }], /set.list is "bullet", "number" or "none"/);
  no([{ format: "a", set: { level: 10 } }], /set.level is a list level from 1 to 9/);
  no([{ format: "a", set: { list: "none", level: 2 } }], /no level or listStart with it/);
  no([{ defineStyle: "S", type: "table", set: { bold: true } }], /type is "paragraph" \(the default\) or "character"/);
  no([{ defineStyle: "S", change: false, set: { bold: true } }], /change is true/);
  no([{ formatTable: "a", set: { merge: true } }], /merge takes cells/);
  no([{ formatTable: "a", cells: "A1", set: { merge: true } }], /two cells or more/);
  no([{ formatTable: "a", cells: "A1:J21", set: { merge: true } }], new RegExp(`${MAX_MERGE_CELLS} cells at most`));
  no([{ formatTable: "a", cells: "A0", set: { fill: "none" } }], /cells is a table's cells as A1:C2/);
  no([{ formatTable: "a", set: { borders: "double" } }], /set.borders is "all"/);
  no([{ formatTable: "a", set: { borders: { top: "double 1pt #000000" } } }], /the editor draws single borders only/);
  no([{ formatTable: "a", set: { borders: { diagonal: "none" } } }], /its sides are top, bottom, left, right, insideH, insideV/);
  no([{ formatTable: "a", set: { width: "120%" } }], /set.width is a share/);
  no([{ formatTable: "a", set: { columnWidths: [] } }], /a list of lengths/);
  no([{ formatTable: "a", set: { columnWidths: ["3cm", "wide"] } }], /set.columnWidths\[1\] is a length/);
  no([{ page: "a", set: { pageSize: "B5" } }], /set.pageSize is A3, A4, A5, Letter, Legal, or \[width, height\]/);
  no([{ page: "a", set: { pageSize: [10, 10] } }], /from 1 to 22 inches/);
  no([{ page: "a", set: { margins: [1, 2] } }], /one length for all four, or \[top, right, bottom, left\]/);
  no([{ page: "a", set: { header: "a\nb" } }], /set.header is its text, one line/);
  no([{ page: "a", set: { replace: true } }], /set.replace goes with header or footer/);
  no([{ sectionBreak: "a", type: "oddish" }], /type is "nextPage" \(the default\)/);
  no([{ pageBreak: "yes" }], /pageBreak is true/);
  no([{ footnote: "a", text: "" }], /text is the footnote's text/);
  no([{ toc: true, levels: 10 }], /levels is a whole number from 1 to 9/);
  // The caps of every call.
  assert.throws(() => formatJob("docx", Array.from({ length: MAX_OPS + 1 }, () => ({ pageBreak: true }))), refused("bad_op"));
  assert.throws(() => formatJob("docx", []), refused("bad_op"));
});

/* ---------------- spreadsheets (#13 PR 3) ---------------- */

test("office_format (spreadsheet): each op and set key, in the agent's words, reaches the command in the builder's terms", () => {
  const job = formatJob("xlsx", [
    { sheet: "Data", format: "b2:d9", set: { numberFormat: '#,##0.00 "€"', font: "Arial", fontSize: 10.5, bold: true, italic: false, underline: true, strike: false, superscript: true, color: "#c81e1e", fill: "none", align: "center", valign: "top", wrap: true, rotation: -45, borders: { bottom: "double #FF0000", insideH: "dashed 2pt", top: "single 1.5pt", left: "3pt" }, merge: false, clear: true } },
    { format: "C:D", set: { fill: "#1F4E79" } },
    { format: "5:6", set: { rotation: "vertical", borders: "outside" } },
    { format: "A1", set: { subscript: true } },
    { columns: "c:e", width: 18.456 },
    { sheet: "Data", columns: "F", hide: true },
    { rows: "7", height: 30, show: true },
    { rows: "8:9", autofit: true },
    { columns: "G", set: { width: 12 } },
    { freeze: "B3" },
    { sheet: "Data", freeze: "A2" },
    { freeze: "none" },
    { freeze: "A1" },
  ]);
  assert.equal(job.kind, "cell.format");
  const black = { r: 0, g: 0, b: 0 };
  assert.deepEqual(job.args.ops, [
    { sheet: "Data", format: "B2:D9", area: { col: 1, row: 1, cols: 3, rows: 8 }, looks: { numberFormat: '#,##0.00 "€"', font: "Arial", size: 10.5, bold: true, italic: false, underline: true, strike: false, vertAlign: "superscript", color: { r: 200, g: 30, b: 30 }, fill: "none", align: "center", valign: "top", wrap: true, rotation: -45, borders: { bottom: { style: "Double", color: { r: 255, g: 0, b: 0 } }, insideH: { style: "MediumDashed", color: black }, top: { style: "Medium", color: black }, left: { style: "Thick", color: black } }, merge: false, clear: true } },
    { format: "C:D", area: { col: 2, row: 0, cols: 2, rows: 1048576, whole: "columns" }, looks: { fill: { r: 31, g: 78, b: 121 } } },
    { format: "5:6", area: { col: 0, row: 4, cols: 16384, rows: 2, whole: "rows" }, looks: { rotation: 255, borders: { top: { style: "Thin", color: black }, bottom: { style: "Thin", color: black }, left: { style: "Thin", color: black }, right: { style: "Thin", color: black } } } },
    { format: "A1", area: { col: 0, row: 0, cols: 1, rows: 1 }, looks: { vertAlign: "subscript" } },
    { columns: "C:E", from: 2, count: 3, width: 18.46 },
    { sheet: "Data", columns: "F:F", from: 5, count: 1, hidden: true },
    { rows: "7:7", from: 6, count: 1, height: 30, hidden: false },
    { rows: "8:9", from: 7, count: 2, autofit: true },
    { columns: "G:G", from: 6, count: 1, width: 12 },
    { freeze: "B3", cols: 1, rows: 2 },
    { sheet: "Data", freeze: "A2", cols: 0, rows: 1 },
    { freeze: "none", cols: 0, rows: 0 },
    { freeze: "none", cols: 0, rows: 0 },
  ]);
});

test("office_format (spreadsheet): what does not hold is refused before anything is sent, naming the op and what it takes", () => {
  const no = (ops: unknown[], message: RegExp, code = "bad_op", op = 0) =>
    assert.throws(() => formatJob("xlsx", ops), (e: unknown) => {
      assert.ok(e instanceof OpError, String(e));
      assert.equal(e.code, code, e.message);
      assert.equal(e.op, op, e.message);
      assert.match(e.message, message);
      return true;
    }, JSON.stringify(ops));
  no([{ format: "A1" }], /set is an object of what to set \(for cells: numberFormat, font/);
  no([{ format: "A1", bold: true }], /"bold" is not part of \{sheet\?, format, set\}: what to set goes in set/);
  no([{ format: "A0", set: { bold: true } }], /format is the cells, as "A1:D9", or whole columns "C:D" or rows "5:6"/);
  no([{ format: "C", set: { bold: true } }], /format is the cells/);
  no([{ format: "A1", columns: "C", set: { bold: true } }], /each is an op of its own/);
  no([{ format: "A1", sheet: "", set: { bold: true } }], /sheet is a sheet's name/);
  no([{ format: "A1", set: { highlight: "yellow" } }], /"highlight", which is not a key of cells .*\(highlight, link and style are Word's\)/);
  no([{ format: "A1", set: { font: { bold: true } } }], /set.font is a font's name/);
  no([{ format: "A1", set: { text: { bold: true } } }], /set is flat/);
  no([{ format: "A1", set: { numberFormat: "" } }], /set.numberFormat is a number format as Excel writes it/);
  // One bound for every size a sheet does not take, the sheet's: below 1 too, not Word's 1638.
  for (const fontSize of [500, 0.4, 2000]) no([{ format: "A1", set: { fontSize } }], /set\.fontSize is the size in points, from 1 to 409 \(halves too: 10\.5\)$/);
  no([{ format: "A1", set: { color: "auto" } }], /set.color is "#RRGGBB"$/);
  no([{ format: "A1", set: { fill: "red" } }], /set.fill is "#RRGGBB" or "none"/);
  no([{ format: "A1", set: { align: "general" } }], /set.align is left, center, right, justify \(the editor's API sets no "general" back: clear: true/);
  no([{ format: "A1", set: { valign: "middle" } }], /set.valign is "top", "center" or "bottom"/);
  no([{ format: "A1", set: { rotation: 100 } }], /set.rotation is the text's angle in degrees, a whole number from -90 to 90/);
  no([{ format: "A1", set: { rotation: 12.5 } }], /set.rotation/);
  no([{ format: "A1", set: { borders: "none" } }], /there is no "none" \(clear: true takes all of the cells' formatting off\)/);
  no([{ format: "A1", set: { borders: { bottom: "none" } } }], /set.borders.bottom is a line, .*there is no "none"/);
  no([{ format: "A1", set: { borders: { bottom: "wavy" } } }], /set.borders.bottom is a line, as "single 1pt #000000" \(single, double, dashed or dotted/);
  no([{ format: "A1", set: { borders: { diagonal: "single" } } }], /its sides are top, bottom, left, right, insideH, insideV/);
  no([{ format: "A1", set: { merge: true } }], /a merge takes two cells or more/);
  no([{ format: "C:D", set: { merge: true } }], /merge takes cells \("A1:D1"\), not whole columns or rows/);
  no([{ format: "A1", set: { superscript: true, subscript: true } }], /superscript or subscript, not both/);
  no([{ format: "A1", set: { clear: false } }], /set.clear is true/);
  no([{ columns: "C" }], /give what to do with the columns: width, hide, show or autofit/);
  no([{ columns: "C1", width: 3 }], /columns is columns by their letters, "C" or "C:E"/);
  no([{ columns: "C", height: 3 }], /"height" is not part of \{sheet\?, columns, width\?, hide\?, show\?, autofit\?\} \(columns take a width in characters\)/);
  no([{ rows: "x", height: 3 }], /rows is rows by their numbers, "5" or "5:7"/);
  no([{ rows: "5", width: 3 }], /rows take a height in points/);
  no([{ rows: "5", height: 500 }], /height is the rows' height in points/);
  no([{ columns: "C", width: 0 }], /width is the columns' width in characters/);
  no([{ columns: "C", hide: true, show: true }], /hide or show, not both/);
  no([{ columns: "C", width: 3, autofit: true }], /width or autofit, not both/);
  no([{ columns: "C", hide: false }], /hide is true/);
  no([{ freeze: "B2:C3" }], /freeze is the first cell that scrolls/);
  no([{ freeze: true }], /freeze is the first cell that scrolls/);
  no([{ freeze: "B2", set: {} }], /"set" is not part of \{sheet\?, freeze\}/);
  // Content ops are office_edit's, Word ops a Word document's.
  no([{ range: "A1", values: [[1]] }], /`range` is an office_edit op \(what the sheet holds\)/);
  no([{ format: "A1", set: { bold: true } }, { insertRows: "5" }], /`insertRows` is an office_edit op/, "bad_op", 1);
  no([{ addSheet: "X" }], /`addSheet` is an office_edit op/);
  no([{ footnote: "a", text: "b" }], /is a Word op \(`footnote`\), and this is a spreadsheet/, "unsupported_format");
  no([{ formatTable: "a", set: { fill: "none" } }], /is a Word op/, "unsupported_format");
  // The caps: cells by their addresses, and columns and rows.
  assert.doesNotThrow(() => formatJob("xlsx", [{ format: "A1:CV36", set: { bold: true } }, { format: "A:XFD", set: { bold: true } }]));
  // A whole column or row counts one here (the command counts the used cells among them): every row of a sheet is far
  // more than a call formats, and refused before the agents' browser builds any of it.
  assert.throws(() => formatJob("xlsx", [{ format: "1:1048576", set: { font: "Arial" } }]), (e: unknown) => e instanceof OpError && /formats 20,000 cells at most \(got 1,048,576, a whole column or row counting one\)/.test(e.message));
  assert.throws(() => formatJob("xlsx", [{ format: "A1:CV200", set: { bold: true } }, { format: "A:A", set: { bold: true } }]), (e: unknown) => e instanceof OpError && /\(got 20,001,/.test(e.message));
  assert.throws(() => formatJob("xlsx", [{ format: "A1:CV200", set: { bold: true } }, { format: "A201", set: { bold: true } }]), (e: unknown) => e instanceof OpError && new RegExp(`formats ${MAX_FORMAT_CELLS.toLocaleString("en")} cells at most \\(got 20,001,`).test(e.message));
  assert.throws(() => formatJob("xlsx", [{ rows: "1:20001", height: 20 }]), (e: unknown) => e instanceof OpError && /take 20,000 columns and rows at most/.test(e.message));
});

test("office_edit (spreadsheet): rows and columns inserted and deleted, by number or letter, either end first; deletes come after every op that can be taken back", () => {
  const ops = editJob("xlsx", [{ sheet: "Data", insertRows: "6:5" }, { insertColumns: "c" }, { range: "A1", values: [[1]] }, { addSheet: "New" }, { deleteRows: "$9" }, { sheet: "Data", deleteColumns: "B:D" }]).args.ops;
  assert.deepEqual(ops, [
    { sheet: "Data", insertRows: "5:6", from: 4, count: 2 },
    { insertColumns: "C:C", from: 2, count: 1 },
    { range: "A1", values: [[1]] },
    { addSheet: "New" },
    { deleteRows: "9:9", from: 8, count: 1 },
    { sheet: "Data", deleteColumns: "B:D", from: 1, count: 3 },
  ]);
  const no = (list: unknown[], message: RegExp, op: number) => assert.throws(() => editJob("xlsx", list), (e: unknown) => e instanceof OpError && e.code === "bad_op" && e.op === op && message.test(e.message), JSON.stringify(list));
  no([{ deleteRows: "5" }, { range: "A1", values: [[1]] }], /^op 1 cannot be taken back once made \(deleted rows\), so it goes after every op that can: put it last in the call \(op 2 comes after it\)/, 0);
  no([{ range: "A1", values: [[1]] }, { deleteColumns: "B" }, { insertRows: "2" }], /^op 2 cannot be taken back/, 1);
  no([{ insertRows: "A" }], /insertRows is rows by their numbers, "5" or "5:7"/, 0);
  no([{ insertColumns: "5" }], /insertColumns is columns by their letters/, 0);
  no([{ insertRows: "0" }], /insertRows is rows/, 0);
  no([{ insertRows: "5", values: [[1]] }], /must be exactly one of/, 0);
  no([{ insertRows: "5", deleteRows: "6" }], /must be exactly one of/, 0);
  no([{ insertRows: "5", count: 2 }], /"count" is not part of \{sheet\?, insertRows\}/, 0);
  // Not sheet ops: no wait for the Document Server, so no count against MAX_SHEET_OPS.
  assert.doesNotThrow(() => editJob("xlsx", Array.from({ length: MAX_SHEET_OPS + 5 }, (_, k) => ({ insertRows: String(k + 1) }))));
  // As many rows and columns a call as a format reads cells: an insert taken back reads what was written into it.
  assert.doesNotThrow(() => editJob("xlsx", [{ insertRows: "2:10001" }, { insertColumns: "A:J" }, { deleteRows: "1:9990" }]));
  no([{ insertRows: "2:1000001" }, { range: "A1", values: [[1]] }], /^one call inserts and deletes 20,000 rows and columns at most \(got 1,000,000\)/, undefined as unknown as number);
  assert.deepEqual(parseLines("XFD", "columns"), { from: 16383, count: 1, text: "XFD:XFD" });
  assert.equal(parseLines("XFE", "columns"), null);
  assert.equal(parseLines("1048577", "rows"), null);
  assert.deepEqual(parseArea("$b$2"), { area: { col: 1, row: 1, cols: 1, rows: 1 }, text: "B2" });
  assert.deepEqual(parseArea("d:c")?.text, "C:D");
  assert.equal(parseArea("5"), null);
});

const BLACK = { r: 0, g: 0, b: 0 };
const refusal = (run: () => unknown, message: RegExp, code = "bad_op", op: number | null = 0) =>
  assert.throws(run, (e: unknown) => {
    assert.ok(e instanceof OpError, String(e));
    assert.equal(e.code, code, e.message);
    if (op !== null) assert.equal(e.op, op, e.message);
    assert.match(e.message, message);
    return true;
  });

test("office_format (spreadsheet): conditional formats, in the agent's words, reach the command as the builder takes them", () => {
  const job = formatJob("xlsx", [
    { sheet: "Data", conditional: "b2:b9", set: { rule: "cell", operator: ">", value: 1000, fill: "#c6efce", color: "#006100", bold: true } },
    { conditional: "C:C", rule: "cell", operator: "between", value: 5, value2: "9", italic: true, underline: true, strike: false },
    { conditional: "D2:D9", set: { rule: "formula", formula: "=$A2=\"x\"", fill: "#FFC7CE" } },
    { conditional: "E2:E9", set: { rule: "colorScale" } },
    { conditional: "E2:E9", set: { rule: "colorScale", colors: ["#FF0000", "#00FF00"] } },
    { conditional: "F2:F9", set: { rule: "dataBar", color: "#638EC6" } },
    { conditional: "G2:G9", set: { rule: "top", rank: 3, bottom: true, percent: true, bold: true } },
    { conditional: "G2:G9", set: { rule: "top", fill: "#FFFF00" } },
    { conditional: "H2:H9", set: { rule: "duplicates", fill: "#FFEB9C" } },
    { conditional: "H2:H9", set: { rule: "duplicates", unique: true, color: "#000000" } },
    { conditional: "A1:H9", set: { clear: true } },
  ]);
  assert.equal(job.kind, "cell.format");
  const rgb = (r: number, g: number, b: number) => ({ r, g, b });
  assert.deepEqual(job.args.ops, [
    { sheet: "Data", conditional: "B2:B9", area: { col: 1, row: 1, cols: 1, rows: 8 }, rule: { rule: "cell", operator: "xlGreater", value: "1000", fill: rgb(198, 239, 206), color: rgb(0, 97, 0), bold: true } },
    { conditional: "C:C", area: { col: 2, row: 0, cols: 1, rows: 1048576, whole: "columns" }, rule: { rule: "cell", operator: "xlBetween", value: "5", value2: "9", italic: true, underline: true, strike: false } },
    { conditional: "D2:D9", area: { col: 3, row: 1, cols: 1, rows: 8 }, rule: { rule: "formula", formula: '=$A2="x"', fill: rgb(255, 199, 206) } },
    { conditional: "E2:E9", area: { col: 4, row: 1, cols: 1, rows: 8 }, rule: { rule: "colorScale" } },
    { conditional: "E2:E9", area: { col: 4, row: 1, cols: 1, rows: 8 }, rule: { rule: "colorScale", colors: [rgb(255, 0, 0), rgb(0, 255, 0)] } },
    { conditional: "F2:F9", area: { col: 5, row: 1, cols: 1, rows: 8 }, rule: { rule: "dataBar", color: rgb(99, 142, 198) } },
    { conditional: "G2:G9", area: { col: 6, row: 1, cols: 1, rows: 8 }, rule: { rule: "top", rank: 3, bottom: true, percent: true, bold: true } },
    { conditional: "G2:G9", area: { col: 6, row: 1, cols: 1, rows: 8 }, rule: { rule: "top", rank: 10, bottom: false, percent: false, fill: rgb(255, 255, 0) } },
    { conditional: "H2:H9", area: { col: 7, row: 1, cols: 1, rows: 8 }, rule: { rule: "duplicates", unique: false, fill: rgb(255, 235, 156) } },
    { conditional: "H2:H9", area: { col: 7, row: 1, cols: 1, rows: 8 }, rule: { rule: "duplicates", unique: true, color: BLACK } },
    { conditional: "A1:H9", area: { col: 0, row: 0, cols: 8, rows: 9 }, clear: true },
  ]);
  for (const op of ["<", "<=", "=", "<>", "notBetween", "NOT BETWEEN"]) {
    const two = /between/i.test(op);
    assert.doesNotThrow(() => formatJob("xlsx", [{ conditional: "A1", set: { rule: "cell", operator: op, value: 1, ...(two ? { value2: 2 } : {}), bold: true } }]), op);
  }
});

test("office_format (spreadsheet): a conditional format that does not hold is refused, naming what its rule takes", () => {
  const no = (set: unknown, message: RegExp) => refusal(() => formatJob("xlsx", [{ conditional: "B2:B9", set }]), message);
  no({}, /set.rule is one of cell, formula, colorScale, dataBar, top, duplicates, or clear: true to take rules off/);
  no({ rule: "bold" }, /set.rule is one of cell, formula/);
  no({ rule: "cell", operator: "~", value: 1, bold: true }, /set.operator is one of > >= < <= = <> between notBetween/);
  no({ rule: "cell", operator: ">", bold: true }, /set.value is what the cells are compared with/);
  no({ rule: "cell", operator: ">", value: 1 }, /a "cell" rule changes how cells look: give fill, color, bold, italic, underline, strike/);
  no({ rule: "cell", operator: ">", value: 1, value2: 2, bold: true }, /> takes set.value alone/);
  no({ rule: "cell", operator: "between", value: 1, bold: true }, /between takes set.value and set.value2/);
  no({ rule: "cell", operator: ">", value: "a\nb", bold: true }, /set.value is a number or a text/);
  no({ rule: "cell", operator: ">", value: 1, fill: "red" }, /set.fill is "#RRGGBB"/);
  no({ rule: "cell", operator: ">", value: 1, bold: "yes" }, /set.bold is true or false/);
  no({ rule: "cell", operator: ">", value: 1, bold: true, colors: [] }, /"colors" is not a key of a "cell" rule \(it takes operator, value, value2, fill, color/);
  no({ rule: "formula", formula: "A1>1", bold: true }, /set.formula is a formula starting with "="/);
  no({ rule: "formula", formula: "=A1>1" }, /changes how cells look/);
  no({ rule: "colorScale", colors: ["#FF0000"] }, /set.colors is two or three colours/);
  no({ rule: "colorScale", colors: ["#FF0000", "#00FF00", "#0000FF", "#FFFFFF"] }, /set.colors is two or three colours/);
  no({ rule: "colorScale", colors: ["#FF0000", "red"] }, /set.colors is "#RRGGBB"/);
  no({ rule: "dataBar", fill: "#FF0000" }, /"fill" is not a key of a "dataBar" rule \(it takes color\)/);
  no({ rule: "top", rank: 0, bold: true }, /set.rank is how many cells/);
  no({ rule: "top", rank: 2.5, bold: true }, /set.rank/);
  no({ rule: "duplicates" }, /changes how cells look/);
  no({ rule: "duplicates", unique: "yes", bold: true }, /set.unique is true or false/);
  no({ clear: true, rule: "cell" }, /clear is true, and the only key then/);
  no({ clear: false }, /clear is true/);
  no({ rule: { cell: "x" } }, /set.rule is one of/);
  refusal(() => formatJob("xlsx", [{ conditional: "B2:B9", set: "x" }]), /set is an object of conditional's keys \(rule, operator/);
  refusal(() => formatJob("xlsx", [{ conditional: "B2:B9", rule: "cell", operator: ">", value: 1, bold: true, tint: 1 }]), /"tint" is not a key of conditional \(they are rule, operator/);
  refusal(() => formatJob("xlsx", [{ conditional: "B", set: { clear: true } }]), /conditional is the cells, as "B2:B9" or a whole column "C:C" \(got "B"\)/);
});

test("office_format (spreadsheet): validation: a list, a number, a date or a length with its condition, or clear", () => {
  const job = formatJob("xlsx", [
    { sheet: "Data", validate: "e2:e9", set: { list: ["Open", "Done", " Blocked "] } },
    { validate: "E2:E9", set: { list: "Data!A2:A9" } },
    { validate: "E2:E9", set: { list: "'My data'!$B$1:$B$5" } },
    { validate: "E2:E9", set: { list: [1, 2, 3] } },
    { validate: "B2:B9", set: { whole: ">= 0" } },
    { validate: "B2:B9", whole: "between 1 and 10" },
    { validate: "C2:C9", set: { decimal: "<>0" } },
    { validate: "D2:D9", set: { date: ">= 2026-01-31" } },
    { validate: "D2:D9", set: { date: "notBetween 2026-01-01 and 2026-12-31" } },
    { validate: "F2:F9", set: { length: "<= 20" } },
    { validate: "F2:F9", set: { clear: true } },
  ]);
  assert.deepEqual(job.args.ops, [
    { sheet: "Data", validate: "E2:E9", area: { col: 4, row: 1, cols: 1, rows: 8 }, check: { type: "xlValidateList", operator: "xlBetween", f1: "Open,Done,Blocked" } },
    { validate: "E2:E9", area: { col: 4, row: 1, cols: 1, rows: 8 }, check: { type: "xlValidateList", operator: "xlBetween", f1: "='Data'!$A$2:$A$9" } },
    { validate: "E2:E9", area: { col: 4, row: 1, cols: 1, rows: 8 }, check: { type: "xlValidateList", operator: "xlBetween", f1: "='My data'!$B$1:$B$5" } },
    { validate: "E2:E9", area: { col: 4, row: 1, cols: 1, rows: 8 }, check: { type: "xlValidateList", operator: "xlBetween", f1: "1,2,3" } },
    { validate: "B2:B9", area: { col: 1, row: 1, cols: 1, rows: 8 }, check: { type: "xlValidateWholeNumber", operator: "xlGreaterEqual", f1: "0" } },
    { validate: "B2:B9", area: { col: 1, row: 1, cols: 1, rows: 8 }, check: { type: "xlValidateWholeNumber", operator: "xlBetween", f1: "1", f2: "10" } },
    { validate: "C2:C9", area: { col: 2, row: 1, cols: 1, rows: 8 }, check: { type: "xlValidateDecimal", operator: "xlNotEqual", f1: "0" } },
    // The date as its serial day number: 2026-01-31 is day 46053.
    { validate: "D2:D9", area: { col: 3, row: 1, cols: 1, rows: 8 }, check: { type: "xlValidateDate", operator: "xlGreaterEqual", f1: "46053" } },
    { validate: "D2:D9", area: { col: 3, row: 1, cols: 1, rows: 8 }, check: { type: "xlValidateDate", operator: "xlNotBetween", f1: "46023", f2: "46387" } },
    { validate: "F2:F9", area: { col: 5, row: 1, cols: 1, rows: 8 }, check: { type: "xlValidateTextLength", operator: "xlLessEqual", f1: "20" } },
    { validate: "F2:F9", area: { col: 5, row: 1, cols: 1, rows: 8 }, check: null },
  ]);
});

test("office_format (spreadsheet): a validation that does not hold is refused", () => {
  const no = (set: unknown, message: RegExp) => refusal(() => formatJob("xlsx", [{ validate: "E2:E9", set }]), message);
  no({}, /give exactly one of list, whole, decimal, date, length or clear \(it has none\)/);
  no({ list: ["a"], whole: "> 1" }, /exactly one of list, whole.*\(it has list and whole\)/);
  no({ list: [] }, /set.list is the allowed entries/);
  no({ list: ["a,b"] }, /set.list is the allowed entries.*no commas/);
  no({ list: [""] }, /set.list is the allowed entries/);
  no({ list: Array.from({ length: 101 }, (_, k) => `v${k}`) }, /set.list is the allowed entries/);
  no({ list: ["x".repeat(130), "y".repeat(130)] }, /set.list holds at most 255 characters in all/);
  no({ list: "not a range" }, /set.list is the allowed entries/);
  no({ whole: "> 1.5" }, /set.whole is a condition on the cells' number: ">= 0", "= 5", "between 1 and 10"/);
  no({ whole: 5 }, /set.whole is a condition/);
  no({ decimal: "between 1 and" }, /set.decimal is a condition/);
  no({ decimal: "> abc" }, /set.decimal is a condition/);
  no({ length: "> -1" }, /set.length is a condition on the cells' text length/);
  no({ date: "> 31.01.2026" }, /set.date is a condition on the cells' date.*dates as 2026-01-31/);
  no({ date: "> 2026-02-30" }, /set.date is a condition/);
  no({ clear: true, list: ["a"] }, /give exactly one of list, whole, decimal, date, length or clear \(it has list and clear\)/);
  // (No message: the editor's setters for it send nothing, so a refused entry shows the editor's own.)
  no({ whole: "> 1", message: "Pick one" }, /"message" is not a key of validate/);
  no({ clear: 1 }, /clear is true/);
  no({ whole: "> 1", format: 2 }, /"format" is not a key of validate \(they are list, whole, decimal, date, length, clear\)/);
  refusal(() => formatJob("xlsx", [{ validate: "E:E", set: { clear: true } }]), /validate takes cells \("A1:D9"\), not whole columns or rows/);
});

test("office_format (spreadsheet): a link in a cell, a chart, a filter and a table, in the agent's words", () => {
  const job = formatJob("xlsx", [
    { sheet: "Data", link: "a2", set: { url: "https://example.com/x", text: "Example" } },
    { link: "B2", url: "mailto:a@example.com" },
    { sheet: "Data", chart: "a1:c5", set: { type: "bar", title: "Revenue", xTitle: "Region", yTitle: "EUR", legend: "bottom", at: "h2", width: "10cm", height: 200, rows: true } },
    { chart: "A1:B5" },
    { chart: "A1:B5", set: { type: "pie" } },
    { filter: "a1:d9" },
    { filter: "A1:D9", set: { column: "b", criteria: ">500" } },
    { filter: "A1:D9", set: { column: "C", criteria: "N", or: "S" } },
    { filter: "A1:D9", column: "D", criteria: "<5", and: ">1" },
    { filter: "none" },
    { asTable: "A1:C5" },
  ]);
  assert.deepEqual(job.args.ops, [
    { sheet: "Data", link: "A2", at: { col: 0, row: 1 }, url: "https://example.com/x", text: "Example" },
    { link: "B2", at: { col: 1, row: 1 }, url: "mailto:a@example.com" },
    // Sizes in EMU (a twip is 635): 10cm, and 200pt.
    { sheet: "Data", chart: "A1:C5", area: { col: 0, row: 0, cols: 3, rows: 5 }, chartType: "horizontalBar", title: "Revenue", xTitle: "Region", yTitle: "EUR", legend: "bottom", at: { col: 7, row: 1 }, width: 5669 * 635, height: 4000 * 635, inRows: true },
    // Right of the data by default, 12 x 7.5 cm, a column chart.
    { chart: "A1:B5", area: { col: 0, row: 0, cols: 2, rows: 5 }, chartType: "bar", at: { col: 3, row: 0 }, width: 6803 * 635, height: 4252 * 635, inRows: false },
    { chart: "A1:B5", area: { col: 0, row: 0, cols: 2, rows: 5 }, chartType: "pie", at: { col: 3, row: 0 }, width: 6803 * 635, height: 4252 * 635, inRows: false },
    { filter: "A1:D9", area: { col: 0, row: 0, cols: 4, rows: 9 } },
    { filter: "A1:D9", area: { col: 0, row: 0, cols: 4, rows: 9 }, column: 2, criteria: ">500" },
    { filter: "A1:D9", area: { col: 0, row: 0, cols: 4, rows: 9 }, column: 3, criteria: "N", or: "S" },
    { filter: "A1:D9", area: { col: 0, row: 0, cols: 4, rows: 9 }, column: 4, criteria: "<5", and: ">1" },
    { filter: "none" },
    { asTable: "A1:C5", area: { col: 0, row: 0, cols: 3, rows: 5 } },
  ]);
});

test("office_format (spreadsheet): a link, chart, filter or table that does not hold is refused", () => {
  const no = (ops: unknown, message: RegExp, code = "bad_op", op = 0) => refusal(() => formatJob("xlsx", ops as unknown[]), message, code, op);
  no([{ link: "A1:A2", set: { url: "https://example.com" } }], /link is one cell, as "A2"/);
  no([{ link: "A1", set: { url: "javascript:alert(1)" } }], /set.url is the link's address \(http, https or mailto\)/);
  no([{ link: "A1", set: {} }], /set.url is the link's address/);
  no([{ link: "A1", set: { url: "https://example.com", text: "" } }], /set.text is the cell's text/);
  no([{ link: "A1", set: { url: "https://example.com", target: "x" } }], /"target" is not a key of link \(they are url, text\)/);
  no([{ chart: "A1:C1" }], /a chart takes the data with its header row: at least two rows/);
  no([{ chart: "A1:C5", set: { type: "radar" } }], /set.type is one of column, columnStacked, bar, barStacked, line, pie, doughnut, area, scatter/);
  no([{ chart: "A1:C5", set: { title: "" } }], /set.title is a text/);
  no([{ chart: "A1:C5", set: { legend: "inside" } }], /set.legend is right, bottom, top, left, none/);
  no([{ chart: "A1:C5", set: { at: "H2:I3" } }], /set.at is the cell the chart's top left corner sits in/);
  no([{ chart: "A1:C5", set: { width: "1cm" } }], /set.width is a length from 2cm to 50cm/);
  no([{ chart: "A1:C5", set: { height: "80cm" } }], /set.height is a length from 2cm to 50cm/);
  no([{ chart: "A1:C5", set: { rows: "yes" } }], /set.rows is true or false/);
  no([{ chart: "XFA1:XFB5" }], /no room for the chart right of the data/);
  no([{ chart: "A:C" }], /chart takes cells \("A1:D9"\), not whole columns or rows/);
  no([{ filter: "A1:D1" }], /a filter needs the header row and at least one row of data/);
  no([{ filter: "A1:D9", set: { criteria: ">1" } }], /criteria go with column/);
  no([{ filter: "A1:D9", set: { column: "F", criteria: ">1" } }], /set.column is one column of the range, as a letter between A and D/);
  no([{ filter: "A1:D9", set: { column: "B" } }], /set.criteria is what the column shows/);
  no([{ filter: "A1:D9", set: { column: "B", criteria: ">1", and: ">0", or: "<5" } }], /and or or, not both/);
  no([{ filter: "A1:D9", set: { column: "B", criteria: ">1", or: "" } }], /set.or is a second criterion/);
  no([{ filter: "none", set: { column: "B" } }], /filter "none" takes no other key/);
  no([{ filter: "everything" }], /filter is the range with its header row, as "A1:D9", or "none"/);
  no([{ asTable: "A1:C1" }], /a table needs a header row with its column names and at least one row of data/);
  no([{ asTable: "A1:C5", set: { style: "x" } }], /"set" is not part of \{sheet\?, asTable\}: the table gets the editor's default style/);
  no([{ asTable: "A1:C5", style: "Medium9" }], /"style" is not part of \{sheet\?, asTable\}/);
  no([{ asTable: "A1:C5", chart: "A1:C5" }], /each is an op of its own/);
});

test("office_format (spreadsheet): charts, filters, tables and cleared rules come last in a call; the rest can be taken back and goes before", () => {
  const ok = [{ format: "A1", set: { bold: true } }, { conditional: "A1:A9", set: { rule: "cell", operator: ">", value: 1, bold: true } }, { validate: "B2:B9", set: { clear: true } }, { link: "C1", url: "https://example.com", text: "x" }, { chart: "A1:C5" }, { filter: "A1:D9" }, { asTable: "A1:C5" }, { conditional: "A1:A9", set: { clear: true } }];
  assert.doesNotThrow(() => formatJob("xlsx", ok));
  const no = (ops: unknown[], message: RegExp, op: number) => refusal(() => formatJob("xlsx", ops), message, "bad_op", op);
  no([{ chart: "A1:C5" }, { format: "A1", set: { bold: true } }], /^op 1 cannot be taken back once made \(a chart, which the editor's API cannot remove\), so it goes after every op that can: put it last in the call \(op 2 comes after it\)/, 0);
  no([{ filter: "A1:D9" }, { freeze: "A2" }], /^op 1 cannot be taken back once made \(a filter, which the editor's API cannot take off again\)/, 0);
  no([{ asTable: "A1:C5" }, { columns: "C", width: 9 }], /^op 1 cannot be taken back once made \(a formatted table, which the editor's API cannot turn back\)/, 0);
  no([{ format: "A1", set: { bold: true } }, { conditional: "A1:A9", set: { clear: true } }, { validate: "A1:A9", set: { clear: true } }], /^op 2 cannot be taken back once made \(cleared conditional formats, which cannot be made again\)/, 1);
  // The cells they read count against the call's 20,000, as a format's do.
  refusal(() => formatJob("xlsx", [{ validate: "A1:CV200", set: { clear: true } }, { format: "B1:B5", set: { bold: true } }, { asTable: "A201:A202" }]), /formats 20,000 cells at most \(got 20,007/, "bad_op", null);
});

test("office_format: a spreadsheet's new ops given to a Word document, and the reverse, are refused with their place named", () => {
  refusal(() => formatJob("docx", [{ conditional: "A1", set: { rule: "dataBar" } }]), /op 1 is a spreadsheet op \(`conditional`\), and this is a Word document/, "unsupported_format");
  refusal(() => formatJob("docx", [{ chart: "A1:B5" }]), /is a spreadsheet op \(`chart`\)/, "unsupported_format");
  refusal(() => formatJob("xlsx", [{ sort: "A2:D9", by: ["B"] }]), /`sort` is an office_edit op \(what the sheet holds\)/);
  refusal(() => formatJob("xlsx", [{ name: "Sales", refersTo: "A1" }]), /`name` is an office_edit op/);
  refusal(() => editJob("xlsx", [{ conditional: "A1", set: { rule: "dataBar" } }]), /`conditional` is an office_format op \(how the sheet looks\)/);
  refusal(() => editJob("xlsx", [{ link: "A1", url: "https://example.com" }]), /`link` is an office_format op/);
  refusal(() => editJob("xlsx", [{ validate: "A1", set: { clear: true } }]), /`validate` is an office_format op/);
  refusal(() => editJob("xlsx", [{ asTable: "A1:B3" }]), /`asTable` is an office_format op/);
});

test("office_edit (spreadsheet): a sort by up to three columns, ascending unless desc, taken as the range's own columns", () => {
  const job = editJob("xlsx", [{ sheet: "Data", sort: "a2:d9", by: ["b desc", "C", " d  Ascending "] }, { sort: "B3:C5", by: "C Descending" }, { range: "A1", values: [[1]] }]);
  assert.equal(job.kind, "cell.edit");
  assert.deepEqual(job.args.ops, [
    { sheet: "Data", sort: "A2:D9", area: { col: 0, row: 1, cols: 4, rows: 8 }, by: [{ col: 1, desc: true }, { col: 2, desc: false }, { col: 3, desc: false }] },
    { sort: "B3:C5", area: { col: 1, row: 2, cols: 2, rows: 3 }, by: [{ col: 2, desc: true }] },
    { range: "A1", values: [[1]] },
  ]);
  const no = (ops: unknown[], message: RegExp, op = 0) => refusal(() => editJob("xlsx", ops), message, "bad_op", op);
  no([{ sort: "A2:D9" }], /by is one to three columns of the range to sort by, as \["B desc", "C"\]/);
  no([{ sort: "A2:D9", by: [] }], /by is one to three columns/);
  no([{ sort: "A2:D9", by: ["A", "B", "C", "D"] }], /by is one to three columns/);
  no([{ sort: "A2:D9", by: ["E"] }], /by names column E, which is outside A2:D9/);
  no([{ sort: "A2:D9", by: ["B", "b desc"] }], /by names a column twice/);
  no([{ sort: "A2:D9", by: ["B up"] }], /by holds columns as "B" or "B desc" \(got "B up"\)/);
  no([{ sort: "A2:D9", by: [2] }], /by holds columns as "B" or "B desc"/);
  no([{ sort: "A2:D2", by: ["A"] }], /a sort needs two rows at least/);
  no([{ sort: "A:D", by: ["A"] }], /sort is the cells whose rows are sorted, without a header row, as "A2:D9" \(got "A:D"\)/);
  no([{ sort: "A2:D9", by: ["A"], values: [[1]] }], /must be exactly one of/);
  no([{ sort: "A2:D9", by: ["A"], order: "desc" }], /"order" is not part of \{sheet\?, sort, by\}/);
  no([{ sort: "A2:D9", by: ["A"], insertRows: "5" }], /must be exactly one of/);
  no([{ sheet: "", sort: "A2:D9", by: ["A"] }], /sheet is a sheet's name/);
  // A sort reads its cells to be taken back: as many as a format reads.
  assert.doesNotThrow(() => editJob("xlsx", [{ sort: "A1:CV200", by: ["A"] }]));
  refusal(() => editJob("xlsx", [{ sort: "A1:CV200", by: ["A"] }, { sort: "A201:A202", by: ["A"] }]), /^one call sorts 20,000 cells at most \(got 20,002\)/, "bad_op", null);
  // Deleting rows or columns still goes after it.
  refusal(() => editJob("xlsx", [{ deleteRows: "9" }, { sort: "A2:D8", by: ["A"] }]), /^op 1 cannot be taken back once made \(deleted rows\)/, "bad_op", 0);
});

test("office_edit (spreadsheet): a named range made, changed or deleted, with cells in their absolute form", () => {
  const job = editJob("xlsx", [
    { name: "Sales", refersTo: "Inventory!b6:c9" },
    { name: "Rows", refersTo: "'My data'!$5:$6" },
    { name: "Cols", refersTo: "Data!C:D" },
    { name: "One", refersTo: "$B$2" },
    { name: "Umsätze", refersTo: "B2:B9" },
    { name: "Old", delete: true },
    { name: "It", refersTo: "'It''s'!A1" },
  ]);
  assert.deepEqual(job.args.ops, [
    { name: "Sales", refersTo: { sheet: "Inventory", address: "$B$6:$C$9" } },
    { name: "Rows", refersTo: { sheet: "My data", address: "$5:$6" } },
    { name: "Cols", refersTo: { sheet: "Data", address: "$C:$D" } },
    { name: "One", refersTo: { address: "$B$2" } },
    { name: "Umsätze", refersTo: { address: "$B$2:$B$9" } },
    { name: "Old", delete: true },
    { name: "It", refersTo: { sheet: "It's", address: "$A$1" } },
  ]);
  const no = (ops: unknown[], message: RegExp) => refusal(() => editJob("xlsx", ops), message);
  no([{ name: "Sales" }], /give refersTo \(the cells it names\) or delete: true/);
  no([{ name: "Sales", refersTo: "A1", delete: true }], /give refersTo/);
  no([{ name: "Sales", delete: false }], /delete is true/);
  no([{ name: "Sales", refersTo: "zzz" }], /refersTo is cells with their sheet, as "Data!\$B\$6:\$C\$9"/);
  no([{ name: "Sales", refersTo: "=SUM(A1:A3)" }], /refersTo is cells with their sheet/);
  no([{ name: "Sales", refersTo: "Data![A1]" }], /refersTo is cells with their sheet/);
  no([{ name: "Sales", refersTo: "A1", sheet: "Data" }], /"sheet" is not part of \{name, refersTo \| delete\}/);
  for (const bad of ["", "1x", "my name", "my.name", "A1", "XFD1048576", "R1C1", "R", "c", "TRUE", "x".repeat(256)]) no([{ name: bad, refersTo: "A1" }], /^op 1: (a name has 1 to 255 characters|a name starts with a letter|"[^"]*" reads as a cell address)/);
  assert.equal(nameProblem("Sales_2026"), null);
  assert.equal(nameProblem("_hidden"), null);
  assert.equal(nameProblem("ABCD1"), null);
  assert.deepEqual(sheetRef("Data!$A$1:B2"), { sheet: "Data", address: "$A$1:$B$2" });
  assert.equal(sheetRef("Da[ta!A1"), null);
});
