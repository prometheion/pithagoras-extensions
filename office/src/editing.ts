/**
 * The save after an agent's edit: the agent edits the document through its own editor (seat.ts), in the editing
 * session the people are in, and the Document Server keeps what that session holds until it saves. So after an edit
 * the Document Server is asked to save the session now (its command service's forcesave), and the edit waits for that
 * save's callback, which callback.ts persists as any save of the editor, through the revision gate: the edit, and what
 * people typed until then, are on disk once it answers.
 */
import { randomUUID } from "node:crypto";
import * as callback from "./callback";

/** How long the save after an edit waits for its callback: the Document Server builds the file from its session (a few
 * seconds for a large document) and then calls back. */
export const SAVE_TIMEOUT_MS = 30_000;

/** What saveNow needs from the outside: the command service, and how long to wait. */
export type SaveDeps = {
  /** One command to the Document Server's command service (callback.command by default). */
  command?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** How long to wait for the save's callback. Default SAVE_TIMEOUT_MS. */
  timeoutMs?: number;
};

/** How long a save after an agent's edit asks again while the Document Server says there is nothing to save: the
 * agent's editor sends its edit a moment after it made it (the command sends it at once, `Api.Save`, so this is a
 * belt). */
const SENT_WITHIN_MS = 3_000;

/** How a save after an agent's edit came out (callback.ForcesaveOutcome), or: nothing to save ("nothing"), no callback
 * within the time given ("timeout"), the Document Server could not be asked or refused ("failed"). */
export type SaveAfterEdit = callback.ForcesaveOutcome | "nothing" | "timeout";

/**
 * Has the Document Server save the editing session of `key` now (its command service's forcesave) and waits for that
 * save's callback, which callback.ts persists through the revision gate: after an agent's edit, the edit and whatever
 * people typed until then are on disk once this answers "saved".
 */
export async function saveNow(key: string, deps: SaveDeps = {}): Promise<SaveAfterEdit> {
  const ask = deps.command ?? ((body: Record<string, unknown>) => callback.command(body));
  const timeoutMs = deps.timeoutMs ?? SAVE_TIMEOUT_MS;
  const sentBy = Date.now() + SENT_WITHIN_MS;
  for (;;) {
    const userdata = `office-${randomUUID()}`;
    // Waited for before it is asked: the callback can come before the command's own answer.
    const waiting = callback.awaitForcesave(userdata);
    let answer: Record<string, unknown>;
    try {
      answer = await ask({ c: "forcesave", key, userdata });
    } catch {
      waiting.forget();
      return "failed";
    }
    if (answer.error === 4) {
      waiting.forget();
      if (Date.now() >= sentBy) return "nothing";
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (answer.error !== 0) {
      waiting.forget();
      return "failed";
    }
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([waiting.done, new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs)))]);
    clearTimeout(timer);
    // Still under way: a later save of the session holds it, and its callback is persisted when it comes.
    if (outcome === "timeout") waiting.cancel();
    return outcome;
  }
}
