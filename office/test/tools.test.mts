/**
 * Unit tests for src/tools.ts (the agent's office_* tools). Run from office/:
 *   node --import tsx --test test/tools.test.mts
 * Self-contained: tmp dataDir per test, real docx/xlsx via store.createDoc (real templates), comment
 * XML injected with ooxml.rewriteZip, every portal bit (extend registrar, chat->folder, folders list,
 * the file reader, root, record, log) injected through registerTools -- the tests NEVER reach portal().
 * The co-editor model is under test here too: a live human session neither blocks nor helps office_edit;
 * only the revision gate decides (fail loud, re-read + retry).
 *
 * Refusals are THROWN by the tool's execute (docs convention: "a refusal is an error the agent
 * reads"), so error cases assert on the rejection MESSAGE, which must start with "error:<code> ".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { registerTools, __resetToolsForTests } from "../src/tools";
import { createDoc, getDoc } from "../src/store";
import { parseDocx, rewriteZip } from "../src/ooxml";
import { setUser, resetLive } from "../src/live";

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

type FolderLite = { path: string; name: string; kind: "agent" | "project" | "chat"; home?: boolean };
const FOLDERS: FolderLite[] = [
  { path: "/f/atlas", name: "Atlas", kind: "agent" },
  { path: "/f/acme", name: "Acme", kind: "project" },
  { path: "/f/notes", name: "Notes", kind: "chat" }, // wrong kind: never gets tools
];
const CHAT_TO_FOLDER: Record<string, string> = {
  "chat-atlas-home": "/f/atlas",
  "aaa-acme-a": "/f/acme",
  "zzz-acme-b": "/f/acme",
  "chat-notes": "/f/notes",
};

type ToolResult = { content: { type: string; text: string }[]; details?: any };
type PiFake = { registered: Record<string, any>[]; sent: unknown[][]; uiHandlers: ((m: any) => void)[]; find: (name: string) => any } & Record<string, any>;

function makePi(): PiFake {
  const registered: Record<string, any>[] = [];
  const sent: unknown[][] = [];
  const uiHandlers: ((m: any) => void)[] = [];
  return Object.assign(({} as any), {
    registered,
    sent,
    uiHandlers,
    find: (name: string) => registered.find((t) => t.name === name),
    registerTool: (def: Record<string, any>) => {
      registered.push(def);
    },
    sendMessage: (msg: unknown, opts: unknown) => {
      sent.push([msg, opts]);
    },
    events: {
      on: (_name: string, fn: (m: any) => void) => {
        uiHandlers.push(fn);
        return () => {};
      },
    },
  });
}

type Seen = { records: { subject: string; reason: string; chatId: string }[]; logs: string[] };

/** One isolated world: tmp root, a captured extend factory, a fake pi for `chatId`, seams wired so no default touches portal(). */
function setup(chatId = "chat-atlas-home"): { root: string; seen: Seen; pi: PiFake; folderPath: string } {
  __resetToolsForTests();
  resetLive();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-tools-"));
  const seen: Seen = { records: [], logs: [] };
  const pi = makePi();
  let factory!: (pi: unknown, chat: { id: string }) => void;
  registerTools({
    extend: (f) => {
      factory = f;
    },
    chatFolder: (id) => {
      const p = CHAT_TO_FOLDER[id];
      if (!p) throw new Error(`no workspace for ${id}`);
      return p;
    },
    folders: () => FOLDERS,
    root,
    record: (e) => seen.records.push(e),
    log: (l) => seen.logs.push(l),
  });
  // The factory body runs PER CALL so each test step sees exactly one registration pass for its chat.
  (setup as any).__run = () => factory(pi, { id: chatId });
  return { root, seen, pi, folderPath: CHAT_TO_FOLDER[chatId] };
}

/** Run the captured factory on the fake pi and hand back the registered tool by name. */
function tool(s: ReturnType<typeof setup>, name: string): any {
  (setup as any).__run();
  const t = s.pi.find(name);
  if (!t) throw new Error(`tool ${name} not registered`);
  s.pi.registered.length = 0; // registrations must not stack across calls on the same pi
  return t;
}

