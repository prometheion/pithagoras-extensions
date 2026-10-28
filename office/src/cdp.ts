/**
 * Pictures of the agents' editors (office_screenshot), through the agents' browser's debugging channel (CDP).
 *
 *   tool -> seat.shot -> view.locate (the plugin: what to show, and the text it shows)
 *        -> cdp.shot -> docker exec <relay> node -e CDP_SRC <spec> -> CDP on <agent>:9222 -> FRAME_FN in the editor's frame
 *        <- one line "CDP <length> <sha256> <json>" <-
 *
 * The browser listens for CDP on its own network only (container.ts agentSpec): the relay is the one other container
 * there, and nothing reaches the relay's processes but a Docker exec, which only the portal (Docker for extensions)
 * can make. So the channel is a fixed Node script (CDP_SRC) run in the relay, whose one argument is data. The model's
 * part of it (a page, a range) was checked by ops.ts and normalized by the locate command, and reaches the editor's
 * frame only as an argument of `Runtime.callFunctionOn`, never as code.
 *
 * The picture is drawn from the editor's own canvases (FRAME_FN), not taken of the browser's screen: an editor's
 * frame can only give what that editor draws, so a shot never shows another editor, whatever is stacked above it on
 * the seat page, and leaves out the overlay with the selection, the cursors and co-authors' name labels.
 */
import { createHash } from "node:crypto";

/** Where the browser listens for CDP on the agents' network (socat in front of Chromium's own port, which it opens
 * on 127.0.0.1 only). */
export const CDP_PORT = 9222;
/** The script's own deadline, and the exec's above it: the script gives up (and the frame function stops before it
 * draws) before the exec is given up on. */
export const SHOT_MS = 12_000;
export const EXEC_MS = 15_000;
/** The longer side of a picture: by default, and with `large`. A picture is never made larger than the editor draws it. */
export const SHOT_SIDE = { normal: 1024, large: 1568 };
/** JPEG quality, and the lower one where a picture would be larger than SHOT_MAX_BYTES. */
export const SHOT_QUALITY = { normal: 0.75, low: 0.6 };
export const SHOT_MAX_BYTES = 1024 * 1024;
/** The largest picture the portal takes, in bytes: the frame function's lower quality may leave a picture above
 * SHOT_MAX_BYTES, but what runs in the editor's frame is the document's side, and a picture far larger than any the
 * editor makes (a page's script can replace the canvas's own methods) would fail the model's every later turn. */
export const SHOT_TAKEN_BYTES = 1.5 * SHOT_MAX_BYTES;
/** The most the client takes of the editor's answer, and the portal of the client's output, in characters: such a
 * picture as base64 and a little more. Docker's exec gives the output whole, so the client stops a larger answer. */
export const SHOT_MAX_CHARS = Math.ceil((SHOT_TAKEN_BYTES * 4) / 3) + 4096;

/** What the locate command (seat-page.ts) says is to be shown, as the frame function takes it. */
export type ShotTarget =
  | { kind: "word"; page: number; pages: number }
  | { kind: "cell"; index: number; name: string; c1: number; r1: number; c2: number; r2: number; centre: [number, number]; away: [number, number]; zoom: number; frozen?: [number, number]; hidden?: { cols: number[]; rows: number[] } };

/** A picture: base64 JPEG and its size, and what the editor showed (a sheet's zoom, a document's settled pages). */
export type ShotImage = { data: string; width: number; height: number; zoom?: number; pages?: number };

