import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { EDITOR_HTML, editorPageJs } from "./page.mts";

/**
 * The Office page's editor (src/web/office-editor.tsx) in a browser, with the portal's own React, against routes that
 * answer as the server half does and a stand-in for the Document Server's api.js: what it loads, that nothing an
 * agent does reloads it (the agent edits the same session in an editor of its own, so its edits come live), the badge
 * of a file changed on disk, and the banner of a reload that failed. The real Document Server is e2e.test.mts's, which
 * opens this same page.
 *
 *   ./scripts/pithagoras.sh && PITHAGORAS_DIR=$PWD/.pithagoras npm run test:portal -w office
 */

const DIR = process.env.PITHAGORAS_DIR;
if (!DIR) throw new Error("PITHAGORAS_DIR is not set: run scripts/pithagoras.sh, then PITHAGORAS_DIR=.pithagoras npm run test:portal");
const BASE = "/api/x/%40pithagoras/office";

/** The stand-in's api.js: an editor that fills its frame into the placeholder, says its app started and that it is
 * ready, and keeps what it is asked. Without `refreshFile` where the page says so; the first one's app never starting
 * where the page says so. */
const FAKE_API = `window.DocsAPI = { DocEditor: function (id, config) {
  const frame = document.createElement("iframe");
  document.getElementById(id).replaceWith(frame);
  window.__fake = window.__fake || { opened: [], refreshed: [], destroyed: 0 };
  window.__fake.opened.push(config.document.key);
  const fails = window.__appFailsOnce && window.__fake.opened.length === 1;
  if (!fails) setTimeout(() => (config.events.onAppReady && config.events.onAppReady(), config.events.onDocumentReady && config.events.onDocumentReady()), 0);
  const editor = { destroyEditor() { window.__fake.destroyed++; frame.remove(); } };
  if (!window.__noRefreshFile) editor.refreshFile = (next) => window.__fake.refreshed.push(next.document.key);
  return editor;
} };`;

/** What the routes answer: the key a new config gets, how an editor of an older key stands, and whether a config is
 * refused (the Document Server away). */
const routes = { key: "k1", standing: "current" as string, refuse: false };
let pageJs = "";
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
  if (url.pathname === "/editor.html") return send(200, "text/html", EDITOR_HTML);
  if (url.pathname === "/editor-page.js") return send(200, "text/javascript", pageJs);
  if (url.pathname === "/fake-api.js") return send(200, "text/javascript", FAKE_API);
  if (url.pathname === `${BASE}/editor-config` && req.method === "POST") {
    if (routes.refuse) return send(503, "application/json", JSON.stringify({ error: "the document server did not answer", code: "ds_unavailable" }));
    return send(200, "application/json", JSON.stringify({ document: { key: routes.key, fileType: "docx" }, token: "t", apiJs: "/fake-api.js" }));
  }
  if (url.pathname === `${BASE}/editor-state`) return send(200, "application/json", JSON.stringify({ standing: url.searchParams.get("key") === routes.key ? "current" : routes.standing }));
  if (url.pathname === `${BASE}/state`) {
    return send(200, "application/json", JSON.stringify({ enabled: true, imageTag: "x", container: { state: "running" }, docs: [{ docId: "d1", title: "Doc", ext: "docx", createdAt: 0, updatedAt: 0, sizeBytes: 1, mtimeMs: 1, owner: null, grants: [] }], locks: { d1: [] } }));
  }
  send(404, "application/json", "{}");
});
let origin = "";
let browser: Browser;

before(async () => {
  pageJs = await editorPageJs(path.resolve(DIR), BASE);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => Object.assign(routes, { key: "k1", standing: "current", refuse: false }));

/** The page with the editor open on k1. */
async function opened(options: { noRefreshFile?: boolean; appFailsOnce?: boolean } = {}): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  if (options.noRefreshFile) await page.addInitScript(() => ((window as unknown as { __noRefreshFile: boolean }).__noRefreshFile = true));
  if (options.appFailsOnce) await page.addInitScript(() => ((window as unknown as { __appFailsOnce: boolean }).__appFailsOnce = true));
  await page.goto(`${origin}/editor.html?doc=d1`);
  await waitFor(page, () => (window as unknown as { __events: unknown[][] }).__events.some((e) => e[0] === "ready"));
  return page;
}

async function waitFor(page: Page, fn: () => unknown, ms = 5000): Promise<void> {
  await page.waitForFunction(fn, undefined, { timeout: ms });
}

