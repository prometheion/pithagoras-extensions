/**
 * Unit tests for src/server.ts: the boot wiring, the loopback listener, and every UI route -- against a
 * FAKE portal (mini router + recorded log/audit/extensions.use) with real tmp dataDirs and a recording fake Docker
 * literal. Nothing here reaches the real portal(), the Docker socket, or any network host but 127.0.0.1 loopback
 * (the listener itself). Booted instances are cleaned up at the end of each test; live-module presence is reset for
 * isolation because it is process-global.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import net, { type AddressInfo } from "node:net";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import { fakeDocker } from "./fake-docker.mts";
import * as container from "../src/container";
import officeServer, { buildEditorConfig, dsPathAllowed, forwardedFor, jwtSecret, loopbackPort, settleKept, ticketSecret, ticketSubject } from "../src/server";
import * as seat from "../src/seat";
import { PLUGIN_GUID } from "../src/seat-page";
import { CDP_SRC } from "../src/cdp";
import { createHash } from "node:crypto";
import { browser } from "./seat-browser.mts";
import * as store from "../src/store";
import { filesCreate, homeIn } from "./homes.mts";
import { rewriteZip } from "../src/ooxml";
import * as live from "../src/live";
import { mintTicket, verifyTicket } from "../src/tickets";
import { signJwt, verifyJwt } from "../src/jwt";
import { docIdOf, keyIdOf, makeKey, parseKey, revHashOf } from "../src/callback";

const DEFAULT_TAG = "onlyoffice/documentserver:10.0.0.1";

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

class MiniRouter {
  routes: Array<{ method: string; pattern: string | RegExp; handler: (req: unknown, res: FakeRes) => Promise<void> | void }> = [];
  /** What `use` was given: run before every route, as express runs a router's middleware. */
  middleware: ((req: unknown, res: FakeRes, next: () => void) => void)[] = [];
  use(fn: (req: unknown, res: FakeRes, next: () => void) => void) { this.middleware.push(fn); }
  private reg(method: string, pattern: string | RegExp, rest: unknown[]) {
    const handler = rest[rest.length - 1] as (req: unknown, res: FakeRes) => Promise<void> | void;
    this.routes.push({ method, pattern, handler });
  }
  /** Express-shaped registration: (pattern, ...middlewares, handler). */
  get(pattern: string | RegExp, ...rest: unknown[]) { this.reg("GET", pattern, rest); }
  post(pattern: string | RegExp, ...rest: unknown[]) { this.reg("POST", pattern, rest); }
  put(pattern: string | RegExp, ...rest: unknown[]) { this.reg("PUT", pattern, rest); }
  delete(pattern: string | RegExp, ...rest: unknown[]) { this.reg("DELETE", pattern, rest); }

  /** Express-shaped fake request: the plain fields PLUS the stream surface -- an async iterator over the body
   * (real IncomingMessages are async-iterable, and the /ds proxy's POST forwarding reads `for await (req)`). */
  private fakeReq(method: string, urlPath: string, params: Record<string, string>, body: unknown, headers: Record<string, string>): unknown {
    const query = Object.fromEntries(new URLSearchParams(urlPath.includes("?") ? urlPath.slice(urlPath.indexOf("?") + 1) : ""));
    const o: Record<PropertyKey, unknown> = { method, url: urlPath, params, query, body, headers };
    const data = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.isBuffer(body) ? body : undefined;
    o[Symbol.asyncIterator] = async function* () { if (data && data.length > 0) yield data; };
    return o;
  }

  /** A request as one of the portal's own pages sends it, unless the test says otherwise (its headers win). */
  async dispatch(method: string, urlPath: string, body?: unknown, given: Record<string, string> = {}): Promise<FakeRes> {
    const headers = { host: "portal.test", origin: "http://portal.test", ...given };
    for (const fn of this.middleware) {
      const res = fakeRes();
      let passed = false;
      fn(this.fakeReq(method, urlPath, {}, body, headers), res, () => void (passed = true));
      if (!passed) return res;
    }
    const us = urlPath.split("?")[0].split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      // Express regex paths match the WHOLE raw url (query included); groups land in params[0..].
      if (typeof route.pattern === "object") {
        const m = route.pattern.exec(urlPath);
        if (!m) continue;
        const params: Record<string, string> = {};
        for (let g = 1; g < m.length; g++) params[String(g - 1)] = m[g] ?? "";
        const res = fakeRes();
        await route.handler(this.fakeReq(method, urlPath, params, body, headers), res);
        return res;
      }
      const ps = route.pattern.split("/").filter(Boolean);
      if (ps.length !== us.length) continue;
      const params: Record<string, string> = {};
      let hit = true;
      for (let i = 0; i < ps.length; i++) {
        if (ps[i].startsWith(":")) params[ps[i].slice(1)] = decodeURIComponent(us[i]);
        else if (ps[i] !== us[i]) { hit = false; break; }
      }
      if (!hit) continue;
      const res = fakeRes();
      await route.handler(this.fakeReq(method, urlPath, params, body, headers), res);
      return res;
    }
    throw new Error(`no registered ${method} route for ${urlPath}`);
  }
}

function fakeRes(): FakeRes {
  let code = 200;
  const r = {
    headers: {} as Record<string, unknown>,
    data: undefined as unknown,
    body: undefined as unknown,
    status(c: number) { code = c; return r; },
    json(o: unknown) { r.body = o; return r; },
    setHeader(k: string, v: unknown) { r.headers[k.toLowerCase()] = v; },
    writeHead(c: number, h?: Record<string, string>) { code = c; if (h) for (const k of Object.keys(h)) r.headers[k.toLowerCase()] = h[k]; },
    end(b?: unknown) { r.data = b; },
  };
  Object.defineProperty(r, "statusCode", { get: () => code });
  return r as unknown as FakeRes;
}

type FakeRes = {
  headers: Record<string, unknown>;
  data: unknown;
  body: unknown;
  statusCode: number;
};

interface Booted {
  root: string;
  portal: ServerPortal;
  router: MiniRouter;
  logs: string[];
  audits: Array<Record<string, unknown>>;
  allowedDirs: string[];
  /** The Docker for extensions the half was given (fake-docker.mts). */
  dock: ReturnType<typeof fakeDocker>;
  /** The office tools' names a chat's pi is given (the half's chats.extend factory run for that chat). */
  toolsOf: (chatId: string) => string[];
  cleanup: () => Promise<void>;
}

/** The folders the fake portal lists (folders.list): an agent's home, a project, or a folder a chat works in. */
type ListedFolder = { path: string; name: string; kind: "agent" | "project" | "chat"; home?: true; newChats?: true };

/** Who the fake portal says is behind each request (http.person): the primary person, unless a test says otherwise. */
const OWNER = { id: "owner", name: "Owner", role: "primary" } as const;
let requestPerson: { id: string; name: string; role: string } | undefined = OWNER;

/** Whose a chat is, as the fake portal says (chats.owner): a test's own answer where it gives one (`owners`), else the
 * agent's home or project the chat's folder is in, by its path as given. */
function ownerOf(chatFolders: Record<string, string>, listed: ListedFolder[], owners: Record<string, string>, id: string): ListedFolder | undefined {
  if (owners[id]) return listed.find((l) => l.path === owners[id]);
  const at = chatFolders[id];
  if (!at) return undefined;
  return listed.filter((l) => (l.kind === "agent" || l.kind === "project") && (at === l.path || at.startsWith(l.path + path.sep))).sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * Boots the half against a fake portal. `api`: "339" the extension API of thecodacus/pithagoras#339 (chats.start,
 * lastAnswer, owner, http.person), "old" one without them. `owners` overrides whose a chat is, by chat id.
 */
async function boot(root?: string, dock = fakeDocker(), chatFolders: Record<string, string> = {}, listed: ListedFolder[] = [], api: "339" | "old" = "339", owners: Record<string, string> = {}): Promise<Booted> {
  container.forgetReach();
  container.forgetProbe(); // and what a start or a download of a test before said
  const rootDir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "office-server-"));
  const logs: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const allowedDirs: string[] = [];
  const router = new MiniRouter();
  const ddock = dock.docker; // ONE instance per boot: extensions.use() resolves the same fake every time
  const factories: ((pi: unknown, chat: { id: string }) => void)[] = [];
  const portalObj = {
    extension: "@pithagoras/office",
    dataDir: () => rootDir,
    log: (l: unknown) => logs.push(String(l)),
    audit: { record: (e: Record<string, unknown>) => audits.push(e) },
    router,
    http: { json: (_o?: unknown) => (_req: unknown, _res: unknown, next: () => void) => next(), text: () => () => undefined, raw: () => () => undefined, send: () => () => {}, upgrade: () => undefined, ...(api === "339" ? { person: () => requestPerson } : {}) },
    folders: { list: () => listed, allowed: (p: string) => allowedDirs.some((d) => p === d || p.startsWith(d + path.sep)), label: (f: string) => ({ name: listed.find((l) => l.path === f)?.name ?? path.basename(f) }), on: () => {} },
    chats: {
      extend: (f: (pi: unknown, chat: { id: string }) => void) => void factories.push(f), get: (id: string) => (chatFolders[id] ? { id } : undefined), list: () => [], inFolder: () => [] as never[], folder: (id: string) => { if (!chatFolders[id]) throw new Error("none"); return chatFolders[id]; }, send: () => {}, tell: async () => false, onEvent: () => {}, on: () => {},
      ...(api === "339" ? { start: () => { throw new Error("no chats in this test"); }, lastAnswer: () => undefined, owner: (id: string) => ownerOf(chatFolders, listed, owners, id) } : {}),
    },
    files: { create: filesCreate },
    extensions: { use: () => ddock },
  } as unknown as ServerPortal;
  const cleanup = await officeServer(portalObj);
  const toolsOf = (chatId: string) => {
    const names: string[] = [];
    for (const f of factories) f({ registerTool: (t: { name: string }) => names.push(t.name), on: () => {}, registerCommand: () => {}, sendMessage: () => {}, events: { on: () => () => {} } }, { id: chatId });
    return names.sort();
  };
  return { root: rootDir, portal: portalObj, router, logs, audits, allowedDirs, dock, toolsOf, cleanup };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The Document Server set up (ds.json), and reached at `origin`: where Docker for extensions' reach says it is. */
function writeDsJson(b: Booted, origin = "http://127.0.0.1:3890"): void {
  const { hostname, port } = new URL(origin);
  b.dock.state.reach = { host: hostname, port: Number(port) };
  container.forgetReach();
  fs.writeFileSync(path.join(b.root, "ds.json"), JSON.stringify({ containerId: "cid-test", imageTag: DEFAULT_TAG }));
}

/* ---------------- boot: jwt-secret + cleanup ---------------- */

test("boot creates jwt-secret 0600 exactly once; a second boot reuses the bytes verbatim", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-secret-"));
  const b1 = await boot(root);
  const file = path.join(root, "jwt-secret");
  assert.ok(fs.existsSync(file), "jwt-secret created at boot");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "mode is exactly 0600 (umask-proof)");
  const s1 = jwtSecret(root);
  assert.match(s1, /^[0-9a-f]{64}$/, "trimmed content is a 64-hex-char random value");

  const b2 = await boot(root); // same dataDir, second portal start
  assert.equal(jwtSecret(root), s1, "second boot reuses the existing secret byte-for-byte");
  const before = fs.readFileSync(file, "utf8");
  const b3 = await boot(root);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  await b3.cleanup(); await b2.cleanup(); await b1.cleanup();
});

test("cleanup closes the loopback listener and clears the timer (nothing keeps node alive)", async () => {
  const b = await boot();
  const port = loopbackPort();
  assert.ok(port > 0, "the listener bound a real ephemeral loopback port");
  let ok = false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/nope`);
    ok = r.status === 404; // reachable BEFORE cleanup, unknown path -> 404 JSON
  } catch { assert.fail("loopback was not reachable before cleanup"); }
  assert.ok(ok);

  await b.cleanup();
  assert.equal(loopbackPort(), 0, "port state cleared after cleanup");
  let refused = false;
  try {
    await fetch(`http://127.0.0.1:${port}/nope`);
  } catch {
    refused = true;
  }
  assert.ok(refused, "the listener is closed: connections are refused after cleanup");
});

test("the way back: once the way in is given, the half holds tunnels open to the relay with its relay-secret, and a request through one reaches the listener; cleanup closes them", async () => {
  // The relay, as far as the half is concerned: it keeps each connection that opens with the key.
  const tunnels: net.Socket[] = [];
  const hellos: string[] = [];
  const relay = net.createServer((s) => {
    s.once("data", (c) => {
      hellos.push(c.toString());
      tunnels.push(s);
    });
    s.on("error", () => {});
  }).listen(0, "127.0.0.1");
  await new Promise((r) => relay.once("listening", r));
  const b = await boot();
  try {
    assert.equal(tunnels.length, 0, "no tunnel before the way in was given: the half asks Docker for nothing by itself");
    b.dock.state.reach = { host: "127.0.0.1", port: (relay.address() as AddressInfo).port };
    await container.reachAgain(b.dock.docker);
    await until(() => tunnels.length === 4);
    const key = fs.readFileSync(path.join(b.root, "relay-secret"), "utf8").trim();
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.deepEqual(hellos, Array(4).fill(`\0${key}\n`));
    // The Document Server's request, as the relay hands it on: answered by the loopback listener.
    const t = tunnels[0];
    const chunks: Buffer[] = [];
    t.on("data", (c) => chunks.push(c));
    t.write("GET /doc/not-a-ticket HTTP/1.1\r\nHost: pithagoras-office-ds-relay:3891\r\nConnection: close\r\n\r\n");
    await new Promise((r) => t.once("close", r));
    assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 401 [\s\S]*bad_ticket/);
    await until(() => tunnels.length === 5, 3000); // the one taken is replaced at once
  } finally {
    await b.cleanup();
  }
  await until(() => tunnels.every((t) => t.destroyed || t.readableEnded));
  relay.close();
});

