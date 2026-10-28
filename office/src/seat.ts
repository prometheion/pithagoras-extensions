/**
 * The agents' seats in the documents: each agent that works in a document (one per agent home and document) has an
 * OnlyOffice editor of its own open in it, in the agents' browser on its own network (container.ts), beside the people in
 * the document. A tool call hands its edit to that editor as a job, which the editor's plugin (seat-page.ts) makes
 * with one fixed command, so people see it at once, and what they typed and have not saved yet is read and kept.
 *
 *   tool -> seat.run -> job queue -> plugin long-poll (POST /plugin/<token>/next) -> command in the editor
 *        <- result <- POST /plugin/<token>/done <-
 *
 * The browser opens one page, the seat page (`GET /seat/<secret>/`), from the loopback listener through the relay's
 * way back, as the Document Server reaches it; the page long-polls what to open and close (`GET /seat/<secret>/poll`).
 * `secret` is new in each run of the half and is in no config: whatever else reaches the listener without the page
 * (a process on the host's loopback, a request the Document Server makes) gets the listener's 404 for every /seat
 * path. Each editor's plugin is served under a token of its own (`/plugin/<token>/`), which is in that editor's
 * config and so known to the Document Server too: it gives the jobs of that one editor and nothing else, and is gone
 * when the editor closes.
 * The seat page trusts the Document Server: its `api.js` runs in the page, and its plugin SDK in each plugin's frame
 * on the page's origin, so its code can read the page's address and with it the secret. That gives it nothing it
 * lacks (it holds every document and the JWT secret), and so nothing under /seat/ or /plugin/ may ever grant more
 * than the Document Server already has.
 *
 * Limits: MAX_EDITORS across the portal, one per agent home and document; the least recently used idle one closes for
 * a new one, and where all are busy the call is refused (`busy`). An editor closes after IDLE_MS without a job, when
 * its key no longer stands (the file changed outside: `behind`), when its document is trashed, when a job of it timed
 * out, and when it would have to open in another mode (the agent's write permission changed); the next call opens it
 * again. A plugin that has not polled for DEAD_MS is taken for dead and its editor opened anew, once. The browser
 * stops AGENT_IDLE_MS after its last editor closed.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BRIDGE_JS, HOLD_MS, pluginConfig, pluginIndex, SEAT_PAGE_HTML, SEAT_PAGE_JS } from "./seat-page";
import type { ShotImage, ShotTarget } from "./cdp";

/** How an agent's editor opens: to edit, to read only, or to read and comment only (an agent that may not change the
 * document still answers in its comment threads). */
export type SeatMode = "edit" | "view" | "comment";
export type SeatJob = { kind: string; args: unknown };

/** What the seats need from the rest of the half (server.ts gives the real ones, tests their own). */
export interface SeatDeps {
  /** The agents' browser running, opening `pageUrl` (container.ensureAgent); rejects with a coded error. */
  ensureAgent(pageUrl: string): Promise<void>;
  /** The agents' browser gone (container.stopAgent). */
  stopAgent(): Promise<void>;
  /** A signed editor config for an agent: `pluginUrl` is the base its plugin is served from. */
  mint(input: { home: string; docId: string; mode: SeatMode; pluginUrl: string }): Promise<{ config: Record<string, unknown>; apiJs: string; key: string }>;
  /** How an editor opened with `key` stands to the document now (callback.keyStanding on its revision): only a
   * "current" one is used; null where the document is gone. */
  standing(docId: string, key: string): "current" | "behind" | null;
  /** A picture of the editor `editorId` as its document's locate said (cdp.shot through the relay); rejects with a
   * coded error. Without it, office_screenshot is refused (`agent_unavailable`). */
  capture?(editorId: string, target: ShotTarget & { large?: boolean }): Promise<ShotImage>;
  /** Where the browser reaches the listener (the relay's way back), `http://<relay>:<port>`. */
  listenerOrigin(): string;
  /** Where the browser reaches the Document Server, `http://<container>`: the origin the plugin's config is fetched
   * from, and the plugin SDK's. */
  dsOrigin(): string;
  log?: (line: string) => void;
}

/** The limits, as constants (owner decision); tests change them through `configureSeat`. */
export const LIMITS = {
  maxEditors: 3,
  /** The browser's first poll after it was started. */
  connectMs: 60_000,
  /** An editor's plugin's first poll after the editor was opened. */
  readyMs: 30_000,
  /** An editor whose app has not started this long after it was made is made anew, once (seat-page.ts). */
  appReadyMs: 10_000,
  /** One job's result. */
  jobMs: 20_000,
  /** An editor with no job closes. */
  idleMs: 5 * 60_000,
  /** The browser stops after its last editor closed. */
  agentIdleMs: 10 * 60_000,
  /** A plugin that has not polled since counts as dead. */
  deadMs: 30_000,
  /** A held long-poll is answered with nothing. */
  holdMs: HOLD_MS,
  /** The most a plugin's result may carry. */
  maxDone: 8 * 1024 * 1024,
  /** An edit's changes sent to the Document Server by the editor. */
  sentMs: 10_000,
  /** An edit after which the editor says nothing of its changes this long changed nothing to send. */
  quietMs: 2_000,
  /** An editor opened only to post an answer (its agent made no tool call in it for `toolWindowMs`) closes this soon. */
  postIdleMs: 60_000,
  toolWindowMs: 5 * 60_000,
};

