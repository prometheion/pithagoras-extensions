/**
 * What the agents' browser loads (seat.ts serves it on the loopback listener, through the relay's way back): the seat
 * page, which opens one OnlyOffice editor for each document an agent works in, and the plugin each of those editors
 * runs, which takes the agent's edits from the listener and makes them in the document with one fixed command
 * function each. Static strings, with no build step: the page and the plugin run in the browser on the island, the
 * command functions inside the editor (the plugin hands their source to `Asc.plugin.callCommand`, which runs it with
 * the document's builder API, `Api`).
 *
 * The model never sends code: a job names one of the commands below (`word.read`, `word.edit`, `cell.read`,
 * `cell.edit`), and its arguments reach the command as data (`Asc.scope.args`).
 *
 * What the Document Server 10.0 does that the commands rely on (each checked by the end-to-end test):
 * - A command's return value comes back to the plugin as JSON; a command that throws comes back as undefined, and
 *   what it changed before it threw stays. So a command catches everything, says whether it changed anything yet
 *   (`touched`), and the plugin then takes that back with the editor's own Undo, which takes back exactly that
 *   command (one history point each).
 * - A quote is replaced by adding the new text after its range and then deleting the quote by its positions: a range
 *   grows over text added to it, and one whose run was deleted whole takes no text any more.
 * - A table goes in through its parent's `AddElement`: `InsertParagraph` takes paragraphs only.
 * - `GetText` ends a paragraph's text with "\r\n" (and a table cell's with "\t"), which is taken off.
 * - An editor sends its changes to the Document Server a moment after they were made; a forcesave asked before that
 *   finds nothing to save (error 4). `Api.Save()` at the end of an edit sends them at once.
 */

/** The plugin's GUID, which only the agents' editor configs name (server.ts): people's editors run no plugin. */
export const PLUGIN_GUID = "asc.{6f1e2d3c-4b5a-4c69-8e7f-a0b1c2d3e4f5}";

/** How long the page's and a plugin's long-polls are held by the listener when there is nothing for them. */
export const HOLD_MS = 25_000;

/**
 * The simulation of a Word edit, in plain JavaScript, inside the `word.edit` command: every op is checked in order on
 * the text of the document's paragraphs before anything is changed, and an earlier op that makes or takes away a
 * later op's quote is taken into account. A quote must be in the text exactly once at its turn, inside one paragraph.
 * `paras` is the paragraphs' text in reading order (a table's cells among them), `ops` the ops as ops.ts checked them.
 * Answers null where all of them hold, or the first failure: its code, the op's index (from 0) and a message.
 */
export const WORD_MODEL_SRC = `
function count(paras, quote) {
  var n = 0, at = -1;
  for (var i = 0; i < paras.length; i++) {
    var from = 0, k;
    while ((k = paras[i].indexOf(quote, from)) !== -1) { n++; if (at === -1) at = i; from = k + quote.length; }
  }
  return { n: n, at: at };
}
function nearest(paras, quote) {
  var fold = function (s) { return s.toLowerCase().replace(/\\s+/g, " ").trim(); };
  var q = fold(quote);
  for (var i = 0; i < paras.length; i++) {
    var p = fold(paras[i]), k = p.indexOf(q);
    if (q && k !== -1) return paras[i].length > 160 ? "..." + p.slice(Math.max(0, k - 40), k + q.length + 40) + "..." : paras[i];
  }
  for (var len = Math.min(quote.length - 1, 60); len >= 8; len--) {
    var head = quote.slice(0, len);
    for (var j = 0; j < paras.length; j++) {
      var h = paras[j].indexOf(head);
      if (h !== -1) return paras[j].slice(Math.max(0, h - 20), h + quote.length + 20);
    }
  }
  return "";
}
function located(paras, quote, i, what) {
  var c = count(paras, quote);
  if (c.n === 1) return { at: c.at };
  if (c.n === 0) {
    var near = nearest(paras, quote);
    return { error: { code: "quote_not_found", op: i, message: "op " + (i + 1) + ": the " + what + " " + JSON.stringify(quote) + " is not in the document" + (near ? " (nearest: " + JSON.stringify(near) + ")" : "") } };
  }
  return { error: { code: "quote_ambiguous", op: i, message: "op " + (i + 1) + ": the " + what + " " + JSON.stringify(quote) + " is in the document " + c.n + " times; quote more of it" } };
}
function simulateWord(paras, ops) {
  paras = paras.slice();
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i], l;
    if (typeof op.quote === "string") {
      l = located(paras, op.quote, i, "quote");
      if (l.error) return l.error;
      paras[l.at] = paras[l.at].replace(op.quote, function () { return op.replacement; });
    } else if (typeof op.remove === "string") {
      l = located(paras, op.remove, i, "quote");
      if (l.error) return l.error;
      paras.splice(l.at, 1);
    } else {
      var added = op.table ? [].concat.apply([], op.table) : op.paragraphs;
      if (typeof op.after === "string") {
        l = located(paras, op.after, i, "anchor");
        if (l.error) return l.error;
        paras.splice.apply(paras, [l.at + 1, 0].concat(added));
      } else paras.push.apply(paras, added);
    }
  }
  return null;
}
`;

