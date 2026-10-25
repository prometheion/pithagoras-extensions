/**
 * Unit tests for src/tools.ts (the agent's office_* tools). Run from office/:
 *   node --import tsx --test test/tools.test.mts
 * Self-contained: tmp dataDir per test, real docx/xlsx via store.createDoc (real templates), comment
 * XML injected with ooxml.rewriteZip, every portal bit (extend registrar, chat->folder, folders list,
 * the file reader, root, record, log) injected through registerTools -- the tests NEVER reach portal().
 * The agent's editor is a fake seat (what seat.ts would run, and what its command would answer) and the save after
 * an edit a fake too, which moves the file's revision as the callback's persist would.
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
import { GUARDS, LABELS, registerTools, __resetToolsForTests } from "../src/tools";
import { de } from "../src/de";
import { createDoc, getDoc, readDoc } from "../src/store";
import { parseDocx, rewriteZip } from "../src/ooxml";
import { resetLive, setUser, setSession, nameAgent } from "../src/live";
import { SeatError } from "../src/seat";
import type { SaveAfterEdit } from "../src/editing";

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

type Run = { home: string; docId: string; mode: string; kind: string; args: any };

/**
 * The agent's editor, faked: every job it is handed (`runs`), answered by `answer` (by default: a Word read of the
 * document's saved paragraphs, an empty sheet, and an edit that succeeds); `saves` the keys a save was asked of, each
 * answered `outcome`, which, saved, moves the file's revision as the callback's persist does.
 */
function fakeSeat(root: () => string) {
  const state = {
    runs: [] as Run[],
    closed: [] as string[],
    saves: [] as string[],
    outcome: "saved" as SaveAfterEdit,
    answer: undefined as ((run: Run) => unknown) | undefined,
  };
  const seat = {
    run: async (home: string, docId: string, mode: string, job: { kind: string; args: any }) => {
      const run = { home, docId, mode, kind: job.kind, args: job.args };
      state.runs.push(run);
      if (state.answer) return state.answer(run);
      if (job.kind === "word.read") return { blocks: parseDocx(readDoc(getDoc(docId, root())!, root())).paragraphs.map((p) => ({ p })) };
      if (job.kind === "cell.read") return { sheets: [{ name: "Sheet1", range: "A1", cells: [], truncated: false }] };
      return { ops: (job.args.ops ?? []).length };
    },
    keyOf: (_home: string, docId: string) => `key-of-${docId}`,
    closeDoc: (docId: string) => void state.closed.push(docId),
  };
  const save = async (key: string) => {
    state.saves.push(key);
    if (state.outcome === "saved") {
      const docId = key.replace(/^key-of-/, "");
      bumpRevision(root(), docId, Date.now() + 1000 * state.saves.length);
    }
    return state.outcome;
  };
  return { state, seat, save };
}

/** One isolated world: tmp root, a captured extend factory, a fake pi for `chatId`, seams wired so no default touches portal(). */
function setup(chatId = "chat-atlas-home"): { root: string; seen: Seen; pi: PiFake; folderPath: string; seat: ReturnType<typeof fakeSeat>["state"]; office: { state: "running" | "starting" | "stopped" } } {
  __resetToolsForTests();
  resetLive();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-tools-"));
  const seen: Seen = { records: [], logs: [] };
  const pi = makePi();
  const fake = fakeSeat(() => root);
  const office = { state: "running" as "running" | "starting" | "stopped" };
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
    seat: fake.seat,
    save: fake.save,
    officeState: () => office.state,
  });
  // The factory body runs PER CALL so each test step sees exactly one registration pass for its chat.
  (setup as any).__run = () => factory(pi, { id: chatId });
  return { root, seen, pi, folderPath: CHAT_TO_FOLDER[chatId], seat: fake.state, office };
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

