/**
 * The save after an agent's edit (src/editing.ts saveNow, with src/callback.ts): the Document Server is asked to save
 * the agent's editing session (its command service's forcesave), and the tool waits for that save's callback, which
 * the callback handler persists through the revision gate. Against a stand-in for the Document Server: its command
 * service (forcesave, with the JWT it takes) and its saved files, which calls back the real callback handler as the
 * Document Server does. Nothing reaches portal().
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
import { saveNow } from "../src/editing";
import { createDoc, getDoc, listDocs, refresh, templateDocx } from "../src/store";
import { homeIn } from "./homes.mts";
import { parseDocx, readPart, rewriteZip } from "../src/ooxml";
import * as live from "../src/live";

const SECRET = "editing-test-secret-0123456789abcdef";
const DS_STATE: CallbackState = { containerId: "cid-1", imageTag: "onlyoffice/documentserver:10.0.0.1" };
/** Where the browser reached the Document Server: it names its files at this address in its callbacks. */
const BROWSER = "http://portal.example/api/x/%40pithagoras/office/ds";

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
 * the bytes it names, status 7, a close's status 2), if anything, and after how long. `gone`: the file it names is not
 * there to download. */
type Answer = { error: number; then?: { status: 2 | 6 | 7; bytes?: Buffer; afterMs?: number; gone?: boolean } };

/** As the real Document Server answers (10.0.0.1, measured): 0 for a forcesave it starts, and calls back with status 6;
 * 4 with nothing typed since its last save, and while a forcesave it started is under way; while an editor closes, 3
 * and then 0, without calling back, until the close's status 2 comes; 1 only for a key it does not know, or whose
 * close it keeps as forgotten (the callback failed), which it never sends again. */
