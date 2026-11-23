import type { PuzzleAnswer } from "../game/puzzles";
import type { Answer, Combat, CombatAction, Outcome, Snapshot } from "../game/types";
import { portal } from "../portal";

/** The server half's routes (server/routes.ts). */
const call = <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);
const chat = (chatId: string) => `/chats/${encodeURIComponent(chatId)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  snapshot: (chatId: string) => call<Snapshot>(chat(chatId)),
  hero: (chatId: string, hero: Record<string, unknown>) => call<Snapshot>(`${chat(chatId)}/hero`, post(hero)),
  answer: (chatId: string, id: string, answer: Answer) => call<{ outcome: Outcome }>(`${chat(chatId)}/scene/${encodeURIComponent(id)}`, post({ answer })),
  puzzle: (chatId: string, id: string, answer: PuzzleAnswer) => call<{ outcome: Outcome }>(`${chat(chatId)}/puzzle/${encodeURIComponent(id)}`, post({ answer })),
  act: (chatId: string, id: string, action: CombatAction) => call<{ combat: Combat }>(`${chat(chatId)}/combat/${encodeURIComponent(id)}`, post({ action })),
  endCombat: (chatId: string, id: string) => call<{ outcome: Outcome }>(`${chat(chatId)}/combat/${encodeURIComponent(id)}/end`, { method: "POST" }),
  picture: (chatId: string, path: string) => `${portal.api.url(`${chat(chatId)}/picture`)}?${new URLSearchParams({ path })}`,
};
