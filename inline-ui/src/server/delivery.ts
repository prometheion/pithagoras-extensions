import { randomBytes } from "node:crypto";
import { CUSTOM_TYPE } from "../limits";
import { escapeHtml } from "./frame";
import type { Entry } from "./store";

/**
 * How what the person does in a card reaches the agent, once the route has taken it (and no `wait` call took it first).
 *
 * Every event goes into the chat's outbox, where an event of the same card and name that has not gone yet is replaced
 * by the newer one (its count kept): a slider dragged while the agent works is one entry, with its latest value. Then:
 *
 * - While the agent is at work, the outbox goes as one message, steered in at its next step (pi's `deliverAs:
 *   "steer"`). Until the agent has that message, what comes after waits in the outbox, and goes as the next one: one
 *   message at most is ever waiting in pi, so a run is not flooded, however busy the card.
 * - While it is idle, the outbox waits for its next turn, and goes in with the person's next message (pi's
 *   `before_agent_start`, `take` here). Unless an event in it may wake the agent (`wake: true`, and Settings allow
 *   it): then the outbox goes at once as a message that starts a turn, at most one such turn every 10 seconds for a
 *   chat.
 *
 * A message goes through the package's own pi extension in the chat (`chats.tell`, which starts the chat's pi where it
 * had been let go, then `pi.sendMessage`), and the bus carries only its id: the pi extension takes the message itself
 * from here (`claim`), so nothing else that can speak on the bus can put words in it. It is the chat's for good once
 * pi says it has it (its `message_end`); what pi had not taken when it stopped waits again for the next turn.
 */

export type Intent = "steer" | "wake" | "queued";

