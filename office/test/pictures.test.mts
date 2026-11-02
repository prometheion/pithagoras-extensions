/**
 * Unit tests for src/pictures.ts: a picture is told by its first bytes, sized from its header, and held to the caps
 * before anything is decoded or sent. The files here are headers only (no pixel data): the module reads nothing more.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_GIF_FRAMES, MAX_PICTURE_BYTES, MAX_PICTURE_PIXELS, PictureError, pictureFile, pictureInfo } from "../src/pictures";

/** The first chunk of a PNG, IHDR, for a picture of `w` by `h` pixels. */
function png(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

/** A JPEG with a JFIF segment and a comment before its frame header (SOF0, or `sof`), then a scan. */
function jpeg(w: number, h: number, sof = 0xc0): Buffer {
  const jfif = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0", "latin1"), Buffer.alloc(9)]);
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x07]), Buffer.from("hello", "latin1")]);
  const frame = Buffer.from([0xff, sof, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, comment, frame, Buffer.from([0xff, 0xda, 0x00, 0x02])]);
}

/** A GIF of `frames` frames of 1 x 1 (or `frame`: its place and size) on a screen of `w` x `h`, with a global colour
 * table and an extension first. */
function gif(w: number, h: number, frames: number, version = "GIF89a", frame?: { left: number; top: number; w: number; h: number }): Buffer {
  const head = Buffer.alloc(13);
  head.write(version, 0, "latin1");
  head.writeUInt16LE(w, 6);
  head.writeUInt16LE(h, 8);
  head[10] = 0x80; // a global colour table of 2 colours
  const table = Buffer.alloc(6);
  const extension = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]); // graphic control, ended by its 0 length
  const one = Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00]);
  if (frame) [frame.left, frame.top, frame.w, frame.h].forEach((v, k) => one.writeUInt16LE(v, 1 + 2 * k));
  return Buffer.concat([head, table, extension, ...Array.from({ length: frames }, () => one), Buffer.from([0x3b])]);
}

/** An APP1 EXIF segment saying `orientation` (tag 0x0112), in the byte order `order`. */
function exif(orientation: number, order: "II" | "MM" = "MM"): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 2 * 12 + 4);
  const u16 = (v: number, at: number) => (order === "II" ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at));
  const u32 = (v: number, at: number) => (order === "II" ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at));
  tiff.write(order, 0, "latin1");
  u16(42, 2);
  u32(8, 4);
  u16(2, 8);
  // An entry before it (the camera's make, a text elsewhere), then the orientation: SHORT, one value.
  u16(0x010f, 10);
  u16(2, 12);
  u32(4, 14);
  u32(0, 18);
  u16(0x0112, 22);
  u16(3, 24);
  u32(1, 26);
  u16(orientation, 30);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/** A JPEG as jpeg() makes it, with `app1` right after its start. */
const withApp1 = (j: Buffer, app1: Buffer) => Buffer.concat([j.subarray(0, 2), app1, j.subarray(2)]);

const refuses = (b: Buffer, pattern: RegExp) => assert.throws(() => pictureInfo(b), (e) => e instanceof PictureError && pattern.test(e.message), String(pattern));

test("a PNG, a JPEG and a GIF are told by their first bytes, and sized from their headers", () => {
  assert.deepEqual(pictureInfo(png(640, 480)), { kind: "png", width: 640, height: 480, frames: 1 });
  assert.deepEqual(pictureInfo(jpeg(1920, 1080)), { kind: "jpeg", width: 1920, height: 1080, frames: 1 });
  assert.deepEqual(pictureInfo(jpeg(300, 200, 0xc2)), { kind: "jpeg", width: 300, height: 200, frames: 1 }, "a progressive JPEG (SOF2)");
  assert.deepEqual(pictureInfo(gif(320, 240, 3)), { kind: "gif", width: 320, height: 240, frames: 3 });
  assert.equal(pictureInfo(gif(10, 10, 1, "GIF87a")).kind, "gif");
});

test("a file is what its first bytes say, whatever it is called: other formats, text and cut or damaged headers are refused", () => {
  refuses(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), /not a PNG, JPEG or GIF/);
  refuses(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), /not a PNG, JPEG or GIF/);
  refuses(Buffer.alloc(0), /not a PNG, JPEG or GIF/);
  refuses(png(1, 1).subarray(0, 20), /PNG, but its header is damaged/);
  const notIhdr = png(1, 1);
  notIhdr.write("IDAT", 12, "latin1");
  refuses(notIhdr, /PNG, but its header is damaged/);
  refuses(jpeg(10, 10).subarray(0, 12), /JPEG, but has no frame header/);
  refuses(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), Buffer.from([0xff, 0xd9])]), /JPEG, but has no frame header/);
  refuses(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x03, 0x00, 0x58, 0x58, 0x58, 0x58]), /JPEG, but its segments are damaged/);
  refuses(gif(10, 10, 1).subarray(0, 9), /GIF, but its header is cut/);
  refuses(gif(10, 10, 0), /holds no frame/);
  refuses(Buffer.concat([gif(10, 10, 1).subarray(0, 27), Buffer.from([0x99])]), /GIF, but its blocks are damaged/);
});

