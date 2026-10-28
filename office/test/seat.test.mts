/**
 * Unit tests for src/seat.ts: the seat routes on a listener of the test's own (as server.ts hands them every request),
 * with a scripted seat page and scripted plugins that speak HTTP to it as the agents' browser does, and the rest of
 * the half faked (`SeatDeps`): the browser's start, the editor config, how a key stands. Short limits, real timers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { closeDoc, closeEditor, configureSeat, health, keyOf, LIMITS, pageUrl, resetSeats, run, SeatError, seats, stopSeats, handleSeat, tuneSeats, type SeatDeps } from "../src/seat";
import { BRIDGE_JS, PLUGIN_GUID } from "../src/seat-page";
import { browser, type Handler } from "./seat-browser.mts";

const DS = "http://office-ds";


/** A listener that answers what the seats answer, and 404 for the rest, as the loopback listener does. */
async function listener() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (handleSeat(req, res, pathname)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such endpoint on the office loopback listener", code: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function deps(origin: string, b: ReturnType<typeof browser>, over: Partial<SeatDeps> = {}) {
  const calls: string[] = [];
  const keys = new Map<string, string>();
  const standing = new Map<string, "current" | "behind" | null>();
  const d: SeatDeps = {
    ensureAgent: async (url) => {
      calls.push("ensureAgent");
      b.start(url);
    },
    stopAgent: async () => {
      calls.push("stopAgent");
      b.stop();
    },
    mint: async ({ home, docId, mode, pluginUrl }) => {
      calls.push(`mint ${home} ${docId} ${mode}`);
      const key = keys.get(docId) ?? `key-${docId}`;
      return { key, apiJs: `${DS}/web-apps/apps/api/documents/api.js`, config: { document: { key }, editorConfig: { mode, plugins: { pluginsData: [`${pluginUrl}config.json`], autostart: [PLUGIN_GUID] } } } };
    },
    standing: (docId) => (standing.has(docId) ? standing.get(docId)! : "current"),
    listenerOrigin: () => origin,
    dsOrigin: () => DS,
    log: () => {},
    ...over,
  };
  return { d, calls, keys, standing };
}

const FAST = { connectMs: 2000, readyMs: 2000, jobMs: 1500, holdMs: 400, deadMs: 600, idleMs: 60_000, agentIdleMs: 60_000, quietMs: 100, sentMs: 1500 };

