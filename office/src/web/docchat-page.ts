/**
 * The people's editor's half of comments and the editor's chat with agents (docchat.ts is the server's): it hooks the
 * OnlyOffice editor in its own placeholder, hears its comment and chat events, and tells the server half
 *
 * - what a person did through the editor's own UI on this page (a "ui report"): the editor's UI makes a comment with
 *   `asc_addComment`, changes a thread (a reply, an edit, a resolve) with `asc_changeComment` and sends a chat message
 *   with `asc_coAuthoringChatSendMessage`, all on its `Asc.editor`, which this page wraps. The SDK never calls those
 *   names itself, so a paste, an undo, a co-author's change, a replay for a late joiner and the file's own comments
 *   make no ui report. A report is sent once this page's editor heard the event that carries it (in Word inside the
 *   call, in a spreadsheet after it), within 10 s, else it is dropped (a lock that failed, a lost connection);
 * - what its editor hears (a "state report"): each comment as it is now, comments removed, and at the document's
 *   ready the comments it sees. These keep the server's view of the threads; they never prompt anybody.
 *
 * Reports go out together every 300 ms (three tries each), the last ones with `keepalive` when the page goes. A thread
 * is named by its GUID (the editor's `asc_getGuid`), which this page keeps for each comment's id in this session and
 * updates with every event: a comment made through the builder (an agent's) changes its GUID once after it came.
 */

/** The protocol of the reports (docchat.ts PROTOCOL). */
export const PROTOCOL = 1;

/** How long a ui report waits for its own event before it is dropped, and how often reports go out. */
export const pageTimings = { confirmMs: 10_000, batchMs: 300, frameMs: 30_000 };

/** A request's events and size at most, below the server's (64 events, 256 KB): a batch is cut by both, and a comment's
 * state larger than `event` keeps its latest replies only. */
export const pageCaps = { events: 64, bytes: 200 * 1024, event: 96 * 1024 };

type Reply = { userId?: string; author?: string; text: string };
type Comment = { guid: string; sessionId: string; userId?: string; author?: string; text: string; time?: number; solved?: boolean; quote?: string; replies: Reply[]; repliesCut?: number };
type Ui = { type: "ui"; id: string; kind: "comment" | "reply" | "edit" | "editReply" | "resolve" | "chat"; guid?: string; text?: string; solved?: boolean; before?: string };
type Event = Ui | ({ type: "comment" } & Comment) | { type: "removed"; guids: string[] };

/** The bits of an editor's comment data (asc_CCommentData) the page reads. */
type Data = {
  asc_getText?: () => string;
  asc_getGuid?: () => string;
  asc_getUserId?: () => string;
  asc_getUserName?: () => string;
  asc_getSolved?: () => boolean;
  asc_getQuoteText?: () => string;
  asc_getRepliesCount?: () => number;
  asc_getReply?: (i: number) => Data;
  asc_getId?: () => string;
  /** The comment's time in UTC, in ms as text (asc_getTime is the editor's local time). */
  asc_getOnlyOfficeTime?: () => string;
};

type EditorApi = Record<string, any> & { asc_registerCallback(name: string, fn: (...args: any[]) => void): void };
/** The editor app's own (web-apps) controllers, of which the comments panel's collection is read at ready. */
type Ui5 = { getController?(name: string): { collection?: { models?: { get(key: string): unknown }[] } } | undefined };

export type DocchatHook = {
  /** The editor in the placeholder said its app started: its frame is hooked (again, after a remake or a refresh). */
  appReady(): void;
  /** The document is open: the comments the editor sees are reported. */
  documentReady(): void;
  /** Stops reporting; what is waiting goes out with keepalive. */
  stop(): void;
};

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const call = <T>(d: Data | undefined, name: keyof Data, fallback: T): T => {
  try {
    const f = d?.[name] as unknown;
    return typeof f === "function" ? ((f as () => T).call(d) ?? fallback) : fallback;
  } catch {
    return fallback;
  }
};

