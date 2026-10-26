import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "@playwright/test";
import { SETTINGS_HTML, settingsPageJs } from "./page.mts";

/**
 * The Office page in Settings (src/web/settings.tsx) in a browser, with the portal's own React, against routes that
 * answer as the server half does: its row for the agents' editor, which says whether the image is there and downloads
 * it on request.
 *
 *   ./scripts/pithagoras.sh && PITHAGORAS_DIR=$PWD/.pithagoras npm run test:portal -w office
 */

const DIR = process.env.PITHAGORAS_DIR;
if (!DIR) throw new Error("PITHAGORAS_DIR is not set: run scripts/pithagoras.sh, then PITHAGORAS_DIR=.pithagoras npm run test:portal");
const BASE = "/api/x/%40pithagoras/office";
const TAG = "chromedp/headless-shell:157.0.8103.15";

/** What /state says of the agents' editor, and the downloads asked for. */
const agent = { present: false, pull: null as null | { active: boolean; line: string; error?: string }, tag: TAG };
const pulls: string[] = [];
let pageJs = "";
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
  if (url.pathname === "/settings.html") return send(200, "text/html", SETTINGS_HTML);
  if (url.pathname === "/settings-page.js") return send(200, "text/javascript", pageJs);
  if (url.pathname === `${BASE}/state`) {
    return send(200, "application/json", JSON.stringify({ enabled: true, imageTag: "onlyoffice/documentserver:10.0.0.1", container: { state: "running" }, agent, docs: [], locks: {} }));
  }
  if (url.pathname === `${BASE}/agent/pull` && req.method === "POST") {
    pulls.push(url.pathname);
    agent.pull = { active: true, line: "Downloading [==>   ] 50MB/540MB" };
    return send(202, "application/json", JSON.stringify({ started: true }));
  }
  send(404, "application/json", "{}");
});
let origin = "";
let browser: Browser;

before(async () => {
  pageJs = await settingsPageJs(path.resolve(DIR), BASE);
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

test("the agents' editor: not downloaded, the row says so and offers the download; downloading, its progress; there, it says so", async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${origin}/settings.html`);
  await page.getByText("The agents' editor", { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByText("Not downloaded", { exact: true }).waitFor();
  assert.equal(await page.getByText(TAG).count(), 1, "the pinned image is named");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await page.getByText("Pulling the image · Downloading [==>   ] 50MB/540MB").waitFor({ timeout: 10_000 });
  assert.deepEqual(pulls, [`${BASE}/agent/pull`]);
  assert.equal(await page.getByRole("button", { name: "Downloading…" }).isDisabled(), true, "no second download while one goes");
  // Done: the next poll says it is there.
  Object.assign(agent, { present: true, pull: { active: false, line: "done" } });
  await page.getByText("Downloaded", { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByRole("button", { name: "Download", exact: true }).count(), 0);
  await page.context().close();
});

test("a download that failed is said in the row, and can be asked again", async () => {
  Object.assign(agent, { present: false, pull: { active: false, line: "", error: `${TAG} is not the build this version of Office runs (sha256:${"0".repeat(64)})` } });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${origin}/settings.html`);
  await page.getByText("is not the build this version of Office runs", { exact: false }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByRole("button", { name: "Download", exact: true }).isEnabled(), true);
  await page.context().close();
});

test("the page says no prose: labels, states and short hints only, none of the explanations it had", async () => {
  Object.assign(agent, { present: true, pull: null });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${origin}/settings.html`);
  await page.getByText("OnlyOffice Document Server", { exact: true }).waitFor({ timeout: 10_000 });
  const text = await page.locator("#root").innerText();
  for (const gone of ["Made documents keep in this extension's own data directory", "The editor loads through this portal's own proxy", "The agents' editor runs in a browser of its own"]) {
    assert.ok(!text.includes(gone), `still says: ${gone}`);
  }
  // Nothing on it reads as a paragraph: every line is a label, a state or a hint.
  const long = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 80);
  assert.deepEqual(long, []);
  await page.context().close();
});
