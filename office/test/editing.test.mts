/**
 * An agent's write to a document open in the editor (src/editing.ts with src/tools.ts and src/callback.ts): office_edit
 * has the Document Server save the open session first, waits for that save's callback, makes its edit on top of it,
 * and the session's editor is told to load the new revision. Against a stand-in for the Document Server: its command
 * service (forcesave, with the JWT it takes) and its saved files, which calls back the real callback handler as the
 * Document Server does. Nothing reaches portal(): every seam is given.
 */
import { after, beforeEach, mock, test } from "node:test";
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

test("office_edit on an open document: a forcesave the Document Server reports failed (status 7) refuses the edit at once, nothing written", async () => {
  const w = await world(() => ({ error: 0, then: { status: 7 } }), 5000);
  const started = Date.now();
  await assert.rejects(
    w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "New document", replacement: "Agent" }], baseRevision: w.base }),
    (e: Error) => /^error:editor_not_saved .*could not save what is typed there/.test(e.message),
  );
  assert.ok(Date.now() - started < 2000, "refused when the Document Server said so, not after the wait");
  assert.equal(w.text(), "New document");
});

test("office_edit on an open document: a forcesave whose save cannot be downloaded (its persist fails) refuses the edit, nothing written", async () => {
  const person = await typed("Typed by the person");
  const w = await world(() => ({ error: 0, then: { status: 6, bytes: person, gone: true } }), 5000);
  await assert.rejects(
    w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "New document", replacement: "Agent" }], baseRevision: w.base }),
    (e: Error) => /^error:editor_not_saved .*could not save what is typed there/.test(e.message),
  );
  await w.ds.settled();
  assert.equal(w.text(), "New document", "nothing written");
  assert.equal(listDocs(w.root).length, 1);
});

test("office_edit on an open document whose earlier save is still under way (its wait timed out): the retry waits for it, though the command answers 4, and edits on top of it", async () => {
  const person = await typed("Typed by the person");
  // The first forcesave takes longer than the wait; while it is under way, the Document Server answers 4.
  const w = await world(() => (w.ds.asked.length === 1 ? { error: 0, then: { status: 6, bytes: person, afterMs: 600 } } : { error: 4 }), 450);
  await assert.rejects(
    w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "the person", replacement: "the person and the agent" }], baseRevision: w.base }),
    (e: Error) => /^error:editor_not_saved /.test(e.message),
  );
  // The agent tries again at once, as it is told to, on the revision it read.
  const done = await w.edit.execute("e2", { id: w.doc.docId, ops: [{ quote: "the person", replacement: "the person and the agent" }], baseRevision: w.base });
  assert.match(done.content[0].text, /open in the editor/);
  assert.equal(w.text(), "Typed by the person and the agent", "the edit is on top of the late save");
  assert.equal(listDocs(w.root).length, 1, "and the late save is no conflict copy");
  assert.equal(keyStanding(w.key, getDoc(w.doc.docId, w.root)!.mtimeMs), "follow");
});

test("office_edit on an open document whose editor is closing (the command answers 3 until the close's save comes): waits for that save, and edits on top of it", async () => {
  const person = await typed("Typed before closing");
  const w = await world(() => ({ error: 3, then: { status: 2, bytes: person, afterMs: 300 } }), 5000);
  await w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "before closing", replacement: "before closing, then edited" }], baseRevision: w.base });
  assert.equal(w.text(), "Typed before closing, then edited");
  assert.deepEqual(live.sessionKeys(w.doc.docId), [], "the closed session is gone");
  assert.equal(listDocs(w.root).length, 1, "no conflict copy");
});

test("office_edit on an open document whose editor is closing (the command answers 0 and calls back only with the close): the close's save is the one waited for", async () => {
  const person = await typed("Typed before closing");
  const w = await world(() => ({ error: 0, then: { status: 2, bytes: person, afterMs: 300 } }), 3000);
  const started = Date.now();
  await w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "before closing", replacement: "before closing, then edited" }], baseRevision: w.base });
  assert.ok(Date.now() - started < 2000, "not after the whole wait");
  assert.equal(w.text(), "Typed before closing, then edited");
  assert.equal(listDocs(w.root).length, 1, "no conflict copy");
});

test("office_edit on a document whose editor closed and whose close could not be handed over (the Document Server keeps it as forgotten): it is taken back first, and the edit made on top of it", async () => {
  const person = await typed("Typed before closing");
  const w = await world(() => ({ error: 1 }), 300);
  w.ds.forgotten.set(w.key, person);
  await w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "before closing", replacement: "before closing, then edited" }], baseRevision: w.base });
  assert.equal(w.text(), "Typed before closing, then edited");
  assert.deepEqual(w.ds.commands, ["getForgottenList", `getForgotten ${w.key}`, `deleteForgotten ${w.key}`], "taken back and let go");
  assert.deepEqual(live.sessionKeys(w.doc.docId), [], "the session is over");
  assert.equal(listDocs(w.root).length, 1, "no conflict copy");
});

