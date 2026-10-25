import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { parseDocx } from "../../src/ooxml.ts";
import { makeKey } from "../../src/callback.ts";
import { signJwt } from "../../src/jwt.ts";

/**
 * Office end to end, against the real Document Server: its server half started by the portal's own extension host,
 * after Docker for extensions, each from its source, Docker for extensions speaking to the machine's own Docker. The
 * portal is "on the machine" (host network), so the way in is Docker for extensions' forwarder on 127.0.0.1. A
 * Chromium opens a document in the editor as the Office page does, types into it and closes it, and the text must be
 * in the file: what "Download failed", the refused key, the refused callback token and the embed viewer each broke.
 * Then once more through a reverse proxy that ends TLS and sends no forwarded headers, as a plain nginx in front does.
 *
 * Opt-in: it needs Docker Engine 28 or later, the image (about 3 GB, `onlyoffice/documentserver:10.0.0.1` unless
 * OFFICE_E2E_IMAGE names another), Chromium for Playwright, and a few minutes. Its containers, network and volumes go
 * by names of their own (`office-e2e-ds…`), and are removed at its end.
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
  const PREFIX = "office-e2e-ds";

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
  // The Office page's part that opens a document, as office-editor.tsx does it: the config from the server half,
  // api.js through the /ds proxy, and the editor, with what it says kept for the test.
  app.get("/editor.html", (req: { query: { doc: string } }, res: { type: (t: string) => { send: (b: string) => void } }) =>
    res.type("html").send(`<!doctype html><html><body style="margin:0"><div id="ph"></div><script>
window.__events = [];
(async () => {
  const r = await fetch("/api/x/%40pithagoras/office/editor-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: ${JSON.stringify(req.query.doc)} }) });
  const cfg = await r.json();
  if (!r.ok) { __events.push(["refused", cfg]); return; }
  await new Promise((ok, no) => { const s = document.createElement("script"); s.src = cfg.apiJs; s.onload = ok; s.onerror = () => no(new Error("api.js")); document.head.appendChild(s); });
  const c = { ...cfg, width: "100%", height: "700px" };
  delete c.apiJs;
  // As the Office page: every second it asks how its key stands, and loads the agent's revision with the editor's own
  // refreshFile when it is told to follow (and when the editor asks for it).
  window.__key = c.document.key;
  const reload = async () => {
    const r2 = await fetch("/api/x/%40pithagoras/office/editor-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: ${JSON.stringify(req.query.doc)} }) });
    const next = await r2.json();
    delete next.apiJs;
    __events.push(["refresh", next.document.key]);
    window.__editor.refreshFile(next);
    window.__key = next.document.key;
  };
  c.events = { onDocumentReady: () => __events.push(["ready"]), onError: (e) => __events.push(["error", e.data]), onWarning: (e) => __events.push(["warning", e.data]), onRequestRefreshFile: () => { __events.push(["asked to refresh"]); void reload(); } };
  window.__editor = new DocsAPI.DocEditor("ph", c);
  setInterval(async () => {
    const r3 = await fetch("/api/x/%40pithagoras/office/editor-state?doc=" + encodeURIComponent(${JSON.stringify(req.query.doc)}) + "&key=" + encodeURIComponent(window.__key));
    const standing = (await r3.json()).standing;
    if (standing !== "current") __events.push(["standing", standing]);
    if (standing === "follow") await reload();
  }, 1000);
})().catch((e) => __events.push(["exception", String(e)]));
</script></body></html>`),
  );
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const at = `${origin}/api/x/%40pithagoras/office`;
  const json = async (url: string, init?: RequestInit) => {
    const answer = await fetch(url, { ...init, headers: { "content-type": "application/json", origin, ...init?.headers } });
    return { status: answer.status, body: await answer.json() };
  };

  after(async () => {
    // OFFICE_E2E_KEEP=1 leaves the containers for a look at the Document Server's logs; `docker rm -f` them after.
    const keep = process.env.OFFICE_E2E_KEEP === "1";
    if (!keep) await json(`${at}/container/remove`, { method: "POST", body: JSON.stringify({ data: true }) }).catch(() => {});
    await host.stopServerHalves();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (keep) return;
    // What Docker for extensions made for the way in goes with the network; anything a failed run left, by name.
    for (const name of [`${PREFIX}-relay`, `${PREFIX}-relay-forward`, PREFIX]) execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
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
  async function openTypeSave(pageOrigin: string, title: string, typed: string): Promise<void> {
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

      // What office_edit asks after a restart of the half (server.ts sessionOpen): the Document Server's own `info`
      // for the document's key answers 0 while the session is open.
      const info = async () => {
        const secret = readFileSync(path.join(data, "jwt-secret"), "utf8").trim();
        const meta = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === doc.docId);
        const body = { c: "info", key: makeKey(doc.docId, meta.mtimeMs) };
        const answer = await fetch(`http://127.0.0.1:${process.env.PITHAGORAS_OFFICE_PORT}/command`, { method: "POST", headers: { "content-type": "application/json", "X-Auth-Token": `Bearer ${signJwt(body, 60_000, secret)}` }, body: JSON.stringify(body) });
        return ((await answer.json()) as { error: number }).error;
      };
      assert.equal(await info(), 0, "the Document Server says the session is open");

      await frame.locator("#editor_sdk").click({ position: { x: 300, y: 150 } });
      await page.keyboard.type(typed, { delay: 30 });
      await delay(3000);
      await page.evaluate(() => (window as unknown as { __editor: { destroyEditor(): void } }).__editor.destroyEditor());
      const file = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === doc.docId);
      const onDisk = path.join(data, "docs", doc.docId, `${file.title}.docx`);
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
    await openTypeSave(origin, "End to end", "Typed end to end");
  });

  test("an agent's edit of a document open in the editor: the editor saves what is typed first, the edit lands on top of it, and the editor loads it in place", { timeout: 600_000 }, async () => {
    const project = path.join(process.env.WORKSPACE_ROOT!, "acme");
    mkdirSync(project, { recursive: true });
    const chatId = `office-e2e-${Math.random().toString(36).slice(2)}`;
    db.createSession({ id: chatId, title: chatId, workspace: project, executor: "host", kind: "task" });
    const tools: Record<string, { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> }> = {};
    for (const { factory } of host.hostExtensions(chatId)) factory({ registerTool: (t: { name: string }) => (tools[t.name] = t as never), on() {}, registerCommand() {}, events: { on: () => () => {} } });
    const made = await tools.office_create.execute("c1", { title: "Agent and person", type: "word" });
    const docId = String(made.details.id);
    const onDisk = async () => {
      const file = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === docId);
      return parseDocx(readFileSync(path.join(data, "docs", docId, `${file.title}.docx`))).text;
    };
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${origin}/editor.html?doc=${encodeURIComponent(docId)}`);
      const events = () => page.evaluate(() => (window as unknown as { __events: unknown[][] }).__events);
      for (let i = 0; i < 120 && !(await events()).some((e) => e[0] === "ready"); i++) await delay(1000);
      assert.ok((await events()).some((e) => e[0] === "ready"), JSON.stringify(await events()));
      const frame = page.frames().find((f) => /documenteditor\/main\//.test(f.url()))!;
      for (let i = 0; i < 30 && !(await json(`${at}/state`)).body.locks[docId].length; i++) await delay(1000);
      const firstKey = await page.evaluate(() => (window as unknown as { __key: string }).__key);

      // The person types; nothing of it is on disk yet.
      await frame.locator("#editor_sdk").click({ position: { x: 300, y: 150 } });
      await page.keyboard.press("Control+End");
      await page.keyboard.type(" Typed by the person", { delay: 30 });
      await delay(3000);
      assert.ok(!(await onDisk()).includes("Typed by the person"));

      // The agent edits what the person typed, on the revision it read before.
      const read = await tools.office_read.execute("r1", { id: docId });
      const started = Date.now();
      const edited = await tools.office_edit.execute("e1", { id: docId, ops: [{ quote: "Typed by the person", replacement: "Typed by the person, edited by the agent" }], baseRevision: read.details.mtimeMs });
      console.log(`office_edit on the open document took ${Date.now() - started} ms: ${edited.content[0].text}`);
      assert.equal(edited.details.action, "edit", edited.content[0].text);
      assert.match(await onDisk(), /Typed by the person, edited by the agent/, "the edit is on top of what the person typed");

      // The editor loads the new revision in place, under a new key.
      let key = firstKey;
      for (let i = 0; i < 30 && key === firstKey; i++) {
        await delay(1000);
        key = await page.evaluate(() => (window as unknown as { __key: string }).__key);
      }
      assert.notEqual(key, firstKey, `the editor followed to the agent's revision (${JSON.stringify(await events())})`);
      for (let i = 0; i < 30 && (await json(`${at}/state`)).body.locks[docId].length !== 1; i++) await delay(1000);
      await delay(8000); // the old session closes a few seconds after the editor left it
      assert.ok(!(await events()).some((e) => e[0] === "error"), JSON.stringify(await events()));

      // Typing goes on in the loaded revision, and its save lands on top of the agent's edit: the editor had it.
      await frame.locator("#editor_sdk").click({ position: { x: 300, y: 150 } });
      await page.keyboard.press("Control+End");
      await page.keyboard.type(" And more after the reload", { delay: 30 });
      await delay(3000);
      await page.evaluate(() => (window as unknown as { __editor: { destroyEditor(): void } }).__editor.destroyEditor());
      let text = "";
      for (let i = 0; i < 90 && !text.includes("And more after the reload"); i++) {
        await delay(1000);
        text = await onDisk();
      }
      assert.match(text, /Typed by the person, edited by the agent/);
      assert.match(text, /And more after the reload/);
      const titles = (await json(`${at}/state`)).body.docs.map((d: { title: string }) => d.title);
      assert.deepEqual(titles.filter((t: string) => t.startsWith("Agent and person")), ["Agent and person"], "no conflict copy: the old session's close held nothing new");
      console.log(`editor events: ${JSON.stringify(await events())}`);
    } finally {
      await browser.close();
    }
  });

  test("behind a reverse proxy that ends TLS and says nothing of it, the editor opens and saves as well", { timeout: 600_000 }, async () => {
    // A self-signed certificate for localhost, and a front that passes each request on as it came (Host kept), with no
    // X-Forwarded-* header: the portal behind it sees plain HTTP. The Document Server must still name https:// in what
    // it hands the page, or the browser refuses it as mixed content.
    const certs = mkdtempSync(path.join(os.tmpdir(), "office-e2e-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(certs, "key.pem"), "-out", path.join(certs, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    const upstream = new URL(origin);
    const front = https.createServer({ key: readFileSync(path.join(certs, "key.pem")), cert: readFileSync(path.join(certs, "cert.pem")) }, (req, res) => {
      const on = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      on.on("error", () => res.destroy());
      req.pipe(on);
    });
    front.listen(0, "127.0.0.1");
    await once(front, "listening");
    try {
      await openTypeSave(`https://localhost:${(front.address() as AddressInfo).port}`, "Behind TLS", "Typed behind a proxy");
    } finally {
      front.closeAllConnections();
      await new Promise((resolve) => front.close(resolve));
      rmSync(certs, { recursive: true, force: true });
    }
  });
}