async function setup(handler: Handler = (job) => ({ echo: job }), limits: Partial<typeof LIMITS> = {}, over: Partial<SeatDeps> = {}) {
  const { server, origin } = await listener();
  const b = browser(origin, handler);
  const made = deps(origin, b, over);
  configureSeat(made.d, { ...FAST, ...limits });
  return {
    ...made,
    b,
    origin,
    async done() {
      stopSeats();
      b.stop();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

const code = (c: string) => (e: unknown) => {
  assert.ok(e instanceof SeatError, String(e));
  assert.equal(e.code, c, e.message);
  return true;
};

test("the flow: the browser started, the page connects, the editor opens, its plugin takes the job and answers", async () => {
  const s = await setup((job) => ({ got: job.kind, args: job.args }));
  try {
    const result = await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: { x: 1 } });
    assert.deepEqual(result, { got: "word.read", args: { x: 1 } });
    assert.deepEqual(s.calls, ["ensureAgent", "mint /homes/a doc-1 edit"]);
    assert.equal(s.b.opened.length, 1);
    assert.equal(s.b.opened[0].apiJs, `${DS}/web-apps/apps/api/documents/api.js`);
    // The page makes an editor anew where its app has not started by then (seat-page.ts).
    assert.equal((s.b.opened[0] as { appReadyMs?: number }).appReadyMs, LIMITS.appReadyMs);
    assert.equal(keyOf("/homes/a", "doc-1"), "key-doc-1");
    // The plugin's config is fetched by the editor's frame, on the Document Server's origin.
    assert.equal(s.b.behaviour.configs[0].headers.get("access-control-allow-origin"), DS);
    const config = (await s.b.behaviour.configs[0].json()) as { guid: string; variations: { type: string; EditorsSupport: string[]; isViewer: boolean; buttons: unknown[] }[] };
    assert.equal(config.guid, PLUGIN_GUID);
    assert.equal(config.variations[0].type, "system");
    assert.deepEqual(config.variations[0].EditorsSupport, ["word", "cell"]);
    // The second call goes to the same editor: no new start, no new mint.
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    assert.equal(s.calls.length, 2);
    assert.deepEqual(seats().map((x) => [x.home, x.docId, x.mode, x.ready]), [["/homes/a", "doc-1", "edit", true]]);
  } finally {
    await s.done();
  }
});

test("a plugin serves the bridge and its page, and the page loads the plugin SDK from the Document Server", async () => {
  const s = await setup();
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    const base = s.b.plugins.get(s.b.opened[0].editorId)!.base;
    assert.equal(await (await fetch(`${base}bridge.js`)).text(), BRIDGE_JS);
    assert.match(await (await fetch(`${base}index.html`)).text(), new RegExp(`src="${DS}/sdkjs-plugins/v1/plugins.js"`));
    assert.match(await (await fetch(pageUrl())).text(), /<script src="page.js">/);
    assert.match(await (await fetch(`${pageUrl()}page.js`)).text(), /DocsAPI\.DocEditor/);
  } finally {
    await s.done();
  }
});

test("a wrong or missing page secret, and a token of no open editor, get the listener's own 404 on every route", async () => {
  const s = await setup();
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    const page = pageUrl();
    const wrong = page.replace(/[0-9a-f]{64}/, "0".repeat(64));
    const short = page.replace(/[0-9a-f]{64}/, "abc");
    const token = /\/plugin\/([0-9a-f]{32})\//.exec(s.b.plugins.get(s.b.opened[0].editorId)!.base)![1];
    for (const base of [wrong, short, `${s.origin}/seat/`, `${s.origin}/plugin/${"f".repeat(32)}/`, `${s.origin}/plugin/${token.slice(0, 31)}/`]) {
      for (const [method, rest] of [["GET", ""], ["GET", "page.js"], ["GET", "poll"], ["POST", "event"], ["GET", "config.json"], ["GET", "index.html"], ["GET", "bridge.js"], ["POST", "next"], ["POST", "done"]]) {
        const r = await fetch(`${base}${rest}`, { method });
        assert.equal(r.status, 404, `${method} ${base}${rest}`);
        assert.deepEqual(await r.json(), { error: "no such endpoint on the office loopback listener", code: "not_found" });
      }
    }
  } finally {
    await s.done();
  }
});

test("one editor's token gives its own jobs only: another editor's job is never handed to it", async () => {
  const s = await setup((job) => job.args);
  try {
    await run("/homes/a", "doc-a", "edit", { kind: "word.read", args: "warm a" });
    await run("/homes/a", "doc-b", "edit", { kind: "word.read", args: "warm b" });
    const [a, b] = s.b.opened.map((o) => s.b.plugins.get(o.editorId)!);
    // A's plugin stops; a job for B is answered by B's own, and A's token polls nothing of it.
    a.stop.abort();
    const thief = fetch(`${a.base}next`, { method: "POST" });
    assert.equal(await run("/homes/a", "doc-b", "edit", { kind: "word.read", args: "for b" }), "for b");
    assert.equal((await thief).status, 204, "A's poll ran out with nothing");
    assert.notEqual(a.base, b.base);
    // A result posted with A's token for B's job settles nothing.
    const posted = await fetch(`${a.base}done`, { method: "POST", body: JSON.stringify({ jobId: "anything", result: "forged" }) });
    assert.equal(posted.status, 200);
  } finally {
    await s.done();
  }
});

