/**
 * Unit tests for src/seat-page.ts as the agents' browser runs it, without a browser: the seat page's script in a
 * context of its own with the few things of a page it uses (fetch, a document, the editor's DocsAPI) scripted, and the
 * read commands with a scripted builder API (`Api`). What the real editor does with them is the end-to-end test's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { setImmediate as tick } from "node:timers/promises";
import { COMMANDS, MAX_READ_TEXT, SEAT_PAGE_JS } from "../src/seat-page";

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
  return { GetName: () => name, GetUsedRange: () => range, GetRange: () => range };
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
