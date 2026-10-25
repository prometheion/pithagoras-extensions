/**
 * An agent's write to a document open in the editor (src/editing.ts with src/tools.ts and src/callback.ts): office_edit
 * has the Document Server save the open session first, waits for that save's callback, makes its edit on top of it,
 * and the session's editor is told to load the new revision. Against a stand-in for the Document Server: its command
 * service (forcesave, with the JWT it takes) and its saved files, which calls back the real callback handler as the
 * Document Server does. Nothing reaches portal(): every seam is given.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { signJwt, verifyJwt } from "../src/jwt";
import { configure, handleCallback, keyStanding, makeKey, type CallbackState } from "../src/callback";
import { saveOpenSessions } from "../src/editing";
import { registerTools, __resetToolsForTests } from "../src/tools";
import { createDoc, getDoc, listDocs, refresh, templateDocx } from "../src/store";
import { editDocx, parseDocx, readPart, rewriteZip } from "../src/ooxml";
import * as live from "../src/live";

const SECRET = "editing-test-secret-0123456789abcdef";
const DS_STATE: CallbackState = { containerId: "cid-1", imageTag: "onlyoffice/documentserver:10.0.0.1" };
/** Where the browser reached the Document Server: it names its files at this address in its callbacks. */
const BROWSER = "http://portal.example/api/x/%40pithagoras/office/ds";
const HOME = "/f/atlas";

/* ------------------------------------------------------------------ */
/* the callback, as the Document Server sends it                       */
/* ------------------------------------------------------------------ */

/** One callback through the bare handler (the loopback listener's POST /callback), signed as the Document Server
 * signs it; resolves with its answer. */
