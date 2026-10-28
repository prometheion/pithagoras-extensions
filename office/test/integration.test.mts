/**
 * Integration tests for @pithagoras/office: the real server half and its real loopback listener, over a tmp dataDir,
 * with a small server of the test's own standing in for the Document Server's files. What they assert:
 *
 *   1. A ticketed GET on the REAL loopback listener serves a document LARGER than 1 MB byte-for-byte
 *      (the whole reason the cookie-free listener exists is that portal-managed files cap at MAX_EDIT_BYTES
 *      = 1 MB in the portal) and rejects an expired ticket.
 *   2. A synthetic OnlyOffice callback with status 2 arrives on the loopback POST /callback WITHOUT any
 *      session cookie, persists (bytes on disk changed to exactly what body.url served), bumps the index
 *      revision, and clears the lock AFTER the persist.
 *
 * The agent's edits go through its own editor (seat.ts), which needs the real Document Server and the agents' browser:
 * test/portal/e2e.test.mts and spike.test.mts, opt-in. These need no Docker and start none.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import officeServer, { jwtSecret, loopbackPort, ticketSecret, ticketSubject } from "../src/server";
import * as store from "../src/store";
import { filesCreate, homeIn } from "./homes.mts";
import * as live from "../src/live";
import { mintTicket } from "../src/tickets";
import { signJwt } from "../src/jwt";
import { makeKey } from "../src/callback";
import { parseDocx, rewriteZip } from "../src/ooxml";
import { registerTools, __resetToolsForTests } from "../src/tools";
import * as container from "../src/container";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
/** The committed sample docx doubles as the "what the DS saved" payload in test 2: it differs from the
 * blank store template on disk, so "bytes changed" is a meaningful assertion. */
const SAVED_DOCX = fs.readFileSync(`${FIXTURES}sample.docx`);

/* ------------------------------------------------------------------ */
/* booting the real server half against a tmp dataDir + fake portal    */
/* ------------------------------------------------------------------ */

interface Booted {
  root: string;
  /** Where Docker for extensions says the Document Server is reached (the stand-in's address, once it listens). */
  reach: { host: string; port: number };
  logs: string[];
  audits: Array<Record<string, unknown>>;
  cleanup: () => Promise<void>;
}

/** The REAL officeServer entry (routes registered on a no-op router, the REAL loopback listener bound to an
 * ephemeral 127.0.0.1 port) over a tmp dataDir and a recording fake portal. The fake Docker literal answers
 * available()=false so lookAfter never tries to touch anything; settings default disabled keeps it quiet. */
async function boot(): Promise<Booted> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-it-"));
  const logs: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  // Docker answers only where the Document Server is reached: lookAfter finds Office off and makes nothing.
  const reach = { host: "127.0.0.1", port: 9 };
  const fakeDocker = { available: async () => true, networks: { reach: async () => reach, get: async () => undefined } } as Record<string, unknown>;
  container.forgetReach();
  const portalObj = {
    extension: "@pithagoras/office",
    dataDir: () => root,
    log: (l: unknown) => logs.push(String(l)),
    audit: { record: (e: Record<string, unknown>) => audits.push(e) },
    router: { get() {}, post() {}, put() {}, delete() {}, use() {} }, // UI routes are covered by server.test.mts; the listener is what this file drives
    http: { json: () => (_a?: unknown, _b?: unknown, next?: () => void) => next?.(), text: () => (_a?: unknown, _b?: unknown, next?: () => void) => next?.(), raw: () => () => {}, send: () => () => {}, upgrade: () => undefined },
    folders: { list: () => [] as never[], allowed: () => false, label: () => ({ name: "" }), on: () => {} },
    chats: { extend: () => {}, get: () => undefined, list: () => [], inFolder: () => [] as never[], folder: () => { throw new Error("no workspace folder"); }, send: () => {}, tell: async () => false, onEvent: () => {}, on: () => {} },
    files: { create: filesCreate },
    extensions: { use: () => fakeDocker },
  } as unknown as ServerPortal;
  const cleanup = await officeServer(portalObj);
  return { root, reach, logs, audits, cleanup };
}

