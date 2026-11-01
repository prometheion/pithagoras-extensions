/**
 * Unit tests for src/seat-page.ts as the agents' browser runs it, without a browser: the seat page's script in a
 * context of its own with the few things of a page it uses (fetch, a document, the editor's DocsAPI) scripted, and the
 * read commands with a scripted builder API (`Api`), and the plugin's run of a spreadsheet edit against a scripted
 * workbook that changes its sheets a moment after it is asked, as the Document Server 10's does. What the real editor
 * does with them is the end-to-end test's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { setImmediate as tick } from "node:timers/promises";
import { BRIDGE_JS, CELL_EDIT_COMMANDS, COMMANDS, EDITOR_SIZE, MAX_READ_TEXT, MAX_SHOWN_TEXT, SEAT_PAGE_HTML, SEAT_PAGE_JS, SETTLE, SHEET_MOST, VIEW_SETTLE } from "../src/seat-page";
import { editJob, formatJob } from "../src/ops";

/** The seat page running: its polls answered by `order`, what it posts as events, the editors it made, and the
 * scripts it loads (each loaded when the test says). */
function seatPage() {
  const polls: ((order: unknown) => void)[] = [];
  const events: { editorId: string; type: string; data: unknown; seq: number }[] = [];
  const scripts: { src: string; onload: () => void; onerror: () => void }[] = [];
  const editors: { box: string; config: { events: Record<string, (e?: unknown) => void> }; destroyed: boolean }[] = [];
  // The page's timers, run when the test says.
  const timers: { fn: () => void; ms: number }[] = [];
  const context = {
    fetch: (url: string, init?: { body?: string }) => {
      if (url === "poll") return new Promise((resolve) => polls.push((order) => resolve({ status: 200, json: async () => order })));
      if (url === "event") events.push(JSON.parse(init!.body!));
      return Promise.resolve({ status: 200, json: async () => ({}) });
    },
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    document: {
      createElement: () => ({ remove() {} }),
      head: { appendChild: (s: (typeof scripts)[number]) => scripts.push(s) },
      body: { appendChild() {} },
      getElementById: () => null,
    },
    window: {
      DocsAPI: {
        DocEditor: function (this: { destroyEditor: () => void }, box: string, config: (typeof editors)[number]["config"]) {
          const made = { box, config, destroyed: false };
          editors.push(made);
          this.destroyEditor = () => {
            made.destroyed = true;
          };
        },
      },
    },
  };
  vm.runInNewContext(SEAT_PAGE_JS, context);
  return {
    events,
    scripts,
    editors,
    timers,
    /** The page's held poll answered with `order`. */
    async order(order: unknown) {
      for (let i = 0; i < 20 && !polls.length; i++) await tick();
      polls.shift()!(order);
      for (let i = 0; i < 5; i++) await tick();
    },
    async settle() {
      for (let i = 0; i < 5; i++) await tick();
    },
  };
}

const openOrder = (editorId: string, appReadyMs?: number) => ({ open: { editorId, apiJs: "http://office-ds/web-apps/apps/api/documents/api.js", config: { document: { key: "k" } }, appReadyMs } });

test("seat page: an editor whose app never says it started is made anew, once; one that started, or was closed, is not", async () => {
  const page = seatPage();
  await page.order(openOrder("e1", 10_000));
  page.scripts[0].onload();
  await page.settle();
  assert.equal(page.editors.length, 1);
  assert.deepEqual(page.timers.map((t) => t.ms), [10_000]);
  // Its app failed while it loaded: nothing said, and at appReadyMs it is torn down and made again, with a config of
  // its own.
  page.timers.shift()!.fn();
  assert.equal(page.editors[0].destroyed, true);
  assert.equal(page.editors.length, 2);
  assert.notEqual(page.editors[1].config, page.editors[0].config);
  assert.deepEqual(page.editors[1].config.events && Object.keys(page.editors[1].config.events).includes("onDocumentReady"), true);
  assert.deepEqual(page.events.map((e) => [e.editorId, e.type]), [["e1", "remade"]]);
  // Once: the second try has no timer of its own; the listener's wait is the bound.
  assert.equal(page.timers.length, 0);
  page.editors[1].config.events.onDocumentReady();
  await page.settle();
  assert.deepEqual(page.events.map((e) => [e.editorId, e.type]), [["e1", "remade"], ["e1", "ready"]]);

  // One whose app started is left to load.
  await page.order(openOrder("e2", 10_000));
  await page.settle();
  page.editors[2].config.events.onAppReady();
  page.timers.shift()!.fn();
  assert.equal(page.editors.length, 3);
  assert.equal(page.editors[2].destroyed, false);
  // One closed meanwhile is not made again.
  await page.order(openOrder("e3", 10_000));
  await page.settle();
  await page.order({ close: "e3" });
  page.timers.shift()!.fn();
  assert.equal(page.editors.length, 4);
  assert.equal(page.editors[3].destroyed, true);
});

test("seat page: each editor is made at its own size, a Word editor 1100 x 1400 and a sheet's 1600 x 1000, stacked at the top left", async () => {
  const page = seatPage();
  const order = (editorId: string, documentType: string) => ({ open: { editorId, apiJs: "http://office-ds/web-apps/apps/api/documents/api.js", config: { documentType, document: { key: editorId } } } });
  await page.order(order("w", "word"));
  page.scripts[0].onload();
  await page.settle();
  await page.order(order("c", "cell"));
  await page.settle();
  const sizes = page.editors.map((e) => [(e.config as { width?: string }).width, (e.config as { height?: string }).height]);
  assert.deepEqual(sizes, [["1100px", "1400px"], ["1600px", "1000px"]]);
  assert.deepEqual(EDITOR_SIZE, { word: { width: 1100, height: 1400 }, cell: { width: 1600, height: 1000 } });
  // The editor's frame takes the place of its box, so the page places the frames themselves: all at its top left,
  // inside the browser's window.
  assert.match(SEAT_PAGE_HTML, /iframe\{position:absolute;top:0;left:0\}/);
});

test("seat page: an editor whose close came while the editor's script still loaded is never made", async () => {
  const page = seatPage();
  await page.order(openOrder("e1"));
  assert.equal(page.scripts.length, 1, "api.js is loading");
  await page.order({ close: "e1" });
  page.scripts[0].onload();
  await page.settle();
  assert.equal(page.editors.length, 0);
  // Another editor opens as before.
  await page.order(openOrder("e2"));
  await page.settle();
  assert.equal(page.editors.length, 1);
});

test("seat page: the editors' events are numbered in the order they were raised; a reload the editor asks for is an error", async () => {
  const page = seatPage();
  await page.order(openOrder("e1"));
  page.scripts[0].onload();
  await page.settle();
  const events = page.editors[0].config.events;
  events.onDocumentStateChange({ data: true });
  events.onDocumentStateChange({ data: false });
  events.onRequestRefreshFile();
  events.onOutdatedVersion();
  await page.settle();
  assert.deepEqual(page.events.map((e) => [e.type, e.data === true || e.data === false ? e.data : typeof e.data]), [["state", true], ["state", false], ["error", "object"], ["error", "object"]]);
  const seqs = page.events.map((e) => e.seq);
  assert.ok(seqs.every((n, i) => typeof n === "number" && (i === 0 || n > seqs[i - 1])), `increasing: ${seqs}`);
});

