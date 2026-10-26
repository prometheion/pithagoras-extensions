/**
 * @pithagoras/office container lifecycle: the OnlyOffice Document Server behind every edit, and the small relay
 * container that is its only way to the portal and back. Both are made through Docker for extensions
 * (pithagoras-docker 1.3.0), carry this extension's name, and are Office's alone.
 *
 * The Document Server is on a network of its own (`names.network`, made by `networks.create`): internal, isolated,
 * no IPv6, so a converter fed an untrusted .docx reaches neither the machine, its loopback, the local network nor the
 * internet, and nothing outside the machine reaches the Document Server. Office uses nothing of Docker for extensions
 * but that network and the way onto it (`networks.reach`), as Blender and Godot do: no container of Office's shares
 * the portal's network namespace (`sharedNetwork`). The Document Server must still fetch `document.url` and post its
 * save callback to the portal, which such a network has no way to. So the way back runs over the way in, opened from
 * the portal's side:
 *
 *   browser -> portal /ds proxy -> reach(network, relay, port) -> relay :port -> document server :80      (the way in)
 *   portal (back.ts) -> reach(network, relay, port) -> relay :port, held open with the relay's key        (a tunnel)
 *   document server -> relay :3891 -> the next tunnel -> back.ts -> 127.0.0.1:<listener>                 (the way back)
 *
 * The agents' browser (seat.ts) is on a network of its own (`names.agentNetwork`, as isolated as the island), which the
 * relay is on too: it reaches the Document Server only through the relay's way in (port 80, where the Document
 * Server's nginx keeps its own endpoints to itself; never its docservice's port 8000 beside it), the portal only
 * through the way back, and nothing else. A portal container that `reach` put on the island is not on its network.
 *
 * `<container>-relay` is on the island, on Node's alpine image (the one Docker for extensions' forwarder runs, so
 * usually there already) and hardened as that forwarder is. On `port` (3890 by default; Blender is 3870 and Godot
 * 3880) it passes each connection on to the Document Server's port 80, except one that opens with its key (a NUL byte,
 * the key, a newline: no HTTP request starts with a NUL), which it keeps as a tunnel. On BACK_PORT it hands each
 * connection of the Document Server's to the next tunnel, and the portal passes it on to the extension's loopback
 * listener, which still checks its ticket and the callback's JWT. The key is in the extension's data folder
 * (`relay-secret`), and the Document Server is not given it: whatever reaches the relay's port (the forwarder
 * publishes it on the machine's 127.0.0.1) cannot take the Document Server's requests without it. The Document Server
 * is never reached on its own port 80 from the machine: `reach` publishes the relay's port on the machine's 127.0.0.1
 * for a portal in the host's namespace, where port 80 is usually a reverse proxy's.
 *
 * A restart of the portal, or of its container, takes nothing of this with it: the new run reaches the relay again and
 * opens its tunnels anew, and Docker for extensions puts a portal container that was made again on the network.
 *
 * Each container is made from a spec whose hash is its label (`stamped`, as Blender's and Godot's are), and one whose
 * label is not what would be made now, or that is not on the network as it is now (by the network's id), is made
 * again, the volumes kept. A Document Server that runs and differs only by its image is left running: a new image tag
 * applies at its next start, as the Settings page says, so a tag change never ends an editing session.
 *
 * User intent: `stopContainer` records a user-stopped marker FILE in the data dir, so a portal restart does not
 * revive what the person stopped (lookAfter never starts it). Any `ensureContainer` success clears it, as an ensure is
 * a start the person asked for (Settings enable, POST /container/start).
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir, docker as hostDocker, portal } from "./host";
import { loadSettings } from "./settings";
import { namesFrom, SPEC_LABEL, specHash, stamped, type Names } from "../../shared/service";
import type { ContainerInfo, ContainerSpec, Docker, NetworkInfo, PullState, Reach } from "../../shared/docker-api";

/** The names Office's containers go by, each one the portal's environment can change (`PITHAGORAS_OFFICE_*`): a test
 * never meets the containers of a portal in use. */
export interface OfficeNames extends Names {
  /** The relay on the island: the way in, and the way back. */
  relay: string;
  /** The agents' own browser, in which their editors run (seat.ts), on a network of its own. */
  agent: string;
  /** The agents' browser's network: internal and isolated as the island, with the relay on it too, its only way to the
   * Document Server (the relay's way in, to port 80 alone) and to the portal (the way back). */
  agentNetwork: string;
  /** The Document Server's volumes, by the path in its container each is bound at (see DS_PATHS). */
  volumes: Record<string, string>;
}

/**
 * Every path the Document Server's image declares as a VOLUME (`docker image inspect onlyoffice/documentserver:10.0.0.1`:
 * Config.Volumes), each given a named volume of Office's own, by the end of its name. One left out would be an
 * anonymous volume, which Docker makes anew for each container and keeps, nobody's, after it: dropped at every
 * re-create, and left on the machine. `/var/lib/onlyoffice` matters most: it holds the cache of open documents,
 * the saves the Document Server kept as forgotten among them (callback.ts takes those back).
 */
