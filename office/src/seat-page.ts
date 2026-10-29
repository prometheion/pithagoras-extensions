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
 * later op's quote is taken into account. A quote must be in the text exactly once at its turn, inside one paragraph,
 * or the op names which place it means (`nth`, from 1, in reading order). `paras` is the body's paragraphs' text in
 * reading order (a table's cells among them, a table of contents' entries not: WORD_COLLECT_SRC), `ops` the ops as
 * ops.ts checked them. Answers null where all of them hold, or the first failure: its code, the op's index (from 0)
 * and a message.
 */
export const WORD_MODEL_SRC = `
function places(paras, quote) {
  var out = [];
  for (var i = 0; i < paras.length; i++) {
    var from = 0, k;
    while ((k = paras[i].indexOf(quote, from)) !== -1) { out.push({ at: i, k: k }); from = k + quote.length; }
  }
  return out;
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
function located(paras, quote, i, what, nth) {
  var c = places(paras, quote);
  if (c.length === 0) {
    var near = nearest(paras, quote);
    return { error: { code: "quote_not_found", op: i, message: "op " + (i + 1) + ": the " + what + " " + JSON.stringify(quote) + " is not in the document's body" + (near ? " (nearest: " + JSON.stringify(near) + ")" : "") } };
  }
  if (nth) return nth <= c.length ? c[nth - 1] : { error: { code: "quote_not_found", op: i, message: "op " + (i + 1) + ": the " + what + " " + JSON.stringify(quote) + " is in the document " + c.length + " time" + (c.length === 1 ? "" : "s") + ", not " + nth } };
  if (c.length === 1) return c[0];
  return { error: { code: "quote_ambiguous", op: i, message: "op " + (i + 1) + ": the " + what + " " + JSON.stringify(quote) + " is in the document " + c.length + " times: quote more of it, or give nth (from 1, in reading order)" } };
}
function simulateWord(paras, ops) {
  paras = paras.slice();
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i], l;
    if (typeof op.quote === "string") {
      l = located(paras, op.quote, i, "quote", op.nth);
      if (l.error) return l.error;
      paras[l.at] = paras[l.at].slice(0, l.k) + op.replacement + paras[l.at].slice(l.k + op.quote.length);
    } else if (typeof op.remove === "string") {
      l = located(paras, op.remove, i, "quote", op.nth);
      if (l.error) return l.error;
      paras.splice(l.at, 1);
    } else {
      var added = op.table ? [].concat.apply([], op.table) : op.paragraphs;
      if (typeof op.after === "string") {
        l = located(paras, op.after, i, "anchor", op.nth);
        if (l.error) return l.error;
        paras.splice.apply(paras, [l.at + 1, 0].concat(added));
      } else paras.push.apply(paras, added);
    }
  }
  return null;
}
`;

/** Every paragraph of a document's content in reading order, a table's cells and a content control's own among them,
 * with its text as the simulation sees it: without a list item's label ("1.", "·", which the editor puts before its
 * text and nobody can quote), and whether it is an entry of a table of contents (`toc`: its text repeats a heading's,
 * so it is no place a quote is looked for). Inside the commands. */
const WORD_COLLECT_SRC = `
function clean(s) { return String(s == null ? "" : s).replace(/[\\r\\n\\t]+$/, ""); }
function textOf(p) { return clean(p.GetText({ Numbering: false })); }
function isToc(p) { try { var st = p.GetStyle(); return Boolean(st && /^toc \\d+$/i.test(st.GetName())); } catch (e) { return false; } }
function collect(content, out) {
  for (var i = 0; i < content.GetElementsCount(); i++) {
    var el = content.GetElement(i), type = el.GetClassType();
    if (type === "paragraph") out.push({ p: el, text: textOf(el), toc: isToc(el) });
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
// A paragraph's list: its kind ("bullet" or "number", by its level's numFmt in the numbering's JSON, the builder
// having no getter for it), the numFmt itself, its level (from 0) and the numbering; null outside a list.
function listOf(p) {
  var lvl = null;
  try { lvl = p.GetNumbering(); } catch (e) { lvl = null; }
  if (!lvl) return null;
  var j = JSON.parse(lvl.GetNumbering().ToJSON()), abs = j.abstractNum ? j.abstractNum[Object.keys(j.abstractNum)[0]] : null;
  var l = abs && abs.lvl ? abs.lvl[lvl.GetLevelIndex()] : null, fmt = l && l.numFmt ? String(l.numFmt.val) : "decimal";
  return { kind: fmt === "bullet" ? "bullet" : "number", format: fmt, level: lvl.GetLevelIndex(), numbering: lvl.GetNumbering() };
}
`;

/**
 * Where a quote is in a document, as the commands find it (inside them, after WORD_COLLECT_SRC): the editor's own
 * search, kept to the body's text. `doc.Search` also finds text in headers, footers and footnotes and in a table of
 * contents' entries (measured in DS 10.0: after a header that says "Meridian Labs", the body's "Meridian Labs" had two
 * hits; after a table of contents every heading had two), so a hit counts only where its paragraph is one of the
 * body's (collect: a table's cells among them) and no entry of a table of contents. `pick` answers the place the op
 * means: the only one, or the `nth` (from 1) in reading order; else a coded refusal.
 */
const WORD_QUOTE_SRC = `
function styleNamed(doc, name) {
  var st = doc.GetStyle(name);
  if (st) return st;
  var all = doc.GetAllStyles() || [], key = String(name).toLowerCase();
  for (var i = 0; i < all.length; i++) if (String(all[i].GetName()).toLowerCase() === key) return all[i];
  return null;
}
function bodyIndex(doc) {
  var at = {}, all = collect(doc, []);
  for (var i = 0; i < all.length; i++) if (!all[i].toc) at[all[i].p.GetInternalId()] = i;
  return at;
}
function bodyHits(doc, quote, at) {
  var found = doc.Search(quote, true) || [], out = [];
  for (var i = 0; i < found.length; i++) {
    var paras = found[i].GetAllParagraphs(), p = paras && paras[0];
    var k = p ? at[p.GetInternalId()] : undefined;
    if (k === undefined) continue;
    out.push({ range: found[i], at: k, pos: found[i].GetStartPos(), para: p, last: paras[paras.length - 1] });
  }
  out.sort(function (a, b) { return a.at - b.at || a.pos - b.pos; });
  return out;
}
function pick(doc, quote, nth, i, what) {
  var hits = bodyHits(doc, quote, bodyIndex(doc)), q = JSON.stringify(quote), n = "op " + (i + 1) + ": ";
  if (!hits.length) {
    // In the text and not found by the search: a footnote's mark or a field inside it parts it for the editor's search.
    var parted = collect(doc, []).some(function (x) { return !x.toc && x.text.indexOf(quote) !== -1; });
    throw { code: "quote_not_found", op: i, message: n + "the " + what + " " + q + " is not in the document's body as the editor searches it" + (parted ? " (it is in the text, parted by a footnote's mark or a field: quote the text before or after that)" : "") };
  }
  if (nth) {
    if (nth > hits.length) throw { code: "quote_not_found", op: i, message: n + "the " + what + " " + q + " is in the document " + hits.length + " time" + (hits.length === 1 ? "" : "s") + ", not " + nth };
    return hits[nth - 1];
  }
  if (hits.length > 1) throw { code: "quote_ambiguous", op: i, message: n + "the " + what + " " + q + " is in the document " + hits.length + " times as the editor searches it: quote more of it, or give nth (from 1, in reading order)" };
  return hits[0];
}
`;

/** The most text the read commands give, in characters: what office_read shows at most (its own cap), and so far below
 * the size a plugin's result may have (seat.LIMITS.maxDone) that a long document never fails its read. */
export const MAX_READ_TEXT = 200_000;

/** The most formatting word.read gives with `formatting`, in characters of its JSON: a quarter of what office_read
 * shows at most (MAX_READ_TEXT), as the plan has it; past it the read says where it stopped (`formatCut`). */
export const MAX_READ_FORMAT = 50_000;

/**
 * How the read commands describe formatting (inside them, after WORD_COLLECT_SRC), from the builder's own JSON of a
 * paragraph (`ToJSON`): its direct formatting only, what the paragraph or run says itself and not what its style
 * gives it (no inheritance is resolved; the styles in use are described once, as they are). Lengths in twips, sizes in
 * half-points, as the builder keeps them; tools.ts says them in points and centimetres. A paragraph that holds a
 * picture is not taken whole (its JSON carries the picture's data): its runs of text one by one, and the picture by its
 * size.
 */
