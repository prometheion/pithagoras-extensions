/**
 * In-memory co-editing registry, shared by src/callback.ts (DS status-1 presence + the lock commands of the
 * callback state machine), src/server.ts (the /state poller and editor-config minting) and docchat.ts (who is in a session).
 *
 * Deliberately dependency-free -- no fs, no node:fs, no portal(), no store import: pure process memory keyed by
 * docId, so every module (and every unit test) can import it anywhere without a started server half or a data
 * dir. The ONE piece of external knowledge pollState needs (the document's current mtimeMs revision) is injected
 * through setMetaResolver: server.ts registers `docId -> store.getDoc(docId)?.mtimeMs ?? null` once at boot, and
 * until then (or in tests without a resolver) pendingRev stays null. pollState keeps its two
 * arguments for that reason -- the resolver lives at module scope instead of becoming a third parameter.
 *
 * State is process-local by design: after a portal restart nobody is known to be editing until the DS session's
 * next status-1 callback or the next editor-config mint calls setUser again, which is the correct reading of
 * "closed with no changes" for a fresh process.
 *
 * Lock model: an EXPLICIT flag carries the command-based entries -- status 2 "unlock after
 * persist", status 4 "unlock", status 6 "keep locked" -- while status 1 says "set users[] from the body
 * (locked while users.length > 0)", so presence itself also counts as a lock: someone who opened the editor (a
 * server-minted setUser before any callback, or a DS connect we are about to hear about) keeps the doc locked
 * until they leave. pollState therefore reports `locked` when EITHER holds; unlocking never hides a user that is
 * still tracked as present. Conservative on purpose: a false "still editing" badge beats a false "free to edit".
 * TERMINAL CLOSES are authoritative though: status 2 (ready for saving) and status 4 (closed with no changes)
 * mean nobody is connected anymore, so callback.ts clears presence AND the flag there (clearDoc) instead of
 * only flipping the flag -- otherwise a server-minted user without a DS leave event would badge forever.
 *
 * On top of that, tracked PRESENCE carries a TTL (DEFAULT_PRESENCE_TTL_MS = 15 min, setPresenceTtl to change):
 * presence is minted at editor-config time for a single shared seat and only cleared on terminal closes, so
 * an abandoned open (api.js never loads, tab closed before DS connects) would otherwise hold the doc locked for
 * DS and badge "still editing" -- forever. Stale entries are dropped lazily on read (usersOf/pollState). Once the
 * Document Server confirms a user (its status-1 callback names them), that presence no longer expires: it sends
 * status 1 only as somebody connects or leaves, never as a heartbeat. This adds expiry only -- it does NOT change
 * lock/badge semantics: a non-expired open session still locks the doc for DS (the status rules above) and is
 * reported to polling clients by pollState.
 */

export type LiveUser = { id: string; name?: string; at: number };

/** A tracked entry plus its expiry (internal: usersOf returns LiveUser copies without it).
 * The TTL closes the stuck-lock problem: presence is minted at editor-config time (a single shared seat,
 * EDITOR_USER id "portal-user") and only cleared unconditionally on a terminal DS close -- so a failed or
 * abandoned open (api.js never loads, tab closed before DS connects) left the doc locked FOREVER. With a TTL
 * such a stuck entry auto-expires; one the Document Server confirmed stays until it leaves.
 * 15 minutes matches CONFIG_TTL_MS (server.ts): an editor config outlives a single page-load, and the badge is
 * already best-effort (the /state poller refreshes it every 5 s from this same map). */
const DEFAULT_PRESENCE_TTL_MS = 15 * 60_000;
/** `confirmed`: the Document Server said the user is connected (a status-1 callback). Such presence does not expire:
 * the Document Server sends a status 1 only as somebody connects or leaves, never as a heartbeat, so a person editing
 * for longer than the TTL would otherwise drop out while the editor is open. It ends at a leave, or at a status 2 or 4. */
type PresenceRecord = LiveUser & { expiresAt: number; confirmed?: boolean };

let presenceTtlMs = DEFAULT_PRESENCE_TTL_MS;

/** Change the presence TTL (default DEFAULT_PRESENCE_TTL_MS). Affects joins from now on; already-tracked users
 * keep their existing expiry until their next heartbeat re-sets them. Tests use it to exercise expiry fast.
 * Non-finite or non-positive values are ignored rather than stored (0 would expire everything immediately). */
