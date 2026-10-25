import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
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
  c.events = { onDocumentReady: () => __events.push(["ready"]), onError: (e) => __events.push(["error", e.data]), onWarning: (e) => __events.push(["warning", e.data]) };
  window.__editor = new DocsAPI.DocEditor("ph", c);
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
    await json(`${at}/container/remove`, { method: "POST", body: JSON.stringify({ data: true }) }).catch(() => {});
    await host.stopServerHalves();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // What Docker for extensions made for the way in goes with the network; anything a failed run left, by name.
    for (const name of [`${PREFIX}-portal`, `${PREFIX}-relay`, `${PREFIX}-relay-forward`, PREFIX]) execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  });

  test("the Document Server, its relays and its network come up through Docker for extensions, and it answers through the way in", { timeout: 600_000 }, async () => {
    await host.syncServerHalves([half(path.join(PITHAGORAS, "extensions/docker"), "src/server.ts"), half(PACKAGE, "src/server.ts")]);
    assert.equal(host.serverFailure("@pithagoras/office"), undefined);
    let answer = "";
    for (let i = 0; i < 300 && answer !== "true"; i++) {
      await delay(2000);
      answer = await fetch(`${at}/ds/healthcheck`).then((r) => (r.ok ? r.text() : ""), () => "");
    }
    assert.equal(answer, "true", "the Document Server answers its health check through the relay");
    const inspect = (name: string) => JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8" }))[0];
    assert.equal(inspect(PREFIX).HostConfig.NetworkMode, `${PREFIX}-net`);
    assert.deepEqual(inspect(PREFIX).HostConfig.PortBindings ?? {}, {}, "nothing of the Document Server's is published");
    assert.equal(inspect(`${PREFIX}-portal`).HostConfig.NetworkMode, "host");
    const net = JSON.parse(execFileSync("docker", ["network", "inspect", `${PREFIX}-net`], { encoding: "utf8" }))[0];
    assert.equal(net.Internal, true);
  });

  test("a document opens in the editor, takes what is typed, and the save lands in the file", { timeout: 600_000 }, async () => {
    const made = await json(`${at}/documents`, { method: "POST", body: JSON.stringify({ title: "End to end", type: "word" }) });
    assert.equal(made.status, 201);
    const doc = made.body as { docId: string };
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const failed: string[] = [];
      page.on("requestfailed", (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
      await page.goto(`${origin}/editor.html?doc=${encodeURIComponent(doc.docId)}`);
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
      await page.keyboard.type("Typed end to end", { delay: 30 });
      await delay(3000);
      await page.evaluate(() => (window as unknown as { __editor: { destroyEditor(): void } }).__editor.destroyEditor());
      const file = (await json(`${at}/state`)).body.docs.find((d: { docId: string }) => d.docId === doc.docId);
      const onDisk = path.join(data, "docs", doc.docId, `${file.title}.docx`);
      let text = "";
      for (let i = 0; i < 90 && !text.includes("Typed end to end"); i++) {
        await delay(1000);
        text = parseDocx(readFileSync(onDisk)).text;
      }
      assert.match(text, /Typed end to end/, "the Document Server's save was taken and written to the file");
      assert.deepEqual((await json(`${at}/state`)).body.locks[doc.docId], [], "nobody is in it once it closed");
      assert.equal(await info(), 1, "and that none is open once it closed");
    } finally {
      await browser.close();
    }
  });
}