test("every tool has its label from the translated table and a guard decided for it: what it returns is outside content", () => {
  const s = setup();
  (setup as any).__run();
  assert.deepEqual(s.pi.registered.map((t) => t.name).sort(), Object.keys(LABELS).sort());
  assert.deepEqual(Object.keys(GUARDS).sort(), Object.keys(LABELS).sort());
  for (const t of s.pi.registered) {
    assert.equal(t.label, LABELS[t.name], t.name);
    assert.ok(t.label in de, `${t.name}'s label has its German`);
    assert.deepEqual(t.guard, { outside: true, acts: [] }, t.name);
  }
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

  // office_read of the out-of-scope id refuses with the SAME words as a nonexistent id (docs convention: no leak),
  // and no editor is opened for it
  const missing = await refused(tool(s, "office_read").execute("c", { id: "no-such-id" }), "missing id");
  const foreign = await refused(tool(s, "office_read").execute("c", { id: theirs.docId }), "out-of-scope id");
  assert.equal(foreign, missing);
  assert.match(foreign, /^error:not_found /);
  assert.match(await refused(tool(s, "office_edit").execute("c", { id: theirs.docId, ops: [{ quote: "a", replacement: "b" }] }), "out-of-scope edit"), /^error:not_found /);
  assert.deepEqual(s.seat.runs, [], "no editor opened for a document out of scope");

  // the granted doc IS readable (xlsx, through the seat)
  const shared = (await tool(s, "office_read").execute("c", { id: granted.docId })) as ToolResult;
  assert.ok(shared.content[0].text.includes('"Shared One"'));
  assert.deepEqual((s.seat.runs as Run[]).map((r) => [r.docId, r.kind, r.mode]), [[granted.docId, "cell.read", "edit"]]);
});

/** A scanned document in a folder of its own, with the tools registered for the agent that works there, through the
 * seams given. */
async function scanned(seams: Parameters<typeof registerTools>[0], files: string[] = ["shared.docx"]) {
  __resetToolsForTests();
  resetLive();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-tools-"));
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-ws-")));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), await (await import("../src/store")).templateDocx());
  }
  (await import("../src/store")).scanWorkspace([ws], root);
  const pi = makePi();
  const fake = fakeSeat(() => root);
  registerTools({ extend: (f) => f(pi, { id: "chat-a" }), chatFolder: () => ws, folders: () => [{ path: ws, name: "Atlas", kind: "agent" }], root, record: () => {}, log: () => {}, seat: fake.seat, save: fake.save, officeState: () => "running", ...seams });
  const doc = (await import("../src/store")).listDocs(root)[0]!;
  return { root, ws, file: path.join(ws, files[0]), doc, seat: fake.state, find: (name: string) => pi.registered.find((t) => t.name === name)! };
}