type Outcome = { result?: unknown; error?: { code?: string; message?: string; op?: number }; ran?: boolean };
type Job = {
  id: string;
  kind: string;
  args: unknown;
  settle: (outcome: Outcome) => void;
  handed: boolean;
  handedAt: number;
  /** When it was handed, the editor had said it holds changes unsent and not yet that it sent them. */
  unsentAtHand: boolean;
  /** A picture's locate: once it is handed, the editor takes no other job until the picture is taken (`Editor.held`). */
  hold?: string;
  /** Called as it is handed: its time starts then. */
  onHand?: () => void;
};

type Editor = {
  id: string;
  home: string;
  docId: string;
  key: string;
  mode: SeatMode;
  token: string;
  /** Its plugin polled at least once. */
  ready: boolean;
  /** What the page said went wrong while it opened. */
  failed?: string;
  waiters: (() => void)[];
  lastUsed: number;
  lastPoll: number;
  busy: boolean;
  /** When a call other than a post last used it (0: none since it opened): an editor only posts keep closes sooner. */
  lastTool: number;
  reopened: boolean;
  queue: Job[];
  held: ServerResponse | null;
  /** When the editor last said it holds changes it has not sent to the Document Server (its onDocumentStateChange
   * true), and when it last said it sent them all (false). */
  unsentAt: number;
  /** The order of those two (a count of the editor's state events): which came last. */
  unsentSeq: number;
  sentSeq: number;
  stateWaiters: (() => void)[];
  /** The picture under way in it (its locate's `hold`): no other job is handed until it is taken. */
  holding?: string;
};

/** A coded refusal the tools pass on as `error:<code> <message>`. `ran`: the editor's plugin had taken the job, so
 * the command may have run, and an edit may be in the document (office_edit records it all the same). */
export class SeatError extends Error {
  constructor(public readonly code: string, message: string, public readonly op?: number, public readonly ran = false) {
    super(message);
  }
}

let deps: SeatDeps | null = null;
/** The end of the last picture asked for: one at a time in the whole browser. */
let shooting: Promise<void> = Promise.resolve();
let limits = { ...LIMITS };
let secret = randomBytes(32).toString("hex");
const editors = new Map<string, Editor>();
const orders: Record<string, unknown>[] = [];
let page: ServerResponse | null = null;
let pageSeen = 0;
let pageWaiters: (() => void)[] = [];
let lastEditorClosed = 0;
let sweeper: NodeJS.Timeout | undefined;
let agentRunning = false;
/** The browser's stop under way, if any: a start waits for it, or it would find the browser it removes. */
let stopping: Promise<void> = Promise.resolve();
/** Starts of the browser under way (connected): the sweep does not stop a browser that a call is starting. */
let startingAgent = 0;
/** Counts the editors' state events, to tell which of two came last. */
let stateSeq = 0;
/** Why the browser last failed to start, for the Office page, until it starts or the seats are reset. */
let startFailed: string | undefined;

function log(line: string): void {
  (deps?.log ?? ((l: string) => console.error(l)))(`@pithagoras/office: seat: ${line}`);
}

/**
 * Sets the seats up for a run of the half: a new page secret (a browser left from before is refused), no editors, and
 * the sweeper that closes idle editors and stops the browser. `overrides` changes the limits (tests).
 */
export function configureSeat(d: SeatDeps, overrides: Partial<typeof LIMITS> = {}): void {
  closeAll();
  deps = d;
  limits = { ...LIMITS, ...overrides };
  secret = randomBytes(32).toString("hex");
  pageSeen = 0;
  agentRunning = false;
  startFailed = undefined;
  lastEditorClosed = Date.now();
  if (sweeper) clearInterval(sweeper);
  sweeper = setInterval(sweep, Math.min(30_000, limits.idleMs / 2, limits.postIdleMs / 2));
  sweeper.unref();
}

/** Changes the limits of the seats as they run (the end-to-end test, which cannot wait five minutes for an idle close). */
export function tuneSeats(overrides: Partial<typeof LIMITS>): void {
  limits = { ...limits, ...overrides };
  if (sweeper) clearInterval(sweeper);
  sweeper = setInterval(sweep, Math.min(30_000, limits.idleMs / 2, limits.postIdleMs / 2));
  sweeper.unref();
}

