import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";

/**
 * Nextcloud's files in the chat's Files tab, as a portal runs it: this extension's server half and Files 0.2.0's (its own built server
 * half, the one with the sources hook), both started by Pithagoras' extension host after Docker for extensions' (fake, as in
 * portal.test.mts), against a stand-in Nextcloud MCP server that answers the WebDAV tools out of a few files in memory. Read through
 * Files' own routes for a chat, as the chat's Files tab reads them: /api/x/pithagoras-files/chats/<chat>/sources.
 *
 * "Another person" is a request with no login on a portal that has a password: the portal then names no person, and a portal that tells
 * people apart shows the Nextcloud of its primary person to that person alone. (Every login to this Pithagoras is its owner's for now, so
 * a colleague cannot be made here; the unit tests hold the roles.)
 *
 *   PITHAGORAS_DIR=<a built Pithagoras with Files 0.2.0> npm run test:portal -w nextcloud
 */

const DIR = process.env.PITHAGORAS_DIR;
if (!DIR || !existsSync(path.join(DIR, "core/server/dist/extension-host.js")) || !existsSync(path.join(DIR, "extensions/files/server.js"))) {
  throw new Error("PITHAGORAS_DIR must name a Pithagoras checkout with core/server and extensions/files built, Files at 0.2.0 or later");
}
const from = (file: string) => pathToFileURL(path.join(DIR, file)).href;

const { inProcessHome, freePort } = await import(from("core/server/test/server-harness.mjs"));
const home = inProcessHome("flair-nextcloud-files-source-");
process.env.PORTAL_PASSWORD = "";
delete process.env.PORTAL_ALLOW_NO_PASSWORD; // a portal with a password (set below): a request with no login is nobody's

const mcpPort = await freePort();
process.env.PITHAGORAS_NEXTCLOUD_PORT = String(mcpPort);
const dataDir = mkdtempSync(path.join(os.tmpdir(), "nextcloud-files-source-data-"));
process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR = dataDir;
process.env.PITHAGORAS_NEXTCLOUD_ANSWER_MS = "1500";
process.env.PITHAGORAS_NEXTCLOUD_SETTLED_MS = "200";
process.env.PITHAGORAS_NEXTCLOUD_SOURCE_MS = "1000"; // a call of the source is given a second, to show a slow Nextcloud in a test's time
const { IMAGE, IMAGE_BY_DIGEST } = await import("../../src/container.ts");

// ---- a stand-in Nextcloud MCP server with WebDAV tools ----------------------------------------------------------