test("scanned documents: the ones in the agent's own folder are opened in its editor once the portal could open them for it; another agent's are not there", async () => {
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
  const { scanWorkspace, listDocs } = await import("../src/store");
  scanWorkspace([mine, theirs], root);
  const opened: [string, string][] = [];
  const pi = makePi();
  const fake = fakeSeat(() => root);
  fake.state.answer = (run) => (run.kind === "word.read" ? { blocks: [{ p: "New document" }] } : { ops: 1 });
  registerTools({
    extend: (f) => f(pi, { id: "chat-a" }),
    chatFolder: () => mine,
    folders: () => [{ path: mine, name: "Atlas", kind: "agent" }, { path: theirs, name: "Bolt", kind: "agent" }],
    openFile: (file, chatId) => {
      opened.push([file, chatId]);
      return { fd: fs.openSync(file, "r"), size: fs.statSync(file).size };
    },
    mayWrite: () => {},
    root,
    record: () => {},
    log: () => {},
    seat: fake.seat,
    save: async () => "saved",
    officeState: () => "running",
  });
  const find = (name: string) => pi.registered.find((t) => t.name === name)!;
  const listed = ((await find("office_list").execute("c", {})) as ToolResult).content[0].text;
  assert.match(listed, /"report"/);
  assert.doesNotMatch(listed, /salary/, "another agent's scanned document is not in its list");
  const report = listDocs(root).find((d) => d.title === "report")!;
  const salary = listDocs(root).find((d) => d.title === "salary")!;
  const read = (await find("office_read").execute("c", { id: report.docId })) as ToolResult;
  assert.match(read.content[0].text, /\[1\] New document/);
  assert.deepEqual(opened, [[path.join(mine, "notes", "report.docx"), "chat-a"]], "opened as the agent of that chat, before its editor was");
  await find("office_edit").execute("c", { id: report.docId, ops: [{ quote: "New document", replacement: "Edited" }] });
  assert.deepEqual((fake.state.runs as Run[]).map((r) => [r.docId, r.kind, r.mode]), [[report.docId, "word.read", "edit"], [report.docId, "word.edit", "edit"]]);
  await refused(find("office_read").execute("c", { id: salary.docId }), "another agent's");
  await refused(find("office_edit").execute("c", { id: salary.docId, ops: [{ quote: "New document", replacement: "x" }] }), "another agent's");
  assert.equal(fake.state.runs.length, 2, "no editor for another agent's document");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("scanned documents: a file the portal refuses to open for the agent (the sandbox closed it, or a link) is never opened in an editor", async () => {
  const s = await scanned({
    openFile: () => {
      throw Object.assign(new Error("That folder is not one its agent may use"), { code: "invalid" });
    },
  });
  assert.match(await refused(s.find("office_read").execute("c", { id: s.doc.docId }), "closed"), /^error:not_found .*not a file your agent can read/);
  assert.match(await refused(s.find("office_edit").execute("c", { id: s.doc.docId, ops: [{ quote: "New document", replacement: "x" }] }), "closed"), /^error:not_found /);
  assert.deepEqual(s.seat.runs, [], "the Document Server, which reads as the portal, is never handed it");
  fs.rmSync(s.ws, { recursive: true, force: true });
});

test("scanned documents the agent may read but not change: read in a view-mode editor; office_edit is error:read_only before anything is sent", async () => {
  const asked: [string, string][] = [];
  const s = await scanned({
    openFile: (file) => ({ fd: fs.openSync(file, "r"), size: fs.statSync(file).size }),
    mayWrite: (file, chatId) => {
      asked.push([file, chatId]);
      throw Object.assign(new Error("That folder is not one its agent may use"), { code: "invalid" });
    },
  });
  await s.find("office_read").execute("c", { id: s.doc.docId });
  assert.deepEqual(s.seat.runs.map((r) => [r.kind, r.mode]), [["word.read", "view"]]);
  const msg = await refused(s.find("office_edit").execute("c", { id: s.doc.docId, ops: [{ quote: "New document", replacement: "Changed anyway" }] }), "read-only");
  assert.match(msg, /^error:read_only .*not a file your agent may change/);
  assert.equal(s.seat.runs.length, 1, "no edit was sent");
  assert.deepEqual(s.seat.saves, [], "and no save asked");
  assert.deepEqual(asked[0], [s.file, "chat-a"], "asked for that chat's agent, of the document's own file");
  fs.rmSync(s.ws, { recursive: true, force: true });
});

test("office_read/office_edit: a scanned file that grew past the library's cap since it was indexed is refused before it is opened anywhere", async () => {
  const s = await scanned({ openFile: () => ({ fd: -1, size: 600 * 1024 * 1024 }), mayWrite: () => {} });
  const realClose = fs.closeSync;
  (fs as { closeSync: unknown }).closeSync = (fd: number) => (fd === -1 ? undefined : realClose(fd));
  try {
    assert.match(await refused(s.find("office_read").execute("c", { id: s.doc.docId }), "too large"), /^error:too_large /);
    assert.match(await refused(s.find("office_edit").execute("c", { id: s.doc.docId, ops: [{ quote: "New document", replacement: "x" }] }), "too large"), /^error:too_large /);
  } finally {
    (fs as { closeSync: unknown }).closeSync = realClose;
  }
  assert.deepEqual(s.seat.runs, []);
  fs.rmSync(s.ws, { recursive: true, force: true });
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
  assert.doesNotMatch(res.content[0].text, /baseRevision/);
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
/* office_read                                                         */
/* ------------------------------------------------------------------ */

test("office_read (Word): the editor's blocks, numbered, with styles and tables; the header says it is live and who typed", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Report", type: "word", owner: "/f/atlas" }, s.root);
  s.seat.answer = () => ({ blocks: [{ p: "Quarterly report" , style: "Title" }, { p: "Revenue was revised." }, { table: [["Item", "Amount"], ["Ledger", "42"]] }, { p: "" }] });
  setUser(doc.docId, { id: "portal-user", name: "Portal" }, true, { confirmed: true });
  const read = (await tool(s, "office_read").execute("r", { id: doc.docId })) as ToolResult;
  const t = read.content[0].text;
  assert.match(t, new RegExp(`^"Report" \\(id ${doc.docId}, docx, revision ${doc.mtimeMs}\\)\\nLive: the document as it stands in the editor, including what 1 person in it typed and have not saved yet\\.`));
  assert.match(t, /\n\[1\] \(Title\) Quarterly report\n\[2\] Revenue was revised\.\n\[3\] table\n\| Item \| Amount \|\n\| Ledger \| 42 \|\n\[4\] $/);
  assert.equal(read.details.live, true);
  assert.deepEqual(s.seat.runs.map((r) => [r.home, r.docId, r.mode, r.kind]), [["/f/atlas", doc.docId, "edit", "word.read"]]);
  // A sheet is for spreadsheets.
  assert.match(await refused(tool(s, "office_read").execute("r2", { id: doc.docId, sheet: "Sheet1" }), "sheet of a docx"), /^error:bad_op /);
});

test("office_read (spreadsheet): cells by address, texts quoted, formulas after their values; one sheet by name", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Budget", type: "cell", owner: "/f/atlas" }, s.root);
  s.seat.answer = () => ({ sheets: [{ name: "Sheet1", range: "A1:C3", cells: [{ a: "A1", v: 2 }, { a: "A3", v: 6, f: "=A1*A2" }, { a: "C1", v: "person" }, { a: "B2", v: true }], truncated: false }, { name: "Empty", range: "A1", cells: [], truncated: true }, { name: "Later", range: "", cells: [], truncated: true, skipped: true }] });
  const t = ((await tool(s, "office_read").execute("r", { id: doc.docId })) as ToolResult).content[0].text;
  assert.match(t, /Sheet "Sheet1" \(A1:C3\):\nA1: 2\nA3: 6 \(=A1\*A2\)\nC1: "person"\nB2: TRUE\n\nSheet "Empty" \(A1\):\n\(empty\)\n\(not all of its cells are shown: a read gives 20,000 cells of a sheet and 200,000 characters at most\)\n\nSheet "Later": not read \(the sheets before it filled the read; read it with sheet\)$/);
  await tool(s, "office_read").execute("r2", { id: doc.docId, sheet: "Sheet1" });
  assert.deepEqual(s.seat.runs.at(-1)!.args, { sheet: "Sheet1" });
});

test("office_read with Office stopped (or starting) reads the saved file and says so; no editor is opened", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Saved", type: "word", owner: "/f/atlas" }, s.root);
  s.office.state = "stopped";
  const t = ((await tool(s, "office_read").execute("r", { id: doc.docId })) as ToolResult).content[0].text;
  assert.match(t, /\nSaved copy \(Office is stopped\): what the file holds\./);
  assert.match(t, /\[1\] New document/);
  s.office.state = "starting";
  assert.match(((await tool(s, "office_read").execute("r", { id: doc.docId })) as ToolResult).content[0].text, /Saved copy \(Office is still starting\)/);
  const sheet = await createDoc({ title: "Grid", type: "cell", owner: "/f/atlas" }, s.root);
  assert.match(((await tool(s, "office_read").execute("r", { id: sheet.docId })) as ToolResult).content[0].text, /Saved copy .*\n\nSheet "Sheet1":\n\(empty\)/s);
  assert.match(((await tool(s, "office_read").execute("r", { id: sheet.docId, sheet: "Sheet1" })) as ToolResult).content[0].text, /Sheet "Sheet1"/);
  assert.match(await refused(tool(s, "office_read").execute("r", { id: sheet.docId, sheet: "Nope" }), "no such sheet"), /^error:not_found there is no sheet named "Nope" \(the sheets: Sheet1\)/);
  assert.deepEqual(s.seat.runs, []);
});

test("office_read without the agent's editor downloaded reads the saved file and says why; office_edit is refused with what to do", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Saved", type: "word", owner: "/f/atlas" }, s.root);
  // container.ensureAgent's refusal, as it comes through the seat.
  s.seat.answer = () => Promise.reject(Object.assign(new Error("the agent's editor (chromedp/headless-shell:1) is not downloaded"), { code: "agent_editor_missing" }));
  const t = ((await tool(s, "office_read").execute("r", { id: doc.docId })) as ToolResult).content[0].text;
  assert.match(t, /\nSaved copy \(your editor is not downloaded: the person downloads it on the Office page\): what the file holds\./);
  assert.match(t, /\[1\] New document/);
  assert.match(await refused(tool(s, "office_edit").execute("e", { id: doc.docId, ops: [{ quote: "New document", replacement: "x" }] })), /^error:agent_editor_missing .*download it on the Office page/);
  // Anything else the editor says is no reason to read the saved file: it is said.
  s.seat.answer = () => Promise.reject(new SeatError("agent_unavailable", "the agent's editor did not start within 60 s"));
  assert.match(await refused(tool(s, "office_read").execute("r", { id: doc.docId })), /^error:agent_unavailable /);
});

