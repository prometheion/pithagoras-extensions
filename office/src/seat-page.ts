/**
 * What the agents' browser loads (seat.ts serves it on the loopback listener, through the relay's way back): the seat
 * page, which opens one OnlyOffice editor for each document an agent works in, and the plugin each of those editors
 * runs, which takes the agent's edits from the listener and makes them in the document with one fixed command
 * function each. Static strings, with no build step: the page and the plugin run in the agents' browser, the
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
 * - A table goes in through its parent's `AddElement`: `InsertParagraph` takes paragraphs only. `Api.CreateTable`
 *   takes the number of rows first.
 * - `GetText` ends a paragraph's text with "\r\n" (and a table cell's with "\t"), which is taken off.
 * - An editor sends its changes to the Document Server a moment after they were made, and a forcesave saves what the
 *   Document Server has: one asked before that misses the edit (error 4 where nothing else is unsaved, or a save of
 *   the people's typing alone). `Api.Save()` at the end of an edit sends them sooner, and the seat waits until the
 *   editor says they are sent (onDocumentStateChange false) before the save is asked for.
 * - In the spreadsheet editor, `Api.AddSheet`, `ApiWorksheet.Move` and `Delete` only ask for the change (the workbook
 *   is locked through the Document Server first): the sheet changes after the command returned, for the person too.
 *   `SetName` and `SetVisible` change it at once, and a rename carries the formulas that name the sheet along. A
 *   command cannot reach the editor's own API (`Asc.editor`), so a sheet is copied as a new sheet given the values,
 *   formulas, number formats and column widths of the old one. `ApiRange.Copy` and `Paste` into another sheet are
 *   not used: the old sheet's formulas computed no more after them. The editor's Undo takes back nothing of a
 *   spreadsheet command, and `Api.GetSheet` finds a name only in its own case.
 * - A moved sheet becomes the editor's active sheet, and a hidden sheet made active is shown again; a hidden sheet's
 *   move never reached the person's editor, and the agent's editor lost the sheet changes after it. So only visible
 *   sheets are moved. Hiding the active sheet makes the next visible one active.
 * - `ApiRange.SetValue` answers false where it did not take a value (a formula it cannot read, such as "=SUM(", or a
 *   protected sheet), and writes the range's other cells all the same. It reads a text as Excel's input does ("00123"
 *   becomes 123, "10%" 0.1 with a percent format), except in a cell formatted as text ("@").
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

/** The most text the read commands give, in characters: what office_read shows at most (its own cap), and so far below
 * the size a plugin's result may have (seat.LIMITS.maxDone) that a long document never fails its read. */
export const MAX_READ_TEXT = 200_000;

/** word.read: the document's blocks, in order: a paragraph's text (and its style where it has one other than the
 * default), a table's rows of cell texts; up to MAX_READ_TEXT characters (`truncated` where the document goes on). */
const WORD_READ = `function () {
  ${WORD_COLLECT_SRC}
  try {
    var doc = Api.GetDocument(), blocks = [], size = 0, truncated = false;
    var add = function (content) {
      for (var i = 0; i < content.GetElementsCount(); i++) {
        if (size > ${MAX_READ_TEXT}) { truncated = true; return; }
        var el = content.GetElement(i), type = el.GetClassType();
        if (type === "paragraph") {
          var style = "";
          try { var st = el.GetParaPr().GetStyle(); style = st ? st.GetName() : ""; } catch (e) { style = ""; }
          var text = clean(el.GetText());
          size += text.length;
          blocks.push(style && style !== "Normal" ? { p: text, style: style } : { p: text });
        } else if (type === "table") {
          var rows = [];
          for (var r = 0; r < el.GetRowsCount(); r++) {
            var row = el.GetRow(r), cells = [];
            for (var c = 0; c < row.GetCellsCount(); c++) {
              var t = cellText(row.GetCell(c));
              size += t.length;
              cells.push(t);
            }
            rows.push(cells);
            if (size > ${MAX_READ_TEXT}) { truncated = true; break; }
          }
          blocks.push({ table: rows });
        } else if (type === "blockLvlSdt") add(el.GetContent());
      }
    };
    add(doc);
    return { result: truncated ? { blocks: blocks, truncated: true } : { blocks: blocks } };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) } };
  }
}`;

/** A comment as the comment commands give it: author, user id, time (ms, UTC), solved, the text it is on, its text and
 * its replies. `COMMENT_SRC` runs inside a command. */
const COMMENT_SRC = `
// A getter the builder API of this Document Server may not have (a reply has no GetTimeUTC in 10.0): nothing then.
function ask(o, name) { try { return o && typeof o[name] === "function" ? o[name]() : undefined; } catch (e) { return undefined; } }
function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }
function described(c) {
  var replies = [], n = 0;
  try { n = c.GetRepliesCount(); } catch (e) { n = 0; }
  for (var r = 0; r < n; r++) {
    var reply = c.GetReply(r);
    if (reply) replies.push({ author: String(ask(reply, "GetAuthorName") || ""), userId: String(ask(reply, "GetUserId") || ""), time: Number(ask(reply, "GetTimeUTC") || ask(reply, "GetTime")) || 0, text: clip(ask(reply, "GetText"), 20000) });
  }
  var quote = "";
  try { quote = typeof c.GetQuoteText === "function" ? String(c.GetQuoteText() || "") : ""; } catch (e) { quote = ""; }
  return { author: String(c.GetAuthorName() || ""), userId: String(c.GetUserId() || ""), time: Number(c.GetTimeUTC()) || 0, solved: Boolean(c.IsSolved()), quote: clip(quote, 2000), text: clip(c.GetText(), 20000), replies: replies };
}
function hexId(c) { var id = Number(c.GetId()); return isFinite(id) && id >= 0 ? ("00000000" + id.toString(16)).slice(-8) : String(c.GetId()); }
`;

/** word.edit: every op checked on the text first (WORD_MODEL_SRC), then made, each found again in the document as it
 * stands then; anything that does not hold throws, and what was changed by then is taken back by the plugin. */