/** A command run as the plugin runs it, with `Api` and `Asc.scope.args` as given. */
function command(kind: string, Api: unknown, args: unknown = {}): { result?: any; error?: any; touched?: boolean } {
  // As JSON, as the editor hands it back to the plugin (and out of the context's own objects).
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${COMMANDS[kind].source})()`, { Api, Asc: { scope: { args } } })));
}

let paragraphs = 0;
/** A paragraph as the builder gives it, of `text` in `style` (a list item's label in front of it where it has one, as
 * GetText gives it unless asked without). */
const paragraph = (text: string, style?: string, label = "") => {
  const id = `p${++paragraphs}`;
  const st = style ? { GetName: () => style, GetType: () => "paragraph" } : null;
  return { GetClassType: () => "paragraph", GetText: (o?: { Numbering?: boolean }) => `${o?.Numbering === false ? "" : label}${text}\r\n`, GetParaPr: () => ({ GetStyle: () => st }), GetStyle: () => st, GetInternalId: () => id, GetNumbering: () => null, ToJSON: () => JSON.stringify({ content: [{ type: "run", content: [text] }] }) };
};
const contentOf = (elements: unknown[]) => ({ GetElementsCount: () => elements.length, GetElement: (i: number) => elements[i] });

test("word.read: a long document is read up to the most text a read gives, and says it goes on", () => {
  const long = Array.from({ length: 400 }, (_, i) => paragraph(`${i}`.padEnd(1000, ".")));
  const out = command("word.read", { GetDocument: () => contentOf(long) });
  assert.equal(out.result.truncated, true);
  const size = out.result.blocks.reduce((n: number, b: { p: string }) => n + b.p.length, 0);
  assert.ok(size > MAX_READ_TEXT - 1000 && size <= MAX_READ_TEXT + 1000, `${size}`);
  const short = command("word.read", { GetDocument: () => contentOf([paragraph("one"), paragraph("two")]) });
  assert.deepEqual(short.result, { blocks: [{ p: "one" }, { p: "two" }] });
});

/** A sheet whose used range starts at `first` and holds `values` (and `formulas`). */
function sheet(name: string, first: string, values: unknown[][], formulas?: string[][]) {
  const range = {
    GetAddress: () => `${first}:${first}`,
    GetRowsCount: () => values.length,
    GetColumnsCount: () => values[0].length,
    GetValue: () => values,
    GetFormula: () => formulas ?? values.map((row) => row.map(() => "")),
  };
  return { GetName: () => name, GetVisible: () => true, GetUsedRange: () => range, GetRange: () => range };
}

test("cell.read: cells are named from where the used range starts, not from A1", () => {
  const out = command("cell.read", { GetSheets: () => [sheet("Data", "C3", [[1, 2], [3, ""]], [["", "=A1*2"], ["", ""]])] });
  assert.deepEqual(out.result.sheets[0].cells, [{ a: "C3", v: 1 }, { a: "D3", v: 2, f: "=A1*2" }, { a: "C4", v: 3 }]);
});

test("cell.read: the sheets are read up to the most text a read gives; a sheet not read is said to be", () => {
  const big = (name: string) => sheet(name, "A1", Array.from({ length: 150 }, () => ["x".repeat(1000)]));
  const out = command("cell.read", { GetSheets: () => [big("One"), big("Two"), big("Three"), big("Four")] });
  const [one, two, three, four] = out.result.sheets;
  assert.equal(one.truncated, false);
  assert.equal(one.cells.length, 150);
  assert.equal(two.truncated, true, "cut off inside the second sheet");
  assert.ok(two.cells.length > 0 && two.cells.length < 150);
  assert.equal(two.skipped, undefined);
  assert.deepEqual([three.cells.length, three.skipped, four.cells.length, four.skipped], [0, true, 0, true]);
});

test("word.edit: a table of one row and two columns is made with the rows first, as the Document Server 10 takes them", () => {
  const pushed: unknown[] = [];
  /** Api.CreateTable as DS 10.0 has it: (rows, cols). */
  const createTable = (rows: number, cols: number) => {
    const cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => [] as string[]));
    return {
      cells,
      GetRowsCount: () => rows,
      GetCell: (r: number, c: number) => {
        if (r >= rows || c >= cols) throw new Error(`Cell index ${c} is out of bounds [0, ${cols - 1}].`);
        return { GetContent: () => ({ GetElement: () => ({ AddText: (t: string) => cells[r][c].push(t) }) }) };
      },
      SetStyle() {},
    };
  };
  const doc = { ...contentOf([paragraph("Only")]), GetStyle: () => null, Push: (el: unknown) => pushed.push(el) };
  const out = command("word.edit", { GetDocument: () => doc, CreateTable: createTable, Save() {} }, { ops: [{ table: [["End", "Table"]] }] });
  assert.deepEqual(out, { result: { ops: 1 } });
  assert.deepEqual((pushed[0] as { cells: string[][][] }).cells, [[["End"], ["Table"]]]);
});

test("cell.read: every sheet of the workbook, hidden ones and empty ones among them, beside the one asked for by its name in any case", () => {
  const hidden = { ...sheet("Data", "A1", [[""]]), GetVisible: () => false };
  const book = [sheet("Sheet1", "A1", [[1]]), hidden, sheet("Empty", "A1", [[""]])];
  const out = command("cell.read", { GetSheets: () => book }, { sheet: "DATA" });
  assert.deepEqual(out.result.book, [{ name: "Sheet1", hidden: false }, { name: "Data", hidden: true }, { name: "Empty", hidden: false }]);
  assert.deepEqual(out.result.sheets.map((s: { name: string }) => s.name), ["Data"]);
  const missing = command("cell.read", { GetSheets: () => book }, { sheet: "Nope" });
  assert.equal(missing.error.code, "not_found");
  assert.match(missing.error.message, /the sheets: "Sheet1", "Data", "Empty"/);
});

/* ------------------------------------------------------------------ */
/* the plugin's spreadsheet edit                                         */
/* ------------------------------------------------------------------ */

/** A1 addresses of a range, row by row. */
function cellsOf(range: string): string[][] {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range.replace(/\$/g, ""))!;
  const col = (l: string) => [...l].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const name = (n: number) => { let out = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out; return out; };
  const [c1, r1, c2, r2] = [col(m[1]), Number(m[2]), col(m[3] ?? m[1]), Number(m[4] ?? m[2])];
  return Array.from({ length: Math.abs(r2 - r1) + 1 }, (_, r) => Array.from({ length: Math.abs(c2 - c1) + 1 }, (_, c) => `${name(Math.min(c1, c2) + c)}${Math.min(r1, r2) + r}`));
}

type Look = { font: string; size: number; bold: boolean; italic: boolean; underline: string; strike: boolean; vertAlign: string; color: string; fill: string; wrap: boolean; rotation: number };
const DEFAULT_LOOK: Look = { font: "Calibri", size: 11, bold: false, italic: false, underline: "none", strike: false, vertAlign: "baseline", color: "#000000", fill: "none", wrap: false, rotation: 0 };
type FakeSheet = {
  name: string;
  hidden: boolean;
  cells: Record<string, unknown>;
  formats: Record<string, string>;
  widths: Record<number, number>;
  /** What the builder can read of a cell's look, the cell's own over its column's over its row's. */
  looks: Record<string, Partial<Look>>;
  colLooks: Record<number, Partial<Look>>;
  rowLooks: Record<number, Partial<Look>>;
  /** What it cannot read: alignment and borders, by cell. */
  aligns: Record<string, string>;
  borders: Record<string, string[]>;
  merges: string[];
  heights: Record<number, number>;
  hiddenCols: number[];
  hiddenRows: number[];
  frozen: { cols: number; rows: number };
  /** A text's characters that look otherwise than its cell (rich text), by cell: each character's own, from the first. */
  chars: Record<string, Partial<Look>[]>;
  /** #13 PR 4: conditional formats (in the order made), validation by cell (ApiValidation's getters in turn), links by
   * cell, charts, the sheet's filter (its range) and the criteria set on it, and formatted tables (their ranges). */
  rules: FakeRule[];
  validations: Record<string, (string | boolean | null)[]>;
  links: Record<string, { address: string; sub: string; tip: string }>;
  charts: { type: string; ref: string; title?: string; xTitle?: string; yTitle?: string; legend?: string; col: number; row: number; width: number; height: number; inRows: boolean }[];
  filter: string | null;
  criteria: unknown[][];
  tables: string[];
};
type FakeRule = { type: string; applies: string; operator?: string; f1?: string; f2?: string; rank?: number; topBottom?: string; percent?: boolean; dupe?: string; fill?: string; fontColor?: string; bold?: boolean; italic?: boolean; underline?: string; strike?: boolean; barColor?: string; colors?: string[] };
const freshSheet = (name: string, hidden = false): FakeSheet => ({ name, hidden, cells: {}, formats: {}, widths: {}, looks: {}, colLooks: {}, rowLooks: {}, aligns: {}, borders: {}, merges: [], heights: {}, hiddenCols: [], hiddenRows: [], frozen: { cols: 0, rows: 0 }, chars: {}, rules: [], validations: {}, links: {}, charts: [], filter: null, criteria: [], tables: [] });

const colOf = (l: string) => [...l].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const nameOf = (n: number) => { let out = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out; return out; };
/** An address's bounds (from 0): cells "A1:B2", whole columns "C:D", whole rows "5:6". */
function bounds(address: string): { c1: number; r1: number; c2: number; r2: number; whole?: "columns" | "rows" } {
  const a = address.replace(/\$/g, "");
  let m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a);
  if (m) {
    const [c1, r1, c2, r2] = [colOf(m[1]), Number(m[2]) - 1, colOf(m[3] ?? m[1]), Number(m[4] ?? m[2]) - 1];
    return { c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) };
  }
  m = /^([A-Z]+):([A-Z]+)$/.exec(a);
  if (m) return { c1: colOf(m[1]), r1: 0, c2: colOf(m[2]), r2: 1048575, whole: "columns" };
  m = /^(\d+):(\d+)$/.exec(a);
  if (m) return { c1: 0, r1: Number(m[1]) - 1, c2: 16383, r2: Number(m[2]) - 1, whole: "rows" };
  throw new Error(`no address ${address}`);
}
const at = (c: number, r: number) => `${nameOf(c)}${r + 1}`;
const parse = (a: string) => { const m = /^([A-Z]+)(\d+)$/.exec(a)!; return { c: colOf(m[1]), r: Number(m[2]) - 1 }; };
const inside = (a: string, b: ReturnType<typeof bounds>) => { const p = parse(a); return p.c >= b.c1 && p.c <= b.c2 && p.r >= b.r1 && p.r <= b.r2; };
const meets = (x: ReturnType<typeof bounds>, y: ReturnType<typeof bounds>) => x.c1 <= y.c2 && y.c1 <= x.c2 && x.r1 <= y.r2 && y.r1 <= x.r2;
const hexOf = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const colourOf = (h: string) => { const n = parseInt(h.slice(1), 16); const c = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; return { ...c, GetRGB: () => c }; };

/**
 * A workbook as the spreadsheet editor's builder API shows it to a command (as the end-to-end test and the probes of
 * DS 10.0 found it): a sheet is made, moved or deleted two commands after it was asked for (the Document Server's
 * lock), a name or visibility changes at once. A value written is read as Excel's input reads it ("10%" is 0.1 in a
 * percent format, "00123" is 123, unless the cell is formatted as text), a formula it cannot read ("=SUM(") is not
 * taken and SetValue answers false. A moved or made sheet becomes the active one, hiding the active one makes the
 * next visible one active, and a hidden sheet made active is shown again. `poison` makes the first write into that
 * address throw; `never` keeps the Document Server from making what was asked (all of it, or what it names).
 * Cells' looks as #13 PR 3's first step found them: read through a cell's characters (italic, strike, superscript and
 * subscript read true or null), superscript and subscript taken by text cells only, no getter for alignment and
 * borders, a border "None" changing nothing, no "general" alignment, Merge keeping the top-left value, FreezeAt
 * throwing, an unfreeze taken by the active sheet only and a freeze at a cell by the selection of the active sheet
 * (and none where the panes are frozen at a cell already), a merge giving the others the top-left one's number format
 * too, the frozen panes named as DS names them ("1:1" for the first row alone, "A:A" for column A alone), a hidden
 * column reading no width, a size set showing a hidden line, and a text whose characters differ (`chars`) reading null
 * (or false for bold, null for italic and the like) where they do; a setter on the whole text makes them alike.
 * `state.ranges` counts the ranges a command asked for. `poisonLook` makes a look set on that cell throw: an op that
 * fails in its step, which the check cannot foresee.
 * `before` runs before each command (with how many ran before it): a person's change between two steps. A freeze, an
 * unfreeze and an autofit show from the next command on, as in an editor people have co-edited (the Document Server's
 * lock); `autofitAtOnce` lays an autofit out in its command, as an editor nobody else has been in does.
 */
function workbook(start: (string | { name: string; hidden: boolean })[], options: { poison?: string; poisonLook?: string; never?: boolean | ((what: string) => boolean); before?: (commands: number, sheets: FakeSheet[]) => void; autofitAtOnce?: boolean } = {}) {
  const sheets: FakeSheet[] = start.map((s) => (typeof s === "string" ? freshSheet(s) : freshSheet(s.name, s.hidden)));
  const later: { due: number; fn: () => void }[] = [];
  const state = { sheets, commands: 0, saves: 0, active: sheets[0], asked: [] as string[], poisoned: false, formatted: [] as string[], calls: [] as string[], selected: null as null | { sheet: FakeSheet; address: string }, ranges: 0, names: {} as Record<string, string> };
  const ask = (what: string, fn: () => void) => {
    state.asked.push(what);
    const never = typeof options.never === "function" ? options.never(what) : options.never;
    if (!never) later.push({ due: state.commands + 2, fn });
  };
  const activate = (sh: FakeSheet) => {
    state.active = sh;
    sh.hidden = false;
  };
  const of = new WeakMap<object, FakeSheet>();
  const read = (sh: FakeSheet, a: string, s: string): unknown => {
    if (s.startsWith("=") || sh.formats[a] === "@") return s;
    if (/^-?\d+(\.\d+)?%$/.test(s)) {
      if ((sh.formats[a] ?? "General") === "General") sh.formats[a] = "0%";
      return Number(s.slice(0, -1)) / 100;
    }
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
    return s;
  };
  const lookAt = (sh: FakeSheet, a: string): Look => {
    const p = parse(a);
    return { ...DEFAULT_LOOK, ...sh.rowLooks[p.r], ...sh.colLooks[p.c], ...sh.looks[a] };
  };
  /** The cells a setter reaches: a cell range's own, or of whole columns or rows the cells that have anything there. */
  const huge = (b: ReturnType<typeof bounds>) => (b.c2 - b.c1 + 1) * (b.r2 - b.r1 + 1) > 100_000;
  const reached = (sh: FakeSheet, b: ReturnType<typeof bounds>) => {
    if (!b.whole && !huge(b)) {
      const out: string[] = [];
      for (let r = b.r1; r <= b.r2; r++) for (let c = b.c1; c <= b.c2; c++) out.push(at(c, r));
      return out;
    }
    return [...new Set([...Object.keys(sh.cells), ...Object.keys(sh.looks), ...Object.keys(sh.links)])].filter((a) => inside(a, b));
  };
  const setLook = (sh: FakeSheet, address: string, key: keyof Look, v: unknown) => {
    const b = bounds(address);
    if (options.poisonLook && !b.whole && inside(options.poisonLook, b)) throw new Error("the editor refused the format");
    // A column's or row's own look, where it differs from the default (what the builder reads).
    const own = (map: Record<number, Partial<Look>>, k: number) => {
      const next = { ...map[k], [key]: v } as Record<string, unknown>;
      if (DEFAULT_LOOK[key] === v) delete next[key];
      if (Object.keys(next).length) map[k] = next as Partial<Look>;
      else delete map[k];
    };
    if (b.whole === "columns") for (let c = b.c1; c <= b.c2; c++) own(sh.colLooks, c);
    if (b.whole === "rows") for (let r = b.r1; r <= b.r2; r++) own(sh.rowLooks, r);
    for (const a of reached(sh, b)) {
      // Set on the whole text: its characters are alike in it from then on.
      if (sh.chars[a]) sh.chars[a] = sh.chars[a].map((c) => { const { [key]: _, ...rest } = c as Record<string, unknown>; return rest as Partial<Look>; });
      const own = { ...sh.looks[a], [key]: v } as Partial<Look>;
      const p = parse(a);
      // A cell's own look only where it differs from what it would have without it.
      if ((({ ...DEFAULT_LOOK, ...sh.rowLooks[p.r], ...sh.colLooks[p.c] }) as Record<string, unknown>)[key] === v) delete (own as Record<string, unknown>)[key];
      if (Object.keys(own).length) sh.looks[a] = own;
      else delete sh.looks[a];
    }
  };
  const isText = (sh: FakeSheet, a: string) => typeof sh.cells[a] === "string" && sh.cells[a] !== "" && !String(sh.cells[a]).startsWith("=");
  const usedAddress = (sh: FakeSheet) => {
    const all = [...Object.keys(sh.cells), ...Object.keys(sh.looks), ...Object.keys(sh.formats), ...Object.keys(sh.aligns)].map(parse);
    if (!all.length) return "A1";
    const c1 = Math.min(...all.map((p) => p.c)), c2 = Math.max(...all.map((p) => p.c)), r1 = Math.min(...all.map((p) => p.r)), r2 = Math.max(...all.map((p) => p.r));
    return c1 === c2 && r1 === r2 ? at(c1, r1) : `${at(c1, r1)}:${at(c2, r2)}`;
  };
  /** Rows or columns from `from` moved by `delta` (a delete takes the `-delta` ones from `from` away first). */
  const shift = (sh: FakeSheet, kind: "rows" | "columns", from: number, delta: number) => {
    const move = <T,>(map: Record<string, T>) => {
      const out: Record<string, T> = {};
      for (const [a, v] of Object.entries(map)) {
        const p = parse(a), k = kind === "rows" ? p.r : p.c;
        if (delta < 0 && k >= from && k < from - delta) continue;
        const n = k >= from ? k + delta : k;
        out[kind === "rows" ? at(p.c, n) : at(n, p.r)] = v;
      }
      return out;
    };
    sh.cells = move(sh.cells);
    sh.formats = move(sh.formats);
    sh.looks = move(sh.looks);
    sh.aligns = move(sh.aligns);
    sh.borders = move(sh.borders);
  };
  /* #13 PR 4's parts of the builder, as docbuilder and the editor showed them (DS 10.0.0.1): */
  const rgbOf = (c: { r: number; g: number; b: number } | undefined) => (c ? hexOf(c) : undefined);
  const ruleItem = (sh: FakeSheet, rule: FakeRule) => {
    const item: Record<string, unknown> = {
      GetType: () => rule.type,
      GetAppliesTo: () => rangeOf(sh, rule.applies),
      Delete: () => void sh.rules.splice(sh.rules.indexOf(rule), 1),
      SetFillColor: (c: { r: number; g: number; b: number }) => void (rule.fill = rgbOf(c)),
      GetFillColor: () => (rule.fill ? colourOf(rule.fill) : undefined),
      GetFont: () => ({
        GetColor: () => (rule.fontColor ? colourOf(rule.fontColor) : undefined),
        GetBold: () => rule.bold,
        SetColor: (c: { r: number; g: number; b: number }) => void (rule.fontColor = rgbOf(c)),
        SetBold: (v: boolean) => void (rule.bold = v),
        SetItalic: (v: boolean) => void (rule.italic = v),
        // The conditional font takes the editor's own names for an underline, not a boolean.
        SetUnderline: (v: string) => {
          if (!/^xlUnderlineStyle/.test(String(v))) throw new Error('Invalid type of parametr "isUnderline".');
          rule.underline = v;
        },
        SetStrikethrough: (v: boolean) => void (rule.strike = v),
      }),
    };
    // Only the kinds that have them answer these (the others have no such method).
    if (rule.type === "xlCellValue" || rule.type === "xlExpression") Object.assign(item, { GetFormula1: () => rule.f1, GetFormula2: () => rule.f2 ?? "" });
    if (rule.type === "xlCellValue") item.GetOperator = () => rule.operator;
    if (rule.type === "xlTop10") Object.assign(item, { GetRank: () => rule.rank, GetTopBottom: () => rule.topBottom, GetPercent: () => rule.percent, SetRank: (n: number) => void (rule.rank = n), SetTopBottom: (v: string) => void (rule.topBottom = v), SetPercent: (v: boolean) => void (rule.percent = v) });
    if (rule.type === "xlUniqueValues") Object.assign(item, { GetDupeUnique: () => rule.dupe, SetDupeUnique: (v: string) => void (rule.dupe = v) });
    if (rule.type === "xlDataBar") Object.assign(item, { SetBarColor: (c: { r: number; g: number; b: number }) => void (rule.barColor = rgbOf(c)) });
    if (rule.type === "xlColorScale") item.GetColorScaleCriteria = () => (rule.colors ?? []).map((_, k) => ({ SetColor: (c: { r: number; g: number; b: number }) => void (rule.colors![k] = hexOf(c)) }));
    return item;
  };
  /** A range's conditional formats: those that meet it, counted and taken by their number from 1. */
  const conditions = (sh: FakeSheet, address: string) => {
    const b = bounds(address);
    const mine = () => sh.rules.filter((r) => meets(bounds(r.applies), b));
    const make = (rule: Omit<FakeRule, "applies">, address: string) => {
      state.calls.push(`rule ${rule.type} ${address}`);
      const made = { ...rule, applies: address } as FakeRule;
      sh.rules.push(made);
      return ruleItem(sh, made);
    };
    return {
      GetCount: () => mine().length,
      GetItem: (k: number) => ruleItem(sh, mine()[k - 1]),
      Delete: () => void mine().forEach((r) => sh.rules.splice(sh.rules.indexOf(r), 1)),
      Add: (type: string, operator?: string, f1?: string, f2?: string) => make({ type, operator, f1: f1?.replace(/^=/, ""), f2 }, address),
      AddColorScale: (n: number) => make({ type: "xlColorScale", colors: Array.from({ length: n }, () => "#FFFFFF") }, address),
      AddDatabar: () => make({ type: "xlDataBar" }, address),
      AddTop10: () => make({ type: "xlTop10", rank: 10, topBottom: "xlTop10Top", percent: false }, address),
      AddUniqueValues: () => make({ type: "xlUniqueValues", dupe: "xlUnique" }, address),
    };
  };
  const VALIDATION_TYPES = ["xlValidateList", "xlValidateWholeNumber", "xlValidateDecimal", "xlValidateDate", "xlValidateTextLength", "xlValidateCustom"];
  /** The getters of one cell's validation in turn: type, alert style, operator, formulas, ignore blank, in-cell
   * dropdown, error message and title, input message and title, show error, show input. */
  const NO_VALIDATION = ["xlValidateInputOnly", "xlValidAlertStop", "xlBetween", "", "", true, true, "", "", "", "", true, true];
  const validation = (sh: FakeSheet, cells: string[]) => {
    const getters = ["GetType", "GetAlertStyle", "GetOperator", "GetFormula1", "GetFormula2", "GetIgnoreBlank", "GetInCellDropdown", "GetErrorMessage", "GetErrorTitle", "GetInputMessage", "GetInputTitle", "GetShowError", "GetShowInput"];
    const first = cells[0];
    const out: Record<string, unknown> = {
      Add: (type: string, alert: string, operator: string, f1: string, f2?: string) => {
        if (cells.some((a) => sh.validations[a])) throw new Error("Validation already exists.");
        if (!VALIDATION_TYPES.includes(type)) return null;
        state.calls.push(`validation ${type} ${cells[0]}..${cells.at(-1)}`);
        for (const a of cells) sh.validations[a] = [type, alert, operator, f1, f2 ?? "", true, true, "", "", "", "", true, true];
        return out;
      },
      Delete: () => void cells.forEach((a) => delete sh.validations[a]),
    };
    getters.forEach((g, k) => (out[g] = () => (sh.validations[first] ?? NO_VALIDATION)[k]));
    // The setters of the rest: the same slots, on every cell of the range.
    for (const [name, k] of [["SetIgnoreBlank", 5], ["SetInCellDropdown", 6], ["SetErrorMessage", 7], ["SetErrorTitle", 8], ["SetInputMessage", 9], ["SetInputTitle", 10], ["SetShowError", 11], ["SetShowInput", 12]] as [string, number][]) {
      out[name] = (v: string | boolean) => cells.forEach((a) => sh.validations[a] && (sh.validations[a][k] = v));
    }
    return out;
  };
  const linkOf = (sh: FakeSheet, a: string) => ({
    GetAddress: () => sh.links[a].address,
    GetSubAddress: () => sh.links[a].sub,
    GetScreenTip: () => sh.links[a].tip,
    GetTextToDisplay: () => String(sh.cells[a] ?? ""),
    GetRange: () => rangeOf(sh, a),
  });
  /** The rows of a range ordered by up to three columns, the cells' values, formats and looks moving with them. */
  const sortRows = (sh: FakeSheet, b: ReturnType<typeof bounds>, keys: { col: number; desc: boolean }[]) => {
    const rows = Array.from({ length: b.r2 - b.r1 + 1 }, (_, k) => b.r1 + k);
    const rank = (v: unknown) => (v === undefined || v === "" ? 3 : typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
    const order = [...rows].sort((x, y) => {
      for (const key of keys) {
        const [vx, vy] = [sh.cells[at(key.col, x)], sh.cells[at(key.col, y)]];
        if (rank(vx) !== rank(vy)) return rank(vx) - rank(vy);
        const d = typeof vx === "number" ? (vx as number) - (vy as number) : String(vx ?? "").toLowerCase() < String(vy ?? "").toLowerCase() ? -1 : String(vx ?? "").toLowerCase() > String(vy ?? "").toLowerCase() ? 1 : 0;
        if (d) return key.desc ? -d : d;
      }
      return x - y;
    });
    const maps = [sh.cells, sh.formats, sh.looks, sh.aligns, sh.borders, sh.chars] as Record<string, unknown>[];
    const before = maps.map((m) => ({ ...m }));
    maps.forEach((m, i) => {
      for (let c = b.c1; c <= b.c2; c++) rows.forEach((r, k) => {
        const from = at(c, order[k]), to = at(c, r);
        if (from in before[i]) m[to] = before[i][from]; else delete m[to];
      });
    });
  };
  const rangeOf = (sh: FakeSheet, address: string): Record<string, unknown> => {
    state.ranges++;
    const b = bounds(address);
    const grid = b.whole || huge(b) ? [] : cellsOf(address);
    const first = at(b.c1, b.r1);
    const one = !b.whole && grid.length === 1 && grid[0].length === 1;
    const formula = (v: unknown) => typeof v === "string" && v.startsWith("=");
    const each = (fn: (a: string) => void) => reached(sh, b).forEach(fn);
    const font = (start = 1, count = 1) => {
      const base = lookAt(sh, first);
      // The characters asked for: where they differ in a key, it reads null (bold false).
      const own = sh.chars[first] ? sh.chars[first].slice(start - 1, start - 1 + Math.max(1, count)) : [];
      const all = own.length ? own.map((c) => ({ ...base, ...c })) : [base];
      const one = <K extends keyof Look>(k: K): Look[K] | null => (all.every((c) => c[k] === all[0][k]) ? all[0][k] : null);
      return {
        GetName: () => one("font"),
        GetSize: () => one("size"),
        GetBold: () => one("bold") === true,
        GetItalic: () => (one("italic") ? true : null),
        GetStrikethrough: () => (one("strike") ? true : null),
        GetUnderline: () => `xlUnderlineStyle${(one("underline") ?? "none").charAt(0).toUpperCase()}${(one("underline") ?? "none").slice(1)}`,
        GetSuperscript: () => (one("vertAlign") === "superscript" ? true : null),
        GetSubscript: () => (one("vertAlign") === "subscript" ? true : null),
        GetColor: () => (one("color") === null ? null : colourOf(one("color")!)),
        // On a text's characters only, as the builder sets them.
        SetSuperscript: (v: boolean) => { if (isText(sh, first)) setLook(sh, first, "vertAlign", v ? "superscript" : "baseline"); },
        SetSubscript: (v: boolean) => { if (isText(sh, first)) setLook(sh, first, "vertAlign", v ? "subscript" : "baseline"); },
      };
    };
    const range: Record<string, unknown> = {
      GetValue: () => {
        const rows = grid.map((row) => row.map((a) => (formula(sh.cells[a]) ? 0 : sh.cells[a] ?? "")));
        return one ? rows[0][0] : rows;
      },
      GetFormula: () => {
        const rows = grid.map((row) => row.map((a) => (sh.cells[a] === undefined ? "" : String(sh.cells[a]))));
        return one ? rows[0][0] : rows;
      },
      GetText: () => String(sh.cells[first] ?? ""),
      SetValue: (v: unknown) => {
        if (options.poison && !state.poisoned && grid.flat().includes(options.poison)) {
          state.poisoned = true;
          throw new Error("the editor refused the write");
        }
        const rows = Array.isArray(v) ? (v as unknown[][]) : [[v]];
        let took = true;
        grid.forEach((row, r) =>
          row.forEach((a, c) => {
            const s = String(rows[r][c]);
            if (s === "") delete sh.cells[a];
            else if (s.startsWith("=") && s.split("(").length !== s.split(")").length) took = false;
            else sh.cells[a] = read(sh, a, s);
          }),
        );
        return took;
      },
      GetNumberFormat: () => {
        const all = new Set(grid.flat().map((a) => sh.formats[a] ?? "General"));
        return all.size === 1 ? [...all][0] : null;
      },
      SetNumberFormat: (f: string) =>
        each((a) => {
          state.formatted.push(a);
          if (f === "General") delete sh.formats[a];
          else sh.formats[a] = f;
        }),
      GetAddress: () => address,
      GetRowsCount: () => b.r2 - b.r1 + 1,
      GetColumnsCount: () => b.c2 - b.c1 + 1,
      // In DS 10.0 a Copy or Paste into another sheet leaves the old sheet's formulas computing no more.
      Copy: () => {
        throw new Error("ApiRange.Copy into another sheet breaks the old sheet's formulas");
      },
      // A hidden column reads no width; a size set shows a hidden line (docbuilder, DS 10.0).
      GetColumnWidth: () => (sh.hiddenCols.includes(b.c1) ? 0 : sh.widths[b.c1] ?? 8.43),
      SetColumnWidth: (w: number) => { for (let c = b.c1; c <= b.c2; c++) { sh.widths[c] = w; if (sh.hiddenCols.includes(c)) sh.hiddenCols.splice(sh.hiddenCols.indexOf(c), 1); } },
      GetRowHeight: () => (b.r1 in sh.heights ? sh.heights[b.r1] : 15),
      SetRowHeight: (h: number) => { for (let r = b.r1; r <= b.r2; r++) { sh.heights[r] = h; if (sh.hiddenRows.includes(r)) sh.hiddenRows.splice(sh.hiddenRows.indexOf(r), 1); } },
      GetHidden: () => (b.whole === "columns" ? sh.hiddenCols.includes(b.c1) : b.whole === "rows" ? sh.hiddenRows.includes(b.r1) : false),
      SetHidden: (v: boolean) => {
        const list = b.whole === "columns" ? sh.hiddenCols : sh.hiddenRows;
        const [from, to] = b.whole === "columns" ? [b.c1, b.c2] : [b.r1, b.r2];
        for (let k = from; k <= to; k++) {
          if (v && !list.includes(k)) list.push(k);
          if (!v && list.includes(k)) list.splice(list.indexOf(k), 1);
        }
        list.sort((x, y) => x - y);
      },
      // An editor people have co-edited lays the sizes out after the command (DS 10.0): they show from the next one on;
      // one nobody else has been in (`autofitAtOnce`) in the command.
      AutoFit: (rows: boolean, cols: boolean) => {
        state.calls.push(`AutoFit ${address} ${rows} ${cols}`);
        const fit = () => {
          if (cols) for (let c = b.c1; c <= b.c2; c++) sh.widths[c] = 12.5;
          if (rows) for (let r = b.r1; r <= b.r2; r++) sh.heights[r] = 20;
        };
        if (options.autofitAtOnce) fit();
        else later.push({ due: state.commands + 1, fn: fit });
      },
      GetCharacters: (start: number, count: number) => ({ GetFont: () => font(start, count), GetCount: () => String(sh.cells[first] ?? "").length }),
      GetFillColor: () => (lookAt(sh, first).fill === "none" ? "No Fill" : colourOf(lookAt(sh, first).fill)),
      GetWrapText: () => lookAt(sh, first).wrap,
      GetOrientation: () => lookAt(sh, first).rotation,
      SetFontName: (v: string) => setLook(sh, address, "font", v),
      SetFontSize: (v: number) => setLook(sh, address, "size", v),
      SetBold: (v: boolean) => setLook(sh, address, "bold", v),
      SetItalic: (v: boolean) => setLook(sh, address, "italic", v),
      SetStrikeout: (v: boolean) => setLook(sh, address, "strike", v),
      SetUnderline: (v: string) => setLook(sh, address, "underline", v),
      SetFontColor: (c: { r: number; g: number; b: number }) => setLook(sh, address, "color", hexOf(c)),
      SetFillColor: (c: string | { r: number; g: number; b: number }) => setLook(sh, address, "fill", c === "No Fill" ? "none" : hexOf(c as { r: number; g: number; b: number })),
      SetWrap: (v: boolean) => setLook(sh, address, "wrap", v),
      SetOrientation: (v: string | number) => setLook(sh, address, "rotation", ({ xlHorizontal: 0, xlUpward: 90, xlDownward: -90, xlVertical: 255 } as Record<string, number>)[String(v)] ?? Number(v)),
      SetAlignHorizontal: (v: string) => (["left", "center", "right", "justify"].includes(v) ? (each((a) => (sh.aligns[a] = v)), true) : false),
      SetAlignVertical: (v: string) => (["top", "center", "bottom", "justify", "distributed"].includes(v) ? (each((a) => (sh.aligns[a] = `${sh.aligns[a] ?? ""}/${v}`)), true) : false),
      SetBorders: (side: string, style: string) => {
        if (style !== "None") each((a) => (sh.borders[a] = [...(sh.borders[a] ?? []), `${side} ${style}`]));
        return true;
      },
      ClearFormats: () => {
        state.calls.push(`ClearFormats ${address}`);
        each((a) => {
          delete sh.looks[a];
          delete sh.formats[a];
          delete sh.aligns[a];
          delete sh.borders[a];
          delete sh.chars[a];
        });
        if (b.whole === "columns") for (let c = b.c1; c <= b.c2; c++) delete sh.colLooks[c];
        if (b.whole === "rows") for (let r = b.r1; r <= b.r2; r++) delete sh.rowLooks[r];
        sh.merges = sh.merges.filter((m) => !meets(bounds(m), b));
      },
      // The merged cells take the top-left one's value (the others' go) and its formats (DS 10.0).
      Merge: (across: boolean) => {
        state.calls.push(`Merge ${address} ${across}`);
        for (const a of grid.flat().slice(1)) {
          delete sh.cells[a];
          if (sh.looks[first]) sh.looks[a] = { ...sh.looks[first] };
          else delete sh.looks[a];
          if (sh.formats[first]) sh.formats[a] = sh.formats[first];
          else delete sh.formats[a];
        }
        sh.merges = sh.merges.filter((m) => !meets(bounds(m), b));
        sh.merges.push(address);
      },
      UnMerge: () => { sh.merges = sh.merges.filter((m) => !meets(bounds(m), b)); },
      Select: () => { state.selected = { sheet: sh, address }; },
      Insert: (dir: string) => { state.calls.push(`Insert ${address} ${dir}`); shift(sh, b.whole === "columns" ? "columns" : "rows", b.whole === "columns" ? b.c1 : b.r1, b.whole === "columns" ? b.c2 - b.c1 + 1 : b.r2 - b.r1 + 1); },
      Delete: (dir: string) => { state.calls.push(`Delete ${address} ${dir}`); shift(sh, b.whole === "columns" ? "columns" : "rows", b.whole === "columns" ? b.c1 : b.r1, -(b.whole === "columns" ? b.c2 - b.c1 + 1 : b.r2 - b.r1 + 1)); },
    };
    Object.assign(range, {
      GetFormatConditions: () => conditions(sh, address),
      GetValidation: () => validation(sh, b.whole ? [first] : grid.flat()),
      GetHyperlinks: () => reached(sh, b).filter((a) => sh.links[a]).map((a) => linkOf(sh, a)),
      ClearHyperlinks: () => void reached(sh, b).forEach((a) => delete sh.links[a]),
      // The first column of each key counts; a header is taken only when asked ("xlYes"); merged cells are not sorted.
      SetSort: (k1?: string, o1?: string, k2?: string, o2?: string, k3?: string, o3?: string, header?: string) => {
        state.calls.push(`SetSort ${address} ${[k1, o1, k2, o2, k3, o3, header].join(" ")}`);
        if (sh.merges.some((m) => meets(bounds(m), b))) return;
        const keys = ([[k1, o1], [k2, o2], [k3, o3]] as [string | undefined, string | undefined][]).filter(([k]) => k).map(([k, o]) => ({ col: parse(k!).c, desc: o === "xlDescending" }));
        if (keys.some((k) => k.col < b.c1 || k.col > b.c2)) return;
        sortRows(sh, { ...b, r1: header === "xlYes" ? b.r1 + 1 : b.r1 }, keys);
      },
      // With nothing: a filter on these cells, or off where it is there already (docbuilder); with a column: its criteria.
      SetAutoFilter: (...args: unknown[]) => {
        state.calls.push(`SetAutoFilter ${address} ${JSON.stringify(args)}`);
        if (args.length === 0) sh.filter = sh.filter === address ? null : address;
        else {
          sh.filter = address;
          sh.criteria.push(args);
        }
      },
    });
    Object.defineProperty(range, "MergeArea", { get: () => rangeOf(sh, sh.merges.find((m) => inside(first, bounds(m))) ?? first) });
    return range;
  };
  const wrap = (sh: FakeSheet) => {
    const w = {
      GetName: () => sh.name,
      GetVisible: () => !sh.hidden,
      SetVisible: (v: boolean) => {
        sh.hidden = !v;
        if (!v && state.active === sh) state.active = sheets.slice(sheets.indexOf(sh)).concat(sheets).find((s) => !s.hidden) ?? sh;
      },
      SetName: (n: string) => void (sh.name = n),
      SetActive: () => activate(sh),
      GetRange: (a: string) => rangeOf(sh, a),
      GetUsedRange: () => rangeOf(sh, usedAddress(sh)),
      GetFreezePanes: () => ({
        GetLocation: () => {
          const f = sh.frozen;
          if (!f.cols && !f.rows) return null;
          // As DS 10.0 names them: "A:A" and "1:1" for one column or row alone.
          return { GetAddress: () => (!f.rows ? (f.cols === 1 ? "A:A" : `A1:${nameOf(f.cols - 1)}1048576`) : !f.cols ? (f.rows === 1 ? "1:1" : `A1:XFD${f.rows}`) : `A1:${nameOf(f.cols - 1)}${f.rows}`) };
        },
        // Every freeze goes through the co-editing lock: it shows in the panes from the next command on (DS 10.0).
        FreezeRows: (n: number) => void later.push({ due: state.commands + 1, fn: () => void (sh.frozen = { cols: 0, rows: n }) }),
        FreezeColumns: (n: number) => void later.push({ due: state.commands + 1, fn: () => void (sh.frozen = { cols: n, rows: 0 }) }),
        // An unfreeze of a sheet that is not the active one changes nothing (docbuilder, DS 10.0).
        Unfreeze: () => void (state.active === sh && later.push({ due: state.commands + 1, fn: () => void (sh.frozen = { cols: 0, rows: 0 }) })),
        FreezeAt: () => {
          state.calls.push("FreezeAt");
          throw new Error("H.aH is not a function");
        },
      }),
      // The address goes into the cell as its text where the cell holds none, and the link's look comes with it.
      // It goes through the co-editing lock, as a freeze does: the link, the text and the look show from the next command
      // on (the editor, measured in e2e 34; docbuilder makes them at once). The link's look replaces the cell's font.
      SetHyperlink: (address: string, link: string, sub = "", tip = "", text?: string) => {
        if (!/^https?:|^mailto:|^$/.test(link) || link.length > 2000) throw new Error('Incorrect "address".');
        later.push({
          due: state.commands + 1,
          fn: () => {
            for (const a of cellsOf(address).flat()) {
              sh.links[a] = { address: link, sub, tip };
              if (text !== undefined) sh.cells[a] = text;
              else if (!isText(sh, a)) sh.cells[a] = link;
              sh.looks[a] = { underline: "single", color: "#0563C1" };
            }
          },
        });
        return true;
      },
      GetHyperlinks: () => Object.keys(sh.links).map((a) => linkOf(sh, a)),
      // A chart of a type the editor does not have is none (null); a range it cannot find is made all the same.
      AddChart: (ref: string, inRows: boolean, type: string, _style: number, width: number, height: number, col: number, _colOffset: number, row: number) => {
        if (!["bar", "barStacked", "horizontalBar", "horizontalBarStacked", "lineNormal", "pie", "doughnut", "area", "scatter"].includes(type)) return null;
        const chart = { type, ref, col, row, width, height, inRows } as FakeSheet["charts"][number];
        sh.charts.push(chart);
        return {
          GetChartType: () => chart.type,
          SetTitle: (t: string) => { chart.title = t; return true; },
          SetHorAxisTitle: (t: string) => { chart.xTitle = t; return true; },
          SetVerAxisTitle: (t: string) => { chart.yTitle = t; return true; },
          SetLegendPos: (p: string) => { chart.legend = p; return true; },
          GetTitle: () => (chart.title === undefined ? null : `${chart.title}\n`),
          GetPosition: () => ({ fromCol: chart.col, colOffset: 0, fromRow: chart.row, rowOffset: 0 }),
        };
      },
      GetAllCharts: () => sh.charts.map((chart) => ({ GetChartType: () => chart.type, GetTitle: () => (chart.title === undefined ? null : `${chart.title}\n`), GetPosition: () => ({ fromCol: chart.col, fromRow: chart.row }) })),
      // The editor gives a filter object with no range where there is none (docbuilder gives null).
      GetAutoFilter: () => ({ GetRange: () => (sh.filter ? rangeOf(sh, sh.filter) : null) }),
      // A table over cells that are in a table already is ignored without a word (docbuilder).
      FormatAsTable: (address: string) => {
        state.calls.push(`FormatAsTable ${address}`);
        if (options.poisonLook && inside(options.poisonLook, bounds(address))) throw new Error("the editor refused the format");
        if (!sh.tables.some((t) => meets(bounds(t), bounds(address)))) sh.tables.push(address);
        return true;
      },
      Delete: () => ask(`delete ${sh.name}`, () => sheets.splice(sheets.indexOf(sh), 1)),
      Move: (before?: object, after?: object) =>
        ask(`move ${sh.name}`, () => {
          sheets.splice(sheets.indexOf(sh), 1);
          const at = before ? sheets.indexOf(of.get(before)!) : sheets.indexOf(of.get(after!)!) + 1;
          sheets.splice(at, 0, sh);
          activate(sh);
        }),
    };
    of.set(w, sh);
    return w;
  };
  const Api = {
    GetSheets: () => sheets.map(wrap),
    GetSheet: (n: string | number) => {
      const sh = typeof n === "number" ? sheets[n] : sheets.find((s) => s.name === n);
      return sh ? wrap(sh) : null;
    },
    GetActiveSheet: () => wrap(state.active),
    AddSheet: (n: string) =>
      ask(`add ${n}`, () => {
        const made = freshSheet(n);
        sheets.splice(sheets.indexOf(state.active) + 1, 0, made);
        activate(made);
      }),
    CreateColorFromRGB: (r: number, g: number, b: number) => ({ r, g, b, GetRGB: () => ({ r, g, b }) }),
    // Names are the workbook's: a name taken (in any case) or one the builder does not take is "Invalid name"; a
    // reference to a sheet that is not there is "Invalid range"; what is read back has no quotes where none are needed.
    AddDefName: (name: string, ref: string) => {
      if (Object.keys(state.names).some((n) => n.toLowerCase() === name.toLowerCase()) || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) || /^[A-Za-z]{1,3}\d+$/.test(name)) throw new Error("Invalid name.");
      const m = /^(?:'((?:[^']|'')+)'|([^'!]+))?!?(.*)$/.exec(ref)!;
      const sheetName = (m[1] ?? m[2])?.replace(/''/g, "'");
      if (ref.includes("!") && !sheets.some((x) => x.name === sheetName)) throw new Error("Invalid range.");
      state.names[name] = ref.includes("!") ? `${/^\w+$/.test(sheetName!) ? sheetName : `'${sheetName!.replace(/'/g, "''")}'`}!${m[3]}` : ref;
      return true;
    },
    GetDefName: (name: string) => {
      const key = Object.keys(state.names).find((n) => n.toLowerCase() === name.toLowerCase());
      if (!key) throw new Error(`Defined name does not exist:${name}`);
      return {
        GetName: () => key,
        GetRefersTo: () => state.names[key],
        SetRefersTo: (ref: string) => void (state.names[key] = ref),
        Delete: () => void delete state.names[key],
      };
    },
    // A freeze at the selected cell, of the active sheet, where the selection is in it.
    SetFreezePanesType: (type: string) => {
      const sel = state.selected;
      if (type !== "cell" || !sel || sel.sheet !== state.active) return;
      // Where the panes are frozen at a cell already, it does nothing (the builder's SetFreezePanesType, DS 10.0).
      if (sel.sheet.frozen.cols && sel.sheet.frozen.rows) return;
      const p = parse(sel.address.split(":")[0]);
      // It shows in the panes from the next command on (DS 10.0).
      later.push({ due: state.commands + 1, fn: () => void (sel.sheet.frozen = { cols: p.c, rows: p.r }) });
    },
    Save: () => void state.saves++,
  };
  /** A command run as the editor runs it: what was asked two commands ago is made first. */
  const run = (source: string, args: unknown) => {
    options.before?.(state.commands, sheets);
    state.commands++;
    for (const item of later.filter((l) => l.due <= state.commands)) {
      later.splice(later.indexOf(item), 1);
      item.fn();
    }
    return JSON.parse(JSON.stringify(vm.runInNewContext(`(${source})()`, { Api, Asc: { scope: { args: JSON.parse(JSON.stringify(args)) } } }) ?? null));
  };
  return { state, run, view: () => sheets.map((s) => `${s.name}${s.hidden ? " (hidden)" : ""}`) };
}

/** The plugin running in its frame with `book` as its editor: it is handed `job`, and resolves with what it posts. */
async function plugin(book: ReturnType<typeof workbook>, job: { kind: string; args: unknown }): Promise<{ result?: any; error?: any; undone?: boolean; ran?: boolean }> {
  let handed = false;
  let posted: (outcome: unknown) => void = () => {};
  const outcome = new Promise<any>((resolve) => (posted = resolve));
  const window = {
    Asc: {
      scope: {} as { args?: unknown },
      plugin: {
        init: () => {},
        button: () => {},
        callCommand(fn: { toString(): string }, _close: boolean, _calc: boolean, then: (out: unknown) => void) {
          const out = book.run(fn.toString(), window.Asc.scope.args);
          setImmediate(() => then(out));
        },
        executeMethod(_name: string, _args: unknown[], then: () => void) {
          setImmediate(then);
        },
      },
    },
  };
  const context = {
    window,
    location: { pathname: "/plugin/token/index.html" },
    setTimeout: (fn: () => void) => setImmediate(fn),
    fetch: (url: string, init?: { body?: string }) => {
      if (url.endsWith("next")) {
        if (handed) return new Promise(() => {});
        handed = true;
        return Promise.resolve({ status: 200, json: async () => ({ jobId: "j1", ...job }) });
      }
      posted(JSON.parse(init!.body!));
      return new Promise(() => {});
    },
  };
  vm.runInNewContext(BRIDGE_JS, context);
  window.Asc.plugin.init();
  return outcome;
}

test("a spreadsheet edit: sheets made, written, renamed, copied, moved, hidden, shown and deleted in turn, each waited for", async () => {
  const book = workbook(["Sheet1", "Old"]);
  const ops = [
    { addSheet: "Data", position: 1 },
    { sheet: "data", range: "A1:B1", values: [[2, 3]] },
    { sheet: "Sheet1", range: "A1", values: [["=Data!A1+Data!B1"]] },
    { renameSheet: "Data", to: "Q1" },
    { copySheet: "Q1", to: "Q2" },
    { moveSheet: "Q2", position: 4 },
    { hideSheet: "Sheet1" },
    { deleteSheet: "Old" },
    { addSheet: "Old" },
    { showSheet: "Sheet1" },
  ];
  const out = await plugin(book, { kind: "cell.edit", args: { ops } });
  assert.deepEqual(out.result, { ops: ops.length, cells: 3 }, JSON.stringify(out));
  // Old deleted while hidden, and a new Old made after the last sheet, Q2.
  assert.deepEqual(book.view(), ["Q1", "Sheet1", "Q2", "Old"]);
  const [q1, sheet1, q2, old] = book.state.sheets;
  assert.deepEqual(q1.cells, { A1: 2, B1: 3 });
  assert.deepEqual(q2.cells, { A1: 2, B1: 3 }, "the copy has the cells of its sheet");
  assert.deepEqual(sheet1.cells, { A1: "=Data!A1+Data!B1" });
  assert.deepEqual(old.cells, {}, "the new Old is not the deleted one");
  assert.match(book.state.asked.at(-1)!, /^delete ~deleted /, "the deleted one went last, after every op was made");
  assert.ok(book.state.saves >= 1, "sent at the end");
});

test("a spreadsheet edit whose op fails in the editor takes back every op before it, in reverse: cells, names, places, visibility and deleted sheets", async () => {
  const book = workbook(["Sheet1", "Other", { name: "Back", hidden: true }], { poison: "Z9" });
  book.state.sheets[0].cells.A1 = 1;
  book.state.sheets[0].cells.A2 = "=A1*2";
  const before = JSON.stringify(book.state.sheets);
  const ops = [
    { range: "A1:A2", values: [[5], [""]] },
    { addSheet: "New" },
    { sheet: "New", range: "B2", values: [[7]] },
    { renameSheet: "Sheet1", to: "Renamed" },
    { moveSheet: "Other", position: 1 },
    { showSheet: "Back" },
    { deleteSheet: "Other" },
    { copySheet: "Renamed", to: "Copy" },
    { range: "Z9", values: [[1]] },
  ];
  const out = await plugin(book, { kind: "cell.edit", args: { ops } });
  assert.equal(out.error?.code, "failed", JSON.stringify(out));
  assert.equal(out.error.op, 8);
  assert.match(out.error.message, /^op 9: the editor refused the write/);
  assert.equal(out.undone, true);
  assert.equal(JSON.stringify(book.state.sheets), before, "the workbook is as it was");
  assert.ok(!book.state.asked.some((a) => a.startsWith("delete ~deleted")), "no sheet the edit deleted is gone");
});

test("a spreadsheet edit the check refuses touches nothing", async () => {
  const book = workbook(["Sheet1"]);
  const out = await plugin(book, { kind: "cell.edit", args: { ops: [{ range: "A1", values: [[1]] }, { deleteSheet: "Sheet1" }] } });
  assert.deepEqual(out, { jobId: "j1", error: { code: "last_visible_sheet", op: 1, message: 'op 2: "Sheet1" is the only sheet, and a workbook keeps one visible sheet at least' } });
  assert.equal(book.state.commands, 1, "the check alone");
  assert.deepEqual(book.state.sheets[0].cells, {});
});

test("a spreadsheet edit whose sheet the editor never makes fails after the wait, says why it may, and that the sheet may still come", async () => {
  const book = workbook(["Sheet1"], { never: true });
  const out = await plugin(book, { kind: "cell.edit", args: { ops: [{ range: "A1", values: [[1]] }, { addSheet: "Never" }] } });
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.equal(out.ran, true, "asked of the editor: it may still make it");
  assert.match(out.error.message, /^op 2: the editor did not show the change to the sheet "Never" within 10 s: a person may be working in that sheet, or the workbook's structure is protected; try again later\. The ops before it are taken back, but the change the editor was asked for may still be made\.$/);
  assert.deepEqual(book.state.sheets[0].cells, {}, "the write before it is taken back");
});

test("a spreadsheet edit whose deleted sheets cannot all be deleted at the end says it is partly made, naming the delete op and its sheet", async () => {
  // The first delete lands; the second never does (a person in that sheet holds it).
  let deletes = 0;
  const book = workbook(["A", "B", "C"], { never: (what) => what.startsWith("delete") && ++deletes === 2 });
  const out = await plugin(book, { kind: "cell.edit", args: { ops: [{ deleteSheet: "A" }, { deleteSheet: "B" }, { sheet: "C", range: "A1", values: [[1]] }] } });
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.equal(out.ran, true);
  assert.equal(out.error.op, 1);
  assert.match(out.error.message, /^op 2: the editor did not delete the sheet "B" within 10 s: .* Not all of the call could be taken back \(the sheet "A" is deleted already\)\.$/);
  assert.equal(out.undone, undefined);
  // A is gone for good; B and C's cell are back as they were.
  assert.deepEqual(book.view(), ["B", "C"]);
  assert.deepEqual(book.state.sheets[1].cells, {});
});

test("a spreadsheet edit of cell ops alone is one command for all of them, besides the check and the save", async () => {
  const book = workbook(["Sheet1"]);
  const ops = Array.from({ length: 200 }, (_, n) => ({ range: `A${n + 1}`, values: [[n]] }));
  const out = await plugin(book, { kind: "cell.edit", args: { ops } });
  assert.deepEqual(out.result, { ops: 200, cells: 200 });
  assert.equal(book.state.commands, 3, "check, the writes, save");
  assert.equal(book.state.sheets[0].cells.A200, 199);
  // Runs of cell ops between sheet ops are one command each.
  const mixed = workbook(["Sheet1"]);
  await plugin(mixed, { kind: "cell.edit", args: { ops: [{ range: "A1", values: [[1]] }, { range: "A2", values: [[2]] }, { renameSheet: "Sheet1", to: "S" }, { range: "A3", values: [[3]] }, { range: "A4", values: [[4]] }] } });
  assert.equal(mixed.state.commands, 5, "check, two writes, the rename, two writes, save");
  assert.deepEqual(mixed.state.sheets[0].cells, { A1: 1, A2: 2, A3: 3, A4: 4 });
});

test("a cell op the editor does not take (a formula it cannot read) fails the edit, and the cells written before it are as they were, with their formats and texts", async () => {
  const book = workbook(["Sheet1", "Other"]);
  const [sheet1] = book.state.sheets;
  Object.assign(sheet1.cells, { B2: 3, C2: "00123", D2: "=B2*2" });
  sheet1.formats.E2 = "0.00";
  const before = JSON.stringify(book.state.sheets);
  const ops = [
    { range: "B2:E2", values: [["10%", "7", "", "8"]] },
    { renameSheet: "Other", to: "Renamed" },
    { range: "A1", values: [["x"]] },
    { range: "D1:E1", values: [[1, "=SUM("]] },
  ];
  const out = await plugin(book, { kind: "cell.edit", args: { ops } });
  assert.equal(out.error?.code, "bad_value", JSON.stringify(out));
  assert.equal(out.error.op, 3);
  assert.match(out.error.message, /^op 4: the editor did not take the values for D1:E1 of "Sheet1": a formula it cannot read/);
  assert.equal(out.undone, true);
  // B2 is 3 in its own format again (not 300 %), C2 the text "00123" (not 123), D2 its formula, D1 empty.
  assert.equal(JSON.stringify(book.state.sheets), before);
});

test("cells written back in a rollback after a later op failed keep their own formats and texts", async () => {
  const book = workbook(["Sheet1"], { poison: "Z9" });
  const [sheet1] = book.state.sheets;
  Object.assign(sheet1.cells, { B2: 3, C2: "TRUE" });
  sheet1.formats.C2 = "@";
  const before = JSON.stringify(book.state.sheets);
  const out = await plugin(book, { kind: "cell.edit", args: { ops: [{ range: "B2:C2", values: [["10%", "2026"]] }, { addSheet: "New" }, { range: "Z9", values: [[1]] }] } });
  assert.equal(out.error?.code, "failed", JSON.stringify(out));
  assert.equal(out.undone, true);
  assert.equal(JSON.stringify(book.state.sheets), before);
});

test("cells put back get a format only where theirs differs: empty cells around them stay out of the used range", async () => {
  const book = workbook(["Sheet1"]);
  book.state.sheets[0].cells.A1 = 1;
  const out = await plugin(book, { kind: "cell.edit", args: { ops: [{ range: "A1:C1", values: [[2, "", ""]] }, { range: "D1:E1", values: [["x", "=SUM("]] }] } });
  assert.equal(out.error?.code, "bad_value");
  assert.deepEqual(book.state.sheets[0].cells, { A1: 1 });
  assert.deepEqual(book.state.formatted, [], "no cell given a format: none of them changed theirs");
});

test("a hidden sheet is not moved (the editor would show it, or lose the move), and shown, moved and hidden again in one call it stays hidden through a later add", async () => {
  const book = workbook(["A", { name: "Secret", hidden: true }, "C"]);
  const refused = await plugin(book, { kind: "cell.edit", args: { ops: [{ range: "A1", values: [[1]] }, { moveSheet: "Secret", position: 1 }] } });
  assert.equal(refused.error?.code, "sheet_hidden", JSON.stringify(refused));
  assert.equal(refused.error.op, 1);
  assert.deepEqual(book.state.asked, [], "nothing asked of the editor");
  assert.deepEqual(book.state.sheets[0].cells, {});

  const out = await plugin(book, { kind: "cell.edit", args: { ops: [{ showSheet: "Secret" }, { moveSheet: "Secret", position: 1 }, { hideSheet: "Secret" }, { addSheet: "Notes" }, { copySheet: "A", to: "A2" }] } });
  assert.deepEqual(out.result, { ops: 5, cells: 0 }, JSON.stringify(out));
  assert.deepEqual(book.view(), ["Secret (hidden)", "A", "A2", "C", "Notes"]);
});

test("a copied sheet gets the old one's values, formulas, texts, number formats and column widths, without ApiRange.Copy (which stops the old sheet's formulas)", async () => {
  const book = workbook(["Sheet1"]);
  const [sheet1] = book.state.sheets;
  Object.assign(sheet1.cells, { A1: "00123", B1: 0.1, C1: "=B1*2" });
  sheet1.formats.B1 = "0%";
  sheet1.widths[0] = 20;
  const out = await plugin(book, { kind: "cell.edit", args: { ops: [{ copySheet: "Sheet1", to: "Copy" }] } });
  assert.deepEqual(out.result, { ops: 1, cells: 0 }, JSON.stringify(out));
  const copy = book.state.sheets[1];
  assert.equal(copy.name, "Copy");
  assert.deepEqual(copy.cells, { A1: "00123", B1: 0.1, C1: "=B1*2" });
  assert.deepEqual(copy.formats, { B1: "0%" }, "the text written as text, then its own format back");
  assert.equal(copy.widths[0], 20);
});

/* ---------------- the spreadsheet's formatting, rows and columns (#13 PR 3) ---------------- */

/** A spreadsheet format job as office_format makes it (ops.ts). */
const formatting = (ops: unknown[]) => formatJob("xlsx", ops) as { kind: string; args: unknown };
/** A sheet's state as the builder could read and set it, for "as it was" comparisons (not what it cannot read). */
const readable = (sh: { cells: unknown; formats: unknown; looks: unknown; colLooks: unknown; rowLooks: unknown; merges: unknown; widths: unknown; heights: unknown; hiddenCols: unknown; hiddenRows: unknown; frozen: unknown }) => {
  // In a key order of its own: what was taken off and put back again is the same.
  const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v);
  return JSON.stringify(sorted([sh.cells, sh.formats, sh.looks, sh.colLooks, sh.rowLooks, sh.merges, sh.widths, sh.heights, sh.hiddenCols, sh.hiddenRows, sh.frozen]));
};

test("a sheet's format: each set key reaches the cells through the builder (superscript and subscript on a text's characters), and a merge", async () => {
  const book = workbook(["Sheet1", "Data"]);
  const data = book.state.sheets[1];
  Object.assign(data.cells, { A1: "H2O", B1: 5, A2: "x", C1: "keep", D1: "dropped" });
  const out = await plugin(book, formatting([
    { sheet: "data", format: "A1:B2", set: { numberFormat: "0.00", font: "Arial", fontSize: 12, bold: true, italic: true, underline: true, strike: true, color: "#C81E1E", fill: "#FFFF00", align: "center", valign: "top", wrap: true, rotation: 45, borders: { bottom: "single 1.5pt #000000" } } },
    { sheet: "Data", format: "A1", set: { subscript: true } },
    { sheet: "Data", format: "C1:D1", set: { merge: true } },
    { sheet: "Data", format: "E1", set: { rotation: "vertical", fill: "none" } },
  ]));
  assert.deepEqual(out.result, { ops: 4, cells: 0 }, JSON.stringify(out));
  assert.deepEqual(data.looks.B2, { font: "Arial", size: 12, bold: true, italic: true, underline: "single", strike: true, color: "#C81E1E", fill: "#FFFF00", wrap: true, rotation: 45 });
  assert.equal(data.looks.A1.vertAlign, "subscript");
  assert.equal(data.looks.E1.rotation, 255);
  assert.equal(data.formats.B2, "0.00");
  assert.equal(data.aligns.B2, "center/top");
  assert.deepEqual(data.borders.A2, ["Bottom Medium"]);
  assert.deepEqual(data.merges, ["C1:D1"]);
  assert.deepEqual([data.cells.C1, data.cells.D1], ["keep", undefined], "a merge keeps the top-left value only");
  assert.deepEqual(book.state.sheets[0].looks, {}, "the other sheet is not touched");
});

test("a sheet's format: superscript on a number or a formula, a freeze of a hidden sheet, too many cells and an insert past the sheet's end are refused by the check, before the first step changes anything", async () => {
  const book = workbook(["Sheet1", { name: "Hidden", hidden: true }]);
  const [sheet1] = book.state.sheets;
  Object.assign(sheet1.cells, { A1: "m2", B1: 5, C1: "=B1*2", C3: 7 });
  const before = readable(sheet1);
  // What a format cannot read back (alignment, borders) would stay, were it made before the refusal.
  const out = await plugin(book, formatting([{ format: "A1:D1", set: { bold: true, align: "center", borders: "all" } }, { format: "A1:B1", set: { superscript: true } }]));
  assert.deepEqual(out, { jobId: "j1", error: { code: "bad_op", op: 1, message: 'op 2: superscript takes text, and "Sheet1"!B1 holds a number (the editor sets it on a text\'s characters): leave that cell out' } });
  assert.equal(book.state.commands, 1, "the check alone");
  assert.equal(readable(sheet1), before);
  assert.deepEqual([sheet1.aligns, sheet1.borders], [{}, {}]);
  const formula = await plugin(book, formatting([{ format: "C1", set: { subscript: true } }]));
  assert.match(formula.error.message, /"Sheet1"!C1 holds a formula/);
  // A cell an op before merges into another holds nothing by then.
  const merged = await plugin(book, formatting([{ format: "B3:C3", set: { merge: true } }, { format: "C3", set: { subscript: true } }]));
  assert.equal(merged.error, undefined, JSON.stringify(merged));
  sheet1.merges = [];
  delete sheet1.looks.C3;
  sheet1.cells.C3 = 7;
  const commands = book.state.commands;
  const hidden = await plugin(book, formatting([{ format: "A1", set: { fill: "#FF0000" } }, { sheet: "Hidden", freeze: "B2" }]));
  assert.deepEqual(hidden.error, { code: "sheet_hidden", op: 1, message: 'op 2: "Hidden" is hidden, and the editor freezes panes of a visible sheet only: show it first' });
  // Whole columns count the used cells among them: in the check, on the sheet as it stands.
  sheet1.cells.A400 = 1;
  const many = await plugin(book, formatting([{ format: "A1:CV190", set: { italic: true } }, { format: "A:Z", set: { bold: true } }]));
  assert.match(many.error?.message, /^op 2: the call formats more than 20,000 cells/);
  delete sheet1.cells.A400;
  // An insert whose cells would move past the sheet's last row, after a write that reaches further down.
  const past = await plugin(book, { kind: "cell.edit", args: editJob("xlsx", [{ range: "A1048570", values: [[1]] }, { insertRows: "2:10" }]).args });
  assert.deepEqual(past.error, { code: "bad_op", op: 1, message: "op 2: the sheet's cells would move past its last row" });
  assert.equal(book.state.commands, commands + 3, "each the check alone");
  assert.equal(readable(sheet1), before);
  // The step checks again: an op before can change what it reads.
  assert.deepEqual(book.run(CELL_EDIT_COMMANDS.step, { op: (formatting([{ format: "B1", set: { subscript: true } }]).args as { ops: unknown[] }).ops[0], index: 3, pending: [] }).error, { code: "bad_op", op: 3, message: 'op 4: subscript takes text, and "Sheet1"!B1 holds a number (the editor sets it on a text\'s characters): leave that cell out' });
  // Empty cells are left: a text cell among them takes it.
  const ok = await plugin(book, formatting([{ format: "A1:A3", set: { superscript: true } }]));
  assert.deepEqual(ok.result, { ops: 1, cells: 0 });
  assert.equal(sheet1.looks.A1.vertAlign, "superscript");
});

test("a sheet's format taken back when a later op fails: number formats, fonts, fills, wrap, rotation, clear and merges as they were, the merged cells' values too; alignment and borders stay, and the answer names them", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [sheet1] = book.state.sheets;
  Object.assign(sheet1.cells, { A1: "a", B1: "b", C1: 0.3, D1: "d", A5: 7 });
  sheet1.formats.C1 = "0%";
  sheet1.looks.A1 = { bold: true, fill: "#00FF00", rotation: 90 };
  sheet1.looks.D1 = { italic: true, size: 14 };
  sheet1.merges.push("E1:F1");
  const before = readable(sheet1);
  const out = await plugin(book, formatting([
    { format: "A1:C1", set: { bold: false, italic: true, fill: "#FF0000", numberFormat: "0.00", wrap: true, rotation: 0, align: "center", borders: "all", font: "Arial", fontSize: 9, color: "#123456", underline: true, strike: true } },
    { format: "A1:B1", set: { merge: true } },
    { format: "E1:F1", set: { merge: false } },
    { format: "D1:F1", set: { clear: true } },
    { format: "Z99", set: { bold: true } },
  ]));
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.equal(out.ran, true);
  assert.equal(out.error.op, 4);
  assert.equal(out.error.message, 'op 5: the editor refused the format. The ops before it are taken back, but not all of them whole. The editor cannot read back the alignment and borders of "Sheet1"!A1:C1 (op 1), "Sheet1"!A1:B1 (op 2) and "Sheet1"!D1:F1 (op 4), which stay as this call set them.');
  assert.equal(readable(sheet1), before, "what the builder reads is as it was, B1's value and E1:F1's merge among it");
  assert.equal(sheet1.aligns.A1, "center", "alignment has no getter: it stays");
  assert.ok(sheet1.borders.A1.length, "nor do borders");
});

test("a merge taken back gives the merged cells their own formats back, which the merge had made the top-left one's", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [sheet1] = book.state.sheets;
  Object.assign(sheet1.cells, { A1: "a", B1: "b", A5: 5 });
  sheet1.looks.A1 = { bold: true, fill: "#FF0000" };
  sheet1.looks.B1 = { italic: true };
  sheet1.formats.B1 = "0.00";
  const before = readable(sheet1);
  const out = await plugin(book, formatting([{ format: "A1:B1", set: { merge: true } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.match(out.error.message, /The editor cannot read back the alignment and borders of "Sheet1"!A1:B1 \(op 1\)/, "a merge gives the others the top-left one's alignment and borders too");
  assert.equal(readable(sheet1), before);
});

test("an inverse keeps what a person changed after the step, and names it: a cell typed into after the agent's write, a cell filled after its format, a row written into after its insert", async () => {
  // check, the writes, the insert, the failing write: the person types between the insert and the failing write.
  const edit = workbook(["Sheet1"], { poison: "Z9", before: (n, sheets) => { if (n === 3) Object.assign(sheets[0].cells, { A1: "person", A3: "new row" }); } });
  const [s1] = edit.state.sheets;
  Object.assign(s1.cells, { A1: 1, B1: 2, A2: "below" });
  const out = await plugin(edit, { kind: "cell.edit", args: editJob("xlsx", [{ range: "A1:B1", values: [[10, 20]] }, { insertRows: "3" }, { range: "Z9", values: [[1]] }]).args });
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.match(out.error.message, /^op 3: the editor refused the write\. The ops before it are taken back, but not all of them whole\. Kept as a person changed them after this call: the rows 3:3 this call made \(a person wrote into them\) of "Sheet1"; A1 of "Sheet1"\.$/);
  assert.deepEqual(s1.cells, { A1: "person", B1: 2, A2: "below", A3: "new row" }, "B1 is back; A1 and the row the person wrote into stay");

  // check, the format, the failing format: the person fills B1 in between.
  const look = workbook(["Sheet1"], { poisonLook: "Z99", before: (n, sheets) => { if (n === 2) sheets[0].looks.B1 = { ...sheets[0].looks.B1, fill: "#0000FF" }; } });
  const [s2] = look.state.sheets;
  Object.assign(s2.cells, { A1: "a", B1: "b", A5: 5 });
  const failed = await plugin(look, formatting([{ format: "A1:C1", set: { bold: true, fill: "#FF0000" } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(failed.error?.code, "partial", JSON.stringify(failed));
  assert.match(failed.error.message, /Kept as a person changed them after this call: B1 of "Sheet1"\.$/);
  assert.deepEqual(s2.looks, { B1: { bold: true, fill: "#0000FF" } }, "A1 and C1 as they were; B1 as the person left it");
});

test("columns and rows: widths in characters, heights in points, hidden, shown and autofit, each taken back; the frozen panes never through FreezeAt, at a cell through its sheet made active and the agent's own active sheet after", async () => {
  const book = workbook(["Sheet1", "Data"], { poisonLook: "Z99" });
  const data = book.state.sheets[1];
  data.hiddenCols.push(4);
  data.widths[1] = 11;
  data.widths[4] = 9;
  data.widths[5] = 10;
  data.cells.A9 = 3;
  const before = readable(data);
  const ops = [
    { sheet: "Data", columns: "B:C", width: 20 },
    { sheet: "Data", rows: "2:3", height: 30, hide: true },
    { sheet: "Data", columns: "D", autofit: true },
    { sheet: "Data", columns: "E", show: true },
    { sheet: "Data", freeze: "B3" },
  ];
  const out = await plugin(book, formatting(ops));
  assert.deepEqual(out.result, { ops: 5, cells: 0 }, JSON.stringify(out));
  assert.deepEqual([data.widths, data.heights, data.hiddenRows, data.hiddenCols, data.frozen], [{ 1: 20, 2: 20, 3: 12.5, 4: 9, 5: 10 }, { 1: 30, 2: 30 }, [1, 2], [], { cols: 1, rows: 2 }]);
  assert.ok(book.state.calls.includes("AutoFit D:D false true"));
  assert.equal(book.state.active.name, "Sheet1", "the agent's active sheet is its own again");
  assert.ok(!book.state.calls.includes("FreezeAt"));
  // Refused by the check where a sheet is not there, before anything.
  const after = readable(data);
  const refused = await plugin(book, formatting([{ sheet: "Data", columns: "B:E", width: 5 }, { sheet: "Nope", freeze: "A2" }]));
  assert.equal(refused.error?.code, "not_found", JSON.stringify(refused));
  assert.equal(readable(data), after);
  // Taken back when a later op fails, the freeze too (an unfreeze through its sheet made active).
  // (An autofit's width, and a freeze at a cell, show only after their command: neither is a person's change.)
  const undone = await plugin(book, formatting([{ sheet: "Data", columns: "B:E", width: 5, hide: true }, { sheet: "Data", columns: "F", autofit: true }, { sheet: "Data", rows: "2:3", show: true }, { sheet: "Data", freeze: "C4" }, { sheet: "Data", format: "Z99", set: { bold: true } }]));
  assert.equal(undone.undone, true, JSON.stringify(undone));
  assert.equal(readable(data), after, "widths, hidden columns and rows and the frozen panes as they were");
  assert.equal(book.state.active.name, "Sheet1");
  void before;
});

test("rows and columns inserted and deleted: an insert is taken back by deleting what it made; deletes come last, and one that a later failure cannot take back is named", async () => {
  const book = workbook(["Sheet1", "B"]);
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "top", A2: "second", B2: "=A2", C1: "c" });
  const made = await plugin(book, { kind: "cell.edit", args: editJob("xlsx", [{ insertRows: "2:3" }, { range: "A2", values: [["new"]] }, { insertColumns: "B" }]).args });
  assert.deepEqual(made.result, { ops: 3, cells: 1, shifted: [{ sheet: "Sheet1", kind: "rows", at: 1, count: 2, made: true }, { sheet: "Sheet1", kind: "columns", at: 1, count: 1, made: true }] }, JSON.stringify(made));
  assert.deepEqual(s1.cells, { A1: "top", D1: "c", A2: "new", A4: "second", C4: "=A2" });
  const before = JSON.stringify(s1.cells);
  const failed = await plugin(book, { kind: "cell.edit", args: { ops: [{ insertColumns: "A:B", from: 0, count: 2 }, { insertRows: "1", from: 0, count: 1 }, { range: "B2", values: [["=SUM("]] }] } });
  assert.equal(failed.error?.code, "bad_value", JSON.stringify(failed));
  assert.equal(failed.undone, true);
  assert.equal(JSON.stringify(s1.cells), before, "the rows and columns it made are gone again");
  // A delete is the last of the call; one the editor made before a later failure is named.
  const book2 = workbook(["A", "B"], { never: (what) => what.startsWith("delete") });
  Object.assign(book2.state.sheets[0].cells, { A1: 1, A2: 2 });
  const gone = await plugin(book2, { kind: "cell.edit", args: editJob("xlsx", [{ deleteSheet: "B" }, { sheet: "A", deleteRows: "1" }]).args });
  assert.equal(gone.error?.code, "partial", JSON.stringify(gone));
  assert.match(gone.error.message, /Not taken back: the rows 1:1 of "A" that op 2 deleted\.$/);
  assert.deepEqual(book2.state.sheets[0].cells, { A1: 2 });
});

test("a format of whole columns: the cells of the used range among them one by one, the rest as the columns' own format; taken back so; the cells a call reads count against its cap", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: 1, A2: 2, B3: "x", C1: "out" });
  s1.looks.B2 = { fill: "#00FF00" };
  s1.colLooks[1] = { italic: true };
  const before = readable(s1);
  const out = await plugin(book, formatting([{ format: "A:B", set: { fill: "#FF0000", bold: true } }, { format: "C1", set: { subscript: true } }, { format: "D1", set: { subscript: true } }]));
  assert.equal(out.result?.ops, 3, JSON.stringify(out));
  assert.deepEqual(s1.colLooks, { 0: { fill: "#FF0000", bold: true }, 1: { italic: true, fill: "#FF0000", bold: true } });
  const after = readable(s1);
  const failed = await plugin(book, formatting([{ format: "A:B", set: { fill: "#0000FF", italic: false } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(failed.undone, true, JSON.stringify(failed));
  assert.equal(readable(s1), after);
  void before;
  // 19,900 cells of a range, which grows the used range, then a whole column with the 199 cells of the used range among
  // it: over the cap, in the step (the check counted the used range as the call found it).
  const big = workbook(["Sheet1"]);
  big.state.sheets[0].cells.A1 = 1;
  const capped = await plugin(big, formatting([{ format: "A1:CV199", set: { bold: true } }, { format: "A:A", set: { italic: true } }]));
  assert.equal(capped.error?.code, "bad_op", JSON.stringify(capped).slice(0, 300));
  assert.match(capped.error.message, /^op 2: the call formats more than 20,000 cells/);
});

test("a format of a whole sheet's columns or rows counts the used cells among them without listing them, and reads only those: refused before the agents' browser builds millions of addresses, accepted where they are few", async () => {
  // A used range of 2,000 rows: "A:Z" is 52,000 used cells, refused at once.
  const book = workbook(["Sheet1"]);
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "top", Z2000: "end" });
  const t0 = Date.now();
  const out = await plugin(book, formatting([{ format: "A:XFD", set: { font: "Arial" } }]));
  assert.match(out.error?.message, /^op 1: the call formats more than 20,000 cells/, JSON.stringify(out).slice(0, 300));
  assert.ok(Date.now() - t0 < 2000, `answered in ${Date.now() - t0} ms`);
  assert.ok(book.state.ranges < 50, `${book.state.ranges} ranges asked for`);
  assert.deepEqual(s1.looks, {});
  // Every column of a sheet whose used range is A1:B20: 40 used cells and 16,384 columns, within the cap. Only the used
  // columns' cells are read one by one (not A1:XFD20, 327,680 of them).
  const small = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s2] = small.state.sheets;
  Object.assign(s2.cells, { A1: "a", B20: 2 });
  s2.looks.B20 = { fill: "#00FF00" };
  const before = readable(s2);
  const whole = await plugin(small, formatting([{ format: "A:XFD", set: { bold: true } }]));
  assert.deepEqual(whole.result, { ops: 1, cells: 0 }, JSON.stringify(whole).slice(0, 300));
  assert.deepEqual([s2.colLooks[1], s2.colLooks[16383], s2.looks.B20], [{ bold: true }, { bold: true }, { fill: "#00FF00" }]);
  // And taken back so.
  const back = await plugin(small, formatting([{ format: "A:XFD", set: { italic: true } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(back.undone, true, JSON.stringify(back).slice(0, 300));
  const after = JSON.parse(readable(s2));
  assert.deepEqual([after[2].B20, after[3][16383]], [{ fill: "#00FF00" }, { bold: true }]);
  void before;
});

test("a merge taken back compares what a person changed before it puts the merged cells' values and number formats back: a cell whose number format the merge changed is no person's change", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: 1, B1: "x" });
  s1.formats.A1 = "0.00";
  s1.looks.A1 = { italic: true };
  s1.looks.B1 = { fill: "#FFFF00" };
  const before = readable(s1);
  const out = await plugin(book, formatting([{ format: "A1:B1", set: { merge: true } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.doesNotMatch(out.error.message, /Kept as a person changed them/);
  assert.equal(readable(s1), before, "B1 has its fill and General back, and is not italic");
});

test("rows deleted before a later failure move the cells below them for good: the ops before it there are not taken back at the old addresses, and the answer names them; cells above them are", async () => {
  const book = workbook(["Sheet1", "Old"], { never: (what) => what.startsWith("delete") });
  const [s1] = book.state.sheets;
  for (let r = 1; r <= 9; r++) s1.cells[`A${r}`] = `r${r}`;
  s1.cells.A10 = "a";
  s1.cells.B1 = "b";
  const out = await plugin(book, { kind: "cell.edit", args: editJob("xlsx", [{ range: "B1", values: [["new"]] }, { range: "A10", values: [[""]] }, { deleteSheet: "Old" }, { deleteRows: "5" }]).args });
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.match(out.error.message, / Not taken back: the rows 5:5 of "Sheet1" that op 4 deleted\. Not taken back either, as the rows or columns of their sheet moved after them for good: op 2\.$/);
  assert.deepEqual(out.error.shifted, [{ sheet: "Sheet1", kind: "rows", at: 4, count: 1, made: false }], "the rows that stay moved, for the answer to name the people in the workbook");
  // B1 is back; A10's "a" is not written into A10, which is A11's row now (A9, where "a" was, stays empty).
  assert.deepEqual(s1.cells, { A1: "r1", A2: "r2", A3: "r3", A4: "r4", A5: "r6", A6: "r7", A7: "r8", A8: "r9", B1: "b" });
});

test("frozen panes as DS names them: the first row alone reads \"1:1\", so office_read says it and an inverse puts it back; a freeze at a cell where one is already is unfrozen first, and its inverse compares what it left once it landed", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s1] = book.state.sheets;
  s1.cells.A1 = "head";
  s1.frozen = { cols: 0, rows: 1 };
  assert.deepEqual(book.run(COMMANDS["cell.read"].source, { formatting: true }).result.sheets[0].look.frozen, { cols: 0, rows: 1 });
  const out = await plugin(book, formatting([{ freeze: "C3" }, { format: "Z99", set: { bold: true } }]));
  assert.equal(out.undone, true, JSON.stringify(out));
  assert.deepEqual(s1.frozen, { cols: 0, rows: 1 }, "the person's frozen row is back");
  // At B2 already: a freeze at C4 is made, not left at B2.
  s1.frozen = { cols: 1, rows: 1 };
  const moved = await plugin(book, formatting([{ freeze: "C4" }]));
  assert.deepEqual(moved.result, { ops: 1, cells: 0 }, JSON.stringify(moved));
  assert.deepEqual(s1.frozen, { cols: 2, rows: 3 });
  // (Unfrozen in a command of its own before: in the editor an Unfreeze in the freeze's command takes the new one off.)
  assert.ok(book.state.commands >= 4);
  // Taken back so too: through no freeze, to the cell freeze before.
  const back = await plugin(book, formatting([{ freeze: "D5" }, { format: "Z99", set: { bold: true } }]));
  assert.equal(back.undone, true, JSON.stringify(back));
  assert.deepEqual(s1.frozen, { cols: 2, rows: 3 });
  // A person freezes elsewhere after the agent's freeze at a cell landed: theirs stays.
  const person = workbook(["Sheet1"], { poisonLook: "Z99", before: (n, sheets) => { if (n === 3) sheets[0].frozen = { cols: 0, rows: 5 }; } });
  const kept = await plugin(person, formatting([{ freeze: "C4" }, { format: "Z99", set: { bold: true } }]));
  assert.equal(kept.error?.code, "partial", JSON.stringify(kept));
  assert.match(kept.error.message, /Kept as a person changed them after this call: the frozen panes of "Sheet1"\.$/);
  assert.deepEqual(person.state.sheets[0].frozen, { cols: 0, rows: 5 });
});

test("every freeze shows a moment after its command, as the co-editing lock makes it: rows, columns and none are read once they show, and taken back whole; inverses wait for the panes they put back", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s1] = book.state.sheets;
  s1.cells.A1 = "head";
  // A freeze of rows taken back: nobody touched the panes, so no person's change is named.
  const rows = await plugin(book, formatting([{ freeze: "A2" }, { format: "Z99", set: { bold: true } }]));
  assert.equal(rows.undone, true, JSON.stringify(rows));
  assert.deepEqual(s1.frozen, { cols: 0, rows: 0 });
  // "none" over frozen rows, and columns.
  s1.frozen = { cols: 0, rows: 2 };
  const none = await plugin(book, formatting([{ freeze: "none" }, { format: "Z99", set: { bold: true } }]));
  assert.equal(none.undone, true, JSON.stringify(none));
  assert.deepEqual(s1.frozen, { cols: 0, rows: 2 });
  const cols = await plugin(book, formatting([{ freeze: "C1" }, { format: "Z99", set: { bold: true } }]));
  assert.equal(cols.undone, true, JSON.stringify(cols));
  assert.deepEqual(s1.frozen, { cols: 0, rows: 2 });
  // Two freezes of one sheet in a call, a cell over a cell among them: each inverse reads the panes the one after it
  // put back.
  s1.frozen = { cols: 1, rows: 1 };
  const twice = await plugin(book, formatting([{ freeze: "A3" }, { freeze: "C4" }, { freeze: "D5" }, { format: "Z99", set: { bold: true } }]));
  assert.equal(twice.undone, true, JSON.stringify(twice));
  assert.deepEqual(s1.frozen, { cols: 1, rows: 1 });
  // Made: the panes the last freeze asked for.
  const made = await plugin(book, formatting([{ freeze: "A3" }, { freeze: "C4" }, { freeze: "D5" }]));
  assert.deepEqual(made.result, { ops: 3, cells: 0 }, JSON.stringify(made));
  assert.deepEqual(s1.frozen, { cols: 3, rows: 4 });
  // Frozen so already: nothing asked of the editor, nothing to take back.
  const commands = book.state.commands;
  const same = await plugin(book, formatting([{ freeze: "D5" }]));
  assert.deepEqual(same.result, { ops: 1, cells: 0 }, JSON.stringify(same));
  assert.equal(book.state.commands, commands + 3, "the check, the step and the save");
});

test("an autofit whose size lands in its command is not waited for, and the autofits of a call that do not change a size are waited for once, at the end of their run", async () => {
  // An editor nobody else has been in: the sizes are there in the command.
  const quick = workbook(["Sheet1"], { autofitAtOnce: true });
  quick.state.sheets[0].cells.A1 = 1;
  const out = await plugin(quick, formatting([{ columns: "B", autofit: true }, { columns: "C", autofit: true }, { columns: "D", autofit: true }]));
  assert.deepEqual(out.result, { ops: 3, cells: 0 }, JSON.stringify(out));
  assert.equal(quick.state.commands, 5, "the check, three steps and the save");
  assert.deepEqual([quick.state.sheets[0].widths[1], quick.state.sheets[0].widths[3]], [12.5, 12.5]);
  // Fitted already: the sizes never change, and are read for at most one settle across the run.
  const commands = quick.state.commands;
  const again = await plugin(quick, formatting([{ columns: "B", autofit: true }, { columns: "C", autofit: true }, { columns: "D", autofit: true }, { columns: "E", autofit: true }]));
  assert.deepEqual(again.result, { ops: 4, cells: 0 }, JSON.stringify(again));
  assert.ok(quick.state.commands - commands <= 6 + SETTLE.tries + 1, `${quick.state.commands - commands} commands`);
  // And taken back so: the sizes the autofits left in their command are what the inverses compare.
  const failed = workbook(["Sheet1"], { autofitAtOnce: true, poisonLook: "Z99" });
  failed.state.sheets[0].cells.A1 = 1;
  const back = await plugin(failed, formatting([{ columns: "B:C", autofit: true }, { format: "Z99", set: { bold: true } }]));
  assert.equal(back.undone, true, JSON.stringify(back));
  assert.deepEqual(failed.state.sheets[0].widths, { 1: 8.43, 2: 8.43 });
});

test("clear, superscript and subscript on whole columns and rows reach the used cells among them, and are taken back", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "x", C1: "m2", C2: "note", D1: "y" });
  s1.looks.C1 = { bold: true, fill: "#FF0000" };
  s1.colLooks[3] = { italic: true };
  s1.merges.push("C2:D2");
  const before = readable(s1);
  const ok = await plugin(book, formatting([{ format: "C:C", set: { superscript: true } }]));
  assert.deepEqual(ok.result, { ops: 1, cells: 0 }, JSON.stringify(ok));
  assert.equal(s1.looks.C1.vertAlign, "superscript");
  const cleared = await plugin(book, formatting([{ format: "C:D", set: { clear: true } }]));
  assert.deepEqual(cleared.result, { ops: 1, cells: 0 }, JSON.stringify(cleared));
  assert.deepEqual([s1.looks.C1, s1.colLooks[3], s1.merges, s1.cells.C1], [undefined, undefined, [], "m2"]);
  // Taken back when a later op fails: the column's italic, C1's look and the merge.
  s1.looks.C1 = { bold: true, fill: "#FF0000" };
  s1.colLooks[3] = { italic: true };
  s1.merges.push("C2:D2");
  const again = readable(s1);
  const failed = await plugin(book, formatting([{ format: "C:D", set: { clear: true } }, { format: "1:1", set: { subscript: true, bold: true } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(failed.error?.code, "partial", JSON.stringify(failed));
  assert.equal(readable(s1), again);
  void before;
});

test("a text whose characters mix a key the format sets is not flattened by the inverse, and the answer names it as staying", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "ab", B1: "xy", C1: "plain" });
  s1.chars.A1 = [{ bold: true }, {}];
  s1.chars.B1 = [{ font: "Arial" }, {}];
  const out = await plugin(book, formatting([{ format: "A1:C1", set: { font: "Times", fontSize: 20, bold: true } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.match(out.error.message, /The editor cannot read back the mixed text formatting of "Sheet1"!A1, B1 \(op 1\), which stay as this call set them\.$/);
  assert.equal(s1.looks.C1, undefined, "the cell of one look is as it was");
  assert.equal(s1.looks.A1.bold, true, "A1's bold, which its characters mixed, is not set false on the whole text");
  // office_read does not say a key the characters mix.
  const read = book.run(COMMANDS["cell.read"].source, { formatting: true }).result.sheets[0].look;
  assert.ok(read.formats.every((f: { look: Record<string, unknown> }) => !Object.values(f.look).includes(null)), JSON.stringify(read.formats));
});

test("a text formatted in its middle only (one bold word) reads mixed before the step: the inverse does not flatten it, and the answer names it; a text past the characters a step compares is named so", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "abc", B1: "plain" });
  s1.chars.A1 = [{}, { bold: true }, {}];
  const out = await plugin(book, formatting([{ format: "A1:B1", set: { bold: true } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.match(out.error.message, /The editor cannot read back the mixed text formatting of "Sheet1"!A1 \(op 1\), which stay as this call set them\.$/);
  assert.equal(s1.looks.A1?.bold, true, "the person's bold b is not taken off with the rest of the text");
  assert.equal(s1.looks.B1, undefined, "the plain text is as it was");
  // 40,000 characters are compared one by one; a text of 20,000 more is past the room a step has.
  const long = workbook(["Sheet1"], { poisonLook: "Z99" });
  Object.assign(long.state.sheets[0].cells, { A1: "x".repeat(40_000), B1: "y".repeat(20_000) });
  const past = await plugin(long, formatting([{ format: "A1:B1", set: { italic: true } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(past.error?.code, "partial", JSON.stringify(past).slice(0, 400));
  assert.match(past.error.message, /cannot read back the mixed text formatting \(or of a text too long to read character by character\) of "Sheet1"!B1 \(op 1\)/);
  assert.equal(long.state.sheets[0].looks.A1, undefined, "the text that was compared is put back");
});

test("a whole column taken back keeps a cell a person formatted after the step beyond the used range it read, and names it", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99", before: (n, sheets) => { if (n === 2) sheets[0].looks.C50 = { fill: "#FF0000" }; } });
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: 1, C1: "c" });
  const out = await plugin(book, formatting([{ format: "C:C", set: { fill: "#FFFF00" } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.match(out.error.message, /Kept as a person changed them after this call: C50 of "Sheet1"\.$/);
  assert.equal(s1.looks.C50?.fill, "#FF0000");
  assert.equal(s1.colLooks[2], undefined, "the column has no fill of its own again");
  assert.equal(s1.looks.C1, undefined);
});

test("a line hidden before the step comes back hidden at its own size: a row's height is put back, a column's width (which a hidden column does not give) is named", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s1] = book.state.sheets;
  s1.cells.A1 = 1;
  s1.hiddenRows.push(1);
  s1.heights[1] = 14.25;
  s1.hiddenCols.push(3);
  s1.widths[3] = 11;
  const rows = await plugin(book, formatting([{ rows: "2", height: 30 }, { format: "Z99", set: { bold: true } }]));
  assert.equal(rows.undone, true, JSON.stringify(rows));
  assert.deepEqual([s1.hiddenRows, s1.heights[1]], [[1], 14.25]);
  const cols = await plugin(book, formatting([{ columns: "D", width: 20 }, { format: "Z99", set: { bold: true } }]));
  assert.equal(cols.error?.code, "partial", JSON.stringify(cols));
  assert.match(cols.error.message, /The editor cannot read back the width of "Sheet1"!column D \(op 1\), which stay as this call set them\.$/);
  assert.deepEqual(s1.hiddenCols, [3], "hidden again");
});

test("an autofit's inverse compares the size it left once it landed: a person's width after it wins, and is named", async () => {
  // check, the autofit, its settle read, the failing format: the person sets column D's width before the failing op.
  const book = workbook(["Sheet1"], { poisonLook: "Z99", before: (n, sheets) => { if (n === 3) sheets[0].widths[3] = 30; } });
  const [s1] = book.state.sheets;
  s1.cells.A1 = 1;
  s1.widths[4] = 9;
  const out = await plugin(book, formatting([{ columns: "D:E", autofit: true }, { format: "Z99", set: { bold: true } }]));
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.match(out.error.message, /Kept as a person changed them after this call: the column D of "Sheet1"\.$/);
  assert.deepEqual([s1.widths[3], s1.widths[4]], [30, 9], "D the person's, E as it was");
});

test("a sheet the call made, taken back, stays where a person wrote into it meanwhile, and the answer names it; a copy only where it holds what its sheet does not", async () => {
  // A person types into the new sheet as soon as it shows; the write after it fails.
  let typed = false;
  const book = workbook(["Sheet1"], { poison: "Z9", before: (_n, sheets) => { const made = sheets.find((s) => s.name === "New"); if (made && !typed) { made.cells.A1 = "person typed this"; typed = true; } } });
  const out = await plugin(book, { kind: "cell.edit", args: editJob("xlsx", [{ addSheet: "New" }, { range: "Z9", values: [[1]] }]).args });
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.match(out.error.message, /^op 2: the editor refused the write\. The ops before it are taken back, but not all of them whole\. Kept as a person changed them after this call: the sheet "New" this call made \(a person wrote into it\)\.$/);
  assert.deepEqual(book.view(), ["Sheet1", "New"]);
  assert.equal(book.state.sheets[1].cells.A1, "person typed this");
  // A copy that holds what its sheet holds (and the call's own write into it, taken back) goes again.
  const copies = workbook(["Sheet1"], { poison: "Z9" });
  Object.assign(copies.state.sheets[0].cells, { A1: 1, B2: "=A1*2", C3: "text" });
  const plain = await plugin(copies, { kind: "cell.edit", args: editJob("xlsx", [{ copySheet: "Sheet1", to: "Copy" }, { sheet: "Copy", range: "D4", values: [["mine"]] }, { range: "Z9", values: [[1]] }]).args });
  assert.equal(plain.undone, true, JSON.stringify(plain));
  assert.deepEqual(copies.view(), ["Sheet1"]);
  // One a person wrote into stays.
  let wrote = false;
  const kept = workbook(["Sheet1"], { poison: "Z9", before: (_n, sheets) => { const copy = sheets.find((s) => s.name === "Copy"); if (copy && copy.cells.A1 === 1 && !wrote) { copy.cells.E5 = "theirs"; wrote = true; } } });
  Object.assign(kept.state.sheets[0].cells, { A1: 1, B2: "=A1*2" });
  const theirs = await plugin(kept, { kind: "cell.edit", args: editJob("xlsx", [{ copySheet: "Sheet1", to: "Copy" }, { range: "Z9", values: [[1]] }]).args });
  assert.equal(theirs.error?.code, "partial", JSON.stringify(theirs));
  assert.match(theirs.error.message, /Kept as a person changed them after this call: the sheet "Copy" this call made \(a person wrote into it\)\.$/);
  assert.deepEqual(kept.view(), ["Sheet1", "Copy"]);
});

test("rows inserted and taken back are read for what was written into them in one go, not cell by cell", async () => {
  const book = workbook(["Sheet1"]);
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "top", D20: "end" });
  const out = await plugin(book, { kind: "cell.edit", args: editJob("xlsx", [{ insertRows: "2:5001" }, { range: "A1", values: [["=SUM("]] }]).args });
  assert.equal(out.undone, true, JSON.stringify(out));
  assert.deepEqual(s1.cells, { A1: "top", D20: "end" });
  assert.ok(book.state.ranges < 100, `${book.state.ranges} ranges asked for`);
});

test("cell.read with formatting: the merged cells and the lines' own sizes take their part of the room, and are cut where it ends", () => {
  const book = workbook(["Sheet1"]);
  const [s1] = book.state.sheets;
  s1.cells.A1 = 1;
  s1.cells.A20000 = 2;
  for (let r = 0; r < 20000; r += 2) s1.heights[r] = 20;
  const look = book.run(COMMANDS["cell.read"].source, { formatting: true }).result.sheets[0].look;
  assert.equal(look.cut, true);
  assert.ok(look.rows.own.length * 10 <= 50_000, `${look.rows.own.length} rows said`);
});

test("cell.read with formatting: the sheet's usual font, the cells that look otherwise in rectangles, merged cells, own widths and heights, hidden ones, frozen panes", () => {
  const book = workbook(["Sheet1"]);
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "Region", B1: "Sales", A2: "North", B2: 0.25, A3: "South", B3: 0.5, A4: "x" });
  for (const a of ["A1", "B1"]) s1.looks[a] = { bold: true, fill: "#1F4E79", color: "#FFFFFF" };
  for (const a of ["B2", "B3"]) s1.formats[a] = "0%";
  s1.looks.A4 = { rotation: 90, wrap: true, size: 14 };
  s1.merges.push("A4:B4");
  s1.widths[0] = 18;
  s1.heights[3] = 30;
  // A height the builder does not give is the usual one.
  (s1.heights as Record<number, number | null>)[1] = null;
  s1.hiddenRows.push(2);
  s1.frozen = { cols: 0, rows: 1 };
  const out = book.run(COMMANDS["cell.read"].source, { formatting: true });
  assert.ok(out.result, JSON.stringify(out));
  const look = out.result.sheets[0].look;
  assert.deepEqual(look.font, { name: "Calibri", size: 11 });
  assert.deepEqual(look.formats, [
    { look: { bold: true, color: "#FFFFFF", fill: "#1F4E79" }, ranges: ["A1:B1"] },
    { look: { numberFormat: "0%" }, ranges: ["B2:B3"] },
    { look: { size: 14, wrap: true, rotation: 90 }, ranges: ["A4"] },
  ]);
  assert.deepEqual(look.merged, ["A4:B4"]);
  assert.deepEqual(look.cols, { usual: 8.43, own: [[0, 18]] });
  assert.deepEqual(look.rows, { usual: 15, own: [[2, 15, true], [3, 30]] });
  assert.deepEqual(look.frozen, { cols: 0, rows: 1 });
  assert.equal(book.run(COMMANDS["cell.read"].source, {}).result.sheets[0].look, undefined, "only with formatting");
});

/* ---------------- comments and the editor's chat ---------------- */

/** A comment of the builder API, as `GetAllComments` and `GetCommentById` give it. */
function apiComment(id: number, d: { author: string; userId: string; time: number; text: string; solved?: boolean; quote?: string; replies?: { author: string; userId: string; time: number; text: string }[] }) {
  const replies = [...(d.replies ?? [])];
  return {
    added: [] as unknown[][],
    GetId: () => id,
    GetAuthorName: () => d.author,
    GetUserId: () => d.userId,
    GetTimeUTC: () => d.time,
    IsSolved: () => d.solved ?? false,
    GetQuoteText: () => d.quote ?? "",
    GetText: () => d.text,
    GetRepliesCount: () => replies.length,
    GetReply: (i: number) => ({ GetAuthorName: () => replies[i].author, GetUserId: () => replies[i].userId, GetTimeUTC: () => replies[i].time, GetText: () => replies[i].text, SetTimeUTC: (t: number) => (replies[i].time = t) }),
    AddReply(text: string, author: string, userId: string) {
      this.added.push([text, author, userId]);
      replies.push({ text, author, userId, time: 0 });
    },
  };
}

test("word.comments: every comment with its author, user id, time, state, quote, text and replies, and its thread's GUID: the durableId the builder gives as its id, in hex", () => {
  const c = apiComment(0x626360df, { author: "Portal", userId: "portal-user", time: 1793108364144, text: "Bitte übersetzen +Aegis", solved: true, quote: "was revised\r\n", replies: [{ author: "Aegis (agent)", userId: "agent:a", time: 1793108365000, text: "Done." }] });
  const small = apiComment(0x1f, { author: "Portal", userId: "portal-user", time: 1, text: "x" });
  const out = command("word.comments", { GetDocument: () => ({ GetAllComments: () => [c, small] }) });
  assert.deepEqual(out.result.comments[0], { author: "Portal", userId: "portal-user", time: 1793108364144, solved: true, quote: "was revised\r\n", text: "Bitte übersetzen +Aegis", replies: [{ author: "Aegis (agent)", userId: "agent:a", time: 1793108365000, text: "Done." }], guid: "626360df" });
  assert.equal(out.result.comments[1].guid, "0000001f", "8 hex digits, as the editor names it");
});

test("word.reply: the reply goes on the comment found by its durableId in decimal, as the agent; a comment that is gone is said to be", () => {
  const c = apiComment(0x626360df, { author: "Portal", userId: "portal-user", time: 1, text: "Bitte" });
  const asked: string[] = [];
  let saved = 0;
  const Api = { GetDocument: () => ({ GetCommentById: (id: string) => (asked.push(id), id === String(0x626360df) ? c : null) }), Save: () => saved++ };
  const out = command("word.reply", Api, { guid: "626360df", text: "Erledigt.", author: "Aegis (agent)", userId: "agent:a" });
  assert.deepEqual(out, { result: { replies: 1 } });
  assert.deepEqual(asked, [String(0x626360df)]);
  assert.deepEqual(c.added, [["Erledigt.", "Aegis (agent)", "agent:a"]]);
  assert.equal(saved, 1, "sent at once, as an edit is");
  assert.equal(command("word.reply", Api, { guid: "0badf00d", text: "x", author: "a", userId: "u" }).error.code, "comment_gone");
});

test("cell.reply: on the comment of its session id while that is still the comment the pages named, else the one of that author, text and time (within a second); none or two are said to be", () => {
  const right = apiComment(7, { author: "Portal", userId: "portal-user", time: 1793108364140, text: "Bitte prüfen" });
  const other = apiComment(8, { author: "Portal", userId: "portal-user", time: 1793108999999, text: "Etwas anderes" });
  const Api = { GetAllComments: () => [other, right], GetCommentById: (id: string) => ({ "7": right, "8": other })[id] ?? null, Save() {} };
  const match = { userId: "portal-user", text: "Bitte prüfen", time: 1793108364144 };
  // The session id now names another comment (a session after a reopen numbers them anew): found by the match.
  const out = command("cell.reply", Api, { sessionId: "8", match, text: "Geprüft.", author: "Aegis (agent)", userId: "agent:a" });
  assert.deepEqual(out, { result: { replies: 1, sessionId: "7" } });
  assert.deepEqual(right.added, [["Geprüft.", "Aegis (agent)", "agent:a"]]);
  assert.deepEqual(other.added, []);
  assert.equal(command("cell.reply", Api, { match: { ...match, time: match.time + 5000 }, text: "x", author: "a", userId: "u" }).error.code, "comment_gone");
  const twin = apiComment(9, { author: "Portal", userId: "portal-user", time: 1793108364100, text: "Bitte prüfen" });
  assert.equal(command("cell.reply", { ...Api, GetAllComments: () => [right, twin] }, { match, text: "x", author: "a", userId: "u" }).error.code, "comment_ambiguous");
});

/**
 * A Word document of one paragraph for word.edit, with positions: a range is [start, end) of its text, `AddText` after
 * a range puts the text there and the range grows over it, `Delete` takes the text away and every comment whose range
 * lies in it (as the editor does to a comment inside a larger deleted text), and `AddComment` on a range makes a new
 * comment with an id of its own.
 */
function wordWithComments(text: string, comments: { id: number; from: number; to: number; d: Parameters<typeof apiComment>[1] }[]) {
  const state = { text, comments: comments.map((c) => ({ ...c, api: apiComment(c.id, c.d) })), next: 0x7164b85f, made: [] as { at: [number, number]; api: ReturnType<typeof apiComment>; solved?: boolean; time?: number }[] };
  const range = (from: number, to: number): any => {
    const r = {
      from,
      to,
      GetStartPos: () => r.from,
      GetEndPos: () => r.to,
      AddText(t: string) {
        state.text = state.text.slice(0, r.to) + t + state.text.slice(r.to);
        r.to += t.length;
      },
      Delete() {
        state.text = state.text.slice(0, r.from) + state.text.slice(r.to);
        state.comments = state.comments.filter((c) => !(c.from >= r.from && c.to <= r.to && c.to - c.from < r.to - r.from));
      },
      GetAllParagraphs: () => [para],
      AddComment(t: string, author: string, userId: string) {
        const api = apiComment(state.next++, { author, userId, time: 0, text: t });
        const made = { at: [r.from, r.to] as [number, number], api, solved: undefined as boolean | undefined, time: undefined as number | undefined };
        Object.assign(api, { SetTimeUTC: (n: number) => (made.time = n), SetSolved: (b: boolean) => (made.solved = b) });
        state.made.push(made);
        return api;
      },
    };
    return r;
  };
  const para: any = { ...paragraph(""), ToJSON: () => JSON.stringify({ content: [{ type: "run", content: [state.text] }] }), GetText: () => `${state.text}\r\n`, GetRange: () => range(0, state.text.length), GetNext: () => null, GetPrevious: () => null, Delete() {} };
  const doc = {
    ...contentOf([para]),
    GetStyle: () => null,
    Search: (q: string) => (state.text.includes(q) ? [range(state.text.indexOf(q), state.text.indexOf(q) + q.length)] : []),
    GetRange: (a: number, b: number) => range(a, b),
    GetAllComments: () => [...state.comments.map((c) => c.api), ...state.made.map((m) => m.api)],
  };
  return { state, Api: { GetDocument: () => doc, Save() {} } };
}

test("word.edit: a comment the replace would take away is made again on the replacement, with its author, time, state and replies, and the move is answered; one on exactly the quote stays as it is", () => {
  const word = wordWithComments("Revenue figures were revised after the audit.", [
    { id: 0x626360df, from: 21, to: 28, d: { author: "Portal", userId: "portal-user", time: 1793108364144, text: "Bitte übersetzen +Aegis", solved: true, replies: [{ author: "Portal", userId: "portal-user", time: 1793108365000, text: "Danke" }] } },
  ]);
  const out = command("word.edit", word.Api, { ops: [{ quote: "were revised after", replacement: "wurden nach" }] });
  assert.deepEqual(out, { result: { ops: 1, moved: [["626360df", "7164b85f"]] } });
  assert.equal(word.state.text, "Revenue figures wurden nach the audit.");
  const made = word.state.made[0];
  assert.deepEqual(made.at, [16, 27], "on the replacement's own range");
  assert.deepEqual([made.api.GetText(), made.api.GetAuthorName(), made.api.GetUserId(), made.time, made.solved], ["Bitte übersetzen +Aegis", "Portal", "portal-user", 1793108364144, true]);
  assert.deepEqual(made.api.added, [["Danke", "Portal", "portal-user"]]);

  const exact = wordWithComments("Revenue figures were revised after the audit.", [{ id: 5, from: 16, to: 34, d: { author: "Portal", userId: "portal-user", time: 1, text: "Hier" } }]);
  assert.deepEqual(command("word.edit", exact.Api, { ops: [{ quote: "were revised after", replacement: "wurden nach" }] }), { result: { ops: 1 } });
  assert.equal(exact.state.made.length, 0);
});

/** The plugin running in its frame, handed `job`: its commands run by `callCommand(source, args)`, its editor's methods
 * by `method(name, args)`; resolves with what it posts. */
async function bridge(job: { kind: string; args: unknown }, callCommand: (source: string, args: unknown) => unknown, method: (name: string, args: unknown[]) => unknown): Promise<any> {
  let handed = false;
  let posted: (outcome: unknown) => void = () => {};
  const outcome = new Promise<any>((resolve) => (posted = resolve));
  const window = {
    Asc: {
      scope: {} as { args?: unknown },
      plugin: {
        init: () => {},
        button: () => {},
        callCommand(fn: { toString(): string }, _close: boolean, _calc: boolean, then: (out: unknown) => void) {
          const out = JSON.parse(JSON.stringify(callCommand(fn.toString(), window.Asc.scope.args) ?? null));
          setImmediate(() => then(out));
        },
        executeMethod(name: string, args: unknown[], then: (out: unknown) => void) {
          const out = method(name, JSON.parse(JSON.stringify(args)));
          setImmediate(() => then?.(out));
        },
      },
    },
  };
  const context = {
    window,
    location: { pathname: "/plugin/token/index.html" },
    setTimeout: (fn: () => void) => setImmediate(fn),
    fetch: (url: string, init?: { body?: string }) => {
      if (url.endsWith("next")) {
        if (handed) return new Promise(() => {});
        handed = true;
        return Promise.resolve({ status: 200, json: async () => ({ jobId: "j1", ...job }) });
      }
      posted(JSON.parse(init!.body!));
      return new Promise(() => {});
    },
  };
  vm.runInNewContext(BRIDGE_JS, context);
  window.Asc.plugin.init();
  return outcome;
}

test("chat.send: the message goes out through the editor's own chat method, no command", async () => {
  const sent: unknown[][] = [];
  const out = await bridge({ kind: "chat.send", args: { text: "Zusammenfassung: …" } }, () => assert.fail("no command"), (name, args) => (sent.push([name, ...args]), true));
  assert.deepEqual(out.result, { sent: true });
  assert.deepEqual(sent, [["CoAuthoringChatSendMessage", "Zusammenfassung: …"]]);
});

test("a reply through the editor's comment methods (an editor that may only comment): the Word comment found by its GUID, then by author, text and time in the methods' local time; the reply added to its thread", async () => {
  const c = apiComment(0x626360df, { author: "Portal", userId: "portal-user", time: 1793131668923, text: "Bitte +Beta" });
  const calls: unknown[][] = [];
  const out = await bridge(
    { kind: "word.reply", args: { how: "method", guid: "626360df", text: "From a commenter.", author: "Beta (agent)", userId: "agent:b" } },
    (source, args) => vm.runInNewContext(`(${source})()`, { Api: { GetDocument: () => ({ GetAllComments: () => [c] }) }, Asc: { scope: { args } } }),
    (name, args) => {
      calls.push([name, ...args]);
      // Its time is the editor's local time: an hour off UTC here.
      if (name === "GetAllComments") return [{ Id: "1_2", Data: { Text: "Anders", UserId: "portal-user", Time: "1793135268923", Replies: [] } }, { Id: "1_1", Data: { Text: "Bitte +Beta", UserId: "portal-user", UserName: "Portal", Time: "1793135268923", Replies: [] } }];
      return undefined;
    },
  );
  assert.deepEqual(out.result, { replies: 1 });
  const change = calls.find((c) => c[0] === "ChangeComment")!;
  assert.equal(change[1], "1_1");
  assert.deepEqual((change[2] as { Replies: { UserName: string; UserId: string; Text: string }[] }).Replies.map((r) => [r.UserName, r.UserId, r.Text]), [["Beta (agent)", "agent:b", "From a commenter."]]);

  const gone = await bridge({ kind: "cell.reply", args: { how: "method", match: { userId: "portal-user", text: "Nicht da", time: 1 }, text: "x", author: "a", userId: "u" } }, () => null, (name) => (name === "GetAllComments" ? [] : undefined));
  assert.equal(gone.error.code, "comment_gone");
});

test("a Word reply through the comment methods names the comment made anew by the GUID that is new after it, also where another comment has the same author and text", async () => {
  const c = apiComment(0x626360df, { author: "Portal", userId: "portal-user", time: 1793131668923, text: "Bitte +Beta" });
  const twin = apiComment(0x11, { author: "Portal", userId: "portal-user", time: 1793100000000, text: "Bitte +Beta" });
  const remade = apiComment(0x7000, { author: "Portal", userId: "portal-user", time: 1793131668923, text: "Bitte +Beta" });
  let listed = 0;
  const out = await bridge(
    { kind: "word.reply", args: { how: "method", guid: "626360df", text: "Gern.", author: "Beta (agent)", userId: "agent:b" } },
    (source, args) => vm.runInNewContext(`(${source})()`, { Api: { GetDocument: () => ({ GetAllComments: () => (listed++ === 0 ? [twin, c] : [twin, remade]) }) }, Asc: { scope: { args } } }),
    (name) => (name === "GetAllComments" ? [{ Id: "1_1", Data: { Text: "Bitte +Beta", UserId: "portal-user", Time: "1793135268923", Replies: [] } }, { Id: "1_2", Data: { Text: "Bitte +Beta", UserId: "portal-user", Time: "1793103600000", Replies: [] } }] : undefined),
  );
  assert.deepEqual(out.result, { replies: 1, guid: "00007000" });
});

/* ------------------------------------------------------------------ */
/* view.locate (office_screenshot)                                      */
/* ------------------------------------------------------------------ */

/**
 * A Word document of `texts` (a list is a table of one row, `{rows}` one of those rows), laid out so that page k starts
 * in paragraph `starts[k]` (an index into the document's paragraphs in reading order, a table's cells among them);
 * `hits` what the editor's search finds of a quote, each on its page (from 0), or in a header.
 */
function laidOut(texts: (string | string[] | { rows: string[][] })[], starts: number[], hits: Record<string, (number | "header")[]> = {}) {
  let id = 0;
  const paras: { GetInternalId: () => string }[] = [];
  const para = (text: string) => {
    const own = String(++id);
    const p = { ...paragraph(text), GetInternalId: () => own };
    paras.push(p);
    return p;
  };
  const elements: unknown[] = texts.map((t): unknown =>
    typeof t === "string"
      ? para(t)
      : (() => {
          const rows = (Array.isArray(t) ? [t] : t.rows).map((row) => row.map((c) => contentOf([para(c)])).map((content) => ({ GetContent: () => content })));
          return { GetClassType: () => "table", GetRowsCount: () => rows.length, GetRow: (r: number) => ({ GetCellsCount: () => rows[r].length, GetCell: (i: number) => rows[r][i] }) };
        })(),
  );
  const did: string[] = [];
  let at = 0;
  const doc = {
    ...contentOf(elements),
    GetPageCount: () => starts.length,
    // A hit on a page is in the paragraph that page starts with; one in a header is in none of the body's.
    Search: (q: string) => (hits[q] ?? []).map((page, k) => (page === "header" ? { GetAllParagraphs: () => [{ GetInternalId: () => "header" }], GetStartPos: () => 0 } : { GetStartPage: () => page, GetAllParagraphs: () => [paras[starts[page]] ?? paras[0]], GetStartPos: () => k })),
    GoToPage: (k: number) => (did.push(`page ${k}`), (at = starts[k])),
    MoveCursorRight: (n: number, select: boolean) => did.push(`right ${n} ${select}`),
    GetRangeBySelect: () => ({ GetAllParagraphs: () => [paras[at]] }),
    RemoveSelection: () => did.push("unselect"),
  };
  return { Api: { GetDocument: () => doc }, did };
}

test("view.locate, Word: the page, the page count, and the page's blocks as office_read numbers them, from the one the page starts in to the one the next page starts in", () => {
  // Paragraphs in reading order: 0 a, 1 b, 2 c, 3 d, 4 cell1, 5 cell2, 6 e, 7 f. Pages start at a, c, cell2.
  const doc = laidOut(["a", "b", "c", "d", ["cell1", "cell2"], "e", "f"], [0, 2, 5]);
  const two = command("view.locate", doc.Api, { kind: "word", page: 2 });
  assert.deepEqual(two.result, { page: 2, pages: 3, first: 3, blocks: [{ p: "c" }, { p: "d" }, { table: [["cell1", "cell2"]] }], truncated: false, view: { kind: "word", page: 2, pages: 3 } });
  assert.deepEqual(doc.did, ["page 1", "right 1 true", "page 2", "right 1 true", "unselect"], "the selection is the agent's own, and let go");
  const last = command("view.locate", doc.Api, { kind: "word", page: 3 });
  assert.equal(last.result.first, 5, "a page that starts in a table's cell starts with the table");
  assert.deepEqual(last.result.blocks.map((b: { p?: string }) => b.p ?? "table"), ["table", "e", "f"]);
  assert.deepEqual(command("view.locate", doc.Api, { kind: "word", page: 4 }).error, { code: "no_page", message: "the document has 3 pages" });
});

test("view.locate, Word: the first page's text starts at the document's start, also where going to the page puts the cursor after a table of contents there", () => {
  // Going to page 1 lands in c, after the TOC's entries a and b; page 2 starts at e.
  const doc = laidOut(["a", "b", "c", "d", "e"], [2, 4]);
  const one = command("view.locate", doc.Api, { kind: "word", page: 1 }).result;
  assert.deepEqual([one.first, one.blocks.map((b: { p: string }) => b.p)], [1, ["a", "b", "c", "d", "e"]]);
});

test("view.locate, Word: a page in a long table gives the table's rows from the one the page starts in to the one the next page starts in, and says which", () => {
  // Paragraphs: 0 a, then a table of 40 rows of 2 cells (1-80), then 81 z. Pages start at a, in row 3 (paragraph 5),
  // in row 7 (paragraph 13), and at z.
  const rows = Array.from({ length: 40 }, (_, r) => [`r${r + 1}a`, `r${r + 1}b`]);
  const doc = laidOut(["a", { rows }, "z"], [0, 5, 13, 81]);
  const two = command("view.locate", doc.Api, { kind: "word", page: 2 }).result;
  assert.deepEqual(two.blocks, [{ table: rows.slice(2, 7), row: 3, of: 40 }], "rows 3 to 7: the next page starts in row 7");
  assert.equal(two.first, 2);
  assert.deepEqual(command("view.locate", doc.Api, { kind: "word", page: 1 }).result.blocks, [{ p: "a" }, { table: rows.slice(0, 3), row: 1, of: 40 }]);
  assert.deepEqual(command("view.locate", doc.Api, { kind: "word", page: 3 }).result.blocks, [{ table: rows.slice(6), row: 7, of: 40 }, { p: "z" }]);
});

test("view.locate, Word: a page's text stops at the most a picture gives, also inside a table and inside one paragraph", () => {
  // A table of 2,000 rows over pages 2 to 48 (each page starts 40 rows on), the text of one page far above the cap.
  const rows = Array.from({ length: 2000 }, (_, r) => Array.from({ length: 5 }, (_, c) => `row ${r + 1} cell ${c + 1} `.padEnd(30, "x")));
  const starts = [0, ...Array.from({ length: 47 }, (_, k) => 1 + 5 * 40 * k), 1 + 5 * 2000];
  const doc = laidOut(["heading", { rows }, "end"], starts);
  const page = command("view.locate", doc.Api, { kind: "word", page: 1 }).result;
  const size = (blocks: { p?: string; table?: string[][] }[]) => blocks.reduce((n, b) => n + (b.p ?? "").length + (b.table ?? []).flat().join("").length, 0);
  assert.equal(page.truncated, false, "a page of 40 rows is far below it");
  const all = laidOut(["heading", { rows }, "end"], [0, 1 + 5 * 2000]);
  const long = command("view.locate", all.Api, { kind: "word", page: 1 }).result;
  assert.equal(long.truncated, true);
  assert.ok(size(long.blocks) <= MAX_SHOWN_TEXT, `${size(long.blocks)} characters`);
  assert.ok(long.blocks[1].table.length < 200 && long.blocks[1].row === 1 && long.blocks[1].of === 2000);
  const one = laidOut(["y".repeat(50_000), "after"], [0]);
  const cut = command("view.locate", one.Api, { kind: "word", page: 1 }).result;
  assert.deepEqual([cut.truncated, cut.blocks.length, cut.blocks[0].p.length], [true, 1, MAX_SHOWN_TEXT]);
});

test("view.locate, Word: a quote's page, the nth time it is found in the body (not in a header); a quote found more than once needs nth; one not found is refused", () => {
  const doc = laidOut(["a", "b", "c"], [0, 1, 2], { once: ["header", 1], thrice: [0, 1, 2] });
  assert.equal(command("view.locate", doc.Api, { kind: "word", quote: "once" }).result.page, 2);
  assert.equal(command("view.locate", doc.Api, { kind: "word", quote: "thrice", nth: 3 }).result.page, 3);
  assert.deepEqual(command("view.locate", doc.Api, { kind: "word", quote: "thrice" }).error, { code: "quote_ambiguous", message: 'the quote "thrice" is in the document 3 times: give nth (from 1) or quote more of it' });
  assert.deepEqual(command("view.locate", doc.Api, { kind: "word", quote: "thrice", nth: 4 }).error, { code: "quote_not_found", message: 'the quote "thrice" is in the document 3 times, not 4' });
  assert.deepEqual(command("view.locate", doc.Api, { kind: "word", quote: "none" }).error, { code: "quote_not_found", message: 'the quote "none" is not in the document' });
});

/**
 * A workbook for view.locate: sheets of `used` ranges, each cell holding its address as its value; column widths in
 * characters by column (8.43 where not given), row heights in points (none given: the default), hidden columns and
 * rows, and frozen panes (`frozen`, the location the builder gives).
 */
function viewBook(sheets: { name: string; hidden?: boolean; used: string; widths?: Record<string, number>; heights?: Record<number, number>; hiddenCols?: string[]; hiddenRows?: number[]; frozen?: string; value?: (a: string) => string }[]) {
  const asked: string[] = [];
  const book = sheets.map((s, index) => ({
    GetName: () => s.name,
    GetVisible: () => !s.hidden,
    GetIndex: () => index,
    GetUsedRange: () => ({ GetAddress: () => s.used }),
    GetFreezePanes: () => ({ GetLocation: () => (s.frozen ? { GetAddress: () => s.frozen } : null) }),
    GetRange: (a: string) => {
      asked.push(a);
      const col = /^([A-Z]+):\1$/.exec(a)?.[1];
      const row = /^(\d+):\1$/.exec(a)?.[1];
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a);
      const cells = () => {
        const [, c1, r1, c2 = c1, r2 = r1] = m!;
        const n = (l: string) => [...l].reduce((x, ch) => x * 26 + ch.charCodeAt(0) - 64, 0);
        const name = (k: number) => { let out = ""; for (; k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(65 + ((k - 1) % 26)) + out; return out; };
        return Array.from({ length: Number(r2) - Number(r1) + 1 }, (_, y) => Array.from({ length: n(c2) - n(c1) + 1 }, (_, x) => (s.value ?? String)(`${name(n(c1) + x)}${Number(r1) + y}`)));
      };
      return {
        GetHidden: () => (col ? (s.hiddenCols ?? []).includes(col) : row ? (s.hiddenRows ?? []).includes(Number(row)) : false),
        GetColumnWidth: () => (m ? s.widths?.[m[1]] ?? 8.43 : 8.43),
        GetRowHeight: () => (m ? s.heights?.[Number(m[2])] ?? null : null),
        GetValue: () => cells(),
        GetFormula: () => cells().map((r) => r.map(() => "")),
      };
    },
  }));
  return { Api: { GetSheets: () => book }, asked };
}

test("view.locate, sheets: the first visible sheet's used range from A1 at 100 % where it fits, with its cells; a hidden sheet is refused; a sheet by its name in any case", () => {
  const book = viewBook([{ name: "Hidden", hidden: true, used: "A1:B2" }, { name: "Data", used: "B2:C3" }]);
  const out = command("view.locate", book.Api, { kind: "cell" });
  assert.deepEqual(out.result.view, { kind: "cell", index: 1, name: "Data", c1: 0, r1: 0, c2: 2, r2: 2, centre: [1, 1], away: [0, 302], zoom: 1 });
  assert.deepEqual([out.result.sheet, out.result.range, out.result.used, out.result.cut, out.result.zoom], ["Data", "A1:C3", "B2:C3", false, 1]);
  assert.equal(out.result.cells.length, 9);
  assert.deepEqual(out.result.cells[4], { a: "B2", v: "B2" });
  assert.equal(command("view.locate", book.Api, { kind: "cell", sheet: "data" }).result.sheet, "Data");
  const hidden = command("view.locate", book.Api, { kind: "cell", sheet: "HIDDEN" });
  assert.equal(hidden.error.code, "sheet_hidden");
  assert.match(hidden.error.message, /^"Hidden" is hidden, and the editor shows no hidden sheet: show it first \(office_edit showSheet\)$/);
  assert.equal(command("view.locate", book.Api, { kind: "cell", sheet: "Nope" }).error.code, "not_found");
});

test("view.locate, sheets: the fit from the columns' widths and the rows' heights: 100 %, else 75 %, else refused with the largest range from its first cell that fits; the default range cut to it", () => {
  const book = viewBook([{ name: "S", used: "A1:BH120" }]);
  // 23 default columns of 64 px and 41 rows of 19 px fit at 100 % (1480 x 783); 30 x 55 at 75 %.
  assert.equal(command("view.locate", book.Api, { kind: "cell", range: { col: 0, row: 0, cols: 23, rows: 41 } }).result.zoom, 1);
  assert.equal(command("view.locate", book.Api, { kind: "cell", range: { col: 0, row: 0, cols: 24, rows: 41 } }).result.zoom, 0.75);
  assert.equal(command("view.locate", book.Api, { kind: "cell", range: { col: 3, row: 9, cols: 30, rows: 55 } }).result.zoom, 0.75);
  assert.deepEqual(command("view.locate", book.Api, { kind: "cell", range: { col: 3, row: 9, cols: 31, rows: 55 } }).error, { code: "range_too_large", message: "the range D10:AH64 is larger than the editor shows at 75 %: the largest range from D10 that fits is D10:AG64; take it in parts" });
  const cut = command("view.locate", book.Api, { kind: "cell" }).result;
  assert.deepEqual([cut.range, cut.used, cut.cut, cut.zoom], ["A1:AD55", "A1:BH120", true, 0.75]);
  // Wide columns, tall rows: fewer fit. Hidden ones count nothing.
  // B is 1,755 px wide, row 2 1,067 px high: at 75 % (1,981 x 1,050 px) A to D fit, and row 1 alone.
  const wide = viewBook([{ name: "S", used: "A1:Z99", widths: { B: 250 }, heights: { 2: 800 } }]);
  assert.match(command("view.locate", wide.Api, { kind: "cell", range: { col: 0, row: 0, cols: 6, rows: 3 } }).error.message, /the largest range from A1 that fits is A1:D1;/);
  const hidden = viewBook([{ name: "S", used: "A1:Z99", hiddenCols: ["B", "C", "D", "E", "F", "G", "H"] }]);
  assert.equal(command("view.locate", hidden.Api, { kind: "cell", range: { col: 0, row: 0, cols: 30, rows: 10 } }).result.zoom, 1);
});

test("view.locate, sheets: hidden rows and columns are left out of the cells, and the frame function is told which they are; a range spans so many rows and columns at most, hidden ones counted", () => {
  // A filtered sheet: A1:Z2000 with rows 41-2000 hidden, and column C hidden.
  const book = viewBook([{ name: "S", used: "A1:Z2000", hiddenRows: Array.from({ length: 1960 }, (_, k) => k + 41), hiddenCols: ["C"] }]);
  const out = command("view.locate", book.Api, { kind: "cell" }).result;
  assert.deepEqual([out.range, out.cut, out.zoom, out.hidden], [`A1:Z${SHEET_MOST.rows}`, true, 0.75, true]);
  assert.equal(out.cells.length, 40 * 25, "the 40 rows shown, without column C");
  assert.ok(!out.cells.some((c: { a: string }) => /^C\d/.test(c.a) || Number(c.a.replace(/^[A-Z]+/, "")) > 40));
  assert.deepEqual(out.view.hidden.cols, [2]);
  assert.deepEqual([out.view.hidden.rows.length, out.view.hidden.rows[0], out.view.hidden.rows.at(-1)], [SHEET_MOST.rows - 40, 40, SHEET_MOST.rows - 1]);
  assert.deepEqual(out.view.centre, [13, 19], "the centre among the columns and rows shown");
  const given = command("view.locate", book.Api, { kind: "cell", range: { col: 0, row: 0, cols: 26, rows: 2000 } });
  assert.deepEqual(given.error, { code: "range_too_large", message: `the range A1:Z2000 is larger than the editor shows at 75 % (a picture takes ${SHEET_MOST.cols} columns and ${SHEET_MOST.rows} rows at most, hidden ones counted): the largest range from A1 that fits is A1:Z${SHEET_MOST.rows}; take it in parts` });
  // A range of hidden rows alone shows nothing.
  assert.equal(command("view.locate", book.Api, { kind: "cell", range: { col: 0, row: 100, cols: 3, rows: 5 } }).error.code, "range_hidden");
  // No hidden ones: nothing said of them.
  const plain = command("view.locate", viewBook([{ name: "S", used: "A1:B2" }]).Api, { kind: "cell" }).result;
  assert.deepEqual([plain.hidden, plain.truncated, plain.view.hidden], [undefined, undefined, undefined]);
});

test("view.locate, sheets: the cells listed stop at the most text a picture gives", () => {
  const book = viewBook([{ name: "S", used: "A1:Z40", value: (a) => `${a} `.padEnd(30, "x") }]);
  const out = command("view.locate", book.Api, { kind: "cell" }).result;
  assert.equal(out.range, "A1:Z40");
  assert.equal(out.truncated, true);
  const size = out.cells.reduce((n: number, c: { a: string; v: string }) => n + c.a.length + c.v.length, 0);
  assert.ok(size <= MAX_SHOWN_TEXT + 40 && out.cells.length < 26 * 40, `${out.cells.length} cells, ${size} characters`);
});

test("view.locate, sheets: frozen panes take their part of the view from a range beyond them; a range across them is looked at from the first cell after them", () => {
  // Rows 1-10 frozen (190 px): 41 rows beyond them no longer fit at 100 %.
  const book = viewBook([{ name: "S", used: "A1:Z300", frozen: "A1:XFD10" }]);
  assert.equal(command("view.locate", book.Api, { kind: "cell", range: { col: 0, row: 20, cols: 5, rows: 41 } }).result.zoom, 0.75);
  assert.equal(command("view.locate", book.Api, { kind: "cell", range: { col: 0, row: 20, cols: 5, rows: 30 } }).result.zoom, 1);
  const beyond = command("view.locate", book.Api, { kind: "cell", range: { col: 0, row: 20, cols: 5, rows: 30 } }).result.view;
  assert.equal(beyond.frozen, undefined);
  const across = command("view.locate", book.Api, { kind: "cell", range: { col: 0, row: 5, cols: 5, rows: 10 } }).result.view;
  assert.deepEqual(across.frozen, [0, 10]);
  const cols = viewBook([{ name: "S", used: "A1:Z300", frozen: "A1:B1048576" }]);
  assert.deepEqual(command("view.locate", cols.Api, { kind: "cell", range: { col: 1, row: 0, cols: 5, rows: 5 } }).result.view.frozen, [2, 0]);
  // A freeze of columns alone, as the editor gives its place: "A:B", no row numbers.
  const bare = viewBook([{ name: "S", used: "A1:Z300", frozen: "A:B" }]);
  assert.deepEqual(command("view.locate", bare.Api, { kind: "cell", range: { col: 1, row: 0, cols: 5, rows: 5 } }).result.view.frozen, [2, 0]);
  // And the first row alone: "1:1", no column letters.
  const row = viewBook([{ name: "S", used: "A1:Z300", frozen: "1:1" }]);
  assert.deepEqual(command("view.locate", row.Api, { kind: "cell", range: { col: 0, row: 0, cols: 5, rows: 5 } }).result.view.frozen, [0, 1]);
});

test("the plugin locates a Word page once the page count held still; a spreadsheet's at once", async () => {
  const counts = [1, 1, 5, 5];
  const seen: string[] = [];
  const editor = {
    run: (source: string) => {
      if (source === COMMANDS["word.pages"].source) {
        seen.push("pages");
        return { result: counts.length > 1 ? counts.shift() : counts[0] };
      }
      seen.push("locate");
      return { result: { located: true } };
    },
  };
  const began = Date.now();
  const out = await plugin(editor as unknown as ReturnType<typeof workbook>, { kind: "view.locate", args: { kind: "word", page: 1 } });
  assert.deepEqual(out, { result: { located: true }, jobId: "j1" });
  assert.ok(Date.now() - began >= VIEW_SETTLE.ms, "the count held still for the settle time");
  assert.equal(seen.at(-1), "locate");
  assert.ok(seen.filter((s) => s === "pages").length >= 4);
  seen.length = 0;
  await plugin(editor as unknown as ReturnType<typeof workbook>, { kind: "view.locate", args: { kind: "cell" } });
  assert.deepEqual(seen, ["locate"]);
});

/**
 * A Word document for the formatting commands, scripted: its body's paragraphs (a style, a list of a kind, a link, a
 * table around it), what the editor's search finds of a quote (in the body, and where `elsewhere` says, in a header or
 * a table of contents' entry), its styles and sections; every call a command makes of something it does not answer
 * itself is written down (`calls`, as "what.Method(args)"), so a test reads what the command did.
 */
function scriptedWord(spec: {
  /** A paragraph's link covers `linkText` (all of the paragraph's text where none is given); in a table, its cell is in
   * row `row` (from 0), with the cell's `tcPr` as the table's JSON has it; `section` is its section (from 0). */
  paras: { text: string; renamed?: string; style?: string; list?: { kind: "bullet" | "number"; level?: number; num?: string }; link?: string; linkText?: string; table?: string; row?: number; tcPr?: Record<string, unknown>; section?: number; field?: boolean }[];
  elsewhere?: Record<string, ("header" | "toc")[]>;
  styles?: Record<string, "paragraph" | "run" | "table">;
  /** The style each style is based on, by name (in its JSON, by id). */
  basedOn?: Record<string, string>;
  header?: "text" | "picture";
  /** The sections (one where none is given, with `header`): whether each has a header of its own, and is landscape. */
  sections?: { header?: "text" | "picture"; landscape?: boolean }[];
  throwOn?: string;
  /** Quotes the search does not find though the text has them (a footnote's mark parts them). */
  parted?: string[];
  /** Quotes whose text is highlighted (ApiTextPr.GetHighlight is "none" for the others). */
  highlighted?: string[];
  /** Comments on the text `on` (of the paragraph `at`, from 0); the full TOC update takes away those on an entry, as
   * the editor does, and their quote is then a piece shifted by one, as the editor gives it. */
  comments?: { at: number; on: string; text: string }[];
  /** The entries are no TOC's (one made into text): UpdateAllTOC leaves them as they are. */
  flatToc?: boolean;
  /** The entries are links (\\h, as the editor and Word make them): a link of runs, the heading's text, the tab and the
   * page number; a search hit there takes a comment one character in, the text's run on the text. */
  tocLinks?: boolean;
  /** Every op sets what is set already: the JSON of paragraphs, tables, styles and sections stays as it was. */
  same?: boolean;
}) {
  const calls: string[] = [];
  // In the JSON of what an op may change: how many calls were made by then (none counted with \`same\`).
  const v = () => (spec.same ? 0 : calls.length);
  // UpdateAllTOC(false) makes the entries anew: new paragraphs, so new internal ids.
  let tocMade = 0;
  const comments = (spec.comments ?? []).map((c, k) => ({ ...c, gone: false, api: { ...apiComment(0x100 + k, { author: "Portal", userId: "portal-user", time: 1793108364144 + k, text: c.text, replies: [{ author: "Ann", userId: "u-ann", time: 1793108365000, text: "Agreed" }] }), GetQuoteText: () => (comments[k].gone ? c.on.slice(1) : c.on) } }));
  const madeComments: { on: string; api: ReturnType<typeof apiComment> }[] = [];
  const show = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? `[${v.map(show).join(", ")}]` : typeof v === "object" && v && (v as { __label?: string }).__label ? String((v as { __label: string }).__label) : JSON.stringify(v));
  /** An object answering `own`, writing every other call down under `label`. */
  const rec = (label: string, own: Record<string, unknown> = {}): any =>
    new Proxy(own, {
      get(target, key) {
        if (key === "__label") return label;
        if (key in target) return target[key as string];
        if (typeof key !== "string" || key === "then" || key === "toJSON") return undefined;
        return (...args: unknown[]) => {
          const call = `${label}.${key}(${args.map(show).join(", ")})`;
          calls.push(call);
          if (spec.throwOn && call.startsWith(spec.throwOn)) throw new Error(`scripted failure at ${call}`);
          return true;
        };
      },
    });
  const styles: Record<string, any> = {};
  const style = (name: string, type: string) => (styles[name] = rec(`style(${name})`, { GetName: () => name, GetType: () => type, GetTextPr: () => rec(`style(${name}).text`), GetParaPr: () => rec(`style(${name}).para`, { GetOutlineLvl: () => (/^Heading \d$/.test(name) ? Number(name.slice(-1)) - 1 : undefined) }), ToJSON: () => JSON.stringify({ styleId: name, ...(spec.basedOn?.[name] ? { basedOn: spec.basedOn[name] } : {}), v: v() }) }));
  for (const [name, type] of Object.entries({ Normal: "paragraph", "Heading 1": "paragraph", "toc 1": "paragraph", Hyperlink: "run", "Table Grid": "table", ...spec.styles })) style(name, type);
  const numberings: Record<string, any> = {};
  const numbering = (id: string, kind: string) =>
    (numberings[id] ??= rec(`numbering(${id})`, {
      GetLevel: (k: number) => rec(`numbering(${id}).level(${k})`, { GetLevelIndex: () => k, GetNumbering: () => numberings[id] }),
      ToJSON: () => JSON.stringify({ abstractNum: { [id]: { lvl: Array.from({ length: 9 }, () => ({ numFmt: { val: kind === "bullet" ? "bullet" : "decimal" } })) } } }),
    }));
  let made = 0;
  const tables: Record<string, any> = {};
  const body: any[] = [];
  // A paragraph's text now: an entry's `renamed` once the update made the entries anew.
  const now = (i: number) => (tocMade && spec.paras[i].renamed !== undefined ? spec.paras[i].renamed! : spec.paras[i].text);
  const paras = spec.paras.map((p, i) => {
    const label = `para(${p.text})`;
    const list = p.list ? numbering(p.list.num ?? p.list.kind, p.list.kind) : null;
    const link = p.link ? rec(`link(${p.link})`, { GetClassType: () => "hyperlink", GetRange: () => ({ __label: `link range`, GetText: () => p.linkText ?? p.text }), GetElementsCount: () => 1, GetElement: () => rec(`run(${p.link})`, { GetClassType: () => "run", GetTextPr: () => ({ GetStyle: () => styles.Hyperlink }) }) }) : null;
    const entryRuns = () => ["", ...now(i).split("\t").flatMap((t, k) => (k ? ["\t", t] : [t]))].map((t) => rec(`run(${t})`, { GetClassType: () => "run", GetText: () => t, GetRange: () => rec(`run(${t})'s range`, { GetText: () => t, AddComment: addComment(`its run ${t} in ${now(i)}`) }) }));
    const entry = spec.tocLinks && p.style === "toc 1" ? rec(`entry link(${p.text})`, { GetClassType: () => "hyperlink", GetElementsCount: () => entryRuns().length, GetElement: (k: number) => entryRuns()[k] }) : null;
    const elements = link ? [rec(`run(before ${p.text})`, { GetClassType: () => "run", GetRange: () => ({}), GetTextPr: () => ({ GetStyle: () => null }) }), link] : entry ? [entry] : [];
    const para = rec(label, {
      GetClassType: () => "paragraph",
      GetText: (o?: { Numbering?: boolean }) => `${p.list && o?.Numbering !== false ? "·\t" : ""}${now(i)}\r\n`,
      GetRange: () => rec(`${label}'s range`, { AddComment: addComment(`all of ${now(i)}`) }),
      GetStyle: () => (p.style ? styles[p.style] : null),
      GetParaPr: () => ({ GetStyle: () => (p.style ? styles[p.style] : null) }),
      // A TOC's paragraphs (its entries, or the field's paragraph of one without: \`field\`) are made anew by the update.
      GetInternalId: () => ((p.style === "toc 1" || p.field) && tocMade ? `id${i}.${tocMade}` : `id${i}`),
      GetNumbering: () => (list ? list.GetLevel(p.list!.level ?? 0) : null),
      GetPrevious: () => (i > 0 && !spec.paras[i - 1].table ? paras[i - 1] : null),
      GetNext: () => null,
      GetParentTable: () => (p.table ? tables[p.table] : null),
      GetSection: () => sections[p.section ?? 0],
      GetParent: () => doc,
      GetPosInParent: () => i,
      GetElementsCount: () => elements.length,
      GetElement: (k: number) => elements[k],
      GetAllDrawingObjects: () => [],
      // With \`same\`, a quote's paragraph as the editor gives it once a range of it was set: its run parted in two of
      // the same look.
      ToJSON: () => JSON.stringify({ v: v(), content: spec.same && calls.some((c) => c.startsWith("range(")) ? [{ type: "run", rPr: { b: true }, content: [p.text.slice(0, 4)] }, { type: "run", rPr: { b: true }, content: [p.text.slice(4)] }] : [{ type: "run", rPr: { b: true }, content: [p.text] }] }),
    });
    return para;
  });
  // The body: paragraphs, those of a table inside it as its cells (one row).
  spec.paras.forEach((p, i) => {
    if (!p.table) return void body.push(paras[i]);
    if (tables[p.table]) return;
    const mine = spec.paras.map((q, k) => (q.table === p.table ? k : -1)).filter((k) => k >= 0);
    const count = Math.max(...mine.map((k) => spec.paras[k].row ?? 0)) + 1;
    const rows = Array.from({ length: count }, (_, r) => mine.filter((k) => (spec.paras[k].row ?? 0) === r));
    const recs = rows.map((ks, r) => {
      const cells = ks.map((k) => rec(`cell(${spec.paras[k].text})`, { GetContent: () => contentOf([paras[k]]) }));
      return rec(count === 1 ? `row(${p.table})` : `row(${p.table}:${r + 1})`, { GetCellsCount: () => cells.length, GetCell: (c: number) => cells[c] });
    });
    const json = () => JSON.stringify({ v: v(), content: rows.map((ks) => ({ content: ks.map((k) => ({ tcPr: spec.paras[k].tcPr ?? {} })) })) });
    tables[p.table] = rec(`table(${p.table})`, { GetClassType: () => "table", GetRowsCount: () => count, GetRow: (r: number) => recs[r], GetColumnsCount: () => rows[0].length, ToJSON: json });
    body.push(tables[p.table]);
  });
  const own = (where: string, kind?: "text" | "picture") => rec(`${where} content`, { GetElementsCount: () => 1, GetElement: () => rec(`${where} paragraph`, { GetClassType: () => "paragraph", ToJSON: () => JSON.stringify({ content: [{ type: "run", content: kind === "picture" ? [{ docPr: {} }] : ["Old header"] }] }) }) });
  const sections = (spec.sections ?? [{ header: spec.header }]).map((x, k) => {
    const label = k === 0 ? "" : `section${k + 1} `;
    return rec(k === 0 ? "section" : `section${k + 1}`, { GetHeader: (_k: string, make: boolean) => (x.header || make ? own(`${label}header`, x.header) : null), GetFooter: (_k: string, make: boolean) => (make ? own(`${label}footer`) : null), GetPageWidth: () => (x.landscape ? 16838 : 11906), GetPageHeight: () => (x.landscape ? 11906 : 16838), GetPageMarginTop: () => 1134, GetPageMarginRight: () => 1134, GetPageMarginBottom: () => 1134, GetPageMarginLeft: () => 1134, ToJSON: () => JSON.stringify({ v: v() }) });
  });
  const addComment = (on: string) => (text: string, author: string, userId: string) => {
    calls.push(`AddComment on ${JSON.stringify(on)}: ${JSON.stringify(text)}`);
    const api = apiComment(0x7000 + madeComments.length, { author, userId, time: 0, text });
    Object.assign(api, { SetTimeUTC: (t: number) => calls.push(`made comment.SetTimeUTC(${t})`), SetSolved: (b: boolean) => calls.push(`made comment.SetSolved(${b})`) });
    madeComments.push({ on, api });
    return api;
  };
  const hit = (q: string, at: number, extra: Record<string, unknown> = {}) => rec(`range(${q}${at ? `@${at}` : ""})`, { AddComment: addComment(`${q} in ${now(at)}`), GetText: () => q, GetTextPr: () => ({ GetHighlight: () => (spec.highlighted?.includes(q) ? "yellow" : "none") }), GetAllParagraphs: () => [extra.para ?? paras[at]], GetStartPos: () => at * 1000, GetEndPos: () => at * 1000 + q.length, IntersectWith: () => ({ GetText: () => q }), ExpandTo: (r: any) => rec(`range(${q}..${r.GetText()})`, { GetAllParagraphs: () => [paras[at], ...r.GetAllParagraphs()], GetText: () => q, IntersectWith: () => ({ GetText: () => q }) }), ...extra });
  const doc = rec("doc", {
    ...contentOf(body),
    GetStyle: (name: string) => styles[name] ?? null,
    GetAllStyles: () => Object.values(styles),
    CreateStyle: (name: string, type: string) => (calls.push(`doc.CreateStyle(${JSON.stringify(name)}, ${JSON.stringify(type)})`), style(name, type)),
    CreateNumbering: (kind: string) => (calls.push(`doc.CreateNumbering(${JSON.stringify(kind)})`), numbering(`new${++made}`, kind)),
    Search: (q: string) => {
      const found = spec.parted?.includes(q) ? [] : spec.paras.flatMap((_p, i) => (now(i).includes(q) ? [hit(q, i)] : []));
      for (const where of spec.elsewhere?.[q] ?? []) {
        const stray = where === "toc" ? rec("toc entry", { GetInternalId: () => "toc", GetStyle: () => styles["toc 1"] }) : rec("header paragraph", { GetInternalId: () => "header" });
        found.unshift(hit(q, 0, { para: stray }));
      }
      return found;
    },
    GetSections: () => sections,
    GetFinalSection: () => sections[sections.length - 1],
    GetRange: (a: number, b: number) => rec(`doc.range(${a}, ${b})`),
    AddFootnote: () => (calls.push("doc.AddFootnote()"), rec("footnote", { GetElement: () => rec("footnote paragraph") })),
    GetAllComments: () => [...comments.filter((c) => !c.gone).map((c) => c.api), ...madeComments.map((m) => m.api)],
    UpdateAllTOC: (pages: boolean) => {
      calls.push(`doc.UpdateAllTOC(${pages})`);
      if (pages || spec.flatToc || !spec.paras.some((p) => p.style === "toc 1" || p.field)) return;
      tocMade++;
      for (const c of comments) if (spec.paras[c.at].style === "toc 1") c.gone = true;
    },
    CreateSection: (p: { __label: string }) => (calls.push(`doc.CreateSection(${p.__label})`), rec("new section")),
  });
  const Api = rec("Api", { GetDocument: () => doc, CreateTextPr: () => rec("textPr"), CreateParagraph: () => rec("new paragraph", { GetRange: () => rec("new paragraph's range"), GetSection: () => sections[0] }) });
  return { Api, calls, madeComments, run: (ops: unknown[]) => command("word.format", Api, { ops }), edit: (ops: unknown[]) => command("word.edit", Api, { ops }) };
}

