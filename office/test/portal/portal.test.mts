import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { templateDocx } from "../../src/store.ts";

/**
 * Office as Pithagoras runs it: its server half started by the portal's own extension host, after Docker's, which it
 * requires, each from its source as the portal reads a package, Docker speaking to the portal's own fake daemon
 * (extensions/docker/test/fake-docker.ts), never to one on the machine, and a stand-in for the Document Server on the
 * relay's port on 127.0.0.1, where the forwarder would publish it for a portal on the host's network. As Blender's
 * portal tests do, against the Pithagoras this repository builds with: fetch and build it with scripts/pithagoras.sh,
 * then PITHAGORAS_DIR=.pithagoras npm run test:portal. The real Document Server is e2e.test.mts's.
 */

const DIR = process.env.PITHAGORAS_DIR;
if (!DIR) throw new Error("PITHAGORAS_DIR is not set: run scripts/pithagoras.sh, then PITHAGORAS_DIR=.pithagoras npm run test:portal");
const PITHAGORAS = path.resolve(DIR);
const from = (file: string) => pathToFileURL(path.join(PITHAGORAS, file)).href;
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGE = "onlyoffice/documentserver:10.0.0.1";

const { inProcessHome } = await import(from("tests/helpers.mts"));
inProcessHome("office-portal-");
const { fakeDocker } = await import(from("extensions/docker/test/fake-docker.ts"));
const daemon = await fakeDocker();
process.env.DOCKER_SOCKET = daemon.socket;
process.env.PORTAL_CONTAINER_NAME = "portal-test";
process.env.PORTAL_PASSWORD = "";
process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
// The portal's container, on the host's network as both of Pithagoras' Compose files run it: the way in is a
// forwarder, and the way back runs over it.
daemon.containers.push({ Id: "portal-one", Name: "portal-test", Image: "pithagoras-portal:latest", State: "running", Labels: {}, Tty: false, out: "", err: "", HostConfig: { NetworkMode: "host" } });
daemon.images.add(IMAGE);
daemon.images.add("node:22.23.4-alpine3.23");
// Every container runs until it is stopped.
daemon.runs.onStart = () => new Promise<void>(() => {});

/** The Document Server, as far as the portal reaches it through the way in: its health, and what it was told. */
const seen: http.IncomingHttpHeaders[] = [];
const ds = http.createServer((req, res) => {
  seen.push(req.headers);
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(req.url === "/healthcheck" ? "true" : `${req.headers["x-forwarded-proto"]}://${req.headers["x-forwarded-host"]}${req.headers["x-forwarded-prefix"]}${req.url}`);
});
ds.listen(0, "127.0.0.1");
await once(ds, "listening");
const PORT = (ds.address() as AddressInfo).port;
process.env.PITHAGORAS_OFFICE_PORT = String(PORT);

// Office switched on before its half starts, and a project with a document in it, which the boot scan finds.
const data = path.join(process.env.DATA_DIR!, "extension-data", "%40pithagoras%2Foffice");
mkdirSync(data, { recursive: true, mode: 0o700 });
writeFileSync(path.join(data, "settings.json"), JSON.stringify({ enabled: true, imageTag: IMAGE }));
const project = path.join(process.env.WORKSPACE_ROOT!, "acme");
mkdirSync(project, { recursive: true });
writeFileSync(path.join(project, "plan.docx"), await templateDocx());

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
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const at = `${origin}/api/x/%40pithagoras/office`;
after(async () => {
  await host.stopServerHalves();
  server.closeAllConnections();
  ds.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => ds.close(resolve));
  await daemon.close();
});

/** A request of the Office page's: from the portal's own origin, as a browser says it. */
const json = async (url: string, init?: RequestInit) => {
  const answer = await fetch(url, { ...init, headers: { "content-type": "application/json", origin, ...init?.headers } });
  return { status: answer.status, body: await answer.json() };
};
const chat = (workspace: string) => {
  const id = `office-${Math.random().toString(36).slice(2)}`;
  db.createSession({ id, title: id, workspace, executor: "host", kind: "task" });
  return id;
};
/** The tools the server halves register in a chat's pi, as a stand-in pi takes them. */
const registered = (chatId: string) => {
  const found: any[] = [];
  for (const { factory } of host.hostExtensions(chatId)) factory({ registerTool: (tool: any) => found.push(tool), on() {}, registerCommand() {}, events: { on: () => () => {} } });
  return found.filter((t) => t.name.startsWith("office_"));
};
const made = (name: string) => daemon.containers.find((c: { Name: string }) => c.Name === name) as any;

test("the half waits for Docker, which it requires", async () => {
  await host.syncServerHalves([own]);
  assert.match(String(host.serverFailure("@pithagoras/office")), /pithagoras-docker/);
  await host.syncServerHalves([docker, own]);
  assert.equal(host.serverFailure("@pithagoras/office"), undefined);
  assert.equal(host.isServing("@pithagoras/office"), true);
});

