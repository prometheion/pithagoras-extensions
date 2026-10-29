/**
 * The containers of the Nextcloud MCP server, one per instance: who each is, how it is made, and when it must be
 * made anew -- and the ones already running that an instance adopts by name instead.
 *
 * A container this extension makes runs on the portal's own loopback (Docker for extensions' sharedNetwork), not on
 * an isolated network: it must reach the person's Nextcloud host across the machine's usual networking, which a
 * container with no way out cannot do. There it serves its /mcp endpoint to the portal alone, bound to 127.0.0.1 of
 * that shared namespace -- not on every interface, so nothing but the portal reaches it. The image's entry point
 * already runs `nextcloud-mcp-server run --host 0.0.0.0` (for its Kubernetes chart); the `--host 127.0.0.1 --port`
 * appended to the command line takes the place of that and says on which port, as click reads an option named twice
 * and keeps the last. Where several instances keep their own containers, each listens on its own port of that loopback.
 *
 * An adopted container is one that ran before this extension took note of it: the person started it themselves, for
 * pi's own mcp.json as much as for anything else. All this extension does with it is say where its /mcp endpoint
 * stands and name how it runs; it is never made again, pulled, changed or removed by this extension -- that goes for
 * the ones it adopted as much as for any container of another's, and only the ones it made itself get the life of a
 * container made: remade where its environment no longer matches, started where it stopped, taken away where its
 * instance went. Docker for extensions' API lists nothing but what is its own, so finding the candidates to adopt is
 * by the machine's own docker CLI, as that helper does with the socket itself.
 */
import { execFile } from "node:child_process";
import type { Docker } from "../../shared/docker-api";
import { NextcloudInstance, DEFAULT_INSTANCE_NAME, isAdopted, adoptedName } from "./config";
import { ownName } from "./host";

/** The image by its release tag: what latest pointed to when this version was made (v0.202.2, 2026-10-28), and
 * what it is tested with. Pinned so an update of the server's own code is the person's choice, not a pull. */
export const IMAGE = "ghcr.io/cbcoutinho/nextcloud-mcp-server:v0.202.2";

/** What discovery looks for: every tag of the image, the pinned one as much as a :latest someone runs in the field. */
export const IMAGE_PREFIX = IMAGE.split(":")[0];

/** The name an own container stands under by its default, and how each instance's is made from it: the base for the
 * instance an earlier version carried, the base with its slug of the instance's name beside (overridable as every
 * other thing of this extension is, by its environment). */
export const CONTAINER_BASE = process.env.PITHAGORAS_NEXTCLOUD_CONTAINER?.trim() || "pithagoras-nextcloud-mcp";

/** Where an own container's server listens within the shared network namespace: loopback only, on the base port --
 * each further own instance takes the next one above it. */
export const PORT = Number(process.env.PITHAGORAS_NEXTCLOUD_PORT?.trim()) > 0 ? Number(process.env.PITHAGORAS_NEXTCLOUD_PORT) : 8000;

/** The /mcp address of an own container, on the loopback of the shared network namespace at its port. */
export const ownAddress = (port: number): string => `http://127.0.0.1:${port}/mcp`;

/** A slug of an instance's name for a container name beside: what Docker takes, lowercase and dashed. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** How an own instance stands where the list of instances says it does: its container by its name, and the loopback
 * port of its server. A port that is already saved with the instance (see planOwn's caller keep it there) stands as
 * long as it is a real port no other instance claims; the rest take the lowest free ports at and above the base.
 * Adding, removing or reordering the others then does not shift what already stands -- a container is remade where
 * its own data changed, never where its neighbor went. The name of the one an earlier version carried stands as it
 * did, the rest get their slug of the instance's name beside the base -- and two slugs that came to one stand apart
 * by number. */
export interface OwnPlan {
  inst: NextcloudInstance;
  containerName: string;
  port: number;
}

