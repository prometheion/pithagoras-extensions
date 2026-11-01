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
 * runs on its own, reported back in the status's task; one run at a time. A removal is a save of the list without
 * the instance, and the run behind it takes away what no instance stands for any more: every container of this
 * extension that no plan names, and every entry it wrote (it keeps their names) that no instance carries.
 */
import net from "node:net";
import { isDeepStrictEqual } from "node:util";
import type { ServerHalf } from "@pithagoras/extension-api/server";
import { writesFromHere } from "../../shared/proxy";
import { setPortal, portal, docker, personGate } from "./host";
import { loadInstances, saveInstances, loadWritten, loadEntriesVersion, saveWritten, ENTRIES_VERSION, configured, isValidInstanceName, NextcloudInstance } from "./config";
import { CAPABILITIES, APPROVE_TOOLS, EARLIER_APPROVE_TOOLS, capabilityOfTool, excludeGlobs, availableFromTools } from "./capabilities";
import { mcpClient } from "./ncmcp";
import { normalizeUrl, checkAccountSoon, forgetAccount } from "./account";
import { ensureOwn, releaseOwn, containerState, instanceAddress, ownAddress, planOwn, CONTAINER_BASE, IMAGE, OwnPlan } from "./container";

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
    ...(inst.allowHttp === true ? { allowHttp: true } : {}),
    username: inst.username,
    ...(inst.capabilities !== undefined ? { capabilities: { ...inst.capabilities } } : {}),
    passwordSet: inst.password !== "",
    configured: configured(inst),
  };
}

/** One client for each endpoint, kept: a call is not a handshake (a session each time was never closed, and the
 * server holds its sessions for half an hour). */
const clients = new Map<string, ReturnType<typeof mcpClient>>();
function clientFor(address: string): ReturnType<typeof mcpClient> {
  let client = clients.get(address);
  if (!client) clients.set(address, (client = mcpClient(address)));
  return client;
}
/** A client no longer used (its container made again, or gone): its session ended, its tool names forgotten. */
function forgetClient(address: string): void {
  const client = clients.get(address);
  clients.delete(address);
  toolNamesCache.delete(address);
  void client?.close();
}

/** How long a container is given to come up and answer as the Nextcloud MCP server before the run says it did not. */
const ANSWER_WITHIN_MS = Number(process.env.PITHAGORAS_NEXTCLOUD_ANSWER_MS?.trim()) > 0 ? Number(process.env.PITHAGORAS_NEXTCLOUD_ANSWER_MS) : 60_000;
/** How long the container must have run without a break when its port answers, before the answer counts as its own:
 * one that cannot listen because the port is taken exits about when it would have begun to listen, and Docker starts
 * it again (its restart policy), so a container in that loop is running for a few seconds at a time. */
const SETTLED_MS = Number(process.env.PITHAGORAS_NEXTCLOUD_SETTLED_MS?.trim()) > 0 ? Number(process.env.PITHAGORAS_NEXTCLOUD_SETTLED_MS) : 8_000;

/** Whether anything takes a connection on that port of the loopback right now (the portal's loopback is the
 * container's: they share the network namespace). */