const WORD_EDIT = `function () {
  ${WORD_COLLECT_SRC}
  ${WORD_MODEL_SRC}
  ${COMMENT_SRC}
  var touched = false, moved = [];
  // The comments of the document by id, before an op that deletes text: a comment whose text the op takes away goes
  // with it, which would end its thread and the chat that belongs to it. Each is made again where the op leaves text
  // (keep), with its author, time, state and replies, and the move is said in the answer: its thread's old GUID and new.
  var comments = function () { var out = {}; (doc.GetAllComments() || []).forEach(function (c) { out[String(c.GetId())] = c; }); return out; };
  var keep = function (before, target) {
    var now = comments();
    for (var id in before) {
      if (now[id] || !target) continue;
      var d = described(before[id]), old = hexId(before[id]);
      var made = target.AddComment(d.text, d.author, d.userId);
      if (!made) continue;
      try { made.SetTimeUTC(d.time); } catch (e) {}
      try { made.SetSolved(d.solved); } catch (e) {}
      for (var r = 0; r < d.replies.length; r++) {
        try { made.AddReply(d.replies[r].text, d.replies[r].author, d.replies[r].userId); } catch (e) {}
        try { var reply = made.GetReply(r); if (reply && d.replies[r].time) reply.SetTimeUTC(d.replies[r].time); } catch (e) {}
      }
      moved.push([old, hexId(made)]);
    }
  };
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
        var range = one(op.quote, i), start = range.GetStartPos(), end = range.GetEndPos(), held = comments(), home = paragraphOf(range);
        touched = true;
        if (op.replacement) range.AddText(op.replacement, "after");
        doc.GetRange(start, end).Delete();
        // The replacement, found by the editor's own search where it is in the document once (a range made from the
        // quote's positions came out a character short in DS 10.0), else from those positions.
        var placed = op.replacement ? doc.Search(op.replacement, true) || [] : [];
        keep(held, op.replacement ? (placed.length === 1 ? placed[0] : doc.GetRange(start, start + op.replacement.length)) : home && home.GetRange());
      } else if (typeof op.remove === "string") {
        var gone = paragraphOf(one(op.remove, i)), before = comments(), next = gone.GetNext() || gone.GetPrevious();
        touched = true;
        gone.Delete();
        keep(before, next && next.GetRange());
      } else {
        var anchor = typeof op.after === "string" ? paragraphOf(one(op.after, i)) : null;
        var made = [];
        if (op.table) {
          // DS 10.0 takes the rows first (its own check names them so); the builder API's older documentation has the
          // columns first. Made again the other way round where the table did not come out as asked.
          var cols = op.table[0].length, rows = op.table.length, table = Api.CreateTable(rows, cols);
          if (table.GetRowsCount() !== rows) table = Api.CreateTable(cols, rows);
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
    return { result: moved.length ? { ops: ops.length, moved: moved } : { ops: ops.length } };
  } catch (err) {
    var code = err && err.code ? err : { code: "failed", message: String(err && err.message || err) };
    return { error: code, touched: touched };
  }
}`;

/**
 * The simulation of a spreadsheet edit, in plain JavaScript, inside the `cell.edit` command, as WORD_MODEL_SRC is the
 * Word edit's: every op checked in order on the workbook's sheets before anything is changed, an earlier op's sheets
 * taken into account (a sheet the call makes can be written into, one it renamed is found by its new name only).
 * `sheets` is the workbook's sheets in order, `{name, hidden}`, `ops` the ops as ops.ts checked them. A sheet is named
 * case-insensitively, as Excel does. Answers null where all of them hold, or the first failure: its code, the op's
 * index (from 0) and a message.
 */
export const SHEET_MODEL_SRC = `
function sheetAt(sheets, name) {
  var key = String(name).toLowerCase();
  for (var i = 0; i < sheets.length; i++) if (sheets[i].name.toLowerCase() === key) return i;
  return -1;
}
function simulateSheets(sheets, ops) {
  sheets = sheets.map(function (s) { return { name: s.name, hidden: Boolean(s.hidden) }; });
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i], n = "op " + (i + 1) + ": ", j = -1, at;
    var names = function () { return sheets.map(function (s) { return JSON.stringify(s.name); }).join(", "); };
    var fail = function (code, message) { return { code: code, op: i, message: n + message }; };
    var named = op.sheet !== undefined ? op.sheet : op.renameSheet !== undefined ? op.renameSheet : op.moveSheet !== undefined ? op.moveSheet : op.copySheet !== undefined ? op.copySheet : op.hideSheet !== undefined ? op.hideSheet : op.showSheet !== undefined ? op.showSheet : op.deleteSheet;
    if (named !== undefined) {
      j = sheetAt(sheets, named);
      if (j === -1) return fail("not_found", "there is no sheet named " + JSON.stringify(named) + " (the sheets: " + names() + ")");
    }
    var made = op.addSheet !== undefined ? op.addSheet : op.to;
    if (made !== undefined) {
      var k = sheetAt(sheets, made);
      if (k !== -1 && !(op.renameSheet !== undefined && k === j)) return fail("sheet_exists", "there is a sheet named " + JSON.stringify(sheets[k].name) + " already (names are told apart without case)");
    }
    var most = sheets.length + (op.addSheet !== undefined || op.copySheet !== undefined ? 1 : 0);
    if (op.position !== undefined && op.position > most) return fail("bad_op", "position " + op.position + " is past the end: the sheets go up to " + most + " here");
    var visibleBesides = sheets.filter(function (s, x) { return x !== j && !s.hidden; }).length;
    if (typeof op.range === "string") continue;
    if (op.addSheet !== undefined) {
      at = op.position !== undefined ? op.position : sheets.length + 1;
      sheets.splice(at - 1, 0, { name: op.addSheet, hidden: false });
    } else if (op.renameSheet !== undefined) {
      sheets[j].name = op.to;
    } else if (op.moveSheet !== undefined) {
      if (sheets[j].hidden) return fail("sheet_hidden", JSON.stringify(sheets[j].name) + " is hidden, and the editor moves visible sheets only: show it, move it and hide it again (one call can do all three)");
      sheets.splice(op.position - 1, 0, sheets.splice(j, 1)[0]);
    } else if (op.copySheet !== undefined) {
      at = op.position !== undefined ? op.position : j + 2;
      sheets.splice(at - 1, 0, { name: op.to, hidden: false });
    } else if (op.hideSheet !== undefined) {
      if (!sheets[j].hidden && visibleBesides === 0) return fail("last_visible_sheet", JSON.stringify(sheets[j].name) + " is the only visible sheet, and a workbook shows one at least: show another first");
      sheets[j].hidden = true;
    } else if (op.showSheet !== undefined) {
      sheets[j].hidden = false;
    } else if (op.deleteSheet !== undefined) {
      if (!sheets[j].hidden && visibleBesides === 0) return fail("last_visible_sheet", JSON.stringify(sheets[j].name) + " is the " + (sheets.length === 1 ? "only sheet" : "only visible sheet") + ", and a workbook keeps one visible sheet at least");
      sheets.splice(j, 1);
    }
  }
  return null;
}
`;

