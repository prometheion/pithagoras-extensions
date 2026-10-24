import type { ContainerSpec } from "../../../shared/docker-api";
import { namesFrom, type Plan } from "../../../shared/service";
import type { Display } from "../displays";
import { version } from "../../package.json";

/**
 * What the Godot server's container is: its image, its names, its port and the spec it is made with.
 *
 * The image is published by this repository's release workflow, built from godot/server/ (its Dockerfile), and tagged
 * with the package's version, package.json's, which the build bundles into lib/server.js, so a release changes
 * package.json and nothing else: an update of the extension is an update of the image, and the container is made again
 * from it (shared/service.ts, the stale rule). It is pinned by its tag, not a digest: Docker for extensions splits an
 * image's name at its last ':'.
 */
export const VERSION: string = version;
export const IMAGE = `ghcr.io/prometheion/pithagoras-godot:${VERSION}`;

/**
 * The names and the port, each as the portal's environment says it where it does: `PITHAGORAS_GODOT_CONTAINER`,
 * `_VOLUME`, `_PORT`, `_IMAGE` and `_GPU` (a card's UUID or index, which is then the only card it is given). They are
 * for a second portal on the same Docker daemon, for tests, and for a host owner who keeps it off a card.
 */
export const names = () => namesFrom(process.env, "godot", { container: "pithagoras-godot", port: 3880, image: IMAGE });

/**
 * The container for a plan, as the live godot-server's compose made it: an init that reaps the editor's and the games'
 * children, 1 GiB of shared memory, at most 8 GiB of memory, and no core files (a Godot crash dump is 0.3-1.3 GB). On
 * the extension's own network, with no way out (`plan.network`), where the server listens on 0.0.0.0 of the
 * container's own network, which only the portal reaches; Docker restarts it unless the person stopped it (the
 * service adds the policy). Its projects are in a named volume at /data. The card by Docker's own request, with every
 * driver capability: graphics for Vulkan and EGL, compute, and utility for nvidia-smi. The stream is encoded on the
 * CPU (x264): NVENC wants the first GPU's device node in a container that may see only another card.
 *
 * What runs in it is the agent's as much as the server's: GDScript it sends, `@tool` scripts and games it writes. So it
 * runs as the image's own user (godot, uid 10001), not root, with no Linux capabilities at all (`CapDrop: ALL`: Xvfb,
 * Selkies and the editor need none) and no way to gain one (`no-new-privileges`, which a setuid program would
 * otherwise get round). Its network has no way out, so what runs in it reaches nothing but the server, and, for a
 * portal in a container of its own, what is listened for on 0.0.0.0 in that container's network namespace (the README
 * says what).
 */
export function godotSpec(plan: Plan, server: { port: number; volume: string; image: string; display: Display }): ContainerSpec {
  return {
    Image: server.image,
    User: "10001:10001",
    Tty: true,
    Env: [`GODOT_SERVER_TOKEN=${plan.token}`, "GODOT_SERVER_HOST=0.0.0.0", `GODOT_SERVER_PORT=${server.port}`, `DISPLAY_SIZE=${server.display}`, "NVIDIA_DRIVER_CAPABILITIES=all"],
    HostConfig: {
      NetworkMode: plan.network,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Init: true,
      ShmSize: 1024 ** 3,
      Memory: 8 * 1024 ** 3,
      Ulimits: [{ Name: "core", Soft: 0, Hard: 0 }],
      Binds: [`${server.volume}:/data`],
      DeviceRequests: plan.card ? [{ Driver: "nvidia", DeviceIDs: [plan.card.uuid], Capabilities: [["gpu"]] }] : [],
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } },
    },
  };
}