test("office_read: a Word document the editor read only in part says it goes on", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Long", type: "word", owner: "/f/atlas" }, s.root);
  s.seat.answer = () => ({ blocks: [{ p: "first" }], truncated: true });
  const t = ((await tool(s, "office_read").execute("r", { id: doc.docId })) as ToolResult).content[0].text;
  assert.match(t, /\[1\] first\n\n\(the document goes on: only its first 200,000 characters were read\)$/);
});

test("office_read: Office found stopped as the agent's editor starts (its network gone) reads the saved file", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Saved", type: "word", owner: "/f/atlas" }, s.root);
  s.seat.answer = () => Promise.reject(Object.assign(new Error("the Document Server's network is not there"), { code: "office_stopped" }));
  const t = ((await tool(s, "office_read").execute("r", { id: doc.docId })) as ToolResult).content[0].text;
  assert.match(t, /\nSaved copy \(Office is stopped\): what the file holds\./);
  assert.match(t, /\[1\] New document/);
});

test("office_read: a text past 200,000 characters is cut with a marker", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Long", type: "word", owner: "/f/atlas" }, s.root);
  s.seat.answer = () => ({ blocks: Array.from({ length: 300 }, () => ({ p: "x".repeat(1000) })) });
  const t = ((await tool(s, "office_read").execute("r", { id: doc.docId })) as ToolResult).content[0].text;
  assert.ok(t.length <= 200_000 + 100);
  assert.match(t, /\[output truncated by office_read: it exceeds 200,000 characters\]$/);
});

