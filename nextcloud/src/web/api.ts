/**
 * What the browser half asks of its server half: the routes under the address the portal gives the package
 * (portal.api.url, mounted by the portal at /api/x/@pithagoras/nextcloud, session-gated there). A request made
 * while the server half is not running is refused as one the server refused is.
 */
import { portal } from "../portal";

/** What GET /status says of where things stand: the keys (whether they name a Nextcloud at all), the container,
 * the entry in pi's config, and the server itself. */
export interface NextcloudStatus {
  image: string;
  container: string;
  state: string; // absent | running | stopped | created | ... Docker's word for it
  address: string;
  mcp: { registered: boolean; on: boolean; url?: string };
  health: { ok: boolean; server?: { name: string; version: string }; error?: string };
  task?: string; // what a save is doing on the person's behalf right now
  error?: string; // what the last of those said when it failed
  configured: boolean;
}

/** What the keys hold, as GET /settings says it (the password not among them). */
export interface NextcloudSettingsView {
  url: string;
  username: string;
  mcpExcludeTools: string;
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

export const api = {
  status: () => call<NextcloudStatus>("/status"),
  settings: () => call<NextcloudSettingsView>("/settings"),
  saveSettings: (patch: Partial<{ url: string; username: string; password: string; mcpExcludeTools: string }>) =>
    call<NextcloudSettingsView & { task?: string }>("/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  start: () => call<NextcloudStatus>("/start", { method: "POST" }),
  reset: () => call<{ ok: true }>("/reset", { method: "POST" }),
  tool: (name: string, args: Record<string, unknown> = {}) =>
    call<ToolResult>("/tool", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, args }) }),
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