/** Every seat closed and the sweeper stopped: the half stops. */
export function stopSeats(): void {
  closeAll();
  if (sweeper) clearInterval(sweeper);
  sweeper = undefined;
  deps = null;
}

/** The address of the seat page, as the browser opens it. */
export function pageUrl(): string {
  if (!deps) throw new SeatError("agent_unavailable", "the seats are not set up");
  return `${deps.listenerOrigin()}/seat/${secret}/`;
}

/**
 * How the agents' browser stands, for the Office page: running (and how many editors are open in it), starting, or
 * idle; and why its last start failed, where it did for another reason than the two the page says by itself (its
 * image missing, Office stopped).
 */
export function health(): { running: boolean; starting: boolean; editors: number; error?: string } {
  return { running: agentRunning, starting: startingAgent > 0, editors: editors.size, ...(startFailed ? { error: startFailed } : {}) };
}

/** The agent seats open now, for office_list and the tests: who is in which document. */
export function seats(): { home: string; docId: string; mode: SeatMode; key: string; ready: boolean }[] {
  return [...editors.values()].map((e) => ({ home: e.home, docId: e.docId, mode: e.mode, key: e.key, ready: e.ready }));
}

/* ------------------------------------------------------------------ */
/* running a job                                                       */
/* ------------------------------------------------------------------ */

/**
 * Runs `job` in the editor of (`home`, `docId`) in `mode`, opening it (and the browser) where it is not open, and
 * answers the command's result. Rejects with a SeatError: the codes of section 2.9 of the plan (`agent_unavailable`,
 * `editor_not_ready`, `timeout`, `busy`, `behind`, and the command's own, such as `quote_not_found`), or the coded
 * errors of `ensureAgent` and `mint`. An abort (`signal`) only stops the wait: a job the plugin took runs to its end.
 */
export async function run(home: string, docId: string, mode: SeatMode, job: SeatJob, options: { signal?: AbortSignal; timeoutMs?: number; post?: boolean } = {}): Promise<unknown> {
  if (!deps) throw new SeatError("agent_unavailable", "the seats are not set up");
  // A view-mode editor takes no edit and no reply, a comment-only one no edit: refused here, before its plugin is asked.
  if ((mode === "view" && changes(job.kind)) || (mode === "comment" && job.kind.endsWith(".edit"))) throw new SeatError("read_only", "the agent's editor of this document is read-only");
  const edit = changes(job.kind);
  // A read opens the file anew where it changed outside the editor; an edit hears `behind` first.
  const editor = await editorFor(home, docId, mode, options.signal, !edit);
  editor.busy = true;
  editor.lastUsed = Date.now();
  // A post (an answer the extension writes for the agent) is no use of the agent's own: see LIMITS.postIdleMs.
  if (!options.post) editor.lastTool = Date.now();
  try {
    // Closed between the find and now (another call made room for its document): never handed, so nothing ran.
    if (!editors.has(editor.id)) throw new SeatError("editor_closed", "the agent's editor of this document was closed for another document as the call began; try again");
    const outcome = await handOver(editor, job, options);
    if (outcome.error) throw new SeatError(outcome.error.code ?? "failed", outcome.error.message ?? "the command failed", outcome.error.op, outcome.ran ?? false);
    if (!edit) return outcome.result;
    let changed: boolean;
    try {
      changed = await sent(editor, outcome.handedAt ?? 0, Date.now(), outcome.unsentAtHand ?? false, options.signal);
    } catch (e) {
      // An editor that does not send what it made has lost the Document Server's session (it restarted, or the editor
      // waits for a reload): closed, so that the next call opens the document anew instead of editing a copy nobody
      // sees.
      if (e instanceof SeatError && e.code === "editor_not_saved") close(editor, "it did not send an edit to the Document Server");
      throw e;
    }
    // Whether the editor said the edit changed anything it had to send: the save after an edit that changed nothing
    // finds nothing to save.
    return { ...(outcome.result && typeof outcome.result === "object" ? outcome.result : {}), changed };
  } finally {
    editor.busy = false;
    editor.lastUsed = Date.now();
  }
}

/**
 * A picture of the document as the agent's editor of (`home`, `docId`) shows it (office_screenshot): `locate` (a
 * `view.locate` job) is run in that editor, and in the same step of its queue, before it is handed any other job, the
 * picture is taken of what the locate answered (`deps.capture`, cdp.ts). Pictures are taken one at a time in the whole
 * browser. Answers the locate's result and the picture; rejects with a SeatError: the locate's codes, the capture's
 * (`no_page`, `range_too_large`, `not_drawn`, …), and those of `run`.
 */
