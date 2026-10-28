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
 * answer as the server half does: how Office stands (one status, made of the Document Server and the agents' editor),
 * and Start, which downloads both images (the route holds its answer until the test lets it go, as a real first start
 * does for minutes).
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
  limits: { docchatRuns: 2, docchatThreads: 50, docchatReplyChars: 4000, docchatChatMessages: 4, docchatRemoveAfterS: 120, docchatChatEndS: 60, docchatReportsPer10S: 50, docchatMessageChars: 20_000, docchatSaveEveryS: 3, docchatQueued: 20 } as Record<string, number>,
  limitBounds: { docchatRuns: [1, 20], docchatThreads: [1, 1000], docchatReplyChars: [200, 19_990], docchatChatMessages: [1, 20], docchatRemoveAfterS: [0, 86_400], docchatChatEndS: [0, 86_400], docchatReportsPer10S: [10, 1000], docchatMessageChars: [200, 20_000], docchatSaveEveryS: [1, 600], docchatQueued: [1, 200] } as Record<string, [number, number]>,
};
const asked: string[] = [];
const saved: Record<string, unknown>[] = [];
let starting: { during(): void; after(): void } = { during() {}, after() {} };
let release: () => void = () => {};
let pageJs = "";
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
  if (url.pathname === "/settings.html") return send(200, "text/html", SETTINGS_HTML);
  if (url.pathname === "/settings-page.js") return send(200, "text/javascript", pageJs);
  if (url.pathname === `${BASE}/state`) {
    return send(200, "application/json", JSON.stringify({ enabled: true, imageTag: "onlyoffice/documentserver:10.0.0.1", limits: now.limits, limitBounds: now.limitBounds, container: now.container, agent: now.agent, docs: [], locks: {} }));
  }
  if (req.method === "POST") asked.push(url.pathname.slice(BASE.length));
  if (url.pathname === `${BASE}/settings` && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const patch = JSON.parse(body);
      saved.push(patch);
      Object.assign(now.limits, patch);
      send(200, "application/json", JSON.stringify({ settings: { enabled: true, imageTag: "x", ...now.limits }, container: now.container }));
    });
    return;
  }
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
  await office(page).waitFor({ timeout: 10_000 });
  return page;
}

/** Office, as the page shows it: one status, whatever part it stands for. */
const office = (page: Page) => page.getByRole("status", { name: "Office" });
const said = async (page: Page, text: string) => office(page).getByText(text, { exact: true }).waitFor({ timeout: 10_000 });
const start = (page: Page) => page.getByRole("button", { name: "Start container", exact: true });

test("one Office on the page: one status, no part named while all is well, one memory figure", async () => {
  Object.assign(now, {
    container: { state: "running", version: "10.0.0-169" },
    agent: { present: true, pull: null, tag: TAG, browser: { running: true, starting: false, editors: 2 } },
  });
  const page = await opened();
  await said(page, "Running");
  assert.equal(await page.getByRole("status").count(), 1, "one status");
  const text = await page.locator("#root").innerText();
  for (const part of ["Document Server", "agents' editor", "Agents' editor", TAG]) assert.ok(!text.includes(part), `names a part: ${part}`);
  await office(page).getByText("10.0.0-169 · Agents in 2 documents", { exact: true }).waitFor();
  await page.getByText("Recommended: 1 GB of RAM.", { exact: true }).waitFor();
  assert.equal(await start(page).isDisabled(), true, "everything is there: nothing to start");
  await page.context().close();
});

test("the agents' editor missing on a running Office: said, no download of its own, and Start gets the image", async () => {
  Object.assign(now, {
    container: { state: "running", version: "10.0.0-169" },
    agent: { present: false, pull: null, tag: TAG, browser: { running: false, starting: false, editors: 0 } },
  });
  const page = await opened();
  await said(page, "Agents' editor missing: Start downloads it");
  assert.equal(await page.getByRole("button", { name: /^Download/ }).count(), 0, "no download of its own");
  assert.equal(await start(page).isEnabled(), true, "Start, though the Document Server runs");
  starting = {
    during: () => void (now.agent.pull = { active: true, line: "Downloading [==>   ] 50MB/540MB" }),
    after: () => Object.assign(now.agent, { present: true, pull: { active: false, line: "done" } }),
  };
  await start(page).click();
  await said(page, "Downloading");
  await office(page).getByText("Downloading [==>   ] 50MB/540MB").waitFor({ timeout: 10_000 });
  assert.equal(await page.getByRole("button", { name: "Starting…" }).isDisabled(), true, "no second start while one goes");
  release();
  await said(page, "Running");
  assert.deepEqual(asked, ["/container/start"]);
  assert.equal(await start(page).isDisabled(), true, "everything is there: nothing to start");
  await page.context().close();
});