/** A comment's data as the page reports it. */
function describe(sessionId: string, d: Data): Comment {
  const replies: Reply[] = [];
  const n = call(d, "asc_getRepliesCount", 0);
  for (let i = 0; i < n && i < 500; i++) {
    let r: Data | undefined;
    try {
      r = d.asc_getReply?.(i);
    } catch {
      r = undefined;
    }
    if (r) replies.push({ userId: str(call(r, "asc_getUserId", "")), author: str(call(r, "asc_getUserName", "")), text: str(call(r, "asc_getText", "")).slice(0, 20_000) });
  }
  return {
    guid: str(call(d, "asc_getGuid", "")),
    sessionId,
    userId: str(call(d, "asc_getUserId", "")),
    author: str(call(d, "asc_getUserName", "")),
    text: str(call(d, "asc_getText", "")).slice(0, 20_000),
    // What tells two comments of the same author and text apart where a spreadsheet's reply has no session id to go by.
    ...(Number(call(d, "asc_getOnlyOfficeTime", "")) > 0 ? { time: Number(call(d, "asc_getOnlyOfficeTime", "")) } : {}),
    solved: Boolean(call(d, "asc_getSolved", false)),
    quote: str(call(d, "asc_getQuoteText", "")).slice(0, 2000),
    replies,
  };
}

/** Answers a report is not tried again after; of those, the ones after which this page reports nothing more. */
const STOPS = new Set([401, 403, 409, 501]);
const FINAL = new Set([400, 413, ...STOPS]);

/**
 * Hooks the editor whose frame `frame()` finds (inside this editor's own placeholder), for the document `docId` whose
 * session `key()` names now. `user` is this page's editor user id (its config's). `post` sends a report to the server
 * half's `path` (`/docchat/events`, `/docchat/ready`); `keepalive` for the last ones as the page goes.
 */
