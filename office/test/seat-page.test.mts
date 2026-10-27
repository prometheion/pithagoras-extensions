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
import { BRIDGE_JS, COMMANDS, MAX_READ_TEXT, SEAT_PAGE_JS } from "../src/seat-page";

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
function command(kind: string, Api: unknown, args: unknown = {}): { result?: any; error?: any } {
  // As JSON, as the editor hands it back to the plugin (and out of the context's own objects).
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${COMMANDS[kind].source})()`, { Api, Asc: { scope: { args } } })));
}

const paragraph = (text: string) => ({ GetClassType: () => "paragraph", GetText: () => `${text}\r\n`, GetParaPr: () => ({ GetStyle: () => null }) });
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

type FakeSheet = { name: string; hidden: boolean; cells: Record<string, unknown>; widths: Record<number, number> };

/** A1 addresses of a range, row by row. */
function cellsOf(range: string): string[][] {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range)!;
  const col = (l: string) => [...l].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const name = (n: number) => { let out = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out; return out; };
  const [c1, r1, c2, r2] = [col(m[1]), Number(m[2]), col(m[3] ?? m[1]), Number(m[4] ?? m[2])];
  return Array.from({ length: r2 - r1 + 1 }, (_, r) => Array.from({ length: c2 - c1 + 1 }, (_, c) => `${name(c1 + c)}${r1 + r}`));
}

/**
 * A workbook as the spreadsheet editor's builder API shows it to a command: a sheet is made, moved or deleted two
 * commands after it was asked for (the Document Server's lock), a name or visibility changes at once. `poison` makes
 * a write into that address throw.
 */
function workbook(start: (string | { name: string; hidden: boolean })[], options: { poison?: string; never?: boolean } = {}) {
  const sheets: FakeSheet[] = start.map((s) => (typeof s === "string" ? { name: s, hidden: false, cells: {}, widths: {} } : { ...s, cells: {}, widths: {} }));
  const later: { due: number; fn: () => void }[] = [];
  const state = { sheets, commands: 0, saves: 0, active: 0, asked: [] as string[] };
  const ask = (what: string, fn: () => void) => {
    state.asked.push(what);
    if (!options.never) later.push({ due: state.commands + 2, fn });
  };
  const of = new WeakMap<object, FakeSheet>();
  const rangeOf = (sh: FakeSheet, address: string) => {
    const grid = cellsOf(address);
    const flat = (v: unknown) => (grid.length === 1 && grid[0].length === 1 ? v : v);
    return {
      GetValue: () => flat(grid.map((row) => row.map((a) => (typeof sh.cells[a] === "string" && (sh.cells[a] as string).startsWith("=") ? 0 : sh.cells[a] ?? "")))),
      GetFormula: () => grid.map((row) => row.map((a) => (sh.cells[a] === undefined ? "" : String(sh.cells[a])))),
      SetValue: (v: unknown) => {
        if (options.poison && grid.flat().includes(options.poison)) throw new Error("the editor refused the write");
        const rows = Array.isArray(v) ? (v as unknown[][]) : [[v]];
        grid.forEach((row, r) => row.forEach((a, c) => (rows[r][c] === "" ? delete sh.cells[a] : (sh.cells[a] = rows[r][c]))));
      },
      GetAddress: () => {
        const used = Object.keys(sh.cells).sort();
        return used.length ? `${used[0]}:${used.at(-1)}` : "A1";
      },
      Copy: (dest: { into: (cells: Record<string, unknown>) => void }) => dest.into(Object.fromEntries(grid.flat().filter((a) => a in sh.cells).map((a) => [a, sh.cells[a]]))),
      into: (cells: Record<string, unknown>) => Object.assign(sh.cells, cells),
      GetColumnWidth: () => sh.widths[cellsOf(address)[0][0].charCodeAt(0) - 65] ?? 9,
      SetColumnWidth: (w: number) => (sh.widths[cellsOf(address)[0][0].charCodeAt(0) - 65] = w),
    };
  };
  const wrap = (sh: FakeSheet) => {
    const w = {
      GetName: () => sh.name,
      GetVisible: () => !sh.hidden,
      SetVisible: (v: boolean) => void (sh.hidden = !v),
      SetName: (n: string) => void (sh.name = n),
      GetRange: (a: string) => rangeOf(sh, a),
      GetUsedRange: () => {
        const r = rangeOf(sh, "A1");
        return { ...rangeOf(sh, r.GetAddress()), GetAddress: r.GetAddress };
      },
      Delete: () => ask(`delete ${sh.name}`, () => sheets.splice(sheets.indexOf(sh), 1)),
      Move: (before?: object, after?: object) =>
        ask(`move ${sh.name}`, () => {
          sheets.splice(sheets.indexOf(sh), 1);
          const at = before ? sheets.indexOf(of.get(before)!) : sheets.indexOf(of.get(after!)!) + 1;
          sheets.splice(at, 0, sh);
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
    AddSheet: (n: string) => ask(`add ${n}`, () => sheets.splice(Math.min(state.active + 1, sheets.length), 0, { name: n, hidden: false, cells: {}, widths: {} })),
    Save: () => void state.saves++,
  };
  /** A command run as the editor runs it: what was asked two commands ago is made first. */
  const run = (source: string, args: unknown) => {
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
async function plugin(book: ReturnType<typeof workbook>, job: { kind: string; args: unknown }): Promise<{ result?: any; error?: any; undone?: boolean }> {
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

test("a spreadsheet edit whose sheet the editor never makes fails after the wait, and what came before is taken back", async () => {
  const book = workbook(["Sheet1"], { never: true });
  const out = await plugin(book, { kind: "cell.edit", args: { ops: [{ range: "A1", values: [[1]] }, { addSheet: "Never" }] } });
  assert.equal(out.error?.code, "failed");
  assert.match(out.error.message, /^op 2: the editor did not show the change to the sheets within 10 s/);
  assert.deepEqual(book.state.sheets[0].cells, {}, "the write before it is taken back");
});