test("a long-poll with nothing to hand gets 204 after the hold", async () => {
  const s = await setup();
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    s.b.stop();
    const started = Date.now();
    const r = await fetch(`${pageUrl()}poll`);
    assert.equal(r.status, 204);
    assert.ok(Date.now() - started >= 350, "held for the hold time");
  } finally {
    await s.done();
  }
});

test("a job with no result in time is error:timeout, and its editor is closed; the next call opens it again", async () => {
  const s = await setup();
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    s.b.behaviour.slow = true;
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} }), code("timeout"));
    assert.equal(seats().length, 0);
    await delay(50);
    assert.equal(s.b.closed.length, 1, "the page was told to close it");
    s.b.behaviour.slow = false;
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    assert.equal(s.b.opened.length, 2);
  } finally {
    await s.done();
  }
});

test("the command's own error comes back coded, with the op it names", async () => {
  const s = await setup(() => {
    throw { code: "quote_not_found", op: 1, message: "op 2: the quote is not in the document" };
  });
  try {
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} }), (e: SeatError) => e.code === "quote_not_found" && e.op === 1 && /op 2/.test(e.message));
  } finally {
    await s.done();
  }
});

test("a failed job the plugin says may have changed the document all the same (ran) is a refusal that says the command ran; no other field makes it one", async () => {
  const s = await setup((job) => {
    throw { outcome: { error: { code: "partial", op: 2, message: "op 3: not all of it could be taken back" }, ran: (job.args as { ran: unknown }).ran } };
  });
  try {
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "cell.edit", args: { ran: true } }), (e: SeatError) => e.code === "partial" && e.op === 2 && e.ran === true);
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "cell.edit", args: { ran: "yes" } }), (e: SeatError) => e.code === "partial" && e.ran === false);
  } finally {
    await s.done();
  }
});

test("idle editors close after the idle time, and the browser stops a while after the last one", async () => {
  const s = await setup(undefined, { idleMs: 300, agentIdleMs: 300 });
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    assert.equal(seats().length, 1);
    for (let i = 0; i < 40 && seats().length; i++) await delay(50);
    assert.equal(seats().length, 0, "closed when idle");
    for (let i = 0; i < 40 && !s.calls.includes("stopAgent"); i++) await delay(50);
    assert.ok(s.calls.includes("stopAgent"), "the browser stopped");
    // The next call starts it again.
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    assert.equal(s.calls.filter((c) => c === "ensureAgent").length, 2);
  } finally {
    await s.done();
  }
});

test("at most three editors: the least recently used idle one closes for a fourth; with all busy, error:busy", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const s = await setup(async (job) => {
    if (job.kind === "hold") await gate;
    return "ok";
  });
  try {
    for (const doc of ["d1", "d2", "d3"]) await run("/homes/a", doc, "edit", { kind: "word.read", args: {} });
    await run("/homes/a", "d1", "edit", { kind: "word.read", args: {} }); // d2 is the least recently used now
    await run("/homes/a", "d4", "edit", { kind: "word.read", args: {} });
    assert.deepEqual(seats().map((x) => x.docId).sort(), ["d1", "d3", "d4"]);
    // Opened at the same time, they still count each other.
    await Promise.all(["d5", "d6", "d7"].map((doc) => run("/homes/a", doc, "edit", { kind: "word.read", args: {} })));
    assert.equal(seats().length, 3);
    // All three busy: a fourth is refused.
    const held = ["d5", "d6", "d7"].map((doc) => run("/homes/a", doc, "edit", { kind: "hold", args: {} }));
    await delay(100);
    await assert.rejects(run("/homes/a", "d8", "edit", { kind: "word.read", args: {} }), code("busy"));
    release();
    await Promise.all(held);
  } finally {
    await s.done();
  }
});

