/**
 * The container of the Nextcloud MCP server: who it is, how it is made, and when it must be made anew.
 *
 * It runs on the portal's own loopback (Docker for extensions' sharedNetwork), not on an isolated network: it
 * must reach the person's Nextcloud host across the machine's usual networking, which a container with no way out
 * cannot do. There it serves its /mcp endpoint to the portal alone, bound to 127.0.0.1 of that shared namespace --
 * not on every interface, so nothing but the portal reaches it. The image's entry point already runs
 * `nextcloud-mcp-server run --host 0.0.0.0` (for its Kubernetes chart); a `--host 127.0.0.1` appended to the
 * command line takes the place of that, as click reads an option named twice and keeps the last.
 */
import type { Docker } from "../../shared/docker-api";
import { NextcloudSettings } from "./config";
import { ownName } from "./host";

/** The image by its release tag: what latest pointed to when this version was made (v0.202.2, 2026-10-28), and
 * what it is tested with. Pinned so an update of the server's own code is the person's choice, not a pull. */
export const IMAGE = "ghcr.io/cbcoutinho/nextcloud-mcp-server:v0.202.2";

/** The container by its name (overridable as every other thing of this extension is, by its environment). */
export const CONTAINER_NAME = process.env.PITHAGORAS_NEXTCLOUD_CONTAINER?.trim() || "pithagoras-nextcloud-mcp";

/** Where the server listens within the shared network namespace: loopback only, on the image's default port. */
export const PORT = Number(process.env.PITHAGORAS_NEXTCLOUD_PORT?.trim()) > 0 ? Number(process.env.PITHAGORAS_NEXTCLOUD_PORT) : 8000;
const CMD_EXTRA = ["--host", "127.0.0.1"];

/** The address the portal reaches the /mcp endpoint at: on the machine's own loopback, or that of its container. */
export const serverAddress = (): string => `http://127.0.0.1:${PORT}/mcp`;

/** How the container is made from the settings: image, environment (the host and the login), command and network. */
export async function makeSpec(docker: Docker, s: NextcloudSettings): Promise<Record<string, unknown>> {
  const networkMode = await docker.sharedNetwork();
  return {
    Image: IMAGE,
    Env: [
      `NEXTCLOUD_HOST=${s.url}`,
      `NEXTCLOUD_USERNAME=${s.username}`,
      `NEXTCLOUD_PASSWORD=${s.password}`,
    ],
    Cmd: CMD_EXTRA,
    HostConfig: { NetworkMode: networkMode },
  };
}

/** A container that stands in the name: taken over where it is nobody's, refused as one with a name of another. */
async function claim(docker: Docker): Promise<boolean> {
  const found = await docker.containers.get(CONTAINER_NAME);
  if (!found) return false;
  if (found.owner === "") await docker.containers.adopt(CONTAINER_NAME);
  else if (found.owner !== ownName()) throw new Error(`A container named ${CONTAINER_NAME} is ${found.owner}'s, not Nextcloud's. Rename or remove it first.`);
  return true;
}

/**
 * Bring the container to where the settings ask for it: made (or remade where its environment or network is no
 * longer what these settings say) and running. What an answer of sharedNetwork says that changes -- a portal's
 * container made again, with a new namespace id -- makes the old one not match, so it is remade then as well.
 */
export async function ensureContainer(docker: Docker, s: NextcloudSettings): Promise<void> {
  if (!docker) throw new Error("Docker for extensions is not available to this portal");
  await docker.images.ensure(IMAGE);
  const spec = (await makeSpec(docker, s)) as { Image: string; Env: string[] } & Record<string, unknown>;
  const exists = await claim(docker);
  if (exists) {
    const inspect = (await docker.containers.inspect(CONTAINER_NAME)) as
      | { Config?: { Env?: string[] }; HostConfig?: { NetworkMode?: unknown } }
      | undefined;
    const envWantsSame = JSON.stringify(inspect?.Config?.Env ?? []) === JSON.stringify(spec.Env);
    const wantedNetwork = (spec.HostConfig as { NetworkMode?: unknown } | undefined)?.NetworkMode;
    const networkWantsSame = inspect?.HostConfig?.NetworkMode === wantedNetwork;
    if (envWantsSame && networkWantsSame) {
      const state = await docker.containers.get(CONTAINER_NAME);
      if (!state || state.state !== "running") await docker.containers.start(CONTAINER_NAME);
      return;
    }
    // What it runs is no longer what the settings say: remake it. Docker's update takes the policy and resources,
    // not the environment -- there is no way to change it in place.
    await removeContainer(docker);
  }
  await docker.containers.create(CONTAINER_NAME, spec);
  await docker.containers.start(CONTAINER_NAME);
}

/** The container gone, stopped where it ran; nothing where there was none already -- and never one of another's. */
export async function removeContainer(docker: Docker): Promise<void> {
  try {
    const found = await docker.containers.get(CONTAINER_NAME);
    if (!found) return;
    if (found.owner !== "" && found.owner !== ownName()) return; // not ours to take away
    await docker.containers.stop(CONTAINER_NAME);
    await docker.containers.remove(CONTAINER_NAME);
  } catch {
    // a container that is gone already is gone
  }
}

/** How it stands: absent, or by Docker's word for its state (created, running, exited, ...). */
export async function containerState(docker: Docker | undefined): Promise<string> {
  if (!docker) return "unavailable";
  try {
    const found = await docker.containers.get(CONTAINER_NAME);
    return found ? found.state : "absent";
  } catch {
    return "unavailable"; // Docker itself not to be had right now
  }
}
