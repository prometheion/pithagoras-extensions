import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { APPROVE_TOOLS, CAPABILITIES, EARLIER_APPROVE_TOOLS } from "../../src/capabilities.ts";

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
/** Where the half keeps its settings (so that the test reads them), and how long it waits for a server to answer. */
const dataDir = mkdtempSync(path.join(os.tmpdir(), "nextcloud-portal-data-"));
process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR = dataDir;
process.env.PITHAGORAS_NEXTCLOUD_ANSWER_MS = "1500";
process.env.PITHAGORAS_NEXTCLOUD_SETTLED_MS = "200";
// Loaded after the environment is set: the port and the container names are read as the module loads.
const { IMAGE, IMAGE_BY_DIGEST } = await import("../../src/container.ts");

/** The settings of the home the halves run from say pi-mcp-adapter is already installed for them, as a real
 * portal's say it: the entries the extension writes into mcp.json are then what stand out. */
writeFileSync(
  path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"),
  JSON.stringify({ packages: [{ source: "npm:pi-mcp-adapter@2.18.0", autoload: true }] }),
  { mode: 0o600 },
);

// A stand-in of the Nextcloud MCP server's endpoint, on the very port an instance's container is told to hold, while
// a container told to hold it runs (the fake Docker starts it, below): it gives a session out on initialize and answers
// ping, tools/list and tools/call. `mockName` is what it calls itself (another program on the port is another name),
// `mockTools` the tools it lists.
const seen = { initialize: 0, tools_call: 0 };
let mockName = "Nextcloud MCP";
let mockTools: string[] = [];
const answer: http.RequestListener = (req, res) => {
  if (req.method === "DELETE") return res.writeHead(200).end();
  if (req.method !== "POST") return res.writeHead(405).end();
  const accept = req.headers.accept ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return res.writeHead(406).end();
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const message = JSON.parse(body) as { method?: string; id?: number };
    if (message.method === "initialize") {
      seen.initialize += 1;
      return res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result: { protocolVersion: "2025-03-26", serverInfo: { name: mockName, version: "9.9.9" }, capabilities: {} } }));
    }
    if (message.method === "notifications/initialized") return res.writeHead(202).end();
    if (message.method === "ping") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result: {} }));
    if (message.method === "tools/list") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result: { tools: mockTools.map((name) => ({ name })) } }));
    if (message.method === "tools/call") {
      seen.tools_call += 1;
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result: { content: [{ type: "text", text: '{"lists":[{"id":7,"name":"Einkaufen"}]}' }] } }));
    }
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
};
const mock = http.createServer(answer);
/** The containers running that hold the stand-in's port: it listens while there is one, as the real server would. */
const holding = new Set<string>();
let mockTurn: Promise<void> = Promise.resolve(); // listen and close one after the other
const mockUp = (name: string) => {
  holding.add(name);
  if (holding.size === 1)
    mockTurn = mockTurn.then(() => new Promise<void>((resolve) => {
      // where another program holds the port, the container's server cannot listen (as the real one cannot)
      const refused = () => resolve();
      mock.once("error", refused);
      mock.listen(mcpPort, "127.0.0.1", () => {
        mock.off("error", refused);
        resolve();
      });
    }));
};
const mockDown = (name: string) => {
  if (!holding.delete(name) || holding.size > 0) return;
  mockTurn = mockTurn.then(() => new Promise<void>((resolve) => {
    if (!mock.listening) return resolve();
    mock.closeAllConnections();
    mock.close(() => resolve());
  }));
};

// A stand-in Nextcloud, for the account the status asks it about: the app password it takes is `ncPassword`.
let ncPassword = "the-password";
const nextcloud = http.createServer((req, res) => {
  if (!req.url?.startsWith("/ocs/v2.php/cloud/user")) return res.writeHead(404).end();
  const [user, pass] = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":");
  if (user !== "anna" || pass !== ncPassword) return res.writeHead(401).end("{}");
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ocs: { data: { id: "anna", displayname: "Anna Example" } } }));
});
await new Promise<void>((resolve) => nextcloud.listen(0, "127.0.0.1", () => resolve()));
const ncUrl = `http://127.0.0.1:${(nextcloud.address() as AddressInfo).port}`;

