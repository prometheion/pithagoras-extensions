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
 * every editor of it loads the new revision (office-editor.tsx, with the editor's own refreshFile, once the editor has
 * sent what is typed there).
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

/** How often a wait looks again whether a session closed. */
const POLL_MS = 100;

/**
 * Has the Document Server save each editing session open on the document (`keys`) now, and waits until each is saved:
 * its callback persisted (or kept as a copy). Afterwards everything typed in those sessions until now is on disk.
 * First a forcesave asked before and not landed yet (a wait that timed out, a persist the Document Server sends again)
 * is waited for: while it is under way the command answers 4 though what it holds is not on disk. Then the command:
 * - 0: the forcesave started; its callback is waited for. A session that is closing calls back with its close
 *   instead (status 2, a few seconds after the last editor left), which saves everything it held as well.
 * - 4: nothing was typed since the session's last save; nothing to wait for.
 * - 3: the Document Server cannot save it now, as while the session closes: its close is waited for.
 * - 1: the Document Server has no session of that key. Its close's save that could not be handed over is kept as
 *   forgotten there, and is taken back now (callback.takeForgotten); one still on its way is waited for while the key
 *   is known as open. Then the key is let go: the Document Server holds nothing of it to save.
 * Rejects with `editor_not_saved` where the Document Server cannot be asked, answers anything else, reports the save
 * failed, or does not save in time.
 */
export async function saveOpenSessions(docId: string, title: string, keys: string[], deps: SaveDeps = {}): Promise<void> {
  const ask = deps.command ?? ((body: Record<string, unknown>) => callback.command(body));
  const timeoutMs = deps.timeoutMs ?? SAVE_TIMEOUT_MS;
  for (const key of keys) {
    const until = Date.now() + timeoutMs;
    if (!(await earlierSaved(key, until))) throw notSaved(title, `a save it was asked for before has not landed within ${timeoutMs / 1000} s`);
    const userdata = `office-${randomUUID()}`;
    // Waiting before asking: the callback can come before the command's own answer.
    const waiting = callback.awaitForcesave(userdata, key);
    let answer: Record<string, unknown>;
    try {
      answer = await ask({ c: "forcesave", key, userdata });
    } catch (e) {
      waiting.forget();
      throw notSaved(title, `the Document Server could not be asked to save it (${e instanceof Error ? e.message : String(e)})`);
    }
    if (answer.error === 4) {
      waiting.forget();
      continue;
    }
    if (answer.error === 3) {
      waiting.forget();
      if (!(await closed(key, until))) throw notSaved(title, `the Document Server could not save it now (error 3), and it did not close within ${timeoutMs / 1000} s`);
      continue;
    }
    if (answer.error === 1) {
      waiting.forget();
      await sessionGone(docId, key, until, title);
      continue;
    }
    if (answer.error !== 0) {
      waiting.forget();
      throw notSaved(title, `the Document Server refused to save it (error ${String(answer.error)})`);
    }
    const closing = watchClosed(key, until);
    const ok = await Promise.race([waiting.done, closing.done.then((gone) => (gone ? true : ("timeout" as const)))]);
    closing.stop();
    waiting.cancel();
    if (ok === "timeout") throw notSaved(title, `the Document Server did not save what is typed there within ${timeoutMs / 1000} s`);
    if (!ok) throw notSaved(title, "the Document Server could not save what is typed there");
  }
}

/** Every forcesave of `key` asked before and not landed yet has landed by `until`: true, or false where one did not. A
 * persist that failed is sent again by the Document Server, so its wait goes on. */
async function earlierSaved(key: string, until: number): Promise<boolean> {
  for (let left = callback.unsavedOf(key); left.length; left = callback.unsavedOf(key)) {
    const waiting = callback.awaitForcesave(left[0], key);
    const closing = watchClosed(key, until);
    const settled = await Promise.race([waiting.done.then(() => true), closing.done]);
    closing.stop();
    waiting.cancel();
    if (!settled && Date.now() >= until) return false;
  }
  return true;
}

/** Whether `key`'s session closed (its close saved, callback.sessionClosed) by `until`, looked at every POLL_MS: true
 * once it did, false at `until` or once stopped (whoever waits got their answer elsewhere). */
function watchClosed(key: string, until: number): { done: Promise<boolean>; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: () => void;
  const done = new Promise<boolean>((resolve) => {
    const look = () => {
      if (callback.sessionClosed(key)) return resolve(true);
      if (Date.now() >= until) return resolve(false);
      timer = setTimeout(look, POLL_MS);
    };
    stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    look();
  });
  return { done, stop };
}

const closed = (key: string, until: number): Promise<boolean> => watchClosed(key, until).done;

/** A session the Document Server no longer knows. A close whose save failed here is kept as forgotten there, and is
 * taken back now; a close on its way ends the session here (live.endSession) and is waited for up to `until`, and
 * looked for once more among the forgotten saves; a key that is still not ended then is let go: the Document Server
 * holds nothing of it to save. Rejects where the forgotten saves cannot be listed, or the one there cannot be taken. */
async function sessionGone(docId: string, key: string, until: number, title: string): Promise<void> {
  const open = () => live.sessionKeys(docId).includes(key) && !callback.sessionClosed(key);
  const take = async () => {
    try {
      return await callback.takeForgotten(docId, key);
    } catch (e) {
      throw notSaved(title, `its last save is kept by the Document Server and could not be taken back (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  if (!open() || (await take()) === "taken") return;
  while (open() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  if (!open() || (await take()) === "taken") return;
  live.setSession(docId, key, []);
}