export async function shot(home: string, docId: string, mode: SeatMode, locate: SeatJob, options: { signal?: AbortSignal; large?: boolean } = {}): Promise<{ located: Record<string, unknown>; image: ShotImage }> {
  if (!deps) throw new SeatError("agent_unavailable", "the seats are not set up");
  const capture = deps.capture;
  if (!capture) throw new SeatError("agent_unavailable", "pictures of the agent's editor are not set up");
  // In line behind every picture asked for before, also where this one is aborted while it waits.
  const before = shooting;
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  shooting = Promise.all([before, mine]).then(() => {});
  try {
    await turn(before, options.signal);
    const editor = await editorFor(home, docId, mode, options.signal, true);
    editor.busy = true;
    editor.lastUsed = Date.now();
    editor.lastTool = Date.now();
    const hold = randomUUID();
    try {
      if (!editors.has(editor.id)) throw new SeatError("editor_closed", "the agent's editor of this document was closed for another document as the call began; try again");
      const outcome = await handOver(editor, { ...locate, hold }, options);
      if (outcome.error) throw new SeatError(outcome.error.code ?? "failed", outcome.error.message ?? "the command failed");
      const located = (outcome.result && typeof outcome.result === "object" ? outcome.result : {}) as Record<string, unknown>;
      if (!editors.has(editor.id)) throw new SeatError("editor_closed", "the agent's editor of this document was closed while the picture was taken; try again");
      try {
        return { located, image: await capture(editor.id, { ...(located.view as ShotTarget), large: Boolean(options.large) }) };
      } catch (e) {
        const err = e as { code?: unknown; message?: unknown } | null;
        throw new SeatError(typeof err?.code === "string" ? err.code : "failed", typeof err?.message === "string" ? err.message : String(e));
      }
    } finally {
      // The jobs that came meanwhile go on.
      if (editor.holding === hold) editor.holding = undefined;
      editor.busy = false;
      editor.lastUsed = Date.now();
      feed(editor);
    }
  } finally {
    release();
  }
}

/** `before` ended, or the call was aborted. */
function turn(before: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return before;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new SeatError("aborted", "the call was aborted"));
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    void before.then(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    });
  });
}

/** Whether a job changes the document (an edit, or a reply on a comment): it is waited for until the editor sent it, and
 * a view-mode editor is never handed it. */
export function changes(kind: string): boolean {
  return kind.endsWith(".edit") || kind.endsWith(".reply");
}

/** The key the editor of (`home`, `docId`) has open, where one is open: the session an edit's save is asked of. */
export function keyOf(home: string, docId: string): string | undefined {
  return find(home, docId)?.key;
}

function find(home: string, docId: string): Editor | undefined {
  for (const e of editors.values()) if (e.home === home && e.docId === docId) return e;
  return undefined;
}

/** The open editor of (`home`, `docId`) in `mode`, or one opened. One that is found is marked in use before anything
 * else runs, so that another call making room for its own document does not close it. `reopenBehind`: an editor whose
 * key no longer stands is closed and the file opened as it is now, instead of `behind` (a read has nothing to lose). */
async function editorFor(home: string, docId: string, mode: SeatMode, signal?: AbortSignal, reopenBehind = false): Promise<Editor> {
  const d = deps!;
  let editor = find(home, docId);
  if (editor && !editor.ready) {
    // Another call opens it right now.
    await ready(editor, signal);
  }
  if (editor) {
    const standing = d.standing(docId, editor.key);
    if (standing !== "current") {
      close(editor, "its document changed outside the editor");
      if (standing !== "behind") throw new SeatError("not_found", "the document is gone");
      if (!reopenBehind) throw new SeatError("behind", "the document's file changed outside the editor while the agent's editor had it open; that editor is closed, and the next call opens the file as it is now");
      editor = undefined;
    } else if (editor.mode !== mode && !(editor.mode === "comment" && mode === "view")) {
      // Another mode (an editor that may only comment also serves a read asked in view mode): it opens anew, once the
      // jobs it runs ended; closed under a job, that job would end as "may have run" (a post then made twice).
      await idle(editor, signal);
      if (editors.has(editor.id)) close(editor, `it opens in ${mode} mode now`);
      return editorFor(home, docId, mode, signal, reopenBehind);
    } else if (editor.ready && !editor.held && Date.now() - editor.lastPoll > limits.deadMs) {
      // Its plugin stopped polling (a crashed frame, a reload of the browser): opened anew, once.
      if (editor.reopened) {
        close(editor, "its plugin stopped polling again");
        throw new SeatError("editor_not_ready", "the agent's editor of this document stopped answering twice; try again");
      }
      close(editor, "its plugin stopped polling");
      editor = await open(home, docId, mode, signal);
      editor.reopened = true;
      return editor;
    }
  }
  if (!editor) return open(home, docId, mode, signal);
  editor.busy = true;
  editor.lastUsed = Date.now();
  return editor;
}

/** Waits until `editor` runs no job (none queued, none handed, no call using it), at most as long as a job and its
 * send may take; an abort ends the wait. */