export const DS_PATHS: Record<string, string> = {
  "/var/www/onlyoffice/Data": "data",
  "/var/lib/onlyoffice": "cache",
  "/var/log/onlyoffice": "logs",
  "/usr/share/fonts/truetype/custom": "fonts",
};

export function officeNames(env: NodeJS.ProcessEnv = process.env): OfficeNames {
  const base = namesFrom(env, "office", { container: "pithagoras-office-ds", port: 3890, image: "" });
  // The data volume keeps its own setting (PITHAGORAS_OFFICE_VOLUME), as it had one before the others were named.
  const volumes = Object.fromEntries(Object.entries(DS_PATHS).map(([at, end]) => [at, end === "data" ? base.volume : `${base.container}-${end}`]));
  return { ...base, relay: `${base.container}-relay`, agent: `${base.container}-agent`, agentNetwork: `${base.container}-agents`, volumes };
}

export const NAMES = officeNames();
/** The DS container, by that name. */
export const DS_NAME = NAMES.container;
/** The named volume bound at /var/www/onlyoffice/Data (DS's internal storage). */
export const DS_VOLUME = NAMES.volume;

/** The relay's image: the one Docker for extensions pins for its forwarder (forward.ts), pinned by its tag. */
export const RELAY_IMAGE = "node:22.23.4-alpine3.23";
/** The relay's port for the way back. It never leaves the island, so it needs no setting. */
export const BACK_PORT = 3891;

/**
 * The relay's program (see the module header). Two connections joined: a side that ends its writing is passed on as
 * such, a side that closes or fails closes the other, no delay on small writes, as Docker for extensions' forwarder
 * joins them. On IN_PORT, a connection whose first byte is not NUL goes to the Document Server (looked up by name for
 * each, so one that came back at another address is reached); one that opens with the key (TUNNEL_KEY between a NUL
 * and a newline, compared in constant time) waits as a tunnel, and anything else that starts with a NUL is closed. A
 * tunnel that ends or sends anything while it waits is closed. On BACK_PORT, each connection waits (at most 30 s) for
 * a tunnel and is joined to it. At most 16 tunnels and 64 connections wait at once.
 */
export const RELAY_SCRIPT = `const net = require("node:net");
const { timingSafeEqual } = require("node:crypto");
const join = (a, b) => {
  for (const s of [a, b]) s.setNoDelay(true);
  const close = () => { a.destroy(); b.destroy(); };
  for (const s of [a, b]) { s.on("error", close); s.on("close", close); }
  a.pipe(b).pipe(a);
};
const HELLO = Buffer.from("\\0" + process.env.TUNNEL_KEY + "\\n");
const tunnels = [];
const waiting = [];
const drop = (list, s) => { const i = list.indexOf(s); if (i >= 0) list.splice(i, 1); };
const pair = () => {
  for (;;) {
    while (tunnels.length && tunnels[0].destroyed) tunnels.shift();
    while (waiting.length && waiting[0].destroyed) waiting.shift();
    if (!tunnels.length || !waiting.length) return;
    const tunnel = tunnels.shift();
    const from = waiting.shift();
    clearTimeout(from.wait);
    tunnel.off("data", tunnel.kill);
    tunnel.off("end", tunnel.kill);
    join(from, tunnel);
  }
};
net.createServer({ allowHalfOpen: true }, (from) => {
  let seen = Buffer.alloc(0);
  from.on("error", () => from.destroy());
  from.setTimeout(10000, () => from.destroy());
  const first = (chunk) => {
    seen = Buffer.concat([seen, chunk]);
    if (seen[0] !== 0) {
      from.off("data", first);
      from.pause();
      from.setTimeout(0);
      from.unshift(seen);
      join(from, net.connect({ host: process.env.DS_HOST, port: Number(process.env.DS_PORT), allowHalfOpen: true }));
      return;
    }
    if (seen.length < HELLO.length) return;
    from.off("data", first);
    from.setTimeout(0);
    if (seen.length !== HELLO.length || !timingSafeEqual(seen, HELLO) || tunnels.length >= 16) return from.destroy();
    from.setKeepAlive(true, 30000);
    from.kill = () => from.destroy();
    from.on("data", from.kill);
    from.on("end", from.kill);
    from.on("close", () => drop(tunnels, from));
    tunnels.push(from);
    pair();
  };
  from.on("data", first);
}).listen(Number(process.env.IN_PORT), "0.0.0.0");
net.createServer({ allowHalfOpen: true }, (from) => {
  from.pause();
  from.on("error", () => from.destroy());
  if (waiting.length >= 64) return from.destroy();
  from.wait = setTimeout(() => from.destroy(), 30000);
  from.on("close", () => { clearTimeout(from.wait); drop(waiting, from); });
  waiting.push(from);
  pair();
}).listen(Number(process.env.BACK_PORT), "0.0.0.0");
process.on("SIGTERM", () => process.exit(0));
`;

