/**
 * The office document library: an index.json ({ version: 1, docs: DocMeta[] }) under the extension's own dataDir that
 * is the single source of truth for metadata. Every operation reads the index fresh from disk (no caching -- a human
 * UI tab, the loopback listener and the agent tools all share this process's files) and writes it back atomically
 * (tmp file in the same directory + rename). Document bytes live in the plain filesystem: the portal's 1 MB
 * managed-file cap does not apply here, so >1 MB Office files work natively.
 *
 * Every document lives in the folder of an agent's home or a project, and belongs to that agent or project (owner
 * decision of 2026-10-28: there are no unowned documents). The index points at each file IN PLACE (DocMeta.path):
 * a made one is written into its owner's folder (createDoc), a scanned one is found there (scanWorkspace), and the
 * file IS the document. A deleted doc moves its file into this library's .trash (7-day sweep); a file already gone
 * out-of-band is pruned, not an error. Documents an earlier version made in the extension's own docs folder move
 * into a folder once (migrateLibrary).
 *
 * Every exported function takes a trailing optional `root = dataDir()` so unit tests can pass a tmp
 * dir; production callers just omit it. The ONLY async functions are
 * templateDocx/templateXlsx and createDoc, because jszip -- the only zip writer allowed in
 * this package -- generates buffers asynchronously; everything that touches existing files is sync.
 */
import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { jsZip } from "./jszip";
import { dataDir } from "./host";

/** A mention that opened a document to an agent's or project's folder (its path, as `owner`). */
export type Grant = { folder: string; commentId: string; at: number };

export type DocMeta = {
  docId: string;
  title: string;
  ext: "docx" | "xlsx";
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
  mtimeMs: number;
  /** The agent or project it belongs to, by its folder (the path the portal lists it at, resolved): the agent's home or
   * project folder its file is in (the deepest, where one is inside another). An agent's chats come and go, and which of
   * them stands for the folder changes, but the folder stays. */
  owner: string;
  grants: Grant[];
  createdBy?: string;
  /** Set for workspace-scanned docs and conflict copies: the file came from elsewhere, not made blank here.
   * (An `importedKeys` field older index files hold is the comment wake's baseline, which is gone: nothing reads it.) */
  imported?: boolean;
  /** Its file, in PLACE: its real, absolute path (realpathSync'd at index time), in its owner's folder. */
  path: string;
  /** Since when its file has been gone (pruneMissingDocs): kept meanwhile, in case it comes back. */
  missingSince?: number;
  /** Which workspace a scanned doc lives in -- the "workspace" sort key of the UI: the FIRST path segment under the scan
   * root that contains it (scanWorkspace; deepest matching root wins, so /root/repos/pithagoras/... labels "pithagoras"),
   * and for a file straight in a root that root's OWN dir name. Stamped at index time and BACKFILLED on every rescan. */
  workspace?: string;
};

/** An entry of an index from before every document lived in an agent's or project's folder: one made in the extension's
 * own docs folder (docs/<docId>/<title>.<ext>), with no `path`, and no owner where the person made it. Kept apart from
 * the documents (readIndex), so that nothing hands it out, and written back as it was until migrateLibrary moves it. */
export type LibraryDoc = Omit<DocMeta, "owner" | "path"> & { owner: string | null; path?: undefined };

type IndexFile = { version: 1; docs: DocMeta[]; unplaced: LibraryDoc[] };

const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // sweepTrash removes .trash entries older than this
// The scan's cap: a file above it stays out of the library (any xlsx/docx in it is parsed later against ooxml.ts'
// 256 MiB / 1 GiB zip envelope). The same cap holds for every later read of a file whole (readDoc, the tools' read as the agent): an indexed file
// that grew since is refused, not read into the portal's memory.
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

/** The refusal of a file above MAX_IMPORT_BYTES, before a byte of it is read. */
export function tooLarge(file: string, size: number): Error {
  return Object.assign(new Error(`${file} is ${size} bytes: files above ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB are not read`), { code: "too_large" });
}

/* ------------------------------------------------------------------ */
/* index I/O                                                           */
/* ------------------------------------------------------------------ */

function indexPath(root: string): string {
  return path.join(root, "index.json");
}

function readIndex(root: string): IndexFile {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(indexPath(root), "utf8"));
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).docs)) throw new Error("bad shape");
    const all = (raw as { docs: (DocMeta | LibraryDoc)[] }).docs;
    return {
      version: 1,
      docs: all.filter((d): d is DocMeta => typeof d.path === "string"),
      unplaced: all.filter((d): d is LibraryDoc => typeof d.path !== "string"),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, docs: [], unplaced: [] };
    throw Object.assign(new Error(`corrupt document index at ${indexPath(root)} -- run settleKept to reconcile`), { code: "index_corrupt", cause: err });
  }
}

