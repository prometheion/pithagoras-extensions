import { useEffect, useSyncExternalStore } from "react";
import { api, type GodotState } from "./api";

/**
 * How the Godot server stands, as the server half last said, for every part that shows it: the Settings page, the
 * panel beside a chat, and its button. One store, as Browser's: asked every 2 seconds while something is changing
 * (a download, a start), every 10 seconds otherwise, while at least one of them is on screen and the tab is in view,
 * and at once when one asks (after an action). An answer that does not come keeps the last one, and says it did not.
 */

type Known = { state: GodotState | null; failed: boolean };

let known: Known = { state: null, failed: false };
const listeners = new Set<() => void>();
let asking: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function set(next: Known): void {
  known = next;
  for (const listener of listeners) listener();
}

/** Nothing known: as the extension is loaded, again when its server half comes or goes. */
export function forget(): void {
  known = { state: null, failed: false };
}

const changing = (s: GodotState | null) => !s || s.busy || s.state === "downloading" || s.state === "starting";

function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (!listeners.size || document.hidden) return;
  timer = setTimeout(() => void refresh(), changing(known.state) ? 2_000 : 10_000);
}

/** Asks the server half how the server stands; one question at a time. */
export function refresh(): Promise<void> {
  asking ??= api
    .state()
    .then(
      (state) => set({ state, failed: false }),
      () => set({ state: known.state, failed: true }),
    )
    .finally(() => {
      asking = null;
      schedule();
    });
  return asking;
}

document.addEventListener("visibilitychange", () => (document.hidden ? schedule() : void refresh()));

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) void refresh();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) schedule();
  };
};

/** A hook: how the server stands, asked as the first part that shows it is drawn, then kept up to date. */
export function useGodotState(): Known {
  useEffect(() => {
    if (known.state === null) void refresh();
  }, []);
  return useSyncExternalStore(subscribe, () => known);
}

/** Whether there is a server to show: installed, or being installed. */
export const installed = (state: GodotState | null): boolean => !!state && !["unavailable", "absent", "foreign"].includes(state.state);
