/**
 * A client for the MCP endpoint of the extension's own server (`POST /mcp` on the container's port, on the portal's
 * loopback): JSON-RPC over plain HTTP, every request with the server's token. Both servers it is written for answer
 * each POST with one JSON reply and keep no session (their server.py), so it speaks JSON only: no event stream is
 * read, and no session id is kept.
 *
 * A call that takes long (a render) is waited for: the portal's own fetch waits half an hour for an answer. Its
 * AbortSignal ends the request; the server goes on with what it was doing, as neither server reads
 * `notifications/cancelled`.
 */

/** A tool as the server lists it (`tools/list`). */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** What a tool call came back with (`tools/call`): MCP's own content parts, in order. */
export interface McpResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: string; [key: string]: unknown })[];
  isError?: boolean;
}

/** What the server says of itself as the client starts (`initialize`). */
export interface McpServerInfo {
  instructions: string;
  version: string;
}

/** The server could not be reached at all: nothing answers on its port. */
export class NotAnswering extends Error {}

/** The protocol version asked for: one both servers take. */
export const PROTOCOL_VERSION = "2025-06-18";

export function mcpClient(options: { url: () => string; token: () => string }) {
  let id = 0;

  /** One JSON-RPC request. The server's error is thrown with its message; an answer that is not JSON is an error too. */
  async function call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    let answer: Response;
    try {
      answer = await fetch(options.url(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token()}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new NotAnswering(`Nothing answers at ${options.url()}: ${(e as Error).message}`);
    }
    const text = await answer.text();
    let body: { result?: T; error?: { message?: string } };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`The server answered ${answer.status} with something that is not JSON: ${text.slice(0, 200)}`);
    }
    if (body.error) throw new Error(body.error.message ?? `The server refused ${method}`);
    if (!answer.ok) throw new Error(`The server answered ${answer.status} to ${method}`);
    return body.result as T;
  }

  return {
    call,
    async initialize(): Promise<McpServerInfo> {
      const result = await call<{ instructions?: string; serverInfo?: { version?: string } }>("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "pithagoras-flair", version: "1" },
      });
      return { instructions: result.instructions ?? "", version: result.serverInfo?.version ?? "" };
    },
    /** Whether the server answers, with its token: the server's own `ping`, answered by its HTTP thread. */
    async ping(signal?: AbortSignal): Promise<boolean> {
      try {
        await call("ping", {}, signal);
        return true;
      } catch {
        return false;
      }
    },
    async listTools(): Promise<McpTool[]> {
      return (await call<{ tools: McpTool[] }>("tools/list")).tools;
    },
    callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => call<McpResult>("tools/call", { name, arguments: args }, signal),
  };
}

export type McpClient = ReturnType<typeof mcpClient>;
