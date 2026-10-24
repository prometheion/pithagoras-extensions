import type { EventSpecs } from "../limits";
import { portal } from "../portal";
import type { Delivered } from "./host";

/** A card as the server half tells the pages of it (server/store.ts `summary`). */
export interface CardSummary {
  id: string;
  callId: string;
  title: string;
  events: EventSpecs;
  wait?: { event: string };
  status: "open" | "closed";
  closedBy?: "agent" | "person";
  rev: number;
  dataSeq: number;
}

export interface UiSettings {
  defaultDebounceMs: number;
  maxHeight: number;
  allowWake: boolean;
}

/** A JSON route of the server half. */
const call = <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);
const at = (chatId: string, cardId: string) => `/chats/${encodeURIComponent(chatId)}/cards/${encodeURIComponent(cardId)}`;

export const api = {
  cards: (chatId: string) => call<{ cards: CardSummary[] }>(`/chats/${encodeURIComponent(chatId)}/cards`),
  event: (chatId: string, cardId: string, event: string, data: unknown) =>
    call<{ delivery: Delivered }>(`${at(chatId, cardId)}/events`, { method: "POST", body: JSON.stringify({ event, data }) }).then((r) => r.delivery),
  close: (chatId: string, cardId: string) => call<{ card: CardSummary }>(`${at(chatId, cardId)}/close`, { method: "POST" }),
  settings: () => call<UiSettings>("/settings"),
  saveSettings: (patch: Partial<UiSettings>) => call<UiSettings>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
  /** The frame a card is drawn in, for one load of it: its nonce, the page's origin and language, and the theme now. */
  frameUrl: (chatId: string, cardId: string, rev: number, nonce: string, theme: unknown, lang: string) =>
    `${portal.api.url(`/frame/${encodeURIComponent(chatId)}/${encodeURIComponent(cardId)}`)}?${new URLSearchParams({ rev: String(rev), n: nonce, o: location.origin, lang, theme: JSON.stringify(theme) })}`,
};
