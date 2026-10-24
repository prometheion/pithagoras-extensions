import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Selkies' web client as the package serves it (pages/stream) is the one the image's Selkies has: the files the image's
 * build checks (server/selkies-web.sha256) are these, byte for byte, and these are all of the client the package has,
 * beside the shim and Selkies' licence.
 */

const STREAM = path.resolve(import.meta.dirname, "../pages/stream");
const LIST = readFileSync(path.resolve(import.meta.dirname, "../server/selkies-web.sha256"), "utf8").trim().split("\n");

test("the package's Selkies client is the one the image's build checks, file by file", () => {
  const listed = new Map(LIST.map((line) => {
    const [sum, file] = line.split(/\s+/);
    return [file.replace(/^\.\//, ""), sum];
  }));
  for (const [file, sum] of listed) assert.equal(createHash("sha256").update(readFileSync(path.join(STREAM, file))).digest("hex"), sum, file);
  const here = readdirSync(STREAM, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(STREAM, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();
  assert.deepEqual(here, [...listed.keys(), "LICENSE", "__gs_shim.js"].sort());
  assert.match(readFileSync(path.join(STREAM, "LICENSE"), "utf8"), /^Mozilla Public License Version 2\.0/);
});
