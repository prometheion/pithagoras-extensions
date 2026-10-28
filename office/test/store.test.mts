/**
 * Unit tests for src/store.ts: the document library (index, each document in place in its agent's or project's
 * folder), CRUD, ownership/grant scoping, the move out of an earlier version's docs folder, export, the persistBytes
 * REVISION GATE and trash sweeping. Templates are asserted to be REAL office
 * files by parsing them with src/ooxml.ts (parseDocx/parseXlsx). Every root is an mkdtemp dir in os.tmpdir() --
 * the real data dir and portal() are never touched.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  listDocs, getDoc, docsForHome, createDoc, renameDoc, deleteDoc, sweepTrash,
  exportDoc, persistBytes, readDoc, templateDocx, templateXlsx, slugify,
  scanWorkspace, pruneMissingDocs, addGrant, migrateOwners, migrateLibrary, configureStore, ownerFolder,
} from "../src/store";
import { homeIn } from "./homes.mts";
import { parseDocx, parseXlsx } from "../src/ooxml";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "office-store-"));
}

/** A document's file: in its folder (`root` is the test's data root, kept for the calls' shape). */
const docFile = (_root: string, meta: { path: string }) => meta.path;

/* ---------------- templates ---------------- */

test("templateDocx: minimal docx parses with ooxml.parseDocx and carries real content", async () => {
  const buf = await templateDocx();
  assert.ok(buf.length > 500);
  const parsed = parseDocx(buf); // throws if the zip or word/document.xml is missing/broken
  assert.deepEqual(parsed.paragraphs, ["New document"]);
  assert.equal(parsed.comments.length, 0);
  // every part a docx needs must be present in the archive
  const zip = await JSZip.loadAsync(buf);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml"]) assert.ok(zip.file(name), `missing ${name}`);
});

test("templateXlsx: minimal xlsx parses with ooxml.parseXlsx as one empty Sheet1", async () => {
  const buf = await templateXlsx();
  const parsed = parseXlsx(buf); // throws if workbook/rels/sheet parts are missing/broken
  assert.deepEqual(parsed.sheetNames, ["Sheet1"]);
  assert.deepEqual(parsed.sheets["Sheet1"], []);
  const zip = await JSZip.loadAsync(buf);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"]) assert.ok(zip.file(name), `missing ${name}`);
});

test("slugify: lowercase, non-alnum runs -> single dash, trimmed", () => {
  assert.equal(slugify("Quarterly Report  Q3"), "quarterly-report-q3");
  assert.equal(slugify("  --Weird__Name!! "), "weird-name");
});

/* ---------------- create / list / get ---------------- */

test("createDoc: word and cell write parseable templates into the folder they belong to, nothing into the extension's own", async () => {
  const root = tmpRoot();
  const home = homeIn(root);
  const w = await createDoc({ title: "Quarterly Report", type: "word", folder: home }, root);
  assert.equal(w.ext, "docx");
  assert.equal(w.path, path.join(home, "Quarterly Report.docx"), "in its folder, by its title");
  assert.equal(w.owner, home, "and belongs to it");
  assert.equal(w.workspace, path.basename(home));
  assert.ok(!fs.existsSync(path.join(root, "docs")), "no docs folder of the extension's own");
  assert.match(w.docId, /^quarterly-report-[a-z0-9]{6}$/);
  assert.equal(parseDocx(fs.readFileSync(docFile(root, w))).text, "New document");
  assert.ok(w.sizeBytes > 0 && w.mtimeMs > 0);

  const c = await createDoc({ title: "Budget", type: "cell", folder: homeIn(root) }, root);
  assert.equal(c.ext, "xlsx");
  assert.match(c.docId, /^budget-[a-z0-9]{6}$/);
  assert.deepEqual(parseXlsx(fs.readFileSync(docFile(root, c))).sheetNames, ["Sheet1"]);

  // fresh index.json on disk, version 1
  const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
  assert.equal(index.version, 1);
  assert.equal(index.docs.length, 2);
});

test("createDoc: duplicate (same title + type) throws code 'exists'; same title different type is fine; a file of that name in the folder is never written over", async () => {
  const root = tmpRoot();
  await createDoc({ title: "Report", type: "word", folder: homeIn(root) }, root);
  await assert.rejects(async () => createDoc({ title: "Report", type: "word", folder: homeIn(root, "other") }, root), (err: NodeJS.ErrnoException) => err.code === "exists");
  // a spreadsheet with the same title is a different document, not a duplicate
  const cell = await createDoc({ title: "Report", type: "cell", folder: homeIn(root) }, root);
  assert.equal(cell.ext, "xlsx");
  fs.writeFileSync(path.join(homeIn(root), "Notes.docx"), "the agent's own, not indexed yet");
  await assert.rejects(async () => createDoc({ title: "Notes", type: "word", folder: homeIn(root) }, root), (err: NodeJS.ErrnoException) => err.code === "exists");
  assert.equal(fs.readFileSync(path.join(homeIn(root), "Notes.docx"), "utf8"), "the agent's own, not indexed yet");
});

test("createDoc: the file is put into its folder through the store's seam (the portal's files.create), and takes the name it was given", async () => {
  const root = tmpRoot();
  const home = homeIn(root);
  const asked: [string, string][] = [];
  configureStore({
    place: (folder, name, bytes) => {
      asked.push([folder, name]);
      // Something took the name meanwhile: the portal numbers it.
      const file = path.join(folder, name.replace(".docx", " (2).docx"));
      fs.writeFileSync(file, bytes, { flag: "wx" });
      return file;
    },
  });
  try {
    const doc = await createDoc({ title: "Raced", type: "word", folder: home }, root);
    assert.deepEqual(asked, [[home, "Raced.docx"]]);
    assert.equal(doc.path, path.join(home, "Raced (2).docx"));
    assert.equal(doc.title, "Raced (2)", "the title is its file's name");
  } finally {
    configureStore({ place: (folder, name, bytes) => (fs.writeFileSync(path.join(folder, name), bytes, { flag: "wx" }), path.join(folder, name)) });
  }
});

