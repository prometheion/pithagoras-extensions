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

type FakeSheet = { name: string; hidden: boolean; cells: Record<string, unknown>; formats: Record<string, string>; widths: Record<number, number> };

/** A1 addresses of a range, row by row. */
function cellsOf(range: string): string[][] {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range.replace(/\$/g, ""))!;
  const col = (l: string) => [...l].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const name = (n: number) => { let out = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out; return out; };
  const [c1, r1, c2, r2] = [col(m[1]), Number(m[2]), col(m[3] ?? m[1]), Number(m[4] ?? m[2])];
  return Array.from({ length: Math.abs(r2 - r1) + 1 }, (_, r) => Array.from({ length: Math.abs(c2 - c1) + 1 }, (_, c) => `${name(Math.min(c1, c2) + c)}${Math.min(r1, r2) + r}`));
}

/**
 * A workbook as the spreadsheet editor's builder API shows it to a command (as the end-to-end test and the probes of
 * DS 10.0 found it): a sheet is made, moved or deleted two commands after it was asked for (the Document Server's
 * lock), a name or visibility changes at once. A value written is read as Excel's input reads it ("10%" is 0.1 in a
 * percent format, "00123" is 123, unless the cell is formatted as text), a formula it cannot read ("=SUM(") is not
 * taken and SetValue answers false. A moved or made sheet becomes the active one, hiding the active one makes the
 * next visible one active, and a hidden sheet made active is shown again. `poison` makes the first write into that
 * address throw; `never` keeps the Document Server from making what was asked (all of it, or what it names).
 */
function workbook(start: (string | { name: string; hidden: boolean })[], options: { poison?: string; never?: boolean | ((what: string) => boolean) } = {}) {
  const sheets: FakeSheet[] = start.map((s) => (typeof s === "string" ? { name: s, hidden: false, cells: {}, formats: {}, widths: {} } : { ...s, cells: {}, formats: {}, widths: {} }));
  const later: { due: number; fn: () => void }[] = [];
  const state = { sheets, commands: 0, saves: 0, active: sheets[0], asked: [] as string[], poisoned: false, formatted: [] as string[] };
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
  const rangeOf = (sh: FakeSheet, address: string) => {
    const grid = cellsOf(address);
    const one = grid.length === 1 && grid[0].length === 1;
    const formula = (v: unknown) => typeof v === "string" && v.startsWith("=");
    return {
      GetValue: () => {
        const rows = grid.map((row) => row.map((a) => (formula(sh.cells[a]) ? 0 : sh.cells[a] ?? "")));
        return one ? rows[0][0] : rows;
      },
      GetFormula: () => grid.map((row) => row.map((a) => (sh.cells[a] === undefined ? "" : String(sh.cells[a])))),
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
        grid.flat().forEach((a) => {
          state.formatted.push(a);
          if (f === "General") delete sh.formats[a];
          else sh.formats[a] = f;
        }),
      GetAddress: () => {
        const used = Object.keys(sh.cells).sort();
        return used.length ? `${used[0]}:${used.at(-1)}` : "A1";
      },
      // In DS 10.0 a Copy or Paste into another sheet leaves the old sheet's formulas computing no more.
      Copy: () => {
        throw new Error("ApiRange.Copy into another sheet breaks the old sheet's formulas");
      },
      GetColumnWidth: () => sh.widths[cellsOf(address)[0][0].charCodeAt(0) - 65] ?? 9,
      SetColumnWidth: (w: number) => (sh.widths[cellsOf(address)[0][0].charCodeAt(0) - 65] = w),
    };
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
        const made = { name: n, hidden: false, cells: {}, formats: {}, widths: {} };
        sheets.splice(sheets.indexOf(state.active) + 1, 0, made);
        activate(made);
      }),
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
  const para: any = { GetClassType: () => "paragraph", GetText: () => `${state.text}\r\n`, GetParaPr: () => ({ GetStyle: () => null }), GetRange: () => range(0, state.text.length), GetNext: () => null, GetPrevious: () => null, Delete() {} };
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
