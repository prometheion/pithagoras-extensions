/**
 * Unit tests for src/cdp.ts: the client (CDP_SRC) run as the relay runs it, `node --no-warnings -e CDP_SRC <spec>`,
 * against a DevTools server of the test's own (its /json/list and a WebSocket that answers the commands the client
 * sends); and the frame function (FRAME_FN) run on a scripted editor frame: a Word editor whose canvas holds a page, a
 * spreadsheet editor that scrolls as the real one does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import vm from "node:vm";
import { CDP_SRC, FRAME_FN, readFrame, shot, ShotError, SHOT_SIDE, SHOT_QUALITY, SHOT_MAX_BYTES } from "../src/cdp";

/* ---------------- a DevTools server ---------------- */

type Sent = { id: number; method: string; params: Record<string, any> };

/**
 * /json/list with the targets given, and the seat page's WebSocket: every command the client sends is recorded and
 * answered by `answer` (undefined: never answered); `Runtime.enable` also raises the frames' contexts first.
 */
async function devtools(opts: { targets?: (base: string) => unknown[]; frames?: { id: string; url: string }[]; answer?: (m: Sent) => unknown }) {
  const sent: Sent[] = [];
  const hosts: string[] = [];
  const origins: (string | undefined)[] = [];
  const frames = opts.frames ?? [];
  const server = http.createServer((req, res) => {
    hosts.push(String(req.headers.host));
    if (req.url === "/json/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(opts.targets ? opts.targets(base) : [{ type: "page", url: `http://relay:3891/seat/${"a".repeat(64)}/`, webSocketDebuggerUrl: `ws://localhost:9222/devtools/page/P1` }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const sockets: Duplex[] = [];
  server.on("upgrade", (req, socket: Duplex) => {
    sockets.push(socket);
    origins.push(req.headers.origin);
    hosts.push(`ws ${req.headers.host} ${req.url}`);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (o: unknown) => {
      const body = Buffer.from(JSON.stringify(o));
      const head = body.length < 126 ? Buffer.from([0x81, body.length]) : body.length < 65536 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255]) : Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0]), Buffer.from([(body.length >>> 24) & 255, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255])]);
      socket.write(Buffer.concat([head, body]));
    };
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 127;
        let at = 2;
        if (len === 126) {
          len = buf.readUInt16BE(2);
          at = 4;
        } else if (len === 127) {
          len = Number(buf.readBigUInt64BE(2));
          at = 10;
        }
        if (buf.length < at + 4 + len) return;
        const mask = buf.subarray(at, at + 4);
        const data = Buffer.from(buf.subarray(at + 4, at + 4 + len).map((b, i) => b ^ mask[i % 4]));
        const op = buf[0] & 15;
        buf = buf.subarray(at + 4 + len);
        if (op === 8) return socket.end();
        if (op !== 1) continue;
        const m = JSON.parse(data.toString("utf8")) as Sent;
        sent.push(m);
        if (m.method === "Runtime.enable") {
          frames.forEach((f, i) => send({ method: "Runtime.executionContextCreated", params: { context: { id: 100 + i, auxData: { frameId: f.id, isDefault: true } } } }));
          frames.forEach((f, i) => send({ method: "Runtime.executionContextCreated", params: { context: { id: 200 + i, auxData: { frameId: f.id, isDefault: false } } } }));
        }
        const result = m.method === "Page.getFrameTree" ? { frameTree: { frame: { id: "top", url: `http://relay:3891/seat/${"a".repeat(64)}/` }, childFrames: frames.map((f) => ({ frame: f, childFrames: [] })) } } : opts.answer ? opts.answer(m) : {};
        if (result !== undefined) send({ id: m.id, result });
      }
    });
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const base = `127.0.0.1:${port}`;
  return {
    port,
    sent,
    hosts,
    origins,
    async close() {
      for (const s of sockets) s.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/** The client run as the relay runs it: its output, as Docker's exec gives it (both streams as one). */
function runClient(spec: unknown): Promise<string> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--no-warnings", "-e", CDP_SRC, JSON.stringify(spec)], { timeout: 20_000 }, (_e, stdout, stderr) => resolve(stdout + stderr));
  });
}

