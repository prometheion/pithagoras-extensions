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
  CallbackState, configure, createCallbackHandler, docIdOf, handleCallback, keyIdOf, makeKey, onDocumentServer, onPersisted, parseKey, revHashOf,
} from "../src/callback";
import { createDoc, getDoc, listDocs, scanWorkspace } from "../src/store";
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

const docFile = (root: string, meta: { docId: string; title: string; ext: string }): string =>
  path.join(root, "docs", meta.docId, `${meta.title}.${meta.ext}`);

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
  const doc = await createDoc({ title, type: "word" }, root);
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

test("status 2 happy path: persists bytes, bumps index, stores history zip, fires onPersisted, unlocks", async () => {
  const root = tmpRoot();
  const sink: string[] = [];
  const doc = await createDoc({ title: "Quarterly Report", type: "word" }, root);
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
  // the changes archive landed at history/<doc>/<newRev>.zip (rev = the NEW post-persist mtime)
  const zipPath = path.join(root, "history", doc.docId, `${after.mtimeMs}.zip`);
  assert.ok(fs.readFileSync(zipPath).equals(zipBytes), "changes zip stored under the new revision");
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
  const doc = await createDoc({ title: "Stale Doc", type: "word", owner: "/homes/a" }, root);
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
  assert.equal(copy.owner, "/homes/a", "the same agents see it");
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
  const doc = await createDoc({ title: "Forced Doc", type: "word" }, root);
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

/* ------------------------------------------------------------------ */
/* JWT verification                                                    */
/* ------------------------------------------------------------------ */

test("JWT: garbage token -> 401 {error:1} without touching disk", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Jwt Doc", type: "word" }, root);
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
  const doc = await createDoc({ title: "Alg Doc", type: "word" }, root);
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
  const doc = await createDoc({ title: "Bearer", type: "word" }, root);
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
  const doc = await createDoc({ title: "Fallback", type: "word" }, root);
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
  const doc = await createDoc({ title: "Bind Doc", type: "word" }, root);
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
  const doc = await createDoc({ title: "Presence Doc", type: "word" }, root);
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
  const doc = await createDoc({ title: "Seat", type: "word" }, root);
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

test("statuses 3 and 7: one log line each, zero file changes, zero downloads", async () => {
  const root = tmpRoot();
  const sink: string[] = [];
  const doc = await createDoc({ title: "Errors Doc", type: "word" }, root);
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
  const doc = await createDoc({ title: "Flaky Doc", type: "word" }, root);
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
  const doc = await createDoc({ title: "Dead Doc", type: "word" }, root);
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
  const key = makeKey((await createDoc({ title: "Route", type: "word" }, root)).docId, 1);
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
  const doc = await createDoc({ title: "Mapped", type: "word" }, root);
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
  assert.deepEqual(server.urls, ["/cache/files/saved?md5=Ab-Cd_1&expires=1792000000&filename=output.docx", "/cache/files/changes.zip?md5=Ef&expires=1792000000"]);
  assert.ok(fs.readFileSync(docFile(root, doc)).equals(saved));
});

test("status 2: an address outside the Document Server's files is refused without a fetch", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Elsewhere", type: "word" }, root);
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
/* the bare module-level handler + configure (server wiring)              */
/* ------------------------------------------------------------------ */

test("bare handleCallback: 503 until configure; after configure it serves requests", async () => {
  const root = tmpRoot();
  const wire = (await createDoc({ title: "Wire", type: "word" }, root)).docId;

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
