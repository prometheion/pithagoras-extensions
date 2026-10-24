import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { blenderSpec, IMAGE, names, VERSION } from "../src/server/spec.ts";
import { namesFrom, specHash, stamped, SPEC_LABEL } from "../../shared/service.ts";

/** What the Blender server's container is made with, and what it is called. */

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const plan = { card: { uuid: "GPU-1b1b1b1b" }, optix: "none" as const, network: "host", token: "t0k" };
const made = (over: Partial<typeof plan> = {}) => stamped(blenderSpec({ ...plan, ...over }, 3870, "pithagoras-blender-data", IMAGE)) as any;

test("the image is the one the release publishes for this version of the package", () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(IMAGE, `ghcr.io/prometheion/pithagoras-blender:${pkg.version}`);
});

test("the container gets the card by its UUID, and none without one", () => {
  assert.deepEqual(made().HostConfig.DeviceRequests, [{ Driver: "nvidia", DeviceIDs: ["GPU-1b1b1b1b"], Capabilities: [["gpu"]] }]);
  assert.deepEqual(made({ card: undefined }).HostConfig.DeviceRequests, []);
});

test("it is on the network it is given, comes back unless stopped, and has its token, port, volume and log limits", () => {
  const spec = made({ network: "container:abc" });
  assert.equal(spec.HostConfig.NetworkMode, "container:abc");
  assert.deepEqual(spec.HostConfig.RestartPolicy, { Name: "unless-stopped" });
  assert.ok(spec.Env.includes("BLENDER_SERVER_TOKEN=t0k"));
  assert.ok(spec.Env.includes("BLENDER_SERVER_PORT=3870"));
  assert.ok(spec.Env.includes("NVIDIA_DRIVER_CAPABILITIES=all"));
  assert.deepEqual(spec.HostConfig.Binds, ["pithagoras-blender-data:/data"]);
  assert.deepEqual(spec.HostConfig.LogConfig, { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } });
  assert.equal(spec.Tty, true, "a terminal keeps its log plain text");
  assert.equal(spec.Image, IMAGE);
});

test("Blender, which runs the agent's code, has none of the kernel's capabilities and cannot gain privileges", () => {
  const spec = made();
  assert.deepEqual(spec.HostConfig.CapDrop, ["ALL"]);
  assert.equal(spec.HostConfig.CapAdd, undefined);
  assert.deepEqual(spec.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
  assert.equal(spec.HostConfig.Privileged, undefined);
  // The user is the image's own (server/Dockerfile: USER blender), which the release's smoke test holds the image to.
  assert.equal(spec.User, undefined);
});

test("the OptiX weights are bound from the host only where the toolkit does not mount them", () => {
  const nvoptix = [{ Type: "bind", Source: "/usr/share/nvidia/nvoptix.bin", Target: "/usr/share/nvidia/nvoptix.bin", ReadOnly: true }];
  assert.deepEqual(made({ optix: "host" as never }).HostConfig.Mounts, nvoptix);
  assert.deepEqual(made({ optix: "toolkit" as never }).HostConfig.Mounts, []);
  assert.deepEqual(made({ optix: "none" }).HostConfig.Mounts, []);
});

test("every name can be changed from the portal's environment, and each has a default", () => {
  const env = process.env;
  for (const key of Object.keys(env)) if (key.startsWith("PITHAGORAS_BLENDER_")) delete env[key];
  assert.deepEqual(names(), { container: "pithagoras-blender", volume: "pithagoras-blender-data", probe: "pithagoras-blender-probe", port: 3870, image: IMAGE });
  const changed = namesFrom(
    { PITHAGORAS_BLENDER_CONTAINER: "flairtest-blender", PITHAGORAS_BLENDER_VOLUME: "flairtest-blender-data", PITHAGORAS_BLENDER_PORT: "3990", PITHAGORAS_BLENDER_IMAGE: "flairtest-pithagoras-blender:0.1.0", PITHAGORAS_BLENDER_GPU: "GPU-1" },
    "blender",
    { container: "pithagoras-blender", port: 3870, image: IMAGE },
  );
  assert.deepEqual(changed, { container: "flairtest-blender", volume: "flairtest-blender-data", probe: "flairtest-blender-probe", port: 3990, image: "flairtest-pithagoras-blender:0.1.0", gpu: "GPU-1" });
  // A container renamed alone takes its volume and probe with it; a port that is no port is the default.
  const renamed = namesFrom({ PITHAGORAS_BLENDER_CONTAINER: "other", PITHAGORAS_BLENDER_PORT: "no" }, "blender", { container: "pithagoras-blender", port: 3870, image: IMAGE });
  assert.equal(renamed.volume, "other-data");
  assert.equal(renamed.probe, "other-probe");
  assert.equal(renamed.port, 3870);
});

test("the spec's hash changes with the image and the card, and not with the network", () => {
  const hash = (spec: any) => spec.Labels[SPEC_LABEL];
  assert.equal(hash(made()), specHash(made()));
  assert.equal(hash(made({ network: "container:a" })), hash(made({ network: "host" })));
  assert.notEqual(hash(made({ card: { uuid: "GPU-other" } })), hash(made()));
  assert.notEqual(hash(stamped(blenderSpec(plan, 3870, "pithagoras-blender-data", "ghcr.io/prometheion/pithagoras-blender:0.2.0"))), hash(made()));
  assert.notEqual(hash(made({ optix: "host" as never })), hash(made()));
});
