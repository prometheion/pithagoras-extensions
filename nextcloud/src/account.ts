/**
 * Whether a Nextcloud instance's host and login are good: the address parsed and judged when it is saved, and the
 * account asked of the Nextcloud itself when the status is read. The MCP server's own answer says nothing of it --
 * its handshake never reaches Nextcloud, so "answering" is true with a mistyped host or a revoked app password.
 */
import { createHash } from "node:crypto";
import type { NextcloudInstance } from "./config";

/** The address as it is stored: https (http only where the person chose it), a host, no login in it, no trailing
 * slash. A reason in a sentence where it is not one. */
export function normalizeUrl(given: string, allowHttp: boolean): { url: string } | { error: string } {
  const text = given.trim();
  if (!text) return { error: "The Nextcloud address is missing." };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { error: "The Nextcloud address is not an address. Write it with its scheme, like https://cloud.example.org" };
  }
  if (parsed.protocol === "http:") {
    if (!allowHttp) return { error: "http sends the app password unencrypted. Use https://, or switch on plain http for this instance." };
  } else if (parsed.protocol !== "https:") {
    return { error: "The Nextcloud address has to start with https:// (or http:// where plain http is switched on)." };
  }
  if (!parsed.hostname) return { error: "The Nextcloud address has no host." };
  if (parsed.username || parsed.password) return { error: "Leave the login out of the address: the user name and the app password have fields of their own." };
  if (parsed.search || parsed.hash) return { error: "The Nextcloud address is the address of the Nextcloud, without a query or a fragment." };
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}` };
}

/** What the Nextcloud said of the login. */
export interface Account {
  /** ok: the login works; unauthorized: the host answered and refused it; unreachable: no answer at all; other: an answer that is not Nextcloud's. */
  state: "ok" | "unauthorized" | "unreachable" | "other";
  /** The name Nextcloud shows for the user, where it said. */
  name?: string;
  error?: string;
}

const CHECK_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; account: Account }>();

/** The key of an answer in the cache: the login, hashed, so the password is not kept as a key in memory. */
const keyOf = (inst: NextcloudInstance): string => createHash("sha256").update(JSON.stringify([inst.url, inst.username, inst.password])).digest("hex");

const asking = new Map<string, Promise<Account>>();

/** Asks the Nextcloud who the login is (`GET /ocs/v2.php/cloud/user`), and keeps the answer for a minute: the status
 * is read often, and the Nextcloud is not to be asked every time. */
export function checkAccount(inst: NextcloudInstance): Promise<Account> {
  const key = keyOf(inst);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.account);
  let running = asking.get(key);
  if (!running) {
    running = ask(inst)
      .then((account) => {
        cache.set(key, { at: Date.now(), account });
        if (cache.size > 50) for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
        return account;
      })
      .finally(() => asking.delete(key));
    asking.set(key, running);
  }
  return running;
}

/** The answer if there is one within `waitMs`; "checking" otherwise, the question going on in the background -- so a
 * host that does not answer does not hold the status back for the whole of the request's time. */
export async function checkAccountSoon(inst: NextcloudInstance, waitMs: number): Promise<Account | { state: "checking" }> {
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<{ state: "checking" }>((resolve) => {
    timer = setTimeout(() => resolve({ state: "checking" }), waitMs);
  });
  try {
    return await Promise.race([checkAccount(inst), slow]);
  } finally {
    clearTimeout(timer);
  }
}

/** The answer forgotten, for a login just saved: the next status asks again. */
export function forgetAccount(inst: NextcloudInstance): void {
  cache.delete(keyOf(inst));
}

async function ask(inst: NextcloudInstance): Promise<Account> {
  const basic = Buffer.from(`${inst.username}:${inst.password}`, "utf8").toString("base64");
  let answer: Response;
  try {
    answer = await fetch(`${inst.url}/ocs/v2.php/cloud/user?format=json`, {
      headers: { authorization: `Basic ${basic}`, "ocs-apirequest": "true", accept: "application/json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (error) {
    const e = error as Error & { cause?: { code?: string; message?: string } };
    const timedOut = e.name === "TimeoutError";
    return { state: "unreachable", error: timedOut ? `${inst.url} did not answer within ${CHECK_TIMEOUT_MS / 1000} s` : `${inst.url} could not be reached: ${e.cause?.message ?? e.cause?.code ?? e.message}` };
  }
  if (answer.status === 401 || answer.status === 403) {
    await answer.body?.cancel().catch(() => {});
    return { state: "unauthorized", error: "Nextcloud refused the user name or the app password." };
  }
  if (!answer.ok) {
    await answer.body?.cancel().catch(() => {});
    return { state: "other", error: `${inst.url} answered ${answer.status} where Nextcloud's user API should answer.` };
  }
  try {
    const body = (await answer.json()) as { ocs?: { data?: { id?: string; displayname?: string } } };
    const data = body.ocs?.data;
    if (!data || typeof data !== "object") throw new Error("no ocs data");
    return { state: "ok", ...(data.displayname || data.id ? { name: String(data.displayname || data.id) } : {}) };
  } catch {
    return { state: "other", error: `${inst.url} answered, but not as a Nextcloud does: is the address the Nextcloud's own?` };
  }
}