/**
 * What runs in the agent's editor's frame, as `Runtime.callFunctionOn` calls it with one argument, `t` (a ShotTarget
 * with `large`, `until` (the deadline, ms since the epoch), `settleMs`, `settleMaxMs`, and the picture's limits).
 * It moves only the agent's own view (page, zoom, scroll, selection), then draws what the editor's canvas shows into a
 * canvas of its own and answers that as a JPEG; or `{error: {code, message}}`. A second shot of the same editor that
 * begins meanwhile ends this one (`superseded`), as does the deadline, both checked after every wait.
 *
 * Word: the layout is waited for until the page count holds still (it lands up to 0.7 s after an edit of 20 pages);
 * then "fit to page" and the page, and the page's rectangle found on the canvas `#id_viewer` (white on grey): the pages
 * in view down a line inside their left margin, the one drawn whole at the top (the last page's at the bottom: the
 * view does not scroll past the end), and its sides along a line just below its top (inside its top margin).
 * Co-authors' marks are switched off in the agent's editor first.
 * Sheets: the sheet shown (where it is still the one the locate named, and not hidden), the zoom set, and the range
 * made visible, its hidden columns and rows skipped: as it is, or else with its centre cell found (the
 * editor centres a cell it scrolls to), from a cell far from it; both corners must then be inside the grid, and the
 * first corner where it was before the second was looked up. A range across frozen panes is looked at from the first
 * cell after them, where the panes and the rest join. The picture is the range with its column letters and row numbers:
 * the headers' strips cut to the range, from the cells' canvas and the one with charts and pictures above it.
 */
