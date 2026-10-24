import http from "node:http";
import type { Duplex } from "node:stream";
import type { NextFunction, Request, Response } from "express";

/**
 * The viewer beside a chat, served through the portal at /api/x/<package>/ui/…, behind the portal's sign-in: the
 * extension's own page, and what the server answers it (its API, the files it serves, and for Godot its stream).
 *
 * Why a proxy and not a link to the server's port: the server binds the portal's loopback alone, so nothing else can
 * reach it, and the person never signs in to it. The portal decides who they are before anything is proxied (every
 * route under /api/x is behind its sign-in, and core checks a stream's sign-in and origin before it is handed over),
 * and the proxy adds the server's token on the way. The container is never given the portal's cookie, or anything the
 * page sent as a credential. Browser's proxy works the same way.
 *
 * What is served here is on the portal's own origin, where a script could call the portal's API as the person. The
 * server runs code the agent writes, in the very process that answers here, so what it answers is never let run
 * there: the page at /ui/ is the extension's own (`page`), from its package, and every answer of the server's is
 * sandboxed (`answered`), so that one opened as a page of its own runs no script, in an origin of its own, with no way
 * to the portal's. The extension's page reads the server's answers as data, and puts nothing of them into the page unescaped.
 */

export interface ProxyOptions {
  /** The server's port on the portal's loopback. */
  port: () => number;
  /** The server's token, sent as `Authorization: Bearer`. */
  token: () => string;
  /** The extension's own page, served at /ui/ in place of anything the server would answer there. */
  page: Buffer;
  /** What a refused connection says: "Blender antwortet nicht. / Blender is not answering." */
  notAnswering: string;
}

const UPSTREAM_HOST = "127.0.0.1";

/** What is never sent on to the server: the portal's cookie, any credential the page sent, and where the request came from. */
const DROPPED = new Set(["cookie", "authorization", "origin", "referer", "host"]);

/** The request's headers as they go on to the server: as they came, without what is dropped, with the server's host and token. */
export function forwarded(headers: http.IncomingHttpHeaders, options: ProxyOptions): http.OutgoingHttpHeaders {
  const kept: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) if (!DROPPED.has(name) && value !== undefined) kept[name] = value;
  return { ...kept, host: `${UPSTREAM_HOST}:${options.port()}`, authorization: `Bearer ${options.token()}` };
}

const FRAME_ANCESTORS = "frame-ancestors 'self'";

/**
 * What the server answered, with what it does not say for itself: only the portal's own pages may frame it, a browser
 * takes each answer as the type it says it is, and nothing of it runs on the portal's origin (`sandbox`): an answer
 * opened as a page of its own runs no script, in an origin of its own. Each policy is added to one of the server's own as a
 * second one, so that both apply. A cookie is never passed on: the answer is the portal's origin's, where a cookie
 * would sit beside the portal's own, and the servers have none to set.
 */
export function answered(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const { "set-cookie": _cookie, ...rest } = headers;
  const own = rest["content-security-policy"];
  const ours = `${FRAME_ANCESTORS}, sandbox`;
  return { ...rest, "content-security-policy": own ? `${own}, ${ours}` : ours, "x-content-type-options": "nosniff" };
}

/** The extension's own page, as it is sent: framed only by the portal's pages, taken as HTML, asked for anew each time. */
const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "content-security-policy": FRAME_ANCESTORS, "x-content-type-options": "nosniff", "cache-control": "no-cache" };

/**
 * Is this request from one of the portal's own pages? Its `Origin` names the host it was made to (`Host`, or the
 * first `X-Forwarded-Host` behind a reverse proxy that rewrites Host, which a page cannot set), as core decides for a
 * stream; or, with no `Origin`, the browser says it is from the same origin (`Sec-Fetch-Site`).
 */
export function fromHere(headers: http.IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  if (!origin) return headers["sec-fetch-site"] === "same-origin";
  const forwardedHost = headers["x-forwarded-host"];
  const first = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(",")[0]?.trim();
  return [headers.host, first].some((host) => !!host && sameHost(origin, host));
}