test("a document written outside the extension: office_read shows its new revision", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Scripted", type: "word", owner: "/f/atlas" }, s.root);
  const file = path.join(s.root, "docs", doc.docId, "Scripted.docx");
  fs.writeFileSync(file, rewriteZip(fs.readFileSync(file), { "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Written by a script</w:t></w:r></w:p></w:body></w:document>' }));
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const now = fs.statSync(file).mtimeMs;
  const read = (await tool(s, "office_read").execute("c", { id: doc.docId })) as ToolResult;
  assert.equal(read.details.mtimeMs, now, "the revision of the file as it is");
  const listed = (await tool(s, "office_list").execute("c", {})) as ToolResult;
  assert.equal(listed.details.documents[0].mtimeMs, now);
});

/* ------------------------------------------------------------------ */
/* office_edit                                                         */
/* ------------------------------------------------------------------ */

test("office_edit: the ops go to the agent's editor as one job, the session is saved, and the tool answers the new revision", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Edit Me", type: "word", owner: "/f/atlas" }, s.root);
  setUser(doc.docId, { id: "portal-user", name: "Portal" }, true, { confirmed: true });
  const ops = [{ quote: "New document", replacement: "Edited text" }, { after: "Edited text", paragraphs: ["Findings"], style: "Heading 1" }, { after: "Findings", table: [["a", "b"]] }, { remove: "gone" }];
  const ok = (await tool(s, "office_edit").execute("e1", { id: doc.docId, ops })) as ToolResult;
  const to = getDoc(doc.docId, s.root)!.mtimeMs;
  assert.equal(ok.content[0].text, `Edited "Edit Me" (4 ops), saved as revision ${to}. 1 person in the document saw it live.`);
  assert.deepEqual(ok.details, { action: "edit", id: doc.docId, ops: 4, from: doc.mtimeMs, to, live: 1 });
  assert.deepEqual(s.seat.runs.map((r) => [r.home, r.docId, r.mode, r.kind, r.args]), [["/f/atlas", doc.docId, "edit", "word.edit", { ops }]]);
  assert.deepEqual(s.seat.saves, [`key-of-${doc.docId}`], "the agent's own session was saved");
  const audit = s.seen.records.find((r) => r.reason.startsWith("office_edit"))!;
  assert.equal(audit.chatId, "chat-atlas-home");
  assert.match(audit.reason, new RegExp(`office_edit: 4 op\\(s\\) \\(replace, insert, table, remove\\) on ${doc.docId} by /f/atlas; saved as revision ${to}`));
});

test("office_edit (spreadsheet): the range ops go as one cell.edit job", async () => {
  const s = setup();
  const sheet = await createDoc({ title: "Grid", type: "cell", owner: "/f/atlas" }, s.root);
  await tool(s, "office_edit").execute("e1", { id: sheet.docId, ops: [{ range: "A1:A3", values: [[2], [3], ["=A1*A2"]] }] });
  assert.deepEqual(s.seat.runs.map((r) => [r.kind, r.args]), [["cell.edit", { ops: [{ range: "A1:A3", values: [[2], [3], ["=A1*A2"]] }] }]]);
});

test("office_edit: bad ops are refused before anything is sent (bad_op, unsupported_format)", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Doc", type: "word", owner: "/f/atlas" }, s.root);
  const sheet = await createDoc({ title: "Grid", type: "cell", owner: "/f/atlas" }, s.root);
  const t = tool(s, "office_edit");
  assert.match(await refused(t.execute("e", { id: doc.docId, ops: [] }), "empty"), /^error:bad_op /);
  assert.match(await refused(t.execute("e", { id: doc.docId, ops: [{ quote: "a" }] }), "no replacement"), /^error:bad_op /);
  assert.match(await refused(t.execute("e", { id: doc.docId, ops: [{ range: "A1", values: [[1]] }] }), "cell op on docx"), /^error:unsupported_format /);
  assert.match(await refused(t.execute("e", { id: sheet.docId, ops: [{ quote: "a", replacement: "b" }] }), "word op on xlsx"), /^error:unsupported_format /);
  assert.deepEqual(s.seat.runs, []);
});