const WORD_LOOK_SRC = `
var HIGHLIGHT_RGB = { "255,255,0": "yellow", "0,255,0": "green", "0,255,255": "cyan", "255,0,255": "magenta", "0,0,255": "blue", "255,0,0": "red", "0,0,139": "darkBlue", "0,139,139": "darkCyan", "0,100,0": "darkGreen", "128,0,128": "darkMagenta", "139,0,0": "darkRed", "128,128,0": "darkYellow", "169,169,169": "darkGray", "211,211,211": "lightGray", "0,0,0": "black", "255,255,255": "white" };
function hex(c) { return c && !c.auto && typeof c.r === "number" ? "#" + [c.r, c.g, c.b].map(function (v) { return ("0" + v.toString(16)).slice(-2); }).join("").toUpperCase() : undefined; }
function styleNames(doc) {
  var out = {};
  (doc.GetAllStyles() || []).forEach(function (s) { try { out[JSON.parse(s.ToJSON()).styleId] = s.GetName(); } catch (e) {} });
  return out;
}
// A run's direct formatting, compact: only what it sets.
function runLook(r, names) {
  var out = {};
  if (!r) return out;
  if (r.rFonts && r.rFonts.ascii) out.font = r.rFonts.ascii;
  if (typeof r.sz === "number") out.size = r.sz;
  if (r.b === true) out.bold = true;
  if (r.i === true) out.italic = true;
  if (r.u === true || (r.u && typeof r.u === "object" && r.u.value !== "none")) out.underline = true;
  if (r.strike === true || r.dstrike === true) out.strike = true;
  if (r.vertAlign === "superscript" || r.vertAlign === "subscript") out[r.vertAlign] = true;
  if (r.color && !r.color.auto) out.color = hex(r.color);
  if (r.highlight && typeof r.highlight === "object") out.highlight = HIGHLIGHT_RGB[[r.highlight.r, r.highlight.g, r.highlight.b].join(",")] || hex(r.highlight);
  if (r.rStyle && names[r.rStyle]) out.style = names[r.rStyle];
  return out;
}
function paraLook(p) {
  var out = {};
  if (!p) return out;
  var JC = { start: "left", left: "left", center: "center", end: "right", right: "right", both: "justify", distribute: "justify" };
  if (p.jc && JC[p.jc]) out.align = JC[p.jc];
  if (p.spacing) {
    if (typeof p.spacing.before === "number") out.spaceBefore = p.spacing.before;
    if (typeof p.spacing.after === "number") out.spaceAfter = p.spacing.after;
    if (typeof p.spacing.line === "number") out.line = p.spacing.lineRule === "auto" || !p.spacing.lineRule ? { multiple: p.spacing.line / 240 } : { exact: p.spacing.line };
  }
  if (p.ind) {
    if (typeof p.ind.left === "number" && p.ind.left) out.indentLeft = p.ind.left;
    if (typeof p.ind.right === "number" && p.ind.right) out.indentRight = p.ind.right;
    if (typeof p.ind.firstLine === "number" && p.ind.firstLine) out.firstLine = p.ind.firstLine;
  }
  if (p.keepNext === true) out.keepWithNext = true;
  if (p.pageBreakBefore === true) out.pageBreakBefore = true;
  return out;
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
// The text of a run's JSON, its fields as {page} and {pages} where they are page numbers.
function runText(items, field) {
  var s = "";
  for (var x = 0; x < (items || []).length; x++) {
    var it = items[x];
    if (typeof it === "string") { if (!field.skip) s += it; continue; }
    if (!it) continue;
    if (it.type === "tab") s += "\\t";
    else if (it.type === "pgNum") s += "{page}";
    else if (it.type === "fldChar" && it.fldCharType === "begin") { field.kind = ""; field.skip = false; }
    else if (it.type === "instrText") field.kind = /^\\s*NUMPAGES\\b/i.test(String(it.instr)) ? "{pages}" : /^\\s*PAGE\\b/i.test(String(it.instr)) ? "{page}" : "";
    else if (it.type === "fldChar" && it.fldCharType === "separate") field.skip = Boolean(field.kind);
    else if (it.type === "fldChar" && it.fldCharType === "end") { if (field.kind) s += field.kind; field.kind = ""; field.skip = false; }
    else if (it.type === "footnoteRef") field.notes.push(s.length);
  }
  return s;
}
// A paragraph's look: its own formatting (pp), and its text in runs of the same direct formatting (only those that
// set something), its footnotes' places (as the text before them) and its pictures' sizes (EMU).
function lookOf(p, names) {
  var drawings = 0;
  try { drawings = p.GetAllDrawingObjects().length; } catch (e) { drawings = 0; }
  // Each element's JSON beside the element itself: a run's character style is named by the run (its JSON's style id
  // is not always the one GetAllStyles gives a style the document made).
  var elements = [], apis = [], pPr = null;
  if (!drawings) {
    var j = JSON.parse(p.ToJSON());
    pPr = j.pPr;
    elements = j.content || [];
    for (var a = 0; a < elements.length; a++) apis.push(a < p.GetElementsCount() ? p.GetElement(a) : null);
  } else {
    pPr = JSON.parse(p.GetParaPr().ToJSON());
    for (var e = 0; e < p.GetElementsCount(); e++) {
      var el = p.GetElement(e), t = el.GetClassType();
      if (t === "hyperlink" || (t === "run" && el.GetText())) { elements.push(JSON.parse(el.ToJSON())); apis.push(el); }
    }
  }
  var styleName = function (api, type) {
    try { var st = api && api.GetClassType() === type && api.GetTextPr ? api.GetTextPr().GetStyle() : null; return st ? st.GetName() : undefined; } catch (x) { return undefined; }
  };
  var runs = [], text = "", field = { kind: "", skip: false, notes: [] }, notes = [];
  var add = function (r, link, api) {
    var before = text.length;
    field.notes = [];
    var s = runText(r.content, field);
    field.notes.forEach(function (k) { notes.push(text + s.slice(0, k)); });
    if (!s) return;
    text += s;
    var look = runLook(r.rPr, names), own = styleName(api, "run");
    if (own) look.style = own;
    else if (api) delete look.style;
    if (link) look.link = link;
    var last = runs[runs.length - 1];
    if (last && same(last.look, look)) last.t += s; else runs.push({ t: s, look: look, at: before });
  };
  elements.forEach(function (el, k) {
    var api = apis[k] && apis[k].GetClassType() === el.type ? apis[k] : null;
    if (el.type === "run") add(el, undefined, api);
    else if (el.type === "hyperlink") (el.content || []).forEach(function (r, m) { if (r.type === "run") add(r, el.value, api && m < api.GetElementsCount() ? api.GetElement(m) : null); });
  });
  var out = {};
  var pp = paraLook(pPr);
  if (Object.keys(pp).length) out.para = pp;
  var shown = runs.filter(function (r) { return Object.keys(r.look).length; }).map(function (r) { return { t: r.t, look: r.look }; });
  if (shown.length) out.runs = shown;
  if (notes.length) out.notes = notes.map(function (s) { return s.slice(-40); });
  if (drawings) out.pictures = p.GetAllDrawingObjects().map(function (d) { return [d.GetWidth(), d.GetHeight()]; });
  if (pPr && pPr.sectPr) out.sectionEnd = true;
  return out;
}
// A style's own look, and what it is based on.
function styleLook(st, names) {
  var j = JSON.parse(st.ToJSON()), out = { name: st.GetName(), type: st.GetType() };
  if (j.basedOn && names[j.basedOn]) out.basedOn = names[j.basedOn];
  var r = runLook(j.rPr, names), p = paraLook(j.pPr);
  delete r.style;
  if (Object.keys(r).length) out.text = r;
  if (Object.keys(p).length) out.para = p;
  return out;
}
// A header's or footer's text, its page numbers as {page} and {pages}; whether it holds more (pictures, tables).
function hfText(content) {
  if (!content) return null;
  var lines = [], more = false;
  for (var e = 0; e < content.GetElementsCount(); e++) {
    var el = content.GetElement(e);
    if (el.GetClassType() !== "paragraph") { more = true; continue; }
    var j = JSON.parse(el.ToJSON()), field = { kind: "", skip: false, notes: [] }, s = "";
    (j.content || []).forEach(function (r) {
      if (r.type === "run") { s += runText(r.content, field); if ((r.content || []).some(function (x) { return x && typeof x === "object" && x.type !== "tab" && x.type !== "pgNum" && x.type !== "fldChar" && x.type !== "instrText" && x.type !== "break"; })) more = true; }
      else if (r.type === "hyperlink") (r.content || []).forEach(function (x) { s += runText(x.content, field); });
    });
    if (s) lines.push(s);
  }
  return { text: lines.join(" / "), more: more };
}
`;

/**
 * word.read: the document's blocks, in order: a paragraph's text (without a list item's label), its style where it has
 * one other than the default, and its list (`list`: "bullet" or "number" and its level from 1, `format` the
 * numbering's own kind, "decimal", "lowerLetter", ...); a table's rows of cell texts; up to MAX_READ_TEXT characters
 * (`truncated` where the document goes on). With `formatting` (Asc.scope.args) each block also says how it looks
 * (`look`, WORD_LOOK_SRC; a table: its style, header rows and merged cells), and `format` how the document does: the
 * styles in use, each section's page and header and footer (`sections`, with the block it ends at), the footnotes'
 * texts; up to MAX_READ_FORMAT characters of it (`formatCut`: the block it stopped at).
 */
