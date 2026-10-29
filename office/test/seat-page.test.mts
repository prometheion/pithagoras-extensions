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
import { BRIDGE_JS, COMMANDS, EDITOR_SIZE, MAX_READ_TEXT, MAX_SHOWN_TEXT, SEAT_PAGE_HTML, SEAT_PAGE_JS, SHEET_MOST, VIEW_SETTLE } from "../src/seat-page";

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
  return { GetClassType: () => "paragraph", GetText: (o?: { Numbering?: boolean }) => `${o?.Numbering === false ? "" : label}${text}\r\n`, GetParaPr: () => ({ GetStyle: () => st }), GetStyle: () => st, GetInternalId: () => id, GetNumbering: () => null };
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
  const para: any = { ...paragraph(""), GetText: () => `${state.text}\r\n`, GetRange: () => range(0, state.text.length), GetNext: () => null, GetPrevious: () => null, Delete() {} };
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
  paras: { text: string; style?: string; list?: { kind: "bullet" | "number"; level?: number; num?: string }; link?: string; linkText?: string; table?: string; row?: number; tcPr?: Record<string, unknown>; section?: number; instr?: string }[];
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
}) {
  const calls: string[] = [];
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
  const style = (name: string, type: string) => (styles[name] = rec(`style(${name})`, { GetName: () => name, GetType: () => type, GetTextPr: () => rec(`style(${name}).text`), GetParaPr: () => rec(`style(${name}).para`), ToJSON: () => JSON.stringify({ styleId: name, ...(spec.basedOn?.[name] ? { basedOn: spec.basedOn[name] } : {}) }) }));
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
  const paras = spec.paras.map((p, i) => {
    const label = `para(${p.text})`;
    const list = p.list ? numbering(p.list.num ?? p.list.kind, p.list.kind) : null;
    const link = p.link ? rec(`link(${p.link})`, { GetClassType: () => "hyperlink", GetRange: () => ({ __label: `link range`, GetText: () => p.linkText ?? p.text }), GetElementsCount: () => 1, GetElement: () => rec(`run(${p.link})`, { GetClassType: () => "run", GetTextPr: () => ({ GetStyle: () => styles.Hyperlink }) }) }) : null;
    const elements = link ? [rec(`run(before ${p.text})`, { GetClassType: () => "run", GetRange: () => ({}), GetTextPr: () => ({ GetStyle: () => null }) }), link] : [];
    const para = rec(label, {
      GetClassType: () => "paragraph",
      GetText: (o?: { Numbering?: boolean }) => `${p.list && o?.Numbering !== false ? "·\t" : ""}${p.text}\r\n`,
      GetStyle: () => (p.style ? styles[p.style] : null),
      GetParaPr: () => ({ GetStyle: () => (p.style ? styles[p.style] : null) }),
      GetInternalId: () => `id${i}`,
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
      // A field's instruction in the paragraph's JSON (a TOC without entries holds its field so).
      ...(p.instr ? { ToJSON: () => JSON.stringify({ content: [{ type: "run", content: [{ type: "fldChar", fldCharType: "begin" }, { type: "instrText", instr: p.instr }] }, { type: "run", content: [p.text] }] }) } : {}),
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
    const json = () => JSON.stringify({ content: rows.map((ks) => ({ content: ks.map((k) => ({ tcPr: spec.paras[k].tcPr ?? {} })) })) });
    tables[p.table] = rec(`table(${p.table})`, { GetClassType: () => "table", GetRowsCount: () => count, GetRow: (r: number) => recs[r], GetColumnsCount: () => rows[0].length, ToJSON: json });
    body.push(tables[p.table]);
  });
  const own = (where: string, kind?: "text" | "picture") => rec(`${where} content`, { GetElementsCount: () => 1, GetElement: () => rec(`${where} paragraph`, { GetClassType: () => "paragraph", ToJSON: () => JSON.stringify({ content: [{ type: "run", content: kind === "picture" ? [{ docPr: {} }] : ["Old header"] }] }) }) });
  const sections = (spec.sections ?? [{ header: spec.header }]).map((x, k) => {
    const label = k === 0 ? "" : `section${k + 1} `;
    return rec(k === 0 ? "section" : `section${k + 1}`, { GetHeader: (_k: string, make: boolean) => (x.header || make ? own(`${label}header`, x.header) : null), GetFooter: (_k: string, make: boolean) => (make ? own(`${label}footer`) : null), GetPageWidth: () => (x.landscape ? 16838 : 11906), GetPageHeight: () => (x.landscape ? 11906 : 16838), GetPageMarginTop: () => 1134, GetPageMarginRight: () => 1134, GetPageMarginBottom: () => 1134, GetPageMarginLeft: () => 1134 });
  });
  const hit = (q: string, at: number, extra: Record<string, unknown> = {}) => rec(`range(${q}${at ? `@${at}` : ""})`, { GetText: () => q, GetTextPr: () => ({ GetHighlight: () => (spec.highlighted?.includes(q) ? "yellow" : "none") }), GetAllParagraphs: () => [extra.para ?? paras[at]], GetStartPos: () => at * 1000, GetEndPos: () => at * 1000 + q.length, IntersectWith: () => ({ GetText: () => q }), ExpandTo: (r: any) => rec(`range(${q}..${r.GetText()})`, { GetAllParagraphs: () => [paras[at], ...r.GetAllParagraphs()], GetText: () => q, IntersectWith: () => ({ GetText: () => q }) }), ...extra });
  const doc = rec("doc", {
    ...contentOf(body),
    GetStyle: (name: string) => styles[name] ?? null,
    GetAllStyles: () => Object.values(styles),
    CreateStyle: (name: string, type: string) => (calls.push(`doc.CreateStyle(${JSON.stringify(name)}, ${JSON.stringify(type)})`), style(name, type)),
    CreateNumbering: (kind: string) => (calls.push(`doc.CreateNumbering(${JSON.stringify(kind)})`), numbering(`new${++made}`, kind)),
    Search: (q: string) => {
      const found = spec.parted?.includes(q) ? [] : spec.paras.flatMap((p, i) => (p.text.includes(q) ? [hit(q, i)] : []));
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
    GetAllComments: () => [],
    CreateSection: (p: { __label: string }) => (calls.push(`doc.CreateSection(${p.__label})`), rec("new section")),
  });
  const Api = rec("Api", { GetDocument: () => doc, CreateTextPr: () => rec("textPr"), CreateParagraph: () => rec("new paragraph", { GetRange: () => rec("new paragraph's range"), GetSection: () => sections[0] }) });
  return { Api, calls, run: (ops: unknown[]) => command("word.format", Api, { ops }), edit: (ops: unknown[]) => command("word.edit", Api, { ops }) };
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
  const w = scriptedWord({ paras: [{ text: "Title" }, { text: "Wide" }], sections: [{}, { landscape: true }] });
  assert.deepEqual(w.run([{ toc: true, levels: 2 }]).result, { ops: 1, reflowed: true });
  const made = w.calls.filter((c) => /^section2\.Set|AddField|UpdateAllTOC|Api\.Save/.test(c));
  assert.deepEqual(made, [
    "section2.SetPageSize(11906, 11906, true)",
    "section2.SetPageMargins(1134, 1134, 1134, 1134)",
    'new paragraph\'s range.AddField("TOC \\\\o \\"1-2\\" \\\\h \\\\z \\\\u")',
    "section2.SetPageSize(16838, 11906, false)",
    "section2.SetPageMargins(1134, 1134, 1134, 1134)",
    // The entries again while the last section is as wide as the TOC's (a new entry takes its tab so), then the page
    // numbers with the last section as it is: counted with the other width, its pages came out one too many.
    "section2.SetPageSize(11906, 11906, true)",
    "section2.SetPageMargins(1134, 1134, 1134, 1134)",
    "doc.UpdateAllTOC(false)",
    "section2.SetPageSize(16838, 11906, false)",
    "section2.SetPageMargins(1134, 1134, 1134, 1134)",
    "doc.UpdateAllTOC(true)",
    "Api.Save()",
  ]);
  // One section, or sections alike across: nothing changed for it.
  const one = scriptedWord({ paras: [{ text: "Title" }] });
  one.run([{ toc: true, levels: 2 }]);
  assert.ok(!one.calls.some((c) => /SetPageSize|SetPageMargins/.test(c)), one.calls.join("\n"));
  assert.deepEqual(one.calls.filter((c) => /UpdateAllTOC/.test(c)), ["doc.UpdateAllTOC(false)", "doc.UpdateAllTOC(true)"]);
});

test("a table of contents follows every office_edit and office_format call that changed its document: its entries and page numbers, in the same command before the save, with the last section as wide as the TOC's for the entries", () => {
  const doc = () => scriptedWord({ paras: [{ text: "Findings\t1", style: "toc 1" }, { text: "Findings", style: "Heading 1" }, { text: "Body text" }, { text: "Wide", section: 1 }], sections: [{}, { landscape: true }] });
  const toc = (calls: string[]) => calls.filter((c) => /^section2\.Set|UpdateAllTOC|Api\.Save/.test(c));
  const after = [
    "section2.SetPageSize(11906, 11906, true)",
    "section2.SetPageMargins(1134, 1134, 1134, 1134)",
    "doc.UpdateAllTOC(false)",
    "section2.SetPageSize(16838, 11906, false)",
    "section2.SetPageMargins(1134, 1134, 1134, 1134)",
    "doc.UpdateAllTOC(true)",
    "Api.Save()",
  ];
  const edit = doc();
  assert.deepEqual(edit.edit([{ after: "Body text", paragraphs: ["Outlook"], style: "Heading 1" }]).result, { ops: 1, toc: true });
  assert.deepEqual(toc(edit.calls), after);
  const format = doc();
  assert.deepEqual(format.run([{ format: "Body text", text: { bold: true } }]).result, { ops: 1, toc: true });
  assert.deepEqual(toc(format.calls), after);
  // A TOC that lists no entries yet: the field's own paragraph, with the editor's text for it.
  const empty = scriptedWord({ paras: [{ text: "No table of contents entries found.", instr: 'TOC \\o "1-2" \\h \\z \\u' }, { text: "Body text" }] });
  assert.deepEqual(empty.edit([{ quote: "Body", replacement: "Main" }]).result, { ops: 1, toc: true });
  assert.deepEqual(empty.calls.filter((c) => /UpdateAllTOC/.test(c)), ["doc.UpdateAllTOC(false)", "doc.UpdateAllTOC(true)"]);
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

test("word.format: a page break and a table of contents go after their paragraph (a TOC at the start where none is given, as a TOC field); a footnote at the quote's end", () => {
  const w = scriptedWord({ paras: [{ text: "Title" }, { text: "There was a discrepancy." }] });
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