test("office_edit with Office stopped is error:office_stopped, while it starts error:ds_starting; nothing is sent", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Doc", type: "word", owner: "/f/atlas" }, s.root);
  s.office.state = "stopped";
  assert.match(await refused(tool(s, "office_edit").execute("e", { id: doc.docId, ops: [{ quote: "New document", replacement: "x" }] }), "stopped"), /^error:office_stopped .*start it on the Office page/);
  s.office.state = "starting";
  assert.match(await refused(tool(s, "office_edit").execute("e", { id: doc.docId, ops: [{ quote: "New document", replacement: "x" }] }), "starting"), /^error:ds_starting /);
  assert.deepEqual(s.seat.runs, []);
});

test("office_edit: the editor's refusals reach the agent coded, with what to do", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Doc", type: "word", owner: "/f/atlas" }, s.root);
  const t = tool(s, "office_edit");
  const fail = (e: SeatError) => (s.seat.answer = () => Promise.reject(e));
  fail(new SeatError("quote_not_found", "op 2: the quote \"x\" is not in the document", 1));
  assert.match(await refused(t.execute("e", { id: doc.docId, ops: [{ quote: "New document", replacement: "a" }, { quote: "x", replacement: "b" }] })), /^error:quote_not_found op 2: .* Nothing was changed: read the document again/);
  fail(new SeatError("agent_editor_missing", "the agent's editor (chromedp/headless-shell:1) is not downloaded"));
  assert.match(await refused(t.execute("e", { id: doc.docId, ops: [{ quote: "New document", replacement: "a" }] })), /^error:agent_editor_missing .*download it on the Office page/);
  fail(new SeatError("timeout", "the agent's editor gave no result within 20 s; what the call did is unknown: read the document again before you go on"));
  assert.match(await refused(t.execute("e", { id: doc.docId, ops: [{ quote: "New document", replacement: "a" }] })), /^error:timeout /);
  fail(new SeatError("busy", "the agents have 3 documents open in the editor and all of them are busy; try again in a moment"));
  assert.match(await refused(t.execute("e", { id: doc.docId, ops: [{ quote: "New document", replacement: "a" }] })), /^error:busy /);
  assert.deepEqual(s.seat.saves, [], "nothing is saved after a refused edit");
  assert.equal(s.seen.records.filter((r) => r.reason.startsWith("office_edit")).length, 0);
});

