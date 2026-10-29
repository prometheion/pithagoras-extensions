/**
 * @pithagoras/nextcloud's server half (the built server.js behind package.json's pithagoras.server field): keeps
 * one Nextcloud MCP server running per instance -- each in a container this extension made and keeps, as understory
 * keeps its own -- registers every instance as its own entry in pi's mcp.json for the chats, and gives the client a
 * small REST of it: the instances, the state of all of it, and one tool call that goes straight to the chosen
 * instance's server and back.
 *
 * Stateless by design: every route re-reads the keys (the agent's config file) and finds out from Docker itself
 * where things stand; nothing of it is lost where this process was, and two reads never see different worlds. What
 * a save starts -- pulling the image, making or remaking the containers, setting or clearing the mcp.json entries --
 * runs on its own, reported back in the status's task; one run at a time.
 */
import type { ServerHalf } from "@pithagoras/extension-api/server";
import { setPortal, portal, docker } from "./host";
import { loadInstances, saveInstances, configured, isValidInstanceName, NextcloudInstance } from "./config";
import { CAPABILITIES, excludeGlobs, availableFromTools } from "./capabilities";
import { mcpClient } from "./ncmcp";
import { ensureOwn, releaseOwn, containerState, instanceAddress, planOwn, IMAGE, OwnPlan } from "./container";

/** What a save is doing on the person's behalf right now -- and what it says of its last failure. Where two saves
 * ask at once they stand in a row: each run waits for the one before it, so every run sees finished runs only, never
 * half of another. */
let applying: { description: string } | undefined;
let applyRow: Promise<unknown> = Promise.resolve(); // the end of that row: every new run is hooked to it
let lastError: string | undefined;

function apply(description: string, work: () => Promise<void>): Promise<void> {
  const self = { description };
  const turn = applyRow.then(async () => {
    applying = self;
    try {
      await work();
      if (applying === self) lastError = undefined;
    } catch (error) {
      if (applying === self) lastError = (error as Error).message;
      throw error; // to the one who asked for this run; the row goes on without it
    } finally {
      if (applying === self) applying = undefined;
    }
  });
  applyRow = turn.then(
    () => undefined,
    () => undefined, // a failed run is not the end of the row: the next still gets its turn
  );
  return turn;
}

/** What an instance says of itself where the settings page wants to read it: everything but the password -- with
 * its capability choices beside, as a missing map is "everything on". */
function view(inst: NextcloudInstance): Record<string, unknown> {
  return {
    name: inst.name,
    url: inst.url,
    username: inst.username,
    ...(inst.capabilities !== undefined ? { capabilities: { ...inst.capabilities } } : {}),
    passwordSet: inst.password !== "",
    configured: configured(inst),
  };
}

/** Bring every instance's container and its entry in pi's config to where the keys ask for them; a no-op where all
 * is well. Each configured one gets its life of a made container (remade where it no longer matches, started where
 * it stopped); an entry is cleared where the instance behind it is gone or unconfigured, so pi's config keeps saying
 * what is true. The keys
 * are read where the run starts, not where it was asked for: a run standing in the row works on what stands now.
 *
 * What an entry in pi's config takes -- url, lifecycle and excludeTools beside trusted -- is pi-mcp-adapter's own
 * vocabulary, checked by eye against its source, as that API has no types of its own. */
function ensureApplied(): Promise<void> {
  const asked = loadInstances();
  return apply(
    asked.some(configured) ? "bringing the containers and their entries in pi's config to where they are asked" : "removing the containers this extension made and its entries",
    async () => {
      const d = docker();
      if (!d) throw new Error("Docker for extensions is not available to this portal");
      const insts = loadInstances();
      const plans = planOwn(insts);
      let portsChanged = false;
      for (const plan of plans.values()) if (plan.inst.port !== plan.port) { plan.inst.port = plan.port; portsChanged = true; }
      if (portsChanged) saveInstances(insts); // the planned ports stand saved from now on: a later save does not shift them
      for (const inst of insts) {
        if (configured(inst)) continue; // what stands asks for nothing: it goes, entry as well.
        const name = plans.get(inst.name)?.containerName;
        if (name) await releaseOwn(d, name);
        await portal().mcp.set(inst.name, undefined);
      }
      for (const inst of insts) {
        if (!configured(inst)) continue;
        const plan = plans.get(inst.name);
        if (!plan) continue; // cannot stand: no plan for it (too many instances), and the status says so
        await ensureOwn(d, plan);
        await portal().mcp.set(inst.name, { ...carryOver(portal().mcp.get(inst.name)?.entry), url: `http://127.0.0.1:${plan.port}/mcp`, lifecycle: "persistent", excludeTools: excludeGlobs(inst) }, { trusted: true });
      }
    },
  );
}