/** A1 addresses inside the cell commands. */
const CELL_ADDRESS_SRC = `
function colName(n) { var s = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }
function colIndex(letters) { var n = 0; for (var i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64; return n - 1; }
function grid(v) { return Array.isArray(v) ? (v.length && !Array.isArray(v[0]) ? [v] : v) : [[v]]; }
`;

/** The most cells of one sheet cell.read gives. */
export const MAX_READ_CELLS = 20_000;

/** cell.read: every sheet of the workbook in order, by name and whether it is hidden (`book`, also the empty ones), and
 * each sheet (or the one asked for, named case-insensitively): the cells of its used range that hold anything, by
 * address, with the value and, where the cell has one, the formula; up to MAX_READ_CELLS cells of a sheet, and
 * MAX_READ_TEXT characters of all of them (a sheet cut short is `truncated`, one not read at all for that `skipped` too). */
const CELL_READ = `function () {
  ${CELL_ADDRESS_SRC}
  ${SHEET_MODEL_SRC}
  try {
    var all = Api.GetSheets(), book = all.map(function (s) { return { name: s.GetName(), hidden: !s.GetVisible() }; });
    var want = Asc.scope.args.sheet, at = want ? sheetAt(book, want) : -1, sheets = want ? [all[at]] : all;
    if (want && at === -1) return { error: { code: "not_found", message: "there is no sheet named " + JSON.stringify(want) + " (the sheets: " + book.map(function (s) { return JSON.stringify(s.name); }).join(", ") + ")" } };
    var out = [], size = 0;
    for (var i = 0; i < sheets.length; i++) {
      if (size > ${MAX_READ_TEXT}) { out.push({ name: sheets[i].GetName(), range: "", cells: [], truncated: true, skipped: true }); continue; }
      var sheet = sheets[i], used = sheet.GetUsedRange(), address = String(used.GetAddress(false, false));
      var m = /^([A-Z]+)(\\d+)/.exec(address), col0 = m ? colIndex(m[1]) : 0, row0 = m ? Number(m[2]) - 1 : 0;
      var rows = used.GetRowsCount(), cols = used.GetColumnsCount(), truncated = false;
      if (rows * cols > ${MAX_READ_CELLS}) { rows = Math.max(1, Math.floor(${MAX_READ_CELLS} / cols)); truncated = true; }
      var range = truncated ? sheet.GetRange(colName(col0) + (row0 + 1) + ":" + colName(col0 + cols - 1) + (row0 + rows)) : used;
      var values = grid(range.GetValue()), formulas = grid(range.GetFormula()), cells = [];
      for (var r = 0; r < values.length; r++) for (var c = 0; c < values[r].length; c++) {
        var v = values[r][c], f = formulas[r] ? formulas[r][c] : "";
        if (v === "" && !(typeof f === "string" && f.charAt(0) === "=")) continue;
        if (size > ${MAX_READ_TEXT}) { truncated = true; break; }
        var cell = { a: colName(col0 + c) + (row0 + r + 1), v: v };
        if (typeof f === "string" && f.charAt(0) === "=") cell.f = f;
        size += cell.a.length + String(v).length + (cell.f ? cell.f.length : 0);
        cells.push(cell);
      }
      out.push({ name: sheet.GetName(), range: address, cells: cells, truncated: truncated });
    }
    return { result: { book: book, sheets: out } };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) } };
  }
}`;

/**
 * cell.edit is not one command but a few, in turn, which the plugin runs (BRIDGE_JS, `cellEdit`): in the spreadsheet
 * editor of DS 10.0 a command that makes, moves or deletes a sheet only asks for it (the workbook is locked through
 * the Document Server first, and the sheet changes when the answer comes, after the command returned), and the
 * editor's Undo does not take back what a spreadsheet command did. So the plugin checks the whole edit first
 * (`check`, SHEET_MODEL_SRC), then makes one sheet op, or one run of cell ops, at a time (`step`), waits where an op
 * changes the sheets until the editor shows the change (`sheets`), and where an op fails takes back the ops before it,
 * in reverse, with what each step said would undo it; a sheet the edit deletes is only renamed out of the way and
 * hidden until every op is made, and deleted then. Every step finds its sheets by name again, on the workbook as it
 * stands at its turn.
 */
const CELL_CHECK = `function () {
  ${SHEET_MODEL_SRC}
  try {
    var failed = simulateSheets(Api.GetSheets().map(function (s) { return { name: s.GetName(), hidden: !s.GetVisible() }; }), Asc.scope.args.ops);
    return failed ? { error: failed } : { result: {} };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) } };
  }
}`;

/** The workbook's sheets in order, by name and whether each is hidden: what the plugin waits on. */
const CELL_SHEETS = `function () {
  try {
    return { result: Api.GetSheets().map(function (s) { return { name: s.GetName(), hidden: !s.GetVisible() }; }) };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) } };
  }
}`;

