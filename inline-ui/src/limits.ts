/**
 * What both halves hold a card to: the names its events may have, how long they are debounced, and how much a card,
 * an event and what is posted to a card may weigh. The tools check what the model wrote against these and say what is
 * wrong in words it can correct; the route checks what a page sends against the same, and drops what does not fit.
 */

/** The package's name: what its routes, its messages and its pi extension's bus messages go by. */
export const EXTENSION = "@pithagoras/inline-ui";

/** How long the page waits after the last emit of an event before it is sent, unless the event or Settings say otherwise. */
export const DEBOUNCE_DEFAULT_MS = 400;
export const DEBOUNCE_MIN_MS = 100;
export const DEBOUNCE_MAX_MS = 10_000;

/** At most this long between the first emit of a burst and its sending: input that never pauses still reports. */
export const maxWaitFor = (debounceMs: number): number => Math.max(1000, debounceMs * 4);

/** What one event's data may weigh, as JSON in UTF-8. */
export const EVENT_DATA_MAX = 32 * 1024;
/** What ui_update may post to a card's script at once, as JSON in UTF-8. */
export const UPDATE_DATA_MAX = 64 * 1024;
/** A card's HTML. */
export const HTML_MAX = 256 * 1024;
export const TITLE_MAX = 120;
/** The events one card may declare. */
export const EVENTS_MAX = 20;
/** An event's name: a word, as a script would write it. */
export const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/;

/** How long `wait` waits when the model gives no `timeoutSec`, and the most and least it may ask for. */
export const WAIT_DEFAULT_SEC = 600;
export const WAIT_MIN_SEC = 5;
export const WAIT_MAX_SEC = 3600;

/** How tall a card is drawn before it scrolls inside, unless Settings say otherwise. */
export const HEIGHT_DEFAULT = 480;
export const HEIGHT_MIN = 160;
export const HEIGHT_MAX = 2000;

/** The cards kept for a chat: past these, the oldest go. */
export const CARDS_PER_CHAT = 200;

/** The customType of the messages that bring a card's events into the chat. */
export const CUSTOM_TYPE = "inline-ui-events";

/** pi's event bus, between the portal and the package's pi extension in a chat (see the portal's extension-ui.ts). */
export const UI_RECEIVE = "pithagoras:v1:ui:receive";

/** Each event a card declares, as kept: its debounce where the model said one, else Settings' default, and whether it may start a turn. */
export interface EventSpec {
  debounceMs?: number;
  wake: boolean;
}
export type EventSpecs = Record<string, EventSpec>;

export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** The bytes of a text in UTF-8, without making them. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** A model's mistake, thrown as what it reads and corrects. */
export class Refusal extends Error {}
const fail = (text: string): never => {
  throw new Refusal(text);
};

/**
 * The events a card declares, as the model wrote them, checked: `{ name: { debounceMs?, wake? } }`. `true` or `{}` for a
 * name is its defaults, and so is a list of names, as models write the short form. `debounceMs` is held to 100..10000.
 */
export function readEvents(raw: unknown): EventSpecs {
  if (raw === undefined || raw === null) return {};
  const entries: [string, unknown][] = Array.isArray(raw) ? raw.map((name) => [String(name), {}]) : typeof raw === "object" ? Object.entries(raw as object) : fail('"events" is an object: {"submit": {"wake": true}, "change": {"debounceMs": 600}}.');
  if (entries.length > EVENTS_MAX) fail(`Too many events: a card declares at most ${EVENTS_MAX}.`);
  // No prototype: the model names the keys, and `__proto__` must be a name like any other.
  const out: EventSpecs = Object.create(null);
  for (const [name, value] of entries) {
    if (!EVENT_NAME.test(name)) fail(`The event name "${name}" is not one: a letter, then letters, digits, "_", ".", ":" or "-", at most 40.`);
    const given = value === true || value === null ? {} : value;
    if (typeof given !== "object" || Array.isArray(given)) fail(`The event "${name}" is {"debounceMs"?: number, "wake"?: boolean}.`);
    const { debounceMs, wake } = given as { debounceMs?: unknown; wake?: unknown };
    if (debounceMs !== undefined && (typeof debounceMs !== "number" || !Number.isFinite(debounceMs))) fail(`The event "${name}": debounceMs is a number of milliseconds.`);
    if (wake !== undefined && typeof wake !== "boolean") fail(`The event "${name}": wake is true or false.`);
    out[name] = { ...(debounceMs !== undefined ? { debounceMs: clamp(Math.round(debounceMs as number), DEBOUNCE_MIN_MS, DEBOUNCE_MAX_MS) } : {}), wake: wake === true };
  }
  return { ...out };
}

/** What `wait` asked for: the event, and for how long, held to 5..3600 seconds (600 when not said). */
export function readWait(raw: unknown): { event: string; timeoutSec: number } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) fail('"wait" is {"event": "submit", "timeoutSec"?: 600}.');
  const { event, timeoutSec } = raw as { event?: unknown; timeoutSec?: unknown };
  if (typeof event !== "string" || !EVENT_NAME.test(event)) fail('"wait.event" is the name of the event to wait for, as the card emits it: "submit".');
  if (timeoutSec !== undefined && (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec))) fail('"wait.timeoutSec" is a number of seconds.');
  return { event: event as string, timeoutSec: clamp(Math.round((timeoutSec as number | undefined) ?? WAIT_DEFAULT_SEC), WAIT_MIN_SEC, WAIT_MAX_SEC) };
}

/** Whether a card takes an event of this name: one it declares, or the one its call waits for. */
export const declares = (events: EventSpecs, wait: { event: string } | undefined, name: string): boolean => Object.hasOwn(events, name) || wait?.event === name;

/** The debounce an event of a card is sent with: its own, else the default Settings give. */
export const debounceOf = (events: EventSpecs, name: string, fallback: number): number => clamp(Object.hasOwn(events, name) ? (events[name].debounceMs ?? fallback) : fallback, DEBOUNCE_MIN_MS, DEBOUNCE_MAX_MS);