/** What Docker for extensions' forwarder is held to (forward.ts), for the relay. */
const HARDENED = {
  CapDrop: ["ALL"],
  SecurityOpt: ["no-new-privileges"],
  ReadonlyRootfs: true,
  Memory: 128 * 1024 ** 2,
  PidsLimit: 64,
  LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
};

/** The marker file that records "the user stopped it": lookAfter must not revive it. */
export const USER_STOPPED_FILE = "user-stopped";

type DsRecord = { containerId: string; imageTag: string };

/** Of Docker's inspect body, what is read here. */
type Inspected = {
  Config?: { Image?: string; Labels?: Record<string, string> | null };
  HostConfig?: { NetworkMode?: string };
  NetworkSettings?: { Networks?: Record<string, { NetworkID?: string }> | null };
  State?: { Status?: string; Running?: boolean; Restarting?: boolean; Starting?: boolean };
};

/** The last pull progress, in memory only, so status() can report it without re-pulling */
let pullState: PullState | null = null;

function log(line: string): void {
  try {
    portal().log(`@pithagoras/office: ${line}`);
  } catch {
    console.error(`[@pithagoras/office] ${line}`);
  }
}

function noDocker(): Error {
  return Object.assign(new Error("no_docker"), { code: "no_docker" });
}

/** docker ?? host.docker(), guarded: undefined or unreachable -> the no_docker error. */
async function reachable(docker?: Docker): Promise<Docker> {
  const d = docker ?? hostDocker();
  if (!d || !(await d.available())) throw noDocker();
  return d;
}

function resolvedRoot(root?: string): string {
  return root ?? dataDir();
}

/** The Document Server's env: its JWT in every direction with the extension's secret (the file server.ts makes at
 * boot), and no plugin manager, which would try the internet at every start from a network that has no way out. The
 * private-address filter (`ALLOW_PRIVATE_IP_ADDRESS`) stays on: the signed `document.url` and `callbackUrl` are fetched
 * directly anyway (`externalRequest.directIfIn.jwtToken`), and the filter keeps a URL inside a document from reaching
 * the relay. */
function dsEnv(root: string): string[] {
  const secret = fs.readFileSync(path.join(root, "jwt-secret"), "utf8").trim();
  return ["JWT_ENABLED=true", `JWT_SECRET=${secret}`, "JWT_HEADER=X-Auth-Token", "JWT_IN_BODY=false", "PLUGINS_ENABLED=false"];
}

/** The Document Server, on the island by its name, with no published port, and a named volume at each path its image
 * declares one (DS_PATHS). */
export function dsSpec(image: string, env: string[], island: string, names: OfficeNames = NAMES): ContainerSpec {
  return { Image: image, Env: env, HostConfig: { NetworkMode: island, Binds: Object.entries(names.volumes).map(([at, volume]) => `${volume}:${at}`) } };
}

/** The relay, on the island and on the agents' browser's network (`agents`), with the key a tunnel opens with (the
 * extension's `relay-secret`). */
export function relaySpec(island: string, key: string, agents: string, names: OfficeNames = NAMES): ContainerSpec {
  return {
    Image: RELAY_IMAGE,
    User: "1000:1000",
    Cmd: ["node", "-e", RELAY_SCRIPT],
    Env: [`IN_PORT=${names.port}`, `DS_HOST=${names.container}`, "DS_PORT=80", `BACK_PORT=${BACK_PORT}`, `TUNNEL_KEY=${key}`],
    HostConfig: { NetworkMode: island, ...HARDENED },
    // On both from its start: Docker for extensions gives no way to put a container on a network later.
    NetworkingConfig: { EndpointsConfig: { [island]: {}, [agents]: {} } },
  };
}

/* ------------------------------------------------------------------ */
/* the agents' browser                                                 */
/* ------------------------------------------------------------------ */

/**
 * The agents' browser: Chromium's headless shell, pinned by its digest, on a network of its own beside the island.
 * The tag names it for a download (Docker for extensions takes an image by its tag), the digest is what a container
 * is made from: a tag that came to name another build since is not run, and the next Start downloads it again. About
 * 540 MB on disk. Start (startOffice) downloads it beside the Document Server's image; a tool and lookAfter never do.
 */
export const AGENT_IMAGE_TAG = "chromedp/headless-shell:157.0.8103.15";
export const AGENT_IMAGE_DIGEST = "sha256:f76fce2964611eb1e25b90d906727884db12a8918a6d85a0df2619a9ef845c7c";
export const AGENT_IMAGE = `chromedp/headless-shell@${AGENT_IMAGE_DIGEST}`;

