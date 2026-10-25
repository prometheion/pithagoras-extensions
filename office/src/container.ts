/**
 * @pithagoras/office container lifecycle: the OnlyOffice Document Server behind every edit, and the two small relay
 * containers that are its only way to the portal and back. All three are made through Docker for extensions
 * (pithagoras-docker 1.3.0), carry this extension's name, and are Office's alone.
 *
 * The Document Server is on a network of its own (`names.network`, made by `networks.create`): internal, isolated,
 * no IPv6, so a converter fed an untrusted .docx reaches neither the machine, its loopback, the local network nor the
 * internet, and nothing outside the machine reaches the Document Server. Docker for extensions gives a way onto such a
 * network (`networks.reach`) but none back from it, and the Document Server must fetch `document.url` and post its
 * save callback to the portal. So Office runs two relays of its own, both on Node's alpine image (the one the
 * forwarder of Docker for extensions runs, so usually there already) and hardened as that forwarder is:
 *
 *   browser -> portal /ds proxy -> reach(network, relay, port) -> relay :port -> document server :80   (the way in)
 *   document server -> relay :3891 -> unix socket in a volume -> portal-side relay -> 127.0.0.1:<listener>  (the way back)
 *
 * - `<container>-relay` is on the island. It passes `port` (3890 by default; Blender is 3870 and Godot 3880) on to the
 *   Document Server's port 80, and BACK_PORT on to a unix socket in a volume it shares with the other relay. The
 *   Document Server is never reached on its own port 80 from the machine: `reach` publishes its port on the machine's
 *   127.0.0.1 for a portal in the host's namespace, where port 80 is usually a reverse proxy's.
 * - `<container>-portal` shares the portal's own network namespace (`docker.sharedNetwork()`: `host`, or
 *   `container:<portal id>`), listens on that socket and passes each connection on to the extension's loopback
 *   listener on 127.0.0.1, which still checks its ticket and the callback's JWT.
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
import { namesFrom, SPEC_LABEL, stamped, type Names } from "../../shared/service";
import type { ContainerInfo, ContainerSpec, Docker, NetworkInfo, PullState, Reach } from "../../shared/docker-api";

/** The names Office's containers go by, each one the portal's environment can change (`PITHAGORAS_OFFICE_*`): a test
 * never meets the containers of a portal in use. */
export interface OfficeNames extends Names {
  /** The relay on the island: the way in, and the island's end of the way back. */
  relay: string;
  /** The relay on the portal's loopback: the portal's end of the way back. */
  portalSide: string;
  /** The volume the two relays share their socket in. */
  sock: string;
}

export function officeNames(env: NodeJS.ProcessEnv = process.env): OfficeNames {
  const base = namesFrom(env, "office", { container: "pithagoras-office-ds", port: 3890, image: "" });
  return { ...base, relay: `${base.container}-relay`, portalSide: `${base.container}-portal`, sock: `${base.container}-relay-sock` };
}

export const NAMES = officeNames();
/** The DS container, by that name. */
export const DS_NAME = NAMES.container;
/** The named volume bound at /var/www/onlyoffice/Data (DS's internal storage). */
export const DS_VOLUME = NAMES.volume;
const DS_DATA_PATH = "/var/www/onlyoffice/Data";

/** The relays' image: the one Docker for extensions pins for its forwarder (forward.ts), pinned by its tag. */
export const RELAY_IMAGE = "node:22.23.4-alpine3.23";
/** The relay's port for the way back. It never leaves the island, so it needs no setting. */
export const BACK_PORT = 3891;
/** Where the relays' shared volume is mounted: the image's own `node` home, whose owner (1000) Docker copies into a new
 * volume at its first mount, so both relays run as that user and may make and use the socket. */
const SOCK_DIR = "/home/node";
const BACK_SOCKET = `${SOCK_DIR}/portal.sock`;

/** One connection passed on: a side that ends its writing is passed on as such, a side that closes or fails closes the
 * other, no delay on small writes. The program of Docker for extensions' forwarder, for a socket as well. */
const PASS = `const net = require("node:net");
const pass = (from, to) => {
  const on = net.connect({ ...to, allowHalfOpen: true });
  for (const s of [from, on]) s.setNoDelay(true);
  const close = () => { from.destroy(); on.destroy(); };
  for (const s of [from, on]) { s.on("error", close); s.on("close", close); }
  from.pipe(on).pipe(from);
};
const listen = (at, to) => net.createServer({ allowHalfOpen: true }, (from) => pass(from, to)).listen(at);
process.on("SIGTERM", () => process.exit(0));
`;