const EDITOR = "0b1c2d3e-aaaa-bbbb-cccc-0123456789ab";
const FRAMES = [
  { id: "F-other", url: `http://relay:3890/web-apps/apps/documenteditor/main/index.html?frameEditorId=editor-${EDITOR}x&lang=en` },
  { id: "F-mine", url: `http://relay:3890/web-apps/apps/spreadsheeteditor/main/index.html?lang=en&frameEditorId=editor-${EDITOR}` },
];

test("the client finds the seat page and the editor's own frame by its exact id, and calls the frame function there with the target as an argument, never as code", async () => {
  const hostile = "a'); alert(1);//";
  const d = await devtools({ frames: FRAMES, answer: (m) => (m.method === "Runtime.callFunctionOn" ? { result: { type: "object", value: { data: "/9j/", width: 3, height: 2, zoom: 1 } } } : {}) });
  try {
    const out = await runClient({ browser: "127.0.0.1", port: d.port, editorId: EDITOR, ms: 8000, target: { kind: "cell", index: 0, sheet: hostile, c1: 0 } });
    assert.deepEqual(readFrame(out), { data: "/9j/", width: 3, height: 2, zoom: 1 });
    assert.match(out, /^CDP \d+ [0-9a-f]{64} \{.*\}\n$/, "one line and nothing else");
    const call = d.sent.find((m) => m.method === "Runtime.callFunctionOn")!;
    assert.equal(call.params.functionDeclaration, FRAME_FN, "the fixed function, nothing of the target in it");
    assert.equal(call.params.executionContextId, 101, "the editor's own frame's main context");
    assert.equal(call.params.arguments.length, 1);
    assert.equal(call.params.arguments[0].value.sheet, hostile, "the target is data");
    assert.equal(typeof call.params.arguments[0].value.until, "number");
    assert.equal(call.params.returnByValue, true);
    assert.equal(call.params.awaitPromise, true);
    assert.deepEqual(d.sent.map((m) => m.method), ["Page.getFrameTree", "Runtime.enable", "Runtime.callFunctionOn"]);
    // By its address, which Chromium wants as the Host, on the seat page's own path.
    assert.ok(d.hosts.includes(`127.0.0.1:${d.port}`));
    assert.ok(d.hosts.includes(`ws 127.0.0.1:${d.port} /devtools/page/P1`));
    assert.deepEqual(d.origins, [undefined], "no Origin: Chromium refuses a WebSocket that has one");
  } finally {
    await d.close();
  }
});

