import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guidelineOf } from "../../../shared/relay.ts";

/**
 * Blender as Pithagoras runs it: its server half started by the portal's own extension host, after Docker's, which it
 * requires, each from its source as the portal reads a package, Docker speaking to the portal's own fake daemon
 * (extensions/docker/test/fake-docker.ts), never to one on the machine, and a stand-in for the Blender server on the
 * server's port on 127.0.0.1, where the forwarder would publish it for a portal on the host's network. As Voice's portal tests do, against the Pithagoras this repository builds with: fetch and build it with
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
// The portal's container, on the host's network as both of Pithagoras' Compose files run it: the way to the server is a
// forwarder.
daemon.containers.push({ Id: "portal-one", Name: "portal-test", Image: "pithagoras-portal:latest", State: "running", Labels: {}, Tty: false, out: "", err: "", HostConfig: { NetworkMode: "host" } });
daemon.images.add("ghcr.io/prometheion/pithagoras-blender:0.1.0");
daemon.images.add("ubuntu:24.04");
// The forwarder's image (Docker for extensions' forward.ts).
daemon.images.add("node:22.23.4-alpine3.23");
// The probe prints the cards it was given and exits; the Blender container and the forwarder run until they are stopped.
daemon.runs.onStart = (c: { Name: string; out: string; code?: number }) => {
  if (c.Name !== "pithagoras-blender-probe") return new Promise<void>(() => {});
  c.out = "0, GPU-1b1b1b1b, NVIDIA GeForce RTX 3060, 158, 12288\nOPTIX=host\n";
  c.code = 0;
};

// The extension's token, made before the half starts, so that the stand-in server takes it.
const TOKEN = "f".repeat(48);
const data = path.join(process.env.DATA_DIR!, "extension-data", "%40pithagoras%2Fblender");
mkdirSync(data, { recursive: true, mode: 0o700 });
writeFileSync(path.join(data, "settings.json"), JSON.stringify({ token: TOKEN }), { mode: 0o600 });

/** The Blender server, as far as the half asks it: MCP with the token, and the viewer's own state. */
const bundled = JSON.parse(readFileSync(path.join(PACKAGE, "server/tools.json"), "utf8"));
const tools = bundled.tools;
/** A whole picture, one pixel, which the portal tells by its bytes. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** What the stand-in answers a call: a render's file and picture, and for any other tool text and a picture. Each call is kept. */
const calls: { name: string; arguments: Record<string, unknown> }[] = [];
const answer = (call: { name: string; arguments: Record<string, unknown> }) => {
  calls.push(call);
  if (call.name === "render") return { content: [{ type: "text", text: '{"path": "/data/renders/render_1.png"}' }, { type: "image", data: PIXEL, mimeType: "image/png" }] };
  return { content: [{ type: "text", text: "pong" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] };
};
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
      : message.method === "tools/call" ? answer(message.params)
      : {};
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
});
blender.listen(0, "127.0.0.1");
await once(blender, "listening");
const PORT = (blender.address() as AddressInfo).port;
process.env.PITHAGORAS_BLENDER_PORT = String(PORT);

const host = await import(from("core/server/dist/extension-host.js"));
const { filesFound } = await import(from("core/server/dist/output-files.js"));
const { callSubject } = await import(from("core/server/dist/pi/guard.js"));
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
const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/x/%40pithagoras/blender`;
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
  assert.match(String(host.serverFailure("@pithagoras/blender")), /pithagoras-docker/);
  await host.syncServerHalves([docker, own]);
  assert.equal(host.serverFailure("@pithagoras/blender"), undefined);
  assert.equal(host.isServing("@pithagoras/blender"), true);
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
  assert.equal(made.HostConfig.NetworkMode, "pithagoras-blender-net");
  assert.ok(made.Env.includes("BLENDER_SERVER_HOST=0.0.0.0"));
  assert.deepEqual(made.HostConfig.RestartPolicy, { Name: "unless-stopped" });
  assert.equal(made.Labels["pithagoras.extension"], "@pithagoras/blender", "Docker's API marks it as the extension's");
  assert.ok(daemon.volumes.some((v: { Name: string }) => v.Name === "pithagoras-blender-data"));
  // Its network: Docker's bridge with no way out, the extension's.
  const island = daemon.networks.find((n: { Name: string }) => n.Name === "pithagoras-blender-net")!;
  assert.equal(island.Internal, true);
  assert.equal(island.EnableIPv6, false);
  assert.equal(island.Options!["com.docker.network.bridge.gateway_mode_ipv4"], "isolated");
  assert.equal(island.Labels["pithagoras.extension"], "@pithagoras/blender");
  // The portal is on the host's network, to which Docker adds none: the forwarder publishes the port on 127.0.0.1.
  const forwarder = daemon.containers.find((c: { Name: string }) => c.Name === "pithagoras-blender-forward")!;
  assert.equal(forwarder.State, "running");
  assert.equal(forwarder.Labels["pithagoras.extension"], "@pithagoras/blender");
  assert.deepEqual((forwarder.made as any).HostConfig.PortBindings, { [`${PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(PORT) }] });
  assert.deepEqual(Object.keys((forwarder.made as any).NetworkingConfig.EndpointsConfig).sort(), ["pithagoras-blender-forward", "pithagoras-blender-net"]);
  assert.deepEqual(daemon.connects, [], "the portal's container is not connected to anything");
});