test("a picture with no pixels, or past 40 megapixels as its header says, is refused before it is read; 40 megapixels exactly is taken", () => {
  refuses(png(0, 10), /no pixels/);
  refuses(jpeg(0, 0), /no pixels/);
  refuses(gif(0, 0, 1, "GIF89a", { left: 0, top: 0, w: 0, h: 0 }), /no pixels/);
  // 8,000 x 5,000 is 40 MP; one more row is past it. A 100 kB PNG can say 100,000 x 100,000.
  assert.equal(pictureInfo(png(8000, 5000)).width, 8000);
  assert.equal(MAX_PICTURE_PIXELS, 40_000_000);
  refuses(png(8000, 5001), /8000 × 5001 pixels \(40 megapixels\), and a picture may have 40 megapixels at most/);
  refuses(png(100_000, 100_000), /10,000 megapixels/);
  refuses(png(0xffffffff, 0xffffffff), /megapixels/);
  refuses(gif(65535, 65535, 1), /megapixels/);
});

test("a GIF's frames that reach past its screen count: the picture is as large as the first frame makes it (as the browser makes it), and the cap is on every frame's reach", () => {
  // 35 bytes: a screen of 1 x 1 and one frame of 1 x 1 at 7999, 5999, which Chromium decodes as 8,000 x 6,000 (48 MP).
  const far = gif(1, 1, 1, "GIF89a", { left: 7999, top: 5999, w: 1, h: 1 });
  refuses(far, /it is 8000 × 6000 pixels \(48 megapixels\), and a picture may have 40 megapixels at most/);
  refuses(gif(1, 1, 1, "GIF89a", { left: 0, top: 0, w: 60000, h: 60000 }), /it is 60000 × 60000 pixels \(3,600 megapixels\)/);
  refuses(gif(100, 100, 1, "GIF89a", { left: 0, top: 0, w: 8000, h: 6000 }), /8000 × 6000 pixels/);
  refuses(gif(1, 1, 1, "GIF89a", { left: 65535, top: 65535, w: 65535, h: 65535 }), /131070 × 131070 pixels/);
  // A first frame wider than the screen makes the picture wider; within the cap it is taken at that size.
  assert.deepEqual(pictureInfo(gif(100, 100, 1, "GIF89a", { left: 0, top: 0, w: 200, h: 50 })), { kind: "gif", width: 200, height: 100, frames: 1 });
  assert.deepEqual(pictureInfo(gif(0, 0, 1, "GIF89a", { left: 0, top: 0, w: 30, h: 20 })), { kind: "gif", width: 30, height: 20, frames: 1 }, "a screen of 0 is the first frame's size");
  // A later frame's reach counts against the cap: 100 frames on a 1 x 1 screen, each 1 x 1 but far out.
  const later = Buffer.concat([gif(1, 1, 1).subarray(0, -1), gif(1, 1, 1, "GIF89a", { left: 7999, top: 5999, w: 1, h: 1 }).subarray(27)]);
  refuses(later, /8000 × 6000 pixels/);
});

test("a JPEG turned a quarter by its EXIF orientation (5 to 8, a phone's portrait photo) is sized as it is shown; 1 to 4, none, or a damaged EXIF leave it", () => {
  const stored = jpeg(4000, 3000);
  for (const o of [5, 6, 7, 8]) assert.deepEqual(pictureInfo(withApp1(stored, exif(o))), { kind: "jpeg", width: 3000, height: 4000, frames: 1 }, `orientation ${o}`);
  assert.deepEqual(pictureInfo(withApp1(stored, exif(6, "II"))), { kind: "jpeg", width: 3000, height: 4000, frames: 1 }, "little-endian EXIF");
  for (const o of [1, 2, 3, 4]) assert.deepEqual(pictureInfo(withApp1(stored, exif(o))), { kind: "jpeg", width: 4000, height: 3000, frames: 1 }, `orientation ${o}`);
  // An APP1 that is no EXIF (XMP), and one cut short, are passed over.
  const ns = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1");
  const xmp = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, ns.length + 2]), ns]);
  assert.equal(pictureInfo(withApp1(stored, xmp)).width, 4000);
  const cut = exif(6);
  cut.writeUInt16BE(12, 2);
  assert.equal(pictureInfo(withApp1(stored, Buffer.concat([cut.subarray(0, 14)]))).width, 4000);
});

