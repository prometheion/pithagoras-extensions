import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Blender as Pithagoras runs it: its server half started by the portal's own extension host, after Docker's, which it
 * requires, each from its source as the portal reads a package, Docker speaking to the portal's own fake daemon
 * (extensions/docker/test/fake-docker.ts), never to one on the machine, and a stand-in for the Blender server on the
 * server's port. As Voice's portal tests do, against the Pithagoras this repository builds with: fetch and build it with
 * scripts/pithagoras.sh, then PITHAGORAS_DIR=.pithagoras npm run test:portal.
 */

const DIR = process.env.PITHAGORAS_DIR;
if (!DIR) throw new Error("PITHAGORAS_DIR is not set: run scripts/pithagoras.sh, then PITHAGORAS_DIR=.pithagoras npm run test:portal");
const PITHAGORAS = path.resolve(DIR);
const from = (file: string) => pathToFileURL(path.join(PITHAGORAS, file)).href;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, "../..");

const { inProcessHome } = await import(from("tests/helpers.mts"));
inProcessHome("flair-blender-portal-");
const { fakeDocker } = await import(from("extensions/docker/test/fake-docker.ts"));
const daemon = await fakeDocker();
process.env.DOCKER_SOCKET = daemon.socket;
process.env.PORTAL_CONTAINER_NAME = "portal-test";
process.env.PORTAL_PASSWORD = "";
process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
daemon.containers.push({ Id: "portal-one", Name: "portal-test", Image: "pithagoras-portal:latest", State: "running", Labels: {}, Tty: false, out: "", err: "" });
daemon.images.add("ghcr.io/thecodacus/pithagoras-blender:0.1.0");
daemon.images.add("ubuntu:24.04");
// The probe prints the cards it was given and exits; the Blender container runs until it is stopped.
daemon.runs.onStart = (c: { Name: string; out: string; code?: number }) => {
  if (c.Name !== "pithagoras-blender-probe") return new Promise<void>(() => {});
  c.out = "0, GPU-1b1b1b1b, NVIDIA GeForce RTX 3060, 158, 12288\nOPTIX=host\n";
  c.code = 0;
};

// The extension's token, made before the half starts, so that the stand-in server takes it.
const TOKEN = "f".repeat(48);
const data = path.join(process.env.DATA_DIR!, "extension-data", "pithagoras-blender");
mkdirSync(data, { recursive: true, mode: 0o700 });
writeFileSync(path.join(data, "settings.json"), JSON.stringify({ token: TOKEN }), { mode: 0o600 });

/** The Blender server, as far as the half asks it: MCP with the token, and the viewer's own state. */
const bundled = JSON.parse(readFileSync(path.join(PACKAGE, "server/tools.json"), "utf8"));
const tools = bundled.tools;
const blender = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url !== "/mcp") return void res.end(JSON.stringify({ gpu: "OPTIX", denoiser: "OPTIX", path: req.url }));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result =
      message.method === "initialize" ? { instructions: "Use Blender.", serverInfo: { version: "5.2.2" } }
      : message.method === "tools/list" ? { tools }
      : message.method === "tools/call" ? { content: [{ type: "text", text: "pong" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }
      : {};
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
});
blender.listen(0, "127.0.0.1");
await once(blender, "listening");
process.env.PITHAGORAS_BLENDER_PORT = String((blender.address() as AddressInfo).port);

const host = await import(from("core/server/dist/extension-host.js"));
const { requiresOf } = await import(from("core/server/dist/extension-ui.js"));
const db = await import(from("core/server/dist/db.js"));
db.getDb();
const half = (folder: string, file: string) => {
  const meta = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8"));
  return { name: meta.name, version: meta.version, file: path.join(folder, file), rev: meta.version, requires: requiresOf(meta) };
};
const docker = half(path.join(PITHAGORAS, "extensions/docker"), "src/server.ts");
const own = half(PACKAGE, "src/server.ts");

