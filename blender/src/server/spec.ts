import type { ContainerSpec } from "../../../shared/docker-api";
import { namesFrom, type Plan } from "../../../shared/service";
import { version } from "../../package.json";

/**
 * The Blender server's container: what it is called, the image it runs, and what it is made with.
 *
 * The image is published by this repository's release (`blender-v<version>` builds `server/Dockerfile` and pushes it
 * to GHCR), tagged with the package's version, so that an update of the extension is an update of its server. The
 * version is package.json's, which the build bundles into server.js, so a release changes package.json and nothing
 * else. It is pinned by its tag: Docker for extensions splits a reference at its last colon, which a digest would be
 * cut at.
 */
export const VERSION: string = version;
export const IMAGE = `ghcr.io/prometheion/pithagoras-blender:${VERSION}`;

/** The names, each of which the portal's environment can change (`PITHAGORAS_BLENDER_CONTAINER`, `_VOLUME`, `_PORT`, `_IMAGE`, `_GPU`). */
export const names = () => namesFrom(process.env, "blender", { container: "pithagoras-blender", port: 3870, image: IMAGE });

/** Where the OptiX denoiser's weights are, in the driver's files on the host and in the container alike. */
const NVOPTIX = "/usr/share/nvidia/nvoptix.bin";

/**
 * The container for a plan. `NVIDIA_DRIVER_CAPABILITIES=all`: compute for Cycles on OptiX and CUDA, graphics for
 * EEVEE's EGL context. The OptiX weights are bound from the host only where the probe found them there and the
 * container toolkit does not mount them itself: a bind over a file the toolkit mounts would clash, and one from a file
 * that is not there would refuse the create. Without them Blender denoises with OpenImageDenoise. No memory limit, as
 * Blender's needs follow the scene.
 *
 * Blender runs the Python the agent writes, so it is held to what Pithagoras' own Docker tools ask of a container the
 * agent runs: the image's own user (`blender`, not root), none of the kernel's capabilities (`CapDrop: ALL`, raw
 * sockets among them), and no way to gain more (`no-new-privileges`). Its network is the extension's own, with no way
 * out (`plan.network`), so the code Blender runs reaches nothing but the server, and, for a portal in a container of
 * its own, what is listened for on 0.0.0.0 in that container's network namespace (the README says what); the server
 * listens on 0.0.0.0 of the container's own network, which only the portal reaches. The GPU needs none of the capabilities: the container
 * toolkit hands the card's devices to the container as it starts.
 */
export function blenderSpec(plan: Plan, port: number, volume: string, image: string): ContainerSpec {
  return {
    Image: image,
    Tty: true,
    Env: [`BLENDER_SERVER_TOKEN=${plan.token}`, "BLENDER_SERVER_HOST=0.0.0.0", `BLENDER_SERVER_PORT=${port}`, "NVIDIA_DRIVER_CAPABILITIES=all"],
    HostConfig: {
      NetworkMode: plan.network,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Binds: [`${volume}:/data`],
      Mounts: plan.optix === "host" ? [{ Type: "bind", Source: NVOPTIX, Target: NVOPTIX, ReadOnly: true }] : [],
      DeviceRequests: plan.card ? [{ Driver: "nvidia", DeviceIDs: [plan.card.uuid], Capabilities: [["gpu"]] }] : [],
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } },
    },
  };
}