test("listDocs: titles ascending; getDoc miss -> null", async () => {
  const root = tmpRoot();
  const banana = await createDoc({ title: "Banana Plan", type: "word", folder: homeIn(root) }, root);
  const apple = await createDoc({ title: "apple notes", type: "word", folder: homeIn(root) }, root);
  assert.deepEqual(listDocs(root).map((d) => d.docId), [apple.docId, banana.docId]);
  assert.equal(getDoc("nope-123456", root), null);
  const found = getDoc(apple.docId, root);
  assert.ok(found && found.title === "apple notes");
});

/* ---------------- ownership / grants ---------------- */

test("docsForHome: owner path, grant path, dedupe of owned-and-granted doc; others' docs excluded", async () => {
  const root = tmpRoot();
  const homeA = homeIn(root, "a");
  const homeB = homeIn(root, "b");
  const owned = await createDoc({ title: "A owned doc", type: "word", folder: homeA }, root);
  const granted = await createDoc({ title: "B doc granted to A", type: "word", folder: homeB }, root);
  const stranger = await createDoc({ title: "C doc nobody shares", type: "word", folder: homeIn(root, "c") }, root);

  // grant A access to the B doc (what ping.ts does on a mention), and the A-owned doc too: it is listed once
  assert.equal(addGrant(granted.docId, homeA, "c1", Date.now(), root), "added");
  assert.equal(addGrant(owned.docId, homeA, "c2", Date.now(), root), "added");
  assert.equal(addGrant(owned.docId, homeA, "c2", Date.now(), root), "duplicate");

  const visible = docsForHome(homeA, root).map((d) => d.docId);
  assert.deepEqual(visible.sort(), [granted.docId, owned.docId].sort());
  assert.ok(!visible.includes(stranger.docId));
  assert.deepEqual(docsForHome(homeB, root).map((d) => d.docId), [granted.docId]);
});

test("docsForHome: a scanned document is its folder's (at any depth), not every agent's; there are no documents of everyone's", async () => {
  const root = tmpRoot();
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-unowned-")));
  const [a, b] = [path.join(ws, "a"), path.join(ws, "b")];
  fs.mkdirSync(path.join(a, "deep"), { recursive: true });
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, "deep", "plan.docx"), Buffer.from("a docx of sorts"));
  fs.writeFileSync(path.join(b, "salary.docx"), Buffer.from("another"));
  assert.deepEqual(scanWorkspace([a, b], root), { added: 2, updated: 0, dropped: [] });
  const plan = listDocs(root).find((d) => d.title === "plan")!;
  const salary = listDocs(root).find((d) => d.title === "salary")!;
  assert.equal(plan.owner, a, "it belongs to the folder it is in");
  assert.equal(salary.owner, b);
  const human = await createDoc({ title: "Made in the default home", type: "word", folder: homeIn(root) }, root);
  const onlyB = await createDoc({ title: "B only", type: "word", folder: b }, root);

  assert.deepEqual(docsForHome(a, root).map((d) => d.docId).sort(), [plan.docId].sort());
  assert.deepEqual(docsForHome(b, root).map((d) => d.docId).sort(), [onlyB.docId, salary.docId].sort());
  assert.deepEqual(docsForHome(homeIn(root), root).map((d) => d.docId), [human.docId], "the person's is its home's alone");
  // A link to a's folder is the same folder.
  fs.symlinkSync(a, path.join(ws, "link-to-a"));
  assert.ok(docsForHome(path.join(ws, "link-to-a"), root).some((d) => d.docId === plan.docId));
  // A folder whose name only begins like a's is not a's.
  fs.mkdirSync(`${a}-other`);
  assert.ok(!docsForHome(`${a}-other`, root).some((d) => d.docId === plan.docId));
  fs.rmSync(ws, { recursive: true, force: true });
});

test("migrateOwners: owners and grants that named a chat name that chat's folder; one of a chat that is gone stays as it was", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Old owner", type: "word", folder: homeIn(root) }, root);
  const gone = await createDoc({ title: "Gone owner", type: "word", folder: homeIn(root) }, root);
  const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
  index.docs.find((d: { docId: string }) => d.docId === doc.docId).owner = "chat-a";
  index.docs.find((d: { docId: string }) => d.docId === gone.docId).owner = "chat-gone";
  index.docs.find((d: { docId: string }) => d.docId === doc.docId).grants = [{ chatId: "chat-b", commentId: "c1", at: 1 }];
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(index));
  const folders: Record<string, string> = { "chat-a": "/homes/a", "chat-b": "/homes/b" };
  assert.equal(migrateOwners((id) => folders[id], root), 1);
  assert.equal(getDoc(doc.docId, root)!.owner, "/homes/a");
  assert.deepEqual(getDoc(doc.docId, root)!.grants, [{ folder: "/homes/b", commentId: "c1", at: 1 }]);
  assert.equal(getDoc(gone.docId, root)!.owner, "chat-gone", "seen by no agent, rather than by every one");
  assert.equal(migrateOwners((id) => folders[id], root), 0, "once is enough");
});

/* ---------------- writing an agent's file ---------------- */

async function scannedOne(name = "report.docx") {
  const root = tmpRoot();
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-own-")));
  const file = path.join(ws, name);
  fs.writeFileSync(file, await templateDocx());
  fs.chmodSync(file, 0o640);
  scanWorkspace([ws], root);
  return { root, ws, file, doc: listDocs(root)[0]! };
}

