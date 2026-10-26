import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { PANEL_HTML, panelPageJs } from "./page.mts";

/**
 * The chat's Office panel (client.tsx's chat.panel entry) and the office tools' cards (its chat.tool entries), loaded
 * as the portal loads the extension, in a browser with the portal's own React, beside a stand-in conversation whose
 * panel host does what Chat.tsx does, against routes that answer as the server half does and a stand-in for the
 * Document Server's api.js. A document opened there opens in the panel, beside the chat, never in the Office tab; the
 * same editor component as the tab's, at the panel's widths, destroyed when it is left. The real Document Server in a
 * real portal's panel is real-portal.test.mts's.
 *
 *   ./scripts/pithagoras.sh && PITHAGORAS_DIR=$PWD/.pithagoras npm run test:portal -w office
 */

const DIR = process.env.PITHAGORAS_DIR;
if (!DIR) throw new Error("PITHAGORAS_DIR is not set: run scripts/pithagoras.sh, then PITHAGORAS_DIR=.pithagoras npm run test:portal");
const BASE = "/api/x/%40pithagoras/office";
const CSS = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/client.css"), "utf8");

/** The stand-in's api.js: an editor that fills its frame into its placeholder, and says what it was made and destroyed
 * with, in order. */
const FAKE_API = `window.DocsAPI = { DocEditor: function (id, config) {
  const frame = document.createElement("iframe");
  frame.dataset.key = config.document.key;
  document.getElementById(id).replaceWith(frame);
  const log = (window.__fake = window.__fake || []);
  log.push(["made", config.document.key, id]);
  return { destroyEditor() { log.push(["destroyed", config.document.key]); frame.remove(); } };
} };`;

const DOC = (docId: string, title: string, ext: "docx" | "xlsx") => ({ docId, title, ext, createdAt: 0, updatedAt: 0, sizeBytes: 1, mtimeMs: 1, owner: null, grants: [] });
const DOCS = [DOC("d1", "Plan", "docx"), DOC("d2", "Budget", "xlsx")];
/** Documents the server half has made since the page last asked (an agent's new one). */
const made: ReturnType<typeof DOC>[] = [];

let pageJs = "";
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
  if (url.pathname === "/panel.html") return send(200, "text/html", PANEL_HTML);
  if (url.pathname === "/panel-page.js") return send(200, "text/javascript", pageJs);
  if (url.pathname === "/client.css") return send(200, "text/css", CSS);
  if (url.pathname === "/fake-api.js") return send(200, "text/javascript", FAKE_API);
  if (url.pathname === `${BASE}/state`) {
    return send(200, "application/json", JSON.stringify({ enabled: true, imageTag: "x", container: { state: "running" }, agent: { present: true, pull: null, tag: "t" }, docs: [...DOCS, ...made], locks: { d1: [], d2: [] } }));
  }
  if (url.pathname === `${BASE}/scope`) return send(200, "application/json", JSON.stringify({ docIds: DOCS.map((d) => d.docId) }));
  if (url.pathname === `${BASE}/editor-config` && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const doc = (JSON.parse(raw) as { doc: string }).doc;
    // One key per document, as the server half mints it while its session stands: two views join one session.
    return send(200, "application/json", JSON.stringify({ document: { key: `key-${doc}`, fileType: "docx" }, token: "t", apiJs: "/fake-api.js" }));
  }
  if (url.pathname === `${BASE}/editor-state`) return send(200, "application/json", JSON.stringify({ standing: "current" }));
  send(404, "application/json", "{}");
});
let origin = "";
let browser: Browser;

before(async () => {
  pageJs = await panelPageJs(path.resolve(DIR), BASE);
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

type Seen = { navigated: string[]; opens: [string, unknown][]; kept?: boolean; fake: [string, string, string?][] };
const seen = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __navigated: string[]; __opens: [string, unknown][]; __kept?: boolean; __fake?: [string, string, string?][] };
    return { navigated: w.__navigated, opens: w.__opens, kept: w.__kept, fake: w.__fake ?? [] } as Seen;
  });

/** A chat whose conversation holds cards of these calls. */
async function chatPage(calls: unknown[] = [], query = ""): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 800 } })).newPage();
  await page.addInitScript((given) => ((window as unknown as { __calls: unknown[] }).__calls = given), calls);
  await page.goto(`${origin}/panel.html${query}`);
  await page.getByRole("button", { name: "Office panel button" }).waitFor({ timeout: 10_000 });
  return page;
}

