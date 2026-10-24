import { setTimeout as delay } from "node:timers/promises";
import type { Docker } from "./docker-api";

/**
 * The GPUs a container can be given, as Docker's NVIDIA runtime hands them out, read in a short-lived container of
 * the extension's own (`<container>-probe`): the portal may run in a container itself, with no nvidia-smi of its own,
 * and the card that matters is the one Docker can give, not the one the portal's machine lists. Voice reads its cards
 * the same way.
 *
 * The probe runs nvidia-smi and looks for the OptiX denoiser's weights (`nvoptix.bin`), which come with the NVIDIA
 * driver: Blender's OptiX denoiser needs them, and the container toolkit does not always mount them. The host's
 * `/usr/share` is bound read-only at `/host-share` for that look, as `/usr/share` exists on every Linux host; binding
 * `/usr/share/nvidia` would make that folder on a host that lacks it.
 */

/** A card, as nvidia-smi reads it in the probe. Memory in MiB. */
export interface Card {
  /** The card's index as the probe saw it: inside a probe given one card, that card is 0. */
  index: number;
  uuid: string;
  name: string;
  usedMiB: number | null;
  totalMiB: number | null;
}

/**
 * Where the OptiX weights are: mounted by the container toolkit itself (`toolkit`), only on the host (`host`, so the
 * server's container binds them), or nowhere (`none`, so Blender denoises with OpenImageDenoise).
 */
export type Optix = "toolkit" | "host" | "none";

export interface Probed {
  cards: Card[];
  optix: Optix;
  /** Why no card was found, where none was: Docker's or nvidia-smi's own words. Empty where cards were found. */
  error: string;
}

/** The image the probe runs in: the base the servers' images are built from, so it is there once a server is. */
export const PROBE_IMAGE = "ubuntu:24.04";

export const SMI_QUERY = "nvidia-smi --query-gpu=index,uuid,name,memory.used,memory.total --format=csv,noheader,nounits";

/** What the probe runs: the cards, then where the OptiX weights are. */
export const PROBE_SCRIPT = [
  SMI_QUERY,
  "test -f /usr/share/nvidia/nvoptix.bin && echo OPTIX=toolkit",
  "test -f /host-share/nvidia/nvoptix.bin && echo OPTIX=host",
  "true",
].join("; ");

/** What the probe printed: one card a line, then the OptiX lines. A line of another shape is skipped. */
export function parseProbe(output: string): { cards: Card[]; optix: Optix } {
  const cards: Card[] = [];
  let toolkit = false;
  let host = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "OPTIX=toolkit") toolkit = true;
    else if (line === "OPTIX=host") host = true;
    else {
      const fields = line.split(",").map((f) => f.trim());
      if (fields.length < 5 || !/^\d+$/.test(fields[0]) || !fields[1].startsWith("GPU-")) continue;
      const memory = (value: string) => (/^\d+$/.test(value) ? Number(value) : null);
      // A name with a comma in it keeps it: the memory figures are the last two fields.
      cards.push({ index: Number(fields[0]), uuid: fields[1], name: fields.slice(2, -2).join(", "), usedMiB: memory(fields.at(-2)!), totalMiB: memory(fields.at(-1)!) });
    }
  }
  // The toolkit's own mount is used whatever the host has: a bind over it would clash.
  return { cards, optix: toolkit ? "toolkit" : host ? "host" : "none" };
}

/** The card with the most free memory; a card whose memory could not be read counts as having none free. */
export function mostFree(cards: readonly Card[]): Card | undefined {
  const free = (c: Card) => (c.totalMiB ?? 0) - (c.usedMiB ?? c.totalMiB ?? 0);
  return [...cards].sort((a, b) => free(b) - free(a))[0];
}

/**
 * Docker's, the toolkit's and nvidia-smi's own words for there being no GPU to give a container: no NVIDIA runtime, no
 * driver, no device. Voice tells them apart the same way.
 */
const NO_GPU = /could not select device driver|unknown or invalid runtime name: nvidia|nvml error|driver not loaded|no devices were found|couldn't communicate with the nvidia driver|load library failed: libnvidia-ml|nvidia-smi: not found|executable file not found/i;
export const isNoGpu = (message: string) => NO_GPU.test(message);

/** Of Docker's inspect body, what the probe reads. */
type Inspected = { State?: { Running?: boolean; ExitCode?: number } };

/**
 * Runs the probe once: `name` is its container, `pinned` a card the host's owner pinned (a UUID or an index), which is
 * then the only one it asks for. Docker refusing the GPU request, or nvidia-smi finding none, is "no GPU", not a
 * failure; and so is Docker refusing a probe that asks for a pinned card alone, which is that card not being there
 * (`nvidia-container-cli: device error: 7: unknown device`), with Docker's words. The probe's container is removed
 * afterwards, whatever came of it.
 */
export async function probe(docker: Docker, name: string, pinned?: string): Promise<Probed> {
  await docker.images.ensure(PROBE_IMAGE);
  await docker.containers.create(name, {
    Image: PROBE_IMAGE,
    Tty: true,
    Cmd: ["sh", "-c", PROBE_SCRIPT],
    // All of the driver's capabilities, as the server's container is given: the toolkit mounts nvoptix.bin for some
    // of them and not for others, and the probe has to see what the server will.
    Env: ["NVIDIA_DRIVER_CAPABILITIES=all"],
    HostConfig: {
      Binds: ["/usr/share:/host-share:ro"],
      DeviceRequests: [{ Driver: "nvidia", ...(pinned ? { DeviceIDs: [pinned] } : { Count: -1 }), Capabilities: [["gpu"]] }],
    },
  });
  try {
    try {
      await docker.containers.start(name);
    } catch (e) {
      if (pinned || isNoGpu((e as Error).message)) return { cards: [], optix: "none", error: (e as Error).message };
      throw e;
    }
    // Until it has exited: Docker's own wait is not one an extension is given.
    const until = Date.now() + 30_000;
    let state: Inspected["State"];
    while ((state = ((await docker.containers.inspect(name)) as Inspected | undefined)?.State)?.Running) {
      if (Date.now() > until) throw new Error("nvidia-smi did not end in time");
      await delay(200);
    }
    const output = (await docker.containers.logs(name)).replace(/\r/g, "");
    const found = parseProbe(output);
    if (!found.cards.length) return { ...found, optix: "none", error: output.trim().split("\n")[0] || "nvidia-smi listed no GPU" };
    return { ...found, error: "" };
  } finally {
    await docker.containers.remove(name).catch(() => {});
  }
}