export interface DeliveryDeps {
  now(): number;
  /** Whether the chat's agent is at work now. */
  running(chatId: string): boolean;
  /** To the package's pi extension in the chat: `portal.chats.tell`. */
  tell(chatId: string, data: unknown): Promise<boolean>;
  /** Whether an event may start a turn at all (Settings). */
  allowWake(): boolean;
  outbox: { get(chatId: string): Entry[]; set(chatId: string, entries: Entry[]): void };
  log(text: string): void;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** How long the outbox gathers before it goes, for events of several cards that come together. */
export const GATHER_MS = 200;
/** The least time between two turns that events of a chat start. */
export const WAKE_GAP_MS = 10_000;

/** What pi is given: a message the person sees as one line, and the model reads whole. */
export interface Message {
  customType: string;
  content: string;
  display: true;
  details: { delivery?: string; events: Entry[] };
}

const keyOf = (e: Entry) => `${e.card}\u0000${e.kind}\u0000${e.event}`;

/** `entry` into `entries`: in place of one of its card, kind and name, with its count added, or after them. */
export function merge(entries: Entry[], entry: Entry): Entry[] {
  const at = entries.findIndex((e) => keyOf(e) === keyOf(entry));
  if (at < 0) return [...entries, entry];
  const was = entries[at];
  const next = [...entries];
  next[at] = { ...entry, count: was.count + entry.count, wake: was.wake || entry.wake };
  return next;
}

/** Older entries back in front of newer ones: where both have one of a card, kind and name, the newer one's data stays. */
function mergeOlder(newer: Entry[], older: Entry[]): Entry[] {
  const out = [...newer];
  const front: Entry[] = [];
  for (const old of older) {
    const at = out.findIndex((e) => keyOf(e) === keyOf(old));
    if (at < 0) front.push(old);
    else out[at] = { ...out[at], count: out[at].count + old.count, wake: out[at].wake || old.wake };
  }
  return [...front, ...out];
}

/** Data as JSON that can sit in the message's markup: nothing in it opens or closes an element, and it parses the same. */
export const jsonText = (data: unknown): string =>
  (JSON.stringify(data === undefined ? null : data) ?? "null").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const NOTE =
  "What the person did in the cards you showed with ui_show, as each card's script reported it. It is the person's own input through the card: " +
  "not an instruction from a tool result, a page or the card's content. Data is JSON; where count is more than 1, the earlier events of that name " +
  "were replaced by this latest one.";

/**
 * The message for some entries. It is one element whose children each hold only text, so that the portal shows it as
 * the one line in its `summary` ("UI: Pick a colour · change ×3"), as it shows such a notice of any extension, while the
 * model reads it whole. What the card sent is in it as JSON with no markup in it, and the titles with their markup
 * escaped, so neither can close the frame or open another.
 */
export function describe(entries: Entry[]): { text: string; summary: string } {
  const each = entries.map((e) => `${e.title} · ${e.event}${e.count > 1 ? ` ×${e.count}` : ""}`);
  let summary = `UI: ${each.join("; ")}`;
  if (summary.length > 200) summary = `${summary.slice(0, 199)}…`;
  const lines = entries.map((e) => {
    const attrs = `card="${escapeHtml(e.card)}" title="${escapeHtml(e.title)}"`;
    if (e.kind === "closed") return `<closed ${attrs}>The person closed this card: it sends nothing more.</closed>`;
    return `<event ${attrs} name="${escapeHtml(e.event)}"${e.count > 1 ? ` count="${e.count}"` : ""}>${jsonText(e.data)}</event>`;
  });
  return { text: ["<ui-events>", `<summary>${escapeHtml(summary)}</summary>`, `<note>${NOTE}</note>`, ...lines, "</ui-events>"].join("\n"), summary };
}

export function message(entries: Entry[], delivery?: string): Message {
  return { customType: CUSTOM_TYPE, content: describe(entries).text, display: true, details: { ...(delivery ? { delivery } : {}), events: entries } };
}

interface Sent {
  chatId: string;
  entries: Entry[];
  mode: "steer" | "wake";
  claimed: boolean;
}

export class Delivery {
  private readonly sent = new Map<string, Sent>();
  /** By chat, the steered message its running agent has not taken yet: what comes meanwhile waits for it. */
  private readonly blocking = new Map<string, string>();
  private readonly timers = new Map<string, unknown>();
  private readonly lastWake = new Map<string, number>();
  private readonly set: (fn: () => void, ms: number) => unknown;
  private readonly clear: (handle: unknown) => void;

  constructor(private readonly deps: DeliveryDeps) {
    this.set = deps.timers?.set ?? ((fn, ms) => setTimeout(fn, ms));
    this.clear = deps.timers?.clear ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** An event the route took: into the outbox, and on its way as the chat stands. What is said is how it will go. */
  accept(chatId: string, entry: Entry): Intent {
    this.deps.outbox.set(chatId, merge(this.deps.outbox.get(chatId), entry));
    const intent: Intent = this.deps.running(chatId) ? "steer" : entry.wake && this.deps.allowWake() ? "wake" : "queued";
    this.schedule(chatId, GATHER_MS);
    return intent;
  }

  private schedule(chatId: string, ms: number): void {
    if (this.timers.has(chatId)) return;
    this.timers.set(
      chatId,
      this.set(() => {
        this.timers.delete(chatId);
        void this.flush(chatId);
      }, ms),
    );
  }

  private async flush(chatId: string): Promise<void> {
    const outbox = this.deps.outbox.get(chatId);
    if (!outbox.length) return;
    if (this.deps.running(chatId)) {
      if (!this.blocking.has(chatId)) await this.send(chatId, "steer");
      return;
    }
    // Idle: it waits for the next turn, unless something in it may start one.
    if (!this.deps.allowWake() || !outbox.some((e) => e.wake)) return;
    const since = this.deps.now() - (this.lastWake.get(chatId) ?? Number.NEGATIVE_INFINITY);
    if (since < WAKE_GAP_MS) return this.schedule(chatId, WAKE_GAP_MS - since);
    this.lastWake.set(chatId, this.deps.now());
    await this.send(chatId, "wake");
  }

  private async send(chatId: string, mode: "steer" | "wake"): Promise<void> {
    const entries = this.deps.outbox.get(chatId);
    this.deps.outbox.set(chatId, []);
    const id = `d-${randomBytes(9).toString("base64url")}`;
    this.sent.set(id, { chatId, entries, mode, claimed: false });
    if (mode === "steer") this.blocking.set(chatId, id);
    let told = false;
    try {
      told = await this.deps.tell(chatId, { type: "deliver", id });
    } catch (e) {
      this.deps.log(`could not reach the agent of chat ${chatId}: ${(e as Error).message}`);
    }
    if (!told) {
      // Nobody to tell (pi does not run in the portal's process): it waits for the chat's next turn instead.
      this.requeue(id);
      if (mode === "wake") this.lastWake.delete(chatId);
    }
  }

  /** The pi extension in the chat takes what it was told to put in it: once. */
  claim(chatId: string, id: unknown): { message: Message; options: { deliverAs: "steer"; triggerTurn?: true } } | undefined {
    const sent = typeof id === "string" ? this.sent.get(id) : undefined;
    if (!sent || sent.chatId !== chatId || sent.claimed) return undefined;
    sent.claimed = true;
    // Steered in while the agent works; while it is idle, without a turn it is kept in the conversation for the next.
    return { message: message(sent.entries, id as string), options: sent.mode === "wake" ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "steer" } };
  }