async function callBack(envelope: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stream = Readable.from([Buffer.from("{}")]);
  Object.assign(stream, { method: "POST", url: "/callback", headers: { "x-auth-token": `Bearer ${signJwt({ payload: envelope, operation: "callback" }, 60_000, SECRET)}` } });
  let body = "";
  await new Promise<void>((resolve) => {
    const res = {
      headersSent: false,
      writeHead() {
        this.headersSent = true;
      },
      end(chunk?: string) {
        body += chunk ?? "";
        resolve();
      },
    };
    handleCallback(stream as unknown as IncomingMessage, res as unknown as ServerResponse);
  });
  return JSON.parse(body) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* the stand-in Document Server                                        */
/* ------------------------------------------------------------------ */

type Forcesave = { key: string; userdata: string };
/** What the stand-in does with a forcesave: the error it answers, and what it calls back with afterwards (status 6 with
 * the bytes it names, status 7, a close's status 2), if anything, and after how long. */
type Answer = { error: number; then?: { status: 2 | 6 | 7; bytes?: Buffer; afterMs?: number } };

async function standInDs(answer: (asked: Forcesave) => Answer) {
  const files = new Map<string, Buffer>();
  const asked: Forcesave[] = [];
  const callbacks: Promise<unknown>[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/cache/files/")) {
      const bytes = files.get(req.url.split("?")[0]);
      res.writeHead(bytes ? 200 : 404);
      res.end(bytes);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const token = String(req.headers["x-auth-token"] ?? "").replace(/^Bearer /, "");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.url !== "/command" || !verifyJwt(token, SECRET)) return void res.end(JSON.stringify({ error: 6 }));
      if (body.c !== "forcesave") return void res.end(JSON.stringify({ error: 5 }));
      asked.push({ key: body.key, userdata: body.userdata });
      const said = answer({ key: body.key, userdata: body.userdata });
      res.end(JSON.stringify({ error: said.error, key: body.key }));
      if (!said.then) return;
      const { status, bytes, afterMs = 20 } = said.then;
      const file = `/cache/files/data/${asked.length}/output.docx`;
      if (bytes) files.set(file, bytes);
      callbacks.push(new Promise((resolve) => setTimeout(resolve, afterMs)).then(() =>
        callBack({ key: body.key, status, ...(bytes ? { url: `${BROWSER}${file}?md5=x&expires=9` } : {}), ...(status === 2 ? {} : { forcesavetype: 0, userdata: body.userdata }) }),
      ));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    asked,
    /** Every callback the stand-in made, settled. */
    settled: () => Promise.all(callbacks),
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/* ------------------------------------------------------------------ */
/* one world per test                                                  */
/* ------------------------------------------------------------------ */

const roots: string[] = [];
const servers: { close(): Promise<void> }[] = [];
beforeEach(() => {
  live.resetLive();
  __resetToolsForTests();
});
after(async () => {
  for (const s of servers) await s.close();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** A library document of the agent's, open in the editor (a session the Document Server named in a status-1
 * callback), the stand-in Document Server behind the callback handler, and the agent's office_edit. */
async function world(answer: (asked: Forcesave) => Answer, timeoutMs?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-editing-"));
  roots.push(root);
  const ds = await standInDs(answer);
  servers.push(ds);
  configure({ getState: () => DS_STATE, getSecret: () => SECRET, getOrigin: async () => ds.origin, root, retryDelaysMs: [], log: () => {} });
  const doc = await createDoc({ title: "Open", type: "word", owner: HOME }, root);
  // An older revision than now, so that any write is a new one.
  const file = path.join(root, "docs", doc.docId, "Open.docx");
  fs.utimesSync(file, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
  const opened = refresh(doc.docId, root)!;
  const key = makeKey(doc.docId, opened.mtimeMs);
  assert.deepEqual(await callBack({ key, status: 1, users: ["portal-user"] }), { error: 0 });
  let factory!: (pi: unknown, chat: { id: string }) => void;
  registerTools({
    extend: (f) => (factory = f),
    chatFolder: () => HOME,
    folders: () => [{ path: HOME, name: "Atlas", kind: "agent" }],
    root,
    record: () => {},
    log: () => {},
    ...(timeoutMs !== undefined ? { saveSessions: (d, keys) => saveOpenSessions(d.docId, d.title, keys, { timeoutMs }) } : {}),
  });
  const tools: Record<string, { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }> }> = {};
  factory({ registerTool: (t: { name: string }) => (tools[t.name] = t as never), events: { on: () => () => {} } }, { id: "chat-atlas" });
  const text = () => parseDocx(fs.readFileSync(path.join(root, "docs", doc.docId, "Open.docx"))).text;
  return { root, ds, doc, key, base: opened.mtimeMs, edit: tools.office_edit, text };
}

/** The document as the person's session holds it: the blank template with `typed` in place of its text. */
async function typed(words: string): Promise<Buffer> {
  const blank = await templateDocx();
  return rewriteZip(blank, { "word/document.xml": editDocx(readPart(blank, "word/document.xml")!, [{ quote: "New document", replacement: words }]) });
}

/* ------------------------------------------------------------------ */
/* the tests                                                           */
/* ------------------------------------------------------------------ */

test("office_edit on a document open in the editor: what is typed is saved first, the edit is made on top of it, and the editor follows to the new revision", async () => {
  const person = await typed("Typed by the person");
  const w = await world(() => ({ error: 0, then: { status: 6, bytes: person } }));
  const done = await w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "the person", replacement: "the person and the agent" }], baseRevision: w.base });
  assert.match(done.content[0].text, /open in the editor/, done.content[0].text);
  assert.equal(w.text(), "Typed by the person and the agent", "the edit is on top of what the person typed");
  assert.deepEqual(w.ds.asked.map((a) => a.key), [w.key], "the open session was asked to save");
  assert.match(w.ds.asked[0].userdata, /^office-/);
  const now = getDoc(w.doc.docId, w.root)!.mtimeMs;
  assert.equal(keyStanding(w.key, now), "follow", "the editor loads the agent's revision");
  assert.equal(listDocs(w.root).length, 1, "no conflict copy");

  // The editor loaded the new revision; the old session closes and sends everything it held once more: nothing new.
  assert.deepEqual(await w.ds.settled().then(() => callBackClose(w, person)), { error: 0 });
  assert.equal(w.text(), "Typed by the person and the agent", "the old session's close does not write over the agent's edit");
  assert.equal(listDocs(w.root).length, 1, "and is no conflict either");
  assert.equal(getDoc(w.doc.docId, w.root)!.mtimeMs, now);
});

