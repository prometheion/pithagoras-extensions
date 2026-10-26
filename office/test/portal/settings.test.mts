import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { SETTINGS_HTML, settingsPageJs } from "./page.mts";

/**
 * The Office page in Settings (src/web/settings.tsx) in a browser, with the portal's own React, against routes that
 * answer as the server half does: how the Document Server and the agents' editor stand, and Start, which downloads
 * both images (the route holds its answer until the test lets it go, as a real first start does for minutes).
 *
 *   ./scripts/pithagoras.sh && PITHAGORAS_DIR=$PWD/.pithagoras npm run test:portal -w office
 */

const DIR = process.env.PITHAGORAS_DIR;
if (!DIR) throw new Error("PITHAGORAS_DIR is not set: run scripts/pithagoras.sh, then PITHAGORAS_DIR=.pithagoras npm run test:portal");
const BASE = "/api/x/%40pithagoras/office";
const TAG = "chromedp/headless-shell:157.0.8103.15";

type Pull = null | { active: boolean; line: string; error?: string };
/** What /state says, what was asked of the routes, and what a Start does while it runs and when it ends. */
const now = {
  container: { state: "running", version: "10.0.0-169" } as { state: string; version?: string; pull?: Pull; error?: string },
  agent: { present: false, pull: null as Pull, tag: TAG, browser: { running: false, starting: false, editors: 0 } as { running: boolean; starting: boolean; editors: number; error?: string } },
};
const asked: string[] = [];
let starting: { during(): void; after(): void } = { during() {}, after() {} };
let release: () => void = () => {};
let pageJs = "";
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
  if (url.pathname === "/settings.html") return send(200, "text/html", SETTINGS_HTML);
  if (url.pathname === "/settings-page.js") return send(200, "text/javascript", pageJs);
  if (url.pathname === `${BASE}/state`) {
    return send(200, "application/json", JSON.stringify({ enabled: true, imageTag: "onlyoffice/documentserver:10.0.0.1", container: now.container, agent: now.agent, docs: [], locks: {} }));
  }
  if (req.method === "POST") asked.push(url.pathname.slice(BASE.length));
  if (url.pathname === `${BASE}/container/start` && req.method === "POST") {
    starting.during();
    new Promise<void>((r) => (release = r)).then(() => {
      starting.after();
      send(200, "application/json", JSON.stringify({ started: true, container: now.container, agent: { present: now.agent.present } }));
    });
    return;
  }
  send(404, "application/json", JSON.stringify({ error: "no such route" }));
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
  release();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  asked.length = 0;
  starting = { during() {}, after() {} };
});

