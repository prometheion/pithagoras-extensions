import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Frame, type Page } from "@playwright/test";
import JSZip from "jszip";
import { parseDocx } from "../../src/ooxml.ts";
import { templateDocx, within } from "../../src/store.ts";
import { AGENT_IMAGE, AGENT_IMAGE_TAG } from "../../src/container.ts";
import { jpegSize, SHOT_MAX_BYTES, SHOT_SIDE } from "../../src/cdp.ts";
import { PI_TOOLS, portalEnv, realModelMay, realModelProxy } from "./real-model.mts";

/**
 * Office in a real portal, end to end: the portal's own server (`core/server/dist/index.js` of PITHAGORAS_DIR, built),
 * started as a person runs it, Docker for extensions and Office installed into it through POST /api/packages, Office
 * switched on through its own settings route (the real Document Server and the agents' editor, both on Docker), a
 * person in the real Office page in Chromium, and the agent working through its office tools from a real chat. The
 * chat's model is a script (scripted-model.mjs): each message names the tool calls it makes, so nothing needs a GPU.
 *
 * OFFICE_PORTAL_MODE picks where the portal runs: `host` (the default) on the machine itself, `container` in a
 * container of its own, with its own network namespace (Node's alpine image, the one Office's relay runs on, with this
 * machine's Docker socket), where Docker for extensions puts it on the Document Server's network.
 *
 * Opt-in, as e2e.test.mts: Docker Engine 28 or later, the images (`onlyoffice/documentserver:10.0.0.1` unless
 * OFFICE_E2E_IMAGE names another, `chromedp/headless-shell:157.0.8103.15`, `node:22.23.4-alpine3.23`), Chromium for
 * Playwright, and a few minutes. Its containers, networks and volumes go by names of their own (`office-portal-ds…`,
 * `office-portal-<pid>`; OFFICE_E2E_CONTAINER and OFFICE_E2E_PORT name others, as in e2e.test.mts), and are removed at
 * its end.
 *
 *   OFFICE_E2E=1 PITHAGORAS_DIR=<a built Pithagoras> [OFFICE_PORTAL_MODE=container] node --import tsx --test test/portal/real-portal.test.mts
 *
 * Case m is where documents live: each in an agent's home or a project, owned by it. New document on the Office tab makes
 * one in the home New starts chats in (the default agent's, nobody picked another here), office_create in the chat's agent home or project; the library has only what is in
 * the homes and projects; a document an earlier version kept in the extension's own docs folder (one is put there
 * before the portal starts) was moved into the default agent's home; the editor's chat of a document made on the tab is
 * answered by the default agent.
 *
 * Case q is office_format end to end on a document the agent made: one call with headings, a new style, a list that
 * goes on and one that starts again, a table's style, header row and merged cells, header and footer with the page
 * numbers, a landscape section, a page break, a footnote and a TOC, seen live in a person's editor, in the saved
 * file's parts, in office_read with formatting and in office_screenshot's pictures; an existing style and a pictured
 * header refused without change and replace; a call failing at its last op taken back while the person types on.
 *
 * Case n is office_screenshot from a chat: a model that says it takes pictures (scripted-eye) gets a Word page and a
 * sheet range of its agent's documents, each one JPEG within the caps (the very bytes pi gave the model, which the
 * scripted model keeps) with the text it shows; a person's editor of the document is as it was after the shot; a model
 * without image input gets error:no_images, a document of another agent is not found; two agents' shots at once are
 * both taken, the relay's picture runs one after the other (Docker's events); and the agents' browser's debugging port
 * answers neither the machine and a person's browser on it nor a page in the agents' browser.
 *
 * Cases h to l are comments and the editor's chat as the way to talk to agents, in Word and a spreadsheet: mentions
 * from the editor's list and typed by hand, answers in the thread and in the editor's chat, a thread's chat kept
 * through replies, resolve and unresolve and gone after a delete, messages that come during a run given together, no
 * question tool, none of these chats listed, and limits set on the Office page.
 *
 * OFFICE_E2E_SHOTS=<a folder> keeps pictures there: Settings → Office after Start, the chat with a document open in
 * its Office panel, the panel made narrow, the mention lists, answered threads and the editors' chats, and case n's
 * office_screenshot pictures with the person's page before and after them. OFFICE_E2E_PULL_AGENT=1 removes the agents' editor's image
 * (`chromedp/headless-shell`, about 540 MB) before Start, so the page's Start is seen downloading it.
 */

const DIR = process.env.PITHAGORAS_DIR;
if (process.env.OFFICE_E2E !== "1" || !DIR) {
  test("Office in a real portal", { skip: "set OFFICE_E2E=1 and PITHAGORAS_DIR (see the file's header)" }, () => {});
} else {
  await run(path.resolve(DIR), process.env.OFFICE_PORTAL_MODE === "container" ? "container" : "host");
}

async function freePort(): Promise<number> {
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const until = async (what: () => Promise<boolean> | boolean, ms: number, every = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await what()) return true;
    await delay(every);
  }
  return false;
};