/** How much the browser may use: about 0.9 GB for one open document, and three at most (seat.ts). */
const AGENT_MEMORY = 3 * 1024 ** 3;

/**
 * The browser, on the island alone and with no port published: it reaches the Document Server by its name and the
 * relay's way back, and nothing else (the island has no way out). Hardened as the relay is, as a user that is not
 * root, with a read-only root and its profile in memory. Chromium's own sandbox is off (`--no-sandbox`): it needs
 * namespaces that the default seccomp profile and no-new-privileges refuse, and this container is the boundary. It
 * opens the seat page (`url`, which carries the page's secret) and nothing else, with no debugging port: the portal
 * talks to it only through that page.
 */
export function agentSpec(network: string, url: string): ContainerSpec {
  return {
    Image: AGENT_IMAGE,
    User: "1000:1000",
    Entrypoint: ["/headless-shell/headless-shell"],
    Cmd: ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--disable-background-networking", "--user-data-dir=/tmp/profile", url],
    Env: ["HOME=/tmp"],
    HostConfig: {
      NetworkMode: network,
      ...HARDENED,
      Memory: AGENT_MEMORY,
      PidsLimit: 512,
      ShmSize: 512 * 1024 ** 2,
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=512m" },
    },
  };
}

/** The spec as the browser is made with it: its hash as its label, and never started again by Docker by itself (its
 * page's secret is of one run of the half, so one started after a restart of Docker could only be refused). */
function agentStamped(spec: ContainerSpec): ContainerSpec {
  const host = (spec.HostConfig ?? {}) as Record<string, unknown>;
  const withPolicy = { ...spec, HostConfig: { ...host, RestartPolicy: { Name: "no" } } };
  return { ...withPolicy, Labels: { [SPEC_LABEL]: specHash(withPolicy) } };
}

/** A coded error the tools pass on to the agent as `error:<code>`. */
function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The last download of the browser's image, in memory, for the Office page. */
let agentPull: PullState | null = null;
/** The download under way: a second Start (or the switch and the button at once) waits for it instead of another. */
let agentPulling: Promise<void> | null = null;

/** Whether the browser's image is there (by its digest), and how its download goes. */
export async function agentImage(docker?: Docker): Promise<{ present: boolean; pull: PullState | null }> {
  let present = false;
  try {
    present = await (await reachable(docker)).images.present(AGENT_IMAGE);
  } catch {
    present = false;
  }
  return { present, pull: agentPull ? { ...agentPull } : null };
}

/** Downloads the browser's image (a Start of Office's; a tool never does), one download at a time. Refused where the
 * tag names another build than the pinned digest now. */
export function pullAgentImage(docker?: Docker): Promise<void> {
  agentPulling ??= pullAgentOnce(docker).finally(() => {
    agentPulling = null;
  });
  return agentPulling;
}

async function pullAgentOnce(docker?: Docker): Promise<void> {
  agentPull = null; // what a download before said is over
  try {
    const d = await reachable(docker);
    await d.images.ensure(AGENT_IMAGE_TAG, (state) => {
      agentPull = state;
    });
  } catch (e) {
    // Shown on the Office page beside the button (the route answered before the download began).
    agentPull = { active: false, line: "", error: (e as Error).message === "no_docker" ? "Docker is not reachable" : (e as Error).message };
    throw e;
  }
  const d = await reachable(docker);
  if (!(await d.images.present(AGENT_IMAGE))) {
    agentPull = { active: false, line: "", error: `${AGENT_IMAGE_TAG} is not the build this version of Office runs (${AGENT_IMAGE_DIGEST})` };
    throw coded("agent_editor_missing", agentPull.error!);
  }
}

/**
 * The browser running, opening `url`: made where there is none or it is not as it would be made now (another page
 * secret, after a restart of the half), started where it stopped. Refused where the person stopped Office
 * (`office_stopped`), the image is not there (`agent_editor_missing`: never downloaded here), or the island is not
 * (the Document Server was never started or was removed).
 */
export async function ensureAgent(url: string, docker?: Docker, root?: string): Promise<void> {
  const d = await reachable(docker);
  if (userStopped(root)) throw coded("office_stopped", "the person stopped Office");
  if (!(await d.images.present(AGENT_IMAGE))) throw coded("agent_editor_missing", `the agent's editor (${AGENT_IMAGE_TAG}) is not downloaded`);
  const agents = await d.networks.get(NAMES.agentNetwork);
  if (!agents) throw coded("office_stopped", "the agents' network is not there: Office was never started, or was removed");
  const spec = agentStamped(agentSpec(agents.name, url));
  const detail = await claim(d, NAMES.agent);
  if (!detail || !current(detail, spec, [agents])) {
    await d.containers.create(NAMES.agent, spec);
    await d.containers.start(NAMES.agent);
  } else if (!running(detail)) await d.containers.start(NAMES.agent);
}