/** What an entry in pi's config keeps of itself where this extension rewrites it: the person's own tuning of that
 * server (the debug flag, the direct-tools flag, whatever stood there) -- but not how the server is reached, which
 * the instance says now. */
function carryOver(entry: Record<string, unknown> | undefined): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry ?? {})) if (!["url", "command", "socket"].includes(key)) kept[key] = value;
  return kept;
}

/** What one instance says of itself in the status: its container, its entry in pi's config, and whether its server
 * answers at all. */
async function instanceStatus(d: NonNullable<ReturnType<typeof docker>>, plans: Map<string, OwnPlan>, inst: NextcloudInstance): Promise<Record<string, unknown>> {
  const name = plans.get(inst.name)?.containerName ?? "";
  const state = await containerState(d, name);
  const address = instanceAddress(plans, inst);
  let mcp: { registered: boolean; on: boolean; url?: string };
  try {
    const entry = await portal().mcp.get(inst.name);
    mcp = entry
      ? { registered: true, on: entry.on, url: typeof (entry.entry as Record<string, unknown>).url === "string" ? (entry.entry as Record<string, unknown>).url as string : undefined }
      : { registered: false, on: false };
  } catch {
    mcp = { registered: false, on: false };
  }
  let health: { ok: boolean; server?: { name: string; version: string }; error?: string };
  if (!configured(inst)) {
    health = { ok: false, error: "not set completely yet" };
  } else if (state !== "running") {
    health = { ok: false, error: state === "absent" ? "the container is not running" : `the container ${state}` };
  } else if (!address) {
    health = { ok: false, error: "no plan stands for its container yet" };
  } else {
    try {
      const server = await mcpClient(address).ping();
      health = { ok: true, server };
    } catch (error) {
      health = { ok: false, error: (error as Error).message };
    }
  }
  // What the endpoint provides of each family, asked live where it answers -- so a page offers nowhere what its
  // server does not have; where it cannot be asked, availability stands unknown and nothing is offered away on it.
  let capabilities: { available: Record<string, boolean>; on: Record<string, boolean> } | undefined;
  if (health.ok && address) {
    try {
      capabilities = { available: availableFromTools(await toolNames(address)), on: inst.capabilities ? { ...inst.capabilities } : {} };
    } catch {
      // the endpoint did not list its tools right now: availability stays unknown for this pass
    }
  }
  return { name: inst.name, containerName: name, state, address, mcp, health, configured: configured(inst), ...(capabilities !== undefined ? { capabilities } : {}) };
}

/** The names of one endpoint's tools, asked live and answered from memory for a while: the capability check stands
 * on it, and a status poll is not to make the endpoint list its tools again every turn. */
const toolNamesCache = new Map<string, { at: number; names: string[] }>();
const TOOL_NAMES_TTL_MS = 60_000;
async function toolNames(address: string): Promise<string[]> {
  const hit = toolNamesCache.get(address);
  if (hit && Date.now() - hit.at < TOOL_NAMES_TTL_MS) return hit.names;
  const names = (await mcpClient(address).listTools()).map((tool) => tool.name);
  toolNamesCache.set(address, { at: Date.now(), names });
  return names;
}

/** Where things stand of every instance at once, and a run of a save. */
async function status(): Promise<Record<string, unknown>> {
  const insts = loadInstances();
  let plans: Map<string, OwnPlan> = new Map();
  try {
    plans = planOwn(insts);
  } catch (error) {
    return { image: IMAGE, instances: [], configured: false, task: applying?.description, error: (error as Error).message };
  }
  const rows = await Promise.all(insts.map((inst) => instanceStatus(docker(), plans, inst)));
  return { image: IMAGE, instances: rows, configured: rows.some((row) => row.configured), task: applying?.description, error: lastError };
}