async function standInDs(answer: (asked: Forcesave) => Answer) {
  const files = new Map<string, Buffer>();
  const asked: Forcesave[] = [];
  const callbacks: Promise<unknown>[] = [];
  /** The saves it keeps as forgotten, by key, and the other commands it was given. */
  const forgotten = new Map<string, Buffer>();
  const commands: string[] = [];
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
      if (body.c !== "forcesave") commands.push(`${body.c}${body.key ? ` ${body.key}` : ""}`);
      if (body.c === "getForgottenList") return void res.end(JSON.stringify({ error: 0, keys: [...forgotten.keys()] }));
      if (body.c === "getForgotten") {
        const bytes = forgotten.get(body.key);
        if (!bytes) return void res.end(JSON.stringify({ error: 1 }));
        files.set(`/cache/files/forgotten/${body.key}/output.docx`, bytes);
        return void res.end(JSON.stringify({ error: 0, key: body.key, url: `${BROWSER}/cache/files/forgotten/${body.key}/output.docx?md5=f` }));
      }
      if (body.c === "deleteForgotten") return void res.end(JSON.stringify({ error: forgotten.delete(body.key) ? 0 : 1 }));
      if (body.c !== "forcesave") return void res.end(JSON.stringify({ error: 5 }));
      asked.push({ key: body.key, userdata: body.userdata });
      const said = answer({ key: body.key, userdata: body.userdata });
      res.end(JSON.stringify({ error: said.error, key: body.key }));
      if (!said.then) return;
      const { status, bytes, afterMs = 20, gone } = said.then;
      const file = `/cache/files/data/${asked.length}/output.docx`;
      if (bytes && !gone) files.set(file, bytes);
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
    forgotten,
    commands,
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
beforeEach(() => live.resetLive());
after(async () => {
  for (const s of servers) await s.close();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** A library document an agent's editor has open (a session the Document Server named in a status-1 callback), and
 * the stand-in Document Server behind the callback handler. */
async function world(answer: (asked: Forcesave) => Answer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-editing-"));
  roots.push(root);
  const ds = await standInDs(answer);
  servers.push(ds);
  configure({ getState: () => DS_STATE, getSecret: () => SECRET, getOrigin: async () => ds.origin, root, retryDelaysMs: [], log: () => {} });
  const doc = await createDoc({ title: "Open", type: "word", folder: homeIn(root, "atlas") }, root);
  // An older revision than now, so that any write is a new one.
  const file = doc.path;
  fs.utimesSync(file, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
  const opened = refresh(doc.docId, root)!;
  const key = makeKey(doc.docId, opened.mtimeMs);
  assert.deepEqual(await callBack({ key, status: 1, users: ["agent:abc", "portal-user"] }), { error: 0 });
  const text = () => parseDocx(fs.readFileSync(file)).text;
  return { root, ds, doc, key, file, base: opened.mtimeMs, text };
}

/** The document as the session holds it: the blank template with `words` in place of its text. */
async function holding(words: string): Promise<Buffer> {
  const blank = await templateDocx();
  return rewriteZip(blank, { "word/document.xml": String(readPart(blank, "word/document.xml")).replace("New document", words) });
}

/* ------------------------------------------------------------------ */
/* the tests                                                           */
/* ------------------------------------------------------------------ */

test("saved: the session is asked to save, its callback is written as the new revision, and the session stays on it", async () => {
  const session = await holding("Edited by the agent, typed by the person");
  const w = await world(() => ({ error: 0, then: { status: 6, bytes: session } }));
  assert.equal(await saveNow(w.key), "saved");
  assert.deepEqual(w.ds.asked.map((a) => a.key), [w.key]);
  assert.match(w.ds.asked[0].userdata, /^office-[0-9a-f-]{36}$/);
  assert.equal(w.text(), "Edited by the agent, typed by the person");
  const now = getDoc(w.doc.docId, w.root)!.mtimeMs;
  assert.ok(now > w.base, "a new revision");
  assert.equal(keyStanding(w.key, now), "current", "the session's next save lands on top of its own");
});

test("the edit not sent yet: the Document Server answers 4 at first, and is asked again until it saves", async () => {
  const session = await holding("Edited");
  let n = 0;
  const w = await world(() => (++n < 3 ? { error: 4 } : { error: 0, then: { status: 6, bytes: session } }));
  assert.equal(await saveNow(w.key), "saved");
  assert.equal(w.ds.asked.length, 3);
  assert.equal(w.text(), "Edited");
});

test("nothing to save at all: 4 for a few seconds, then \"nothing\", and nothing written", async () => {
  const w = await world(() => ({ error: 4 }));
  const started = Date.now();
  assert.equal(await saveNow(w.key), "nothing");
  assert.ok(Date.now() - started >= 2_900, "asked again for about three seconds");
  assert.equal(getDoc(w.doc.docId, w.root)!.mtimeMs, w.base);
});

test("failed: a forcesave the Document Server reports failed (status 7), one whose file cannot be downloaded, a refusal, or no Document Server", async () => {
  const seven = await world(() => ({ error: 0, then: { status: 7 } }));
  assert.equal(await saveNow(seven.key), "failed");
  const bytes = await holding("x");
  const gone = await world(() => ({ error: 0, then: { status: 6, bytes, gone: true } }));
  assert.equal(await saveNow(gone.key), "failed");
  assert.equal(gone.text(), "New document", "nothing written");
  const refused = await world(() => ({ error: 1 }));
  assert.equal(await saveNow(refused.key), "failed");
  assert.equal(await saveNow(refused.key, { command: async () => Promise.reject(new Error("connection refused")) }), "failed");
});

test("timeout: no callback in time; the save still lands when it comes", async () => {
  const session = await holding("Late but saved");
  const w = await world(() => ({ error: 0, then: { status: 6, bytes: session, afterMs: 300 } }));
  assert.equal(await saveNow(w.key, { timeoutMs: 50 }), "timeout");
  assert.equal(w.text(), "New document");
  await w.ds.settled();
  assert.equal(w.text(), "Late but saved", "the late callback is persisted as any other");
});

test("copy: the file changed outside the editor since its session opened: the save is kept beside it, the file is not written over", async () => {
  const session = await holding("The agent's edit");
  const w = await world(() => ({ error: 0, then: { status: 6, bytes: session } }));
  // A script writes the file: a revision the session never had.
  fs.writeFileSync(w.file, await holding("Written by a script"));
  fs.utimesSync(w.file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(await saveNow(w.key), "copy");
  assert.equal(w.text(), "Written by a script");
  assert.equal(listDocs(w.root).filter((d) => d.title.startsWith("Open (conflict")).length, 1);
});

test("same: a save holding exactly what the session saved last is nothing new; one whose only change is the document's properties is written", async () => {
  const session = await holding("Saved once");
  let bytes = session;
  const w = await world(() => ({ error: 0, then: { status: 6, bytes } }));
  assert.equal(await saveNow(w.key), "saved");
  const first = getDoc(w.doc.docId, w.root)!.mtimeMs;
  assert.equal(await saveNow(w.key), "same");
  assert.equal(getDoc(w.doc.docId, w.root)!.mtimeMs, first);
  // The person sets the title in File, Document info: the content digest leaves it out, the bytes do not.
  bytes = rewriteZip(session, { "docProps/core.xml": '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>A title</dc:title></cp:coreProperties>' });
  assert.equal(await saveNow(w.key), "saved");
  assert.match(String(readPart(fs.readFileSync(w.file), "docProps/core.xml")), /A title/);
});