export const FRAME_FN = `async function (t) {
  var token = String(Math.random());
  window.__pithagorasShot = token;
  function stop(code, message) { return { error: { code: code, message: message } }; }
  function alive() {
    if (window.__pithagorasShot !== token) throw { code: "superseded", message: "another picture of this editor was begun" };
    if (Date.now() > t.until) throw { code: "timeout", message: "the picture took too long" };
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Two frames drawn, or 100 ms where the frame is not drawn now.
  function drawn() { return Promise.race([new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); }), sleep(100)]); }
  function jpeg(parts, width, height) {
    var scale = Math.min(1, (t.large ? t.side.large : t.side.normal) / Math.max(width, height));
    var out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(width * scale));
    out.height = Math.max(1, Math.round(height * scale));
    var g = out.getContext("2d");
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, out.width, out.height);
    parts.forEach(function (p) {
      if (p.w > 0 && p.h > 0) g.drawImage(p.from, p.x, p.y, p.w, p.h, p.dx * scale, p.dy * scale, p.w * scale, p.h * scale);
    });
    var url = out.toDataURL("image/jpeg", t.quality.normal);
    if ((url.length - url.indexOf(",") - 1) * 3 / 4 > t.maxBytes) url = out.toDataURL("image/jpeg", t.quality.low);
    return { data: url.slice(url.indexOf(",") + 1), width: out.width, height: out.height };
  }
  async function word() {
    var api = window.editor;
    if (!api || typeof api.getCountPages !== "function") return stop("not_ready", "the editor is not ready");
    var pages = api.getCountPages(), since = Date.now(), began = Date.now();
    if (pages !== t.pages) {
      while (Date.now() - since < t.settleMs && Date.now() - began < t.settleMaxMs) {
        await sleep(50);
        alive();
        var now = api.getCountPages();
        if (now !== pages) { pages = now; since = Date.now(); }
      }
    }
    if (t.page > pages) return stop("no_page", "the document has " + pages + " page" + (pages === 1 ? "" : "s") + " as the editor lays it out now");
    try { api.asc_setDrawCollaborationMarks(false); } catch (e) {}
    api.zoomFitToPage();
    api.goToPage(t.page - 1);
    await drawn();
    await sleep(100);
    alive();
    var cv = document.getElementById("id_viewer");
    if (!cv) return stop("not_drawn", "the editor has no page canvas");
    var W = cv.width, H = cv.height, d = cv.getContext("2d").getImageData(0, 0, W, H).data;
    var white = function (x, y) { var i = (y * W + x) * 4; return d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250 && d[i + 3] > 250; };
    // A page's sides along a line through it, from either end to the first white.
    var sides = function (y) {
      var l = -1, r = -1;
      for (var x = 0; x < W && l === -1; x++) if (white(x, y)) l = x;
      for (var x2 = W - 1; x2 >= 0 && r === -1; x2--) if (white(x2, y)) r = x2;
      return [l, r];
    };
    // A line through some page: down the middle to the first white.
    var some = -1, mid = W >> 1;
    for (var y = 0; y < H && some === -1; y++) if (white(mid, y)) some = y;
    if (some === -1) return stop("not_drawn", "the page is not on the editor's canvas");
    // The pages in view, down a line just inside their left edge (in their margin): each white run with grey above
    // and below it is a page drawn whole. The page gone to is at the top of the view, but the last page, which the
    // view cannot scroll to the top, is at its bottom.
    var edge = sides(some)[0] + 3, whole = [], from = -1;
    for (var y2 = 0; y2 <= H; y2++) {
      var on = y2 < H && white(edge, y2);
      if (on && from === -1) from = y2;
      if (!on && from !== -1) {
        if (from > 0 && y2 < H) whole.push([from, y2 - 1]);
        from = -1;
      }
    }
    var run = whole.length ? whole[t.page === pages ? whole.length - 1 : 0] : null;
    if (!run) return stop("not_drawn", "the page is not on the editor's canvas");
    var top = run[0], bottom = run[1], at = sides(Math.min(bottom, top + 4)), left = at[0], right = at[1];
    if (right - left < 100 || bottom - top < 100) return stop("not_drawn", "the page is not on the editor's canvas");
    var shot = jpeg([{ from: cv, x: left, y: top, w: right - left + 1, h: bottom - top + 1, dx: 0, dy: 0 }], right - left + 1, bottom - top + 1);
    shot.pages = pages;
    return shot;
  }
  async function cell() {
    var api = window.Asc && window.Asc.editor;
    if (!api || typeof api.asc_findCell !== "function" || typeof api.asc_getWorksheetName !== "function" || typeof api.asc_isWorksheetHidden !== "function") return stop("not_ready", "the editor is not ready");
    // The sheet the locate named, where it is still that one and not hidden: a person may have hidden, moved or renamed
    // it since, and asc_showWorksheet of a hidden sheet unhides it (a change to the document, which co-editing sends).
    if (!(t.index < api.asc_getWorksheetsCount()) || api.asc_getWorksheetName(t.index) !== t.name || api.asc_isWorksheetHidden(t.index)) return stop("sheet_changed", "the sheet " + JSON.stringify(t.name) + " was hidden, moved or renamed while the picture was taken; try again");
    if (api.asc_getActiveWorksheetIndex() !== t.index) {
      api.asc_showWorksheet(t.index);
      await drawn();
      alive();
      if (api.asc_getActiveWorksheetIndex() !== t.index) return stop("not_drawn", "the editor did not show the sheet");
    }
    var cv = document.getElementById("ws-canvas"), charts = document.getElementById("ws-canvas-graphic");
    if (!cv) return stop("not_drawn", "the editor has no sheet canvas");
    var g = cv.getContext("2d");
    // A cell's place as the editor draws it now; looking a cell up selects it, and scrolls where it is not in view.
    var at = function (c, r) {
      var a = "";
      for (var n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) a = String.fromCharCode(65 + (n - 1) % 26) + a;
      api.asc_findCell(a + (r + 1));
      var q = api.asc_getActiveCellCoord();
      return { x: q.asc_getX(), y: q.asc_getY(), w: q.asc_getWidth(), h: q.asc_getHeight() };
    };
    var near = function (a, b) { return Math.abs(a - b) <= 1; };
    // The range's columns and rows that are shown: the editor draws a hidden one as nothing, and is not asked for one.
    var hidden = t.hidden || { cols: [], rows: [] }, cs = [], rs = [];
    for (var hc = t.c1; hc <= t.c2; hc++) if (hidden.cols.indexOf(hc) === -1) cs.push(hc);
    for (var hr = t.r1; hr <= t.r2; hr++) if (hidden.rows.indexOf(hr) === -1) rs.push(hr);
    if (!cs.length || !rs.length) return stop("range_hidden", "every column or row of the range is hidden");
    // The range's rectangle where all of it is in view at once, else null: along its first row and down its first
    // column each cell must start where the one before it ends (a cell looked up out of view would scroll it), and its
    // first cell must stay where it was between the two.
    var whole = function () {
      var tl = at(cs[0], rs[0]), last = tl;
      for (var c = 1; c < cs.length; c++) {
        var k = at(cs[c], rs[0]);
        if (!near(k.x, last.x + last.w) || !near(k.y, tl.y)) return null;
        last = k;
      }
      var right = last.x + last.w, again = at(cs[0], rs[0]);
      if (!near(again.x, tl.x) || !near(again.y, tl.y)) return null;
      last = tl;
      for (var r = 1; r < rs.length; r++) {
        var k2 = at(cs[0], rs[r]);
        if (!near(k2.y, last.y + last.h) || !near(k2.x, tl.x)) return null;
        last = k2;
      }
      at(cs[0], rs[0]);
      if (right > cv.width || last.y + last.h > cv.height) return null;
      return { x: tl.x, y: tl.y, w: right - tl.x, h: last.y + last.h - tl.y };
    };
    var pixel = function (x, y) { return Array.prototype.join.call(g.getImageData(x, y, 1, 1).data, ","); };
    // The headers' size, as drawn now (the row numbers' strip is wider for longer numbers): the corner where both
    // strips meet is one colour up to its borders, along its top and its left edge; the border is the header's last
    // pixel. (Not along the range's first row or column: next to hidden rows or columns the editor draws a second line
    // there.)
    var headers = function () {
      var bg = pixel(1, 1), x = 1, y = 1;
      while (x < cv.width && pixel(x, 1) === bg) x++;
      while (y < cv.height && pixel(1, y) === bg) y++;
      return { x: x + 1, y: y + 1 };
    };
    // In view as the editor stands, else from a cell just after frozen panes the range crosses (where the panes and
    // the rest join), else with its centre found from a cell far from it (the editor centres a cell it scrolls to).
    var place = async function () {
      for (var attempt = 0; attempt < 2; attempt++) {
        if (attempt === 1) {
          // The cell after the first one after the panes: DS 10.0 does not scroll back to the first one itself (its
          // place is answered as above the view, and the view stays). Near the sheet's start, the editor's centring
          // puts the view where the panes and the rest join.
          if (t.frozen) at(t.frozen[0] + 1, t.frozen[1] + 1);
          else { at(cs[0], t.away[1]); await drawn(); at(t.centre[0], t.centre[1]); }
        }
        await drawn();
        alive();
        var box = whole();
        if (!box) continue;
        await drawn();
        alive();
        var head = headers();
        if (box.x >= head.x && box.y >= head.y) return { box: box, head: head };
      }
      return null;
    };
    var zooms = t.zoom === 1 ? [1, 0.75] : [t.zoom];
    for (var z = 0; z < zooms.length; z++) {
      if (Math.abs(api.asc_getZoom() - zooms[z]) > 0.001) {
        api.asc_setZoom(zooms[z]);
        await drawn();
        await sleep(50);
        alive();
      }
      var placed = await place();
      if (!placed) continue;
      var hx = placed.head.x, hy = placed.head.y, x0 = placed.box.x, y0 = placed.box.y, w = placed.box.w, h = placed.box.h, parts = [];
      [cv, charts].forEach(function (layer) {
        if (!layer) return;
        parts.push({ from: layer, x: 0, y: 0, w: hx, h: hy, dx: 0, dy: 0 });
        parts.push({ from: layer, x: x0, y: 0, w: w, h: hy, dx: hx, dy: 0 });
        parts.push({ from: layer, x: 0, y: y0, w: hx, h: h, dx: 0, dy: hy });
        parts.push({ from: layer, x: x0, y: y0, w: w, h: h, dx: hx, dy: hy });
      });
      var shot = jpeg(parts, hx + w, hy + h);
      shot.zoom = zooms[z];
      return shot;
    }
    return stop("range_too_large", "the range does not fit in the editor's view at " + Math.round(zooms[zooms.length - 1] * 100) + " %");
  }
  try {
    return t.kind === "word" ? await word() : await cell();
  } catch (e) {
    return e && e.code ? { error: { code: String(e.code), message: String(e.message || e.code) } } : stop("failed", String(e && e.message || e));
  }
}`;

