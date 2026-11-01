/**
 * The containers of the Nextcloud MCP server, one per instance: who each is, how it is made, and when it must be
 * made anew. Every instance holds its own container -- as understory's does for itself: the extension makes it,
 * keeps it, and takes it away where its instance went.
 *
 * A container this extension makes runs on the portal's own loopback (Docker for extensions' sharedNetwork), not on
 * an isolated network: it must reach the person's Nextcloud host across the machine's usual networking, which a
 * container with no way out cannot do. There it serves its /mcp endpoint on 127.0.0.1 of that shared namespace --
 * not on every interface. For a portal on the machine itself that namespace is the machine's: the endpoint is then
 * reachable by every local process, and it checks nobody (the server has no login of its own in this mode, and
 * a token in front of it would be as reachable as it is -- the README says so). What keeps the damage down is what
 * the portal does with it: the person is asked before mail goes out, a link is made, something is shared or deleted
 * (the `approveTools` of its entry), and the container is made without capabilities, with limits.
 * The image's entry point already runs `nextcloud-mcp-server run --host 0.0.0.0` (for its Kubernetes chart); the
 * `--host 127.0.0.1 --port` appended to the command line takes the place of that and says on which port, as click
 * reads an option named twice and keeps the last. Where several instances keep their containers, each listens on
 * its own port of that loopback.
 */
import type { ContainerSpec, Docker } from "../../shared/docker-api";
import { SPEC_LABEL, stamped } from "../../shared/service";
import { NextcloudInstance, DEFAULT_INSTANCE_NAME } from "./config";
import { ownName } from "./host";

/** The image by its release tag: what latest pointed to when this version was made (0.203.0, 2026-10-29), and
 * what it is tested with. It is downloaded by this tag (Docker for extensions takes an image by its tag), and a
 * container is made from the digest below: a tag that is pushed again, to another build, is not run -- the next
 * Start downloads it again and refuses. The tags on GHCR carry no v prefix, whatever the project's releases call themselves. */
export const IMAGE = "ghcr.io/cbcoutinho/nextcloud-mcp-server:0.203.0";
/** What the tag named on 2026-11-01 (the image index, read from the registry). A container is made from this. */
export const IMAGE_DIGEST = "sha256:e021187a3f87acfe5e3f9b460a4f8a04932f9ed2fcd9490a8a27bf4780e24fe1";
export const IMAGE_BY_DIGEST = `${IMAGE.slice(0, IMAGE.lastIndexOf(":"))}@${IMAGE_DIGEST}`;

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
 * port of its server. A port and a container name that are already saved with the instance stand as long as they
 * are real and no other instance claims them; the rest take the lowest free ports at and above the base, and a
 * name from the slug of the instance's name beside the base (two slugs that came to one stand apart by number). The
 * name of the default instance is the base itself. Adding, removing or reordering the others then does not shift or
 * rename what already stands -- a container is remade where its own data changed, never where its neighbor went. */
export interface OwnPlan {
  inst: NextcloudInstance;
  containerName: string;
  port: number;
}

/** Whether a saved container name is one this extension may have given: the base, or the base and a dash. */
const isOwnName = (name: string | undefined): name is string =>
  typeof name === "string" && (name === CONTAINER_BASE || (name.startsWith(`${CONTAINER_BASE}-`) && /^[a-z0-9][a-z0-9_.-]*$/.test(name)));

function freshName(takenNames: Set<string>, inst: NextcloudInstance): string {
  let name = inst.name === DEFAULT_INSTANCE_NAME ? CONTAINER_BASE : `${CONTAINER_BASE}-${slug(inst.name) || "extra"}`;
  if (takenNames.has(name)) { // two slugs that came to one: apart by number
    let n = 2;
    while (takenNames.has(`${name}-${n}`)) n++;
    name = `${name}-${n}`;
  }
  return name;
}