test("office_edit: how the save after the edit came out: saved, kept as a copy (behind, the seat closed), or not in time (editor_not_saved)", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Saving", type: "word", owner: "/f/atlas" }, s.root);
  const t = tool(s, "office_edit");
  const op = { id: doc.docId, ops: [{ quote: "New document", replacement: "x" }] };
  s.seat.outcome = "timeout";
  assert.match(await refused(t.execute("e", op)), /^error:editor_not_saved .*made and live in the document.*reaches the file with the editor's next save.*Do not make it again/);
  s.seat.outcome = "failed";
  assert.match(await refused(t.execute("e", op)), /^error:editor_not_saved /);
  s.seat.outcome = "copy";
  assert.match(await refused(t.execute("e", op)), /^error:behind .*kept beside the document as "Saving \(conflict <date time>\)"/);
  assert.deepEqual(s.seat.closed, [doc.docId], "the agent's editor of a document that changed outside is closed");
  s.seat.outcome = "same";
  assert.match(((await t.execute("e", op)) as ToolResult).content[0].text, /^Edited "Saving" \(1 op\), saved as revision/);
  // Each was recorded with what came of it.
  assert.deepEqual(s.seen.records.filter((r) => r.reason.startsWith("office_edit")).map((r) => r.reason.split("; ")[1]), ["not saved yet (timeout)", "not saved yet (failed)", "the save was kept as a conflict copy", `saved as revision ${getDoc(doc.docId, s.root)!.mtimeMs}`]);
});

test("office_edit: an edit the editor took and then gave no clear answer for is recorded all the same, with what came of it", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Unclear", type: "word", owner: "/f/atlas" }, s.root);
  const t = tool(s, "office_edit");
  const op = { id: doc.docId, ops: [{ quote: "New document", replacement: "x" }] };
  for (const [code, ran] of [["editor_not_saved", true], ["timeout", true], ["aborted", true], ["editor_closed", true], ["timeout", false], ["aborted", false], ["busy", false]] as const) {
    s.seat.answer = () => Promise.reject(new SeatError(code, `the ${code}`, undefined, ran));
    assert.match(await refused(t.execute("e", op)), new RegExp(`^error:${code} `));
  }
  assert.deepEqual(s.seen.records.filter((r) => r.reason.startsWith("office_edit")).map((r) => r.reason.split("; ")[1]), [
    "made in the editor, not saved yet (editor_not_saved)",
    "outcome unknown (timeout)",
    "outcome unknown (aborted)",
    "outcome unknown (editor_closed)",
  ]);
  assert.match(s.seen.records[0].reason, new RegExp(`^office_edit: 1 op\\(s\\) \\(replace\\) on ${doc.docId} by /f/atlas; `));
  assert.deepEqual(s.seat.saves, []);
});

test("office_edit: an edit that changed nothing has nothing to save, and says so; one that changed something and was not saved is editor_not_saved", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Same", type: "cell", owner: "/f/atlas" }, s.root);
  const t = tool(s, "office_edit");
  const op = { id: doc.docId, ops: [{ range: "A1", values: [[1]] }] };
  s.seat.outcome = "nothing";
  s.seat.answer = () => ({ cells: 1, changed: false });
  const ok = (await t.execute("e", op)) as ToolResult;
  assert.match(ok.content[0].text, new RegExp(`^Edited "Same" \\(1 op\\): that changed nothing, so there was nothing to save; the document is at revision ${doc.mtimeMs}, as it was\\.$`));
  assert.equal(ok.details.changed, false);
  s.seat.answer = () => ({ cells: 1, changed: true });
  assert.match(await refused(t.execute("e", op)), /^error:editor_not_saved /);
  assert.deepEqual(s.seen.records.filter((r) => r.reason.startsWith("office_edit")).map((r) => r.reason.split("; ")[1]), [`no change, revision ${doc.mtimeMs}`, "not saved yet (nothing)"]);
});

