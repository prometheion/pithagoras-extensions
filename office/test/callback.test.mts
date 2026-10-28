/**
 * Unit tests for src/callback.ts (+ src/live.ts): the DS callback state machine. Everything is
 * self-contained -- tmp data dirs, self-minted HS256 JWTs, a LOCAL node:http server standing in for the
 * Document Server's saved-file/changes endpoints, and synthetic IncomingMessage/ServerResponse pairs (a
 * Readable stream + a recording object). Nothing here reaches portal() or the real data dir: every handler is
 * built with createCallbackHandler with an explicit root; only the bare handleCallback/configure test touches
 * module-level wiring (and still only status-4, which writes nothing).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { createHmac, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { signJwt, verifyJwt } from "../src/jwt";
import {
  CallbackState, configure, createCallbackHandler, docIdOf, handleCallback, keyIdOf, makeKey, onDocumentServer, onPersisted, parseKey, recoverForgotten, revHashOf,
} from "../src/callback";
import { createDoc, getDoc, listDocs, scanWorkspace } from "../src/store";
import { homeIn } from "./homes.mts";
import * as live from "../src/live";

const SECRET = "unit-test-secret-0123456789abcdef";
const DS_STATE: CallbackState = { containerId: "cid-1", imageTag: "onlyoffice/documentserver:10.0.0.1" };
/** Where the browser reached the Document Server (the /ds proxy): the Document Server names its files at this address. */
const BROWSER = "http://portal.example/api/x/%40pithagoras/office/ds";
/** Where the server half reaches the Document Server: the last file server started. */
let lastOrigin = "http://127.0.0.1:9";
const dsOrigin = async () => lastOrigin;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "office-callback-"));
}

/** A document's file: in its folder (`root` is the test's data root, kept for the calls' shape). */
const docFile = (_root: string, meta: { path: string }): string => meta.path;

/* ------------------------------------------------------------------ */
/* synthetic req/res + the local "DS" file server                      */
/* ------------------------------------------------------------------ */

type FakeRes = {
  statusCode: number;
  body: string;
  headersSent: boolean;
  ended: boolean;
  finished: Promise<void>;
  writeHead(code: number, headers?: Record<string, string>): void;
  end(chunk?: string | Buffer): void;
};

function makeRes(): FakeRes {
  const res = { statusCode: 0, body: "", headersSent: false, ended: false, _done: null as null | (() => void) } as FakeRes & { _done: null | (() => void) };
  res.finished = new Promise<void>((r) => (res._done = r));
  res.writeHead = function (code: number): void {
    this.statusCode = code;
    this.headersSent = true;
  };
  res.end = function (chunk?: string | Buffer): void {
    if (chunk !== undefined && chunk !== null) this.body += chunk.toString();
    this.ended = true;
    res._done?.();
  };
  return res;
}

function makeReq(method: string, url: string, headers: Record<string, string>, bodyObj: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(bodyObj))]);
  Object.assign(stream, { method, url, headers });
  return stream as unknown as IncomingMessage;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function post(handler: Handler, body: Record<string, unknown>, opts: { method?: string; url?: string; headers?: Record<string, string> } = {}): Promise<FakeRes> {
  const res = makeRes();
  handler(makeReq(opts.method ?? "POST", opts.url ?? "/callback", opts.headers ?? {}, body), res as unknown as ServerResponse);
  await res.finished;
  return res;
}

const json = (res: FakeRes): Record<string, unknown> => JSON.parse(res.body) as Record<string, unknown>;

/** The token as the Document Server sends it: its outbox prefix "Bearer " in X-Auth-Token (JWT_HEADER only renames
 * the header), the envelope under `payload` with `operation: "callback"`. */
const dsToken = (envelope: Record<string, unknown>) => `Bearer ${signJwt({ payload: envelope, operation: "callback" }, 60_000, SECRET)}`;
const dsHeaders = (envelope: Record<string, unknown>) => ({ "x-auth-token": dsToken(envelope) });

/** A local node:http server standing in for the DS saved-file/changes endpoints. onSaved(n) decides the n-th
 * GET /saved outcome; changes is served verbatim at /changes.zip. Records every X-Auth-Token it was sent. */
type FileServer = {
  /** The browser's address of the Document Server, which the envelopes name. */
  base: string;
  /** Every path and query the server was asked for. */
  urls: string[];
  savedAttempts: number;
  tokens: string[];
  close(): Promise<void>;
};