test("a first Start: both downloads as one progress, then starting and running", async () => {
  Object.assign(now, {
    container: { state: "stopped", pull: null },
    agent: { present: false, pull: null, tag: TAG, browser: { running: false, starting: false, editors: 0 } },
  });
  const page = await opened();
  await said(page, "Stopped");
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
  await office(page).getByText("Pulling fs layer 3/41").waitFor({ timeout: 10_000 });
  await office(page).getByText("Downloading [=>    ] 20MB/540MB").waitFor({ timeout: 10_000 });
  await said(page, "Downloading");
  release();
  await said(page, "Starting");
  Object.assign(now.container, { state: "running", version: "10.0.0-169" });
  await said(page, "Running");
  await office(page).getByText("10.0.0-169", { exact: true }).waitFor({ timeout: 10_000 });
  await page.context().close();
});

test("a failure is said with the part that failed and why: a start of the Document Server, the image's download, the agents' browser", async () => {
  Object.assign(now, {
    container: { state: "stopped", error: "port is already allocated" },
    agent: { present: false, pull: { active: false, line: "", error: `${TAG} is not the build this version of Office runs (sha256:${"0".repeat(64)})` }, tag: TAG, browser: { running: false, starting: false, editors: 0 } },
  });
  const page = await opened();
  await said(page, "Failed");
  await office(page).getByText("Document Server: port is already allocated", { exact: true }).waitFor();
  assert.equal(await start(page).isEnabled(), true, "Start tries both again");
  // The Document Server started; the image's download did not.
  Object.assign(now, { container: { state: "running" } });
  await office(page).getByText(`Agents' editor: ${TAG} is not the build this version of Office runs`, { exact: false }).waitFor({ timeout: 10_000 });
  await said(page, "Failed");
  assert.equal(await start(page).isEnabled(), true, "Start downloads it again");
  // The image is there, but the browser made from it did not start.
  Object.assign(now, {
    container: { state: "running" },
    agent: { present: true, pull: null, tag: TAG, browser: { running: false, starting: false, editors: 0, error: "the agent's editor did not start within 60 s" } },
  });
  await office(page).getByText("Agents' editor: the agent's editor did not start within 60 s", { exact: true }).waitFor({ timeout: 10_000 });
  await said(page, "Failed");
  assert.equal(await start(page).isDisabled(), true, "Start would not help: an agent's next call starts the browser again");
  // A download that failed before a start that succeeded is not said under a running Office.
  Object.assign(now, { container: { state: "running", pull: { active: false, line: "", error: "manifest unknown" } }, agent: { present: true, pull: null, tag: TAG, browser: { running: false, starting: false, editors: 0 } } });
  await said(page, "Running");
  assert.equal(await office(page).getByText("manifest unknown", { exact: false }).count(), 0);
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

test("the limits of comments and the editor's chat with agents: each a labelled number with its value, saved as typed", async () => {
  saved.length = 0;
  const page = await opened();
  const runs = page.getByRole("textbox", { name: "Comment chats running at once, per agent or project" });
  assert.equal(await runs.inputValue(), "2");
  assert.equal(await page.getByRole("textbox", { name: "Seconds the editor's chat stays after the last person left" }).inputValue(), "60");
  await runs.fill("3");
  await page.getByRole("textbox", { name: "Comment chats per document" }).fill("20");
  await page.getByRole("region", { name: "Comments and chat with agents" }).getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() => true);
  for (let i = 0; i < 50 && !saved.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(saved, [{ docchatRuns: 3, docchatThreads: 20 }]);
  await runs.fill("x");
  await page.getByRole("region", { name: "Comments and chat with agents" }).getByRole("button", { name: "Save" }).click();
  await page.getByRole("alert").getByText("A limit is a whole number.").waitFor({ timeout: 5000 });
  assert.equal(saved.length, 1, "not sent");
  await page.context().close();
});

test("a limit out of its bounds is said on the page, with the field and its bounds, and not sent; the four limits of floods and saves are there too", async () => {
  saved.length = 0;
  const page = await opened();
  for (const label of ["Messages waiting for one chat while it answers", "Longest comment or chat message taken, in characters", "Reports per editing session in 10 seconds", "Seconds between saves after answers"]) {
    await page.getByRole("textbox", { name: label }).waitFor({ timeout: 5000 });
  }
  await page.getByRole("textbox", { name: "Comment chats running at once, per agent or project" }).fill("21");
  await page.getByRole("region", { name: "Comments and chat with agents" }).getByRole("button", { name: "Save" }).click();
  await page.getByRole("alert").getByText("Comment chats running at once, per agent or project: a whole number from 1 to 20.").waitFor({ timeout: 5000 });
  assert.deepEqual(saved, [], "not sent");
  await page.context().close();
});
