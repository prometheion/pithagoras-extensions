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

/** A GIF of `frames` frames of 1 x 1 on a screen of `w` x `h`, with a global colour table and an extension first. */
function gif(w: number, h: number, frames: number, version = "GIF89a"): Buffer {
  const head = Buffer.alloc(13);
  head.write(version, 0, "latin1");
  head.writeUInt16LE(w, 6);
  head.writeUInt16LE(h, 8);
  head[10] = 0x80; // a global colour table of 2 colours
  const table = Buffer.alloc(6);
  const extension = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]); // graphic control, ended by its 0 length
  const frame = Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00]);
  return Buffer.concat([head, table, extension, ...Array.from({ length: frames }, () => frame), Buffer.from([0x3b])]);
}

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
  refuses(gif(0, 5, 1), /no pixels/);
  // 8,000 x 5,000 is 40 MP; one more row is past it. A 100 kB PNG can say 100,000 x 100,000.
  assert.equal(pictureInfo(png(8000, 5000)).width, 8000);
  assert.equal(MAX_PICTURE_PIXELS, 40_000_000);
  refuses(png(8000, 5001), /8000 × 5001 pixels \(40 megapixels\), and a picture may have 40 megapixels at most/);
  refuses(png(100_000, 100_000), /10,000 megapixels/);
  refuses(png(0xffffffff, 0xffffffff), /megapixels/);
  refuses(gif(65535, 65535, 1), /megapixels/);
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
    (e) => e instanceof PictureError && /may take 5 MB at most/.test(e.message),
  );
  assert.equal(read, 0, "nothing was read");
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