async function startFileServer(
  onSaved: (n: number) => { status: number; bytes: Buffer },
  changes: Buffer | null,
): Promise<FileServer> {
  const server = http.createServer((req, res) => {
    let n = 0;
    urls.push(req.url ?? "");
    if (req.url?.startsWith("/cache/files/saved?")) {
      n = ++serverSavedCalls;
      serverTokens.push(typeof req.headers["x-auth-token"] === "string" ? req.headers["x-auth-token"] : "");
      const out = onSaved(n);
      res.writeHead(out.status, { "Content-Type": "application/octet-stream" });
      res.end(out.bytes);
    } else if (req.url?.startsWith("/cache/files/changes.zip?")) {
      if (!changes) return res.writeHead(404).end();
      serverTokens.push(typeof req.headers["x-auth-token"] === "string" ? req.headers["x-auth-token"] : "");
      res.writeHead(200, { "Content-Type": "application/zip" });
      res.end(changes);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  let serverSavedCalls = 0;
  const serverTokens: string[] = [];
  const urls: string[] = [];
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  lastOrigin = `http://127.0.0.1:${addr.port}`;
  return {
    base: BROWSER,
    urls,
    get savedAttempts() {
      return serverSavedCalls;
    },
    get tokens() {
      return serverTokens;
    },
    close: () =>
      new Promise<void>((r, j) => {
        // undici's fetch pool keep-ALIVEs its sockets; force them down so close() resolves immediately
        server.closeAllConnections?.();
        server.close((e) => (e ? j(e) : r()));
      }),
  };
}

/* ------------------------------------------------------------------ */
/* parseKey                                                            */
/* ------------------------------------------------------------------ */

test("makeKey/parseKey: the document's id hash and the revision hash, round-trip", () => {
  const sha = createHash("sha256").update("12345").digest("base64url");
  assert.equal(sha.length, 43); // one unpadded sha256 digest in base64url
  assert.equal(revHashOf(12345), sha);
  const keyId = createHash("sha256").update("my-doc").digest("base64url").slice(0, 22);
  assert.equal(keyIdOf("my-doc"), keyId);
  assert.equal(makeKey("my-doc", 12345), `${keyId}.${sha}`);
  assert.deepEqual(parseKey(`${keyId}.${sha}`), { keyId, revHash: sha });
});

test("makeKey: every key is one the Document Server takes (its alphabet, at most 128), for the longest title too", async () => {
  const root = tmpRoot();
  const title = "Ä long title with spaces, punctuation | pipes & ümlauts ".repeat(4).slice(0, 200);
  const doc = await createDoc({ title, type: "word", folder: homeIn(root) }, root);
  assert.ok(doc.docId.length > 128, "a docId alone can be longer than a key may be");
  for (const key of [makeKey(doc.docId, doc.mtimeMs), makeKey("a", 0), makeKey("x|y", 1.5)]) {
    assert.match(key, /^[0-9a-zA-Z_.=-]{1,128}$/, key);
  }
  const parsed = parseKey(makeKey(doc.docId, doc.mtimeMs))!;
  assert.equal(docIdOf(parsed.keyId, root), doc.docId);
  assert.equal(docIdOf(keyIdOf("not-in-the-library"), root), null);
});

test("parseKey: null for anything this package did not mint", () => {
  const sha = revHashOf(1);
  const keyId = keyIdOf("doc");
  assert.equal(parseKey(""), null);
  assert.equal(parseKey(`office|doc|${sha}`), null); // the old shape, which the Document Server refuses
  assert.equal(parseKey(keyId), null); // missing hash part
  assert.equal(parseKey(`${keyId}.`), null); // empty hash part
  assert.equal(parseKey(`.${sha}`), null); // empty id part
  assert.equal(parseKey(`${keyId}.${sha.slice(0, 42)}`), null); // 42 chars -- not a sha256 digest
  assert.equal(parseKey(`${keyId}.${"=".repeat(43)}`), null); // "=" is not base64url
});

/* ------------------------------------------------------------------ */
/* status-2 happy path                                                 */
/* ------------------------------------------------------------------ */

const hookLog: { docId: string; buffer: Buffer }[] = [];
onPersisted((docId, buffer) => hookLog.push({ docId, buffer })); // single module-level collector, cleared per test

test("status 2 happy path: persists bytes, bumps index, fires onPersisted, unlocks; the changes archive, which nothing reads, is not kept", async () => {
  const root = tmpRoot();
  const sink: string[] = [];
  const doc = await createDoc({ title: "Quarterly Report", type: "word", folder: homeIn(root) }, root);
  const before = getDoc(doc.docId, root)!;
  hookLog.length = 0;

  live.setUser(doc.docId, { id: "u1", name: "Ana" }, true); // the human editor is open -> locked via presence
  assert.equal(live.pollState(doc.docId, 0).locked, true);

  const newBytes = Buffer.from("saved-by-ds-content-" + "x".repeat(257));
  const zipBytes = Buffer.from("CHANGES-ARCHIVE-BYTES");
  const server = await startFileServer(() => ({ status: 200, bytes: newBytes }), zipBytes);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [5, 10], log: (l) => sink.push(l) });

  // The envelope is bound to the signed JWT claims; the JSON body is ignored by the handler.
  const envelope = {
    key: makeKey(doc.docId, before.mtimeMs),
    status: 2,
    url: `${server.base}/cache/files/saved?md5=m1&expires=9`,
    changesurl: `${server.base}/cache/files/changes.zip?md5=m2&expires=9`,
  };
  const res = await post(handler, envelope, { headers: dsHeaders(envelope) });

  await server.close();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { error: 0 });

  // the file bytes changed to exactly what DS served
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(newBytes), "document bytes were replaced");
  // the index moved on: new mtime revision + size of the new bytes
  const after = getDoc(doc.docId, root)!;
  assert.notEqual(after.mtimeMs, before.mtimeMs);
  assert.equal(after.sizeBytes, newBytes.length);
  // no version history is offered in the editor, so the changes archive is neither fetched nor kept
  assert.ok(!fs.existsSync(path.join(root, "history")));
  assert.equal(zipBytes.length > 0, true);
  // onPersisted fired once for this doc with the exact buffer (ping's wake hook will see these bytes)
  const mine = hookLog.filter((h) => h.docId === doc.docId);
  assert.equal(mine.length, 1);
  assert.ok(mine[0].buffer.equals(newBytes));
  // the persist path did not need retries and authenticated its outbound GETs with a verifiable HS256 token
  assert.equal(server.savedAttempts, 1);
  const t = server.tokens.find((x) => x !== "");
  assert.ok(t && verifyJwt(t, SECRET), "outbound fetch carried a valid X-Auth-Token JWT");
  // lock released after the persist (status-2 row: unlock AFTER persist)
  assert.equal(live.pollState(doc.docId, 0).locked, false);
});

test("stale key (revHash of an older mtime): the document is NOT overwritten, the save is kept as a copy beside it, and the person can find it", async () => {
  const root = tmpRoot();
  const sink: string[] = [];
  const records: { subject: string; reason: string }[] = [];
  const doc = await createDoc({ title: "Stale Doc", type: "word", folder: homeIn(root, "a") }, root);
  const before = getDoc(doc.docId, root)!;
  const original = fs.readFileSync(docFile(root, doc));
  hookLog.length = 0;

  const typed = Buffer.from("what the person typed in the session that opened the older revision");
  const server = await startFileServer(() => ({ status: 200, bytes: typed }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [5, 10], log: (l) => sink.push(l), record: (e) => records.push(e) });
  live.setUser(doc.docId, { id: "portal-user" }, true, { confirmed: true });

  // key minted from an OLDER mtime than the one currently in the index
  const envelope = { key: makeKey(doc.docId, before.mtimeMs - 60_000), status: 2, url: `${server.base}/cache/files/saved?md5=m1&expires=9` };
  const res = await post(handler, envelope, { headers: dsHeaders(envelope) });
  await server.close();
  assert.deepEqual(json(res), { error: 0 }, "saved, as a copy: the Document Server keeps nothing as forgotten");
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original), "the newer revision is untouched");
  assert.equal(getDoc(doc.docId, root)!.mtimeMs, before.mtimeMs);
  assert.equal(hookLog.filter((h) => h.docId === doc.docId).length, 0, "no wake from a save that was not taken");
  const copy = listDocs(root).find((d) => d.docId !== doc.docId)!;
  assert.match(copy.title, /^Stale Doc \(conflict \d{4}-\d\d-\d\d \d\d\.\d\d\)$/);
  assert.equal(copy.owner, doc.owner, "the same agents see it");
  assert.equal(path.dirname(copy.path), path.dirname(doc.path), "beside it, in its folder");
  assert.ok(fs.readFileSync(docFile(root, copy)).equals(typed), "what was typed is all there");
  assert.ok(sink.some((l) => l.includes("stale key") && l.includes(copy.title)));
  assert.ok(records.some((r) => r.subject === "Stale Doc" && r.reason.includes(copy.docId)), "recorded where the person looks");
  assert.deepEqual(live.usersOf(doc.docId), [], "the session is over");
});