test("a second office_edit right after the first: the session that follows the agent's revision is not asked to save again (it is closing, and answers late)", async () => {
  const person = await typed("Typed by the person");
  // After the editor loaded the agent's revision, its old session closes: the Document Server answers 3 for it.
  const w = await world(() => (w.ds.asked.length === 1 ? { error: 0, then: { status: 6, bytes: person } } : { error: 3 }), 3000);
  const first = await w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "the person", replacement: "the person and the agent" }], baseRevision: w.base });
  await w.ds.settled();
  const now = getDoc(w.doc.docId, w.root)!.mtimeMs;
  assert.match(first.content[0].text, new RegExp(`revision ${now}`));
  await w.edit.execute("e2", { id: w.doc.docId, ops: [{ quote: "the agent", replacement: "the agent, twice" }], baseRevision: now });
  assert.equal(w.text(), "Typed by the person and the agent, twice");
  assert.equal(w.ds.asked.length, 1, "asked to save only once");
  assert.equal(keyStanding(w.key, getDoc(w.doc.docId, w.root)!.mtimeMs), "follow", "and the editor still loads the newest revision");
});

test("office_edit on a document open in an editor that is behind (the file changed outside it): its typing is kept as a copy, and neither the agent nor the editor is told it is in the edit", async () => {
  const person = await typed("Typed by the person");
  const w = await world(() => ({ error: 0, then: { status: 6, bytes: person } }));
  // A script writes the file while the editor is open; the agent reads that revision.
  const file = path.join(w.root, "docs", w.doc.docId, "Open.docx");
  fs.writeFileSync(file, await typed("A script's version"));
  const read = refresh(w.doc.docId, w.root)!;
  const done = await w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "A script's version", replacement: "A script's version, edited by the agent" }], baseRevision: read.mtimeMs });
  assert.equal(w.text(), "A script's version, edited by the agent");
  assert.doesNotMatch(done.content[0].text, /saved first/, done.content[0].text);
  assert.match(done.content[0].text, /older revision.*conflict/, done.content[0].text);
  assert.equal(keyStanding(w.key, getDoc(w.doc.docId, w.root)!.mtimeMs), "behind", "the editor says it is behind, and does not load the agent's revision as if it held its typing");
  const copy = listDocs(w.root).find((d) => d.title.startsWith("Open (conflict"));
  assert.ok(copy, "the typing is kept beside it");
  assert.equal(parseDocx(fs.readFileSync(path.join(w.root, "docs", copy.docId, `${copy.title}.docx`))).text, "Typed by the person");
});

test("the agent's write right after the editor's save gets a revision of its own, also where the filesystem keeps times by two seconds: the editor follows, and its next save does not write over the edit", async () => {
  // Every time the store reads, as a filesystem that keeps them by two seconds (FAT) has them.
  for (const name of ["lstatSync", "statSync", "fstatSync"] as const) {
    const real = fs[name] as (...args: unknown[]) => fs.Stats;
    mock.method(fs, name, (...args: unknown[]) => {
      const st = real(...args);
      if (st) st.mtimeMs = Math.floor(st.mtimeMs / 2000) * 2000;
      return st;
    });
  }
  try {
    const person = await typed("Typed by the person");
    const w = await world(() => ({ error: 0, then: { status: 6, bytes: person } }));
    // At the start of a two-second step, so that the editor's save and the agent's edit fall in it.
    while (Date.now() % 2000 > 1000) await new Promise((resolve) => setTimeout(resolve, 50));
    await w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "the person", replacement: "the person and the agent" }], baseRevision: w.base });
    assert.equal(w.text(), "Typed by the person and the agent");
    assert.equal(keyStanding(w.key, getDoc(w.doc.docId, w.root)!.mtimeMs), "follow", "the editor loads the agent's revision");
    await w.ds.settled();
    assert.deepEqual(await callBackClose(w, await typed("Typed by the person, and more")), { error: 0 });
    assert.equal(w.text(), "Typed by the person and the agent", "the old session's close is not written over the agent's edit");
    assert.equal(listDocs(w.root).filter((d) => d.title.startsWith("Open (conflict")).length, 1, "it is kept as a copy");
  } finally {
    mock.restoreAll();
  }
});

test("a save of the editor whose only change is in the document's properties (its title) is written, not dropped as nothing new", async () => {
  const person = await typed("Typed by the person");
  const w = await world(() => ({ error: 0, then: { status: 6, bytes: person } }));
  // The agent's edit does not go through, but the editor's save it asked for did.
  await assert.rejects(w.edit.execute("e1", { id: w.doc.docId, ops: [{ quote: "not there", replacement: "x" }], baseRevision: w.base }), /quote_not_found/);
  await w.ds.settled();
  assert.equal(w.text(), "Typed by the person");
  // The person then sets the title in File, Document info, and closes.
  const titled = rewriteZip(person, { "docProps/core.xml": '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>A title</dc:title></cp:coreProperties>' });
  assert.deepEqual(await callBackClose(w, titled), { error: 0 });
  assert.match(String(readPart(fs.readFileSync(path.join(w.root, "docs", w.doc.docId, "Open.docx")), "docProps/core.xml")), /A title/);
});