async function idle(editor: Editor, signal?: AbortSignal): Promise<void> {
  const until = Date.now() + limits.jobMs + limits.sentMs;
  while (editors.has(editor.id) && (editor.busy || editor.queue.length) && Date.now() < until) {
    if (signal?.aborted) throw new SeatError("aborted", "the call was aborted");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Opens an editor: the browser and its page first, room made under the limit, the config minted, the page told, and
 * the editor's plugin waited for. */
async function open(home: string, docId: string, mode: SeatMode, signal?: AbortSignal): Promise<Editor> {
  const d = deps!;
  await connected(signal);
  // Room is made and the place taken at once, before anything is waited for: opens at the same time count each other.
  while (editors.size >= limits.maxEditors) {
    const idle = [...editors.values()].filter((e) => !e.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) throw new SeatError("busy", `the agents have ${limits.maxEditors} documents open in the editor and all of them are busy; try again in a moment`);
    close(idle, "room for another document");
  }
  const token = randomBytes(16).toString("hex");
  const editor: Editor = { id: randomUUID(), home, docId, key: "", mode, token, ready: false, waiters: [], lastUsed: Date.now(), lastPoll: Date.now(), busy: true, lastTool: 0, reopened: false, queue: [], held: null, unsentAt: 0, unsentSeq: 0, sentSeq: 0, stateWaiters: [] };
  editors.set(editor.id, editor);
  try {
    const minted = await d.mint({ home, docId, mode, pluginUrl: `${d.listenerOrigin()}/plugin/${token}/` });
    editor.key = minted.key;
    if (!editors.has(editor.id)) throw new SeatError("editor_not_ready", "the agent's editor of this document was closed while it opened");
    order({ open: { editorId: editor.id, apiJs: minted.apiJs, config: minted.config, appReadyMs: limits.appReadyMs } });
    await ready(editor, signal);
  } catch (e) {
    close(editor, "it did not open");
    throw e;
  } finally {
    editor.busy = false;
  }
  return editor;
}

/** The browser started (where it does not run) and its page polling. A poll held from a browser that was stopped is no
 * page that listens: after a stop, only a poll that came after the new start counts. */
async function connected(signal?: AbortSignal): Promise<void> {
  const d = deps!;
  if (agentRunning && (page || Date.now() - pageSeen < limits.holdMs + 5_000)) return;
  // Counted from before the wait for a stop: the sweep could otherwise stop the browser this call starts, between its
  // start and its page's first poll, when no editor is open yet.
  startingAgent++;
  try {
    await stopping;
    const since = Date.now();
    await d.ensureAgent(pageUrl());
    agentRunning = true;
    await waitFor((wake) => pageWaiters.push(wake), () => pageSeen >= since, limits.connectMs, signal, () => new SeatError("agent_unavailable", `the agent's editor did not start within ${limits.connectMs / 1000} s`));
    startFailed = undefined;
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code !== "agent_editor_missing" && code !== "office_stopped" && !signal?.aborted) startFailed = (e as Error).message;
    throw e;
  } finally {
    startingAgent--;
    // A browser just started runs its idle time from now, not from the last close before it stopped.
    lastEditorClosed = Date.now();
  }
}

/** The edit's changes sent to the Document Server: since the job was handed (`since`) the editor said it held changes
 * unsent, and said after that it sent them all; or it said nothing of changes for quietMs after the command's outcome
 * came (`at`: the edit changed nothing). The page and the plugin speak over requests of their own, so either may come
 * first. An editor that still held changes unsent when the job was handed (`pending`) says nothing new when the edit
 * adds to them: then only its word that it sent them counts, never the quiet. Rejects with editor_not_saved where they
 * are not sent within sentMs: the edit is made in the editor, and reaches the file with a later save. Answers whether
 * the editor said it had changes to send (false: the edit changed nothing). */
async function sent(editor: Editor, since: number, at: number, pending: boolean, signal?: AbortSignal): Promise<boolean> {
  const changed = () => pending || editor.unsentAt >= since;
  const done = () => !editors.has(editor.id) || (changed() ? editor.sentSeq > editor.unsentSeq : Date.now() - at >= limits.quietMs);
  const quiet = setTimeout(() => {
    for (const wake of editor.stateWaiters.splice(0)) wake();
  }, limits.quietMs);
  try {
    await waitFor((wake) => editor.stateWaiters.push(wake), done, limits.sentMs, signal, () => new SeatError("editor_not_saved", `the edit is made in the agent's editor, but the editor did not send it to the Document Server within ${limits.sentMs / 1000} s; it reaches the file with a later save`, undefined, true));
  } catch (e) {
    // An abort after the command ran: the edit is made all the same.
    if (e instanceof SeatError && e.code === "aborted") throw new SeatError("aborted", e.message, undefined, true);
    throw e;
  } finally {
    clearTimeout(quiet);
  }
  return changed();
}

async function ready(editor: Editor, signal?: AbortSignal): Promise<void> {
  if (editor.ready) return;
  await waitFor(
    (wake) => editor.waiters.push(wake),
    () => editor.ready || editor.failed !== undefined || !editors.has(editor.id),
    limits.readyMs,
    signal,
    () => new SeatError("editor_not_ready", `the agent's editor did not open the document within ${limits.readyMs / 1000} s`),
  );
  if (editor.failed !== undefined) throw new SeatError("editor_not_ready", `the agent's editor could not open the document: ${editor.failed}`);
  if (!editors.has(editor.id)) throw new SeatError("editor_not_ready", "the agent's editor of this document was closed while it opened");
}

/** Waits until `done()` holds, woken by whoever `listen` hands the wake to; rejects at `ms` or on an abort. */
function waitFor(listen: (wake: () => void) => void, done: () => boolean, ms: number, signal: AbortSignal | undefined, late: () => Error): Promise<void> {
  return new Promise((resolve, reject) => {
    if (done()) return resolve();
    let over = false;
    const finish = (e?: Error) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (e) reject(e);
      else resolve();
    };
    const wake = () => {
      if (done()) finish();
      else if (!over) listen(wake);
    };
    const aborted = () => finish(new SeatError("aborted", "the call was aborted"));
    const timer = setTimeout(() => finish(late()), ms);
    signal?.addEventListener("abort", aborted);
    if (signal?.aborted) return aborted();
    listen(wake);
  });
}

