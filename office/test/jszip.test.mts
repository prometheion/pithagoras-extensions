/**
 * Unit tests for src/jszip.ts: jszip is bundled into the server half, and the loader gives the real package.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsZip } from "../src/jszip";

test("jsZip gives the real package: a bare new() makes a working archive and loadAsync reads it back", async () => {
  const zip = await jsZip();
  assert.equal(typeof zip.version, "string", "jszip exposes its version string");
  const bytes = await new zip().file("a.txt", "hello").generateAsync({ type: "nodebuffer" });
  const back = await zip.loadAsync(bytes);
  assert.equal(await back.file("a.txt")!.async("string"), "hello");
});