export function planOwn(insts: NextcloudInstance[]): Map<string, OwnPlan> {
  const plans = new Map<string, OwnPlan>();
  const takenNames = new Set<string>();
  const takenPorts = new Set<number>();
  // The names that stand saved are reserved first, so that a new instance whose slug comes to the same cannot take one.
  const named = new Map<string, string>();
  for (const inst of insts) {
    if (isOwnName(inst.container) && !takenNames.has(inst.container)) {
      named.set(inst.name, inst.container);
      takenNames.add(inst.container);
    }
  }
  const place = (inst: NextcloudInstance, port: number): void => {
    const name = named.get(inst.name) ?? freshName(takenNames, inst);
    takenNames.add(name);
    takenPorts.add(port);
    plans.set(inst.name, { inst, containerName: name, port });
  };
  const unplaced: NextcloudInstance[] = [];
  for (const inst of insts) {
    const port = typeof inst.port === "number" && Number.isInteger(inst.port) && inst.port > 0 && inst.port <= 65535 ? inst.port : undefined;
    if (port === undefined || takenPorts.has(port)) unplaced.push(inst); // its saved port is not one it may keep: a fresh one below
    else place(inst, port);
  }
  for (const inst of unplaced) {
    let port = PORT;
    while (takenPorts.has(port)) port++;
    if (port > 65535) throw new Error(`Too many own containers: the ports above ${PORT} run out.`);
    place(inst, port);
  }
  return plans;
}

/** What the server may use: a WebDAV read pulls a file in as base64, and the Python server holds it whole. */
const MEMORY = 1024 ** 3;

/** How an own container is made from its instance: the image by its digest, environment (the host and the login),
 * command and network -- with no capability, no new privileges, a memory, process and log limit, and Docker's
 * restart policy (`stamped`), and the hash of all of it as its label. */
export async function makeSpec(docker: Docker, inst: NextcloudInstance, port: number): Promise<ContainerSpec> {
  const networkMode = await docker.sharedNetwork();
  return stamped({
    Image: IMAGE_BY_DIGEST,
    Env: [
      `NEXTCLOUD_HOST=${inst.url}`,
      `NEXTCLOUD_USERNAME=${inst.username}`,
      `NEXTCLOUD_PASSWORD=${inst.password}`,
    ],
    Cmd: ["--host", "127.0.0.1", "--port", String(port)],
    HostConfig: {
      NetworkMode: networkMode,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Memory: MEMORY,
      PidsLimit: 256,
      LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } },
    },
  });
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
 * Bring an own container to where its instance asks for it: made (or remade where what it was made with is no longer
 * what the instance says) and running. "What it was made with" is the hash of its spec, kept as a label: Docker's
 * inspect shows the environment with the image's own variables merged in, in another order, so a comparison of that
 * would never hold. A portal's container made again, with a new namespace id, changes the network and so the hash.
 * Says whether it was made anew.
 */
export async function ensureOwn(docker: Docker, plan: OwnPlan): Promise<boolean> {
  if (!docker) throw new Error("Docker for extensions is not available to this portal");
  const { inst, containerName, port } = plan;
  await docker.images.ensure(IMAGE);
  if (!(await docker.images.present(IMAGE_BY_DIGEST)))
    throw new Error(`${IMAGE} is not the build this version of the extension runs (${IMAGE_DIGEST}): it is not started.`);
  const spec = await makeSpec(docker, inst, port);
  const wanted = (spec.Labels as Record<string, string>)[SPEC_LABEL];
  const exists = await claim(docker, containerName);
  if (exists) {
    const inspect = (await docker.containers.inspect(containerName)) as { Config?: { Labels?: Record<string, string> | null } } | undefined;
    if (inspect?.Config?.Labels?.[SPEC_LABEL] === wanted) {
      const state = await docker.containers.get(containerName);
      if (!state || state.state !== "running") await docker.containers.start(containerName);
      return false;
    }
    // What it was made with is no longer what the instance says: remake it. Docker's update takes the policy and
    // resources, not the environment -- there is no way to change it in place.
    await releaseOwn(docker, containerName);
  }
  await docker.containers.create(containerName, spec);
  await docker.containers.start(containerName);
  return true;
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