test("word.format: text and paragraph keys go to the quote's range and its paragraphs; a character style through a text property, never ApiRange.SetStyle; a paragraph style on the paragraphs", () => {
  const w = scriptedWord({ paras: [{ text: "Quarterly report for Meridian" }, { text: "Revenue grew" }], styles: { Callout: "paragraph", Mark: "run" } });
  const out = w.run([
    { format: "Quarterly", text: { font: "Arial", size: 28, bold: true, italic: false, underline: true, strike: true, vertAlign: "superscript", color: { r: 200, g: 30, b: 30 }, highlight: "yellow", style: "Mark" }, para: { align: "justify", spaceBefore: 240, spaceAfter: 120, lineSpacing: { line: 360, rule: "auto" }, indentLeft: 720, indentRight: 0, firstLine: -283, pageBreakBefore: false, keepWithNext: true } },
    { format: "Revenue", text: { style: "Callout", color: "auto" } },
  ]);
  assert.deepEqual(out, { result: { ops: 2 } });
  assert.deepEqual(w.calls.filter((c) => !c.startsWith("Api.Save")), [
    "para(Quarterly report for Meridian).SetJc(\"both\")",
    "para(Quarterly report for Meridian).SetSpacingBefore(240)",
    "para(Quarterly report for Meridian).SetSpacingAfter(120)",
    "para(Quarterly report for Meridian).SetSpacingLine(360, \"auto\")",
    "para(Quarterly report for Meridian).SetIndLeft(720)",
    "para(Quarterly report for Meridian).SetIndRight(0)",
    "para(Quarterly report for Meridian).SetIndFirstLine(-283)",
    "para(Quarterly report for Meridian).SetPageBreakBefore(false)",
    "para(Quarterly report for Meridian).SetKeepNext(true)",
    "range(Quarterly).SetFontFamily(\"Arial\")",
    "range(Quarterly).SetFontSize(28)",
    "range(Quarterly).SetBold(true)",
    "range(Quarterly).SetItalic(false)",
    "range(Quarterly).SetUnderline(true)",
    "range(Quarterly).SetStrikeout(true)",
    "range(Quarterly).SetVertAlign(\"superscript\")",
    "range(Quarterly).SetColor(200, 30, 30)",
    "range(Quarterly).SetHighlight(\"yellow\")",
    "textPr.SetStyle(style(Mark))",
    "range(Quarterly).SetTextPr(textPr)",
    "para(Revenue grew).SetStyle(style(Callout))",
    "range(Revenue@1).SetColor(null)",
  ]);
  assert.ok(!w.calls.some((c) => /^range\(.*\)\.SetStyle\(/.test(c)), "ApiRange.SetStyle would set the paragraph's style");
});

test("word.format: a quote counts only in the body's text, not in a header or a table of contents' entry; one found twice needs nth, which picks in reading order", () => {
  const w = scriptedWord({ paras: [{ text: "Findings" }, { text: "Meridian Labs one" }, { text: "Meridian Labs two" }], elsewhere: { Findings: ["toc", "header"], "Meridian Labs": ["header"] } });
  assert.deepEqual(w.run([{ format: "Findings", text: { bold: true } }]), { result: { ops: 1 } });
  assert.ok(w.calls.includes("range(Findings).SetBold(true)"), w.calls.join("\n"));
  const two = w.run([{ format: "Meridian Labs", text: { bold: true } }]);
  assert.equal(two.error.code, "quote_ambiguous");
  assert.match(two.error.message, /is in the document 2 times as the editor searches it: quote more of it, or give nth/);
  assert.equal(two.touched, false);
  w.calls.length = 0;
  assert.deepEqual(w.run([{ format: "Meridian Labs", nth: 2, text: { italic: true } }]), { result: { ops: 1 } });
  assert.deepEqual(w.calls.filter((c) => c.includes("SetItalic")), ["range(Meridian Labs@2).SetItalic(true)"]);
  assert.match(w.run([{ format: "Meridian Labs", nth: 3, text: { italic: true } }]).error.message, /is in the document 2 times, not 3/);
  assert.equal(w.run([{ format: "nowhere", text: { italic: true } }]).error.code, "quote_not_found");
});

test("word.format: everything is checked before anything is changed, and a failure after that answers touched (the plugin's Undo takes the command back)", () => {
  const w = scriptedWord({ paras: [{ text: "Alpha" }, { text: "Beta" }] });
  const early = w.run([{ format: "Alpha", text: { bold: true } }, { format: "Beta", text: { style: "Nope" } }]);
  assert.deepEqual([early.error.code, early.error.op, early.touched], ["bad_op", 1, false]);
  assert.match(early.error.message, /op 2: the document has no style "Nope"/);
  assert.equal(w.calls.length, 0, "nothing was made");
  const late = scriptedWord({ paras: [{ text: "Alpha" }, { text: "Beta" }], throwOn: "range(Beta@1).SetBold" });
  const out = late.run([{ format: "Alpha", text: { italic: true } }, { format: "Beta", text: { bold: true } }]);
  assert.deepEqual([out.error.code, out.touched], ["failed", true]);
  assert.ok(!late.calls.includes("Api.Save()"));
});

test("word.format: defineStyle makes a new style; an existing name is refused without change, with how many paragraphs use it, and changed with it", () => {
  const w = scriptedWord({ paras: [{ text: "One", style: "Callout" }, { text: "Two", style: "Callout" }, { text: "Three" }], styles: { Callout: "paragraph" } });
  const no = w.run([{ defineStyle: "callout", type: "paragraph", text: { italic: true } }]);
  assert.equal(no.error.code, "style_exists");
  assert.match(no.error.message, /a style "Callout" already \(2 paragraphs use it\): give change: true/);
  assert.equal(w.calls.length, 0);
  assert.match(scriptedWord({ paras: [{ text: "One", style: "Callout" }], styles: { Callout: "paragraph" } }).run([{ defineStyle: "Callout", type: "paragraph", text: { italic: true } }]).error.message, /a style "Callout" already \(1 paragraph uses it\)/);
  const changed = w.run([{ defineStyle: "Callout", type: "paragraph", change: true, text: { italic: true }, para: { indentLeft: 720 } }]);
  assert.deepEqual(changed.result, { ops: 1, styles: [{ style: "Callout", changed: true, paragraphs: 2 }], reflowed: true });
  assert.ok(w.calls.includes("style(Callout).text.SetItalic(true)") && w.calls.includes("style(Callout).para.SetIndLeft(720)"), w.calls.join("\n"));
  assert.ok(!w.calls.some((c) => c.startsWith("doc.CreateStyle")));
  w.calls.length = 0;
  const made = w.run([{ defineStyle: "Note", type: "character", basedOn: "Hyperlink", text: { bold: true } }, { format: "Three", text: { style: "Note" } }]);
  assert.deepEqual(made.result, { ops: 2, styles: [{ style: "Note", made: true }] });
  assert.deepEqual(w.calls.slice(0, 3), ['doc.CreateStyle("Note", "run")', "style(Note).SetBasedOn(style(Hyperlink))", "style(Note).text.SetBold(true)"]);
  assert.ok(w.calls.includes("textPr.SetStyle(style(Note))"), "a later op of the call uses the style it made");
  // A style's type is kept: a paragraph style is no character style.
  assert.match(w.run([{ defineStyle: "Callout", type: "character", change: true, text: { bold: true } }]).error.message, /is a paragraph style already/);
});

test("word.format: a link is taken off by moving its runs out of it, which lose the Hyperlink style; a new one goes on the range", () => {
  const w = scriptedWord({ paras: [{ text: "Visit Example now", link: "https://example.com/", linkText: "Example" }] });
  assert.deepEqual(w.run([{ format: "Example", text: { link: "" } }]), { result: { ops: 1 } });
  assert.deepEqual(w.calls.filter((c) => !c.startsWith("Api.Save")), ["para(Visit Example now).RemoveElement(1)", "para(Visit Example now).AddElement(run(https://example.com/), 1)", "run(https://example.com/).SetStyle(null)"]);
  w.calls.length = 0;
  w.run([{ format: "Example", text: { link: "https://example.org/b" } }]);
  assert.equal(w.calls.at(-2), 'range(Example).AddHyperlink("https://example.org/b", "")');
});

test("word.format: clear takes the text's own formatting off with null setters, and a run's character style at the run", () => {
  const w = scriptedWord({ paras: [{ text: "Alpha" }, { text: "Beta" }], highlighted: ["Alpha"] });
  w.run([{ format: "Alpha", text: { clear: true, bold: true } }]);
  const said = w.calls.filter((c) => c.startsWith("range(Alpha)"));
  assert.deepEqual(said.slice(0, 3), ["range(Alpha).SetBold(null)", "range(Alpha).SetItalic(null)", "range(Alpha).SetUnderline(null)"]);
  assert.ok(said.includes('range(Alpha).SetHighlight("none")'));
  assert.equal(said.at(-1), "range(Alpha).SetBold(true)", "what the op sets comes after the clearing");
  // A text without a highlight is given no "none" (a highlight of its own, which office_read would show).
  const from = w.calls.length;
  w.run([{ format: "Beta", text: { clear: true } }]);
  assert.ok(w.calls.slice(from).includes("range(Beta@1).SetBold(null)"), w.calls.slice(from).join("\n"));
  assert.ok(!w.calls.slice(from).some((c) => c.includes("SetHighlight")), w.calls.slice(from).join("\n"));
});

test("word.format: a list goes on the list of the same kind right before it, else a new one starts; listStart always starts one there; none takes it off", () => {
  const w = scriptedWord({ paras: [{ text: "one", list: { kind: "bullet", num: "b1" } }, { text: "two" }, { text: "three" }] });
  w.run([{ format: "two", through: "three", para: { list: "bullet" } }]);
  assert.deepEqual(w.calls.filter((c) => c.includes("SetNumbering")), ["para(two).SetNumbering(numbering(b1).level(0))", "para(three).SetNumbering(numbering(b1).level(0))"]);
  w.calls.length = 0;
  w.run([{ format: "two", para: { list: "number", level: 1 } }]);
  assert.deepEqual(w.calls.filter((c) => /Numbering/.test(c)), ['doc.CreateNumbering("numbered")', "para(two).SetNumbering(numbering(new1).level(1))"]);
  w.calls.length = 0;
  w.run([{ format: "two", para: { list: "bullet", listStart: 4 } }]);
  assert.deepEqual(w.calls.filter((c) => /Numbering|SetStart/.test(c)), ['doc.CreateNumbering("bullet")', "numbering(new2).level(0).SetStart(4)", "para(two).SetNumbering(numbering(new2).level(0))"]);
  w.calls.length = 0;
  w.run([{ format: "one", para: { list: "none" } }]);
  assert.deepEqual(w.calls.filter((c) => /Numbering/.test(c)), ["para(one).SetNumbering(null)"]);
  // A level without a list is refused for a paragraph in none, after one in none.
  assert.match(w.run([{ format: "three", para: { level: 2 } }]).error.message, /is in no list, nor is the paragraph before it: give list/);
  // After a list, a level alone puts it in that list (a sub-point); so does an earlier op of the same call.
  w.calls.length = 0;
  assert.deepEqual(w.run([{ format: "two", para: { level: 1 } }]), { result: { ops: 1 } });
  assert.deepEqual(w.calls.filter((c) => /Numbering/.test(c)), ["para(two).SetNumbering(numbering(b1).level(1))"]);
  const call = scriptedWord({ paras: [{ text: "alpha" }, { text: "beta" }] });
  assert.deepEqual(call.run([{ format: "alpha", through: "beta", para: { list: "bullet" } }, { format: "beta", para: { level: 1 } }]).error, undefined);
});

test("word.format: a table's style, widths in the builder's EMU, header rows, borders and a cell range's merge; cells past the table refused before anything", () => {
  const w = scriptedWord({ paras: [{ text: "Item", table: "t" }, { text: "Amount", table: "t" }], styles: { "Grid Table 4 - Accent 1": "table", Callout: "paragraph" } });
  const out = w.run([
    { formatTable: "Item", table: { tableStyle: "Grid Table 4 - Accent 1", width: { percent: 100 }, columnWidths: [3969, 1700], headerRows: 1 }, cell: { borders: { top: { type: "single", size: 4, color: { r: 0, g: 0, b: 0 } }, insideV: { type: "none" } }, fill: { r: 255, g: 255, b: 0 } } },
    { formatTable: "Item", cells: { col: 0, row: 0, cols: 2, rows: 1 }, cell: { merge: true, valign: "center", align: "right" } },
  ]);
  assert.deepEqual(out, { result: { ops: 2 } });
  for (const c of [
    "table(t).SetStyle(style(Grid Table 4 - Accent 1))",
    'table(t).SetWidth("percent", 100)',
    "table(t).SetColumnWidth(0, 2520315)",
    "table(t).SetColumnWidth(1, 1079500)",
    "row(t).SetTableHeader(true)",
    'table(t).SetTableBorderTop("single", 4, 0, 0, 0, 0)',
    'table(t).SetTableBorderInsideV("none", 0, 0, 0, 0, 0)',
    'cell(Item).SetShd("clear", 255, 255, 0)',
    'cell(Amount).SetVerticalAlign("center")',
    'para(Amount).SetJc("right")',
    "table(t).MergeCells([cell(Item), cell(Amount)])",
  ]) assert.ok(w.calls.includes(c), `${c}\n${w.calls.join("\n")}`);
  w.calls.length = 0;
  const past = w.run([{ formatTable: "Item", cells: { col: 0, row: 0, cols: 3, rows: 1 }, cell: { fill: "none" } }]);
  assert.match(past.error.message, /row 1 of the table has 2 cells/);
  assert.match(w.run([{ formatTable: "Item", table: { columnWidths: [1, 2, 3] } }]).error.message, /the table has 2 columns, and columnWidths gives 3/);
  assert.match(w.run([{ formatTable: "Item", table: { tableStyle: "Callout" } }]).error.message, /is a paragraph style, not a table style/);
  assert.equal(w.calls.length, 0);
});

test("word.format: a header that holds more than text is replaced only with replace; its text takes the first paragraph's place, the page number and count as fields", () => {
  const pic = scriptedWord({ paras: [{ text: "Body" }], header: "picture" });
  const no = pic.run([{ page: "*", set: { header: [{ text: "New" }] } }]);
  assert.match(no.error.message, /the header holds more than text \(a picture, a table or a field\): give replace: true/);
  assert.equal(pic.calls.length, 0);
  assert.deepEqual(pic.run([{ page: "*", set: { header: [{ text: "Page " }, { field: "page" }, { text: " of " }, { field: "pages" }], replace: true } }]).result, { ops: 1, reflowed: true });
  assert.deepEqual(pic.calls.filter((c) => c.startsWith("header")), ["header paragraph.RemoveAllElements()", 'header paragraph.AddText("Page ")', "header paragraph.AddPageNumber()", 'header paragraph.AddText(" of ")', "header paragraph.AddPagesCount()"]);
  const plain = scriptedWord({ paras: [{ text: "Body" }], header: "text" });
  plain.run([{ page: "Body", set: { header: [], size: { width: 11906, height: 16838 }, orientation: "landscape", margins: { top: 1, right: 2, bottom: 3, left: 4 }, differentFirstPage: true } }]);
  assert.deepEqual(plain.calls.filter((c) => c.startsWith("section")), ["section.SetPageSize(16838, 11906, false)", "section.SetPageMargins(4, 1, 2, 3)", "section.SetTitlePage(true)", 'section.RemoveHeader("default")']);
});

test("word.format: a table of contents in a portrait section before a landscape one is made while the last section has the TOC's section's width (the editor sets the entries' page-number tab by the last section's), which it gets back after; its page numbers are counted then", () => {
  const w = scriptedWord({ paras: [{ text: "Title" }, { text: "Findings", style: "Heading 1" }, { text: "Wide", section: 1 }], sections: [{}, { landscape: true }] });
  assert.deepEqual(w.run([{ toc: true, levels: 2 }]).result, { ops: 1, reflowed: true });
  const made = w.calls.filter((c) => /^section2\.Set|AddField|UpdateAllTOC|Api\.Save/.test(c));
  assert.deepEqual(made, [
    "section2.SetPageSize(11906, 11906, true)",
    "section2.SetPageMargins(1134, 1134, 1134, 1134)",
    'new paragraph\'s range.AddField("TOC \\\\o \\"1-2\\" \\\\h \\\\z \\\\u")',
    "section2.SetPageSize(16838, 11906, false)",
    "section2.SetPageMargins(1134, 1134, 1134, 1134)",
    // The page numbers with the last section as it is (AddField gives 0; counted with the other width, the pages came
    // out one too many). The entries are as AddField made them after every other op: not made a second time.
    "doc.UpdateAllTOC(true)",
    "Api.Save()",
  ]);
  // A later op of the call may change the headings: the entries again then (they keep the tab AddField gave them).
  const later = scriptedWord({ paras: [{ text: "Title" }, { text: "Findings", style: "Heading 1" }, { text: "Wide", section: 1 }], sections: [{}, { landscape: true }] });
  later.run([{ toc: true, levels: 2 }, { format: "Findings", text: { bold: true } }]);
  assert.deepEqual(later.calls.filter((c) => /UpdateAllTOC/.test(c)), ["doc.UpdateAllTOC(false)", "doc.UpdateAllTOC(true)"]);
  // Without headings the new TOC lists nothing, and an update would only add an empty paragraph after it.
  const bare = scriptedWord({ paras: [{ text: "Title" }, { text: "Wide", section: 1 }], sections: [{}, { landscape: true }] });
  bare.run([{ toc: true, levels: 2 }]);
  assert.ok(!bare.calls.some((c) => /UpdateAllTOC/.test(c)), bare.calls.join("\n"));
  // One section, or sections alike across: nothing changed for it, and the page numbers are not counted a second time.
  const one = scriptedWord({ paras: [{ text: "Title" }, { text: "Findings", style: "Heading 1" }] });
  one.run([{ toc: true, levels: 2 }]);
  assert.ok(!one.calls.some((c) => /SetPageSize|SetPageMargins/.test(c)), one.calls.join("\n"));
  assert.deepEqual(one.calls.filter((c) => /UpdateAllTOC/.test(c)), ["doc.UpdateAllTOC(true)"]);
  const oneLater = scriptedWord({ paras: [{ text: "Title" }, { text: "Findings", style: "Heading 1" }] });
  oneLater.run([{ toc: true, levels: 2 }, { format: "Findings", text: { bold: true } }]);
  assert.deepEqual(oneLater.calls.filter((c) => /UpdateAllTOC/.test(c)), ["doc.UpdateAllTOC(false)"]);
});

test("a table of contents follows every office_edit and office_format call that changed its document: its entries again, in the same command before the save; one with entries keeps their tab, so the last section keeps its width and the page numbers are not counted twice", () => {
  const doc = () => scriptedWord({ paras: [{ text: "Findings\t1", style: "toc 1" }, { text: "Findings", style: "Heading 1" }, { text: "Body text" }, { text: "Wide", section: 1 }], sections: [{}, { landscape: true }] });
  const toc = (calls: string[]) => calls.filter((c) => /^section2\.Set|UpdateAllTOC|Api\.Save/.test(c));
  // Each update lays the whole document out (about 6 s for 600 pages): one, where the entries keep their own tab.
  const after = ["doc.UpdateAllTOC(false)", "Api.Save()"];
  const edit = doc();
  assert.deepEqual(edit.edit([{ after: "Body text", paragraphs: ["Outlook"], style: "Heading 1" }]).result, { ops: 1, toc: true });
  assert.deepEqual(toc(edit.calls), after);
  const format = doc();
  assert.deepEqual(format.run([{ format: "Body text", text: { bold: true } }]).result, { ops: 1, toc: true });
  assert.deepEqual(toc(format.calls), after);
  // A TOC that lists no entries yet, in a portrait section before a landscape one: its new entries take their tab from
  // the last section, so that has the TOC's section's width for the entries; the page numbers are counted again after.
  const empty = scriptedWord({ paras: [{ text: "No table of contents entries found.", field: true }, { text: "Findings", style: "Heading 1" }, { text: "Body text" }, { text: "Wide", section: 1 }], sections: [{}, { landscape: true }] });
  assert.deepEqual(empty.edit([{ quote: "Body", replacement: "Main" }]).result, { ops: 1, toc: true });
  assert.deepEqual(toc(empty.calls), [
    "section2.SetPageSize(11906, 11906, true)",
    "section2.SetPageMargins(1134, 1134, 1134, 1134)",
    "doc.UpdateAllTOC(false)",
    "section2.SetPageSize(16838, 11906, false)",
    "section2.SetPageMargins(1134, 1134, 1134, 1134)",
    "doc.UpdateAllTOC(true)",
    "Api.Save()",
  ]);
  // No TOC (that text typed by a person is no TOC): nothing is updated, and the answer says nothing of it.
  const none = scriptedWord({ paras: [{ text: "No table of contents entries found." }, { text: "Body text" }] });
  assert.deepEqual(none.edit([{ quote: "Body", replacement: "Main" }]).result, { ops: 1 });
  assert.deepEqual(none.run([{ format: "Body text", text: { bold: true } }]).result, { ops: 1 });
  assert.ok(!none.calls.some((c) => /UpdateAllTOC/.test(c)), none.calls.join("\n"));
  // A call that fails is not followed by an update: the plugin's Undo takes back exactly that call.
  const failed = doc();
  assert.equal(failed.edit([{ quote: "nowhere", replacement: "x" }]).error.code, "quote_not_found");
  const late = scriptedWord({ paras: [{ text: "Findings\t1", style: "toc 1" }, { text: "Body text" }], throwOn: "range(Body text@1).SetItalic" });
  const out = late.run([{ format: "Body text", text: { bold: true } }, { format: "Body text", text: { italic: true } }]);
  assert.equal(out.touched, true);
  assert.ok(![...failed.calls, ...late.calls].some((c) => /UpdateAllTOC|Api\.Save/.test(c)), late.calls.join("\n"));
});

test("a comment a person put on a table of contents' entry goes with the old entries in the update, and is made again on the new entry with its author, time and replies, and named as moved (office_edit and office_format); one on the body stays", () => {
  const doc = () => scriptedWord({
    paras: [{ text: "Overview\t1", style: "toc 1" }, { text: "Risks\t2", style: "toc 1" }, { text: "Overview", style: "Heading 1" }, { text: "Body text" }, { text: "Risks", style: "Heading 1" }],
    comments: [{ at: 0, on: "Overview", text: "@Aegis rename this section to Summary" }, { at: 3, on: "Body text", text: "Too long" }],
    tocLinks: true,
  });
  const edit = doc();
  const out = edit.edit([{ quote: "Body", replacement: "Main" }]);
  assert.deepEqual(out.result, { ops: 1, moved: [["00000100", "00007000"]], toc: true, tocMoved: 1 });
  // On the new entry that holds its text (the quote as it was before the update, not the editor's shifted piece after),
  // on the run of its text in the entry's link: on the search's hit there, the editor took it one character in (e2e 24:
  // "lanning ahead" for "Planning ahead"), and one more each time it was made again so.
  assert.deepEqual(edit.madeComments.map((m) => [m.on, m.api.GetText(), m.api.GetAuthorName(), m.api.GetUserId(), m.api.added]), [["its run Overview in Overview\t1", "@Aegis rename this section to Summary", "Portal", "portal-user", [["Agreed", "Ann", "u-ann"]]]]);
  assert.ok(edit.calls.includes("made comment.SetTimeUTC(1793108364144)"), edit.calls.join("\n"));
  const format = doc();
  assert.deepEqual(format.run([{ format: "Body text", text: { bold: true } }]).result, { ops: 1, toc: true, moved: [["00000100", "00007000"]], tocMoved: 1 });
  // An entry whose text is gone (its heading renamed by the call): the entry at its place takes it; with no entries
  // left, the TOC's own paragraph.
  const renamed = scriptedWord({ paras: [{ text: "Intro\t1", style: "toc 1" }, { text: "Overview\t1", renamed: "Summary\t1", style: "toc 1" }, { text: "Intro", style: "Heading 1" }, { text: "Overview", style: "Heading 1" }], comments: [{ at: 1, on: "Overview", text: "rename" }] });
  assert.equal(renamed.edit([{ quote: "Overview", replacement: "Summary" }]).result.tocMoved, 1);
  assert.deepEqual(renamed.madeComments.map((m) => m.on), ["Summary in Summary\t1"]);
  const renamedLink = scriptedWord({ paras: [{ text: "Intro\t1", style: "toc 1" }, { text: "Overview\t1", renamed: "Summary\t1", style: "toc 1" }, { text: "Intro", style: "Heading 1" }, { text: "Overview", style: "Heading 1" }], comments: [{ at: 1, on: "Overview", text: "rename" }], tocLinks: true });
  renamedLink.edit([{ quote: "Overview", replacement: "Summary" }]);
  assert.deepEqual(renamedLink.madeComments.map((m) => m.on), ["its run Summary in Summary\t1"]);
});

test("an office_format call that changed nothing (each op sets what is set already; the editor parts a run at the quote's ends all the same, into runs of one look) brings no table of contents up to date, and says it changed nothing; one that changed something does", () => {
  const paras = [{ text: "Findings\t1", style: "toc 1" }, { text: "Findings", style: "Heading 1" }, { text: "Body text" }];
  const same = scriptedWord({ paras, same: true });
  assert.deepEqual(same.run([{ format: "Body", text: { bold: true } }, { page: "*", set: { margins: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } }, { defineStyle: "Heading 1", change: true, text: { bold: true } }]).result, { ops: 3, changed: false, styles: [{ style: "Heading 1", changed: true, paragraphs: 1 }] });
  assert.ok(!same.calls.some((c) => /UpdateAllTOC/.test(c)), same.calls.join("\n"));
  assert.ok(same.calls.includes("Api.Save()"));
  // A footnote, a header, a section break or a page break always changes the document.
  for (const op of [{ footnote: "Body", text: "A note." }, { page: "*", set: { header: [{ text: "Top" }] } }, { sectionBreak: "Body text", type: "nextPage" }, { after: "Body text", pageBreak: true }]) {
    const w = scriptedWord({ paras, same: true });
    const out = w.run([op]);
    assert.equal(out.result.changed, undefined, JSON.stringify(op));
    assert.ok(w.calls.includes("doc.UpdateAllTOC(false)"), JSON.stringify(op));
  }
  const changed = scriptedWord({ paras });
  assert.deepEqual(changed.run([{ format: "Body", text: { bold: true } }]).result, { ops: 1, toc: true });
});

test("paragraphs styled as entries of a table of contents that is no field (one made into text) are not said to be updated", () => {
  const flat = scriptedWord({ paras: [{ text: "Findings\t1", style: "toc 1" }, { text: "Body text" }], flatToc: true });
  assert.deepEqual(flat.edit([{ quote: "Body", replacement: "Main" }]).result, { ops: 1 });
  assert.deepEqual(flat.run([{ format: "Body text", text: { bold: true } }]).result, { ops: 1 });
});

test("a table of contents without entries (the editor's text for it, its field in no JSON) is brought up to date where there are headings to list, and left as it is where there are none; the same sentence typed is no TOC", () => {
  const empty = (paras: { text: string; style?: string }[]) => scriptedWord({ paras: [{ text: "Report" }, { text: "No table of contents entries found.", field: true }, ...paras] });
  const headed = empty([{ text: "Body text" }]);
  assert.deepEqual(headed.edit([{ after: "Body text", paragraphs: ["Outlook"], style: "Heading 1" }]).result, { ops: 1 });
  // The fake's body does not grow by the insert: a heading is in it from the start for the update.
  const withHeading = empty([{ text: "Outlook", style: "Heading 1" }, { text: "Body text" }]);
  assert.deepEqual(withHeading.edit([{ quote: "Body", replacement: "Main" }]).result, { ops: 1, toc: true });
  assert.deepEqual(withHeading.calls.filter((c) => /UpdateAllTOC/.test(c)), ["doc.UpdateAllTOC(false)"]);
  // No headings: no update (each would add an empty paragraph after the TOC, or take it away again).
  assert.ok(!headed.calls.some((c) => /UpdateAllTOC/.test(c)), headed.calls.join("\n"));
  const typed = scriptedWord({ paras: [{ text: "No table of contents entries found." }, { text: "Outlook", style: "Heading 1" }] });
  assert.deepEqual(typed.edit([{ quote: "Outlook", replacement: "View" }]).result, { ops: 1 });
});

test("with two tables of contents, the last section takes the width of the one without entries for the update (the one with entries keeps its tab)", () => {
  // A TOC with entries in a landscape section, an empty one in a portrait section, and a landscape last section.
  const two = scriptedWord({
    paras: [{ text: "Findings\t1", style: "toc 1", section: 0 }, { text: "No table of contents entries found.", field: true, section: 1 }, { text: "Findings", style: "Heading 1", section: 2 }],
    sections: [{ landscape: true }, {}, { landscape: true }],
  });
  assert.deepEqual(two.edit([{ quote: "Findings", nth: 1, replacement: "Results" }]).result, { ops: 1, toc: true });
  assert.deepEqual(two.calls.filter((c) => /^section3\.Set|UpdateAllTOC/.test(c)), [
    "section3.SetPageSize(11906, 11906, true)",
    "section3.SetPageMargins(1134, 1134, 1134, 1134)",
    "doc.UpdateAllTOC(false)",
    "section3.SetPageSize(16838, 11906, false)",
    "section3.SetPageMargins(1134, 1134, 1134, 1134)",
    "doc.UpdateAllTOC(true)",
  ]);
});

test("word.format: a page break and a table of contents go after their paragraph (a TOC at the start where none is given, as a TOC field); a footnote at the quote's end", () => {
  const w = scriptedWord({ paras: [{ text: "Title" }, { text: "There was a discrepancy." }, { text: "Findings", style: "Heading 1" }] });
  const out = w.run([{ after: "Title", pageBreak: true }, { toc: true, levels: 2 }, { footnote: "discrepancy", text: "The audit." }, { sectionBreak: "Title", type: "continuous" }]);
  assert.deepEqual(out.error, undefined, JSON.stringify(out));
  assert.deepEqual(out.result, { ops: 4, reflowed: true });
  for (const c of ["new paragraph.AddPageBreak()", "doc.AddElement(1, new paragraph)", "doc.AddElement(0, new paragraph)", 'new paragraph\'s range.AddField("TOC \\\\o \\"1-2\\" \\\\h \\\\z \\\\u")', "doc.UpdateAllTOC(false)", "doc.range(1011, 1011).Select()", "doc.AddFootnote()", 'footnote paragraph.AddText("The audit.")', "doc.CreateSection(para(Title))", 'section.SetType("continuous")']) assert.ok(w.calls.includes(c), `${c}\n${w.calls.join("\n")}`);
  // The type is how the section after the break starts: set on the one the paragraph was in, which goes on after it,
  // not on the copy CreateSection answers, which ends at the paragraph.
  assert.ok(!w.calls.some((c) => c.startsWith("new section.SetType")), w.calls.join("\n"));
  const inTable = scriptedWord({ paras: [{ text: "Cell", table: "t" }] });
  assert.match(inTable.run([{ after: "Cell", pageBreak: true }]).error.message, /a page break goes after a paragraph outside tables/);
});

test("word.edit: a quote is found in the body only, a list item's label is no part of its text, and nth picks among repeats; an insert takes any paragraph style of the document", () => {
  const w = scriptedWord({ paras: [{ text: "Findings" }, { text: "Total" }, { text: "Total" }, { text: "point", list: { kind: "bullet" } }], elsewhere: { Findings: ["toc", "header"] }, styles: { Callout: "paragraph", Mark: "run" } });
  const edit = (ops: unknown[]) => command("word.edit", w.Api, { ops });
  assert.equal(edit([{ quote: "Total", replacement: "Sum" }]).error.code, "quote_ambiguous");
  assert.equal(edit([{ quote: "·\tpoint", replacement: "x" }]).error.code, "quote_not_found", "the label is not text");
  assert.equal(edit([{ paragraphs: ["x"], style: "Mark" }]).error.message, 'op 1: "Mark" is a run style, and new paragraphs take a paragraph style');
  assert.match(edit([{ paragraphs: ["x"], style: "Heading 7" }]).error.message, /no style "Heading 7" \(office_read with formatting lists the styles in use; office_format makes a new one with defineStyle, and a list with set.list\)$/);
  w.calls.length = 0;
  edit([{ remove: "Total", nth: 2 }, { after: "Findings", paragraphs: ["New"], style: "callout" }]);
  assert.ok(w.calls.includes("para(Total).Delete()"), w.calls.join("\n"));
  assert.ok(w.calls.includes("new paragraph.SetStyle(style(Callout))"), w.calls.join("\n"));
});

test("the plugin takes back a word.format that failed after it changed something with the editor's Undo, and one that failed in its check without it", async () => {
  const methods: string[] = [];
  const late = await bridge({ kind: "word.format", args: { ops: [] } }, () => ({ error: { code: "failed", op: 1, message: "op 2: the editor did not merge the cells" }, touched: true }), (name) => (methods.push(name), true));
  assert.deepEqual([late.error.code, late.undone, methods], ["failed", true, ["Undo"]]);
  const early = await bridge({ kind: "word.format", args: { ops: [] } }, () => ({ error: { code: "bad_op", op: 0, message: "op 1: no style" }, touched: false }), (name) => (methods.push(name), true));
  assert.deepEqual([early.error.code, early.undone, methods], ["bad_op", undefined, ["Undo"]]);
});

test("word.format: a quote in the text that the editor's search does not find (a footnote's mark parts it) is refused with what to quote instead", () => {
  const w = scriptedWord({ paras: [{ text: "Figures are unaudited." }], parted: ["Figures are unaudited."] });
  assert.match(w.run([{ format: "Figures are unaudited.", text: { bold: true } }]).error.message, /is not in the document's body as the editor searches it \(it is in the text, parted by a footnote's mark or a field: quote the text before or after that\)$/);
  assert.match(w.run([{ format: "nowhere", text: { bold: true } }]).error.message, /as the editor searches it$/);
});