async function run(PITHAGORAS: string, mode: "host" | "container"): Promise<void> {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const PACKAGE = path.resolve(HERE, "../..");
  const IMAGE = process.env.OFFICE_E2E_IMAGE ?? "onlyoffice/documentserver:10.0.0.1";
  const PREFIX = process.env.OFFICE_E2E_CONTAINER ?? "office-portal-ds";
  const NODE_IMAGE = "node:22.23.4-alpine3.23";
  const portalName = `office-portal-${process.pid}`;

  const root = mkdtempSync(path.join(os.tmpdir(), "office-portal-"));
  const d = (name: string) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const data = d("data");
  const piAgent = d("pi-agent");
  const bin = d("bin");
  const log = path.join(root, "model.jsonl");
  writeFileSync(log, "");
  const port = await freePort();
  const modelPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const at = `${origin}/api/x/%40pithagoras/office`;
  const officeData = path.join(data, "extension-data", "%40pithagoras%2Foffice");
  // A document an earlier version made in the extension's own docs folder, which nobody owned (case m): Office moves it
  // into the default agent's home when its half starts.
  const LEGACY = "minutes-aaaaaa";
  mkdirSync(path.join(officeData, "docs", LEGACY), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(officeData, "docs", LEGACY, "Old minutes.docx"), await templateDocx());
  writeFileSync(path.join(officeData, "index.json"), JSON.stringify({ version: 1, docs: [{ docId: LEGACY, title: "Old minutes", ext: "docx", createdAt: 1, updatedAt: 1, sizeBytes: 1, mtimeMs: 1, owner: null, grants: [] }] }));

  // The chat's model is the script: `scripted` reads text only, `scripted-eye` (case n's) says it takes pictures too,
  // so pi gives it a tool's image parts.
  // Case p's real model, where one is given (OFFICE_REAL_MODEL_URL and OFFICE_REAL_MODEL): reached through a proxy of
  // the test's own, which keeps every request the portal sends it (the tool calls and their results are in them).
  // Its key stays in this process (the proxy adds it); the portal is started without any OFFICE_REAL_MODEL_* (portalEnv).
  const real = process.env.OFFICE_REAL_MODEL_URL && process.env.OFFICE_REAL_MODEL ? await realModelProxy(process.env.OFFICE_REAL_MODEL_URL, process.env.OFFICE_REAL_MODEL_KEY, realModelMay) : null;
  const realProvider = real ? { real: { baseUrl: real.url, api: "openai-completions", apiKey: "proxied", models: [{ id: process.env.OFFICE_REAL_MODEL, name: process.env.OFFICE_REAL_MODEL, input: process.env.OFFICE_REAL_MODEL_IMAGES === "1" ? ["text", "image"] : ["text"], contextWindow: Number(process.env.OFFICE_REAL_MODEL_CONTEXT ?? 65536), maxTokens: 8192 }] } } : {};
  writeFileSync(path.join(piAgent, "models.json"), JSON.stringify({ providers: { scripted: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", apiKey: "none", models: [{ id: "scripted", name: "scripted", input: ["text"], contextWindow: 32768, maxTokens: 4096 }, { id: "scripted-eye", name: "scripted-eye", input: ["text", "image"], contextWindow: 32768, maxTokens: 4096 }] }, ...realProvider } }));
  writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted" }));
  // The portal runs `pi` for installs, as a real install has it on PATH: the one of its own packages.
  writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec node "${PITHAGORAS}/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"\n`, { mode: 0o755 });
  const env: Record<string, string> = {
    HOME: d("home"),
    DATA_DIR: data,
    SESSION_DIR: d("sessions"),
    BIN_DIR: bin,
    AGENT_HOME: d("agent-home"),
    CHANNELS_DIR: d("channels"),
    WORKSPACE_ROOT: d("workspaces"),
    PI_CODING_AGENT_DIR: piAgent,
    PORTAL_ALLOW_NO_PASSWORD: "1",
    PORT: String(port),
    PITHAGORAS_OFFICE_CONTAINER: PREFIX,
    PITHAGORAS_OFFICE_PORT: process.env.OFFICE_E2E_PORT ?? "3996",
  };
  const portalOut = openSync(path.join(root, "portal.log"), "a");
  const children: ChildProcess[] = [];
  const model = path.join(HERE, "scripted-model.mjs");
  const entry = path.join(PITHAGORAS, "core/server/dist/index.js");
  if (mode === "host") {
    children.push(spawn(process.execPath, [model, String(modelPort), log], { stdio: ["ignore", portalOut, portalOut] }));
    children.push(spawn(process.execPath, [entry], { cwd: PITHAGORAS, env: { ...portalEnv(process.env), ...env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", portalOut, portalOut] }));
  } else {
    // A container of its own: its own network namespace, the portal's port published on 127.0.0.1, the folders it
    // reads and writes mounted where they are on the machine, Docker's socket as both Compose files give it.
    const sock = "/var/run/docker.sock";
    const args = ["run", "-d", "--name", portalName, "--user", `${process.getuid!()}:${process.getgid!()}`, "--group-add", String(statSync(sock).gid), "-p", `127.0.0.1:${port}:${port}`, "-v", `${sock}:${sock}`];
    for (const dir of [PITHAGORAS, PACKAGE, root]) args.push("-v", `${dir}:${dir}`);
    // Without a password the portal listens on its own loopback unless told otherwise: its container's, here, which
    // the published port does not reach.
    for (const [k, v] of Object.entries({ ...env, PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, ALLOW_OPEN: "1" })) args.push("-e", `${k}=${v}`);
    args.push("-w", PITHAGORAS, NODE_IMAGE, "sh", "-c", `node "${model}" ${modelPort} "${log}" & exec node "${entry}"`);
    execFileSync("docker", args, { stdio: ["ignore", "ignore", "inherit"] });
    children.push(spawn("docker", ["logs", "-f", portalName], { stdio: ["ignore", portalOut, portalOut] }));
  }

  const json = async (url: string, init?: RequestInit) => {
    const answer = await fetch(url, { ...init, headers: { "content-type": "application/json", origin, ...init?.headers } });
    const text = await answer.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: kept as text
    }
    return { status: answer.status, body };
  };
  const state = async () => (await json(`${at}/state`)).body as { docs: { docId: string; title: string; ext: string; mtimeMs: number; path: string; owner: string; ownerName: string }[]; locks: Record<string, { id: string; name?: string }[]>; agent: { present: boolean; pull: { error?: string } | null; browser: unknown }; container: { state: string } };
  /** A document's file: in place, in its owner's folder. */
  const fileOf = async (docId: string) => (await state()).docs.find((x) => x.docId === docId)!.path;
  const partOf = async (docId: string, part: string) => (await JSZip.loadAsync(readFileSync(await fileOf(docId)))).file(part)!.async("string");
  const noConflictCopy = async (title: string) => assert.deepEqual((await state()).docs.filter((x) => x.title.startsWith(`${title} (conflict`)).map((x) => x.title), [], "no conflict copy");
  const newDoc = async (title: string, type: "word" | "cell") => {
    const made = await json(`${at}/documents`, { method: "POST", body: JSON.stringify({ title, type }) });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.docId as string;
  };

  /** A chat of the default agent, and what its scripted model calls in it: each call's result, as the model got it. */
  const chat = async () => {
    const made = await json(`${origin}/api/sessions`, { method: "POST", body: "{}" });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return made.body.id as string;
  };
  let scripts = 0;
  /** A picture the model was given after a tool result (scripted-model.mjs keeps it as a file). */
  type Given = { result: number; file: string; mimeType: string; bytes: number };
  const say = async (chatId: string, calls: { name: string; arguments: Record<string, unknown> }[]): Promise<string[]> => (await ran(chatId, calls)).results;
  /** `say`, with the pictures the model was given. */
  const ran = async (chatId: string, calls: { name: string; arguments: Record<string, unknown> }[]): Promise<{ results: string[]; images: Given[] }> => {
    const id = `s${++scripts}-${process.pid}`;
    const sent = await json(`${origin}/api/sessions/${chatId}/prompt`, { method: "POST", body: JSON.stringify({ message: `Do as scripted. SCRIPT#${id} <<<${JSON.stringify(calls)}>>>` }) });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    let done: { results: string[]; images: Given[] } | undefined;
    await until(() => {
      done = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.id === id && l.final);
      return !!done;
    }, 180_000);
    assert.ok(done, `the chat ran script ${id} to its end (portal log: ${path.join(root, "portal.log")})`);
    return done;
  };

  let browser: Browser;

  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    const keep = process.env.OFFICE_E2E_KEEP === "1";
    await browser?.close().catch(() => {});
    if (!keep) await json(`${at}/container/remove`, { method: "POST", body: JSON.stringify({ data: true }) }).catch(() => {});
    for (const child of children) child.kill();
    real?.close();
    if (mode === "container") execFileSync("docker", ["rm", "-f", portalName], { stdio: "ignore" });
    if (keep) return;
    // The portal's log outlives the run where OFFICE_E2E_LOG names a file for it.
    if (process.env.OFFICE_E2E_LOG) writeFileSync(process.env.OFFICE_E2E_LOG, readFileSync(path.join(root, "portal.log")));
    for (const name of [`${PREFIX}-agent`, `${PREFIX}-relay`, `${PREFIX}-relay-forward`, PREFIX]) execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    for (const name of [`${PREFIX}-agents`, `${PREFIX}-net`]) {
      try {
        execFileSync("docker", ["network", "rm", name], { stdio: "ignore" });
      } catch {
        // gone with Office's own removal
      }
    }
    for (const end of ["data", "cache", "logs", "fonts"]) execFileSync("docker", ["volume", "rm", "-f", `${PREFIX}-${end}`], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  test(`the portal (${mode === "host" ? "on the machine" : "in a container of its own"}) takes Docker for extensions and Office through POST /api/packages, and Office starts its Document Server`, { timeout: 900_000 }, async () => {
    assert.ok(await until(async () => (await json(`${origin}/api/sessions`).catch(() => ({ status: 0 }))).status === 200, 120_000), "the portal is up");
    for (const spec of [path.join(PITHAGORAS, "extensions/docker"), PACKAGE]) {
      const installed = await json(`${origin}/api/packages`, { method: "POST", body: JSON.stringify({ spec }) });
      assert.equal(installed.status, 200, JSON.stringify(installed.body));
    }
    assert.ok(await until(async () => (await json(`${at}/state`)).status === 200, 60_000, 1000), "Office's server half answers");
    const tagged = await json(`${at}/settings`, { method: "POST", body: JSON.stringify({ imageTag: IMAGE }) });
    assert.equal(tagged.status, 200, JSON.stringify(tagged.body));
    const pullAgent = process.env.OFFICE_E2E_PULL_AGENT === "1";
    // By its tag, then by its digest where that still names it (once the tag is gone, Docker may have taken both).
    if (pullAgent) for (const ref of [AGENT_IMAGE_TAG, AGENT_IMAGE]) spawnSync("docker", ["image", "rm", ref], { stdio: "ignore" });
    console.log(`setup: the agents' editor's image ${(await state()).agent.present ? "is there" : "is missing"} before Start`);

    // Settings → Office in the real portal: no prose, and Start is all a person does.
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(`${origin}/settings/x/@pithagoras/office`);
    const own = page.locator('[data-extension="@pithagoras/office"]').filter({ has: page.getByRole("status") }).first();
    const office = own.getByRole("status");
    await office.waitFor({ timeout: 60_000 });
    // Its status is there while it still loads ("Loading…"): the page is read once its Start is.
    await own.getByRole("button", { name: /^(Start container|Container starten)$/ }).waitFor({ timeout: 60_000 });
    const lines = (await own.innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
    console.log(`setup: the page before Start: ${JSON.stringify(lines)}`);
    for (const line of lines) assert.ok(line.length <= 80, `no prose on the page: ${JSON.stringify(line)}`);
    for (const gone of [/Made documents keep/, /through this portal's own proxy/, /runs in a browser of its own/, /each person|each agent|jede[rm]? (Person|Agenten?)\b/]) assert.doesNotMatch(lines.join("\n"), gone);
    // The memory it needs, said plainly: one line, nothing about how it grows.
    assert.ok(lines.some((l) => /^(Recommended: 1 GB of RAM\.|Empfohlen: 1 GB RAM\.)$/.test(l)), `the plain RAM line: ${JSON.stringify(lines)}`);
    assert.equal(lines.filter((l) => /\bRAM\b/.test(l)).length, 1, "and only that line speaks of RAM");
    await own.getByRole("button", { name: /^(Start container|Container starten)$/ }).click();
    // What the one status said on the way, and every download line it showed.
    const healths: string[] = [];
    const pulls = new Set<string>();
    let health = "";
    assert.ok(
      await until(async () => {
        health = (await office.locator("[data-health]").getAttribute("data-health").catch(() => null)) ?? "";
        if (health && healths.at(-1) !== health) healths.push(health);
        for (const line of await office.locator(".po-pull-line").allInnerTexts().catch(() => [])) pulls.add(line);
        return health === "running" || health === "failed";
      }, 900_000, 500),
      `Office runs after Start (${health})`,
    );
    console.log(`setup: the status went ${healths.join(" → ")}; download lines seen: ${pulls.size} (${JSON.stringify([...pulls].slice(-3))})`);
    assert.equal(health, "running", `healthy, both parts: ${await office.innerText()}`);
    if (pullAgent) assert.ok(healths.includes("downloading"), "the page showed Start downloading the agents' editor");
    const after = await state();
    assert.equal(after.container.state, "running", "the Document Server runs");
    assert.equal(after.agent.present, true, "the agents' editor's image is there");
    assert.deepEqual(after.agent.browser, { running: false, starting: false, editors: 0 }, "the agents' browser is ready: it starts when an agent needs it");
    assert.equal((await json(`${at}/state`)).body.enabled, true, "Start switched Office on");
    assert.equal(await own.getByRole("switch").first().isChecked().catch(() => true), true);
    if (process.env.OFFICE_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.OFFICE_E2E_SHOTS, `settings-after-start-${mode}.png`) });
    await page.context().close();
    if (mode === "container") {
      const portal = JSON.parse(execFileSync("docker", ["inspect", portalName], { encoding: "utf8" }))[0];
      console.log(`portal container networks: ${Object.keys(portal.NetworkSettings.Networks).join(", ")}`);
      assert.ok(Object.keys(portal.NetworkSettings.Networks).includes(`${PREFIX}-net`), "Docker for extensions put the portal's container on the Document Server's network");
      assert.ok(!Object.keys(portal.NetworkSettings.Networks).includes(`${PREFIX}-agents`), "and not on the agents' editor's");
    }
  });

  /** A person in the real Office page, with `docId` open in its editor: the page and the editor's frame. */
  async function personOpens(docId: string, kind: "word" | "cell", alsoOpen = false) {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(`${origin}/x/@pithagoras/office/office?doc=${encodeURIComponent(docId)}`);
    let frame: Frame | undefined;
    const pattern = kind === "word" ? /documenteditor\/main\// : /spreadsheeteditor\/main\//;
    await until(async () => {
      for (const f of page.frames().filter((f) => pattern.test(f.url()))) if (await f.evaluate("Boolean(window.Asc && window.Asc.editor)").catch(() => false)) frame = f;
      return !!frame;
    }, 120_000, 500);
    assert.ok(frame, "the person's editor frame in the Office page");
    // The same person in another view of it too (alsoOpen): the Document Server may list them once or twice.
    assert.ok(await until(async () => (alsoOpen ? ((await state()).locks[docId] ?? []).length >= 1 : ((await state()).locks[docId] ?? []).length === 1), 60_000, 500), "the person is in the document");
    // A mark in the frame's window: a reload of the editor would lose it.
    await frame.evaluate("window.__personMark = 1");
    return { page, frame };
  }
  /** What the person's Word editor holds, as its own select-all reads it. */
  const personText = (frame: Frame) => frame.evaluate(`(function () { var e = window.Asc.editor; e.asc_EditSelectAll(); return e.pluginMethod_GetSelectedText(); })()`) as Promise<string>;
  /** Who the person's editor lists as editing the file with them (its header's list of users), each as it is shown:
   * the initial in its badge, then the name. */
  const personSees = (frame: Frame) => frame.evaluate(`Array.from(document.querySelectorAll(".cousers-list .user-name")).map(function (e) { return (e.textContent || "").replace(/Follow$/, "").trim(); })`) as Promise<string[]>;
  const notReloaded = async (page: Page, frame: Frame) => {
    assert.equal(await frame.evaluate("window.__personMark").catch(() => undefined), 1, "the person's editor was never reloaded");
    assert.ok(page.frames().includes(frame));
  };
  /** The person leaves the document as the Office page has it: "All documents". */
  const personCloses = async (page: Page) => {
    await page.getByRole("button", { name: /All documents|Alle Dokumente/ }).click();
    await delay(500);
    await page.context().close();
  };

  test("a: a person types in a Word document; the agent's office_read has the unsaved text, its office_edit shows live in their editor under the agent's name while they type on, and closing saves everything with no conflict copy", { timeout: 900_000 }, async () => {
    const doc = await newDoc("Shared notes", "word");
    const { page, frame } = await personOpens(doc, "word");
    assert.ok(await until(async () => (await personText(frame)).includes("New document"), 30_000), "the document is loaded");
    await frame.locator("#editor_sdk").click({ position: { x: 400, y: 120 } });
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Person line one", { delay: 25 });
    await delay(2500);
    const id = await chat();

    const [read] = await say(id, [{ name: "office_read", arguments: { id: doc } }]);
    console.log(`a. office_read: ${JSON.stringify(read)}`);
    assert.match(read, /Live: the document as it stands in the editor, including what 1 person in it typed and have not saved yet/);
    assert.match(read, /\[1\] New document\n\[2\] Person line one/);

    // The person types on in their own line while the agent edits.
    const typing = page.keyboard.type(" and two", { delay: 40 });
    const t0 = Date.now();
    const [edited] = await say(id, [{ name: "office_edit", arguments: { id: doc, ops: [{ quote: "New document", replacement: "Meeting notes" }, { after: "Meeting notes", paragraphs: ["Agenda"], style: "Heading 1" }, { after: "Agenda", table: [["Item", "Owner"], ["Budget", "Ann"]] }, { after: "Person line one", paragraphs: ["Temporary line"] }] } }]);
    await typing;
    console.log(`a. office_edit (${Date.now() - t0} ms): ${JSON.stringify(edited)}`);
    assert.match(edited, /Edited "Shared notes" \(4 ops\), saved as revision \d+(\.\d+)?\. 1 person in the document saw it live\./);
    let seen = "";
    const t1 = Date.now();
    assert.ok(await until(async () => /Meeting notes[\s\S]*Agenda[\s\S]*Budget[\s\S]*Ann[\s\S]*Temporary line/.test((seen = await personText(frame))), 5000), `the agent's edit in the person's editor: ${JSON.stringify(seen)}`);
    console.log(`a. in the person's editor ${Date.now() - t1} ms after the tool answered: ${JSON.stringify(seen)}`);
    const names = await personSees(frame);
    console.log(`a. the person's editor shows in the document: ${JSON.stringify(names)}`);
    const agentName = (await json(`${origin}/api/agent/avatar?session=${id}`)).body.agent.name as string;
    assert.ok(names.some((n) => n.slice(1) === `${agentName} (agent)`), `the agent is in the person's editor under its own name, "${agentName} (agent)": ${JSON.stringify(names)}`);

    const [removed] = await say(id, [{ name: "office_edit", arguments: { id: doc, ops: [{ remove: "Temporary line" }] } }]);
    console.log(`a. remove: ${JSON.stringify(removed)}`);
    assert.ok(await until(async () => !(seen = await personText(frame)).includes("Temporary line"), 5000), `the removed paragraph is gone from the person's editor: ${JSON.stringify(seen)}`);
    await notReloaded(page, frame);

    // The person keeps typing after the agent's edits, and leaves.
    await frame.locator("#editor_sdk").click({ position: { x: 400, y: 120 } });
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    // (A key pressed at once after the click may go before the editor has the focus back.)
    await delay(500);
    await page.keyboard.type("Person line after the agent", { delay: 25 });
    await delay(2000);
    assert.match(await personText(frame), /Person line one and two[\s\S]*Person line after the agent/);
    await personCloses(page);
    let text = "";
    const want = ["Meeting notes", "Agenda", "Budget", "Ann", "Person line one and two", "Person line after the agent"];
    const file = await fileOf(doc);
    assert.ok(await until(() => want.every((w) => (text = parseDocx(readFileSync(file)).text).includes(w)), 90_000, 1000), `the file has everything: ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /Temporary line|New document/);
    assert.match(await partOf(doc, "word/document.xml"), /<w:tbl>[\s\S]*Budget[\s\S]*Ann[\s\S]*<\/w:tbl>/);
    await noConflictCopy("Shared notes");
    assert.deepEqual((await state()).locks[doc], [], "nobody is in it once the person left");
  });

  test("b: a person in a spreadsheet; the agent's range write with a formula shows live, computed, and is saved with what the person typed", { timeout: 900_000 }, async () => {
    const doc = await newDoc("Budget", "cell");
    const { page, frame } = await personOpens(doc, "cell");
    await frame.locator("#editor_sdk").click({ position: { x: 600, y: 400 } });
    await frame.evaluate(`window.Asc.editor.asc_findCell("C1")`);
    await page.keyboard.type("person\n", { delay: 30 });
    await delay(2500);
    const id = await chat();
    const [read] = await say(id, [{ name: "office_read", arguments: { id: doc } }]);
    console.log(`b. office_read: ${JSON.stringify(read)}`);
    assert.match(read, /C1: "person"/);
    const t0 = Date.now();
    const [edited] = await say(id, [{ name: "office_edit", arguments: { id: doc, ops: [{ range: "A1:A3", values: [[2], [3], ["=A1*A2"]] }] } }]);
    console.log(`b. office_edit (${Date.now() - t0} ms): ${JSON.stringify(edited)}`);
    assert.match(edited, /Edited "Budget" \(1 op\), saved as revision .* 1 person in the document saw it live\./);
    let max = "";
    const t1 = Date.now();
    assert.ok(
      await until(async () => {
        await frame.evaluate(`window.Asc.editor.asc_findCell("A1:A3")`);
        max = String(await frame.evaluate(`(document.getElementById("status-math-max") || {}).textContent || ""`)).trim();
        return /\b6\b/.test(max);
      }, 5000),
      `the person sees the formula computed: ${max}`,
    );
    console.log(`b. the person's sheet shows the largest of A1:A3 as "${max}" ${Date.now() - t1} ms after the tool answered`);
    await notReloaded(page, frame);
    // The person types on, and leaves.
    await frame.evaluate(`window.Asc.editor.asc_findCell("D1")`);
    await page.keyboard.type("later\n", { delay: 30 });
    await delay(2000);
    await personCloses(page);
    let sheet = "";
    assert.ok(await until(async () => /r="D1"/.test((sheet = await partOf(doc, "xl/worksheets/sheet1.xml"))), 90_000, 1000), `the person's later cell is in the file: ${sheet}`);
    assert.match(sheet, /<c r="A3"[^>]*><f>A1\*A2<\/f><v>6<\/v><\/c>/);
    const strings = await partOf(doc, "xl/sharedStrings.xml");
    assert.match(strings, /person/);
    assert.match(strings, /later/);
    await noConflictCopy("Budget");
  });

  test("c: with nobody in the document, the agent's edit lands and is saved as a new revision", { timeout: 900_000 }, async () => {
    const doc = await newDoc("Unopened", "word");
    const before = (await state()).docs.find((x) => x.docId === doc)!.mtimeMs;
    const id = await chat();
    const [edited] = await say(id, [{ name: "office_edit", arguments: { id: doc, ops: [{ after: "New document", paragraphs: ["Written with nobody in it"] }] } }]);
    console.log(`c. office_edit: ${JSON.stringify(edited)}`);
    const revision = Number(/saved as revision (\d+(?:\.\d+)?)/.exec(edited)?.[1]);
    assert.ok(revision > before, `a new revision: ${revision} after ${before}`);
    assert.doesNotMatch(edited, /saw it live/, "nobody saw it");
    assert.equal((await state()).docs.find((x) => x.docId === doc)!.mtimeMs, revision);
    assert.deepEqual(parseDocx(readFileSync(await fileOf(doc))).paragraphs, ["New document", "Written with nobody in it"]);
    assert.deepEqual((await state()).locks[doc], [], "and no person is in it");
  });

  test("f: the chat's Office panel: the agent's tool card opens its document in the panel beside the chat, a person types there and sees the agent's edit live, the same document in the Office tab co-edits with it, it works narrow, wide and at the bottom, back and close destroy the editor", { timeout: 900_000 }, async () => {
    // The agent makes the document (office_create opens no editor of the agent's: the seats stay as the other cases
    // leave them).
    const id = await chat();
    await say(id, [{ name: "office_create", arguments: { title: "Beside the chat", type: "word" } }]);
    const doc = (await state()).docs.find((x) => x.title === "Beside the chat")!.docId;
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    await page.goto(`${origin}/s/${id}`);
    // The panel's body: of what Office draws on the chat's page (its card, its button, …), the one with its list or editor.
    const body = page.locator('[data-extension="@pithagoras/office"]').filter({ has: page.locator(".po-editor-panel, .po-newcompact") }).first();
    /** The Document Server's editor frame of `doc` on `p`, once its editor is up. */
    const editorFrame = async (p: Page, inPanel: boolean) => {
      let frame: Frame | undefined;
      await until(async () => {
        for (const f of p.frames().filter((f) => /documenteditor\/main\//.test(f.url()))) {
          const owner = await f.frameElement().catch(() => null);
          const there = owner ? await owner.evaluate((el) => Boolean((el as Element).closest(".po-editor-panel"))) : false;
          if (there === inPanel && (await f.evaluate("Boolean(window.Asc && window.Asc.editor)").catch(() => false))) frame = f;
        }
        return !!frame;
      }, 120_000, 500);
      return frame;
    };
    /** The panel and its editor as drawn: the editor fills the panel under its bar, and nothing scrolls sideways. */
    const fits = async (what: string) => {
      const sizes = await body.evaluate((el) => {
        const frame = el.querySelector(".po-host iframe")!.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const aside = el.closest("aside")!;
        return { frame: { w: frame.width, h: frame.height }, box: { w: box.width, h: box.height }, dock: aside.getAttribute("data-dock"), sideways: el.scrollWidth - el.clientWidth };
      });
      console.log(`f. ${what}: the panel ${JSON.stringify(sizes.box)} docked ${sizes.dock}, its editor ${JSON.stringify(sizes.frame)}`);
      assert.ok(Math.abs(sizes.frame.w - sizes.box.w) <= 1 && sizes.frame.h > sizes.box.h - 80, `${what}: the editor fills the panel under its bar`);
      assert.ok(sizes.sideways <= 0, `${what}: nothing scrolls sideways`);
      return sizes;
    };
    /** A line typed at the end of the document in `frame`. */
    const typeIn = async (p: Page, frame: Frame, line: string) => {
      await frame.locator("#editor_sdk").click({ position: { x: 120, y: 100 } });
      await p.keyboard.press("Control+End");
      await p.keyboard.press("Enter");
      // (A key pressed at once after the click may go before the editor has the focus.)
      await delay(500);
      await p.keyboard.type(line, { delay: 25 });
    };
    /** Drags the edge between the conversation and the panels on the right until the panels are `width` wide. */
    const widen = async (width: number) => {
      const aside = page.locator('aside[data-dock="right"]');
      const edge = page.locator(".chat-aside-edge[aria-orientation=vertical]");
      const from = (await aside.boundingBox())!.width;
      const at = (await edge.boundingBox())!;
      await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
      await page.mouse.down();
      await page.mouse.move(at.x + at.width / 2 + (from - width), at.y + at.height / 2, { steps: 12 });
      await page.mouse.up();
      assert.ok(await until(async () => Math.abs((await aside.boundingBox())!.width - width) <= 8, 5000), `the panels made ${width} px wide (${(await aside.boundingBox())!.width})`);
      // The editor follows its window's size.
      await delay(1500);
    };

    // The card of the agent's office_create opens the document in the chat's Office panel, not the Office tab.
    // (The portal speaks the browser's language: German on a German machine.)
    await page.getByRole("button", { name: /^(Open in Office|In Office öffnen)$/ }).first().click({ timeout: 60_000 });
    let panelFrame = await editorFrame(page, true);
    assert.ok(panelFrame, "the editor in the chat's Office panel");
    assert.equal(new URL(page.url()).pathname, `/s/${id}`, "the page stayed on the chat");
    assert.ok(await page.locator("textarea, [contenteditable=true]").first().isVisible(), "the chat's composer is on screen beside it");
    assert.ok(await until(async () => (await personText(panelFrame!)).includes("New document"), 30_000), "the document is loaded in the panel");
    await fits("as the portal docks it");

    // A person types in the panel; the agent's office_edit from the same chat shows there live, under its name.
    await typeIn(page, panelFrame!, "Typed in the panel");
    await delay(2000);
    const [edited] = await say(id, [{ name: "office_edit", arguments: { id: doc, ops: [{ after: "Typed in the panel", paragraphs: ["Written by the agent beside the chat"] }] } }]);
    console.log(`f. office_edit: ${JSON.stringify(edited)}`);
    assert.match(edited, /1 person in the document saw it live\./);
    let seen = "";
    assert.ok(await until(async () => /Typed in the panel[\s\S]*Written by the agent beside the chat/.test((seen = await personText(panelFrame!))), 10_000), `the agent's edit in the panel's editor: ${JSON.stringify(seen)}`);
    assert.equal(new URL(page.url()).pathname, `/s/${id}`, "still on the chat");
    if (process.env.OFFICE_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.OFFICE_E2E_SHOTS, `panel-${mode}.png`) });

    // The Office tab opens the document in its own page; typed there, seen in the panel, and the other way round.
    const { page: tab, frame: tabFrame } = await personOpens(doc, "word", true);
    assert.equal(await (await tabFrame.frameElement()).evaluate((el) => Boolean((el as Element).closest(".po-editor-panel"))), false, "the tab's editor is its page's");
    assert.ok(await until(async () => (seen = await personText(tabFrame)).includes("Written by the agent beside the chat"), 20_000), `the tab's editor has the panel's document: ${JSON.stringify(seen)}`);
    await typeIn(tab, tabFrame, "Typed in the tab");
    assert.ok(await until(async () => (seen = await personText(panelFrame!)).includes("Typed in the tab"), 20_000), `the panel's editor has the tab's typing: ${JSON.stringify(seen)}`);
    await typeIn(page, panelFrame!, "Typed in the panel again");
    assert.ok(await until(async () => (seen = await personText(tabFrame)).includes("Typed in the panel again"), 20_000), `the tab's editor has the panel's typing: ${JSON.stringify(seen)}`);
    await personCloses(tab);

    // Narrow, then wide: the same editor, never reloaded, fitting the panel, and typing works at both.
    await panelFrame!.evaluate("window.__panelMark = 1");
    await widen(380);
    await fits("narrow");
    await typeIn(page, panelFrame!, "Typed narrow");
    assert.ok(await until(async () => (await personText(panelFrame!)).includes("Typed narrow"), 10_000), "typed in the narrow panel");
    if (process.env.OFFICE_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.OFFICE_E2E_SHOTS, `panel-narrow-${mode}.png`) });
    await widen(900);
    await fits("wide");
    assert.equal(await panelFrame!.evaluate("window.__panelMark"), 1, "resizing the panel never reloaded its editor");

    // At the bottom, where a drag of its header to the bottom edge puts it (kept per browser, as the portal keeps it).
    await page.evaluate(() => localStorage.setItem("panelPlaces", JSON.stringify({ "x:@pithagoras/office/office": "bottom" })));
    await page.reload();
    // The portal may bring the panel back open by itself; only where it does not is it opened.
    const toggle = page.locator('button.panel-toggle[aria-label="Office"]');
    await toggle.waitFor({ timeout: 60_000 });
    if (!(await body.waitFor({ timeout: 5000 }).then(() => true, () => false))) await toggle.click();
    const row = body.locator(".po-open", { hasText: "Beside the chat" });
    if (await row.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await row.click();
    panelFrame = await editorFrame(page, true);
    assert.ok(panelFrame, "the editor in the panel at the bottom");
    const bottom = await fits("at the bottom");
    assert.equal(bottom.dock, "bottom");
    assert.ok(await until(async () => (await personText(panelFrame!)).includes("Typed narrow"), 30_000), "the document is loaded at the bottom");
    await typeIn(page, panelFrame!, "Typed at the bottom");
    assert.ok(await until(async () => (await personText(panelFrame!)).includes("Typed at the bottom"), 10_000), "typed in the panel at the bottom");

    // Back to the panel's list: the editor goes; a row opens it in the panel again; closing the panel takes it.
    await body.getByRole("button", { name: /All documents|Alle Dokumente/ }).click();
    await row.waitFor({ timeout: 10_000 });
    assert.equal(await body.locator("iframe").count(), 0, "no editor left in the panel");
    await row.click();
    assert.ok(await editorFrame(page, true), "opened in the panel again");
    await page.locator('button.panel-toggle[aria-label="Office"]').click();
    await body.waitFor({ state: "detached", timeout: 10_000 });
    assert.equal(page.frames().filter((f) => /documenteditor\/main\//.test(f.url())).length, 0, "no editor left on the page");
    await page.context().close();
    let file = "";
    const want = /Typed in the panel[\s\S]*Written by the agent beside the chat/;
    const all = ["Typed in the tab", "Typed in the panel again", "Typed narrow", "Typed at the bottom"];
    assert.ok(await until(async () => want.test((file = parseDocx(readFileSync(await fileOf(doc))).text)) && all.every((w) => file.includes(w)), 90_000, 1000), `everything typed and written is saved: ${JSON.stringify(file)}`);
    await noConflictCopy("Beside the chat");
    assert.ok(await until(async () => ((await state()).locks[doc] ?? []).length === 0, 60_000, 1000), "nobody is in it once both views left");
  });

  test("e: a person's editor config never has plugins on, and a tampered client config loads no plugin", { timeout: 900_000 }, async () => {
    const doc = await newDoc("No plugins", "word");
    const id = await chat();
    await say(id, [{ name: "office_read", arguments: { id: doc } }]); // the agent's editor is in it, with its plugin
    const config = (await json(`${at}/editor-config`, { method: "POST", body: JSON.stringify({ doc }) })).body;
    assert.deepEqual(config.editorConfig.customization, { macros: false, plugins: false });
    assert.equal(config.editorConfig.plugins, undefined);
    const { page } = await personOpens(doc, "word");
    await delay(3000);
    assert.deepEqual(page.frames().map((f) => f.url()).filter((u) => /\/plugin\/|sdkjs-plugins|config\.json/.test(u)), [], "no plugin frame in the person's editor");
    await personCloses(page);

    // A plugin a tampered page could reach: served here, on the machine, open to any origin. It writes into the
    // document and says so where it runs.
    const asked: string[] = [];
    const rogue = http.createServer((req, res) => {
      asked.push(req.url ?? "");
      res.setHeader("access-control-allow-origin", "*");
      if (req.url === "/config.json") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ name: "Rogue", guid: "asc.{11111111-2222-4333-8444-555555555555}", version: "1.0.0", variations: [{ description: "rogue", url: "index.html", icons: [], isViewer: true, EditorsSupport: ["word", "cell"], type: "system", isVisual: false, isModal: false, isInsideMode: false, initDataType: "none", initData: "", buttons: [], events: [] }] }));
      }
      if (req.url === "/index.html") {
        res.setHeader("content-type", "text/html");
        return res.end(`<!doctype html><html><head><script src="${origin}/api/x/%40pithagoras/office/ds/sdkjs-plugins/v1/plugins.js"></script><script>fetch("/loaded");window.Asc.plugin.init=function(){fetch("/ran");this.callCommand(function(){var p=Api.CreateParagraph();p.AddText("Written by a rogue plugin");Api.GetDocument().Push(p);},false,true);};window.Asc.plugin.button=function(){};</script></head><body></body></html>`);
      }
      res.end();
    });
    rogue.listen(0, "127.0.0.1");
    await once(rogue, "listening");
    const rogueAt = `http://127.0.0.1:${(rogue.address() as AddressInfo).port}`;
    try {
      // Its config changed as it comes in, before the page hands it on: plugins on, the agents' own plugin (its address
      // as an agent's config has it, on the island) and the rogue one.
      const tampered = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
      await tampered.route("**/editor-config", async (route) => {
        const answer = await route.fetch();
        const body = await answer.json();
        body.editorConfig.customization = { ...body.editorConfig.customization, plugins: true };
        body.editorConfig.plugins = { pluginsData: [`http://${PREFIX}-relay:3891/plugin/${"a".repeat(32)}/config.json`, `${rogueAt}/config.json`], autostart: ["asc.{6f1e2d3c-4b5a-4c69-8e7f-a0b1c2d3e4f5}", "asc.{11111111-2222-4333-8444-555555555555}"] };
        await route.fulfill({ response: answer, json: body });
      });
      await tampered.goto(`${origin}/x/@pithagoras/office/office?doc=${encodeURIComponent(doc)}`);
      let frame: Frame | undefined;
      await until(async () => {
        for (const f of tampered.frames().filter((f) => /documenteditor\/main\//.test(f.url()))) if (await f.evaluate("Boolean(window.Asc && window.Asc.editor)").catch(() => false)) frame = f;
        return !!frame;
      }, 120_000, 500);
      assert.ok(frame, "the tampered page's editor");
      await until(async () => (await personText(frame!)).includes("New document"), 30_000);
      // A plugin that loads runs within seconds (about 5 s with this one, measured without the fix).
      await delay(15_000);
      const text = await personText(frame!);
      const frames = tampered.frames().map((f) => f.url()).filter((u) => /\/plugin\/|config\.json|index\.html|127\.0\.0\.1:\d+\/(?!api)/.test(u) && !u.startsWith(origin));
      console.log(`e. a tampered person's editor: asked of the rogue plugin ${JSON.stringify(asked)}, plugin frames ${JSON.stringify(frames)}, text ${JSON.stringify(text)}`);
      await tampered.context().close();
      assert.doesNotMatch(text, /Written by a rogue plugin/, "no plugin wrote into the document");
      assert.ok(!asked.includes("/ran"), "no plugin ran");
      assert.deepEqual(frames, [], "no plugin frame");
    } finally {
      rogue.close();
    }
  });

  test("g: from a chat, the agent makes a spreadsheet of three sheets (one renamed, one with a formula across sheets, one hidden) while a person has it open; office_read names them all, the person sees them live, and the file holds what office_read showed", { timeout: 900_000 }, async () => {
    const id = await chat();
    await say(id, [{ name: "office_create", arguments: { title: "Quarter", type: "cell" } }]);
    const doc = (await state()).docs.find((x) => x.title === "Quarter")!.docId;
    const { page, frame } = await personOpens(doc, "cell");

    const t0 = Date.now();
    const [edited, ...reads] = await say(id, [
      {
        name: "office_edit",
        arguments: {
          id: doc,
          ops: [
            { renameSheet: "Sheet1", to: "Sales Q1" },
            { range: "A1:B3", values: [["Month", "Sales"], ["Jan", 120], ["Feb", 80]] },
            { addSheet: "Summary" },
            { sheet: "Summary", range: "A1:B1", values: [["Total", "='Sales Q1'!B2+'Sales Q1'!B3"]] },
            { addSheet: "Notes" },
            { sheet: "notes", range: "A1", values: [["Checked by the agent"]] },
            { hideSheet: "Notes" },
          ],
        },
      },
      { name: "office_read", arguments: { id: doc } },
      { name: "office_read", arguments: { id: doc, sheet: "Notes" } },
    ]);
    // The portal wraps what a tool read in markers of its own (outside content): the read is what is inside them.
    const [read, notes] = reads.map((r) => r.replace(/^<<<untrusted:\w+>>>[^\n]*\n/, "").replace(/\n<<<\/untrusted:\w+>>>$/, ""));
    console.log(`g. office_edit (${Date.now() - t0} ms with the reads): ${JSON.stringify(edited)}\ng. office_read: ${JSON.stringify(read)}\ng. office_read of Notes: ${JSON.stringify(notes)}`);
    assert.match(edited, /Edited "Quarter" \(7 ops\), saved as revision .* 1 person in the document saw it live\./);
    assert.match(read, /\nSheets: 1 "Sales Q1", 2 "Summary", 3 "Notes" \(hidden\)\n/);
    assert.match(read, /\n\nSheet "Sales Q1" \(A1:B3\):\nA1: "Month"\nB1: "Sales"\nA2: "Jan"\nB2: 120\nA3: "Feb"\nB3: 80\n/);
    assert.match(read, /\n\nSheet "Summary" \(A1:B1\):\nA1: "Total"\nB1: 200 \(='Sales Q1'!B2\+'Sales Q1'!B3\)\n/);
    assert.match(read, /\n\nSheet "Notes" \(A1\):\nA1: "Checked by the agent"$/);
    assert.match(notes, /\nSheets: 1 "Sales Q1", 2 "Summary", 3 "Notes" \(hidden\)\n\nSheet "Notes" \(A1\):\nA1: "Checked by the agent"$/, "one sheet read alone, and every sheet named");

    // The person's editor: the three sheets as the agent made them, and the formula computed there (the largest of
    // Summary!A1:B1 in its status bar, as the person sees it with that sheet's cells selected).
    const personSheets = () => frame.evaluate(`(function () { var e = window.Asc.editor, out = []; for (var i = 0; i < e.asc_getWorksheetsCount(); i++) out.push(e.asc_getWorksheetName(i) + (e.asc_isWorksheetHidden(i) ? " (hidden)" : "")); return out.join(", "); })()`) as Promise<string>;
    let seen = "";
    const t1 = Date.now();
    assert.ok(await until(async () => (seen = await personSheets()) === "Sales Q1, Summary, Notes (hidden)", 5000), `the person sees the agent's sheets: ${seen}`);
    console.log(`g. the person's sheets ${Date.now() - t1} ms after the tool answered: ${seen}`);
    let max = "";
    assert.ok(
      await until(async () => {
        await frame.evaluate(`(function () { var e = window.Asc.editor; e.asc_showWorksheet(1); e.asc_findCell("A1:B1"); })()`);
        max = String(await frame.evaluate(`(document.getElementById("status-math-max") || {}).textContent || ""`)).trim();
        return /\b200\b/.test(max);
      }, 10_000),
      `the person sees Summary's formula computed: ${max}`,
    );
    await notReloaded(page, frame);
    await personCloses(page);

    // The file afterwards: the sheets in order, the hidden one hidden, every cell as office_read showed it.
    const { parseXlsx } = await import("../../src/ooxml.ts");
    const shown = new Map<string, Map<string, string>>();
    for (const part of read.split("\n\n").filter((p) => p.startsWith("Sheet "))) {
      const [head, ...cells] = part.split("\n");
      shown.set(/^Sheet "(.*)" \(/.exec(head)![1], new Map(cells.map((c) => /^([A-Z]+\d+): (.*?)(?: \(=.*\))?$/.exec(c)!).map((m) => [m[1], m[2].startsWith('"') ? JSON.parse(m[2]) : m[2]])));
    }
    const col = (n: number) => String.fromCharCode(65 + n);
    let book: ReturnType<typeof parseXlsx> | undefined;
    const cellsOf = (rows: string[][]) => new Map(rows.flatMap((row, r) => row.map((v, c) => [`${col(c)}${r + 1}`, v] as [string, string]).filter(([, v]) => v !== "")));
    const inFile = () => new Map(book!.sheetNames.map((name) => [name, cellsOf(book!.sheets[name] ?? [])]));
    assert.ok(await until(async () => (book = parseXlsx(readFileSync(await fileOf(doc)))).sheetNames.length === 3, 90_000, 1000), `the file has the three sheets: ${JSON.stringify(book?.sheetNames)}`);
    assert.deepEqual(book!.sheetNames, ["Sales Q1", "Summary", "Notes"]);
    assert.deepEqual(book!.hiddenSheets, ["Notes"]);
    assert.deepEqual(inFile(), shown, "the file holds what office_read showed");
    const zip = await JSZip.loadAsync(readFileSync(await fileOf(doc)));
    const parts = await Promise.all(Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).map((n) => zip.file(n)!.async("string")));
    assert.ok(parts.some((x) => /<f>(&apos;|')Sales Q1(&apos;|')!B2\+(&apos;|')Sales Q1(&apos;|')!B3<\/f><v>200<\/v>/.test(x)), "the formula across sheets is in the file with its value");
    await noConflictCopy("Quarter");
  });

  test("h: a comment that mentions the agent starts a chat of its own in the agent's home (no child of the person's chat), which nobody sees and nobody attends, so it has no question tool: the agent's ask_question is refused there at once, and its answer comes as the agent's reply in the thread", { timeout: 900_000 }, async () => {
    const parent = await chat();
    const made = await say(parent, [{ name: "office_create", arguments: { title: "Asked in a comment", type: "word" } }]);
    const docId = /id ([\w-]+),/.exec(made[0])![1];
    const users = (await json(`${at}/mentionables`)).body.users as { name: string; email: string }[];
    const agent = users.find((u) => !u.email.startsWith("project:"))!;
    assert.ok(agent, JSON.stringify(users));
    const { page, frame } = await personOpens(docId, "word");
    await frame.locator("#editor_sdk").click({ position: { x: 300, y: 200 } });
    await page.keyboard.type("A sentence to comment on.", { delay: 10 });
    await page.keyboard.press("Control+a");
    await frame.evaluate(`DE.getController("Common.Controllers.Comments").addDummyComment()`);
    await delay(800);
    await frame.locator("textarea.msg-reply").first().click();
    const id = `h-${process.pid}`;
    const calls = [{ name: "ask_question", arguments: { questions: [{ question: "Which one?", options: ["A", "B"] }] } }];
    await page.keyboard.type(`Bitte entscheide. SCRIPT#${id} <<<${JSON.stringify(calls)}>>> `, { delay: 5 });
    await page.keyboard.type(`@${agent.name.slice(0, 2)}`, { delay: 60 });
    await delay(1500);
    await frame.locator("li", { hasText: agent.name }).first().click();
    await delay(300);
    await frame.locator("button", { hasText: /^(Add|Hinzufügen)$/ }).first().click();

    // The comment's chat ran the script: its model was never offered ask_question, and the call was refused at once.
    let lines: { id: string | null; results: string[]; final: boolean; tools: string[] }[] = [];
    assert.ok(
      await until(() => {
        lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.id === id);
        return lines.some((l) => l.final);
      }, 180_000),
      `the comment's chat ran the script (portal log: ${path.join(root, "portal.log")})`,
    );
    console.log(`the comment's chat: ${JSON.stringify(lines.map((l) => ({ tools: l.tools.filter((t) => /ask|question/.test(t)), results: l.results.map((r) => r.slice(0, 160)) })))}`);
    // A chat of the person's has it (the office_create above): the comment's chat, started unattended, is not offered it.
    const parentLines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => typeof l.id === "string" && l.id.startsWith("s"));
    assert.ok(parentLines.some((l) => l.tools.includes("ask_question")), "the person's own chat is offered ask_question");
    assert.ok(lines.every((l) => !l.tools.includes("ask_question")), "the question tool is not offered in the comment's chat");
    // pi refuses a tool it was not given before it runs.
    assert.match(lines.find((l) => l.final)!.results[0] ?? "", /ask_question not found/);
    // Its answer is the agent's reply in the thread, in the person's editor.
    const replies = () => frame.evaluate(`JSON.stringify(DE.getController("Common.Controllers.Comments").collection.map(function (c) { return (c.get("replys") || []).map(function (r) { return [r.get("username"), r.get("reply")]; }); }))`).then((x) => JSON.parse(x as string) as string[][][]);
    assert.ok(await until(async () => (await replies()).flat().some(([who, text]) => /\(agent\)$/.test(who) && text === `Done ${id}.`), 60_000), JSON.stringify(await replies()));
    // Shown nowhere: no chat of the comment in the chat lists.
    const listed = (await json(`${origin}/api/sessions`)).body as unknown;
    assert.ok(!JSON.stringify(listed).includes("Comment: Bitte entscheide"), "the comment's chat is not listed");
    // A chat of the agent's home of its own (chats.start), not a child of the chat the person works in.
    const recorded = Object.values(JSON.parse(readFileSync(path.join(officeData, "state", "threads", `${docId}.json`), "utf8")).threads as Record<string, { agents: Record<string, { chatId: string }> }>)[0];
    const [[folder, entry]] = Object.entries(recorded.agents);
    const started = (await json(`${origin}/api/sessions/${entry.chatId}`)).body as { parent?: string; workspace: string };
    assert.equal(started.parent, undefined, "no parent");
    assert.equal(realpathSync(started.workspace), folder, "in the agent's home");
    await personCloses(page);
  });

  /* Comments and the editor's chat as the way to talk to agents (office-docchat-plan.md, with the owner's answers):
   * an agent Aegis and a project Report, each with a task chat of its own; a Word document and a spreadsheet Aegis made
   * (so Aegis owns them). */
  type ModelLine = { at: number; id: string | null; results: string[]; call: { name: string } | null; final: boolean; tools: string[]; seen: string[]; prompt: string };
  const modelLines = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ModelLine);
  /** The model's requests of the script `id`, once it ran to its end. */
  const ranScript = async (id: string, ms = 120_000) => {
    let lines: ModelLine[] = [];
    assert.ok(await until(() => (lines = modelLines().filter((l) => l.id === id)).some((l) => l.final), ms), `the script ${id} ran to its end (portal log: ${path.join(root, "portal.log")})`);
    return lines;
  };
  const shot = async (page: Page, name: string) => {
    if (process.env.OFFICE_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.OFFICE_E2E_SHOTS, `${name}.png`) });
  };
  type ThreadRecord = { agents: Record<string, { chatId: string | null; state: string; error?: string }>; removing?: unknown };
  /** A document's comment threads as docchat keeps them, and the editor's chats by editing session. */
  const threadRecords = (docId: string): Record<string, ThreadRecord> => {
    try {
      return JSON.parse(readFileSync(path.join(officeData, "state", "threads", `${docId}.json`), "utf8")).threads;
    } catch {
      return {};
    }
  };
  const sessionRecords = (): Record<string, { docId: string; chatId: string | null; state: string }> => {
    try {
      return JSON.parse(readFileSync(path.join(officeData, "state", "sessions.json"), "utf8"));
    } catch {
      return {};
    }
  };
  const chatExists = async (id: string) => (await json(`${origin}/api/sessions/${id}`)).status === 200;
  /** Every chat the portal's chat lists show: the sidebar's, and each agent's page. */
  const listedChats = async () => {
    const ids = new Set<string>();
    for (const s of (await json(`${origin}/api/sessions`)).body.sessions ?? []) ids.add(s.id);
    for (const a of (await json(`${origin}/api/agents`)).body.agents ?? []) for (const s of (await json(`${origin}/api/agent/sessions?agent=${encodeURIComponent(a.id)}`)).body.sessions ?? []) ids.add(s.id);
    return ids;
  };
  /** The comments controller of the editor's UI (Word's DE, the spreadsheet's SSE): what its buttons call. */
  const comments = `(window.DE || window.SSE).getController("Common.Controllers.Comments")`;
  type Shown = { uid: string; guid: string; text: string; resolved: boolean; replies: string[][] };
  const threadsIn = (frame: Frame) =>
    frame.evaluate(`JSON.stringify(${comments}.collection.map(function (c) { return { uid: c.get("uid"), guid: c.get("guid"), text: c.get("comment"), resolved: !!c.get("resolved"), replies: (c.get("replys") || []).map(function (r) { return [r.get("username"), r.get("reply")]; }) }; }))`).then((s) => JSON.parse(s as string) as Shown[]);
  /** The entries the editor's mention list shows now. */
  const mentionList = (frame: Frame) => frame.evaluate(`Array.from(document.querySelectorAll("li")).filter(function (li) { var r = li.getBoundingClientRect(); return li.offsetParent && r.height > 0; }).map(function (li) { return (li.textContent || "").replace(/\\s+/g, " ").trim(); })`) as Promise<string[]>;
  /** A comment made in the popover on what is selected, as a person makes one: `parts` is [text, search, name to pick,
   * text, …], each pick after an "@" and its search; `atList` looks at the list the first "@" opened. Where the
   * popover closed under the typing (now and then), it is opened and typed into again, once. */
  async function commentInPopover(page: Page, frame: Frame, parts: string[], atList?: () => Promise<void>): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      await frame.evaluate(`${comments}.addDummyComment()`);
      await delay(800);
      await frame.locator("textarea.msg-reply").first().click();
      for (let i = 0; i < parts.length; i += 3) {
        await page.keyboard.type(parts[i], { delay: 5 });
        if (parts[i + 1] === undefined) break;
        await page.keyboard.type("@", { delay: 60 });
        await delay(1500);
        if (i === 0 && attempt === 1) await atList?.();
        await page.keyboard.type(parts[i + 1], { delay: 60 });
        await delay(1200);
        await frame.locator("li", { hasText: parts[i + 2] }).first().click();
        await delay(300);
      }
      const typed = (await frame.evaluate(`Array.from(document.querySelectorAll("textarea.msg-reply")).filter(function (t) { return t.offsetParent; }).map(function (t) { return t.value; })[0]`)) as string;
      const add = frame.locator("button", { hasText: /^(Add|Hinzufügen)$/ }).first();
      if (attempt > 1 || (await add.isVisible().catch(() => false))) {
        await add.click();
        return typed;
      }
      console.log("the comment popover closed while the test typed: opened again");
      await page.keyboard.press("Escape");
      await delay(500);
    }
  }
  /** The list the first "@" opened shows the agents and the projects. */
  const listsAgentsAndProjects = (page: Page, frame: Frame, name: string) => async () => {
    let seen: string[] = [];
    assert.ok(await until(async () => (seen = await mentionList(frame)).some((t) => t.startsWith("Aegis")) && seen.some((t) => t.includes("report (project)")), 5000), `typing @ lists the agents and the projects: ${JSON.stringify(seen)}`);
    console.log(`${name}: the mention list after "@": ${JSON.stringify(seen.filter((t) => /Aegis|report|\(project\)/.test(t) || /agent/i.test(t)))}`);
    await shot(page, name);
  };
  /** The editor's chat panel opened, and every message the editor hears from now on recorded. */
  const openChat = async (frame: Frame) => {
    await frame.evaluate(`window.__chat = []; window.Asc.editor.asc_registerCallback("asc_onCoAuthoringChatReceiveMessage", function (m) { (m || []).forEach(function (x) { window.__chat.push([x.useridoriginal, x.username, x.message]); }); })`);
    await frame.locator("#left-btn-chat").click();
    await delay(800);
  };
  const sendChat = async (page: Page, frame: Frame, text: string) => {
    await frame.locator("#chat-msg-text").click();
    await page.keyboard.type(text, { delay: 3 });
    await frame.locator("#chat-msg-btn-add").click();
  };
  const chatHeard = (frame: Frame) => frame.evaluate("window.__chat") as Promise<string[][]>;

  let aegisChat = "";
  let reportChat = "";
  let aegisHome = "";
  let reportFolder = "";
  let wordDoc = "";
  let sheetDoc = "";
  const limitsNow = async () => (await json(`${at}/state`)).body.limits as Record<string, number>;

  test("i: the limits of comments and the editor's chat are set on the Office page (the grace of a deleted comment's chat, the longest answer in a comment) and take effect at once; an agent Aegis and a project Report, each with a chat", { timeout: 900_000 }, async () => {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    await page.goto(`${origin}/settings/x/@pithagoras/office`);
    const region = page.getByRole("region", { name: /^(Comments and chat with agents|Kommentare und Chat mit Agenten)$/ });
    await region.waitFor({ timeout: 60_000 });
    const grace = region.getByRole("textbox", { name: /^(Seconds before a deleted comment's chat goes|Sekunden, bis der Chat eines gelöschten Kommentars geht)$/ });
    assert.equal(await grace.inputValue(), "120");
    await grace.fill("5");
    await region.getByRole("textbox", { name: /^(Longest answer in a comment, in characters|Längste Antwort in einem Kommentar, in Zeichen)$/ }).fill("200");
    await region.getByRole("button", { name: /^(Save|Speichern)$/ }).click();
    let limits: Record<string, number> = {};
    assert.ok(await until(async () => (limits = await limitsNow()).docchatRemoveAfterS === 5 && limits.docchatReplyChars === 200, 10_000), `saved: ${JSON.stringify(limits)}`);
    await page.context().close();

    const agent = await json(`${origin}/api/agents`, { method: "POST", body: JSON.stringify({ name: "Aegis" }) });
    assert.equal(agent.status, 200, JSON.stringify(agent.body));
    const withAegis = await json(`${origin}/api/sessions`, { method: "POST", body: JSON.stringify({ agent: agent.body.id }) });
    assert.equal(withAegis.status, 200, JSON.stringify(withAegis.body));
    aegisChat = withAegis.body.id;
    aegisHome = realpathSync(agent.body.home);
    const project = await json(`${origin}/api/projects`, { method: "POST", body: JSON.stringify({ name: "Report" }) });
    assert.equal(project.status, 200, JSON.stringify(project.body));
    const inReport = await json(`${origin}/api/sessions`, { method: "POST", body: JSON.stringify({ workspace: project.body.path }) });
    assert.equal(inReport.status, 200, JSON.stringify(inReport.body));
    reportChat = inReport.body.id;
    reportFolder = realpathSync(project.body.path);
    await say(reportChat, []);
    const [word, sheet] = await say(aegisChat, [
      { name: "office_create", arguments: { title: "Talk to Aegis", type: "word" } },
      { name: "office_create", arguments: { title: "Numbers for Report", type: "cell" } },
    ]);
    wordDoc = /id ([\w-]+),/.exec(word)![1];
    sheetDoc = /id ([\w-]+),/.exec(sheet)![1];
    const users = (await json(`${at}/mentionables`)).body.users as { name: string; email: string }[];
    console.log(`i. who can be mentioned: ${JSON.stringify(users)}`);
    assert.ok(users.some((u) => u.name === "Aegis" && u.email === "Aegis"));
    // The portal names a project by its folder: "report".
    assert.ok(users.some((u) => u.name === "report (project)" && u.email === "project:report"));
  });

  test("j: Word: a person types @ in a comment and sees the agents and projects, picks Aegis, and Aegis answers in the thread within seconds; a reply continues the same chat, which has the thread's history; resolve and unresolve keep it; a comment with @Aegis typed by hand gets a chat of its own, which goes after the Office page's grace once the comment is deleted; no chat list shows these chats", { timeout: 900_000 }, async () => {
    const { page, frame } = await personOpens(wordDoc, "word");
    await frame.locator("#editor_sdk").click({ position: { x: 300, y: 200 } });
    await page.keyboard.type("The budget grows by ten percent next year.", { delay: 10 });
    await page.keyboard.press("Control+a");
    const [j1, j2, j3, j4] = ["j1", "j2", "j3", "j4"].map((x) => `${x}-${process.pid}`);
    const typed = await commentInPopover(page, frame, [`Stimmt das? SCRIPT#${j1} <<<[]>>> `, "Ae", "Aegis"], listsAgentsAndProjects(page, frame, "word-mention-list"));
    const t0 = Date.now();
    assert.match(typed, /\+Aegis\s*$/, "the picked name is inserted");
    const mine = async (id: string) => (await threadsIn(frame)).find((t) => t.text.includes(id));
    let thread: Shown | undefined;
    assert.ok(await until(async () => Boolean((thread = await mine(j1))?.replies.some(([who, text]) => who === "Aegis (agent)" && text === `Done ${j1}.`)), 60_000, 300), `Aegis's answer in the thread: ${JSON.stringify(await threadsIn(frame))}`);
    const took = Date.now() - t0;
    console.log(`j. Aegis's answer in the thread ${took} ms after Add`);
    assert.ok(took < 30_000, `within seconds: ${took} ms`);
    const records = threadRecords(wordDoc);
    assert.deepEqual(Object.keys(records), [thread!.guid], "one thread, by the comment's GUID");
    const entries = Object.entries(records[thread!.guid].agents);
    assert.equal(entries.length, 1);
    const first = entries[0][1].chatId!;
    assert.ok(first && (await chatExists(first)), "its chat is there");

    // A reply in the same thread: the same chat, which has the comment as its history.
    await frame.evaluate(`${comments}.onAddReplyComment(${JSON.stringify(thread!.uid)}, ${JSON.stringify(`Und warum? SCRIPT#${j2} <<<[]>>>`)})`);
    const replied = await ranScript(j2);
    console.log(`j. the reply's run: seen ${JSON.stringify(replied[0].seen)}, prompt ${JSON.stringify(replied[0].prompt)}`);
    assert.deepEqual(replied[0].seen, [j1, j2], "the chat has the comment and the reply");
    assert.equal(replied[0].prompt, `A reply in the thread:\nUnd warum? SCRIPT#${j2} <<<[]>>>`);
    assert.ok(await until(async () => Boolean((await mine(j1))?.replies.some(([who, text]) => who === "Aegis (agent)" && text === `Done ${j2}.`)), 60_000, 300), "the reply's answer in the thread");
    assert.equal(Object.values(threadRecords(wordDoc)[thread!.guid].agents)[0].chatId, first, "the same chat");
    await shot(page, "word-answered-thread");

    // Resolved, then unresolved: longer than the grace, and the thread and its chat stay.
    await frame.evaluate(`${comments}.onResolveComment(${JSON.stringify(thread!.uid)})`);
    assert.ok(await until(async () => Boolean((await mine(j1))?.resolved), 5000), "resolved");
    await delay(7000);
    await frame.evaluate(`${comments}.onResolveComment(${JSON.stringify(thread!.uid)})`);
    assert.ok(await until(async () => (await mine(j1))?.resolved === false, 5000), "unresolved");
    await delay(7000);
    assert.ok(await chatExists(first), "resolve and unresolve keep the chat");
    assert.equal(Object.values(threadRecords(wordDoc)[(await mine(j1))!.guid]?.agents ?? {})[0]?.chatId, first, "and the thread");
    await frame.evaluate(`${comments}.onAddReplyComment(${JSON.stringify((await mine(j1))!.uid)}, ${JSON.stringify(`Noch da? SCRIPT#${j3} <<<[]>>>`)})`);
    assert.deepEqual((await ranScript(j3))[0].seen, [j1, j2, j3], "a reply after the unresolve goes on in the same chat");

    // A second comment, the agent's name typed by hand: a chat of its own.
    await frame.locator("#editor_sdk").click({ position: { x: 300, y: 200 } });
    await page.keyboard.press("Control+a");
    const byHand = await commentInPopover(page, frame, [`@Aegis wie viel ist das? SCRIPT#${j4} <<<[]>>>`]);
    assert.match(byHand, /^@Aegis wie viel/, "typed by hand");
    assert.ok(await until(async () => Boolean((await mine(j4))?.replies.some(([who, text]) => who === "Aegis (agent)" && text === `Done ${j4}.`)), 60_000, 300), `the typed mention's answer: ${JSON.stringify(await threadsIn(frame))}`);
    const other = (await mine(j4))!;
    const second = Object.values(threadRecords(wordDoc)[other.guid].agents)[0].chatId!;
    assert.ok(second && second !== first, "a chat of its own");
    assert.deepEqual((await ranScript(j4))[0].seen, [j4], "which has only its own comment");

    // Neither is in any chat list (the person's own chat with Aegis is).
    const listed = await listedChats();
    assert.ok(listed.has(aegisChat), "the lists show the person's chats");
    assert.ok(!listed.has(first) && !listed.has(second), "the comments' chats are in no list");

    // The second comment deleted: its chat goes after the grace the Office page set (5 s; 120 s by default).
    await frame.evaluate(`${comments}.onRemoveComment(${JSON.stringify(other.uid)})`);
    const t1 = Date.now();
    assert.ok(await until(async () => !(await chatExists(second)), 40_000, 500), "the deleted comment's chat goes");
    console.log(`j. the deleted comment's chat went ${Date.now() - t1} ms after the delete`);
    assert.ok(Date.now() - t1 >= 4000, "after the grace");
    assert.equal(threadRecords(wordDoc)[other.guid], undefined, "and its thread");
    assert.ok(await chatExists(first), "the other comment's chat stays");
    await personCloses(page);
  });

  test("k: a spreadsheet: a cell comment that picks the project Report gets Report's answer in its thread, cut at the Office page's longest answer; a reply continues the same chat with its history; resolve and unresolve keep it; deleted, its chat goes after the grace", { timeout: 900_000 }, async () => {
    const { page, frame } = await personOpens(sheetDoc, "cell");
    // The workbook takes a moment after the editor is there.
    assert.ok(await until(() => frame.evaluate(`window.Asc.editor.asc_findCell("B2")`).then(() => true, () => false), 30_000, 500), "B2 selected");
    const [k1, k2, k3] = ["k1", "k2", "k3"].map((x) => `${x}-${process.pid}`);
    const long = `${"Die Summe stimmt. ".repeat(20)}Ende.`;
    const typed = await commentInPopover(page, frame, [`Summe prüfen SCRIPT#${k1} <<<${JSON.stringify([{ say: long }])}>>> `, "re", "report (project)"], listsAgentsAndProjects(page, frame, "cell-mention-list"));
    const t0 = Date.now();
    assert.match(typed, /\+project:report\s*$/);
    const mine = async (id: string) => (await threadsIn(frame)).find((t) => t.text.includes(id));
    const cut = `${long.slice(0, 200)} (…)`;
    assert.ok(await until(async () => Boolean((await mine(k1))?.replies.some(([who, text]) => who === "report (agent)" && text === cut)), 60_000, 300), `Report's answer, cut at 200 characters: ${JSON.stringify(await threadsIn(frame))}`);
    const took = Date.now() - t0;
    console.log(`k. Report's answer in the cell comment's thread ${took} ms after Add (a cell comment's answer waits until it is 5 s old)`);
    assert.ok(took < 30_000, `within seconds: ${took} ms`);
    const thread = (await mine(k1))!;
    const [[guid, record]] = Object.entries(threadRecords(sheetDoc));
    const chat = Object.values(record.agents)[0].chatId!;
    assert.ok(await chatExists(chat));
    assert.ok(!(await listedChats()).has(chat), "in no chat list");

    await frame.evaluate(`${comments}.onAddReplyComment(${JSON.stringify(thread.uid)}, ${JSON.stringify(`Und Spalte C? SCRIPT#${k2} <<<[]>>>`)})`);
    assert.deepEqual((await ranScript(k2))[0].seen, [k1, k2], "the same chat, with the comment");
    assert.ok(await until(async () => Boolean((await mine(k1))?.replies.some(([who, text]) => who === "report (agent)" && text === `Done ${k2}.`)), 60_000, 300), `the reply's answer: ${JSON.stringify(await threadsIn(frame))}`);
    await shot(page, "cell-answered-thread");

    await frame.evaluate(`${comments}.onResolveComment(${JSON.stringify(thread.uid)})`);
    assert.ok(await until(async () => Boolean((await mine(k1))?.resolved), 5000), "resolved");
    await delay(7000);
    await frame.evaluate(`${comments}.onResolveComment(${JSON.stringify(thread.uid)})`);
    assert.ok(await until(async () => (await mine(k1))?.resolved === false, 5000), "unresolved");
    await delay(7000);
    assert.ok(await chatExists(chat), "resolve and unresolve keep the chat");
    await frame.evaluate(`${comments}.onAddReplyComment(${JSON.stringify(thread.uid)}, ${JSON.stringify(`Danke SCRIPT#${k3} <<<[]>>>`)})`);
    assert.deepEqual((await ranScript(k3))[0].seen, [k1, k2, k3]);
    // The person deletes the comment once they read the answer (a reply posted on a comment just deleted would bring it
    // back: docchat holds answers back while a delete is under way, but one already handed to the agent's editor goes).
    assert.ok(await until(async () => Boolean((await mine(k1))?.replies.some(([, text]) => text === `Done ${k3}.`)), 60_000, 300), "the last answer in the thread");

    await frame.evaluate(`${comments}.onRemoveComment(${JSON.stringify(thread.uid)})`);
    const t1 = Date.now();
    assert.ok(await until(async () => !(await chatExists(chat)), 40_000, 500), `the deleted comment's chat goes: ${JSON.stringify({ record: threadRecords(sheetDoc), shown: await threadsIn(frame) })}`);
    console.log(`k. the deleted cell comment's chat went ${Date.now() - t1} ms after the delete`);
    assert.equal(threadRecords(sheetDoc)[guid], undefined);
    await personCloses(page);
  });

  test("l: the editor's chat, in Word and a spreadsheet: a message gets the owning agent's answer there; two messages during a run arrive together as the next prompt; a run that would ask a person gets an error at once and answers; no chat list shows these chats", { timeout: 900_000 }, async () => {
    const [l1, l2, l3, l4, l5] = ["l1", "l2", "l3", "l4", "l5"].map((x) => `${x}-${process.pid}`);
    const fromAgent = (heard: string[][], text: string) => heard.some(([id, name, said]) => /^agent:/.test(id) && /Aegis/.test(name) && said === text);

    const word = await personOpens(wordDoc, "word");
    await openChat(word.frame);
    const t0 = Date.now();
    await sendChat(word.page, word.frame, `Worum geht es? SCRIPT#${l1} <<<[]>>>`);
    assert.ok(await until(async () => fromAgent(await chatHeard(word.frame), `Done ${l1}.`), 60_000, 300), `Aegis's answer in the editor's chat: ${JSON.stringify(await chatHeard(word.frame))}`);
    console.log(`l. Aegis's answer in Word's editor chat ${Date.now() - t0} ms after Send`);
    await delay(500);
    await shot(word.page, "word-editor-chat");
    const wordSession = Object.values(sessionRecords()).find((s) => s.docId === wordDoc)!;
    assert.ok(wordSession?.chatId && (await chatExists(wordSession.chatId)), "the session's chat");

    const sheet = await personOpens(sheetDoc, "cell");
    await openChat(sheet.frame);
    // A run that takes a while; two messages come during it.
    await sendChat(sheet.page, sheet.frame, `Erste Frage SLOW#8000 SCRIPT#${l2} <<<[]>>>`);
    assert.ok(await until(() => modelLines().some((l) => l.id === l2), 60_000), "the first message's run started");
    await sendChat(sheet.page, sheet.frame, `Zweite SCRIPT#${l3} <<<[]>>>`);
    await sendChat(sheet.page, sheet.frame, `Dritte SCRIPT#${l4} <<<[]>>>`);
    const both = await ranScript(l3);
    console.log(`l. the prompt after the run: ${JSON.stringify(both[0].prompt)}`);
    assert.match(both[0].prompt, new RegExp(`Zweite SCRIPT#${l3} <<<\\[\\]>>>\\n\\nDritte SCRIPT#${l4} <<<\\[\\]>>>$`), "the two messages are the next prompt, together");
    // (The first run's answer was held back 8 s after its request.)
    assert.ok(both[0].at >= modelLines().find((l) => l.id === l2 && l.final)!.at + 7500, "after the run they came in");
    assert.ok(!modelLines().some((l) => l.id === l4), "the third was no prompt of its own");
    assert.deepEqual(both[0].seen, [l2, l3, l4]);
    assert.ok(await until(async () => {
      const heard = await chatHeard(sheet.frame);
      return fromAgent(heard, `Done ${l2}.`) && fromAgent(heard, `Done ${l3}.`);
    }, 60_000, 300), `both answers in the spreadsheet's editor chat: ${JSON.stringify(await chatHeard(sheet.frame))}`);

    // Nothing waits for a person: the question tool is refused at once, and the run goes on to its answer.
    await sendChat(sheet.page, sheet.frame, `Frag mich SCRIPT#${l5} <<<${JSON.stringify([{ name: "ask_question", arguments: { questions: [{ question: "Which one?", options: ["A", "B"] }] } }])}>>>`);
    const asked = await ranScript(l5);
    const final = asked.find((l) => l.final)!;
    console.log(`l. the question in the editor's chat: ${JSON.stringify(final.results)}, ${final.at - asked[0].at} ms from the call to its answer`);
    assert.ok(asked.every((l) => !l.tools.includes("ask_question")), "not offered");
    assert.match(final.results[0] ?? "", /ask_question not found/);
    assert.ok(final.at - asked[0].at < 10_000, "refused at once");
    assert.ok(await until(async () => fromAgent(await chatHeard(sheet.frame), `Done ${l5}.`), 60_000, 300), "and answered");
    await delay(500);
    await shot(sheet.page, "cell-editor-chat");

    const sessions = Object.values(sessionRecords()).filter((s) => s.docId === wordDoc || s.docId === sheetDoc);
    const listed = await listedChats();
    assert.ok(listed.has(aegisChat));
    for (const s of sessions) assert.ok(s.chatId && !listed.has(s.chatId), `the editor's chat ${s.chatId} is in no list`);
    // Nor does the person see one in the sidebar beside their chat with Aegis.
    const view = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await view.goto(`${origin}/s/${aegisChat}`);
    await view.locator("textarea, [contenteditable=true]").first().waitFor({ timeout: 60_000 });
    await delay(1500);
    const shown = await view.locator("body").innerText();
    assert.doesNotMatch(shown, /Comment: |Office chat/, "no internal chat in the portal's page");
    await view.context().close();
    await personCloses(word.page);
    await personCloses(sheet.page);
  });

  test("m: no document of nobody's: New document on the Office tab makes it in the default agent's home, office_create in the chat's agent home or project; the library has only the homes' and projects' documents; the earlier version's docs folder was moved into the default agent's home; the editor's chat of a document made on the tab is answered by the default agent", { timeout: 900_000 }, async () => {
    const agents = (await json(`${origin}/api/agents`)).body.agents as { id: string; name: string; home: string; first: boolean }[];
    const first = agents.find((a) => a.first)!;
    assert.ok(first, JSON.stringify(agents));
    const home = realpathSync(first.home);
    assert.equal(home, realpathSync(env.AGENT_HOME), "the default agent's home is the portal's agent home");
    console.log(`m. the default agent: ${first.name} at ${home}; Aegis at ${aegisHome}; the project Report at ${reportFolder}`);

    // The document of the earlier version's docs folder: moved into the default agent's home at start, said in the log.
    const old = (await state()).docs.find((d) => d.docId === LEGACY);
    assert.ok(old, "the earlier version's document is in the library");
    assert.equal(old.path, path.join(home, "Old minutes.docx"));
    assert.equal(old.owner, home);
    assert.equal(old.ownerName, first.name);
    assert.ok(existsSync(old.path));
    assert.ok(!existsSync(path.join(officeData, "docs")), "the extension's docs folder is gone");
    const moved = readFileSync(path.join(root, "portal.log"), "utf8").split("\n").filter((l) => l.includes(LEGACY) && /moved from the extension's docs folder/.test(l));
    console.log(`m. the log: ${JSON.stringify(moved)}`);
    assert.ok(moved.some((l) => l.includes(`to ${old.path}`)), "the move is logged");

    // New document on the Office tab, as a person makes one: in the default agent's home, and its.
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(`${origin}/x/@pithagoras/office/office`);
    const titleBox = page.getByRole("textbox", { name: /^(Title of a new document|Titel eines neuen Dokuments)$/ });
    await titleBox.waitFor({ timeout: 60_000 });
    await titleBox.fill("Made on the tab");
    const make = page.getByRole("button", { name: /^(New document|Neues Dokument)$/ });
    console.log(`m. the New document button says: ${JSON.stringify(await make.getAttribute("title"))}`);
    await make.click();
    let tabDoc: Awaited<ReturnType<typeof state>>["docs"][number] | undefined;
    assert.ok(await until(async () => !!(tabDoc = (await state()).docs.find((d) => d.title === "Made on the tab")), 20_000), "the document is made");
    assert.equal(tabDoc!.path, path.join(home, "Made on the tab.docx"), "in the default agent's home");
    assert.equal(tabDoc!.owner, home, "owned by the default agent's home");
    assert.equal(tabDoc!.ownerName, first.name);
    assert.ok(existsSync(tabDoc!.path));
    // Its row's owner chip names the default agent.
    const chip = page.locator(".po-chip-owner", { hasText: first.name }).first();
    await chip.waitFor({ timeout: 20_000 });
    const chips = await page.locator(".po-chip-owner").allInnerTexts();
    console.log(`m. the owner chips on the tab: ${JSON.stringify(chips)}`);
    assert.ok(chips.every((c) => /^(owned|Besitzer) · \S/.test(c.trim())), "every row has an owner");
    assert.doesNotMatch(await page.locator("body").innerText(), /unowned|ohne Besitzer|Nobody answers|Niemand antwortet/i);
    await page.context().close();

    // office_create from an agent's chat and from a project's chat: in that home, or that project's folder.
    await say(aegisChat, [{ name: "office_create", arguments: { title: "Aegis plan", type: "word" } }]);
    await say(reportChat, [{ name: "office_create", arguments: { title: "Report figures", type: "cell" } }]);
    const docs = (await state()).docs;
    const plan = docs.find((d) => d.title === "Aegis plan")!;
    const figures = docs.find((d) => d.title === "Report figures")!;
    assert.equal(plan.path, path.join(aegisHome, "Aegis plan.docx"));
    assert.equal(plan.owner, aegisHome);
    assert.equal(plan.ownerName, "Aegis");
    assert.equal(figures.path, path.join(reportFolder, "Report figures.xlsx"));
    assert.equal(figures.owner, reportFolder);
    assert.ok(existsSync(plan.path) && existsSync(figures.path));

    // Files dropped in: in an agent's home or a project (also deeper in it) they are documents; in a chat's folder or
    // elsewhere in the workspace they are not.
    const workspaces = realpathSync(env.WORKSPACE_ROOT);
    const drafts = path.join(workspaces, ".drafts");
    mkdirSync(drafts, { recursive: true });
    const inDrafts = await json(`${origin}/api/sessions`, { method: "POST", body: JSON.stringify({ workspace: drafts }) });
    assert.equal(inDrafts.status, 200, JSON.stringify(inDrafts.body));
    const bytes = await templateDocx();
    mkdirSync(path.join(reportFolder, "minutes"), { recursive: true });
    writeFileSync(path.join(aegisHome, "Dropped in Aegis.docx"), bytes);
    writeFileSync(path.join(reportFolder, "minutes", "Dropped in Report.docx"), bytes);
    writeFileSync(path.join(drafts, "In a chat folder.docx"), bytes);
    writeFileSync(path.join(workspaces, "Loose in the workspace.docx"), bytes);
    const rescan = await json(`${at}/documents/rescan`, { method: "POST", body: "{}" });
    assert.equal(rescan.status, 200, JSON.stringify(rescan.body));
    console.log(`m. Rescan: ${JSON.stringify(rescan.body)}`);
    const after = (await state()).docs;
    const titled = (title: string) => after.find((d) => d.title === title);
    assert.equal(titled("Dropped in Aegis")?.owner, aegisHome, "the one in Aegis's home is Aegis's");
    assert.equal(titled("Dropped in Report")?.owner, reportFolder, "the one deeper in the project is the project's");
    assert.equal(titled("Dropped in Report")?.path, path.join(reportFolder, "minutes", "Dropped in Report.docx"));
    assert.equal(titled("In a chat folder"), undefined, "not the one in a chat's folder");
    assert.equal(titled("Loose in the workspace"), undefined, "nor the one elsewhere in the workspace");
    console.log(`m. the library's owners: ${JSON.stringify([...new Set(after.map((d) => d.owner))])}`);
    assert.ok(after.every((d) => [home, aegisHome, reportFolder].includes(d.owner) && within(d.owner, d.path)), "every document is in its owner's folder, an agent's home or a project");

    // The editor's chat of the document made on the tab: answered by the default agent, in a chat of its home.
    const m1 = `m1-${process.pid}`;
    const { page: editor, frame } = await personOpens(tabDoc!.docId, "word");
    await openChat(frame);
    await sendChat(editor, frame, `Wer antwortet? SCRIPT#${m1} <<<[]>>>`);
    let heard: string[][] = [];
    assert.ok(await until(async () => (heard = await chatHeard(frame)).some(([id, name, said]) => /^agent:/.test(id) && name.includes(first.name) && said === `Done ${m1}.`), 60_000, 300), `the default agent's answer in the editor's chat: ${JSON.stringify(heard)}`);
    console.log(`m. the editor's chat heard: ${JSON.stringify(heard)}`);
    const session = Object.values(sessionRecords()).find((s) => s.docId === tabDoc!.docId);
    assert.ok(session?.chatId, "the editor's chat has a chat");
    const behind = await json(`${origin}/api/sessions/${session!.chatId}`);
    assert.equal(behind.status, 200);
    assert.equal(realpathSync(behind.body.workspace), home, "the chat behind it works in the default agent's home");
    await shot(editor, "owned-tab-document-chat");
    await personCloses(editor);
  });

  /** A chat of `agent` (the default one where none is named) whose model takes pictures (scripted-eye). */
  const eyeChat = async (agent?: string) => {
    const made = await json(`${origin}/api/sessions`, { method: "POST", body: JSON.stringify(agent ? { agent } : {}) });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const set = await json(`${origin}/api/sessions/${made.body.id}/config`, { method: "POST", body: JSON.stringify({ provider: "scripted", modelId: "scripted-eye" }) });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    return made.body.id as string;
  };
  /** The one picture the model got with tool result `n`: a JPEG within the caps (the longer side 1,024 px at most, 1 MiB
   * at most), kept where OFFICE_E2E_SHOTS names a folder. */
  const pictureOf = (given: { images: Given[] }, n: number, name: string) => {
    const mine = given.images.filter((i) => i.result === n);
    assert.equal(mine.length, 1, `one picture with tool result ${n}: ${JSON.stringify(given.images)}`);
    const [image] = mine;
    assert.equal(image.mimeType, "image/jpeg");
    const bytes = readFileSync(image.file);
    const size = jpegSize(bytes);
    assert.ok(size, "a JPEG with its size in its frame header");
    assert.ok(Math.max(size.width, size.height) <= SHOT_SIDE.normal, `the longer side within ${SHOT_SIDE.normal} px: ${JSON.stringify(size)}`);
    assert.ok(bytes.length <= SHOT_MAX_BYTES, `within ${SHOT_MAX_BYTES} bytes: ${bytes.length}`);
    console.log(`n. ${name}: ${size.width} x ${size.height}, ${bytes.length} bytes`);
    if (process.env.OFFICE_E2E_SHOTS) writeFileSync(path.join(process.env.OFFICE_E2E_SHOTS, `screenshot-${name}-${mode}.jpg`), bytes);
    return { ...size, bytes };
  };
  /** What the person's Word editor shows of its own view, read without touching it: where its caret is on the screen
   * (which moves with the view's scroll too), the page count, and its status bar's page and zoom. */
  const personView = (frame: Frame) =>
    frame.evaluate(`(function () {
      var c = document.getElementById("id_target_cursor"), text = function (id) { var e = document.getElementById(id); return e ? e.textContent.trim() : null; };
      return JSON.stringify({ caret: c ? [c.style.left, c.style.top, c.style.height] : null, pages: window.Asc.editor.getCountPages(), page: text("label-pages"), zoom: text("label-zoom") });
    })()`) as Promise<string>;
  /** The relay's runs of the picture client (cdp.ts) between `since` and `until`, as Docker recorded them: start and end. */
  const shotRuns = (since: number, until: number) => {
    const lines = execFileSync("docker", ["events", "--since", String(since / 1000), "--until", String(until / 1000), "--filter", `container=${PREFIX}-relay`, "--filter", "event=exec_start", "--filter", "event=exec_die", "--format", "{{json .}}"], { encoding: "utf8" }).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const runs = new Map<string, { start?: number; end?: number }>();
    for (const e of lines) {
      const id = e.Actor?.Attributes?.execID as string;
      const run = runs.get(id) ?? {};
      if (/^exec_start: node --no-warnings -e /.test(e.Action ?? e.status ?? "")) run.start = e.timeNano / 1e6;
      if (/^exec_die/.test(e.Action ?? e.status ?? "")) run.end = e.timeNano / 1e6;
      runs.set(id, run);
    }
    return [...runs.values()].filter((r): r is { start: number; end: number } => r.start !== undefined && r.end !== undefined).sort((a, b) => a.start - b.start);
  };

  test("n: office_screenshot from a chat whose model takes pictures: a Word page and a sheet range of its agent's documents, each one JPEG within the caps with the text it shows; a person's editor of the Word document unchanged by it; a model without image input gets error:no_images, a document of another agent not_found; two agents' shots at once both taken, one after the other; the debugging port reached neither from a person's browser nor from a page in the agents' browser", { timeout: 900_000 }, async () => {
    const eye = await eyeChat();
    const word = await newDoc("Shot report", "word");
    const sheet = await newDoc("Shot numbers", "cell");
    const [wrote, filled] = await say(eye, [
      { name: "office_edit", arguments: { id: word, ops: [{ quote: "New document", replacement: "Quarterly shot report" }, { after: "Quarterly shot report", paragraphs: ["Revenue grew in every region."] }, { after: "Revenue grew in every region.", table: [["Region", "Revenue"], ["North", "120"], ["South", "95"]] }] } },
      { name: "office_edit", arguments: { id: sheet, ops: [{ range: "A1:C4", values: [["Region", "Q1", "Q2"], ["North", 120, 130], ["South", 95, 101], ["Total", "=SUM(B2:B3)", "=SUM(C2:C3)"]] }] } },
    ]);
    assert.match(wrote, /Edited "Shot report"/);
    assert.match(filled, /Edited "Shot numbers"/);

    // A person has the Word document open and typed a line they have not saved.
    const { page, frame } = await personOpens(word, "word");
    assert.ok(await until(async () => (await personText(frame)).includes("Quarterly shot report"), 30_000), "the document is loaded");
    await frame.locator("#editor_sdk").click({ position: { x: 400, y: 120 } });
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await delay(500);
    await page.keyboard.type("Typed by the person", { delay: 25 });
    await delay(2500);
    const viewBefore = await personView(frame);
    const pictureBefore = await page.screenshot();

    const t0 = Date.now();
    const shots = await ran(eye, [
      { name: "office_screenshot", arguments: { id: word } },
      { name: "office_screenshot", arguments: { id: sheet, range: "A1:C4" } },
    ]);
    console.log(`n. two shots in one run: ${Date.now() - t0} ms\nn. Word: ${JSON.stringify(shots.results[0])}\nn. sheet: ${JSON.stringify(shots.results[1])}`);
    assert.match(shots.results[0], new RegExp(`Page 1 of 1 of "Shot report" \\(id ${word}\\), as your editor shows it now\\. Its text:\\n\\n\\[1\\] Quarterly shot report\\n\\[2\\] Revenue grew in every region\\.\\n\\[3\\] table`));
    assert.match(shots.results[0], /North[\s\S]*120[\s\S]*South[\s\S]*95/);
    assert.match(shots.results[1], /Sheet "Sheet1" A1:C4 at 100 %, as your editor shows it now\. Its cells:\n\nA1: "?Region"?\n/);
    assert.match(shots.results[1], /\nB4: 215\b/);
    const page1 = pictureOf(shots, 0, "word-page");
    const range = pictureOf(shots, 1, "sheet-range");
    assert.ok(page1.height > page1.width, "a Word page stands upright");
    assert.ok(range.width > range.height, "four rows of three columns are wider than high");

    // The person's editor: not reloaded, its caret, page count and zoom as they were, their line still there. (Their
    // page may differ by one thing: the agent's cursor, which the person sees as a co-author's, is where the agent's
    // editor looked for the page.)
    await delay(1000);
    const viewAfter = await personView(frame);
    const pictureAfter = await page.screenshot();
    console.log(`n. the person's view before: ${viewBefore}\nn. after: ${viewAfter}\nn. the person's page the same to the byte: ${pictureBefore.equals(pictureAfter)}`);
    if (process.env.OFFICE_E2E_SHOTS) {
      writeFileSync(path.join(process.env.OFFICE_E2E_SHOTS, `screenshot-person-before-${mode}.png`), pictureBefore);
      writeFileSync(path.join(process.env.OFFICE_E2E_SHOTS, `screenshot-person-after-${mode}.png`), pictureAfter);
    }
    assert.equal(viewAfter, viewBefore, "the person's view is as it was");
    await notReloaded(page, frame);
    assert.match(await personText(frame), /Quarterly shot report[\s\S]*Typed by the person/);

    // A model without image input: refused before anything is done, and no picture.
    const blind = await chat();
    const refused = await ran(blind, [{ name: "office_screenshot", arguments: { id: word } }]);
    console.log(`n. a model without image input: ${JSON.stringify(refused.results[0])}`);
    assert.match(refused.results[0], /error:no_images scripted cannot see images; office_read gives the document's text/);
    assert.deepEqual(refused.images, []);

    // Another agent, Iris, with a document of its own: invisible to the default agent's chat.
    const iris = await json(`${origin}/api/agents`, { method: "POST", body: JSON.stringify({ name: "Iris" }) });
    assert.equal(iris.status, 200, JSON.stringify(iris.body));
    const irisChat = await eyeChat(iris.body.id);
    const [made] = await say(irisChat, [{ name: "office_create", arguments: { title: "Iris plan", type: "word" } }]);
    const irisDoc = /id ([\w-]+),/.exec(made)![1];
    const [irisWrote] = await say(irisChat, [{ name: "office_edit", arguments: { id: irisDoc, ops: [{ quote: "New document", replacement: "Iris keeps this plan" }] } }]);
    assert.match(irisWrote, /Edited "Iris plan"/);
    const unseen = await ran(eye, [{ name: "office_screenshot", arguments: { id: irisDoc } }]);
    console.log(`n. another agent's document: ${JSON.stringify(unseen.results[0])}`);
    assert.match(unseen.results[0], /error:not_found There is no document with that id/);
    assert.deepEqual(unseen.images, []);

    // Two agents' shots at once: both taken, the browser's one at a time.
    const since = Date.now() - 1000;
    const t1 = Date.now();
    const [mine, theirs] = await Promise.all([ran(eye, [{ name: "office_screenshot", arguments: { id: sheet, range: "A1:B3" } }]), ran(irisChat, [{ name: "office_screenshot", arguments: { id: irisDoc } }])]);
    console.log(`n. two shots at once: ${Date.now() - t1} ms\nn. the default agent's: ${JSON.stringify(mine.results[0])}\nn. Iris's: ${JSON.stringify(theirs.results[0])}`);
    assert.match(mine.results[0], /Sheet "Sheet1" A1:B3 at 100 %/);
    assert.match(theirs.results[0], /Page 1 of 1 of "Iris plan" .*\n\n\[1\] Iris keeps this plan/s);
    pictureOf(mine, 0, "at-once-sheet");
    pictureOf(theirs, 0, "at-once-word");
    await delay(1000);
    const runs = shotRuns(since, Date.now());
    console.log(`n. the relay's picture runs: ${JSON.stringify(runs.map((r) => [Math.round(r.start - since), Math.round(r.end - since)]))}`);
    assert.equal(runs.length, 2, "two runs of the picture client");
    assert.ok(runs[1].start >= runs[0].end, "the second began after the first had ended");

    // The debugging port: the agents' browser's address on its network, from the person's browser (the Office page).
    const agent = JSON.parse(execFileSync("docker", ["inspect", `${PREFIX}-agent`], { encoding: "utf8" }))[0];
    assert.deepEqual(Object.keys(agent.NetworkSettings.Networks), [`${PREFIX}-agents`], "the browser is on the agents' network alone");
    assert.ok(!Object.values(agent.HostConfig.PortBindings ?? {}).some((b) => Array.isArray(b) && b.length), "and publishes no port");
    const ip = agent.NetworkSettings.Networks[`${PREFIX}-agents`].IPAddress as string;
    const browserPath = execFileSync("docker", ["exec", `${PREFIX}-relay`, "node", "-e", `require("dns").promises.lookup(process.argv[1]).then(a => fetch("http://" + a.address + ":9222/json/version")).then(r => r.json()).then(j => console.log(new URL(j.webSocketDebuggerUrl).pathname))`, `${PREFIX}-agent`], { encoding: "utf8" }).trim();
    assert.match(browserPath, /^\/devtools\/browser\//, "the relay reaches it");
    const fromMachine = await fetch(`http://${ip}:9222/json/version`, { signal: AbortSignal.timeout(5000) }).then((r) => `HTTP ${r.status}`, (e: Error) => `failed (${e.message})`);
    console.log(`n. from the machine the person's browser runs on, ${ip}:9222: ${fromMachine}`);
    assert.match(fromMachine, /^failed/);
    const probe = (where: string[]) => `(async function () { var out = {}; for (var url of ${JSON.stringify(where)}) { out[url] = await fetch(url + '/json/version', { signal: AbortSignal.timeout(5000) }).then(function (r) { return 'read ' + r.status; }, function (e) { return 'failed: ' + e.message; }); out[url + ' ws'] = await new Promise(function (ok) { var w = new WebSocket(url.replace('http', 'ws') + ${JSON.stringify(browserPath)}); w.onopen = function () { ok('open'); }; w.onerror = function () { ok('refused'); }; setTimeout(function () { ok('no answer'); }, 5000); }); } return JSON.stringify(out); })()`;
    const fromPerson = JSON.parse((await page.evaluate(probe([`http://${ip}:9222`, `http://${ip}:9223`]))) as string) as Record<string, string>;
    console.log(`n. from the person's browser: ${JSON.stringify(fromPerson)}`);
    for (const [what, how] of Object.entries(fromPerson)) assert.match(how, what.endsWith(" ws") ? /^(refused|no answer)$/ : /^failed/, what);
    // From a page in the agents' browser (its seat page, through the relay as the picture client reaches it).
    const inside = `
      const dns = require("dns");
      (async () => {
        const a = (await dns.promises.lookup(process.argv[1])).address;
        const list = await (await fetch("http://" + a + ":9222/json/list")).json();
        const seat = list.find((p) => p.type === "page" && /\\/seat\\//.test(p.url));
        const ws = new WebSocket("ws://" + a + ":9222" + seat.webSocketDebuggerUrl.replace(/^ws:\\/\\/[^/]+/, ""));
        await new Promise((ok) => (ws.onopen = ok));
        ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) { console.log(m.result.result.value); process.exit(0); } };
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: process.argv[2], awaitPromise: true, returnByValue: true } }));
      })().catch((e) => { console.log("FAILED " + e.message); process.exit(0); });`;
    const fromPage = JSON.parse(execFileSync("docker", ["exec", `${PREFIX}-relay`, "node", "--no-warnings", "-e", inside, `${PREFIX}-agent`, probe([`http://${PREFIX}-agent:9222`, `http://${ip}:9222`, "http://127.0.0.1:9223"])], { encoding: "utf8", timeout: 60_000 }).trim()) as Record<string, string>;
    console.log(`n. from a page in the agents' browser: ${JSON.stringify(fromPage)}`);
    for (const [what, how] of Object.entries(fromPage)) assert.match(how, what.endsWith(" ws") ? /^(refused|no answer)$/ : /^failed/, what);
    await personCloses(page);
  });

  test("o: office_format from a chat: a scripted model formats a report (a style, a list, a table, the page, a footnote) and reads its formatting; the person's Office page shows it live; a picture of the page from a model that takes pictures", { timeout: 900_000 }, async () => {
    const eye = await eyeChat();
    const word = await newDoc("Formatted from a chat", "word");
    const { page, frame } = await personOpens(word, "word");
    const [wrote, formatted, read] = await say(eye, [
      { name: "office_edit", arguments: { id: word, ops: [{ quote: "New document", replacement: "Quarterly report" }, { after: "Quarterly report", paragraphs: ["Findings"], style: "Heading 1" }, { after: "Findings", paragraphs: ["Revenue grew. There was a discrepancy.", "North region", "South region"] }, { after: "South region", table: [["Region", "Revenue"], ["North", "120"]] }] } },
      {
        name: "office_format",
        arguments: {
          id: word,
          ops: [
            { format: "Quarterly report", set: { fontSize: 20, bold: true, color: "#C81E1E", align: "center" } },
            { defineStyle: "Callout", set: { italic: true, indentLeft: "1cm" } },
            { format: "Revenue grew", set: { style: "Callout" } },
            { format: "North region", through: "South region", set: { list: "bullet" } },
            { formatTable: "Region", set: { tableStyle: "Grid Table 4 - Accent 1", headerRows: 1, width: "100%" } },
            { page: "*", set: { margins: "2cm", footer: "Page {page} of {pages}" } },
            { footnote: "discrepancy", text: "Checked in March." },
          ],
        },
      },
      { name: "office_read", arguments: { id: word, formatting: true } },
    ]);
    console.log(`o. ${wrote}\no. ${formatted}\no. ${read}`);
    assert.match(formatted, /\nFormatted "Formatted from a chat" \(7 ops\), saved as revision [\d.]+\. 1 person in the document saw it live\. Made the style "Callout"\. The document reflowed/);
    assert.match(read, /"Quarterly report": 20, bold, #C81E1E/);
    assert.match(read, /\(Callout\) Revenue grew\./);
    assert.match(read, /\(bullet\) North region\n\[\d+\] \(bullet\) South region/);
    assert.match(read, /table \(style "Grid Table 4 - Accent 1", header row 1\)/);
    assert.match(read, /Footer: "Page \{page\} of \{pages\}"/);
    assert.match(read, /Footnotes: \[1\] in \[\d+\] after "Revenue grew\. There was a discrepancy": Checked in March\./);
    // The person's editor, not reloaded, has the look (its own select-all, as HTML).
    const html = String(await frame.evaluate(`(function () { var e = window.Asc.editor; e.asc_EditSelectAll(); return e.pluginMethod_GetSelectedContent({ type: "html" }); })()`));
    // (Its HTML says bold by a tag of its own; the size and colour in the style of the text's element.)
    const at = html.indexOf("Quarterly report");
    assert.match([...html.slice(0, at).matchAll(/style="([^"]*)"/g)].at(-1)?.[1] ?? "", /font-size:20pt;color:#c81e1e/i);
    await notReloaded(page, frame);
    const shot = await ran(eye, [{ name: "office_screenshot", arguments: { id: word } }]);
    assert.match(shot.results[0], /Page 1 of \d+ of "Formatted from a chat"/);
    pictureOf(shot, 0, "formatted-page");
    // The tool's card in the chat (the Office extension's) says what the call did.
    await personCloses(page);
  });

  /** The last `<w:p>` of `xml` that holds `text` (a heading's in the body, after its TOC entry). */
  const paraXml = (xml: string, text: string) => {
    const at = xml.lastIndexOf(text);
    assert.ok(at >= 0, `${JSON.stringify(text)} is in the part`);
    const from = Math.max(xml.lastIndexOf("<w:p>", at), xml.lastIndexOf("<w:p ", at));
    return xml.slice(from, xml.indexOf("</w:p>", at));
  };
  /** The id styles.xml gives the style named `name` (in any case: the file names the built-in ones in lower case). */
  const styleIdOf = (styles: string, name: string) => {
    for (const m of styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) if (new RegExp(`<w:name w:val="${name}"`, "i").test(m[2])) return m[1];
    assert.fail(`no style ${JSON.stringify(name)} in styles.xml`);
  };
  /** A Word document whose header holds a picture (a PNG of one pixel, 1.27 cm square) after the text "Logo". */
  const picturedHeaderDocx = async () => {
    const zip = new JSZip();
    const ns = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
    const rels = (...r: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${r.join("")}</Relationships>`;
    const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`);
    zip.file("_rels/.rels", rels(`<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>`));
    zip.file("word/_rels/document.xml.rels", rels(`<Relationship Id="rId1" Type="${R}/header" Target="header1.xml"/>`));
    zip.file("word/_rels/header1.xml.rels", rels(`<Relationship Id="rId1" Type="${R}/image" Target="media/logo.png"/>`));
    zip.file("word/media/logo.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    const size = `cx="457200" cy="457200"`;
    zip.file("word/header1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${ns}><w:p><w:r><w:t xml:space="preserve">Logo </w:t></w:r><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent ${size}/><wp:docPr id="1" name="Logo"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext ${size}/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:hdr>`);
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body><w:p><w:r><w:t>Under a pictured header</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`);
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  };

  /**
   * q: office_format end to end on a Word document the agent made: from a chat (scripted model), headings and a new
   * paragraph style, a numbered list that goes on and one that starts again, a table with a style, a header row and
   * merged cells, a header and a footer with the page number and count, a landscape section, a page break, a footnote
   * and a table of contents, in one call. The person's editor, open on it, has them at once; the save (the call's
   * forcesave) holds them in document.xml, styles.xml, numbering.xml, the header and footer parts and footnotes.xml;
   * office_read with formatting says them; office_screenshot's pictures of its pages show them. An existing style
   * without change: true and a header holding a picture without replace: true are refused. A call whose last op fails
   * after the ops before it were made leaves the document as it was, while the person types in it during the call, and
   * the person keeps what they typed.
   */
  test("q: office_format end to end from a chat on a Word document of the agent's: headings, a new style, a list going on and one starting again, a table with style, header row and merged cells, header and footer with page numbers, a landscape section, a page break, a footnote and a TOC; live in a person's editor, in the save, in office_read and in office_screenshot; refusals; a failing call taken back while the person types on", { timeout: 900_000 }, async () => {
    const eye = await eyeChat();
    // The results without the marks pi puts around a tool's outside content (their ids differ from call to call).
    const unwrap = (r: string) => r.replace(/^<<<untrusted:([0-9a-f]+)>>>[^\n]*\n([\s\S]*)\n<<<\/untrusted:\1>>>$/, "$2");
    const say = async (chatId: string, calls: { name: string; arguments: Record<string, unknown> }[]) => (await ran(chatId, calls)).results.map(unwrap);
    const [created] = await say(eye, [{ name: "office_create", arguments: { title: "Formatted end to end", type: "word" } }]);
    console.log(`q. ${created}`);
    const made = (await state()).docs.find((d) => d.title === "Formatted end to end");
    assert.ok(made, "the agent made the document");
    assert.equal(made.owner, realpathSync(env.AGENT_HOME), "the agent's own: in its home");
    assert.ok(within(made.owner, made.path));
    const word = made.docId;
    const { page, frame } = await personOpens(word, "word");
    const [wrote] = await say(eye, [
      {
        name: "office_edit",
        arguments: {
          id: word,
          ops: [
            { quote: "New document", replacement: "Quarterly report" },
            { after: "Quarterly report", paragraphs: ["Overview", "Sales grew in every area. One number was revised.", "Plan", "Step one", "Step two", "Step three", "Again one", "Again two", "Figures"] },
            { after: "Figures", table: [["Region", "Revenue"], ["North", "120"], ["Total of both", ""]] },
            { paragraphs: ["All amounts are unaudited.", "Appendix", "Wide appendix text.", "Closing words."] },
          ],
        },
      },
    ]);
    assert.match(wrote, /^Edited "Formatted end to end" \(4 ops\)/);
    assert.ok(await until(async () => (await personText(frame)).includes("Closing words."), 10_000), "the person's editor has the text");
    const pagesBefore = Number(await frame.evaluate("window.Asc.editor.getCountPages()"));
    const ops = [
      { format: "Quarterly report", set: { fontSize: 20, bold: true, align: "center" } },
      { format: "Overview", set: { style: "Heading 1" } },
      { format: "Plan", set: { style: "Heading 1" } },
      { format: "Figures", set: { style: "Heading 2" } },
      { format: "Appendix", set: { style: "Heading 1" } },
      { defineStyle: "Callout", set: { italic: true, color: "#1F4E79", indentLeft: "1cm" } },
      { format: "Sales grew", set: { style: "Callout" } },
      { format: "Step one", through: "Step two", set: { list: "number" } },
      // Right after the list: it goes on (3.).
      { format: "Step three", set: { list: "number" } },
      // Right after it too, but started again (1., 2.).
      { format: "Again one", through: "Again two", set: { list: "number", listStart: 1 } },
      { formatTable: "Region", set: { tableStyle: "Grid Table 4 - Accent 1", headerRows: 1, width: "100%" } },
      { formatTable: "Total of both", cells: "A3:B3", set: { merge: true } },
      { after: "Again two", pageBreak: true },
      { sectionBreak: "All amounts are unaudited.", type: "nextPage" },
      { page: "*", set: { margins: "2cm", header: "Meridian Labs — internal", footer: "Page {page} of {pages}" } },
      { page: "Wide appendix text", set: { orientation: "landscape" } },
      { footnote: "revised", text: "Revised in March." },
      { toc: true, levels: 2 },
    ];
    const t0 = Date.now();
    const [formatted, read] = await say(eye, [
      { name: "office_format", arguments: { id: word, ops } },
      { name: "office_read", arguments: { id: word, formatting: true } },
    ]);
    console.log(`q. office_format (${Date.now() - t0} ms with the read): ${formatted}\nq. office_read with formatting:\n${read}`);
    assert.match(formatted, new RegExp(`^Formatted "Formatted end to end" \\(${ops.length} ops\\), saved as revision [\\d.]+\\. 1 person in the document saw it live\\. Made the style "Callout"\\. The document reflowed`));

    // office_read with formatting says each of them.
    for (const want of [
      /Styles in use: [^\n]*Callout \(paragraph[^)]*: italic, #1F4E79; indent left 1cm\)/,
      /Section 1: \S+ portrait, margins 2\/2\/2\/2 cm \(top\/right\/bottom\/left\)\. Header: "Meridian Labs — internal"\. Footer: "Page \{page\} of \{pages\}"\./,
      /Section 2 \(from \[\d+\]\): \S+ landscape, margins 2\/2\/2\/2 cm/,
      // (The place is the text before the mark, its last 40 characters or so.)
      /Footnotes: \[1\] in \[8\] after "…[^"\n]*One number was revised": Revised in March\./,
      /\[8\] \(Callout\) Sales grew/,
      /\] \(toc 1\) Overview\t\d/,
      /\] \(toc 2\) Figures\t\d/,
      /\] \(center\) Quarterly report\n {4}"Quarterly report": 20, bold\n/,
      /\] \(Heading 1\) Overview\n\[\d+\] \(Callout\) Sales grew in every area\. One number was revised\.\n\[\d+\] \(Heading 1\) Plan\n/,
      /\] \(numbered "1\."\) Step one\n\[\d+\] \(numbered "2\."\) Step two\n\[\d+\] \(numbered "3\."\) Step three\n\[\d+\] \(numbered "1\."\) Again one\n\[\d+\] \(numbered "2\."\) Again two\n/,
      /\] \(Heading 2\) Figures\n\[\d+\] table \(style "Grid Table 4 - Accent 1", header row 1, A3 spans 2 columns\)\n\| Region \| Revenue \|\n\| North \| 120 \|\n\| Total of both( \/ )? \|\n/,
      /\] \(Heading 1\) Appendix\n/,
    ]) assert.match(read, want);

    // The person's editor, not reloaded, has them: the pages the break, the section and the TOC made, the title's
    // size, the style's colour, and the lists' numbers as it numbers them.
    let pages = 0;
    assert.ok(await until(async () => (pages = Number(await frame.evaluate("window.Asc.editor.getCountPages()"))) >= pagesBefore + 2, 10_000), `the person's editor has the new pages: ${pagesBefore} -> ${pages}`);
    const html = String(await frame.evaluate(`(function () { var e = window.Asc.editor; e.asc_EditSelectAll(); var h = e.pluginMethod_GetSelectedContent({ type: "html" }); e.asc_RemoveSelection && e.asc_RemoveSelection(); return h; })()`));
    const styleBefore = (text: string) => [...html.slice(0, html.indexOf(text)).matchAll(/style="([^"]*)"/g)].at(-1)?.[1] ?? "";
    const numbered = String(await frame.evaluate(`(function () { var e = window.Asc.editor; e.asc_EditSelectAll(); var t = e.pluginMethod_GetSelectedText({ Numbering: true, NewLineSeparator: "\\n", ParaSeparator: "\\n" }); e.asc_RemoveSelection && e.asc_RemoveSelection(); return t; })()`));
    console.log(`q. the person's editor: ${pagesBefore} -> ${pages} pages; "Quarterly report" ${JSON.stringify(styleBefore("Quarterly report"))}; "Sales grew" ${JSON.stringify(styleBefore("Sales grew"))}; its text with numbers: ${JSON.stringify(numbered)}`);
    assert.match(styleBefore("Quarterly report"), /font-size:20pt/i);
    assert.match(styleBefore("Sales grew"), /color:#1f4e79/i);
    assert.match(numbered, /1\.\s*Step one\s+2\.\s*Step two\s+3\.\s*Step three\s+1\.\s*Again one\s+2\.\s*Again two/);
    await notReloaded(page, frame);

    // The save holds them: the parts of the .docx, unzipped.
    const zip = await JSZip.loadAsync(readFileSync(await fileOf(word)));
    const part = async (name: string) => (await zip.file(name)?.async("string")) ?? "";
    const parts = async (pattern: RegExp) => (await Promise.all(Object.keys(zip.files).filter((n) => pattern.test(n)).map(part))).join("\n");
    const xml = await part("word/document.xml");
    const styles = await part("word/styles.xml");
    const header = await parts(/^word\/header\d*\.xml$/);
    const footer = await parts(/^word\/footer\d*\.xml$/);
    console.log(`q. the save: ${Object.keys(zip.files).filter((n) => !n.endsWith("/")).join(", ")}`);
    for (const [text, style] of [["Overview", "heading 1"], ["Plan", "heading 1"], ["Appendix", "heading 1"], ["Figures", "heading 2"], ["Sales grew", "Callout"]]) assert.match(paraXml(xml, `>${text}`), new RegExp(`<w:pStyle w:val="${styleIdOf(styles, style)}"\\s*/>`), `${text} in ${style}`);
    const callout = /<w:style\b[^>]*>(?:(?!<\/w:style>)[\s\S])*<w:name w:val="Callout"\s*\/>(?:(?!<\/w:style>)[\s\S])*<\/w:style>/.exec(styles)?.[0] ?? "";
    assert.match(callout, /<w:i\s*\/>/);
    assert.match(callout, /<w:color w:val="1F4E79"\s*\/>/i);
    assert.match(callout, /<w:ind [^>]*w:left="567"/, "1 cm, in twips");
    const numId = (text: string) => /<w:numId w:val="(\d+)"\s*\/>/.exec(paraXml(xml, `>${text}`))?.[1];
    const lists = ["Step one", "Step two", "Step three", "Again one", "Again two"].map(numId);
    console.log(`q. the lists' numIds: ${JSON.stringify(lists)}`);
    assert.ok(lists.every(Boolean), "each item is in a list");
    assert.equal(new Set(lists.slice(0, 3)).size, 1, "Step three goes on in the steps' list");
    assert.equal(lists[3], lists[4]);
    assert.notEqual(lists[3], lists[0], "Again one starts a list of its own");
    const table = xml.slice(xml.indexOf("<w:tbl>"), xml.indexOf("</w:tbl>"));
    assert.match(table, /<w:tblStyle w:val="[^"]+"\s*\/>/);
    assert.match(table, /<w:tblHeader\s*\/>/);
    assert.match(table, /<w:gridSpan w:val="2"\s*\/>/);
    assert.match(header, /Meridian Labs — internal/);
    assert.match(footer, /PAGE/);
    assert.match(footer, /NUMPAGES/);
    const sections = xml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g) ?? [];
    assert.equal(sections.length, 2, "two sections");
    assert.doesNotMatch(sections[0], /w:orient="landscape"/, "the first one portrait");
    assert.match(sections[1], /<w:pgSz [^>]*w:orient="landscape"/, "the second landscape");
    assert.match(xml, /Again two<\/w:t>(?:(?!<w:t[ >])[\s\S])*<w:br w:type="page"[^>]*\/>/, "a page break right after Again two");
    assert.match(xml, /<w:footnoteReference /);
    assert.match(await part("word/footnotes.xml"), /Revised in March\./);
    assert.match(xml, /<w:instrText[^>]*>\s*TOC \\o &quot;1-2&quot;/);
    // The entries' page numbers at the right margin of the TOC's (portrait) section: A4, 2 cm margins, 9,638 twips
    // across; not at the landscape section's 14,570, off the page.
    const tabs = [...xml.matchAll(/<w:tab w:val="right" w:leader="dot" w:pos="(\d+)"/g)].map((m) => m[1]);
    assert.ok(tabs.length >= 4 && tabs.every((t) => t === "9638"), `the TOC's tabs: ${JSON.stringify(tabs)}`);

    // office_screenshot's pictures of the pages (OFFICE_E2E_SHOTS keeps them).
    const shot = await ran(eye, [
      { name: "office_screenshot", arguments: { id: word, page: 1 } },
      { name: "office_screenshot", arguments: { id: word, quote: "Figures" } },
      { name: "office_screenshot", arguments: { id: word, quote: "Wide appendix text" } },
    ]);
    shot.results = shot.results.map(unwrap);
    console.log(`q. office_screenshot:\n${shot.results.join("\n---\n")}`);
    assert.match(shot.results[0], /^Page 1 of 3 of "Formatted end to end"[^\n]*\n\n\[1\] \(toc 1\) Overview\t1\n/, "page 1's text from its start, the TOC's entries first");
    assert.match(shot.results[1], /^Page 2 of \d+ of "Formatted end to end"/);
    assert.match(shot.results[2], /^Page 3 of \d+ of "Formatted end to end"/);
    const portrait = pictureOf(shot, 0, "q-page-1");
    pictureOf(shot, 1, "q-page-2");
    const landscape = pictureOf(shot, 2, "q-page-3");
    // Each page whole: A4's sides, 1 : 1.414, portrait and landscape.
    assert.ok(Math.abs(portrait.height / portrait.width - 1.414) < 0.03 && Math.abs(landscape.width / landscape.height - 1.414) < 0.03, `page 1 portrait, page 3 landscape, each whole: ${portrait.width}x${portrait.height}, ${landscape.width}x${landscape.height}`);

    // Refused: an existing style without change: true (and taken with it).
    const [again, changed] = await say(eye, [
      { name: "office_format", arguments: { id: word, ops: [{ defineStyle: "Callout", set: { bold: true } }] } },
      { name: "office_format", arguments: { id: word, ops: [{ defineStyle: "Callout", change: true, set: { color: "#1F4E79", italic: true } }] } },
    ]);
    console.log(`q. defineStyle again: ${again}\nq. with change: ${changed}`);
    assert.match(again, /error:style_exists op 1: the document has a style "Callout" already \(1 paragraph uses it\): give change: true to change it, or another name/);
    assert.match(changed, /Changed the style "Callout" \(1 paragraph uses it\)\./);

    // A call whose last op fails once the ops before it are made (its quote is parted by the footnote op 3 puts in
    // it), while the person types a line of their own: the editor's Undo takes the agent's call back, and only it.
    await frame.locator("#editor_sdk").click({ position: { x: 400, y: 300 } });
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await delay(500);
    await page.keyboard.type("Typed by the person:", { delay: 25 });
    await delay(2500);
    const [before] = await say(eye, [{ name: "office_read", arguments: { id: word, formatting: true } }]);
    assert.match(before, /\] Typed by the person:\n/);
    const more = " and more words, typed while the agent works on the document";
    let typedAt = 0;
    const typing = page.keyboard.type(more, { delay: 80 }).then(() => (typedAt = Date.now()));
    await delay(400);
    const t1 = Date.now();
    const [failed] = await say(eye, [
      {
        name: "office_format",
        arguments: { id: word, ops: [{ format: "Closing words", set: { highlight: "yellow" } }, { format: "Quarterly report", set: { fontSize: 30 } }, { footnote: "Closing", text: "A note the Undo takes back." }, { format: "Closing words", set: { italic: true } }] },
      },
    ]);
    const answeredAt = Date.now();
    await typing;
    console.log(`q. a call failing at its last op, ${t1 - (typedAt - more.length * 80)} ms into the person's typing, answered after ${answeredAt - t1} ms, ${typedAt - answeredAt} ms before the typing ended: ${failed}`);
    assert.match(failed, /error:quote_not_found op 4: /);
    assert.ok(answeredAt < typedAt, "the call ran while the person typed");
    await delay(3000);
    const [afterwards] = await say(eye, [{ name: "office_read", arguments: { id: word, formatting: true } }]);
    // (The person's words are a block and a run of their own: both named by them.)
    assert.equal(afterwards, before.split("Typed by the person:").join(`Typed by the person:${more}`), "the document is as it was, with the person's words");
    const personHas = await personText(frame);
    await frame.evaluate("window.Asc.editor.asc_RemoveSelection && window.Asc.editor.asc_RemoveSelection()");
    assert.ok(personHas.includes(`Typed by the person:${more}`), `the person's editor has their words: ${JSON.stringify(personHas.slice(-200))}`);
    await notReloaded(page, frame);
    // The person leaves; the save has their words and nothing of the failed call.
    await personCloses(page);
    let saved = "";
    assert.ok(await until(async () => (saved = parseDocx(readFileSync(await fileOf(word))).text).includes(`Typed by the person:${more}`), 90_000, 1000), `the file has the person's words: ${JSON.stringify(saved.slice(-300))}`);
    const last = await JSZip.loadAsync(readFileSync(await fileOf(word)));
    const lastXml = (await last.file("word/document.xml")?.async("string")) ?? "";
    assert.doesNotMatch(lastXml, /<w:highlight w:val="yellow"/, "no highlight of the failed call");
    assert.doesNotMatch(lastXml, /<w:sz w:val="60"\s*\/>/, "nor its size");
    assert.equal((lastXml.match(/<w:footnoteReference /g) ?? []).length, 1, "nor its footnote");
    assert.doesNotMatch((await last.file("word/footnotes.xml")?.async("string")) ?? "", /A note the Undo takes back/);
    await noConflictCopy("Formatted end to end");

    // A header that holds a picture is replaced only with replace: true.
    await say(eye, [{ name: "office_create", arguments: { title: "Pictured header", type: "word" } }]);
    const pictured = (await state()).docs.find((d) => d.title === "Pictured header")!.docId;
    writeFileSync(await fileOf(pictured), await picturedHeaderDocx());
    const [seen, kept, replaced] = await say(eye, [
      { name: "office_read", arguments: { id: pictured, formatting: true } },
      { name: "office_format", arguments: { id: pictured, ops: [{ page: "*", set: { header: "Plain words" } }] } },
      { name: "office_format", arguments: { id: pictured, ops: [{ page: "*", set: { header: "Plain words", replace: true } }] } },
    ]);
    console.log(`q. the pictured header: ${seen}\nq. without replace: ${kept}\nq. with replace: ${replaced}`);
    assert.match(seen, /Header: "Logo ?" \(and more than text: pictures or tables\)/);
    assert.match(kept, /error:bad_op op 1: the header holds more than text \(a picture, a table or a field\): give replace: true to replace it all/);
    assert.match(replaced, /^Formatted "Pictured header" \(1 op\), saved as revision/);
    const plain = await JSZip.loadAsync(readFileSync(await fileOf(pictured)));
    const heads = (await Promise.all(Object.keys(plain.files).filter((n) => /^word\/header\d*\.xml$/.test(n)).map((n) => plain.file(n)!.async("string")))).join("\n");
    assert.match(heads, /Plain words/);
    assert.doesNotMatch(heads, /<w:drawing>|Logo/, "the picture went with replace: true");
  });

  /**
   * p: a real model (one OpenAI-compatible model, named by the environment) runs a fixed task through the office tools,
   * and the run's tool calls are counted: how many, how many refused and with which codes, and which keys of the ops it
   * got wrong, so the tool texts can be changed until a run has no refusal the text could have prevented. Skipped
   * unless OFFICE_REAL_MODEL_URL (its API's base, ending in /v1) and OFFICE_REAL_MODEL (its id) are set;
   * OFFICE_REAL_MODEL_KEY is its API key where it needs one, OFFICE_REAL_MODEL_IMAGES=1 says it takes pictures,
   * OFFICE_REAL_MODEL_CONTEXT its context window (65536). OFFICE_REAL_MODEL_REPORT names a file for the run's calls.
   * The model gets the office tools alone, and its key never reaches the portal (real-model.mts).
   */
  test("p: a real model writes and formats a report through the office tools; its calls and refusals are counted", { timeout: 1_800_000, skip: real && mode === "host" ? false : real ? "a real model runs with the portal on the machine (its proxy listens on the machine's loopback)" : "set OFFICE_REAL_MODEL_URL and OFFICE_REAL_MODEL (see the case's comment)" }, async () => {
    const made = await json(`${origin}/api/sessions`, { method: "POST", body: "{}" });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const chatId = made.body.id as string;
    const set = await json(`${origin}/api/sessions/${chatId}/config`, { method: "POST", body: JSON.stringify({ provider: "real", modelId: process.env.OFFICE_REAL_MODEL }) });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    // The chat has the office tools alone: no shell and no file tools for a hosted model on this machine, where the
    // portal runs with the sandbox off. Switched off for it: pi's own and every other tool a chat of the default agent
    // has, as the portal saw them registered (in a scripted chat first, where none has run yet). The proxy refuses any
    // request that offers another all the same.
    await say(await chat(), []);
    const listed = (await json(`${origin}/api/sessions/${chatId}/tools`)).body as { tools: { name: string }[] };
    assert.ok(listed.tools.some((t) => t.name === "office_format"), JSON.stringify(listed));
    const off = [...new Set([...PI_TOOLS, ...listed.tools.map((t) => t.name)])].filter((name) => !realModelMay(name));
    const switched = await json(`${origin}/api/sessions/${chatId}/tools`, { method: "PUT", body: JSON.stringify({ off }) });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    const task = [
      'Make a Word document titled "Quarterly report" with office_create, and write and format it with the office tools, without asking me anything:',
      '1. A title line "Quarterly report 2026", centred, 20 pt, bold, dark red.',
      '2. A heading "Summary" (Heading 1) with a paragraph of two sentences under it; make the words "record quarter" in it bold and yellow-highlighted.',
      '3. A heading "Highlights" with three bulleted points under it, and one second-level point under the second.',
      '4. A heading "Figures" with a table of three columns (Region, Revenue, Change) and four rows, its header row repeating, in the table style "Grid Table 4 - Accent 1", the Revenue column right-aligned.',
      '5. A style "Note" (italic, grey #666666, indented 1 cm) for a closing paragraph "Figures are unaudited.", with a footnote on "unaudited" saying "Audit due in March.".',
      '6. A4 landscape pages with 2 cm margins, a header "Meridian Labs — internal" and a footer "Page X of Y" with the real page numbers.',
      "7. A table of contents at the start.",
      "Then read the document with its formatting and fix anything that is not as asked. Answer with one line when done.",
    ].join("\n");
    real!.requests.length = 0;
    const t0 = Date.now();
    const sent = await json(`${origin}/api/sessions/${chatId}/prompt`, { method: "POST", body: JSON.stringify({ message: task }) });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await until(async () => (await json(`${origin}/api/sessions/${chatId}`)).body?.status === "running", 60_000, 500);
    assert.ok(await until(async () => (await json(`${origin}/api/sessions/${chatId}`)).body?.status !== "running", 1_700_000, 2000), "the run ended in time");
    // The calls and their results, as the last request the model got holds them.
    const last = real!.requests.at(-1) as { messages?: { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[] } | undefined;
    const messages = last?.messages ?? [];
    const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, typeof m.content === "string" ? m.content : JSON.stringify(m.content)]));
    const calls = messages.flatMap((m) => m.tool_calls ?? []).map((c) => ({ name: c.function.name, args: c.function.arguments, result: results.get(c.id) ?? "" }));
    const refusals = calls.filter((c) => /^(<<<[^\n]*\n)?error:/.test(c.result.replace(/^\s+/, "")) || /error:[a-z_]+ /.test(c.result.slice(0, 200)));
    const codes: Record<string, number> = {};
    for (const r of refusals) {
      const code = /error:([a-z_]+)/.exec(r.result)?.[1] ?? "?";
      codes[code] = (codes[code] ?? 0) + 1;
    }
    const report = { model: process.env.OFFICE_REAL_MODEL, seconds: Math.round((Date.now() - t0) / 1000), requests: real!.requests.length, calls: calls.length, byTool: calls.reduce((m: Record<string, number>, c) => ((m[c.name] = (m[c.name] ?? 0) + 1), m), {}), refused: refusals.length, codes, refusals: refusals.map((r) => ({ name: r.name, args: r.args.slice(0, 600), result: r.result.slice(0, 600) })) };
    console.log(`p. ${JSON.stringify(report, null, 1)}`);
    if (process.env.OFFICE_REAL_MODEL_REPORT) writeFileSync(process.env.OFFICE_REAL_MODEL_REPORT, JSON.stringify({ ...report, all: calls }, null, 1));
    assert.deepEqual(real!.refused, [], "no request offered the model a tool other than the office tools");
    assert.ok(real!.requests.length > 0 && real!.requests.every((r) => ((r as { tools?: { function?: { name?: string } }[] }).tools ?? []).every((t) => realModelMay(String(t.function?.name)))));
    // What the run made: the document, formatted, in the default agent's home.
    const doc = (await state()).docs.find((d) => d.title === "Quarterly report");
    assert.ok(doc, "the model made the document");
    assert.ok(calls.some((c) => c.name === "office_format" && /^(\s*<<<[^\n]*\n)?Formatted /.test(c.result)), "and formatted it with office_format");
    const xml = await partOf(doc!.docId, "word/document.xml");
    console.log(`p. the saved document: TOC ${/TOC \\o/.test(xml)}, table style ${/<w:tblStyle /.test(xml)}, header rows ${/<w:tblHeader/.test(xml)}, landscape ${/w:orient="landscape"/.test(xml)}, footnote ${/<w:footnoteReference/.test(xml)}, highlight ${/<w:highlight w:val="yellow"/.test(xml)}, lists ${/<w:numPr>/.test(xml)}`);
  });

  test("d: Office stopped: office_edit is refused with office_stopped, office_read reads the saved file", { timeout: 900_000 }, async () => {
    const doc = await newDoc("Stopped", "word");
    const id = await chat();
    const [edited] = await say(id, [{ name: "office_edit", arguments: { id: doc, ops: [{ paragraphs: ["Saved before the stop"] }] } }]);
    assert.match(edited, /saved as revision/);
    const stopped = await json(`${at}/container/stop`, { method: "POST" });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    const [refused, read] = await say(id, [
      { name: "office_edit", arguments: { id: doc, ops: [{ paragraphs: ["Written while stopped"] }] } },
      { name: "office_read", arguments: { id: doc } },
    ]);
    console.log(`d. office_edit: ${JSON.stringify(refused)}\nd. office_read: ${JSON.stringify(read)}`);
    assert.match(refused, /error:office_stopped /);
    assert.match(read, /Saved copy \(Office is stopped\): what the file holds\./);
    assert.match(read, /Saved before the stop/);
    assert.doesNotMatch(parseDocx(readFileSync(await fileOf(doc))).text, /Written while stopped/);
    const agent = execFileSync("docker", ["ps", "-a", "--filter", `name=^${PREFIX}-agent$`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
    assert.equal(agent, "", "the agents' browser went with the Document Server");
  });
}