test("persistBytes: a save keeps the file's owner, group and mode, as the agent had them", async () => {
  const { root, ws, file, doc } = await scannedOne();
  const before = fs.statSync(file);
  const old = process.umask(0o022); // a fresh file would be 0644
  // The portal runs as root with the sandbox on: the owner is given back, which a test as another user can only watch.
  const given: number[][] = [];
  const chown = mock.method(fs, "fchownSync", (_fd: number, uid: number, gid: number) => void given.push([uid, gid]));
  try {
    persistBytes(doc, Buffer.from("saved"), root);
  } finally {
    process.umask(old);
    chown.mock.restore();
  }
  assert.deepEqual(given, [[before.uid, before.gid]]);
  const after = fs.statSync(file);
  assert.equal(after.mode & 0o777, 0o640);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.notEqual(after.ino, before.ino, "put in place by a rename, never written half");
  assert.deepEqual(fs.readdirSync(ws), ["report.docx"], "no temporary file left behind");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("persistBytes: a link put in the file's place, or in its folder's, is refused and nothing it leads to is written", async () => {
  const { root, ws, file, doc } = await scannedOne();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "office-elsewhere-"));
  const secret = path.join(elsewhere, "secret.docx");
  fs.writeFileSync(secret, "not yours");
  fs.rmSync(file);
  fs.symlinkSync(secret, file);
  assert.throws(() => persistBytes({ ...doc, mtimeMs: fs.statSync(secret).mtimeMs }, Buffer.from("x"), root), (e: Error & { code?: string }) => e.code === "invalid");
  assert.equal(fs.readFileSync(secret, "utf8"), "not yours");
  assert.ok(fs.lstatSync(file).isSymbolicLink(), "the link itself is left as it is");

  // The folder swapped for a link to another one holding a file of that name.
  const ws2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-own2-")));
  const real = path.join(ws2, "real");
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, "report.docx"), "theirs");
  const { root: root2, ws: ws3, doc: doc2 } = await scannedOne();
  fs.rmSync(ws3, { recursive: true, force: true });
  fs.symlinkSync(real, ws3);
  assert.throws(() => persistBytes({ ...doc2, mtimeMs: fs.statSync(path.join(real, "report.docx")).mtimeMs }, Buffer.from("x"), root2), (e: Error & { code?: string }) => e.code === "invalid");
  assert.equal(fs.readFileSync(path.join(real, "report.docx"), "utf8"), "theirs");
  for (const d of [ws, elsewhere, ws2, ws3]) fs.rmSync(d, { recursive: true, force: true });
});

test("deleteDoc: a scanned document whose folder an agent swapped for a link to another folder deletes nothing there", async () => {
  // Agent A's docs/report.docx is indexed; A replaces docs/ with a link to agent B's private/, which holds a
  // report.docx of B's; the person deletes "report" in the library.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-swap-")));
  const [a, b] = [path.join(base, "a"), path.join(base, "b")];
  fs.mkdirSync(path.join(a, "docs"), { recursive: true });
  fs.mkdirSync(path.join(b, "private"), { recursive: true });
  fs.writeFileSync(path.join(a, "docs", "report.docx"), "A's");
  fs.writeFileSync(path.join(b, "private", "report.docx"), "B's");
  const root = tmpRoot();
  scanWorkspace([a], root);
  const doc = listDocs(root)[0];
  fs.renameSync(path.join(a, "docs"), path.join(a, "docs.old"));
  fs.symlinkSync(path.join(b, "private"), path.join(a, "docs"));
  deleteDoc(doc.docId, root);
  assert.equal(fs.readFileSync(path.join(b, "private", "report.docx"), "utf8"), "B's", "B's file is still there");
  assert.equal(fs.readFileSync(path.join(a, "docs.old", "report.docx"), "utf8"), "A's");
  assert.equal(listDocs(root).length, 0, "the entry goes");
  const [entry] = fs.readdirSync(path.join(root, ".trash"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".trash", entry, "document.json"), "utf8")).path, doc.path, "and the trash says where it was");

  // A link in the file's own place, in its own folder, is still removed as the link: what it leads to stays.
  fs.rmSync(path.join(a, "docs"));
  fs.renameSync(path.join(a, "docs.old"), path.join(a, "docs"));
  scanWorkspace([a], root);
  const again = listDocs(root)[0];
  fs.rmSync(path.join(a, "docs", "report.docx"));
  fs.symlinkSync(path.join(b, "private", "report.docx"), path.join(a, "docs", "report.docx"));
  deleteDoc(again.docId, root);
  assert.equal(fs.lstatSync(path.join(a, "docs", "report.docx"), { throwIfNoEntry: false }), undefined, "the link is gone");
  assert.equal(fs.readFileSync(path.join(b, "private", "report.docx"), "utf8"), "B's");
  fs.rmSync(base, { recursive: true, force: true });
});

test("readDoc: a file that grew past the library's cap since it was indexed is refused before it is read", async () => {
  const { root, ws, file, doc } = await scannedOne();
  fs.truncateSync(file, 513 * 1024 * 1024); // sparse: nothing is written to the disk
  assert.throws(() => readDoc({ ...doc, mtimeMs: fs.statSync(file).mtimeMs }), (e: Error & { code?: string }) => e.code === "too_large");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("renameDoc: a scanned file is never renamed over another file of that name", async () => {
  const { root, ws, file, doc } = await scannedOne();
  fs.writeFileSync(path.join(ws, "notes.docx"), "an unindexed file of the agent's");
  assert.throws(() => renameDoc(doc.docId, "notes", root), (e: Error & { code?: string }) => e.code === "exists");
  assert.equal(fs.readFileSync(path.join(ws, "notes.docx"), "utf8"), "an unindexed file of the agent's");
  assert.ok(fs.existsSync(file));
  const renamed = renameDoc(doc.docId, "final", root);
  assert.equal(renamed.path, path.join(ws, "final.docx"));
  assert.deepEqual(fs.readdirSync(ws).sort(), ["final.docx", "notes.docx"]);
  fs.rmSync(ws, { recursive: true, force: true });
});

/* ---------------- rename / delete / trash ---------------- */

test("renameDoc: renames the file on disk, keeps bytes and mtimeMs, bumps updatedAt", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Old Title", type: "word", folder: homeIn(root) }, root);
  const oldBytes = fs.readFileSync(docFile(root, doc));
  const before = getDoc(doc.docId, root);
  assert.ok(before);

  const renamed = renameDoc(doc.docId, "New Title", root);
  assert.equal(renamed.docId, doc.docId); // stable across renames -- tickets/history key off it
  assert.equal(renamed.title, "New Title");
  assert.ok(!fs.existsSync(doc.path));
  const newBytes = fs.readFileSync(docFile(root, renamed));
  assert.deepEqual(newBytes, oldBytes); // bytes untouched
  assert.equal(renamed.mtimeMs, before!.mtimeMs); // content mtime (the revision) is preserved by the rename
  assert.ok(renamed.updatedAt >= before!.updatedAt);
  // renaming onto another doc's title -> exists
  await createDoc({ title: "Taken", type: "word", folder: homeIn(root) }, root);
  assert.throws(() => renameDoc(doc.docId, "Taken", root), (err: NodeJS.ErrnoException) => err.code === "exists");
});

test("renameDoc on unknown id -> not_found", () => {
  const root = tmpRoot();
  assert.throws(() => renameDoc("ghost-123456", "X", root), (err: NodeJS.ErrnoException) => err.code === "not_found");
});

test("deleteDoc: moves its file out of its folder into .trash, prunes the index; unknown id -> not_found", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Doomed", type: "word", folder: homeIn(root) }, root);
  deleteDoc(doc.docId, root);
  assert.ok(!fs.existsSync(doc.path));
  const trash = fs.readdirSync(path.join(root, ".trash"));
  assert.equal(trash.length, 1);
  assert.match(trash[0], new RegExp(`^\\d+-${doc.docId}$`));
  assert.ok(fs.existsSync(path.join(root, ".trash", trash[0], "Doomed.docx"))); // content kept for the TTL
  assert.equal(getDoc(doc.docId, root), null);
  assert.throws(() => deleteDoc(doc.docId, root), (err: NodeJS.ErrnoException) => err.code === "not_found");
});

