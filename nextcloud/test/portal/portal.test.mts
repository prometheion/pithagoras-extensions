import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { CAPABILITIES } from "../../src/capabilities.ts";

/**
 * Nextcloud as a portal runs it: its server half started by Pithagoras' own extension host, after Docker for
 * extensions' (which it requires), each from its package as the portal reads it, with Docker speaking to the daemon
 * of Pithagoras' own tests (extensions/docker/test/fake-docker.ts), never to one on the machine, and a stand-in
 * MCP server on the port an instance's container is told to hold, where the real nextcloud-mcp-server would answer.
 * Its routes are served as the portal serves an extension's, under /api/x/@pithagoras/nextcloud.
 *
 * The pi-mcp-adapter pi installs for the entries this extension writes into mcp.json is not installed through its
 * CLI in a test: the settings of the home the half runs from say it is already there (as every real portal's), so
 * what stands out is the entry itself, and none of the test needs a network.
 *
 * Needs a Pithagoras checkout at the version this extension is built for, with its server built:
 * `scripts/pithagoras.sh` makes one in .pithagoras/, and `PITHAGORAS_DIR` names it.
 */

const DIR = process.env.PITHAGORAS_DIR;
if (!DIR || !existsSync(path.join(DIR, "core/server/dist/extension-host.js"))) {
  throw new Error("PITHAGORAS_DIR must name a Pithagoras checkout with core/server built: scripts/pithagoras.sh makes one");
}
const from = (file: string) => pathToFileURL(path.join(DIR, file)).href;

const { inProcessHome, freePort } = await import(from("core/server/test/server-harness.mjs"));
inProcessHome("flair-nextcloud-portal-");
process.env.PORTAL_PASSWORD = "";
process.env.PORTAL_ALLOW_NO_PASSWORD = "1";

/** The port the first instance's container holds on 127.0.0.1: read once its half loads, where the real one reads it too. */
const mcpPort = await freePort();
process.env.PITHAGORAS_NEXTCLOUD_PORT = String(mcpPort);

/** The settings of the home the halves run from say pi-mcp-adapter is already installed for them, as a real
 * portal's say it: the entries the extension writes into mcp.json are then what stand out. */
writeFileSync(
  path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"),
  JSON.stringify({ packages: [{ source: "npm:pi-mcp-adapter@2.18.0", autoload: true }] }),
  { mode: 0o600 },
);

// A stand-in of the Nextcloud MCP server's endpoint, on the very port an instance's container is told to hold: it
// gives a session out on initialize and answers tools/list and tools/call while it stands.
const seen = { initialize: 0, tools_call: 0 };
const mock = http.createServer((req, res) => {
  if (req.method !== "POST") return res.writeHead(405).end();
  const accept = req.headers.accept ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return res.writeHead(406).end();
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const message = JSON.parse(body) as { method?: string; id?: number };
    if (message.method === "initialize") {
      seen.initialize += 1;
      return res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result: { protocolVersion: "2025-03-26", serverInfo: { name: "mock-nextcloud-mcp", version: "9.9.9" }, capabilities: {} } }));
    }
    if (message.method === "tools/list") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result: { tools: [] } }));
    if (message.method === "tools/call") {
      seen.tools_call += 1;
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result: { content: [{ type: "text", text: '{"lists":[{"id":7,"name":"Einkaufen"}]}' }] } }));
    }
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
});
await new Promise<void>((resolve) => mock.listen(mcpPort, "127.0.0.1", () => resolve()));

// Docker, stood in for: this portal runs on the machine itself (no container of its own), so a container it makes
// shares the machine's network, and nothing is put between them.
const { fakeDocker } = await import(from("extensions/docker/test/fake-docker.ts"));
const docker = await fakeDocker();
process.env.DOCKER_SOCKET = docker.socket;
docker.images.add("ghcr.io/cbcoutinho/nextcloud-mcp-server:v0.202.2");

