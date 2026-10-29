import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import JSZip from "jszip";
import { parseDocx, rewriteZip } from "../../src/ooxml.ts";
import { signJwt } from "../../src/jwt.ts";
import type * as Seat from "../../src/seat.ts";
import { EDITOR_HTML, editorPageJs } from "./page.mts";

/**
 * Office end to end, against the real Document Server: its server half started by the portal's own extension host,
 * after Docker for extensions, each from its source, Docker for extensions speaking to the machine's own Docker. The
 * portal is "on the machine" (host network), so the way in is Docker for extensions' forwarder on 127.0.0.1. A
 * Chromium opens a document in the Office page's own editor (office-editor.tsx, bundled with the portal's React:
 * page.mts), types into it and closes it, and the text must be in the file: what "Download failed", the refused key,
 * the refused callback token and the embed viewer each broke. Then the agent works in documents through its own editor
 * (the agents' browser, `chromedp/headless-shell`): a closed document, one a person types in, a spreadsheet, a
 * read-only seat, a file changed outside, a failed op, each Word op in the real editor, a used range away from A1, the
 * sheets of a workbook (made, written, renamed, moved, copied, hidden, shown, deleted) while a person has it open,
 * hidden ones kept hidden, an op the editor does not take with every op before it taken back, and how long large
 * edits take; people's editors run no plugin, the agents' browser reaches nothing but the relay, and with Office
 * stopped the agent reads the saved file and edits nothing. And once more through a reverse proxy that ends TLS and
 * sends no forwarded headers, as a plain nginx in front does.
 *
 * Opt-in: it needs Docker Engine 28 or later, the images (about 3 GB, `onlyoffice/documentserver:10.0.0.1` unless
 * OFFICE_E2E_IMAGE names another, and the agents' editor, which the test downloads through the Office page's route
 * where it is not there), Chromium for Playwright, and a few minutes. Its containers, network and volumes go by names
 * of their own (`office-e2e-ds…`, or OFFICE_E2E_CONTAINER's), and are removed at its end.
 *
 *   ./scripts/pithagoras.sh && OFFICE_E2E=1 PITHAGORAS_DIR=$PWD/.pithagoras npm run test:e2e -w office
 */

const DIR = process.env.PITHAGORAS_DIR;
if (process.env.OFFICE_E2E !== "1" || !DIR) {
  test("Office end to end against the real Document Server", { skip: "set OFFICE_E2E=1 and PITHAGORAS_DIR (see the file's header)" }, () => {});
} else {
  await run(path.resolve(DIR));
}