test("word.format: a merge of cells that are no rectangle of the table's grid is refused in the check (a cell spanning columns, one merged with the cell above or below), before anything is changed", () => {
  const spanned = scriptedWord({ paras: [{ text: "c11", table: "t" }, { text: "c12", table: "t", tcPr: { gridSpan: 2 } }, { text: "c21", table: "t", row: 1 }, { text: "c22", table: "t", row: 1 }, { text: "c23", table: "t", row: 1 }] });
  const no = spanned.run([{ format: "c11", text: { bold: true } }, { formatTable: "c11", cells: { col: 0, row: 0, cols: 2, rows: 2 }, cell: { merge: true } }]);
  assert.deepEqual([no.error.code, no.error.op, no.touched], ["bad_op", 1, false]);
  assert.match(no.error.message, /^op 2: the cells to merge are no rectangle of the table's grid: row 2's cells cover other columns than row 1's/);
  assert.equal(spanned.calls.length, 0, "nothing was made");
  // A1 and B1 (which spans two columns) side by side are one.
  assert.deepEqual(spanned.run([{ formatTable: "c11", cells: { col: 0, row: 0, cols: 2, rows: 1 }, cell: { merge: true } }]).error, undefined);
  assert.ok(spanned.calls.includes("table(t).MergeCells([cell(c11), cell(c12)])"), spanned.calls.join("\n"));
  const down = scriptedWord({ paras: [{ text: "a1", table: "t" }, { text: "b1", table: "t" }, { text: "a2", table: "t", row: 1, tcPr: { vMerge: "continue" } }, { text: "b2", table: "t", row: 1 }] });
  assert.match(down.run([{ formatTable: "a1", cells: { col: 0, row: 1, cols: 2, rows: 1 }, cell: { merge: true } }]).error.message, /a cell of row 2 is merged with the cell above it/);
  assert.match(down.run([{ formatTable: "a1", cells: { col: 0, row: 0, cols: 2, rows: 1 }, cell: { merge: true } }]).error.message, /a cell of row 1 is merged with the cell below it/);
  assert.equal(down.calls.length, 0);
});

test("a word.format or word.edit that fails after its edit began makes one change of its own first (a paragraph added and taken away), so the plugin's Undo takes back this command and never the one before it", () => {
  const w = scriptedWord({ paras: [{ text: "c11", table: "t" }, { text: "c12", table: "t" }], throwOn: "table(t).MergeCells" });
  const out = w.run([{ formatTable: "c11", cells: { col: 0, row: 0, cols: 2, rows: 1 }, cell: { merge: true } }]);
  assert.deepEqual([out.error.code, out.touched], ["failed", true]);
  assert.deepEqual(w.calls.slice(-2), ["doc.Push(new paragraph)", "new paragraph.Delete()"], w.calls.join("\n"));
  // A call that does not fail, and one refused in its check, leave no such change.
  const ok = scriptedWord({ paras: [{ text: "Alpha" }] });
  ok.run([{ format: "Alpha", text: { bold: true } }]);
  ok.run([{ format: "nowhere", text: { bold: true } }]);
  assert.ok(!ok.calls.some((c) => c.startsWith("doc.Push") || c.endsWith(".Delete()")), ok.calls.join("\n"));
  const edit = scriptedWord({ paras: [{ text: "Alpha words" }], throwOn: "doc.range(0, 5).Delete" });
  const failed = command("word.edit", edit.Api, { ops: [{ quote: "Alpha", replacement: "Beta" }] });
  assert.deepEqual([failed.error.code, failed.touched], ["failed", true]);
  assert.deepEqual(edit.calls.slice(-2), ["doc.Push(new paragraph)", "new paragraph.Delete()"], edit.calls.join("\n"));
});

test("word.format: a link is changed or taken off whole: a quote of part of one is refused before anything", () => {
  const w = scriptedWord({ paras: [{ text: "See the Meridian Labs report now", link: "https://example.com/", linkText: "Meridian Labs report" }] });
  for (const link of ["", "https://example.org/new"]) {
    const out = w.run([{ format: "Meridian Labs", text: { link } }]);
    assert.deepEqual([out.error.code, out.touched], ["bad_op", false]);
    assert.match(out.error.message, /^op 1: the quote is part of the link "Meridian Labs report", and a link changes or goes off whole: quote all of its text$/);
  }
  assert.equal(w.calls.length, 0);
  assert.deepEqual(w.run([{ format: "Meridian Labs report", text: { link: "" } }]), { result: { ops: 1 } });
  // Bold on part of it is no change of the link.
  assert.deepEqual(w.run([{ format: "Meridian Labs", text: { bold: true } }]), { result: { ops: 1 } });
});

test("word.format: a style based on itself, or on a style based on it (in this call or in the document), is refused", () => {
  const w = scriptedWord({ paras: [{ text: "One" }], styles: { Callout: "paragraph", Quote2: "paragraph" }, basedOn: { Quote2: "Callout" } });
  assert.match(w.run([{ defineStyle: "Callout", type: "paragraph", change: true, basedOn: "callout", text: { bold: true } }]).error.message, /^op 1: "Callout" cannot be based on "callout", itself: give basedOn another style$/);
  assert.match(w.run([{ defineStyle: "Callout", type: "paragraph", change: true, basedOn: "Quote2", text: { bold: true } }]).error.message, /^op 1: "Callout" cannot be based on "Quote2", which is based on it/);
  const loop = w.run([{ defineStyle: "A", type: "paragraph", basedOn: "Normal", text: { bold: true } }, { defineStyle: "B", type: "paragraph", basedOn: "A", text: { bold: true } }, { defineStyle: "A", type: "paragraph", change: true, basedOn: "B", text: { bold: true } }]);
  assert.deepEqual([loop.error.op, loop.touched], [2, false]);
  assert.match(loop.error.message, /^op 3: "A" cannot be based on "B", which is based on it/);
  assert.equal(w.calls.length, 0);
  assert.deepEqual(w.run([{ defineStyle: "Quote2", type: "paragraph", change: true, basedOn: "Normal", text: { bold: true } }]).error, undefined);
});

test("word.format: a page size alone keeps the section's orientation; a header taken off a section that shows an earlier one's gives it an empty one of its own", () => {
  const land = scriptedWord({ paras: [{ text: "Body" }], sections: [{ landscape: true }] });
  land.run([{ page: "*", set: { size: { width: 12240, height: 15840 } } }]);
  assert.deepEqual(land.calls.filter((c) => c.startsWith("section.SetPageSize")), ["section.SetPageSize(15840, 12240, false)"]);
  const two = scriptedWord({ paras: [{ text: "One" }, { text: "Two", section: 1 }], sections: [{ header: "text" }, {}] });
  assert.deepEqual(two.run([{ page: "Two", set: { header: [] } }]).error, undefined);
  assert.ok(two.calls.includes("section2 header paragraph.RemoveAllElements()"), two.calls.join("\n"));
  assert.ok(!two.calls.some((c) => /RemoveHeader/.test(c)), "nothing to remove: it had none of its own");
  // Where no section has a header, there is nothing to hide.
  const none = scriptedWord({ paras: [{ text: "One" }, { text: "Two", section: 1 }], sections: [{}, {}] });
  none.run([{ page: "Two", set: { header: [] } }]);
  assert.ok(!none.calls.some((c) => /header/.test(c)), none.calls.join("\n"));
});

test("word.read with formatting: what is set off or to zero is direct formatting too; each footnote is read at its own mark, a table cell's among them; a section without a header of its own names the one it shows", () => {
  const run = (rPr: Record<string, unknown>, content: unknown[], extra: Record<string, unknown> = {}) => ({ type: "run", rPr, content, ...extra });
  const note = (id: string, text: string) => ({ id, content: [{ type: "paragraph", content: [run({}, [{ type: "footnoteNum", footnote: id }]), run({}, [" "]), run({}, [text])] }] });
  const ref = (id: string) => ({ type: "footnoteRef", footnote: id });
  const para = (id: string, json: unknown) => ({ GetClassType: () => "paragraph", GetText: () => "", GetParaPr: () => ({ GetStyle: () => null }), GetStyle: () => null, GetInternalId: () => id, GetNumbering: () => null, GetAllDrawingObjects: () => [], ToJSON: () => JSON.stringify(json), GetElementsCount: () => 0, GetElement: () => null });
  const first = para("p1", { pPr: { ind: { left: 0, firstLine: 0 }, keepNext: false, pageBreakBefore: false, spacing: { line: 300, lineRule: "atLeast" } }, content: [run({ b: false, i: false, u: false, strike: false, dstrike: false, color: { auto: true }, highlight: "none" }, ["Off words"])] });
  const tail = para("p3", { content: [run({}, ["Tail para"]), run({}, [ref("9")], { footnotes: [note("9", "Note at the tail.")] })] });
  const cellJson = { content: [{ type: "paragraph", content: [run({}, ["cellnote"]), run({}, [ref("7")], { footnotes: [note("7", "Note in the cell.")] })] }] };
  const table = {
    GetClassType: () => "table",
    GetInternalId: () => "t1",
    GetRowsCount: () => 1,
    GetRow: () => ({ GetCellsCount: () => 2, GetCell: () => ({ GetContent: () => contentOf([]) }) }),
    ToJSON: () => JSON.stringify({ tblPr: {}, content: [{ content: [{ tcPr: {}, content: { content: [] } }, { tcPr: {}, content: cellJson }] }] }),
  };
  const hf = (text: string) => contentOf([{ GetClassType: () => "paragraph", ToJSON: () => JSON.stringify({ content: [run({}, [text])] }) }]);
  const section = (header: string | null) => ({ GetPageWidth: () => 11906, GetPageHeight: () => 16838, GetPageMarginTop: () => 1134, GetPageMarginRight: () => 1134, GetPageMarginBottom: () => 1134, GetPageMarginLeft: () => 1134, GetHeader: () => (header ? hf(header) : null), GetFooter: () => null, ToJSON: () => "{}" });
  const doc = { ...contentOf([first, table, tail]), GetAllStyles: () => [], GetAllImages: () => [], GetStyle: () => null, GetDefaultTextPr: () => ({ ToJSON: () => "{}" }), GetSections: () => [section("Head one"), section(null), section(null)], GetFootnotesFirstParagraphs: () => [] };
  const out = command("word.read", { GetDocument: () => doc }, { formatting: true });
  assert.deepEqual(out.error, undefined, JSON.stringify(out));
  const [p1, t1, p3] = out.result.blocks;
  assert.deepEqual(p1.look, { para: { indentLeft: 0, firstLine: 0, keepWithNext: false, pageBreakBefore: false, line: { atLeast: 300 } }, runs: [{ t: "Off words", look: { bold: false, italic: false, underline: false, strike: false, color: "auto", highlight: "none" } }] });
  assert.deepEqual(t1.look, { notes: [{ at: "cellnote", note: "Note in the cell.", row: 0, cell: 1 }] });
  assert.deepEqual(p3.look, { notes: [{ at: "Tail para", note: "Note at the tail." }] });
  assert.deepEqual(out.result.format.sections.map((x: { header?: unknown; headerAs?: number }) => [Boolean(x.header), x.headerAs]), [[true, undefined], [false, 1], [false, 1]]);
});

test("word.read with formatting: a table's own borders, and each cell's own fill, vertical alignment and borders and its paragraphs' and runs' own formatting, as the table's JSON has them; cells that set nothing are left out", () => {
  const run = (rPr: Record<string, unknown>, text: string) => ({ type: "run", rPr, content: [text] });
  const cellPara = (id: string, json: Record<string, unknown>) => ({ GetClassType: () => "paragraph", GetText: () => "", GetParaPr: () => ({ GetStyle: () => null }), GetStyle: () => null, GetInternalId: () => id, GetNumbering: () => null, GetAllDrawingObjects: () => [], ToJSON: () => JSON.stringify(json), GetElementsCount: () => 0, GetElement: () => null });
  const red = { auto: false, r: 192, g: 0, b: 0 };
  // Rows of cells: each its tcPr (as DS 10.0's JSON has it: the left border as "start") and its paragraphs.
  const cells = [
    [{ tcPr: { tcBorders: {} }, paras: [cellPara("a1", { content: [run({}, "Region")] })] }, { tcPr: { shd: { val: "nil", fill: { auto: false, r: 255, g: 255, b: 255 } }, tcBorders: {} }, paras: [cellPara("b1", { content: [run({}, "Revenue")] })] }],
    [
      { tcPr: { tcBorders: {} }, paras: [cellPara("a2", { content: [run({}, "North")] })] },
      { tcPr: { shd: { val: "clear", fill: { auto: false, r: 255, g: 255, b: 0 } }, vAlign: "center", tcBorders: { start: { value: "none", sz: 0, color: { auto: true } }, top: { value: "single", sz: 12, color: red } } }, paras: [cellPara("b2", { pPr: { jc: "end" }, content: [run({ b: true }, "120")] }), cellPara("b2b", { pPr: { jc: "center" }, content: [run({}, "approx.")] })] },
    ],
  ];
  const table = {
    GetClassType: () => "table",
    GetInternalId: () => "t1",
    GetRowsCount: () => cells.length,
    GetRow: (r: number) => ({ GetCellsCount: () => cells[r].length, GetCell: (c: number) => ({ GetContent: () => contentOf(cells[r][c].paras) }) }),
    ToJSON: () => JSON.stringify({ tblPr: { tblBorders: { bottom: { value: "single", sz: 12, color: red } } }, content: cells.map((row) => ({ content: row.map((c) => ({ tcPr: c.tcPr, content: { content: [] } })) })) }),
  };
  const section = { GetPageWidth: () => 11906, GetPageHeight: () => 16838, GetPageMarginTop: () => 1134, GetPageMarginRight: () => 1134, GetPageMarginBottom: () => 1134, GetPageMarginLeft: () => 1134, GetHeader: () => null, GetFooter: () => null, ToJSON: () => "{}" };
  const doc = { ...contentOf([table]), GetAllStyles: () => [], GetAllImages: () => [], GetStyle: () => null, GetDefaultTextPr: () => ({ ToJSON: () => "{}" }), GetSections: () => [section], GetFootnotesFirstParagraphs: () => [] };
  const out = command("word.read", { GetDocument: () => doc }, { formatting: true });
  assert.deepEqual(out.error, undefined, JSON.stringify(out));
  assert.deepEqual(out.result.blocks[0].look, {
    borders: { bottom: "single 1.5pt #C00000" },
    cells: [
      { row: 0, cell: 1, fill: "none" },
      { row: 1, cell: 1, k: 0, of: 2, para: { align: "right" }, runs: [{ t: "120", look: { bold: true } }], fill: "#FFFF00", valign: "center", borders: { left: "none", top: "single 1.5pt #C00000" } },
      { row: 1, cell: 1, k: 1, of: 2, para: { align: "center" } },
    ],
  });
  // The editor gives a command's answer back only where it is nested 10 deep at most (DS 10.0's Asc.C3c): deeper, the
  // plugin got undefined and the read failed.
  const fits = (v: unknown, depth = 0): boolean => depth <= 10 && (typeof v !== "object" || v === null || Object.values(v).every((x) => fits(x, depth + 1)));
  assert.ok(fits(out), "the answer is nested 10 deep at most");
  // Without formatting, none of it.
  assert.equal(command("word.read", { GetDocument: () => doc }, {}).result.blocks[0].look, undefined);
});

test("word.read with formatting: a cell's paragraphs are counted as its text in the rows shows them, a nested table's and a content control's among them, and each is read", () => {
  const run = (rPr: Record<string, unknown>, text: string) => ({ type: "run", rPr, content: [text] });
  const cellPara = (id: string, text: string, rPr: Record<string, unknown> = {}) => ({ GetClassType: () => "paragraph", GetText: () => `${text}\r\n`, GetParaPr: () => ({ GetStyle: () => null }), GetStyle: () => null, GetInternalId: () => id, GetNumbering: () => null, GetAllDrawingObjects: () => [], ToJSON: () => JSON.stringify({ content: [run(rPr, text)] }), GetElementsCount: () => 0, GetElement: () => null });
  const inner = { GetClassType: () => "table", GetRowsCount: () => 1, GetRow: () => ({ GetCellsCount: () => 1, GetCell: () => ({ GetContent: () => contentOf([cellPara("x", "x")]) }) }) };
  const control = { GetClassType: () => "blockLvlSdt", GetContent: () => contentOf([cellPara("c", "c", { i: true })]) };
  // One cell: "a", a nested table holding "x", "b" in bold, and a content control holding "c" in italic.
  const content = [cellPara("a", "a"), inner, cellPara("b", "b", { b: true }), control];
  const table = {
    GetClassType: () => "table",
    GetInternalId: () => "t1",
    GetRowsCount: () => 1,
    GetRow: () => ({ GetCellsCount: () => 1, GetCell: () => ({ GetContent: () => contentOf(content) }) }),
    ToJSON: () => JSON.stringify({ content: [{ content: [{ tcPr: {}, content: { content: [] } }] }] }),
  };
  const section = { GetPageWidth: () => 11906, GetPageHeight: () => 16838, GetPageMarginTop: () => 1134, GetPageMarginRight: () => 1134, GetPageMarginBottom: () => 1134, GetPageMarginLeft: () => 1134, GetHeader: () => null, GetFooter: () => null, ToJSON: () => "{}" };
  const doc = { ...contentOf([table]), GetAllStyles: () => [], GetAllImages: () => [], GetStyle: () => null, GetDefaultTextPr: () => ({ ToJSON: () => "{}" }), GetSections: () => [section], GetFootnotesFirstParagraphs: () => [] };
  const out = command("word.read", { GetDocument: () => doc }, { formatting: true });
  assert.deepEqual(out.error, undefined, JSON.stringify(out));
  assert.deepEqual(out.result.blocks[0].table, [["a / x / b / c"]]);
  assert.deepEqual(out.result.blocks[0].look.cells, [
    { row: 0, cell: 0, k: 2, of: 4, runs: [{ t: "b", look: { bold: true } }] },
    { row: 0, cell: 0, k: 3, of: 4, runs: [{ t: "c", look: { italic: true } }] },
  ]);
});

test("word.read with formatting: a numbered item carries its label as the editor numbers it, so a list going on and one starting again are told apart; a bullet and a read without formatting carry none", () => {
  const numbering = (fmt: string) => {
    const n: any = { ToJSON: () => JSON.stringify({ abstractNum: { a: { lvl: [{ numFmt: { val: fmt } }] } } }) };
    n.GetLevel = () => ({ GetLevelIndex: () => 0, GetNumbering: () => n });
    return n;
  };
  const steps = numbering("decimal"), again = numbering("decimal"), dots = numbering("bullet");
  const para = (id: string, text: string, label: string, list: any) => ({ GetClassType: () => "paragraph", GetText: (o?: { Numbering?: boolean }) => `${o?.Numbering === false ? "" : label}${text}\r\n`, GetParaPr: () => ({ GetStyle: () => null }), GetStyle: () => null, GetInternalId: () => id, GetNumbering: () => list.GetLevel(0), GetAllDrawingObjects: () => [], ToJSON: () => JSON.stringify({ content: [{ type: "run", rPr: {}, content: [text] }] }), GetElementsCount: () => 0, GetElement: () => null });
  const section = { GetPageWidth: () => 11906, GetPageHeight: () => 16838, GetPageMarginTop: () => 1134, GetPageMarginRight: () => 1134, GetPageMarginBottom: () => 1134, GetPageMarginLeft: () => 1134, GetHeader: () => null, GetFooter: () => null, ToJSON: () => "{}" };
  const doc = { ...contentOf([para("p1", "Step two", "2.\t", steps), para("p2", "Step three", "3.\t", steps), para("p3", "Again one", "1.\t", again), para("p4", "Dot", "·\t", dots)]), GetAllStyles: () => [], GetAllImages: () => [], GetStyle: () => null, GetDefaultTextPr: () => ({ ToJSON: () => "{}" }), GetSections: () => [section], GetFootnotesFirstParagraphs: () => [] };
  const out = command("word.read", { GetDocument: () => doc }, { formatting: true });
  assert.deepEqual(out.error, undefined, JSON.stringify(out));
  assert.deepEqual(out.result.blocks.map((b: { p: string; label?: string }) => [b.p, b.label]), [["Step two", "2."], ["Step three", "3."], ["Again one", "1."], ["Dot", undefined]]);
  assert.deepEqual(command("word.read", { GetDocument: () => doc }, {}).result.blocks.map((b: { label?: string }) => b.label), [undefined, undefined, undefined, undefined]);
});

/* ------------------------------------------------------------------ */
/* #13 PR 4: conditional formats, validation, links, sort, names, charts, filters, tables */
/* ------------------------------------------------------------------ */

/** What a fake sheet holds of PR 4's parts, for "as it was" comparisons. */
const extras = (book: ReturnType<typeof workbook>) => {
  const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v);
  return JSON.stringify(sorted([book.state.sheets.map((s) => [s.rules, s.validations, s.links, s.charts, s.filter, s.tables, s.cells, s.formats, s.looks]), book.state.names]));
};

