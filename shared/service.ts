import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { ContainerSpec, Docker, NetworkInfo, Reach } from "./docker-api";
import { mostFree, probe, type Card, type Optix, type Probed } from "./gpu";
import type { McpClient } from "./mcp";
import type { Relay } from "./relay";
import type { Store } from "./store";

/**
 * The server's container: made, started, stopped and removed through Docker for extensions (`pithagoras-docker`,
 * which the extension requires), as Voice runs its own. What the extension may do with it is what Docker lets any
 * extension do with its own: it carries the extension's name, and a container of that name that is not the
 * extension's is left alone.
 *
 * Docker starts it again after it exits and as the host starts, unless the person stopped it (`unless-stopped`, the
 * rule for every service container an extension runs). The half never stops it: a stop of the half also comes with
 * every restart of the portal and of Docker's half, and a stop through Docker would count as the person's and keep
 * the server down after a reboot. So it keeps running when the extension is switched off or uninstalled, as the
 * portal has no uninstall hook: the Settings page says to remove the server there first.
 *
 * The container is on a network of its own (`names.network`), which Docker for extensions makes with no way out: code
 * the server runs reaches nothing but the server, and the portal reaches the server where `networks.reach` says
 * (`serverAddress`). What it is made with is hashed into a label of its own (`pithagoras.extension-spec`). A container
 * whose label is not the hash of what would be made now (another image after an update, another card), or that is not
 * on the network as it is now (by the network's id: one removed and made again is another network, on which an old
 * container cannot start), is stale. A running one is made again at once, the volume kept; a stopped one at its next
 * Start. That is Voice's rule, with a hash for Voice's recipe label.
 *
 * The portal's container being made again or restarted leaves the server as it is: a new portal container is put on
 * the network at the next reach, which is asked as the server starts and where it does not answer.
 */

/** The names a service goes by, each one the portal's environment can change: see `namesFrom`. */
export interface Names {
  container: string;
  volume: string;
  /** The short-lived container the GPU probe runs in. */
  probe: string;
  /** The network the container is on, the extension's own, which has no way out. */
  network: string;
  /** The server's port in its container, and, for a portal in the host's namespace, on 127.0.0.1 (the forwarder's). */
  port: number;
  image: string;
  /** A card the host's owner pinned, by UUID or index: the only one the probe asks for and the server is given. */
  gpu?: string;
}

/**
 * The names, with what the portal's environment says in place of each default: `PITHAGORAS_<APP>_CONTAINER`,
 * `_VOLUME`, `_PORT`, `_IMAGE` and `_GPU`. For a second portal on the same Docker, and for tests, which must not
 * meet the containers of a portal that is in use.
 */
export function namesFrom(env: NodeJS.ProcessEnv, app: string, defaults: { container: string; port: number; image: string }): Names {
  const key = (name: string) => env[`PITHAGORAS_${app.toUpperCase()}_${name}`]?.trim() || undefined;
  const container = key("CONTAINER") ?? defaults.container;
  const port = Number(key("PORT"));
  return {
    container,
    volume: key("VOLUME") ?? `${container}-data`,
    probe: `${container}-probe`,
    network: `${container}-net`,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : defaults.port,
    image: key("IMAGE") ?? defaults.image,
    ...(key("GPU") ? { gpu: key("GPU") } : {}),
  };
}

/** What a container is made for: the card it is given (none: no GPU), where the OptiX weights are, its network, and its token. */
export interface Plan {
  card?: { uuid: string };
  optix: Optix;
  /** The network it is on: the extension's own, which has no way out. */
  network: string;
  token: string;
}

/** How the server stands, as the Settings page and the panel are told. */
export interface Status {
  state: "unavailable" | "absent" | "foreign" | "downloading" | "starting" | "running" | "stopped" | "failed";
  /** An install, a start or a removal is under way. */
  busy: boolean;
  /** The download's last line, while one is under way. */
  progress: string;
  /** Why the last install or start failed, or why Docker stopped the container. */
  error: string;
  /** The end of what the container wrote (200 lines), colours taken out. */
  log: string;
  container: string;
  volume: string;
  image: string;
  /** The card the container holds, by UUID, where it holds one. */
  card?: string;
  /** Docker is starting it again after it exited, which a stop ends. */
  retrying?: boolean;
}

