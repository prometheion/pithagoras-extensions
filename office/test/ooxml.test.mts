/**
 * Unit tests for src/ooxml.ts: docx/xlsx parsing, quote-based document editing, zip rewriting,
 * comment diffing. Self-contained -- fixtures are built in-test with jszip (no network, docker, portal).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { parseDocx, parseXlsx, rewriteZip, docxThreads, xlsxThreads } from "../src/ooxml";

/* ---------------- fixture building (jszip) ---------------- */

const DOCUMENT_XML = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
  `<w:p><w:r><w:t>Hello &amp; welcome to &lt;Office&gt;.</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>Alp</w:t></w:r><w:r><w:t>ha</w:t></w:r><w:r><w:t xml:space="preserve"> beta</w:t></w:r></w:p>` +
  `<w:p/>` +
  `<w:p><w:r><w:t>Gamma one</w:t></w:r><w:r><w:t xml:space="preserve"> and gamma two</w:t></w:r></w:p>` +
  `</w:body></w:document>`;

const COMMENTS_XML = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:comment w:id="1" w:author="Alice Adams" w:date="2026-10-25T10:00:00Z"><w:p><w:r><w:t>Fix the</w:t></w:r><w:r><w:t> title.</w:t></w:r></w:p></w:comment>` +
  `<w:comment w:id="2" w:author="Bob Brown"><w:p><w:r><w:t>@agent</w:t></w:r><w:r><w:t> please review</w:t></w:r></w:p></w:comment>` +
  `</w:comments>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

async function buildDocxZip(documentXml = DOCUMENT_XML, commentsXml: string | null = COMMENTS_XML): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("word/document.xml", documentXml);
  if (commentsXml !== null) zip.file("word/comments.xml", commentsXml);
  return zip.generateAsync({ type: "nodebuffer" });
}

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;

const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>Region</t></si><si><t>North</t></si><si><r><t>So</t></r><r><t>uth &amp; Co.</t></r></si><si><t>Total</t></si></sst>`;

const SALES_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>42</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="inlineStr"><is><t xml:space="preserve"> inline value </t></is></c><c r="C2"><v>7.5</v></c></row></sheetData></worksheet>`;