/** The job handed to the editor's plugin (now, where it waits, or at its next poll) and its outcome waited for. A job
 * with no outcome in time closes the editor: what it did is unknown. Its time counts from when it is handed; while it
 * waits behind a job handed before it, or a picture that holds the editor, it waits as long as they take (each ends
 * within its own time, or closes the editor). */
function handOver(editor: Editor, job: SeatJob & { hold?: string }, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<Outcome & { handedAt?: number; unsentAtHand?: boolean }> {
  const ms = options.timeoutMs ?? limits.jobMs;
  return new Promise((resolve, reject) => {
    let over = false;
    let timer: ReturnType<typeof setTimeout>;
    const queued: Job = {
      id: randomUUID(),
      kind: job.kind,
      args: job.args,
      handed: false,
      handedAt: 0,
      unsentAtHand: false,
      ...(job.hold ? { hold: job.hold } : {}),
      settle: (outcome) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", aborted);
        resolve({ ...outcome, handedAt: queued.handedAt, unsentAtHand: queued.unsentAtHand });
      },
    };
    const expire = () => {
      if (over) return;
      if (!queued.handed && (editor.holding !== undefined || editor.queue.some((j) => j.handed))) {
        timer = setTimeout(expire, ms);
        return;
      }
      over = true;
      options.signal?.removeEventListener("abort", aborted);
      close(editor, "a job of it timed out");
      reject(new SeatError("timeout", `the agent's editor gave no result within ${ms / 1000} s; what the call did is unknown: read the document again before you go on`, undefined, queued.handed));
    };
    timer = setTimeout(expire, ms);
    queued.onHand = () => {
      clearTimeout(timer);
      timer = setTimeout(expire, ms);
    };
    const aborted = () => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      // Not handed yet: it never runs. Handed: it runs to its end, and its outcome is dropped.
      if (!queued.handed) editor.queue = editor.queue.filter((j) => j !== queued);
      reject(new SeatError("aborted", "the call was aborted", undefined, queued.handed));
    };
    options.signal?.addEventListener("abort", aborted);
    if (options.signal?.aborted) return aborted();
    editor.queue.push(queued);
    feed(editor);
  });
}

/** The next job to the plugin's held poll, where both are there and no picture holds the editor. A picture's locate
 * holds it from when it is handed until the picture is taken (`shot`). */
function feed(editor: Editor): void {
  if (editor.holding) return;
  const job = editor.queue.find((j) => !j.handed);
  if (!job || !editor.held) return;
  const res = editor.held;
  editor.held = null;
  if (job.hold) editor.holding = job.hold;
  job.handed = true;
  job.handedAt = Date.now();
  job.unsentAtHand = editor.unsentSeq > editor.sentSeq;
  job.onHand?.();
  json(res, 200, { jobId: job.id, kind: job.kind, args: job.args });
}

/* ------------------------------------------------------------------ */
/* closing                                                             */
/* ------------------------------------------------------------------ */