test("one editor per agent home and document: another home gets its own, another mode reopens it", async () => {
  const s = await setup();
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    await run("/homes/b", "doc-1", "edit", { kind: "word.read", args: {} });
    assert.equal(seats().length, 2);
    await run("/homes/a", "doc-1", "view", { kind: "word.read", args: {} });
    assert.deepEqual(seats().filter((x) => x.home === "/homes/a").map((x) => x.mode), ["view"]);
    assert.ok(s.calls.includes("mint /homes/a doc-1 view"));
  } finally {
    await s.done();
  }
});

test("a plugin that stopped polling is taken for dead and its editor opened again, once", async () => {
  const s = await setup();
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    // Its plugin goes away (a crashed frame), and does not come back for the next ones.
    s.b.plugins.get(s.b.opened[0].editorId)!.stop.abort();
    await delay(700);
    assert.equal(await run("/homes/a", "doc-1", "edit", { kind: "x", args: 1 }).then(() => "ran"), "ran", "opened again and ran");
    assert.equal(s.b.opened.length, 2);
    s.b.plugins.get(s.b.opened[1].editorId)!.stop.abort();
    await delay(700);
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "x", args: 1 }), code("editor_not_ready"));
    assert.equal(seats().length, 0);
  } finally {
    await s.done();
  }
});

test("an editor whose plugin never polls is error:editor_not_ready, and closed", async () => {
  const s = await setup();
  try {
    s.b.behaviour.dead = true;
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} }), code("editor_not_ready"));
    assert.equal(seats().length, 0);
  } finally {
    await s.done();
  }
});

test("a browser whose page never connects is error:agent_unavailable; a failing start passes its own code on", async () => {
  const s = await setup(undefined, { connectMs: 300 }, { ensureAgent: async () => {} });
  try {
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} }), code("agent_unavailable"));
  } finally {
    await s.done();
  }
  const t = await setup(undefined, {}, {
    ensureAgent: async () => {
      throw new SeatError("agent_editor_missing", "the agent's editor is not downloaded");
    },
  });
  try {
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} }), code("agent_editor_missing"));
  } finally {
    await t.done();
  }
});

test("a trashed document's seats close; a key that no longer stands closes its seat with error:behind, and the next call opens the file as it is", async () => {
  const s = await setup();
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    await run("/homes/b", "doc-1", "edit", { kind: "word.read", args: {} });
    closeDoc("doc-1");
    assert.equal(seats().length, 0);
    await delay(50);
    assert.equal(s.b.closed.length, 2);

    await run("/homes/a", "doc-2", "edit", { kind: "word.read", args: {} });
    s.standing.set("doc-2", "behind");
    await assert.rejects(run("/homes/a", "doc-2", "edit", { kind: "word.edit", args: {} }), code("behind"));
    assert.equal(seats().length, 0);
    s.standing.set("doc-2", "current");
    s.keys.set("doc-2", "key-doc-2-new");
    await run("/homes/a", "doc-2", "edit", { kind: "word.read", args: {} });
    assert.equal(keyOf("/homes/a", "doc-2"), "key-doc-2-new");
  } finally {
    await s.done();
  }
});

test("a restart of the half makes a new page secret: the old page is refused", async () => {
  const s = await setup();
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    const before = pageUrl();
    configureSeat(s.d, FAST);
    assert.notEqual(pageUrl(), before);
    assert.equal((await fetch(`${before}poll`)).status, 404);
    assert.equal((await fetch(before)).status, 404);
    assert.equal(seats().length, 0, "nothing of the run before is open");
  } finally {
    await s.done();
  }
});

test("an abort stops the wait; a job not handed yet never runs", async () => {
  const ran: unknown[] = [];
  const s = await setup((job) => ran.push(job.args));
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: "warm" });
    s.b.plugins.get(s.b.opened[0].editorId)!.stop.abort(); // nobody polls: the job waits in the queue
    const abort = new AbortController();
    const call = run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: "never" }, { signal: abort.signal });
    abort.abort();
    await assert.rejects(call, code("aborted"));
    assert.deepEqual(ran, ["warm"]);
  } finally {
    await s.done();
  }
});