// Docker, stood in for: this portal runs on the machine itself (no container of its own), so a container it makes
// shares the machine's network, and nothing is put between them.
const { fakeDocker } = await import(from("extensions/docker/test/fake-docker.ts"));
const docker = await fakeDocker();
process.env.DOCKER_SOCKET = docker.socket;
docker.images.add(IMAGE);
docker.images.add(IMAGE_BY_DIGEST); // the tag is the build the digest names
// A container told to hold the stand-in's port runs it while it runs: started with it, stopped with it.
const holdsPort = (c: any) => Array.isArray(c.made?.Cmd) && c.made.Cmd.includes(String(mcpPort));
const stopped = new Map<string, () => void>();
docker.runs.onStart = (c: any) => {
  if (!holdsPort(c)) return;
  mockUp(c.Name);
  return new Promise<void>((resolve) => stopped.set(c.Name, resolve)); // it runs until it is stopped
};
docker.runs.onStop = (c: any) => {
  mockDown(c.Name);
  stopped.get(c.Name)?.();
  stopped.delete(c.Name);
};

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
const origin = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
const at = `${origin}/api/x/%40pithagoras/nextcloud`;

after(async () => {
  await host.stopServerHalves();
  http.globalAgent.destroy();
  portal.closeAllConnections();
  portal.close();
  mock.closeAllConnections();
  if (mock.listening) mock.close();
  nextcloud.closeAllConnections();
  nextcloud.close();
  rmSync(dataDir, { recursive: true, force: true });
  await docker.close();
});

const status = async () => (await fetch(`${at}/status`)).json() as any;
const until = async (check: (s: any) => boolean, what: string) => {
  let s: any;
  for (let i = 0; i < 300; i++) {
    s = await status();
    if (check(s)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`never: ${what} (the status last said ${JSON.stringify({ task: s?.task, error: s?.error })})`);
};

/** A request of the page's: from the portal's own origin, as a browser says it. */
const post = (route: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  fetch(`${at}${route}`, { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(body) });
const FIELDS = { url: ncUrl, allowHttp: true, username: "anna", password: "the-password" };
const save = (name: string, over: Record<string, unknown> = {}) => post("/instances", { name, ...FIELDS, ...over });

// The save routes fire their run on its own (a first pull must not hold the response open): a read of what a save
// kept stands behind the run standing done.
const applyDone = async () => {
  await until((s) => s.task === undefined, "the run of a save to stand done");
};
const ncContainer = (name: string) => docker.containers.find((c: { Name: string }) => c.Name === name);
const mcpFile = () => path.join(process.env.PI_CODING_AGENT_DIR!, "mcp.json");
/** What pi's mcp.json holds now, by server name. */
const servers = (): Record<string, any> => (existsSync(mcpFile()) ? JSON.parse(readFileSync(mcpFile(), "utf8")).mcpServers ?? {} : {});
const trusted = (): string[] => [...db.trustedMcpServers()];
const url = `http://127.0.0.1:${mcpPort}/mcp`;

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
  // what it does on its start may not have stood done as it first answers: wait for nothing left doing before
  // reading what it kept.
  const s = await until((s) => s.task === undefined, "the startup run to stand done");
  assert.deepEqual(s, { image: IMAGE, instances: [], configured: false });
});