// sparse on purpose: A1 and B5 only -- the grid must be filled dense to 5 rows x 2 columns
const NOTES_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="5"><c r="B5" t="inlineStr"><is><t>far cell</t></is></c></row></sheetData></worksheet>`;

async function buildXlsxZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("xl/workbook.xml", WORKBOOK_XML);
  zip.file("xl/_rels/workbook.xml.rels", WORKBOOK_RELS);
  zip.file("xl/sharedStrings.xml", SHARED_STRINGS);
  zip.file("xl/worksheets/sheet1.xml", SALES_SHEET);
  zip.file("xl/worksheets/sheet2.xml", NOTES_SHEET);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Uncompressed bytes of every file entry, keyed by name (jszip on both sides makes comparisons independent of our writer). */
async function entryBytes(buf: Buffer): Promise<Record<string, Buffer>> {
  const zip = await JSZip.loadAsync(buf);
  const out: Record<string, Buffer> = {};
  for (const [name, file] of Object.entries(zip.files)) if (!file.dir) out[name] = Buffer.from(await file.async("nodebuffer"));
  return out;
}

/** Run fn, require it to throw, and return the thrown error (this node's assert.throws does not return it). */
function thrown(fn: () => unknown): Error & { code?: string } {
  try { fn(); } catch (err) { if (err instanceof Error) return err as Error & { code?: string }; throw err; }
  throw new assert.AssertionError({ message: "expected the call to throw" });
}

/* ---------------- parseDocx ---------------- */

test("parseDocx extracts paragraphs, joined text and comments with entity decoding", async () => {
  const doc = parseDocx(await buildDocxZip());
  assert.deepEqual(doc.paragraphs, [
    "Hello & welcome to <Office>.",
    "Alpha beta",
    "", // the empty paragraph is kept, on purpose
    "Gamma one and gamma two",
  ]);
  assert.equal(doc.text, doc.paragraphs.join("\n"));
  assert.deepEqual(doc.comments, [
    { id: "1", author: "Alice Adams", date: "2026-10-25T10:00:00Z", text: "Fix the title." },
    { id: "2", author: "Bob Brown", text: "@agent please review" }, // no w:date attribute -> no date field
  ]);
});

test("parseDocx treats a missing comments part as no comments, and rejects non-docx zips", async () => {
  const doc = parseDocx(await buildDocxZip(DOCUMENT_XML, null));
  assert.deepEqual(doc.comments, []);
  const plainZip = await new JSZip().file("readme.txt", "no document here").generateAsync({ type: "nodebuffer" });
  assert.equal(thrown(() => parseDocx(plainZip)).code, "missing_part");
});

/* ---------------- parseXlsx ---------------- */

test("parseXlsx resolves shared strings and inlineStr across both sheets, dense grid", async () => {
  const book = parseXlsx(await buildXlsxZip());
  assert.deepEqual(book.sheetNames, ["Sales", "Notes"]);
  assert.deepEqual(book.sheets["Sales"], [
    ["Region", "North", "42"], // shared string, shared string, numeric kept as stored text
    ["South & Co.", " inline value ", "7.5"], // rich-text si (two runs) + inlineStr with padding kept
  ]);
  assert.deepEqual(book.sheets["Notes"], [
    ["1", ""],
    ["", ""],
    ["", ""],
    ["", ""],
    ["", "far cell"], // sparse cells filled dense to the farthest used row/column
  ]);
});

test("parseXlsx names the hidden sheets (state hidden or veryHidden), in the workbook's order", async () => {
  assert.deepEqual(parseXlsx(await buildXlsxZip()).hiddenSheets, []);
  const zip = await JSZip.loadAsync(await buildXlsxZip());
  zip.file("xl/workbook.xml", WORKBOOK_XML.replace('name="Sales"', 'name="Sales" state="visible"').replace('name="Notes"', 'name="Notes" state="hidden"'));
  const book = parseXlsx(await zip.generateAsync({ type: "nodebuffer" }));
  assert.deepEqual(book.sheetNames, ["Sales", "Notes"]);
  assert.deepEqual(book.hiddenSheets, ["Notes"]);
  zip.file("xl/workbook.xml", WORKBOOK_XML.replace('name="Sales"', 'name="Sales" state="veryHidden"'));
  assert.deepEqual(parseXlsx(await zip.generateAsync({ type: "nodebuffer" })).hiddenSheets, ["Sales"]);
});

test("parseXlsx bounds the dense grid of sparse far-out cells (memory/CPU cap, honest truncation)", async () => {
  // The review's attack shape: a ~1.7 KB xlsx with few cells referencing huge coordinates used to densify to
  // row x col PER SHEET and allocate hundreds of MB (+~18 s CPU). Each sheet here holds exactly two cells --
  // A1 and one near the axis caps (row 20000, column 500 = MAX_GRID_COLS) -- so every sheet's PRODUCT is
  // ~10M slots; the bounded grid must materialize at most floor(MAX_SHEET_CELLS / 500) rows per sheet and flag it.
  const colLetters = (n: number): string => { let s = ""; while (n > 0) { const d = (n - 1) % 26; s = String.fromCharCode(65 + d) + s; n = Math.floor((n - 1) / 26); } return s; };
  const farRef = `${colLetters(500)}20000`; // the 500th column (zero-based 499), row 20000 -- both at the axis caps
  const sheetXml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>origin</t></is></c></row><row r="20000"><c r="${farRef}" t="inlineStr"><is><t>far away</t></is></c></row></sheetData></worksheet>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("xl/workbook.xml", `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${[1, 2, 3].map((i) => `<sheet name="S${i}" sheetId="${i}" r:id="rId${i}"/>`).join("")}</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[1, 2, 3].map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join("")}</Relationships>`);
  for (const i of [1, 2, 3]) zip.file(`xl/worksheets/sheet${i}.xml`, sheetXml);
  const buf = await zip.generateAsync({ type: "nodebuffer" });

  const t0 = Date.now();
  const book = parseXlsx(buf); // must stay fast and bounded -- the pre-fix run took ~18 s CPU / ~523 MB heap here
  assert.ok(Date.now() - t0 < 2000, `parseXlsx on a tiny sparse xlsx must be fast (took ${Date.now() - t0} ms)`);
  assert.deepEqual(book.sheetNames, ["S1", "S2", "S3"]);
  for (const name of book.sheetNames) {
    const grid = book.sheets[name];
    assert.ok(grid.length > 0, `${name}: the origin row is within budget`);
    assert.equal(grid[0][0], "origin", `${name}: A1 readable in the affordable rows`);
    assert.ok(grid.length < 20000, `${name}: grid height bounded (got ${grid.length} rows, file references row 20000)`);
    assert.equal(book.truncatedSheets[name], true, `${name}: the skipped far rows are reported honestly`);
  }
});

/* ---------------- rewriteZip ---------------- */

test("rewriteZip with no changes round-trips: parse-equal and every entry content-identical", async () => {
  const original = await buildDocxZip();
  const rewritten = rewriteZip(original, {});
  assert.deepEqual(parseDocx(rewritten), parseDocx(original));
  const before = await entryBytes(original);
  const after = await entryBytes(rewritten);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const name of Object.keys(before)) assert.ok(Buffer.compare(before[name], after[name]) === 0, `entry ${name} content changed`);
});

test("rewriteZip replaces word/document.xml in place and reflects it on reparse", async () => {
  const original = await buildDocxZip();
  const edited = DOCUMENT_XML.replace("Gamma one", "Delta nine");
  const rewritten = rewriteZip(original, { "word/document.xml": edited });
  assert.equal(parseDocx(rewritten).paragraphs[3], "Delta nine and gamma two");
  assert.deepEqual(parseDocx(rewritten).comments, parseDocx(original).comments);
  const before = await entryBytes(original);
  const after = await entryBytes(rewritten);
  for (const name of Object.keys(before)) {
    if (name === "word/document.xml") continue;
    assert.ok(Buffer.compare(before[name], after[name]) === 0, `entry ${name} content changed`);
  }
});

test("rewriteZip appends a new part and leaves the rest untouched", async () => {
  const original = await buildDocxZip();
  const rewritten = rewriteZip(original, { "word/media/hello.txt": Buffer.from("a binary \u0000\u0001 part", "latin1") });
  const after = await entryBytes(rewritten);
  const before = await entryBytes(original);
  assert.equal(after["word/media/hello.txt"].toString("latin1"), "a binary \u0000\u0001 part");
  for (const name of Object.keys(before)) assert.ok(Buffer.compare(before[name], after[name]) === 0, `entry ${name} content changed`);
});

test("rewriteZip matches part names case-insensitively (no shadow duplicate) and dedupes case variants last-one-wins", async () => {
  const original = await buildDocxZip();
  const beforeNames = Object.keys(await entryBytes(original)).sort();

  // a key that differs only in case from the existing part must OVERWRITE it in place (original name kept), not shadow it
  const edited = DOCUMENT_XML.replace("Gamma one", "Case fixed");
  const out1 = rewriteZip(original, { "WORD/DOCUMENT.XML": edited });
  assert.deepEqual(Object.keys(await entryBytes(out1)).sort(), beforeNames, "no shadow part was added");
  assert.equal(parseDocx(out1).paragraphs[3], "Case fixed and gamma two");

  // two change keys differing only in case dedupe to the LAST one (jszip last-one-wins), still exactly one part
  const other = DOCUMENT_XML.replace("Gamma one", "Last wins");
  const out2 = rewriteZip(original, { "word/document.xml": edited, "WORD/DOCUMENT.XML": other });
  assert.equal(parseDocx(out2).paragraphs[3], "Last wins and gamma two");
  assert.deepEqual(Object.keys(await entryBytes(out2)).sort(), beforeNames);
});

/* ---------------- CRC validation on read ---------------- */

test("a zip entry whose data no longer matches its CRC-32 is rejected loudly (invalid_zip)", async () => {
  // Build the docx with STORED entries so corrupting a payload byte breaks ONLY the CRC (deflate corruption
  // could fail earlier in the inflate step and would not prove the CRC check itself).
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("word/document.xml", DOCUMENT_XML);
  const clean = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  assert.equal(parseDocx(clean).paragraphs[0], "Hello & welcome to <Office>.", "the uncorrupt STORED archive parses");

  // Find the LFH of word/document.xml and flip one byte of its (stored) payload.
  const needle = Buffer.from("word/document.xml", "utf8");
  const corrupted = Buffer.from(clean);
  let flipped = false;
  for (let i = 0; i + 30 + needle.length <= corrupted.length; i++) {
    if (corrupted.readUInt32LE(i) !== 0x04034b50) continue; // local file header signature
    const nameLen = corrupted.readUInt16LE(i + 26);
    const extraLen = corrupted.readUInt16LE(i + 28);
    if (nameLen !== needle.length || !corrupted.subarray(i + 30, i + 30 + nameLen).equals(needle)) continue;
    corrupted[i + 30 + nameLen + extraLen] ^= 0xff; // stored: payload starts right after the name
    flipped = true;
    break;
  }
  assert.ok(flipped, "located the stored word/document.xml entry to corrupt");

  const err = thrown(() => parseDocx(corrupted));
  assert.equal(err.code, "invalid_zip");
  assert.match(err.message, /CRC mismatch for word\/document\.xml/);
  // and rewriting (persisting) the corrupt archive fails too -- corruption is never re-persisted with its old CRC
  const rewriteErr = thrown(() => rewriteZip(corrupted, {}));
  assert.equal(rewriteErr.code, "invalid_zip");
});

/* ---------------- readZip archive-level expansion cap ---------------- */

test("readZip refuses an archive whose COMBINED advertised expansion exceeds the 1 GiB archive cap", () => {
  // Hand-crafted zip with NO payload bytes: 6 central-directory records each advertising 200 MiB (deflate method) --
  // every entry stays UNDER the 256 MiB per-entry cap on purpose; 1.2 GiB total crosses the 1 GiB archive cap.
  // readZip trips in its CD loop before any payload is read, so the buffer never needs real data.
  const N = 6;
  const rec = 46 + 8; // central-directory record (fixed part) + name "part.xml"
  const cdSize = N * rec;
  const buf = Buffer.alloc(cdSize + 22);
  for (let i = 0; i < N; i++) {
    const p = i * rec;
    buf.writeUInt32LE(0x02014b50, p); // central directory file header signature
    buf.writeUInt16LE(8, p + 10); // compression method (deflate)
    buf.writeUInt32LE(200 * 1024 * 1024, p + 24); // uncompressed size -- under the per-entry cap ON PURPOSE
    buf.writeUInt16LE(8, p + 28); // file name length
    buf.write("part.xml", p + 46);
  }
  const eocd = cdSize;
  buf.writeUInt32LE(0x06054b50, eocd); // end of central directory signature
  buf.writeUInt16LE(N, eocd + 10); // total number of entries
  buf.writeUInt32LE(cdSize, eocd + 12); // size of the central directory
  buf.writeUInt32LE(0, eocd + 16); // offset of the central directory
  assert.throws(() => parseDocx(buf), /archive cap/);
});

/* ---------------- comment threads ---------------- */

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"`;