test("tuneSeats changes the limits of seats already running: a shorter idle closes the open editor", async () => {
  const s = await setup(undefined, { idleMs: 60_000 });
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    tuneSeats({ idleMs: 200 });
    for (let i = 0; i < 40 && seats().length; i++) await delay(50);
    assert.equal(seats().length, 0);
  } finally {
    await s.done();
  }
});

test("an edit answers once the editor says its changes are sent to the Document Server, whichever request comes first", async () => {
  const s = await setup(() => ({ ops: 1 }));
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    // The editor says it holds unsent changes, and 400 ms later that they are sent.
    s.b.behaviour.states = [[true, 0], [false, 400]];
    const started = Date.now();
    await run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} });
    assert.ok(Date.now() - started >= 390, `waited for the sent changes (${Date.now() - started} ms)`);
    // An edit that changes nothing: the editor says nothing, and the call answers after the quiet time.
    s.b.behaviour.states = [];
    const quiet = Date.now();
    await run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} });
    assert.ok(Date.now() - quiet >= 90 && Date.now() - quiet < 1000, `${Date.now() - quiet} ms`);
    // A read waits for nothing of it.
    s.b.behaviour.states = [[true, 0], [false, 400]];
    const read = Date.now();
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    assert.ok(Date.now() - read < 300);
  } finally {
    await s.done();
  }
});

test("an edit whose changes the editor does not send in time is error:editor_not_saved", async () => {
  const s = await setup(() => ({ ops: 1 }));
  try {
    s.b.behaviour.states = [[true, 0]];
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "cell.edit", args: {} }), code("editor_not_saved"));
  } finally {
    await s.done();
  }
});

test("a view-mode editor is never handed an edit: error:read_only before its plugin is asked", async () => {
  const handed: string[] = [];
  const s = await setup((job) => handed.push(job.kind));
  try {
    await run("/homes/a", "doc-1", "view", { kind: "word.read", args: {} });
    await assert.rejects(run("/homes/a", "doc-1", "view", { kind: "word.edit", args: {} }), code("read_only"));
    assert.deepEqual(handed, ["word.read"]);
  } finally {
    await s.done();
  }
});

test("after the browser stopped for idleness, the next call starts it again even while a poll of the old page is still held", async () => {
  let stops = 0;
  let release: () => void = () => {};
  const s = await setup(undefined, { idleMs: 200, agentIdleMs: 200 }, {
    // A stop that takes a while, as Docker removing a container does; the old page keeps polling meanwhile.
    stopAgent: () => {
      stops++;
      return new Promise<void>((r) => (release = r));
    },
  });
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    for (let i = 0; i < 60 && stops === 0; i++) await delay(50);
    assert.equal(stops, 1, "the browser is being stopped");
    // The old page polls again (its container is not gone yet).
    const stale = fetch(`${pageUrl()}poll`).catch(() => null);
    await delay(50);
    const next = run("/homes/a", "doc-2", "edit", { kind: "word.read", args: {} });
    await delay(100);
    assert.equal(s.calls.filter((c) => c === "ensureAgent").length, 1, "the start waits for the stop");
    release();
    await next;
    assert.equal(s.calls.filter((c) => c === "ensureAgent").length, 2, "started again, not taken for running");
    await stale;
  } finally {
    await s.done();
  }
});

/** What the page says of an editor, as the seat page posts it. */
const tell = (editorId: string, type: string, data: unknown, seq?: number) =>
  fetch(`${pageUrl()}event`, { method: "POST", body: JSON.stringify({ editorId, type, data, ...(seq !== undefined ? { seq } : {}) }) });