const host = await import(from("core/server/dist/extension-host.js"));
const db = await import(from("core/server/dist/db.js"));
db.getDb();
const { requiresOf } = await import(from("core/server/dist/extension-ui.js"));
const halfOf = (folder: string, file: string) => {
  const meta = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8"));
  return { name: meta.name as string, version: meta.version as string, file: path.join(folder, file), rev: meta.version as string, requires: requiresOf(meta) };
};
const halves = { docker: halfOf(path.join(DIR, "extensions/docker"), "src/server.ts"), nextcloud: halfOf(path.resolve(import.meta.dirname, "../.."), "src/server.ts") };

const app = express().use("/api/x", host.extensionRoutes);
app.use((req, res) => res.status(404).json({ no: `a route here, as the portal gives one: ${req.method} ${req.path}` }));
const portal = http.createServer(app);
portal.listen(0, "127.0.0.1");
await once(portal, "listening");
const at = `http://127.0.0.1:${(portal.address() as AddressInfo).port}/api/x/%40pithagoras/nextcloud`;

after(async () => {
  await host.stopServerHalves();
  http.globalAgent.destroy();
  portal.closeAllConnections();
  portal.close();
  mock.closeAllConnections();
  mock.close();
  await docker.close();
});

const status = async () => (await fetch(`${at}/status`)).json() as any;
const until = async (check: (s: any) => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    const s = await status();
    if (check(s)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`never: ${what}`);
};
const ncContainer = (name: string) => docker.containers.find((c: { Name: string }) => c.Name === name);

test("it waits for Docker for extensions, as its package.json requires, and starts once Docker's half runs", async () => {
  await host.syncServerHalves([halves.nextcloud]);
  assert.equal(host.isServing("@pithagoras/nextcloud"), false);
  assert.match(String(host.serverFailure("@pithagoras/nextcloud") ?? ""), /It needs pithagoras-docker \(\^1\.3\.0\)/);
  await host.syncServerHalves([halves.docker, halves.nextcloud]);
  for (let i = 0; i < 300 && !(host.isServing("pithagoras-docker") && host.isServing("@pithagoras/nextcloud")); i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(host.isServing("pithagoras-docker"), true);
  assert.equal(host.isServing("@pithagoras/nextcloud"), true);
});

test("no instance yet: it says none is set, and the way it keeps that said", async () => {
  // what it does on its start may not have stood done as it first answers (it looked through mcp.json for something
  // to adopt): wait for nothing left doing before reading what it kept.
  const s = await until((s) => s.task === undefined && s.migrated === undefined, "the startup task to stand done");
  assert.deepEqual(s, { image: "ghcr.io/cbcoutinho/nextcloud-mcp-server:v0.202.2", instances: [], configured: false });
});

test("a saved instance stands in a container of its own, on the portal's network, and its entry in mcp.json with it", async () => {
  const answer = await fetch(`${at}/instances`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "uni", url: "https://cloud.uni.example", username: "anna@uni.example", password: "the-password" }) });
  assert.equal(answer.status, 200);
  const body = (await answer.json()) as any;
  assert.deepEqual(body.instances[0], { name: "uni", url: "https://cloud.uni.example", username: "anna@uni.example", passwordSet: true, configured: true, container: "own" }); // a fresh instance carries no capability choices yet

  const made = ncContainer("pithagoras-nextcloud-mcp-uni");
  assert.ok(made, "a container of its own stands");
  assert.equal(made.State, "running");
  assert.deepEqual(made.made?.Env, ["NEXTCLOUD_HOST=https://cloud.uni.example", "NEXTCLOUD_USERNAME=anna@uni.example", "NEXTCLOUD_PASSWORD=the-password"]);
  assert.deepEqual(made.made?.Cmd, ["--host", "127.0.0.1", "--port", String(mcpPort)]);
  assert.equal(made.made?.HostConfig?.NetworkMode, "host"); // this portal is on the machine itself: no container between

  const row = (await until((s) => s.instances.some((i: any) => i.name === "uni" && i.capabilities), "the instance in the status, with what its server offers")).instances.find((i: any) => i.name === "uni");
  assert.deepEqual(row.capabilities.available, Object.fromEntries(CAPABILITIES.map((cap) => [cap.id, false]))); // the stand-in serves no tools, so nothing stands offered
  const { capabilities, ...plain } = row;
  assert.deepEqual(plain, { name: "uni", mode: "own", containerName: "pithagoras-nextcloud-mcp-uni", state: "running", address: `http://127.0.0.1:${mcpPort}/mcp`, mcp: { registered: true, on: true, url: `http://127.0.0.1:${mcpPort}/mcp` }, health: { ok: true, server: { name: "mock-nextcloud-mcp", version: "9.9.9" } }, configured: true });
});