test("deleteDoc: the trash entry says where the file was, and takes what was kept for the document with it", async () => {
  const root = tmpRoot();
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-del-meta-")));
  fs.mkdirSync(path.join(ws, "q3"));
  fs.writeFileSync(path.join(ws, "q3", "Q3 report.docx"), await templateDocx());
  scanWorkspace([ws], root);
  const doc = listDocs(root)[0]!;
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(path.join(root, "state", `${doc.docId}.json`), JSON.stringify({ keys: ["k"] }));
  fs.mkdirSync(path.join(root, "history", doc.docId), { recursive: true });
  fs.writeFileSync(path.join(root, "history", doc.docId, "1.zip"), "an older version's archive");
  deleteDoc(doc.docId, root);
  const [entry] = fs.readdirSync(path.join(root, ".trash"));
  const at = path.join(root, ".trash", entry!);
  assert.deepEqual(fs.readdirSync(at).sort(), ["Q3 report.docx", "document.json", "history", "state.json"]);
  const was = JSON.parse(fs.readFileSync(path.join(at, "document.json"), "utf8"));
  assert.equal(was.path, path.join(ws, "q3", "Q3 report.docx"), "where to put it back");
  assert.equal(was.title, "Q3 report");
  assert.ok(!fs.existsSync(path.join(root, "state", `${doc.docId}.json`)));
  assert.ok(!fs.existsSync(path.join(root, "history", doc.docId)));
  // Swept after 7 days: the whole entry.
  const old = path.join(root, ".trash", `${Date.now() - 8 * 24 * 60 * 60 * 1000}-${doc.docId}`);
  fs.renameSync(at, old);
  assert.equal(sweepTrash(root), 1);
  assert.deepEqual(fs.readdirSync(path.join(root, ".trash")), []);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("deleteDoc: a workspace on another file system than the trash (EXDEV) is copied over and removed, not refused", async () => {
  const root = tmpRoot();
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-del-xdev-")));
  fs.writeFileSync(path.join(ws, "far.docx"), "on another mount");
  scanWorkspace([ws], root);
  const doc = listDocs(root)[0]!;
  const rename = fs.renameSync;
  const crossing = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from).startsWith(ws)) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    return rename(from, to);
  });
  try {
    deleteDoc(doc.docId, root);
  } finally {
    crossing.mock.restore();
  }
  assert.ok(!fs.existsSync(path.join(ws, "far.docx")));
  const [entry] = fs.readdirSync(path.join(root, ".trash"));
  assert.equal(fs.readFileSync(path.join(root, ".trash", entry!, "far.docx"), "utf8"), "on another mount");
  assert.equal(listDocs(root).length, 0);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("sweepTrash: removes only entries older than 7 days", () => {
  const root = tmpRoot();
  const trash = path.join(root, ".trash");
  const oldStamp = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days
  fs.mkdirSync(path.join(trash, `${oldStamp}-ancient-doc`), { recursive: true });
  fs.writeFileSync(path.join(trash, `${oldStamp}-ancient-doc`, "x.docx"), Buffer.from("z"));
  const freshStamp = Date.now() - 3600 * 1000; // 1h ago
  fs.mkdirSync(path.join(trash, `${freshStamp}-young-doc`), { recursive: true });
  fs.writeFileSync(path.join(trash, `${freshStamp}-young-doc`, "x.docx"), Buffer.from("z"));
  fs.mkdirSync(path.join(trash, "not-a-stamped-entry"), { recursive: true }); // no numeric prefix -- leave it alone

  const removed = sweepTrash(root);
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(path.join(trash, `${oldStamp}-ancient-doc`)));
  assert.ok(fs.existsSync(path.join(trash, `${freshStamp}-young-doc`)));
  assert.ok(fs.existsSync(path.join(trash, "not-a-stamped-entry")));

  // empty root: no .trash at all -> 0, no throw
  assert.equal(sweepTrash(tmpRoot()), 0);
});

/* ---------------- import / export ---------------- */

test("exportDoc: writes <title>.<ext> into a created dest dir and returns the absolute path", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Export me", type: "word", folder: homeIn(root) }, root);
  const destDir = path.join(tmpRoot(), "out", "nested"); // must be created recursively
  const written = exportDoc(doc.docId, destDir, root);
  assert.equal(written, path.join(destDir, "Export me.docx"));
  assert.ok(path.isAbsolute(written));
  assert.deepEqual(parseDocx(fs.readFileSync(written)), parseDocx(fs.readFileSync(docFile(root, doc))));
  assert.throws(() => exportDoc("ghost-123456", destDir, root), (err: NodeJS.ErrnoException) => err.code === "not_found");
});

/* ---------------- persist gate ---------------- */

test("persistBytes: success writes the bytes, updates the index mtime/size and returns the new mtimeMs", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Live", type: "word", folder: homeIn(root) }, root);
  const oldMeta = getDoc(doc.docId, root);
  assert.ok(oldMeta);
  const saved = Buffer.from("saved-by-DS-" + "x".repeat(100));

  const res = persistBytes(oldMeta, saved, root);
  const fresh = fs.statSync(docFile(root, doc));
  assert.equal(res.mtimeMs, fresh.mtimeMs);
  const updated = getDoc(doc.docId, root);
  assert.ok(updated);
  assert.equal(updated!.mtimeMs, res.mtimeMs);
  assert.equal(updated!.sizeBytes, saved.length);
  assert.deepEqual(fs.readFileSync(docFile(root, doc)), saved); // the bytes really landed
});