const WORD_READ = `function () {
  ${WORD_COLLECT_SRC}
  ${WORD_LOOK_SRC}
  try {
    var doc = Api.GetDocument(), blocks = [], size = 0, truncated = false, formatting = Boolean(Asc.scope.args && Asc.scope.args.formatting);
    var names = formatting ? styleNames(doc) : {}, used = {}, lookSize = 0, cut = 0, sections = [], pictured = {};
    if (formatting) (doc.GetAllImages() || []).forEach(function (img) { try { var pt = img.GetParentTable(); if (pt) pictured[pt.GetInternalId()] = true; } catch (e) {} });
    var looked = function (block, look) {
      if (cut) return;
      var n = JSON.stringify(look).length;
      if (lookSize + n > ${MAX_READ_FORMAT}) { cut = blocks.length; return; }
      lookSize += n;
      block.look = look;
    };
    var add = function (content) {
      for (var i = 0; i < content.GetElementsCount(); i++) {
        if (size > ${MAX_READ_TEXT}) { truncated = true; return; }
        var el = content.GetElement(i), type = el.GetClassType();
        if (type === "paragraph") {
          var style = "";
          try { var st = el.GetParaPr().GetStyle(); style = st ? st.GetName() : ""; } catch (e) { style = ""; }
          var text = textOf(el), list = listOf(el);
          size += text.length;
          var block = style && style !== "Normal" ? { p: text, style: style } : { p: text };
          if (list) { block.list = list.kind; block.level = list.level + 1; if (list.format !== "bullet" && list.format !== "decimal") block.format = list.format; }
          if (formatting) {
            if (style) used[style] = true;
            var look = lookOf(el, names);
            (look.runs || []).forEach(function (r) { if (r.look.style) used[r.look.style] = true; });
            if (look.sectionEnd) { sections.push(blocks.length + 1); delete look.sectionEnd; }
            if (Object.keys(look).length) looked(block, look);
          }
          blocks.push(block);
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
          var tb = { table: rows };
          // A table's style, header rows and merged cells from its JSON, which carries its cells' content: not taken
          // of a table that holds pictures (their data would be in it).
          if (formatting && pictured[el.GetInternalId()]) looked(tb, { pictures: true });
          else if (formatting) {
            var tj = JSON.parse(el.ToJSON()), tlook = {}, header = 0, merged = [];
            if (tj.tblPr && tj.tblPr.tblStyle && names[tj.tblPr.tblStyle]) { tlook.style = names[tj.tblPr.tblStyle]; used[tlook.style] = true; }
            (tj.content || []).forEach(function (rj, ri) {
              if (rj.trPr && rj.trPr.tblHeader && header === ri) header++;
              (rj.content || []).forEach(function (cell, k) {
                var pr = cell.tcPr || {};
                if (pr.gridSpan > 1) merged.push({ row: ri, cell: k, across: pr.gridSpan });
                if (pr.vMerge === "continue" || (pr.vMerge && pr.vMerge.val === "continue")) merged.push({ row: ri, cell: k, above: true });
              });
            });
            if (header) tlook.headerRows = header;
            if (merged.length) tlook.merged = merged;
            if (Object.keys(tlook).length) looked(tb, tlook);
          }
          blocks.push(tb);
        } else if (type === "blockLvlSdt") add(el.GetContent());
      }
    };
    add(doc);
    var result = { blocks: blocks };
    if (truncated) result.truncated = true;
    if (formatting) {
      var styles = [];
      for (var name in used) { var st2 = doc.GetStyle(name); if (st2) styles.push(styleLook(st2, names)); }
      var defaults = runLook(JSON.parse(doc.GetDefaultTextPr().ToJSON()), names);
      var dj = JSON.parse(doc.GetDefaultTextPr().ToJSON());
      if (!defaults.font && dj.fontFamily && dj.fontFamily.name) defaults.font = dj.fontFamily.name;
      var secs = doc.GetSections().map(function (sec, k) {
        var s = { width: sec.GetPageWidth(), height: sec.GetPageHeight(), margins: [sec.GetPageMarginTop(), sec.GetPageMarginRight(), sec.GetPageMarginBottom(), sec.GetPageMarginLeft()], ends: sections[k] || 0 };
        var hd = hfText(sec.GetHeader("default", false)), ft = hfText(sec.GetFooter("default", false));
        if (hd) s.header = hd;
        if (ft) s.footer = ft;
        try { var first = JSON.parse(sec.ToJSON()).titlePg; if (first) { s.firstPage = true; var h1 = hfText(sec.GetHeader("title", false)), f1 = hfText(sec.GetFooter("title", false)); if (h1) s.firstHeader = h1; if (f1) s.firstFooter = f1; } } catch (e) {}
        return s;
      });
      var notes = (doc.GetFootnotesFirstParagraphs() || []).map(function (p) { return textOf(p); });
      result.format = { defaults: defaults, styles: styles, sections: secs, footnotes: notes };
      if (cut) result.formatCut = cut;
    }
    return { result: result };
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
  ${WORD_QUOTE_SRC}
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
    var failed = simulateWord(collect(doc, []).filter(function (x) { return !x.toc; }).map(function (x) { return x.text; }), ops);
    if (failed) return { error: failed, touched: false };
    // The style of an insert: any paragraph style the document has, by its name in any case.
    var styles = {};
    for (var s = 0; s < ops.length; s++) {
      if (!ops[s].style) continue;
      var found = styleNamed(doc, ops[s].style);
      if (!found) return { error: { code: "bad_op", op: s, message: "op " + (s + 1) + ": the document has no style " + JSON.stringify(ops[s].style) + " (office_read with formatting lists the styles in use; office_format makes a new one with defineStyle, and a list with set.list)" }, touched: false };
      if (found.GetType() !== "paragraph") return { error: { code: "bad_op", op: s, message: "op " + (s + 1) + ": " + JSON.stringify(found.GetName()) + " is a " + found.GetType() + " style, and new paragraphs take a paragraph style" }, touched: false };
      styles[s] = found;
    }
    var one = function (quote, nth, i) { return pick(doc, quote, nth, i, "quote").range; };
    var paragraphOf = function (range) { var all = range.GetAllParagraphs(); return all[all.length - 1]; };
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (typeof op.quote === "string") {
        var range = one(op.quote, op.nth, i), start = range.GetStartPos(), end = range.GetEndPos(), held = comments(), home = paragraphOf(range);
        touched = true;
        if (op.replacement) range.AddText(op.replacement, "after");
        doc.GetRange(start, end).Delete();
        // The replacement, found by the editor's own search where it is in the document once (a range made from the
        // quote's positions came out a character short in DS 10.0), else from those positions.
        var placed = op.replacement ? doc.Search(op.replacement, true) || [] : [];
        keep(held, op.replacement ? (placed.length === 1 ? placed[0] : doc.GetRange(start, start + op.replacement.length)) : home && home.GetRange());
      } else if (typeof op.remove === "string") {
        var gone = paragraphOf(one(op.remove, op.nth, i)), before = comments(), next = gone.GetNext() || gone.GetPrevious();
        touched = true;
        gone.Delete();
        keep(before, next && next.GetRange());
      } else {
        var anchor = typeof op.after === "string" ? paragraphOf(one(op.after, op.nth, i)) : null;
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
          var style = styles[i] || null;
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
 * word.format: office_format's ops (ops.ts formatJob), each value already in the builder's unit. Every op is checked
 * first on the document as it stands, in order (its quote in the body, `through` after it, the styles it names or an
 * earlier op of the call makes, the table and cells, the section and what its header holds), and nothing is changed
 * where one does not hold. Then each op is made, its quote found again; one that fails then answers `touched`, and
 * the plugin takes the whole command back with the editor's Undo (one history point: measured for styles, numbering,
 * margins, headers, footnotes, links, merges, sections and a table of contents). What DS 10.0 does that it relies on:
 * - `ApiRange.SetStyle` sets the paragraph's style even when it is given a character style, so a character style goes
 *   on through `SetTextPr` with a text property of that style; a paragraph style through each paragraph's `SetStyle`.
 * - A text setter given null takes that direct formatting off (bold, italic, underline, strike, colour, size, font,
 *   super- and subscript, caps, spacing, position); a highlight is taken off by "none". The character style of a run
 *   comes off only by the run's own `SetStyle(null)`.
 * - A link is taken off by moving its runs out of it (`SetLink("")` leaves an empty link with the Hyperlink style);
 *   its runs keep that style until `SetStyle(null)`.
 * - `ApiTable.SetColumnWidth` takes and gives English Metric Units (635 to the twip; 2000 came out as the narrowest
 *   column, 216 twips); `CreateStyle` with a name the document has gives the existing style; `GetStyle` matches the
 *   name only in its own case; a table's borders and a cell's are drawn "single" or "none" (the other kinds as none).
 * - `doc.AddTableOfContents` does nothing; a TOC field (`AddField`) and `UpdateAllTOC` make one, whose entries are
 *   paragraphs of the styles "toc 1" to "toc 9".
 */
const WORD_FORMAT = `function () {
  ${WORD_COLLECT_SRC}
  ${WORD_QUOTE_SRC}
  var touched = false;
  try {
    var doc = Api.GetDocument(), ops = Asc.scope.args.ops, made = {}, said = [], reflowed = false;
    var JC = { left: "left", center: "center", right: "right", justify: "both" };
    var fail = function (code, i, message) { throw { code: code, op: i, message: "op " + (i + 1) + ": " + message }; };
    // A style by name: the document's (any case), or one an earlier op of this call makes (its type, "paragraph" or
    // "run"); in the check, the ones still to be made stand as their names.
    var styleOf = function (name, type, i, checking) {
      var st = made[name.toLowerCase()] || styleNamed(doc, name);
      if (!st) fail("bad_op", i, "the document has no style " + JSON.stringify(name) + " (office_read with formatting lists the styles in use; defineStyle makes one)");
      var t = typeof st === "string" ? st : st.GetType();
      if (type && t !== type && !(type === "text" && (t === "paragraph" || t === "run"))) fail("bad_op", i, JSON.stringify(name) + " is a " + (t === "run" ? "character" : t) + " style, not a " + (type === "run" ? "character" : type) + " style");
      return checking || typeof st === "string" ? null : st;
    };
    var listed = listOf;
    // A header's or footer's content holds only text (and page numbers): what a text may take the place of.
    var textOnly = function (content) {
      for (var e = 0; e < content.GetElementsCount(); e++) {
        var el = content.GetElement(e);
        if (el.GetClassType() !== "paragraph") return false;
        var runs = JSON.parse(el.ToJSON()).content || [];
        for (var r = 0; r < runs.length; r++) {
          if (runs[r].type === "endRun") continue;
          if (runs[r].type !== "run") return false;
          var items = runs[r].content || [];
          for (var x = 0; x < items.length; x++) {
            var it = items[x];
            if (typeof it === "string") continue;
            if (it && (it.type === "pgNum" || it.type === "tab" || it.type === "fldChar")) continue;
            if (it && it.type === "instrText" && /^\\s*(PAGE|NUMPAGES)\\b/i.test(String(it.instr))) continue;
            return false;
          }
        }
      }
      return true;
    };
    var sectionsOf = function (op, i) {
      if (op.page === "*") return doc.GetSections();
      return [pick(doc, op.page, op.nth, i, "quote").para.GetSection()];
    };
    var cellsOf = function (table, op, i) {
      var rows = table.GetRowsCount(), c = op.cells, out = [];
      var r0 = c ? c.row : 0, r1 = c ? c.row + c.rows - 1 : rows - 1;
      if (r1 >= rows) fail("bad_op", i, "the table has " + rows + " row" + (rows === 1 ? "" : "s"));
      for (var r = r0; r <= r1; r++) {
        var row = table.GetRow(r), n = row.GetCellsCount(), c0 = c ? c.col : 0, c1 = c ? c.col + c.cols - 1 : n - 1;
        if (c1 >= n) fail("bad_op", i, "row " + (r + 1) + " of the table has " + n + " cell" + (n === 1 ? "" : "s") + " (as office_read shows it)");
        for (var k = c0; k <= c1; k++) out.push({ cell: row.GetCell(k), row: row, r: r - r0, k: k - c0, last: r === r1, end: k === c1 });
      }
      return out;
    };
    var tableOf = function (op, i) {
      var t = pick(doc, op.formatTable, op.nth, i, "quote").para.GetParentTable();
      if (!t) fail("bad_op", i, JSON.stringify(op.formatTable) + " is not in a table");
      return t;
    };

    // The check: every op on the document as it stands, nothing changed (the paragraphs an earlier op of the call puts
    // in a list count as in one).
    var listing = {};
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.format !== undefined) {
        var hit = pick(doc, op.format, op.nth, i, "quote"), span = [hit.para];
        if (op.through !== undefined) {
          var on = bodyHits(doc, op.through, bodyIndex(doc)).filter(function (h) { return h.at > hit.at || (h.at === hit.at && h.pos >= hit.pos); });
          if (!on.length) fail("quote_not_found", i, "\\"through\\" " + JSON.stringify(op.through) + " is not in the body after " + JSON.stringify(op.format));
          span = hit.range.ExpandTo(on[0].range).GetAllParagraphs();
        }
        if (op.text && op.text.link && op.through !== undefined && on[0].at !== hit.at) fail("bad_op", i, "a link lies inside one paragraph: format its text alone");
        if (op.text && op.text.style) styleOf(op.text.style, "text", i, true);
        var lst = op.para || {};
        if (lst.list) span.forEach(function (p) { listing[p.GetInternalId()] = lst.list !== "none"; });
        // A level or a new start for a paragraph in no list: in the list right before it, where there is one.
        var inList = function (p) { var k = listing[p.GetInternalId()]; return k !== undefined ? k : Boolean(listed(p)); };
        var before = hit.para.GetPrevious && hit.para.GetPrevious();
        if ((lst.level !== undefined || lst.listStart !== undefined) && !lst.list && !inList(hit.para) && !(before && before.GetClassType() === "paragraph" && inList(before))) fail("bad_op", i, JSON.stringify(op.format) + " is in no list, nor is the paragraph before it: give list (\\"bullet\\" or \\"number\\") with level or listStart");
      } else if (op.defineStyle !== undefined) {
        var type = op.type === "character" ? "run" : "paragraph", have = made[op.defineStyle.toLowerCase()] || styleNamed(doc, op.defineStyle);
        if (have && !op.change) {
          var users = 0;
          collect(doc, []).forEach(function (x) { try { var st = x.p.GetStyle(); if (st && st.GetName() === (typeof have === "string" ? op.defineStyle : have.GetName())) users++; } catch (e) {} });
          fail("style_exists", i, "the document has a style " + JSON.stringify(typeof have === "string" ? op.defineStyle : have.GetName()) + " already" + (type === "paragraph" ? " (" + users + " paragraph" + (users === 1 ? "" : "s") + " use it)" : "") + ": give change: true to change it, or another name");
        }
        if (have && (typeof have === "string" ? have : have.GetType()) !== type) fail("bad_op", i, JSON.stringify(op.defineStyle) + " is a " + (typeof have === "string" ? have : have.GetType()) + " style already, not a " + op.type + " style");
        if (op.basedOn !== undefined) styleOf(op.basedOn, type, i, true);
        made[op.defineStyle.toLowerCase()] = have || type;
      } else if (op.formatTable !== undefined) {
        var table = tableOf(op, i), cells = cellsOf(table, op, i);
        if (op.table && op.table.tableStyle) styleOf(op.table.tableStyle, "table", i, true);
        if (op.table && op.table.columnWidths && op.table.columnWidths.length > table.GetColumnsCount()) fail("bad_op", i, "the table has " + table.GetColumnsCount() + " columns, and columnWidths gives " + op.table.columnWidths.length);
        if (op.cell && op.cell.merge) {
          var width = -1;
          for (var r = 0; r < op.cells.rows; r++) {
            var row = table.GetRow(op.cells.row + r), n = row.GetCellsCount();
            if (op.cells.col + op.cells.cols > n) fail("bad_op", i, "the cells to merge are no rectangle: row " + (op.cells.row + r + 1) + " has " + n + " cells");
          }
        }
      } else if (op.page !== undefined) {
        var secs = sectionsOf(op, i);
        for (var k = 0; k < secs.length; k++) {
          ["header", "footer"].forEach(function (part) {
            if (!op.set[part] || op.set.replace) return;
            var own = part === "header" ? secs[k].GetHeader("default", false) : secs[k].GetFooter("default", false);
            if (own && !textOnly(own)) fail("bad_op", i, "the " + part + (secs.length > 1 ? " of section " + (k + 1) : "") + " holds more than text (a picture, a table or a field): give replace: true to replace it all");
          });
        }
      } else if (op.sectionBreak !== undefined || op.footnote !== undefined) {
        var at = pick(doc, op.sectionBreak !== undefined ? op.sectionBreak : op.footnote, op.nth, i, "quote");
        if (op.sectionBreak !== undefined && at.para.GetParentTable()) fail("bad_op", i, "a section ends after a paragraph outside tables; quote one");
      } else if (op.after !== undefined) {
        var anchor = pick(doc, op.after, op.nth, i, "quote").last;
        if (anchor.GetParentTable()) fail("bad_op", i, (op.toc ? "a table of contents" : "a page break") + " goes after a paragraph outside tables; quote one");
      }
    }

    // Text keys on a range (and the paragraphs it touches).
    var clearText = function (range, paras) {
      ["SetBold", "SetItalic", "SetUnderline", "SetStrikeout", "SetDoubleStrikeout", "SetColor", "SetFontSize", "SetFontFamily", "SetVertAlign", "SetCaps", "SetSmallCaps", "SetSpacing", "SetPosition", "SetShd"].forEach(function (m) { range[m](null); });
      range.SetHighlight("none");
      // A run's character style comes off at the run (not one inside a link: that is the link's look).
      paras.forEach(function (p) {
        for (var e = 0; e < p.GetElementsCount(); e++) {
          var el = p.GetElement(e);
          if (el.GetClassType() !== "run") continue;
          var x = range.IntersectWith(el.GetRange());
          if (x && x.GetText() && el.GetTextPr().GetStyle()) el.SetStyle(null);
        }
      });
    };
    var unlink = function (range, paras) {
      paras.forEach(function (p) {
        for (var e = 0; e < p.GetElementsCount(); e++) {
          var el = p.GetElement(e);
          if (el.GetClassType() !== "hyperlink") continue;
          var x = range.IntersectWith(el.GetRange());
          if (!x || !x.GetText()) continue;
          var runs = [];
          for (var r = 0; r < el.GetElementsCount(); r++) runs.push(el.GetElement(r));
          p.RemoveElement(e);
          for (var m = 0; m < runs.length; m++) {
            p.AddElement(runs[m], e + m);
            var st = runs[m].GetClassType() === "run" ? runs[m].GetTextPr().GetStyle() : null;
            if (st && st.GetName() === "Hyperlink") runs[m].SetStyle(null);
          }
          e += runs.length - 1;
        }
      });
    };
    var textOn = function (range, t, paras, i) {
      if (t.clear) clearText(range, paras);
      if (t.font !== undefined) range.SetFontFamily(t.font);
      if (t.size !== undefined) range.SetFontSize(t.size);
      if (t.bold !== undefined) range.SetBold(t.bold);
      if (t.italic !== undefined) range.SetItalic(t.italic);
      if (t.underline !== undefined) range.SetUnderline(t.underline);
      if (t.strike !== undefined) range.SetStrikeout(t.strike);
      if (t.vertAlign !== undefined) range.SetVertAlign(t.vertAlign);
      if (t.color !== undefined) { if (t.color === "auto") range.SetColor(null); else range.SetColor(t.color.r, t.color.g, t.color.b); }
      if (t.highlight !== undefined) range.SetHighlight(t.highlight);
      if (t.style !== undefined) {
        var st = styleOf(t.style, "text", i);
        if (st.GetType() === "run") { var pr = Api.CreateTextPr(); pr.SetStyle(st); range.SetTextPr(pr); }
        else paras.forEach(function (p) { p.SetStyle(st); });
      }
      if (t.link !== undefined) {
        unlink(range, paras);
        if (t.link && !range.AddHyperlink(t.link, "")) fail("failed", i, "the editor made no link of the text");
      }
    };
    var prOn = function (pr, t, pp) {
      if (t) {
        if (t.font !== undefined) pr.SetFontFamily(t.font);
        if (t.size !== undefined) pr.SetFontSize(t.size);
        if (t.bold !== undefined) pr.SetBold(t.bold);
        if (t.italic !== undefined) pr.SetItalic(t.italic);
        if (t.underline !== undefined) pr.SetUnderline(t.underline);
        if (t.strike !== undefined) pr.SetStrikeout(t.strike);
        if (t.vertAlign !== undefined) pr.SetVertAlign(t.vertAlign);
        if (t.color !== undefined) { if (t.color === "auto") pr.SetColor(null); else pr.SetColor(t.color.r, t.color.g, t.color.b); }
        if (t.highlight !== undefined) pr.SetHighlight(t.highlight);
      }
    };
    var paraOn = function (p, pp) {
      if (pp.align !== undefined) p.SetJc(JC[pp.align]);
      if (pp.spaceBefore !== undefined) p.SetSpacingBefore(pp.spaceBefore);
      if (pp.spaceAfter !== undefined) p.SetSpacingAfter(pp.spaceAfter);
      if (pp.lineSpacing !== undefined) p.SetSpacingLine(pp.lineSpacing.line, pp.lineSpacing.rule);
      if (pp.indentLeft !== undefined) p.SetIndLeft(pp.indentLeft);
      if (pp.indentRight !== undefined) p.SetIndRight(pp.indentRight);
      if (pp.firstLine !== undefined) p.SetIndFirstLine(pp.firstLine);
      if (pp.pageBreakBefore !== undefined) p.SetPageBreakBefore(pp.pageBreakBefore);
      if (pp.keepWithNext !== undefined) p.SetKeepNext(pp.keepWithNext);
    };
    // A list: the one of the same kind right before the first paragraph goes on, else a new one starts (listStart:
    // always a new one, starting there).
    var listOn = function (paras, pp) {
      if (pp.list === "none") return paras.forEach(function (p) { p.SetNumbering(null); });
      var prev = paras[0].GetPrevious && paras[0].GetPrevious(), before = prev && prev.GetClassType() === "paragraph" ? listed(prev) : null;
      // A level alone, of a paragraph in no list: it goes in the list right before it (the check made sure of one).
      var first = listed(paras[0]) || (!pp.list ? before : null), kind = pp.list || (first && first.kind), level = pp.level !== undefined ? pp.level : first ? first.level : 0, numbering = null;
      if (!pp.list && pp.listStart === undefined) return paras.forEach(function (p) { var l = listed(p) || first; if (l) p.SetNumbering(l.numbering.GetLevel(level)); });
      if (pp.listStart === undefined) numbering = before && before.kind === kind ? before.numbering : first && first.kind === kind ? first.numbering : null;
      if (!numbering) {
        numbering = doc.CreateNumbering(kind === "bullet" ? "bullet" : "numbered");
        if (pp.listStart !== undefined) numbering.GetLevel(level).SetStart(pp.listStart);
      }
      paras.forEach(function (p) { p.SetNumbering(numbering.GetLevel(level)); });
    };
    var border = function (b) { return b.type === "none" ? ["none", 0, 0, 0, 0, 0] : ["single", b.size, 0, b.color.r, b.color.g, b.color.b]; };
    var setHeader = function (sec, part, pieces) {
      if (!pieces.length) return part === "header" ? sec.RemoveHeader("default") : sec.RemoveFooter("default");
      var content = part === "header" ? sec.GetHeader("default", true) : sec.GetFooter("default", true);
      var first = content.GetElementsCount() && content.GetElement(0).GetClassType() === "paragraph" ? content.GetElement(0) : null;
      // The first paragraph keeps its own look (its style, its alignment); the rest goes.
      for (var e = content.GetElementsCount() - 1; e >= (first ? 1 : 0); e--) content.RemoveElement(e);
      if (first) first.RemoveAllElements();
      else {
        first = Api.CreateParagraph();
        var hs = styleNamed(doc, part === "header" ? "Header" : "Footer");
        if (hs) first.SetStyle(hs);
        content.Push(first);
      }
      pieces.forEach(function (x) { if (x.text !== undefined) first.AddText(x.text); else if (x.field === "page") first.AddPageNumber(); else first.AddPagesCount(); });
    };

    // The edit: each op found again and made.
    for (var i2 = 0; i2 < ops.length; i2++) {
      var o = ops[i2];
      if (o.format !== undefined) {
        var h = pick(doc, o.format, o.nth, i2, "quote"), range = h.range;
        if (o.through !== undefined) {
          var to = bodyHits(doc, o.through, bodyIndex(doc)).filter(function (x) { return x.at > h.at || (x.at === h.at && x.pos >= h.pos); })[0];
          range = range.ExpandTo(to.range);
        }
        var paras = range.GetAllParagraphs();
        touched = true;
        if (o.text && o.text.style !== undefined && styleOf(o.text.style, "text", i2).GetType() === "paragraph") { textOn(range, { style: o.text.style }, paras, i2); }
        if (o.para) { paras.forEach(function (p) { paraOn(p, o.para); }); if (o.para.list || o.para.level !== undefined || o.para.listStart !== undefined) listOn(paras, o.para); if (o.para.pageBreakBefore) reflowed = true; }
        if (o.text) {
          var rest = {};
          for (var key in o.text) if (key !== "style" || styleOf(o.text.style, "text", i2).GetType() === "run") rest[key] = o.text[key];
          textOn(range, rest, paras, i2);
        }
      } else if (o.defineStyle !== undefined) {
        var type2 = o.type === "character" ? "run" : "paragraph", st = styleNamed(doc, o.defineStyle), was = Boolean(st);
        touched = true;
        if (!st) st = doc.CreateStyle(o.defineStyle, type2);
        if (o.basedOn !== undefined) st.SetBasedOn(styleOf(o.basedOn, type2, i2));
        prOn(st.GetTextPr(), o.text);
        if (o.para && type2 === "paragraph") paraOn(st.GetParaPr(), o.para);
        made[o.defineStyle.toLowerCase()] = st;
        if (was) {
          var count = 0;
          collect(doc, []).forEach(function (x) { try { var s2 = x.p.GetStyle(); if (s2 && s2.GetName() === st.GetName()) count++; } catch (e) {} });
          said.push({ style: st.GetName(), changed: true, paragraphs: type2 === "paragraph" ? count : undefined });
          reflowed = true;
        } else said.push({ style: st.GetName(), made: true });
      } else if (o.formatTable !== undefined) {
        var tb = tableOf(o, i2), cs = cellsOf(tb, o, i2), t2 = o.table || {}, c2 = o.cell || {};
        touched = true;
        if (t2.tableStyle !== undefined) tb.SetStyle(styleOf(t2.tableStyle, "table", i2));
        if (t2.width) { if (t2.width.percent !== undefined) tb.SetWidth("percent", t2.width.percent); else tb.SetWidth("twips", t2.width.twips); }
        if (t2.columnWidths) t2.columnWidths.forEach(function (w, k) { tb.SetColumnWidth(k, w * 635); });
        if (t2.headerRows !== undefined) for (var hr = 0; hr < tb.GetRowsCount(); hr++) tb.GetRow(hr).SetTableHeader(hr < t2.headerRows);
        if (c2.borders) {
          var b2 = c2.borders;
          if (!o.cells) {
            if (b2.top) tb.SetTableBorderTop.apply(tb, border(b2.top));
            if (b2.bottom) tb.SetTableBorderBottom.apply(tb, border(b2.bottom));
            if (b2.left) tb.SetTableBorderLeft.apply(tb, border(b2.left));
            if (b2.right) tb.SetTableBorderRight.apply(tb, border(b2.right));
            if (b2.insideH) tb.SetTableBorderInsideH.apply(tb, border(b2.insideH));
            if (b2.insideV) tb.SetTableBorderInsideV.apply(tb, border(b2.insideV));
          } else cs.forEach(function (x) {
            if (b2.top && x.r === 0) x.cell.SetCellBorderTop.apply(x.cell, border(b2.top));
            if (b2.bottom && x.last) x.cell.SetCellBorderBottom.apply(x.cell, border(b2.bottom));
            if (b2.left && x.k === 0) x.cell.SetCellBorderLeft.apply(x.cell, border(b2.left));
            if (b2.right && x.end) x.cell.SetCellBorderRight.apply(x.cell, border(b2.right));
            if (b2.insideH && !x.last) x.cell.SetCellBorderBottom.apply(x.cell, border(b2.insideH));
            if (b2.insideH && x.r > 0) x.cell.SetCellBorderTop.apply(x.cell, border(b2.insideH));
            if (b2.insideV && !x.end) x.cell.SetCellBorderRight.apply(x.cell, border(b2.insideV));
            if (b2.insideV && x.k > 0) x.cell.SetCellBorderLeft.apply(x.cell, border(b2.insideV));
          });
        }
        cs.forEach(function (x) {
          if (c2.fill !== undefined) { if (c2.fill === "none") x.cell.SetShd("nil", 255, 255, 255); else x.cell.SetShd("clear", c2.fill.r, c2.fill.g, c2.fill.b); }
          if (c2.valign !== undefined) x.cell.SetVerticalAlign(c2.valign);
          var content = x.cell.GetContent(), cps = collect(content, []).map(function (y) { return y.p; });
          if (c2.align !== undefined) cps.forEach(function (p) { p.SetJc(JC[c2.align]); });
          if (o.text) textOn(content.GetRange(), o.text, cps, i2);
        });
        if (c2.rowHeight !== undefined) { var seen = {}; cs.forEach(function (x) { if (!seen[x.r]) { seen[x.r] = true; x.row.SetHeight("atLeast", c2.rowHeight); } }); }
        if (c2.merge && !tb.MergeCells(cs.map(function (x) { return x.cell; }))) fail("failed", i2, "the editor did not merge the cells (they are no rectangle of the table's grid: one of them spans columns or rows)");
      } else if (o.page !== undefined) {
        var ss = sectionsOf(o, i2), ps = o.set;
        touched = true;
        reflowed = true;
        ss.forEach(function (sec) {
          if (ps.size || ps.orientation) {
            var w = ps.size ? ps.size.width : sec.GetPageWidth(), hh = ps.size ? ps.size.height : sec.GetPageHeight();
            var land = ps.orientation ? ps.orientation === "landscape" : w > hh;
            if ((land && w < hh) || (!land && w > hh)) { var sw = w; w = hh; hh = sw; }
            sec.SetPageSize(w, hh, !land);
          }
          if (ps.margins) sec.SetPageMargins(ps.margins.left, ps.margins.top, ps.margins.right, ps.margins.bottom);
          if (ps.differentFirstPage !== undefined) sec.SetTitlePage(ps.differentFirstPage);
          if (ps.header) setHeader(sec, "header", ps.header);
          if (ps.footer) setHeader(sec, "footer", ps.footer);
        });
      } else if (o.sectionBreak !== undefined) {
        var sp = pick(doc, o.sectionBreak, o.nth, i2, "quote").last;
        touched = true;
        reflowed = true;
        doc.CreateSection(sp).SetType(o.type);
      } else if (o.footnote !== undefined) {
        var fh = pick(doc, o.footnote, o.nth, i2, "quote"), end = fh.range.GetEndPos();
        touched = true;
        doc.GetRange(end, end).Select();
        var note = doc.AddFootnote();
        doc.RemoveSelection();
        if (!note) fail("failed", i2, "the editor made no footnote there");
        note.GetElement(0).AddText(o.text);
      } else {
        var anchor2 = o.after !== undefined ? pick(doc, o.after, o.nth, i2, "quote").last : null, np = Api.CreateParagraph();
        touched = true;
        reflowed = true;
        if (o.pageBreak) np.AddPageBreak();
        // A table of contents goes at the start where no place is given; a page break at the end.
        if (anchor2) anchor2.GetParent().AddElement(anchor2.GetPosInParent() + 1, np);
        else if (o.toc) doc.AddElement(0, np);
        else doc.Push(np);
        if (o.toc) {
          np.GetRange().AddField('TOC \\\\o "1-' + o.levels + '" \\\\h \\\\z \\\\u');
          doc.UpdateAllTOC(false);
        }
      }
    }
    Api.Save();
    var result = { ops: ops.length };
    if (said.length) result.styles = said;
    if (reflowed) result.reflowed = true;
    return { result: result };
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

