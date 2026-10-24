import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { fakeMcp, TOOLS } from "../fakes.mts";

/**
 * Godot as a portal runs it: its server half started by Pithagoras' own extension host, after Docker for extensions'
 * (which it requires), each from its package as the portal reads it, with Docker speaking to the daemon of
 * Pithagoras' own tests (extensions/docker/test/fake-docker.ts), never to one on the machine, and the Godot server
 * stood in for on its port. Its routes are served as the portal serves an extension's, under /api/x/pithagoras-godot,
 * and its stream as the portal hands an extension its upgrades.
 *
 * Needs a Pithagoras checkout at the version this extension is built for, with its server built:
 * `scripts/pithagoras.sh` makes one in .pithagoras/, and `PITHAGORAS_DIR` names it.
 */

const DIR = process.env.PITHAGORAS_DIR;
if (!DIR || !existsSync(path.join(DIR, "core/server/dist/extension-host.js"))) {
  throw new Error("PITHAGORAS_DIR must name a Pithagoras checkout with core/server built: scripts/pithagoras.sh makes one");
}
const from = (file: string) => pathToFileURL(path.join(DIR, file)).href;

const { inProcessHome } = await import(from("core/server/test/server-harness.mjs"));
inProcessHome("flair-godot-portal-");
process.env.PORTAL_PASSWORD = "";
process.env.PORTAL_ALLOW_NO_PASSWORD = "1";

// Docker, stood in for: the portal's own container to share the network of, and nvidia-smi in the GPU probe.
const { fakeDocker } = await import(from("extensions/docker/test/fake-docker.ts"));
const docker = await fakeDocker();
process.env.DOCKER_SOCKET = docker.socket;
process.env.PORTAL_CONTAINER_NAME = "portal-test";
const portalContainer = (id: string) => ({ Id: id, Name: "portal-test", Image: "pithagoras", State: "running", Labels: {}, Tty: false, out: "", err: "" });
docker.containers.push(portalContainer("portal-1"));
docker.images.add("ubuntu:24.04");
docker.images.add("ghcr.io/thecodacus/pithagoras-godot:0.1.0");
docker.runs.onStart = (c: { Name: string; out: string; code?: number }) => {
  if (!c.Name.endsWith("-probe")) return new Promise<void>(() => {});
  c.out = "0, GPU-aaaa0000, NVIDIA GeForce RTX 3060, 11000, 12288\n1, GPU-bbbb1111, NVIDIA GeForce RTX 3060, 158, 12288\n";
  c.code = 0;
};

const data = () => realpathSync(path.join(process.env.DATA_DIR!, "extension-data", "pithagoras-godot"));
const token = () => JSON.parse(readFileSync(path.join(data(), "settings.json"), "utf8")).token as string;
const server = await fakeMcp(token);
process.env.PITHAGORAS_GODOT_PORT = String(server.port);

const host = await import(from("core/server/dist/extension-host.js"));
const db = await import(from("core/server/dist/db.js"));
db.getDb();
const { requiresOf } = await import(from("core/server/dist/extension-ui.js"));
const halfOf = (folder: string, file: string) => {
  const meta = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8"));
  return { name: meta.name as string, version: meta.version as string, file: path.join(folder, file), rev: meta.version as string, requires: requiresOf(meta) };
};
const halves = { docker: halfOf(path.join(DIR, "extensions/docker"), "src/server.ts"), godot: halfOf(path.resolve(import.meta.dirname, "../.."), "src/server.ts") };

const { attachUpgrades } = await import(from("core/server/dist/upgrades.js"));
const app = express().use("/api/x", host.extensionRoutes);
const portal = http.createServer(app);
attachUpgrades(portal);
portal.listen(0, "127.0.0.1");
await once(portal, "listening");
const port = (portal.address() as AddressInfo).port;
const at = `http://127.0.0.1:${port}/api/x/pithagoras-godot`;
after(async () => {
  await host.stopServerHalves();
  http.globalAgent.destroy();
  portal.closeAllConnections();
  portal.close();
  await server.close();
  await docker.close();
});

const state = async () => (await fetch(`${at}/state`)).json();
const until = async (check: (s: any) => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    const s = await state();
    if (check(s)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`never: ${what}`);
};
const container = () => docker.containers.find((c: { Name: string }) => c.Name === "pithagoras-godot");
/** The Godot tools a chat's pi is given as it loads, by name, as the portal gives them (Docker's own are left out). */
const chatTools = (chatId: string) => {
  const tools: Record<string, any> = {};
  for (const { name, factory } of host.hostExtensions(chatId)) if (name === "pithagoras-godot") factory({ registerTool: (tool: any) => (tools[tool.name] = tool) });
  return tools;
};