export function hookDocchat(options: {
  frame: () => HTMLIFrameElement | null;
  docId: string;
  key: () => string;
  user: string;
  post: (path: string, body: unknown, keepalive?: boolean) => Promise<{ ok: boolean; status: number }>;
  log?: (line: string) => void;
}): DocchatHook {
  const { docId, user } = options;
  const log = options.log ?? (() => {});
  /** comment id in this session -> what this page knows of it (GUID first). */
  let known = new Map<string, Comment>();
  /** Reports made, each waiting for the event that carries it. */
  let waiting: { ui: Ui; heard: () => boolean; until: number }[] = [];
  let queue: Event[] = [];
  let api: EditorApi | null = null;
  let stopped = false;
  let gone = false;
  let flushing: ReturnType<typeof setTimeout> | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  /** Chat messages this page's person sent, not heard back yet. */
  let sentChat: string[] = [];
  let heardChat: string[] = [];
  let chunks: string[] = [];
  let chunkTimer: ReturnType<typeof setTimeout> | undefined;

  const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const size = (e: unknown) => JSON.stringify(e).length;

  function enqueue(e: Event): void {
    if (stopped || gone) return;
    // A thread of many long replies: its state keeps its latest replies, as many as fit (the rest are counted).
    if (e.type === "comment" && size(e) > pageCaps.event) {
      const all = e.replies;
      let keep = all.length;
      while (keep > 0 && size({ ...e, replies: all.slice(all.length - keep) }) > pageCaps.event) keep = Math.max(0, Math.floor(keep / 2));
      e = { ...e, replies: all.slice(all.length - keep), repliesCut: all.length - keep };
    }
    queue.push(e);
    if (flushing === undefined) flushing = setTimeout(() => void flush(), pageTimings.batchMs);
  }

  /** Sends `events`; the answer's status, or 0 where every try failed. */
  async function send(events: Event[], keepalive: boolean): Promise<number> {
    const body = { v: PROTOCOL, docId, key: options.key(), events };
    let status = 0;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await options.post("/docchat/events", body, keepalive);
        status = r.status;
        if (r.ok || FINAL.has(r.status)) return r.status;
      } catch {
        // tried again
      }
      if (keepalive) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
    return status;
  }

  async function flush(keepalive = false): Promise<void> {
    flushing = undefined;
    if (!queue.length || gone) return;
    // As many as fit in one request, by count and by size (one at least).
    let n = 0;
    let bytes = 0;
    while (n < queue.length && n < pageCaps.events && (n === 0 || bytes + size(queue[n]) <= pageCaps.bytes)) bytes += size(queue[n++]);
    const events = queue.splice(0, n);
    let status = await send(events, keepalive);
    // Refused as too large all the same: what a person did goes alone, rather than with what the editor heard.
    if (status === 413) {
      const ui = events.filter((e) => e.type === "ui");
      if (ui.length && ui.length < events.length) status = await send(ui, keepalive);
      if (status === 413) log(`docchat reports refused as too large: ${events.length} dropped`);
    }
    if (STOPS.has(status)) {
      // Office was updated (another protocol), the session is not open, this person may not talk to the agents, or the
      // portal is too old for agents to answer (501): nothing more is taken from this page.
      log(`docchat reports refused (${status}): reload the page`);
      gone = true;
      return;
    }
    if (queue.length && flushing === undefined) flushing = setTimeout(() => void flush(), pageTimings.batchMs);
  }

  /** The ui reports whose event this page heard go out; those past their time are dropped. */
  function settle(): void {
    const now = Date.now();
    waiting = waiting.filter((w) => {
      if (w.heard()) {
        enqueue(w.ui);
        return false;
      }
      if (now > w.until) {
        log(`a ${w.ui.kind} report was dropped: its editor did not hear it within ${pageTimings.confirmMs} ms`);
        return false;
      }
      return true;
    });
  }

  /** The GUIDs a comment (by its id) had before its last: a comment made through the builder comes with one GUID and
   * changes to its lasting one, while the editor's own UI keeps the first, so its later changes can carry that again. */
  let before = new Map<string, Set<string>>();

  function heardComment(sessionId: string, data: Data): Comment {
    const c = describe(sessionId, data);
    const was = known.get(sessionId);
    // A GUID the event lacks, or one the comment had before its lasting one: the one known.
    if (was && (!c.guid || before.get(sessionId)?.has(c.guid))) c.guid = was.guid;
    if (was?.guid && c.guid !== was.guid) before.set(sessionId, new Set([...(before.get(sessionId) ?? []), was.guid]));
    known.set(sessionId, c);
    if (c.guid) enqueue({ type: "comment", ...c });
    settle();
    return c;
  }

  function hook(target: EditorApi): void {
    if (api === target) return;
    api = target;
    known = new Map();
    before = new Map();
    waiting = [];
    const realAdd = target.asc_addComment;
    const realChange = target.asc_changeComment;
    const realChat = target.asc_coAuthoringChatSendMessage;
    if (typeof realAdd === "function") {
      target.asc_addComment = function (this: unknown, data: Data, ...rest: unknown[]) {
        const c = describe("", data);
        if (c.guid) {
          const ui: Ui = { type: "ui", id: id(), kind: "comment", guid: c.guid, text: c.text };
          waiting.push({ ui, heard: () => [...known.values()].some((k) => k.guid === c.guid), until: Date.now() + pageTimings.confirmMs });
        }
        const out = realAdd.call(this, data, ...rest);
        settle();
        return out;
      };
    }
    if (typeof realChange === "function") {
      target.asc_changeComment = function (this: unknown, sessionId: string, data: Data, ...rest: unknown[]) {
        const before = known.get(str(sessionId));
        const after = describe(str(sessionId), data);
        const guid = before?.guid || after.guid;
        let ui: Ui | null = null;
        if (before && guid) {
          const last = after.replies[after.replies.length - 1];
          if (after.replies.length === before.replies.length + 1 && last && (!last.userId || last.userId === user)) ui = { type: "ui", id: id(), kind: "reply", guid, text: last.text };
          else if (after.text !== before.text) ui = { type: "ui", id: id(), kind: "edit", guid, text: after.text, before: before.text };
          else if (after.replies.length === before.replies.length && after.replies.some((r, i) => r.text !== before.replies[i]?.text)) ui = { type: "ui", id: id(), kind: "editReply", guid, text: after.replies.find((r, i) => r.text !== before.replies[i]?.text)!.text };
          else if (Boolean(after.solved) !== Boolean(before.solved)) ui = { type: "ui", id: id(), kind: "resolve", guid, solved: Boolean(after.solved) };
        }
        if (ui) {
          const made = ui;
          const want = made.kind === "reply" ? after.replies.length : -1;
          waiting.push({
            ui: made,
            heard: () => {
              const now = known.get(str(sessionId));
              if (!now) return false;
              if (made.kind === "reply") return now.replies.length >= want && now.replies.some((r) => r.text === made.text);
              if (made.kind === "edit") return now.text === made.text;
              if (made.kind === "resolve") return Boolean(now.solved) === made.solved;
              return now.replies.some((r) => r.text === made.text);
            },
            until: Date.now() + pageTimings.confirmMs,
          });
        }
        const out = realChange.call(this, sessionId, data, ...rest);
        settle();
        return out;
      };
    }
    if (typeof realChat === "function") {
      target.asc_coAuthoringChatSendMessage = function (this: unknown, text: string, ...rest: unknown[]) {
        // The chat panel splits a long message into calls in the same tick: they are one message of the person's.
        chunks.push(str(text));
        if (chunkTimer === undefined) {
          chunkTimer = setTimeout(() => {
            chunkTimer = undefined;
            const parts = chunks;
            chunks = [];
            const message = parts.join("");
            sentChat.push(...parts);
            const ui: Ui = { type: "ui", id: id(), kind: "chat", text: message };
            waiting.push({ ui, heard: () => parts.every((p) => heardChat.includes(p)), until: Date.now() + pageTimings.confirmMs });
            settle();
          }, 0);
        }
        return realChat.call(this, text, ...rest);
      };
    }
    target.asc_registerCallback("asc_onAddComment", (sessionId: unknown, data: Data) => void heardComment(str(sessionId), data));
    target.asc_registerCallback("asc_onChangeCommentData", (sessionId: unknown, data: Data) => void heardComment(str(sessionId), data));
    target.asc_registerCallback("asc_onRemoveComment", (sessionId: unknown) => removed([str(sessionId)]));
    // A spreadsheet's: its comments at load, comments moved by a row or column, removed with one.
    target.asc_registerCallback("asc_onAddComments", (list: unknown) => {
      for (const d of Array.isArray(list) ? (list as Data[]) : []) heardComment(str(call(d, "asc_getId", "")), d);
    });
    target.asc_registerCallback("asc_onChangeComments", (list: unknown) => {
      for (const item of Array.isArray(list) ? (list as { Id?: unknown; Comment?: Data }[]) : []) if (item?.Comment) heardComment(str(item.Id), item.Comment);
    });
    target.asc_registerCallback("asc_onRemoveComments", (list: unknown) => removed((Array.isArray(list) ? list : []).map(str)));
    target.asc_registerCallback("asc_onCoAuthoringChatReceiveMessage", (messages: unknown) => {
      for (const m of Array.isArray(messages) ? (messages as { message?: unknown; useridoriginal?: unknown }[]) : []) {
        const text = str(m?.message);
        const at = sentChat.indexOf(text);
        if (str(m?.useridoriginal) === user && at !== -1) {
          sentChat.splice(at, 1);
          heardChat.push(text);
        }
      }
      settle();
      heardChat = heardChat.slice(-50);
    });
  }

  function removed(ids: string[]): void {
    const guids: string[] = [];
    for (const sid of ids) {
      const c = known.get(sid);
      if (c?.guid) guids.push(c.guid);
      known.delete(sid);
    }
    if (guids.length) enqueue({ type: "removed", guids });
  }

  /** The frame's editor API, once it is there: the frame may come a moment after the app said it started. */
  function attach(): void {
    if (watch !== undefined) clearInterval(watch);
    const until = Date.now() + pageTimings.frameMs;
    const look = () => {
      if (stopped) return true;
      try {
        const win = options.frame()?.contentWindow as (Window & { Asc?: { editor?: EditorApi } }) | null | undefined;
        const editor = win?.Asc?.editor;
        if (editor && typeof editor.asc_registerCallback === "function") {
          hook(editor);
          return true;
        }
      } catch {
        // not there yet (or of another origin: then never)
      }
      return Date.now() > until;
    };
    if (look()) return;
    watch = setInterval(() => {
      if (look() && watch !== undefined) {
        clearInterval(watch);
        watch = undefined;
      }
    }, 200);
  }

  const timer = setInterval(settle, 1000);
  const goes = () => {
    settle();
    void flush(true);
  };
  window.addEventListener("pagehide", goes);

  return {
    appReady: attach,
    documentReady() {
      // A document loaded anew in the same frame (refreshFile) may have a new editor API: hooked again where it has.
      attach();
      // The comments the editor loaded come as events a moment after it is ready (a late joiner's replay among them).
      setTimeout(() => {
        if (stopped || gone) return;
        // What the editor's own comments panel holds, for any comment whose event came before this page listened: a
        // list that misses one would start that thread's removal.
        try {
          const win = options.frame()?.contentWindow as (Window & { DE?: Ui5; SSE?: Ui5 }) | null | undefined;
          const ui = win?.DE ?? win?.SSE;
          const models = ui?.getController?.("Common.Controllers.Comments")?.collection?.models ?? [];
          for (const m of models) {
            const get = (k: string) => m.get(k);
            const sid = str(get("uid"));
            if (!sid || known.has(sid) || !str(get("guid"))) continue;
            const replies = (Array.isArray(get("replys")) ? (get("replys") as { get(k: string): unknown }[]) : []).map((r) => ({ userId: str(r.get("userid")), author: str(r.get("username")), text: str(r.get("reply")) }));
            known.set(sid, { guid: str(get("guid")), sessionId: sid, userId: str(get("userid")), author: str(get("username")), text: str(get("comment")), solved: Boolean(get("resolved")), quote: str(get("quote")), replies });
          }
        } catch {
          // the panel's internals of another version: the events alone
        }
        let comments: Comment[] = [...known.values()].filter((c) => c.guid);
        // Every comment must be in the list (one it lacks starts its thread's removal): where all of them do not fit,
        // they go without their replies, and with their texts cut at last, which the events bring in full.
        const body = (list: Comment[]) => size({ v: PROTOCOL, docId, key: options.key(), comments: list });
        if (body(comments) > pageCaps.bytes) comments = comments.map((c) => ({ ...c, replies: [], repliesCut: c.replies.length }));
        if (body(comments) > pageCaps.bytes) comments = comments.map((c) => ({ ...c, text: c.text.slice(0, 200), quote: "" }));
        void options.post("/docchat/ready", { v: PROTOCOL, docId, key: options.key(), comments }).catch(() => {});
      }, 1500);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      if (watch !== undefined) clearInterval(watch);
      if (chunkTimer !== undefined) clearTimeout(chunkTimer);
      window.removeEventListener("pagehide", goes);
      settle();
      if (flushing !== undefined) clearTimeout(flushing);
      void flush(true);
    },
  };
}

/** The editor's mention list (onRequestUsers): who can be mentioned, asked of the server half once a minute at most,
 * filtered by what the person typed after "@". */
export function mentionList(get: () => Promise<{ users: { name: string; email: string }[] }>): (search: string) => Promise<{ name: string; email: string }[]> {
  let cached: { at: number; users: { name: string; email: string }[] } | null = null;
  return async (search: string) => {
    if (!cached || Date.now() - cached.at > 60_000) cached = { at: Date.now(), users: (await get()).users };
    const s = search.toLowerCase();
    return cached.users.filter((u) => !s || u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s));
  };
}