/** The edit's changes sent to the Document Server now, not at the editor's next pause: the forcesave after the edit
 * saves them. */
const CELL_SAVE = `function () {
  try {
    Api.Save();
    return { result: {} };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) } };
  }
}`;

/**
 * One op of a spreadsheet edit (`Asc.scope.args`: `op`, its `index`, and `pending`, the names the sheets this edit
 * deletes have until it ends, which the op does not see). Besides the sheet ops of ops.ts, the steps the plugin makes
 * of them: `writes` (a run of cell ops one after the other, each with its own `index`), `fillSheet` (a copy's values,
 * formulas, number formats and column widths from `from`), `restoreSheet` (a deleted sheet back, as `to`), `dropSheet` (a sheet deleted for good),
 * `restoreCells` (cells put back as they were). `real` names a sheet by its name exactly, pending ones included.
 * Answers what the plugin goes on with: `inverse` (the step that takes this one back), `expect` (what the sheets show
 * once the editor made it: a name there, `has`, gone, `gone`, or their `order`), `then` (the next step of the same
 * op), `pending` (a sheet now waiting to be deleted), `cells` (how many cells it wrote). A step that fails answers its
 * error, and `broken` where it could not take back what it had changed itself.
 */
const CELL_STEP = `function () {
  ${CELL_ADDRESS_SRC}
  ${SHEET_MODEL_SRC}
  var args = Asc.scope.args, op = args.op, i = args.index, pending = args.pending || [];
  try {
    var all = Api.GetSheets(), realNames = all.map(function (s) { return s.GetName(); });
    var shown = all.filter(function (s) { return pending.indexOf(s.GetName()) === -1; }), shownNames = shown.map(function (s) { return s.GetName(); });
    var named = function (name, at) {
      var list = op.real ? all : shown, found = sheetAt(list.map(function (s) { return { name: s.GetName() }; }), name), n = at === undefined ? i : at;
      if (found === -1) throw { code: "not_found", op: n, message: "op " + (n + 1) + ": there is no sheet named " + JSON.stringify(name) + " (the sheets: " + shownNames.map(function (x) { return JSON.stringify(x); }).join(", ") + ")" };
      return list[found];
    };
    var visible = function () { return all.filter(function (s) { return s.GetVisible(); }).length; };
    var lastVisible = function (name) { return { code: "last_visible_sheet", op: i, message: "op " + (i + 1) + ": " + JSON.stringify(name) + " is the only visible sheet, and a workbook keeps one visible sheet at least" }; };
    // The cells of a range by A1 address, row by row (either corner first, $ anchors as ops.ts takes them).
    var cellsOf = function (address) {
      var m = /^\\$?([A-Z]+)\\$?(\\d+)(?::\\$?([A-Z]+)\\$?(\\d+))?$/.exec(address);
      var c1 = colIndex(m[1]), r1 = Number(m[2]), c2 = m[3] ? colIndex(m[3]) : c1, r2 = m[4] ? Number(m[4]) : r1, out = [];
      for (var r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) { var row = []; for (var c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) row.push(colName(c) + r); out.push(row); }
      return out;
    };
    // What a range holds before it is written: each cell's value (a formula as its formula) and number format, by
    // which restore puts it back as it was.
    var capture = function (sheet, address) {
      var range = sheet.GetRange(address), was = grid(range.GetValue()), formulas = grid(range.GetFormula()), format = range.GetNumberFormat();
      var values = was.map(function (row, r) { return row.map(function (v, c) { var f = formulas[r] ? formulas[r][c] : ""; return typeof f === "string" && f.charAt(0) === "=" ? f : v; }); });
      // One format for the range, or each cell's where they differ (GetNumberFormat answers null then).
      var formats = format === null ? cellsOf(address).map(function (row) { return row.map(function (a) { return sheet.GetRange(a).GetNumberFormat(); }); }) : null;
      return { sheet: sheet.GetName(), range: address, values: values, format: format, formats: formats };
    };
    var restore = function (saved) {
      var sheet = Api.GetSheet(saved.sheet);
      if (!sheet) throw { code: "not_found", op: i, message: "the cells " + saved.range + " of " + JSON.stringify(saved.sheet) + " could not be put back: there is no such sheet any more" };
      var cells = cellsOf(saved.range), range = sheet.GetRange(saved.range);
      // A text the editor would read as something else ("00123", "10%", "TRUE") goes into a cell formatted as text,
      // so that it stays text; the cell's own format comes back after.
      saved.values.forEach(function (row, r) { row.forEach(function (v, c) { if (typeof v === "string" && v !== "" && v.charAt(0) !== "=") sheet.GetRange(cells[r][c]).SetNumberFormat("@"); }); });
      range.SetValue(saved.values.length === 1 && saved.values[0].length === 1 ? saved.values[0][0] : saved.values);
      // Only where it differs: a format set on an empty cell would make it part of the sheet's used range.
      cells.forEach(function (row, r) { row.forEach(function (a, c) {
        var f = saved.format !== null ? saved.format : saved.formats[r][c], cell = sheet.GetRange(a);
        if (cell.GetNumberFormat() !== f) cell.SetNumberFormat(f);
      }); });
    };
    if (op.writes !== undefined) {
      var written = [], cells = 0;
      for (var w = 0; w < op.writes.length; w++) {
        var write = op.writes[w], n = write.index, saved = null, failed = null;
        try {
          var sheet = write.sheet !== undefined ? named(write.sheet, n) : shown[0];
          saved = capture(sheet, write.range);
          // One cell takes its value, a range its rows of values.
          var took = sheet.GetRange(write.range).SetValue(write.values.length === 1 && write.values[0].length === 1 ? write.values[0][0] : write.values);
          if (took === false) failed = { code: "bad_value", op: n, message: "op " + (n + 1) + ": the editor did not take the values for " + write.range + " of " + JSON.stringify(sheet.GetName()) + ": a formula it cannot read (check its parentheses and separators), or the sheet is protected" };
        } catch (e) {
          failed = e && e.code ? e : { code: "failed", op: n, message: "op " + (n + 1) + ": " + String(e && e.message || e) };
        }
        if (failed) {
          // This step's writes are not in the plugin's undo yet: put back here, the failing one's own cells first.
          var broken = false;
          if (saved) written.push(saved);
          for (var u = written.length - 1; u >= 0; u--) { try { restore(written[u]); } catch (e2) { broken = true; } }
          return { error: failed, broken: broken };
        }
        written.push(saved);
        cells += write.values.length * write.values[0].length;
      }
      return { result: { inverse: { restoreCells: written.reverse(), real: true }, cells: cells } };
    }
    if (op.restoreCells !== undefined) {
      for (var k = 0; k < op.restoreCells.length; k++) restore(op.restoreCells[k]);
      return { result: {} };
    }
    if (op.addSheet !== undefined) {
      // Made after the editor's active sheet, then moved to its place (by default after the last).
      Api.AddSheet(op.addSheet);
      return { result: { inverse: { dropSheet: op.addSheet, real: true }, expect: { has: op.addSheet }, then: { moveSheet: op.addSheet, position: op.position !== undefined ? op.position : shown.length + 1, fresh: true } } };
    }
    if (op.copySheet !== undefined) {
      var source = named(op.copySheet).GetName();
      Api.AddSheet(op.to);
      return { result: { inverse: { dropSheet: op.to, real: true }, expect: { has: op.to }, then: { fillSheet: op.to, from: source, position: op.position } } };
    }
    if (op.fillSheet !== undefined) {
      var from = Api.GetSheet(op.from), to = Api.GetSheet(op.fillSheet), address = String(from.GetUsedRange().GetAddress(false, false));
      // Written as a write is put back, not with ApiRange.Copy: in DS 10.0 a Copy or Paste into another sheet left the
      // old sheet's formulas computing no more (they kept their values when the cells they read changed).
      var copied = capture(from, address);
      copied.sheet = to.GetName();
      restore(copied);
      var m = /^([A-Z]+)\\d+(?::([A-Z]+)\\d+)?$/.exec(address), first = m ? colIndex(m[1]) : 0, last = m && m[2] ? colIndex(m[2]) : first;
      for (var c = first; c <= Math.min(last, first + 1023); c++) to.GetRange(colName(c) + "1").SetColumnWidth(from.GetRange(colName(c) + "1").GetColumnWidth());
      // By default right after the sheet it copies.
      var rest = shownNames.filter(function (x) { return x !== op.fillSheet; });
      return { result: { then: { moveSheet: op.fillSheet, position: op.position !== undefined ? op.position : rest.indexOf(op.from) + 2, fresh: true, real: true } } };
    }
    if (op.moveSheet !== undefined) {
      var moved = named(op.moveSheet), name = moved.GetName(), others = shownNames.filter(function (x) { return x !== name; });
      if (!moved.GetVisible()) return { error: { code: "sheet_hidden", op: i, message: "op " + (i + 1) + ": " + JSON.stringify(name) + " is hidden, and the editor moves visible sheets only: show it, move it and hide it again" } };
      var order = realNames.filter(function (x) { return x !== name; }), before = op.position - 1 < others.length;
      var inverse = op.fresh ? undefined : { moveSheet: name, position: shownNames.indexOf(name) + 1, real: true };
      if (!others.length) return { result: { inverse: inverse } };
      var target = before ? others[op.position - 1] : others[others.length - 1];
      order.splice(order.indexOf(target) + (before ? 0 : 1), 0, name);
      if (order.join("\\n") === realNames.join("\\n")) return { result: { inverse: inverse } };
      if (before) moved.Move(Api.GetSheet(target)); else moved.Move(undefined, Api.GetSheet(target));
      return { result: { inverse: inverse, expect: { order: order } } };
    }
    if (op.renameSheet !== undefined) {
      var renamed = named(op.renameSheet), was = renamed.GetName();
      renamed.SetName(op.to);
      return { result: { inverse: { renameSheet: op.to, to: was, real: true } } };
    }
    if (op.hideSheet !== undefined || op.showSheet !== undefined) {
      var show = op.showSheet !== undefined, one = named(show ? op.showSheet : op.hideSheet);
      if (one.GetVisible() === show) return { result: {} };
      if (!show && visible() < 2) return { error: lastVisible(one.GetName()) };
      one.SetVisible(show);
      return { result: { inverse: show ? { hideSheet: one.GetName(), real: true } : { showSheet: one.GetName(), real: true } } };
    }
    if (op.deleteSheet !== undefined) {
      var gone = named(op.deleteSheet), goneName = gone.GetName(), hidden = !gone.GetVisible(), book = all.map(function (s) { return { name: s.GetName() }; }), temp;
      if (!hidden && visible() < 2) return { error: lastVisible(goneName) };
      do temp = "~deleted " + Math.random().toString(36).slice(2, 10); while (sheetAt(book, temp) !== -1);
      if (!hidden) gone.SetVisible(false);
      gone.SetName(temp);
      return { result: { inverse: { restoreSheet: temp, to: goneName, hidden: hidden }, pending: temp } };
    }
    if (op.restoreSheet !== undefined) {
      var back = Api.GetSheet(op.restoreSheet);
      if (!back) return { error: { code: "not_found", op: i, message: "the sheet " + JSON.stringify(op.to) + " is deleted already" } };
      back.SetName(op.to);
      if (!op.hidden) back.SetVisible(true);
      return { result: {} };
    }
    if (op.dropSheet !== undefined) {
      var drop = sheetAt(all.map(function (s) { return { name: s.GetName() }; }), op.dropSheet);
      if (drop === -1) return { result: {} };
      all[drop].Delete();
      return { result: { expect: { gone: realNames[drop] } } };
    }
    return { error: { code: "bad_op", op: i, message: "op " + (i + 1) + " is no spreadsheet op" } };
  } catch (e) {
    return { error: e && e.code ? e : { code: "failed", op: i, message: "op " + (i + 1) + ": " + String(e && e.message || e) } };
  }
}`;