/**
 * The client, run in the relay as `node --no-warnings -e CDP_SRC <spec>` (its one argument, JSON: `browser`, the
 * browser's container name; `port`; `editorId`; `ms`, its deadline from its start; `target`, FRAME_FN's argument). It
 * finds the browser by its name and speaks to it by its address (Chromium refuses a Host header that is not an
 * address), takes the seat page, finds the editor's frame (`frameEditorId=editor-<editorId>` in its address, which
 * the editor's API gives it), and calls FRAME_FN in that frame's own context. It writes one line, `CDP <length>
 * <sha256> <json>`, and nothing else (Docker's exec gives stdout and stderr as one): the answer, or `{error}`.
 */
export const CDP_SRC = `"use strict";
const crypto = require("node:crypto");
const dns = require("node:dns");
const FRAME_FN = ${JSON.stringify(FRAME_FN)};
const began = Date.now();
let done = false;
function finish(out) {
  if (done) return;
  done = true;
  let json = JSON.stringify(out);
  if (json.length > ${SHOT_MAX_CHARS}) json = JSON.stringify({ error: { code: "failed", message: "the editor's answer is larger than a picture may be" } });
  process.stdout.write("CDP " + Buffer.byteLength(json) + " " + crypto.createHash("sha256").update(json).digest("hex") + " " + json + "\\n", () => process.exit(0));
}
const fail = (code, message) => finish({ error: { code: code, message: message } });
process.on("uncaughtException", (e) => fail("failed", String((e && e.message) || e)));
process.on("unhandledRejection", (e) => fail("failed", String((e && e.message) || e)));
let input;
try {
  input = JSON.parse(process.argv[1]);
} catch (e) {
  input = null;
}
if (!input || typeof input.browser !== "string" || typeof input.editorId !== "string" || !input.target) {
  fail("failed", "no spec");
} else {
  const until = began + Number(input.ms);
  setTimeout(() => fail("timeout", "the picture took longer than " + input.ms + " ms"), Math.max(0, until - Date.now()));
  (async () => {
    const found = await dns.promises.lookup(input.browser, { family: 4 });
    const base = found.address + ":" + Number(input.port);
    const list = await (await fetch("http://" + base + "/json/list", { signal: AbortSignal.timeout(Math.max(1, until - Date.now())) })).json();
    const seat = (Array.isArray(list) ? list : []).find((p) => p && p.type === "page" && /\\/seat\\/[0-9a-f]{64}\\/$/.test(String(p.url)));
    if (!seat || typeof seat.webSocketDebuggerUrl !== "string") return fail("agent_unavailable", "the agents' browser has no seat page open");
    const ws = new WebSocket("ws://" + base + seat.webSocketDebuggerUrl.replace(/^ws:\\/\\/[^/]+/, ""));
    let n = 0;
    const waiting = new Map();
    const contexts = [];
    ws.onmessage = (event) => {
      // Nothing the editor's frame answers is taken larger than a picture may be (a page's script can answer more).
      if (String(event.data).length > ${SHOT_MAX_CHARS}) return fail("failed", "the editor's answer is larger than a picture may be");
      const m = JSON.parse(String(event.data));
      if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
      const w = m.id !== undefined && waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.no(new Error(m.error.message));
      else w.ok(m.result);
    };
    ws.onclose = () => fail("agent_unavailable", "the agents' browser closed the connection");
    await new Promise((ok, no) => {
      ws.onopen = ok;
      ws.onerror = () => no(new Error("the agents' browser refused the connection"));
    });
    const send = (method, params) => new Promise((ok, no) => {
      n++;
      waiting.set(n, { ok, no });
      ws.send(JSON.stringify({ id: n, method, params: params || {} }));
    });
    const tree = await send("Page.getFrameTree");
    const frames = [];
    (function walk(node) {
      if (!node) return;
      frames.push(node.frame);
      for (const child of node.childFrames || []) walk(child);
    })(tree.frameTree);
    const want = "editor-" + input.editorId;
    const frame = frames.find((f) => {
      try {
        return new URL(f.url).searchParams.get("frameEditorId") === want;
      } catch (e) {
        return false;
      }
    });
    if (!frame) return fail("editor_not_ready", "the agent's editor is not in the agents' browser");
    await send("Runtime.enable");
    const context = contexts.find((c) => c.auxData && c.auxData.frameId === frame.id && c.auxData.isDefault);
    if (!context) return fail("editor_not_ready", "the agent's editor has no script context");
    const res = await send("Runtime.callFunctionOn", {
      functionDeclaration: FRAME_FN,
      executionContextId: context.id,
      arguments: [{ value: Object.assign({}, input.target, { until: until }) }],
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) return fail("failed", String((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text));
    finish(res.result && res.result.value ? res.result.value : { error: { code: "failed", message: "the editor gave nothing back" } });
  })().catch((e) => fail("agent_unavailable", String((e && e.message) || e)));
}
`;