test("the loopback listener answers on 127.0.0.1 alone", async () => {
  const b = await boot();
  try {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (lan) {
      await assert.rejects(fetch(`http://${lan.address}:${loopbackPort()}/nope`), "not reachable on the machine's own address");
    }
    assert.equal((await fetch(`http://127.0.0.1:${loopbackPort()}/nope`)).status, 404);
  } finally {
    await b.cleanup();
  }
});

/* ---------------- loopback listener ---------------- */

test("loopback GET /doc/<ticket> returns the exact bytes + content-type + no-store; bad/expired tickets -> 401", async () => {
  const b = await boot();
  const doc = await store.createDoc({ title: "Loop", type: "word", folder: homeIn(b.root) }, b.root);
  const secret = ticketSecret(b.root);
  const { token } = mintTicket(ticketSubject(doc.docId, doc.mtimeMs), 600_000, secret);

  const r = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(r.headers.get("cache-control"), "no-store");
  const disk = fs.readFileSync(doc.path);
  assert.ok(Buffer.compare(Buffer.from(await r.arrayBuffer()), disk) === 0, "served bytes are exactly the library bytes");

  // xlsx gets the spreadsheet media type
  const cell = await store.createDoc({ title: "Cells", type: "cell", folder: homeIn(b.root) }, b.root);
  const { token: t2 } = mintTicket(ticketSubject(cell.docId, cell.mtimeMs), 600_000, secret);
  const r2 = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${t2}`);
  assert.equal(r2.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

  // invalid ticket -> 401 JSON; expired ticket -> 401 JSON (negative ttl mints an already-expired one)
  const r3 = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/garbage.ticket.here`);
  assert.equal(r3.status, 401);
  assert.deepEqual(await r3.json(), { error: "invalid or expired document ticket", code: "bad_ticket" });
  const { token: expired } = mintTicket(ticketSubject(doc.docId, doc.mtimeMs), -1_000, secret);
  assert.equal(verifyTicket(expired, secret), null, "sanity: the negative-ttl ticket does not verify");
  const r4 = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${expired}`);
  assert.equal(r4.status, 401);

  live.clearDoc(doc.docId); live.clearDoc(cell.docId);
  await b.cleanup();
});

test("loopback GET /doc/<ticket>: the Document Server's own secret makes no ticket, one for an older revision reads nothing, and a link in the file's place is not followed", async () => {
  const b = await boot();
  const doc = await store.createDoc({ title: "Ticketed", type: "word", folder: homeIn(b.root) }, b.root);
  assert.notEqual(ticketSecret(b.root), jwtSecret(b.root), "two secrets: the Document Server holds only one of them");
  const forged = mintTicket(ticketSubject(doc.docId, doc.mtimeMs), 600_000, jwtSecret(b.root)).token;
  assert.equal((await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${forged}`)).status, 401);
  const before = mintTicket(ticketSubject(doc.docId, doc.mtimeMs), 600_000, ticketSecret(b.root)).token;
  const file = doc.path;
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000)); // something wrote it since
  assert.equal((await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${before}`)).status, 409);
  // A link in the file's place, to a file the portal can read and an agent cannot.
  const secretFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "office-secret-file-")), "secret.docx");
  fs.writeFileSync(secretFile, "not for the editor");
  fs.rmSync(file);
  fs.symlinkSync(secretFile, file);
  const now = store.refresh(doc.docId, b.root)!;
  const linked = mintTicket(ticketSubject(doc.docId, now.mtimeMs), 600_000, ticketSecret(b.root)).token;
  const res = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${linked}`);
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), /not for the editor/);
  live.clearDoc(doc.docId);
  await b.cleanup();
});

test("loopback POST /callback while the DS is unconfigured -> 503 {error:1}; unknown paths -> 404 JSON", async () => {
  const b = await boot(); // fresh root: no ds.json yet, but configure() ran at boot with this root's lookups
  const r = await fetch(`http://127.0.0.1:${loopbackPort()}/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 1 }); // the DS callback convention, not our JSON shape

  const r2 = await fetch(`http://127.0.0.1:${loopbackPort()}/whatever`);
  assert.equal(r2.status, 404);
  const body = (await r2.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string");
  assert.equal(body.code, "not_found");

  const r3 = await fetch(`http://127.0.0.1:${loopbackPort()}/callback`); // GET on the POST-only route is also 404
  assert.equal(r3.status, 404);
  await b.cleanup();
});

/* ---------------- /editor-config ---------------- */

test("editor-config (docx): key round-trips through parseKey, url is a fresh verifiable ticket through the relay, the whole config is JWT-signed", async () => {
  const b = await boot();
  writeDsJson(b);
  const doc = await store.createDoc({ title: "Plan", type: "word", folder: homeIn(b.root) }, b.root);
  const secret = jwtSecret(b.root);

  const res = await b.router.dispatch("POST", "/editor-config", { doc: doc.docId });
  assert.equal(res.statusCode, 200);
  const body = res.body as Record<string, unknown> & { token: string; apiJs: string };

  // the plain fields a DocsAPI.DocEditor gets
  assert.equal(body.documentType, "word");
  assert.equal(body.type, "desktop", "the editor, not the embed viewer");
  assert.equal(body.title, "Plan");
  const document = body.document as Record<string, unknown>;
  assert.equal(document.fileType, "docx");
  assert.equal(document.title, "Plan.docx");
  // key: exactly makeKey(docId, current mtime) and parseable back
  assert.equal(document.key, makeKey(doc.docId, doc.mtimeMs));
  const parsed = parseKey(String(document.key)) as { keyId: string; revHash: string };
  assert.equal(docIdOf(parsed.keyId, b.root), doc.docId);
  assert.equal(parsed.revHash, revHashOf(doc.mtimeMs));
  // only what the Document Server takes in a key, and no more than it takes
  assert.match(String(document.key), /^[0-9a-zA-Z_.=-]{1,128}$/);
  // url: the island's relay, which the Document Server reaches and which passes it on to the loopback listener;
  // ticketed, and the ticket verifies with the boot secret
  const url = String(document.url);
  assert.ok(url.startsWith("http://pithagoras-office-ds-relay:3891/doc/"), `url names the relay: ${url}`);
  const ticket = url.split("/doc/")[1];
  assert.ok(ticket.length > 0 && !ticket.includes("/"));
  assert.equal(verifyTicket(ticket, ticketSecret(b.root))?.docId, ticketSubject(doc.docId, doc.mtimeMs), "the minted ticket names the document at its revision, with the ticket secret");
  // editorConfig
  const ec = body.editorConfig as Record<string, unknown>;
  assert.equal(ec.callbackUrl, "http://pithagoras-office-ds-relay:3891/callback");
  assert.equal(ec.mode, "edit");
  assert.deepEqual(ec.user, { id: "portal-user", name: "Portal" });
  // no document macros and no plugins on the portal's origin, and that is signed
  assert.deepEqual(ec.customization, { macros: false, plugins: false });
  assert.equal(ec.plugins, undefined, "a person's editor is given no plugin");
  // the JWT wrap: payload == the WHOLE plain config (minus token/apiJs), 15-minute life, verifies with the same secret
  const claims = verifyJwt(body.token, secret);
  assert.ok(claims, "the signed config verifies");
  assert.deepEqual(
    { documentType: claims?.documentType, type: claims?.type, title: claims?.title, document: claims?.document, editorConfig: claims?.editorConfig },
    { documentType: body.documentType, type: body.type, title: body.title, document: body.document, editorConfig: body.editorConfig },
  );
  const exp = Number(claims?.exp); const iat = Number(claims?.iat);
  assert.equal(exp - iat, 900, "config token lives exactly 15 minutes (the official sample's window)");
  // api.js src: ROOT-RELATIVE through this extension's own /ds proxy (resolved by the browser against the page
  // origin it reached the portal at); getBasePath() turns that prefix into the editor iframe base. The loopback
  // document.url/callbackUrl above are what STAY absolute for DS-side fetches.
  assert.equal(body.apiJs, "/api/x/%40pithagoras/office/ds/web-apps/apps/api/documents/api.js");
  // and minting claimed the seat in live presence
  assert.deepEqual(live.usersOf(doc.docId).map((u) => ({ id: u.id, name: u.name })), [{ id: "portal-user", name: "Portal" }]);

  live.clearDoc(doc.docId);
  await b.cleanup();
});

test("editor-config: a file written outside the extension is opened at its new revision, under a new key", async () => {
  const b = await boot();
  writeDsJson(b);
  const doc = await store.createDoc({ title: "Pulled", type: "word", folder: homeIn(b.root) }, b.root);
  const first = (await b.router.dispatch("POST", "/editor-config", { doc: doc.docId })).body as { document: { key: string } };
  const file = doc.path;
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const second = (await b.router.dispatch("POST", "/editor-config", { doc: doc.docId })).body as { document: { key: string } };
  assert.notEqual(second.document.key, first.document.key, "the Document Server downloads the file afresh");
  assert.equal(second.document.key, makeKey(doc.docId, fs.statSync(file).mtimeMs));
  assert.equal(store.getDoc(doc.docId, b.root)!.mtimeMs, fs.statSync(file).mtimeMs, "and the index has it");
  live.clearDoc(doc.docId);
  await b.cleanup();
});

test("editor-config: an editor opened while a session that saved this revision is open joins that session (its key), not a second one beside it", async () => {
  const b = await boot();
  writeDsJson(b);
  const doc = await store.createDoc({ title: "Joined", type: "word", folder: homeIn(b.root) }, b.root);
  const opened = (await b.router.dispatch("POST", "/editor-config", { doc: doc.docId })).body as { document: { key: string } };
  const key = opened.document.key;
  live.setSession(doc.docId, key, ["portal-user"]);
  // The session saved (a forcesave): a new revision, which its key does not name.
  const saved = await savedBySession(b, doc, key, "saved by the open session");
  assert.notEqual(makeKey(doc.docId, saved), key);
  const second = (await b.router.dispatch("POST", "/editor-config", { doc: doc.docId })).body as { document: { key: string } };
  assert.equal(second.document.key, key, "the second editor joins the open session");
  // Once that session is over, a new editor opens the revision under its own key.
  live.endSession(doc.docId, key);
  const third = (await b.router.dispatch("POST", "/editor-config", { doc: doc.docId })).body as { document: { key: string } };
  assert.equal(third.document.key, makeKey(doc.docId, saved));
  live.resetLive();
  await b.cleanup();
});

/** `bytes` saved by the session of `key` through the loopback listener's callback (a status-6 forcesave), as the
 * Document Server saves it: the new revision. */
async function savedBySession(b: Booted, doc: store.DocMeta, key: string, bytes: string): Promise<number> {
  const files = http.createServer((_req, res) => res.end(bytes));
  await new Promise<void>((resolve) => files.listen(0, "127.0.0.1", resolve));
  writeDsJson(b, `http://127.0.0.1:${(files.address() as AddressInfo).port}`);
  const envelope = { key, status: 6, url: "http://portal.test/api/x/%40pithagoras/office/ds/cache/files/data/x/output.docx?md5=x", forcesavetype: 0 };
  const answer = await fetch(`http://127.0.0.1:${loopbackPort()}/callback`, { method: "POST", headers: { "content-type": "application/json", "x-auth-token": `Bearer ${signJwt({ payload: envelope, operation: "callback" }, 60_000, jwtSecret(b.root))}` }, body: "{}" });
  assert.deepEqual(await answer.json(), { error: 0 });
  files.closeAllConnections();
  files.close();
  return store.getDoc(doc.docId, b.root)!.mtimeMs;
}

test("/editor-state: an editor's key is current on its own revision and on what its session saved, and is behind a change made outside", async () => {
  const b = await boot();
  writeDsJson(b);
  const doc = await store.createDoc({ title: "Standing", type: "word", folder: homeIn(b.root) }, b.root);
  const key = makeKey(doc.docId, doc.mtimeMs);
  const ask = async (k = key) => (await b.router.dispatch("GET", `/editor-state?doc=${encodeURIComponent(doc.docId)}&key=${encodeURIComponent(k)}`)).body;
  assert.deepEqual(await ask(), { standing: "current", docchat: [] });
  const saved = await savedBySession(b, doc, key, "saved by the session");
  assert.deepEqual(await ask(), { standing: "current", docchat: [] }, "its own save does not take it off its revision");
  assert.ok(saved > doc.mtimeMs);
  const file = doc.path;
  // A script writes the file: nothing the editor's session had is in that revision.
  fs.writeFileSync(file, "a script's");
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.deepEqual(await ask(), { standing: "behind", docchat: [] });
  // A key of another document, or none, is refused.
  const other = await store.createDoc({ title: "Other", type: "word", folder: homeIn(b.root) }, b.root);
  assert.equal((await b.router.dispatch("GET", `/editor-state?doc=${encodeURIComponent(doc.docId)}&key=${encodeURIComponent(makeKey(other.docId, other.mtimeMs))}`)).statusCode, 400);
  assert.equal((await b.router.dispatch("GET", `/editor-state?doc=${encodeURIComponent(doc.docId)}`)).statusCode, 400);
  live.resetLive();
  await b.cleanup();
});

test("editor-config while a new Document Server still makes its fonts: 503 ds_starting, no seat taken; once it is done, the config", async () => {
  const b = await boot();
  writeDsJson(b);
  b.dock.put("pithagoras-office-ds", { Image: DEFAULT_TAG }, { state: "running" });
  container.forgetProbe();
  let making = true;
  b.dock.state.answer = (cmd) => (cmd.join(" ").includes("AllFonts.js") ? { output: "", exitCode: making ? 1 : 0, timedOut: false } : undefined);
  const doc = await store.createDoc({ title: "Early", type: "word", folder: homeIn(b.root) }, b.root);
  let res = await b.router.dispatch("POST", "/editor-config", { doc: doc.docId });
  assert.equal(res.statusCode, 503);
  assert.equal((res.body as Record<string, unknown>).code, "ds_starting");
  assert.deepEqual(live.usersOf(doc.docId), [], "nobody is shown editing a document whose editor did not open");
  making = false;
  res = await b.router.dispatch("POST", "/editor-config", { doc: doc.docId });
  assert.equal(res.statusCode, 200);
  live.clearDoc(doc.docId);
  await b.cleanup();
});

test("editor-config while a start is under way (no ds.json until it ends): 503 ds_starting, not \"not configured\"", async () => {
  const b = await boot();
  const doc = await store.createDoc({ title: "Soon", type: "word", folder: homeIn(b.root) }, b.root);
  // The image download holds the start until the test lets it go.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const ensure = b.dock.docker.images.ensure;
  b.dock.docker.images.ensure = async (image, onProgress) => {
    await held;
    return ensure(image, onProgress);
  };
  b.dock.state.exec = { output: "", exitCode: 0, timedOut: false }; // set up as soon as it runs
  const started = b.router.dispatch("POST", "/container/start", {});
  let res = await b.router.dispatch("POST", "/editor-config", { doc: doc.docId });
  assert.equal(res.statusCode, 503);
  assert.equal((res.body as Record<string, unknown>).code, "ds_starting");
  release();
  assert.equal((await started).statusCode, 200);
  res = await b.router.dispatch("POST", "/editor-config", { doc: doc.docId });
  assert.equal(res.statusCode, 200);
  live.clearDoc(doc.docId);
  // Never started: said so, as before.
  fs.rmSync(path.join(b.root, "ds.json"));
  res = await b.router.dispatch("POST", "/editor-config", { doc: doc.docId });
  assert.equal((res.body as Record<string, unknown>).code, "ds_not_configured");
  await b.cleanup();
});

test("editor-config (xlsx): documentType cell, also for a portal in a container; unconfigured -> 503; unknown doc -> 404", async () => {
  const b = await boot(undefined, fakeDocker({ sharedNetwork: "container:9f3a1c2d", reach: { host: "pithagoras-office-ds-relay", port: 3890 } }));
  writeDsJson(b, "http://pithagoras-office-ds-relay:3890");
  const cell = await store.createDoc({ title: "Budget", type: "cell", folder: homeIn(b.root) }, b.root);
  let res = await b.router.dispatch("POST", "/editor-config", { doc: cell.docId });
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as Record<string, unknown>).documentType, "cell");
  live.clearDoc(cell.docId);

  // and with no ds.json at all: 503 not-configured; unknown doc: 404
  fs.rmSync(path.join(b.root, "ds.json"));
  res = await b.router.dispatch("POST", "/editor-config", { doc: cell.docId });
  assert.equal(res.statusCode, 503);
  res = await b.router.dispatch("POST", "/editor-config", { doc: "nope" });
  assert.equal(res.statusCode, 404);
  assert.equal((res.body as Record<string, unknown>).code, "not_found");
  await b.cleanup();
});