/** The commands of a spreadsheet edit, which the plugin runs in turn (cellEdit). */
export const CELL_EDIT_COMMANDS = { check: CELL_CHECK, step: CELL_STEP, sheets: CELL_SHEETS, save: CELL_SAVE };

/** How often, and how far apart in ms, the plugin looks whether a change to the sheets is made: up to 10 s per change. */
export const SHEET_WAIT = { tries: 100, ms: 100 };

/** word.comments: every comment of the document, its thread's GUID (the comment's durableId, which the builder gives as
 * its id in decimal) with it. */
const WORD_COMMENTS = `function () {
  ${COMMENT_SRC}
  try {
    var all = Api.GetDocument().GetAllComments() || [];
    return { result: { comments: all.map(function (c) { var d = described(c); d.guid = hexId(c); return d; }) } };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) } };
  }
}`;

/** word.reply: a reply on the comment whose thread GUID is `guid` (its durableId: the builder finds it by the decimal),
 * as the agent (`author`, `userId`). */
const WORD_REPLY = `function () {
  try {
    var a = Asc.scope.args, doc = Api.GetDocument(), id = parseInt(a.guid, 16);
    var comment = isFinite(id) ? doc.GetCommentById(String(id)) : null;
    if (!comment) return { error: { code: "comment_gone", message: "the comment is not in the document any more" }, touched: false };
    comment.AddReply(a.text, a.author, a.userId);
    Api.Save();
    return { result: { replies: comment.GetRepliesCount() } };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) }, touched: false };
  }
}`;