/** Of Docker's inspect body, what is read here. */
interface Inspected {
  Image?: string;
  Config?: { Image?: string; Labels?: Record<string, string> | null };
  HostConfig?: { NetworkMode?: string; DeviceRequests?: { DeviceIDs?: string[] | null }[] | null; Mounts?: { Target?: string }[] | null };
  NetworkSettings?: { Networks?: Record<string, { NetworkID?: string }> | null };
  State?: { Running?: boolean; Restarting?: boolean; ExitCode?: number; Error?: string; StartedAt?: string };
  RestartCount?: number;
}

export const SPEC_LABEL = "pithagoras.extension-spec";
const RESTART = { Name: "unless-stopped" };

/** What a spec is hashed by: everything but its labels. */
export function specHash(spec: ContainerSpec): string {
  const { Labels: _labels, ...rest } = spec;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

/** The spec as it is made: the restart policy every service container has, and the hash of the rest as its label. */
export function stamped(spec: ContainerSpec): ContainerSpec {
  const host = (spec.HostConfig ?? {}) as Record<string, unknown>;
  const withPolicy = { ...spec, HostConfig: { ...host, RestartPolicy: RESTART } };
  return { ...withPolicy, Labels: { ...((spec.Labels as Record<string, string> | undefined) ?? {}), [SPEC_LABEL]: specHash(withPolicy) } };
}

/** Docker's answer that there is no such container or volume, which is no failure where nothing has to be there. */
function absent(e: unknown): void {
  if ((e as { status?: number }).status !== 404) throw e;
}

/** The card a container was given, by the id Docker was asked for: the UUID, as every container made here asks by it. */
const heldCard = (detail: Inspected | undefined): string | undefined => detail?.HostConfig?.DeviceRequests?.flatMap((r) => r.DeviceIDs ?? [])[0];

/** How long a server may take to answer after its start before the half stops waiting for it (the 30 s look goes on). */
const ANSWER_WITHIN_MS = 180_000;

/**
 * Where the portal reaches the server: what Docker for extensions' `networks.reach` gave, asked once in each run of the
 * half and again where the server does not answer (`again`). A name, or 127.0.0.1 through a forwarder, never an
 * address of the container's, which changes as it starts again: so what was given stays right while the portal runs.
 */
export function serverAddress(docker: () => Docker, names: Names) {
  let reached: Promise<Reach> | undefined;
  const again = () =>
    (reached = docker().networks.reach(names.network, names.container, names.port).catch((e) => {
      reached = undefined;
      throw e;
    }));
  return { get: () => reached ?? again(), again, forget: () => void (reached = undefined) };
}
export type ServerAddress = ReturnType<typeof serverAddress>;

export interface ServiceOptions {
  portal: ServerPortal;
  docker: () => Docker;
  /** The app's name, as people read it: `Blender`. */
  app: string;
  names: Names;
  store: Store;
  relay: Relay;
  mcp: McpClient;
  /** What the container is made with for a plan: Docker's create body, with the plan's network. */
  spec: (plan: Plan) => ContainerSpec;
  /** Runs the GPU probe; the tests give their own. */
  probe?: (docker: Docker, name: string, pinned?: string) => Promise<Probed>;
  /** Where the portal reaches the server (`serverAddress`), which the MCP client and the proxy ask too. */
  address: ServerAddress;
}

export function service(options: ServiceOptions) {
  const { portal, app, names, store, relay, mcp } = options;
  const docker = options.docker;
  const runProbe = options.probe ?? probe;
  let pending = false;
  let downloading = false;
  let progress = "";
  let error = "";
  /** The run of the container (Docker's `State.StartedAt`) the server last answered in: see `retrying`. */
  let answered: string | undefined;

  /**
   * Docker is starting the container again by itself after it exited, and goes on doing so: running to Docker while it
   * waits for the next try (`Restarting`), and in a try one it began (`RestartCount`) that the server has not answered
   * in. One it answered in came back. A stop ends the tries. Voice's rule.
   */
  const retrying = (detail: Inspected | undefined) =>
    detail?.State?.Running === true && Boolean(detail.State.Restarting || (detail.RestartCount && detail.State.StartedAt !== answered));

  /** The container by its name: nothing where there is none, `foreign` where it is not this extension's. */
  async function own(): Promise<Inspected | "foreign" | undefined> {
    const d = docker();
    const found = await d.containers.get(names.container);
    if (!found) return undefined;
    if (found.owner !== portal.extension) return "foreign";
    // One removed since it was looked at has nothing to read.
    return ((await d.containers.inspect(names.container).catch((e) => absent(e))) as Inspected | undefined) ?? undefined;
  }

  // --- the GPU ---

  let probed: Probed | undefined;
  let probing: Promise<Probed> | undefined;
  /** One probe at a time: the page asks as it opens, an install asks when nothing was probed yet. */
  function detect(): Promise<Probed> {
    probing ??= runProbe(docker(), names.probe, names.gpu)
      .then((found) => (probed = found))
      .finally(() => {
        probing = undefined;
      });
    return probing;
  }

  /**
   * The card the server is to be on: the one the host's owner pinned (the probe asked for it alone); else the one chosen
   * on the page, if it is there; else the one the container holds now, so that the most free memory, which the server's
   * own use changes, does not move it; else the card with the most free memory. Without a probe in this run of the half,
   * the container keeps its card unless another was chosen. A pinned card the probe did not find leaves a container
   * on the card it holds (a new one is refused: `install`), and with no pin and no card found, it has none.
   */
  function wantedCard(detail: Inspected | undefined): { uuid: string } | undefined {
    const chosen = names.gpu ? "" : (store.setting("gpu") ?? "");
    const held = heldCard(detail);
    if (!probed) return chosen ? { uuid: chosen } : held ? { uuid: held } : undefined;
    if (!probed.cards.length) return names.gpu && held ? { uuid: held } : undefined;
    if (names.gpu) return { uuid: probed.cards[0].uuid };
    const card = probed.cards.find((c) => c.uuid === chosen) ?? probed.cards.find((c) => c.uuid === held) ?? mostFree(probed.cards);
    return card && { uuid: card.uuid };
  }

  /** Where the OptiX weights are for the plan: as probed, else as the container was made (bound from the host, or not). */
  function wantedOptix(detail: Inspected | undefined): Optix {
    if (probed) return probed.optix;
    return detail?.HostConfig?.Mounts?.some((m) => m.Target === "/usr/share/nvidia/nvoptix.bin") ? "host" : "none";
  }

  const wantedSpec = (detail: Inspected | undefined, island: NetworkInfo): ContainerSpec =>
    stamped(options.spec({ card: wantedCard(detail), optix: wantedOptix(detail), network: island.name, token: store.token() }));

  /** Made as it would be now, and on the network as it is now: by its id, as one made again under the name is another. */
  const current = (detail: Inspected, spec: ContainerSpec, island: NetworkInfo) =>
    detail.Config?.Labels?.[SPEC_LABEL] === (spec.Labels as Record<string, string>)[SPEC_LABEL] &&
    detail.NetworkSettings?.Networks?.[island.name]?.NetworkID === island.id;

  // --- how it stands ---

  async function status(): Promise<Status> {
    const base = { busy: pending, progress: downloading ? progress : "", container: names.container, volume: names.volume, image: names.image };
    const d = docker();
    if (!(await d.available())) return { ...base, state: "unavailable", error: "", log: "" };
    const detail = await own();
    if (detail === "foreign") {
      relay.setInstalled(false);
      return { ...base, state: "foreign", error: "", log: "" };
    }
    relay.setInstalled(detail !== undefined);
    // One Docker waits to start again is running to Docker, with nothing running in it.
    const running = detail?.State?.Running === true && !detail.State.Restarting;
    let problem = error;
    if (running && !pending) {
      try {
        const island = await d.networks.get(names.network);
        if (!island || !current(detail!, wantedSpec(detail, island), island)) {
          void install().catch((e) => portal.log(`could not make the ${app} container again: ${(e as Error).message}`));
          return { ...base, busy: true, state: "starting", error: "", log: "" };
        }
      } catch (e) {
        problem = (e as Error).message;
      }
    }
    // Tty is on, so the log is plain text, colours aside.
    const written = detail ? await d.containers.logs(names.container, { tail: 200 }).catch((e) => (absent(e), "")) : "";
    const log = written.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
    const ready = running && (await mcp.ping(AbortSignal.timeout(3000)));
    if (ready) answered = detail!.State!.StartedAt;
    const retried = retrying(detail);
    const failed = !ready && (retried || (!running && Boolean(detail?.State?.ExitCode)));
    const state: Status["state"] = pending ? (downloading ? "downloading" : "starting") : ready ? "running" : failed ? "failed" : running ? "starting" : detail ? "stopped" : "absent";
    if (failed && !problem) problem = detail?.State?.Error || `${app} exited. Its log says why.`;
    return { ...base, state, error: problem, log, ...(detail && heldCard(detail) ? { card: heldCard(detail) } : {}), ...(detail?.Config?.Image ? { image: detail.Config.Image } : {}), retrying: retried };
  }

  /**
   * After a start: waits for the server to answer, then compares what it lists with the tools the extension offers,
   * which says in the log where they differ.
   */
  async function whenAnswering(): Promise<void> {
    const until = Date.now() + ANSWER_WITHIN_MS;
    while (Date.now() < until) {
      if (await mcp.ping(AbortSignal.timeout(3000))) return relay.check();
      // Not a wait that keeps the portal's process from ending.
      await delay(1000, undefined, { ref: false });
    }
  }

  // --- what the person asks for ---

  /**
   * A card the host's owner pinned (`PITHAGORAS_<APP>_GPU`) that the probe did not find: Docker would not give a
   * container that card (no card by that UUID or index, or no NVIDIA runtime), so none is made with it, and none is
   * made without it either, as the owner asked for that card.
   */
  function refuseMissingPin(found: Probed): void {
    if (names.gpu && !found.cards.length) throw new Error(`The card PITHAGORAS_${app.toUpperCase()}_GPU names is not on this host.`);
  }

  /**
   * Installs the server, or starts it: the GPU probed (once in each run of the half, and again as the page opens),
   * the image downloaded where it is not there yet, the volume made, and the container made where there is none or
   * it is stale, then started. In the background: the page follows it in `status`. A failure is `error` there.
   */
  async function install(): Promise<void> {
    if (pending) throw new Error(`${app} is being set up already.`);
    const d = docker();
    if (!(await d.available())) throw new Error("Docker does not answer.");
    if ((await own()) === "foreign") throw new Error(`A container named ${names.container} is there that is not this extension's. Rename or remove it first.`);
    if (probed) refuseMissingPin(probed);
    pending = true;
    error = "";
    progress = "";
    void (async () => {
      try {
        refuseMissingPin(probed ?? (await detect()));
        downloading = true;
        await d.images.ensure(names.image, (state) => {
          if (state.active && state.line !== "starting") progress = state.line;
        });
        downloading = false;
        await d.volumes.create(names.volume);
        const island = await d.networks.create(names.network);
        const detail = await own();
        if (detail === "foreign") throw new Error(`A container named ${names.container} is there that is not this extension's. Rename or remove it first.`);
        const spec = wantedSpec(detail, island);
        if (detail && current(detail, spec, island)) {
          // One Docker is starting again is running to Docker: stopped first, so this start is a start of its own.
          if (retrying(detail)) await d.containers.stop(names.container);
          await d.containers.start(names.container);
        } else {
          // Made again where it is stale: the volume, with the projects, stays.
          await d.containers.create(names.container, spec);
          await d.containers.start(names.container);
        }
        // The portal's way onto the network: its container put on it, or the forwarder made and started.
        await options.address.again();
        relay.setInstalled(true);
        void whenAnswering().catch((e) => portal.log(`could not compare ${app}'s tools: ${(e as Error).message}`));
      } catch (e) {
        error = (e as Error).message;
      } finally {
        pending = false;
        downloading = false;
        progress = "";
      }
    })();
  }

  async function stop(): Promise<void> {
    if (pending) throw new Error("Wait for the setup to finish.");
    const detail = await own();
    if (detail && detail !== "foreign") await docker().containers.stop(names.container);
    error = "";
  }

  /**
   * Removes the container, then its network, with the forwarder or the portal's container taken off it, and with
   * `removeData` the volume with the projects. The image stays: Docker for extensions cannot remove one, and the page
   * says how. The tools leave every chat.
   */
  async function uninstall(removeData: boolean): Promise<void> {
    if (pending) throw new Error("Wait for the setup to finish.");
    pending = true;
    error = "";
    try {
      const d = docker();
      const detail = await own();
      if (detail === "foreign") throw new Error(`A container named ${names.container} is there that is not this extension's. Rename or remove it first.`);
      if (detail) await d.containers.remove(names.container);
      relay.setInstalled(false);
      await d.networks.remove(names.network);
      options.address.forget();
      if (removeData) await d.volumes.remove(names.volume);
    } finally {
      pending = false;
    }
  }

  /**
   * The look every 30 seconds, and once as the half starts: a running container that is stale is made again (in
   * `status`); while the server answers, what it lists is compared with the extension's tools, which the log says
   * where they differ (code the agent ran can change the server); and for one Docker says is running that does not
   * answer, the portal's way to it is asked for again (`networks.reach`), which puts right what is not as it should
   * be: a portal container made again is put on the network, and a forwarder somebody removed or stopped comes back.
   * Nothing is stopped or started for it, so a server that is only slow to start loses nothing. A container somebody
   * stopped is never started here.
   */
  async function maintain(): Promise<void> {
    const now = await status();
    if (now.state === "running") return relay.check();
    // Only these can be running to Docker without answering: one starting, and one Docker starts again after it exited.
    if (now.busy || (now.state !== "starting" && now.state !== "failed")) return;
    const detail = await own();
    if (detail && detail !== "foreign" && detail.State?.Running && !detail.State.Restarting) await options.address.again();
  }

  /** The cards as the probe finds them now, and which the server is, or would be, on. */
  async function hardware(): Promise<Probed & { chosen: string; pinned: boolean; wanted?: string }> {
    const found = await detect();
    const detail = (await docker().available()) ? await own() : undefined;
    const held = detail && detail !== "foreign" ? detail : undefined;
    return { ...found, chosen: names.gpu ? "" : (store.setting("gpu") ?? ""), pinned: Boolean(names.gpu), wanted: wantedCard(held)?.uuid };
  }

  /**
   * The card chosen on the page, by UUID, or "" for the card with the most free memory. A card that is not on the host
   * is refused, and so is any while the host's owner pinned one. A running server is made again on it now (the look in
   * `status` finds it stale), a stopped one at its next Start.
   */
  async function chooseGpu(uuid: string): Promise<{ restarting: boolean }> {
    if (names.gpu) throw new Error("The host fixes the card for this server.");
    if (uuid) {
      const found = probed ?? (await detect());
      if (!found.cards.some((c: Card) => c.uuid === uuid)) throw new Error("That card is not on this host.");
    }
    store.putSettings({ gpu: uuid });
    const now = await status();
    return { restarting: now.busy };
  }

  return { status, install, start: install, stop, uninstall, maintain, hardware, chooseGpu, probed: () => probed };
}

export type Service = ReturnType<typeof service>;