test("it waits for Docker for extensions, as its package.json requires, and starts once Docker's half runs", async () => {
  await host.syncServerHalves([halves.godot]);
  assert.equal(host.isServing("pithagoras-godot"), false);
  assert.match(host.serverFailure("pithagoras-godot") ?? "", /It needs pithagoras-docker \(\^1\.2\.0\), which is not installed, or is switched off/);
  await host.syncServerHalves([halves.docker, halves.godot]);
  assert.equal(host.serverFailure("pithagoras-godot"), undefined);
  assert.deepEqual([host.isServing("pithagoras-docker"), host.isServing("pithagoras-godot")], [true, true]);
  assert.equal((await state()).state, "absent");
});

test("Install against the daemon: the GPU probe made, read and removed, then the container on the portal's network", async () => {
  const answer = await fetch(`${at}/install`, { method: "POST", headers: { origin: new URL(at).origin } });
  assert.deepEqual(await answer.json(), { ok: true });
  const s = await until((s) => s.state === "running", "running");
  assert.equal(s.card, "GPU-bbbb1111", "the card with the most free memory");
  const probe = docker.created.find((c: { Name: string }) => c.Name === "pithagoras-godot-probe");
  assert.ok(probe, "the probe was made");
  assert.deepEqual((probe.made.HostConfig as any).DeviceRequests, [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }]);
  assert.ok(!docker.containers.some((c: { Name: string }) => c.Name === "pithagoras-godot-probe"), "and removed");
  const made = container().made as any;
  assert.equal(made.HostConfig.NetworkMode, "container:portal-1");
  assert.deepEqual(made.HostConfig.RestartPolicy, { Name: "unless-stopped" });
  assert.equal(container().Labels["pithagoras.extension"], "pithagoras-godot", "Docker for extensions' own label: the container is Godot's");
  assert.ok(docker.volumes.some((v: { Name: string }) => v.Name === "pithagoras-godot-data"));
});

test("the relayed tools as the portal lists them in Settings → Tools and gives them to a chat's pi", async () => {
  const names = TOOLS.map((t) => `godot_${t.name}`).sort();
  assert.deepEqual(host.offeredTools().get("pithagoras-godot").map((t: { name: string }) => t.name).sort(), names);
  db.createSession({ id: "chat-1", title: "A chat", workspace: process.env.WORKSPACE_ROOT!, executor: "host" });
  const tools = chatTools("chat-1");
  assert.deepEqual(Object.keys(tools).sort(), names);
  assert.deepEqual(tools.godot_execute_gdscript.guard, { outside: true, acts: ["upload"] });
  server.answers.set("ping", { content: [{ type: "text", text: '{"server": "godot-server"}' }], isError: false });
  const result = await tools.godot_ping.execute("call-1", {}, undefined);
  assert.deepEqual(result.content, [{ type: "text", text: '{"server": "godot-server"}' }]);
});

test("the stream reaches the server through the portal's upgrade, without its Origin and with the server's token", async () => {
  const socket = net.connect(port, "127.0.0.1");
  let text = "";
  socket.on("data", (d) => (text += d));
  socket.write(
    [`GET /api/x/pithagoras-godot/ui/stream/api/websockets HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Origin: http://127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="].join("\r\n") + "\r\n\r\n",
  );
  await once(socket, "close");
  assert.match(text, /^HTTP\/1\.1 101 /);
  assert.match(text, /hello from the stream/);
  const [asked] = server.upgrades;
  assert.equal(asked.url, "/stream/api/websockets");
  assert.equal(asked.headers.origin, undefined);
  assert.equal(asked.headers.authorization, `Bearer ${token()}`);
});

test("after the portal's container is made again, a running server is made again on its new network, keeping the volume", async () => {
  const before = container().Id;
  docker.containers.splice(docker.containers.findIndex((c: { Name: string }) => c.Name === "portal-test"), 1, portalContainer("portal-2"));
  // A start of the halves looks after the container at once, as the maintain loop does every 30 seconds.
  await host.syncServerHalves([]);
  await host.syncServerHalves([halves.docker, halves.godot]);
  await until(() => container()?.Id !== before && container()?.State === "running", "made again");
  assert.equal((container().made as any).HostConfig.NetworkMode, "container:portal-2");
  assert.ok(docker.volumes.some((v: { Name: string }) => v.Name === "pithagoras-godot-data"));
});

test("Remove with the projects: the container and the volume go, and so do the tools", async () => {
  await until((s) => s.state === "running", "running");
  const answer = await fetch(`${at}/uninstall`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(at).origin }, body: JSON.stringify({ removeData: true }) });
  assert.deepEqual(await answer.json(), { ok: true });
  assert.equal(container(), undefined);
  assert.ok(!docker.volumes.some((v: { Name: string }) => v.Name === "pithagoras-godot-data"));
  assert.deepEqual(host.offeredTools().get("pithagoras-godot"), []);
  assert.deepEqual(Object.keys(chatTools("chat-1")), []);
});