/** A workspace of folders, as a portal lists them: the default agent's home, another agent's, a project, a folder a
 * chat works in inside the project, and one outside every home and project. */
function workspace(): { ws: string; home: string; a: string; project: string; sub: string; loose: string; listed: ListedFolder[]; chats: Record<string, string> } {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-folders-")));
  const [home, a, project, loose] = ["home", "a", "project", "loose"].map((n) => path.join(ws, n));
  const sub = path.join(project, "sub");
  for (const d of [home, a, sub, loose]) fs.mkdirSync(d, { recursive: true });
  return {
    ws, home, a, project, sub, loose,
    listed: [
      { path: home, name: "Home", kind: "agent", home: true },
      { path: a, name: "Atlas", kind: "agent" },
      { path: project, name: "Report", kind: "project" },
      { path: sub, name: "Report/sub", kind: "chat" },
      { path: loose, name: "loose", kind: "chat" },
    ],
    chats: { "chat-home": home, "chat-a": a, "chat-project": project, "chat-sub": sub, "chat-loose": loose },
  };
}

test("/scope: what the agent or project of a chat sees, whose the portal says the chat is (chats.owner); a chat in a project's subfolder is the project's, one in a link in an agent's home that leads into a project the agent's, one outside every home and project the default agent's; a chat that is gone sees none", async () => {
  const w = workspace();
  fs.writeFileSync(path.join(w.project, "theirs.docx"), await store.templateDocx());
  // A link in the default agent's home into the project: the portal holds a chat there to be the agent's (the sandbox
  // runs it as that agent), wherever the link leads.
  fs.symlinkSync(w.project, path.join(w.home, "report-link"));
  const bt = await boot(undefined, fakeDocker(), { ...w.chats, "chat-link": path.join(w.home, "report-link") }, w.listed);
  const theirs = store.listDocs(bt.root).find((d) => d.title === "theirs")!;
  assert.equal(theirs.owner, w.project, "the boot scan found it, and it is the project's");
  const human = await store.createDoc({ title: "The person's", type: "word", folder: w.home }, bt.root);
  const mine = await store.createDoc({ title: "A's", type: "word", folder: w.a }, bt.root);
  const scope = async (chat: string) => ((await bt.router.dispatch("GET", `/scope?chat=${chat}`)).body as { docIds: string[] }).docIds.sort();
  assert.deepEqual(await scope("chat-a"), [mine.docId]);
  assert.deepEqual(await scope("chat-project"), [theirs.docId]);
  assert.deepEqual(await scope("chat-sub"), [theirs.docId]);
  assert.deepEqual(await scope("chat-home"), [human.docId]);
  assert.deepEqual(await scope("chat-loose"), [human.docId]);
  assert.deepEqual(await scope("chat-link"), [human.docId], "the agent's, as the portal says");
  assert.deepEqual(await scope("chat-gone"), []);
  await bt.cleanup();
  fs.rmSync(w.ws, { recursive: true, force: true });
});

test("the office tools are given to a chat by the panel's rule: whose the portal says the chat is, a chat in a project's subfolder and one in a link in an agent's home included; a chat that is neither's, or gone, gets none", async () => {
  const w = workspace();
  fs.symlinkSync(w.project, path.join(w.home, "report-link"));
  const bt = await boot(undefined, fakeDocker(), { ...w.chats, "chat-link": path.join(w.home, "report-link") }, w.listed);
  try {
    const all = ["office_comments", "office_create", "office_edit", "office_format", "office_list", "office_read", "office_screenshot"];
    for (const chat of ["chat-a", "chat-home", "chat-project", "chat-sub", "chat-link"]) assert.deepEqual(bt.toolsOf(chat), all, chat);
    assert.deepEqual(bt.toolsOf("chat-loose"), [], "in no agent's home nor project");
    assert.deepEqual(bt.toolsOf("chat-gone"), []);
  } finally {
    await bt.cleanup();
    fs.rmSync(w.ws, { recursive: true, force: true });
  }
});

test("POST /documents: the Office tab's New document is made in the home New starts the person's chats in (the default agent's where none is marked), a chat panel's in the chat's agent home or project folder; no home is a 409", async () => {
  const w = workspace();
  const bt = await boot(undefined, fakeDocker(), w.chats, w.listed);
  const make = async (body: Record<string, unknown>) => bt.router.dispatch("POST", "/documents", { type: "word", ...body });
  const tab = await make({ title: "Minutes" });
  assert.equal(tab.statusCode, 201);
  const minutes = tab.body as store.DocMeta;
  assert.equal(minutes.path, path.join(w.home, "Minutes.docx"));
  assert.equal(minutes.owner, w.home);
  assert.ok(fs.existsSync(minutes.path));
  assert.ok(!fs.existsSync(path.join(bt.root, "docs")), "nothing in the extension's own folder");
  assert.equal(((await make({ title: "Atlas notes", chat: "chat-a" })).body as store.DocMeta).path, path.join(w.a, "Atlas notes.docx"));
  assert.equal(((await make({ title: "Sub notes", chat: "chat-sub" })).body as store.DocMeta).owner, w.project);
  assert.equal(((await make({ title: "Loose notes", chat: "chat-loose" })).body as store.DocMeta).owner, w.home);
  // An owner the page names is not taken: where a document goes is the server half's to decide.
  assert.equal(((await make({ title: "Elsewhere", owner: w.a })).body as store.DocMeta).owner, w.home);
  assert.equal((await make({ title: "Gone", chat: "chat-gone" })).statusCode, 404);
  assert.ok(bt.audits.some((a) => String(a.reason).includes(path.join(w.home, "Minutes.docx"))), "the audit says where it was made");
  await bt.cleanup();
  // The person picked Atlas for new chats ("New chats start here"): the Office tab's new documents go to its home.
  const picked = await boot(undefined, fakeDocker(), w.chats, w.listed.map((f) => (f.path === w.a ? { ...f, newChats: true as const } : f)));
  const made = await picked.router.dispatch("POST", "/documents", { type: "word", title: "Picked" });
  assert.equal(made.statusCode, 201);
  assert.equal((made.body as store.DocMeta).path, path.join(w.a, "Picked.docx"));
  assert.equal((made.body as store.DocMeta).owner, w.a);
  await picked.cleanup();
  const none = await boot(undefined, fakeDocker(), {}, w.listed.filter((f) => !f.home));
  const refused = await none.router.dispatch("POST", "/documents", { title: "Nowhere", type: "word" });
  assert.equal(refused.statusCode, 409);
  assert.equal((refused.body as { code: string }).code, "no_home");
  await none.cleanup();
  fs.rmSync(w.ws, { recursive: true, force: true });
});

test("boot: the scan takes only the agents' homes and the projects, and a document an earlier version found elsewhere leaves the index", async () => {
  const w = workspace();
  fs.writeFileSync(path.join(w.loose, "loose.docx"), await store.templateDocx());
  fs.writeFileSync(path.join(w.sub, "deep.docx"), await store.templateDocx());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-boot-scan-"));
  store.scanWorkspace([w.loose], root); // as an earlier version did: every folder a chat works in
  assert.equal(store.listDocs(root).length, 1);
  const bt = await boot(root, fakeDocker(), w.chats, w.listed);
  assert.deepEqual(store.listDocs(root).map((d) => [d.title, d.owner]), [["deep", w.project]]);
  assert.ok(fs.existsSync(path.join(w.loose, "loose.docx")), "its file stays");
  assert.ok(bt.logs.some((l) => /workspace scan at boot: 1 added, 0 refreshed, 1 out of every agent's home and project/.test(l)), bt.logs.join("\n"));
  await bt.cleanup();
  fs.rmSync(w.ws, { recursive: true, force: true });
});

test("boot: the documents an earlier version made in its own docs folder move into the default agent's home, or their agent's, and the move is logged", async () => {
  const w = workspace();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-boot-move-"));
  const legacy = (docId: string, title: string, owner: string | null) => {
    fs.mkdirSync(path.join(root, "docs", docId), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", docId, `${title}.docx`), `${title}'s bytes`);
    return { docId, title, ext: "docx", createdAt: 1, updatedAt: 1, sizeBytes: 9, mtimeMs: 1, owner, grants: [] };
  };
  fs.writeFileSync(path.join(w.home, "Minutes.docx"), "the agent's own minutes");
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({ version: 1, docs: [legacy("minutes-aaaaaa", "Minutes", null), legacy("plan-bbbbbb", "Plan", w.a)] }));
  const bt = await boot(root, fakeDocker(), w.chats, w.listed);
  const minutes = store.getDoc("minutes-aaaaaa", root)!;
  assert.equal(minutes.path, path.join(w.home, "Minutes (2).docx"), "a name taken there gets a number");
  assert.equal(minutes.owner, w.home);
  assert.equal(fs.readFileSync(minutes.path, "utf8"), "Minutes's bytes");
  assert.equal(store.getDoc("plan-bbbbbb", root)!.path, path.join(w.a, "Plan.docx"), "an agent's goes into its own home");
  assert.ok(!fs.existsSync(path.join(root, "docs")));
  assert.ok(bt.logs.some((l) => l.includes(`"Minutes (2)" (minutes-aaaaaa) moved from the extension's docs folder to ${minutes.path}`)), bt.logs.join("\n"));
  // The scan after it finds the agent's own file as a document of its own, and the moved ones as what they are.
  assert.deepEqual(store.listDocs(root).map((d) => d.title).sort(), ["Minutes", "Minutes (2)", "Plan"]);
  await bt.cleanup();
  fs.rmSync(w.ws, { recursive: true, force: true });
});

test("a document of the docs folder that could not be moved at boot (no default agent's home listed yet) is moved by a Rescan, not only at the next start", async () => {
  const w = workspace();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-rescan-move-"));
  fs.mkdirSync(path.join(root, "docs", "memo-aaaaaa"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "memo-aaaaaa", "Memo.docx"), "memo");
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({ version: 1, docs: [{ docId: "memo-aaaaaa", title: "Memo", ext: "docx", createdAt: 1, updatedAt: 1, sizeBytes: 4, mtimeMs: 1, owner: null, grants: [] }] }));
  const listed = w.listed.filter((f) => !f.home);
  const bt = await boot(root, fakeDocker(), w.chats, listed);
  assert.equal(store.getDoc("memo-aaaaaa", root), null, "kept apart: no default home to move it to");
  listed.push(w.listed.find((f) => f.home)!);
  assert.equal((await bt.router.dispatch("POST", "/documents/rescan", {})).statusCode, 200);
  assert.equal(store.getDoc("memo-aaaaaa", root)!.path, path.join(w.home, "Memo.docx"));
  assert.equal(bt.logs.filter((l) => /memo-aaaaaa\) could not be moved/.test(l)).length, 1, bt.logs.join("\n"));
  await bt.cleanup();
  fs.rmSync(w.ws, { recursive: true, force: true });
});