test("a save refused beside a scanned document is kept in its folder, as its file is", async () => {
  const root = tmpRoot();
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-copy-")));
  fs.writeFileSync(path.join(ws, "plan.docx"), await (await import("../src/store")).templateDocx());
  fs.chmodSync(path.join(ws, "plan.docx"), 0o640);
  scanWorkspace([ws], root);
  const doc = listDocs(root)[0]!;
  const server = await startFileServer(() => ({ status: 200, bytes: Buffer.from("typed") }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [], log: () => {} });
  const envelope = { key: makeKey(doc.docId, doc.mtimeMs - 1), status: 2, url: `${server.base}/cache/files/saved?md5=m1&expires=9` };
  assert.deepEqual(json(await post(handler, envelope, { headers: dsHeaders(envelope) })), { error: 0 });
  await server.close();
  const copy = listDocs(root).find((d) => d.docId !== doc.docId)!;
  assert.equal(path.dirname(copy.path!), ws);
  assert.equal(fs.readFileSync(copy.path!, "utf8"), "typed");
  assert.equal(fs.statSync(copy.path!).mode & 0o777, 0o640);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("duplicate force-save pass (same url + our revision): treated as done, no second write", async () => {
  const root = tmpRoot();
  const sink: string[] = [];
  const doc = await createDoc({ title: "Forced Doc", type: "word", folder: homeIn(root) }, root);
  const before = getDoc(doc.docId, root)!;
  hookLog.length = 0;

  const firstBytes = Buffer.from("first-forcesave");
  let n = 0;
  const server = await startFileServer(() => ({ status: 200, bytes: firstBytes }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [5, 10], log: (l) => sink.push(l) });
  // Pass 1: the status-1 forcesave action (actions[].type === 2) persists now, doc STAYS locked.
  live.setLocked(doc.docId, true);
  const env1 = {
    key: makeKey(doc.docId, before.mtimeMs),
    status: 1,
    users: [{ id: "u2", name: "Bob" }],
    actions: [{ type: 2, userid: "u2" }],
    url: `${server.base}/cache/files/saved?md5=m1&expires=9`,
  };
  const r1 = await post(handler, env1, { headers: dsHeaders(env1) });
  assert.deepEqual(json(r1), { error: 0 });
  const mid = getDoc(doc.docId, root)!;
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(firstBytes));
  assert.equal(live.pollState(doc.docId, 0).locked, true, "forcesave keeps the doc locked (status-6 rules)");

  // Pass 2: DS then reports the canonical status 6 for the SAME save. The key now hashes an older mtime than
  // the one we just wrote -- without lastPersist this would answer {error:1} as a stale session.
  const env2 = {
    key: makeKey(doc.docId, before.mtimeMs),
    status: 6,
    url: `${server.base}/cache/files/saved?md5=m1&expires=9`,
    forcesavetype: 1,
  };
  const r2 = await post(handler, env2, { headers: dsHeaders(env2) });
  assert.deepEqual(json(r2), { error: 0 }, "duplicate pass reports success");
  const after = getDoc(doc.docId, root)!;
  assert.equal(after.mtimeMs, mid.mtimeMs, "no second persist happened");
  assert.equal(hookLog.filter((h) => h.docId === doc.docId).length, 1, "hook fired once for the single real save");
  await server.close();
});

test("a session's later save lands on top of its own forcesave (its key pins the revision it opened, not the one it wrote); another's is kept as a copy", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Goes On", type: "word", folder: homeIn(root) }, root);
  const opened = getDoc(doc.docId, root)!;
  let bytes = Buffer.from("forcesaved");
  const server = await startFileServer(() => ({ status: 200, bytes }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [], log: () => {} });
  const key = makeKey(doc.docId, opened.mtimeMs);
  const forced = { key, status: 6, url: `${server.base}/cache/files/saved?md5=a`, forcesavetype: 0, userdata: "office-x" };
  assert.deepEqual(json(await post(handler, forced, { headers: dsHeaders(forced) })), { error: 0 });
  assert.equal(fs.readFileSync(docFile(root, doc), "utf8"), "forcesaved");
  // More typed in the same session, which then closes: its save is on the revision its own forcesave wrote.
  bytes = Buffer.from("forcesaved, then more");
  const closed = { key, status: 2, url: `${server.base}/cache/files/saved?md5=b` };
  assert.deepEqual(json(await post(handler, closed, { headers: dsHeaders(closed) })), { error: 0 });
  assert.equal(fs.readFileSync(docFile(root, doc), "utf8"), "forcesaved, then more", "written, not kept as a copy");
  assert.equal(listDocs(root).length, 1);
  // A session of another key, opened on the first revision, never saved: its save is stale and kept as a copy.
  bytes = Buffer.from("from an old editor");
  const old = { key: makeKey(doc.docId, opened.mtimeMs - 1000), status: 2, url: `${server.base}/cache/files/saved?md5=c` };
  assert.deepEqual(json(await post(handler, old, { headers: dsHeaders(old) })), { error: 0 });
  assert.equal(fs.readFileSync(docFile(root, doc), "utf8"), "forcesaved, then more");
  assert.equal(listDocs(root).filter((d) => d.title.startsWith("Goes On (conflict")).length, 1);
  await server.close();
});

/** callback.ts loaded anew, as a restart of the half has it: nothing of what the module kept in memory. */
const freshCallback = async (n: number): Promise<typeof import("../src/callback")> => import(new URL(`../src/callback.ts?restart=${n}`, import.meta.url).href);