test("the client says what it did not find: no seat page, no frame of that editor", async () => {
  const none = await devtools({ targets: () => [{ type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://x/devtools/page/B" }] });
  try {
    assert.deepEqual(readFrame(await runClient({ browser: "127.0.0.1", port: none.port, editorId: EDITOR, ms: 5000, target: { kind: "word" } })), { error: { code: "agent_unavailable", message: "the agents' browser has no seat page open" } });
  } finally {
    await none.close();
  }
  const other = await devtools({ frames: [FRAMES[0]] });
  try {
    assert.deepEqual(readFrame(await runClient({ browser: "127.0.0.1", port: other.port, editorId: EDITOR, ms: 5000, target: { kind: "word" } })), { error: { code: "editor_not_ready", message: "the agent's editor is not in the agents' browser" } });
    assert.ok(!other.sent.some((m) => m.method === "Runtime.callFunctionOn"));
  } finally {
    await other.close();
  }
});

test("the client gives up at its own deadline, before the exec's, with one line that says so", async () => {
  const d = await devtools({ frames: FRAMES, answer: (m) => (m.method === "Runtime.callFunctionOn" ? undefined : {}) });
  try {
    const began = Date.now();
    const out = await runClient({ browser: "127.0.0.1", port: d.port, editorId: EDITOR, ms: 600, target: { kind: "word" } });
    assert.ok(Date.now() - began < 5000);
    assert.deepEqual(readFrame(out), { error: { code: "timeout", message: "the picture took longer than 600 ms" } });
    assert.ok(d.sent.find((m) => m.method === "Runtime.callFunctionOn")!.params.arguments[0].value.until <= began + 600 + 200, "the frame function has the same deadline");
  } finally {
    await d.close();
  }
});

test("readFrame takes the answer only whole and as written", () => {
  const json = JSON.stringify({ data: "QUJD", width: 1, height: 1 });
  const line = `CDP ${Buffer.byteLength(json)} ${createHash("sha256").update(json).digest("hex")} ${json}\n`;
  assert.deepEqual(readFrame(`some noise\n${line}`), { data: "QUJD", width: 1, height: 1 });
  assert.throws(() => readFrame(line.replace("QUJD", "QUJE")), /damaged/);
  assert.throws(() => readFrame(line.slice(0, -10)), /damaged/, "cut short");
  assert.throws(() => readFrame("node: bad option"), /gave no answer: node: bad option/);
});

test("shot runs the client in the relay with its spec, and turns its answer into a picture or a coded error", async () => {
  const calls: { cmd: string[]; ms: number }[] = [];
  const answer = (o: unknown) => {
    const json = JSON.stringify(o);
    return `CDP ${Buffer.byteLength(json)} ${createHash("sha256").update(json).digest("hex")} ${json}\n`;
  };
  let output = answer({ data: "QUJD", width: 7, height: 9, pages: 4 });
  const deps = { browser: "pithagoras-office-ds-agent", exec: async (cmd: string[], ms: number) => (calls.push({ cmd, ms }), { output, exitCode: 0, timedOut: false }) };
  assert.deepEqual(await shot("e1", { kind: "word", page: 2, pages: 4, large: true }, deps), { data: "QUJD", width: 7, height: 9, pages: 4 });
  assert.deepEqual(calls[0].cmd.slice(0, 4), ["node", "--no-warnings", "-e", CDP_SRC]);
  assert.equal(calls[0].ms, 15_000);
  const spec = JSON.parse(calls[0].cmd[4]);
  assert.deepEqual(spec, { browser: "pithagoras-office-ds-agent", port: 9222, editorId: "e1", ms: 12_000, target: { kind: "word", page: 2, pages: 4, large: true, side: SHOT_SIDE, quality: SHOT_QUALITY, maxBytes: SHOT_MAX_BYTES, settleMs: 300, settleMaxMs: 5000 } });
  output = answer({ error: { code: "no_page", message: "the document has 3 pages as the editor lays it out now" } });
  await assert.rejects(shot("e1", { kind: "word", page: 4, pages: 4 }, deps), (e: unknown) => e instanceof ShotError && e.code === "no_page");
  output = answer({ data: "not base64!", width: 1, height: 1 });
  await assert.rejects(shot("e1", { kind: "word", page: 1, pages: 1 }, deps), (e: unknown) => e instanceof ShotError && e.code === "failed");
  const late = { ...deps, exec: async () => ({ output: "", exitCode: null, timedOut: true }) };
  await assert.rejects(shot("e1", { kind: "word", page: 1, pages: 1 }, late), (e: unknown) => e instanceof ShotError && e.code === "timeout");
});

/* ---------------- the frame function, on a scripted editor ---------------- */

type Drawn = { from: unknown; args: number[] };

/** A canvas whose pixels `pixel(x, y)` gives ([r, g, b, a]), and the canvas the function draws into, which records
 * what is drawn on it. */
function frameWindow(over: Record<string, unknown>, canvases: Record<string, unknown>) {
  const drawn: Drawn[] = [];
  const made: { width: number; height: number }[] = [];
  const window: Record<string, any> = {
    ...over,
    setTimeout,
    Promise,
    Math,
    Date,
    Array,
    String,
    JSON,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 1),
    document: {
      getElementById: (id: string) => canvases[id] ?? null,
      createElement: () => {
        const c = {
          width: 0,
          height: 0,
          getContext: () => ({ fillRect() {}, drawImage: (from: unknown, ...args: number[]) => drawn.push({ from, args }), set fillStyle(_v: string) {}, set imageSmoothingEnabled(_v: boolean) {}, set imageSmoothingQuality(_v: string) {} }),
          toDataURL: () => "data:image/jpeg;base64,QUJD",
        };
        made.push(c);
        return c;
      },
    },
  };
  window.window = window;
  return { window, drawn, made };
}

function canvas(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  return {
    width,
    height,
    getContext: () => ({
      getImageData: (x0: number, y0: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(pixel(x0 + x, y0 + y), (y * w + x) * 4);
        return { data };
      },
    }),
  };
}

async function frameFn(window: Record<string, unknown>, t: Record<string, unknown>): Promise<any> {
  const fn = vm.runInNewContext(`(${FRAME_FN})`, window);
  // As CDP gives it back (returnByValue): plain data, of this realm.
  return JSON.parse(JSON.stringify(await fn({ side: SHOT_SIDE, quality: SHOT_QUALITY, maxBytes: SHOT_MAX_BYTES, settleMs: 60, settleMaxMs: 2000, until: Date.now() + 5000, ...t })));
}

const WHITE = [255, 255, 255, 255];
const GREY = [200, 200, 200, 255];

test("frame function, Word: the page count waited for until it holds still, fit to page, the page gone to, and the page's rectangle found on the canvas", async () => {
  // A page at x 20..179, y 10..289 of a 200 x 300 canvas, with text in its middle (a dark line across it at y 150).
  const viewer = canvas(200, 300, (x, y) => (x >= 20 && x <= 179 && y >= 10 && y <= 289 ? (y === 150 && x > 40 && x < 160 ? [0, 0, 0, 255] : WHITE) : GREY));
  const counts = [2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
  const did: string[] = [];
  const editor = {
    getCountPages: () => (counts.length > 1 ? counts.shift()! : counts[0]),
    zoomFitToPage: () => did.push("fit"),
    goToPage: (n: number) => did.push(`page ${n}`),
    asc_setDrawCollaborationMarks: (on: boolean) => did.push(`marks ${on}`),
  };
  const w = frameWindow({ editor }, { id_viewer: viewer });
  const began = Date.now();
  const out = await frameFn(w.window, { kind: "word", page: 3, pages: 3 });
  assert.ok(Date.now() - began >= 60, "waited until the count held still");
  assert.deepEqual(out, { data: "QUJD", width: 160, height: 280, pages: 3 });
  assert.deepEqual(did, ["marks false", "fit", "page 2"]);
  assert.equal(w.drawn.length, 1);
  assert.equal(w.drawn[0].from, viewer, "drawn from the editor's own page canvas");
  assert.deepEqual(w.drawn[0].args, [20, 10, 160, 280, 0, 0, 160, 280]);
  // A page past the count, as the editor lays it out now.
  assert.deepEqual(await frameFn(frameWindow({ editor: { ...editor, getCountPages: () => 3 } }, { id_viewer: viewer }).window, { kind: "word", page: 4, pages: 3 }), { error: { code: "no_page", message: "the document has 3 pages as the editor lays it out now" } });
});

test("frame function, Word: the last page, which the view shows at its bottom below the end of the page before, is the page drawn whole there", async () => {
  // The page before ends at y 40 (its top is out of view), a gap, then the last page at y 60..279, a gap below.
  const viewer = canvas(200, 300, (x, y) => (x >= 20 && x <= 179 && (y <= 40 || (y >= 60 && y <= 279)) ? (y === 150 && x > 40 && x < 160 ? [0, 0, 0, 255] : WHITE) : GREY));
  const editor = { getCountPages: () => 5, zoomFitToPage() {}, goToPage() {}, asc_setDrawCollaborationMarks() {} };
  let w = frameWindow({ editor }, { id_viewer: viewer });
  assert.deepEqual((await frameFn(w.window, { kind: "word", page: 5, pages: 5 })).height, 220);
  assert.deepEqual(w.drawn[0].args.slice(0, 4), [20, 60, 160, 220]);
  // Any other page is the one at the top: here none is drawn whole there but the same one.
  w = frameWindow({ editor }, { id_viewer: viewer });
  await frameFn(w.window, { kind: "word", page: 4, pages: 5 });
  assert.deepEqual(w.drawn[0].args.slice(0, 4), [20, 60, 160, 220], "the page cut off at the top is never taken");
});

test("frame function, Word: a large page is made smaller to 1,024 px on its longer side, or 1,568 with large; never larger", async () => {
  const viewer = canvas(1000, 1300, (x, y) => (x >= 50 && x <= 949 && y >= 10 && y <= 1281 ? WHITE : GREY));
  const editor = { getCountPages: () => 1, zoomFitToPage() {}, goToPage() {}, asc_setDrawCollaborationMarks() {} };
  let w = frameWindow({ editor }, { id_viewer: viewer });
  let out = await frameFn(w.window, { kind: "word", page: 1, pages: 1 });
  assert.deepEqual([out.width, out.height], [Math.round(900 * 1024 / 1272), 1024]);
  w = frameWindow({ editor }, { id_viewer: viewer });
  out = await frameFn(w.window, { kind: "word", page: 1, pages: 1, large: true });
  assert.deepEqual([out.width, out.height], [900, 1272], "never made larger than the editor draws it");
});

/**
 * A spreadsheet editor as DS 10.0 behaves: cells of 10 x 5 px behind headers of 6 x 4, a canvas of 106 x 44 (10
 * columns, 8 rows in view at 100 %); looking up a cell out of view scrolls so that it is in the middle (as far as the
 * sheet's start allows). At 75 %, cells are 8 x 4 behind headers of 5 x 3 (12 columns in view).
 */
function sheetEditor(frozenRows = 0) {
  const did: string[] = [];
  // `row`: the first row of the part that scrolls (below the frozen rows).
  const view = { col: 0, row: frozenRows, zoom: 1, active: [0, 0] as [number, number], sheet: 0 };
  // Whole pixels, as the editor draws them.
  const size = () => (view.zoom === 1 ? { w: 10, h: 5, hx: 6, hy: 4 } : { w: 8, h: 4, hx: 5, hy: 3 });
  const cols = () => Math.floor((106 - size().hx) / size().w);
  const rows = () => Math.floor((44 - size().hy) / size().h);
  const editor = {
    asc_getActiveWorksheetIndex: () => view.sheet,
    asc_showWorksheet: (i: number) => (did.push(`sheet ${i}`), (view.sheet = i)),
    asc_getZoom: () => view.zoom,
    asc_setZoom: (z: number) => (did.push(`zoom ${z}`), (view.zoom = z)),
    asc_findCell: (a: string) => {
      const m = /^([A-Z]+)(\d+)$/.exec(a)!;
      const c = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const r = Number(m[2]) - 1;
      if (c < view.col || c >= view.col + cols()) view.col = Math.max(0, c - Math.floor(cols() / 2));
      // Frozen rows are always in view. DS 10.0 does not scroll back to the first row after them: it stays out of view.
      const scrolling = rows() - frozenRows;
      if (r >= frozenRows && r !== (frozenRows || -1) && (r < view.row || r >= view.row + scrolling)) view.row = Math.max(frozenRows, r - Math.floor(scrolling / 2));
      view.active = [c, r];
    },
    asc_getActiveCellCoord: () => {
      const s = size();
      const [c, r] = view.active;
      return { asc_getX: () => s.hx + (c - view.col) * s.w, asc_getY: () => s.hy + (r < frozenRows ? r : frozenRows + r - view.row) * s.h, asc_getWidth: () => s.w, asc_getHeight: () => s.h };
    },
  };
  // The headers' strips in a grey of their own up to their border; the grid white.
  const ws = canvas(106, 44, (x, y) => {
    const s = size();
    if (x === s.hx - 1 || y === s.hy - 1) return [180, 180, 180, 255];
    return x < s.hx - 1 || y < s.hy - 1 ? [243, 243, 243, 255] : WHITE;
  });
  const charts = canvas(106, 44, () => [0, 0, 0, 0]);
  return { editor, view, did, ws, charts };
}

test("frame function, sheets: the sheet shown, the range in view as the editor stands, and drawn with its header strips from both canvases", async () => {
  const s = sheetEditor();
  const w = frameWindow({ Asc: { editor: s.editor } }, { "ws-canvas": s.ws, "ws-canvas-graphic": s.charts });
  // B2:D3 (columns 1-3, rows 1-2) on the second sheet, at 100 %.
  const out = await frameFn(w.window, { kind: "cell", index: 1, c1: 1, r1: 1, c2: 3, r2: 2, centre: [2, 1], away: [1, 302], zoom: 1 });
  assert.deepEqual(out, { data: "QUJD", width: 6 + 30, height: 4 + 10, zoom: 1 });
  assert.deepEqual(s.did, ["sheet 1"]);
  // Corner, column letters over the range, row numbers beside it, the range: from the cells' canvas, then the charts'.
  const parts = w.drawn.map((d) => [d.from === s.ws ? "cells" : "charts", ...d.args.slice(0, 6)]);
  assert.deepEqual(parts, [
    ["cells", 0, 0, 6, 4, 0, 0],
    ["cells", 16, 0, 30, 4, 6, 0],
    ["cells", 0, 9, 6, 10, 0, 4],
    ["cells", 16, 9, 30, 10, 6, 4],
    ["charts", 0, 0, 6, 4, 0, 0],
    ["charts", 16, 0, 30, 4, 6, 0],
    ["charts", 0, 9, 6, 10, 0, 4],
    ["charts", 16, 9, 30, 10, 6, 4],
  ]);
  assert.deepEqual(s.view.active, [1, 1], "the agent's selection left on the range's first cell");
});

test("frame function, sheets: a range out of view is centred from a cell far from it; one too wide at 100 % is taken at 75 %; one too large even then is refused", async () => {
  // Rows 40-45 of columns C-E: out of view from the sheet's start.
  let s = sheetEditor();
  let w = frameWindow({ Asc: { editor: s.editor } }, { "ws-canvas": s.ws, "ws-canvas-graphic": s.charts });
  let out = await frameFn(w.window, { kind: "cell", index: 0, c1: 2, r1: 39, c2: 4, r2: 44, centre: [3, 42], away: [2, 344], zoom: 1 });
  assert.equal(out.zoom, 1);
  assert.deepEqual([out.width, out.height], [6 + 30, 4 + 30]);
  // Eleven columns: ten fit at 100 %, twelve at 75 %.
  s = sheetEditor();
  w = frameWindow({ Asc: { editor: s.editor } }, { "ws-canvas": s.ws, "ws-canvas-graphic": s.charts });
  out = await frameFn(w.window, { kind: "cell", index: 0, c1: 0, r1: 0, c2: 10, r2: 1, centre: [5, 0], away: [0, 301], zoom: 1 });
  assert.equal(out.zoom, 0.75);
  assert.deepEqual(s.did, ["zoom 0.75"]);
  s = sheetEditor();
  w = frameWindow({ Asc: { editor: s.editor } }, { "ws-canvas": s.ws, "ws-canvas-graphic": s.charts });
  out = await frameFn(w.window, { kind: "cell", index: 0, c1: 0, r1: 0, c2: 20, r2: 1, centre: [10, 0], away: [0, 301], zoom: 1 });
  assert.deepEqual(out, { error: { code: "range_too_large", message: "the range does not fit in the editor's view at 75 %" } });
  assert.equal(w.drawn.length, 0, "nothing drawn");
});

test("frame function: a second picture of the same editor ends the first; the deadline ends it before anything is drawn", async () => {
  const viewer = canvas(200, 300, (x, y) => (x >= 20 && x <= 179 && y >= 10 && y <= 289 ? WHITE : GREY));
  let n = 1;
  const editor = { getCountPages: () => n++, zoomFitToPage() {}, goToPage() {}, asc_setDrawCollaborationMarks() {} };
  const w = frameWindow({ editor }, { id_viewer: viewer });
  const first = frameFn(w.window, { kind: "word", page: 1, pages: 99 });
  await new Promise((r) => setTimeout(r, 20));
  w.window.editor = { ...editor, getCountPages: () => 1 };
  const second = frameFn(w.window, { kind: "word", page: 1, pages: 1 });
  assert.deepEqual(await first, { error: { code: "superseded", message: "another picture of this editor was begun" } });
  assert.equal((await second).width, 160);
  const late = frameWindow({ editor: { ...editor, getCountPages: () => n++ } }, { id_viewer: viewer });
  assert.deepEqual(await frameFn(late.window, { kind: "word", page: 1, pages: 99, until: Date.now() + 100 }), { error: { code: "timeout", message: "the picture took too long" } });
  assert.equal(late.drawn.length, 0);
});

test("frame function, sheets: a range across frozen panes, with the view scrolled far down, is looked at from the cell after the first one after the panes, which the editor scrolls back to", async () => {
  // Rows 1-2 frozen; the view scrolled to rows 30 and on; the range A2:B5 across the panes.
  const s = sheetEditor(2);
  s.view.row = 30;
  const w = frameWindow({ Asc: { editor: s.editor } }, { "ws-canvas": s.ws, "ws-canvas-graphic": s.charts });
  const out = await frameFn(w.window, { kind: "cell", index: 0, c1: 0, r1: 1, c2: 1, r2: 4, centre: [0, 2], away: [0, 304], zoom: 1, frozen: [0, 2] });
  assert.equal(out.zoom, 1);
  assert.deepEqual([out.width, out.height], [6 + 20, 4 + 20]);
  assert.equal(s.view.row, 2, "the part that scrolls is back at its start");
  assert.deepEqual(w.drawn.filter((d) => d.from === s.ws)[3].args.slice(0, 4), [6, 9, 20, 20], "rows 2 to 5 as they join below the panes");
});