test("/state answers for an entry an earlier version scanned with no owner yet, while no folder is listed to give it one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-ownerless-state-"));
  const home = homeIn(root, "gone-home");
  const doc = await store.createDoc({ title: "Away", type: "word", folder: home }, root);
  const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
  index.docs[0].owner = null;
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(index));
  const bt = await boot(root, fakeDocker(), {}, []);
  const res = await bt.router.dispatch("GET", "/state");
  assert.equal(res.statusCode, 200);
  const got = (res.body as { docs: { docId: string; owner: string; ownerName: string }[] }).docs.find((d) => d.docId === doc.docId)!;
  assert.deepEqual([got.owner, got.ownerName], ["", ""]);
  await bt.cleanup();
});

test("boot moves owners and grants that named a chat to that chat's folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-migrate-"));
  const doc = await store.createDoc({ title: "Owned before", type: "word", folder: homeIn(root) }, root);
  const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
  index.docs[0].owner = "chat-a";
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(index));
  const bt = await boot(root, fakeDocker(), { "chat-a": "/homes/a" });
  assert.equal(store.getDoc(doc.docId, root)!.owner, "/homes/a");
  await bt.cleanup();
});

test("a change asked from another page than the portal's own is refused; a read is not", async () => {
  const b = await boot();
  const doc = await store.createDoc({ title: "Kept", type: "word", folder: homeIn(b.root) }, b.root);
  const elsewhere = { origin: "http://portal.test:8081" };
  for (const [method, url, body] of [["DELETE", `/documents/${doc.docId}`], ["POST", "/container/remove", { data: true }], ["POST", "/settings", { imageTag: "x/y:1" }]] as const) {
    const res = await b.router.dispatch(method, url, body, elsewhere);
    assert.equal(res.statusCode, 403, `${method} ${url}`);
  }
  assert.ok(store.getDoc(doc.docId, b.root), "nothing was deleted");
  assert.equal((await b.router.dispatch("GET", "/state", undefined, elsewhere)).statusCode, 200);
  await b.cleanup();
});

/* ---------------- /state ---------------- */

test("/state: settings + container status + docs list + locks for EVERY doc", async () => {
  const b = await boot();
  const d1 = await store.createDoc({ title: "Alpha", type: "word", folder: homeIn(b.root) }, b.root);
  const d2 = await store.createDoc({ title: "Beta", type: "cell", folder: homeIn(b.root) }, b.root);
  live.setUser(d1.docId, { id: "u-ada", name: "Ada" }, true);

  const res = await b.router.dispatch("GET", "/state");
  assert.equal(res.statusCode, 200);
  const body = res.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["agent", "container", "docs", "enabled", "imageTag", "limitBounds", "limits", "locks"]);
  assert.deepEqual(
    body.agent,
    { present: false, pull: null, tag: container.AGENT_IMAGE_TAG, browser: { running: false, starting: false, editors: 0 } },
    "the agents' editor is not downloaded yet, and its browser not running",
  );
  assert.equal(body.enabled, false); // defaults from a fresh dataDir
  assert.equal(body.imageTag, DEFAULT_TAG);
  const c = body.container as Record<string, unknown>;
  assert.equal(c.state, "stopped"); // fake docker: nothing made yet
  const docs = body.docs as store.DocMeta[];
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.title).sort(), ["Alpha", "Beta"]);
  const locks = body.locks as Record<string, { id: string; name?: string }[]>;
  assert.deepEqual(locks[d1.docId], [{ id: "u-ada", name: "Ada" }]);
  assert.deepEqual(locks[d2.docId], [], "every doc gets a locks entry -- empty when nobody is in it");

  live.resetLive();
  await b.cleanup();
});

/* ---------------- /documents CRUD ---------------- */