test("switched on, the Document Server, its relay, its network and the way in are made through Docker's own API, and nothing shares the portal's network", async () => {
  for (let i = 0; i < 300 && !made("pithagoras-office-ds-relay-forward"); i++) await delay(20);
  const dsSpec = made("pithagoras-office-ds").made;
  assert.equal(dsSpec.Image, IMAGE);
  assert.equal(dsSpec.HostConfig.NetworkMode, "pithagoras-office-ds-net");
  assert.equal(dsSpec.HostConfig.PortBindings, undefined, "nothing of the Document Server's is published");
  assert.equal(made("pithagoras-office-ds").Labels["pithagoras.extension"], "@pithagoras/office", "Docker's API marks it as the extension's");
  assert.equal(made("pithagoras-office-ds-relay").made.HostConfig.NetworkMode, "pithagoras-office-ds-net");
  assert.equal(made("pithagoras-office-ds-portal"), undefined, "no relay of Office's is on the portal's own network");
  const key = readFileSync(path.join(data, "relay-secret"), "utf8").trim();
  assert.ok(made("pithagoras-office-ds-relay").made.Env.includes(`TUNNEL_KEY=${key}`), "the relay knows the key the way back's tunnels open with");
  assert.ok(!dsSpec.Env.some((e: string) => e.includes(key)), "the Document Server does not");
  const binds = dsSpec.HostConfig.Binds as string[];
  assert.deepEqual(binds.map((b) => b.split(":")[1]).sort(), ["/usr/share/fonts/truetype/custom", "/var/lib/onlyoffice", "/var/log/onlyoffice", "/var/www/onlyoffice/Data"]);
  const island = daemon.networks.find((n: { Name: string }) => n.Name === "pithagoras-office-ds-net")!;
  assert.equal(island.Internal, true);
  assert.equal(island.Options!["com.docker.network.bridge.gateway_mode_ipv4"], "isolated");
  // The portal is on the host's network: the forwarder publishes the relay's port on 127.0.0.1.
  const forwarder = made("pithagoras-office-ds-relay-forward");
  assert.deepEqual(forwarder.made.HostConfig.PortBindings, { [`${PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(PORT) }] });
  for (let i = 0; i < 300 && !(await json(`${at}/state`)).body.container.state.startsWith("running"); i++) await delay(20);
  assert.equal((await json(`${at}/state`)).body.container.state, "running");
});

test("the editor's traffic reaches the Document Server through the way in, told where the browser is", async () => {
  const health = await fetch(`${at}/ds/healthcheck`);
  assert.equal(await health.text(), "true");
  const asked = await fetch(`${at}/ds/10.0.0-169/web-apps/apps/api/documents/api.js`, { headers: { "x-forwarded-host": "office.example", "x-forwarded-proto": "https" } });
  assert.equal(await asked.text(), "https://office.example/api/x/%40pithagoras/office/ds/10.0.0-169/web-apps/apps/api/documents/api.js");
  assert.equal((await fetch(`${at}/ds/info/info.json`)).status, 404, "the Document Server's own endpoints are not passed on");
});

test("the tools are in a project's chats, read the project's own document through the portal's files, and not in a plain chat", async () => {
  assert.deepEqual(registered(chat(process.env.WORKSPACE_ROOT!)), [], "a chat of no agent's or project's folder has none");
  const inProject = registered(chat(project));
  assert.deepEqual(inProject.map((t) => t.name).sort(), ["office_comments", "office_create", "office_edit", "office_list", "office_read"]);
  for (const t of inProject) assert.equal(t.guard.outside, true, t.name);
  const tool = (name: string) => inProject.find((t) => t.name === name);
  const listed = await tool("office_list").execute("c1", {});
  const plan = listed.details.documents.find((d: { title: string }) => d.title === "plan");
  assert.ok(plan, listed.content[0].text);
  // The agents' editor is not downloaded here: office_read reads the file through the portal's files, as the
  // project's agent would, and says so; office_edit asks for the download, and nothing of the browser is made.
  const read = await tool("office_read").execute("c2", { id: plan.id });
  assert.match(read.content[0].text, /Saved copy \(your editor is not downloaded/);
  assert.match(read.content[0].text, /New document/);
  const createdDoc = await tool("office_create").execute("c3", { title: "Minutes", type: "word" });
  const doc = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === createdDoc.details.id);
  assert.equal(doc.owner, project, "owned by the project's folder");
  await assert.rejects(tool("office_edit").execute("c4", { id: plan.id, ops: [{ quote: "New document", replacement: "Planned by the agent" }] }), (e: Error) => /^error:agent_editor_missing .*Start container in Settings → Office/.test(e.message));
  assert.equal(made("pithagoras-office-ds-agent"), undefined, "a tool never downloads the agents' editor, nor makes it without");
});

test("the agents' editor: missing while the Document Server runs, then downloaded through Docker's API by its tag with Start, and refused where the tag names another build", async () => {
  const before = (await json(`${at}/state`)).body.agent;
  assert.equal(before.present, false);
  assert.equal(daemon.pulls.includes(before.tag), false, "the half's own start (lookAfter) never downloads it");
  assert.match(before.tag, /^chromedp\/headless-shell:\d+\.\d+\.\d+\.\d+$/);
  assert.deepEqual(before.browser, { running: false, starting: false, editors: 0 });
  const started = await json(`${at}/container/start`, { method: "POST" });
  assert.equal(started.status, 200, "the Document Server runs: the image's failure does not fail the start");
  assert.equal(started.body.started, false);
  assert.equal(started.body.agent.present, false);
  assert.ok(daemon.pulls.includes(before.tag), "pulled by its tag");
  // This daemon names no image by its digest, as one would where the tag moved on to another build.
  const agent = (await json(`${at}/state`)).body.agent;
  assert.equal(agent.present, false);
  assert.match(agent.pull.error, /is not the build this version of Office runs \(sha256:[0-9a-f]{64}\)/);
  assert.equal((await fetch(`${at}/agent/pull`, { method: "POST", headers: { origin } })).status, 404, "no download of its own any more");
  assert.equal((await fetch(`${at}/container/start`, { method: "POST", headers: { origin: "http://elsewhere.example" } })).status, 403, "only from the portal's own pages");
});

test("a change asked from another page than the portal's own is refused", async () => {
  const res = await fetch(`${at}/container/remove`, { method: "POST", headers: { "content-type": "application/json", origin: "http://elsewhere.example" }, body: "{}" });
  assert.equal(res.status, 403);
  assert.ok(made("pithagoras-office-ds"), "nothing was removed");
});