/** The browser gone: when its last editor closed a while ago, when Office stops, and at the half's start (one left
 * from the run before has a page secret nobody knows any more, and holds the Document Server's sessions open). */
export async function stopAgent(docker?: Docker): Promise<void> {
  const d = await reachable(docker);
  const found = await d.containers.get(NAMES.agent);
  if (found && found.owner === ownName()) await d.containers.remove(NAMES.agent);
}

/** The key the portal's tunnels open with (server.ts makes the file at boot, as it makes jwt-secret). */
export function relayKey(root: string): string {
  return fs.readFileSync(path.join(root, "relay-secret"), "utf8").trim();
}

function writeAtomic(dest: string, bytes: Buffer): void {
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
}

/** ds.json: which container and image the last start made, the sign that the Document Server was set up. */
export function readDsRecord(root?: string): DsRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(resolvedRoot(root), "ds.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.containerId !== "string" || typeof r.imageTag !== "string") return null;
  return { containerId: r.containerId, imageTag: r.imageTag };
}

/** Whether the user-stopped marker is present. */
export function userStopped(root?: string): boolean {
  try {
    fs.accessSync(path.join(resolvedRoot(root), USER_STOPPED_FILE));
    return true;
  } catch {
    return false;
  }
}

function clearUserStopped(root: string): void {
  fs.rmSync(path.join(root, USER_STOPPED_FILE), { force: true });
}

/* ------------------------------------------------------------------ */
/* where the portal reaches the Document Server                        */
/* ------------------------------------------------------------------ */

/** What `networks.reach` gave, asked once in each run of the half and again where the Document Server does not answer
 * through it: a name, or 127.0.0.1 through Docker for extensions' forwarder, never an address of a container's. */
let reached: Promise<Reach> | undefined;

/** Asks Docker for extensions for the way in again, which also puts right a forwarder that went or a portal container
 * that was made again. */
export function reachAgain(docker?: Docker): Promise<Reach> {
  const asked = reachable(docker).then((d) => d.networks.reach(NAMES.network, NAMES.relay, NAMES.port));
  const now: Promise<Reach> = asked.then(
    (at) => {
      onReached?.();
      return at;
    },
    (e) => {
      if (reached === now) reached = undefined;
      throw e;
    },
  );
  reached = now;
  return now;
}

/** The origin the server half reaches the Document Server at, through the relay: `http://<host>:<port>`. */
export async function dsOrigin(docker?: Docker): Promise<string> {
  const { host, port } = await (reached ?? reachAgain(docker));
  return `http://${host}:${port}`;
}

/** The way in as last asked for, without asking: for the way back (back.ts), which must not make the forwarder or
 * the network's connection again by itself, after the person removed them. Nothing before the first ask. */
export function reachedNow(): Promise<Reach> | undefined {
  return reached;
}

/** What is told each time the way in was asked for and given: the way back opens its tunnels at once then. */
let onReached: (() => void) | undefined;
export function whenReached(hook: (() => void) | undefined): void {
  onReached = hook;
}

/** What is told each time a start (re)started the Document Server: the sessions the agents' editors were in are over
 * (seat.resetSeats). */
let onDsStarted: (() => void) | undefined;
export function whenDsStarted(hook: (() => void) | undefined): void {
  onDsStarted = hook;
}

/** Forgets the way in, for a removal (the network goes, and the forwarder with it) and for tests. */
export function forgetReach(): void {
  reached = undefined;
}

/* ------------------------------------------------------------------ */
/* making and starting                                                 */
/* ------------------------------------------------------------------ */

/** A volume of this extension's: made, or kept as it is; one nobody's by that name (an older install's) is taken over. */
async function ensureVolume(d: Docker, name: string): Promise<void> {
  try {
    await d.volumes.create(name);
  } catch (e) {
    try {
      await d.volumes.adopt(name);
    } catch {
      throw e;
    }
  }
}

/** This extension's name, as Docker for extensions marks its containers; the scoped name where no portal is set (tests). */
function ownName(): string {
  try {
    return portal().extension;
  } catch {
    return "@pithagoras/office";
  }
}

/** The container by its name, as this extension may act on it: nothing where there is none; one nobody owns (made
 * before there was this extension) taken over; another extension's refused with what to do. */
async function claim(d: Docker, name: string): Promise<Inspected | undefined> {
  const found = await d.containers.get(name);
  if (!found) return undefined;
  if (found.owner === "") await d.containers.adopt(name);
  else if (found.owner !== ownName()) {
    throw Object.assign(new Error(`A container named ${name} is ${found.owner}'s, not Office's. Rename or remove it first.`), { code: "foreign" });
  }
  return ((await d.containers.inspect(name)) as Inspected | undefined) ?? undefined;
}

const labelOf = (spec: ContainerSpec) => (spec.Labels as Record<string, string>)[SPEC_LABEL];
const running = (detail: Inspected | undefined) => detail?.State?.Running === true && !detail.State.Restarting;