/** Every paragraph of a document's content in reading order, a table's cells and a content control's own among them,
 * with its text as the simulation sees it. Inside the commands. */
const WORD_COLLECT_SRC = `
function clean(s) { return String(s == null ? "" : s).replace(/[\\r\\n\\t]+$/, ""); }
function collect(content, out) {
  for (var i = 0; i < content.GetElementsCount(); i++) {
    var el = content.GetElement(i), type = el.GetClassType();
    if (type === "paragraph") out.push({ p: el, text: clean(el.GetText()) });
    else if (type === "table") {
      for (var r = 0; r < el.GetRowsCount(); r++) {
        var row = el.GetRow(r);
        for (var c = 0; c < row.GetCellsCount(); c++) collect(row.GetCell(c).GetContent(), out);
      }
    } else if (type === "blockLvlSdt") collect(el.GetContent(), out);
  }
  return out;
}
function cellText(cell) { return collect(cell.GetContent(), []).map(function (x) { return x.text; }).join(" / "); }
`;

/** word.read: the document's blocks, in order: a paragraph's text (and its style where it has one other than the
 * default), a table's rows of cell texts. */
const WORD_READ = `function () {
  ${WORD_COLLECT_SRC}
  try {
    var doc = Api.GetDocument(), blocks = [];
    var add = function (content) {
      for (var i = 0; i < content.GetElementsCount(); i++) {
        var el = content.GetElement(i), type = el.GetClassType();
        if (type === "paragraph") {
          var style = "";
          try { var st = el.GetParaPr().GetStyle(); style = st ? st.GetName() : ""; } catch (e) { style = ""; }
          blocks.push(style && style !== "Normal" ? { p: clean(el.GetText()), style: style } : { p: clean(el.GetText()) });
        } else if (type === "table") {
          var rows = [];
          for (var r = 0; r < el.GetRowsCount(); r++) {
            var row = el.GetRow(r), cells = [];
            for (var c = 0; c < row.GetCellsCount(); c++) cells.push(cellText(row.GetCell(c)));
            rows.push(cells);
          }
          blocks.push({ table: rows });
        } else if (type === "blockLvlSdt") add(el.GetContent());
      }
    };
    add(doc);
    return { result: { blocks: blocks } };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) } };
  }
}`;

/** word.edit: every op checked on the text first (WORD_MODEL_SRC), then made, each found again in the document as it
 * stands then; anything that does not hold throws, and what was changed by then is taken back by the plugin. */