const fake = (page: Page) => page.evaluate(() => (window as unknown as { __fake: { opened: string[]; refreshed: string[]; destroyed: number } }).__fake);
/** What the editor tells the page: true, it holds typing it has not sent yet; false, all of it is sent. */
const typing = (page: Page, unsent: boolean) => page.evaluate((data) => (window as unknown as { __page: { onDocumentStateChange?(e: { data: boolean }): void } }).__page.onDocumentStateChange?.({ data }), unsent);

test("nothing but a change on disk reloads the editor: an agent's edits come live in its own session, and no chip is shown for them", async () => {
  const page = await opened();
  // A newer key and any answer but "behind" (what the page once loaded an agent's revision for): nothing happens.
  Object.assign(routes, { key: "k2", standing: "follow" });
  await delay(2500);
  const made = await fake(page);
  assert.deepEqual(made.refreshed, [], "not reloaded");
  assert.deepEqual(made.opened, ["k1"], "not made again");
  assert.equal(await page.getByText("This document changed on disk since it opened").count(), 0);
  assert.equal(await page.locator(".po-editor-bar .po-chip").count(), 0, "no chip for an agent's edit");
  await page.context().close();
});

test("an editor whose app never says it started (it failed while it loaded) is made anew, once, and opens", async () => {
  const page = await opened({ appFailsOnce: true });
  const made = await fake(page);
  assert.deepEqual(made.opened, ["k1", "k1"], "made again");
  assert.equal(made.destroyed, 1, "the one that did not start is destroyed");
  assert.equal(await page.locator("iframe").count(), 1);
  // Once: an editor that started is not made again.
  await delay(1000);
  assert.deepEqual((await fake(page)).opened, ["k1", "k1"]);
  await page.context().close();
});

test("an editor without refreshFile is made again by the badge's button", async () => {
  const page = await opened({ noRefreshFile: true });
  Object.assign(routes, { key: "k2", standing: "behind" });
  await page.getByRole("button", { name: "reload it (what you typed here since is kept as a copy)" }).click({ timeout: 5000 });
  await waitFor(page, () => (window as unknown as { __fake: { opened: string[] } }).__fake.opened.length > 1);
  const made = await fake(page);
  assert.deepEqual(made.opened, ["k1", "k2"]);
  assert.equal(made.destroyed, 1);
  await page.context().close();
});

test("a file changed on disk: the badge says so, and its button loads the new revision in place", async () => {
  const page = await opened();
  Object.assign(routes, { key: "k2", standing: "behind" });
  const badge = page.getByText("This document changed on disk since it opened");
  await badge.waitFor({ timeout: 5000 });
  assert.deepEqual((await fake(page)).refreshed, [], "not loaded by itself: what is typed there would go to a copy");
  await page.getByRole("button", { name: "reload it (what you typed here since is kept as a copy)" }).click();
  await waitFor(page, () => (window as unknown as { __fake: { refreshed: string[] } }).__fake.refreshed.length > 0);
  assert.deepEqual((await fake(page)).refreshed, ["k2"]);
  await badge.waitFor({ state: "detached", timeout: 5000 });
  await page.context().close();
});

test("the editor asks to be loaded again (its session ended): loaded at once, as what it has not sent cannot be sent any more", async () => {
  const page = await opened();
  await typing(page, true);
  routes.key = "k2";
  await page.evaluate(() => (window as unknown as { __page: { onRequestRefreshFile(): void } }).__page.onRequestRefreshFile());
  await waitFor(page, () => (window as unknown as { __fake: { refreshed: string[] } }).__fake.refreshed.length > 0);
  assert.deepEqual((await fake(page)).refreshed, ["k2"]);
  await page.context().close();
});

test("a reload that fails says so, and the banner goes once a later one loads", async () => {
  const page = await opened();
  Object.assign(routes, { key: "k2", standing: "behind", refuse: true });
  const button = page.getByRole("button", { name: "reload it (what you typed here since is kept as a copy)" });
  await button.click({ timeout: 5000 });
  const banner = page.getByRole("alert");
  await banner.waitFor({ timeout: 5000 });
  assert.match(await banner.innerText(), /the document server did not answer/);
  routes.refuse = false;
  await button.click();
  await waitFor(page, () => (window as unknown as { __fake: { refreshed: string[] } }).__fake.refreshed.length > 0);
  await banner.waitFor({ state: "detached", timeout: 5000 });
  await page.context().close();
});