/** Made as it would be now, and on the networks as they are now (by their ids). */
function current(detail: Inspected, spec: ContainerSpec, on: NetworkInfo[]): boolean {
  if (detail.Config?.Labels?.[SPEC_LABEL] !== labelOf(spec)) return false;
  return on.every((n) => detail.NetworkSettings?.Networks?.[n.name]?.NetworkID === n.id);
}

/** What each container would be made with now, in the order they start. The Document Server's is made with the
 * image a running one has where only that differs (see the module header). */
async function wanted(d: Docker, r: string, island: NetworkInfo, agents: NetworkInfo, tag: string): Promise<{ name: string; spec: ContainerSpec; on: NetworkInfo[] }[]> {
  const env = dsEnv(r);
  let ds = stamped(dsSpec(tag, env, island.name));
  const now = (await d.containers.inspect(NAMES.container).catch(() => undefined)) as Inspected | undefined;
  const image = now?.Config?.Image;
  if (now && running(now) && image && image !== tag) {
    const asItRuns = stamped(dsSpec(image, env, island.name));
    if (current(now, asItRuns, [island])) ds = asItRuns;
  }
  return [
    { name: NAMES.container, spec: ds, on: [island] },
    { name: NAMES.relay, spec: stamped(relaySpec(island.name, relayKey(r), agents.name)), on: [island, agents] },
  ];
}

/**
 * The images there (pulled with progress where not), the volumes and the network made, and each container made where
 * there is none or it is stale, and started where it does not run; then the way in asked for (`networks.reach`), and
 * ds.json written. `{ started }` says whether the Document Server itself was (re)started.
 */
// Serialized: two callers at once (the boot look and a Start) would race create/start/ds.json.
let ensuring: Promise<{ started: boolean }> | null = null;

/** Whether a start is under way: until it ends, there may be no ds.json yet, and the Document Server is starting, not
 * missing (the editor waits for it rather than saying it was never started). */
export function starting(): boolean {
  return ensuring !== null;
}

/** Why the last start of the Document Server failed, until one succeeds (or the person stops or removes it). */
let startError: string | undefined;

export function ensureContainer(docker?: Docker, onPull?: (state: PullState) => void, root?: string): Promise<{ started: boolean }> {
  ensuring ??= ensureContainerOnce(docker, onPull, root).then(
    (done) => {
      startError = undefined;
      return done;
    },
    (e) => {
      // Said on the Office page until a start succeeds: a start the switch asked for answers nobody else.
      startError = (e as Error).message === "no_docker" ? "Docker is not reachable" : (e as Error).message;
      throw e;
    },
  ).finally(() => {
    ensuring = null;
  });
  return ensuring;
}

/**
 * Start, as the person asks for it (the Office page's Start, the switch): the Document Server as ensureContainer makes
 * it, and the agents' editor's image downloaded beside it, both at once, so the page shows both downloads. A Document
 * Server that fails fails the start; an image that cannot be downloaded does not: the Document Server runs without
 * it, the page says why (`agentImage().pull.error`), and the next Start tries again. An install whose Document Server
 * runs already gets only the image.
 */
export async function startOffice(docker?: Docker, onPull?: (state: PullState) => void, root?: string): Promise<{ started: boolean; agent: { present: boolean; error?: string } }> {
  const agent = pullAgentImage(docker).then(
    () => ({ present: true }),
    (e) => ({ present: false, error: agentPull?.error ?? (e as Error).message }),
  );
  const ds = ensureContainer(docker, onPull, root);
  const [made, image] = await Promise.allSettled([ds, agent]);
  if (made.status === "rejected") throw made.reason;
  return { started: made.value.started, agent: image.status === "fulfilled" ? image.value : { present: false } };
}

async function ensureContainerOnce(docker?: Docker, onPull?: (state: PullState) => void, root?: string): Promise<{ started: boolean }> {
  const d = await reachable(docker);
  const r = resolvedRoot(root);
  const tag = loadSettings(r).imageTag;

  // One pull for an image at a time, whoever asks; the progress is held for status() and handed to onPull.
  for (const image of [tag, RELAY_IMAGE]) {
    await d.images.ensure(image, (state) => {
      pullState = state;
      onPull?.(state);
    });
  }
  for (const volume of Object.values(NAMES.volumes)) await ensureVolume(d, volume);
  const island = await d.networks.create(NAMES.network);
  const agents = await d.networks.create(NAMES.agentNetwork);

  let started = false;
  for (const { name, spec, on } of await wanted(d, r, island, agents, tag)) {
    const detail = await claim(d, name);
    if (!detail || !current(detail, spec, on)) {
      // Made again where it is stale: the volumes stay.
      await d.containers.create(name, spec);
      await d.containers.start(name);
    } else if (!running(detail)) {
      await d.containers.start(name);
    } else continue;
    if (name === NAMES.container) started = true;
  }
  if (started) onDsStarted?.();
  // The portal's way onto the island: its container put on it, or the forwarder made and started.
  await reachAgain(d);

  const ds = await d.containers.get(NAMES.container);
  writeAtomic(path.join(r, "ds.json"), Buffer.from(JSON.stringify({ containerId: ds?.id ?? "", imageTag: tag }, null, 2) + "\n"));
  // An explicit ensure is a start request from the user: whatever stopped it before, keep it running from now on.
  clearUserStopped(r);
  return { started };
}