/** The island's relay: IN_PORT to the Document Server (looked up by name for each connection, so one that came back at
 * another address is reached), BACK_PORT to the socket the portal-side relay listens on. */
export const RELAY_SCRIPT = `${PASS}listen({ port: Number(process.env.IN_PORT), host: "0.0.0.0" }, { host: process.env.DS_HOST, port: Number(process.env.DS_PORT) });
listen({ port: Number(process.env.BACK_PORT), host: "0.0.0.0" }, { path: process.env.BACK_SOCKET });
`;

/** The portal-side relay: the socket to the extension's loopback listener. A socket left by the one before is removed. */
export const PORTAL_SCRIPT = `${PASS}require("node:fs").rmSync(process.env.BACK_SOCKET, { force: true });
listen({ path: process.env.BACK_SOCKET }, { host: "127.0.0.1", port: Number(process.env.TO_PORT) });
`;

/** What Docker for extensions' forwarder is held to (forward.ts), for both relays. */
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

/** The port of the extension's loopback listener, which the portal-side relay passes the way back on to. Set by the
 * server half once it listens (0 before). */
let backTo = 0;
export function setBackPort(port: number): void {
  backTo = port;
}

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

/** The Document Server, on the island by its name, with no published port. */
export function dsSpec(image: string, env: string[], island: string, names: OfficeNames = NAMES): ContainerSpec {
  return { Image: image, Env: env, HostConfig: { NetworkMode: island, Binds: [`${names.volume}:${DS_DATA_PATH}`] } };
}

export function relaySpec(island: string, names: OfficeNames = NAMES): ContainerSpec {
  return {
    Image: RELAY_IMAGE,
    User: "1000:1000",
    Cmd: ["node", "-e", RELAY_SCRIPT],
    Env: [`IN_PORT=${names.port}`, `DS_HOST=${names.container}`, "DS_PORT=80", `BACK_PORT=${BACK_PORT}`, `BACK_SOCKET=${BACK_SOCKET}`],
    HostConfig: { NetworkMode: island, Binds: [`${names.sock}:${SOCK_DIR}`], ...HARDENED },
  };
}

/** The portal-side relay, on the portal's own loopback: `host`, or `container:<portal id>`. Made again when either the
 * portal's container or the listener's port is another. */
export function portalSideSpec(networkMode: string, toPort: number, names: OfficeNames = NAMES): ContainerSpec {
  return {
    Image: RELAY_IMAGE,
    User: "1000:1000",
    Cmd: ["node", "-e", PORTAL_SCRIPT],
    Env: [`BACK_SOCKET=${BACK_SOCKET}`, `TO_PORT=${toPort}`],
    HostConfig: { NetworkMode: networkMode, Binds: [`${names.sock}:${SOCK_DIR}`], ...HARDENED },
  };
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
  reached = asked.catch((e) => {
    reached = undefined;
    throw e;
  });
  return reached;
}