test("after a restart of the half, a session's close that holds what its forcesave of the run before wrote is no conflict; one with more in it still is", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Agent Doc", type: "word", folder: homeIn(root) }, root);
  const opened = getDoc(doc.docId, root)!;
  let bytes = Buffer.from("the agent's edit, forcesaved");
  const server = await startFileServer(() => ({ status: 200, bytes }), null);
  const key = makeKey(doc.docId, opened.mtimeMs);
  try {
    const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [], log: () => {} });
    const forced = { key, status: 6, url: `${server.base}/cache/files/saved?md5=a`, forcesavetype: 0, userdata: "office-x" };
    assert.deepEqual(json(await post(handler, forced, { headers: dsHeaders(forced) })), { error: 0 });
    // The half restarts (a fresh module: what the sessions saved is gone with the process), and the agent's editor's
    // session closes with exactly what the file holds.
    const fresh = await freshCallback(1);
    const again = fresh.createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [], log: () => {} });
    const closed = { key, status: 2, url: `${server.base}/cache/files/saved?md5=b` };
    assert.deepEqual(json(await post(again, closed, { headers: dsHeaders(closed) })), { error: 0 });
    assert.deepEqual(listDocs(root).map((d) => d.title), ["Agent Doc"], "no conflict copy");
    assert.equal(fs.readFileSync(docFile(root, doc), "utf8"), "the agent's edit, forcesaved");
    // Another session of that key after another restart, with something new in it: kept as a copy, as before.
    const third = await freshCallback(2);
    const later = third.createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [], log: () => {} });
    bytes = Buffer.from("the agent's edit, and more typed after the restart");
    assert.deepEqual(json(await post(later, closed, { headers: dsHeaders(closed) })), { error: 0 });
    assert.equal(fs.readFileSync(docFile(root, doc), "utf8"), "the agent's edit, forcesaved");
    assert.equal(listDocs(root).filter((d) => d.title.startsWith("Agent Doc (conflict")).length, 1);
  } finally {
    await server.close();
  }
});

test("status 6 in a session only agents' editors are in: saved, and the document is not locked; with a person in it, it is", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Agent forcesave", type: "word", folder: homeIn(root) }, root);
  const bytes = Buffer.from("the agent's edit");
  const server = await startFileServer(() => ({ status: 200, bytes }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [], log: () => {} });
  live.resetLive();
  const key = makeKey(doc.docId, doc.mtimeMs);
  try {
    const agentOnly = { key, status: 1, users: ["agent:abc"], actions: [{ type: 1, userid: "agent:abc" }] };
    await post(handler, agentOnly, { headers: dsHeaders(agentOnly) });
    const forced = { key, status: 6, url: `${server.base}/cache/files/saved?md5=a`, forcesavetype: 0, userdata: "office-x" };
    assert.deepEqual(json(await post(handler, forced, { headers: dsHeaders(forced) })), { error: 0 });
    assert.equal(fs.readFileSync(docFile(root, doc), "utf8"), "the agent's edit");
    assert.equal(live.isLocked(doc.docId), false, "an agent's editor locks nothing");
    const both = { key, status: 1, users: ["agent:abc", "portal-user"], actions: [{ type: 1, userid: "portal-user" }] };
    await post(handler, both, { headers: dsHeaders(both) });
    const again = { ...forced, url: `${server.base}/cache/files/saved?md5=b` };
    assert.deepEqual(json(await post(handler, again, { headers: dsHeaders(again) })), { error: 0 });
    assert.equal(live.isLocked(doc.docId), true, "a person is in it");
  } finally {
    live.resetLive();
    await server.close();
  }
});

test("two sessions of one document (an editor that loaded a newer revision while the old one closes): the old one's close keeps the new one's users and lock", async () => {
  live.resetLive();
  const root = tmpRoot();
  const doc = await createDoc({ title: "Two Keys", type: "word", folder: homeIn(root) }, root);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, log: () => {} });
  const oldKey = makeKey(doc.docId, doc.mtimeMs - 1000);
  const newKey = makeKey(doc.docId, doc.mtimeMs);
  for (const env of [{ key: oldKey, status: 1, users: ["portal-user"] }, { key: newKey, status: 1, users: ["portal-user"] }]) await post(handler, env, { headers: dsHeaders(env) });
  assert.deepEqual(live.sessionKeys(doc.docId).sort(), [newKey, oldKey].sort());
  const closed = { key: oldKey, status: 4 };
  await post(handler, closed, { headers: dsHeaders(closed) });
  assert.deepEqual(live.sessionKeys(doc.docId), [newKey]);
  assert.deepEqual(live.usersOf(doc.docId).map((u) => u.id), ["portal-user"], "still in the new session");
  assert.equal(live.pollState(doc.docId, 0).locked, true);
  // Its users leaving (a status 1 with nobody), and then its close, end it all.
  const left = { key: newKey, status: 1, users: [] };
  await post(handler, left, { headers: dsHeaders(left) });
  assert.deepEqual(live.usersOf(doc.docId), []);
  const end = { key: newKey, status: 4 };
  await post(handler, end, { headers: dsHeaders(end) });
  assert.deepEqual(live.sessionKeys(doc.docId), []);
  assert.equal(live.pollState(doc.docId, 0).locked, false);
});

/* ------------------------------------------------------------------ */
/* JWT verification                                                    */
/* ------------------------------------------------------------------ */

test("JWT: garbage token -> 401 {error:1} without touching disk", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Jwt Doc", type: "word", folder: homeIn(root) }, root);
  const original = fs.readFileSync(docFile(root, doc));
  const server = await startFileServer(() => ({ status: 200, bytes: Buffer.from("nope") }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, log: () => {} });

  const res = await post(handler, {
    key: makeKey(doc.docId, getDoc(doc.docId, root)!.mtimeMs),
    status: 2,
    url: `${server.base}/cache/files/saved?md5=m1&expires=9`,
  }, { headers: { "x-auth-token": "garbage.token.value" } });

  await server.close();
  assert.equal(res.statusCode, 401);
  assert.deepEqual(json(res), { error: 1 });
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original), "no download, no write");
  assert.equal(server.savedAttempts, 0);
});

test("JWT: RS256-alg token with a valid HMAC signature is still rejected (alg pinned to HS256)", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Alg Doc", type: "word", folder: homeIn(root) }, root);
  const original = fs.readFileSync(docFile(root, doc));

  // Forge a token whose header says RS256 but whose signature is the HS256 MAC over that exact pair.
  const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ key: makeKey(doc.docId, getDoc(doc.docId, root)!.mtimeMs), status: 2 }));
  const sig = b64url(createHmac("sha256", SECRET).update(`${head}.${body}`).digest());
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, log: () => {} });

  const res = await post(handler, { status: 2 }, { headers: { "x-auth-token": `${head}.${body}.${sig}` } });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(json(res), { error: 1 });
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original));
});