test("/documents: create (409 on duplicate), rename keeps mtimeMs, download bytes+disposition, delete clears live presence", async () => {
  const w = workspace();
  const b = await boot(undefined, fakeDocker(), w.chats, w.listed);

  let res = await b.router.dispatch("POST", "/documents", { title: "Plan", type: "word" });
  assert.equal(res.statusCode, 201);
  const meta = res.body as store.DocMeta;
  assert.equal(meta.ext, "docx");
  assert.ok(meta.docId.length > 0);

  res = await b.router.dispatch("POST", "/documents", { title: "Plan", type: "word" }); // same title+ext -> exists
  assert.equal(res.statusCode, 409);
  assert.equal((res.body as Record<string, unknown>).code, "exists");

  res = await b.router.dispatch("POST", "/documents", { title: "", type: "word" });
  assert.equal(res.statusCode, 400);
  res = await b.router.dispatch("POST", "/documents", { title: "X", type: "slides" });
  assert.equal(res.statusCode, 400);

  // rename: a new title, the SAME mtimeMs (open sessions' revision survives a retitle)
  const before = store.getDoc(meta.docId, b.root) as store.DocMeta;
  res = await b.router.dispatch("POST", `/documents/${meta.docId}/rename`, { title: "Plan v2" });
  assert.equal(res.statusCode, 200);
  const after = res.body as store.DocMeta;
  assert.equal(after.title, "Plan v2");
  assert.equal(after.mtimeMs, before.mtimeMs);

  // download: the exact disk bytes with an attachment disposition
  live.setUser(meta.docId, { id: "u-1", name: "U" }, true); // set presence BEFORE delete to prove clearDoc
  res = await b.router.dispatch("GET", `/documents/${meta.docId}`);
  assert.equal(res.statusCode, 200);
  const disk = fs.readFileSync(after.path);
  assert.ok(Buffer.compare(Buffer.from(res.data as Buffer), disk) === 0);
  assert.equal(res.headers["content-type"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.match(String(res.headers["content-disposition"]), /attachment; filename="Plan v2\.docx"/);

  // delete: gone, and the live doc cleared with it
  res = await b.router.dispatch("DELETE", `/documents/${meta.docId}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(live.usersOf(meta.docId), []);
  res = await b.router.dispatch("GET", `/documents/${meta.docId}`);
  assert.equal(res.statusCode, 404);
  // export of a gone doc refuses too
  res = await b.router.dispatch("GET", `/documents/${meta.docId}/export`);
  assert.equal(res.statusCode, 404);

  live.resetLive();
  await b.cleanup();
});

/* ---------------- /documents/rescan (the import route is gone) ---------------- */

/** Point the fake portal's folders.list at a workspace AFTER boot: the rescan route reads it live per request,
 * so overwriting the method is enough -- exactly how a real portal picks up newly added agent folders. */
function pointFoldersAt(b: Booted, ...dirs: string[]): void {
  // the route reads AgentFolder[] ({path,name,kind}) -- the fake must hand back that shape, not bare strings
  (b.portal as unknown as { folders: { list: () => Array<{ path: string; name: string; kind: string }> } }).folders.list =
    () => dirs.map((d) => ({ path: d, name: path.basename(d), kind: "project" }));
}

test("/documents/rescan: indexes in place (no copy), skips hidden/node_modules/.txt, second run is a no-op", async () => {
  const b = await boot(); // boots with folders.list -> [] : the boot scan logs zero and touches nothing
  assert.ok(b.logs.some((l) => l.startsWith("workspace scan at boot:")), "boot logged its workspace scan");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-ws-"));
  const srcBytes = Buffer.from(`a docx of sorts ${Date.now()}`);
  fs.writeFileSync(path.join(ws, "report.docx"), srcBytes);
  fs.mkdirSync(path.join(ws, "deep", "drafts"), { recursive: true }); // nested dirs ARE walked
  fs.writeFileSync(path.join(ws, "deep", "drafts", "plan.xlsx"), Buffer.from("an xlsx of sorts"));
  fs.mkdirSync(path.join(ws, ".hidden"));
  fs.writeFileSync(path.join(ws, ".hidden", "secret.docx"), srcBytes); // hidden dir: never indexed
fs.mkdirSync(path.join(ws, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "pkg", "bundled.docx"), srcBytes); // node_modules: never indexed
  fs.writeFileSync(path.join(ws, "notes.txt"), "plain text is not office"); // wrong type: ignored, not an error
  pointFoldersAt(b, ws);

  const res = await b.router.dispatch("POST", "/documents/rescan");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { added: 2, updated: 0 });
  const docs = store.listDocs(b.root);
  assert.equal(docs.length, 2);
  const report = docs.find((d) => d.title === "report")!;
  assert.equal(report.path, path.join(ws, "report.docx"), "the entry points at the REAL file");
  assert.ok(fs.existsSync(path.join(ws, "report.docx")), "the source file is still where it was: IN PLACE, never copied");
  assert.ok(!fs.existsSync(path.join(b.root, "docs", report.docId)), "nothing was written into the library's docs/ for a scanned doc");
  assert.equal(report.owner, fs.realpathSync(ws), "the project's whose folder it is in");
  assert.equal(report.imported, true);

  // rescan again with nothing changed: idempotent by realpath identity, counts stay honest
  const again = await b.router.dispatch("POST", "/documents/rescan");
  assert.deepEqual(again.body, { added: 0, updated: 0 });
  assert.equal(store.listDocs(b.root).length, 2);

  // something wrote the file straight to disk (an agent outside DS): a rescan REFRESHES it in place
  const bigger = Buffer.concat([srcBytes, Buffer.from(" more")]);
  fs.writeFileSync(path.join(ws, "report.docx"), bigger);
  const refresh = await b.router.dispatch("POST", "/documents/rescan");
  assert.deepEqual(refresh.body, { added: 0, updated: 1 });
  const refreshed = store.listDocs(b.root).find((d) => d.docId === report.docId)!;
  assert.equal(refreshed.sizeBytes, bigger.length);
  assert.ok(Math.abs(refreshed.mtimeMs - fs.statSync(path.join(ws, "report.docx")).mtimeMs) < 50, "mtimeMs now matches the file on disk");

  // /state's payload carries the sort keys: mtimeMs and sizeBytes are real numbers, path is where it lives
  const state = (await b.router.dispatch("GET", "/state")).body as { docs: Array<Record<string, unknown>> };
  const stReport = state.docs.find((d) => d.docId === report.docId)!;
  assert.equal(typeof stReport.mtimeMs, "number");
  assert.equal(stReport.sizeBytes, bigger.length);
  assert.equal(stReport.path, path.join(ws, "report.docx"));

  // export of a scanned doc serves the REAL file's bytes as an attachment (fileFor honors DocMeta.path)
  const ex = await b.router.dispatch("GET", `/documents/${report.docId}/export`);
  assert.equal(ex.statusCode, 200);
  assert.ok(Buffer.compare(Buffer.from(ex.data as Buffer), bigger) === 0);
  assert.match(String(ex.headers["content-disposition"]), /filename="report\.docx"/);

  // the manual import surface is GONE: no route registered at all (MiniRouter throws, not a coded refusal)
  await assert.rejects(b.router.dispatch("POST", "/import", { path: path.join(ws, "report.docx") }), /no registered POST route for \/import/);

  fs.rmSync(ws, { recursive: true, force: true });
  await b.cleanup();
});

test("/documents/rescan: a docx with pre-existing comments is indexed without reading them (no comment baseline)", async () => {
  const b = await boot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-ws-baseline-"));
  const docBytes = rewriteZip(await store.templateDocx(), { "word/comments.xml": commentsXmlWith([
    { id: "1", author: "Cara", text: "a mention from before the library existed" },
  ]) });
  fs.writeFileSync(path.join(ws, "legacy.docx"), docBytes);
  pointFoldersAt(b, ws);

  const res = await b.router.dispatch("POST", "/documents/rescan");
  assert.equal(res.statusCode, 200);
  const doc = store.listDocs(b.root).find((d) => d.title === "legacy")!;
  assert.equal("importedKeys" in doc, false, "indexing reads no comments of the file: nothing wakes on them any more");
  fs.rmSync(ws, { recursive: true, force: true });
  await b.cleanup();
});

/** Minimal comments.xml body for a docx (ping.test has its own richer variant). */
function commentsXmlWith(comments: Array<{ id: string; author: string; text: string }>): string {
  const items = comments.map((c) => `<w:comment w:id="${c.id}" w:author="${c.author}"><w:p><w:r><w:t>${c.text}</w:t></w:r></w:p></w:comment>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${items}</w:comments>`;
}

/* ---------------- /settings + container routes ---------------- */

test("/settings: enable fires ensureContainer exactly once with the settings tag; disable stops + leaves the user-stopped marker", async () => {
  const b = await boot();
  const m = b.dock;
  const creates = () => m.calls.filter((c) => c === "create pithagoras-office-ds");
  const starts = () => m.calls.filter((c) => c === "start pithagoras-office-ds");
  assert.equal(store.listDocs(b.root).length, 0);
  // a LEGACY settings file (written before the removed switch existed) must load without crashing -- write it
  // before any POST so every route in this test runs over tolerant loading; saveSettings then rewrites it clean.
  fs.writeFileSync(path.join(b.root, "settings.json"), JSON.stringify({ enabled: false, imageTag: DEFAULT_TAG, coEdit: true }));

  // enable: side effect is fire-and-forget -- poll for the create, not the response
  let res = await b.router.dispatch("POST", "/settings", { enabled: true });
  assert.equal(res.statusCode, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal((body.settings as Record<string, unknown>).enabled, true);
  assert.equal(body.starting, true, "the response says the start is underway");
  await until(() => fs.existsSync(path.join(b.root, "ds.json")));
  assert.equal(creates().length, 1);
  const spec = m.containers.get("pithagoras-office-ds")!.spec;
  assert.equal(spec.Image, DEFAULT_TAG, "the tag comes from settings (default), not a constant");
  assert.ok((spec.Env as string[]).includes(`JWT_SECRET=${jwtSecret(b.root)}`), "the container is env'd with the boot secret");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.root, "ds.json"), "utf8")), { containerId: m.containers.get("pithagoras-office-ds")!.info.id, imageTag: DEFAULT_TAG });
  // The relay opens the way back to tunnels that carry this half's key.
  assert.ok((m.containers.get("pithagoras-office-ds-relay")!.spec.Env as string[]).includes(`TUNNEL_KEY=${fs.readFileSync(path.join(b.root, "relay-secret"), "utf8").trim()}`));
  assert.equal(starts().length, 1);

  // a second enable is an adopt: no second create, no restart
  res = await b.router.dispatch("POST", "/settings", { enabled: true });
  assert.equal((res.body as Record<string, unknown>).starting, undefined, "already enabled -> no start fired");
  await new Promise((r) => setTimeout(r, 100)); // give a stray fire-and-forget a chance to (wrongly) run
  assert.equal(creates().length, 1);
  assert.equal(starts().length, 1);

  // disable: awaited stop + the intent marker on disk
  res = await b.router.dispatch("POST", "/settings", { enabled: false });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(m.calls.filter((c) => c.startsWith("stop")), ["stop pithagoras-office-ds"]);
  assert.ok(fs.existsSync(path.join(b.root, "user-stopped")), "user-stopped marker file written");
  assert.equal((res.body as { settings: Record<string, unknown> }).settings.enabled, false);
  assert.equal((res.body as { container: Record<string, unknown> }).container.state, "stopped");

  // and :latest is refused with a real reason
  res = await b.router.dispatch("POST", "/settings", { imageTag: "onlyoffice/documentserver:latest" });
  assert.equal(res.statusCode, 400);
  assert.equal((res.body as Record<string, unknown>).code, "invalid_image_tag");
  // and so is a tag-less one, which Docker reads as :latest
  res = await b.router.dispatch("POST", "/settings", { imageTag: "onlyoffice/documentserver" });
  assert.equal(res.statusCode, 400);
  assert.equal((res.body as Record<string, unknown>).code, "invalid_image_tag");
  // and an image by its digest, which Docker for extensions would split inside the digest
  res = await b.router.dispatch("POST", "/settings", { imageTag: "onlyoffice/documentserver@sha256:0123456789abcdef" });
  assert.equal(res.statusCode, 400);
  assert.match(String((res.body as Record<string, unknown>).error), /digest/);

  // there is no co-editing switch in this payload any more (the agent is a co-editor under the revision gate,
  // full stop): a body carrying only the LEGACY key hits the existing no-known-setting path and changes nothing
  res = await b.router.dispatch("POST", "/settings", { coEdit: true });
  assert.equal(res.statusCode, 400);
  assert.match(String((res.body as Record<string, unknown>).error), /no known setting/);
  const after = await b.router.dispatch("GET", "/state");
  assert.equal(after.statusCode, 200, "a legacy key in the body must not wedge the state poller");
  assert.ok(!JSON.stringify(after.body).includes("coEdit"), "the removed setting never lands in the /state payload");

  // the audit sink got the settings change
  assert.ok(b.audits.some((a) => String(a.subject).includes("settings")), "the settings change was audited");

  live.resetLive();
  await b.cleanup();
});

test("/container/status + /container/start + /container/stop + /container/remove drive the same lifecycle", async () => {
  const b = await boot();
  const m = b.dock;
  m.state.exec = { output: "", exitCode: 0, timedOut: false }; // set up as soon as it runs (see container.settled)

  let res = await b.router.dispatch("GET", "/container/status");
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as Record<string, unknown>).state, "stopped");

  res = await b.router.dispatch("POST", "/container/start");
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as Record<string, unknown>).started, true);
  assert.equal((res.body as { container: Record<string, unknown> }).container.state, "running");

  res = await b.router.dispatch("POST", "/container/start"); // idempotent adopt
  assert.equal((res.body as Record<string, unknown>).started, false);
  assert.equal(m.calls.filter((c) => c === "start pithagoras-office-ds").length, 1, "never restarted");

  res = await b.router.dispatch("POST", "/container/stop");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(m.calls.filter((c) => c.startsWith("stop")), ["stop pithagoras-office-ds"]);
  assert.ok(fs.existsSync(path.join(b.root, "user-stopped")));

  res = await b.router.dispatch("POST", "/container/remove", { data: true });
  assert.equal(res.statusCode, 200);
  assert.deepEqual([...m.containers.keys()], [], "the Document Server and its relay are gone");
  assert.equal(m.networks.size, 0);
  assert.deepEqual([...m.volumes.keys()], [], "with data: both volumes");
  assert.ok(b.audits.some((a) => /removed, with its volume/.test(String(a.reason))));

  live.resetLive();
  await b.cleanup();
});

test("Start downloads the agents' editor's image beside the Document Server, and /state says how both stand; there is no download of its own", async () => {
  const b = await boot();
  const m = b.dock;
  m.state.exec = { output: "", exitCode: 0, timedOut: false };
  const ensure = m.docker.images.ensure;
  m.docker.images.ensure = async (image, onProgress) => {
    await ensure(image, onProgress);
    if (image === container.AGENT_IMAGE_TAG) m.state.images.add(container.AGENT_IMAGE);
  };
  const res = await b.router.dispatch("POST", "/container/start");
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.body as { agent: unknown }).agent, { present: true });
  assert.ok(m.calls.includes(`pull ${container.AGENT_IMAGE_TAG}`));
  const state = (await b.router.dispatch("GET", "/state")).body as { container: { state: string }; agent: Record<string, unknown> };
  assert.equal(state.container.state, "running");
  assert.equal(state.agent.present, true);
  assert.deepEqual(state.agent.browser, { running: false, starting: false, editors: 0 });
  assert.ok(b.audits.some((e) => e.subject === container.AGENT_IMAGE_TAG));
  await assert.rejects(b.router.dispatch("POST", "/agent/pull"), /no registered POST route/);
  live.resetLive();
  await b.cleanup();
});

test("Start switches Office on: while it is off the tools take Office as stopped, whatever runs", async () => {
  const b = await boot();
  b.dock.state.exec = { output: "", exitCode: 0, timedOut: false };
  assert.equal(((await b.router.dispatch("GET", "/state")).body as { enabled: boolean }).enabled, false);
  const res = await b.router.dispatch("POST", "/container/start");
  assert.equal(res.statusCode, 200);
  assert.equal(((await b.router.dispatch("GET", "/state")).body as { enabled: boolean }).enabled, true);
  live.resetLive();
  await b.cleanup();
});

test("switching Office on starts it as Start does: the agents' editor's image is downloaded too", async () => {
  const b = await boot();
  const res = await b.router.dispatch("POST", "/settings", { enabled: true });
  assert.equal((res.body as { starting?: boolean }).starting, true);
  await until(() => b.dock.calls.includes(`pull ${container.AGENT_IMAGE_TAG}`) && b.dock.calls.includes("start pithagoras-office-ds"));
  // This Docker names no image by the pinned digest: said on the page, the Document Server runs all the same.
  let agent = ((await b.router.dispatch("GET", "/state")).body as { agent: { pull: { error?: string } | null } }).agent;
  for (let i = 0; i < 100 && !agent.pull?.error; i++) {
    await new Promise((r) => setTimeout(r, 10));
    agent = ((await b.router.dispatch("GET", "/state")).body as { agent: { pull: { error?: string } | null } }).agent;
  }
  assert.match(agent.pull?.error ?? "", /is not the build this version of Office runs/);
  live.resetLive();
  await b.cleanup();
});

/* ---------------- settleKept ---------------- */

test("settleKept: stale index entries are pruned, orphan dirs stay, fresh trash is kept and old trash is swept", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-settle-"));
  // a real doc (bytes present) + a ghost entry whose file vanished out-of-band + an orphan file with NO index entry
  const home = homeIn(root);
  const real: store.DocMeta = { docId: "real-1", title: "Real", ext: "docx", createdAt: 1, updatedAt: 1, sizeBytes: 3, mtimeMs: 1, owner: home, grants: [], path: path.join(home, "Real.docx") };
  const ghost: store.DocMeta = { ...real, docId: "ghost-1", title: "Gone", path: path.join(home, "Gone.docx") };
  fs.writeFileSync(path.join(home, "Real.docx"), "abc");
  fs.writeFileSync(path.join(home, "Orphan.docx"), "abc"); // index is the source of truth: NOT added back
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({ version: 1, docs: [real, ghost] }));

  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const oldStamp = `${now - 8 * day}-old-doc`; // > 7 days -> swept
  const freshStamp = `${now - 2 * day}-fresh-doc`; // kept
  fs.mkdirSync(path.join(root, ".trash", oldStamp), { recursive: true });
  fs.mkdirSync(path.join(root, ".trash", freshStamp), { recursive: true });
  fs.mkdirSync(path.join(root, ".trash", "not-a-timestamp"), { recursive: true }); // not a deleteDoc entry -> untouched

  const out = settleKept(root);
  assert.equal(out.sweptTrash, 1);
  assert.deepEqual(out.prunedDocs, [], "a gone file is kept a while, in case it comes back");
  const marked = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8")) as { docs: store.DocMeta[] };
  marked.docs.find((d) => d.docId === "ghost-1")!.missingSince = now - 8 * day;
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(marked));
  assert.deepEqual(settleKept(root).prunedDocs, ["ghost-1"]);

  const idx = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8")) as { docs: store.DocMeta[] };
  assert.deepEqual(idx.docs.map((d) => d.docId), ["real-1"], "the ghost entry is gone and the orphan file was NOT indexed");
  assert.ok(!fs.existsSync(path.join(root, ".trash", oldStamp)), "the 8-day-old trash entry was swept");
  assert.ok(fs.existsSync(path.join(root, ".trash", freshStamp)), "the 2-day-old trash entry stays (7-day TTL)");
  assert.ok(fs.existsSync(path.join(root, ".trash", "not-a-timestamp")), "non-deleteDoc entries are untouched");
});

/* ---------------- GET /ds/* (browser -> DS proxy) ---------------- */

const API_JS_BYTES = Buffer.from("// stand-in for the real api.js: getBasePath() walks document scripts\nwindow.DocsAPI={};");

/** A fake Document Server on an ephemeral 127.0.0.1 port: serves /web-apps/... with a body + content-type,
 * answers a dedicated 404, and records every raw request url it received (the verbatim-pass-through proof). */
function startFakeDs(): Promise<{ server: http.Server; port: number; urls: string[] }> {
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    urls.push(req.url ?? "");
    if (req.method === "GET" && req.url?.startsWith("/web-apps/")) {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(API_JS_BYTES);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("nope");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, urls }));
  });
}

test("/ds proxy: 200 passes the body, content-type and the RAW query string verbatim to the recorded DS origin", async () => {
  const b = await boot();
  const ds = await startFakeDs();
  try {
    writeDsJson(b, `http://127.0.0.1:${ds.port}`);
    // the iframe-style query: percent-encoded chars must arrive upstream byte-for-byte (no re-encoding)
    const q = "/ds/web-apps/apps/api/documents/api.js?dockey=a%2Bb~c&lang=en-US&x=1%20two";
    const res = await b.router.dispatch("GET", q);
    assert.equal(res.statusCode, 200, "the upstream status passes through");
    assert.equal(Buffer.from(res.data as Buffer).compare(API_JS_BYTES), 0, "the body bytes are byte-for-byte what the DS sent");
    assert.match(String(res.headers["content-type"]), /application\/javascript/, "content-type is copied");
    assert.equal(res.headers["cache-control"], "no-cache", "cache-control is copied");
    const upstream = ds.urls.at(-1);
    assert.ok(upstream !== undefined, "the fake DS was hit");
    assert.equal(upstream, q.replace(/^\/ds/, ""), "path + raw query string reached the DS untouched (no re-encoding)");
  } finally {
    ds.server.closeAllConnections();
    await new Promise<void>((r) => ds.server.close(() => r()));
    await b.cleanup();
  }
});

test("/ds proxy: an upstream 404 passes through as a 404 with the upstream body", async () => {
  const b = await boot();
  const ds = await startFakeDs();
  try {
    writeDsJson(b, `http://127.0.0.1:${ds.port}`);
    const res = await b.router.dispatch("GET", "/ds/missing/page.html?dockey=z");
    assert.equal(res.statusCode, 404, "the upstream status passes through");
    assert.match(String(res.data), /nope/, "the upstream body passes through");
  } finally {
    ds.server.closeAllConnections();
    await new Promise<void>((r) => ds.server.close(() => r()));
    await b.cleanup();
  }
});

test("/ds proxy: an identity request answered with GZIP bytes + LYING headers still delivers the FULL original payload", async () => {
  // The bug of the first version of the /ds proxy, replayed against a hostile upstream: it honours NOTHING -- it answers our
  // accept-encoding: identity ask with a gzip body while declaring content-encoding: gzip and a
  // content-length sized to the COMPRESSED bytes. undici auto-decodes the gzip; the handler must not copy
  // either lying header, so the client reads every original byte intact -- no truncation, no manual gunzip.
  const ORIGINAL = Buffer.concat(Array.from({ length: 64 }, () => API_JS_BYTES));
  assert.ok(ORIGINAL.length > 1024, "sanity: the payload is big enough for gzip to shrink it");
  const gzipped = zlib.gzipSync(ORIGINAL);
  assert.ok(gzipped.length < ORIGINAL.length, "sanity: the gzip body is really smaller than the original");
  const b = await boot();
  const seenEncodings: string[] = [];
  let server: http.Server | undefined;
  try {
    server = http.createServer((req, res) => {
      seenEncodings.push(req.headers["accept-encoding"] ?? "");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Content-Encoding": "gzip", "Content-Length": gzipped.length });
      res.end(gzipped);
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", () => resolve()); });
    const port = (server.address() as AddressInfo).port;
    writeDsJson(b, `http://127.0.0.1:${port}`);
    const res = await b.router.dispatch("GET", "/ds/web-apps/apps/api/documents/api.js");
    assert.equal(res.statusCode, 200, "the upstream status passes through");
    assert.equal(seenEncodings.at(-1), "identity", "the proxy asks the DS for an UNENCODED body");
    assert.match(String(res.headers["content-type"]), /application\/javascript/, "the content-type passes through");
    assert.equal(res.headers["content-encoding"], undefined, "the (lying) upstream content-encoding is NOT copied");
    assert.ok(!Object.keys(res.headers).includes("content-length"), "no upstream-declared content-length is forwarded -- Node sizes the real buffer");
    assert.equal(Buffer.from(res.data as Buffer).compare(ORIGINAL), 0, "the FULL original payload arrives intact (undici decoded it; no truncation at the lying length)");
  } finally {
    if (server) { const s = server; s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
    await b.cleanup();
  }
});

test("/ds proxy: a dead origin -> 503 {code:'ds_unavailable'} and a log line", async () => {
  const b = await boot();
  try {
    // an ephemeral port nothing listens on: bind one, close it, reuse the number for the dead target
    const dead = http.createServer();
    await new Promise<void>((resolve, reject) => { dead.once("error", reject); dead.listen(0, "127.0.0.1", () => resolve()); });
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    writeDsJson(b, `http://127.0.0.1:${port}`);

    const res = await b.router.dispatch("GET", "/ds/web-apps/apps/api/documents/api.js");
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: "the document server did not answer", code: "ds_unavailable" });
    assert.ok(b.logs.some((l) => l.includes("GET /ds/") && l.includes(`http://127.0.0.1:${port}`)), "the failure left a log line");
    // The way in is asked for again: a forwarder somebody removed comes back.
    await until(() => b.dock.calls.some((c) => c.startsWith("reach")));
  } finally {
    await b.cleanup();
  }
});

test("/ds proxy: an unconfigured data dir -> 503 {code:'ds_not_configured'}", async () => {
  const b = await boot(); // fresh root, no ds.json
  try {
    const none = await b.router.dispatch("GET", "/ds/web-apps/apps/api/documents/api.js");
    assert.equal(none.statusCode, 503);
    assert.equal((none.body as Record<string, unknown>).code, "ds_not_configured");
  } finally {
    await b.cleanup();
  }
});

/** A Document Server that answers what it was told about the browser, as the real one builds its addresses from it:
 * the forwarded headers it got, and a redirect for an unversioned /web-apps/ path, as its nginx does. */
function startForwardedDs(): Promise<{ server: http.Server; port: number; seen: http.IncomingHttpHeaders[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    const base = `${req.headers["x-forwarded-proto"]}://${req.headers["x-forwarded-host"]}${req.headers["x-forwarded-prefix"]}`;
    if (req.url === "/web-apps/apps/documenteditor/main/index.html") {
      res.writeHead(302, { Location: `${base}/10.0.0-169/web-apps/apps/documenteditor/main/index.html` });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ editorBin: `${base}/cache/files/data/k1/Editor.bin/Editor.bin?md5=x&expires=1` }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, seen })));
}