test("a browser being started is not stopped by the sweep before its page polls the first time", async () => {
  let cancelled = 0;
  let pending: NodeJS.Timeout | undefined;
  const made: { b?: ReturnType<typeof browser> } = {};
  const s = await setup(undefined, { idleMs: 200, agentIdleMs: 50 }, {
    // The container is there at once, its page polls a moment later (Chromium starting).
    ensureAgent: async (url) => {
      pending = setTimeout(() => made.b!.start(url), 300);
    },
    stopAgent: async () => {
      if (pending) clearTimeout(pending);
      cancelled++;
      made.b!.stop();
    },
  });
  made.b = s.b;
  try {
    // Long after the seats were set up: the last close (there was none) is older than the browser's idle time.
    await delay(150);
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: "x" });
    assert.equal(cancelled, 0, "the start was not stopped");
  } finally {
    await s.done();
  }
});

test("an edit the editor does not send closes the editor; the refusal says the command ran", async () => {
  // A job's own time well above the time to send, so that a slow machine does not take one for the other.
  const s = await setup(() => ({ ops: 1 }), { jobMs: 5000 });
  try {
    s.b.behaviour.states = [[true, 10]];
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} }), (e: SeatError) => e.code === "editor_not_saved" && e.ran === true);
    assert.equal(seats().length, 0, "not used again: the next call opens it anew");
    s.b.behaviour.states = [];
    await run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} });
    assert.equal(s.b.opened.length, 2);
  } finally {
    await s.done();
  }
});

test("an editor that still holds changes unsent when an edit is handed: only its word that they are sent ends the wait, never the quiet", async () => {
  const s = await setup(() => ({ ops: 1 }), { jobMs: 5000 });
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    const editorId = s.b.opened[0].editorId;
    // The editor said it holds unsent changes (an edit before, or a session lost), and nothing since.
    await tell(editorId, "state", true);
    // An edit that adds to them raises no new event: it is not taken for one that changed nothing.
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} }), code("editor_not_saved"));
    // Where the editor then says they are sent, the edit answers, as one that changed something.
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    await tell(s.b.opened[1].editorId, "state", true);
    s.b.behaviour.states = [[false, 100]];
    assert.deepEqual(await run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} }), { ops: 1, changed: true });
  } finally {
    await s.done();
  }
});

test("an edit says whether the editor had changes to send: none for one that changed nothing", async () => {
  const s = await setup(() => ({ ops: 2 }));
  try {
    s.b.behaviour.states = [];
    assert.deepEqual(await run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} }), { ops: 2, changed: false });
    s.b.behaviour.states = [[true, 0], [false, 50]];
    assert.deepEqual(await run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} }), { ops: 2, changed: true });
  } finally {
    await s.done();
  }
});

test("an editor that reports an error after it opened is closed, and the next call opens it anew", async () => {
  const s = await setup();
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    await tell(s.b.opened[0].editorId, "error", { errorCode: -1, errorDescription: "the editor asks to be reloaded" });
    await delay(50);
    assert.equal(seats().length, 0);
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    assert.equal(s.b.opened.length, 2);
  } finally {
    await s.done();
  }
});

test("the editor's state events are taken in the order the page numbered them, whichever request arrives first", async () => {
  const s = await setup(() => ({ ops: 1 }));
  try {
    // "sent" (2) arrives before "unsent" (1).
    s.b.behaviour.states = [[false, 0, 2], [true, 20, 1]];
    assert.deepEqual(await run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} }), { ops: 1, changed: true });
  } finally {
    await s.done();
  }
});

test("a result larger than the most a result may carry is error:too_large at once, and the editor stays", async () => {
  const s = await setup((job) => (job.kind === "big" ? "x".repeat(2 * 1024 * 1024) : "small"), { maxDone: 1024 * 1024, jobMs: 5000 });
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    const started = Date.now();
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "big", args: {} }), code("too_large"));
    assert.ok(Date.now() - started < 2000, "not after the job's time ran out");
    assert.equal(seats().length, 1, "the editor stays");
    assert.equal(await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} }), "small");
    assert.equal(s.b.opened.length, 1);
  } finally {
    await s.done();
  }
});