test("JWT: expired token -> 401; missing token entirely -> 401", async () => {
  const root = tmpRoot();
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, log: () => {} });
  const key = makeKey("whatever-doc", 1);

  const expired = await post(handler, { key, status: 4 }, { headers: { "x-auth-token": signJwt({ sub: "x" }, -1000, SECRET) } });
  assert.equal(expired.statusCode, 401);
  assert.deepEqual(json(expired), { error: 1 });

  const missing = await post(handler, { key, status: 4 }); // no x-auth-token header at all
  assert.equal(missing.statusCode, 401);
  assert.deepEqual(json(missing), { error: 1 });
});

test("JWT: the Document Server's own header, \"Bearer <jwt>\" over {payload, operation}, is taken; the bare form too; another operation is refused", async () => {
  const root = tmpRoot();
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, log: () => {} });
  const doc = await createDoc({ title: "Bearer", type: "word", folder: homeIn(root) }, root);
  const envelope = { key: makeKey(doc.docId, doc.mtimeMs), status: 4 };
  for (const token of [dsToken(envelope), `bearer   ${signJwt(envelope, 60_000, SECRET)}`, signJwt({ payload: envelope }, 60_000, SECRET)]) {
    live.setLocked(doc.docId, true);
    const res = await post(handler, { ...envelope, token: "the body's own copy" }, { headers: { "x-auth-token": token } });
    assert.deepEqual([res.statusCode, json(res)], [200, { error: 0 }], token.slice(0, 12));
    assert.equal(live.isLocked(doc.docId), false);
  }
  const other = await post(handler, envelope, { headers: { "x-auth-token": `Bearer ${signJwt({ payload: envelope, operation: "command" }, 60_000, SECRET)}` } });
  assert.deepEqual([other.statusCode, json(other)], [401, { error: 1 }]);
});

test("JWT: embedded body.token is accepted as a defensive fallback (header path stays canonical)", async () => {
  const root = tmpRoot();
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, log: () => {} });
  const doc = await createDoc({ title: "Fallback", type: "word", folder: homeIn(root) }, root);
  live.setLocked(doc.docId, true);

  const res = await post(handler, {
    key: makeKey(doc.docId, 1),
    status: 4,
    // The fallback token itself must carry the signed envelope (the body is never trusted).
    token: signJwt({ key: makeKey(doc.docId, 1), status: 4 }, 60_000, SECRET), // no x-auth-token header
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { error: 0 });
  assert.equal(live.pollState(doc.docId, 0).locked, false, "status-4 unlock applied through the fallback");
});

test("envelope binding: valid token without signed key/status cannot drive a hostile body", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Bind Doc", type: "word", folder: homeIn(root) }, root);
  const original = fs.readFileSync(docFile(root, doc));
  const server = await startFileServer(() => ({ status: 200, bytes: Buffer.from("attacker-bytes") }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, log: () => {} });

  // A valid token that carries NO envelope (the shape of our own non-callback tokens) plus a hostile JSON
  // body claiming status 2 for a library document: rejected at the binding check, disk untouched.
  const res = await post(handler, {
    key: makeKey(doc.docId, getDoc(doc.docId, root)!.mtimeMs),
    status: 2,
    url: `${server.base}/cache/files/saved?md5=m1&expires=9`,
  }, { headers: { "x-auth-token": signJwt({ sub: "x" }, 60_000, SECRET) } });

  await server.close();
  assert.equal(res.statusCode, 400);
  assert.deepEqual(json(res), { error: 1 });
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original), "hostile body ignored, file untouched");
  assert.equal(server.savedAttempts, 0);
});

/* ------------------------------------------------------------------ */
/* status 1 / 4 presence + lock commands                               */
/* ------------------------------------------------------------------ */

test("status 1 join then leave mutates live.usersOf; status 4 unlocks without any disk write", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Presence Doc", type: "word", folder: homeIn(root) }, root);
  const before = getDoc(doc.docId, root)!;
  const original = fs.readFileSync(docFile(root, doc));
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, log: () => {} });
  // JOIN: presence lands in live with id/name and a numeric join time; the doc locks (users.length>0).
  const envJoin = { key: makeKey(doc.docId, before.mtimeMs), status: 1, users: [{ id: "u9", name: "Bob" }], actions: [{ type: 1, userid: "u9" }] };
  const join = await post(handler, envJoin, { headers: dsHeaders(envJoin) });
  assert.deepEqual(json(join), { error: 0 });
  const joined = live.usersOf(doc.docId);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].id, "u9");
  assert.equal(joined[0].name, "Bob");
  assert.equal(typeof joined[0].at, "number");
  assert.equal(live.pollState(doc.docId, 0).locked, true);

  // LEAVE: the empty users snapshot removes the user and clears the derived lock.
  const envLeave = { key: makeKey(doc.docId, before.mtimeMs), status: 1, users: [] };
  const leave = await post(handler, envLeave, { headers: dsHeaders(envLeave) });
  assert.deepEqual(json(leave), { error: 0 });
  assert.deepEqual(live.usersOf(doc.docId), []);
  assert.equal(live.pollState(doc.docId, 0).locked, false);

  // STATUS 4: explicit unlock, and the file + index are byte-identical to before.
  live.setLocked(doc.docId, true);
  const env4 = { key: makeKey(doc.docId, before.mtimeMs), status: 4 };
  const r4 = await post(handler, env4, { headers: dsHeaders(env4) });
  assert.deepEqual(json(r4), { error: 0 });
  assert.equal(live.pollState(doc.docId, 0).locked, false);
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original), "status 4 wrote nothing");
  const after = getDoc(doc.docId, root)!;
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.sizeBytes, before.sizeBytes);
});

