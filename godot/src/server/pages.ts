import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

/**
 * Selkies' web client at /ui/stream/, the stream page the viewer frames: the extension's own copy, from its package
 * (pages/stream), as Selkies 2.1.0 has it (the image's build stops unless the image's Selkies has the same:
 * server/selkies-web.sha256), with the shim its page loads first (`__gs_shim.js`). Mounted before the proxy
 * (`portal.router.use("/ui", stream(…))`), which serves the viewer itself at /ui/ (its `page`): what is not one of
 * these files goes on to the server, whose answers are its API, its files and the stream's WebSocket.
 *
 * Why it is not the server's: the server runs the editor, and the editor runs the agent's code. A page it served
 * would run on the portal's origin, where a script can call the portal's API as the person; the proxy sandboxes every
 * answer of the server's, which a stream page from there could not play in.
 */

/** As every file here is sent: framed by the portal's own pages alone, taken as the type it says it is, asked for anew each time. */
const HEADERS = { "content-security-policy": "frame-ancestors 'self'", "x-content-type-options": "nosniff", "cache-control": "no-cache" };

export function stream(dir: string) {
  const folder = path.join(dir, "stream");
  // Every file of the client, by its path under /ui/stream/: nothing else under it is served from here.
  const files = new Set(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== "LICENSE")
      .map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")),
  );
  // The client's page, with the shim loaded before anything of the client.
  const index = readFileSync(path.join(folder, "index.html"), "utf8").replace("<head>", '<head><script src="__gs_shim.js"></script>');

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path === "/stream/" || req.path === "/stream/index.html") return void res.set(HEADERS).type("html").send(index);
    const file = req.path.startsWith("/stream/") ? req.path.slice("/stream/".length) : "";
    // Sent from the folder (`root`), as send refuses a path with a dot folder in it: an npm install is under ~/.pi.
    if (files.has(file)) return res.sendFile(file, { root: folder, headers: HEADERS });
    next();
  };
}