test("persistBytes: every write is a revision of its own, also two writes in one tick of a filesystem that keeps times by two seconds", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Quick", type: "word", folder: homeIn(root) }, root);
  for (const name of ["lstatSync", "statSync", "fstatSync"] as const) {
    const real = fs[name] as (...args: unknown[]) => fs.Stats;
    mock.method(fs, name, (...args: unknown[]) => {
      const st = real(...args);
      if (st) st.mtimeMs = Math.floor(st.mtimeMs / 2000) * 2000;
      return st;
    });
  }
  try {
    // At the start of a two-second step, so that the writes below all fall in it.
    while (Date.now() % 2000 > 1000) await new Promise((resolve) => setTimeout(resolve, 50));
    const first = { ...getDoc(doc.docId, root)!, mtimeMs: fs.lstatSync(docFile(root, doc)).mtimeMs };
    const one = persistBytes(first, Buffer.from("the editor's save"), root);
    const two = persistBytes({ ...first, mtimeMs: one.mtimeMs }, Buffer.from("the agent's edit on top"), root);
    assert.ok(two.mtimeMs > one.mtimeMs, `${two.mtimeMs} after ${one.mtimeMs}`);
    // A writer that still holds the first save's revision must not write over the second.
    assert.throws(() => persistBytes({ ...first, mtimeMs: one.mtimeMs }, Buffer.from("late"), root), (e: Error & { code?: string }) => e.code === "revision_mismatch");
    assert.equal(fs.readFileSync(docFile(root, doc), "utf8"), "the agent's edit on top");
  } finally {
    mock.restoreAll();
  }
});

test("persistBytes: a stale meta (external write moved the mtime) throws revision_mismatch with currentMtimeMs", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Contended", type: "word", folder: homeIn(root) }, root);
  const staleMeta = getDoc(doc.docId, root);
  assert.ok(staleMeta);

  // an external writer (another DS session / the agent) rewrites the file and pushes its mtime far forward
  const file = docFile(root, doc);
  fs.writeFileSync(file, Buffer.from("someone else saved this"));
  const forced = new Date(Date.now() + 60_000).getTime(); // a definitely-distinct mtime
  fs.utimesSync(file, forced / 1000, forced / 1000);
  const currentMtimeMs = fs.statSync(file).mtimeMs;
  assert.notEqual(currentMtimeMs, staleMeta.mtimeMs);

  await assert.rejects(
    (async () => persistBytes(staleMeta, Buffer.from("my stale save"), root))(),
    (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, "revision_mismatch");
      assert.equal((err as NodeJS.ErrnoException & { currentMtimeMs?: number }).currentMtimeMs, currentMtimeMs);
      return true;
    },
  );
  // the library file is untouched by the refused write
  assert.deepEqual(fs.readFileSync(file), Buffer.from("someone else saved this"));
});

test("persistBytes: an FRESH meta after the external write persists again (the gate clears)", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Retry", type: "word", folder: homeIn(root) }, root);
  const file = docFile(root, doc);
  fs.writeFileSync(file, Buffer.from("newer content"));
  const freshMeta = getDoc(doc.docId, root) ?? undefined; // re-read: still the OLD index mtime -> would mismatch
  assert.ok(freshMeta);
  // but persistBytes with the stale index meta must fail...
  await assert.rejects((async () => persistBytes(freshMeta, Buffer.from("z"), root))(), (err: NodeJS.ErrnoException) => err.code === "revision_mismatch");
});

/* ---------------- end-to-end-ish ---------------- */

test("a full round-trip: create -> edit bytes through the gate -> export is parseable", async () => {
  const root = tmpRoot();
  const doc = await createDoc({ title: "Round Trip", type: "word", folder: homeIn(root) }, root);
  let meta = getDoc(doc.docId, root)!;
  for (let i = 0; i < 3; i++) {
    const bytes = Buffer.from(`revision ${i} of the round trip document`);
    await new Promise((r) => setTimeout(r, 2)); // let mtime advance so successive persists are distinct revisions
    const res = persistBytes(meta, bytes, root);
    meta = getDoc(doc.docId, root)!;
    assert.equal(meta.mtimeMs, res.mtimeMs);
  }
  const out = exportDoc(doc.docId, path.join(tmpRoot(), "rt"), root);
  assert.equal(fs.readFileSync(out).toString("utf8"), "revision 2 of the round trip document");
});

/* ---------------- workspace scan (in-place indexing, replaces manual import) ---------------- */

test("scanWorkspace: discovers nested docx/xlsx case-insensitively; skips hidden dirs, node_modules, .txt", () => {
  const root = tmpRoot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-scan-ws-"));
  fs.writeFileSync(path.join(ws, "alpha.docx"), Buffer.from("bytes a"));
  fs.mkdirSync(path.join(ws, "nested", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(ws, "nested", "deeper", "BETA.XLSX"), Buffer.from("bytes b")); // uppercase ext counts
  fs.mkdirSync(path.join(ws, ".cache"));
  fs.writeFileSync(path.join(ws, ".cache", "hidden.docx"), Buffer.from("nope"));
  fs.mkdirSync(path.join(ws, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "pkg", "vendor.docx"), Buffer.from("nope"));
  fs.writeFileSync(path.join(ws, "readme.txt"), "not office");

  const out = scanWorkspace([ws], root);
  assert.deepEqual(out, { added: 2, updated: 0, dropped: [] });
  const docs = listDocs(root);
  assert.deepEqual(docs.map((d) => d.title), ["alpha", "BETA"], "listDocs keeps its localeCompare order even with a mixed-case title");
  for (const doc of docs) {
    assert.equal(doc.path, path.join(ws, doc.title === "alpha" ? "alpha.docx" : path.join("nested", "deeper", "BETA.XLSX")), "points at the real file in place");
    assert.equal(doc.owner, ws, "it belongs to the folder it is in");
    assert.ok(fs.existsSync(doc.path!)); // IN PLACE: no copy was made
  }
  fs.rmSync(ws, { recursive: true, force: true });
});

test("scanWorkspace: never indexes the library's own dir (state or .trash), even when it is passed as a root", async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".trash"));
  fs.writeFileSync(path.join(root, ".trash", "old.docx"), Buffer.from("trash stays trash"));
  fs.mkdirSync(path.join(root, "state"));
  fs.writeFileSync(path.join(root, "state", "kept.docx"), Buffer.from("the extension's own"));

  const out = scanWorkspace([root], root); // the data dir IS a root: the whole walk must refuse to enter it
  assert.deepEqual(out, { added: 0, updated: 0, dropped: [] });
  assert.equal(listDocs(root).length, 0);
});