/** A coded error the seats pass on (seat.ts turns it into a SeatError). */
export class ShotError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/** How the client is run: a command in the relay (container.ts `execRelay`), and the browser's container name. */
export interface CdpDeps {
  exec(cmd: string[], timeoutMs: number): Promise<{ output: string; exitCode: number | null; timedOut: boolean }>;
  browser: string;
  port?: number;
}

/** The answer in the client's output: its one `CDP <length> <sha256> <json>` line, whole and as written, and no
 * larger than the client writes. */
export function readFrame(output: string): unknown {
  if (output.length > SHOT_MAX_CHARS + 1024) throw new ShotError("failed", "the picture's channel gave more than a picture may be");
  const at = output.lastIndexOf("CDP ");
  const m = at === -1 ? null : /^CDP (\d+) ([0-9a-f]{64}) /.exec(output.slice(at));
  if (!m) throw new ShotError("failed", `the picture's channel gave no answer${output.trim() ? `: ${output.trim().slice(0, 200)}` : ""}`);
  const start = at + m[0].length;
  const json = Buffer.from(output.slice(start), "utf8").subarray(0, Number(m[1])).toString("utf8");
  if (Buffer.byteLength(json) !== Number(m[1]) || createHash("sha256").update(json).digest("hex") !== m[2]) throw new ShotError("failed", "the picture's channel gave a damaged answer");
  return JSON.parse(json);
}

