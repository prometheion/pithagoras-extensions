/**
 * A streamable-HTTP MCP client for the Nextcloud MCP server, the way it speaks: JSON-RPC over POST to one
 * endpoint, answers as a plain JSON object or an event stream (`event: message`, one `data:` line of JSON each),
 * and a session given out by the `mcp-session-id` response header that later requests must carry back.
 *
 * (shared/mcp.ts in this repository is simpler -- it takes only plain-JSON answers and keeps no session, which
 * is what its own servers give.) This one keeps that same thin shape: an id per request, and what a tool call
 * answered as content parts, raw -- nothing of them parsed here.
 *
 * A client of this module is for ONE endpoint at a time and holds its session in process memory (the server half keeps
 * one per endpoint and reuses it, see server.ts); where the server says there is no such session (404 on a request
 * that carried one), it makes one anew and tries the request once more.
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

// How long a request is given, before it is gone up on: short for the check that there is a server at all,
// long for what the tools do (a WebDAV read can pull in several megabytes as base64).
const PING_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 120_000;

/** A streamable-HTTP MCP client of `url`, sessionful. */
export function mcpClient(url: string) {
  let sessionId: string | undefined;
  let initialized = false;
  let initializing: Promise<void> | undefined; // two first calls at once make one session, not two
  let info: { name: string; version: string } = { name: "", version: "" };
  let nextId = 1;

  /** One JSON-RPC message to the server, answered as JSON or event stream, its one result read back -- given no
   * longer than `timeoutMs`, over the whole answer including its body. A notification (no id) has no result to read. */
  async function post(message: JsonRpcMessage, timeoutMs = 30_000): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // The server takes nothing else: without both of them it answers 406.
      accept: "application/json, text/event-stream",
    };
    const sent = sessionId;
    if (sent) headers["mcp-session-id"] = sent;
    let answer: Response;
    try {
      answer = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = (error as Error).name === "TimeoutError";
      throw new Error(`The MCP server at ${url} could not be reached: ${timedOut ? `it took longer than ${Math.round(timeoutMs / 1000)} s` : (error as Error).message}`);
    }
    const givenSession = answer.headers.get("mcp-session-id");
    if (givenSession) sessionId = givenSession;
    if (answer.status === 404) {
      await answer.body?.cancel().catch(() => {});
      // Only a request that carried a session can be told its session is gone; a 404 on the first one means that
      // whatever answers at this address is not an MCP server (or not the one on this path).
      if (!sent) throw new Error(`Nothing serves /mcp at ${url}: it answered 404.`);
      const error = new Error("The server knows no session of this client anymore") as NodeJS.ErrnoException & { code?: string };
      error.code = "E_SESSION_GONE";
      throw error;
    }
    if (!answer.ok) throw await answerError(answer);
    if (message.id === undefined) {
      await answer.body?.cancel().catch(() => {}); // a notification: the server says 202 and nothing more
      return undefined;
    }
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
          if (parsed.id === message.id) body = parsed;
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

  /** The handshake: initialize, what the server says of itself kept, and the notification that the client is ready. */
  async function handshake(timeoutMs: number): Promise<void> {
    sessionId = undefined;
    const result = (await post({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "@pithagoras/nextcloud", version: "0.1.0" } } }, timeoutMs)) as Record<string, unknown>;
    const server = (result?.serverInfo ?? {}) as Record<string, unknown>;
    info = { name: String(server.name ?? ""), version: String(server.version ?? "") };
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs);
    initialized = true;
  }

  function initialize(timeoutMs = 30_000): Promise<void> {
    initializing ??= handshake(timeoutMs).finally(() => {
      initializing = undefined;
    });
    return initializing;
  }

  /** One request of the client proper: a handshake first where needed, one retry over a gone session. */
  async function rpc(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!initialized) await initialize();
    for (let attempt = 0; ; attempt++) {
      try {
        return await post({ jsonrpc: "2.0", id: nextId++, method, params }, timeoutMs);
      } catch (error) {
        if (attempt === 0 && (error as NodeJS.ErrnoException).code === "E_SESSION_GONE") {
          initialized = false;
          await initialize();
          continue;
        }
        throw error;
      }
    }
  }

  return {
    /** Whether the server answers at all: a `ping` over the session this client holds (a handshake first where there
     * is none), with what the server said of itself in that handshake. */
    async ping(): Promise<{ name: string; version: string }> {
      if (!initialized) await initialize(PING_TIMEOUT_MS);
      await rpc("ping", undefined, PING_TIMEOUT_MS);
      return { ...info };
    },
    /** The server's tools, by name and argument schema. */
    async listTools(): Promise<McpTool[]> {
      const result = (await rpc("tools/list")) as Record<string, unknown>;
      return (result?.tools ?? []) as McpTool[];
    },
    /** Call a tool of the server: its content parts back, raw -- this module parses none of them. */
    async callTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
      const result = (await rpc("tools/call", { name, arguments: args }, TOOL_TIMEOUT_MS)) as McpResult;
      return result ?? { content: [] };
    },
    /** Ends the session on the server (best effort), for a client that is not used again. */
    async close(): Promise<void> {
      const id = sessionId;
      initialized = false;
      sessionId = undefined;
      if (!id) return;
      try {
        await fetch(url, { method: "DELETE", headers: { "mcp-session-id": id }, signal: AbortSignal.timeout(3_000) });
      } catch {
        // the server is gone or does not know the verb: its sessions end by themselves
      }
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
