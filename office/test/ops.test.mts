/**
 * Unit tests for src/ops.ts: the shapes, formats and caps of office_edit's ops, the A1 ranges, and the check the
 * Word command makes before it touches anything (simulateWord, the command's own source): every quote exactly once
 * at its turn, an earlier op that makes or takes away a later op's quote taken into account, the failing op named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { editJob, MAX_ARGS_BYTES, MAX_OPS, OpError, parseRange, simulateWord, type WordOp } from "../src/ops";

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