test("a conditional format: every rule kind reaches the builder, each with its look; taken back it takes away the rule it made, not an equal one that was there", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { B2: 5, B3: 1500, C2: 1, C3: 2 });
  // The rule a person made: the same as the first this call makes.
  s1.rules.push({ type: "xlCellValue", applies: "B2:B9", operator: "xlGreater", f1: "1000", fill: "#C6EFCE", fontColor: "#006100", bold: true });
  const before = extras(book);
  const ops = [
    { conditional: "B2:B9", set: { rule: "cell", operator: ">", value: 1000, fill: "#C6EFCE", color: "#006100", bold: true } },
    { conditional: "B2:B9", set: { rule: "cell", operator: "between", value: 1, value2: 9, italic: true, underline: true, strike: true } },
    { conditional: "C:C", set: { rule: "formula", formula: "=$B1>8", fill: "#FFC7CE" } },
    { conditional: "D2:D9", set: { rule: "colorScale", colors: ["#FF0000", "#00FF00", "#0000FF"] } },
    { conditional: "E2:E9", set: { rule: "dataBar", color: "#638EC6" } },
    { conditional: "F2:F9", set: { rule: "top", rank: 3, bottom: true, percent: true, fill: "#FFFF00" } },
    { conditional: "G2:G9", set: { rule: "duplicates", unique: true, color: "#FF0000" } },
    { conditional: "G2:G9", set: { rule: "duplicates", bold: true } },
  ];
  const made = await plugin(book, formatting(ops));
  assert.deepEqual(made.result, { ops: 8, cells: 0 }, JSON.stringify(made));
  assert.deepEqual(s1.rules.slice(1), [
    { type: "xlCellValue", applies: "B2:B9", operator: "xlGreater", f1: "1000", f2: undefined, fill: "#C6EFCE", fontColor: "#006100", bold: true },
    { type: "xlCellValue", applies: "B2:B9", operator: "xlBetween", f1: "1", f2: "9", italic: true, underline: "xlUnderlineStyleSingle", strike: true },
    { type: "xlExpression", applies: "C:C", operator: undefined, f1: "$B1>8", f2: undefined, fill: "#FFC7CE" },
    { type: "xlColorScale", applies: "D2:D9", colors: ["#FF0000", "#00FF00", "#0000FF"] },
    { type: "xlDataBar", applies: "E2:E9", barColor: "#638EC6" },
    { type: "xlTop10", applies: "F2:F9", rank: 3, topBottom: "xlTop10Bottom", percent: true, fill: "#FFFF00" },
    { type: "xlUniqueValues", applies: "G2:G9", dupe: "xlUnique", fontColor: "#FF0000" },
    { type: "xlUniqueValues", applies: "G2:G9", dupe: "xlDuplicate", bold: true },
  ]);
  s1.rules.splice(1);
  // Failing at the last op: the rules this call made go, the person's stays (the equal one among the rules is told by order).
  const failed = await plugin(book, formatting([...ops, { format: "Z99", set: { bold: true } }]));
  assert.equal(failed.undone, true, JSON.stringify(failed));
  assert.equal(extras(book), before);
  assert.equal(s1.rules.length, 1);
});

