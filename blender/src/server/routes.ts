import type { Request, Response, Router } from "express";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { Service } from "../../../shared/service";

/**
 * Blender's page in Settings, and its panel, at /api/x/pithagoras-blender/…, behind the portal's sign-in:
 *
 *   GET  /state       how the server stands (shared/service.ts `status`), with what the server says of its renderer
 *                     while it answers: the GPU backend Cycles uses and the denoiser the viewport uses
 *   GET  /hardware    the cards as the probe finds them now, the one chosen, the one pinned, where the OptiX weights are
 *   PUT  /gpu         {gpu}: the card by UUID, or "" for the card with the most free memory
 *   POST /install, /start, /stop
 *   POST /uninstall   {removeData}: the container, and with removeData the volume with the projects
 *
 * The viewer is at /ui/ (shared/proxy.ts, mounted in server.ts). A request that is not a read, here or there, is
 * refused unless it comes from the portal's own pages (`writesFromHere`, mounted before both).
 */

/** What the server says of its renderer, from its own state (GET /api/state): nothing while it does not answer. */
async function renderer(port: number, token: string): Promise<{ backend: string; denoiser: string } | undefined> {
  try {
    const answer = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    if (!answer.ok) return undefined;
    const state = (await answer.json()) as { gpu?: string; denoiser?: string };
    return { backend: state.gpu ?? "", denoiser: state.denoiser ?? "" };
  } catch {
    return undefined;
  }
}

export function blenderRoutes(portal: ServerPortal, router: Router, svc: Service, server: { port: number; token: () => string }): void {
  const json = portal.http.json();
  const fail = (res: Response, status: number, e: unknown) => res.status(status).json({ error: (e as Error).message });

  router.get("/state", async (_req: Request, res: Response) => {
    try {
      const state = await svc.status();
      res.json({ ...state, ...(state.state === "running" ? { renderer: await renderer(server.port, server.token()) } : {}) });
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