test("/ds proxy: the Document Server is told where the browser is, so the addresses it hands out (Editor.bin) are the browser's", async () => {
  const b = await boot();
  const ds = await startForwardedDs();
  try {
    writeDsJson(b, `http://127.0.0.1:${ds.port}`);
    // A browser on another machine, at the portal's address.
    let res = await b.router.dispatch("GET", "/ds/10.0.0-169/doc/k1/c/?EIO=4", undefined, { host: "portal.example:8080" });
    assert.equal(ds.seen[0]["x-forwarded-host"], "portal.example:8080");
    assert.equal(ds.seen[0]["x-forwarded-proto"], "http");
    assert.equal(ds.seen[0]["x-forwarded-prefix"], "/api/x/%40pithagoras/office/ds");
    assert.equal(JSON.parse(String(res.data)).editorBin, "http://portal.example:8080/api/x/%40pithagoras/office/ds/cache/files/data/k1/Editor.bin/Editor.bin?md5=x&expires=1");
    // Behind a reverse proxy that terminates TLS: its own forwarded host and scheme, the first of each.
    res = await b.router.dispatch("GET", "/ds/10.0.0-169/doc/k1/c/?EIO=4", undefined, { host: "127.0.0.1:8080", "x-forwarded-host": "office.example, inner", "x-forwarded-proto": "https" });
    assert.equal(JSON.parse(String(res.data)).editorBin.startsWith("https://office.example/api/x/%40pithagoras/office/ds/cache/files/"), true);
  } finally {
    ds.server.close();
    await b.cleanup();
  }
});

test("/ds proxy: what it answers lets the editor's frame fetch and frame the portal's own origin only, so a plugin a page adds to its config cannot load", async () => {
  const b = await boot();
  const ds = await startForwardedDs();
  try {
    writeDsJson(b, `http://127.0.0.1:${ds.port}`);
    for (const at of ["/ds/web-apps/apps/documenteditor/main/index.html", "/ds/10.0.0-169/doc/k1/c/?EIO=4"]) {
      const res = await b.router.dispatch("GET", at, undefined, { host: "portal.example" });
      assert.equal(res.headers["content-security-policy"], "connect-src 'self' blob: data:; frame-src 'self' blob:", at);
    }
  } finally {
    ds.server.close();
    await b.cleanup();
  }
});

test("/ds proxy: a redirect of the Document Server reaches the browser as one, never followed to the portal's public address", async () => {
  const b = await boot();
  const ds = await startForwardedDs();
  try {
    writeDsJson(b, `http://127.0.0.1:${ds.port}`);
    const res = await b.router.dispatch("GET", "/ds/web-apps/apps/documenteditor/main/index.html", undefined, { host: "portal.example" });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "http://portal.example/api/x/%40pithagoras/office/ds/10.0.0-169/web-apps/apps/documenteditor/main/index.html");
    assert.equal(ds.seen.length, 1, "the proxy did not follow it");
  } finally {
    ds.server.close();
    await b.cleanup();
  }
});

test("/ds proxy: the Document Server's own endpoints are not passed on, however the path is spelled; the editor's are", async () => {
  const b = await boot();
  const ds = await startFakeDs();
  try {
    writeDsJson(b, `http://127.0.0.1:${ds.port}`);
    for (const p of ["info/info.json", "internal/cluster/inactive", "10.0.0-169/info/info.json", "INFO/info.json", "%69nfo/info.json", "web-apps/../info/info.json", "web-apps/%2e%2e/internal/connections/edit", "//internal/x", "coauthoring/CommandService.ashx", "command", "Command?c=forcesave", "10.0.0-169/command", "web-apps/../command", "ConvertService.ashx", "ai-proxy/x", "%zz"]) {
      const res = await b.router.dispatch("GET", `/ds/${p}`);
      assert.equal(res.statusCode, 404, p);
    }
    // The command service is the server half's alone (it saves an open editor before an agent writes): a POST of the
    // browser's never reaches it.
    assert.equal((await b.router.dispatch("POST", "/ds/command", JSON.stringify({ c: "forcesave", key: "k" }), { "content-type": "application/json" })).statusCode, 404);
    assert.deepEqual(ds.urls, [], "none reached the Document Server");
    for (const p of ["web-apps/apps/api/documents/api.js", "10.0.0-169/web-apps/apps/documenteditor/main/index.html", "cache/files/data/k/Editor.bin/Editor.bin?md5=x", "10.0.0-169/doc/k/c/?EIO=4", "downloadas/k?cmd=x", "fonts/x", "sdkjs/x", "meta/formats", "healthcheck"]) {
      assert.equal(dsPathAllowed(p), true, p);
    }
  } finally {
    ds.server.close();
    await b.cleanup();
  }
});

test("/ds proxy: a body above the cap is refused with 413, never sent on cut short", async () => {
  const b = await boot();
  const ds = await startFakeEngineIo();
  try {
    writeDsJson(b, `http://127.0.0.1:${ds.port}`);
    const big = Buffer.alloc(64 * 1024 * 1024 + 1);
    const res = await b.router.dispatch("POST", "/ds/c/?EIO=4&transport=polling", Buffer.concat([big, big]), { "content-type": "text/plain" });
    assert.equal(res.statusCode, 413);
    assert.deepEqual(ds.posts, []);
  } finally {
    ds.server.close();
    await b.cleanup();
  }
});

test("forwardedFor: the request's Host and scheme, or a reverse proxy's forwarded ones, and the prefix", () => {
  const prefix = "/api/x/%40pithagoras/office/ds";
  assert.deepEqual(forwardedFor({ headers: { host: "a.example" } }, prefix), { "x-forwarded-host": "a.example", "x-forwarded-proto": "http", "x-forwarded-prefix": prefix });
  assert.deepEqual(forwardedFor({ headers: { host: "a.example" }, socket: { encrypted: true } }, prefix)["x-forwarded-proto"], "https");
  assert.deepEqual(forwardedFor({ headers: { host: "inner", "x-forwarded-host": ["outer.example", "x"], "x-forwarded-proto": "https, http" } }, prefix), { "x-forwarded-host": "outer.example", "x-forwarded-proto": "https", "x-forwarded-prefix": prefix });
});

test("forwardedFor: behind a reverse proxy that ends TLS and sends no forwarded headers (and its upstream's name as Host), the browser's own origin says where it is", () => {
  const prefix = "/api/x/%40pithagoras/office/ds";
  const behind = { host: "127.0.0.1:3000", "sec-fetch-site": "same-origin" };
  // The editor frame's polls and Editor.bin: a same-origin GET carries Referer, not Origin.
  assert.deepEqual(forwardedFor({ headers: { ...behind, referer: "https://portal.example/api/x/%40pithagoras/office/ds/web-apps/apps/documenteditor/main/index.html?x=1" } }, prefix), { "x-forwarded-host": "portal.example", "x-forwarded-proto": "https", "x-forwarded-prefix": prefix });
  // A POST of the socket.io channel carries Origin, which comes first.
  assert.deepEqual(forwardedFor({ headers: { ...behind, origin: "https://portal.example:8443", referer: "https://elsewhere.example/" } }, prefix)["x-forwarded-host"], "portal.example:8443");
  // Over the forwarded headers too: what the browser used is what it must be handed.
  assert.deepEqual(forwardedFor({ headers: { ...behind, "x-forwarded-proto": "http", referer: "https://portal.example/" } }, prefix)["x-forwarded-proto"], "https");
  // Not where the browser does not say the request is its own page's: another site's page that links here names
  // itself in Referer, and an old browser says nothing.
  assert.deepEqual(forwardedFor({ headers: { host: "portal.example", "sec-fetch-site": "cross-site", referer: "https://evil.example/" } }, prefix)["x-forwarded-host"], "portal.example");
  assert.deepEqual(forwardedFor({ headers: { host: "portal.example", referer: "https://evil.example/" } }, prefix)["x-forwarded-host"], "portal.example");
  // An opaque origin, or no address at all, falls back as well.
  assert.deepEqual(forwardedFor({ headers: { host: "portal.example", "sec-fetch-site": "same-origin", origin: "null" } }, prefix), { "x-forwarded-host": "portal.example", "x-forwarded-proto": "http", "x-forwarded-prefix": prefix });
  assert.deepEqual(forwardedFor({ headers: { host: "portal.example", "sec-fetch-site": "same-origin", referer: "not a url" } }, prefix)["x-forwarded-host"], "portal.example");
});

/** A fake engine.io polling endpoint: answers the handshake GET and records every POST body it received.
 * The real docserver's /<app>/10.0.0-<buildhash>/doc/<key>/c/ speaks exactly this shape (replayed live). */