test("docxThreads: a comment with its replies, solved, its GUID the durableId, its author's user id and its quote; a comment on the document from its own parts", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("word/document.xml", `<w:document ${W}><w:body><w:p><w:r><w:t xml:space="preserve">Revenue </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>was revised</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:t>.</w:t></w:r></w:p></w:body></w:document>`);
  zip.file("word/comments.xml", `<w:comments ${W}>` +
    `<w:comment w:id="0" w:author="Portal" w:date="2026-10-27T10:00:00Z"><w:p w14:paraId="1A2B3C4D"><w:r><w:t>Bitte übersetzen +Aegis</w:t></w:r></w:p></w:comment>` +
    `<w:comment w:id="1" w:author="Aegis (agent)" w:date="2026-10-27T10:01:00Z"><w:p w14:paraId="5E6F7A8B"><w:r><w:t>Done: was updated.</w:t></w:r></w:p></w:comment>` +
    `<w:comment w:id="2" w:author="Portal"><w:p w14:paraId="00000011"><w:r><w:t>Danke</w:t></w:r></w:p></w:comment>` +
    `</w:comments>`);
  zip.file("word/commentsExtended.xml", `<w15:commentsEx ${W}><w15:commentEx w15:paraId="1A2B3C4D" w15:done="1"/><w15:commentEx w15:paraId="5E6F7A8B" w15:paraIdParent="1A2B3C4D" w15:done="0"/><w15:commentEx w15:paraId="00000011" w15:paraIdParent="1A2B3C4D" w15:done="0"/></w15:commentsEx>`);
  zip.file("word/commentsIds.xml", `<w16cid:commentsIds ${W}><w16cid:commentId w16cid:paraId="1A2B3C4D" w16cid:durableId="626360DF"/><w16cid:commentId w16cid:paraId="5E6F7A8B" w16cid:durableId="0A000001"/></w16cid:commentsIds>`);
  zip.file("word/people.xml", `<w15:people ${W}><w15:person w15:author="Portal"><w15:presenceInfo w15:providerId="Teamlab" w15:userId="portal-user"/></w15:person><w15:person w15:author="Aegis (agent)"><w15:presenceInfo w15:providerId="Teamlab" w15:userId="agent:abc"/></w15:person></w15:people>`);
  zip.file("word/commentsDocument.xml", `<w:comments ${W}><w:comment w:id="0" w:author="Portal"><w:p w14:paraId="22222222"><w:r><w:t>On the whole document</w:t></w:r></w:p></w:comment></w:comments>`);
  zip.file("word/commentsIdsDocument.xml", `<w16cid:commentsIds ${W}><w16cid:commentId w16cid:paraId="22222222" w16cid:durableId="7164B85F"/></w16cid:commentsIds>`);
  const threads = docxThreads(await zip.generateAsync({ type: "nodebuffer" }));
  assert.equal(threads.length, 2);
  assert.deepEqual(threads[0], {
    guid: "626360df",
    author: "Portal",
    userId: "portal-user",
    date: "2026-10-27T10:00:00Z",
    text: "Bitte übersetzen +Aegis",
    solved: true,
    quote: "was revised",
    replies: [
      { author: "Aegis (agent)", userId: "agent:abc", date: "2026-10-27T10:01:00Z", text: "Done: was updated." },
      { author: "Portal", userId: "portal-user", text: "Danke" },
    ],
  });
  assert.equal(threads[1].guid, "7164b85f");
  assert.equal(threads[1].text, "On the whole document");
  assert.equal(threads[1].quote, undefined);
});

