/** What the streamable-HTTP client keeps saying where its session goes: a plain-JSON and an event-stream answer,
 * and one request over a session the server has forgotten -- answered as 404 once, then made new and tried again. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mcpClient } from "../src/ncmcp.ts";

/** A stand-in of the Nextcloud MCP server's endpoint: it gives a session out on initialize, answers tools/list and
 * tools/call while its last one stands, and says 406 where the client does not say it takes both answer kinds. */
function mockServer(kind: "json" | "sse") {
  let sessions = new Map<string, boolean>(); // what stands, and whether each still counts for the server
  let nextSession = 1;
  let poison = false; // where it stands, a session made by an initialize no longer counts from its making on
  const seen: Record<string, number> = { initialize: 0, initialized: 0, ping: 0, tools_list: 0, tools_call: 0, notFound: 0, deleted: 0 };

  const server = http.createServer((req, res) => {
    if (req.method === "DELETE") {
      seen.deleted += 1;
      const header = req.headers["mcp-session-id"];
      if (typeof header === "string") sessions.set(header, false);
      return res.writeHead(200).end();
    }
    if (req.method !== "POST") return res.writeHead(405).end();
    const accept = req.headers.accept ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return res.writeHead(406).end();
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body) as { method?: string; id?: number };
      if (message.method === "initialize") {
        seen.initialize += 1;
        const id = `s${nextSession++}`;
        sessions.set(id, !poison);
        answer(res, kind, { jsonrpc: "2.0", id: message.id ?? 0, result: { protocolVersion: "2025-03-26", serverInfo: { name: "mock-nextcloud-mcp", version: "9.9.9" }, capabilities: {} } }, id);
        return;
      }
      const header = req.headers["mcp-session-id"];
      if (typeof header !== "string" || !sessions.get(header)) {
        seen.notFound += 1;
        return res.writeHead(404, { "content-type": "application/json" }).end("{}");
      }
      if (message.method === "notifications/initialized") {
        seen.initialized += 1;
        return res.writeHead(202).end();
      }
      if (message.method === "ping") {
        seen.ping += 1;
        return answer(res, kind, { jsonrpc: "2.0", id: message.id ?? 0, result: {} });
      }
      if (message.method === "tools/list") {
        seen.tools_list += 1;
        answer(res, kind, { jsonrpc: "2.0", id: message.id ?? 0, result: { tools: [{ name: "mock_tool" }] } });
        return;
      }
      if (message.method === "tools/call") {
        seen.tools_call += 1;
        answer(res, kind, { jsonrpc: "2.0", id: message.id ?? 0, result: { content: [{ type: "text", text: '{"answered":true}' }] } });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
    });
  });

  function answer(res: http.ServerResponse, kind: "json" | "sse", message: unknown, session?: string) {
    const payload = JSON.stringify(message);
    if (kind === "sse") {
      res.writeHead(200, { "content-type": "text/event-stream", ...(session ? { "mcp-session-id": session } : {}) });
      res.end(`event: message\ndata: ${payload}\n\n`);
    } else {
      res.writeHead(200, { "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) });
      res.end(payload);
    }
  }

  return {
    start: () =>
      new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    /** The sessions that stand -- and gone for the server from now on. */
    forgetSessions(): void {
      for (const key of sessions.keys()) sessions.set(key, false);
    },
    /** From now on, a session made by an initialize is forgotten from its making on. */
    poisonNewSessions: () => (poison = true),
    seen,
  };
}

test("a plain-JSON answer comes back: what it named of itself, its tools, and a tool's content raw", async () => {
  const server = mockServer("json");
  const port = await server.start();
  try {
    const client = mcpClient(`http://127.0.0.1:${port}/mcp`);
    const info = await client.ping();
    assert.equal(info.name, "mock-nextcloud-mcp");
    assert.equal(info.version, "9.9.9");
    assert.deepEqual(await client.listTools(), [{ name: "mock_tool" }]);
    const result = await client.callTool("mock_tool", {});
    assert.equal(result.content?.[0]?.text, '{"answered":true}');
  } finally {
    await server.stop();
  }
});

test("an event-stream answer is read where its one data line stands", async () => {
  const server = mockServer("sse");
  const port = await server.start();
  try {
    const client = mcpClient(`http://127.0.0.1:${port}/mcp`);
    assert.equal((await client.ping()).name, "mock-nextcloud-mcp");
    const result = await client.callTool("mock_tool", {});
    assert.equal(result.content?.[0]?.text, '{"answered":true}');
  } finally {
    await server.stop();
  }
});

test("a session the server has forgotten costs one 404: it is made new and the request stands on the second try", async () => {
  const server = mockServer("json");
  const port = await server.start();
  try {
    const client = mcpClient(`http://127.0.0.1:${port}/mcp`);
    await client.callTool("mock_tool", {}); // one session out, and standing
    const callsSoFar = server.seen.tools_call;
    server.forgetSessions();
    const result = await client.callTool("mock_tool", {});
    assert.equal(result.content?.[0]?.text, '{"answered":true}');
    assert.equal(server.seen.notFound, 1); // the gone session said no exactly once
    assert.equal(server.seen.tools_call, callsSoFar + 1); // and the call itself went over only again
    assert.equal(server.seen.initialize >= 2, true); // with a new session made for it
  } finally {
    await server.stop();
  }
});

test("a session gone twice is not retried a third time: the refusal stands where even the new one is forgotten", async () => {
  const server = mockServer("json");
  const port = await server.start();
  try {
    const client = mcpClient(`http://127.0.0.1:${port}/mcp`);
    await client.ping(); // a session out
    server.forgetSessions();
    server.poisonNewSessions(); // the re-initialize gets one -- gone from its making on
    const initsSoFar = server.seen.initialize;
    await assert.rejects(client.callTool("mock_tool", {}), /knows no session/);
    assert.equal(server.seen.initialize, initsSoFar + 1); // one re-initialize and nothing more: the client gave it up
    assert.equal(server.seen.tools_call, 0); // the call never stood
  } finally {
    await server.stop();
  }
});

test("a client makes one session and keeps it: the handshake ends with the notification, and a health check is a ping over it", async () => {
  const server = mockServer("json");
  const port = await server.start();
  try {
    const client = mcpClient(`http://127.0.0.1:${port}/mcp`);
    for (let i = 0; i < 5; i++) assert.equal((await client.ping()).name, "mock-nextcloud-mcp");
    await client.listTools();
    await client.callTool("mock_tool", {});
    assert.equal(server.seen.initialize, 1, "one session for all of it");
    assert.equal(server.seen.initialized, 1, "and the server told the client is ready");
    assert.equal(server.seen.ping, 5);
  } finally {
    await server.stop();
  }
});

test("two first calls at once make one session, not two", async () => {
  const server = mockServer("json");
  const port = await server.start();
  try {
    const client = mcpClient(`http://127.0.0.1:${port}/mcp`);
    await Promise.all([client.listTools(), client.listTools(), client.ping()]);
    assert.equal(server.seen.initialize, 1);
  } finally {
    await server.stop();
  }
});

test("close ends the session on the server; the client makes a new one if it is used again", async () => {
  const server = mockServer("json");
  const port = await server.start();
  try {
    const client = mcpClient(`http://127.0.0.1:${port}/mcp`);
    await client.ping();
    await client.close();
    assert.equal(server.seen.deleted, 1);
    await client.close(); // nothing to end: no second request
    assert.equal(server.seen.deleted, 1);
    await client.ping();
    assert.equal(server.seen.initialize, 2);
  } finally {
    await server.stop();
  }
});

test("a 404 on the first request says nothing serves /mcp there; it is not taken for a lost session", async () => {
  const other = http.createServer((_req, res) => res.writeHead(404).end("<html>not here</html>"));
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", () => resolve()));
  try {
    const client = mcpClient(`http://127.0.0.1:${(other.address() as AddressInfo).port}/mcp`);
    await assert.rejects(client.ping(), (error: Error) => /Nothing serves \/mcp at/.test(error.message) && !/no session/.test(error.message));
  } finally {
    other.close();
  }
});