test("a conditional format taken back leaves one a person changed or took away; a clear has no inverse and is named when a later op fails", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99", before: (n, sheets) => { if (n === 3) { sheets[0].rules.find((r) => r.applies === "B2:B9")!.f1 = "2000"; sheets[0].rules.splice(sheets[0].rules.findIndex((r) => r.applies === "C2:C9"), 1); } } });
  const [s1] = book.state.sheets;
  s1.cells.A1 = 1;
  const out = await plugin(book, formatting([
    { conditional: "B2:B9", set: { rule: "cell", operator: ">", value: 1000, fill: "#C6EFCE" } },
    { conditional: "C2:C9", set: { rule: "dataBar" } },
    { format: "Z99", set: { bold: true } },
  ]));
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.match(out.error.message, /Kept as a person changed them after this call: the conditional format B2:B9 of "Sheet1"\.$/);
  assert.deepEqual(s1.rules.map((r) => [r.applies, r.f1]), [["B2:B9", "2000"]], "the changed rule stays, the one taken away is gone, nothing else is there");

  // A clear takes every rule that meets the cells, and cannot be made again: the answer says so.
  const book2 = workbook(["Sheet1"], { poisonLook: "A1" });
  const [t1] = book2.state.sheets;
  Object.assign(t1.cells, { A1: "h1", B1: "h2", A2: 1 });
  t1.rules.push({ type: "xlCellValue", applies: "B2:B9", operator: "xlGreater", f1: "1" }, { type: "xlDataBar", applies: "D2:D9" });
  const cleared = await plugin(book2, formatting([{ conditional: "A1:C9", set: { clear: true } }, { asTable: "A1:B2" }]));
  assert.equal(cleared.error?.code, "partial", JSON.stringify(cleared));
  assert.match(cleared.error.message, /Not taken back: the conditional formats of A1:C9 of "Sheet1" that op 1 cleared\./);
  assert.deepEqual(t1.rules.map((r) => r.applies), ["D2:D9"], "only the rules that meet the cells went");
});