const panel = (page: Page) => page.locator("#panel");
const frames = (page: Page, where: string) => page.locator(`${where} .po-host iframe`);
const openRow = (page: Page, title: string) => panel(page).locator(".po-open", { hasText: title }).click();
const editorOf = async (page: Page, key: string) => frames(page, "#panel").and(page.locator(`[data-key="${key}"]`)).waitFor({ timeout: 10_000 });

const call = (name: string, details: Record<string, unknown>) => ({ name, status: "done", input: {}, details });
const EDIT = call("office_edit", { action: "edit", id: "d2", title: "Budget", ext: "xlsx", from: 1, to: 2, ops: 1 });
const LIST = call("office_list", { action: "list", documents: [{}, {}] });

test("a row of the chat's Office panel opens its document in the panel, beside the chat, never the Office tab; back is the list again; a control opens it in the tab", async () => {
  const page = await chatPage();
  await page.getByRole("button", { name: "Office panel button" }).click();
  await openRow(page, "Plan");
  await editorOf(page, "key-d1");
  assert.equal(await panel(page).locator(".po-editor-title").innerText(), "Plan.docx");
  let now = await seen(page);
  assert.deepEqual(now.navigated, [], "the page stays on the chat");
  assert.equal(now.kept, true, "not the panel closed to make room for a third while a document is open in it");
  await panel(page).getByRole("button", { name: "← All documents" }).click();
  await panel(page).locator(".po-open", { hasText: "Budget" }).waitFor();
  now = await seen(page);
  assert.deepEqual(now.fake, [["made", "key-d1", now.fake[0][2]], ["destroyed", "key-d1"]], "the editor destroyed as the list comes back");
  assert.equal(await page.locator("[id^=po-doceditor]").count(), 0, "no placeholder left");
  assert.equal(now.kept, false);
  await openRow(page, "Budget");
  await editorOf(page, "key-d2");
  await panel(page).getByRole("button", { name: "Open in the Office tab" }).click();
  assert.deepEqual((await seen(page)).navigated, ["/x/@pithagoras/office/office?doc=d2"]);
  await page.context().close();
});

test("an office tool's card opens its document in the chat's Office panel (the panel's params), not the tab; again after another was chosen there; a list's card opens the panel's list", async () => {
  const page = await chatPage([EDIT, LIST]);
  const cards = page.locator("#conversation").getByRole("button", { name: "Open in Office" });
  await cards.nth(0).click();
  await editorOf(page, "key-d2");
  let now = await seen(page);
  assert.deepEqual(now.opens, [["office", { doc: "d2" }]]);
  assert.deepEqual(now.navigated, []);
  // Another document chosen in the panel; the card opens its own again.
  await panel(page).getByRole("button", { name: "← All documents" }).click();
  await openRow(page, "Plan");
  await editorOf(page, "key-d1");
  await cards.nth(0).click();
  await editorOf(page, "key-d2");
  await cards.nth(1).click();
  await panel(page).locator(".po-open", { hasText: "Plan" }).waitFor({ timeout: 10_000 });
  now = await seen(page);
  assert.deepEqual(now.opens.at(-1), ["office", {}]);
  assert.equal(await frames(page, "#panel").count(), 0);
  assert.deepEqual(now.navigated, [], "never the Office tab");
  await page.context().close();
});

test("switching documents destroys the editor before the next is made, and closing the panel destroys it", async () => {
  const page = await chatPage([EDIT]);
  await page.getByRole("button", { name: "Office panel button" }).click();
  await openRow(page, "Plan");
  await editorOf(page, "key-d1");
  await page.locator("#conversation").getByRole("button", { name: "Open in Office" }).click();
  await editorOf(page, "key-d2");
  assert.equal(await frames(page, "#panel").count(), 1, "one editor in the panel");
  let log = (await seen(page)).fake.map(([what, key]) => `${what} ${key}`);
  assert.deepEqual(log, ["made key-d1", "destroyed key-d1", "made key-d2"]);
  await page.getByRole("button", { name: "Close the panel" }).click();
  await panel(page).waitFor({ state: "detached" });
  log = (await seen(page)).fake.map(([what, key]) => `${what} ${key}`);
  assert.deepEqual(log, ["made key-d1", "destroyed key-d1", "made key-d2", "destroyed key-d2"]);
  assert.equal(await page.locator("iframe, [id^=po-doceditor]").count(), 0, "nothing of it left on the page");
  await page.context().close();
});

