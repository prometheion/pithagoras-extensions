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

/** What the locate command (seat-page.ts) says is to be shown, as the frame function takes it. */
export type ShotTarget =
  | { kind: "word"; page: number; pages: number }
  | { kind: "cell"; index: number; c1: number; r1: number; c2: number; r2: number; centre: [number, number]; away: [number, number]; zoom: number; frozen?: [number, number] };

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
 * then "fit to page" and the page, and the page's rectangle found on the canvas `#id_viewer` (white on grey): down the
 * middle for its top, along a line just below its top for its sides (inside its top margin), and down a line just
 * inside its left edge for its bottom. Co-authors' marks are switched off in the agent's editor first.
 * Sheets: the sheet shown, the zoom set, and the range made visible: as it is, or else with its centre cell found (the
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
    var top = -1, mid = W >> 1, left = -1, right = -1, bottom = H - 1;
    for (var y = 0; y < H && top === -1; y++) if (white(mid, y)) top = y;
    if (top === -1) return stop("not_drawn", "the page is not on the editor's canvas");
    var line = Math.min(H - 1, top + 4);
    for (var x = 0; x < W && left === -1; x++) if (white(x, line)) left = x;
    for (var x2 = W - 1; x2 >= 0 && right === -1; x2--) if (white(x2, line)) right = x2;
    for (var y2 = top; y2 < H; y2++) if (!white(left + 3, y2)) { bottom = y2 - 1; break; }
    if (right - left < 100 || bottom - top < 100) return stop("not_drawn", "the page is not on the editor's canvas");
    var shot = jpeg([{ from: cv, x: left, y: top, w: right - left + 1, h: bottom - top + 1, dx: 0, dy: 0 }], right - left + 1, bottom - top + 1);
    shot.pages = pages;
    return shot;
  }
  async function cell() {
    var api = window.Asc && window.Asc.editor;
    if (!api || typeof api.asc_findCell !== "function") return stop("not_ready", "the editor is not ready");
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
    // The range's rectangle where all of it is in view at once, else null: along its first row and down its first
    // column each cell must start where the one before it ends (a cell looked up out of view would scroll it), and its
    // first cell must stay where it was between the two.
    var whole = function () {
      var tl = at(t.c1, t.r1), last = tl;
      for (var c = t.c1 + 1; c <= t.c2; c++) {
        var k = at(c, t.r1);
        if (!near(k.x, last.x + last.w) || !near(k.y, tl.y)) return null;
        last = k;
      }
      var right = last.x + last.w, again = at(t.c1, t.r1);
      if (!near(again.x, tl.x) || !near(again.y, tl.y)) return null;
      last = tl;
      for (var r = t.r1 + 1; r <= t.r2; r++) {
        var k2 = at(t.c1, r);
        if (!near(k2.y, last.y + last.h) || !near(k2.x, tl.x)) return null;
        last = k2;
      }
      at(t.c1, t.r1);
      if (right > cv.width || last.y + last.h > cv.height) return null;
      return { x: tl.x, y: tl.y, w: right - tl.x, h: last.y + last.h - tl.y };
    };
    var pixel = function (x, y) { return Array.prototype.join.call(g.getImageData(x, y, 1, 1).data, ","); };
    // The headers' size, as drawn now (the row numbers' strip is wider for longer numbers): each strip is one colour
    // up to its border, along a line through the first pixels of the range's first row and column; the border is the
    // header's last pixel.
    var headers = function (box) {
      var bg = pixel(1, box.y + 1), x = 1, y = 1;
      while (x < cv.width && pixel(x, box.y + 1) === bg) x++;
      bg = pixel(box.x + 1, 1);
      while (y < cv.height && pixel(box.x + 1, y) === bg) y++;
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
          else { at(t.away[0], t.away[1]); await drawn(); at(t.centre[0], t.centre[1]); }
        }
        await drawn();
        alive();
        var box = whole();
        if (!box) continue;
        await drawn();
        alive();
        var head = headers(box);
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
  const json = JSON.stringify(out);
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

/** The answer in the client's output: its one `CDP <length> <sha256> <json>` line, whole and as written. */
export function readFrame(output: string): unknown {
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
  return { data: out.data, width: out.width, height: out.height, ...(typeof out.zoom === "number" ? { zoom: out.zoom } : {}), ...(typeof out.pages === "number" ? { pages: out.pages } : {}) };
}
