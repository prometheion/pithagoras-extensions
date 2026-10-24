import { useSyncExternalStore } from "react";
import type { CardSummary, UiSettings } from "./api";

/**
 * Each chat's cards, as the server half last said (`index` as a page opens the chat, then `card` for each change), and
 * the data the agent posts to them (`data`), for every card drawn in the page to read. Kept in the module, heard as
 * the module is called (client.tsx): what the server half says before a card is drawn is not missed.
 */

const chats = new Map<string, Map<string, CardSummary>>();
const listeners = new Set<() => void>();
const dataListeners = new Set<(chatId: string, cardId: string, seq: number, value: unknown) => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

export function heard(chatId: string, said: unknown): void {
  const m = said as { type?: unknown; cards?: unknown; card?: unknown; seq?: unknown; value?: unknown } | null;
  if (!m || typeof m !== "object") return;
  if (m.type === "index" && Array.isArray(m.cards)) {
    chats.set(chatId, new Map((m.cards as CardSummary[]).map((c) => [c.id, c])));
    changed();
  } else if (m.type === "card" && m.card && typeof m.card === "object") {
    const card = m.card as CardSummary;
    const cards = chats.get(chatId) ?? new Map<string, CardSummary>();
    cards.set(card.id, card);
    chats.set(chatId, cards);
    changed();
  } else if (m.type === "data" && typeof m.card === "string" && typeof m.seq === "number") {
    for (const listener of dataListeners) listener(chatId, m.card, m.seq, m.value);
  }
}

/** What the server half said of a chat's cards, as it said it (a page that missed it asks: `api.cards`). */
export function know(chatId: string, cards: CardSummary[]): void {
  heard(chatId, { type: "index", cards });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** A hook: the card a ui_show call made, by the call's id, or by its own id where the call's result says it. */
export function useCard(chatId: string, callId: string | undefined, cardId: string | undefined): CardSummary | undefined {
  return useSyncExternalStore(subscribe, () => {
    const cards = chats.get(chatId);
    if (!cards) return undefined;
    if (cardId && cards.has(cardId)) return cards.get(cardId);
    for (const card of cards.values()) if (callId && card.callId === callId) return card;
    return undefined;
  });
}

/** Whether the page has been told anything of the chat's cards. */
export const knows = (chatId: string): boolean => chats.has(chatId);

export function onData(chatId: string, cardId: string, fn: (seq: number, value: unknown) => void): () => void {
  const listener = (c: string, card: string, seq: number, value: unknown) => {
    if (c === chatId && card === cardId) fn(seq, value);
  };
  dataListeners.add(listener);
  return () => void dataListeners.delete(listener);
}

// Settings, as last read or saved in this page: the cards draw with them.
let settings: UiSettings | null = null;
const settingsListeners = new Set<() => void>();
export function setSettings(next: UiSettings): void {
  settings = next;
  for (const listener of settingsListeners) listener();
}
export function useSettings(): UiSettings | null {
  return useSyncExternalStore(
    (l) => {
      settingsListeners.add(l);
      return () => void settingsListeners.delete(l);
    },
    () => settings,
  );
}
export const currentSettings = () => settings;
