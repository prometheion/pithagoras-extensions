import { readFileSync } from "node:fs";
import path from "node:path";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { Docker } from "../../shared/docker-api";
import { mcpClient } from "../../shared/mcp";
import { proxyUi, writesFromHere } from "../../shared/proxy";
import { relay, type Bundled } from "../../shared/relay";
import { service } from "../../shared/service";
import { openStore } from "../../shared/store";
import bundled from "../server/tools.json";
import { ACTS, LABELS, PREFIX } from "./labels";
import { blenderRoutes } from "./server/routes";
import { blenderSpec, names } from "./server/spec";

/**
 * The viewer's page: the extension's own, beside this module, which the build copies from src/viewer.html to beside
 * server.js. It is the one page that runs on the portal's origin; it draws what the server answers.
 */
const VIEWER = new URL("./viewer.html", import.meta.url);

/**
 * Blender's server half: a headless Blender run in a container of its own through Docker for extensions
 * (`pithagoras-docker`, which this package requires), its MCP tools relayed as this extension's own tools in every
 * chat (shared/relay.ts), its viewer served through the portal at /api/x/pithagoras-blender/ui/ (shared/proxy.ts),
 * and the routes of its page in Settings (server/routes.ts). Every request under those routes that changes something
 * is refused unless it comes from the portal's own pages.
 *
 * Docker's server half starts before this one, and this one is started again whenever Docker is. So it starts
 * without waiting on Docker, and stops without touching the container: a start or a stop of the half is not one of
 * the server's. Its token, its card and whether there is a server are in its own folder (`portal.dataDir()`).
 */
export default function blender(portal: ServerPortal) {
  const data = portal.dataDir();
  const store = openStore(data);
  const at = names();
  const docker = () => portal.extensions.use<Docker>("pithagoras-docker")!;
  const mcp = mcpClient({ url: () => `http://127.0.0.1:${at.port}/mcp`, token: () => store.token() });
  const tools = relay({ portal, prefix: PREFIX, app: "Blender", mcp, bundled: bundled as Bundled, labels: LABELS, acts: ACTS, installedFile: path.join(data, "installed") });
  const svc = service({ portal, docker, app: "Blender", names: at, store, relay: tools, mcp, spec: (plan) => blenderSpec(plan, at.port, at.volume, at.image) });

  portal.router.use(writesFromHere);
  blenderRoutes(portal, portal.router, svc, { port: at.port, token: () => store.token() });
  // No stream to proxy: the viewer asks for each frame of the viewport with a plain request.
  portal.router.use("/ui", proxyUi({ port: () => at.port, token: () => store.token(), page: readFileSync(VIEWER), notAnswering: "Blender antwortet nicht. / Blender is not answering." }));

  let stopped = false;
  const look = () => {
    if (!stopped) void svc.maintain().catch((e) => portal.log(`could not look after the Blender server: ${(e as Error).message}`));
  };
  const timer = setInterval(look, 30_000);
  timer.unref();
  look();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
