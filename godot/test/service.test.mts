import { after, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Probed } from "../../shared/gpu.ts";
import { mcpClient } from "../../shared/mcp.ts";
import { relay } from "../../shared/relay.ts";
import { service, SPEC_LABEL, specHash, type Names } from "../../shared/service.ts";
import { openStore } from "../../shared/store.ts";
import { ACTS, LABELS } from "../src/labels.ts";
import { displayOf } from "../src/displays.ts";
import { godotSpec } from "../src/server/spec.ts";
import { fakeDocker, fakeMcp, fakePortal, LISTED } from "./fakes.mts";

/**
 * Godot's container through the shared service (shared/service.ts), with Godot's spec: installed on a card, made again
 * when its spec, its screen or its network changes, whether its server answers or not, and never started by anything
 * but the person.
 */

const CARD0 = { index: 0, uuid: "GPU-aaaa0000", name: "NVIDIA GeForce RTX 3060", usedMiB: 11000, totalMiB: 12288 };
const CARD1 = { index: 1, uuid: "GPU-bbbb1111", name: "NVIDIA GeForce RTX 3060", usedMiB: 158, totalMiB: 12288 };

/** `probed`: what the probe finds, or "real" for shared/gpu.ts's own probe against the fake Docker. */
async function setup(options: { names?: Partial<Names>; probed?: Probed | "real" } = {}) {
  const fake = fakePortal();
  const store = openStore(fake.dataDir);
  const server = await fakeMcp(() => store.token());
  after(() => server.close());
  const d = fakeDocker();
  const names: Names = { container: "pithagoras-godot", volume: "pithagoras-godot-data", probe: "pithagoras-godot-probe", port: server.port, image: "ghcr.io/thecodacus/pithagoras-godot:0.1.0", ...options.names };
  const mcp = mcpClient({ url: () => `http://127.0.0.1:${names.port}/mcp`, token: () => store.token() });
  const tools = relay({ portal: fake.portal, prefix: "godot", app: "Godot", mcp, labels: LABELS, acts: ACTS, bundled: LISTED, installedFile: path.join(fake.dataDir, "installed") });
  const svc = service({
    portal: fake.portal,
    docker: () => d.docker,
    app: "Godot",
    names,
    store,
    relay: tools,
    mcp,
    spec: (plan) => godotSpec(plan, { port: names.port, volume: names.volume, image: names.image, display: displayOf(store.setting("display")) }),
    ...(options.probed === "real" ? {} : { probe: async () => (options.probed as Probed | undefined) ?? { cards: [CARD0, CARD1], optix: "toolkit", error: "" } }),
    netns: () => "net:[4026532001]",
  });
  return { fake, store, server, d, names, svc };
}

/** Until what runs in the background (an install, a start, a remake) has ended. */
async function settled(svc: Awaited<ReturnType<typeof setup>>["svc"]) {
  for (let i = 0; i < 300 && (await svc.status()).busy; i++) await delay(10);
  return svc.status();
}

const kept = (d: ReturnType<typeof fakeDocker>) => d.containers.get("pithagoras-godot")!;
const spec = (d: ReturnType<typeof fakeDocker>) => kept(d).spec as any;

test("an install downloads the image, makes the volume, makes the container on the card with the most room, and starts it", async () => {
  const { d, svc } = await setup();
  assert.equal((await svc.status()).state, "absent");
  await svc.install();
  const now = await settled(svc);
  assert.equal(now.state, "running");
  assert.equal(now.card, "GPU-bbbb1111");
  assert.deepEqual(d.calls, ["pull ghcr.io/thecodacus/pithagoras-godot:0.1.0", "volume pithagoras-godot-data", "create pithagoras-godot", "start pithagoras-godot"]);
  assert.equal(spec(d).Labels[SPEC_LABEL], specHash(spec(d)), "the spec's hash is in its label");
  assert.equal(spec(d).HostConfig.NetworkMode, "container:portal-1");
  assert.deepEqual(spec(d).HostConfig.RestartPolicy, { Name: "unless-stopped" });
});

test("another screen size makes a running editor again with it, on the card it had, the volume kept; a stopped one waits for Start", async () => {
  const { d, svc, store } = await setup();
  await svc.install();
  await settled(svc);
  const first = kept(d).id;
  store.putSettings({ display: "1280x720" });
  assert.equal((await svc.status()).busy, true, "being made again");
  await settled(svc);
  assert.notEqual(kept(d).id, first);
  assert.ok(spec(d).Env.includes("DISPLAY_SIZE=1280x720"));
  assert.deepEqual(spec(d).HostConfig.DeviceRequests[0].DeviceIDs, ["GPU-bbbb1111"]);
  assert.ok(!d.calls.includes("remove volume pithagoras-godot-data"));

  await svc.stop();
  store.putSettings({ display: "1920x1080" });
  const before = d.calls.length;
  await svc.maintain();
  await svc.maintain();
  assert.deepEqual(d.calls.slice(before), [], "the look neither makes a stopped container again nor starts it");
  assert.equal((await svc.status()).state, "stopped");
  await svc.start();
  assert.equal((await settled(svc)).state, "running");
  assert.ok(spec(d).Env.includes("DISPLAY_SIZE=1920x1080"), "made again at its Start");
});