/** The most text a picture's locate gives of what the picture shows, in characters: a page holds far less, but a page
 * the editor cannot place (it starts in a text box), or one in a long table, is answered with the text around it; a
 * range of narrow columns and low rows shows thousands of cells. */
export const MAX_SHOWN_TEXT = 20_000;

/** The most columns and rows a sheet's picture takes, hidden ones counted (about three times what fits at 75 % with
 * the default sizes): a range of many hidden rows "fits" by its pixels, and every row of it costs a look in the
 * builder and the frame function. */
export const SHEET_MOST = { cols: 100, rows: 200 };

/**
 * The sheet's view the fit is reckoned on (seat-page EDITOR_SIZE's spreadsheet editor, measured in DS 10.0): its grid
 * at 100 % is 1506 x 802 px less the headers (26 x 19 px), at 75 % less theirs (20 x 14 px), in px at 100 %. A
 * column is `width * 7 + 5` px for its width in characters (8.43 is 64 px), a row `height * 4 / 3` px for its height
 * in points, and 19 px where the builder gives none (the default).
 */
export const SHEET_VIEW = { width: 1506, height: 802, header: { 1: [26, 19], 0.75: [20, 14] } as Record<string, [number, number]> };

/** word.pages: how many pages the editor has laid out now (the plugin waits until that holds still, VIEW_SETTLE). */
const WORD_PAGES = `function () {
  try {
    return { result: Api.GetDocument().GetPageCount() };
  } catch (e) {
    return { error: { code: "failed", message: String(e && e.message || e) } };
  }
}`;