/** The close of `w`'s first session (status 2), with `bytes`. */
async function callBackClose(w: Awaited<ReturnType<typeof world>>, bytes: Buffer): Promise<Record<string, unknown>> {
  const url = "/cache/files/data/close/output.docx";
  const server = http.createServer((_req, res) => res.end(bytes));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  configure({ getState: () => DS_STATE, getSecret: () => SECRET, getOrigin: async () => `http://127.0.0.1:${(server.address() as { port: number }).port}`, root: w.root, retryDelaysMs: [], log: () => {} });
  try {
    return await callBack({ key: w.key, status: 2, url: `${BROWSER}${url}?md5=x` });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("what was typed in the old session after its save, before the editor loaded the agent's revision, is kept as a copy, not written over the agent's edit", async () => {
  const person = await typed("Typed by the person");
  const w = await world(() => ({ error: 0, then: { status: 6, bytes: person } }));
  await w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "the person", replacement: "the person and the agent" }], baseRevision: w.base });
  await w.ds.settled();
  assert.deepEqual(await callBackClose(w, await typed("Typed by the person, and a little more")), { error: 0 });
  assert.equal(w.text(), "Typed by the person and the agent", "the agent's revision stays");
  const copy = listDocs(w.root).find((d) => d.title.startsWith("Open (conflict"));
  assert.ok(copy, "the late typing is kept beside it");
  assert.equal(parseDocx(fs.readFileSync(path.join(w.root, "docs", copy.docId, `${copy.title}.docx`))).text, "Typed by the person, and a little more");
});

test("office_edit on an open document: where the editor does not save in time, the edit is refused and nothing is written; the late save still lands", async () => {
  const person = await typed("Typed by the person");
  const w = await world(() => ({ error: 0, then: { status: 6, bytes: person, afterMs: 400 } }), 100);
  await assert.rejects(
    w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "New document", replacement: "Agent" }], baseRevision: w.base }),
    (e: Error) => /^error:editor_not_saved /.test(e.message) && / within 0.1 s, /.test(e.message),
  );
  assert.equal(w.text(), "New document", "nothing written by the agent");
  await w.ds.settled();
  assert.equal(w.text(), "Typed by the person", "the editor's save came late, and landed");
  assert.equal(keyStanding(w.key, getDoc(w.doc.docId, w.root)!.mtimeMs), "current", "the editor goes on with what it saved: no reload");
  assert.equal(listDocs(w.root).length, 1);
});

test("office_edit on an open document: nothing typed since its last save (the command answers 4), the edit goes straight on", async () => {
  const w = await world(() => ({ error: 4 }));
  await w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "New document", replacement: "Agent" }], baseRevision: w.base });
  assert.equal(w.text(), "Agent");
  assert.equal(w.ds.asked.length, 1);
  assert.equal(keyStanding(w.key, getDoc(w.doc.docId, w.root)!.mtimeMs), "follow");
});

test("office_edit on an open document: a forcesave the Document Server reports failed (status 7) refuses the edit, nothing written", async () => {
  const w = await world(() => ({ error: 0, then: { status: 7 } }));
  await assert.rejects(
    w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "New document", replacement: "Agent" }], baseRevision: w.base }),
    (e: Error) => /^error:editor_not_saved /.test(e.message),
  );
  assert.equal(w.text(), "New document");
});

test("office_edit on a document whose editor just closed (the command knows no session): waits for the close's save, and edits on top of it", async () => {
  const person = await typed("Typed before closing");
  const w = await world(() => ({ error: 1, then: { status: 2, bytes: person, afterMs: 300 } }));
  await w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "before closing", replacement: "before closing, then edited" }], baseRevision: w.base });
  assert.equal(w.text(), "Typed before closing, then edited");
  assert.deepEqual(live.sessionKeys(w.doc.docId), [], "the closed session is gone");
  assert.equal(listDocs(w.root).length, 1, "no conflict copy");
});
