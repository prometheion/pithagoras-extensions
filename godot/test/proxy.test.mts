import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import express from "express";
import { proxyUi, uiUpgrade, writesFromHere } from "../../shared/proxy.ts";

/**
 * What the viewer asks of the server, through the portal at /api/x/pithagoras-godot/ui/: the portal's cookie and the
 * page's own credentials left out, the server's token added, writes only from the portal's own page, the answers framed
 * only by the portal, run as no page of the portal's and never setting a cookie on its origin, the viewer the
 * extension's own, and the stream's WebSocket passed on both ways. That the portal asks for its sign-in first, of every
 * request and stream under /api/x, is core's (its own tests).
 */

const seen = { requests: [] as { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[], upgrades: [] as { url?: string; headers: http.IncomingHttpHeaders }[], received: "", mode: "accept" as "accept" | "refuse" };
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "text/plain", "set-cookie": "selkies=1; Path=/", ...(req.url?.startsWith("/own-policy") ? { "content-security-policy": "default-src 'self'" } : {}) });
    res.end("the editor");
  });
});
const streams: import("node:stream").Duplex[] = [];
upstream.on("upgrade", (req, socket, head) => {
  streams.push(socket);
  seen.upgrades.push({ url: req.url, headers: req.headers });
  socket.on("error", () => {});
  if (seen.mode === "refuse") return void socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
  seen.received = head.toString();
  socket.on("data", (d) => (seen.received += d));
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello from the stream");
});
upstream.listen(0, "127.0.0.1");
await new Promise((resolve) => upstream.once("listening", resolve));
let port = (upstream.address() as AddressInfo).port;
/** Where the portal reaches the server, as Docker for extensions' reach gives it; or, while `unreachable`, its refusal. */
let unreachable = false;

const options = { upstream: async () => (unreachable ? Promise.reject(new Error("There is no network pithagoras-godot-net")) : { host: "127.0.0.1", port }), token: () => "server-token", page: Buffer.from("<p>the extension's viewer</p>"), notAnswering: "Godot antwortet nicht. / Godot is not answering." };
const ui = proxyUi(options);
const stream = uiUpgrade(options);
// Mounted as the portal mounts an extension's routes: /api/x/<package>, then the router's /ui.
const router = express.Router();
router.use(writesFromHere);
router.use("/ui", ui);
const app = express().use("/api/x/pithagoras-godot", router);
const portal = http.createServer(app);
// Core checks the sign-in and the page, strips /api/x/<package>, and hands the stream to the extension's handler.
portal.on("upgrade", (req, socket, head) => {
  req.url = req.url!.replace(/^\/api\/x\/pithagoras-godot/, "");
  stream(req, socket, head);
});
portal.listen(0, "127.0.0.1");
await new Promise((resolve) => portal.once("listening", resolve));
const portalPort = (portal.address() as AddressInfo).port;
const at = `http://127.0.0.1:${portalPort}/api/x/pithagoras-godot`;
after(() => {
  // What the tests leave open: the streams the stand-in took, and the proxy's kept connections to it.
  for (const s of streams) s.destroy();
  http.globalAgent.destroy();
  portal.closeAllConnections();
  upstream.closeAllConnections();
  portal.close();
  upstream.close();
});

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`never: ${what}`);
};

