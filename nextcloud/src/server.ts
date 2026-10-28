/**
 * @pithagoras/nextcloud's server half (the built server.js behind package.json's pithagoras.server field): keeps
 * the Nextcloud MCP server running in its own container on the portal's loopback, registers it in pi's mcp.json
 * for the chats, and gives the client a small REST of it -- status, settings, and one tool call that goes straight
 * to the server and back.
 *
 * Stateless by design: every route re-reads the keys (the agent's config file) and finds out from Docker itself
 * where things stand; nothing of it is lost where this process was, and two reads never see different worlds. What
 * a save starts -- pulling the image, making or remaking the container, setting or clearing the mcp.json entry --
 * runs on its own, reported back in the status's task; one run at a time.
 */
import type { ServerHalf } from "@pithagoras/extension-api/server";
import { setPortal, portal, docker } from "./host";
import { loadSettings, saveSettings, configured, excludeList, NextcloudSettings } from "./config";
import { mcpClient } from "./ncmcp";
import { ensureContainer, removeContainer, serverAddress, containerState, IMAGE, CONTAINER_NAME } from "./container";

const MCP_NAME = "nextcloud"; // the entry's name in pi's config: also the prefix of this server's tools for pi

/** What a save is doing on the person's behalf right now, one run at a time -- and what it says of its last failure. */
let applying: { description: string; work: Promise<void> } | undefined;
let lastError: string | undefined;

async function apply(description: string, work: () => Promise<void>): Promise<void> {
  const self = { description, work: work() };
  applying = self;
  try {
    await self.work;
    if (applying === self) lastError = undefined;
  } catch (error) {
    if (applying === self) lastError = (error as Error).message;
    throw error;
  } finally {
    if (applying === self) applying = undefined;
  }
}

/** Bring the container and the entry in pi's config to where the keys ask for them; a no-op where all is well. */
function ensureApplied(): Promise<void> {
  const s = loadSettings();
  return apply(
    configured(s) ? "making the container and its entry in pi's config" : "removing the container and its entry",
    async () => {
      if (!configured(s)) {
        await removeContainer(docker());
        await portal().mcp.set(MCP_NAME, undefined);
        return;
      }
      const d = docker();
      if (!d) throw new Error("Docker for extensions is not available to this portal");
      await ensureContainer(d, s);
      await portal().mcp.set(
        MCP_NAME,
        { url: serverAddress(), lifecycle: "persistent", excludeTools: excludeList(s) },
        { trusted: true },
      );
    },
  );
}

/** Where things stand: the keys, the container, the entry in pi's config, the server itself, and a run of a save. */
async function status(s: NextcloudSettings): Promise<Record<string, unknown>> {
  const state = await containerState(docker());
  let mcp: { registered: boolean; on: boolean; url?: string };
  try {
    const entry = await portal().mcp.get(MCP_NAME);
    mcp = entry
      ? { registered: true, on: entry.on, url: typeof (entry.entry as Record<string, unknown>).url === "string" ? (entry.entry as Record<string, unknown>).url as string : undefined }
      : { registered: false, on: false };
  } catch {
    mcp = { registered: false, on: false };
  }
  let health: { ok: boolean; server?: { name: string; version: string }; error?: string };
  if (!configured(s) || state !== "running") {
    health = { ok: false, error: state === "absent" ? "the container is not running" : `the container ${state}` };
  } else {
    try {
      const server = await mcpClient(serverAddress()).ping();
      health = { ok: true, server };
    } catch (error) {
      health = { ok: false, error: (error as Error).message };
    }
  }
  return {
    image: IMAGE,
    container: CONTAINER_NAME,
    state,
    address: serverAddress(),
    mcp,
    health,
    task: applying?.description,
    error: lastError,
  };
}

const nextcloud: ServerHalf = async (portalArg) => {
  setPortal(portalArg);
  const r = portal().router;
  const json = portal().http.json();

  /** Where things stand, as above. */
  r.get("/status", async (_req, res) => {
    try {
      res.json(await status(loadSettings()));
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  /** What the keys hold (the password not among them) and what they would make of themselves. */
  r.get("/settings", (_req, res) => {
    const s = loadSettings();
    res.json({ url: s.url, username: s.username, mcpExcludeTools: s.mcpExcludeTools, passwordSet: s.password !== "", configured: configured(s) });
  });

  /** Set some of the keys and bring container and entry to them; where that fails, the keys stand and the task says why. */
  r.post("/settings", json, async (req, res) => {
    const given = req.body as Record<string, unknown>;
    const patch: Partial<NextcloudSettings> = {};
    for (const key of ["url", "username", "password", "mcpExcludeTools"] as const) {
      if (typeof given[key] === "string") patch[key] = given[key]; // the password is only set, never answered back
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing to save: none of url, username, password, mcpExcludeTools was given as a string" });
    const saved = saveSettings(patch);
    let task: string | undefined;
    try {
      await ensureApplied();
    } catch (error) {
      task = (error as Error).message; // the keys are what they were asked to be; the container and the entry catch up on the next save or start
    }
    res.json({ url: saved.url, username: saved.username, mcpExcludeTools: saved.mcpExcludeTools, configured: configured(saved), task });
  });

  /** One more pass toward where the keys ask for it: a no-op where all is well; what it does as its task. */
  r.post("/start", json, async (_req, res) => {
    try {
      await ensureApplied();
      res.json(await status(loadSettings()));
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  /** The container gone and the entry cleared; the keys stay. */
  r.post("/reset", json, async (_req, res) => {
    try {
      await apply("removing the container and its entry", async () => {
        await removeContainer(docker());
        await portal().mcp.set(MCP_NAME, undefined);
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  /** One tool of the Nextcloud MCP server, called through: its content parts back, raw -- the client reads them. */
  r.post("/tool", json, async (req, res) => {
    const s = loadSettings();
    if (!configured(s)) return res.status(409).json({ error: "no Nextcloud is set: save the settings first" });
    const body = req.body as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name : "";
    const args = body.args && typeof body.args === "object" && body.args !== null ? (body.args as Record<string, unknown>) : {};
    if (!name) return res.status(400).json({ error: "a tool name is needed" });
    try {
      res.json(await mcpClient(serverAddress()).callTool(name, args));
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  // On every start: one pass toward where the keys ask for it (the half was removed on stop, so this is how the
  // container comes back after a restart of the portal); its failures are theirs alone to read in the status.
  void ensureApplied().catch(() => {});

  return () => {
    // Where a stop or a removal takes the package: the container goes with it, and the entry out of pi's config;
    // the keys stay, so the next start brings everything back as it was asked for.
    void removeContainer(docker()).catch(() => {});
    void portal().mcp.set(MCP_NAME, undefined).catch(() => {});
  };
};

export default nextcloud;
