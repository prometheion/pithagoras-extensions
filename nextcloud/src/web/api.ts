/**
 * What the browser half asks of its server half: the routes under the address the portal gives the package
 * (portal.api.url, mounted by the portal at /api/x/@pithagoras/nextcloud, session-gated there), one per instance
 * beside the status and discovery. A request made while the server half is not running is refused as one the server
 * refused is. The pages also hold which of the instances they are meant to talk to -- the switcher in the panel's
 * header sets it, and every tool call is sent with it.
 */
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
  mode: "own" | "adopted";
  containerName: string;
  state: string; // absent | running | stopped | created | ... Docker's word for it
  address?: string; // where its /mcp endpoint stands, where it does at all
  mcp: { registered: boolean; on: boolean; url?: string };
  health: { ok: boolean; server?: { name: string; version: string }; error?: string };
  configured: boolean;
}

/** What an instance holds, as GET /instances says it (the password not among them). */
export interface InstanceView {
  name: string;
  url: string;
  username: string;
  mcpExcludeTools: string;
  passwordSet?: boolean;
  configured: boolean;
  container: string; // "own" or "adopted:<docker container name>"
}

/** A container that runs the image, as GET /discover found it on the machine. */
export interface DiscoveredContainer {
  name: string;
  image: string;
  status: string; // Docker's own words for how it stands
  endpoint?: string; // its /mcp at the loopback, where it publishes port 8000 there
  takenBy?: string; // an instance already adopts it
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

/** Which instance the pages talk to right now: set by the switcher, and what every tool call is sent with. One for
 * the whole portal on purpose -- every open panel of this user's shares the single active instance. */
let currentInstance: string | undefined;
export const setCurrentInstance = (name: string | undefined): void => {
  currentInstance = name;
};

export const api = {
  status: () => call<NextcloudStatus>("/status"),
  instances: () => call<{ instances: InstanceView[] }>("/instances"),
  saveInstance: (fields: Record<string, string>) =>
    call<{ instances: InstanceView[]; task?: string }>("/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    }),
  removeInstance: (name: string) =>
    call<{ instances: InstanceView[]; task?: string }>("/instances/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  discover: () => call<{ containers: DiscoveredContainer[]; note?: string }>("/discover"),
  start: () => call<NextcloudStatus>("/start", { method: "POST" }),
  reset: () => call<{ ok: true }>("/reset", { method: "POST" }),
  tool: (name: string, args: Record<string, unknown> = {}) =>
    call<ToolResult>("/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, args, instance: currentInstance }),
    }),
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