/** How long the page count must hold still before a page is located, and the longest wait for that (the layout of 20
 * pages lands 0.3 to 0.7 s after an edit). */
export const VIEW_SETTLE = { ms: 300, max: 5_000, every: 50 };

/**
 * view.locate: what office_screenshot is to show, checked in the document as it stands, with the text it shows and
 * the target the picture is taken of (cdp.ts ShotTarget). Changes nothing but the agent's own selection.
 * Word (`kind: "word"`, `page` from 1, or the page of `quote`, the `nth` time it is found): the page, the page count,
 * and the page's blocks as office_read numbers them, from the one the page starts in to the one the next page starts
 * in (the cursor put at each page's start and the paragraph there looked up), of a table there its rows from the one
 * to the other (`row`, from 1, and `of`, its rows, where not all of them are given). A page's start is not in a block
 * of the body where it is in a text box: then the text goes from the start, or to the end, of the document. Up to
 * MAX_SHOWN_TEXT characters (`truncated`).
 * Sheets (`kind: "cell"`, `sheet`, `range` as {col, row, cols, rows} from ops.ts): the sheet (the first visible one
 * by default; a hidden one is refused), the range (by default the used range from A1), and the zoom it fits at:
 * 100 %, else 75 %, from its columns' widths and rows' heights (hidden ones count nothing; frozen panes the range is
 * beyond take their part of the view). A range that fits at neither is refused with the largest one from its first
 * cell that does; the default range is cut to that (`cut`). A range spans SHEET_MOST columns and rows at most, hidden
 * ones counted. Its cells as cell.read gives them, of its rows and columns that are not hidden (what the picture shows;
 * the frame function skips the hidden ones too), up to MAX_SHOWN_TEXT characters (`truncated`).
 */