async function opened(): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${origin}/settings.html`);
  await row(page, "OnlyOffice Document Server").waitFor({ timeout: 10_000 });
  return page;
}

const row = (page: Page, name: string) => page.getByRole("status", { name });
const said = async (page: Page, name: string, text: string) => row(page, name).getByText(text, { exact: true }).waitFor({ timeout: 10_000 });
const start = (page: Page) => page.getByRole("button", { name: "Start container", exact: true });

test("the Document Server running and the agents' editor missing: the page says so, has no download of its own, and Start gets the image", async () => {
  Object.assign(now, {
    container: { state: "running", version: "10.0.0-169" },
    agent: { present: false, pull: null, tag: TAG, browser: { running: false, starting: false, editors: 0 } },
  });
  const page = await opened();
  await said(page, "OnlyOffice Document Server", "Running");
  await said(page, "The agents' editor", "Missing: Start downloads it");
  assert.equal(await row(page, "The agents' editor").getByText(TAG).count(), 1, "the pinned image is named");
  assert.equal(await page.getByRole("button", { name: /^Download/ }).count(), 0, "no download of its own");
  assert.equal(await start(page).isEnabled(), true, "Start, though the Document Server runs");
  starting = {
    during: () => void (now.agent.pull = { active: true, line: "Downloading [==>   ] 50MB/540MB" }),
    after: () => Object.assign(now.agent, { present: true, pull: { active: false, line: "done" } }),
  };
  await start(page).click();
  await said(page, "The agents' editor", "Downloading");
  await row(page, "The agents' editor").getByText("Downloading [==>   ] 50MB/540MB").waitFor({ timeout: 10_000 });
  assert.equal(await page.getByRole("button", { name: "Starting…" }).isDisabled(), true, "no second start while one goes");
  release();
  await said(page, "The agents' editor", "Ready");
  assert.deepEqual(asked, ["/container/start"]);
  assert.equal(await start(page).isDisabled(), true, "everything is there: nothing to start");
  // An agent at work: its browser runs, with the documents open in it.
  now.agent.browser = { running: true, starting: false, editors: 2 };
  await said(page, "The agents' editor", "Running · 2 documents open");
  await page.context().close();
});

test("a first Start: both downloads shown at once, then the Document Server starting and running beside a ready agents' editor", async () => {
  Object.assign(now, {
    container: { state: "stopped", pull: null },
    agent: { present: false, pull: null, tag: TAG, browser: { running: false, starting: false, editors: 0 } },
  });
  const page = await opened();
  await said(page, "OnlyOffice Document Server", "Stopped");
  starting = {
    during: () => {
      now.container.pull = { active: true, line: "Pulling fs layer 3/41" };
      now.agent.pull = { active: true, line: "Downloading [=>    ] 20MB/540MB" };
    },
    after: () => {
      Object.assign(now.container, { state: "starting", pull: { active: false, line: "done" } });
      Object.assign(now.agent, { present: true, pull: { active: false, line: "done" } });
    },
  };
  await start(page).click();
  await row(page, "OnlyOffice Document Server").getByText("Pulling fs layer 3/41").waitFor({ timeout: 10_000 });
  await row(page, "The agents' editor").getByText("Downloading [=>    ] 20MB/540MB").waitFor({ timeout: 10_000 });
  await said(page, "OnlyOffice Document Server", "Downloading");
  await said(page, "The agents' editor", "Downloading");
  release();
  await said(page, "OnlyOffice Document Server", "Starting");
  await said(page, "The agents' editor", "Ready");
  Object.assign(now.container, { state: "running", version: "10.0.0-169" });
  await said(page, "OnlyOffice Document Server", "Running");
  await row(page, "OnlyOffice Document Server").getByText("10.0.0-169").waitFor({ timeout: 10_000 });
  await page.context().close();
});

test("what failed is said in its row, with the error: a start of the Document Server, the image's download, the agents' browser", async () => {
  Object.assign(now, {
    container: { state: "stopped", error: "port is already allocated" },
    agent: { present: false, pull: { active: false, line: "", error: `${TAG} is not the build this version of Office runs (sha256:${"0".repeat(64)})` }, tag: TAG, browser: { running: false, starting: false, editors: 0 } },
  });
  const page = await opened();
  await said(page, "OnlyOffice Document Server", "Failed");
  await row(page, "OnlyOffice Document Server").getByText("port is already allocated").waitFor();
  await said(page, "The agents' editor", "Failed");
  await row(page, "The agents' editor").getByText("is not the build this version of Office runs", { exact: false }).waitFor();
  assert.equal(await start(page).isEnabled(), true, "Start tries both again");
  // The image is there, but the browser made from it did not start.
  Object.assign(now, {
    container: { state: "running" },
    agent: { present: true, pull: null, tag: TAG, browser: { running: false, starting: false, editors: 0, error: "the agent's editor did not start within 60 s" } },
  });
  await row(page, "The agents' editor").getByText("the agent's editor did not start within 60 s").waitFor({ timeout: 10_000 });
  await said(page, "The agents' editor", "Failed");
  assert.equal(await start(page).isDisabled(), true, "Start would not help: an agent's next call starts the browser again");
  await page.context().close();
});

test("the page says no prose: labels, states and short hints only, none of the explanations it had", async () => {
  Object.assign(now, { container: { state: "running" }, agent: { present: true, pull: null, tag: TAG, browser: { running: false, starting: false, editors: 0 } } });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${origin}/settings.html`);
  await page.getByText("Image tag (pinned)", { exact: false }).first().waitFor({ timeout: 10_000 });
  const text = await page.locator("#root").innerText();
  for (const gone of ["Made documents keep in this extension's own data directory", "The editor loads through this portal's own proxy", "The agents' editor runs in a browser of its own"]) {
    assert.ok(!text.includes(gone), `still says: ${gone}`);
  }
  // Nothing on it reads as a paragraph: every line is a label, a state or a hint.
  const long = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 80);
  assert.deepEqual(long, []);
  await page.context().close();
});