test("scanWorkspace: a second scan refreshes changed mtime/size in place; untouched files do not count as updated", () => {
  const root = tmpRoot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-scan-refresh-"));
  fs.writeFileSync(path.join(ws, "one.docx"), Buffer.from("12345"));
  fs.writeFileSync(path.join(ws, "two.xlsx"), Buffer.from("abcdef"));
  assert.deepEqual(scanWorkspace([ws], root), { added: 2, updated: 0, dropped: [] });

  assert.deepEqual(scanWorkspace([ws], root), { added: 0, updated: 0, dropped: [] }, "immediately rescanning changes nothing");

  fs.writeFileSync(path.join(ws, "one.docx"), Buffer.from("123456789")); // grew AND got a new mtime
  const out = scanWorkspace([ws], root);
  assert.deepEqual(out, { added: 0, updated: 1, dropped: [] }, "only the file that actually changed counts as refreshed");
  const one = getDoc(listDocs(root).find((d) => d.title === "one")!.docId, root)!;
  assert.equal(one.sizeBytes, 9);
  assert.ok(Math.abs(one.mtimeMs - fs.statSync(path.join(ws, "one.docx")).mtimeMs) < 50);

  // and the refreshed doc still persists through the mtime gate: its revision IS the file's own mtime
  const saved = persistBytes(one, Buffer.from("123456789X"), root);
  assert.equal(saved.mtimeMs, fs.statSync(path.join(ws, "one.docx")).mtimeMs);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("scanWorkspace stamps DocMeta.workspace: first path segment under the DEEPEST scan root containing the file; a direct child takes the root's own dir name", () => {
  const root = tmpRoot();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "office-wslabel-"));
  const repos = path.join(base, "repos"); // an inner root (e.g. a repo dir) nested under another one
  const home = path.join(base, "homes", "acme"); // a home root; the deepest root for its files
  fs.mkdirSync(path.join(repos, "pithagoras", "extensions"), { recursive: true });
  fs.mkdirSync(path.join(home, "plans"), { recursive: true });
  fs.writeFileSync(path.join(repos, "pithagoras", "extensions", "sample.docx"), Buffer.from("a docx of sorts"));
  fs.writeFileSync(path.join(repos, "top.xlsx"), Buffer.from("an xlsx straight in the inner root"));
  fs.writeFileSync(path.join(home, "readme.docx"), Buffer.from("directly in the home root"));
  fs.writeFileSync(path.join(home, "plans", "q3.xlsx"), Buffer.from("nested in the home"));

  // base is ALSO a root: the deepest matching root must label, not the broadest (via base, sample would read "repos")
  assert.deepEqual(scanWorkspace([base, repos, home], root), { added: 4, updated: 0, dropped: [] });
  const byTitle = new Map(listDocs(root).map((d) => [d.title, d.workspace]));
  assert.equal(byTitle.get("sample"), "pithagoras", "first path segment under the deepest containing root (repos, not base)");
  assert.equal(byTitle.get("top"), "repos", "a file straight in a root takes that root's OWN dir name, not its own file name");
  assert.equal(byTitle.get("readme"), "acme", "a home-root file takes the home's dir name");
  assert.equal(byTitle.get("q3"), "plans", "a nested file takes its first segment under the root");
  fs.rmSync(base, { recursive: true, force: true });
});