test("office_edit: an edit queued behind another starts from the revision that one saved", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Queued", type: "word", owner: "/f/atlas" }, s.root);
  const t = tool(s, "office_edit");
  const [one, two] = (await Promise.all([t.execute("a", { id: doc.docId, ops: [{ quote: "New document", replacement: "one" }] }), t.execute("b", { id: doc.docId, ops: [{ quote: "one", replacement: "two" }] })])) as ToolResult[];
  assert.equal(one.details.from, doc.mtimeMs);
  assert.equal(two.details.from, one.details.to, "from the first one's revision");
  assert.notEqual(two.details.to, two.details.from);
});

test("office_edit: two edits of one document run one after the other, each with its save, never interleaved", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Twice", type: "word", owner: "/f/atlas" }, s.root);
  const order: string[] = [];
  s.seat.answer = async (run) => {
    order.push(`start ${run.args.ops[0].replacement}`);
    await new Promise((r) => setTimeout(r, 30));
    order.push(`end ${run.args.ops[0].replacement}`);
    return { ops: 1 };
  };
  const t = tool(s, "office_edit");
  await Promise.all([t.execute("a", { id: doc.docId, ops: [{ quote: "New document", replacement: "one" }] }), t.execute("b", { id: doc.docId, ops: [{ quote: "New document", replacement: "two" }] })]);
  assert.deepEqual(order, ["start one", "end one", "start two", "end two"]);
  assert.equal(s.seat.saves.length, 2);
});

test("office_edit takes no baseRevision any more, and refuses nothing as revision_mismatch", () => {
  const s = setup();
  const edit = tool(s, "office_edit");
  assert.deepEqual(edit.parameters.required, ["id", "ops"]);
  assert.equal(edit.parameters.properties.baseRevision, undefined);
  for (const name of ["office_list", "office_read", "office_edit", "office_create"]) assert.doesNotMatch(JSON.stringify(tool(s, name)), /baseRevision|revision_mismatch/, name);
});

test("office_list: people editing and agents in a document, apart", async () => {
  const s = setup();
  const doc = await createDoc({ title: "Busy", type: "word", owner: "/f/atlas" }, s.root);
  nameAgent("agent:abc", "Research (agent)");
  setSession(doc.docId, "k", ["portal-user", "agent:abc"]);
  setUser(doc.docId, { id: "portal-user", name: "Portal" }, true, { confirmed: true });
  setUser(doc.docId, { id: "agent:abc" }, true, { confirmed: true });
  const listed = (await tool(s, "office_list").execute("l", {})) as ToolResult;
  assert.match(listed.content[0].text, /"Busy".*  1 editing now  agents in it: Research \(agent\)/);
  assert.deepEqual(listed.details.documents[0].agents, ["Research (agent)"]);
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

test("office_read of the saved copy whose text part inflates past the cap (600 MiB from 600 KB): refused before it is inflated, the portal's memory untouched", async () => {
  const s = setup();
  s.office.state = "stopped";
  const doc = await createDoc({ title: "Bomb", type: "word", owner: "/f/atlas" }, s.root);
  const file = path.join(s.root, "docs", doc.docId, "Bomb.docx");
  fs.writeFileSync(file, bombDocx(600));
  bumpRevision(s.root, doc.docId, Date.now() - 1000);
  const peak = process.resourceUsage().maxRSS; // KiB
  const msg = await refused(tool(s, "office_read").execute("b", { id: doc.docId }), "bomb");
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
  assert.match(await refused(tool(s, "office_edit").execute("x3", { id: doc.docId, ops: [] }), "empty ops"), /^error:bad_op /);
  s.seat.answer = () => Promise.reject(new SeatError("behind", "the document's file changed outside the editor"));
  assert.match(await refused(tool(s, "office_read").execute("x6", { id: doc.docId }), "behind"), /^error:behind /);
  s.seat.answer = () => Promise.reject(new Error("something unexpected"));
  assert.match(await refused(tool(s, "office_read").execute("x7", { id: doc.docId }), "failed"), /^error:failed /);
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