test("at the panel's widths (560 px, dragged to 320 and 900, docked at the bottom) the editor fills the panel under its bar, and nothing scrolls sideways", async () => {
  const page = await chatPage();
  await page.getByRole("button", { name: "Office panel button" }).click();
  await openRow(page, "Plan");
  await editorOf(page, "key-d1");
  for (const dock of [{ w: 560, h: 320, dock: "right" }, { w: 320, h: 320, dock: "right" }, { w: 900, h: 320, dock: "right" }, { w: 560, h: 320, dock: "bottom" }]) {
    await page.evaluate((d) => (window as unknown as { __dock(d: unknown): void }).__dock(d), dock);
    await page.waitForTimeout(100);
    // A string, not a function: tsx names the helpers of a function, which the page does not have.
    const box = (await page.evaluate(`(function () {
      var aside = document.querySelector("#panel");
      var body = aside.lastElementChild;
      var bar = aside.querySelector(".po-editor-bar");
      return {
        body: body.getBoundingClientRect().toJSON(),
        bar: bar.getBoundingClientRect().toJSON(),
        frame: aside.querySelector(".po-host iframe").getBoundingClientRect().toJSON(),
        sideways: [aside, body, bar].filter(function (el) { return el.scrollWidth > el.clientWidth + 1; }).map(function (el) { return el.className || el.tagName; }),
      };
    })()`)) as { body: DOMRect; bar: DOMRect; frame: DOMRect; sideways: string[] };
    const label = JSON.stringify(dock);
    assert.deepEqual(box.sideways, [], `${label}: nothing wider than its place`);
    assert.ok(Math.abs(box.frame.width - box.body.width) <= 1, `${label}: the editor is as wide as the panel (${box.frame.width} of ${box.body.width})`);
    assert.ok(Math.abs(box.frame.top - box.bar.bottom) <= 1, `${label}: right under the bar`);
    assert.ok(Math.abs(box.frame.bottom - box.body.bottom) <= 1, `${label}: down to the panel's foot (${box.frame.bottom} of ${box.body.bottom})`);
    if (dock.dock === "right") assert.ok(Math.abs(box.body.width - dock.w) <= 1, `${label}: the panel is the width it was given`);
  }
  await page.context().close();
});

test("the same document in the Office tab and in the panel: two editors of the one session, each in a placeholder of its own; closing the panel leaves the tab's", async () => {
  const page = await chatPage([], "?tab=d1");
  await frames(page, "#tab").waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Office panel button" }).click();
  await openRow(page, "Plan");
  await editorOf(page, "key-d1");
  const made = (await seen(page)).fake.filter(([what]) => what === "made");
  assert.deepEqual(made.map(([, key]) => key), ["key-d1", "key-d1"], "both with the document's one session key");
  assert.notEqual(made[0][2], made[1][2], "each in its own placeholder");
  assert.equal(await frames(page, "#tab").count(), 1);
  await page.getByRole("button", { name: "Close the panel" }).click();
  await panel(page).waitFor({ state: "detached" });
  assert.equal(await frames(page, "#tab").count(), 1, "the tab's editor stays");
  assert.deepEqual((await seen(page)).fake.filter(([what]) => what === "destroyed").length, 1);
  await page.context().close();
});

test("a document an agent just made opens from its card at once, never said to be gone while the last answer is older than it", async () => {
  made.length = 0;
  const page = await chatPage([call("office_create", { action: "create", id: "d3", title: "Minutes", ext: "docx" }), call("office_read", { action: "read", id: "nope", title: "Old", ext: "docx" })]);
  const cards = page.locator("#conversation").getByRole("button", { name: "Open in Office" });
  // Whether the page ever said the document is gone, however briefly.
  await page.evaluate(`new MutationObserver(function () {
    if (document.body.innerText.includes("no longer in the library")) window.__saidGone = true;
  }).observe(document.body, { childList: true, subtree: true, characterData: true })`);
  await page.getByRole("button", { name: "Office panel button" }).click();
  await panel(page).locator(".po-open", { hasText: "Plan" }).waitFor({ timeout: 10_000 });
  // Made now: the page's last answer (and its next poll, 5 s on) does not have it yet.
  made.push(DOC("d3", "Minutes", "docx"));
  await cards.nth(0).click();
  await frames(page, "#panel").and(page.locator('[data-key="key-d3"]')).waitFor({ timeout: 3_000 });
  assert.equal(await page.evaluate("window.__saidGone === true"), false, "never said to be gone");
  // One that is gone is said so, once an answer asked since says it.
  await cards.nth(1).click();
  await panel(page).getByText("This document is no longer in the library.", { exact: false }).waitFor({ timeout: 3_000 });
  made.length = 0;
  await page.context().close();
});