/** cell.comments: every comment of the workbook, by its id in this editor's session (the builder names no thread GUID
 * in a spreadsheet: the half matches them to the pages' by author, time and text). */
const CELL_COMMENTS = `function () {
  ${COMMENT_SRC}
  try {
    var all = Api.GetAllComments() || [];
    return { result: { comments: all.map(function (c) { var d = described(c); d.sessionId = String(c.GetId()); return d; }) } };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) } };
  }
}`;

/** cell.reply: a reply on a cell comment as the agent. The comment is the one with `sessionId` in this editor's session
 * where that one is still the comment the pages reported (its author's user id and its text), else the one comment of
 * that author, text and time (within a second, which a save and reopen can move by a few ms). */
const CELL_REPLY = `function () {
  try {
    var a = Asc.scope.args, comment = null, all = Api.GetAllComments() || [];
    var plain = function (text) { return String(text == null ? "" : text).replace(/\\s+/g, " ").trim(); };
    var same = function (c) { return String(c.GetUserId() || "") === a.match.userId && plain(c.GetText()) === plain(a.match.text); };
    // Found among all the comments (a comment GetCommentById gives takes no reply that lasts, in DS 10.0): by its id
    // where that is still the comment the pages named.
    if (a.sessionId) comment = all.filter(function (c) { return String(c.GetId()) === a.sessionId && same(c); })[0] || null;
    if (!comment) {
      var found = all.filter(function (c) { return same(c) && (!a.match.time || Math.abs((Number(c.GetTimeUTC()) || 0) - a.match.time) <= 1000); });
      if (found.length > 1) return { error: { code: "comment_ambiguous", message: "more than one comment has that author, time and text" } };
      comment = found[0] || null;
    }
    if (!comment) return { error: { code: "comment_gone", message: "the comment is not in the workbook any more" } };
    comment.AddReply(a.text, a.author, a.userId);
    Api.Save();
    return { result: { replies: comment.GetRepliesCount(), sessionId: String(comment.GetId()) } };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) } };
  }
}`;

/** The job kinds and the command each runs; edits recalculate the document after them, reads do not. (cell.edit is
 * the plugin's own run of CELL_EDIT_COMMANDS.) */
export const COMMANDS: Record<string, { source: string; edit: boolean }> = {
  "word.read": { source: WORD_READ, edit: false },
  "word.edit": { source: WORD_EDIT, edit: true },
  "cell.read": { source: CELL_READ, edit: false },
  "word.comments": { source: WORD_COMMENTS, edit: false },
  "word.reply": { source: WORD_REPLY, edit: true },
  "cell.comments": { source: CELL_COMMENTS, edit: false },
  "cell.reply": { source: CELL_REPLY, edit: true },
};

/**
 * The plugin: it long-polls its editor's jobs from the listener (`next`, at the address it was loaded from, which
 * carries its editor's token), runs each job's command, takes back a Word command that failed after it changed
 * something (Undo) and a spreadsheet edit's ops before the one that failed (cellEdit), and posts the outcome (`done`).
 * It knows nothing but its token, and runs nothing but the commands above.
 */