function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (taken: boolean) => {
      socket.destroy();
      resolve(taken);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** What runs before the run starts an instance's container: whatever answers on its port then is not that container,
 * and would be taken for it -- another Nextcloud MCP server of the person's, for another account, included. */
const portFree = (plan: OwnPlan) => async (): Promise<void> => {
  if (await portAnswers(plan.port))
    throw new Error(`${plan.inst.name}: port ${plan.port} of 127.0.0.1 is taken by another program, so its container is not started (what answers there would be taken for it). Stop that program or move it to another port, then press Start.`);
};

/** How long the container has been running without a break, by Docker's word: nothing where it is not running now
 * (one Docker waits to start again included). */
async function runningFor(d: ReturnType<typeof docker>, name: string): Promise<number | undefined> {
  const inspect = (await d.containers.inspect(name).catch(() => undefined)) as { State?: { Status?: string; Restarting?: boolean; StartedAt?: string } } | undefined;
  const state = inspect?.State;
  if (state?.Status !== "running" || state.Restarting === true) return undefined;
  const since = Date.parse(state.StartedAt ?? "");
  return Number.isNaN(since) ? undefined : Math.max(0, Date.now() - since);
}

/** The container running, and answering as the Nextcloud MCP server (the server names itself "Nextcloud MCP"): what
 * stands on the port may be another program, or the container may have exited because the port is taken. The answer
 * counts once the container has run without a break for a while: a container that keeps restarting is not what
 * answers. Only a server that answered goes into pi's config. */
async function awaitAnswer(d: ReturnType<typeof docker>, plan: OwnPlan): Promise<void> {
  const address = ownAddress(plan.port);
  forgetClient(address); // a handshake of its own: what a session made earlier was told is not what stands now
  const give = Date.now() + Math.max(ANSWER_WITHIN_MS, SETTLED_MS + 1_000);
  let last = "";
  for (;;) {
    const state = await containerState(d, plan.containerName);
    if (state === "exited" || state === "dead") {
      last = `the container ${state}${plan.port ? ` (is port ${plan.port} taken by another program?)` : ""}`;
      break;
    }
    try {
      const server = await clientFor(address).ping();
      if (/nextcloud/i.test(server.name)) {
        const up = await runningFor(d, plan.containerName);
        if (up !== undefined && up >= SETTLED_MS) return;
        last = up === undefined
          ? `${address} answers, but its container is not running (${state}): another program may hold port ${plan.port}`
          : `its container has not run for long enough yet to tell its answer from another program's on port ${plan.port}; it keeps restarting where that program holds the port`;
      } else {
        last = `${address} answers as ${server.name ? `"${server.name}"` : "an unnamed server"}, not as the Nextcloud MCP server`;
      }
    } catch (error) {
      last = (error as Error).message;
    }
    if (Date.now() >= give) break;
    await new Promise((wait) => setTimeout(wait, 300));
  }
  throw new Error(`${plan.inst.name}: its server did not come up: ${last}. Its log is in Settings -> Docker.`);
}

/** Whether an entry of pi's mcp.json looks like one this extension wrote: the loopback /mcp of a container, kept
 * alive, with no login of its own. What an earlier version wrote and left behind is such an entry, with nothing
 * recorded of it -- asked only while that earlier version's entries are being taken over (`entries` below
 * ENTRIES_VERSION): later, every entry this extension writes stands in `written`, and a person's own local server of
 * that shape is theirs. */
function looksOwn(entry: Record<string, unknown>): boolean {
  const login = ["headers", "env", "auth", "oauth", "command", "socket"].some((key) => key in entry) || Object.keys(entry).some((key) => /^bearer/i.test(key));
  return typeof entry.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(entry.url) && entry.lifecycle === "persistent" && !login;
}

/** The server of that name in pi's mcp.json, where it is not this extension's to take: one it did not write and that
 * does not look like its own. */
function foreignEntry(name: string): boolean {
  const there = portal().mcp.get(name);
  return !!there && !loadWritten().includes(name) && !(loadEntriesVersion() < ENTRIES_VERSION && looksOwn(there.entry));
}

/** Bring every instance's container and its entry in pi's config to where the keys ask for them; a no-op where all
 * is well. Each configured one gets its life of a made container (remade where what it was made with is no longer
 * what it says, started where it stopped), and its entry is written once that server answers as the Nextcloud MCP
 * server. What no configured instance stands for any more goes: the containers of this extension that no plan
 * names, and the entries it wrote under names no instance carries. An entry it did not write is never touched. The
 * keys are read where the run starts, not where it was asked for: a run standing in the row works on what stands now.
 *
 * What an entry in pi's config takes -- url, lifecycle, excludeTools and approveTools -- is pi-mcp-adapter's own
 * vocabulary, checked by eye against its source, as that API has no types of its own. */
function ensureApplied(): Promise<void> {
  const asked = loadInstances();
  return apply(
    asked.some(configured) ? "bringing the containers and their entries in pi's config to where they are asked" : "removing the containers this extension made and its entries",
    async () => {
      const d = docker();
      const insts = loadInstances();
      const plans = planOwn(insts);
      let changed = false;
      for (const plan of plans.values()) {
        // the planned ports and names stand saved from now on: a later save does not shift or rename them
        if (plan.inst.port !== plan.port || plan.inst.container !== plan.containerName) {
          plan.inst.port = plan.port;
          plan.inst.container = plan.containerName;
          changed = true;
        }
      }
      if (changed) saveInstances(insts);
      const wanted = insts.filter(configured);
      const names = new Set(wanted.map((inst) => inst.name));
      const keep = new Set(wanted.map((inst) => plans.get(inst.name)!.containerName));
      // Containers no instance stands for: a removed or unfinished instance's, or one a run left that was removed meanwhile.
      for (const found of await d.containers.list()) {
        if (!found.name.startsWith(CONTAINER_BASE) || keep.has(found.name)) continue;
        await releaseOwn(d, found.name);
      }
      let written = loadWritten();
      const version = loadEntriesVersion();
      // Entries this extension wrote under names that no instance carries any more.
      for (const name of written) if (!names.has(name)) await portal().mcp.set(name, undefined);
      written = written.filter((name) => names.has(name));
      saveWritten(written, version);
      const failed: string[] = [];
      for (const inst of wanted) {
        const plan = plans.get(inst.name)!;
        try {
          const there = portal().mcp.get(inst.name);
          if (there && !written.includes(inst.name) && !(version < ENTRIES_VERSION && looksOwn(there.entry)))
            throw new Error(`${inst.name}: pi's mcp.json already holds a server of that name that this extension did not write. Rename the instance, or remove that server in Settings -> MCP.`);
          if (await ensureOwn(d, plan, portFree(plan))) forgetClient(ownAddress(plan.port));
          // Removed while it was made (a download takes minutes): no entry for it; the run behind that removal sweeps it.
          if (!loadInstances().some((i) => i.name === inst.name)) continue;
          await awaitAnswer(d, plan);
          const kept = carryOver(there?.entry);
          // A list this extension wrote itself, now or in an earlier version, is its default and not the person's
          // choice: it gets this version's (a wider one reaches every install that ran an earlier one).
          if ([APPROVE_TOOLS, ...EARLIER_APPROVE_TOOLS].some((list) => isDeepStrictEqual(kept.approveTools, list))) delete kept.approveTools;
          const entry = { approveTools: APPROVE_TOOLS, ...kept, url: ownAddress(plan.port), lifecycle: "persistent", excludeTools: excludeGlobs(inst) };
          // An entry an earlier version wrote counted as the person's own (trusted). Writing a server again does not
          // take the name out of Settings -> Guard's trusted servers; removing it does. Only the names that version
          // wrote: every name in `written` was written by this one (0.1.0 kept no such list), and a removal each run
          // would take a trust the person gave it since, and reload the open chats, while another instance fails.
          if (there && version < ENTRIES_VERSION && !written.includes(inst.name)) await portal().mcp.set(inst.name, undefined);
          else if (there && written.includes(inst.name) && isDeepStrictEqual(there.entry, entry)) continue; // nothing to say again: every set reloads the open chats
          await portal().mcp.set(inst.name, entry);
          written = [...written, inst.name];
          saveWritten(written, version);
        } catch (error) {
          failed.push((error as Error).message);
        }
      }
      if (!failed.length) saveWritten(written, ENTRIES_VERSION);
      if (failed.length) throw new Error(failed.join(" "));
    },
  );
}

/** What an entry in pi's config keeps of itself where this extension rewrites it: the person's own tuning of that
 * server (the debug flag, the direct-tools flag, the tools they chose to be asked about) -- but not how the server
 * is reached, which the instance says now, and never a login: a header, a token or an environment someone put on
 * an entry of that name is not sent on to the container. */
function carryOver(entry: Record<string, unknown> | undefined): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry ?? {})) {
    if (["url", "command", "args", "cwd", "socket", "headers", "env", "auth", "oauth"].includes(key) || /^bearer/i.test(key)) continue;
    kept[key] = value;
  }
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
      const server = await clientFor(address).ping();
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
  // Whether the Nextcloud itself takes the login: the server's own answer says nothing of that (its handshake never
  // reaches Nextcloud). Asked of the host directly, and kept for a minute; a host that is slow to say shows as "checking".
  const account = configured(inst) ? await checkAccountSoon(inst, ACCOUNT_WAIT_MS) : undefined;
  return { name: inst.name, containerName: name, state, address, url: inst.url || undefined, mcp, health, configured: configured(inst), ...(account !== undefined ? { account } : {}), ...(capabilities !== undefined ? { capabilities } : {}) };
}

