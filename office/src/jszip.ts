/**
 * The jszip loader. jszip is bundled into the built server.js (build.mjs), so it is there whenever this half runs;
 * `jsZip()` stays async because its callers (the store's templates, office_read) already await it, and because jszip
 * only exposes async load/generate anyway.
 */
import JSZip from "jszip";

/** The package's shape: the constructor AND its statics (JSZip.loadAsync). */
export type JSZipStatic = typeof JSZip;

export async function jsZip(): Promise<JSZipStatic> {
  return JSZip;
}