function place(plans: Map<string, OwnPlan>, takenNames: Set<string>, takenPorts: Set<number>, inst: NextcloudInstance, port: number): void {
  let name = inst.name === DEFAULT_INSTANCE_NAME ? CONTAINER_BASE : `${CONTAINER_BASE}-${slug(inst.name) || "extra"}`;
  while (takenNames.has(name)) name = `${name}-${plans.size + 1}`; // two slugs that came to one: apart by number
  takenNames.add(name);
  takenPorts.add(port);
  plans.set(inst.name, { inst, containerName: name, port });
}

export function planOwn(insts: NextcloudInstance[]): Map<string, OwnPlan> {
  const plans = new Map<string, OwnPlan>();
  const takenNames = new Set<string>();
  const takenPorts = new Set<number>();
  const unplaced: NextcloudInstance[] = [];
  for (const inst of insts) {
    if (isAdopted(inst.container)) continue;
    const port = typeof inst.port === "number" && Number.isInteger(inst.port) && inst.port > 0 && inst.port <= 65535 ? inst.port : undefined;
    if (port === undefined || takenPorts.has(port)) unplaced.push(inst); // its saved port is not one it may keep: a fresh one below
    else place(plans, takenNames, takenPorts, inst, port);
  }
  for (const inst of unplaced) {
    let port = PORT;
    while (takenPorts.has(port)) port++;
    if (port > 65535) throw new Error(`Too many own containers: the ports above ${PORT} run out.`);
    place(plans, takenNames, takenPorts, inst, port);
  }
  return plans;
}

/** How an own container is made from its instance: image, environment (the host and the login), command and network. */
export async function makeSpec(docker: Docker, inst: NextcloudInstance, port: number): Promise<Record<string, unknown>> {
  const networkMode = await docker.sharedNetwork();
  return {
    Image: IMAGE,
    Env: [
      `NEXTCLOUD_HOST=${inst.url}`,
      `NEXTCLOUD_USERNAME=${inst.username}`,
      `NEXTCLOUD_PASSWORD=${inst.password}`,
    ],
    Cmd: ["--host", "127.0.0.1", "--port", String(port)],
    HostConfig: { NetworkMode: networkMode },
  };
}

/** A container that stands in a name: taken as its own where this extension made it, refused anywhere else. One that
 * is nobody's is never taken over on the way past -- adopting somebody else's container by accident would end in a
 * remake of theirs. */