/** Stops the Document Server and records the user-stopped intent (the marker BEFORE the stop, so a lookAfter in flight
 * cannot race the person back into a revive). The relay keeps running: it holds nothing, and the Document Server's
 * next start finds its way in and back as it was. */
export async function stopContainer(docker?: Docker, root?: string): Promise<void> {
  const d = await reachable(docker);
  const r = resolvedRoot(root);
  fs.mkdirSync(r, { recursive: true });
  writeAtomic(path.join(r, USER_STOPPED_FILE), Buffer.from("user stopped the document server\n"));
  startError = undefined;
  const existing = await d.containers.get(NAMES.container);
  if (existing && existing.owner === ownName() && existing.state !== "exited") await d.containers.stop(NAMES.container);
  // The agents' editors are in the Document Server's sessions: they go with it.
  await stopAgent(d);
}

/**
 * Removes what Office made in Docker: the relay and the Document Server, then the network (which takes the forwarder
 * or the portal's connection with it); with `removeData` also the Document Server's volumes (its cache of open
 * documents with the saves it could not hand over yet, its logs, its own data). Without, they stay for the next Start,
 * which takes back such a save. The images stay: Docker for extensions cannot remove one. Recorded as stopped, so
 * lookAfter does not make it all again; a Start does.
 */
export async function removeContainers(removeData: boolean, docker?: Docker, root?: string): Promise<void> {
  const d = await reachable(docker);
  const r = resolvedRoot(root);
  fs.mkdirSync(r, { recursive: true });
  writeAtomic(path.join(r, USER_STOPPED_FILE), Buffer.from("user removed the document server\n"));
  startError = undefined;
  for (const name of [NAMES.agent, NAMES.relay, NAMES.container]) {
    const found = await d.containers.get(name);
    if (found && found.owner === ownName()) await d.containers.remove(name);
  }
  await d.networks.remove(NAMES.network);
  await d.networks.remove(NAMES.agentNetwork);
  forgetReach();
  if (removeData) for (const volume of Object.values(NAMES.volumes)) await d.volumes.remove(volume);
  fs.rmSync(path.join(r, "ds.json"), { force: true });
}

/* ------------------------------------------------------------------ */
/* how it stands                                                       */
/* ------------------------------------------------------------------ */

/** The version and memory use read in the container, kept a little: the page polls every 5 seconds, and an exec each
 * time would be a process in the container each time. */
let probed: { id: string; at: number; version?: string; memBytes?: number } | undefined;
const PROBE_FOR_MS = 15_000;

/**
 * The running version, as the image's package says it (`dpkg-query`: "10.0.0-169"), and the memory the container uses
 * now, from its own cgroup (v2's memory.current, or v1's usage). Docker's inspect body has neither, and the Docker API
 * an extension has gives no stats. Never an error: what fails stays absent.
 */
async function probe(d: Docker, id: string): Promise<{ version?: string; memBytes?: number }> {
  if (probed && probed.id === id && Date.now() - probed.at < PROBE_FOR_MS) return { version: probed.version, memBytes: probed.memBytes };
  const out: { version?: string; memBytes?: number } = {};
  try {
    const res = await d.containers.exec(
      NAMES.container,
      ["sh", "-c", "dpkg-query -W -f='${Version}\\n' onlyoffice-documentserver; cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes"],
      { timeoutMs: 10_000 },
    );
    const [version, mem] = res.output.trim().split("\n").map((l) => l.trim());
    if (version && /^\d[\w.~+-]*$/.test(version)) out.version = version;
    if (mem && /^\d+$/.test(mem) && Number(mem) > 0) out.memBytes = Number(mem);
  } catch {
    // no answer: nothing to say
  }
  probed = { id, at: Date.now(), ...out };
  return out;
}

/** Drops what the probe kept, and what the last start and download said, for tests. */
export function forgetProbe(): void {
  probed = undefined;
  settledRun = undefined;
  startError = undefined;
  agentPull = null;
}

/**
 * A new Document Server container answers its health check within seconds, but its start script then makes its fonts,
 * themes and script caches in the background (about two minutes) and restarts its own services at the end. An editor
 * opened meanwhile loses its connection at that restart: what is typed is not saved, and the editor shows errors.
 * It is set up once AllFonts.js is there and the script that makes it no longer runs (the bracket keeps pgrep from
 * finding this shell, whose command line names it too).
 */