test("the bytes after a picture's end (after PNG's IEND, a JPEG's EOI, a GIF's trailer) are not sent; a file without an end is sent whole", () => {
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const idat = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("IDAT", "latin1"), Buffer.from([1, 2, 3]), Buffer.alloc(4)]);
  const fullPng = Buffer.concat([png(2, 2), idat, iend]);
  const hidden = Buffer.from("a secret hidden after the picture".repeat(30));
  const sent = (b: Buffer) => Buffer.from(pictureFile(() => b, b.length, "x").data.replace(/^data:[^,]*,/, ""), "base64");
  assert.deepEqual(sent(Buffer.concat([fullPng, hidden])), fullPng);
  assert.equal(pictureFile(() => Buffer.concat([fullPng, hidden]), fullPng.length + hidden.length, "x").bytes, fullPng.length);
  assert.deepEqual(sent(fullPng), fullPng);
  // A JPEG: an EXIF thumbnail's EOI inside APP1 is not its end, nor a 0xff of its data (0xff 0x00) or a restart marker.
  const thumb = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x0a]), Buffer.from("Exif\0\0", "latin1"), Buffer.from([0xff, 0xd9])]);
  const scan = Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0xd9]);
  const fullJpeg = Buffer.concat([jpeg(10, 10).subarray(0, -4), thumb, scan]);
  assert.deepEqual(sent(Buffer.concat([fullJpeg, hidden])), fullJpeg);
  assert.deepEqual(sent(Buffer.concat([fullJpeg, Buffer.from([0xff, 0xd8]), hidden])), fullJpeg, "a second picture after it (a phone's multi-picture JPEG) goes too");
  // A progressive JPEG: tables between its scans.
  const progressive = Buffer.concat([jpeg(10, 10, 0xc2).subarray(0, -4), Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xc4, 0x00, 0x03, 0x00, 0xff, 0xda, 0x00, 0x02, 0x33, 0xff, 0xd9])]);
  assert.deepEqual(sent(Buffer.concat([progressive, hidden])), progressive);
  const fullGif = gif(4, 4, 2);
  assert.deepEqual(sent(Buffer.concat([fullGif, hidden])), fullGif);
  // Cut files (no end found) are sent as they are.
  for (const b of [jpeg(10, 10), png(3, 3), gif(4, 4, 1).subarray(0, -1)]) assert.deepEqual(sent(b), b);
});

test("a GIF of more than 100 frames is refused as the 101st is counted, and one of 100 is taken", () => {
  assert.equal(pictureInfo(gif(8, 8, MAX_GIF_FRAMES)).frames, 100);
  refuses(gif(8, 8, MAX_GIF_FRAMES + 1), /more than 100 frames/);
  // Counted block by block: a GIF of thousands of frames stops at the cap and does not walk them all.
  const started = Date.now();
  refuses(gif(8, 8, 50_000), /more than 100 frames/);
  assert.ok(Date.now() - started < 1000);
});

test("pictureFile: the size cap is on the file's size before a byte is read; a file within it is a data URL of its own type, with its pixels", () => {
  let read = 0;
  assert.throws(
    () => pictureFile(() => (read++, png(1, 1)), MAX_PICTURE_BYTES + 1, "big.png"),
    (e) => e instanceof PictureError && /^it is 5\.1 MB, and a picture may take 5 MB at most/.test(e.message),
  );
  assert.equal(read, 0, "nothing was read");
  // MB as the owner gave them, of 1,000,000 bytes: a file of 5,000,001 bytes is past it.
  assert.equal(MAX_PICTURE_BYTES, 5_000_000);
  assert.throws(() => pictureFile(() => png(1, 1), 5_000_001, "over.png"), PictureError);
  const file = pictureFile(() => jpeg(40, 20), 100, "photo.jpg");
  assert.equal(file.px.w, 40);
  assert.equal(file.px.h, 20);
  assert.equal(file.name, "photo.jpg");
  assert.equal(file.bytes, jpeg(40, 20).length);
  assert.equal(file.data, `data:image/jpeg;base64,${jpeg(40, 20).toString("base64")}`);
  assert.match(pictureFile(() => png(2, 2), 40, "a.png").data, /^data:image\/png;base64,/);
  assert.match(pictureFile(() => gif(2, 2, 1), 40, "a.gif").data, /^data:image\/gif;base64,/);
  // A file exactly at the cap is taken.
  assert.equal(pictureFile(() => png(1, 1), MAX_PICTURE_BYTES, "edge.png").px.w, 1);
});