interface Stored {
  content: string;
  etag: string;
}
const files = new Map<string, Stored>([
  ["notes.txt", { content: "hello from nextcloud", etag: "n1" }],
  ["Docs/plan.md", { content: "# Plan\n", etag: "p1" }],
]);
const folders: Record<string, { name: string; is_directory: boolean; size?: number; content_type?: string }[]> = {
  "": [{ name: "Docs", is_directory: true }, { name: "notes.txt", is_directory: false, size: 20, content_type: "text/plain" }],
  Docs: [{ name: "plan.md", is_directory: false, size: 7, content_type: "text/markdown" }],
};
/** What the stand-in does with the next calls of the WebDAV tools: answer them (nothing set), fail them, or never answer. */
const mode: { fail?: string; slowMs?: number } = {};
const tools: string[] = ["nc_webdav_list_directory", "nc_webdav_read_file", "nc_webdav_write_file"];
const calls: { name: string; args: any }[] = [];
const webdav = (name: string, args: any): { isError: boolean; text: string } => {
  const ok = (value: unknown) => ({ isError: false, text: JSON.stringify(value) });
  const no = (words: string) => ({ isError: true, text: words });
  if (mode.fail) return no(mode.fail);
  if (name === "nc_webdav_list_directory") return folders[args.path ?? ""] ? ok({ files: folders[args.path ?? ""] }) : no(`Not found: ${args.path}`);
  if (name === "nc_webdav_read_file") {
    const file = files.get(args.path);
    return file ? ok({ path: args.path, content: file.content, etag: file.etag }) : no(`Not found: ${args.path}`);
  }
  if (name === "nc_webdav_write_file") {
    const there = files.get(args.path);
    if (args.if_match === undefined && there) return no(`The file ${args.path} already exists`);
    if (args.if_match !== undefined && (!there || there.etag !== args.if_match)) return no("412 Precondition Failed: the file has changed since it was read");
    const etag = `w${files.size}${Date.now()}`;
    files.set(args.path, { content: args.content, etag });
    return ok({ path: args.path, created: !there, etag });
  }
  return no(`no stand-in for ${name}`);
};
const mock = http.createServer((req, res) => {
  if (req.method === "DELETE") return res.writeHead(200).end();
  if (req.method !== "POST") return res.writeHead(405).end();
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    const message = JSON.parse(body) as { method?: string; id?: number; params?: { name: string; arguments: any } };
    const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result }));
    if (message.method === "initialize") {
      res.setHeader("mcp-session-id", "s1");
      return reply({ protocolVersion: "2025-03-26", serverInfo: { name: "Nextcloud MCP", version: "9.9.9" }, capabilities: {} });
    }
    if (message.method === "notifications/initialized") return res.writeHead(202).end();
    if (message.method === "ping") return reply({});
    if (message.method === "tools/list") return reply({ tools: tools.map((name) => ({ name })) });
    if (message.method === "tools/call") {
      calls.push({ name: message.params!.name, args: message.params!.arguments });
      if (mode.slowMs) await new Promise((wait) => setTimeout(wait, mode.slowMs));
      const answer = webdav(message.params!.name, message.params!.arguments);
      return reply({ isError: answer.isError, content: [{ type: "text", text: answer.text }] });
    }
    res.writeHead(404).end("{}");
  });
});
const holding = new Set<string>();
let mockTurn: Promise<void> = Promise.resolve();
const mockUp = (name: string) => {
  holding.add(name);
  if (holding.size === 1) mockTurn = mockTurn.then(() => new Promise<void>((resolve) => { mock.once("error", () => resolve()); mock.listen(mcpPort, "127.0.0.1", () => resolve()); }));
};
const mockDown = (name: string) => {
  if (!holding.delete(name) || holding.size > 0) return;
  mockTurn = mockTurn.then(() => new Promise<void>((resolve) => {
    if (!mock.listening) return resolve();
    mock.closeAllConnections();
    mock.close(() => resolve());
  }));
};

// A stand-in Nextcloud for the account check of the status.
const nextcloud = http.createServer((req, res) => {
  if (!req.url?.startsWith("/ocs/v2.php/cloud/user")) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ocs: { data: { id: "anna", displayname: "Anna Example" } } }));
});
await new Promise<void>((resolve) => nextcloud.listen(0, "127.0.0.1", () => resolve()));
const ncUrl = `http://127.0.0.1:${(nextcloud.address() as AddressInfo).port}`;

const { fakeDocker } = await import(from("extensions/docker/test/fake-docker.ts"));
const docker = await fakeDocker();
process.env.DOCKER_SOCKET = docker.socket;
docker.images.add(IMAGE);
docker.images.add(IMAGE_BY_DIGEST);
const holdsPort = (c: any) => Array.isArray(c.made?.Cmd) && c.made.Cmd.includes(String(mcpPort));
const stopped = new Map<string, () => void>();
docker.runs.onStart = (c: any) => {
  if (!holdsPort(c)) return;
  mockUp(c.Name);
  return new Promise<void>((resolve) => stopped.set(c.Name, resolve));
};
docker.runs.onStop = (c: any) => {
  mockDown(c.Name);
  stopped.get(c.Name)?.();
  stopped.delete(c.Name);
};

// ---- the portal: its host, its login, a chat -------------------------------------------------------------------