test("docxThreads: a file an outside tool saved, with no durableIds or extended parts, gives each comment as a thread without a GUID", async () => {
  const threads = docxThreads(await buildDocxZip());
  assert.deepEqual(threads.map((t) => [t.guid, t.author, t.text, t.solved, t.replies.length]), [["", "Alice Adams", "Fix the title.", false, 0], ["", "Bob Brown", "@agent please review", false, 0]]);
});

test("xlsxThreads: the threaded comments of each sheet, replies by parentId, names and user ids from the persons part", async () => {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", WORKBOOK_XML);
  zip.file("xl/_rels/workbook.xml.rels", WORKBOOK_RELS);
  zip.file("xl/worksheets/sheet1.xml", `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`);
  zip.file("xl/worksheets/sheet2.xml", `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`);
  zip.file("xl/worksheets/_rels/sheet2.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/></Relationships>`);
  zip.file("xl/threadedComments/threadedComment1.xml", `<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">` +
    `<threadedComment ref="B2" dT="2026-10-27T10:00:00.00" personId="{P1}" id="{CEDAB90E-0000-4000-8000-000000000001}" done="1"><text>Bitte prüfen +Aegis &amp; danke</text></threadedComment>` +
    `<threadedComment ref="B2" dT="2026-10-27T10:01:00.00" personId="{P2}" id="{CEDAB90E-0000-4000-8000-000000000002}" parentId="{CEDAB90E-0000-4000-8000-000000000001}"><text xml:space="preserve">Geprüft.
</text></threadedComment>` +
    `</ThreadedComments>`);
  zip.file("xl/persons/person.xml", `<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><person displayName="Portal" id="{P1}" userId="portal-user" providerId="Teamlab"/><person displayName="Aegis (agent)" id="{P2}" userId="agent:abc" providerId="Teamlab"/></personList>`);
  const threads = xlsxThreads(await zip.generateAsync({ type: "nodebuffer" }));
  assert.deepEqual(threads, [
    {
      guid: "{CEDAB90E-0000-4000-8000-000000000001}",
      author: "Portal",
      userId: "portal-user",
      date: "2026-10-27T10:00:00.00",
      text: "Bitte prüfen +Aegis & danke",
      solved: true,
      sheet: "Notes",
      cell: "B2",
      replies: [{ author: "Aegis (agent)", userId: "agent:abc", date: "2026-10-27T10:01:00.00", text: "Geprüft." }],
    },
  ]);
});