test("validation: a list, a number and a message reach the builder after the cells' own validation is deleted (Add refuses cells that have one); taken back it puts the old one back, cell by cell", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s1] = book.state.sheets;
  s1.validations.E3 = ["xlValidateWholeNumber", "xlValidAlertStop", "xlBetween", "1", "9", true, true, "old", "", "", "", true, true];
  s1.validations.E4 = ["xlValidateWholeNumber", "xlValidAlertStop", "xlBetween", "1", "9", true, true, "old", "", "", "", true, true];
  s1.validations.F2 = ["xlValidateDecimal", "xlValidAlertStop", "xlGreater", "0", "", true, true, "", "", "", "", true, true];
  const before = extras(book);
  const ok = await plugin(book, formatting([
    { validate: "E2:E5", set: { list: ["Open", "Done"], message: "Pick one" } },
    { validate: "B2:B3", set: { whole: "between 1 and 10" } },
    { validate: "F2", set: { clear: true } },
  ]));
  assert.deepEqual(ok.result, { ops: 3, cells: 0 }, JSON.stringify(ok));
  assert.deepEqual(s1.validations.E3, ["xlValidateList", "xlValidAlertStop", "xlBetween", "Open,Done", "", true, true, "Pick one", "", "", "", true, true]);
  assert.deepEqual(s1.validations.B3?.slice(0, 5), ["xlValidateWholeNumber", "xlValidAlertStop", "xlBetween", "1", "10"]);
  assert.equal(s1.validations.F2, undefined, "cleared");
  const failed = await plugin(book, formatting([
    { validate: "E2:E5", set: { decimal: "> 0" } },
    { validate: "G2:G3", set: { length: "<= 3" } },
    { format: "Z99", set: { bold: true } },
  ]));
  assert.equal(failed.undone, true, JSON.stringify(failed));
  assert.deepEqual(s1.validations.E3?.slice(0, 5), ["xlValidateList", "xlValidAlertStop", "xlBetween", "Open,Done", ""]);
  assert.equal(s1.validations.G2, undefined);
  // The same from the start, to be sure "as it was" is the whole state.
  const fresh = workbook(["Sheet1"], { poisonLook: "Z99" });
  Object.assign(fresh.state.sheets[0].validations, { E3: s1.validations.E3 === undefined ? [] : ["xlValidateWholeNumber", "xlValidAlertStop", "xlBetween", "1", "9", true, true, "old", "", "", "", true, true], E4: ["xlValidateWholeNumber", "xlValidAlertStop", "xlBetween", "1", "9", true, true, "old", "", "", "", true, true] });
  const was = JSON.stringify(fresh.state.sheets[0].validations);
  await plugin(fresh, formatting([{ validate: "E2:E5", set: { list: ["a"] } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(JSON.stringify(fresh.state.sheets[0].validations), was, "the old validation of E3 and E4 is back, E2 and E5 have none again");
  assert.ok(before);
});

test("validation taken back keeps a cell whose validation a person changed since, and names it", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99", before: (n, sheets) => { if (n === 3) sheets[0].validations.E3 = ["xlValidateDecimal", "xlValidAlertStop", "xlGreater", "5", "", true, true, "", "", "", "", true, true]; } });
  const [s1] = book.state.sheets;
  const out = await plugin(book, formatting([{ validate: "E2:E4", set: { whole: ">= 0" } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.match(out.error.message, /Kept as a person changed them after this call: E3 of "Sheet1"\.$/);
  assert.deepEqual(Object.keys(s1.validations), ["E3"], "E2 and E4 have none again; E3 is the person's");
  assert.equal(s1.validations.E3?.[0], "xlValidateDecimal");
});

test("a link: a text cell keeps its text, an empty cell shows the address, a number or a formula needs set.text; taken back it puts back the text, the look and the link the cell had", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "Home", A2: 42, A3: "=1+2", A4: "Old" });
  s1.links.A4 = { address: "https://old.example.com", sub: "", tip: "tip" };
  s1.looks.A4 = { underline: "single", color: "#0563C1" };
  const refused = await plugin(book, formatting([{ link: "A2", set: { url: "https://example.com" } }]));
  assert.match(refused.error.message, /^op 1: A2 of "Sheet1" holds a number, which a link would replace with its address: give set.text, the text it shows$/);
  assert.match((await plugin(book, formatting([{ link: "A3", set: { url: "https://example.com" } }]))).error.message, /A3 of "Sheet1" holds a formula/);
  assert.equal(book.state.commands, 2, "the check alone each time");
  const before = extras(book);
  const ok = await plugin(book, formatting([
    { link: "A1", set: { url: "https://example.com/a" } },
    { link: "B1", set: { url: "mailto:a@example.com" } },
    { link: "A2", set: { url: "https://example.com/n", text: "forty-two" } },
    { link: "A4", set: { url: "https://example.com/new", text: "New" } },
  ]));
  assert.deepEqual(ok.result, { ops: 4, cells: 0 }, JSON.stringify(ok));
  assert.deepEqual([s1.cells.A1, s1.cells.B1, s1.cells.A2, s1.cells.A4], ["Home", "mailto:a@example.com", "forty-two", "New"]);
  assert.equal(s1.links.A4.address, "https://example.com/new");
  assert.equal(s1.looks.A1.underline, "single");
  const failed = await plugin(book, formatting([
    { link: "A1", set: { url: "https://example.com/a" } },
    { link: "B1", set: { url: "mailto:a@example.com" } },
    { link: "A2", set: { url: "https://example.com/n", text: "forty-two" } },
    { link: "A4", set: { url: "https://example.com/new", text: "New" } },
    { format: "Z99", set: { bold: true } },
  ]));
  // (The call before stays; these four go again.)
  assert.equal(failed.undone, true, JSON.stringify(failed));
  assert.deepEqual([s1.cells.A1, s1.cells.B1, s1.cells.A2, s1.cells.A4], ["Home", "mailto:a@example.com", "forty-two", "New"]);
  assert.ok(before);
});

test("a link taken back puts the cell as it was: its text and number, its look, and the link it had; a cell a person changed since is kept", async () => {
  const book = workbook(["Sheet1"], { poisonLook: "Z99" });
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A2: 42, A4: "Old", B1: "plain" });
  s1.links.A4 = { address: "https://old.example.com", sub: "", tip: "tip" };
  s1.looks.A4 = { underline: "single", color: "#0563C1" };
  // The link's look takes the cell's font over: A2 is bold and red before, and neither after.
  s1.looks.A2 = { bold: true, color: "#FF0000" };
  const was = extras(book);
  const out = await plugin(book, formatting([
    { link: "A2", set: { url: "https://example.com/n", text: "forty-two" } },
    { link: "A4", set: { url: "https://example.com/new", text: "New" } },
    { link: "B1", set: { url: "https://example.com/b" } },
    { format: "Z99", set: { bold: true } },
  ]));
  assert.equal(out.undone, true, JSON.stringify(out));
  assert.equal(extras(book), was.replace(/"tip":"tip"/, '"tip":"tip"'), "number, text, looks and link are back");
  assert.equal(s1.links.A4.address, "https://old.example.com");

  const person = workbook(["Sheet1"], { poisonLook: "Z99", before: (n, sheets) => { if (n === 3) sheets[0].cells.B1 = "typed"; } });
  person.state.sheets[0].cells.B1 = "plain";
  const kept = await plugin(person, formatting([{ link: "B1", set: { url: "https://example.com/b" } }, { format: "Z99", set: { bold: true } }]));
  assert.equal(kept.error?.code, "partial", JSON.stringify(kept));
  assert.match(kept.error.message, /Kept as a person changed them after this call: B1 of "Sheet1"/);
  assert.equal(person.state.sheets[0].cells.B1, "typed");
  assert.equal(person.state.sheets[0].links.B1, undefined, "the link itself is gone");
});