const WORD_EDIT = `function () {
  ${WORD_COLLECT_SRC}
  ${WORD_MODEL_SRC}
  var touched = false;
  try {
    var doc = Api.GetDocument(), ops = Asc.scope.args.ops;
    var failed = simulateWord(collect(doc, []).map(function (x) { return x.text; }), ops);
    if (failed) return { error: failed, touched: false };
    for (var s = 0; s < ops.length; s++) {
      if (ops[s].style && !doc.GetStyle(ops[s].style)) return { error: { code: "bad_op", op: s, message: "op " + (s + 1) + ": the document has no style " + JSON.stringify(ops[s].style) }, touched: false };
    }
    var one = function (quote, i) {
      var found = doc.Search(quote, true) || [];
      if (found.length !== 1) throw { code: found.length ? "quote_ambiguous" : "quote_not_found", op: i, message: "op " + (i + 1) + ": " + JSON.stringify(quote) + " is in the document " + found.length + " times as the editor searches it" };
      return found[0];
    };
    var paragraphOf = function (range) { var all = range.GetAllParagraphs(); return all[all.length - 1]; };
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (typeof op.quote === "string") {
        var range = one(op.quote, i), start = range.GetStartPos(), end = range.GetEndPos();
        touched = true;
        if (op.replacement) range.AddText(op.replacement, "after");
        doc.GetRange(start, end).Delete();
      } else if (typeof op.remove === "string") {
        var gone = paragraphOf(one(op.remove, i));
        touched = true;
        gone.Delete();
      } else {
        var anchor = typeof op.after === "string" ? paragraphOf(one(op.after, i)) : null;
        var made = [];
        if (op.table) {
          var cols = op.table[0].length, table = Api.CreateTable(cols, op.table.length);
          for (var r = 0; r < op.table.length; r++) for (var c = 0; c < cols; c++) if (op.table[r][c]) table.GetCell(r, c).GetContent().GetElement(0).AddText(op.table[r][c]);
          var grid = doc.GetStyle("Table Grid");
          if (grid) table.SetStyle(grid);
          made.push(table);
        } else {
          var style = op.style ? doc.GetStyle(op.style) : null;
          for (var k = 0; k < op.paragraphs.length; k++) {
            var para = Api.CreateParagraph();
            if (op.paragraphs[k]) para.AddText(op.paragraphs[k]);
            if (style) para.SetStyle(style);
            made.push(para);
          }
        }
        touched = true;
        if (anchor) {
          var parent = anchor.GetParent(), pos = anchor.GetPosInParent();
          for (var m = 0; m < made.length; m++) parent.AddElement(pos + 1 + m, made[m]);
        } else for (var e = 0; e < made.length; e++) doc.Push(made[e]);
      }
    }
    // Sent to the Document Server now, not at the editor's next pause: the forcesave after the edit saves it.
    Api.Save();
    return { result: { ops: ops.length } };
  } catch (err) {
    var code = err && err.code ? err : { code: "failed", message: String(err && err.message || err) };
    return { error: code, touched: touched };
  }
}`;

/** A1 addresses inside the cell commands. */
const CELL_ADDRESS_SRC = `
function colName(n) { var s = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }
function colIndex(letters) { var n = 0; for (var i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64; return n - 1; }
function grid(v) { return Array.isArray(v) ? (v.length && !Array.isArray(v[0]) ? [v] : v) : [[v]]; }
`;

/** The most cells of one sheet cell.read gives. */
export const MAX_READ_CELLS = 20_000;

/** cell.read: each sheet (or the one asked for): the cells of its used range that hold anything, by address, with the
 * value and, where the cell has one, the formula. */