function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections(); // drop undici keep-alives so close() actually finishes
  return new Promise((resolve) => server.close(() => resolve()));
}

/* ------------------------------------------------------------------ */
/* 1. ticketed GET > 1 MB                                              */
/* ------------------------------------------------------------------ */

test("ticketed GET on the real loopback listener serves a >1 MB document byte-for-byte and rejects an expired ticket", async () => {
  const b = await boot();
  try {
    const doc = await store.createDoc({ title: "Heavy Report", type: "word", folder: homeIn(b.root) }, b.root);

    // A REAL .docx over 1 MB, built through this extension's own writer (rewriteZip of the store template).
    // Most of the size is one incompressible run: deflate would otherwise shrink repetitive filler below the
    // cap and the test would stop proving what it claims. The document still opens/parses -- parseDocx below.
    const blob = randomBytes(1_300_000).toString("base64"); // 1.7 MB of text that survives deflate (random bytes -> base64)
    const filler = Array.from({ length: 200 }, (_, i) => `<w:p><w:r><w:t xml:space="preserve">filler line ${i + 1} of the heavy integration fixture</w:t></w:r></w:p>`).join("");
    const bigXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Heavy document</w:t></w:r></w:p>${filler}<w:p><w:r><w:t xml:space="preserve">${blob}</w:t></w:r></w:p></w:body></w:document>`;
    const big = rewriteZip(await store.templateDocx(), { "word/document.xml": bigXml });
    assert.ok(big.length > 1024 * 1024, `the built document is ${big.length} bytes (>1 MB)`);

    store.persistBytes(doc, big, b.root); // the meta we hold still matches -- straight through the gate
    const fresh = store.getDoc(doc.docId, b.root)!;
    assert.ok(fresh.sizeBytes > 1024 * 1024, `the index sizeBytes is ${fresh.sizeBytes} (>1 MB)`);

    const secret = ticketSecret(b.root);
    const { token } = mintTicket(ticketSubject(fresh.docId, fresh.mtimeMs), 600_000, secret);
    // node's fetch carries no cookie jar: this request -- like the DS's own GET -- crosses without a session cookie.
    const r = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.equal(r.headers.get("cache-control"), "no-store");
    const served = Buffer.from(await r.arrayBuffer());
    assert.ok(served.length > 1024 * 1024, `the wire payload is ${served.length} bytes -- past the portal-files 1 MB cap`);
    const onDisk = fs.readFileSync(fresh.path);
    assert.equal(Buffer.compare(served, onDisk), 0, "the served bytes are exactly the library bytes");
    // and it is a real Word document end to end, not just bytes:
    assert.ok(parseDocx(served).text.startsWith("Heavy document"), "the heavy doc still parses as docx");

    const { token: dead } = mintTicket(ticketSubject(fresh.docId, fresh.mtimeMs), -1_000, secret); // negative ttl -> already expired at mint time
    const r2 = await fetch(`http://127.0.0.1:${loopbackPort()}/doc/${dead}`);
    assert.equal(r2.status, 401);
    assert.deepEqual(await r2.json(), { error: "invalid or expired document ticket", code: "bad_ticket" });

    live.clearDoc(fresh.docId);
  } finally {
    await b.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 2. synthetic status-2 callback without a session cookie             */
/* ------------------------------------------------------------------ */

test("synthetic status-2 callback WITHOUT any session cookie: persist happened (bytes changed, index bumped) and the lock cleared", async () => {
  const b = await boot();
  try {
    // The listener's POST /callback was configured at boot to read this tmp root's ds.json + jwt-secret on
    // every request -- so writing the record here is what turns the endpoint from 503 into live.
    fs.writeFileSync(path.join(b.root, "ds.json"), JSON.stringify({ containerId: "it-cid", imageTag: "onlyoffice/documentserver:10.0.0.1" }));
    const doc = await store.createDoc({ title: "Round Trip", type: "word", folder: homeIn(b.root) }, b.root);

    // A stand-in for the DS download endpoint (body.url / changesurl): a second ephemeral loopback server
    // serving the "saved" bytes (our committed fixture docx -- different from the on-disk template) and a
    // fixed changes archive. This is exactly the URL pair a real DS callback would carry.
    const changesArchive = Buffer.concat([Buffer.from("PK\x03\x04"), randomBytes(1024)]);
    let hits: string[] = [];
    const dsStandin = http.createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/cache/files/saved?")) {
        hits.push("saved");
        res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        res.end(SAVED_DOCX);
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/cache/files/changes.zip?")) {
        hits.push("changes.zip");
        res.writeHead(200, { "Content-Type": "application/zip" });
        res.end(changesArchive);
        return;
      }
      res.writeHead(404);
      res.end("nope");
    });
    await new Promise<void>((resolve, reject) => { dsStandin.once("error", reject); dsStandin.listen(0, "127.0.0.1", () => resolve()); });
    const dsPort = (dsStandin.address() as AddressInfo).port;
    b.reach.port = dsPort;
    container.forgetReach();

    // The state a status-1 join would have left: one human present, the lock flag set.
    live.setUser(doc.docId, { id: "u-sam", name: "Sam" }, true);
    live.setLocked(doc.docId, true);
    const before = store.getDoc(doc.docId, b.root)!;

    // The DS envelope, signed with THIS tmp root's boot secret -- the same value server.ts created on disk.
    const secret = jwtSecret(b.root);
    const envelope = {
      key: makeKey(before.docId, before.mtimeMs), // the only key shape this package mints
      status: 2, // ready for saving: terminal close
      // At the browser's address of the Document Server, as it names them: fetched from the Document Server itself.
      url: "http://portal.example/api/x/%40pithagoras/office/ds/cache/files/saved?md5=a&expires=9",
      changesurl: "http://portal.example/api/x/%40pithagoras/office/ds/cache/files/changes.zip?md5=b&expires=9",
    };
    // As the Document Server signs it: the envelope under `payload`, its operation named, "Bearer " in front.
    const token = `Bearer ${signJwt({ payload: envelope, operation: "callback" }, 60_000, secret)}`;

    // POSTed to the loopback listener exactly as DS would (X-Auth-Token per the container env) -- node's fetch
    // sends no cookies, so structurally NOTHING like a session cookie crosses on this request.
    const r = await fetch(`http://127.0.0.1:${loopbackPort()}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-auth-token": token },
      body: JSON.stringify(envelope),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { error: 0 }, "DS reads the JSON error field; 0 is the only success");

    const after = store.getDoc(before.docId, b.root)!;
    const onDisk = fs.readFileSync(before.path);
    assert.equal(Buffer.compare(onDisk, SAVED_DOCX), 0, "the bytes the callback downloaded are now the library bytes");
    assert.ok(parseDocx(onDisk).comments.length === 2, "and they really ARE a docx -- our own parser reads it back");
    assert.notEqual(after.mtimeMs, before.mtimeMs, "the index revision (mtimeMs) bumped with the persist");
    assert.equal(after.sizeBytes, SAVED_DOCX.length);

    assert.deepEqual(hits, ["saved"], "the save was fetched from the Document Server; the changes archive, which nothing reads, was not");
    assert.deepEqual(live.usersOf(before.docId), [], "presence cleared by the status-2 terminal close");
    assert.equal(live.isLocked(before.docId), false, "the lock flag cleared AFTER the persist landed");

    await closeServer(dsStandin);
  } finally {
    live.resetLive();
    await b.cleanup();
  }
});