async function claim(docker: Docker, name: string): Promise<boolean> {
  const found = await docker.containers.get(name);
  if (!found) return false;
  if (found.owner !== ownName())
    throw new Error(`A container named ${name} is not this extension's${found.owner ? ` -- it is ${found.owner}'s` : " and no one's"}. Rename or remove it first, or adopt it on purpose on the Nextcloud page in Settings.`);
  return true;
}

/**
 * Bring an own container to where its instance asks for it: made (or remade where its environment, command or network
 * is no longer what the instance says) and running. What an answer of sharedNetwork says that changes -- a portal's
 * container made again, with a new namespace id -- makes the old one not match, so it is remade then as well.
 */
export async function ensureOwn(docker: Docker, plan: OwnPlan): Promise<void> {
  if (!docker) throw new Error("Docker for extensions is not available to this portal");
  const { inst, containerName, port } = plan;
  await docker.images.ensure(IMAGE);
  const spec = (await makeSpec(docker, inst, port)) as { Image: string; Env: string[]; Cmd: string[] } & Record<string, unknown>;
  const exists = await claim(docker, containerName);
  if (exists) {
    const inspect = (await docker.containers.inspect(containerName)) as
      | { Config?: { Env?: string[]; Cmd?: string[] | null }; HostConfig?: { NetworkMode?: unknown } }
      | undefined;
    const envWantsSame = JSON.stringify(inspect?.Config?.Env ?? []) === JSON.stringify(spec.Env);
    const cmdWantsSame = JSON.stringify(inspect?.Config?.Cmd ?? null) === JSON.stringify(spec.Cmd);
    const wantedNetwork = (spec.HostConfig as { NetworkMode?: unknown } | undefined)?.NetworkMode;
    const networkWantsSame = inspect?.HostConfig?.NetworkMode === wantedNetwork;
    if (envWantsSame && cmdWantsSame && networkWantsSame) {
      const state = await docker.containers.get(containerName);
      if (!state || state.state !== "running") await docker.containers.start(containerName);
      return;
    }
    // What it runs is no longer what the instance says: remake it. Docker's update takes the policy and resources,
    // not the environment -- there is no way to change it in place.
    await releaseOwn(docker, containerName);
  }
  await docker.containers.create(containerName, spec);
  await docker.containers.start(containerName);
}

/** An own container gone, stopped where it ran; nothing where there was none already -- and never one of another's. */
export async function releaseOwn(docker: Docker, name: string): Promise<void> {
  try {
    const found = await docker.containers.get(name);
    if (!found) return;
    if (found.owner !== "" && found.owner !== ownName()) return; // not ours to take away
    await docker.containers.stop(name);
    await docker.containers.remove(name);
  } catch {
    // a container that is gone already is gone
  }
}

/** How a container stands: absent, or by Docker's word for its state (created, running, exited, ...). By name, and
 * for names of containers this extension never made -- an adopted one asks how it runs. */
export async function containerState(docker: Docker | undefined, name: string): Promise<string> {
  if (!docker) return "unavailable";
  try {
    const found = await docker.containers.get(name);
    return found ? found.state : "absent";
  } catch {
    return "unavailable"; // Docker itself not to be had right now
  }
}

/** A container that runs the image, as the machine's docker knows it: by its name and status, and where it publishes
 * its port 8000 to the loopback -- the /mcp address of an instance that adopted it. */
export interface Discovered {
  name: string;
  image: string;
  status: string; // Docker's own words: "Up 4 days", "Exited (0) ..."
  endpoint?: string; // its /mcp at the loopback, where it publishes port 8000 there
}

/** Where a docker ps line says the container's port 8000 stands on the machine's loopback: its /mcp address. */
function endpointFromPorts(ports: unknown): string | undefined {
  if (typeof ports !== "string") return undefined;
  const match = ports.match(/(?:([\d.]+):)?(\d+)->8000\/tcp/);
  if (!match) return undefined;
  const host = !match[1] || match[1] === "0.0.0.0" ? "127.0.0.1" : match[1];
  return `http://${host}:${match[2]}/mcp`;
}

/**
 * The containers that run the image, running and stopped alike: by their own CLI's words, as Docker for extensions'
 * API lists only what is its own and a candidate to adopt is never one of those. A failed read of the machine says so
 * in the error, nothing more -- discovery then stands where it stood before, empty.
 */
export async function discover(): Promise<Discovered[]> {
  const { stdout } = await execFile("docker", ["ps", "-a", "--format", "{{json .}}"], { timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
  const raw = typeof stdout === "string" ? stdout : String(stdout ?? ""); // the type says string, this keeps it honest at runtime too
  const out: Discovered[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue; // not a line docker gives: over it
    }
    const image = typeof row.Image === "string" ? row.Image : "";
    if (!image.startsWith(IMAGE_PREFIX)) continue;
    const name = typeof row.Names === "string" ? row.Names.replace(/^\//, "") : "";
    if (!name) continue;
    out.push({ name, image, status: typeof row.Status === "string" ? row.Status : "", endpoint: endpointFromPorts(row.Ports) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A read of discovery that says what it could not where it could not: the list, or an error of its own. */
export async function discoverSafe(): Promise<{ containers: Discovered[]; error?: string }> {
  try {
    return { containers: await discover() };
  } catch (error) {
    return { containers: [], error: (error as Error).message };
  }
}

/** The /mcp address of an instance where it stands at all: the own one on its loopback port, the adopted one where
 * discovery found its published port. */
export function instanceAddress(plans: Map<string, OwnPlan>, discovered: Discovered[], inst: NextcloudInstance): string | undefined {
  if (isAdopted(inst.container)) return discovered.find((c) => c.name === adoptedName(inst.container))?.endpoint;
  const plan = plans.get(inst.name);
  return plan ? ownAddress(plan.port) : undefined;
}