const VIEW_LOCATE = `function () {
  ${WORD_COLLECT_SRC}
  ${WORD_QUOTE_SRC}
  ${CELL_ADDRESS_SRC}
  ${SHEET_MODEL_SRC}
  var a = Asc.scope.args;
  function word() {
    var doc = Api.GetDocument(), pages = doc.GetPageCount(), page = a.page || 1;
    if (a.quote !== undefined) {
      // The body's text only, as office_edit's and office_format's quotes (WORD_QUOTE_SRC).
      var hits = bodyHits(doc, a.quote, bodyIndex(doc)).map(function (h) { return h.range; }), nth = a.nth || 1, q = JSON.stringify(a.quote);
      if (!hits.length) throw { code: "quote_not_found", message: "the quote " + q + " is not in the document" };
      if (hits.length > 1 && !a.nth) throw { code: "quote_ambiguous", message: "the quote " + q + " is in the document " + hits.length + " times: give nth (from 1) or quote more of it" };
      if (nth > hits.length) throw { code: "quote_not_found", message: "the quote " + q + " is in the document " + hits.length + " time" + (hits.length === 1 ? "" : "s") + ", not " + nth };
      page = hits[nth - 1].GetStartPage() + 1;
    }
    if (page > pages) throw { code: "no_page", message: "the document has " + pages + " page" + (pages === 1 ? "" : "s") };
    // The blocks as office_read numbers them, and where each paragraph is: its block, and in a table its row.
    var blocks = [], of = {};
    (function add(content) {
      for (var i = 0; i < content.GetElementsCount(); i++) {
        var el = content.GetElement(i), type = el.GetClassType();
        if (type === "paragraph") { of[el.GetInternalId()] = { block: blocks.length, row: -1 }; blocks.push(el); }
        else if (type === "table") {
          for (var r = 0; r < el.GetRowsCount(); r++) {
            var row = el.GetRow(r);
            for (var c = 0; c < row.GetCellsCount(); c++) collect(row.GetCell(c).GetContent(), []).forEach(function (x) { of[x.p.GetInternalId()] = { block: blocks.length, row: r }; });
          }
          blocks.push(el);
        } else if (type === "blockLvlSdt") add(el.GetContent());
      }
    })(doc);
    var startOf = function (k) {
      doc.GoToPage(k);
      doc.MoveCursorRight(1, true);
      var range = doc.GetRangeBySelect(), paras = range ? range.GetAllParagraphs() : [];
      return (paras.length && of[paras[0].GetInternalId()]) || null;
    };
    var first = startOf(page - 1), last = page < pages ? startOf(page) : { block: blocks.length - 1, row: -1 };
    doc.RemoveSelection();
    if (first === null) first = { block: 0, row: -1 };
    if (last === null || last.block < first.block) last = last === null ? { block: blocks.length - 1, row: -1 } : first;
    // A table the page starts or ends in gives the rows from the one the page starts in to the one the next page starts
    // in (a table can run over many pages); the text stops at MAX_SHOWN_TEXT, also inside a table or a paragraph.
    var shown = [], size = 0, truncated = false;
    var room = function (t) {
      if (size + t.length <= ${MAX_SHOWN_TEXT}) { size += t.length; return t; }
      truncated = true;
      t = t.slice(0, Math.max(0, ${MAX_SHOWN_TEXT} - size));
      size = ${MAX_SHOWN_TEXT};
      return t;
    };
    for (var b = first.block; b <= last.block && !truncated; b++) {
      var el = blocks[b];
      if (el.GetClassType() === "paragraph") {
        var style = "";
        try { var st = el.GetParaPr().GetStyle(); style = st ? st.GetName() : ""; } catch (e) { style = ""; }
        var text = room(textOf(el)), list = listOf(el), block = style && style !== "Normal" ? { p: text, style: style } : { p: text };
        if (list) { block.list = list.kind; block.level = list.level + 1; if (list.format !== "bullet" && list.format !== "decimal") block.format = list.format; }
        shown.push(block);
      } else {
        var count = el.GetRowsCount(), from = b === first.block && first.row > 0 ? first.row : 0, to = b === last.block && last.row >= from ? last.row : count - 1, rows = [];
        for (var r2 = from; r2 <= to && !truncated; r2++) {
          var cells = [], tr = el.GetRow(r2);
          for (var c2 = 0; c2 < tr.GetCellsCount() && !truncated; c2++) cells.push(room(cellText(tr.GetCell(c2))));
          rows.push(cells);
        }
        var table = { table: rows };
        if (from > 0 || from + rows.length < count) { table.row = from + 1; table.of = count; }
        shown.push(table);
      }
    }
    return { page: page, pages: pages, first: first.block + 1, blocks: shown, truncated: truncated, view: { kind: "word", page: page, pages: pages } };
  }
  function cell() {
    var all = Api.GetSheets(), book = all.map(function (s) { return { name: s.GetName(), hidden: !s.GetVisible() }; }), at = -1;
    if (a.sheet !== undefined) {
      at = sheetAt(book, a.sheet);
      if (at === -1) throw { code: "not_found", message: "there is no sheet named " + JSON.stringify(a.sheet) + " (the sheets: " + book.map(function (s) { return JSON.stringify(s.name); }).join(", ") + ")" };
    } else for (var k = 0; k < book.length && at === -1; k++) if (!book[k].hidden) at = k;
    if (book[at].hidden) throw { code: "sheet_hidden", message: JSON.stringify(book[at].name) + " is hidden, and the editor shows no hidden sheet: show it first (office_edit showSheet)" };
    var ws = all[at], used = String(ws.GetUsedRange().GetAddress(false, false)), r = a.range, given = Boolean(r);
    if (!r) {
      var u = /^([A-Z]+)(\\d+)(?::([A-Z]+)(\\d+))?$/.exec(used);
      r = { col: 0, row: 0, cols: u ? colIndex(u[3] || u[1]) + 1 : 1, rows: u ? Number(u[4] || u[2]) : 1 };
    }
    // Frozen panes: the first cell after them (0 where none are frozen that way).
    var fc = 0, fr = 0;
    try {
      var panes = ws.GetFreezePanes(), loc = panes ? panes.GetLocation() : null, f = loc ? /^\\$?([A-Z]+)\\$?(\\d+)(?::\\$?([A-Z]+)\\$?(\\d+))?$/.exec(String(loc.GetAddress(false, false))) : null;
      if (f) {
        var ec = colIndex(f[3] || f[1]), er = Number(f[4] || f[2]) - 1;
        fc = ec >= 16383 ? 0 : ec + 1;
        fr = er >= 1048575 ? 0 : er + 1;
      }
    } catch (e) { fc = 0; fr = 0; }
    var colPx = function (c) {
      var name = colName(c);
      if (ws.GetRange(name + ":" + name).GetHidden()) return 0;
      var w = ws.GetRange(name + "1").GetColumnWidth();
      return Math.round((typeof w === "number" ? w : 8.43) * 7 + 5);
    };
    var rowPx = function (row) {
      if (ws.GetRange((row + 1) + ":" + (row + 1)).GetHidden()) return 0;
      var h = ws.GetRange("A" + (row + 1)).GetRowHeight();
      return typeof h === "number" ? Math.round(h * 4 / 3) : 19;
    };
    // The sizes (px at 100 %, 0 for a hidden one) of the range's columns and rows, as many as a picture takes at most.
    var sizes = function (from, n, px, most) { var out = []; for (var k = 0; k < n && k < most; k++) out.push(px(from + k)); return out; };
    var colW = sizes(r.col, r.cols, colPx, ${SHEET_MOST.cols}), rowH = sizes(r.row, r.rows, rowPx, ${SHEET_MOST.rows});
    // How many of them fit in room (px at 100 %).
    var fitting = function (px, room) {
      var sum = 0, k = 0;
      for (; k < px.length; k++) { sum += px[k]; if (sum > room) break; }
      return k;
    };
    var frozenOff = function (count, start, px) { var sum = 0; if (count && start >= count) for (var k = 0; k < count; k++) sum += px(k); return sum; };
    var offW = frozenOff(fc, r.col, colPx), offH = frozenOff(fr, r.row, rowPx), zoom = 0, cols = 0, rows = 0, cut = false;
    var views = [[1, ${SHEET_VIEW.header[1][0]}, ${SHEET_VIEW.header[1][1]}], [0.75, ${SHEET_VIEW.header[0.75][0]}, ${SHEET_VIEW.header[0.75][1]}]];
    for (var v = 0; v < views.length && !zoom; v++) {
      var z = views[v][0];
      cols = fitting(colW, (${SHEET_VIEW.width} - views[v][1]) / z - offW);
      rows = fitting(rowH, (${SHEET_VIEW.height} - views[v][2]) / z - offH);
      if (cols >= r.cols && rows >= r.rows) zoom = z;
    }
    var from = colName(r.col) + (r.row + 1);
    var largest = from + ":" + colName(r.col + Math.max(1, cols) - 1) + (r.row + Math.max(1, rows));
    if (!zoom) {
      var most = r.cols > ${SHEET_MOST.cols} || r.rows > ${SHEET_MOST.rows} ? " (a picture takes ${SHEET_MOST.cols} columns and ${SHEET_MOST.rows} rows at most, hidden ones counted)" : "";
      if (given) throw { code: "range_too_large", message: "the range " + from + ":" + colName(r.col + r.cols - 1) + (r.row + r.rows) + " is larger than the editor shows at 75 %" + most + ": the largest range from " + from + " that fits is " + largest + "; take it in parts" };
      r = { col: r.col, row: r.row, cols: Math.max(1, cols), rows: Math.max(1, rows) };
      zoom = 0.75;
      cut = true;
    }
    var range = from + ":" + colName(r.col + r.cols - 1) + (r.row + r.rows);
    // The hidden columns and rows of the range: the picture leaves them out, and so does its text.
    var hiddenCols = [], hiddenRows = [];
    for (var hc = 0; hc < r.cols; hc++) if (!colW[hc]) hiddenCols.push(r.col + hc);
    for (var hr = 0; hr < r.rows; hr++) if (!rowH[hr]) hiddenRows.push(r.row + hr);
    if (hiddenCols.length === r.cols || hiddenRows.length === r.rows) throw { code: "range_hidden", message: "every " + (hiddenCols.length === r.cols ? "column" : "row") + " of the range " + range + " is hidden, so a picture shows nothing of it" };
    var values = grid(ws.GetRange(range).GetValue()), formulas = grid(ws.GetRange(range).GetFormula()), shown = [], size = 0, truncated = false;
    for (var y = 0; y < values.length && !truncated; y++) {
      if (!rowH[y]) continue;
      for (var x = 0; x < values[y].length; x++) {
        if (!colW[x]) continue;
        var value = values[y][x], formula = formulas[y] ? formulas[y][x] : "";
        if (value === "" && !(typeof formula === "string" && formula.charAt(0) === "=")) continue;
        if (size > ${MAX_SHOWN_TEXT}) { truncated = true; break; }
        var one = { a: colName(r.col + x) + (r.row + y + 1), v: value };
        if (typeof formula === "string" && formula.charAt(0) === "=") one.f = formula;
        size += one.a.length + String(value).length + (one.f ? one.f.length : 0);
        shown.push(one);
      }
    }
    var c1 = r.col, r1 = r.row, c2 = r.col + r.cols - 1, r2 = r.row + r.rows - 1;
    var crosses = (fr > r1 && fr <= r2) || (fc > c1 && fc <= c2);
    var away = r2 + 300 < 1048576 ? [c1, r2 + 300] : [c1, 0];
    // The centre among the columns and rows that are shown (the editor does not scroll to a hidden one).
    var middle = function (lo, hi, hidden) {
      var showing = [];
      for (var k = lo; k <= hi; k++) if (hidden.indexOf(k) === -1) showing.push(k);
      return showing[Math.floor((showing.length - 1) / 2)];
    };
    var view = { kind: "cell", index: ws.GetIndex(), name: ws.GetName(), c1: c1, r1: r1, c2: c2, r2: r2, centre: [middle(c1, c2, hiddenCols), middle(r1, r2, hiddenRows)], away: away, zoom: zoom };
    if (crosses) view.frozen = [fc, fr];
    if (hiddenCols.length || hiddenRows.length) view.hidden = { cols: hiddenCols, rows: hiddenRows };
    var out = { sheet: ws.GetName(), range: range, used: used, cut: cut, zoom: zoom, cells: shown, view: view };
    if (truncated) out.truncated = true;
    if (view.hidden) out.hidden = true;
    return out;
  }
  try {
    return { result: a.kind === "word" ? word() : cell() };
  } catch (e) {
    return { error: e && e.code ? { code: e.code, message: e.message } : { code: "failed", message: String(e && e.message || e) } };
  }
}`;