export const BRIDGE_JS = `(function () {
  var base = location.pathname.replace(/[^/]*$/, "");
  var commands = {
${Object.entries(COMMANDS).map(([kind, c]) => `    ${JSON.stringify(kind)}: { run: ${c.source}, edit: ${c.edit} }`).join(",\n")}
  };
  var cell = {
${Object.entries(CELL_EDIT_COMMANDS).map(([name, source]) => `    ${name}: ${source}`).join(",\n")}
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
  function call(source, args, edit, then) {
    window.Asc.scope.args = args;
    window.Asc.plugin.callCommand(source, false, edit, function (outcome) {
      then(outcome && typeof outcome === "object" ? outcome : { error: { code: "failed", message: "the editor ran the command but gave nothing back" } });
    });
  }
  // A spreadsheet edit, an op at a time (see CELL_EDIT_COMMANDS; a run of cell ops one after the other is one step):
  // checked whole, each op made and, where it changes the sheets, waited for; on a failure the ops made are taken
  // back in reverse, and the deleted sheets go at the end. Where that cannot be made whole (an op to take back fails,
  // or a change the editor was asked for may still come, as a sheet deleted at the end), the answer says so: "ran",
  // with the code "partial".
  function cellEdit(job) {
    var ops = job.args.ops, undo = [], pending = [], deleted = {}, cells = 0, asked = false, broken = "";
    call(cell.check, { ops: ops }, false, function (out) {
      if (out.error) return done(job, { error: out.error });
      next(0);
    });
    function next(i) {
      if (i >= ops.length) return drop(0);
      if (typeof ops[i].range !== "string") return step(ops[i], i, function () { next(i + 1); });
      var writes = [], j = i;
      for (; j < ops.length && typeof ops[j].range === "string"; j++) writes.push({ sheet: ops[j].sheet, range: ops[j].range, values: ops[j].values, index: j });
      step({ writes: writes }, i, function () { next(j); });
    }
    function drop(k) {
      if (k < pending.length) {
        var gone = deleted[pending[k]];
        // Asked of the editor from here on, and not taken back by a restore once it is made.
        asked = true;
        return step({ dropSheet: pending[k], real: true, was: gone.name }, gone.op, function () { drop(k + 1); });
      }
      call(cell.save, {}, true, function () { done(job, { result: { ops: ops.length, cells: cells } }); });
    }
    // The sheet a step changes, by the name the agent knows it by.
    function subject(op) {
      var keys = ["was", "addSheet", "to", "moveSheet", "fillSheet", "dropSheet"];
      for (var k = 0; k < keys.length; k++) if (op[keys[k]] !== undefined) return op[keys[k]];
      return "";
    }
    function step(op, i, then) {
      call(cell.step, { op: op, index: i, pending: pending }, true, function (out) {
        if (out.error) {
          if (out.broken) broken = "the cells it had written could not all be put back";
          return back(out.error);
        }
        var r = out.result || {};
        if (r.inverse) undo.push(r.inverse);
        if (r.pending) {
          pending.push(r.pending);
          deleted[r.pending] = { name: op.deleteSheet, op: i };
        }
        if (r.cells) cells += r.cells;
        var go = function () { if (r.then) step(r.then, i, then); else then(); };
        if (!r.expect) return go();
        wait(r.expect, function (made) {
          if (made) return go();
          // Asked and not shown: the editor may still make it after this call answered.
          asked = true;
          back({ code: "failed", op: i, message: "op " + (i + 1) + ": the editor did not " + (op.dropSheet !== undefined ? "delete" : "show the change to") + " the sheet " + JSON.stringify(subject(op)) + " within " + (${SHEET_WAIT.tries * SHEET_WAIT.ms} / 1000) + " s: a person may be working in that sheet, or the workbook's structure is protected; try again later" });
        });
      });
    }
    function wait(expect, then, tries) {
      call(cell.sheets, {}, false, function (out) {
        var names = (out.result || []).map(function (s) { return s.name; });
        var made = !out.error && (expect.has !== undefined ? names.indexOf(expect.has) !== -1 : expect.gone !== undefined ? names.indexOf(expect.gone) === -1 : names.join("\\n") === expect.order.join("\\n"));
        if (made || (tries || 0) >= ${SHEET_WAIT.tries}) return then(made);
        setTimeout(function () { wait(expect, then, (tries || 0) + 1); }, ${SHEET_WAIT.ms});
      });
    }
    function back(error) {
      (function one() {
        var inverse = undo.pop();
        if (!inverse) return call(cell.save, {}, true, function () {
          if (!broken && !asked) return done(job, error.op !== undefined ? { error: error, undone: true } : { error: error });
          var said = broken ? " Not all of the call could be taken back (" + broken + ")." : " The ops before it are taken back, but the change the editor was asked for may still be made.";
          done(job, { error: { code: "partial", op: error.op, message: String(error.message).replace(/\\.?$/, ".") + said }, ran: true });
        });
        if (inverse.restoreSheet !== undefined && pending.indexOf(inverse.restoreSheet) !== -1) pending.splice(pending.indexOf(inverse.restoreSheet), 1);
        call(cell.step, { op: inverse, index: -1, pending: pending }, true, function (out) {
          if (out.error) {
            if (!broken) broken = String(out.error.message || out.error.code || "an op to take back failed").replace(/^op 0: /, "");
            return one();
          }
          var r = out.result || {};
          if (!r.expect) return one();
          wait(r.expect, function (made) {
            if (!made && !broken) broken = "the editor did not show the sheet " + JSON.stringify(subject(inverse)) + " taken back";
            one();
          });
        });
      })();
    }
  }
  // A message in the editor's chat, as the agent: the plugin's own method, not a command (it changes no document).
  function chatSend(job) {
    window.Asc.plugin.executeMethod("CoAuthoringChatSendMessage", [String(job.args.text)], function (sent) {
      done(job, sent === false ? { error: { code: "failed", message: "the editor did not send the message" } } : { result: { sent: true } });
    });
  }
  // A reply on a comment through the editor's own comment methods, as its comment panel makes one: what an editor that
  // may only comment can do (a builder command's change is rolled back there). The comment is found by its author's
  // user id, its text and its time (a Word thread's from its GUID, through word.comments), as the methods name no GUID.
  function methodReply(job) {
    var a = job.args, before = {};
    function find(then) {
      if (!a.guid) return then(a.match);
      call(commands["word.comments"].run, {}, false, function (out) {
        var all = out.result && out.result.comments || [];
        // The GUIDs there are before the change: the comment made anew is the one whose GUID is new after it.
        all.forEach(function (c) { before[c.guid] = true; });
        var c = all.filter(function (c) { return c.guid === a.guid; })[0];
        then(c ? { userId: c.userId, author: c.author, text: c.text, time: c.time } : null);
      });
    }
    // The methods give a comment's time in the editor's local time, the builder in UTC: the same moment is off by the
    // time zone's offset, a whole number of quarter hours of at most 14 hours.
    // The texts as the methods and the builder give them, which differ in the spaces at their ends.
    function plain(text) { return String(text == null ? "" : text).replace(/\\s+/g, " ").trim(); }
    function sameTime(local, utc) {
      if (!utc || !local) return true;
      var off = local - utc, q = Math.round(off / 900000);
      return Math.abs(q) <= 56 && Math.abs(off - q * 900000) <= 1000;
    }
    find(function (match) {
      if (!match) return done(job, { error: { code: "comment_gone", message: "the comment is not in the document any more" } });
      window.Asc.plugin.executeMethod("GetAllComments", [], function (all) {
        var hits = (all || []).filter(function (c) {
          var d = c && c.Data || {};
          // The spreadsheet editor's methods give no user id: the author's name there.
          var who = d.UserId ? String(d.UserId) === match.userId : !match.author || String(d.UserName || "") === match.author;
          return who && plain(d.Text) === plain(match.text) && sameTime(Number(d.Time), match.time);
        });
        if (hits.length !== 1) return done(job, { error: { code: hits.length ? "comment_ambiguous" : "comment_gone", message: (hits.length ? "more than one comment has that author, time and text" : "the comment is not in the document any more") } });
        var data = hits[0].Data, replies = (data.Replies || []).slice();
        replies.push({ UserName: a.author, UserId: a.userId, Text: a.text, Time: String(Date.now()), Solved: false });
        data.Replies = replies;
        window.Asc.plugin.executeMethod("ChangeComment", [hits[0].Id, data], function () {
          if (!a.guid) return done(job, { result: { replies: replies.length } });
          // A Word comment changed through the methods is made anew, with a GUID of its own: its thread goes on under
          // that one, which the answer names.
          call(commands["word.comments"].run, {}, false, function (out) {
            var now = (out.result && out.result.comments || []).filter(function (c) { return !before[c.guid] && c.userId === match.userId && plain(c.text) === plain(match.text); });
            done(job, { result: now.length === 1 && now[0].guid !== a.guid ? { replies: replies.length, guid: now[0].guid } : { replies: replies.length } });
          });
        });
      });
    });
  }
  function run(job) {
    if (job.kind === "cell.edit") return cellEdit(job);
    if ((job.kind === "word.reply" || job.kind === "cell.reply") && job.args && job.args.how === "method") return methodReply(job);
    if (job.kind === "chat.send") return chatSend(job);
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

/** The plugin's page: OnlyOffice's plugin SDK, from the Document Server itself (`ds`, its origin in the agents'
 * browser: the relay's way in), and the bridge. */
export function pluginIndex(ds: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><script src="${ds}/sdkjs-plugins/v1/plugins.js"></script><script src="bridge.js"></script></head><body></body></html>`;
}