const CELL_READ = `function () {
  ${CELL_ADDRESS_SRC}
  try {
    var want = Asc.scope.args.sheet, sheets = want ? [Api.GetSheet(want)] : Api.GetSheets();
    if (want && !sheets[0]) return { error: { code: "not_found", message: "there is no sheet named " + JSON.stringify(want) + " (the sheets: " + Api.GetSheets().map(function (s) { return s.GetName(); }).join(", ") + ")" } };
    var out = [];
    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i], used = sheet.GetUsedRange(), address = String(used.GetAddress(false, false));
      var m = /^([A-Z]+)(\\d+)/.exec(address), col0 = m ? colIndex(m[1]) : 0, row0 = m ? Number(m[2]) - 1 : 0;
      var rows = used.GetRowsCount(), cols = used.GetColumnsCount(), truncated = false;
      if (rows * cols > ${MAX_READ_CELLS}) { rows = Math.max(1, Math.floor(${MAX_READ_CELLS} / cols)); truncated = true; }
      var range = truncated ? sheet.GetRange(colName(col0) + (row0 + 1) + ":" + colName(col0 + cols - 1) + (row0 + rows)) : used;
      var values = grid(range.GetValue()), formulas = grid(range.GetFormula()), cells = [];
      for (var r = 0; r < values.length; r++) for (var c = 0; c < values[r].length; c++) {
        var v = values[r][c], f = formulas[r] ? formulas[r][c] : "";
        if (v === "" && !(typeof f === "string" && f.charAt(0) === "=")) continue;
        var cell = { a: colName(col0 + c) + (row0 + r + 1), v: v };
        if (typeof f === "string" && f.charAt(0) === "=") cell.f = f;
        cells.push(cell);
      }
      out.push({ name: sheet.GetName(), range: address, cells: cells, truncated: truncated });
    }
    return { result: { sheets: out } };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) } };
  }
}`;

/** cell.edit: each op's values written into its range; every sheet named checked first. */
const CELL_EDIT = `function () {
  var touched = false;
  try {
    var ops = Asc.scope.args.ops, first = Api.GetSheets()[0];
    for (var s = 0; s < ops.length; s++) {
      if (ops[s].sheet && !Api.GetSheet(ops[s].sheet)) return { error: { code: "not_found", op: s, message: "op " + (s + 1) + ": there is no sheet named " + JSON.stringify(ops[s].sheet) + " (the sheets: " + Api.GetSheets().map(function (x) { return x.GetName(); }).join(", ") + ")" }, touched: false };
    }
    var cells = 0;
    for (var i = 0; i < ops.length; i++) {
      var sheet = ops[i].sheet ? Api.GetSheet(ops[i].sheet) : first;
      var values = ops[i].values;
      touched = true;
      // One cell takes its value, a range its rows of values.
      sheet.GetRange(ops[i].range).SetValue(values.length === 1 && values[0].length === 1 ? values[0][0] : values);
      cells += ops[i].values.length * ops[i].values[0].length;
    }
    Api.Save();
    return { result: { cells: cells } };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) }, touched: touched };
  }
}`;

/** The job kinds and the command each runs; edits recalculate the document after them, reads do not. */
export const COMMANDS: Record<string, { source: string; edit: boolean }> = {
  "word.read": { source: WORD_READ, edit: false },
  "word.edit": { source: WORD_EDIT, edit: true },
  "cell.read": { source: CELL_READ, edit: false },
  "cell.edit": { source: CELL_EDIT, edit: true },
};

/**
 * The plugin: it long-polls its editor's jobs from the listener (`next`, at the address it was loaded from, which
 * carries its editor's token), runs each job's command, takes back a command that failed after it changed something
 * (Undo), and posts the outcome (`done`). It knows nothing but its token, and runs nothing but the commands above.
 */
export const BRIDGE_JS = `(function () {
  var base = location.pathname.replace(/[^/]*$/, "");
  var commands = {
${Object.entries(COMMANDS).map(([kind, c]) => `    ${JSON.stringify(kind)}: { run: ${c.source}, edit: ${c.edit} }`).join(",\n")}
  };
  var stopped = false;
  function poll() {
    if (stopped) return;
    fetch(base + "next", { method: "POST", cache: "no-store" }).then(function (r) {
      if (r.status === 404) { stopped = true; return null; }
      return r.status === 200 ? r.json() : null;
    }).then(function (job) {
      if (job) run(job); else if (!stopped) poll();
    }, function () { setTimeout(poll, 1000); });
  }
  function done(job, outcome) {
    outcome.jobId = job.jobId;
    fetch(base + "done", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(outcome) }).then(poll, function () { setTimeout(poll, 1000); });
  }
  function run(job) {
    var command = commands[job.kind];
    if (!command) return done(job, { error: { code: "bad_op", message: "no command " + job.kind } });
    window.Asc.scope.args = job.args;
    window.Asc.plugin.callCommand(command.run, false, command.edit, function (outcome) {
      if (!outcome || typeof outcome !== "object") return done(job, { error: { code: "failed", message: "the editor ran the command but gave nothing back" } });
      if (outcome.error && outcome.touched) {
        window.Asc.plugin.executeMethod("Undo", [], function () { done(job, { error: outcome.error, undone: true }); });
        return;
      }
      done(job, outcome.error ? { error: outcome.error } : { result: outcome.result });
    });
  }
  window.Asc.plugin.init = function () { poll(); };
  window.Asc.plugin.button = function () {};
})();
`;

