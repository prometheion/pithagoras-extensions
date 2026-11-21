import { useEffect, useSyncExternalStore } from "react";
import type { Snapshot } from "../game/types";
import { api } from "./api";

/**
 * Each chat's game, as the server half last said (`snapshot`, as a page opens the chat and after every change), kept
 * in the module and heard as the module is called (client.tsx), so that a panel drawn later has it.
 */

const chats = new Map<string, Snapshot>();
const listeners = new Set<() => void>();
const asked = new Set<string>();

export function heard(chatId: string, said: unknown): void {
  const m = said as Snapshot | null;
  if (!m || typeof m !== "object" || m.type !== "snapshot") return;
  chats.set(chatId, m);
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** A hook: the chat's game, asked for once where the page was told nothing of it. */
export function useSnapshot(chatId: string): Snapshot | undefined {
  const snap = useSyncExternalStore(subscribe, () => chats.get(chatId));
  useEffect(() => {
    if (chats.has(chatId) || asked.has(chatId)) return;
    asked.add(chatId);
    api.snapshot(chatId).then(
      (s) => {
        if (!chats.has(chatId)) heard(chatId, s);
      },
      () => asked.delete(chatId),
    );
  }, [chatId]);
  return snap;
}

export const snapshotOf = (chatId: string) => chats.get(chatId);
