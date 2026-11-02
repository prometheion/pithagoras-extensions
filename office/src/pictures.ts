/**
 * The pictures an agent puts into a document (office_edit's `picture` ops): a file of its own folder, read as the agent,
 * told by its first bytes to be a PNG, a JPEG or a GIF, and its size read from the header before a byte is sent to the
 * editor. Nothing here decodes a picture: the caps are on what the header says (the pixels the editor will have to
 * decode, the frames of a GIF) and on the bytes, so that a small file that unpacks to a huge picture never reaches the
 * agents' browser.
 */

/** The most a picture's file may take, and all the pictures of one call (each use of a file counts): 5 and 10 MB, as the
 * owner set them (of 1,000,000 bytes, as the refusals say them). */
export const MAX_PICTURE_BYTES = 5_000_000;
export const MAX_PICTURES_BYTES = 10_000_000;
/** The most pixels a picture may have decoded (width times height). */
export const MAX_PICTURE_PIXELS = 40_000_000;
/** The most frames a GIF may have: the editor shows the first, but its browser decodes them all. */
export const MAX_GIF_FRAMES = 100;
/** The most pictures one call carries: each is uploaded to the Document Server by the editor. */
export const MAX_PICTURES = 20;

/** A picture as the editor is given it: its data URL, its size in pixels and its file's size. */
export type PictureFile = { data: string; px: { w: number; h: number }; bytes: number; name: string };

/** Why a file is not taken for a picture. */
export class PictureError extends Error {}

const MIME = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif" } as const;

type Info = { kind: keyof typeof MIME; width: number; height: number; frames: number };

/** What the header of `bytes` says: the kind (by its magic bytes, not its name), the pixels, a GIF's frames. Throws a
 * PictureError for a file that is none of the three, whose header is cut or says nothing, or whose size is past a cap. */
export function pictureInfo(bytes: Buffer): Info {
  const { end: _end, ...info } = inspected(bytes);
  return info;
}

/** pictureInfo's, and where the picture ends: the bytes a file has after its end marker (PNG's IEND, a JPEG's EOI, a
 * GIF's trailer) are not the picture, and are not sent. The file's length where no end is found (a cut file, which the
 * browser draws as far as it goes). */
function inspected(bytes: Buffer): Info & { end: number } {
  const info = header(bytes);
  if (info.width < 1 || info.height < 1) throw new PictureError("its header says it has no pixels");
  pixelsCapped(info.width, info.height);
  return info;
}

function pixelsCapped(width: number, height: number): void {
  if (width * height > MAX_PICTURE_PIXELS) throw new PictureError(`it is ${width} × ${height} pixels (${(Math.round((width * height) / 100_000) / 10).toLocaleString("en")} megapixels), and a picture may have ${MAX_PICTURE_PIXELS / 1_000_000} megapixels at most: scale it down first`);
}

function header(b: Buffer): Info & { end: number } {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    // The first chunk is IHDR: length 13, "IHDR", width, height.
    if (b.length < 24 || b.readUInt32BE(8) !== 13 || b.toString("latin1", 12, 16) !== "IHDR") throw new PictureError("it starts like a PNG, but its header is damaged");
    return { kind: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20), frames: 1, end: pngEnd(b) };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ...jpeg(b), end: jpegEnd(b) };
  if (b.length >= 6 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) return gif(b);
  throw new PictureError("it is not a PNG, JPEG or GIF (a file is told by its first bytes, not by its name)");
}

/** A JPEG's size is in its frame header (SOFn), after the segments before it; sideways where its EXIF orientation (5 to
 * 8, a phone's portrait photo) has it turned a quarter, as the browser and the Document Server show it. */
function jpeg(b: Buffer): { kind: "jpeg"; width: number; height: number; frames: number } {
  let at = 2;
  let turned = false;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) throw new PictureError("it starts like a JPEG, but its segments are damaged");
    const marker = b[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Markers without a length: the standalone ones; the scan or the end before a frame header means there is none.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = b.readUInt16BE(at + 2);
    if (length < 2) break;
    // SOF0 to SOF15, except DHT (c4), JPG (c8) and DAC (cc): precision, height, width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > b.length) break;
      const [height, width] = [b.readUInt16BE(at + 5), b.readUInt16BE(at + 7)];
      return turned ? { kind: "jpeg", width: height, height: width, frames: 1 } : { kind: "jpeg", width, height, frames: 1 };
    }
    if (marker === 0xe1) turned ||= (orientation(b.subarray(at + 4, Math.min(b.length, at + 2 + length))) ?? 1) >= 5;
    at += 2 + length;
  }
  throw new PictureError("it starts like a JPEG, but has no frame header that says its size");
}

/** The orientation (EXIF tag 0x0112, 1 to 8) an APP1 segment's body gives, if it is EXIF and says one. */
function orientation(app1: Buffer): number | undefined {
  if (app1.length < 14 || app1.toString("latin1", 0, 6) !== "Exif\0\0") return undefined;
  const tiff = app1.subarray(6);
  const order = tiff.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return undefined;
  const u16 = (k: number) => (order === "II" ? tiff.readUInt16LE(k) : tiff.readUInt16BE(k));
  const u32 = (k: number) => (order === "II" ? tiff.readUInt32LE(k) : tiff.readUInt32BE(k));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const count = u16(ifd);
  for (let k = 0; k < count && ifd + 2 + 12 * (k + 1) <= tiff.length; k++) {
    const entry = ifd + 2 + 12 * k;
    if (u16(entry) === 0x0112) return u16(entry + 2) === 3 ? u16(entry + 8) : undefined;
  }
  return undefined;
}