/** The job kinds and the command each runs; edits recalculate the document after them, reads do not. (cell.edit is
 * the plugin's own run of CELL_EDIT_COMMANDS.) */
export const COMMANDS: Record<string, { source: string; edit: boolean }> = {
  "word.read": { source: WORD_READ, edit: false },
  "word.edit": { source: WORD_EDIT, edit: true },
  "word.format": { source: WORD_FORMAT, edit: true },
  "cell.read": { source: CELL_READ, edit: false },
  "word.comments": { source: WORD_COMMENTS, edit: false },
  "word.reply": { source: WORD_REPLY, edit: true },
  "cell.comments": { source: CELL_COMMENTS, edit: false },
  "cell.reply": { source: CELL_REPLY, edit: true },
  "word.pages": { source: WORD_PAGES, edit: false },
  "view.locate": { source: VIEW_LOCATE, edit: false },
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
  // A picture's locate: in Word, once the page count held still (the editor lays a document out after an edit, not at
  // once), so the page and its text are those the picture shows.
  function viewLocate(job) {
    if (!job.args || job.args.kind !== "word") return command(job);
    var pages = -1, since = Date.now(), began = Date.now();
    (function look() {
      call(commands["word.pages"].run, {}, false, function (out) {
        if (out.error) return command(job);
        if (out.result !== pages) { pages = out.result; since = Date.now(); }
        if (Date.now() - since >= ${VIEW_SETTLE.ms} || Date.now() - began >= ${VIEW_SETTLE.max}) return command(job);
        setTimeout(look, ${VIEW_SETTLE.every});
      });
    })();
  }
  function run(job) {
    if (job.kind === "cell.edit") return cellEdit(job);
    if ((job.kind === "word.reply" || job.kind === "cell.reply") && job.args && job.args.how === "method") return methodReply(job);
    if (job.kind === "chat.send") return chatSend(job);
    if (job.kind === "view.locate") return viewLocate(job);
    command(job);
  }
  function command(job) {
    var found = commands[job.kind];
    if (!found) return done(job, { error: { code: "bad_op", message: "no command " + job.kind } });
    window.Asc.scope.args = job.args;
    window.Asc.plugin.callCommand(found.run, false, found.edit, function (outcome) {
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
 * The size each agent's editor is made at, in CSS pixels, by its document's kind: a Word page fits whole at "fit to
 * page", and a sheet shows about 23 columns by 41 rows of default cells at 100 %. Made at that size from the start: a
 * spreadsheet editor resized after it was made draws no grid. The editors are stacked at the page's top left, inside
 * the browser's window (container.ts `--window-size`), where none is drawn less often for being off screen.
 */
export const EDITOR_SIZE: Record<string, { width: number; height: number }> = { word: { width: 1100, height: 1400 }, cell: { width: 1600, height: 1000 } };

/**
 * The seat page: it long-polls the listener (`poll`) for what to open and close, opens each editor in a frame of its
 * own (`new DocsAPI.DocEditor`, with the config the half minted and signed), and tells the listener what each editor
 * says of itself (`event`: ready; an error, which ends the wait for it; whether it holds changes it has not sent to
 * the Document Server yet, which an edit's save waits for).
 */
export const SEAT_PAGE_JS = `(function () {
  var sizes = ${JSON.stringify(EDITOR_SIZE)};
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
    // Its size is the page's, not part of what the Document Server checks of the config.
    var size = sizes[config.documentType] || sizes.word;
    config.width = size.width + "px";
    config.height = size.height + "px";
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

export const SEAT_PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Office agents</title><style>body{margin:0}iframe{position:absolute;top:0;left:0}</style></head><body><script src="page.js"></script></body></html>`;