const ACCOUNT_WAIT_MS = 2_500;

/** The names of one endpoint's tools, asked live and answered from memory for a while: the capability check stands
 * on it, and a status poll is not to make the endpoint list its tools again every turn. */
const toolNamesCache = new Map<string, { at: number; names: string[] }>();
const TOOL_NAMES_TTL_MS = 60_000;
async function toolNames(address: string): Promise<string[]> {
  const hit = toolNamesCache.get(address);
  if (hit && Date.now() - hit.at < TOOL_NAMES_TTL_MS) return hit.names;
  const names = (await clientFor(address).listTools()).map((tool) => tool.name);
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

/** The containers this extension made gone and the entries it wrote cleared; the keys stay. Entries first: a chat
 * must not be offered tools of a server that is going. */
async function teardown(): Promise<void> {
  const d = docker();
  const version = loadEntriesVersion();
  for (const name of loadWritten()) {
    await portal().mcp.set(name, undefined);
    saveWritten(loadWritten().filter((n) => n !== name), version);
  }
  const found = (await d.containers.list()).filter((c) => c.name.startsWith(CONTAINER_BASE));
  await Promise.all(found.map((c) => releaseOwn(d, c.name)));
  for (const address of [...clients.keys()]) forgetClient(address);
}

const nextcloud: ServerHalf = async (portalArg) => {
  setPortal(portalArg);
  const r = portal().router;
  const json = portal().http.json();
  // Changes only from the portal's own pages and only for its primary person, as Office's routes: the portal's cookie
  // is SameSite=Lax, which a page on another port of the same site is still sent, and these routes start, remove and
  // call tools that send mail and delete.
  r.use(writesFromHere);
  r.use(personGate);

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
    const given = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof given.name === "string" ? given.name.trim() : "";
    if (!isValidInstanceName(name)) return res.status(400).json({ error: "the instance's name may take letters, numbers, dashes and underscores, and start with a letter" });
    const insts = loadInstances();
    const old = insts.find((i) => i.name === name);
    // A server of that name in pi's mcp.json that this extension did not write is not to be taken over: its settings
    // and its place would go.
    if (foreignEntry(name))
      return res.status(400).json({ error: `pi's mcp.json already holds a server called ${name} that this extension did not make. Use another name, or remove that server in Settings -> MCP first.` });
    const before = old ? { ...old } : undefined;
    const inst = old ?? { name, url: "", username: "", password: "" };
    if (!old) insts.push(inst);
    for (const key of ["username", "password"] as const) {
      // The password is only set, never answered back: a page that has none to send says nothing, or nothing in it.
      if (typeof given[key] === "string" && (key !== "password" || (given[key] as string).trim() !== "")) inst[key] = (given[key] as string).trim();
    }
    if (typeof given.allowHttp === "boolean") {
      if (given.allowHttp) inst.allowHttp = true;
      else delete inst.allowHttp;
    }
    if (typeof given.url === "string") inst.url = given.url.trim();
    if (inst.url !== "") {
      const checked = normalizeUrl(inst.url, inst.allowHttp === true);
      if ("error" in checked) return res.status(400).json({ error: checked.error });
      inst.url = checked.url;
    }
    // The saved app password belongs to the host and the user it was typed for: it is not carried to another one. The
    // address saved is compared as it is normalized now: one an earlier version saved only trimmed (a trailing slash,
    // capitals in the host, the default port) is the same host.
    const beforeUrl = before ? normalizeUrl(before.url, true) : undefined;
    const sameHost = !before || before.url === inst.url || (beforeUrl !== undefined && !("error" in beforeUrl) && beforeUrl.url === inst.url);
    if (before && before.password !== "" && (!sameHost || before.username !== inst.username) && (typeof given.password !== "string" || given.password.trim() === ""))
      return res.status(400).json({ error: "A new address or user name needs the app password typed again: the saved one is not sent to another host or account." });
    if (given.capabilities !== undefined) {
      const record = given.capabilities;
      if (typeof record !== "object" || record === null || Array.isArray(record)) return res.status(400).json({ error: "the capabilities stand as a map of their ids to on or off" });
      const next: Record<string, boolean> = {};
      for (const [id, value] of Object.entries(record as Record<string, unknown>)) if (CAPABILITIES.some((cap) => cap.id === id) && typeof value === "boolean") next[id] = value;
      // A family on stands nowhere in the saved map: only the offs are kept, so a missing map reads as everything on.
      inst.capabilities = Object.keys(next).length > 0 ? next : undefined;
    }
    const saved = saveInstances(insts);
    forgetAccount(inst);
    // Fire-and-forget on purpose (as office's settings route): a first pull takes minutes and must not hold the
    // response open -- the run stands reported in the status's task, one at a time, and its failures stay there.
    void ensureApplied().catch(() => {});
    res.json({ instances: saved.map(view) });
  });

  /** One instance gone: the list saved without it at once, and the run behind that takes its container and its entry
   * away (what no instance stands for goes). Nothing awaits between reading the list and saving it, so a save at the
   * same time is not lost, and a run that is pulling its image at the moment finds the instance gone when it comes
   * round again. */
  r.post("/instances/remove", json, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const insts = loadInstances();
    if (!insts.some((i) => i.name === name)) return res.status(400).json({ error: "no such instance" });
    const saved = saveInstances(insts.filter((i) => i.name !== name));
    void ensureApplied().catch(() => {});
    res.json({ instances: saved.map(view) });
  });

  /** One more pass toward where the instances ask for it: a no-op where all is well; what it does as its task. */
  r.post("/start", json, async (_req, res) => {
    void ensureApplied().catch(() => {}); // fire-and-forget: a pull must not hold the response open; the status carries it
    try {
      res.json(await status());
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  /** The containers this extension made gone and the entries it wrote cleared; the keys stay. */
  r.post("/reset", json, async (_req, res) => {
    // Fire-and-forget, like the others: stopping and removing every container must not hold the response open;
    // the run reports itself in the status.
    void apply("removing the containers this extension made and its entries in pi's config", teardown).catch(() => {});
    res.json({ ok: true });
  });

  /** One tool of the instance's Nextcloud MCP server, called through: its content parts back, raw -- the client
   * reads them. The instance named is taken, or the first configured one where none is. Only a tool of a family the
   * instance has turned on: what the chats may not call, this route does not call either. */
  r.post("/tool", json, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name : "";
    const args = body.args && typeof body.args === "object" && body.args !== null ? (body.args as Record<string, unknown>) : {};
    if (!name) return res.status(400).json({ error: "a tool name is needed" });
    const insts = loadInstances();
    const wanted = typeof body.instance === "string" ? body.instance.trim() : "";
    const inst = wanted ? insts.find((i) => i.name === wanted) : insts.find(configured);
    if (!inst) return res.status(409).json({ error: wanted ? `no such instance: ${wanted}` : "no Nextcloud is set: save the settings first" });
    if (!configured(inst)) return res.status(409).json({ error: `the instance ${inst.name} is not set up completely yet` });
    const family = capabilityOfTool(name);
    if (!family) return res.status(403).json({ error: `${name} is not a tool of any family this extension offers` });
    if (inst.capabilities?.[family.id] === false) return res.status(403).json({ error: `${family.label} is switched off for ${inst.name}` });
    let plans: Map<string, OwnPlan>;
    try {
      plans = planOwn(insts);
    } catch (error) {
      return res.status(502).json({ error: (error as Error).message });
    }
    const address = instanceAddress(plans, inst);
    if (!address) return res.status(502).json({ error: `the container of ${inst.name} is not running` });
    try {
      res.json(await clientFor(address).callTool(name, args));
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  // On every start: one pass toward where the instances ask for their entries in pi's config (the entries were
  // removed on stop, so this is how everything comes back after a restart of the portal). While the extension is
  // still loading, the portal refuses its actions outright, so that first pass retries them until the load has
  // finished instead of failing once and waiting for someone to press Start; any other failure stays in the status.
  void (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await ensureApplied();
        return;
      } catch (error) {
        const message = (error as Error).message ?? "";
        if (!/not\s+(yet\s+)?initialized/i.test(message) || attempt >= 100) return;
        await new Promise((wait) => setTimeout(wait, 500));
      }
    }
  })();

  // Where a stop or a removal takes the package: the entries it wrote out of pi's config and the containers it made
  // gone with it; the keys stay, so the next start brings everything back. The portal waits for this before it
  // starts the half again (an update, a restart of Docker's half), so it is what this returns, and it stands in the
  // row of runs like any other: the new half's first pass begins after it.
  return () =>
    apply("removing the containers this extension made and its entries", teardown).catch(() => {});
};

export default nextcloud;