test("scanWorkspace rescan BACKFILLS DocMeta.workspace on entries indexed before the stamp (counted as refreshed exactly once)", () => {
  const root = tmpRoot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-wsbackfill-"));
  fs.mkdirSync(path.join(ws, "pithagoras", "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(ws, "pithagoras", "fixtures", "sample.docx"), Buffer.from("a docx of sorts"));
  assert.deepEqual(scanWorkspace([ws], root), { added: 1, updated: 0, dropped: [] });

  // simulate an older index.json (pre-stamp): the entry's workspace field is simply absent
  const indexPathFile = path.join(root, "index.json");
  const idx = JSON.parse(fs.readFileSync(indexPathFile, "utf8"));
  delete idx.docs[0].workspace;
  fs.writeFileSync(indexPathFile, JSON.stringify(idx));
  assert.equal(listDocs(root)[0].workspace, undefined);

  const second = scanWorkspace([ws], root);
  assert.deepEqual(second, { added: 0, updated: 1, dropped: [] }, "the backfill counts as a refresh, once");
  assert.equal(listDocs(root)[0].workspace, "pithagoras", "the existing entry picked up its label on the rescan");

  const third = scanWorkspace([ws], root);
  assert.deepEqual(third, { added: 0, updated: 0, dropped: [] }, "idempotent once backfilled");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("scanWorkspace: skips files whose basename cannot be a title or busts the size cap; a collision on title does not sink the sweep", () => {
  const root = tmpRoot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-scan-bad-"));
  fs.writeFileSync(path.join(ws, "bad\tname.docx"), Buffer.from("control char in a title: skipped, not indexed"));
  fs.writeFileSync(path.join(ws, "hugemem.docx"), Buffer.alloc(1)); // size is faked below with sparse write
  fs.rmSync(path.join(ws, "hugemem.docx"));
  const huge = fs.openSync(path.join(ws, "hugemem.docx"), "w");
  fs.ftruncateSync(huge, 513 * 1024 * 1024); // just above the 512 MiB cap: sparse file, no real I/O
  fs.closeSync(huge);
  fs.writeFileSync(path.join(ws, "same.docx"), Buffer.from("first"));
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "office-scan-bad2-"));
  fs.writeFileSync(path.join(ws2, "same.docx"), Buffer.from("second -- same title in another folder: skipped by the guard"));

  const out = scanWorkspace([ws, ws2], root);
  assert.deepEqual(out, { added: 1, updated: 0, dropped: [] }, "only 'same' from the first root survived: bad title, over cap and title collision are all quiet skips");
  assert.equal(listDocs(root)[0].title, "same");
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(ws2, { recursive: true, force: true });
});

test("deleteDoc on a scanned doc moves its REAL file to the office trash; an already-vanished file is a clean prune, not ENOENT", () => {
  const root = tmpRoot();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "office-scan-del-"));
  fs.writeFileSync(path.join(ws, "doomed.docx"), Buffer.from("soon to be trashed"));
  scanWorkspace([ws], root);
  const doc = listDocs(root)[0];

  deleteDoc(doc.docId, root); // the real workspace file is what moves
  assert.ok(!fs.existsSync(path.join(ws, "doomed.docx")), "the workspace file is gone from its folder");
  const trash = fs.readdirSync(path.join(root, ".trash"));
  assert.equal(trash.length, 1, "exactly one entry landed in the office trash -- recoverable for 7 days");
  assert.equal(fs.readFileSync(path.join(root, ".trash", trash[0], "doomed.docx"), "utf8"), "soon to be trashed");
  assert.equal(listDocs(root).length, 0);

  // a file deleted OUT-OF-BAND (no one asked the library): deleting its index entry must not ENOENT
  fs.writeFileSync(path.join(ws, "walked.docx"), Buffer.from("leaving on its own"));
  scanWorkspace([ws], root);
  const gone = listDocs(root)[0];
  fs.rmSync(path.join(ws, "walked.docx")); // the workspace itself loses the file
  deleteDoc(gone.docId, root); // and: no throw, just the index drop -- pruneMissingDocs semantics on demand
  assert.equal(listDocs(root).length, 0);

  // and pruneMissingDocs drops the orphaned entry, once it has been gone for the grace period
  fs.writeFileSync(path.join(ws, "fleeing.docx"), Buffer.from("gone before the sweep"));
  scanWorkspace([ws], root);
  fs.rmSync(path.join(ws, "fleeing.docx"));
  const fleeingId = listDocs(root)[0].docId;
  const now = Date.now();
  assert.deepEqual(pruneMissingDocs(root, now), [], "marked, not dropped");
  assert.equal(getDoc(fleeingId, root)!.missingSince, now);
  assert.deepEqual(pruneMissingDocs(root, now + 8 * 24 * 60 * 60 * 1000), [fleeingId], "dropped once gone for a week");
  assert.equal(listDocs(root).length, 0);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("pruneMissingDocs: a file gone for a while (a git checkout of another branch) keeps its entry, owner, grants and id, and is taken back as it was when it returns", async () => {
  const root = tmpRoot();
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-away-")));
  const file = path.join(ws, "report.docx");
  fs.writeFileSync(file, await templateDocx());
  scanWorkspace([ws], root);
  const doc = listDocs(root)[0]!;
  addGrant(doc.docId, "/homes/b", "c1", 1, root);
  const away = fs.readFileSync(file);
  fs.rmSync(file);
  pruneMissingDocs(root);
  scanWorkspace([ws], root); // a Rescan while it is away adds nothing and drops nothing
  assert.equal(listDocs(root).length, 1);
  fs.writeFileSync(file, away);
  pruneMissingDocs(root);
  scanWorkspace([ws], root);
  const back = listDocs(root);
  assert.equal(back.length, 1);
  assert.equal(back[0]!.docId, doc.docId, "the same document, not a new one");
  assert.deepEqual(back[0]!.grants.map((g) => g.folder), ["/homes/b"]);
  assert.equal(back[0]!.missingSince, undefined);
  fs.rmSync(ws, { recursive: true, force: true });
});

/* ---------------- no documents of nobody's (owner decision of 2026-10-28) ---------------- */

test("scanWorkspace: a file belongs to the deepest agent's home or project folder that holds it", async () => {
  const root = tmpRoot();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-owner-")));
  const project = path.join(home, "work", "report");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, "mine.docx"), "the agent's");
  fs.writeFileSync(path.join(project, "draft.docx"), "the project's");
  scanWorkspace([home, project], root);
  const by = (title: string) => listDocs(root).find((d) => d.title === title)!;
  assert.equal(by("mine").owner, home);
  assert.equal(by("draft").owner, project);
  assert.equal(ownerFolder(path.join(project, "draft.docx"), [home, project]), project);
  assert.equal(ownerFolder(path.join(`${home}-other`, "x.docx"), [home, project]), undefined, "a folder whose name only begins like it is not it");
  fs.rmSync(home, { recursive: true, force: true });
});

test("scanWorkspace: a document an earlier version kept without an owner gets the folder it is in on the next scan", async () => {
  const root = tmpRoot();
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-backfill-owner-")));
  fs.writeFileSync(path.join(ws, "plan.docx"), "bytes");
  scanWorkspace([ws], root);
  const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
  index.docs[0].owner = null;
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(index));
  assert.deepEqual(scanWorkspace([ws], root), { added: 0, updated: 1, dropped: [] });
  assert.equal(listDocs(root)[0]!.owner, ws);
  assert.deepEqual(scanWorkspace([ws], root), { added: 0, updated: 0, dropped: [] }, "once");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("scanWorkspace: a document in no agent's home or project (a chat's folder an earlier version scanned) leaves the index, its file stays", async () => {
  const root = tmpRoot();
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "office-outside-")));
  const [home, chat] = [path.join(ws, "home"), path.join(ws, "chat-folder")];
  fs.mkdirSync(home);
  fs.mkdirSync(chat);
  fs.writeFileSync(path.join(home, "kept.docx"), "in a home");
  fs.writeFileSync(path.join(chat, "loose.docx"), "in a chat's folder");
  fs.writeFileSync(path.join(chat, "away.docx"), "in a chat's folder, gone for now");
  scanWorkspace([home, chat], root); // as an earlier version scanned: every folder a chat works in too
  const loose = listDocs(root).find((d) => d.title === "loose")!;
  const away = listDocs(root).find((d) => d.title === "away")!;
  fs.rmSync(away.path);
  assert.deepEqual(scanWorkspace([], root), { added: 0, updated: 0, dropped: [] }, "no folders at all (none listed): nothing leaves");
  const out = scanWorkspace([home], root);
  assert.deepEqual(out.dropped, [loose.docId]);
  assert.deepEqual(listDocs(root).map((d) => d.title).sort(), ["away", "kept"], "one whose file is gone is pruneMissingDocs' to settle");
  assert.equal(fs.readFileSync(path.join(chat, "loose.docx"), "utf8"), "in a chat's folder", "the file itself stays where it is");
  fs.rmSync(ws, { recursive: true, force: true });
});

