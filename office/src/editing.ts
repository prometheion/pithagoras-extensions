/**
 * An agent's write to a document that is open in the editor: the Document Server saves what is typed there first,
 * and the write is made on top of that save.
 *
 * The Document Server keeps what is typed in its editing session and writes it back only when it saves: as the last
 * editor leaves, or when it is asked to (the command service's `forcesave`). An agent's edit made on the file without
 * that would leave the session on an older revision, and its later save could only be kept as a conflict copy. So
 * before an agent writes, `saveOpenSessions` asks the Document Server to save each open session now and waits for the
 * callback of that save (callback.ts persists it as any other, through the revision gate). The write is then made on
 * the revision that save wrote, and the session's key is marked to follow the agent's revision (callback.followTo):
 * every editor of it loads the new revision (office-editor.tsx, with the editor's own refreshFile).
 *
 * Bounded: a session that is not saved within the time given refuses the write (`editor_not_saved`): nothing is
 * written over what is typed there and not saved.
 */
import { randomUUID } from "node:crypto";
import * as callback from "./callback";
import * as live from "./live";

/** How long an agent's write waits for the open editor's save: the Document Server builds the file from its session
 * (a few seconds for a large document) and then calls back. */
export const SAVE_TIMEOUT_MS = 30_000;

/** What saveOpenSessions needs from the outside: the command service, and how long to wait. */
export type SaveDeps = {
  /** One command to the Document Server's command service (callback.command by default). */
  command?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** How long to wait for each session's save, and for a closing session's last one. Default SAVE_TIMEOUT_MS. */
  timeoutMs?: number;
};

/** The refusal of a write whose open editor did not save in time, or could not be asked to. */
function notSaved(title: string, why: string): Error {
  return Object.assign(new Error(`"${title}" is open in the editor, and ${why}, so the edit was not made: nothing was written over what is typed there. Try again in a moment.`), { code: "editor_not_saved" });
}

/**
 * Has the Document Server save each editing session open on the document (`keys`) now, and waits until each is saved:
 * its callback persisted (or kept as a copy). Afterwards everything typed in those sessions until now is on disk.
 * - The command answers 0: the forcesave started; its callback is waited for.
 * - 4: nothing was typed since the session's last save; nothing to wait for.
 * - 1: the Document Server has no session of that key: it closed. Its last save (status 2) may be on its way and is
 *   waited for while the key is still known as open; then the key is let go.
 * Rejects with `editor_not_saved` where the Document Server cannot be asked, answers anything else, reports the save
 * failed, or does not call back in time.
 */
export async function saveOpenSessions(docId: string, title: string, keys: string[], deps: SaveDeps = {}): Promise<void> {
  const ask = deps.command ?? ((body: Record<string, unknown>) => callback.command(body));
  const timeoutMs = deps.timeoutMs ?? SAVE_TIMEOUT_MS;
  for (const key of keys) {
    const userdata = `office-${randomUUID()}`;
    // Waiting before asking: the callback can come before the command's own answer.
    const waiting = callback.awaitForcesave(userdata);
    let answer: Record<string, unknown>;
    try {
      answer = await ask({ c: "forcesave", key, userdata });
    } catch (e) {
      waiting.cancel();
      throw notSaved(title, `the Document Server could not be asked to save it (${e instanceof Error ? e.message : String(e)})`);
    }
    if (answer.error === 4) {
      waiting.cancel();
      continue;
    }
    if (answer.error === 1) {
      waiting.cancel();
      await sessionEnded(docId, key, timeoutMs);
      continue;
    }
    if (answer.error !== 0) {
      waiting.cancel();
      throw notSaved(title, `the Document Server refused to save it (error ${String(answer.error)})`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ok = await Promise.race([waiting.done, new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs)))]);
    clearTimeout(timer);
    if (ok === "timeout") {
      waiting.cancel();
      throw notSaved(title, `the Document Server did not save what is typed there within ${timeoutMs / 1000} s`);
    }
    if (!ok) throw notSaved(title, "the Document Server could not save what is typed there");
  }
}

/** A session the Document Server no longer knows: its last save (status 2, a few seconds after the last editor left)
 * ends it here (live.endSession). Waited for up to `timeoutMs`; a key that is still not ended then is let go: the
 * Document Server knows of no session to save. */
async function sessionEnded(docId: string, key: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (live.sessionKeys(docId).includes(key) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 200));
  if (live.sessionKeys(docId).includes(key)) live.setSession(docId, key, []);
}