export function setPresenceTtl(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) presenceTtlMs = ms;
}

/** The configured presence TTL in milliseconds. */
export function getPresenceTtl(): number {
  return presenceTtlMs;
}

function isStale(u: PresenceRecord, now: number): boolean {
  return !u.confirmed && u.expiresAt <= now; // inclusive: exactly-at-expiry counts as gone (clocks only ever move forward here)
}

/** docId -> userId -> PresenceRecord. Maps (not arrays) so a re-join of the same user never duplicates. */
const presence = new Map<string, Map<string, PresenceRecord>>();
/** docId -> document.key -> the ids of the users the Document Server says are in the editing session of that key (its
 * status-1 callbacks). A document has more than one for a moment when an editor loads a newer revision: the editor is
 * in the new key's session at once, and the old key's closes a few seconds later. */
const sessions = new Map<string, Map<string, Set<string>>>();
/** docIds explicitly locked by a callback command (statuses 1/2/4/6). */
const locked = new Set<string>();
/** Injected source of "the document's current mtimeMs revision"; null until server.ts registers one. */
let resolveMeta: ((docId: string) => number | null) | null = null;

function userMap(docId: string): Map<string, PresenceRecord> {
  let users = presence.get(docId);
  if (!users) {
    users = new Map();
    presence.set(docId, users);
  }
  return users;
}

/** The id an agent's editor goes by in a document (server.ts mints it, `agent:<keyIdOf(home)>`): the Document Server
 * names it among the session's users like a person, but it is no person editing. */
export const isAgentId = (id: string): boolean => id.startsWith("agent:");

/** Everyone present on the doc, agents among them, with the expired dropped. */
function present(docId: string): PresenceRecord[] {
  const users = presence.get(docId);
  if (!users) return [];
  const now = Date.now();
  for (const [id, u] of [...users]) if (isStale(u, now)) users.delete(id);
  return [...users.values()];
}

/** Every PERSON currently tracked as present on the doc (join time ascending), or [] for none: the agents' editors in
 * it are left out (agentsOf), so they neither lock it, nor badge it, nor count as "editing now". Returns copies --
 * callers may hold onto them freely. Expired entries (TTL passed without a heartbeat) are dropped on sight:
 * they no longer count as "editing now", so tools.ts' "editing now" annotation expires with them. */
export function usersOf(docId: string): LiveUser[] {
  return present(docId).filter((u) => !isAgentId(u.id)).map(({ id, name, at }) => ({ id, name, at }));
}

/** The names agents' editors were opened with, by their id: the Document Server's callbacks name users by id alone. */
const agentNames = new Map<string, string>();

/** The name people see for the agent of `id` ("Research (agent)"), as its editor config was minted with it. */
export function nameAgent(id: string, name: string): void {
  agentNames.set(id, name);
}

/** The agents' editors in the document now, as the Document Server says (its status-1 callbacks), for office_list. */
export function agentsOf(docId: string): { id: string; name: string }[] {
  return present(docId).filter((u) => isAgentId(u.id)).map((u) => ({ id: u.id, name: agentNames.get(u.id) ?? u.name ?? u.id }));
}

/** Track a join (joined=true -- inserts or updates the entry, KEEPING the original `at` of an already-tracked
 * user so the badge shows when they first opened it) or a leave (joined=false -- removes the id; a no-op if
 * absent). Used by status-1 action handling AND by server.ts when it mints an editor config. An empty user id
 * is ignored rather than stored under "". */
export function setUser(docId: string, user: { id: string; name?: string }, joined: boolean, options: { confirmed?: boolean } = {}): void {
  if (!user || typeof user.id !== "string" || user.id === "") return;
  const users = userMap(docId);
  if (joined) {
    const existing = users.get(user.id);
    // `at` keeps the FIRST join (the badge shows when they opened it); expiresAt moves forward on EVERY
    // join, so a minted seat that the Document Server confirms in time stays, while an abandoned one goes.
    const confirmed = options.confirmed || existing?.confirmed;
    users.set(user.id, { id: user.id, name: user.name ?? existing?.name, at: existing?.at ?? Date.now(), expiresAt: Date.now() + presenceTtlMs, ...(confirmed ? { confirmed } : {}) });
  } else {
    users.delete(user.id);
  }
}

/** The Document Server's word on who is in the editing session of `key` (a status-1 callback): its users now, an empty
 * list for none left. Presence follows every session of the document together: a user still in another key's session
 * stays. */