function close(editor: Editor, why: string): void {
  if (!editors.delete(editor.id)) return;
  log(`closed the agent's editor of ${editor.docId} (${editor.home}): ${why}`);
  // Its plugin hears 404 and stops; a job it has not taken never runs; one it took is not waited for any more, and may
  // have run (and been sent): it is not to be made again unseen.
  if (editor.held) {
    notFound(editor.held);
    editor.held = null;
  }
  for (const job of editor.queue) {
    job.settle(
      job.handed
        ? { error: { code: "editor_closed", message: `the agent's editor of this document was closed (${why}) while it ran the call; what the call did is unknown: read the document again before you go on` }, ran: true }
        : { error: { code: "editor_closed", message: `the agent's editor of this document was closed (${why}); try again` } },
    );
  }
  editor.queue = [];
  for (const wake of editor.waiters.splice(0)) wake();
  for (const wake of editor.stateWaiters.splice(0)) wake();
  order({ close: editor.id });
  if (!editors.size) lastEditorClosed = Date.now();
}

/** Closes the seats in `docId` (it was trashed, or its file changed outside). */
export function closeDoc(docId: string, why = "its document was deleted"): void {
  for (const e of [...editors.values()]) if (e.docId === docId) close(e, why);
}

/** The editor of (`home`, `docId`) closed, where it is open and not busy: the next call opens the document anew (a
 * reply it made that never reached anybody may have left it with a stale view of a comment's lock). */
export function closeEditor(home: string, docId: string, why: string): void {
  const e = find(home, docId);
  if (e && !e.busy) close(e, why);
}

/** Every seat closed: the person stopped Office, or removed its Document Server, and the browser went with it
 * (container.stopContainer). The next call starts it again, where Office runs again. */
export function closeSeats(): void {
  closeAll();
  agentRunning = false;
  pageSeen = 0;
  startFailed = undefined;
}

/** Every seat closed and the browser stopped: the Document Server was (re)started, which ended the sessions the
 * agents' editors were in. An editor left open would go on running commands on its own copy, which reach nobody. The
 * next call starts the browser again (after this stop). */
export function resetSeats(why: string): void {
  if (!deps) return;
  const d = deps;
  const open = editors.size;
  closeSeats();
  if (open) log(`closed ${open} agent editor(s): ${why}`);
  stopping = stopping.then(() => d.stopAgent()).catch((e) => log(`could not stop the agents' browser: ${(e as Error).message}`));
}

function closeAll(): void {
  for (const e of [...editors.values()]) close(e, "the seats stop");
  orders.length = 0;
  if (page) notFound(page);
  page = null;
  for (const wake of pageWaiters.splice(0)) wake();
}

/** What the page is to do, handed to its held poll or kept for its next. */
function order(o: Record<string, unknown>): void {
  if (page) {
    const res = page;
    page = null;
    json(res, 200, o);
  } else orders.push(o);
}

/** Every 30 s (or more often for short limits): idle editors closed, and the browser stopped once none was open for a
 * while. */
function sweep(): void {
  const now = Date.now();
  for (const e of [...editors.values()]) {
    if (e.busy) continue;
    const posting = now - e.lastTool > limits.toolWindowMs;
    if (now - e.lastUsed > (posting ? limits.postIdleMs : limits.idleMs)) close(e, posting ? "idle after posting" : "idle");
  }
  if (agentRunning && !startingAgent && !editors.size && now - lastEditorClosed > limits.agentIdleMs && deps) {
    agentRunning = false;
    pageSeen = 0;
    // Its page goes with it: a poll it held is not taken for a page that still listens.
    if (page) noContent(page);
    page = null;
    stopping = deps.stopAgent().catch((e) => log(`could not stop the agents' browser: ${(e as Error).message}`));
  }
}

/* ------------------------------------------------------------------ */
/* the routes on the loopback listener                                 */
/* ------------------------------------------------------------------ */

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: "no such endpoint on the office loopback listener", code: "not_found" });
}

function noContent(res: ServerResponse): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        resolve(null);
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

/** Holds `res` as the long-poll of `set`/`get`, answered with 204 after holdMs, and let go when the client goes. */
function hold(res: ServerResponse, set: (r: ServerResponse | null) => void, get: () => ServerResponse | null): void {
  set(res);
  const timer = setTimeout(() => {
    if (get() !== res) return;
    set(null);
    noContent(res);
  }, limits.holdMs);
  res.on("close", () => {
    clearTimeout(timer);
    if (get() === res) set(null);
  });
}

/**
 * The seat routes of the loopback listener (server.ts hands it every request): true where it answered. Anything under
 * /seat/ without this run's secret, and anything under /plugin/ without an open editor's token, is left to the
 * listener's own 404, so nobody learns more from it than from any other path.
 */
export function handleSeat(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!deps) return false;
  const seat = /^\/seat\/([0-9a-f]{64})\/([a-z.]*)$/.exec(pathname);
  if (seat && same(seat[1], secret)) return seatRoute(req, res, seat[2]);
  const plugin = /^\/plugin\/([0-9a-f]{32})\/([a-z.]+)$/.exec(pathname);
  if (plugin) {
    const editor = [...editors.values()].find((e) => same(e.token, plugin[1]));
    if (editor) return pluginRoute(req, res, editor, plugin[2]);
  }
  return false;
}