test("a page goes on without the portal's cookie, the page's credentials or where it came from, and with the server's token", async () => {
  seen.requests.length = 0;
  const page = await fetch(`${at}/ui/api/state?x=1`, { headers: { cookie: "pithagoras=signed-in", authorization: "Basic c29tZW9uZQ==", referer: "http://elsewhere/" } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "the editor");
  const [asked] = seen.requests;
  assert.equal(asked.url, "/api/state?x=1");
  assert.equal(asked.headers.authorization, "Bearer server-token");
  assert.equal(asked.headers.cookie, undefined);
  assert.equal(asked.headers.referer, undefined);
  assert.equal(asked.headers.host, `127.0.0.1:${port}`);
});

test("the viewer is the extension's; every answer of the server's is framed only by the portal, runs as no page of it, and sets no cookie", async () => {
  const before = seen.requests.length;
  const viewer = await fetch(`${at}/ui/`);
  assert.equal(await viewer.text(), "<p>the extension's viewer</p>");
  assert.equal(viewer.headers.get("content-security-policy"), "frame-ancestors 'self'");
  assert.equal(seen.requests.length, before, "the server is not asked for it");
  const answer = await fetch(`${at}/ui/api/state`);
  assert.equal(answer.headers.get("set-cookie"), null, "an answer is the portal's origin's: a cookie from the container would sit beside the portal's own");
  assert.equal(answer.headers.get("content-security-policy"), "frame-ancestors 'self', sandbox");
  assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
  const own = await fetch(`${at}/ui/own-policy`);
  assert.equal(own.headers.get("content-security-policy"), "default-src 'self', frame-ancestors 'self', sandbox");
  const file = await fetch(`${at}/ui/files/renders/game/1/movie.mp4`);
  assert.equal(file.headers.get("content-security-policy"), "frame-ancestors 'self', sandbox");
});

test("/ui is /ui/, as the pages load what they need from where they are", async () => {
  const answer = await fetch(`${at}/ui?lang=de`, { redirect: "manual" });
  assert.equal(answer.status, 302);
  assert.equal(answer.headers.get("location"), "ui/?lang=de");
});

test("a write from another page is refused; one from the portal's own, by Origin or by Sec-Fetch-Site, goes on", async () => {
  seen.requests.length = 0;
  const post = (headers: Record<string, string>) => fetch(`${at}/ui/api/projects/open`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: '{"name":"demo"}' });
  for (const headers of [{ origin: "http://127.0.0.1:3000" }, { origin: "http://evil.test" }, { "sec-fetch-site": "same-site" }, {}]) {
    const refused = await post(headers);
    assert.equal(refused.status, 403, JSON.stringify(headers));
    assert.equal((await refused.json()).error, "Only the portal's own pages may change this.");
  }
  assert.equal(seen.requests.length, 0, "nothing reached the server");
  assert.equal((await post({ origin: `http://127.0.0.1:${portalPort}` })).status, 200);
  assert.equal((await post({ "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal((await post({ origin: "https://portal.example", "x-forwarded-host": "portal.example" })).status, 200, "behind a proxy that rewrites Host");
  assert.equal(seen.requests.at(-1)!.body, '{"name":"demo"}', "the body goes on as it came");
  assert.equal(seen.requests.at(-1)!.headers.origin, undefined);
});

function upgrade(url: string, headers: Record<string, string> = {}, first = "") {
  const socket = net.connect(portalPort, "127.0.0.1");
  let text = "";
  socket.on("data", (d) => (text += d));
  socket.on("error", () => {});
  const lines = [`GET /api/x/pithagoras-godot${url} HTTP/1.1`, `Host: 127.0.0.1:${portalPort}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  socket.write(`${lines.join("\r\n")}\r\n\r\n${first}`);
  return { socket, text: () => text, closed: new Promise((resolve) => socket.once("close", resolve)) };
}

test("the stream is passed on both ways, without its Origin, with the server's token", async () => {
  seen.upgrades.length = 0;
  seen.mode = "accept";
  const mine = upgrade("/ui/stream/api/websockets", { Origin: `http://127.0.0.1:${portalPort}`, Cookie: "pithagoras=signed-in" }, "from-the-page");
  await until(() => mine.text().includes("hello from the stream"), "the stream's first bytes reaching the page");
  assert.match(mine.text(), /^HTTP\/1\.1 101 /);
  await until(() => seen.received.includes("from-the-page"), "the page's first bytes reaching the stream");
  const [asked] = seen.upgrades;
  assert.equal(asked.url, "/stream/api/websockets");
  assert.equal(asked.headers.origin, undefined, "the stream server would refuse an Origin that is not its own host");
  assert.equal(asked.headers.cookie, undefined);
  assert.equal(asked.headers.authorization, "Bearer server-token");
  mine.socket.destroy();
});

test("a stream the server refuses is refused with its status; one not under /ui is not the server's", async () => {
  seen.mode = "refuse";
  const refused = upgrade("/ui/stream/api/websockets");
  await refused.closed;
  assert.match(refused.text(), /^HTTP\/1\.1 401 /);
  seen.mode = "accept";
  const before = seen.upgrades.length;
  const other = upgrade("/state");
  await other.closed;
  assert.match(other.text(), /^HTTP\/1\.1 404 /);
  assert.equal(seen.upgrades.length, before, "nothing went to the server");
});

test("a server that does not answer is said, in both languages", async () => {
  const was = port;
  port = 1;
  try {
    const page = await fetch(`${at}/ui/api/state`);
    assert.equal(page.status, 502);
    assert.equal(await page.text(), "Godot antwortet nicht. / Godot is not answering.");
  } finally {
    port = was;
  }
});

test("where no way to the server can be given, a page is said not to answer and a stream is closed", async () => {
  unreachable = true;
  try {
    const page = await fetch(`${at}/ui/api/state`);
    assert.equal(page.status, 502);
    assert.equal(await page.text(), "Godot antwortet nicht. / Godot is not answering.");
    const before = seen.upgrades.length;
    const stream = upgrade("/ui/stream/api/websockets");
    await stream.closed;
    assert.equal(stream.text(), "", "closed without an answer");
    assert.equal(seen.upgrades.length, before);
  } finally {
    unreachable = false;
  }
});