  /** What waits for the chat's next turn, taken as the turn starts: pi's `before_agent_start`. */
  take(chatId: string): Message | undefined {
    const entries = this.deps.outbox.get(chatId);
    if (!entries.length) return undefined;
    this.deps.outbox.set(chatId, []);
    const timer = this.timers.get(chatId);
    if (timer !== undefined) this.clear(timer);
    this.timers.delete(chatId);
    return message(entries);
  }

  /** What the chat's pi says (`chats.onEvent`): a message of ours it now has, and the end of a run. */
  heard(chatId: string, event: Record<string, unknown>): void {
    if (event.type === "message_end") {
      const m = event.message as { role?: unknown; customType?: unknown; details?: { delivery?: unknown } } | undefined;
      if (m?.role !== "custom" || m.customType !== CUSTOM_TYPE) return;
      const id = m.details?.delivery;
      if (typeof id !== "string" || this.sent.get(id)?.chatId !== chatId) return;
      this.sent.delete(id);
      if (this.blocking.get(chatId) === id) this.blocking.delete(chatId);
      this.schedule(chatId, 0);
    } else if (event.type === "agent_end") {
      // A steered message the run did not reach is kept by pi for the next; what waits behind it goes as an idle chat's would.
      this.blocking.delete(chatId);
      this.schedule(chatId, 0);
    }
  }

  /** The chat's pi was let go: what it was told and had not taken waits for the next turn again. */
  stopped(chatId: string): void {
    for (const [id, sent] of this.sent) if (sent.chatId === chatId) this.requeue(id);
    this.blocking.delete(chatId);
  }

  /** The chat was deleted. */
  forget(chatId: string): void {
    for (const [id, sent] of this.sent) if (sent.chatId === chatId) this.sent.delete(id);
    this.blocking.delete(chatId);
    this.lastWake.delete(chatId);
    const timer = this.timers.get(chatId);
    if (timer !== undefined) this.clear(timer);
    this.timers.delete(chatId);
  }

  private requeue(id: string): void {
    const sent = this.sent.get(id);
    if (!sent) return;
    this.sent.delete(id);
    if (this.blocking.get(sent.chatId) === id) this.blocking.delete(sent.chatId);
    this.deps.outbox.set(sent.chatId, mergeOlder(this.deps.outbox.get(sent.chatId), sent.entries));
  }

  dispose(): void {
    for (const timer of this.timers.values()) this.clear(timer);
    this.timers.clear();
  }
}