test("a job the plugin took, cut off by its editor's close, is of unknown effect: not to be tried again unseen", async () => {
  const s = await setup();
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    s.b.behaviour.slow = true;
    const call = run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} });
    await delay(100);
    closeDoc("doc-1");
    await assert.rejects(call, (e: SeatError) => e.code === "editor_closed" && e.ran === true && /unknown/.test(e.message) && !/try again/.test(e.message));
  } finally {
    await s.done();
  }
});

test("an editor a call has just found is not closed to make room for another document opening at the same moment", async () => {
  const s = await setup((job) => job.args);
  try {
    for (const doc of ["d1", "d2", "d3"]) await run("/homes/a", doc, "edit", { kind: "word.read", args: doc });
    // d1 is the least recently used; a fourth document opens, and d1 is called in the same moment.
    const [four, one] = await Promise.all([run("/homes/a", "d4", "edit", { kind: "word.read", args: "d4" }), run("/homes/a", "d1", "edit", { kind: "word.read", args: "d1" })]);
    assert.equal(four, "d4");
    assert.equal(one, "d1");
    assert.deepEqual(seats().map((x) => x.docId).sort(), ["d1", "d3", "d4"]);
  } finally {
    await s.done();
  }
});

test("a read of a document whose file changed outside the editor opens it anew; an edit hears error:behind", async () => {
  const s = await setup((job) => job.kind);
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    s.standing.set("doc-1", "behind");
    s.keys.set("doc-1", "key-doc-1-new");
    const read = run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    s.standing.set("doc-1", "current"); // the new editor's key stands
    assert.equal(await read, "word.read");
    assert.equal(keyOf("/homes/a", "doc-1"), "key-doc-1-new");
    s.standing.set("doc-1", "behind");
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "word.edit", args: {} }), code("behind"));
  } finally {
    await s.done();
  }
});

test("resetSeats (the Document Server started again): every editor closed and the browser stopped; the next call starts it anew", async () => {
  const s = await setup();
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    resetSeats("its Document Server started again");
    assert.equal(seats().length, 0);
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    assert.deepEqual(s.calls.filter((c) => c === "ensureAgent" || c === "stopAgent"), ["ensureAgent", "stopAgent", "ensureAgent"]);
  } finally {
    await s.done();
  }
});

test("health, for the Office page: idle, then running with its editors; a start that failed says why until one succeeds; a missing image or Office stopped is not its failure", async () => {
  let fail: Error | null = null;
  const s = await setup(undefined, { connectMs: 300 }, {});
  const real = s.d.ensureAgent;
  s.d.ensureAgent = async (url) => {
    if (fail) throw fail;
    return real(url);
  };
  try {
    assert.deepEqual(health(), { running: false, starting: false, editors: 0 });
    fail = Object.assign(new Error("Docker answered 500: no space left on device"), { code: "docker" });
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} }));
    assert.deepEqual(health(), { running: false, starting: false, editors: 0, error: "Docker answered 500: no space left on device" });
    fail = null;
    await run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} });
    assert.deepEqual(health(), { running: true, starting: false, editors: 1 }, "a start that worked takes the error back");
    resetSeats("the Document Server started again");
    fail = new SeatError("agent_editor_missing", "the agent's editor is not downloaded");
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} }), code("agent_editor_missing"));
    fail = new SeatError("office_stopped", "the person stopped Office");
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} }), code("office_stopped"));
    assert.equal(health().error, undefined, "the page says those by the image and the Document Server");
  } finally {
    await s.done();
  }
  // A browser whose page never connects: that is its failure.
  const t = await setup(undefined, { connectMs: 300 }, { ensureAgent: async () => {} });
  try {
    await assert.rejects(run("/homes/a", "doc-1", "edit", { kind: "word.read", args: {} }), code("agent_unavailable"));
    assert.match(health().error ?? "", /did not start within/);
  } finally {
    await t.done();
  }
});