function startFakeEngineIo(holdMs = 0): Promise<{ server: http.Server; port: number; posts: string[] }> {
  const posts: string[] = [];
  const HANDSHAKE = '0{"sid":"Zkx0F6Y_6ZptlT-cAAKS","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000,"maxPayload":100000000}';
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/c/?")) {
      if (holdMs > 0) setTimeout(() => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(HANDSHAKE); }, holdMs);
      else { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(HANDSHAKE); }
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/c/?")) {
      let b = "";
      req.on("data", (d: string) => (b += d));
      req.on("end", () => { posts.push(b); res.writeHead(200, { "Content-Type": "text/plain" }); res.end(""); });
      return;
    }
    res.writeHead(404); res.end("nope");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, posts }));
  });
}

test("/ds proxy: a POST forwards method + raw body verbatim to the DS (the socket.io client channel)", async () => {
  // The editor app's doc channel: engine.io GETs handshake, then its packets (the "40" connect packet and on
  // every state change) arrive as POSTs to the same /c/ path. A GET-only proxy answered those with the core's
  // 404 and the channel never opened -- the white-spinner root cause (reproduced live against DS 10.0).
  const ds = await startFakeEngineIo();
  const b = await boot();
  try {
    writeDsJson(b, `http://127.0.0.1:${ds.port}`);
    const res = await b.router.dispatch("POST", "/ds/c/?EIO=4&transport=polling&sid=Zkx0F6Y_6ZptlT-cAAKS", "40", { "content-type": "text/plain;charset=UTF-8" });
    assert.equal(res.statusCode, 200, "the upstream answer passes back through the proxy");
    assert.deepEqual(ds.posts, ["40"], "the raw engine.io packet arrived at the DS byte-for-byte with its query string");
  } finally {
    ds.server.closeAllConnections();
    await new Promise<void>((r) => ds.server.close(() => r()));
    await b.cleanup();
  }
});

test("/ds proxy: an engine.io handshake loses its websocket upgrade offer (this proxy is polling-only)", async () => {
  // fetch cannot relay WebSocket frames, so advertising upgrades:["websocket"] would only end in failed-upgrade
  // churn; the handler strips it from outbound handshakes and pins the client to long-polling.
  const ds = await startFakeEngineIo();
  const b = await boot();
  try {
    writeDsJson(b, `http://127.0.0.1:${ds.port}`);
    const res = await b.router.dispatch("GET", "/ds/c/?EIO=4&transport=polling");
    assert.equal(res.statusCode, 200);
    const raw = String(res.data as Buffer | string);
    assert.ok(raw.startsWith("0{"), "the EIO handshake prefix is preserved");
    const hs = JSON.parse(raw.slice(1)) as Record<string, unknown>;
    assert.equal(hs.sid, "Zkx0F6Y_6ZptlT-cAAKS", "everything else in the handshake is untouched");
    assert.ok(!Array.isArray(hs.upgrades) || !hs.upgrades.includes("websocket"), "no websocket upgrade is offered to the client");
  } finally {
    ds.server.closeAllConnections();
    await new Promise<void>((r) => ds.server.close(() => r()));
    await b.cleanup();
  }
});

test("/ds proxy: an idle long-poll HELD past the old 15s cutoff still comes back (engine.io keeps polls open until it has data)", async () => {
  // The pre-fix handler aborted every upstream fetch after exactly 15s -- and undici's abort also closes the
  // upstream socket, which docserver logs as a 499 at precisely that moment. engine.io pings at least every
  // 25s, so a healthy poll can sit empty for longer than 15s; the window must cover a full ping cycle.
  const ds = await startFakeEngineIo(16_500); // held open just past the old 15_000ms cutoff
  const b = await boot();
  try {
    writeDsJson(b, `http://127.0.0.1:${ds.port}`);
    const t0 = Date.now();
    const res = await b.router.dispatch("GET", "/ds/c/?EIO=4&transport=polling");
    assert.equal(res.statusCode, 200, "the held poll answers instead of a ds_unavailable abort");
    assert.match(String(res.data as Buffer | string), /Zkx0F6Y_6ZptlT-cAAKS/, "the handshake body arrives after the hold");
    assert.ok(Date.now() - t0 >= 15_000, "it really waited out the old cutoff window before answering");
  } finally {
    ds.server.closeAllConnections();
    await new Promise<void>((r) => ds.server.close(() => r()));
    await b.cleanup();
  }
});



/* ---------------- the agent's editor config ---------------- */

test("an agent's editor config: its own user, the plugin by its GUID from its own address, live in view mode too, no person's seat taken", async () => {
  const b = await boot();
  writeDsJson(b);
  live.resetLive();
  const doc = await store.createDoc({ title: "Seated", type: "word", folder: homeIn(b.root) }, b.root);
  const home = "/homes/research";
  const built = buildEditorConfig(b.root, jwtSecret(b.root), doc.docId, { kind: "agent", home, label: "Research", mode: "view", pluginUrl: "http://relay:3891/plugin/0123456789abcdef0123456789abcdef/" });
  const ec = (built.config as { editorConfig: Record<string, any> }).editorConfig;
  assert.deepEqual(ec.user, { id: `agent:${keyIdOf(home)}`, name: "Research (agent)", group: "agents" });
  assert.equal(ec.mode, "view");
  assert.deepEqual(ec.coEditing, { mode: "fast", change: false }, "a viewer is live too");
  // No spell check in an agent's editor: its squiggles would be in the agent's screenshots.
  assert.deepEqual(ec.customization, { macros: false, plugins: true, compactHeader: true, features: { spellcheck: { mode: false, change: false } } });
  assert.equal("width" in (built.config as object), false, "its size is the seat page's, outside what is signed");
  assert.deepEqual(ec.plugins, { pluginsData: ["http://relay:3891/plugin/0123456789abcdef0123456789abcdef/config.json"], autostart: [PLUGIN_GUID] });
  assert.equal(built.key, makeKey(doc.docId, doc.mtimeMs));
  assert.equal(ec.callbackUrl, "http://pithagoras-office-ds-relay:3891/callback");
  assert.deepEqual(live.usersOf(doc.docId), [], "its mint is no person opening the document");
  // Its name is known for office_list once the Document Server says it is in the document.
  live.setUser(doc.docId, { id: `agent:${keyIdOf(home)}` }, true, { confirmed: true });
  assert.deepEqual(live.agentsOf(doc.docId), [{ id: `agent:${keyIdOf(home)}`, name: "Research (agent)" }]);
  const editing = buildEditorConfig(b.root, jwtSecret(b.root), doc.docId, { kind: "agent", home, label: "Research", mode: "edit", pluginUrl: "http://x/" });
  assert.equal((editing.config!.editorConfig as { mode: string }).mode, "edit");
  live.resetLive();
  await b.cleanup();
});

test("an agent's editor and a person's join each other's open session: the same key, whoever opened it first", async () => {
  const b = await boot();
  writeDsJson(b);
  live.resetLive();
  const doc = await store.createDoc({ title: "Shared", type: "word", folder: homeIn(b.root) }, b.root);
  // A session whose key stands for this revision, which an agent's editor opened (its status 1 named it).
  const key = makeKey(doc.docId, doc.mtimeMs);
  live.setSession(doc.docId, key, [`agent:${keyIdOf("/homes/a")}`]);
  const person = (await b.router.dispatch("POST", "/editor-config", { doc: doc.docId })).body as { document: { key: string } };
  assert.equal(person.document.key, key);
  // And an agent opens into a session a person opened.
  live.resetLive();
  live.setSession(doc.docId, key, ["portal-user"]);
  const agent = buildEditorConfig(b.root, jwtSecret(b.root), doc.docId, { kind: "agent", home: "/homes/a", label: "A", mode: "edit", pluginUrl: "http://x/" });
  assert.equal(agent.key, key);
  live.resetLive();
  await b.cleanup();
});

test("no route of the portal's or the listener's hands out an agent's editor config: only the seat page's secret route does", async () => {
  const b = await boot();
  writeDsJson(b);
  live.resetLive();
  const doc = await store.createDoc({ title: "Walked", type: "word", folder: homeIn(b.root) }, b.root);
  const marks = [PLUGIN_GUID, "pluginsData", "agent:", "/plugin/"];
  const leaks: string[] = [];
  const look = (where: string, body: unknown) => {
    const text = typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : JSON.stringify(body ?? null);
    for (const m of marks) if (text.includes(m)) leaks.push(`${where} holds ${m}`);
  };
  // Every route the half registered, with the document's id wherever a route takes one.
  for (const route of b.router.routes) {
    const url = typeof route.pattern === "string" ? route.pattern.replace(/:id/g, encodeURIComponent(doc.docId)) + (route.pattern === "/editor-state" ? `?doc=${doc.docId}&key=${makeKey(doc.docId, doc.mtimeMs)}` : route.pattern === "/scope" ? "?chat=c" : "") : "/ds/web-apps/apps/api/documents/api.js";
    if (route.method === "DELETE" || url === "/container/remove" || url === "/container/stop" || url === "/settings") continue; // they change things, and hand out nothing
    const res = await b.router.dispatch(route.method, url, { doc: doc.docId, title: "x", type: "word" }).catch((e: Error) => ({ body: e.message, data: undefined }));
    look(`${route.method} ${url}`, res.body);
    look(`${route.method} ${url}`, res.data);
  }
  // The listener: its routes, and the seat routes without the secret or a token.
  const port = loopbackPort();
  for (const [method, p] of [["GET", "/doc/x"], ["POST", "/callback"], ["GET", "/seat/"], ["GET", `/seat/${"0".repeat(64)}/poll`], ["GET", `/plugin/${"0".repeat(32)}/config.json`], ["GET", "/"]]) {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, body: method === "POST" ? "{}" : undefined });
    assert.ok(r.status >= 400, `${method} ${p} is refused (${r.status})`);
    look(`listener ${method} ${p}`, (await r.text()).split(p).join("<path>")); // its 404 names the path it was asked
  }
  assert.deepEqual(leaks, []);
  // The seat page itself is at the secret route, on the listener.
  const page = await fetch(`http://127.0.0.1:${port}${new URL(seat.pageUrl()).pathname}`);
  assert.equal(page.status, 200);
  await page.text();
  live.resetLive();
  await b.cleanup();
});

/* ---------------- the agents' seats, wired ---------------- */

const AGENT = "pithagoras-office-ds-agent";

/** A booted half whose Document Server runs, with the agents' browser played by the scripted one (seat-browser.mts):
 * it starts as the half starts the browser's container, at the page that container was made for, through the loopback
 * listener, and stops as the container is removed. */
async function withSeats(dock = fakeDocker()) {
  dock.state.images.add(container.AGENT_IMAGE);
  const local = (url: string) => url.replace(/^http:\/\/[^/]+/, `http://127.0.0.1:${loopbackPort()}`);
  const chromium = browser("", (job) => job.kind, local);
  const { start, remove } = dock.docker.containers;
  dock.docker.containers.start = async (name: string) => {
    await start(name);
    if (name === AGENT) chromium.start((dock.containers.get(AGENT)!.spec.Cmd as string[]).at(-1)!);
  };
  dock.docker.containers.remove = async (name: string) => {
    if (name === AGENT) chromium.stop();
    await remove(name);
  };
  const b = await boot(undefined, dock);
  live.resetLive();
  const res = await b.router.dispatch("POST", "/container/start");
  assert.equal(res.statusCode, 200);
  return {
    b,
    chromium,
    async done() {
      chromium.stop();
      live.resetLive();
      await b.cleanup();
    },
  };
}

test("the agents' seats, wired: a trashed document's agent editor closes", async () => {
  const w = await withSeats();
  try {
    const doc = await store.createDoc({ title: "Trashed", type: "word", folder: homeIn(w.b.root) }, w.b.root);
    assert.equal(await seat.run("/homes/a", doc.docId, "edit", { kind: "word.read", args: {} }), "word.read");
    assert.equal(seat.seats().length, 1);
    const res = await w.b.router.dispatch("DELETE", `/documents/${doc.docId}`);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seat.seats(), []);
  } finally {
    await w.done();
  }
});

test("the agents' seats, wired: Office switched off, and removed, closes every agent editor with the browser", async () => {
  const w = await withSeats();
  try {
    const doc = await store.createDoc({ title: "Open", type: "word", folder: homeIn(w.b.root) }, w.b.root);
    fs.writeFileSync(path.join(w.b.root, "settings.json"), JSON.stringify({ enabled: true, imageTag: DEFAULT_TAG }));
    await seat.run("/homes/a", doc.docId, "edit", { kind: "word.read", args: {} });
    assert.equal((await w.b.router.dispatch("POST", "/settings", { enabled: false })).statusCode, 200);
    assert.deepEqual(seat.seats(), []);
    assert.equal(w.b.dock.containers.get(AGENT), undefined);
    await w.b.router.dispatch("POST", "/container/start");
    await seat.run("/homes/a", doc.docId, "edit", { kind: "word.read", args: {} });
    assert.equal(seat.seats().length, 1);
    assert.equal((await w.b.router.dispatch("POST", "/container/remove", {})).statusCode, 200);
    assert.deepEqual(seat.seats(), []);
    assert.equal(w.b.dock.containers.get(AGENT), undefined);
  } finally {
    await w.done();
  }
});