const nextcloud: ServerHalf = async (portalArg) => {
  setPortal(portalArg);
  const r = portal().router;
  const json = portal().http.json();

  /** Where things stand of every instance, as above. */
  r.get("/status", async (_req, res) => {
    try {
      res.json(await status());
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  /** What the instances hold (the passwords not among them), for the settings page. */
  r.get("/instances", (_req, res) => {
    res.json({ instances: loadInstances().map(view) });
  });

  /** One instance added or amended -- and with it, its container and its entry in pi's config brought to where it
   * asks for them; where that fails, the keys stand and the task says why. */
  r.post("/instances", json, async (req, res) => {
    const given = req.body as Record<string, unknown>;
    const name = typeof given.name === "string" ? given.name.trim() : "";
    if (!isValidInstanceName(name)) return res.status(400).json({ error: "the instance's name may take letters, numbers, dashes and underscores, and start with a letter" });
    const insts = loadInstances();
    let inst = insts.find((i) => i.name === name);
    if (!inst) {
      inst = { name, url: "", username: "", password: "" };
      insts.push(inst);
    }
    for (const key of ["url", "username", "password"] as const) {
      // A new instance takes its fields here on the first save; an existing one is amended in place.
      if (typeof given[key] === "string") inst[key] = (given[key] as string).trim(); // the password is only set, never answered back
    }
    if (given.capabilities !== undefined) {
      const record = given.capabilities;
      if (typeof record !== "object" || record === null || Array.isArray(record)) return res.status(400).json({ error: "the capabilities stand as a map of their ids to on or off" });
      const next: Record<string, boolean> = {};
      for (const [id, value] of Object.entries(record as Record<string, unknown>)) if (CAPABILITIES.some((cap) => cap.id === id) && typeof value === "boolean") next[id] = value;
      // A family on stands nowhere in the saved map: only the offs are kept, so a missing map reads as everything on.
      inst.capabilities = Object.keys(next).length > 0 ? next : undefined;
    }
    const saved = saveInstances(insts);
    let task: string | undefined;
    try {
      await ensureApplied();
    } catch (error) {
      task = (error as Error).message; // the keys are what they were asked to be; the containers and the entries catch up on the next save or start
    }
    res.json({ instances: saved.map(view), task });
  });

  /** One instance gone: its entry out of pi's config, and its container with it. */
  r.post("/instances/remove", json, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const insts = loadInstances();
    const gone = insts.find((i) => i.name === name);
    if (!gone) return res.status(400).json({ error: "no such instance" });
    if (configured(gone)) {
      try {
        await releaseOwn(docker(), planOwn(insts).get(name)?.containerName ?? "");
      } catch {
        // the container is gone already or not to be had: the entry still goes
      }
    }
    const saved = saveInstances(insts.filter((i) => i.name !== name));
    let task: string | undefined;
    try {
      await ensureApplied();
    } catch (error) {
      task = (error as Error).message;
    }
    res.json({ instances: saved.map(view), task });
  });

  /** One more pass toward where the instances ask for it: a no-op where all is well; what it does as its task. */
  r.post("/start", json, async (_req, res) => {
    try {
      await ensureApplied();
      res.json(await status());
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  /** The containers this extension made gone and the entries in pi's config cleared; the keys stay. */
  r.post("/reset", json, async (_req, res) => {
    try {
      await apply("removing the containers this extension made and its entries in pi's config", async () => {
        const d = docker();
        const insts = loadInstances();
        const plans = planOwn(insts);
        for (const inst of insts) {
          const name = plans.get(inst.name)?.containerName;
          if (name) await releaseOwn(d, name);
          await portal().mcp.set(inst.name, undefined);
        }
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  /** One tool of the instance's Nextcloud MCP server, called through: its content parts back, raw -- the client
   * reads them. The instance named is taken, or the first configured one where none is. */
  r.post("/tool", json, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name : "";
    const args = body.args && typeof body.args === "object" && body.args !== null ? (body.args as Record<string, unknown>) : {};
    if (!name) return res.status(400).json({ error: "a tool name is needed" });
    const insts = loadInstances();
    const wanted = typeof body.instance === "string" ? body.instance.trim() : "";
    const inst = wanted ? insts.find((i) => i.name === wanted) : insts.find(configured);
    if (!inst) return res.status(409).json({ error: wanted ? `no such instance: ${wanted}` : "no Nextcloud is set: save the settings first" });
    if (!configured(inst)) return res.status(409).json({ error: `the instance ${inst.name} is not set up completely yet` });
    let plans: Map<string, OwnPlan>;
    try {
      plans = planOwn(insts);
    } catch (error) {
      return res.status(502).json({ error: (error as Error).message });
    }
    const address = instanceAddress(plans, inst);
    if (!address) return res.status(502).json({ error: `the container of ${inst.name} is not running` });
    try {
      res.json(await mcpClient(address).callTool(name, args));
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  // On every start: one pass toward where the instances ask for their entries in pi's config (the entries were
  // removed on stop, so this is how everything comes back after a restart of the portal); its failures are its own
  // to read in the status.
  void (async () => {
    await ensureApplied().catch(() => {});
  })();

  return () => {
    // Where a stop or a removal takes the package: the containers it made go with it, and its entries out of pi's
    // config; the keys stay, so the next start brings everything back.
    void (async () => {
      const d = docker();
      if (!d) return;
      const insts = loadInstances();
      let plans: Map<string, OwnPlan> = new Map();
      try {
        plans = planOwn(insts);
      } catch {
        // too many instances for the ports: nothing to release by its planned name
      }
      for (const inst of insts) {
        const name = plans.get(inst.name)?.containerName;
        if (name) await releaseOwn(d, name);
        await portal().mcp.set(inst.name, undefined);
      }
    })().catch(() => {});
  };
};

export default nextcloud;
