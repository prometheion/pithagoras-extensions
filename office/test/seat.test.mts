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
import { closeDoc, configureSeat, keyOf, LIMITS, pageUrl, run, SeatError, seats, stopSeats, handleSeat, type SeatDeps } from "../src/seat";
import { BRIDGE_JS, PLUGIN_GUID } from "../src/seat-page";

const DS = "http://office-ds";

type Handler = (job: { kind: string; args: unknown }) => unknown;

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

/**
 * The agents' browser, scripted: its page polls what to open and close, and opens a plugin for each editor that
 * fetches its config, polls its jobs and answers them with `handler`. `dead` editors' plugins never poll; `slow` ones
 * take the job and never answer.
 */
function browser(origin: string, handler: Handler) {
  let stop = new AbortController();
  const opened: { editorId: string; config: Record<string, any>; apiJs: string }[] = [];
  const closed: string[] = [];
  const plugins = new Map<string, { base: string; stop: AbortController }>();
  const behaviour = { dead: false, slow: false, configs: [] as Response[] };
  let page = "";
  async function plugin(editorId: string, base: string) {
    const own = new AbortController();
    plugins.set(editorId, { base, stop: own });
    const sig = AbortSignal.any([stop.signal, own.signal]);
    behaviour.configs.push(await fetch(`${base}config.json`, { signal: sig }));
    if (behaviour.dead) return;
    while (!sig.aborted) {
      const r = await fetch(`${base}next`, { method: "POST", signal: sig }).catch(() => null);
      if (!r || r.status === 404) return;
      if (r.status === 204) continue;
      const job = (await r.json()) as { jobId: string; kind: string; args: unknown };
      if (behaviour.slow) return;
      let outcome: Record<string, unknown>;
      try {
        outcome = { result: await handler(job) };
      } catch (e) {
        outcome = { error: e };
      }
      await fetch(`${base}done`, { method: "POST", body: JSON.stringify({ jobId: job.jobId, ...outcome }), signal: sig }).catch(() => {});
    }
  }
  async function loop() {
    const signal = stop.signal;
    while (!signal.aborted && page) {
      const r = await fetch(`${page}poll`, { signal }).catch(() => null);
      if (!r) return;
      if (r.status === 404) return;
      if (r.status !== 200) continue;
      const order = (await r.json()) as { open?: { editorId: string; config: Record<string, any>; apiJs: string }; close?: string };
      if (order.open) {
        opened.push(order.open);
        void plugin(order.open.editorId, order.open.config.editorConfig.plugins.pluginsData[0].replace(/config\.json$/, ""));
      }
      if (order.close) {
        closed.push(order.close);
        plugins.get(order.close)?.stop.abort();
      }
    }
  }
  return {
    opened,
    closed,
    plugins,
    behaviour,
    /** The browser started (again): a fresh page. */
    start(url: string) {
      stop.abort();
      stop = new AbortController();
      page = url;
      void loop();
    },
    /** The browser gone, with its page and plugins. */
    stop: () => stop.abort(),
  };
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

const FAST = { connectMs: 2000, readyMs: 2000, jobMs: 1500, holdMs: 400, deadMs: 600, idleMs: 60_000, agentIdleMs: 60_000 };

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