/** The origin the server half reaches the Document Server at, through the relay: `http://<host>:<port>`. */
export async function dsOrigin(docker?: Docker): Promise<string> {
  const { host, port } = await (reached ?? reachAgain(docker));
  return `http://${host}:${port}`;
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

/** Made as it would be now, and, for one on the island, on the network as it is now (by its id). */
function current(detail: Inspected, spec: ContainerSpec, island?: NetworkInfo): boolean {
  if (detail.Config?.Labels?.[SPEC_LABEL] !== labelOf(spec)) return false;
  return !island || detail.NetworkSettings?.Networks?.[island.name]?.NetworkID === island.id;
}

/** What each container would be made with now, in the order they start. The Document Server's is made with the
 * image a running one has where only that differs (see the module header). */
async function wanted(d: Docker, r: string, island: NetworkInfo, tag: string): Promise<{ name: string; spec: ContainerSpec; island?: NetworkInfo }[]> {
  if (!backTo) throw Object.assign(new Error("the office listener is not running yet"), { code: "not_ready" });
  const env = dsEnv(r);
  let ds = stamped(dsSpec(tag, env, island.name));
  const now = (await d.containers.inspect(NAMES.container).catch(() => undefined)) as Inspected | undefined;
  const image = now?.Config?.Image;
  if (now && running(now) && image && image !== tag) {
    const asItRuns = stamped(dsSpec(image, env, island.name));
    if (current(now, asItRuns, island)) ds = asItRuns;
  }
  return [
    { name: NAMES.container, spec: ds, island },
    { name: NAMES.relay, spec: stamped(relaySpec(island.name)), island },
    { name: NAMES.portalSide, spec: stamped(portalSideSpec(await d.sharedNetwork(), backTo)) },
  ];
}

/**
 * The images there (pulled with progress where not), the volumes and the network made, and each container made where
 * there is none or it is stale, and started where it does not run; then the way in asked for (`networks.reach`), and
 * ds.json written. `{ started }` says whether the Document Server itself was (re)started.
 */
// Serialized: two callers at once (the boot look and a Start) would race create/start/ds.json.
let ensuring: Promise<{ started: boolean }> | null = null;

export function ensureContainer(docker?: Docker, onPull?: (state: PullState) => void, root?: string): Promise<{ started: boolean }> {
  ensuring ??= ensureContainerOnce(docker, onPull, root).finally(() => {
    ensuring = null;
  });
  return ensuring;
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
  await ensureVolume(d, NAMES.volume);
  await ensureVolume(d, NAMES.sock);
  const island = await d.networks.create(NAMES.network);

  let started = false;
  for (const { name, spec, island: on } of await wanted(d, r, island, tag)) {
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
  // The portal's way onto the island: its container put on it, or the forwarder made and started.
  await reachAgain(d);

  const ds = await d.containers.get(NAMES.container);
  writeAtomic(path.join(r, "ds.json"), Buffer.from(JSON.stringify({ containerId: ds?.id ?? "", imageTag: tag }, null, 2) + "\n"));
  // An explicit ensure is a start request from the user: whatever stopped it before, keep it running from now on.
  clearUserStopped(r);
  return { started };
}

/** Stops the Document Server and records the user-stopped intent (the marker BEFORE the stop, so a lookAfter in flight
 * cannot race the person back into a revive). The relays keep running: they hold nothing, and the Document Server's
 * next start finds its way in and back as it was. */
export async function stopContainer(docker?: Docker, root?: string): Promise<void> {
  const d = await reachable(docker);
  const r = resolvedRoot(root);
  fs.mkdirSync(r, { recursive: true });
  writeAtomic(path.join(r, USER_STOPPED_FILE), Buffer.from("user stopped the document server\n"));
  const existing = await d.containers.get(NAMES.container);
  if (existing && existing.owner === ownName() && existing.state !== "exited") await d.containers.stop(NAMES.container);
}

/**
 * Removes what Office made in Docker: the portal-side relay, the island's relay and the Document Server, then the
 * network (which takes the forwarder or the portal's connection with it) and the relays' socket volume; with
 * `removeData` also the Document Server's own volume (its cache of open documents: every save is in the library
 * already). The images stay: Docker for extensions cannot remove one. Recorded as stopped, so lookAfter does not
 * make it all again; a Start does.
 */
export async function removeContainers(removeData: boolean, docker?: Docker, root?: string): Promise<void> {
  const d = await reachable(docker);
  const r = resolvedRoot(root);
  fs.mkdirSync(r, { recursive: true });
  writeAtomic(path.join(r, USER_STOPPED_FILE), Buffer.from("user removed the document server\n"));
  for (const name of [NAMES.portalSide, NAMES.relay, NAMES.container]) {
    const found = await d.containers.get(name);
    if (found && found.owner === ownName()) await d.containers.remove(name);
  }
  await d.networks.remove(NAMES.network);
  forgetReach();
  await d.volumes.remove(NAMES.sock);
  if (removeData) await d.volumes.remove(NAMES.volume);
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

/** Drops what the probe kept, for tests. */
export function forgetProbe(): void {
  probed = undefined;
}

/**
 * The Document Server for the status block: absent or exited/created -> "stopped", another extension's -> "foreign";
 * otherwise Docker's own inspect word (with `State.Starting` folded in as "starting"), and while it runs its version
 * and memory use. Pull progress comes from the in-memory last state of an ensure.
 */
export async function status(docker?: Docker): Promise<{ state: string; version?: string; memBytes?: number; pull?: PullState | null }> {
  const out: { state: string; version?: string; memBytes?: number; pull?: PullState | null } = { state: "stopped", pull: pullState ? { ...pullState } : null };
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
 * way in is asked for again (a forwarder somebody removed, a portal container made again). Every failure lands as
 * one log line.
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
      let fine = Boolean(island);
      if (island) {
        for (const { name, spec, island: on } of await wanted(d, r, island, settings.imageTag)) {
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
