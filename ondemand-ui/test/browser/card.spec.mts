import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import express from "express";
import { expect, test, type Frame, type Page } from "@playwright/test";
import ondemandUi from "../../src/server.ts";

/**
 * A card as a browser draws it: a page served with the portal's own policy (its script from its origin, nothing
 * inline), the card host of the browser half (src/web/host.ts) in it, and the server half's routes on the same origin,
 * so the card's frame is the one the extension serves. A second server on another port stands for anywhere else.
 */

const PORTAL_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' https: http:; frame-ancestors 'self'; form-action 'self'";
const EXT = "/api/x/@pithagoras/ondemand-ui";

let server: http.Server;
let elsewhere: http.Server;
let origin: string;
let away: string;
let dataDir: string;
/** What reached the other server, and the events the page posted to the route. */
const reached: string[] = [];
const posted: { body: { event: string; data: unknown }; at: number }[] = [];

const THEME = { mode: "dark", colors: { canvas: "10 10 12", surface: "20 20 23", raised: "32 32 36", line: "44 44 50", fg: "1 2 3", "fg-muted": "185 185 195", accent: "34 211 238", "accent-fg": "10 10 12" } };

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "odui-browser-"));
  const factories: ((pi: any, chat: any) => void)[] = [];
  const portal = {
    version: 1,
    extension: "@pithagoras/ondemand-ui",
    executor: "host",
    log: () => {},
    router: express.Router(),
    http: { json: express.json },
    dataDir: () => dataDir,
    chats: {
      get: (id: string) => (id === "a" ? { id, title: "A chat", workspace: "/nowhere", status: "idle" } : undefined),
      send: () => {},
      onOpen: () => {},
      onEvent: () => {},
      on: () => {},
      extend: (factory: (pi: any, chat: any) => void) => void factories.push(factory),
      tell: async () => false,
    },
  };
  ondemandUi(portal as any);
  const tools = new Map<string, any>();
  for (const factory of factories) factory({ registerTool: (t: any) => tools.set(t.name, t), on: () => {}, events: { on: () => {} } }, { id: "a" });

  elsewhere = http.createServer((req, res) => {
    reached.push(String(req.url));
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("here");
  });
  await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
  away = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`;

  const card = `
    <h3>Pick</h3><div id="box" style="height:40px"></div>
    <button id="grow">Grow</button> <button id="send" class="primary">Send</button>
    <script>
      document.getElementById("grow").onclick = () => { document.getElementById("box").style.height = "900px"; };
      document.getElementById("send").onclick = () => {
        for (let i = 1; i <= 5; i++) pithagoras.emit("change", { i });
        pithagoras.emit("other", 1);
      };
      window.tryFetch = () => fetch("AWAY_ORIGIN/fetch").then(() => "loaded", () => "blocked");
      window.tryImage = () => new Promise((done) => { const img = new Image(); img.onload = () => done("loaded"); img.onerror = () => done("blocked"); img.src = "AWAY_ORIGIN/image.png"; });
      window.got = []; pithagoras.onData((v) => window.got.push(v));
    </script>`;
  await tools.get("ui_show").execute("call-1", { title: "Pick", html: card, events: { change: { debounceMs: 300 } } });

  const hostJs = (await build({ entryPoints: [path.resolve(import.meta.dirname, "../../src/web/host.ts")], bundle: true, format: "iife", globalName: "Odui", write: false, target: "es2022" })).outputFiles[0].text;
  const pageJs = `
    window.statuses = [];
    const theme = ${JSON.stringify(THEME)};
    window.host = new Odui.CardHost(document.getElementById("card"), {
      title: "Pick", events: { change: { debounceMs: 300, wake: false } }, defaultDebounceMs: 400, maxHeight: 300, fill: false, open: true,
      src: (nonce) => "${EXT}/frame/a/c1?" + new URLSearchParams({ n: nonce, o: location.origin, lang: "en", theme: JSON.stringify(theme) }),
      theme: () => window.theme ?? theme,
      send: (event, data) => fetch("${EXT}/chats/a/cards/c1/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event, data }) })
        .then(async (r) => { if (!r.ok) throw Object.assign(new Error("refused"), { status: r.status }); return (await r.json()).delivery; }),
      onStatus: (s) => window.statuses.push(s),
    });`;

  const app = express();
  app.use((req, res, next) => {
    if (req.method === "POST" && req.path.endsWith("/events")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        posted.push({ body: JSON.parse(body), at: Date.now() });
        res.json({ delivery: "queued" });
      });
      return;
    }
    next();
  });
  // The card's HTML names the other server only once it is known: swapped in as the frame is served.
  app.use(`${EXT}/frame`, (req, res, next) => {
    const end = res.end.bind(res);
    (res as any).end = (chunk: any, ...rest: any[]) => end(typeof chunk === "string" ? chunk.replaceAll("AWAY_ORIGIN", away) : chunk, ...rest);
    next();
  });
  app.use(EXT, portal.router);
  app.get("/portal", (_req, res) => {
    res.set("content-security-policy", PORTAL_POLICY);
    res.type("html").send(`<!doctype html><html data-theme="dark"><head><style>.odui-frame{display:block;width:100%;border:0}</style><script src="/host.js"></script></head><body><div id="card" style="width:480px"></div><script src="/page.js"></script></body></html>`);
  });
  app.get("/host.js", (_req, res) => void res.type("js").send(hostJs));
  app.get("/page.js", (_req, res) => void res.type("js").send(pageJs));
  // Another window of the page, not the card's, that knows the card's nonce.
  app.get("/stranger", (req, res) => {
    res.type("html").send(`<script>parent.postMessage({ pithagoras: 1, nonce: ${JSON.stringify(String(req.query.n))}, type: "emit", name: "change", json: "{\\"i\\":99}" }, "*");</script>`);
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  server?.closeAllConnections();
  elsewhere?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  await new Promise((resolve) => elsewhere?.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  reached.length = 0;
  posted.length = 0;
});

/** The card's own frame: inside the extension's frame, inside the page. */
async function cardFrame(page: Page): Promise<Frame> {
  await page.goto(`${origin}/portal`);
  let found: Frame | undefined;
  await expect.poll(async () => {
    found = page.frames().find((f) => f.url() === "about:srcdoc");
    return found ? await found.evaluate(() => typeof (window as any).pithagoras).catch(() => "") : "";
  }).toBe("object");
  return found!;
}

const frameHeight = (page: Page) => page.evaluate(() => (document.querySelector("iframe.odui-frame") as HTMLIFrameElement).getBoundingClientRect().height);

test("the card is drawn with the portal's colours, follows a change of them, and is as tall as it is up to the highest", async ({ page }) => {
  const card = await cardFrame(page);
  await expect(card.locator("h3")).toHaveText("Pick");
  expect(await card.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--fg").trim())).toBe("rgb(1 2 3)");
  expect(await card.evaluate(() => getComputedStyle(document.body).color)).toMatch(/^rgb\(1,? 2,? 3\)$/);
  expect(await card.evaluate(() => (window as any).pithagoras.theme.mode)).toBe("dark");

  await page.evaluate(() => {
    (window as any).theme = { mode: "light", colors: { fg: "9 8 7", surface: "255 255 255" } };
    (window as any).host.setTheme((window as any).theme);
  });
  await expect.poll(() => card.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--fg").trim())).toBe("rgb(9 8 7)");

  await expect.poll(() => frameHeight(page)).toBeLessThan(300);
  const short = await frameHeight(page);
  expect(short).toBeGreaterThan(60);
  await card.locator("#grow").click();
  await expect.poll(() => frameHeight(page)).toBe(300);
  expect(await card.evaluate(() => document.scrollingElement!.scrollHeight > window.innerHeight)).toBe(true);
});

test("the card reaches no other server: a fetch and a picture from elsewhere are refused", async ({ page }) => {
  const card = await cardFrame(page);
  expect(await card.evaluate(() => (window as any).tryFetch())).toBe("blocked");
  expect(await card.evaluate(() => (window as any).tryImage())).toBe("blocked");
  await page.waitForTimeout(300);
  expect(reached).toEqual([]);
});

test("what the card emits is sent once the person has been in it, debounced, and only for its declared events", async ({ page }) => {
  const card = await cardFrame(page);
  // Before the person has touched the card, nothing it emits is sent.
  await card.evaluate(() => (window as any).pithagoras.emit("change", { i: 0 }));
  await page.waitForTimeout(700);
  expect(posted).toEqual([]);

  const clicked = Date.now();
  await card.locator("#send").click();
  await expect.poll(() => posted.length).toBe(1);
  await page.waitForTimeout(500);
  expect(posted.map((p) => p.body)).toEqual([{ event: "change", data: { i: 5 } }]);
  expect(posted[0].at - clicked).toBeGreaterThanOrEqual(250);
  expect(await page.evaluate(() => (window as any).statuses)).toEqual([{ kind: "sent", delivery: "queued" }]);
});

test("messages from any window but the card's are not taken, whatever they say", async ({ page }) => {
  const card = await cardFrame(page);
  await card.locator("h3").click();
  const nonce = await page.evaluate(() => new URL((document.querySelector("iframe.odui-frame") as HTMLIFrameElement).src).searchParams.get("n"));
  // The page itself, and a frame of its own that is not the card, each with the card's nonce.
  await page.evaluate((n) => window.postMessage({ pithagoras: 1, nonce: n, type: "emit", name: "change", json: '{"i":98}' }, "*"), nonce);
  await page.evaluate((n) => {
    const f = document.createElement("iframe");
    f.src = `/stranger?n=${n}`;
    document.body.append(f);
  }, nonce);
  await page.waitForTimeout(1000);
  expect(posted).toEqual([]);
  // The card itself is still heard.
  await card.evaluate(() => (window as any).pithagoras.emit("change", { i: 7 }));
  await expect.poll(() => posted.map((p) => p.body)).toEqual([{ event: "change", data: { i: 7 } }]);
});

test("data the agent posts reaches the card's script, and a closed card takes no input and sends nothing", async ({ page }) => {
  const card = await cardFrame(page);
  await page.evaluate(() => (window as any).host.postData(1, { progress: 0.5 }));
  await expect.poll(() => card.evaluate(() => (window as any).got)).toEqual([{ progress: 0.5 }]);
  await card.locator("h3").click();
  await page.evaluate(() => (window as any).host.configure({ open: false }));
  expect(await page.evaluate(() => (document.querySelector("iframe.odui-frame") as HTMLIFrameElement).inert)).toBe(true);
  await card.evaluate(() => (window as any).pithagoras.emit("change", { i: 1 }));
  await page.waitForTimeout(700);
  expect(posted).toEqual([]);
});
