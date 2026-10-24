import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { Docker } from "../../shared/docker-api";
import { mcpClient } from "../../shared/mcp";
import { proxyUi, uiUpgrade, writesFromHere } from "../../shared/proxy";
import { relay, type Bundled } from "../../shared/relay";
import { serverAddress, service } from "../../shared/service";
import { openStore } from "../../shared/store";
import bundled from "../server/tools.json";
import { ACTS, LABELS, PREFIX } from "./labels";
import { stream } from "./server/pages";
import { godotRoutes } from "./server/routes";
import { displayOf } from "./displays";
import { godotSpec, names } from "./server/spec";

/**
 * Godot's server half: the real Godot editor run in a container of its own through Docker for extensions
 * (`pithagoras-docker`, which this package requires), its MCP tools relayed as this extension's own tools in every
 * chat (shared/relay.ts), its viewer at /api/x/pithagoras-godot/ui/ (from the package: server/pages.ts) with what the
 * viewer asks of the server and the editor's stream proxied to the container (shared/proxy.ts), and the routes of its
 * page in Settings (server/routes.ts).
 *
 * Docker's server half starts before this one, and this one is started again whenever Docker is. So it starts
 * without waiting on Docker, and stops without touching the container: a start or a stop of the half is not one of
 * the server's. Every 30 seconds it looks after the container, as Voice does (shared/service.ts). Its token, its card,
 * its screen size and the server's last list of tools are in its own folder (`portal.dataDir()`).
 */
/**
 * The pages the extension serves, the only ones that run on the portal's origin: the viewer (pages/viewer.html) and
 * Selkies' web client (pages/stream). pages/ is one folder above this module, as src/ in the repository and lib/ in the
 * package both are.
 */
const PAGES = fileURLToPath(new URL("../pages/", import.meta.url));

export default function godot(portal: ServerPortal) {
  const data = portal.dataDir();
  const store = openStore(data);
  const at = names();
  const docker = () => portal.extensions.use<Docker>("pithagoras-docker")!;
  const address = serverAddress(docker, at);
  const mcp = mcpClient({
    url: async () => {
      const { host, port } = await address.get();
      return `http://${host}:${port}/mcp`;
    },
    token: () => store.token(),
  });
  const tools = relay({ portal, prefix: PREFIX, app: "Godot", mcp, bundled: bundled as Bundled, labels: LABELS, acts: ACTS, installedFile: path.join(data, "installed") });
  const svc = service({
    portal,
    docker,
    app: "Godot",
    names: at,
    store,
    relay: tools,
    mcp,
    spec: (plan) => godotSpec(plan, { port: at.port, volume: at.volume, image: at.image, display: displayOf(store.setting("display")) }),
    address,
  });

  // Before every route: what installs, starts, stops, removes or changes anything comes from the portal's own pages.
  portal.router.use(writesFromHere);
  godotRoutes(portal, portal.router, svc, store, { address });
  const proxy = { upstream: address.get, token: () => store.token(), page: readFileSync(path.join(PAGES, "viewer.html")), notAnswering: "Godot antwortet nicht. / Godot is not answering." };
  portal.router.use("/ui", stream(PAGES));
  portal.router.use("/ui", proxyUi(proxy));
  // The editor's stream is a WebSocket: the portal checks the sign-in and the page, and hands it over here.
  portal.http.upgrade(uiUpgrade(proxy));

  let stopped = false;
  const look = () => {
    if (!stopped) void svc.maintain().catch((e) => portal.log(`could not look after the Godot server: ${(e as Error).message}`));
  };
  const timer = setInterval(look, 30_000);
  timer.unref();
  look();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