const host = await import(from("core/server/dist/extension-host.js"));
const db = await import(from("core/server/dist/db.js"));
db.getDb();
const auth = await import(from("core/server/dist/auth.js"));
assert.equal(await auth.setUpPassword("a long enough test password"), null);
/** The cookie of a signed-in browser: the owner's. A request without it comes from nobody the portal knows. */
const cookie = (() => {
  let value = "";
  auth.issueCookie({ req: { secure: false }, cookie: (name: string, v: string) => (value = `${name}=${encodeURIComponent(v)}`) });
  return value;
})();
const { requiresOf } = await import(from("core/server/dist/extension-ui.js"));
const workFolder = path.join(home, "work");
mkdirSync(workFolder);
writeFileSync(path.join(workFolder, "in-the-workspace.txt"), "the chat's own file");
db.createSession({ id: "chat1", title: "chat", workspace: workFolder, executor: "host" });

const halfOf = (folder: string, file: string, version?: string, rev?: string) => {
  const meta = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8"));
  return { name: meta.name as string, version: (version ?? meta.version) as string, file: path.join(folder, file), rev: rev ?? meta.version, requires: requiresOf(meta), optional: meta.pithagoras?.optional as Record<string, string> | undefined };
};
const dockerHalf = halfOf(path.join(DIR, "extensions/docker"), "src/server.ts");
const filesHalf = halfOf(path.join(DIR, "extensions/files"), "server.js");
const ncHalf = () => halfOf(path.resolve(import.meta.dirname, "../.."), "src/server.ts");
assert.deepEqual(ncHalf().optional, { "pithagoras-files": "^0.2.0" }, "the package names Files as an optional dependency");

const app = express().use("/api/x", host.extensionRoutes);
app.use((req, res) => res.status(404).json({ no: `a route here, as the portal gives one: ${req.method} ${req.path}` }));
const portal = http.createServer(app);
portal.listen(0, "127.0.0.1");
await once(portal, "listening");
const origin = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
const at = `${origin}/api/x/%40pithagoras/nextcloud`;
const filesAt = `${origin}/api/x/pithagoras-files/chats/chat1`;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A request as the owner's browser makes it (their cookie), or as nobody's. */
const asOwner = { cookie };
const asNobody = {};
const get = (url: string, who: Record<string, string> = asOwner, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...who, ...(init.headers as object) } });
const send = (route: string, body: unknown) => fetch(`${at}${route}`, { method: "POST", headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify(body) });
const sourcesFor = async (who: Record<string, string> = asOwner) => ((await (await get(`${filesAt}/sources`, who)).json()) as { sources: { id: string; label: string; writable: boolean }[] }).sources;
const until = async <T,>(read: () => Promise<T>, ok: (value: T) => boolean, what: string): Promise<T> => {
  let last: T | undefined;
  for (let i = 0; i < 300; i++) {
    last = await read();
    if (ok(last)) return last;
    await sleep(20);
  }
  return assert.fail(`never: ${what} (last: ${JSON.stringify(last)})`);
};
const status = async () => (await get(`${at}/status`)).json() as Promise<any>;
const applyDone = () => until(status, (s) => s.task === undefined, "the run of a save to stand done");
const FIELDS = { url: ncUrl, allowHttp: true, username: "anna", password: "the-password" };

const start = async (halves: any[]) => {
  await host.syncServerHalves(halves);
  for (let i = 0; i < 300 && !halves.every((h) => host.isServing(h.name)); i++) await sleep(20);
  for (const h of halves) assert.equal(host.isServing(h.name), true, `${h.name}: ${host.serverFailure(h.name)}`);
};
/** An instance's container and server stand again (a start of the half takes them down and makes them anew). */
const ready = () => until(status, (s) => s.task === undefined && s.instances.length > 0 && s.instances.every((i: any) => i.health.ok), "the instance's server to answer");

// ---- the tests ---------------------------------------------------------------------------------------------

test("with Files 0.2.0 started first, and nothing set up, the chat's Files tab has no Nextcloud source", async () => {
  await start([dockerHalf, filesHalf, ncHalf()]);
  assert.deepEqual(await sourcesFor(), []);
  assert.deepEqual((await status()).filesSources, [], "the half found Files' hook and has given it nothing");
});