/** Await an execute that MUST refuse, and return the refusal message (docs convention: it is thrown, and starts with "error:<code> "). */
async function refused(p: Promise<unknown>, what = ""): Promise<string> {
  try {
    const v = await p;
    throw new Error(`expected a refusal (${what}) but the tool succeeded: ${JSON.stringify((v as ToolResult)?.content ?? v)}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("expected a refusal")) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (!/^error:[a-z_]+ /.test(msg)) throw new Error(`bad refusal format (${what}): ${msg}`);
    return msg;
  }
}

const readDocBytes = (root: string, docId: string): Buffer => {
  const doc = getDoc(docId, root)!;
  return fs.readFileSync(path.join(root, "docs", docId, `${doc.title}.${doc.ext}`));
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function commentsXml(cs: { id: string; author: string; text: string }[]): string {
  return (
    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    cs.map((c) => `<w:comment id="${c.id}" author="${esc(c.author)}" date="2026-01-02T03:04:05Z"><w:p><w:r><w:t xml:space="preserve">${esc(c.text)}</w:t></w:r></w:p></w:comment>`).join("") +
    "</w:comments>"
  );
}

function addGrant(root: string, docId: string, folder: string, commentId: string): void {
  const p = path.join(root, "index.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  raw.docs.find((d: any) => d.docId === docId).grants.push({ folder, commentId, at: Date.now() });
  fs.writeFileSync(p, JSON.stringify(raw, null, 2));
}

/** Simulate an EXTERNAL save -- a co-editor's save landing on disk through the DS callback persist path -- by moving the file mtime AND the index entry together (so every gate sees one consistent fresh revision).
 * NOTE: this guest filesystem reports utimes'd timestamps ~1 µs BELOW the requested value, so the index is set to
 * what stat ACTUALLY reads back -- the zero-tolerance gate compares live-stat vs index and would otherwise refuse. */
function bumpRevision(root: string, docId: string, toMs: number): void {
  const doc = getDoc(docId, root)!;
  const file = path.join(root, "docs", docId, `${doc.title}.${doc.ext}`);
  fs.utimesSync(file, new Date(toMs), new Date(toMs));
  const actual = fs.statSync(file).mtimeMs; // the value every later stat (and persistBytes) will see
  const p = path.join(root, "index.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  raw.docs.find((d: any) => d.docId === docId).mtimeMs = actual;
  fs.writeFileSync(p, JSON.stringify(raw, null, 2));
}

/* ------------------------------------------------------------------ */
/* registration + scope                                                */
/* ------------------------------------------------------------------ */

test("registers office_* only in agent and project home chats", () => {
  const s = setup("chat-atlas-home");
  (setup as any).__run();
  assert.deepEqual(
    s.pi.registered.map((t) => t.name).sort(),
    ["office_comments", "office_create", "office_edit", "office_list", "office_read"],
  );

  // wrong kind (a plain chat folder): the factory RETURNS, nothing registered
  const notes = makePi();
  registerTools({
    extend: (f) => f(notes, { id: "chat-notes" }),
    chatFolder: (id) => CHAT_TO_FOLDER[id],
    folders: () => FOLDERS,
    root: s.root,
    log: (l) => s.seen.logs.push(l),
  });
  assert.equal(notes.registered.length, 0);

  // a chat whose folder is gone: no tools, one log line, no throw
  const ghost = makePi();
  registerTools({
    extend: (f) => f(ghost, { id: "chat-gone" }),
    chatFolder: () => {
      throw new Error("folder gone");
    },
    folders: () => FOLDERS,
    root: s.root,
    log: (l) => s.seen.logs.push(l),
  });
  assert.equal(ghost.registered.length, 0);
  assert.ok(s.seen.logs.some((l) => l.includes("no workspace folder for chat chat-gone")));
});

test("a document is owned by the project's folder, whichever of its sessions made it", async () => {
  const s = setup("zzz-acme-b"); // a NON-lowest session of the Acme project
  const made = await tool(s, "office_create").execute("c", { title: "Acme Note", type: "word" });
  assert.equal(getDoc(made.details.id, s.root)!.owner, "/f/acme");
  // and so every session of the folder sees it, the lowest one too
  const other = setup("aaa-acme-a");
  fs.cpSync(s.root, other.root, { recursive: true });
  const listed = (await tool(other, "office_list").execute("c", {})) as ToolResult;
  assert.match(listed.content[0].text, /"Acme Note".*owner you/);
});

test("scope: owned and granted docs visible; another home's doc invisible to list AND read", async () => {
  const s = setup();
  const home = "/f/atlas";
  await createDoc({ title: "Mine", type: "word", owner: home }, s.root);
  const theirs = await createDoc({ title: "Theirs Secret Doc", type: "word", owner: "/f/acme" }, s.root); // no grant to us
  const granted = await createDoc({ title: "Shared One", type: "cell", owner: "/f/acme" }, s.root);
  addGrant(s.root, granted.docId, home, "c-grant");

  (setup as any).__run();
  const listText = (await tool(s, "office_list").execute("c", {})) as ToolResult;
  assert.ok(listText.content[0].text.includes('"Mine"'));
  assert.ok(listText.content[0].text.includes('"Shared One"'));
  assert.ok(!listText.content[0].text.includes("Theirs Secret Doc"), "another home's doc must not appear in office_list");

  // office_read of the out-of-scope id refuses with the SAME words as a nonexistent id (docs convention: no leak)
  const missing = await refused(tool(s, "office_read").execute("c", { id: "no-such-id" }), "missing id");
  const foreign = await refused(tool(s, "office_read").execute("c", { id: theirs.docId }), "out-of-scope id");
  assert.equal(foreign, missing);
  assert.match(foreign, /^error:not_found /);

  // the granted doc IS readable (xlsx grid path)
  const shared = (await tool(s, "office_read").execute("c", { id: granted.docId })) as ToolResult;
  assert.ok(shared.content[0].text.includes('"Shared One"'));
});

test("scanned documents: the ones in the agent's own folder are read and edited from their own file, through the portal as the agent; another agent's are not there", async () => {
  __resetToolsForTests();
  resetLive();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-tools-"));
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-ws-")));
  const [mine, theirs] = [path.join(ws, "atlas"), path.join(ws, "bolt")];
  fs.mkdirSync(path.join(mine, "notes"), { recursive: true });
  fs.mkdirSync(theirs);
  const template = await (await import("../src/store")).templateDocx();
  fs.writeFileSync(path.join(mine, "notes", "report.docx"), template);
  fs.writeFileSync(path.join(theirs, "salary.docx"), template);
  const { scanWorkspace } = await import("../src/store");
  scanWorkspace([mine, theirs], root);
  const reads: [string, string][] = [];
  const pi = makePi();
  registerTools({
    extend: (f) => f(pi, { id: "chat-a" }),
    chatFolder: () => mine,
    folders: () => [{ path: mine, name: "Atlas", kind: "agent" }, { path: theirs, name: "Bolt", kind: "agent" }],
    readFile: (file, chatId) => {
      reads.push([file, chatId]);
      return fs.readFileSync(file);
    },
    root,
    record: () => {},
    log: () => {},
  });
  const find = (name: string) => pi.registered.find((t) => t.name === name)!;
  const listed = ((await find("office_list").execute("c", {})) as ToolResult).content[0].text;
  assert.match(listed, /"report"/);
  assert.doesNotMatch(listed, /salary/, "another agent's scanned document is not in its list");
  const report = (await import("../src/store")).listDocs(root).find((d) => d.title === "report")!;
  const salary = (await import("../src/store")).listDocs(root).find((d) => d.title === "salary")!;
  const read = (await find("office_read").execute("c", { id: report.docId })) as ToolResult;
  assert.match(read.content[0].text, /New document/);
  assert.deepEqual(reads, [[path.join(mine, "notes", "report.docx"), "chat-a"]], "read from its own file, through the portal, for that chat");
  await find("office_edit").execute("c", { id: report.docId, ops: [{ quote: "New document", replacement: "Edited in place" }], baseRevision: report.mtimeMs });
  assert.match(parseDocx(fs.readFileSync(path.join(mine, "notes", "report.docx"))).text, /Edited in place/, "the edit is in the workspace file");
  await refused(find("office_read").execute("c", { id: salary.docId }), "another agent's");
  await refused(find("office_edit").execute("c", { id: salary.docId, ops: [{ quote: "New document", replacement: "x" }], baseRevision: salary.mtimeMs }), "another agent's");
  assert.match(parseDocx(fs.readFileSync(path.join(theirs, "salary.docx"))).text, /New document/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("scanned documents: a file the portal refuses to read for the agent (the sandbox closed it, or a link) is not read", async () => {
  __resetToolsForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-tools-"));
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-ws-")));
  fs.writeFileSync(path.join(ws, "closed.docx"), await (await import("../src/store")).templateDocx());
  (await import("../src/store")).scanWorkspace([ws], root);
  const pi = makePi();
  registerTools({
    extend: (f) => f(pi, { id: "chat-a" }),
    chatFolder: () => ws,
    folders: () => [{ path: ws, name: "Atlas", kind: "agent" }],
    readFile: () => {
      throw Object.assign(new Error("That folder is not one its agent may use"), { code: "invalid" });
    },
    root,
    record: () => {},
    log: () => {},
  });
  const doc = (await import("../src/store")).listDocs(root)[0]!;
  const msg = await refused(pi.registered.find((t) => t.name === "office_read")!.execute("c", { id: doc.docId }), "closed");
  assert.match(msg, /^error:not_found .*not a file your agent can read/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a document written outside the extension: office_read shows its new revision, and office_edit with it goes through", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Scripted", type: "word", owner: "/f/atlas" }, s.root);
  const file = path.join(s.root, "docs", doc.docId, "Scripted.docx");
  // An agent's script rewrites the file: the index still has the old revision.
  fs.writeFileSync(file, rewriteZip(fs.readFileSync(file), { "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Written by a script</w:t></w:r></w:p></w:body></w:document>' }));
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const now = fs.statSync(file).mtimeMs;
  const read = (await tool(s, "office_read").execute("c", { id: doc.docId })) as ToolResult;
  assert.equal(read.details.mtimeMs, now, "the revision of the file as it is");
  assert.match(read.content[0].text, /Written by a script/);
  const listed = (await tool(s, "office_list").execute("c", {})) as ToolResult;
  assert.equal(listed.details.documents[0].mtimeMs, now);
  const edited = (await tool(s, "office_edit").execute("c", { id: doc.docId, ops: [{ quote: "Written by a script", replacement: "Then edited" }], baseRevision: now })) as ToolResult;
  assert.equal(edited.details.from, now);
  assert.match(parseDocx(fs.readFileSync(file)).text, /Then edited/);
});

/* ------------------------------------------------------------------ */
/* office_create                                                       */
/* ------------------------------------------------------------------ */

test("office_create: happy path returns id + meta, owner is the home; duplicate title+type -> error:exists", async () => {
  const s = setup();
  const t = tool(s, "office_create");
  const res = (await t.execute("c1", { title: "Budget", type: "cell" })) as ToolResult;
  const meta = getDoc(res.details.id, s.root)!;
  assert.ok(meta); // exists in the index and on disk
  assert.equal(meta.owner, "/f/atlas");
  assert.equal(meta.ext, "xlsx");
  assert.equal(typeof res.details.mtimeMs, "number");
  assert.ok(res.content[0].text.includes(res.details.id));
  assert.ok(s.seen.records.some((r) => r.chatId === "chat-atlas-home" && r.reason.includes("office_create")), "audit recorded for create");

  const dup = await refused(t.execute("c2", { title: "Budget", type: "cell" }), "duplicate");
  assert.match(dup, /^error:exists /);

  // a different type with the same title is NOT a duplicate
  const word = (await t.execute("c3", { title: "Budget", type: "word" })) as ToolResult;
  assert.ok(word.details.id && !word.content[0].text.startsWith("error:"));

  // bad type -> error:unsupported_format; blank title -> error:invalid (refused before the store is touched)
  assert.match(await refused(t.execute("c4", { title: "Nope", type: "spreadsheet" }), "bad type"), /^error:unsupported_format /);
  assert.match(await refused(t.execute("c5", { title: "  ", type: "word" }), "blank title"), /^error:invalid /);
});

/* ------------------------------------------------------------------ */
/* office_edit                                                         */
/* ------------------------------------------------------------------ */

test("office_edit: applies ops to the stored bytes, bumps the revision; old baseRevision -> error:revision_mismatch with the fresh mtime; quote_not_found passes through", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Edit Me", type: "word", owner: "/f/atlas" }, s.root);
  const base1 = getDoc(doc.docId, s.root)!.mtimeMs;
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "New document");

  const t = tool(s, "office_edit");
  const ok = (await t.execute("e1", { id: doc.docId, ops: [{ quote: "New document", replacement: "Edited text" }], baseRevision: base1 })) as ToolResult;
  assert.ok(!ok.content[0].text.startsWith("error:"), `unexpected error: ${ok.content[0].text}`);
  assert.match(ok.content[0].text, /now at revision/);

  // round-trip: re-reading the STORED bytes shows the edit; persistBytes updated the index's revision
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "Edited text");
  assert.equal(getDoc(doc.docId, s.root)!.mtimeMs, ok.details.to);

  // a second edit on the OLD baseRevision is refused with the FRESH mtime in the message -- and nothing written
  const fresh = getDoc(doc.docId, s.root)!.mtimeMs;
  const stale = await refused(t.execute("e2", { id: doc.docId, ops: [{ quote: "Edited text", replacement: "again" }], baseRevision: fresh - 5000 }), "stale gate");
  assert.match(stale, /^error:revision_mismatch /);
  assert.ok(stale.includes(String(fresh)), `the fresh mtime ${fresh} must be in the message: ${stale}`);
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "Edited text"); // unchanged

  // with the FRESH base it applies; a bad quote surfaces ooxml's quote_not_found code verbatim
  const ok2 = await t.execute("e3", { id: doc.docId, ops: [{ quote: "Edited text", replacement: "Final words" }], baseRevision: getDoc(doc.docId, s.root)!.mtimeMs });
  assert.ok(!ok2.content[0].text.startsWith("error:"), ok2.content[0].text);
  const qnf = await refused(t.execute("e4", { id: doc.docId, ops: [{ quote: "not in the document at all", replacement: "x" }], baseRevision: getDoc(doc.docId, s.root)!.mtimeMs }), "quote_not_found");
  assert.match(qnf, /^error:quote_not_found /);
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "Final words"); // still nothing written

  // spreadsheets cannot be edited in v1 (document.xml run-level edits are Word-only)
  const sheet = await createDoc({ title: "Grid", type: "cell", owner: "/f/atlas" }, s.root);
  assert.match(await refused(t.execute("e5", { id: sheet.docId, ops: [{ quote: "a", replacement: "b" }], baseRevision: getDoc(sheet.docId, s.root)!.mtimeMs }), "xlsx edit"), /^error:unsupported_format /);

  // audit recorded for the two successful edits only
  assert.equal(s.seen.records.filter((r) => r.reason.includes("office_edit")).length, 2);
});

test("office_edit while the document is open in the editor: refused, nothing written; a seat the Document Server never confirmed does not hold it up", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Open One", type: "word", owner: "/f/atlas" }, s.root);
  bumpRevision(s.root, doc.docId, Date.now() - 5000);
  const base = getDoc(doc.docId, s.root)!.mtimeMs;
  // The Document Server said somebody is in it.
  setUser(doc.docId, { id: "portal-user", name: "Portal" }, true, { confirmed: true });
  const msg = await refused(tool(s, "office_edit").execute("f1", { id: doc.docId, ops: [{ quote: "New document", replacement: "Too early" }], baseRevision: base }), "open in the editor");
  assert.match(msg, /^error:open_in_editor /);
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "New document");
  assert.equal(getDoc(doc.docId, s.root)!.mtimeMs, base);
  // Closed: the edit goes through.
  resetLive();
  setUser(doc.docId, { id: "portal-user", name: "Portal" }, true); // minted only: the editor never loaded
  await tool(s, "office_edit").execute("f2", { id: doc.docId, ops: [{ quote: "New document", replacement: "After closing" }], baseRevision: base });
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "After closing");
});

test("office_edit asks the session check it is given (the Document Server's own answer after a restart)", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Asked", type: "word", owner: "/f/atlas" }, s.root);
  const asked: string[] = [];
  registerTools({ sessionOpen: async (d) => (asked.push(d.docId), true) });
  const msg = await refused(tool(s, "office_edit").execute("f1", { id: doc.docId, ops: [{ quote: "New document", replacement: "x" }], baseRevision: getDoc(doc.docId, s.root)!.mtimeMs }), "open");
  assert.match(msg, /^error:open_in_editor /);
  assert.deepEqual(asked, [doc.docId]);
});

test("office_edit: a stale revision is refused with a loud CONFLICT and the fresh revision; re-read and retry goes through", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Co Edit", type: "word", owner: "/f/atlas" }, s.root);
  bumpRevision(s.root, doc.docId, Date.now() - 5000);
  const baseB = getDoc(doc.docId, s.root)!.mtimeMs;
  bumpRevision(s.root, doc.docId, Date.now() + 5000); // an external save moved the revision after the agent read it
  const fresh = getDoc(doc.docId, s.root)!.mtimeMs;
  const refusedMsg = await refused(tool(s, "office_edit").execute("f2", { id: doc.docId, ops: [{ quote: "New document", replacement: "late" }], baseRevision: baseB }), "stale revision must refuse");
  assert.match(refusedMsg, /^error:revision_mismatch /);
  assert.ok(refusedMsg.includes("CONFLICT"), `the refusal is an explicit CONFLICT: ${refusedMsg}`);
  assert.ok(refusedMsg.includes(String(fresh)), `the fresh mtime ${fresh} must be in the message: ${refusedMsg}`);
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "New document"); // NOTHING written by the stale edit
  const ok = (await tool(s, "office_edit").execute("f4", { id: doc.docId, ops: [{ quote: "New document", replacement: "Retried after re-read" }], baseRevision: fresh })) as ToolResult;
  assert.ok(!ok.content[0].text.startsWith("error:"), ok.content[0].text);
  assert.equal(parseDocx(readDocBytes(s.root, doc.docId)).text, "Retried after re-read");
});

/** A .docx whose word/document.xml inflates to `mib` MiB of zeros from a few hundred KB: built a MiB at a time, so the
 * test itself never holds it whole. */
function bombDocx(mib: number): Buffer {
  const chunk = Buffer.alloc(1024 * 1024);
  let crc = 0;
  const parts: Buffer[] = [];
  const deflate = (data: Buffer, flush: number) => zlib.deflateRawSync(data, { finishFlush: flush });
  // One raw deflate stream made of sync-flushed pieces and a final empty block.
  for (let i = 0; i < mib; i++) {
    crc = zlib.crc32(chunk, crc);
    parts.push(deflate(chunk, zlib.constants.Z_SYNC_FLUSH));
  }
  parts.push(deflate(Buffer.alloc(0), zlib.constants.Z_FINISH));
  const data = Buffer.concat(parts);
  const name = Buffer.from("word/document.xml");
  const usize = mib * 1024 * 1024;
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(8, 8); lfh.writeUInt32LE(crc >>> 0, 14);
  lfh.writeUInt32LE(data.length, 18); lfh.writeUInt32LE(usize, 22); lfh.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc >>> 0, 16);
  cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(usize, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(30 + name.length + data.length, 16);
  return Buffer.concat([lfh, name, data, cd, name, eocd]);
}

test("office_edit on a document whose text part inflates past the cap (600 MiB from 600 KB): refused before it is inflated, the portal's memory untouched", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Bomb", type: "word", owner: "/f/atlas" }, s.root);
  const file = path.join(s.root, "docs", doc.docId, "Bomb.docx");
  fs.writeFileSync(file, bombDocx(600));
  bumpRevision(s.root, doc.docId, Date.now() - 1000);
  const peak = process.resourceUsage().maxRSS; // KiB
  const msg = await refused(tool(s, "office_edit").execute("b", { id: doc.docId, ops: [{ quote: "x", replacement: "y" }], baseRevision: getDoc(doc.docId, s.root)!.mtimeMs }), "bomb");
  assert.match(msg, /^error:corrupt .*cap/);
  assert.ok(process.resourceUsage().maxRSS - peak < 200 * 1024, `the peak memory rose by ${Math.round((process.resourceUsage().maxRSS - peak) / 1024)} MiB`);
});

/* ------------------------------------------------------------------ */
/* office_comments                                                     */
/* ------------------------------------------------------------------ */

test("office_comments: docx lists comment ids/authors/text + grants; xlsx -> unsupported note", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Commented", type: "word", owner: "/f/atlas" }, s.root);
  // inject a comments part into the stored bytes (mtime moves -- the tool re-reads the meta anyway)
  const file = path.join(s.root, "docs", doc.docId, `${doc.title}.${doc.ext}`);
  fs.writeFileSync(file, rewriteZip(readDocBytes(s.root, doc.docId), { "word/comments.xml": commentsXml([{ id: "c1", author: "Ada Person", text: "@agent please fix this" }, { id: "c2", author: "Bob", text: "second note" }]) }));
  addGrant(s.root, doc.docId, "/f/acme", "c1");

  const res = (await tool(s, "office_comments").execute("cm", { id: doc.docId })) as ToolResult;
  const t = res.content[0].text;
  assert.ok(!t.startsWith("error:"), t);
  assert.match(t, /c1\s+Ada Person/);
  assert.match(t, /@agent please fix this/);
  assert.match(t, /c2\s+Bob/);
  assert.match(t, /\/f\/acme.*via comment c1/s);
  assert.equal(res.details.comments.length, 2);
  assert.equal(res.details.grants[0].folder, "/f/acme");

  // a doc with no comments -> a readable "(none)", not an error
  const bare = await createDoc({ title: "Bare", type: "word", owner: "/f/atlas" }, s.root);
  const bareRes = (await tool(s, "office_comments").execute("cm2", { id: bare.docId })) as ToolResult;
  assert.match(bareRes.content[0].text, /Comments \(0\):\n\(none\)/);

  // xlsx: the unsupported note with the code prefix (xlsx comments are not read yet)
  const sheet = await createDoc({ title: "Sheet", type: "cell", owner: "/f/atlas" }, s.root);
  assert.match(await refused(tool(s, "office_comments").execute("cm3", { id: sheet.docId }), "xlsx comments"), /^error:unsupported_format /);
});

test("office_comments: aggregated comment output is capped like office_read (marker + bounded details)", async () => {
  const s = setup();
  // 300 comments x ~750 chars of text -- comfortably over the shared 200,000-character cap
  const many = Array.from({ length: 300 }, (_, i) => ({ id: String(i), author: "Crowd", text: `note ${i}: ${"x".repeat(750)}` }));
  const doc = await createDoc({ title: "Wall of Notes", type: "word", owner: "/f/atlas" }, s.root);
  const file = path.join(s.root, "docs", doc.docId, `${doc.title}.${doc.ext}`);
  fs.writeFileSync(file, rewriteZip(readDocBytes(s.root, doc.docId), { "word/comments.xml": commentsXml(many) }));

  const res = (await tool(s, "office_comments").execute("cm4", { id: doc.docId })) as ToolResult;
  const t = res.content[0].text;
  assert.ok(!t.startsWith("error:"), t.slice(0, 200));
  assert.match(t, /Comments \(300\):/, "the true total is announced even when truncated");
  assert.ok(t.length <= 200_000 + 100, `output bounded (got ${t.length} chars)`);
  assert.match(t, /\[output truncated by office_comments: it exceeds 200,000 characters\]/);

  // details are bounded exactly like office_read's: 100 at 500 chars each, true total in commentCount
  assert.equal(res.details.commentCount, 300);
  assert.equal(res.details.comments.length, 100);
  for (const c of res.details.comments) assert.ok(c.text.length <= 500);
});

/* ------------------------------------------------------------------ */
/* error string format (docs convention, office fix)                   */
/* ------------------------------------------------------------------ */

test("every refusal the agent reads starts with \"error:<code> \"", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Fmt", type: "word", owner: "/f/atlas" }, s.root);
  const sheet = await createDoc({ title: "F2", type: "cell", owner: "/f/atlas" }, s.root);

  assert.match(await refused(tool(s, "office_read").execute("x1", { id: "nope" }), "not_found"), /^error:not_found /);
  const stale = await refused(tool(s, "office_edit").execute("x2", { id: doc.docId, ops: [{ quote: "New document", replacement: "r" }], baseRevision: getDoc(doc.docId, s.root)!.mtimeMs - 9000 }), "stale gate");
  assert.match(stale, /^error:revision_mismatch /);
  assert.match(await refused(tool(s, "office_edit").execute("x3", { id: doc.docId, ops: [], baseRevision: getDoc(doc.docId, s.root)!.mtimeMs }), "empty ops"), /^error:invalid /);
  assert.match(await refused(tool(s, "office_create").execute("x4", { title: "Fmt", type: "word" }), "exists"), /^error:exists /);
  assert.match(await refused(tool(s, "office_comments").execute("x5", { id: sheet.docId }), "xlsx comments"), /^error:unsupported_format /);
});

/* ------------------------------------------------------------------ */
/* the wake drain side                                */
/* ------------------------------------------------------------------ */

test("the factory also registers the UI_RECEIVE ping drain for office chats only", () => {
  const s = setup();
  (setup as any).__run();
  assert.equal(s.pi.uiHandlers.length, 1);
  // a non-ping bell is ignored without draining anything or throwing
  s.pi.uiHandlers[0]({ data: { type: "other" } });
  assert.equal(s.pi.sent.length, 0);

  const notes = makePi();
  registerTools({
    extend: (f) => f(notes, { id: "chat-notes" }),
    chatFolder: () => "/f/notes",
    folders: () => FOLDERS,
    root: s.root,
    log: (l) => s.seen.logs.push(l),
  });
  assert.equal(notes.uiHandlers.length, 0); // no tools in a plain chat -> no drain either
});