test("the agents' seats, wired: a Document Server started again (revived, a new image) closes every agent editor and stops the browser", async () => {
  const w = await withSeats();
  try {
    const doc = await store.createDoc({ title: "Revived", type: "word", folder: homeIn(w.b.root) }, w.b.root);
    await seat.run("/homes/a", doc.docId, "edit", { kind: "word.read", args: {} });
    const ds = w.b.dock.containers.get("pithagoras-office-ds")!;
    ds.inspect.State = { Status: "exited", Running: false };
    ds.info.state = "exited";
    w.b.dock.calls.length = 0;
    const res = await w.b.router.dispatch("POST", "/container/start");
    assert.equal((res.body as { started: boolean }).started, true);
    assert.deepEqual(seat.seats(), []);
    await until(() => w.b.dock.calls.includes(`remove ${AGENT}`));
    // The next call starts the browser anew and opens the document in the new Document Server's session.
    assert.equal(await seat.run("/homes/a", doc.docId, "edit", { kind: "word.read", args: {} }), "word.read");
  } finally {
    await w.done();
  }
});

test("the agents' seats, wired: a browser left from the run before is removed at boot", async () => {
  const dock = fakeDocker();
  dock.put(AGENT, { Image: container.AGENT_IMAGE }, { state: "running" });
  const b = await boot(undefined, dock);
  try {
    await until(() => !dock.containers.has(AGENT));
    assert.ok(dock.calls.includes(`remove ${AGENT}`));
  } finally {
    await b.cleanup();
  }
});

test("the agents' seats, wired: the agents' editors reach the Document Server through the relay's way in, never by its own name", async () => {
  const w = await withSeats();
  try {
    const doc = await store.createDoc({ title: "Where", type: "word", folder: homeIn(w.b.root) }, w.b.root);
    await seat.run("/homes/a", doc.docId, "edit", { kind: "word.read", args: {} });
    assert.equal(w.chromium.opened[0].apiJs, "http://pithagoras-office-ds-relay:3890/web-apps/apps/api/documents/api.js");
    assert.equal(w.chromium.behaviour.configs[0].headers.get("access-control-allow-origin"), "http://pithagoras-office-ds-relay:3890");
  } finally {
    await w.done();
  }
});


test("the agents' seats, wired: a picture is taken by cdp's client in Office's relay, of the agent's own editor in the agents' browser", async () => {
  const dock = fakeDocker();
  // The start of a JPEG of 4 x 3: its SOI and its frame header, which the portal reads the picture's size from.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x04, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]).toString("base64");
  const json = JSON.stringify({ data: jpeg, width: 4, height: 3, pages: 1 });
  dock.state.answer = (cmd) => (cmd[0] === "node" ? { output: `CDP ${json.length} ${createHash("sha256").update(json).digest("hex")} ${json}\n`, exitCode: 0, timedOut: false } : undefined);
  const w = await withSeats(dock);
  try {
    const doc = await store.createDoc({ title: "Look", type: "word", folder: homeIn(w.b.root) }, w.b.root);
    const out = await seat.shot("/homes/a", doc.docId, "edit", { kind: "view.locate", args: { kind: "word", page: 1 } });
    assert.deepEqual(out.image, { data: jpeg, width: 4, height: 3, pages: 1 });
    const call = dock.calls.find((c) => c.startsWith("exec pithagoras-office-ds-relay node"));
    assert.ok(call, dock.calls.join(", "));
    assert.ok(call.startsWith(`exec pithagoras-office-ds-relay node --no-warnings -e ${CDP_SRC}`));
    const spec = JSON.parse(call.slice(`exec pithagoras-office-ds-relay node --no-warnings -e ${CDP_SRC} `.length));
    assert.equal(spec.browser, AGENT);
    assert.equal(spec.port, 9222);
    assert.equal(spec.editorId, w.chromium.opened[0].editorId, "the agent's own editor of that document");
    assert.deepEqual(dock.state.execs.filter((e) => e.name === "pithagoras-office-ds-relay"), [{ name: "pithagoras-office-ds-relay", timeoutMs: 15_000 }]);
  } finally {
    await w.done();
  }
});

/* ---------------- comments and the editor's chat (docchat) ---------------- */

test("who is behind a request (http.person): nobody signed in is refused every route but the Document Server's own traffic; a person who is not the primary one may read, not change documents or talk to the agents", async () => {
  const w = workspace();
  const b = await boot(undefined, fakeDocker(), w.chats, w.listed);
  const doc = await store.createDoc({ title: "Talk", type: "word", folder: w.home }, b.root);
  try {
    requestPerson = undefined;
    for (const [method, url, body] of [["GET", "/state"], ["GET", `/documents/${doc.docId}`], ["GET", "/mentionables"], ["POST", "/documents", { title: "X", type: "word" }], ["POST", "/docchat/events", { v: 1 }]] as [string, string, unknown?][]) {
      const res = await b.router.dispatch(method, url, body);
      assert.equal(res.statusCode, 401, `${method} ${url}`);
      assert.equal((res.body as { code: string }).code, "no_person");
    }
    // The editor's own traffic is opened by a config this half signed, not by a login: not asked here.
    let passed = false;
    for (const fn of b.router.middleware) fn({ method: "GET", url: "/ds/web-apps/apps/api/documents/api.js", headers: {} }, {} as never, () => void (passed = true));
    assert.ok(passed);
    requestPerson = { id: "guest-1", name: "Gwen", role: "guest" };
    assert.equal((await b.router.dispatch("GET", "/state")).statusCode, 200, "a person may read");
    for (const [url, body] of [["/documents", { title: "X", type: "word" }], [`/documents/${doc.docId}/rename`, { title: "Y" }], ["/docchat/events", { v: 1 }], ["/settings", { enabled: false }]] as [string, unknown][]) {
      const res = await b.router.dispatch("POST", url, body);
      assert.equal(res.statusCode, 403, url);
      assert.equal((res.body as { code: string }).code, "not_primary");
    }
    assert.equal((await b.router.dispatch("DELETE", `/documents/${doc.docId}`)).statusCode, 403);
    requestPerson = OWNER;
    assert.equal((await b.router.dispatch("POST", `/documents/${doc.docId}/rename`, { title: "Y" })).statusCode, 200, "the primary person may");
  } finally {
    requestPerson = OWNER;
    await b.cleanup();
    fs.rmSync(w.ws, { recursive: true, force: true });
  }
});

test("on a portal without the extension API of #339, comments and the editor's chat with agents are off and say so (the Office page, the editor, the reports), and the rest of Office works", async () => {
  const w = workspace();
  const b = await boot(undefined, fakeDocker(), w.chats, w.listed, "old");
  try {
    const off = ((await b.router.dispatch("GET", "/state")).body as { docchatOff?: string }).docchatOff;
    assert.match(off ?? "", /this portal is too old for it \(it lacks chats\.start, chats\.lastAnswer, chats\.owner, http\.person\)/);
    assert.ok(b.logs.some((l) => l.includes(off!)), "logged at the start");
    const doc = await store.createDoc({ title: "Talk", type: "word", folder: w.home }, b.root);
    const key = makeKey(doc.docId, doc.mtimeMs);
    live.setSession(doc.docId, key, ["portal-user"]);
    for (const route of ["/docchat/events", "/docchat/ready"]) {
      const res = await b.router.dispatch("POST", route, { v: 1, docId: doc.docId, key, events: [], comments: [] });
      assert.equal(res.statusCode, 501, route);
      assert.deepEqual(res.body, { error: off, code: "portal_too_old" });
    }
    assert.deepEqual((await b.router.dispatch("GET", "/mentionables")).body, { users: [] }, "nobody to mention");
    assert.deepEqual((await b.router.dispatch("GET", `/editor-state?doc=${doc.docId}&key=${encodeURIComponent(key)}`)).body, { standing: "current", docchat: [], docchatOff: off });
    // Documents still work: the Office tab's New document, a download, and a chat's panel and tools where the chat works
    // in an agent's home or a project's folder itself, which is what this portal says of whose a chat is.
    assert.equal((await b.router.dispatch("POST", "/documents", { title: "Still", type: "word" })).statusCode, 201);
    assert.equal((await b.router.dispatch("GET", `/documents/${doc.docId}`)).statusCode, 200);
    const panel = await b.router.dispatch("POST", "/documents", { title: "Panel", type: "word", chat: "chat-a" });
    assert.equal(panel.statusCode, 201);
    assert.equal((panel.body as store.DocMeta).owner, w.a);
    const scope = async (chat: string) => ((await b.router.dispatch("GET", `/scope?chat=${chat}`)).body as { docIds: string[] }).docIds;
    assert.deepEqual(await scope("chat-a"), [(panel.body as store.DocMeta).docId]);
    assert.equal((await scope("chat-home")).length, 2, "the home's own two");
    assert.equal(b.toolsOf("chat-a").length, 7);
    // In a folder inside a project, nothing tells whose the chat is here: no documents, no tools, and its New document
    // says why.
    assert.deepEqual(await scope("chat-sub"), []);
    assert.deepEqual(b.toolsOf("chat-sub"), []);
    const sub = await b.router.dispatch("POST", "/documents", { title: "Sub", type: "word", chat: "chat-sub" });
    assert.equal(sub.statusCode, 409);
    assert.match((sub.body as { error: string }).error, /no agent's home nor project's folder/);
    live.resetLive();
  } finally {
    await b.cleanup();
    fs.rmSync(w.ws, { recursive: true, force: true });
  }
  // With it, nothing is said.
  const b2 = await boot();
  assert.equal(((await b2.router.dispatch("GET", "/state")).body as { docchatOff?: string }).docchatOff, undefined);
  await b2.cleanup();
});

test("the limits of comments and the editor's chat are settings: GET /state gives them with their defaults, POST /settings takes whole numbers in their bounds and refuses others", async () => {
  const b = await boot();
  const state = (await b.router.dispatch("GET", "/state")).body as { limits: Record<string, number>; limitBounds: Record<string, [number, number]> };
  assert.deepEqual(state.limits, { docchatRuns: 2, docchatThreads: 50, docchatReplyChars: 4000, docchatChatMessages: 4, docchatRemoveAfterS: 120, docchatChatEndS: 60, docchatReportsPer10S: 50, docchatMessageChars: 20_000, docchatSaveEveryS: 3, docchatQueued: 20 });
  assert.deepEqual(state.limitBounds.docchatRuns, [1, 20], "the bounds, for the page to say them");
  const saved = await b.router.dispatch("POST", "/settings", { docchatRuns: 3, docchatChatEndS: 0 });
  assert.equal(saved.statusCode, 200);
  assert.equal((saved.body as { settings: { docchatRuns: number; docchatChatEndS: number } }).settings.docchatRuns, 3);
  assert.equal(((await b.router.dispatch("GET", "/state")).body as { limits: Record<string, number> }).limits.docchatChatEndS, 0);
  for (const bad of [{ docchatRuns: 0 }, { docchatRuns: 2.5 }, { docchatThreads: "50" }, { docchatReplyChars: 10 }]) {
    const res = await b.router.dispatch("POST", "/settings", bad);
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.equal((res.body as { code: string }).code, "invalid_limit");
  }
  assert.ok(b.audits.some((a) => /docchatRuns=3/.test(String(a.reason))), "audited");
  await b.cleanup();
});

test("GET /mentionables: the agents by their names and the projects as project:<name>, as the editor's mention list takes them", async () => {
  const b = await boot();
  (b.portal.folders as { list: () => unknown[] }).list = () => [{ path: "/w/aegis", name: "Aegis", kind: "agent" }, { path: "/w/report", name: "Report", kind: "project" }, { path: "/w/chat", name: "Scratch", kind: "chat" }];
  assert.deepEqual((await b.router.dispatch("GET", "/mentionables")).body, { users: [{ name: "Aegis", email: "Aegis" }, { name: "Report (project)", email: "project:Report" }] });
  await b.cleanup();
});

test("POST /docchat/events and /ready: the page's protocol, a key of that document's open session (or one the command service says a person is in), and a rate cap; what passes is taken", async () => {
  const b = await boot();
  const doc = await store.createDoc({ title: "Talk", type: "word", folder: homeIn(b.root) }, b.root);
  const key = makeKey(doc.docId, doc.mtimeMs);
  const send = (body: Record<string, unknown>, path = "/docchat/events") => b.router.dispatch("POST", path, { v: 1, docId: doc.docId, key, events: [], ...body });
  assert.equal((await send({ v: 0 })).statusCode, 409, "another protocol reloads");
  assert.equal(((await send({ v: 0 })).body as { code: string }).code, "reload_page");
  const other = await store.createDoc({ title: "Other", type: "word", folder: homeIn(b.root) }, b.root);
  assert.equal((await send({ key: makeKey(other.docId, other.mtimeMs) })).statusCode, 400, "a key of another document");
  // No session the callbacks named, and no Document Server to ask: not taken.
  assert.equal((await send({})).statusCode, 409);
  live.setSession(doc.docId, key, ["portal-user"]);
  const taken = await send({ events: [{ type: "comment", guid: "626360df", text: "Hallo", userId: "portal-user" }] });
  assert.equal(taken.statusCode, 200);
  assert.deepEqual((await send({ comments: [{ guid: "626360df", text: "Hallo" }] }, "/docchat/ready")).statusCode, 200);
  assert.equal((await send({ events: Array.from({ length: 65 }, () => ({ type: "removed", guids: [] })) })).statusCode, 413);
  let limited = 0;
  for (let i = 0; i < 60; i++) if ((await send({})).statusCode === 429) limited++;
  assert.ok(limited > 0, "a page that reports too often is held back");
  live.resetLive();
  await b.cleanup();
});