test("status 1 as the Document Server sends it: users by id strings keep the minted seat, its name, past the TTL; a leave and a close end it", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Seat", type: "word", folder: homeIn(root) }, root);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, log: () => {} });
  live.resetLive();
  live.setPresenceTtl(40);
  // The seat the editor config was minted with.
  live.setUser(doc.docId, { id: "portal-user", name: "Portal" }, true);
  const key = makeKey(doc.docId, doc.mtimeMs);
  const connected = { key, status: 1, users: ["portal-user"], actions: [{ type: 1, userid: "portal-user" }] };
  assert.deepEqual(json(await post(handler, connected, { headers: dsHeaders(connected) })), { error: 0 });
  assert.deepEqual(live.usersOf(doc.docId).map((u) => [u.id, u.name]), [["portal-user", "Portal"]]);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(live.usersOf(doc.docId).length, 1, "no heartbeat comes: the confirmed seat outlives the TTL while the editor is open");
  assert.equal(live.pollState(doc.docId, 0).locked, true);
  // A second person joins, and leaves again.
  const two = { key, status: 1, users: ["portal-user", "guest"], actions: [{ type: 1, userid: "guest" }] };
  await post(handler, two, { headers: dsHeaders(two) });
  assert.equal(live.usersOf(doc.docId).length, 2);
  const left = { key, status: 1, users: ["portal-user"], actions: [{ type: 0, userid: "guest" }] };
  await post(handler, left, { headers: dsHeaders(left) });
  assert.deepEqual(live.usersOf(doc.docId).map((u) => u.id), ["portal-user"]);
  // The last one closes: status 4.
  const closed = { key, status: 4 };
  await post(handler, closed, { headers: dsHeaders(closed) });
  assert.deepEqual(live.usersOf(doc.docId), []);
  live.resetLive();
});

test("status 1 with an agent's editor in the session: its key is a session of the document, the agent is among agentsOf, but no person editing, no lock", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Agent seat", type: "word", folder: homeIn(root) }, root);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, log: () => {} });
  live.resetLive();
  live.nameAgent("agent:abc", "Research (agent)");
  const key = makeKey(doc.docId, doc.mtimeMs);
  const agentOnly = { key, status: 1, users: ["agent:abc"], actions: [{ type: 1, userid: "agent:abc" }] };
  assert.deepEqual(json(await post(handler, agentOnly, { headers: dsHeaders(agentOnly) })), { error: 0 });
  assert.deepEqual(live.sessionKeys(doc.docId), [key], "a person who opens it joins the agent's session");
  assert.deepEqual(live.usersOf(doc.docId), []);
  assert.deepEqual(live.agentsOf(doc.docId), [{ id: "agent:abc", name: "Research (agent)" }]);
  assert.equal(live.isLocked(doc.docId), false);
  assert.equal(live.pollState(doc.docId, 0).locked, false);
  // A person joins: they count, the agent still does not.
  const both = { key, status: 1, users: ["agent:abc", "portal-user"], actions: [{ type: 1, userid: "portal-user" }] };
  await post(handler, both, { headers: dsHeaders(both) });
  assert.deepEqual(live.usersOf(doc.docId).map((u) => u.id), ["portal-user"]);
  assert.equal(live.isLocked(doc.docId), true);
  // The agent's editor closes: the person stays, and with them the lock.
  const personOnly = { key, status: 1, users: ["portal-user"], actions: [{ type: 0, userid: "agent:abc" }] };
  await post(handler, personOnly, { headers: dsHeaders(personOnly) });
  assert.deepEqual(live.agentsOf(doc.docId), []);
  assert.equal(live.usersOf(doc.docId).length, 1);
  live.resetLive();
});

