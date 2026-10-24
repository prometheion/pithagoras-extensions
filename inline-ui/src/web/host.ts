import { debounce, type Debounced } from "../debounce";
import { EVENT_DATA_MAX, debounceOf, declares, maxWaitFor, utf8Length, type EventSpecs } from "../limits";
import type { Theme } from "../theme";

/**
 * A card's frame in the page, and everything between it and the server half: what it is told (the theme as it
 * changes, the data the agent posts), what it says (its height, and the events its script emits), and the debounce
 * each event goes through before it is sent. No React here: the card in the conversation (Card.tsx) draws one, and the
 * browser tests drive one by itself.
 *
 * A message is taken only from the card's own window (the frame inside the extension's frame, see the server's
 * frame.ts), from no origin (the sandbox gives the card none), and with the nonce this load of the card was given: so
 * nothing another frame, another card or an earlier load of this one posts is read. What the card emits is held to
 * the events it declares and to the size an event may have, is debounced by its name (trailing, with a ceiling, so
 * input that never pauses still reports), and is sent only once the person has been in the card: a card's script
 * cannot speak for a person who never touched it.
 */

export type Delivered = "wait" | "steer" | "wake" | "queued";
export type Status = { kind: "sent"; delivery: Delivered } | { kind: "dropped"; reason: "large" | "rate" | "closed" | "failed" };

export interface HostConfig {
  events: EventSpecs;
  wait?: { event: string };
  /** The debounce of an event its card gives none: Settings'. */
  defaultDebounceMs: number;
  /** How tall it is drawn before it scrolls inside: Infinity, expanded. */
  maxHeight: number;
  /** On the whole screen: the frame fills its box, whatever its height. */
  fill: boolean;
  /** A closed card is drawn, and takes no input and sends nothing. */
  open: boolean;
}

export interface HostOptions extends HostConfig {
  title: string;
  /** The frame's address for one load of it, with that load's nonce. */
  src(nonce: string): string;
  /** The page's theme now. */
  theme(): Theme;
  /** Sends an event to the server half; rejects with the answer's `status` where it was refused. */
  send(event: string, data: unknown): Promise<Delivered>;
  onStatus?(status: Status): void;
  /** The card said how tall it is. */
  onHeight?(px: number): void;
}

/** How tall a card is drawn until it says, and the least it is drawn. */
export const FIRST_HEIGHT = 120;
export const LEAST_HEIGHT = 32;

const hosts = new Set<CardHost>();
let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (event) => {
    for (const host of hosts) {
      if (host.owns(event)) return host.receive(event.data);
    }
  });
}

function nonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class CardHost {
  readonly frame: HTMLIFrameElement;
  private config: HostConfig;
  private nonce = "";
  private ready = false;
  private engaged = false;
  private height = 0;
  private latest: { seq: number; value: unknown } | undefined;
  private readonly debounced = new Map<string, { ms: number; d: Debounced<unknown> }>();
  private readonly onBlur = () => {
    // Focus went into a frame: is it this one? Asked once the page has moved it.
    setTimeout(() => {
      if (document.activeElement === this.frame) this.engaged = true;
    }, 0);
  };
  private readonly onFocus = () => {
    this.engaged = true;
  };

  constructor(
    container: HTMLElement,
    private readonly options: HostOptions,
  ) {
    const { events, wait, defaultDebounceMs, maxHeight, fill, open } = options;
    this.config = { events, wait, defaultDebounceMs, maxHeight, fill, open };
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", options.title);
    frame.className = "iui-frame";
    frame.addEventListener("focus", this.onFocus);
    this.frame = frame;
    container.append(frame);
    hosts.add(this);
    listen();
    window.addEventListener("blur", this.onBlur);
    this.load();
  }

  /** Loads the card again, as it is now: a new nonce, and the person has to be in it again before it sends. */
  load(): void {
    for (const { d } of this.debounced.values()) d.flush();
    this.debounced.clear();
    this.nonce = nonce();
    this.ready = false;
    this.engaged = false;
    this.frame.inert = !this.config.open;
    this.frame.src = this.options.src(this.nonce);
    this.applyHeight();
  }

  configure(change: Partial<HostConfig>): void {
    this.config = { ...this.config, ...change };
    this.frame.inert = !this.config.open;
    if (!this.config.open) for (const { d } of this.debounced.values()) d.cancel();
    this.applyHeight();
  }

  setTheme(theme: Theme): void {
    if (this.ready) this.post({ type: "theme", theme });
  }

  /** What the agent posted (ui_update): to the card now, and again to a load of it that comes after. */
  postData(seq: number, value: unknown): void {
    if (this.latest && seq <= this.latest.seq) return;
    this.latest = { seq, value };
    if (this.ready) this.post({ type: "data", seq, value });
  }

  /** The card's own window, inside the extension's frame. */
  private inner(): Window | undefined {
    const outer = this.frame.contentWindow;
    return outer ? (outer[0] as Window | undefined) : undefined;
  }

  owns(event: MessageEvent): boolean {
    const data = event.data as { pithagoras?: unknown; nonce?: unknown } | null;
    return event.origin === "null" && !!event.source && event.source === this.inner() && !!data && data.pithagoras === 1 && data.nonce === this.nonce;
  }

  receive(message: { type?: unknown; height?: unknown; name?: unknown; json?: unknown }): void {
    if (message.type === "ready") {
      this.ready = true;
      this.post({ type: "theme", theme: this.options.theme() });
      if (this.latest) this.post({ type: "data", seq: this.latest.seq, value: this.latest.value });
    } else if (message.type === "size" && typeof message.height === "number" && Number.isFinite(message.height)) {
      this.height = Math.max(0, Math.ceil(message.height));
      this.applyHeight();
      this.options.onHeight?.(this.height);
    } else if (message.type === "emit" && typeof message.name === "string" && typeof message.json === "string") {
      this.emitted(message.name, message.json);
    }
  }

  private emitted(name: string, json: string): void {
    if (!this.config.open || !declares(this.config.events, this.config.wait, name)) return;
    if (utf8Length(json) > EVENT_DATA_MAX) return this.options.onStatus?.({ kind: "dropped", reason: "large" });
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return;
    }
    const ms = debounceOf(this.config.events, name, this.config.defaultDebounceMs);
    let held = this.debounced.get(name);
    if (held && held.ms !== ms) {
      held.d.flush();
      held = undefined;
    }
    if (!held) {
      held = { ms, d: debounce((v) => this.deliver(name, v), ms, maxWaitFor(ms)) };
      this.debounced.set(name, held);
    }
    held.d.push(value);
  }

  private deliver(name: string, value: unknown): void {
    if (!this.config.open) return;
    // Only from a card the person has been in since it loaded, or is in now.
    if (!this.engaged && document.activeElement !== this.frame) return;
    this.options.send(name, value).then(
      (delivery) => this.options.onStatus?.({ kind: "sent", delivery }),
      (e: { status?: number }) => this.options.onStatus?.({ kind: "dropped", reason: e?.status === 409 ? "closed" : e?.status === 429 ? "rate" : e?.status === 413 ? "large" : "failed" }),
    );
  }

  private post(message: Record<string, unknown>): void {
    try {
      this.inner()?.postMessage({ ...message, pithagoras: 1, nonce: this.nonce }, "*");
    } catch {
      // The card is gone, or not there yet: it asks again when it is ready.
    }
  }

  private applyHeight(): void {
    if (this.config.fill) {
      this.frame.style.height = "100%";
      return;
    }
    const wanted = this.height || FIRST_HEIGHT;
    this.frame.style.height = `${Math.max(LEAST_HEIGHT, Math.min(wanted, this.config.maxHeight))}px`;
  }

  destroy(): void {
    // What the person did and was not sent yet goes now, as the card leaves the page.
    for (const { d } of this.debounced.values()) d.flush();
    this.debounced.clear();
    hosts.delete(this);
    window.removeEventListener("blur", this.onBlur);
    this.frame.removeEventListener("focus", this.onFocus);
    this.frame.remove();
  }
}