function writeIndex(root: string, index: IndexFile): void {
  const dest = indexPath(root);
  const tmp = path.join(root, `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, docs: [...index.docs, ...index.unplaced] }, null, 2));
  fs.renameSync(tmp, dest);
}

/** Whether a title of that type is taken in `folder`, by a document whose file is straight in it, or anywhere by an entry
 * still to be moved (which folder it goes to is not known before the move). A title is the file's name, so two agents
 * may each keep a "Notes.docx" in their own folders; only the same name twice in one folder clashes. A document made
 * for an agent or project (`made`: createDoc, the move) is also refused a title one of that owner's documents has
 * elsewhere in its folder, so that its own list never shows two of one name it made. */
function titleTaken(index: IndexFile, title: string, ext: DocMeta["ext"], folder: string, except?: string, made = false): boolean {
  const same = (d: { docId: string; title: string; ext: DocMeta["ext"] }) => d.docId !== except && d.title === title && d.ext === ext;
  return index.docs.some((d) => same(d) && (path.dirname(d.path) === folder || (made && d.owner === folder))) || index.unplaced.some(same);
}

/** What puts a new file into an agent's or project's folder: `bytes` as `name` in `folder`, never over something there,
 * and owned as the folder's files are, so that its agent can go on with it; its real path. The server half puts it
 * through the portal (files.create, which gives the file the folder's owner where the portal runs as root); plain
 * here, for the tests. */
export type PlaceFile = (folder: string, name: string, bytes: Buffer) => string;

let placeFile: PlaceFile = (folder, name, bytes) => {
  const file = path.join(folder, name);
  writeNewKeeping(file, bytes);
  return file;
};

/** The seam of the store: how a new file is put into a folder (server.ts gives the portal's way). */
export function configureStore(opts: { place?: PlaceFile }): void {
  if (opts.place) placeFile = opts.place;
}

function notFound(message = "no such document"): Error {
  return Object.assign(new Error(message), { code: "not_found" });
}

/* ------------------------------------------------------------------ */
/* identity + templates                                                */
/* ------------------------------------------------------------------ */

/** Title -> slug: lowercase, every run of non-alphanumeric characters collapses to one "-", leading/trailing "-" trimmed.
 * A slug is not unique by itself (titles collide) -- createDoc appends a random suffix below. */
export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Six-character random suffix from crypto.randomInt over the lowercase ASCII alphanumerics "abcdefghijklmnopqrstuvwxyz0123456789" --
 * 36 symbols, so the chance that two freshly minted suffixes collide is ~1/36^6 (≈ 4.6e-10); createDoc still
 * re-checks generated ids against the index and regenerates on the off chance of a hit. */
function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

const DOCX_CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `</Types>`;

const DOCX_ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

const W_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;

// word/_rels/document.xml.rels is not strictly required but standard in every real docx and keeps
// Word/OnlyOffice happy (the styles part is referenced from it, not dangling).
const DOCX_DOC_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`;

const DOCX_DOCUMENT =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document ${W_NS}><w:body><w:p><w:r><w:t xml:space="preserve">New document</w:t></w:r></w:p></w:body></w:document>`;

// The document's own defaults: Arial 11, the font the Document Server's built-in table styles (Grid Table 4 - Accent 1
// and the like) set on some of their rows only. An empty styles part leaves the format's default (Times New Roman 10),
// and a table of such a style then shows two fonts. Only a document made here gets this: an uploaded one has its own.
const DOCX_STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}>` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
  `</w:styles>`;

/** A minimal valid docx (jszip, DEFLATE): [Content_Types].xml, _rels/.rels, word/document.xml (one paragraph
 * saying "New document"), word/styles.xml -- plus word/_rels/document.xml.rels so the styles part is properly
 * referenced. Opens cleanly in Word/OnlyOffice and parses with ooxml.parseDocx. jszip only writes buffers
 * asynchronously, which is why this (and createDoc) are async. */
export async function templateDocx(): Promise<Buffer> {
  const zip = new (await jsZip())();
  zip.file("[Content_Types].xml", DOCX_CONTENT_TYPES);
  zip.file("_rels/.rels", DOCX_ROOT_RELS);
  zip.file("word/document.xml", DOCX_DOCUMENT);
  zip.file("word/_rels/document.xml.rels", DOCX_DOC_RELS);
  zip.file("word/styles.xml", DOCX_STYLES);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const XLSX_CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `</Types>`;

const XLSX_ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const XLSX_WORKBOOK =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>` +
  `</workbook>`;

const XLSX_WORKBOOK_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `</Relationships>`;

const XLSX_SHEET1 =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;

/** A minimal valid xlsx (jszip, DEFLATE): [Content_Types].xml, _rels/.rels, xl/workbook.xml, xl/_rels/workbook.xml.rels
 * and an empty xl/worksheets/sheet1.xml named "Sheet1". Opens cleanly in Excel/OnlyOffice and parses with
 * ooxml.parseXlsx (one sheet, zero rows). Async for the same jszip reason as templateDocx. */
export async function templateXlsx(): Promise<Buffer> {
  const zip = new (await jsZip())();
  zip.file("[Content_Types].xml", XLSX_CONTENT_TYPES);
  zip.file("_rels/.rels", XLSX_ROOT_RELS);
  zip.file("xl/workbook.xml", XLSX_WORKBOOK);
  zip.file("xl/_rels/workbook.xml.rels", XLSX_WORKBOOK_RELS);
  zip.file("xl/worksheets/sheet1.xml", XLSX_SHEET1);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/* ------------------------------------------------------------------ */
/* library operations                                                  */
/* ------------------------------------------------------------------ */

/** All documents, titles ascending (localeCompare). */
export function listDocs(root = dataDir()): DocMeta[] {
  return [...readIndex(root).docs].sort((a, b) => a.title.localeCompare(b.title));
}

/** One document by id, or null. */
export function getDoc(docId: string, root?: string): DocMeta | null {
  const rootDir = root ?? dataDir();
  return readIndex(rootDir).docs.find((d) => d.docId === docId) ?? null;
}

/** A document's revision brought up to its file: where the file's mtime or size is not what the index has (something
 * wrote it outside the extension: an agent's script, a git pull, a copy), the index takes the file's. True where it
 * changed. A file that is gone is left to pruneMissingDocs. */
function stampFromDisk(doc: DocMeta, root: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(doc.path);
  } catch {
    return false;
  }
  if (st.mtimeMs === doc.mtimeMs && st.size === doc.sizeBytes) return false;
  doc.mtimeMs = st.mtimeMs;
  doc.sizeBytes = st.size;
  doc.updatedAt = Date.now();
  return true;
}

/** One document as its file is now (stampFromDisk), or null for none: what every path that hands out a revision asks
 * (the editor config's key, the tools, the page's state), so that a change made outside the extension is a new
 * revision at once, not only after a Rescan. */
export function refresh(docId: string, root = dataDir()): DocMeta | null {
  const index = readIndex(root);
  const doc = index.docs.find((d) => d.docId === docId);
  if (!doc) return null;
  if (stampFromDisk(doc, root)) writeIndex(root, index);
  return { ...doc };
}

/** Every document as its file is now, by title (listDocs after stampFromDisk). */
export function refreshAll(root = dataDir()): DocMeta[] {
  const index = readIndex(root);
  let changed = false;
  for (const doc of index.docs) if (stampFromDisk(doc, root)) changed = true;
  if (changed) writeIndex(root, index);
  return [...index.docs].sort((a, b) => a.title.localeCompare(b.title));
}

/** The ONE index writer for mention grants: fresh
 * read, dedupe by (folder, commentId) -- a re-sent comment never adds a second row -- atomic tmp+rename through
 * the store's writeIndex. Sync like everything here and no logging. Returns "added",
 * "duplicate" (already granted: nothing written), or null when the doc is not in the index any more.
 * A corrupt index throws the usual {code:"index_corrupt"} -- a bad file, not a vanished doc. */
export function addGrant(docId: string, folder: string, commentId: string, at: number, root = dataDir()): "added" | "duplicate" | null {
  const index = readIndex(root);
  const doc = index.docs.find((d) => d.docId === docId);
  if (!doc) return null;
  const grants = (doc.grants ??= []);
  if (grants.some((g) => g.folder === folder && g.commentId === commentId)) return "duplicate";
  grants.push({ folder, commentId, at });
  writeIndex(root, index);
  return "added";
}

/** A folder as the store keeps it: resolved through links, so that a home's path and a scanned file's real path
 * compare; as given where it cannot be resolved (gone). */
export function canonical(folder: string): string {
  try {
    return fs.realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

/** Whether `file` is inside `folder` (both resolved), at any depth. */
export function within(folder: string, file: string): boolean {
  const rel = path.relative(folder, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Whether the agent or project of `home` (a canonical folder) sees `doc`: what it owns or was granted, and the
 * documents in its own folder (also one of a project inside it). A document in another agent's or project's folder is
 * not its: the sandbox keeps that folder from its agent, and the tools must not hand it what is in it. */
export function visibleTo(doc: DocMeta, home: string): boolean {
  return doc.owner === home || doc.grants.some((g) => g.folder === home) || within(home, doc.path);
}

/** The agent's or project's folder a file is in, out of `folders` (canonical): the deepest that holds it; none where
 * no folder holds it. */
export function ownerFolder(file: string, folders: string[]): string | undefined {
  let best: string | undefined;
  for (const folder of folders) if ((file === folder || within(folder, file)) && (!best || folder.length > best.length)) best = folder;
  return best;
}

/** The documents the agent or project of `home` (a folder, resolved here) sees in its panel and office tools
 * (`visibleTo`), by title. */
export function docsForHome(home: string, root = dataDir()): DocMeta[] {
  const at = canonical(home);
  return readIndex(root).docs.filter((doc) => visibleTo(doc, at)).sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Owners and grants of the version before, which named a chat (whichever chat of a folder had the lowest id), moved
 * to that chat's folder (`folderOf`, the portal's chats.folder). One that cannot be resolved (a chat deleted since)
 * stays as it is: it names no folder, so no agent sees the document by it, and the person still does. Returns how
 * many documents changed.
 */
export function migrateOwners(folderOf: (chatId: string) => string | undefined, root = dataDir()): number {
  const index = readIndex(root);
  let changed = 0;
  const moved = (who: string): string => {
    if (path.isAbsolute(who)) return who;
    const folder = folderOf(who);
    return folder ? canonical(folder) : who;
  };
  for (const doc of [...index.docs, ...index.unplaced]) {
    const before = JSON.stringify([doc.owner, doc.grants]);
    if (doc.owner !== null) doc.owner = moved(doc.owner);
    doc.grants = (doc.grants ?? []).map((g) => {
      const old = g as Grant & { chatId?: string };
      const { chatId, ...rest } = old;
      return { ...rest, folder: moved(old.folder ?? chatId ?? "") };
    });
    if (JSON.stringify([doc.owner, doc.grants]) !== before) changed++;
  }
  if (changed) writeIndex(root, index);
  return changed;
}

/** What migrateLibrary did with each document of the extension's own docs folder. */
export type LibraryMove =
  | { docId: string; title: string; moved: string; owner: string }
  | { docId: string; title: string; dropped: "file gone" }
  | { docId: string; title: string; failed: string }
  /** Moved, but its old folder in the docs folder could not be removed (tried again at the next start). */
  | { docId: string; title: string; leftover: string };

/**
 * The documents an earlier version made in the extension's own docs folder (docs/<docId>/<title>.<ext>, `LibraryDoc`),
 * moved once into a folder they then live and belong in: their owner's, where an agent or project made one and its
 * folder is among `folders` (the agents' homes and the projects, canonical), else the default agent's home
 * (`defaultHome`). A name taken there (by a file, or a document of that title) gets a number, "Report (2)". Its id,
 * grants, comments seen and revisions stay with it. One whose file is gone leaves the index; one that cannot be moved
 * (no default agent's home, a folder that refuses the file) stays as it was, to be moved at the next start. The file is
 * put in its place before the index names it, and the old folder removed after: a start cut off between the two finds
 * the file it put there already (the same bytes under the name) and takes it, rather than making a second.
 */
export function migrateLibrary(folders: string[], defaultHome: string | undefined, root = dataDir()): LibraryMove[] {
  const out: LibraryMove[] = [];
  for (const legacy of readIndex(root).unplaced) {
    const from = path.join(root, "docs", legacy.docId, `${legacy.title}.${legacy.ext}`);
    // The agent's or project's folder that holds its owner's (one of the chat-id era may name a chat's folder inside it).
    const owner = (legacy.owner !== null && path.isAbsolute(legacy.owner) && ownerFolder(legacy.owner, folders)) || (defaultHome && canonical(defaultHome));
    try {
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(from);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        const index = readIndex(root);
        index.unplaced = index.unplaced.filter((d) => d.docId !== legacy.docId);
        writeIndex(root, index);
        out.push({ docId: legacy.docId, title: legacy.title, dropped: "file gone" });
        continue;
      }
      if (!owner) throw new Error("there is no default agent's home to move it to");
      const index = readIndex(root);
      // The first name free in the index and in the folder; a file there with these very bytes is this one, put there
      // by a start that was cut off before it wrote the index.
      let title = legacy.title;
      let adopt: string | undefined;
      for (let n = 2; ; n++) {
        const file = path.join(owner, `${title}.${legacy.ext}`);
        const there = fs.lstatSync(file, { throwIfNoEntry: false });
        if (there?.isFile() && there.size === bytes.length && !titleTaken(index, title, legacy.ext, owner, legacy.docId, true) && !index.docs.some((d) => d.path === file) && fs.readFileSync(file).equals(bytes)) {
          adopt = file; // as named, never resolved through a link put there since (placeDoc)
          break;
        }
        if (!there && !titleTaken(index, title, legacy.ext, owner, legacy.docId, true)) break;
        const tag = ` (${n})`;
        title = legacy.title.slice(0, 200 - tag.length) + tag;
      }
      const doc: DocMeta = { ...legacy, title, owner, path: "", workspace: path.basename(owner) };
      if (adopt) {
        const st = fs.statSync(adopt);
        Object.assign(doc, { path: adopt, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } else {
        placeDoc(doc, owner, bytes);
      }
      doc.updatedAt = Date.now();
      index.unplaced = index.unplaced.filter((d) => d.docId !== legacy.docId);
      index.docs.push(doc);
      writeIndex(root, index);
      out.push({ docId: doc.docId, title: doc.title, moved: doc.path, owner });
    } catch (e) {
      out.push({ docId: legacy.docId, title: legacy.title, failed: (e as Error).message });
    }
  }
  // The old folder of each document that moved, now or at a start before that was cut off after its index write (or
  // whose removal failed then): only those, by an id the index has as a document.
  let left: string[] = [];
  try {
    left = fs.readdirSync(path.join(root, "docs"));
  } catch {
    // no docs folder (any more)
  }
  if (left.length) {
    const placed = new Set(readIndex(root).docs.map((d) => d.docId));
    for (const docId of left.filter((id) => placed.has(id))) {
      try {
        fs.rmSync(path.join(root, "docs", docId), { recursive: true, force: true });
      } catch (e) {
        out.push({ docId, title: docId, leftover: (e as Error).message });
      }
    }
  }
  // The docs folder itself, once nothing is left in it.
  try {
    fs.rmdirSync(path.join(root, "docs"));
  } catch {
    // not there, or something is still in it
  }
  return out;
}

function freshDocId(existing: DocMeta[], title: string): string {
  const slug = slugify(title);
  let docId = `${slug ? slug + "-" : ""}${randomSuffix()}`; // titles of pure punctuation still get a clean id
  while (existing.some((d) => d.docId === docId)) docId = `${slug ? slug + "-" : ""}${randomSuffix()}`;
  return docId;
}

/** Titles become FILE NAMES (docs/<docId>/<title>.<ext>): reject anything empty, over 200 chars, or carrying a
 * path separator / C0 control character -- "../../etc/passwd.docx" would otherwise escape the library. */
function assertSafeTitle(title: string): void {
  if (title === "" || title.length > 200) {
    throw Object.assign(new Error(`a document title must be 1-200 characters: ${JSON.stringify(title.slice(0, 80))}`), { code: "invalid_title" });
  }
  for (const ch of title) {
    const code = ch.codePointAt(0) as number;
    if (ch === "/" || ch === "\\" || code < 0x20) throw Object.assign(new Error(`the document title may not contain path separators or control characters: ${JSON.stringify(title.slice(0, 80))}`), { code: "invalid_title" });
  }
}

/** `bytes` put into `folder` as `<title>.<ext>` (placeFile), and the entry's file, title, size and revision taken from
 * the file as it was made: where something took the name meanwhile, the portal's way numbers it. The file is taken at
 * the name it was made under, never resolved through a link: the folder's agent may put a link in its place before
 * the store looks, and the entry would then name the file it leads to, in another agent's folder, which the portal
 * reads and writes with its own rights. Such a link is refused ({code:"invalid"}); one put there later is refused by
 * every read and write of the file (plainFile). Sync on purpose: the create and move paths must not await between
 * readIndex and writeIndex. */
function placeDoc(doc: DocMeta, folder: string, bytes: Buffer): DocMeta {
  const placed = placeFile(folder, `${doc.title}.${doc.ext}`, bytes);
  const file = path.join(canonical(path.dirname(placed)), path.basename(placed));
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw Object.assign(new Error(`${file} is not a plain file (a link or a folder took its name as it was made)`), { code: "invalid" });
  doc.path = file;
  doc.title = path.basename(file).slice(0, -(doc.ext.length + 1));
  doc.sizeBytes = st.size;
  doc.mtimeMs = st.mtimeMs;
  return doc;
}

/** Create a document from the blank template of its type, as `<title>.<ext>` in `folder`: the agent's home or the
 * project folder it belongs to (its owner; the person's go into the default agent's home). docId = slug(title) + "-" +
 * 6 random chars (see randomSuffix for the alphabet). A title of that type already in the index, or a file of that name
 * already in the folder, throws Error{code:"exists"} before anything is written. createdBy records who did it. */
export async function createDoc(input: { title: string; type: "word" | "cell"; folder: string; createdBy?: string }, root = dataDir()): Promise<DocMeta> {
  const rootDir = root ?? dataDir();
  assertSafeTitle(input.title); // titles are file names
  const ext: DocMeta["ext"] = input.type === "word" ? "docx" : "xlsx";
  const bytes = ext === "docx" ? await templateDocx() : await templateXlsx(); // BEFORE the index round-trip: no await may sit between readIndex and writeIndex, or a concurrent create would have its write clobbered
  const folder = canonical(input.folder);
  const index = readIndex(rootDir);
  if (titleTaken(index, input.title, ext, folder, undefined, true)) throw Object.assign(new Error(`a document titled "${input.title}" is already in ${folder}`), { code: "exists" });
  if (fs.lstatSync(path.join(folder, `${input.title}.${ext}`), { throwIfNoEntry: false })) {
    throw Object.assign(new Error(`a file named "${input.title}.${ext}" is already in ${folder}`), { code: "exists" });
  }
  const now = Date.now();
  const doc: DocMeta = {
    docId: freshDocId(index.docs, input.title),
    title: input.title,
    ext,
    createdAt: now,
    updatedAt: now,
    sizeBytes: 0,
    mtimeMs: 0,
    owner: folder,
    grants: [],
    path: "",
    workspace: path.basename(folder), // what the scan stamps on a file straight in its folder
  };
  if (input.createdBy !== undefined) doc.createdBy = input.createdBy;
  placeDoc(doc, folder, bytes);
  index.docs.push(doc);
  writeIndex(rootDir, index);
  return { ...doc };
}

/** `from` renamed to `to`, never over something there: the new name made as a second name of the file (a hard link,
 * which the system refuses for a name that is taken) before the old one goes. Where hard links are not possible, a
 * rename after a look. */
function renameNoClobber(from: string, to: string, title: string): void {
  const taken = () => Object.assign(new Error(`a file named "${path.basename(to)}" is already there`), { code: "exists", title });
  try {
    fs.linkSync(from, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw taken();
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") throw e;
    if (fs.existsSync(to)) throw taken();
    fs.renameSync(from, to);
    return;
  }
  fs.unlinkSync(from);
}

/** Retitle a document and rename its file on disk (<its folder>/<newTitle>.<ext>). The docId is stable across the
 * whole lifetime of the doc (tickets, history paths, state files key off it), and rename preserves the content's
 * mtimeMs -- that IS the revision tools gate on, so a retitle is never a new revision. updatedAt bumps. A title
 * already held by ANOTHER document throws {code:"exists"} (refusing is the safe reading of a retitle collision). */
export function renameDoc(docId: string, newTitle: string, root = dataDir()): DocMeta {
  const rootDir = root ?? dataDir();
  assertSafeTitle(newTitle);
  const index = readIndex(rootDir);
  const doc = index.docs.find((d) => d.docId === docId);
  if (!doc) throw notFound(`no document with id ${docId}`);
  if (newTitle !== doc.title && titleTaken(index, newTitle, doc.ext, path.dirname(doc.path), docId)) {
    throw Object.assign(new Error(`a document titled "${newTitle}" already exists`), { code: "exists" });
  }
  // Renamed inside the file's OWN folder: next to where it already is (same parent, new name).
  const from = doc.path;
  const to = path.join(path.dirname(from), `${newTitle}.${doc.ext}`);
  plainFile(doc, from);
  renameNoClobber(from, to, newTitle);
  doc.path = to;
  doc.title = newTitle;
  doc.updatedAt = Date.now();
  writeIndex(rootDir, index);
  return { ...doc };
}

/**
 * Delete a document: it is moved into the trash as one entry, `.trash/<Date.now()>-<docId>/`, that holds its file
 * (`<title>.<ext>`), what was kept for it (the comments seen, `state.json`; an older version's `history/`), and
 * `document.json`, its index entry with where it was (`path`): what is needed to put it back by
 * hand. Then the index entry goes. Its real file moves out of its folder; where the trash is on another
 * file system than that folder (a portal in a container with the workspace bound in), it is copied and the original
 * removed. A link put in the file's place is removed as the link. Where the file's folder leads elsewhere since it was
 * indexed (a link took the folder's place), or a folder took the file's name, nothing on disk is touched: the path
 * leads into another folder now, whose file is not this document's. A file already gone is NOT an error: only
 * the index entry drops. sweepTrash (server boot / settleKept) removes entries older than 7 days, whole. Throws
 * {code:"not_found"} for an unknown id.
 */
export function deleteDoc(docId: string, root = dataDir()): void {
  const rootDir = root ?? dataDir();
  const index = readIndex(rootDir);
  const doc = index.docs.find((d) => d.docId === docId);
  if (!doc) throw notFound(`no document with id ${docId}`);
  const entry = path.join(trashDir(rootDir), `${Date.now()}-${docId}`);
  fs.mkdirSync(entry, { recursive: true });
  const moveIn = (from: string, name: string) => {
    try {
      fs.renameSync(from, path.join(entry, name));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // left on its own: nothing to move
      if (code !== "EXDEV") throw err;
      fs.cpSync(from, path.join(entry, name), { recursive: true, dereference: false });
      fs.rmSync(from, { recursive: true, force: true });
    }
  };
  let plain = true;
  try {
    plainFile(doc, doc.path);
  } catch (err) {
    plain = false; // gone, or not a plain file at its own name in its own folder any more
    // A link in its place, in the folder as it was indexed: removed as the link, never followed. Through a folder
    // that leads elsewhere now, the same path names another folder's file: left alone.
    const dir = path.dirname(doc.path);
    if ((err as { code?: string }).code === "invalid" && canonical(dir) === dir && fs.lstatSync(doc.path, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(doc.path, { force: true });
  }
  if (plain) moveIn(doc.path, `${doc.title}.${doc.ext}`);
  moveIn(path.join(rootDir, "state", `${docId}.json`), "state.json");
  moveIn(path.join(rootDir, "history", docId), "history");
  fs.writeFileSync(path.join(entry, "document.json"), JSON.stringify({ ...doc, deletedAt: Date.now() }, null, 2) + "\n");
  writeIndex(rootDir, { ...index, docs: index.docs.filter((d) => d.docId !== docId) });
}

/** The library's trash dir, made if missing -- one place that names it. */
function trashDir(rootDir: string): string {
  return path.join(rootDir, ".trash");
}

/** Reclaim .trash entries whose name timestamp (the "<ms>-<name>" prefix written by deleteDoc) is older than 7 days.
 * Returns how many were removed. Server boot (settleKept) and the lookAfter path call this. */
export function sweepTrash(root = dataDir()): number {
  const rootDir = root ?? dataDir();
  const trash = trashDir(rootDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(trash);
  } catch {
    return 0; // no .trash yet
  }
  const now = Date.now();
  let removed = 0;
  for (const name of entries) {
    const dash = name.indexOf("-");
    if (dash < 1) continue; // not a deleteDoc entry -- leave it alone
    const stamp = Number(name.slice(0, dash));
    if (!Number.isFinite(stamp)) continue;
    if (now - stamp > TRASH_TTL_MS) {
      fs.rmSync(path.join(trash, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/** How long a document whose file is gone stays in the index, in case the file comes back (a git checkout of another
 * branch, a move and back): its owner, grants, comments seen and an open session's save stay with it meanwhile. */
const MISSING_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** The settleKept half of index-vs-disk reconciliation (server.ts calls it at boot and on the interval): a document
 * whose file is gone is marked (`missingSince`), and dropped from the index only once it has been gone for
 * MISSING_GRACE_MS; one whose file is back is unmarked. The index is the source of truth in BOTH directions: a
 * file with NO index entry is NOT added here (that is the scan's). Returns the dropped docIds; writes nothing when
 * nothing changed. */
export function pruneMissingDocs(root = dataDir(), now = Date.now()): string[] {
  const rootDir = root ?? dataDir();
  const index = readIndex(rootDir);
  const kept: DocMeta[] = [];
  const dropped: string[] = [];
  let changed = false;
  for (const doc of index.docs) {
    if (fs.existsSync(doc.path)) {
      if (doc.missingSince !== undefined) {
        delete doc.missingSince;
        changed = true;
      }
      kept.push(doc);
    } else if (doc.missingSince === undefined) {
      doc.missingSince = now;
      changed = true;
      kept.push(doc);
    } else if (now - doc.missingSince > MISSING_GRACE_MS) {
      dropped.push(doc.docId);
      changed = true;
    } else {
      kept.push(doc);
    }
  }
  if (changed) writeIndex(rootDir, { ...index, docs: kept });
  return dropped;
}

/** ONE file of a scan, resolved to its index entry: throws {code:"unsupported_format"} for anything that is not a
 * regular .docx/.xlsx and {code:"too_large"} above the 512 MiB cap; returns null when the basename (without its
 * extension) cannot become a document title -- such a file is skipped, not indexed. The single place where a
 * scanned file becomes a DocMeta, so the stamping rules of the former importFile live in exactly one spot. */
function indexOne(real: string, rootDir: string, owner: string, workspace?: string): DocMeta | null {
  const base = path.basename(real);
  const dot = base.lastIndexOf(".");
  if (dot < 1) throw Object.assign(new Error(`${base} has no extension`), { code: "unsupported_format" });
  const extRaw = base.slice(dot + 1).toLowerCase();
  if (extRaw !== "docx" && extRaw !== "xlsx") throw Object.assign(new Error(`${base}: only .docx and .xlsx files are indexed`), { code: "unsupported_format" });
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(`no such file ${real}`);
    throw err;
  }
  if (!st.isFile()) throw Object.assign(new Error(`${real} is not a regular file`), { code: "unsupported_format" });
  // The cap importFile had, now on INDEXING: an uncapped source would also blow the ooxml reader's 1 GiB zip
  // envelope at parse time -- above it the file stays out of the library and its mtime-gated flow.
  if (st.size > MAX_IMPORT_BYTES) throw Object.assign(new Error(`${real} is ${st.size} bytes: files above ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB are not indexed`), { code: "too_large" });
  const title = base.slice(0, dot);
  try {
    assertSafeTitle(title); // a file name that cannot be a document title is skipped, not indexed
  } catch {
    return null;
  }
  const now = Date.now();
  const index = readIndex(rootDir);
  if (index.docs.some((d) => d.path === real) || titleTaken(index, title, extRaw, path.dirname(real))) {
    throw Object.assign(new Error(`a document titled "${title}" (${extRaw}) is already in the library`), { code: "exists" });
  }
  const doc: DocMeta = {
    docId: `${slugify(title)}-${randomSuffix()}`,
    title,
    ext: extRaw,
    createdAt: now,
    updatedAt: now,
    sizeBytes: st.size,
    mtimeMs: st.mtimeMs, // the file's OWN mtime IS its revision from day one -- the mtime-gated flow edits it in place
    owner, // the agent or project whose folder it is in
    grants: [],
    imported: true,
    path: real, // IN PLACE: the scanned file IS the document; nothing is copied into the library
  };
  if (workspace !== undefined) doc.workspace = workspace; // the "workspace" sort label of the UI (scanWorkspace)
  index.docs.push(doc);
  writeIndex(rootDir, index);
  return { ...doc };
}

/** Synchronous workspace scan: every *.docx/*.xlsx (case-insensitive) under `roots`, indexed IN PLACE.
 *
 * roots are the agents' homes and the projects' folders (the agent and project folders of portal().folders.list();
 * not the folders chats work in, nor the rest of the workspace): each file belongs to the deepest of them that holds
 * it (its owner). The walk is bounded and deliberately dumb -- no git, no content sniffing: it never enters the
 * library's own data dir, never hidden dirs (dot-prefixed: .git, editor scratch), and never node_modules. A file is
 * identified by its REALPATH, so two roots reaching the same file through a symlink or bind mount produce ONE entry.
 * Already-indexed files get their mtimeMs/sizeBytes REFRESHED from disk (a rescan after something wrote the file
 * straight to disk keeps the list honest), and their owner and workspace label brought up to where they are, and count
 * as `updated` only when something actually changed; new files go through indexOne. A file that cannot be indexed
 * (oversized, unsafe title, already titled, unreadable) is skipped: one bad file must never fail the whole sweep.
 *
 * A document whose file is there but in none of the roots (one an earlier version found in a chat's folder, or in a
 * folder that is no project any more) leaves the index (`dropped`; its file stays where it is): no agent or project
 * owns it. A file that is gone is pruneMissingDocs' (kept a while, in case it comes back), and so is everything where
 * there are no roots at all.
 *
 * Returns { added, updated, dropped } (dropped: the docIds that left the index). */
export function scanWorkspace(roots: string[], root = dataDir()): { added: number; updated: number; dropped: string[] } {
  const rootDir = root ?? dataDir();
  let self: string;
  try {
    self = fs.realpathSync(rootDir);
  } catch {
    self = path.resolve(rootDir);
  }
  const seenDirs = new Set<string>(); // per-walk guard: a dir is walked at most once (also breaks symlink loops)
  const found: string[] = []; // candidate files, in walk order

  const isSkippedName = (name: string): boolean => name.startsWith(".") || name === "node_modules";
  const walk = (dir: string): void => {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return; // gone mid-walk or unreadable -- the rest of the tree still counts
    }
    if (real === self || seenDirs.has(real)) return; // our own library dir is never walked, and neither is any dir twice
    seenDirs.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedName(entry.name)) walk(at); // hidden dirs and node_modules are never walked
        continue;
      }
      if (entry.isFile() && /\.(docx|xlsx)$/i.test(entry.name)) found.push(at);
    }
  };
  for (const r of roots) walk(r);

  // A file's WORKSPACE label (the "workspace" sort key of the UI): the first path segment under whichever scan root
  // contains it -- the DEEPEST matching root wins, so a nested root labels more specifically than its parent.
  // A file straight in a root takes that root's OWN dir name instead of being labelled by its own file name
  // (a home-root file -> the home's dir name). undefined when no resolved root claims the file.
  const resolvedRoots = roots.map(canonical);
  const workspaceOf = (real: string): string | undefined => {
    const dir = ownerFolder(real, resolvedRoots);
    if (!dir || dir === real) return undefined;
    const segs = path.relative(dir, real).split(path.sep);
    return segs.length > 1 ? segs[0] : path.basename(dir);
  };

  // What is ALREADY indexed, by its real path: refreshes target these; everything else in `found` is a candidate add.
  const byReal = new Map<string, DocMeta>();
  const initial = readIndex(rootDir);
  for (const doc of initial.docs) if (doc.path) byReal.set(doc.path, doc);
  let added = 0;
  let updated = 0;
  for (const file of found) {
    let real: string;
    try {
      real = fs.realpathSync(file); // symlinks collapse into one identity; a broken link is skipped
    } catch {
      continue;
    }
    const known = byReal.get(real);
    if (known) {
      let st: fs.Stats;
      try {
        st = fs.statSync(real);
      } catch {
        continue; // vanished since the index was read: pruneMissingDocs settles it at the next settleKept
      }
      if (st.mtimeMs !== known.mtimeMs || st.size !== known.sizeBytes) {
        known.mtimeMs = st.mtimeMs;
        known.sizeBytes = st.size;
        known.updatedAt = Date.now();
        updated++;
      }
      const ws = workspaceOf(real);
      const owner = ownerFolder(real, resolvedRoots);
      if ((ws !== undefined && known.workspace !== ws) || (owner !== undefined && known.owner !== owner)) {
        // BACKFILL on every rescan: entries indexed before the stamp, or without an owner (an earlier version's), or
        // under an older root layout pick up their workspace label and owner here -- counted as a refresh, once.
        if (ws !== undefined) known.workspace = ws;
        if (owner !== undefined) known.owner = owner;
        known.updatedAt = Date.now();
        updated++;
      }
      continue; // refresh-and-continue: a rescan never re-indexes what it already has
    }
    const owner = ownerFolder(real, resolvedRoots);
    if (owner === undefined) continue; // reached through a link that leads out of every root: no agent's or project's
    try {
      const doc = indexOne(real, rootDir, owner, workspaceOf(real)); // its own atomic read-modify-write -- one entry per file
      if (doc) {
        byReal.set(real, doc);
        added++;
      }
    } catch (err) {
      const ce = err as { code?: string };
      if (ce.code === "unsupported_format" || ce.code === "too_large" || ce.code === "exists") continue; // expected skips
      throw err; // a real failure (index corrupt, disk full) IS a rescan failure
    }
  }
  // What no root holds any more, while its file is there: out of the index (see above). An entry an earlier version
  // scanned has no owner: it gets the root that holds it also while its file is away (the walk above gives one only to
  // the files it finds), and leaves the index where none does, file or not, since a document belongs to someone.
  const outside = new Set<string>();
  const ownerless = new Map<string, string>();
  if (resolvedRoots.length) {
    for (const doc of initial.docs) {
      const holder = ownerFolder(doc.path, resolvedRoots);
      if (holder === undefined) {
        if (typeof doc.owner !== "string" || fs.lstatSync(doc.path, { throwIfNoEntry: false })) outside.add(doc.docId);
      } else if (typeof doc.owner !== "string" && !byReal.get(doc.path)?.owner) ownerless.set(doc.docId, holder);
    }
  }
  if (updated > 0 || outside.size || ownerless.size) {
    const index = readIndex(rootDir); // fresh: add-writes may have landed since `initial`
    let wrote = false;
    for (const [realPath, doc] of byReal) {
      const entry = index.docs.find((d) => d.path === realPath);
      if (
        !entry ||
        (doc.mtimeMs === entry.mtimeMs && doc.sizeBytes === entry.sizeBytes && doc.workspace === entry.workspace && doc.owner === entry.owner)
      ) continue;
      entry.mtimeMs = doc.mtimeMs;
      entry.sizeBytes = doc.sizeBytes;
      entry.updatedAt = doc.updatedAt;
      entry.owner = doc.owner;
      if (doc.workspace !== undefined) entry.workspace = doc.workspace;
      wrote = true;
    }
    for (const entry of index.docs) {
      const holder = ownerless.get(entry.docId);
      if (holder !== undefined && typeof entry.owner !== "string") {
        entry.owner = holder;
        if (entry.workspace === undefined) entry.workspace = workspaceOf(entry.path);
        wrote = true;
      }
    }
    if (outside.size) {
      index.docs = index.docs.filter((d) => !outside.has(d.docId));
      wrote = true;
    }
    if (wrote) writeIndex(rootDir, index);
  }
  return { added, updated, dropped: [...outside] };
}

/** Copy a document OUT of the library to destAbsDir (created if missing) as <title>.<ext>; returns the absolute
 * path written. Throws {code:"not_found"} for an unknown id. */
export function exportDoc(docId: string, destAbsDir: string, root = dataDir()): string {
  const rootDir = root ?? dataDir();
  const doc = getDoc(docId, rootDir);
  if (!doc) throw notFound(`no document with id ${docId}`);
  fs.mkdirSync(destAbsDir, { recursive: true });
  const dest = path.join(destAbsDir, `${doc.title}.${doc.ext}`);
  fs.writeFileSync(dest, readDoc(doc)); // never through a link put in the file's place
  return path.resolve(dest);
}

/**
 * The document's file as it may be written: a plain file at its own name (a link put in its place is refused, and so is
 * a scanned file whose folder was swapped for a link since it was indexed, which would lead the write into another
 * folder), with what lstat says of it.
 */
function plainFile(doc: DocMeta, file: string): fs.Stats {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw notFound(`no file for ${doc.docId}`);
  }
  if (!st.isFile()) throw Object.assign(new Error(`${file} is not a plain file any more (a link or a folder took its name)`), { code: "invalid" });
  if (canonical(path.dirname(file)) !== path.dirname(file)) {
    throw Object.assign(new Error(`the folder of ${file} leads elsewhere now (a link took its place)`), { code: "invalid" });
  }
  return st;
}

/** A document's size, from its own file as readDoc would open it (plainFile, then opened without following a link), and
 * refused above the library's cap: what a read through the portal's rights checks before the Document Server is handed
 * the file. */
export function docSize(doc: DocMeta): number {
  plainFile(doc, doc.path);
  const fd = fs.openSync(doc.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const { size } = fs.fstatSync(fd);
    if (size > MAX_IMPORT_BYTES) throw tooLarge(doc.path, size);
    return size;
  } finally {
    fs.closeSync(fd);
  }
}

/** A document's bytes, from its own file and never through a link (plainFile, then opened without following one), so
 * that an agent that put a link in its file's place cannot have the portal hand out what the link leads to. */
export function readDoc(doc: DocMeta): Buffer {
  const file = doc.path;
  plainFile(doc, file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const { size } = fs.fstatSync(fd);
    if (size > MAX_IMPORT_BYTES) throw tooLarge(file, size);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `bytes` put in place of `file` as a save does: written beside it under a name nobody else uses, with the file's own
 * owner, group and mode (an agent's file stays the agent's: the portal may run as root, and a file it made fresh would
 * be root's, which the agent could then no longer write), synced, and renamed over it. Where the owner cannot be given
 * (the portal is not root), the file is the portal's, as only root may give a file away. The portal's own
 * `files.write` does the same but takes at most 1 MB, and a .docx is often more.
 */
function replaceKeeping(file: string, bytes: Buffer, was: fs.Stats): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomInt(1e9)}.tmp`);
  writeNewKeeping(tmp, bytes, was, true);
  fs.renameSync(tmp, file);
}

/** How far a new revision's time is set past the one it replaces where the clock gave it the same one (or an earlier
 * one): a millisecond, then a second and two for a filesystem that keeps times by the second (or by two, as FAT does). */
const REVISION_STEPS_MS = [1, 1000, 2000];

/** `bytes` as a new file at `file` (never over one there, never through a link), synced, with the owner, group and mode
 * of `was` where it is given. With `newer`, it is the next revision of `was`: its modification time, which is the
 * revision, is later than the one of `was`. Two writes a few milliseconds apart (the open editor's save, and the
 * agent's edit on top of it) can get the same time from the kernel's coarse clock, and the revision gate could then not
 * tell them apart. */
function writeNewKeeping(file: string, bytes: Buffer, was?: fs.Stats, newer = false): void {
  const mode = was ? was.mode & 0o7777 : 0o644;
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try {
    fs.writeFileSync(fd, bytes);
    if (was) {
      try {
        fs.fchownSync(fd, was.uid, was.gid);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
      }
      fs.fchmodSync(fd, mode); // the umask had its say at the open
    }
    if (was && newer) {
      for (const step of REVISION_STEPS_MS) {
        const now = fs.fstatSync(fd);
        if (now.mtimeMs > was.mtimeMs) break;
        fs.futimesSync(fd, now.atime, new Date(was.mtimeMs + step));
      }
    }
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    throw e;
  }
  fs.closeSync(fd);
}

/**
 * A save the revision gate refused, kept as a document of its own rather than lost: "<title> (conflict <date time>)",
 * beside the document in its folder (as its file is: owner, group and mode), with the original's owner and grants, so
 * the same agents see it.
 */
export function saveConflictCopy(doc: DocMeta, bytes: Buffer, root = dataDir()): DocMeta {
  const index = readIndex(root);
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", ".");
  const folder = path.dirname(doc.path);
  const taken = (title: string) => titleTaken(index, title, doc.ext, folder) || fs.existsSync(path.join(folder, `${title}.${doc.ext}`));
  let title = "";
  for (let n = 1; !title || taken(title); n++) {
    const tag = ` (conflict ${stamp}${n > 1 ? ` ${n}` : ""})`;
    title = doc.title.slice(0, 200 - tag.length) + tag;
  }
  const now = Date.now();
  const file = path.join(folder, `${title}.${doc.ext}`);
  const copy: DocMeta = { docId: freshDocId(index.docs, title), title, ext: doc.ext, createdAt: now, updatedAt: now, sizeBytes: 0, mtimeMs: 0, owner: doc.owner, grants: doc.grants.map((g) => ({ ...g })), imported: true, path: file };
  const was = plainFile(doc, doc.path);
  writeNewKeeping(file, bytes, was);
  const st = fs.statSync(file);
  Object.assign(copy, { sizeBytes: st.size, mtimeMs: st.mtimeMs, ...(doc.workspace !== undefined ? { workspace: doc.workspace } : {}) });
  index.docs.push(copy);
  writeIndex(root, index);
  return { ...copy };
}

/** Persist saved document bytes (the callback's status-2/6 path) under the REVISION GATE -- the whole point of
 * mtime-as-revision: stat the library file FIRST and if its mtimeMs differs from doc.mtimeMs (tolerance none;
 * the caller passes the meta it last saw), refuse with Error{code:"revision_mismatch", currentMtimeMs} so a stale
 * DS session can never clobber an agent edit (or vice versa). On success: temp file in the same directory + rename
 * over the original (the existing bytes are never deleted mid-write), re-stat for the new mtimeMs/sizeBytes, update
 * the index entry (mtimeMs, sizeBytes, updatedAt) and return { mtimeMs } -- the caller answers DS and registers the
 * history revision under that number. Sync on purpose: no zip is involved here, only a byte copy. */
export function persistBytes(doc: DocMeta, bytes: Buffer, root = dataDir()): { mtimeMs: number } {
  const rootDir = root ?? dataDir();
  const file = doc.path;
  const st = plainFile(doc, file);
  if (st.mtimeMs !== doc.mtimeMs) {
    throw Object.assign(new Error("revision_mismatch: the document changed since this session opened it"), { code: "revision_mismatch", currentMtimeMs: st.mtimeMs });
  }
  replaceKeeping(file, bytes, st);
  const after = fs.statSync(file);
  const index = readIndex(rootDir);
  const entry = index.docs.find((d) => d.docId === doc.docId);
  if (!entry) throw notFound(`no document with id ${doc.docId}`);
  entry.mtimeMs = after.mtimeMs;
  entry.sizeBytes = after.size;
  entry.updatedAt = Date.now();
  writeIndex(rootDir, index);
  return { mtimeMs: after.mtimeMs };
}