test("once an instance is set up, the primary person's chat has the source -- and a request with no login has none", async () => {
  assert.equal((await send("/instances", { name: "nextcloud", ...FIELDS })).status, 200);
  await applyDone();
  assert.deepEqual(await sourcesFor(), [{ id: "nextcloud", label: "Nextcloud", writable: true }]);
  assert.equal((await status()).instances[0].filesSource, true, "and the settings page is told");
  // Files sends no source's answer to a person the source does not show itself to: its routes say there is no such source
  assert.deepEqual(await sourcesFor(asNobody), []);
  for (const route of ["files?path=", "file?path=notes.txt", "file?path=notes.txt&download=1"]) {
    const answer = await get(`${filesAt}/sources/nextcloud/${route}`, asNobody, { redirect: "manual" });
    assert.equal(answer.status, 404, route);
    assert.equal(((await answer.json()) as any).code, "missing");
  }
  assert.equal(calls.filter((c) => c.name.startsWith("nc_webdav_")).length, 0, "Nextcloud was asked for nothing for a person who may not see it");
});

test("its folders and files are listed, read, and downloaded through Files, beside the chat's own folder", async () => {
  const root = (await (await get(`${filesAt}/sources/nextcloud/files?path=`)).json()) as any;
  assert.deepEqual(root.entries.map((e: any) => [e.name, e.type]), [["Docs", "dir"], ["notes.txt", "file"]]);
  const docs = (await (await get(`${filesAt}/sources/nextcloud/files?path=Docs`)).json()) as any;
  assert.deepEqual(docs.entries.map((e: any) => e.name), ["plan.md"]);
  const file = (await (await get(`${filesAt}/sources/nextcloud/file?path=Docs/plan.md`)).json()) as any;
  assert.equal(file.content, "# Plan\n");
  assert.equal(file.binary, false);
  assert.ok(file.mtime > 0);
  // the same tools the panel calls, nothing else, and for the paths given
  assert.deepEqual(calls.filter((c) => c.name === "nc_webdav_read_file").map((c) => c.args), [{ path: "Docs/plan.md", parse_document: "raw" }]);
  // the chat's folder is its own tree: its file is not in the source, and the source's files are not in it
  const workspace = (await (await get(`${filesAt}/files?path=`)).json()) as any;
  assert.deepEqual(workspace.entries.map((e: any) => e.name), ["in-the-workspace.txt"]);
  // the download goes to Nextcloud's own address, with no login in it
  const download = await get(`${filesAt}/sources/nextcloud/file?path=Docs/plan.md&download=1`, asOwner, { redirect: "manual" });
  assert.equal(download.status, 302);
  assert.equal(download.headers.get("location"), `${ncUrl}/remote.php/dav/files/anna/Docs/plan.md`);
});

test("a path that goes up or is absolute never reaches Nextcloud, nor does a path of the workspace", async () => {
  calls.length = 0;
  for (const bad of ["../etc/passwd", "/etc/passwd", "Docs/../../x", "a//b", "a\\b"]) {
    const answer = await get(`${filesAt}/sources/nextcloud/file?path=${encodeURIComponent(bad)}`);
    assert.equal(answer.status, 400, bad);
  }
  // a name the workspace has is just a name in Nextcloud's tree: it is asked there, and is not found there
  const answer = await get(`${filesAt}/sources/nextcloud/file?path=in-the-workspace.txt`);
  assert.equal(answer.status, 404);
  assert.deepEqual(calls.map((c) => c.args), [{ path: "in-the-workspace.txt", parse_document: "raw" }]);
});

test("a file is saved from Files against the version it was read, and a changed file is a conflict", async () => {
  const read = (await (await get(`${filesAt}/sources/nextcloud/file?path=notes.txt`)).json()) as any;
  const put = (body: unknown) => get(`${filesAt}/sources/nextcloud/file?path=notes.txt`, asOwner, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const saved = await put({ content: "edited in the chat", mtime: read.mtime });
  assert.equal(saved.status, 200);
  assert.equal(files.get("notes.txt")!.content, "edited in the chat");
  // the person read the version before: someone changed it on Nextcloud meanwhile
  files.set("notes.txt", { content: "changed there", etag: "n9" });
  const conflict = await put({ content: "mine", mtime: ((await saved.json()) as any).mtime });
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as any).code, "conflict");
  assert.equal(files.get("notes.txt")!.content, "changed there");
});