/** Is `origin` the page of `host`, an address with or without the port its scheme implies? */
function sameHost(origin: string, host: string): boolean {
  // Only an address: anything a URL would read as a user name or a path is not one.
  if (!/^[^\s/@?#\\]+$/.test(host)) return false;
  try {
    const { protocol, host: page } = new URL(origin);
    return new URL(`${protocol}//${host}`).host === page;
  } catch {
    return false;
  }
}

/** Requests that only read: let through from anywhere the portal's sign-in lets them come. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * For the whole of an extension's routes (`portal.router.use(writesFromHere)`), before any of them: a request that is
 * not a read is refused unless it comes from the portal's own pages (`fromHere`), by the rule core holds a stream to.
 * The portal's cookie is SameSite=Lax, which a page on another port of the same address, or on another name under
 * the same site, is still sent; and these routes install, start, stop and remove the server, open projects, take
 * uploads and run code.
 */
export function writesFromHere(req: Request, res: Response, next: NextFunction): void {
  if (READS.has(req.method) || fromHere(req.headers)) return next();
  res.status(403).json({ error: "Only the portal's own pages may change this." });
}

/**
 * The route half, for every method under /ui (`portal.router.use("/ui", proxyUi(…))`). Express strips the mount
 * path, so `req.url` is already the server's own. /ui/ itself is the extension's page; everything else is the
 * server's. Bodies are piped as they come (the portal reads none for an extension's routes), so an upload of a
 * project and a picture of the viewport pass untouched.
 */
export function proxyUi(options: ProxyOptions) {
  return (req: Request, res: Response): void => {
    // The page loads what it needs relative to where it is, so it is at /ui/, with the slash.
    const [pathname, ...query] = req.originalUrl.split("?");
    if (req.path === "/" && !pathname.endsWith("/")) {
      res.redirect(`ui/${query.length ? `?${query.join("?")}` : ""}`);
      return;
    }
    if (req.path === "/" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { ...PAGE_HEADERS, "content-length": options.page.length });
      res.end(options.page);
      return;
    }
    const path = req.url || "/";
    const proxied = http.request(
      { host: UPSTREAM_HOST, port: options.port(), path, method: req.method, headers: forwarded(req.headers, options) },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, answered(upstream.headers));
        upstream.pipe(res);
      },
    );
    proxied.on("error", () => {
      if (res.headersSent) return void res.end();
      res.status(502).type("text/plain").end(options.notAnswering);
    });
    req.pipe(proxied);
  };
}

/**
 * An answer to a connection that is not going to become a stream, then closed. Not left open for the client to close:
 * one that never does would hold the portal's end, and a descriptor, for as long as the portal runs.
 */
function refuse(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const giveUp = setTimeout(() => socket.destroy(), 5_000);
  giveUp.unref();
  socket.once("close", () => clearTimeout(giveUp));
}

/** Where in the extension's routes the server's pages are. */
const UI = /^\/ui(?=$|[/?])/i;

/**
 * The stream half (`portal.http.upgrade(uiUpgrade(…))`), handed a WebSocket under the extension's routes once core has
 * checked its sign-in and the page it comes from. Only the streams under /ui are the server's. The upgrade request
 * goes on with the same headers a request does: without the portal's cookie and the page's `Origin` (core checked it
 * already, and a server that compares it with its own host would refuse it), with the server's token.
 */
export function uiUpgrade(options: ProxyOptions) {
  return (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!UI.test(req.url ?? "")) return refuse(socket, 404, "Not Found");
    const rest = req.url!.replace(UI, "");
    const proxied = http.request({
      host: UPSTREAM_HOST,
      port: options.port(),
      path: rest.startsWith("/") ? rest : `/${rest}`,
      method: "GET",
      headers: forwarded(req.headers, options),
    });
    proxied.end();
    // A visitor who leaves during the handshake takes the request with them.
    socket.once("close", () => proxied.destroy());
    socket.on("error", () => socket.destroy());
    proxied.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      if (socket.destroyed) return void upstreamSocket.destroy();
      const lines = Object.entries(upstreamRes.headers).map(([k, v]) => `${k}: ${v}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      // Each side's first bytes go back where they were read, and are sent on with the rest.
      if (upstreamHead?.length) upstreamSocket.unshift(upstreamHead);
      if (head?.length) socket.unshift(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      // A stream is over when either side ends it: neither is left half open, holding a descriptor.
      const close = () => {
        upstreamSocket.destroy();
        socket.destroy();
      };
      socket.on("end", close);
      upstreamSocket.on("end", close);
      socket.on("close", close);
      upstreamSocket.on("close", close);
      socket.on("error", close);
      upstreamSocket.on("error", close);
    });
    // An answer that is not an upgrade (the server is starting, or refused it) is said to the visitor instead of
    // leaving them waiting.
    proxied.on("response", (answer) => {
      refuse(socket, answer.statusCode ?? 502, answer.statusMessage ?? "Bad Gateway");
      answer.resume();
    });
    proxied.on("error", () => socket.destroy());
  };
}
