import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { stream } from "../src/server/pages.ts";

/** Selkies' client at /ui/stream/, from the package's pages/stream, wherever the package is installed. */

// As npm installs it for the portal: under the agent's ~/.pi, a folder whose name starts with a dot.
const root = mkdtempSync(path.join(os.tmpdir(), "godot-pages-"));
const pages = path.join(root, ".pi", "agent", "npm", "node_modules", "@pithagoras", "godot", "pages");
mkdirSync(path.join(pages, "stream", "assets"), { recursive: true });
writeFileSync(path.join(pages, "stream", "index.html"), '<html><head><script src="./assets/index-a.js"></script></head></html>');
writeFileSync(path.join(pages, "stream", "__gs_shim.js"), "window.shim = 1;");
writeFileSync(path.join(pages, "stream", "assets", "index-a.js"), "console.log(1);");
writeFileSync(path.join(pages, "stream", "LICENSE"), "MPL-2.0");
writeFileSync(path.join(pages, "secret.txt"), "not the client's");

const app = express();
app.use("/ui", stream(pages));
app.use((_req, res) => void res.status(404).send("not here"));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ui`;
after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

test("the client's files are sent from a package installed under a dot folder, as npm installs it", async () => {
  const page = await fetch(`${base}/stream/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /^<html><head><script src="__gs_shim.js"><\/script><script src=".\/assets\/index-a.js">/);
  for (const [file, body] of [["__gs_shim.js", "window.shim = 1;"], ["assets/index-a.js", "console.log(1);"]]) {
    const res = await fetch(`${base}/stream/${file}`);
    assert.equal(res.status, 200, file);
    assert.equal(await res.text(), body, file);
    assert.equal(res.headers.get("content-security-policy"), "frame-ancestors 'self'", file);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", file);
  }
});

test("nothing else is sent from there: not the licence, not a file outside the client, not a path out of it", async () => {
  for (const file of ["LICENSE", "../secret.txt", "%2e%2e/secret.txt", "assets/missing.js"]) {
    const res = await fetch(`${base}/stream/${file}`);
    assert.equal(res.status, 404, file);
    assert.equal(await res.text(), "not here", file);
  }
});