/**
 * The seat page: it long-polls the listener (`poll`) for what to open and close, opens each editor in a frame of its
 * own (`new DocsAPI.DocEditor`, with the config the half minted and signed), and tells the listener what each editor
 * says of itself (`event`: ready; an error, which ends the wait for it; whether it holds changes it has not sent to
 * the Document Server yet, which an edit's save waits for).
 */
export const SEAT_PAGE_JS = `(function () {
  var apis = {};
  var editors = {};
  // Editors closed before they were made (an order to close came while api.js still loaded): never made after.
  var closed = {};
  // The events are numbered in the order the editors raised them: each is a request of its own, and two may arrive in
  // either order.
  var seq = 0;
  function load(src) {
    if (!apis[src]) apis[src] = new Promise(function (ok, no) {
      var s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = function () { delete apis[src]; no(new Error("could not load " + src)); };
      document.head.appendChild(s);
    });
    return apis[src];
  }
  function tell(editorId, type, data) {
    seq++;
    fetch("event", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ editorId: editorId, type: type, data: data, seq: seq }) }).catch(function () {});
  }
  function open(order) {
    load(order.apiJs).then(function () {
      if (!closed[order.editorId]) make(order, 0);
    }, function (e) { tell(order.editorId, "error", { errorDescription: String(e && e.message || e) }); });
  }
  // The editor's own app now and then fails while its scripts load (a race inside it: an exception in its frame, and
  // nothing said to this page), most often while another editor here is torn down. One whose app has not said it
  // started within appReadyMs is made anew, once; the listener's own wait for the editor stays the bound.
  function make(order, tries) {
    var box = document.createElement("div");
    box.id = "editor-" + order.editorId;
    document.body.appendChild(box);
    // A copy for each try: the editor takes the config it is given as its own.
    var config = JSON.parse(JSON.stringify(order.config));
    var started = false;
    config.events = {
      onAppReady: function () { started = true; },
      onDocumentReady: function () { tell(order.editorId, "ready"); },
      onError: function (e) { tell(order.editorId, "error", e && e.data); },
      // The editor's session is no longer the Document Server's (the document changed, or the Document Server
      // restarted): the editor would ask to be reloaded. It is closed instead, and the next call opens it anew.
      onRequestRefreshFile: function () { tell(order.editorId, "error", { errorDescription: "the editor asks to be reloaded" }); },
      onOutdatedVersion: function () { tell(order.editorId, "error", { errorDescription: "the editor's version of the document is outdated" }); },
      // true: the editor holds changes it has not sent to the Document Server yet; false: all of them are sent.
      onDocumentStateChange: function (e) { tell(order.editorId, "state", Boolean(e && e.data === true)); }
    };
    var editor = new window.DocsAPI.DocEditor(box.id, config);
    editors[order.editorId] = editor;
    if (order.appReadyMs && tries < 1) setTimeout(function () {
      if (started || closed[order.editorId] || editors[order.editorId] !== editor) return;
      tell(order.editorId, "remade");
      unmake(order.editorId);
      make(order, tries + 1);
    }, order.appReadyMs);
  }
  function unmake(editorId) {
    var editor = editors[editorId];
    delete editors[editorId];
    try { if (editor) editor.destroyEditor(); } catch (e) {}
    var box = document.getElementById("editor-" + editorId);
    if (box) box.remove();
  }
  function close(editorId) {
    closed[editorId] = true;
    unmake(editorId);
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
