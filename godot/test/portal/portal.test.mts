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
 * stood in for on its port on 127.0.0.1, where the forwarder would publish it for a portal on the host's network. Its
 * routes are served as the portal serves an extension's, under /api/x/@pithagoras/godot,
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

// Docker, stood in for: the portal's own container, on the host's network as both of Pithagoras' Compose files run it
// (the way to the server is then a forwarder), and nvidia-smi in the GPU probe.
const { fakeDocker } = await import(from("extensions/docker/test/fake-docker.ts"));
const docker = await fakeDocker();
process.env.DOCKER_SOCKET = docker.socket;
process.env.PORTAL_CONTAINER_NAME = "portal-test";
const portalContainer = (id: string, mode: string) => ({ Id: id, Name: "portal-test", Image: "pithagoras", State: "running", Labels: {}, Tty: false, out: "", err: "", HostConfig: { NetworkMode: mode } });
docker.containers.push(portalContainer("portal-1", "host"));
docker.images.add("ubuntu:24.04");
docker.images.add("ghcr.io/prometheion/pithagoras-godot:0.1.0");
// The forwarder's image (Docker for extensions' forward.ts).
docker.images.add("node:22.23.4-alpine3.23");
docker.runs.onStart = (c: { Name: string; out: string; code?: number }) => {
  if (!c.Name.endsWith("-probe")) return new Promise<void>(() => {});
  c.out = "0, GPU-aaaa0000, NVIDIA GeForce RTX 3060, 11000, 12288\n1, GPU-bbbb1111, NVIDIA GeForce RTX 3060, 158, 12288\n";
  c.code = 0;
};

const data = () => realpathSync(path.join(process.env.DATA_DIR!, "extension-data", "%40pithagoras%2Fgodot"));
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
const at = `http://127.0.0.1:${port}/api/x/%40pithagoras/godot`;
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
  for (const { name, factory } of host.hostExtensions(chatId)) if (name === "@pithagoras/godot") factory({ registerTool: (tool: any) => (tools[tool.name] = tool) });
  return tools;
};

test("it waits for Docker for extensions, as its package.json requires, and starts once Docker's half runs", async () => {
  await host.syncServerHalves([halves.godot]);
  assert.equal(host.isServing("@pithagoras/godot"), false);
  assert.match(host.serverFailure("@pithagoras/godot") ?? "", /It needs pithagoras-docker \(\^1\.3\.0\), which is not installed, or is switched off/);
  await host.syncServerHalves([halves.docker, halves.godot]);
  assert.equal(host.serverFailure("@pithagoras/godot"), undefined);
  assert.deepEqual([host.isServing("pithagoras-docker"), host.isServing("@pithagoras/godot")], [true, true]);
  assert.equal((await state()).state, "absent");
});

