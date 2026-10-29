/**
 * The containers of the Nextcloud MCP server, one per instance: who each is, how it is made, and when it must be
 * made anew. Every instance holds its own container -- as understory's does for itself: the extension makes it,
 * keeps it, and takes it away where its instance went.
 *
 * A container this extension makes runs on the portal's own loopback (Docker for extensions' sharedNetwork), not on
 * an isolated network: it must reach the person's Nextcloud host across the machine's usual networking, which a
 * container with no way out cannot do. There it serves its /mcp endpoint to the portal alone, bound to 127.0.0.1 of
 * that shared namespace -- not on every interface, so nothing but the portal reaches it. The image's entry point
 * already runs `nextcloud-mcp-server run --host 0.0.0.0` (for its Kubernetes chart); the `--host 127.0.0.1 --port`
 * appended to the command line takes the place of that and says on which port, as click reads an option named twice
 * and keeps the last. Where several instances keep their containers, each listens on its own port of that loopback.
 */
import type { Docker } from "../../shared/docker-api";
import { NextcloudInstance, DEFAULT_INSTANCE_NAME } from "./config";
import { ownName } from "./host";

/** The image by its release tag: what latest pointed to when this version was made (0.203.0, 2026-10-29), and
 * what it is tested with. Pinned so an update of the server's own code is the person's choice, not a pull. The tags
 * on GHCR carry no v prefix, whatever the project's releases call themselves. */
export const IMAGE = "ghcr.io/cbcoutinho/nextcloud-mcp-server:0.203.0";

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

/** How each instance stands where the list of instances says it does: its container by its name, and the loopback
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
 * is nobody's is never taken over on the way past -- claiming somebody else's container by accident would end in a
 * remake of theirs. */
async function claim(docker: Docker, name: string): Promise<boolean> {
  const found = await docker.containers.get(name);
  if (!found) return false;
  if (found.owner !== ownName())
    throw new Error(`A container named ${name} is not this extension's${found.owner ? ` -- it is ${found.owner}'s` : " and no one's"}. Rename or remove it first.`);
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

/** How a container stands: absent, or by Docker's word for its state (created, running, exited, ...). */
export async function containerState(docker: Docker | undefined, name: string): Promise<string> {
  if (!docker) return "unavailable";
  try {
    const found = await docker.containers.get(name);
    return found ? found.state : "absent";
  } catch {
    return "unavailable"; // Docker itself not to be had right now
  }
}

/** The /mcp address of an instance where it stands at all: its loopback port, once a plan says where its container
 * should hold. */
export function instanceAddress(plans: Map<string, OwnPlan>, inst: NextcloudInstance): string | undefined {
  const plan = plans.get(inst.name);
  return plan ? ownAddress(plan.port) : undefined;
}