test("a tool call goes over this instance's server and back with its answer raw", async () => {
  const answer = await fetch(`${at}/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "nc_shopping_list_get_lists", args: {}, instance: "uni" }) });
  assert.equal(answer.status, 200);
  const body = (await answer.json()) as any;
  assert.deepEqual(body.content?.[0], { type: "text", text: '{"lists":[{"id":7,"name":"Einkaufen"}]}' });
  assert.ok(seen.tools_call > 0, "the call stood at the stand-in server");
});

test("a save with nothing changed makes nothing again; one that changes the password remakes the container where it stands", async () => {
  await fetch(`${at}/instances`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "uni", url: "https://cloud.uni.example", username: "anna@uni.example", password: "the-password" }) });
  assert.equal(docker.created.length, 1, "nothing made again where nothing changed");

  await fetch(`${at}/instances`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "uni", url: "https://cloud.uni.example", username: "anna@uni.example", password: "the-other" }) });
  const uni = ncContainer("pithagoras-nextcloud-mcp-uni");
  assert.equal(uni.made?.Env?.find((e) => e.startsWith("NEXTCLOUD_PASSWORD=")), "NEXTCLOUD_PASSWORD=the-other");
  assert.deepEqual(uni.made?.Cmd, ["--host", "127.0.0.1", "--port", String(mcpPort)], "remade where it stood: the port stands as it was");
  assert.equal(docker.created.length, 2);
});

test("a removed instance leaves nothing of it: its container goes, and no one may call its tools with it gone", async () => {
  const answer = await fetch(`${at}/instances/remove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "uni" }) });
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).instances, []);
  assert.equal(ncContainer("pithagoras-nextcloud-mcp-uni"), undefined, "its container is gone");

  const no = await fetch(`${at}/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "nc_shopping_list_get_lists", args: {}, instance: "uni" }) });
  assert.equal(no.status, 409);
});

test("a second instance gets a container of its own, and the port the first one gave up is given out again", async () => {
  const answer = await fetch(`${at}/instances`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "second", url: "https://cloud.second.example", username: "bob@second.example", password: "the-second" }) });
  assert.equal(answer.status, 200);
  const made = ncContainer("pithagoras-nextcloud-mcp-second");
  assert.ok(made, "a container of its own stands");
  assert.equal(made.State, "running");
  assert.deepEqual(made.made?.Cmd, ["--host", "127.0.0.1", "--port", String(mcpPort)], "the first's freed port is the lowest free one again");

  const row = (await until((s) => s.instances.some((i: any) => i.name === "second"), "the second instance in the status")).instances.find((i: any) => i.name === "second");
  assert.equal(row.mode, "own");
  assert.equal(row.address, `http://127.0.0.1:${mcpPort}/mcp`);
  assert.equal(row.mcp.registered, true);
  assert.deepEqual(row.health, { ok: true, server: { name: "mock-nextcloud-mcp", version: "9.9.9" } }, "the stand-in answers on that port as it always does");
});