test("Install against the daemon: the GPU probe made, read and removed, then the container on a network of its own, and the forwarder", async () => {
  const answer = await fetch(`${at}/install`, { method: "POST", headers: { origin: new URL(at).origin } });
  assert.deepEqual(await answer.json(), { ok: true });
  const s = await until((s) => s.state === "running", "running");
  assert.equal(s.card, "GPU-bbbb1111", "the card with the most free memory");
  const probe = docker.created.find((c: { Name: string }) => c.Name === "pithagoras-godot-probe");
  assert.ok(probe, "the probe was made");
  assert.deepEqual((probe.made.HostConfig as any).DeviceRequests, [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }]);
  assert.ok(!docker.containers.some((c: { Name: string }) => c.Name === "pithagoras-godot-probe"), "and removed");
  const made = container().made as any;
  assert.equal(made.HostConfig.NetworkMode, "pithagoras-godot-net");
  assert.ok(made.Env.includes("GODOT_SERVER_HOST=0.0.0.0"));
  assert.deepEqual(made.HostConfig.RestartPolicy, { Name: "unless-stopped" });
  assert.equal(container().Labels["pithagoras.extension"], "@pithagoras/godot", "Docker for extensions' own label: the container is Godot's");
  assert.ok(docker.volumes.some((v: { Name: string }) => v.Name === "pithagoras-godot-data"));
  // Its network: Docker's bridge with no way out, the extension's.
  const island = docker.networks.find((n: { Name: string }) => n.Name === "pithagoras-godot-net")!;
  assert.deepEqual([island.Internal, island.EnableIPv6, island.Options!["com.docker.network.bridge.gateway_mode_ipv4"], island.Labels["pithagoras.extension"]], [true, false, "isolated", "@pithagoras/godot"]);
  // The portal is on the host's network, to which Docker adds none: the forwarder publishes the port on 127.0.0.1.
  const forwarder = docker.containers.find((c: { Name: string }) => c.Name === "pithagoras-godot-forward")!;
  assert.equal(forwarder.State, "running");
  assert.equal(forwarder.Labels["pithagoras.extension"], "@pithagoras/godot");
  assert.deepEqual((forwarder.made as any).HostConfig.PortBindings, { [`${server.port}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(server.port) }] });
  assert.deepEqual(docker.connects, [], "the portal's container is not connected to anything");
});

test("the relayed tools as the portal lists them in Settings → Tools and gives them to a chat's pi", async () => {
  const names = TOOLS.map((t) => `godot_${t.name}`).sort();
  assert.deepEqual(host.offeredTools().get("@pithagoras/godot").map((t: { name: string }) => t.name).sort(), names);
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
    [`GET /api/x/%40pithagoras/godot/ui/stream/api/websockets HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Origin: http://127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="].join("\r\n") + "\r\n\r\n",
  );
  await once(socket, "close");
  assert.match(text, /^HTTP\/1\.1 101 /);
  assert.match(text, /hello from the stream/);
  const [asked] = server.upgrades;
  assert.equal(asked.url, "/stream/api/websockets");
  assert.equal(asked.headers.origin, undefined);
  assert.equal(asked.headers.authorization, `Bearer ${token()}`);
});

test("for a portal in a container of its own network, its container is put on the server's network, and nothing is published", async () => {
  const before = container().Id;
  // The portal's container made again, on Docker's bridge: a new run of the halves asks the way to the server anew.
  docker.containers.splice(docker.containers.findIndex((c: { Name: string }) => c.Name === "portal-test"), 1, portalContainer("portal-2", "bridge"));
  await host.syncServerHalves([]);
  await host.syncServerHalves([halves.docker, halves.godot]);
  for (let i = 0; i < 300 && !docker.connects.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(docker.connects, [{ network: "pithagoras-godot-net", container: "portal-test" }]);
  assert.ok(docker.containers.find((c: { Name: string }) => c.Name === "portal-test").Networks?.["pithagoras-godot-net"], "the portal's container is on it");
  assert.ok(!docker.containers.some((c: { Name: string }) => c.Name === "pithagoras-godot-forward"), "no forwarder: it would hold the port for nothing");
  assert.ok(docker.containers.every((c: any) => !c.made?.HostConfig?.PortBindings), "nothing is published");
  assert.equal(container().Id, before, "the server goes on as it was");
});

test("Remove with the projects: the container, its network and the volume go, and so do the tools", async () => {
  const answer = await fetch(`${at}/uninstall`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(at).origin }, body: JSON.stringify({ removeData: true }) });
  assert.deepEqual(await answer.json(), { ok: true });
  assert.equal(container(), undefined);
  assert.ok(!docker.networks.some((n: { Name: string }) => n.Name === "pithagoras-godot-net"));
  assert.equal(docker.containers.find((c: { Name: string }) => c.Name === "portal-test").Networks?.["pithagoras-godot-net"], undefined, "the portal's container is taken off it");
  assert.ok(!docker.volumes.some((v: { Name: string }) => v.Name === "pithagoras-godot-data"));
  assert.deepEqual(host.offeredTools().get("@pithagoras/godot"), []);
  assert.deepEqual(Object.keys(chatTools("chat-1")), []);
});
