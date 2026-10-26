import { useEffect, useState, useSyncExternalStore } from "react";
import { api, type OfficeState } from "./api";

/**
 * How the office stands, as the server half last said -- shared by the library page, the per-home chat panels,
 * the tool cards and the editor badges. One question at a time, one poll while any of them is on screen:
 * GET /state every 5 s, asked again straight after whatever changed it.
 */

let known: OfficeState | null = null;
const listeners = new Set<() => void>();
let watchers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let inflight: Promise<void> | null = null;
/** How many times GET /state was asked, and which of those questions `known` answers. */
let asked = 0;
let answered = 0;

function publish(state: OfficeState, question: number): void {
  known = state;
  answered = question;
  for (const listener of listeners) listener();
}

/** Ask again now (after a create/rename/delete/settings change), and only once at a time. */
export function refreshOfficeState(): Promise<void> {
  inflight ??= (() => {
    const question = ++asked;
    return api.state().then((state) => publish(state, question), () => {}).finally(() => void (inflight = null));
  })();
  return inflight;
}

/** Ask again with a question sent from now on: one under way may have been sent before what the caller knows of. */
function askAfresh(): void {
  void (inflight ?? Promise.resolve()).then(refreshOfficeState);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** A hook: the newest answer of GET /state. Starts the shared 5 s poll while a first user mounts, ends it when the last goes. */
export function useOfficeState(): OfficeState | null {
  useEffect(() => {
    watchers += 1;
    if (watchers === 1) {
      void refreshOfficeState();
      timer = setInterval(() => void refreshOfficeState(), 5000);
    }
    return () => {
      watchers -= 1;
      if (watchers === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);
  return useSyncExternalStore(subscribe, () => known);
}

/**
 * Whether `docId` has left the library, by an answer of GET /state asked after the document was opened: the shared
 * answer can be up to 5 s old, older than a document an agent made a moment ago, which it would call gone. Until a
 * newer answer comes, false (the editor asks for the document itself and says what it finds).
 */
export function useDocGone(docId: string | null): boolean {
  const state = useOfficeState();
  // The first question that counts for this document: the next one sent.
  const [since, setSince] = useState({ docId, question: asked + 1 });
  let first = since.question;
  if (since.docId !== docId) {
    first = asked + 1;
    setSince({ docId, question: first });
  }
  useEffect(() => {
    if (docId !== null) askAfresh();
  }, [docId]);
  return docId !== null && state !== null && answered >= first && !state.docs.some((d) => d.docId === docId);
}