test("a container on the portal's old network is made again on the new one, though its server cannot answer there", async () => {
  const { d, svc, server } = await setup();
  await svc.install();
  await settled(svc);
  // The portal's container was made again: the old one's loopback is gone, so nothing answers the half.
  d.state.network = "container:portal-2";
  await server.close();
  await svc.maintain();
  await settled(svc);
  assert.equal(spec(d).HostConfig.NetworkMode, "container:portal-2");
  assert.equal(kept(d).running, true);
});

test("after the portal's container restarts under the same id, a server left in its old network namespace is started again in the new one", async () => {
  const { d, svc, server } = await setup();
  await svc.install();
  await settled(svc);
  const made = kept(d).id;
  // Nothing answers the half: the portal is in a new namespace, the server in the old one.
  await server.close();
  await svc.maintain();
  assert.ok(d.calls.includes("exec pithagoras-godot readlink /proc/self/ns/net"));
  assert.ok(!d.calls.includes("stop pithagoras-godot"), "in the portal's namespace: only not answering yet, and left alone");
  d.state.namespace = "net:[4026531840]";
  await svc.maintain();
  await settled(svc);
  assert.deepEqual(d.calls.slice(-2), ["stop pithagoras-godot", "start pithagoras-godot"]);
  assert.equal(kept(d).id, made, "the same container, its volume and its spec kept");
  assert.equal(kept(d).running, true);
});

test("a server that exited, or that Docker is starting again, has failed; one not answering yet is starting", async () => {
  const { d, svc, server } = await setup();
  await svc.install();
  await settled(svc);
  await server.close();
  assert.equal((await svc.status()).state, "starting");
  Object.assign(kept(d), { running: false, exitCode: 1 });
  const failed = await svc.status();
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "Godot exited. Its log says why.");
  Object.assign(kept(d), { running: true, restarting: true });
  assert.equal((await svc.status()).state, "failed");
  Object.assign(kept(d), { running: false, restarting: false, exitCode: 0 });
  assert.equal((await svc.status()).state, "stopped");
});

test("the look never starts a container somebody stopped", async () => {
  const { d, svc } = await setup();
  await svc.install();
  await settled(svc);
  await svc.stop();
  for (let i = 0; i < 3; i++) await svc.maintain();
  assert.equal(kept(d).running, false);
  assert.equal(d.calls.filter((c) => c === "start pithagoras-godot").length, 1);
});

test("a container of that name that is not this extension's is left alone, and said", async () => {
  const { d, svc } = await setup();
  d.foreign("pithagoras-godot", "someone-else");
  assert.equal((await svc.status()).state, "foreign");
  await assert.rejects(svc.install(), /not this extension's/);
  await assert.rejects(svc.uninstall(true), /not this extension's/);
  assert.equal(kept(d).owner, "someone-else");
  assert.ok(!d.calls.some((c) => c.startsWith("create") || c.startsWith("remove")));
});

test("Remove takes the container and its tools, and the projects only when asked", async () => {
  const { d, svc, fake } = await setup();
  await svc.install();
  await settled(svc);
  for (let i = 0; i < 100 && !fake.registered().length; i++) await delay(10);
  assert.ok(fake.registered().length > 0);
  await svc.uninstall(false);
  assert.equal((await svc.status()).state, "absent");
  assert.ok(d.volumes.has("pithagoras-godot-data"));
  assert.deepEqual(fake.registered(), []);
  await svc.install();
  await settled(svc);
  await svc.uninstall(true);
  assert.ok(!d.volumes.has("pithagoras-godot-data"));
});

test("with no GPU for Docker to give, the container is made without one; without Docker there is nothing to do", async () => {
  const { d, svc } = await setup({ probed: { cards: [], optix: "none", error: "could not select device driver" } });
  await svc.install();
  assert.equal((await settled(svc)).state, "running");
  assert.deepEqual(spec(d).HostConfig.DeviceRequests, []);
  d.state.available = false;
  assert.equal((await svc.status()).state, "unavailable");
  await assert.rejects(svc.install(), /Docker does not answer/);
});

test("a card the host pins that Docker cannot give is said as that, and nothing is made with it or without it", async () => {
  const { d, svc } = await setup({ names: { gpu: "7" }, probed: "real" });
  d.state.noGpu = "OCI runtime create failed: error running prestart hook #0: nvidia-container-cli: device error: 7: unknown device: unknown";
  // Install before the page has looked: the probe runs first, and the install is refused in the background.
  await svc.install();
  const now = await settled(svc);
  assert.equal(now.state, "absent");
  assert.equal(now.error, "The card PITHAGORAS_GODOT_GPU names is not on this host.");
  // The page's look: the cards, none, with Docker's words; then Install is refused at once.
  const hardware = await svc.hardware();
  assert.deepEqual([hardware.cards, hardware.pinned], [[], true]);
  assert.match(hardware.error, /unknown device/);
  await assert.rejects(svc.install(), /^Error: The card PITHAGORAS_GODOT_GPU names is not on this host\.$/);
  assert.ok(!d.containers.has("pithagoras-godot"));
  assert.ok(!d.calls.includes("pull ghcr.io/thecodacus/pithagoras-godot:0.1.0"), "not even the image is downloaded");
  assert.ok(!d.containers.has("pithagoras-godot-probe"), "the probe is removed");
});

test("a download that fails is said, and nothing is made", async () => {
  const { d, svc } = await setup();
  d.state.pullFails = "denied: requested access to the resource is denied";
  await svc.install();
  const now = await settled(svc);
  assert.equal(now.state, "absent");
  assert.match(now.error, /denied/);
  assert.ok(!d.containers.has("pithagoras-godot"));
});