test("only the portal's own pages change anything, and only for its primary person; anyone may read", async () => {
  assert.equal((await fetch(`${at}/instances`, { method: "POST", headers: { "content-type": "application/json", origin: "http://elsewhere.example" }, body: JSON.stringify({ name: "x" }) })).status, 403);
  assert.equal((await fetch(`${at}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403, "no origin, no same-origin mark");
  assert.equal((await fetch(`${at}/instances/remove`, { method: "POST", headers: { "content-type": "application/json", origin: "http://elsewhere.example" }, body: JSON.stringify({ name: "x" }) })).status, 403);
  assert.equal((await fetch(`${at}/status`, { headers: { origin: "http://elsewhere.example" } })).status, 200);
});

test("a saved instance stands in a container of its own, on the portal's network, and its entry in mcp.json with it", async () => {
  const answer = await save("uni");
  assert.equal(answer.status, 200);
  const body = (await answer.json()) as any;
  assert.deepEqual(body.instances[0], { name: "uni", url: ncUrl, allowHttp: true, username: "anna", passwordSet: true, configured: true }); // a fresh instance carries no capability choices yet

  await applyDone(); // its run stands done before what it kept is read

  const made = ncContainer("pithagoras-nextcloud-mcp-uni");
  assert.ok(made, "a container of its own stands");
  assert.equal(made.State, "running");
  assert.deepEqual(made.made?.Env?.slice(0, 3), [`NEXTCLOUD_HOST=${ncUrl}`, "NEXTCLOUD_USERNAME=anna", "NEXTCLOUD_PASSWORD=the-password"]);
  assert.ok(made.made?.Env?.includes(`MCP_ALLOWED_HOSTS=127.0.0.1:${mcpPort}`), "only its own loopback Host is taken");
  assert.deepEqual(made.made?.Cmd, ["--host", "127.0.0.1", "--port", String(mcpPort)]);
  assert.equal(made.made?.HostConfig?.NetworkMode, "host"); // this portal is on the machine itself: no container between
  assert.equal(made.made?.Image, IMAGE_BY_DIGEST, "from the digest of the build it was tested with");
  assert.deepEqual(made.made?.HostConfig?.CapDrop, ["ALL"]);
  assert.deepEqual(made.made?.HostConfig?.RestartPolicy, { Name: "unless-stopped" });

  const row = (await until((s) => s.instances.some((i: any) => i.name === "uni" && i.capabilities), "the instance in the status, with what its server offers")).instances.find((i: any) => i.name === "uni");
  assert.deepEqual(row.capabilities.available, Object.fromEntries(CAPABILITIES.map((cap) => [cap.id, false]))); // the stand-in serves no tools, so nothing stands offered
  const { capabilities, ...plain } = row;
  assert.deepEqual(plain, { name: "uni", containerName: "pithagoras-nextcloud-mcp-uni", state: "running", url: ncUrl, address: url, mcp: { registered: true, on: true, url }, health: { ok: true, server: { name: "Nextcloud MCP", version: "9.9.9" } }, configured: true, account: { state: "ok", name: "Anna Example" } });
});

test("its entry is not a trusted server, and the agent is asked before the tools that send, share and delete", async () => {
  const entry = servers().uni;
  assert.equal(entry.url, url);
  assert.equal(entry.lifecycle, "persistent");
  assert.deepEqual(entry.approveTools, APPROVE_TOOLS);
  assert.equal(trusted().includes("uni"), false, "what Nextcloud returns is other people's words (mail, news, shared files): it is wrapped and scanned as any outside content");
});

test("a person's own list of tools to be asked about is kept; their other tuning too, and a login someone put on the entry is not", async () => {
  const file = JSON.parse(readFileSync(mcpFile(), "utf8"));
  file.mcpServers.uni = { ...file.mcpServers.uni, approveTools: ["nc_notes_*"], debug: true, headers: { Authorization: "Bearer x" }, env: { T: "1" } };
  writeFileSync(mcpFile(), JSON.stringify(file));
  assert.equal((await save("uni", { capabilities: { news: false } })).status, 200);
  await applyDone();
  const entry = servers().uni;
  assert.deepEqual(entry.approveTools, ["nc_notes_*"]);
  assert.equal(entry.debug, true);
  assert.equal(entry.headers, undefined);
  assert.equal(entry.env, undefined);
  assert.deepEqual(entry.excludeTools, ["uni_nc_news_*"]);
  assert.equal((await save("uni", { capabilities: {} })).status, 200);
  await applyDone();
});

test("an entry that holds the list an earlier version wrote gets this version's: the extension's default is not taken for the person's", async () => {
  const file = JSON.parse(readFileSync(mcpFile(), "utf8"));
  file.mcpServers.uni = { ...file.mcpServers.uni, approveTools: EARLIER_APPROVE_TOOLS[0] };
  writeFileSync(mcpFile(), JSON.stringify(file));
  await post("/start");
  await applyDone();
  assert.deepEqual(servers().uni.approveTools, APPROVE_TOOLS);
  assert.ok(servers().uni.approveTools.includes("talk_send_message"));
});

test("a tool call goes over this instance's server and back with its answer raw; a family that is off, or none, is refused", async () => {
  await status(); // a session stands
  const sessions = seen.initialize;
  const answer = await post("/tool", { name: "nc_shopping_list_get_lists", args: {}, instance: "uni" });
  assert.equal(answer.status, 200);
  const body = (await answer.json()) as any;
  assert.deepEqual(body.content?.[0], { type: "text", text: '{"lists":[{"id":7,"name":"Einkaufen"}]}' });
  assert.ok(seen.tools_call > 0, "the call stood at the stand-in server");
  await status();
  assert.equal(seen.initialize, sessions, "the call and the status reads went over the session that stands, not one each");

  await save("uni", { capabilities: { mail: false } });
  await applyDone();
  const calls = seen.tools_call;
  const off = await post("/tool", { name: "nc_mail_send_message", args: { to: "x@example.org" }, instance: "uni" });
  assert.equal(off.status, 403);
  assert.match(((await off.json()) as any).error, /Mail is switched off/);
  assert.equal((await post("/tool", { name: "nc_made_up_tool", instance: "uni" })).status, 403);
  assert.equal(seen.tools_call, calls, "neither reached the server");
  await save("uni", { capabilities: {} });
  await applyDone();
});

test("a save with nothing changed makes nothing again and writes nothing again; one that changes the password remakes the container where it stands", async () => {
  const written = statSync(mcpFile()).mtimeMs;
  await save("uni");
  await applyDone(); // the no-op run of that save stands done
  assert.equal(docker.created.length, 1, "nothing made again where nothing changed");
  assert.equal(statSync(mcpFile()).mtimeMs, written, "and its entry not written again");

  ncPassword = "the-other";
  await save("uni", { password: "the-other" });
  await applyDone(); // its remake stands done
  const uni = ncContainer("pithagoras-nextcloud-mcp-uni");
  assert.equal(uni.made?.Env?.find((e) => e.startsWith("NEXTCLOUD_PASSWORD=")), "NEXTCLOUD_PASSWORD=the-other");
  assert.deepEqual(uni.made?.Cmd, ["--host", "127.0.0.1", "--port", String(mcpPort)], "remade where it stood: the port stands as it was");
  assert.equal(docker.created.length, 2);
});

test("an address that is not https (unless chosen), has a login in it or is no address is refused, and a new host or user needs the password typed again", async () => {
  for (const [url, why] of [["cloud.example.org", /not an address/], ["file:///etc/passwd", /https/], ["http://nas.example.org", /unencrypted/], ["https://anna:pw@cloud.example.org", /login/]] as const) {
    const answer = await save("uni", { url, allowHttp: false, password: "" });
    assert.equal(answer.status, 400, url);
    assert.match(((await answer.json()) as any).error, why, url);
  }
  const moved = await post("/instances", { name: "uni", url: "https://cloud.elsewhere.example" });
  assert.equal(moved.status, 400);
  assert.match(((await moved.json()) as any).error, /typed again/);
  const user = await post("/instances", { name: "uni", username: "mallory" });
  assert.equal(user.status, 400);
  assert.equal(ncContainer("pithagoras-nextcloud-mcp-uni").made?.Env?.[0], `NEXTCLOUD_HOST=${ncUrl}`, "nothing changed");
  assert.equal(docker.created.length, 2, "and nothing made");
  assert.equal((await post("/instances", { name: "uni", url: "https://cloud.elsewhere.example", password: "new" })).status, 200, "with the password it is a save");
  await applyDone();
  await save("uni", { password: "the-other" }); // and back
  await applyDone();
});

test("an address an earlier version saved only trimmed (a trailing slash, capitals in the scheme) is the same host: a save of something else needs no password", async () => {
  const settings = path.join(dataDir, "settings.json");
  const stored = JSON.parse(readFileSync(settings, "utf8"));
  const made = docker.created.length;
  stored.instances.find((i: any) => i.name === "uni").url = `${ncUrl}/`.replace("http://", "HTTP://");
  writeFileSync(settings, JSON.stringify(stored));
  const answer = await save("uni", { password: "", url: ncUrl, capabilities: { news: false } });
  assert.equal(answer.status, 200, await answer.clone().text());
  await applyDone();
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).instances.find((i: any) => i.name === "uni").url, ncUrl, "kept normalized from now on");
  assert.equal(docker.created.length, made, "the same host: nothing made again for it");
  await save("uni", { password: "", capabilities: {} });
  await applyDone();
});

test("the status asks the Nextcloud itself: a revoked app password shows as refused although the server answers", async () => {
  ncPassword = "changed-on-the-nextcloud";
  await save("uni", { password: "the-other" }); // forgets the answer kept
  await applyDone();
  const row = (await status()).instances.find((i: any) => i.name === "uni");
  assert.equal(row.health.ok, true, "the MCP server answers");
  assert.equal(row.account.state, "unauthorized", "the Nextcloud does not take the login");
  ncPassword = "the-other";
  await save("uni", { password: "the-other" });
  await applyDone();
  assert.equal((await status()).instances.find((i: any) => i.name === "uni").account.state, "ok");
});

test("a removed instance leaves nothing of it: its container, its entry and its place among the trusted servers go, and no one may call its tools", async () => {
  const answer = await post("/instances/remove", { name: "uni" });
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).instances, []);
  await applyDone();
  assert.equal(ncContainer("pithagoras-nextcloud-mcp-uni"), undefined, "its container is gone");
  assert.equal(servers().uni, undefined, "its entry in pi's mcp.json is gone");
  assert.equal(trusted().includes("uni"), false);

  const no = await post("/tool", { name: "nc_shopping_list_get_lists", args: {}, instance: "uni" });
  assert.equal(no.status, 409);
});

test("a second instance gets a container of its own, and the port the first one gave up is given out again -- to its entry alone", async () => {
  const answer = await save("second", { username: "anna" });
  assert.equal(answer.status, 200);
  await applyDone(); // its run stands done (and the remove's before it)
  const made = ncContainer("pithagoras-nextcloud-mcp-second");
  assert.ok(made, "a container of its own stands");
  assert.equal(made.State, "running");
  assert.deepEqual(made.made?.Cmd, ["--host", "127.0.0.1", "--port", String(mcpPort)], "the first's freed port is the lowest free one again");

  const row = (await until((s) => s.instances.some((i: any) => i.name === "second"), "the second instance in the status")).instances.find((i: any) => i.name === "second");
  assert.equal(row.address, url);
  assert.equal(row.mcp.registered, true);
  assert.deepEqual(row.health, { ok: true, server: { name: "Nextcloud MCP", version: "9.9.9" } }, "the stand-in answers on that port as it always does");
  assert.deepEqual(Object.keys(servers()), ["second"], "no entry of the removed one points at the same port");
});

test("a server of pi's own that has the instance's name is not taken over: the save is refused and the server stays as it was", async () => {
  const file = JSON.parse(readFileSync(mcpFile(), "utf8"));
  file.mcpServers.github = { command: "npx", args: ["-y", "@example/github-mcp"], env: { GITHUB_TOKEN: "t" } };
  file.mcpServers.nextcloud = { url: "https://mcp.example.org/mcp", headers: { Authorization: "Bearer own" } };
  // a local server of the person's that has the shape this extension's entries have is theirs all the same
  file.mcpServers.home = { url: "http://127.0.0.1:8100/mcp", lifecycle: "persistent" };
  writeFileSync(mcpFile(), JSON.stringify(file));
  const before = readFileSync(mcpFile(), "utf8");
  for (const name of ["github", "nextcloud", "home"]) {
    const answer = await save(name);
    assert.equal(answer.status, 400, name);
    assert.match(((await answer.json()) as any).error, /did not make/);
  }
  assert.equal(readFileSync(mcpFile(), "utf8"), before, "nothing written");
  assert.deepEqual((await (await fetch(`${at}/instances`)).json()).instances.map((i: any) => i.name), ["second"]);
  // and a removal of an instance never clears a server it did not write
  const copy = JSON.parse(before);
  delete copy.mcpServers.github;
  delete copy.mcpServers.nextcloud;
  delete copy.mcpServers.home;
  writeFileSync(mcpFile(), JSON.stringify(copy));
});

test("an entry an earlier version wrote as trusted is taken out of the trusted servers by the first run, and put back as an ordinary one", async () => {
  db.setTrustedMcpServers([...trusted(), "second"]);
  const settings = path.join(dataDir, "settings.json");
  const stored = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(stored.entries, 2, "the first version wrote it as 1; this one records 2");
  stored.entries = 1;
  stored.written = []; // 0.1.0 kept no list of what it wrote
  writeFileSync(settings, JSON.stringify(stored));
  await post("/start");
  await applyDone();
  assert.equal(trusted().includes("second"), false);
  assert.equal(servers().second.url, url, "and the entry is there");
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).entries, 2);
});

test("while the first version's entries are still being taken over (another instance failing), an entry this version wrote is not taken out and written again", async () => {
  const settings = path.join(dataDir, "settings.json");
  const stored = JSON.parse(readFileSync(settings, "utf8"));
  assert.deepEqual(stored.written, ["second"]);
  stored.entries = 1; // as a run in which some other instance failed leaves it
  writeFileSync(settings, JSON.stringify(stored));
  db.setTrustedMcpServers([...trusted(), "second"]); // trusted by the person, on purpose, since
  const written = statSync(mcpFile()).mtimeMs;
  await post("/start");
  await applyDone();
  assert.equal(trusted().includes("second"), true, "the person's trust stays");
  assert.equal(statSync(mcpFile()).mtimeMs, written, "and nothing was written again (every write reloads the open chats)");
  db.setTrustedMcpServers(trusted().filter((n) => n !== "second"));
});

test("a server on the port that is another program is not registered: the run says so, and no entry stands for it", async () => {
  const before = JSON.stringify(servers().second);
  mockName = "Some other dev server";
  await post("/instances/remove", { name: "second" });
  await applyDone();
  assert.equal(servers().second, undefined);
  await save("third");
  const failed = await until((s) => s.task === undefined && s.error, "the run to say the server did not come up as the Nextcloud MCP server");
  assert.match(failed.error, /third: its server did not come up.*answers as "Some other dev server", not as the Nextcloud MCP server/);
  assert.equal(servers().third, undefined, "no entry for a server that is not the Nextcloud's");
  mockName = "Nextcloud MCP";
  await post("/start");
  await applyDone();
  assert.equal(servers().third.url, url);
  assert.ok(before);
});

test("a program on the port before the container starts keeps it from starting, even one that answers as a Nextcloud MCP server", async () => {
  await post("/instances/remove", { name: "third" });
  await applyDone();
  // another Nextcloud MCP server of the person's, for another account, on the port the instance is given
  const theirs = http.createServer(answer);
  await new Promise<void>((resolve) => theirs.listen(mcpPort, "127.0.0.1", () => resolve()));
  await save("third");
  const failed = await until((s) => s.task === undefined && s.error, "the run to say the port is taken");
  assert.match(failed.error, new RegExp(`third: port ${mcpPort} of 127\\.0\\.0\\.1 is taken by another program`));
  assert.equal(servers().third, undefined, "no entry pointing at their server");
  assert.notEqual(ncContainer("pithagoras-nextcloud-mcp-third")?.State, "running");
  theirs.closeAllConnections();
  await new Promise((resolve) => theirs.close(resolve));
  await post("/start");
  await applyDone();
  assert.equal(servers().third.url, url, "the port free, it starts and is written");
});

test("a container that keeps restarting is not taken for what answers on its port", async () => {
  const c = ncContainer("pithagoras-nextcloud-mcp-third");
  const before = servers().third;
  // Docker starts it again and again (it cannot listen): each time it runs only for a moment
  const restart = () => {
    c.started = new Date().toISOString();
    c.restarts = (c.restarts ?? 0) + 1;
  };
  restart();
  const loop = setInterval(restart, 40);
  try {
    await save("third", { capabilities: { news: false } }); // an entry to write: what answers decides
    const failed = await until((s) => s.task === undefined && s.error, "the run to say the container does not hold");
    assert.match(failed.error, /third: its server did not come up: its container has not run for long enough/);
    assert.deepEqual(servers().third, before, "its entry is not written on that answer");
  } finally {
    clearInterval(loop);
  }
  await post("/start");
  await applyDone();
  assert.deepEqual(servers().third.excludeTools, ["third_nc_news_*"], "running without a break, it is written");
  await save("third", { capabilities: {} });
  await applyDone();
});

test("an instance removed while its image is still being downloaded leaves no container and no entry behind", async () => {
  docker.images.delete(IMAGE);
  let release!: () => void;
  docker.hold.pull = new Promise<void>((resolve) => (release = resolve));
  await post("/instances/remove", { name: "third" });
  await applyDone();
  const created = docker.created.length;
  await save("fourth"); // its run waits at the download
  await until((s) => s.task !== undefined, "the run to stand at the download");
  const removed = await post("/instances/remove", { name: "fourth" });
  assert.equal(removed.status, 200, "the remove does not wait for the download");
  assert.deepEqual((await removed.json()).instances, []);
  const second = await save("fifth"); // saved while the first run still waits: not lost
  assert.equal(second.status, 200);
  assert.deepEqual((await (await fetch(`${at}/instances`)).json()).instances.map((i: any) => i.name), ["fifth"]);
  release();
  docker.hold.pull = undefined;
  await applyDone();
  assert.equal(ncContainer("pithagoras-nextcloud-mcp-fourth"), undefined, "no container of the removed instance");
  assert.equal(servers().fourth, undefined, "and no entry");
  assert.ok(ncContainer("pithagoras-nextcloud-mcp-fifth"), "the instance saved meanwhile stands");
  assert.equal(servers().fifth.url, `http://127.0.0.1:${(JSON.parse(readFileSync(path.join(dataDir, "settings.json"), "utf8")).instances[0].port)}/mcp`);
  assert.ok(docker.created.length > created);
  docker.images.add(IMAGE);
});

test("a restart of the half (an update) leaves everything as it was: its stop is done before the new half starts", async () => {
  const before = { containers: docker.containers.map((c: any) => c.Name).sort(), entries: Object.keys(servers()).sort() };
  assert.deepEqual(before, { containers: ["pithagoras-nextcloud-mcp-fifth"], entries: ["fifth"] });
  await host.syncServerHalves([halves.docker, { ...halves.nextcloud, rev: "restarted" }]);
  for (let i = 0; i < 300 && !host.isServing("@pithagoras/nextcloud"); i++) await new Promise((r) => setTimeout(r, 20));
  await applyDone();
  assert.deepEqual(docker.containers.map((c: any) => c.Name).sort(), before.containers);
  assert.deepEqual(Object.keys(servers()).sort(), before.entries);
  assert.equal(ncContainer("pithagoras-nextcloud-mcp-fifth").State, "running");
});

test("a reset takes the containers and the entries it wrote away and keeps the keys; a start brings them back", async () => {
  const file = JSON.parse(readFileSync(mcpFile(), "utf8"));
  file.mcpServers.mine = { command: "npx", args: ["x"] };
  writeFileSync(mcpFile(), JSON.stringify(file));
  assert.equal((await post("/reset")).status, 200);
  await applyDone();
  assert.deepEqual(docker.containers.map((c: any) => c.Name), []);
  assert.deepEqual(Object.keys(servers()), ["mine"], "only its own entries went");
  assert.deepEqual((await (await fetch(`${at}/instances`)).json()).instances.map((i: any) => i.name), ["fifth"]);
  await post("/start");
  await applyDone();
  assert.ok(ncContainer("pithagoras-nextcloud-mcp-fifth"));
  assert.deepEqual(Object.keys(servers()).sort(), ["fifth", "mine"]);
});
