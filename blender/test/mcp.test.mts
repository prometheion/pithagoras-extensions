import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { mcpClient, NotAnswering } from "../../shared/mcp.ts";
import { BUNDLED, fakeMcp, TOOLS } from "./fakes.mts";

/** The client of the server's MCP endpoint: JSON-RPC over plain HTTP, with the token. */

test("every request carries the token, and the server's tools and instructions are read", async () => {
  const server = await fakeMcp("s3cret");
  const mcp = mcpClient({ url: () => server.url, token: () => "s3cret" });
  assert.equal(await mcp.ping(), true);
  const info = await mcp.initialize();
  assert.equal(info.instructions, BUNDLED.instructions);
  assert.equal(info.version, "5.2.2");
  assert.deepEqual((await mcp.listTools()).map((t) => t.name), TOOLS.map((t) => t.name));
  assert.ok(server.seen.every((s) => s.auth === "Bearer s3cret"));
  assert.equal(server.seen.find((s) => s.method === "initialize")!.params.protocolVersion, "2025-06-18");
});

test("the wrong token is no answer to a ping, and an error otherwise", async () => {
  const server = await fakeMcp("s3cret");
  const mcp = mcpClient({ url: () => server.url, token: () => "wrong" });
  assert.equal(await mcp.ping(), false);
  await assert.rejects(mcp.listTools(), /401/);
});

test("a JSON-RPC error is thrown with the server's message", async () => {
  const server = await fakeMcp("t");
  const mcp = mcpClient({ url: () => server.url, token: () => "t" });
  await assert.rejects(mcp.callTool("nope", {}), /unknown tool 'nope'/);
});

test("a result the server marks as an error is given back as it is, for the relay to throw", async () => {
  const server = await fakeMcp("t");
  server.answers.render = () => ({ content: [{ type: "text", text: "ValueError: scene has no active camera" }], isError: true });
  const mcp = mcpClient({ url: () => server.url, token: () => "t" });
  const result = await mcp.callTool("render", {});
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /no active camera/);
});

test("an answer that is not JSON is an error", async () => {
  const server = http.createServer((_req, res) => res.end("<html>a proxy's page</html>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const mcp = mcpClient({ url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, token: () => "t" });
  await assert.rejects(mcp.listTools(), /not JSON/);
});

test("nothing on the port is NotAnswering, and the abort signal ends a call", async () => {
  const server = await fakeMcp("t");
  const url = server.url;
  await server.close();
  const gone = mcpClient({ url: () => url, token: () => "t" });
  await assert.rejects(gone.listTools(), NotAnswering);

  const slow = await fakeMcp("t");
  slow.state.hang = true;
  const mcp = mcpClient({ url: () => slow.url, token: () => "t" });
  const stop = new AbortController();
  const call = mcp.callTool("render", {}, stop.signal);
  setTimeout(() => stop.abort(), 50);
  await assert.rejects(call, (e: Error) => e.name === "AbortError" && !(e instanceof NotAnswering));
});