/**
 * A picture of the editor `editorId` as `target` says (seat.ts calls it with what the locate command answered, in
 * the same step of that editor's queue). Rejects with a ShotError: the frame function's code (`no_page`,
 * `range_too_large`, `not_drawn`, …), `timeout`, `agent_unavailable` or `failed`.
 */
export async function shot(editorId: string, target: ShotTarget & { large?: boolean }, deps: CdpDeps): Promise<ShotImage> {
  const spec = {
    browser: deps.browser,
    port: deps.port ?? CDP_PORT,
    editorId,
    ms: SHOT_MS,
    target: { ...target, large: Boolean(target.large), side: SHOT_SIDE, quality: SHOT_QUALITY, maxBytes: SHOT_MAX_BYTES, settleMs: 300, settleMaxMs: 5000 },
  };
  const res = await deps.exec(["node", "--no-warnings", "-e", CDP_SRC, JSON.stringify(spec)], EXEC_MS);
  if (res.timedOut) throw new ShotError("timeout", `the picture took longer than ${EXEC_MS / 1000} s`);
  const out = readFrame(res.output) as { error?: { code?: string; message?: string }; data?: unknown; width?: unknown; height?: unknown; zoom?: unknown; pages?: unknown };
  if (out.error) throw new ShotError(String(out.error.code ?? "failed"), String(out.error.message ?? "the picture failed"));
  if (typeof out.data !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(out.data) || typeof out.width !== "number" || typeof out.height !== "number") throw new ShotError("failed", "the picture's channel gave no picture");
  // The picture as the editor's frame gave it is the document's side: taken only as a JPEG of the size it says, and
  // no larger than the editor makes one.
  const bytes = Buffer.from(out.data, "base64");
  if (bytes.length > SHOT_TAKEN_BYTES) throw new ShotError("failed", `the editor gave a picture of ${bytes.length} bytes, larger than a picture may be`);
  const side = (n: number) => Number.isInteger(n) && n >= 1 && n <= SHOT_SIDE.large;
  const size = jpegSize(bytes);
  if (!size || !side(out.width) || !side(out.height) || size.width !== out.width || size.height !== out.height) throw new ShotError("failed", "the editor gave no JPEG picture of the size it says");
  return { data: out.data, width: out.width, height: out.height, ...(typeof out.zoom === "number" ? { zoom: out.zoom } : {}), ...(typeof out.pages === "number" ? { pages: out.pages } : {}) };
}

/** A JPEG's width and height, from its frame header (SOF); null where `bytes` is no JPEG or has none. */
export function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // Fill bytes, and the markers that stand alone.
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return null;
    // SOF0 to SOF15, not DHT (C4), JPG (C8) or DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return null;
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}