/** Who hears of a session's users (docchat.ts: the editor's chat of a session goes after its last person left). */
let sessionHeard: ((docId: string, key: string, users: string[] | null) => void) | undefined;
export function onSessionChange(fn: typeof sessionHeard): void {
  sessionHeard = fn;
}
function tellSession(docId: string, key: string, users: string[] | null): void {
  try {
    sessionHeard?.(docId, key, users);
  } catch {
    // a listener's failure is its own
  }
}

export function setSession(docId: string, key: string, userIds: string[]): void {
  tellSession(docId, key, userIds);
  let keys = sessions.get(docId);
  if (!keys) {
    keys = new Map();
    sessions.set(docId, keys);
  }
  if (userIds.length) keys.set(key, new Set(userIds));
  else keys.delete(key);
  const still = sessionUsers(docId);
  for (const tracked of present(docId)) if (!still.has(tracked.id)) setUser(docId, { id: tracked.id }, false);
  if (!keys.size) sessions.delete(docId);
}

/** The session of `key` is over (status 2 or 4, its terminal close). With none left on the document, nobody is in it:
 * presence and the flag go (clearDoc). Another key's session (an editor that already loads a newer revision) keeps
 * its users and the lock. */
export function endSession(docId: string, key: string): void {
  tellSession(docId, key, null);
  const keys = sessions.get(docId);
  keys?.delete(key);
  if (!keys?.size) {
    clearDoc(docId);
    return;
  }
  const still = sessionUsers(docId);
  for (const tracked of present(docId)) if (!still.has(tracked.id)) setUser(docId, { id: tracked.id }, false);
}

/** The keys of the editing sessions the Document Server said are open on the document: the one an editor opened on
 * the current revision joins (server.ts buildEditorConfig). */
export function sessionKeys(docId: string): string[] {
  return [...(sessions.get(docId)?.keys() ?? [])];
}

function sessionUsers(docId: string): Set<string> {
  return new Set([...(sessions.get(docId)?.values() ?? [])].flatMap((users) => [...users]));
}

/** The explicit lock flag (callback statuses 1/2/4/6 set it). */
export function setLocked(docId: string, isLocked: boolean): void {
  if (isLocked) locked.add(docId);
  else locked.delete(docId);
}

/** Whether the explicit lock flag is set for this doc. */
export function isLocked(docId: string): boolean {
  return locked.has(docId);
}

/**
 * The poll answer of the /state route (polled every 5 s by the editor page):
 * `locked` -- an explicit lock flag OR at least one tracked present user (see module header for the model);
 * `pendingRev` -- the document's current mtimeMs when a resolver is registered and reports it as strictly
 * NEWER than clientMtimeMs (an agent revision landed since the client opened it; same number = same revision
 * = not pending), else null. No resolver registered -> null.
 */
export function pollState(docId: string, clientMtimeMs: number): { locked: boolean; pendingRev: number | null } {
  // usersOf filters + physically drops expired entries, so "present" here can never count a stale lock
  const present = usersOf(docId).length > 0;
  let pendingRev: number | null = null;
  if (resolveMeta) {
    const mtimeMs = resolveMeta(docId);
    if (mtimeMs !== null && mtimeMs > clientMtimeMs) pendingRev = mtimeMs;
  }
  return { locked: present || locked.has(docId), pendingRev };
}

/** Register the function that answers "what is this doc's current revision mtime?" (server.ts at boot, with a
 * store.getDoc lookup); pass null to clear it. Must be a pure synchronous read of the library index. */
export function setMetaResolver(resolver: ((docId: string) => number | null) | null): void {
  resolveMeta = resolver;
}

/** Drop ALL state for one doc -- server.ts calls this after store.deleteDoc so a deleted doc never shows a
 * phantom lock badge. */
export function clearDoc(docId: string): void {
  presence.delete(docId);
  sessions.delete(docId);
  locked.delete(docId);
}

/** Wipe every doc's state (and the resolver) and restore the DEFAULT presence TTL. Exported for unit tests that
 * share one process; safe to call at any other time -- it only loses in-memory lock badges, nothing on disk. */
export function resetLive(): void {
  presence.clear();
  sessions.clear();
  locked.clear();
  agentNames.clear();
  resolveMeta = null;
  presenceTtlMs = DEFAULT_PRESENCE_TTL_MS;
}
