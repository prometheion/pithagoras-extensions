import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CARDS_PER_CHAT, type EventSpecs } from "../limits";

/**
 * Each chat's cards, kept in the extension's own folder (`portal.dataDir()`, the portal's alone: an agent cannot change
 * a card's HTML behind the person's back, nor what it already sent), so that a card is the same on every page open on
 * the chat and after a reload, and outlives the chat's pi and the portal. A chat's folder holds `index.json` (its cards
 * as the pages list them, the next card's number, and the events that wait for its next turn) and a file for each
 * card's HTML and the data last posted to it, which only the frame route reads. A deleted chat's folder goes with it.
 */

export interface CardRecord {
  /** Short and the chat's own: c1, c2… The model names a card by it. */
  id: string;
  /** The ui_show call that made it: the conversation draws the card where that call is. */
  callId: string;
  title: string;
  events: EventSpecs;
  wait?: { event: string; timeoutSec: number };
  status: "open" | "closed";
  closedBy?: "agent" | "person";
  /** Raised each time its HTML is replaced: the pages draw it again. */
  rev: number;
  /** The number of the data last posted to it; 0 for none. */
  dataSeq: number;
  createdAt: number;
  updatedAt: number;
}

/** A card as the pages are told of it: everything but its HTML and its data, which the frame route serves. */
export type CardSummary = Omit<CardRecord, "wait" | "createdAt" | "updatedAt"> & { wait?: { event: string } };

export const summary = (card: CardRecord): CardSummary => {
  const { wait, createdAt: _c, updatedAt: _u, ...rest } = card;
  return { ...rest, ...(wait ? { wait: { event: wait.event } } : {}) };
};

/** An event of a card waiting to reach the agent: the latest data of its name, and how many came. */
export interface Entry {
  card: string;
  title: string;
  /** The event's name, or for `kind: "closed"`, "closed". */
  event: string;
  data: unknown;
  count: number;
  wake: boolean;
  at: number;
  kind: "event" | "closed";
}

interface ChatIndex {
  chat: string;
  next: number;
  cards: CardRecord[];
  outbox: Entry[];
}

export interface CardBody {
  html: string;
  /** What ui_update last posted, there while the card's `dataSeq` is not 0. */
  data?: unknown;
}

/** A file put in place whole, for the portal alone. */
function writeWhole(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export class CardStore {
  private readonly chats = new Map<string, ChatIndex>();

  constructor(private readonly dir: string) {}

  /** A chat's folder, by a hash of its id: an id is the portal's, and is not made to be a file's name. */
  private folder(chatId: string): string {
    return path.join(this.dir, "chats", createHash("sha256").update(chatId).digest("hex").slice(0, 32));
  }

  private bodyFile(chatId: string, cardId: string): string {
    return path.join(this.folder(chatId), `${cardId}.json`);
  }

  private index(chatId: string): ChatIndex {
    let index = this.chats.get(chatId);
    if (!index) {
      const kept = readJson<ChatIndex>(path.join(this.folder(chatId), "index.json"));
      index = kept && kept.chat === chatId && Array.isArray(kept.cards) ? { ...kept, outbox: Array.isArray(kept.outbox) ? kept.outbox : [] } : { chat: chatId, next: 1, cards: [], outbox: [] };
      this.chats.set(chatId, index);
    }
    return index;
  }

  private save(index: ChatIndex): void {
    mkdirSync(this.folder(index.chat), { recursive: true, mode: 0o700 });
    writeWhole(path.join(this.folder(index.chat), "index.json"), index);
  }

  cards(chatId: string): CardRecord[] {
    return this.index(chatId).cards;
  }

  card(chatId: string, id: string): CardRecord | undefined {
    return this.index(chatId).cards.find((c) => c.id === id);
  }

  body(chatId: string, id: string): CardBody | undefined {
    return this.card(chatId, id) ? readJson<CardBody>(this.bodyFile(chatId, id)) : undefined;
  }

  create(chatId: string, given: { callId: string; title: string; html: string; events: EventSpecs; wait?: { event: string; timeoutSec: number } }, now = Date.now()): CardRecord {
    const index = this.index(chatId);
    const card: CardRecord = { id: `c${index.next++}`, callId: given.callId, title: given.title, events: given.events, ...(given.wait ? { wait: given.wait } : {}), status: "open", rev: 1, dataSeq: 0, createdAt: now, updatedAt: now };
    mkdirSync(this.folder(chatId), { recursive: true, mode: 0o700 });
    writeWhole(this.bodyFile(chatId, card.id), { html: given.html } satisfies CardBody);
    index.cards.push(card);
    // The oldest go once there are too many: the pages say such a card is no longer kept.
    for (const gone of index.cards.splice(0, Math.max(0, index.cards.length - CARDS_PER_CHAT))) rmSync(this.bodyFile(chatId, gone.id), { force: true });
    this.save(index);
    return card;
  }

  /**
   * Replaces a card's HTML, posts data to it, or both, in one write. New HTML is a new card for what was posted before:
   * the data goes with the old HTML, unless data comes with it.
   */
  update(chatId: string, id: string, change: { html?: string; data?: { value: unknown } }, now = Date.now()): CardRecord {
    const index = this.index(chatId);
    const card = index.cards.find((c) => c.id === id);
    if (!card) throw new Error(`No card ${id} in this chat`);
    const body = readJson<CardBody>(this.bodyFile(chatId, id)) ?? { html: "" };
    if (change.html !== undefined) {
      body.html = change.html;
      delete body.data;
      card.rev++;
    }
    if (change.data) {
      body.data = change.data.value;
      card.dataSeq++;
    }
    card.updatedAt = now;
    writeWhole(this.bodyFile(chatId, id), body);
    this.save(index);
    return card;
  }

  close(chatId: string, id: string, by: "agent" | "person", now = Date.now()): CardRecord | undefined {
    const index = this.index(chatId);
    const card = index.cards.find((c) => c.id === id);
    if (!card || card.status === "closed") return card;
    card.status = "closed";
    card.closedBy = by;
    card.updatedAt = now;
    this.save(index);
    return card;
  }

  outbox(chatId: string): Entry[] {
    return this.index(chatId).outbox;
  }

  setOutbox(chatId: string, entries: Entry[]): void {
    const index = this.index(chatId);
    index.outbox = entries;
    this.save(index);
  }

  /** A chat that was deleted: its folder and all in it. */
  forget(chatId: string): void {
    this.chats.delete(chatId);
    rmSync(this.folder(chatId), { recursive: true, force: true });
  }
}
