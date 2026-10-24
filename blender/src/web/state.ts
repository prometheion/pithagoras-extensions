import { useEffect, useSyncExternalStore } from "react";
import { api, type BlenderState } from "./api";

/**
 * How the Blender server stands, as the server half last said, for every part that shows it: the panel and its button
 * in each chat, and the page in Settings. One store for all of them, asked again every 2 seconds while something is
 * changing (a download, a start) and every 10 seconds otherwise, while any of them is drawn and the page is on screen.
 * An answer that does not come keeps the last one, and says it did not come. Browser keeps its state the same way.
 */

type Known = { state: BlenderState | null; failed: boolean };

let known: Known = { state: null, failed: false };
const listeners = new Set<() => void>();
let asking: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let users = 0;

function set(next: Known): void {
  known = next;
  for (const listener of listeners) listener();
}

/** Nothing known: as the extension is loaded, which the portal does again when its server half comes or goes. */
export function forget(): void {
  known = { state: null, failed: false };
}

/** Asks the server half how Blender stands; one question at a time. */
export function refresh(): Promise<void> {
  asking ??= api
    .state()
    .then(
      (state) => set({ state, failed: false }),
      () => set({ state: known.state, failed: true }),
    )
    .finally(() => {
      asking = null;
    });
  return asking;
}

const changing = (state: BlenderState | null) => !state || state.busy || state.state === "downloading" || state.state === "starting";

/** The next question, while something is drawn that shows the state, and not while the page is hidden. */
function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (!users || document.hidden) return;
  timer = setTimeout(() => void refresh().finally(schedule), changing(known.state) ? 2000 : 10_000);
}

function onVisibility(): void {
  if (!document.hidden) void refresh();
  schedule();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** A hook: how Blender stands, asked again as the first part that uses it is drawn, and followed while any is. */
export function useBlenderState(): Known {
  useEffect(() => {
    if (users++ === 0) document.addEventListener("visibilitychange", onVisibility);
    void refresh().finally(schedule);
    return () => {
      if (--users === 0) {
        document.removeEventListener("visibilitychange", onVisibility);
        schedule();
      }
    };
  }, []);
  return useSyncExternalStore(subscribe, () => known);
}

/** Whether there is a server here at all: its container exists, running or not. */
export const installed = (state: BlenderState | null): boolean => !!state && !["unavailable", "absent", "foreign"].includes(state.state);
