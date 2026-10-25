/**
 * The agents' browser, scripted for the tests (seat.test, server.test): its seat page polls what to open and close, and
 * each editor's plugin fetches its config, polls its jobs and answers them with a handler, all over HTTP as Chromium
 * does. `rewrite` turns the addresses the half hands out (the relay's, on the island) into ones the test reaches.
 */
import { setTimeout as delay } from "node:timers/promises";

export type Handler = (job: { kind: string; args: unknown }) => unknown;

/**
 * The agents' browser, scripted: its page polls what to open and close, and opens a plugin for each editor that
 * fetches its config, polls its jobs and answers them with `handler`. `dead` editors' plugins never poll; `slow` ones
 * take the job and never answer.
 */
export function browser(_origin: string, handler: Handler, rewrite: (url: string) => string = (url) => url) {
  let stop = new AbortController();
  const opened: { editorId: string; config: Record<string, any>; apiJs: string }[] = [];
  const closed: string[] = [];
  const plugins = new Map<string, { base: string; stop: AbortController }>();
  /** `states`: after an edit's outcome, what the page says of the editor's changes, each after its delay (ms), with
   * the number the page gave the event where one is given. */
  const behaviour = { dead: false, slow: false, configs: [] as Response[], states: [] as ([boolean, number] | [boolean, number, number])[] };
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
      const states = job.kind.endsWith(".edit") ? behaviour.states : [];
      await fetch(`${base}done`, { method: "POST", body: JSON.stringify({ jobId: job.jobId, ...outcome }), signal: sig }).catch(() => {});
      for (const [unsent, after, seq] of states) {
        await delay(after);
        await fetch(`${page}event`, { method: "POST", body: JSON.stringify({ editorId, type: "state", data: unsent, ...(seq !== undefined ? { seq } : {}) }), signal: sig }).catch(() => {});
      }
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
        void plugin(order.open.editorId, rewrite(order.open.config.editorConfig.plugins.pluginsData[0].replace(/config\.json$/, "")));
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
      page = rewrite(url);
      void loop();
    },
    /** The browser gone, with its page and plugins. */
    stop: () => stop.abort(),
  };
}