/** A GIF's screen size is in its header; its frames are counted by walking the blocks (no pixel is decoded), and the
 * walk ends at the cap. A frame may lie outside the screen (its own place and size, up to 65,535 each): the browser
 * then makes the picture as large as the first frame needs, and its decoder holds the frames that far. So the size is
 * the screen grown to the first frame, and the cap is on the screen grown to every frame. */
function gif(b: Buffer): Info & { end: number } {
  if (b.length < 13) throw new PictureError("it starts like a GIF, but its header is cut");
  let width = b.readUInt16LE(6);
  let height = b.readUInt16LE(8);
  let [allW, allH] = [width, height];
  let at = 13 + (b[10] & 0x80 ? 3 * 2 ** ((b[10] & 7) + 1) : 0);
  let frames = 0;
  let end = b.length;
  // Sub-blocks: a length byte and that many bytes, ended by a zero length.
  const skipBlocks = () => {
    while (at < b.length && b[at] !== 0) at += 1 + b[at];
    at++;
  };
  while (at < b.length) {
    const block = b[at++];
    if (block === 0x3b) {
      end = at;
      break;
    }
    if (block === 0x21) {
      at++;
      skipBlocks();
    } else if (block === 0x2c) {
      if (++frames > MAX_GIF_FRAMES) throw new PictureError(`it has more than ${MAX_GIF_FRAMES} frames, and a GIF may have ${MAX_GIF_FRAMES} at most`);
      if (at + 9 > b.length) throw new PictureError("it starts like a GIF, but its frames are cut");
      const [right, bottom] = [b.readUInt16LE(at) + b.readUInt16LE(at + 4), b.readUInt16LE(at + 2) + b.readUInt16LE(at + 6)];
      if (frames === 1) [width, height] = [Math.max(width, right), Math.max(height, bottom)];
      [allW, allH] = [Math.max(allW, right), Math.max(allH, bottom)];
      pixelsCapped(allW, allH);
      const flags = b[at + 8];
      at += 9 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0) + 1;
      skipBlocks();
    } else throw new PictureError("it starts like a GIF, but its blocks are damaged");
  }
  if (!frames) throw new PictureError("it starts like a GIF, but holds no frame");
  return { kind: "gif", width, height, frames, end };
}

/** Where a PNG ends: after its IEND chunk (length, type, data, CRC from the eighth byte on). */
function pngEnd(b: Buffer): number {
  let at = 8;
  while (at + 12 <= b.length) {
    const length = b.readUInt32BE(at);
    const next = at + 12 + length;
    if (b.toString("latin1", at + 4, at + 8) === "IEND") return Math.min(next, b.length);
    at = next;
  }
  return b.length;
}

/** Where a JPEG ends: after its EOI, walking its segments (each scan's data up to the next marker: 0xff before 0x00 is
 * a byte of the data, before 0xd0 to 0xd7 a restart in it). A segment's own bytes are skipped by its length, so an EXIF
 * thumbnail's EOI is not taken for the picture's. */
function jpegEnd(b: Buffer): number {
  let at = 2;
  while (at + 2 <= b.length) {
    if (b[at] !== 0xff) return b.length;
    const marker = b[at + 1];
    if (marker === 0xd9) return at + 2;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (at + 4 > b.length) return b.length;
    at += 2 + b.readUInt16BE(at + 2);
    if (marker !== 0xda) continue;
    while (at + 1 < b.length && !(b[at] === 0xff && b[at + 1] !== 0x00 && !(b[at + 1] >= 0xd0 && b[at + 1] <= 0xd7) && b[at + 1] !== 0xff)) at++;
  }
  return b.length;
}

/**
 * A file's bytes as the editor is given them: checked against the caps (its size before a byte is read, `size`), told
 * by its header and sized, as a data URL. `name` is what the file is called, for the picture's alt text.
 */
export function pictureFile(read: () => Buffer, size: number, name: string): PictureFile {
  pictureSized(size);
  const file = read();
  const info = inspected(file);
  const bytes = file.subarray(0, info.end);
  return { data: `data:${MIME[info.kind]};base64,${bytes.toString("base64")}`, px: { w: info.width, h: info.height }, bytes: bytes.length, name };
}

/** Throws where a file of `size` bytes is past a picture's cap. */
export function pictureSized(size: number): void {
  if (size > MAX_PICTURE_BYTES) throw new PictureError(`it is ${megabytes(size)} MB, and a picture may take ${MAX_PICTURE_BYTES / 1_000_000} MB at most: scale it down or save it as a JPEG`);
}

/** Bytes in MB, one decimal (and never "5.0" for a size past 5 MB). */
export const megabytes = (bytes: number) => (Math.ceil(bytes / 100_000) / 10).toFixed(1);