async function run(PITHAGORAS: string): Promise<void> {
  const from = (file: string) => pathToFileURL(path.join(PITHAGORAS, file)).href;
  const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const IMAGE = process.env.OFFICE_E2E_IMAGE ?? "onlyoffice/documentserver:10.0.0.1";
  // Names of its own where another run on the machine has the default ones (OFFICE_E2E_CONTAINER, OFFICE_E2E_PORT).
  const PREFIX = process.env.OFFICE_E2E_CONTAINER ?? "office-e2e-ds";

  const { inProcessHome } = await import(from("tests/helpers.mts"));
  inProcessHome("office-e2e-");
  process.env.PORTAL_PASSWORD = "";
  process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
  process.env.PITHAGORAS_OFFICE_CONTAINER = PREFIX;
  process.env.PITHAGORAS_OFFICE_PORT = process.env.OFFICE_E2E_PORT ?? "3990";

  // Office switched on, with the image under test, before its half starts: its first look starts it all.
  const data = path.join(process.env.DATA_DIR!, "extension-data", "%40pithagoras%2Foffice");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(data, "settings.json"), JSON.stringify({ enabled: true, imageTag: IMAGE }));

  // (After the environment above: the module names its containers when it loads.)
  const { MEM_COMMAND } = await import("../../src/container.ts");
  const host = await import(from("core/server/dist/extension-host.js"));
  const { requiresOf } = await import(from("core/server/dist/extension-ui.js"));
  const db = await import(from("core/server/dist/db.js"));
  db.getDb();
  const half = (folder: string, file: string) => {
    const meta = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8"));
    return { name: meta.name, version: meta.version, file: path.join(folder, file), rev: meta.version, requires: requiresOf(meta) };
  };
  const express = (await import(pathToFileURL(path.join(PITHAGORAS, "node_modules/express/index.js")).href)).default;
  const app = express().use("/api/x", host.extensionRoutes);
  // The Office page's editor itself, with the portal's React, at the address the portal gives Office's routes.
  const pageJs = await editorPageJs(PITHAGORAS, "/api/x/%40pithagoras/office");
  app.get("/editor.html", (_req: unknown, res: { type: (t: string) => { send: (b: string) => void } }) => res.type("html").send(EDITOR_HTML));
  app.get("/editor-page.js", (_req: unknown, res: { type: (t: string) => { send: (b: string) => void } }) => res.type("js").send(pageJs));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const at = `${origin}/api/x/%40pithagoras/office`;
  const json = async (url: string, init?: RequestInit) => {
    const answer = await fetch(url, { ...init, headers: { "content-type": "application/json", origin, ...init?.headers } });
    return { status: answer.status, body: await answer.json() };
  };

  /**
   * What the page shows as Office's memory (GET /container/status) against what the containers use: each container's
   * own cgroup less its droppable file cache, read before and after the status call (the figure lies between), and
   * `docker stats`, which counts the same way. With the agents' browser up the figure is both containers', and with it
   * stopped the Document Server's alone. The numbers go to the log (the owner's RAM line rests on them).
   */
  async function measure(label: string, browserUp: boolean): Promise<{ figure: number; ds: number; browser: number }> {
    const cgroup = (name: string) => Number(execFileSync("docker", ["exec", name, "sh", "-c", MEM_COMMAND], { encoding: "utf8" }).trim());
    const running = (name: string) => execFileSync("docker", ["ps", "-q", "--filter", `name=^${name}$`], { encoding: "utf8" }).trim() !== "";
    assert.equal(running(`${PREFIX}-agent`), browserUp, `${label}: the agents' browser ${browserUp ? "runs" : "is stopped"}`);
    await delay(16_000); // the status keeps what it read for 15 s
    const ds0 = cgroup(PREFIX);
    const br0 = browserUp ? cgroup(`${PREFIX}-agent`) : 0;
    const status = (await json(`${at}/container/status`)).body;
    const ds1 = cgroup(PREFIX);
    const br1 = browserUp ? cgroup(`${PREFIX}-agent`) : 0;
    const stats = execFileSync("docker", ["stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}}", PREFIX, ...(browserUp ? [`${PREFIX}-agent`] : [])], { encoding: "utf8" }).trim().split("\n");
    const statsBytes = stats.reduce((sum, line) => {
      const [, n, unit] = / ([\d.]+)(KiB|MiB|GiB) \//.exec(line)!;
      return sum + Number(n) * 1024 ** ({ KiB: 1, MiB: 2, GiB: 3 } as Record<string, number>)[unit];
    }, 0);
    const figure = status.memBytes as number;
    const mib = (n: number) => `${(n / 1048576).toFixed(0)} MiB`;
    console.log(`MEM ${label}: page ${mib(figure)}; Document Server cgroup ${mib(ds0)}..${mib(ds1)}; browser cgroup ${browserUp ? `${mib(br0)}..${mib(br1)}` : "stopped"}; docker stats: ${stats.join("; ")}`);
    const slack = 64 * 1048576;
    assert.ok(figure >= Math.min(ds0, ds1) + Math.min(br0, br1) - slack && figure <= Math.max(ds0, ds1) + Math.max(br0, br1) + slack, `${label}: the page's figure is the Document Server's plus ${browserUp ? "the browser's" : "nothing (the browser is stopped)"}`);
    assert.ok(Math.abs(figure - statsBytes) <= 0.25 * statsBytes + slack, `${label}: the figure (${mib(figure)}) is what docker stats shows (${mib(statsBytes)})`);
    return { figure, ds: Math.max(ds0, ds1), browser: Math.max(br0, br1) };
  }

  after(async () => {
    // OFFICE_E2E_KEEP=1 leaves the containers for a look at the Document Server's logs; `docker rm -f` them after.
    const keep = process.env.OFFICE_E2E_KEEP === "1";
    if (!keep) await json(`${at}/container/remove`, { method: "POST", body: JSON.stringify({ data: true }) }).catch(() => {});
    await host.stopServerHalves();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (keep) return;
    // What Docker for extensions made for the way in goes with the network; anything a failed run left, by name.
    for (const name of [`${PREFIX}-agent`, `${PREFIX}-relay`, `${PREFIX}-relay-forward`, PREFIX]) execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    for (const name of [`${PREFIX}-agents`, `${PREFIX}-net`]) {
      try {
        execFileSync("docker", ["network", "rm", name], { stdio: "ignore" });
      } catch {
        // gone with Office's own removal
      }
    }
    for (const end of ["data", "cache", "logs", "fonts"]) execFileSync("docker", ["volume", "rm", "-f", `${PREFIX}-${end}`], { stdio: "ignore" });
  });

  test("the Document Server, its relay and its network come up through Docker for extensions, and it answers through the way in", { timeout: 600_000 }, async () => {
    await host.syncServerHalves([half(path.join(PITHAGORAS, "extensions/docker"), "src/server.ts"), half(PACKAGE, "src/server.ts")]);
    assert.equal(host.serverFailure("@pithagoras/office"), undefined);
    let answer = "";
    for (let i = 0; i < 300 && answer !== "true"; i++) {
      await delay(2000);
      answer = await fetch(`${at}/ds/healthcheck`).then((r) => (r.ok ? r.text() : ""), () => "");
    }
    assert.equal(answer, "true", "the Document Server answers its health check through the relay");
    // It answers long before it is set up: a new container makes its fonts and then restarts its services, which an
    // editor opened before would not survive. Running, in the status, is after that.
    let state = "";
    for (let i = 0; i < 150 && state !== "running"; i++) {
      state = (await json(`${at}/container/status`)).body.state;
      if (state !== "running") await delay(2000);
    }
    assert.equal(state, "running", "the Document Server is set up");
    await measure("Document Server idle, no editor, no browser", false);
    const inspect = (name: string) => JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8" }))[0];
    assert.equal(inspect(PREFIX).HostConfig.NetworkMode, `${PREFIX}-net`);
    assert.deepEqual(inspect(PREFIX).HostConfig.PortBindings ?? {}, {}, "nothing of the Document Server's is published");
    assert.equal(inspect(`${PREFIX}-relay`).HostConfig.NetworkMode, `${PREFIX}-net`, "the way back runs over the way in: nothing of Office's is on the portal's network");
    const net = JSON.parse(execFileSync("docker", ["network", "inspect", `${PREFIX}-net`], { encoding: "utf8" }))[0];
    assert.equal(net.Internal, true);
    // Every folder the image keeps apart is a named volume of Office's: none is anonymous, which a re-create drops.
    const declared = Object.keys(JSON.parse(execFileSync("docker", ["image", "inspect", IMAGE, "--format", "{{json .Config.Volumes}}"], { encoding: "utf8" }))).sort();
    const mounts = inspect(PREFIX).Mounts as { Type: string; Name: string; Destination: string }[];
    assert.deepEqual(mounts.map((m) => m.Destination).sort(), declared);
    for (const m of mounts) assert.ok(m.Type === "volume" && m.Name.startsWith(`${PREFIX}-`), `${m.Destination} is in ${m.Name}`);
  });

  /** A document made, opened in the editor from `pageOrigin` as the Office page does, typed into and closed: the text
   * must be in the file. */
  async function openTypeSave(pageOrigin: string, title: string, typed: string, measured = false): Promise<void> {
    const made = await json(`${at}/documents`, { method: "POST", body: JSON.stringify({ title, type: "word" }) });
    assert.equal(made.status, 201);
    const doc = made.body as { docId: string };
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
      const failed: string[] = [];
      page.on("requestfailed", (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
      await page.goto(`${pageOrigin}/editor.html?doc=${encodeURIComponent(doc.docId)}`);
      let events: unknown[][] = [];
      for (let i = 0; i < 120 && !events.some((e) => e[0] !== "warning"); i++) {
        await delay(1000);
        events = await page.evaluate(() => (window as unknown as { __events: unknown[][] }).__events);
      }
      assert.deepEqual(events.filter((e) => e[0] !== "warning"), [["ready"]], `the editor opened the document (${JSON.stringify(events)}; failed loads: ${failed.join(", ")})`);
      const frame = page.frames().find((f) => /documenteditor\/main\//.test(f.url()));
      assert.ok(frame, "the full editor, not the embed viewer");
      // Somebody is in it: the Document Server said so through the callback.
      let locks: unknown[] = [];
      for (let i = 0; i < 30 && !locks.length; i++) {
        await delay(1000);
        locks = (await json(`${at}/state`)).body.locks[doc.docId];
      }
      assert.equal(locks.length, 1, "the editing seat shows while the editor is open");

      // The Document Server's own `info` for the document's key answers 0 while the session is open.
      const info = async () => {
        const secret = readFileSync(path.join(data, "jwt-secret"), "utf8").trim();
        const meta = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === doc.docId);
        const body = { c: "info", key: (await import("../../src/callback.ts")).makeKey(doc.docId, meta.mtimeMs) };
        const answer = await fetch(`http://127.0.0.1:${process.env.PITHAGORAS_OFFICE_PORT}/command`, { method: "POST", headers: { "content-type": "application/json", "X-Auth-Token": `Bearer ${signJwt(body, 60_000, secret)}` }, body: JSON.stringify(body) });
        return ((await answer.json()) as { error: number }).error;
      };
      assert.equal(await info(), 0, "the Document Server says the session is open");

      await frame.locator("#editor_sdk").click({ position: { x: 300, y: 150 } });
      await page.keyboard.type(typed, { delay: 30 });
      await delay(3000);
      if (measured) await measure("Document Server with one person editing, no browser", false);
      await page.evaluate(() => (window as unknown as { __editor: { destroyEditor(): void } }).__editor.destroyEditor());
      const file = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === doc.docId);
      const onDisk = file.path; // in the default agent's home, where New document made it
      let text = "";
      for (let i = 0; i < 90 && !text.includes(typed); i++) {
        await delay(1000);
        text = parseDocx(readFileSync(onDisk)).text;
      }
      assert.ok(text.includes(typed), "the Document Server's save was taken and written to the file");
      assert.deepEqual((await json(`${at}/state`)).body.locks[doc.docId], [], "nobody is in it once it closed");
      assert.equal(await info(), 1, "and that none is open once it closed");
    } finally {
      await browser.close();
    }
  }

  test("a document opens in the editor, takes what is typed, and the save lands in the file", { timeout: 600_000 }, async () => {
    await openTypeSave(origin, "End to end", "Typed end to end", true);
  });

  /* ------------------------------------------------------------------ */
  /* the agent's own editor                                               */
  /* ------------------------------------------------------------------ */

  // The half's own modules, as the portal loaded them (the first revision of a half is at its files' own addresses).
  const seat = await import("../../src/seat.ts");
  const { canonical } = await import("../../src/store.ts");
  const project = path.join(process.env.WORKSPACE_ROOT!, "acme");
  mkdirSync(project, { recursive: true });
  const home = canonical(project);
  const chatId = `office-e2e-${Math.random().toString(36).slice(2)}`;
  type Tool = { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: Record<string, any> }> };
  const tools: Record<string, Tool> = {};
  const agentContainer = () => {
    try {
      return JSON.parse(execFileSync("docker", ["inspect", `${PREFIX}-agent`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0];
    } catch {
      return undefined;
    }
  };
  /** A document of the project's agent, made with its own tool. */
  const agentDoc = async (title: string, type: "word" | "cell") => String((await tools.office_create.execute(`c-${title}`, { title, type })).details.id);
  const fileOf = async (docId: string) => {
    const doc = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === docId);
    return doc.path as string;
  };
  const partOf = async (docId: string, part: string) => (await JSZip.loadAsync(readFileSync(await fileOf(docId)))).file(part)!.async("string");
  const browser = await chromium.launch();
  after(() => browser.close());

  /** A person's editor of `docId`, as the Office page opens it. */
  async function personOpens(docId: string) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page.goto(`${origin}/editor.html?doc=${encodeURIComponent(docId)}`);
    const events = () => page.evaluate(() => (window as unknown as { __events: unknown[][] }).__events);
    for (let i = 0; i < 120 && !(await events()).some((e) => e[0] === "ready"); i++) await delay(1000);
    assert.ok((await events()).some((e) => e[0] === "ready"), JSON.stringify(await events()));
    let frame: import("@playwright/test").Frame | undefined;
    for (let i = 0; i < 60 && !frame; i++) {
      for (const f of page.frames().filter((f) => /editor\/main\//.test(f.url()))) if (await f.evaluate("Boolean(window.Asc && window.Asc.editor)").catch(() => false)) frame = f;
      if (!frame) await delay(500);
    }
    assert.ok(frame, "the person's editor frame");
    return { page, frame };
  }
  /** The sheets the person's spreadsheet editor shows, in order, as "Name" or "Name (hidden)". */
  const sheetsOf = (frame: import("@playwright/test").Frame) => frame.evaluate(`(function () { var e = window.Asc.editor, out = []; for (var i = 0; i < e.asc_getWorksheetsCount(); i++) out.push(e.asc_getWorksheetName(i) + (e.asc_isWorksheetHidden(i) ? " (hidden)" : "")); return out.join(", "); })()`) as Promise<string>;
  /** office_edit of `doc`, and how soon the person's editor (`frame`) shows `want`, logged under `label`. */
  const sheetEdit = (label: string, doc: string, frame: import("@playwright/test").Frame) => async (step: string, ops: unknown[], want: string) => {
    const t0 = Date.now();
    const edited = await tools.office_edit.execute(`s-${step}`, { id: doc, ops });
    const took = Date.now() - t0;
    let seen = "";
    const live = await until(async () => (seen = await sheetsOf(frame)) === want, 5000);
    console.log(`${label}. ${step}: ${edited.content[0].text} (${took} ms); the person's sheets ${JSON.stringify(seen)} ${Date.now() - t0} ms after the call`);
    assert.ok(live, `${step}: the person sees ${want} (they see ${seen})`);
  };
  /** What the person's Word editor holds, as its own select-all reads it. */
  const personText = (frame: import("@playwright/test").Frame) => frame.evaluate(`(function () { var e = window.Asc.editor; e.asc_EditSelectAll(); return e.pluginMethod_GetSelectedText(); })()`) as Promise<string>;
  const until = async (what: () => Promise<boolean>, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await what()) return true;
      await delay(150);
    }
    return false;
  };

  test("the agents' editor is downloaded by Start (the Office page's route), and the project's agent has its tools", { timeout: 900_000 }, async () => {
    assert.equal((await json(`${at}/container/start`, { method: "POST" })).status, 200);
    let agent = (await json(`${at}/state`)).body.agent;
    for (let i = 0; i < 900 && !agent.present && !agent.pull?.error; i++) {
      await delay(1000);
      agent = (await json(`${at}/state`)).body.agent;
    }
    assert.equal(agent.present, true, JSON.stringify(agent));
    db.createSession({ id: chatId, title: chatId, workspace: project, executor: "host", kind: "task" });
    for (const { factory } of host.hostExtensions(chatId)) factory({ registerTool: (t: { name: string }) => (tools[t.name] = t as never), on() {}, registerCommand() {}, events: { on: () => () => {} } });
    assert.ok(tools.office_edit);
  });


  test("dev: office_format in the real editor", { timeout: 900_000 }, async () => {
    const doc = await agentDoc("Dev format", "word");
    const call = async (name: string, params: Record<string, unknown>) => {
      try {
        const r = await tools[name].execute(`d-${Math.random()}`, { id: doc, ...params });
        return r.content.map((c: any) => c.text ?? `[${c.type}]`).join("\n");
      } catch (e) {
        return `THROWN ${(e as Error).message}`;
      }
    };
    const steps: [string, Record<string, unknown>][] = JSON.parse(readFileSync(process.env.DEV_STEPS!, "utf8"));
    let person: any = null;
    for (const [name, params] of steps) {
      if (name === "person") {
        person = await personOpens(doc);
        continue;
      }
      if (name === "personLook") {
        const got = await person.frame.evaluate(`(function () { var e = window.Asc.editor; e.asc_EditSelectAll(); var out = { methods: Object.keys(Object.getPrototypeOf(e)).filter(function (k) { return /pluginMethod_GetSelected|GetSelectedContent|ToJSON|Html/i.test(k); }) }; try { out.html = e.pluginMethod_GetSelectedContent ? e.pluginMethod_GetSelectedContent({ type: "html" }) : null; } catch (x) { out.err = String(x); } return out; })()`);
        console.log(`DEV personLook => ${JSON.stringify(got).slice(0, 6000)}`);
        continue;
      }
      console.log(`DEV ${name} ${JSON.stringify(params).slice(0, 300)}\n=> ${await call(name, params)}`);
    }
    for (const part of ["word/document.xml", "word/styles.xml", "word/numbering.xml", "word/footnotes.xml", "word/header1.xml", "word/footer1.xml"]) {
      try {
        writeFileSync(path.join(process.env.DEV_OUT!, part.replace(/\//g, "_")), await partOf(doc, part));
      } catch {}
    }
  });
}