function seatRoute(req: IncomingMessage, res: ServerResponse, rest: string): boolean {
  if (req.method === "GET" && rest === "") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(SEAT_PAGE_HTML);
    return true;
  }
  if (req.method === "GET" && rest === "page.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(SEAT_PAGE_JS);
    return true;
  }
  if (req.method === "GET" && rest === "poll") {
    pageSeen = Date.now();
    for (const wake of pageWaiters.splice(0)) wake();
    if (orders.length) {
      json(res, 200, orders.shift());
      return true;
    }
    if (page) noContent(page); // a poll of before that the browser gave up on: the newest one waits
    hold(res, (r) => (page = r), () => page);
    for (const wake of pageWaiters.splice(0)) wake();
    return true;
  }
  if (req.method === "POST" && rest === "event") {
    void readBody(req, 64 * 1024).then((body) => {
      let event: { editorId?: unknown; type?: unknown; data?: unknown; seq?: unknown } = {};
      try {
        event = JSON.parse(body?.toString("utf8") ?? "{}");
      } catch {
        event = {};
      }
      const editor = typeof event.editorId === "string" ? editors.get(event.editorId) : undefined;
      if (editor && event.type === "error") {
        const what = JSON.stringify(event.data ?? null).slice(0, 300);
        log(`the agent's editor of ${editor.docId} reported an error: ${what}`);
        if (!editor.ready) {
          editor.failed = what;
          for (const wake of editor.waiters.splice(0)) wake();
        } else {
          // An editor that went wrong after it opened (its Document Server session lost, a reload asked for) is not used
          // again: what it ran would reach nobody. The next call opens the document anew.
          close(editor, `it reported an error: ${what}`);
        }
      }
      if (editor && event.type === "remade") log(`the agent's editor of ${editor.docId} did not start, made anew`);
      if (editor && event.type === "state") {
        // The page numbers its events, as two of them may arrive in either order (each is a request of its own); one
        // without a number is counted as it comes.
        const seq = typeof event.seq === "number" && Number.isSafeInteger(event.seq) ? event.seq : ++stateSeq;
        if (event.data === true) {
          editor.unsentAt = Date.now();
          editor.unsentSeq = Math.max(editor.unsentSeq, seq);
        } else editor.sentSeq = Math.max(editor.sentSeq, seq);
        for (const wake of editor.stateWaiters.splice(0)) wake();
      }
      json(res, 200, {});
    });
    return true;
  }
  return false;
}

function pluginRoute(req: IncomingMessage, res: ServerResponse, editor: Editor, rest: string): boolean {
  const d = deps!;
  if (req.method === "GET" && rest === "config.json") {
    // Fetched by the editor's own frame, which is on the Document Server's origin.
    json(res, 200, JSON.parse(pluginConfig()), { "Access-Control-Allow-Origin": d.dsOrigin() });
    return true;
  }
  if (req.method === "GET" && rest === "index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(pluginIndex(d.dsOrigin()));
    return true;
  }
  if (req.method === "GET" && rest === "bridge.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(BRIDGE_JS);
    return true;
  }
  if (req.method === "POST" && rest === "next") {
    req.resume();
    editor.lastPoll = Date.now();
    if (!editor.ready) {
      editor.ready = true;
      for (const wake of editor.waiters.splice(0)) wake();
    }
    if (editor.held) noContent(editor.held);
    hold(res, (r) => (editor.held = r), () => editor.held);
    feed(editor);
    return true;
  }
  if (req.method === "POST" && rest === "done") {
    editor.lastPoll = Date.now();
    void readBody(req, limits.maxDone).then((body) => {
      if (!body) {
        // Its job (the plugin runs one at a time) ends with that, and the editor stays: waiting for the job's time to
        // run out would close it, and every retry would open and close it again.
        for (const job of editor.queue.filter((j) => j.handed)) {
          editor.queue = editor.queue.filter((j) => j !== job);
          job.settle({ error: { code: "too_large", message: `the editor's result is larger than ${Math.round(limits.maxDone / 1024 / 1024)} MiB` }, ran: true });
        }
        return json(res, 413, { error: "the result is too large", code: "too_large" });
      }
      let done: { jobId?: unknown; result?: unknown; error?: { code?: string; message?: string; op?: number }; ran?: unknown } = {};
      try {
        done = JSON.parse(body.toString("utf8"));
      } catch {
        done = {};
      }
      const job = editor.queue.find((j) => j.handed && j.id === done.jobId);
      if (job) {
        editor.queue = editor.queue.filter((j) => j !== job);
        // `ran`: the plugin says its failed job may have changed the document all the same (a spreadsheet edit it could
        // not take back whole).
        job.settle(done.error ? { error: done.error, ...(done.ran === true ? { ran: true } : {}) } : { result: done.result });
      }
      json(res, 200, {});
    });
    return true;
  }
  return false;
}
