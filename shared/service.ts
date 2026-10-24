import { createHash } from "node:crypto";
import { readlinkSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { ContainerSpec, Docker } from "./docker-api";
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
 * What the container is made with is hashed into a label of its own (`pithagoras.extension-spec`): everything but its
 * network, which is checked as it is. A container whose label is not the hash of what would be made now (another
 * image after an update, another card) or whose network is not the portal's loopback as it is now (the portal's own
 * container was made again) is stale. A running one is made again at once, the volume kept; a stopped one at its next
 * Start. That is Voice's rule, with a hash for Voice's recipe label.
 *
 * A network that reads the same can still be the wrong one. Docker joins a container made with `container:<portal>`
 * to the portal's network namespace as it starts it, and leaves it there: when the portal's container starts again
 * under the same id (Settings → About → Restart, a crash, `docker restart`), the portal comes up in a namespace of its
 * own, and the server stays in the old one, where nothing of the portal's reaches it. So a server that Docker says is
 * running and that does not answer has the namespace it is in compared with the portal's (`strayed`), and is started
 * again where they differ, which joins it to the portal's as it is now (`rejoin`).
 */

/** The names a service goes by, each one the portal's environment can change: see `namesFrom`. */
export interface Names {
  container: string;
  volume: string;
  /** The short-lived container the GPU probe runs in. */
  probe: string;
  /** The server's port on the portal's loopback. */
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
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : defaults.port,
    image: key("IMAGE") ?? defaults.image,
    ...(key("GPU") ? { gpu: key("GPU") } : {}),
  };
}

/** What a container is made for: the card it is given (none: no GPU), where the OptiX weights are, its network, and its token. */
export interface Plan {
  card?: { uuid: string };
  optix: Optix;
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
  State?: { Running?: boolean; Restarting?: boolean; ExitCode?: number; Error?: string; StartedAt?: string };
  RestartCount?: number;
}

export const SPEC_LABEL = "pithagoras.extension-spec";
const RESTART = { Name: "unless-stopped" };

/** What a spec is hashed by: everything but its network, which is compared as it is. */
export function specHash(spec: ContainerSpec): string {
  const { HostConfig, Labels: _labels, ...rest } = spec as ContainerSpec & { HostConfig?: Record<string, unknown> };
  const { NetworkMode: _network, ...host } = HostConfig ?? {};
  return createHash("sha256").update(JSON.stringify({ ...rest, HostConfig: host })).digest("hex").slice(0, 16);
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
  /** The portal's own network namespace, as Linux names it (`net:[…]`); the tests give their own. */
  netns?: () => string;
}

/** What names the network namespace a process is in, the same in every process in it. */
const NETNS = "/proc/self/ns/net";

export function service(options: ServiceOptions) {
  const { portal, app, names, store, relay, mcp } = options;
  const docker = options.docker;
  const runProbe = options.probe ?? probe;
  const portalNetns = options.netns ?? (() => readlinkSync(NETNS));
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

  async function wantedSpec(detail: Inspected | undefined): Promise<ContainerSpec> {
    const network = await docker().sharedNetwork();
    return stamped(options.spec({ card: wantedCard(detail), optix: wantedOptix(detail), network, token: store.token() }));
  }

  const current = (detail: Inspected, spec: ContainerSpec) =>
    detail.Config?.Labels?.[SPEC_LABEL] === (spec.Labels as Record<string, string>)[SPEC_LABEL] &&
    detail.HostConfig?.NetworkMode === (spec.HostConfig as { NetworkMode?: string }).NetworkMode;

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
        if (!current(detail!, await wantedSpec(detail))) {
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
        const detail = await own();
        if (detail === "foreign") throw new Error(`A container named ${names.container} is there that is not this extension's. Rename or remove it first.`);
        const spec = await wantedSpec(detail);
        if (detail && current(detail, spec)) {
          // One Docker is starting again is running to Docker: stopped first, so this start is a start of its own.
          if (retrying(detail)) await d.containers.stop(names.container);
          await d.containers.start(names.container);
        } else {
          // Made again where it is stale: the volume, with the projects, stays.
          await d.containers.create(names.container, spec);
          await d.containers.start(names.container);
        }
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
   * Removes the container, and with `removeData` the volume with the projects. The image stays: Docker for extensions
   * cannot remove one, and the page says how. The tools leave every chat.
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
      if (removeData) await d.volumes.remove(names.volume);
    } finally {
      pending = false;
    }
  }

  /**
   * Is the server's process in another network namespace than the portal's? Read in the container, which has to be
   * running: the namespace's name is the same in every process in it.
   */
  async function strayed(): Promise<boolean> {
    const read = await docker().containers.exec(names.container, ["readlink", NETNS], { timeoutMs: 10_000 });
    return read.exitCode === 0 && read.output.trim() !== portalNetns();
  }

  /**
   * The server started again, the container and the volume kept, so that Docker joins it to the portal's namespace as
   * it is now. What was not saved in the open scene is lost with the process, as nothing could reach it to save it.
   */
  async function rejoin(): Promise<void> {
    pending = true;
    error = "";
    portal.log(`the ${app} container is in a network namespace the portal is no longer in (the portal's container started again): starting it again`);
    try {
      await docker().containers.stop(names.container);
      await docker().containers.start(names.container);
    } catch (e) {
      error = (e as Error).message;
      return;
    } finally {
      pending = false;
    }
    void whenAnswering().catch((e) => portal.log(`could not compare ${app}'s tools: ${(e as Error).message}`));
  }

  /**
   * The look every 30 seconds, and once as the half starts: a running container that is stale is made again (in
   * `status`); while the server answers, what it lists is compared with the extension's tools, which the log says
   * where they differ (code the agent ran can change the server); and one Docker says is running that does not answer
   * is started again where it is in a namespace the portal is no longer in. A container somebody stopped is never
   * started here.
   */
  async function maintain(): Promise<void> {
    const now = await status();
    if (now.state === "running") return relay.check();
    // Only these can be running to Docker without answering: one starting, and one Docker starts again after it exited.
    if (now.busy || (now.state !== "starting" && now.state !== "failed")) return;
    const detail = await own();
    if (detail && detail !== "foreign" && detail.State?.Running && !detail.State.Restarting && (await strayed())) await rejoin();
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