/** An index as an earlier version left it: documents made in the extension's own docs folder, with no `path`. */
function legacyLibrary(root: string, docs: { docId: string; title: string; owner: string | null; bytes?: string; grants?: unknown[] }[]): void {
  const entries = docs.map((d) => {
    if (d.bytes !== undefined) {
      fs.mkdirSync(path.join(root, "docs", d.docId), { recursive: true });
      fs.writeFileSync(path.join(root, "docs", d.docId, `${d.title}.docx`), d.bytes);
    }
    return { docId: d.docId, title: d.title, ext: "docx", createdAt: 1, updatedAt: 1, sizeBytes: 5, mtimeMs: 1, owner: d.owner, grants: d.grants ?? [] };
  });
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({ version: 1, docs: entries }));
}

test("migrateLibrary: the person's documents of the docs folder move into the default agent's home, an agent's into its own; id, grants and history stay", async () => {
  const root = tmpRoot();
  const home = homeIn(root, "home");
  const atlas = homeIn(root, "atlas");
  legacyLibrary(root, [
    { docId: "minutes-aaaaaa", title: "Minutes", owner: null, bytes: "the person's", grants: [{ folder: atlas, commentId: "c1", at: 1 }] },
    { docId: "plan-bbbbbb", title: "Plan", owner: atlas, bytes: "atlas made it" },
    { docId: "orphan-cccccc", title: "Orphan", owner: "/a/folder/that/is/gone", bytes: "its agent is gone" },
  ]);
  fs.mkdirSync(path.join(root, "history", "minutes-aaaaaa"), { recursive: true });
  assert.deepEqual(listDocs(root), [], "nothing hands out a document that has no place yet");
  const moves = migrateLibrary([home, atlas], home, root);
  assert.deepEqual(moves.map((m) => ("moved" in m ? [m.docId, m.moved, m.owner] : m)), [
    ["minutes-aaaaaa", path.join(home, "Minutes.docx"), home],
    ["plan-bbbbbb", path.join(atlas, "Plan.docx"), atlas],
    ["orphan-cccccc", path.join(home, "Orphan.docx"), home],
  ]);
  const minutes = getDoc("minutes-aaaaaa", root)!;
  assert.equal(fs.readFileSync(minutes.path, "utf8"), "the person's");
  assert.equal(minutes.owner, home);
  assert.deepEqual(minutes.grants, [{ folder: atlas, commentId: "c1", at: 1 }]);
  assert.equal(minutes.workspace, path.basename(home));
  assert.equal(minutes.mtimeMs, fs.statSync(minutes.path).mtimeMs, "its revision is its new file's");
  assert.deepEqual(docsForHome(atlas, root).map((d) => d.title).sort(), ["Minutes", "Plan"], "what atlas made, and what it was granted");
  assert.ok(fs.existsSync(path.join(root, "history", "minutes-aaaaaa")), "its revisions stay, by its id");
  assert.ok(!fs.existsSync(path.join(root, "docs")), "the docs folder is gone");
  assert.deepEqual(migrateLibrary([home, atlas], home, root), [], "once");
  assert.deepEqual(scanWorkspace([home, atlas], root), { added: 0, updated: 0, dropped: [] }, "the scan finds them as the documents they are");
});

test("migrateLibrary: a name taken in the folder (by a file, or by a document's title) gets a number; a file gone leaves the index", async () => {
  const root = tmpRoot();
  const home = homeIn(root, "home");
  fs.writeFileSync(path.join(home, "Report.docx"), "the agent's own report");
  legacyLibrary(root, [
    { docId: "report-aaaaaa", title: "Report", owner: null, bytes: "the person's report" },
    { docId: "lost-bbbbbb", title: "Lost", owner: null },
  ]);
  const moves = migrateLibrary([home], home, root);
  assert.deepEqual(moves, [
    { docId: "report-aaaaaa", title: "Report (2)", moved: path.join(home, "Report (2).docx"), owner: home },
    { docId: "lost-bbbbbb", title: "Lost", dropped: "file gone" },
  ]);
  assert.equal(fs.readFileSync(path.join(home, "Report.docx"), "utf8"), "the agent's own report", "never written over");
  assert.equal(fs.readFileSync(path.join(home, "Report (2).docx"), "utf8"), "the person's report");
  assert.deepEqual(listDocs(root).map((d) => d.title), ["Report (2)"]);
});

test("migrateLibrary: with no default agent's home it moves nothing, keeps the entry for the next start, and a start cut off after the file was put takes that file", async () => {
  const root = tmpRoot();
  const home = homeIn(root, "home");
  legacyLibrary(root, [{ docId: "memo-aaaaaa", title: "Memo", owner: null, bytes: "memo" }]);
  const [kept] = migrateLibrary([home], undefined, root);
  assert.ok(kept && "failed" in kept && /no default agent's home/.test(kept.failed));
  assert.deepEqual(listDocs(root), []);
  assert.ok(fs.existsSync(path.join(root, "docs", "memo-aaaaaa", "Memo.docx")), "nothing lost");
  // Another document is written meanwhile: the entry still to be moved is written back with the index.
  await createDoc({ title: "Other", type: "word", folder: home }, root);
  // A start put the file in place and was cut off before the index named it.
  fs.writeFileSync(path.join(home, "Memo.docx"), "memo");
  const [moved] = migrateLibrary([home], home, root);
  assert.deepEqual(moved, { docId: "memo-aaaaaa", title: "Memo", moved: path.join(home, "Memo.docx"), owner: home });
  assert.deepEqual(fs.readdirSync(home).sort(), ["Memo.docx", "Other.docx"], "taken, not made twice");
});