test("a Nextcloud that is down or slow is the source's own error, and the chat's folder is not held up", async () => {
  mode.fail = "The MCP server could not reach Nextcloud: connection refused";
  const down = await get(`${filesAt}/sources/nextcloud/files?path=`);
  assert.equal(down.status, 502);
  assert.match(((await down.json()) as any).error, /^Nextcloud: Nextcloud could not do that/, "its own words, not the server's");
  mode.fail = undefined;
  mode.slowMs = 3_000;
  const started = Date.now();
  const slow = get(`${filesAt}/sources/nextcloud/files?path=`);
  const workspace = await get(`${filesAt}/files?path=`);
  assert.equal(workspace.status, 200, "the chat's folder answers while Nextcloud is slow");
  assert.ok(Date.now() - started < 900, "and at once");
  const slowAnswer = await slow;
  assert.equal(slowAnswer.status, 502);
  assert.match(((await slowAnswer.json()) as any).error, /^Nextcloud: Nextcloud did not answer in time/);
  assert.ok(Date.now() - started < 2_500, "the call was given up on by the source's own time, not left to run");
  mode.slowMs = undefined;
  await sleep(2_100); // what the stand-in still held answers into the void
  assert.equal((await get(`${filesAt}/sources/nextcloud/files?path=`)).status, 200, "and it works again when Nextcloud does");
});

test("a second instance is its own source, the label names it; Files switched off for it, or its removal, takes it away", async () => {
  assert.equal((await send("/instances", { name: "work", ...FIELDS })).status, 200);
  await applyDone();
  // (the second instance's container asks for the port the first holds: its server may not come up here; the source is the settings')
  assert.deepEqual((await sourcesFor()).map((s) => [s.id, s.label]), [["nextcloud", "Nextcloud (nextcloud)"], ["nextcloud-work", "Nextcloud (work)"]]);
  assert.equal((await send("/instances", { name: "work", capabilities: { files: false } })).status, 200);
  assert.deepEqual((await sourcesFor()).map((s) => [s.id, s.label]), [["nextcloud", "Nextcloud"]]);
  assert.equal((await send("/instances/remove", { name: "work" })).status, 200);
  await applyDone();
  assert.deepEqual((await sourcesFor()).map((s) => s.id), ["nextcloud"]);
  assert.equal((await send("/instances/remove", { name: "nextcloud" })).status, 200);
  await applyDone();
  assert.deepEqual(await sourcesFor(), [], "nothing set up, no source");
});

test("Files started anew brings the source back with it, and Nextcloud stopped takes it away", async () => {
  assert.equal((await send("/instances", { name: "nextcloud", ...FIELDS })).status, 200);
  await applyDone();
  assert.equal((await sourcesFor()).length, 1);
  await start([dockerHalf, { ...filesHalf, rev: "files-again" }, ncHalf()]);
  assert.deepEqual((await sourcesFor()).map((s) => s.id), ["nextcloud"], "Files forgot what it was given; this half was started again after it and gave it again");
  await host.syncServerHalves([dockerHalf, filesHalf]);
  assert.deepEqual(await sourcesFor(), [], "stopped: nothing of it is left in Files");
});

test("with an older Files, or none, the extension runs as before and has no source", async () => {
  // Files 0.1.0 is there, but not in a version the optional range takes
  await start([dockerHalf, { ...filesHalf, version: "0.1.0", rev: "old-files" }, ncHalf()]);
  assert.deepEqual(await sourcesFor(), []);
  const old = await status();
  assert.equal(old.filesSources, undefined, "no hook, nothing said of it");
  assert.equal(old.instances.length, 1, "and its own routes work");
  await ready();
  assert.equal((await send("/tool", { name: "nc_webdav_list_directory", args: {} })).status, 200, "so does the panel's own Files tab");
  // no Files at all
  await start([dockerHalf, ncHalf()]);
  await ready();
  assert.equal((await status()).filesSources, undefined);
  assert.equal((await send("/tool", { name: "nc_webdav_list_directory", args: {} })).status, 200);
});
