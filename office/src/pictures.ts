/**
 * The pictures an agent puts into a document (office_edit's `picture` ops): a file of its own folder, read as the agent,
 * told by its first bytes to be a PNG, a JPEG or a GIF, and its size read from the header before a byte is sent to the
 * editor. Nothing here decodes a picture: the caps are on what the header says (the pixels the editor will have to
 * decode, the frames of a GIF) and on the bytes, so that a small file that unpacks to a huge picture never reaches the
 * agents' browser.
 */

/** The most a picture's file may take, and all the pictures of one call (each use of a file counts). */
export const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
export const MAX_PICTURES_BYTES = 10 * 1024 * 1024;
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

/** What the header of `bytes` says: the kind (by its magic bytes, not its name), the pixels, a GIF's frames. Throws a
 * PictureError for a file that is none of the three, whose header is cut or says nothing, or whose size is past a cap. */
export function pictureInfo(bytes: Buffer): { kind: keyof typeof MIME; width: number; height: number; frames: number } {
  const info = header(bytes);
  if (info.width < 1 || info.height < 1) throw new PictureError("its header says it has no pixels");
  if (info.width * info.height > MAX_PICTURE_PIXELS) throw new PictureError(`it is ${info.width} × ${info.height} pixels (${(Math.round((info.width * info.height) / 100_000) / 10).toLocaleString("en")} megapixels), and a picture may have ${MAX_PICTURE_PIXELS / 1_000_000} megapixels at most: scale it down first`);
  return info;
}

function header(b: Buffer): { kind: keyof typeof MIME; width: number; height: number; frames: number } {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    // The first chunk is IHDR: length 13, "IHDR", width, height.
    if (b.length < 24 || b.readUInt32BE(8) !== 13 || b.toString("latin1", 12, 16) !== "IHDR") throw new PictureError("it starts like a PNG, but its header is damaged");
    return { kind: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20), frames: 1 };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpeg(b);
  if (b.length >= 6 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) return gif(b);
  throw new PictureError("it is not a PNG, JPEG or GIF (a file is told by its first bytes, not by its name)");
}

/** A JPEG's size is in its frame header (SOFn), after the segments before it. */
function jpeg(b: Buffer): { kind: "jpeg"; width: number; height: number; frames: number } {
  let at = 2;
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
      return { kind: "jpeg", height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7), frames: 1 };
    }
    at += 2 + length;
  }
  throw new PictureError("it starts like a JPEG, but has no frame header that says its size");
}

/** A GIF's screen size is in its header; its frames are counted by walking the blocks (no pixel is decoded), and the
 * walk ends at the cap. */
function gif(b: Buffer): { kind: "gif"; width: number; height: number; frames: number } {
  if (b.length < 13) throw new PictureError("it starts like a GIF, but its header is cut");
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  let at = 13 + (b[10] & 0x80 ? 3 * 2 ** ((b[10] & 7) + 1) : 0);
  let frames = 0;
  // Sub-blocks: a length byte and that many bytes, ended by a zero length.
  const skipBlocks = () => {
    while (at < b.length && b[at] !== 0) at += 1 + b[at];
    at++;
  };
  while (at < b.length) {
    const block = b[at++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      at++;
      skipBlocks();
    } else if (block === 0x2c) {
      if (++frames > MAX_GIF_FRAMES) throw new PictureError(`it has more than ${MAX_GIF_FRAMES} frames, and a GIF may have ${MAX_GIF_FRAMES} at most`);
      if (at + 9 > b.length) throw new PictureError("it starts like a GIF, but its frames are cut");
      const flags = b[at + 8];
      at += 9 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0) + 1;
      skipBlocks();
    } else throw new PictureError("it starts like a GIF, but its blocks are damaged");
  }
  if (!frames) throw new PictureError("it starts like a GIF, but holds no frame");
  return { kind: "gif", width, height, frames };
}

/**
 * A file's bytes as the editor is given them: checked against the caps (its size before a byte is read, `size`), told
 * by its header and sized, as a data URL. `name` is what the file is called, for the picture's alt text.
 */
export function pictureFile(read: () => Buffer, size: number, name: string): PictureFile {
  if (size > MAX_PICTURE_BYTES) throw new PictureError(`it is ${(size / 1048576).toFixed(1)} MB, and a picture may take ${MAX_PICTURE_BYTES / 1048576} MB at most: scale it down or save it as a JPEG`);
  const bytes = read();
  const info = pictureInfo(bytes);
  return { data: `data:${MIME[info.kind]};base64,${bytes.toString("base64")}`, px: { w: info.width, h: info.height }, bytes: bytes.length, name };
}
