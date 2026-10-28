/**
 * A streamable-HTTP MCP client for the Nextcloud MCP server, the way it speaks: JSON-RPC over POST to one
 * endpoint, answers as a plain JSON object or an event stream (`event: message`, one `data:` line of JSON each),
 * and a session given out by the `mcp-session-id` response header that later requests must carry back.
 *
 * (shared/mcp.ts in this repository is simpler -- it takes only plain-JSON answers and keeps no session, which
 * is what its own servers give.) This one keeps that same thin shape: an id per request, and what a tool call
 * answered as content parts, raw -- nothing of them parsed here.
 *
 * A client of this module is for ONE endpoint at a time and holds its session in process memory; where the
 * server says there is no such session (404), it makes one anew and tries the request once more.
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** One part of a tool call's content, as the server gave it: text (where this server puts its JSON) or whatever else it names. */
export type McpContentPart = { type: string; [key: string]: unknown };

export interface McpResult {
  content: McpContentPart[];
  isError?: boolean;
  [key: string]: unknown;
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; [key: string]: unknown };
};

const PROTOCOL_VERSION = "2025-03-26";

/** A streamable-HTTP MCP client of `url`, sessionful. */
export function mcpClient(url: string) {
  let sessionId: string | undefined;
  let initialized = false;
  let nextId = 1;

  /** One JSON-RPC message to the server, answered as JSON or event stream, its one result read back. */
  async function post(message: JsonRpcMessage): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // The server takes nothing else: without both of them it answers 406.
      accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    let answer: Response;
    try {
      answer = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
    } catch (error) {
      throw new Error(`The MCP server at ${url} could not be reached: ${(error as Error).message}`);
    }
    const givenSession = answer.headers.get("mcp-session-id");
    if (givenSession) sessionId = givenSession;
    if (answer.status === 404) {
      // No such session anymore: the caller re-initializes and retries.
      const error = new Error("The server knows no session of this client anymore") as NodeJS.ErrnoException & { code?: string };
      error.code = "E_SESSION_GONE";
      throw error;
    }
    if (!answer.ok) throw await answerError(answer);
    const text = await answer.text();
    const contentType = (answer.headers.get("content-type") ?? "").toLowerCase();
    let body: JsonRpcMessage | undefined;
    if (contentType.includes("text/event-stream")) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as JsonRpcMessage;
          if (parsed.id === message.id || (message.id === undefined && parsed.result)) body = parsed;
        } catch {
          // not the one
        }
      }
    } else {
      try {
        body = JSON.parse(text) as JsonRpcMessage;
      } catch {
        throw new Error(`The MCP server at ${url} answered ${answer.status} with something that is neither JSON nor an event stream.`);
      }
    }
    if (!body) throw new Error(`The MCP server at ${url} answered ${answer.status} without a result for this request.`);
    if (body.error) throw new Error(`The MCP server said no: ${body.error.message}`);
    return body.result;
  }

  async function initialize(): Promise<void> {
    await post({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "@pithagoras/nextcloud", version: "0.1.0" } } });
    initialized = true;
  }

  /** One request of the client proper: an initialize round trip first where needed, one retry over a gone session. */
  async function rpc(method: string, params?: unknown): Promise<unknown> {
    if (!initialized) await initialize();
    for (let attempt = 0; ; attempt++) {
      try {
        return await post({ jsonrpc: "2.0", id: nextId++, method, params });
      } catch (error) {
        if (attempt === 0 && (error as NodeJS.ErrnoException).code === "E_SESSION_GONE") {
          initialized = false;
          sessionId = undefined;
          await initialize();
          continue;
        }
        throw error;
      }
    }
  }

  return {
    /** Whether the server answers at all: an initialize round trip, with what it says of itself. */
    async ping(): Promise<{ name: string; version: string }> {
      initialized = false;
      const result = (await post({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "@pithagoras/nextcloud", version: "0.1.0" } } })) as Record<string, unknown>;
      initialized = true;
      const info = (result?.serverInfo ?? {}) as Record<string, unknown>;
      return { name: String(info.name ?? ""), version: String(info.version ?? "") };
    },
    /** The server's tools, by name and argument schema. */
    async listTools(): Promise<McpTool[]> {
      const result = (await rpc("tools/list")) as Record<string, unknown>;
      return (result?.tools ?? []) as McpTool[];
    },
    /** Call a tool of the server: its content parts back, raw -- this module parses none of them. */
    async callTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
      const result = (await rpc("tools/call", { name, arguments: args })) as McpResult;
      return result ?? { content: [] };
    },
  };
}

async function answerError(answer: Response): Promise<Error> {
  let detail = "";
  try {
    const text = await answer.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string };
        detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? "";
      } catch {
        detail = text.length > 300 ? `${text.slice(0, 300)}…` : text;
      }
    }
  } catch {
    // nothing readable in the body: the status alone stands
  }
  return new Error(`The MCP server answered ${answer.status}${detail ? `: ${detail}` : ""}`);
}