test("the relayed tools are listed in Settings → Tools and registered in a chat's pi, and a call returns the server's parts", async () => {
  for (let i = 0; i < 200 && !(host.offeredTools().get("@pithagoras/blender") ?? []).length; i++) await delay(20);
  const offered = host.offeredTools().get("@pithagoras/blender") ?? [];
  assert.deepEqual(offered.map((t: { name: string }) => t.name).sort(), tools.map((t: { name: string }) => `blender_${t.name}`).sort());
  const inChat = registered(chat());
  assert.equal(inChat.length, tools.length);
  const ping = inChat.find((t) => t.name === "blender_ping");
  assert.deepEqual(ping.guard, { outside: true });
  assert.deepEqual(ping.promptGuidelines, [guidelineOf(bundled.instructions, tools.map((t: { name: string }) => t.name), "blender")], "the extension's own instructions, in the chat's names, not what the server says");
  assert.deepEqual(inChat.find((t) => t.name === "blender_execute_code").guard, { outside: true, acts: ["upload"] });
  const result = await ping.execute("call-1", {});
  assert.deepEqual(result.content, [{ type: "text", text: "pong" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
});

test("a render is put in the chat's folder, and the portal takes the file the call gives as a picture for the chat", async () => {
  const id = chat();
  const render = registered(id).find((t) => t.name === "blender_render");
  const result = await render.execute("call-2", { return_image: false });
  assert.equal(calls.at(-1)!.arguments.return_image, true, "the server is asked for the picture");
  assert.deepEqual(result.content.map((p: { type: string }) => p.type), ["text", "text"], "the model asked for none");
  // The chat's folder: the workspace it was made with.
  const folder = realpathSync(process.env.WORKSPACE_ROOT!);
  // What the portal finds of the call's files when it ends, as the chat draws them.
  const shown = filesFound(folder, result.details);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].kind, "picture");
  assert.equal(shown[0].title, "render_1.png");
  assert.match(shown[0].path, /^blender-renders\/render-.+\.png$/);
  assert.deepEqual(readFileSync(path.join(folder, shown[0].path)), Buffer.from(PIXEL, "base64"));
});

test("a render is not written into a link put where its folder is, to another folder of the chat's", async () => {
  const id = chat();
  const render = registered(id).find((t) => t.name === "blender_render");
  const folder = realpathSync(process.env.WORKSPACE_ROOT!);
  // Inside the chat's folder, where the portal would follow the link: one outside it the portal refuses of itself.
  const elsewhere = mkdtempSync(path.join(folder, "flair-elsewhere-"));
  renameSync(path.join(folder, "blender-renders"), path.join(folder, "blender-renders.kept"));
  symlinkSync(elsewhere, path.join(folder, "blender-renders"));
  try {
    const result = await render.execute("call-6", {});
    assert.deepEqual(result.details, {});
    assert.match(result.content.at(-1).text, /^The render could not be shown in the chat: /);
    assert.deepEqual(readdirSync(elsewhere), []);
  } finally {
    rmSync(path.join(folder, "blender-renders"));
    renameSync(path.join(folder, "blender-renders.kept"), path.join(folder, "blender-renders"));
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a script is run by its path, read from the chat's folder through the portal's own files before the guard looks, and refused outside it", async () => {
  const id = chat();
  const run = registered(id).find((t) => t.name === "blender_execute_code");
  const folder = realpathSync(process.env.WORKSPACE_ROOT!);
  mkdirSync(path.join(folder, "scripts"), { recursive: true });
  const tower = "for i in range(ARGS['floors']):\n    bpy.ops.mesh.primitive_cube_add(location=(0, 0, i))\n";
  writeFileSync(path.join(folder, "scripts/tower.py"), tower);
  // As pi makes the call: its arguments prepared, then the guard, then the tool. What the guard asks the person about
  // after a suspected prompt injection is the call as the guard names it: the script's code and its args.
  const prepared = run.prepareArguments({ path: "scripts/tower.py", args: { floors: 4 } });
  const subject = callSubject("blender_execute_code", prepared);
  assert.ok(subject.includes("primitive_cube_add(location=(0, 0, i))") && subject.includes('"floors":4'), subject);
  await run.execute("call-3", prepared);
  assert.deepEqual(calls.at(-1), { name: "execute_code", arguments: { args: { floors: 4 }, code: tower, script_name: "scripts/tower.py" } });
  const before = calls.length;
  assert.throws(() => run.prepareArguments({ path: "../outside.py" }), /is not in this chat's folder/);
  assert.throws(() => run.prepareArguments({ path: "scripts/none.py" }), /There is no file scripts\/none\.py in this chat's folder/);
  assert.equal(calls.length, before, "Blender was asked nothing for those");
});

test("the viewer is the extension's page, its API is the server's, sandboxed, and a stream is not this extension's", async () => {
  const page = await fetch(`${at}/ui/`);
  assert.equal(await page.text(), readFileSync(path.join(PACKAGE, "src/viewer.html"), "utf8"));
  const answer = await fetch(`${at}/ui/api/state`);
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).path, "/api/state");
  assert.equal(answer.headers.get("content-security-policy"), "frame-ancestors 'self', sandbox");
  assert.equal(host.extensionUpgrade("/api/x/%40pithagoras/blender/ui/stream"), undefined);
});

test("a change from another page of the same site is refused on the extension's routes, as the portal serves them", async () => {
  const other = `http://${new URL(at).hostname}:9999`;
  assert.equal((await json(`${at}/stop`, { method: "POST", headers: { origin: other } })).status, 403);
  assert.equal((await json(`${at}/ui/api/project`, { method: "POST", headers: { origin: other }, body: '{"action":"save"}' })).status, 403);
  assert.equal((await state()).state, "running");
});

test("for a portal in a container of its own network, its container is put on the server's network, and nothing is published", async () => {
  // The portal's container made again, on Docker's bridge: a new run of the halves asks the way to the server anew.
  daemon.containers.splice(daemon.containers.findIndex((c: { Name: string }) => c.Name === "portal-test"), 1);
  daemon.containers.push({ Id: "portal-two", Name: "portal-test", Image: "pithagoras-portal:latest", State: "running", Labels: {}, Tty: false, out: "", err: "", HostConfig: { NetworkMode: "bridge" } });
  const server = daemon.containers.find((c: { Name: string }) => c.Name === "pithagoras-blender")!.Id;
  await host.syncServerHalves([]);
  await host.syncServerHalves([docker, own]);
  for (let i = 0; i < 300 && !daemon.connects.length; i++) await delay(20);
  assert.deepEqual(daemon.connects, [{ network: "pithagoras-blender-net", container: "portal-test" }]);
  assert.ok(daemon.containers.find((c: { Name: string }) => c.Name === "portal-test")!.Networks?.["pithagoras-blender-net"], "the portal's container is on it");
  assert.equal(daemon.containers.some((c: { Name: string }) => c.Name === "pithagoras-blender-forward"), false, "no forwarder: it would hold the port for nothing");
  assert.equal(daemon.networks.some((n: { Name: string }) => n.Name === "pithagoras-blender-forward"), false);
  assert.ok(daemon.containers.every((c: any) => !c.made?.HostConfig?.PortBindings), "nothing is published");
  assert.equal(daemon.containers.find((c: { Name: string }) => c.Name === "pithagoras-blender")!.Id, server, "the server goes on as it was");
});

test("uninstall with the projects removes the container, its network, the volume and the tools", async () => {
  assert.equal((await json(`${at}/uninstall`, { method: "POST", body: JSON.stringify({ removeData: true }) })).status, 200);
  assert.equal(daemon.containers.some((c: { Name: string }) => c.Name === "pithagoras-blender"), false);
  assert.equal(daemon.networks.some((n: { Name: string }) => n.Name === "pithagoras-blender-net"), false);
  assert.equal(daemon.containers.find((c: { Name: string }) => c.Name === "portal-test")!.Networks?.["pithagoras-blender-net"], undefined, "the portal's container is taken off it");
  assert.equal(daemon.volumes.some((v: { Name: string }) => v.Name === "pithagoras-blender-data"), false);
  assert.deepEqual(host.offeredTools().get("@pithagoras/blender"), []);
  assert.deepEqual(registered(chat()), []);
  assert.equal(realpathSync(data).length > 0, true);
});
