import type { Request, Response, Router } from "express";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { ServerAddress, Service } from "../../../shared/service";
import type { Store } from "../../../shared/store";
import { DISPLAYS, displayOf } from "../displays";

/**
 * The Godot page in Settings, and the panel beside each chat, at /api/x/pithagoras-godot/…, behind the portal's
 * sign-in:
 *
 *   GET  /state       how the server stands (shared/service.ts `status`), the editor's own state while it answers,
 *                     and the screen size
 *   GET  /hardware    the cards as the probe finds them now, the one chosen, whether the host pinned one, the one the
 *                     server is or would be on
 *   PUT  /gpu         {gpu}: the card by UUID, or "" for the card with the most free memory. A running server is made
 *                     again on it now, a stopped one at its next Start
 *   PUT  /display     {display}: the size of the virtual screen, made again in the same way
 *   POST /install, /start, /stop
 *   POST /uninstall   {removeData}: the container, and with removeData the volume with the projects
 *
 * The server's own pages and its stream are at /ui/ (shared/proxy.ts, mounted in server.ts).
 */

/** The editor as the server says it is (its /api/state), without its activity log, which is the viewer's. */
export interface EditorState {
  ready: boolean;
  editor: string;
  project: string | null;
  renderer: string | null;
  busy: string | null;
  restarts: number;
  adapter: string | null;
  godot: string;
}

/** What the server says of its editor: nothing while it does not answer in time. */
async function editorState(address: ServerAddress, token: string): Promise<EditorState | undefined> {
  try {
    const { host, port } = await address.get();
    const answer = await fetch(`http://${host}:${port}/api/state`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    if (!answer.ok) return undefined;
    const { ready, editor, project, renderer, busy, restarts, adapter, godot } = (await answer.json()) as EditorState;
    return { ready, editor, project, renderer, busy, restarts, adapter, godot };
  } catch {
    return undefined;
  }
}

export function godotRoutes(portal: ServerPortal, router: Router, svc: Service, store: Store, server: { address: ServerAddress }): void {
  const json = portal.http.json();
  const fail = (res: Response, status: number, e: unknown) => res.status(status).json({ error: (e as Error).message });

  router.get("/state", async (_req: Request, res: Response) => {
    try {
      const state = await svc.status();
      const editor = state.state === "running" ? await editorState(server.address, store.token()) : undefined;
      res.json({ ...state, ...(editor ? { editor } : {}), display: displayOf(store.setting("display")) });
    } catch (e) {
      fail(res, 503, e);
    }
  });
  router.get("/hardware", async (_req: Request, res: Response) => {
    try {
      res.json(await svc.hardware());
    } catch (e) {
      fail(res, 503, e);
    }
  });
  router.put("/gpu", json, async (req: Request, res: Response) => {
    const gpu = req.body?.gpu;
    if (typeof gpu !== "string") return void res.status(400).json({ error: "gpu must be a card's UUID, or empty for the card with the most free memory." });
    try {
      res.json({ selected: gpu, ...(await svc.chooseGpu(gpu)) });
    } catch (e) {
      fail(res, 400, e);
    }
  });
  router.put("/display", json, async (req: Request, res: Response) => {
    const display = req.body?.display;
    if (!(DISPLAYS as readonly string[]).includes(display)) return void res.status(400).json({ error: "Choose one of the screen sizes offered." });
    try {
      store.putSettings({ display });
      // The look finds a running server stale with the new size and makes it again: busy says it does.
      res.json({ display, restarting: (await svc.status()).busy });
    } catch (e) {
      fail(res, 400, e);
    }
  });
  for (const action of ["install", "start", "stop"] as const) {
    router.post(`/${action}`, async (_req: Request, res: Response) => {
      try {
        await svc[action]();
        res.json({ ok: true });
      } catch (e) {
        fail(res, 400, e);
      }
    });
  }
  router.post("/uninstall", json, async (req: Request, res: Response) => {
    const removeData = req.body?.removeData ?? false;
    if (typeof removeData !== "boolean") return void res.status(400).json({ error: "removeData must be true or false." });
    try {
      await svc.uninstall(removeData);
      res.json({ ok: true });
    } catch (e) {
      fail(res, 409, e);
    }
  });
}