test("a sort: the rows of the range ordered by up to three columns through the builder (no header guessed), taken back with values, formulas and formats; alignment and borders are named", async () => {
  const book = workbook(["Sheet1"], { poison: "Z9" });
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "Name", A2: "pear", A3: "apple", A4: "fig", A5: "kiwi", B1: "Qty", B2: 3, B3: 10, B4: 7, B5: 7, C2: "=B2*2", C3: "=B3*2", C4: "=B4*2", C5: "=B5*2" });
  s1.formats.B3 = "0.00";
  s1.looks.A3 = { bold: true, fill: "#FF0000" };
  const before = readable(s1);
  const ok = await plugin(book, { kind: "cell.edit", args: editJob("xlsx", [{ sort: "A2:C5", by: ["B desc", "A"] }]).args });
  assert.deepEqual(ok.result, { ops: 1, cells: 0 }, JSON.stringify(ok));
  assert.deepEqual([2, 3, 4, 5].map((r) => s1.cells[`A${r}`]), ["apple", "fig", "kiwi", "pear"]);
  assert.equal(s1.formats.B2, "0.00", "formats move with their rows");
  assert.equal(s1.looks.A2.bold, true);
  assert.equal(s1.cells.A1, "Name", "the header is outside the range");
  assert.ok(book.state.calls.includes("SetSort A2:C5 B2 xlDescending A2 xlAscending   xlNo"), book.state.calls.join(" | "));
  // Taken back: a later write fails.
  const failed = await plugin(book, { kind: "cell.edit", args: editJob("xlsx", [{ sort: "A2:C5", by: ["A desc"] }, { range: "Z9", values: [[1]] }]).args });
  assert.equal(failed.error?.code, "partial", JSON.stringify(failed));
  assert.match(failed.error.message, /The editor cannot read back the alignment and borders of "Sheet1"!A2:C5 \(op 1\), which stay as this call set them\.$/);
  assert.deepEqual([2, 3, 4, 5].map((r) => s1.cells[`A${r}`]), ["apple", "fig", "kiwi", "pear"], "as the first sort left them");
  assert.ok(before);
  const fresh = workbook(["Sheet1"], { poison: "Z9" });
  const f1 = fresh.state.sheets[0];
  Object.assign(f1.cells, { A2: "pear", A3: "apple", A4: "fig", B2: 3, B3: 10, B4: 7, C2: "=B2*2", C3: "=B3*2", C4: "=B4*2" });
  f1.formats.B3 = "0.00";
  f1.looks.A3 = { bold: true, fill: "#FF0000" };
  const start = readable(f1);
  const undone = await plugin(fresh, { kind: "cell.edit", args: editJob("xlsx", [{ sort: "A2:C4", by: ["B desc"] }, { range: "Z9", values: [[1]] }]).args });
  assert.equal(undone.error?.code, "partial", JSON.stringify(undone));
  assert.equal(readable(f1), start, "values, formulas, number formats and looks as they were");
});

test("a sort of merged cells is refused before anything is changed; a person's change after the sort stays and is named", async () => {
  const book = workbook(["Sheet1"], { poison: "Z9" });
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "b", A2: "a", A3: "c" });
  s1.merges.push("A2:B2");
  const refused = await plugin(book, { kind: "cell.edit", args: editJob("xlsx", [{ sort: "A1:B3", by: ["A"] }]).args });
  assert.equal(refused.error?.message, 'op 1: a sort needs cells that are not merged, and A2:B2 of "Sheet1" is merged (split it first)');
  assert.equal(book.state.commands, 1);
  s1.merges = [];
  const person = workbook(["Sheet1"], { poison: "Z9", before: (n, sheets) => { if (n === 3) sheets[0].cells.A1 = "typed"; } });
  Object.assign(person.state.sheets[0].cells, { A1: "b", A2: "a", A3: "c" });
  const out = await plugin(person, { kind: "cell.edit", args: editJob("xlsx", [{ sort: "A1:A3", by: ["A"] }, { range: "Z9", values: [[1]] }]).args });
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.match(out.error.message, /Kept as a person changed them after this call: A1 of "Sheet1"/);
  assert.equal(person.state.sheets[0].cells.A1, "typed");
});

test("a named range: made, changed and deleted through the workbook, each taken back (the old reference, the old name, or none); a person's change stays and is named", async () => {
  const book = workbook(["Sheet1", "My data"], { poison: "Z9" });
  book.state.names.Old = "Sheet1!$A$1";
  book.state.names.Gone = "'My data'!$B$2:$C$3";
  const ok = await plugin(book, { kind: "cell.edit", args: editJob("xlsx", [{ name: "Sales", refersTo: "My data!B6:C9" }, { name: "Old", refersTo: "Sheet1!B2:B9" }, { name: "Gone", delete: true }, { name: "Plain", refersTo: "A1:A3" }]).args });
  assert.deepEqual(ok.result, { ops: 4, cells: 0 }, JSON.stringify(ok));
  assert.deepEqual(book.state.names, { Old: "'Sheet1'!$B$2:$B$9", Sales: "'My data'!$B$6:$C$9", Plain: "Sheet1!$A$1:$A$3" });
  const was = JSON.stringify(book.state.names);
  const failed = await plugin(book, { kind: "cell.edit", args: editJob("xlsx", [{ name: "Fresh", refersTo: "A1" }, { name: "Old", refersTo: "Sheet1!C2" }, { name: "Plain", delete: true }, { range: "Z9", values: [[1]] }]).args });
  assert.equal(failed.undone, true, JSON.stringify(failed));
  assert.equal(JSON.stringify(book.state.names), was);

  const person = workbook(["Sheet1"], { poison: "Z9", before: (n, sheets) => void n });
  const p = person.state.names;
  const changed = workbook(["Sheet1"], { poison: "Z9", before: (n) => { if (n === 3) { p2.names.Fresh = "Sheet1!$D$4"; p2.names.Edit = "Sheet1!$E$5"; } } });
  const p2 = changed.state;
  p2.names.Edit = "Sheet1!$A$1";
  const out = await plugin(changed, { kind: "cell.edit", args: editJob("xlsx", [{ name: "Fresh", refersTo: "A1" }, { name: "Edit", refersTo: "B2" }, { range: "Z9", values: [[1]] }]).args });
  assert.equal(out.error?.code, "partial", JSON.stringify(out));
  assert.match(out.error.message, /Kept as a person changed them after this call: the name "Edit"; the name "Fresh"\.$/);
  assert.deepEqual(p2.names, { Fresh: "Sheet1!$D$4", Edit: "Sheet1!$E$5" });
  assert.ok(p);
  // A sheet the name refers to must be there.
  const missing = await plugin(workbook(["Sheet1"]), { kind: "cell.edit", args: editJob("xlsx", [{ name: "X", refersTo: "Nope!A1" }]).args });
  assert.match(missing.error.message, /there is no sheet named "Nope"/);
  const none = await plugin(workbook(["Sheet1"]), { kind: "cell.edit", args: editJob("xlsx", [{ name: "Nope", delete: true }]).args });
  assert.match(none.error.message, /there is no name "Nope"/);
});

test("a chart: the data range with its sheet quoted and absolute, the type, size and place, then its titles and legend; it has no inverse and is named when a later op fails", async () => {
  const book = workbook(["Sheet1", "My data"], { poisonLook: "A1" });
  const [s1, data] = book.state.sheets;
  Object.assign(data.cells, { A1: "Region", B1: "2025", A2: "North", B2: 10, A3: "South", B3: 8 });
  const ok = await plugin(book, formatting([{ sheet: "my data", chart: "A1:B3", set: { type: "line", title: "Revenue", xTitle: "Region", yTitle: "EUR", legend: "bottom", at: "E2", width: "10cm", height: "6cm", rows: true } }]));
  assert.deepEqual(ok.result, { ops: 1, cells: 0 }, JSON.stringify(ok));
  assert.deepEqual(data.charts, [{ type: "lineNormal", ref: "'My data'!$A$1:$B$3", col: 4, row: 1, width: 5669 * 635, height: 3402 * 635, inRows: true, title: "Revenue", xTitle: "Region", yTitle: "EUR", legend: "bottom" }]);
  assert.deepEqual(s1.charts, []);
  // The data must hold numbers.
  const empty = await plugin(book, formatting([{ chart: "A1:B3" }]));
  assert.equal(empty.error?.message, 'op 1: the data of a chart holds numbers, and A1:B3 of "Sheet1" holds none (write them first)');
  // A chart made, then a table the builder fails at: the chart stays, and the answer says so.
  Object.assign(s1.cells, { A1: "x", A2: 1 });
  const partial = await plugin(book, formatting([{ chart: "A1:A2", set: { type: "pie", title: "T" } }, { asTable: "A1:A2" }]));
  assert.equal(partial.error?.code, "partial", JSON.stringify(partial));
  assert.match(partial.error.message, /Not taken back: the chart of A1:A2 of "Sheet1" that op 1 made\./);
  assert.equal(s1.charts.length, 1, "the chart is there");
});

test("a chart whose titles the editor refuses after it was made is named as made", async () => {
  const book = workbook(["Sheet1"]);
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "x", A2: 1 });
  const sheet = book.state.sheets[0];
  // The builder throws at the title: a chart is there all the same.
  const real = (sheet as unknown as { __x?: unknown }).__x;
  assert.equal(real, undefined);
  const failing = workbook(["Sheet1"]);
  const f = failing.state.sheets[0];
  Object.assign(f.cells, { A1: "x", A2: 1 });
  const out = failing.run(CELL_EDIT_COMMANDS.step, { op: { sheet: "Sheet1", chart: "A1:A2", area: { col: 0, row: 0, cols: 1, rows: 2 }, chartType: "nope", at: { col: 3, row: 0 }, width: 1, height: 1, inRows: false }, index: 0, pending: [] });
  assert.equal(out.error?.message, "op 1: the editor did not make the chart");
});

test("a table, a filter: the builder's calls; a table needs text headers, all different, in cells that are not merged", async () => {
  const book = workbook(["Sheet1"]);
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "Name", B1: "Qty", A2: "pear", B2: 3, A3: "fig", B3: 7 });
  const ok = await plugin(book, formatting([{ filter: "A1:B3", set: { column: "B", criteria: ">5" } }, { asTable: "D1:E3" }]));
  // (D1:E3 holds nothing: its header is empty.)
  assert.match(ok.error.message, /^op 2: the first row of a table holds its column names as texts, and D1 of "Sheet1" is empty \(write the names first\)$/);
  assert.equal(book.state.commands, 1, "the check alone");
  const good = await plugin(book, formatting([{ filter: "A1:B3", set: { column: "B", criteria: ">5", or: "<2" } }, { asTable: "A1:B3" }]));
  assert.deepEqual(good.result, { ops: 2, cells: 0 }, JSON.stringify(good));
  assert.equal(s1.filter, "A1:B3");
  assert.deepEqual(s1.criteria, [[2, ">5", "xlOr", "<2"]]);
  assert.deepEqual(s1.tables, ["A1:B3"]);
  s1.cells.B1 = 7;
  assert.match((await plugin(book, formatting([{ asTable: "A1:B3" }]))).error.message, /B1 of "Sheet1" is a number or a formula/);
  s1.cells.B1 = "Name";
  assert.match((await plugin(book, formatting([{ asTable: "A1:B3" }]))).error.message, /the column names of a table are all different, and "Name" is in B1 of "Sheet1" twice/);
  s1.cells.B1 = "Qty";
  s1.merges.push("A3:B3");
  assert.match((await plugin(book, formatting([{ asTable: "A1:B3" }]))).error.message, /a table needs cells that are not merged, and A3:B3 of "Sheet1" is merged/);
});

test("cell.read with formatting: conditional formats, validation, links, the filter and the charts of a sheet, each within the room the read has", () => {
  const book = workbook(["Sheet1"]);
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "Name", B1: "Qty", B2: 5, B3: 8, C2: "Open" });
  s1.rules.push({ type: "xlCellValue", applies: "B2:B3", operator: "xlGreater", f1: "6", fill: "#C6EFCE", fontColor: "#006100", bold: true }, { type: "xlColorScale", applies: "C2:C3", colors: [] }, { type: "xlExpression", applies: "A:A", f1: "$B1>8" });
  s1.validations.C2 = ["xlValidateList", "xlValidAlertStop", "xlBetween", "Open,Done", "", true, true, "Pick", "", "", "", true, true];
  s1.validations.C3 = [...s1.validations.C2];
  s1.links.A1 = { address: "https://example.com/a", sub: "", tip: "" };
  s1.filter = "A1:C3";
  s1.charts.push({ type: "bar", ref: "x", title: "Revenue", col: 4, row: 1, width: 1, height: 1, inRows: false });
  const out = book.run(CELL_EDIT_COMMANDS.step === "" ? "" : COMMANDS["cell.read"].source, { formatting: true }) as { result: { sheets: { look: any }[] } };
  const look = out.result.sheets[0].look;
  assert.deepEqual(look.rules, [
    ["xlCellValue", "B2:B3", "xlGreater", "6", "", null, null, null, null, "#C6EFCE", "#006100", true],
    ["xlColorScale", "C2:C3", null, null, null, null, null, null, null, null, null, null],
    ["xlExpression", "A:A", null, "$B1>8", "", null, null, null, null, null, null, null],
  ].map((r) => r.map((v) => (v === undefined ? null : v))));
  assert.deepEqual(look.validation, [{ a: "C2:C3", v: ["xlValidateList", "xlValidAlertStop", "xlBetween", "Open,Done", "", true, true, "Pick", "", "", "", true, true] }]);
  assert.deepEqual(look.links, [["A1", "https://example.com/a", "", "Name"]]);
  assert.equal(look.filter, "A1:C3");
  assert.deepEqual(look.charts, [["bar", "Revenue", "E2"]]);
});

test("cell.read with formatting: the editor gives what a conditional format draws as the cell's own look, so a cell a rule covers lists no fill, font colour, bold, italic, underline or strike; its number format, size and wrap stay", () => {
  const book = workbook(["Sheet1"]);
  const [s1] = book.state.sheets;
  Object.assign(s1.cells, { A1: "head", B2: 5, B3: 8, C2: 1, D5: 9 });
  // B2, C2 and D5 look as a rule draws them (B and a whole column D are covered); A1 is formatted by hand.
  s1.looks.A1 = { bold: true, fill: "#FFFF00" };
  s1.looks.B2 = { bold: true, fill: "#FF0000", color: "#006100", italic: true, underline: "single", strike: true, size: 14, wrap: true };
  s1.looks.B3 = { fill: "#FF0000" };
  s1.looks.C2 = { fill: "#00FF00" };
  s1.looks.D5 = { fill: "#0000FF" };
  s1.formats.B2 = "0.00";
  s1.rules.push({ type: "xlCellValue", applies: "B2:B9", operator: "xlGreater", f1: "1" }, { type: "xlDataBar", applies: "D:D" });
  const out = book.run(COMMANDS["cell.read"].source, { formatting: true }) as { result: { sheets: { look: any }[] } };
  const formats = out.result.sheets[0].look.formats as { look: Record<string, unknown>; ranges: string[] }[];
  const byRange = Object.fromEntries(formats.flatMap((f) => f.ranges.map((r) => [r, f.look])));
  assert.deepEqual(byRange.A1, { bold: true, fill: "#FFFF00" }, "a cell no rule covers is listed as it is");
  assert.deepEqual(byRange.C2, { fill: "#00FF00" });
  assert.deepEqual(byRange.B2, { numberFormat: "0.00", size: 14, wrap: true });
  assert.equal(byRange.B3, undefined, "nothing is left to say of B3");
  assert.equal(byRange.D5, undefined, "a whole column's rule covers its cells");
});
