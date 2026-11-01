/**
 * What the browser half asks of its server half: the routes under the address the portal gives the package
 * (portal.api.url, mounted by the portal at /api/x/@pithagoras/nextcloud, session-gated there), one per instance
 * beside the status. A request made while the server half is not running is refused as one the server
 * refused is. Which of the instances a tool call goes to is what its panel holds (InstanceContext): each open
 * panel keeps its own choice, and every tool call is sent with it.
 */
import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { portal } from "../portal";

/** What GET /status says of where things stand: every instance -- its container, its entry in pi's config, and
 * whether its server answers at all -- beside what a save is doing on the person's behalf right now. */
export interface NextcloudStatus {
  image: string;
  instances: InstanceStatus[];
  configured: boolean; // at least one instance set completely
  task?: string; // what a save is doing on the person's behalf right now
  error?: string; // what the last of those said when it failed
}

/** What one instance says of itself in the status. */
export interface InstanceStatus {
  name: string;
  containerName: string;
  state: string; // absent | running | stopped | created | ... Docker's word for it
  address?: string; // where its /mcp endpoint stands, where it does at all
  /** The Nextcloud host itself -- where the browser opens this one. */
  url?: string;
  mcp: { registered: boolean; on: boolean; url?: string };
  health: { ok: boolean; server?: { name: string; version: string }; error?: string };
  configured: boolean;
  /** What the endpoint's tool list says of each capability family -- where it could be asked. */
  capabilities?: { available: Record<string, boolean>; on: Record<string, boolean> };
}

/** What an instance holds, as GET /instances says it (the password not among them). */
export interface InstanceView {
  name: string;
  url: string;
  username: string;
  /** The capability families turned off for this instance, by family id; nothing standing is everything on. */
  capabilities?: Record<string, boolean>;
  passwordSet?: boolean;
  configured: boolean;
}

/** A content part of a tool call's answer, raw from the server. */
export interface ContentPart {
  type: string;
  [key: string]: unknown;
}

/** The answer of POST /tool, straight from the MCP server: its content parts (the JSON in their text) and what it says of itself. */
export interface ToolResult {
  content?: ContentPart[];
  isError?: boolean;
  [key: string]: unknown;
}

const call = async <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);

/** Which instance one open panel talks to, held by the panel and read by the tabs it remounts for it -- every tool
 * call is sent with it. One choice per panel on purpose: two panels beside two chats may stand on different
 * instances at once. */
export const InstanceContext = createContext<string | undefined>(undefined);
export const useNextcloudInstance = (): string | undefined => useContext(InstanceContext);

export const api = {
  status: () => call<NextcloudStatus>("/status"),
  instances: () => call<{ instances: InstanceView[] }>("/instances"),
  saveInstance: (fields: Record<string, unknown>) =>
    call<{ instances: InstanceView[]; task?: string }>("/instances", {
      method: "POST",
      body: JSON.stringify(fields),
    }),
  removeInstance: (name: string) =>
    call<{ instances: InstanceView[]; task?: string }>("/instances/remove", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  start: () => call<NextcloudStatus>("/start", { method: "POST" }),
  reset: () => call<{ ok: true }>("/reset", { method: "POST" }),
  /** One tool called through. Where the server reports the call failed (isError), it is rejected with the server's
   * own words -- so the catch every caller already stands in catches what was before read as an empty answer and
   * could go by unseen. */
  tool: async (name: string, args: Record<string, unknown> = {}, instance?: string) => {
    const result = await call<ToolResult>("/tool", {
      method: "POST",
      body: JSON.stringify({ name, args, instance }),
    });
    if (result.isError === true) {
      const part = (result.content ?? []).find((p) => p.type === "text");
      throw new Error(typeof part?.text === "string" && part.text !== "" ? part.text : `The tool ${name} said no without a word for it.`);
    }
    return result;
  },
};

/** What one of the server's content parts carries as its text, and what that text says of itself: its JSON where it
 * is JSON (this server puts every answer there), the text itself otherwise. */
export function partText(result: ToolResult): { data?: unknown; text: string } {
  const part = (result.content ?? []).find((p) => p.type === "text");
  if (!part || typeof part.text !== "string") return { text: JSON.stringify(result, null, 2) };
  try {
    return { data: JSON.parse(part.text), text: part.text };
  } catch {
    return { text: part.text };
  }
}

/** An array of an answer where its key is one the server has been seen to use; nothing where it named none. */
export function arrayOf(data: unknown, ...keys: string[]): Record<string, unknown>[] | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  for (const key of keys) {
    const value = (data as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value.map((v) => (typeof v === "object" && v !== null ? v : { value: v })) as Record<string, unknown>[];
  }
  return undefined;
}

/** What a failed call says of itself: the server's words where it gave them, its own otherwise. */
export function sayError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).error === "string")
    return (error as Record<string, unknown>).error as string;
  return String(error);
}

/**
 * A guard against answers that come late: a request that is asked while an earlier one of the same `key` is still on
 * its way makes the earlier one stale, and so does the view being left. Ask for the check before the request, and
 * look at it in the answer: `const current = guard("rows"); api.tool(...).then((r) => { if (!current()) return; ... })`.
 * Without it a slow answer for the board that was pressed first overwrites the board pressed after it.
 */
export function useGuard(): (key?: string) => () => boolean {
  const counters = useRef(new Map<string, number>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback((key = "") => {
    const n = (counters.current.get(key) ?? 0) + 1;
    counters.current.set(key, n);
    return () => mounted.current && counters.current.get(key) === n;
  }, []);
}
