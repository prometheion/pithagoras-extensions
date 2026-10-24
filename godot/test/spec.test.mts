import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { specHash, stamped } from "../../shared/service.ts";
import { displayOf } from "../src/displays.ts";
import { godotSpec, IMAGE, names, VERSION } from "../src/server/spec.ts";

/** The Godot server's container as the extension makes it: what the live godot-server's compose had, on the extension's own network. */

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const plan = { network: "pithagoras-godot-net", token: "t0k3n", optix: "none" as const };
const server = { port: 3880, volume: "pithagoras-godot-data", image: IMAGE, display: "1600x900" as const };

test("the image is the package's version, so a release cannot forget to move it", () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(IMAGE, `ghcr.io/prometheion/pithagoras-godot:${pkg.version}`);
});

test("the container: on the network it is given, listening on all of it, restarted unless stopped, with its token, its port, its screen and its volume", () => {
  const spec = stamped(godotSpec({ ...plan, card: { uuid: "GPU-bbbb1111" } }, server)) as any;
  assert.equal(spec.Image, IMAGE);
  assert.equal(spec.Tty, true, "plain-text logs");
  assert.deepEqual(spec.Env, ["GODOT_SERVER_TOKEN=t0k3n", "GODOT_SERVER_HOST=0.0.0.0", "GODOT_SERVER_PORT=3880", "DISPLAY_SIZE=1600x900", "NVIDIA_DRIVER_CAPABILITIES=all"]);
  const host = spec.HostConfig;
  assert.equal(host.NetworkMode, "pithagoras-godot-net");
  assert.deepEqual(host.RestartPolicy, { Name: "unless-stopped" });
  assert.deepEqual(host.Binds, ["pithagoras-godot-data:/data"]);
  assert.deepEqual(host.DeviceRequests, [{ Driver: "nvidia", DeviceIDs: ["GPU-bbbb1111"], Capabilities: [["gpu"]] }]);
  assert.deepEqual(host.LogConfig, { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } });
  // As the live compose: init, 1 GiB of shared memory, 8 GiB of memory, no core files.
  assert.equal(host.Init, true);
  assert.equal(host.ShmSize, 1024 ** 3);
  assert.equal(host.Memory, 8 * 1024 ** 3);
  assert.deepEqual(host.Ulimits, [{ Name: "core", Soft: 0, Hard: 0 }]);
  assert.equal(host.PortBindings, undefined, "nothing is published");
});

test("what runs in it runs as the image's own user, with no capabilities and no way to gain one", () => {
  const spec = godotSpec({ ...plan, card: { uuid: "GPU-bbbb1111" } }, server) as any;
  assert.equal(spec.User, "10001:10001");
  assert.deepEqual(spec.HostConfig.CapDrop, ["ALL"]);
  assert.equal(spec.HostConfig.CapAdd, undefined);
  assert.deepEqual(spec.HostConfig.SecurityOpt, ["no-new-privileges"]);
  assert.equal(spec.HostConfig.Privileged, undefined);
  // The image says the same, for a container made from it by hand.
  const dockerfile = readFileSync(new URL("../server/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^USER 10001:10001$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["python3", "-I", /m);
});

test("without a card it asks Docker for no GPU", () => {
  assert.deepEqual((godotSpec(plan, server) as any).HostConfig.DeviceRequests, []);
});

test("every name comes from the portal's environment where it says one", () => {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith("PITHAGORAS_GODOT_")) delete process.env[key];
    assert.deepEqual(names(), { container: "pithagoras-godot", volume: "pithagoras-godot-data", probe: "pithagoras-godot-probe", network: "pithagoras-godot-net", port: 3880, image: IMAGE });
    Object.assign(process.env, {
      PITHAGORAS_GODOT_CONTAINER: "flairtest-godot",
      PITHAGORAS_GODOT_PORT: "3881",
      PITHAGORAS_GODOT_IMAGE: "flairtest-pithagoras-godot:0.1.0",
      PITHAGORAS_GODOT_GPU: "GPU-648bf6c5",
    });
    assert.deepEqual(names(), { container: "flairtest-godot", volume: "flairtest-godot-data", probe: "flairtest-godot-probe", network: "flairtest-godot-net", port: 3881, image: "flairtest-pithagoras-godot:0.1.0", gpu: "GPU-648bf6c5" });
  } finally {
    process.env = saved;
  }
});

test("the screen is one the page offers, else the default", () => {
  assert.equal(displayOf("1280x720"), "1280x720");
  assert.equal(displayOf("800x600"), "1600x900");
  assert.equal(displayOf(undefined), "1600x900");
});

test("the spec's hash changes with the image, the card, the screen and the network", () => {
  const card = { uuid: "GPU-a" };
  const base = specHash(godotSpec({ ...plan, card }, server));
  assert.notEqual(specHash(godotSpec({ ...plan, card }, { ...server, image: "ghcr.io/prometheion/pithagoras-godot:0.1.1" })), base);
  assert.notEqual(specHash(godotSpec({ ...plan, card: { uuid: "GPU-b" } }, server)), base);
  assert.notEqual(specHash(godotSpec(plan, server)), base);
  assert.notEqual(specHash(godotSpec({ ...plan, card }, { ...server, display: "1280x720" })), base);
  assert.notEqual(specHash(godotSpec({ ...plan, card, network: "other-net" }, server)), base);
});