const SETTLED_CHECK = 'test -s /var/www/onlyoffice/documentserver/sdkjs/common/AllFonts.js && ! pgrep -f "documentserver-generate-allfont[s]" >/dev/null';

/** The run of the container (its id and when it started) last found set up: that stays so until it starts again. */
let settledRun: string | undefined;

/**
 * Whether the running Document Server is done setting itself up (see SETTLED_CHECK). False only where the check says it
 * is still at it; where it cannot be asked (no Docker, no container, the exec failed), true, and what is wrong is
 * said where it is (the status, the editor's own errors).
 */
export async function settled(docker?: Docker): Promise<boolean> {
  try {
    const d = await reachable(docker);
    const detail = (await d.containers.inspect(NAMES.container)) as (Inspected & { Id?: string; State?: { StartedAt?: string } }) | undefined;
    if (!detail || !running(detail)) return true;
    const run = `${detail.Id ?? ""}@${detail.State?.StartedAt ?? ""}`;
    if (settledRun === run) return true;
    const res = await d.containers.exec(NAMES.container, ["sh", "-c", SETTLED_CHECK], { timeoutMs: 10_000 });
    if (res.timedOut || res.exitCode === null) return true;
    if (res.exitCode !== 0) return false;
    settledRun = run;
    return true;
  } catch {
    return true;
  }
}

/**
 * The Document Server for the status block: absent or exited/created -> "stopped", another extension's -> "foreign";
 * otherwise Docker's own inspect word (with `State.Starting` folded in as "starting"), and while it runs its version
 * and memory use. Pull progress comes from the in-memory last state of an ensure, and `error` says why the last start
 * failed, until one succeeds or the person stops or removes it.
 */
export async function status(docker?: Docker): Promise<{ state: string; version?: string; memBytes?: number; pull?: PullState | null; error?: string }> {
  const out: { state: string; version?: string; memBytes?: number; pull?: PullState | null; error?: string } = { state: "stopped", pull: pullState ? { ...pullState } : null };
  if (startError !== undefined) out.error = startError;
  let d: Docker;
  try {
    d = await reachable(docker);
  } catch {
    return out; // no docker here: the container is as good as stopped from our seat
  }
  let existing: ContainerInfo | undefined;
  try {
    existing = await d.containers.get(NAMES.container);
  } catch {
    existing = undefined;
  }
  if (!existing || existing.state === "exited" || existing.state === "created") return out;
  if (existing.owner !== ownName() && existing.owner !== "") {
    out.state = "foreign";
    return out;
  }
  let inspected: Inspected | undefined;
  try {
    inspected = (await d.containers.inspect(NAMES.container)) as Inspected | undefined;
  } catch {
    inspected = undefined;
  }
  const st = inspected?.State;
  if (!st || typeof st.Status !== "string") {
    out.state = existing.state;
    return out;
  }
  out.state = st.Status === "running" && st.Starting ? "starting" : st.Status === "exited" ? "stopped" : st.Status;
  // Running, but still making its fonts: an editor opened now would lose its connection (see settled).
  if (out.state === "running" && !(await settled(d))) out.state = "starting";
  if (out.state === "running") Object.assign(out, await probe(d, existing.id));
  return out;
}

/** Whether the Document Server answers through the way in now. */
async function answers(docker: Docker): Promise<boolean> {
  try {
    const res = await fetch(`${await dsOrigin(docker)}/healthcheck`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget, at boot and every 30 s: with Office on and not stopped by the person, what is not running or not as
 * it would be made now is put right (ensureContainer), and where all runs but the Document Server does not answer, the
 * way in is asked for again (a forwarder somebody removed, a portal container made again), and with it the way back,
 * which runs over it. Every failure lands as one log line.
 */
export function lookAfter(docker?: Docker, root?: string): Promise<void> {
  return (async () => {
    let d: Docker;
    let r: string;
    try {
      d = await reachable(docker);
      r = resolvedRoot(root);
    } catch (e) {
      log(`lookAfter skipped: ${(e as Error).message}`);
      return;
    }
    try {
      const settings = loadSettings(r);
      if (!settings.enabled || userStopped(r)) return;
      const island = await d.networks.get(NAMES.network);
      const agents = await d.networks.get(NAMES.agentNetwork);
      let fine = Boolean(island && agents);
      if (island && agents) {
        for (const { name, spec, on } of await wanted(d, r, island, agents, settings.imageTag)) {
          const detail = (await d.containers.inspect(name).catch(() => undefined)) as Inspected | undefined;
          if (!detail || !running(detail) || !current(detail, spec, on)) fine = false;
        }
      }
      if (!fine) await ensureContainer(d, undefined, r);
      else if (!(await answers(d))) await reachAgain(d);
    } catch (e) {
      log(`could not look after the document server container: ${(e as Error).message}`);
    }
  })();
}