test("status 1: the last person leaves a session only agents' editors are left in: the Document Server is asked to save it now", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Left to agents", type: "word", folder: homeIn(root) }, root);
  const asked: Record<string, unknown>[] = [];
  const ds = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/command") asked.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.end(JSON.stringify({ error: 0 }));
    });
  });
  await new Promise<void>((r) => ds.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(ds.address() as { port: number }).port}`;
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, async () => origin, { root, log: () => {} });
  live.resetLive();
  const key = makeKey(doc.docId, doc.mtimeMs);
  const say = async (users: string[]) => {
    const envelope = { key, status: 1, users };
    assert.deepEqual(json(await post(handler, envelope, { headers: dsHeaders(envelope) })), { error: 0 });
    await new Promise((r) => setTimeout(r, 100));
  };
  try {
    await say(["agent:abc"]);
    await say(["agent:abc", "portal-user"]);
    assert.deepEqual(asked, [], "nobody left yet");
    await say(["agent:abc"]);
    assert.deepEqual((asked as Record<string, unknown>[]).map((c) => [c.c, c.key]), [["forcesave", key]], "saved as the person left");
    // Everybody leaving closes the session by itself: nothing to ask.
    await say(["agent:abc", "portal-user"]);
    await say([]);
    assert.equal(asked.length, 1);
  } finally {
    live.resetLive();
    ds.closeAllConnections();
    ds.close();
  }
});

test("statuses 3 and 7: one log line each, zero file changes, zero downloads", async () => {
  const root = tmpRoot();
  const sink: string[] = [];
  const doc = await createDoc({ title: "Errors Doc", type: "word", folder: homeIn(root) }, root);
  const before = getDoc(doc.docId, root)!;
  const original = fs.readFileSync(docFile(root, doc));

  const server = await startFileServer(() => ({ status: 200, bytes: Buffer.from("should-not-be-fetched") }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [5, 10], log: (l) => sink.push(l) });
  const env3 = { key: makeKey(doc.docId, before.mtimeMs), status: 3, url: `${server.base}/cache/files/saved?md5=m1&expires=9` };
  const r3 = await post(handler, env3, { headers: dsHeaders(env3) });
  assert.equal(r3.statusCode, 200);
  assert.deepEqual(json(r3), { error: 0 }, "we did not fail internally, so the answer is 0");

  const env7 = { key: makeKey(doc.docId, before.mtimeMs), status: 7, url: `${server.base}/cache/files/saved?md5=m1&expires=9`, forcesavetype: 2 };
  const r7 = await post(handler, env7, { headers: dsHeaders(env7) });
  assert.equal(r7.statusCode, 200);
  assert.deepEqual(json(r7), { error: 0 });

  await server.close();
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original));
  const after = getDoc(doc.docId, root)!;
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(server.savedAttempts, 0, "no fetch happened for 3/7");
  assert.ok(sink.some((l) => l.startsWith("status-3:")), `status-3 line present: ${sink.join("; ")}`);
  assert.ok(sink.some((l) => l.startsWith("status-7:") && l.includes("forcesavetype=2")), `status-7 line present`);
});

/* ------------------------------------------------------------------ */
/* retries                                                             */
/* ------------------------------------------------------------------ */

test("retry: two failed downloads then success -> persisted", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Flaky Doc", type: "word", folder: homeIn(root) }, root);
  const before = getDoc(doc.docId, root)!;
  hookLog.length = 0;

  const saved = Buffer.from("eventually-arrives");
  const server = await startFileServer((n) => (n < 3 ? { status: 500, bytes: Buffer.alloc(0) } : { status: 200, bytes: saved }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [5, 10], log: () => {} });

  const envelope = {
    key: makeKey(doc.docId, before.mtimeMs),
    status: 2,
    url: `${server.base}/cache/files/saved?md5=m1&expires=9`,
  };
  const res = await post(handler, envelope, { headers: dsHeaders(envelope) });

  await server.close();
  assert.deepEqual(json(res), { error: 0 });
  assert.equal(server.savedAttempts, 3, "failed twice, succeeded on the third attempt");
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(saved));
  assert.equal(hookLog.filter((h) => h.docId === doc.docId).length, 1);
});

test("retry: all attempts fail -> JSON error, doc untouched, lock left as-is", async () => {
  const root = tmpRoot();
  const sink: string[] = [];
  const doc = await createDoc({ title: "Dead Doc", type: "word", folder: homeIn(root) }, root);
  const before = getDoc(doc.docId, root)!;
  const original = fs.readFileSync(docFile(root, doc));

  const server = await startFileServer(() => ({ status: 503, bytes: Buffer.alloc(0) }), null);
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [5, 10], log: (l) => sink.push(l) });

  live.setLocked(doc.docId, true);
  const envelope = {
    key: makeKey(doc.docId, before.mtimeMs),
    status: 2,
    url: `${server.base}/cache/files/saved?md5=m1&expires=9`,
  };
  const res = await post(handler, envelope, { headers: dsHeaders(envelope) });

  await server.close();
  assert.equal(res.statusCode, 200); // DS reads the JSON error field, not the HTTP code
  assert.deepEqual(json(res), { error: 1 });
  assert.equal(server.savedAttempts, 3, "1 + retryDelaysMs.length attempts");
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original), "existing file never deleted or replaced");
  const after = getDoc(doc.docId, root)!;
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(live.pollState(doc.docId, 0).locked, true, "fetch failure leaves the lock state untouched (DS will retry)");
  assert.ok(sink.some((l) => l.includes("could not download")), `a download-failure line was logged`);
});

/* ------------------------------------------------------------------ */
/* envelope / route rejections                                         */
/* ------------------------------------------------------------------ */

test("route + envelope: GET -> 405, bad path -> 404, unknown status / bad key -> 400", async () => {
  const root = tmpRoot();
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, log: () => {} });
  const key = makeKey((await createDoc({ title: "Route", type: "word", folder: homeIn(root) }, root)).docId, 1);
  // Envelopes are signed into the token claims; each post below signs its own envelope.
  const tokenFor = (env: Record<string, unknown>) => ({ "x-auth-token": signJwt(env, 60_000, SECRET) });

  const get = await post(handler, { key, status: 4 }, { method: "GET", headers: tokenFor({ key, status: 4 }) });
  assert.equal(get.statusCode, 405);
  assert.deepEqual(json(get), { error: 1 });

  const wrongPath = await post(handler, { key, status: 4 }, { url: "/doc/something-else", headers: tokenFor({ key, status: 4 }) });
  assert.equal(wrongPath.statusCode, 404);
  assert.deepEqual(json(wrongPath), { error: 1 });

  // Signed envelope with an unknown status value -> the handler rejects the status itself.
  const unknownStatus = await post(handler, { key, status: 99 }, { headers: tokenFor({ key, status: 99 }) });
  assert.equal(unknownStatus.statusCode, 400);
  assert.deepEqual(json(unknownStatus), { error: 1 });

  // Signed envelope with a malformed key -> parseKey rejects it.
  const badKey = await post(handler, { key: "nope", status: 2 }, { headers: tokenFor({ key: "nope", status: 2 }) });
  assert.equal(badKey.statusCode, 400);
  assert.deepEqual(json(badKey), { error: 1 });

  // No signed key in the claims -> rejected at the binding check (the unsigned body is never consulted).
  const noKey = await post(handler, { key, status: 2 }, { headers: tokenFor({ status: 2 }) });
  assert.equal(noKey.statusCode, 400);
  assert.deepEqual(json(noKey), { error: 1 });

  // A key of a document deleted since it was opened: a save is refused, a close needs nothing.
  const gone = makeKey("deleted-since", 1);
  assert.deepEqual(json(await post(handler, { key: gone, status: 2 }, { headers: tokenFor({ key: gone, status: 2, url: "http://x/cache/files/a" }) })), { error: 1 });
  assert.deepEqual(json(await post(handler, { key: gone, status: 4 }, { headers: tokenFor({ key: gone, status: 4 }) })), { error: 0 });
});

/* ------------------------------------------------------------------ */
/* where the save is downloaded from                                   */
/* ------------------------------------------------------------------ */

test("status 2: the save the Document Server names at the browser's address is downloaded from the Document Server itself, its query intact", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Mapped", type: "word", folder: homeIn(root) }, root);
  const saved = Buffer.from("saved through the relay");
  const server = await startFileServer(() => ({ status: 200, bytes: saved }), Buffer.from("zip"));
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [], log: () => {} });
  // What the Document Server sends once it was told where the browser is: the portal's public, sign-in-gated address.
  const envelope = {
    key: makeKey(doc.docId, doc.mtimeMs),
    status: 2,
    url: `${BROWSER}/cache/files/saved?md5=Ab-Cd_1&expires=1792000000&filename=output.docx`,
    changesurl: `${BROWSER}/cache/files/changes.zip?md5=Ef&expires=1792000000`,
  };
  const res = await post(handler, envelope, { headers: dsHeaders(envelope) });
  await server.close();
  assert.deepEqual(json(res), { error: 0 });
  assert.deepEqual(server.urls, ["/cache/files/saved?md5=Ab-Cd_1&expires=1792000000&filename=output.docx"]);
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(saved));
});

test("status 2: an address outside the Document Server's files is refused without a fetch", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Elsewhere", type: "word", folder: homeIn(root) }, root);
  const original = fs.readFileSync(docFile(root, doc));
  const server = await startFileServer(() => ({ status: 200, bytes: Buffer.from("x") }), null);
  const sink: string[] = [];
  const handler = createCallbackHandler(() => DS_STATE, () => SECRET, dsOrigin, { root, retryDelaysMs: [], log: (l) => sink.push(l) });
  for (const url of ["http://169.254.169.254/latest/meta-data", `${BROWSER}/info/info.json`, "not a url"]) {
    const envelope = { key: makeKey(doc.docId, doc.mtimeMs), status: 2, url };
    const res = await post(handler, envelope, { headers: dsHeaders(envelope) });
    assert.deepEqual(json(res), { error: 1 });
  }
  await server.close();
  assert.deepEqual(server.urls, [], "nothing was fetched");
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(original));
  assert.equal(sink.filter((l) => /outside the document server's files|names no address/.test(l)).length, 3);
});

test("onDocumentServer: the path from /cache/files/ on and the query, on the Document Server's origin", () => {
  assert.equal(onDocumentServer("https://a.example/p/ds/cache/files/data/k_1/output.docx/output.docx?md5=x&expires=2", "http://relay:3890"), "http://relay:3890/cache/files/data/k_1/output.docx/output.docx?md5=x&expires=2");
  assert.throws(() => onDocumentServer("https://a.example/web-apps/x", "http://relay:3890"), /outside/);
});

/* ------------------------------------------------------------------ */
/* saves the Document Server kept as forgotten                          */
/* ------------------------------------------------------------------ */

/** The Document Server's command service and its forgotten files, as far as recoverForgotten asks them: every
 * command must carry its JWT as the Document Server takes it. */
async function startForgetfulDs(forgotten: Record<string, Buffer>) {
  const deleted: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/cache/files/forgotten/")) {
      const key = decodeURIComponent(req.url.split("/")[4]!);
      res.end(forgotten[key]);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const token = String(req.headers["x-auth-token"] ?? "").replace(/^Bearer /, "");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.url !== "/command" || !verifyJwt(token, SECRET)) return void res.end(JSON.stringify({ error: 6 }));
      if (body.c === "getForgottenList") return void res.end(JSON.stringify({ error: 0, keys: Object.keys(forgotten) }));
      if (body.c === "getForgotten") return void res.end(JSON.stringify({ error: 0, key: body.key, url: `http://ds.example/cache/files/forgotten/${encodeURIComponent(body.key)}/output.docx/output.docx?md5=x` }));
      if (body.c === "deleteForgotten") {
        deleted.push(body.key);
        return void res.end(JSON.stringify({ error: 0, key: body.key }));
      }
      res.end(JSON.stringify({ error: 5 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, deleted, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

test("recoverForgotten: a save the Document Server kept as forgotten (the portal was away) is taken back and let go; one over a newer revision is kept as a copy; another's key is left alone", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Away", type: "word", folder: homeIn(root) }, root);
  const moved = await createDoc({ title: "Moved on", type: "word", folder: homeIn(root) }, root);
  const forgotten = {
    [makeKey(doc.docId, doc.mtimeMs)]: Buffer.from("typed while the portal was away"),
    [makeKey(moved.docId, moved.mtimeMs - 1000)]: Buffer.from("typed on an older revision"),
    "someone-elses-key": Buffer.from("not ours"),
  };
  const ds = await startForgetfulDs(forgotten);
  const taken = await recoverForgotten({ getState: () => DS_STATE, getSecret: () => SECRET, getOrigin: async () => ds.origin, root, log: () => {}, retryDelaysMs: [] });
  await ds.close();
  assert.equal(taken, 2);
  assert.equal(fs.readFileSync(docFile(root, doc), "utf8"), "typed while the portal was away");
  assert.notEqual(fs.readFileSync(docFile(root, moved), "utf8"), "typed on an older revision", "the newer revision is not overwritten");
  const copy = listDocs(root).find((d) => d.title.startsWith("Moved on (conflict"))!;
  assert.equal(fs.readFileSync(docFile(root, copy), "utf8"), "typed on an older revision");
  assert.deepEqual(ds.deleted.sort(), [makeKey(doc.docId, doc.mtimeMs), makeKey(moved.docId, moved.mtimeMs - 1000)].sort());
});

/* ------------------------------------------------------------------ */
/* the bare module-level handler + configure (server wiring)              */
/* ------------------------------------------------------------------ */

test("bare handleCallback: 503 until configure; after configure it serves requests", async () => {
  const root = tmpRoot();
  const wire = (await createDoc({ title: "Wire", type: "word", folder: homeIn(root) }, root)).docId;

  // Not configured yet (no test before this one called configure).
  const notYet = await post(handleCallback, { key: makeKey(wire, 1), status: 4 });
  assert.equal(notYet.statusCode, 503);
  assert.deepEqual(json(notYet), { error: 1 });

  // Configured but the DS record is still absent (getState -> null) -> 503 as well.
  configure({ getState: () => null, getSecret: () => SECRET, getOrigin: dsOrigin, root, log: () => {} });
  const noState = await post(handleCallback, { key: makeKey(wire, 1), status: 4 });
  assert.equal(noState.statusCode, 503);
  assert.deepEqual(json(noState), { error: 1 });

  // The real wiring shape (what server.ts does at boot).
  live.setLocked(wire, true);
  configure({ getState: () => DS_STATE, getSecret: () => SECRET, getOrigin: dsOrigin, root, log: () => {} });
  const wireEnv = { key: makeKey(wire, 1), status: 4 };
  const ok = await post(handleCallback, wireEnv, { headers: dsHeaders(wireEnv) });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(json(ok), { error: 0 });
  assert.equal(live.pollState(wire, 0).locked, false);
});

/* ------------------------------------------------------------------ */
/* live.ts pollState resolver                                          */
/* ------------------------------------------------------------------ */

test("live.pollState: pendingRev only when the resolved revision is strictly newer than the client's", () => {
  live.resetLive(); // clean slate (also proves reset exists and wipes state)
  const docId = "resolver-doc";
  live.setMetaResolver((id) => (id === docId ? 2000 : null));

  assert.deepEqual(live.pollState(docId, 1999), { locked: false, pendingRev: 2000 }); // agent updated since open
  assert.deepEqual(live.pollState(docId, 2000), { locked: false, pendingRev: null }); // same revision
  assert.deepEqual(live.pollState(docId, 5000), { locked: false, pendingRev: null }); // client ahead (weird but safe)

  live.setUser(docId, { id: "u", name: "Z" }, true);
  assert.equal(live.pollState(docId, 2000).locked, true, "presence locks even without the flag");
  live.setLocked(docId, false);
  live.clearDoc(docId);
  assert.deepEqual(live.usersOf(docId), []);
  assert.equal(live.pollState(docId, 1999).locked, false, "clearDoc drops the lock entirely");

  // A cleared resolver makes pendingRev null again (server.ts re-registers at boot).
  live.setMetaResolver(null);
  assert.deepEqual(live.pollState(docId, 1999), { locked: false, pendingRev: null });
});