/** The plugin's config.json: a system plugin (it runs in the background from the start, shows nowhere, and nobody
 * can switch it off in the editor), in Word and Excel, in edit and view mode. */
export function pluginConfig(): string {
  return JSON.stringify({
    name: "Pithagoras agent",
    guid: PLUGIN_GUID,
    version: "1.0.0",
    variations: [
      {
        description: "The agent's edits",
        url: "index.html",
        icons: [],
        isViewer: true,
        EditorsSupport: ["word", "cell"],
        type: "system",
        isVisual: false,
        isModal: false,
        isInsideMode: false,
        initDataType: "none",
        initData: "",
        buttons: [],
        events: [],
      },
    ],
  });
}

/** The plugin's page: OnlyOffice's plugin SDK, from the Document Server itself (`ds`, its origin on the island), and
 * the bridge. */
export function pluginIndex(ds: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><script src="${ds}/sdkjs-plugins/v1/plugins.js"></script><script src="bridge.js"></script></head><body></body></html>`;
}

/**
 * The seat page: it long-polls the listener (`poll`) for what to open and close, opens each editor in a frame of its
 * own (`new DocsAPI.DocEditor`, with the config the half minted and signed), and tells the listener what each editor
 * says of itself (`event`: ready, or an error, which ends the wait for it).
 */
export const SEAT_PAGE_JS = `(function () {
  var apis = {};
  var editors = {};
  function load(src) {
    if (!apis[src]) apis[src] = new Promise(function (ok, no) {
      var s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = function () { delete apis[src]; no(new Error("could not load " + src)); };
      document.head.appendChild(s);
    });
    return apis[src];
  }
  function tell(editorId, type, data) {
    fetch("event", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ editorId: editorId, type: type, data: data }) }).catch(function () {});
  }
  function open(order) {
    load(order.apiJs).then(function () {
      var box = document.createElement("div");
      box.id = "editor-" + order.editorId;
      document.body.appendChild(box);
      var config = order.config;
      config.events = {
        onDocumentReady: function () { tell(order.editorId, "ready"); },
        onError: function (e) { tell(order.editorId, "error", e && e.data); }
      };
      editors[order.editorId] = new window.DocsAPI.DocEditor(box.id, config);
    }, function (e) { tell(order.editorId, "error", { errorDescription: String(e && e.message || e) }); });
  }
  function close(editorId) {
    var editor = editors[editorId];
    delete editors[editorId];
    try { if (editor) editor.destroyEditor(); } catch (e) {}
    var box = document.getElementById("editor-" + editorId);
    if (box) box.remove();
  }
  function poll() {
    fetch("poll", { cache: "no-store" }).then(function (r) {
      if (r.status === 404) return "gone";
      return r.status === 200 ? r.json() : null;
    }).then(function (order) {
      if (order === "gone") return setTimeout(poll, 30000);
      if (order && order.open) open(order.open);
      if (order && order.close) close(order.close);
      poll();
    }, function () { setTimeout(poll, 1000); });
  }
  poll();
})();
`;

export const SEAT_PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Office agents</title><style>body{margin:0}div[id^=editor-]{width:1280px;height:900px}</style></head><body><script src="page.js"></script></body></html>`;