test("a comment-only editor is handed a reply and never an edit; a view-mode editor neither; a reply waits for its changes to be sent, as an edit does", async () => {
  const handed: string[] = [];
  const s = await setup((job) => (handed.push(job.kind), { replies: 1 }));
  try {
    s.b.behaviour.states = [[true, 0], [false, 300]];
    const started = Date.now();
    assert.deepEqual(await run("/homes/a", "doc-1", "comment", { kind: "word.reply", args: {} }), { replies: 1, changed: true });
    assert.ok(Date.now() - started >= 290, "waited for the sent reply");
    assert.ok(s.calls.includes("mint /homes/a doc-1 comment"), "minted for comments only");
    await assert.rejects(run("/homes/a", "doc-1", "comment", { kind: "word.edit", args: {} }), code("read_only"));
    await assert.rejects(run("/homes/a", "doc-2", "view", { kind: "cell.reply", args: {} }), code("read_only"));
    assert.deepEqual(handed, ["word.reply"]);
  } finally {
    await s.done();
  }
});

test("an editor opened only to post an answer closes after the short post idle; one the agent's tools used keeps the full idle time", async () => {
  const s = await setup(undefined, { idleMs: 60_000, postIdleMs: 300, toolWindowMs: 60_000 });
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "chat.send", args: {} }, { post: true });
    await run("/homes/b", "doc-1", "edit", { kind: "word.read", args: {} });
    await run("/homes/b", "doc-1", "edit", { kind: "chat.send", args: {} }, { post: true });
    for (let i = 0; i < 40 && seats().length > 1; i++) await delay(50);
    assert.deepEqual(seats().map((x) => x.home), ["/homes/b"], "the post-only editor went, the agent's own stays");
  } finally {
    await s.done();
  }
});

test("closeEditor closes the one editor of a home and a document, and the next call opens it anew", async () => {
  const s = await setup();
  try {
    await run("/homes/a", "doc-1", "edit", { kind: "cell.comments", args: {} });
    await run("/homes/b", "doc-1", "edit", { kind: "cell.comments", args: {} });
    closeEditor("/homes/a", "doc-1", "a test");
    assert.deepEqual(seats().map((x) => x.home), ["/homes/b"]);
    await run("/homes/a", "doc-1", "edit", { kind: "cell.comments", args: {} });
    assert.equal(s.b.opened.length, 3);
  } finally {
    await s.done();
  }
});

test("an editor that may only comment serves a read asked in view mode; a change of mode waits for the job its editor runs instead of closing it under that job", async () => {
  const s = await setup(async (job) => {
    if (job.kind === "word.read") await delay(300);
    return { kind: job.kind };
  });
  try {
    await run("/homes/a", "doc-1", "comment", { kind: "word.comments", args: {} });
    assert.deepEqual(await run("/homes/a", "doc-1", "view", { kind: "word.comments", args: {} }), { kind: "word.comments" });
    assert.equal(s.calls.filter((c) => c.startsWith("mint /homes/a doc-1")).length, 1, "no editor opened anew for the read");
    // A read in edit mode runs; a post in comment mode comes meanwhile: the read ends as it should, then the editor
    // opens anew in comment mode.
    const read = run("/homes/b", "doc-1", "edit", { kind: "word.read", args: {} });
    await delay(100);
    const post = run("/homes/b", "doc-1", "comment", { kind: "word.comments", args: {} });
    assert.deepEqual(await read, { kind: "word.read" });
    assert.deepEqual(await post, { kind: "word.comments" });
    assert.deepEqual(seats().filter((x) => x.home === "/homes/b").map((x) => x.mode), ["comment"]);
  } finally {
    await s.done();
  }
});