const express = (await import(pathToFileURL(path.join(PITHAGORAS, "node_modules/express/index.js")).href)).default;
const app = express().use("/api/x", host.extensionRoutes);
const server = http.createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/x/pithagoras-blender`;
after(async () => {
  await host.stopServerHalves();
  server.closeAllConnections();
  blender.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => blender.close(resolve));
  await daemon.close();
});

/** A request of the Settings page's: from the portal's own origin, as a browser says it. */
const json = async (url: string, init?: RequestInit) => {
  const answer = await fetch(url, { ...init, headers: { "content-type": "application/json", origin: new URL(at).origin, ...init?.headers } });
  return { status: answer.status, body: await answer.json() };
};
const state = async () => (await json(`${at}/state`)).body;
const chat = () => {
  const id = `flair-${Math.random().toString(36).slice(2)}`;
  db.createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind: "task" });
  return id;
};
/** The tools the server halves register in a chat's pi, as a stand-in pi takes them. */
const registered = (chatId: string) => {
  const found: any[] = [];
  for (const { factory } of host.hostExtensions(chatId)) factory({ registerTool: (tool: any) => found.push(tool), on() {}, registerCommand() {} });
  return found.filter((t) => t.name.startsWith("blender_"));
};

test("the half waits for Docker, which it requires", async () => {
  await host.syncServerHalves([own]);
  assert.match(String(host.serverFailure("pithagoras-blender")), /pithagoras-docker/);
  await host.syncServerHalves([docker, own]);
  assert.equal(host.serverFailure("pithagoras-blender"), undefined);
  assert.equal(host.isServing("pithagoras-blender"), true);
});

test("Settings → Blender from install to running, through the portal's routes and Docker's own API", async () => {
  assert.equal((await state()).state, "absent");
  const hardware = (await json(`${at}/hardware`)).body;
  assert.deepEqual(hardware.cards.map((c: { uuid: string }) => c.uuid), ["GPU-1b1b1b1b"]);
  assert.equal(daemon.containers.some((c: { Name: string }) => c.Name === "pithagoras-blender-probe"), false, "the probe is removed");
  assert.equal((await json(`${at}/install`, { method: "POST" })).status, 200);
  let now = await state();
  for (let i = 0; i < 300 && now.state !== "running"; i++) {
    await delay(20);
    now = await state();
  }
  assert.equal(now.state, "running");
  assert.equal(now.card, "GPU-1b1b1b1b");
  const made = daemon.containers.find((c: { Name: string }) => c.Name === "pithagoras-blender")!.made as any;
  assert.equal(made.HostConfig.NetworkMode, "container:portal-one");
  assert.deepEqual(made.HostConfig.RestartPolicy, { Name: "unless-stopped" });
  assert.equal(made.Labels["pithagoras.extension"], "pithagoras-blender", "Docker's API marks it as the extension's");
  assert.ok(daemon.volumes.some((v: { Name: string }) => v.Name === "pithagoras-blender-data"));
});

test("the relayed tools are listed in Settings → Tools and registered in a chat's pi, and a call returns the server's parts", async () => {
  for (let i = 0; i < 200 && !(host.offeredTools().get("pithagoras-blender") ?? []).length; i++) await delay(20);
  const offered = host.offeredTools().get("pithagoras-blender") ?? [];
  assert.deepEqual(offered.map((t: { name: string }) => t.name).sort(), tools.map((t: { name: string }) => `blender_${t.name}`).sort());
  const inChat = registered(chat());
  assert.equal(inChat.length, tools.length);
  const ping = inChat.find((t) => t.name === "blender_ping");
  assert.deepEqual(ping.guard, { outside: true });
  assert.deepEqual(ping.promptGuidelines, [bundled.instructions], "the extension's own instructions, not what the server says");
  assert.deepEqual(inChat.find((t) => t.name === "blender_execute_code").guard, { outside: true, acts: ["upload"] });
  const result = await ping.execute("call-1", {});
  assert.deepEqual(result.content, [{ type: "text", text: "pong" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
});

test("the viewer is the extension's page, its API is the server's, sandboxed, and a stream is not this extension's", async () => {
  const page = await fetch(`${at}/ui/`);
  assert.equal(await page.text(), readFileSync(path.join(PACKAGE, "src/viewer.html"), "utf8"));
  const answer = await fetch(`${at}/ui/api/state`);
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).path, "/api/state");
  assert.equal(answer.headers.get("content-security-policy"), "frame-ancestors 'self', sandbox");
  assert.equal(host.extensionUpgrade("/api/x/pithagoras-blender/ui/stream"), undefined);
});

test("a change from another page of the same site is refused on the extension's routes, as the portal serves them", async () => {
  const other = `http://${new URL(at).hostname}:9999`;
  assert.equal((await json(`${at}/stop`, { method: "POST", headers: { origin: other } })).status, 403);
  assert.equal((await json(`${at}/ui/api/project`, { method: "POST", headers: { origin: other }, body: '{"action":"save"}' })).status, 403);
  assert.equal((await state()).state, "running");
});

test("a container left on the portal's old network is made again on its new one, with the volume kept", async () => {
  // The portal's container was made again: another id under its name.
  const at0 = daemon.containers.findIndex((c: { Name: string }) => c.Name === "portal-test");
  daemon.containers.splice(at0, 1);
  daemon.containers.push({ Id: "portal-two", Name: "portal-test", Image: "pithagoras-portal:latest", State: "running", Labels: {}, Tty: false, out: "", err: "" });
  await state();
  for (let i = 0; i < 300; i++) {
    const made = daemon.containers.find((c: { Name: string }) => c.Name === "pithagoras-blender")?.made as any;
    if (made?.HostConfig.NetworkMode === "container:portal-two" && (await state()).state === "running") break;
    await delay(20);
  }
  const made = daemon.containers.find((c: { Name: string }) => c.Name === "pithagoras-blender")!.made as any;
  assert.equal(made.HostConfig.NetworkMode, "container:portal-two");
  assert.ok(daemon.volumes.some((v: { Name: string }) => v.Name === "pithagoras-blender-data"));
});

test("uninstall with the projects removes the container, the volume and the tools", async () => {
  assert.equal((await json(`${at}/uninstall`, { method: "POST", body: JSON.stringify({ removeData: true }) })).status, 200);
  assert.equal(daemon.containers.some((c: { Name: string }) => c.Name === "pithagoras-blender"), false);
  assert.equal(daemon.volumes.some((v: { Name: string }) => v.Name === "pithagoras-blender-data"), false);
  assert.deepEqual(host.offeredTools().get("pithagoras-blender"), []);
  assert.deepEqual(registered(chat()), []);
  assert.equal(realpathSync(data).length > 0, true);
});
