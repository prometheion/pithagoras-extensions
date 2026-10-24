import { after, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Probed } from "../../shared/gpu.ts";
import { mcpClient } from "../../shared/mcp.ts";
import { relay } from "../../shared/relay.ts";
import { serverAddress, service, SPEC_LABEL, specHash, type Names } from "../../shared/service.ts";
import { openStore } from "../../shared/store.ts";
import { ACTS, LABELS } from "../src/labels.ts";
import { displayOf } from "../src/displays.ts";
import { godotSpec } from "../src/server/spec.ts";
import { fakeDocker, fakeMcp, fakePortal, LISTED } from "./fakes.mts";

/**
 * Godot's container through the shared service (shared/service.ts), with Godot's spec: installed on a card on the
 * extension's own network, made again when its spec, its screen or its network changes, whether its server answers or
 * not, reached where Docker says, and never started by anything but the person.
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
  const names: Names = { container: "pithagoras-godot", volume: "pithagoras-godot-data", probe: "pithagoras-godot-probe", network: "pithagoras-godot-net", port: server.port, image: "ghcr.io/prometheion/pithagoras-godot:0.1.0", ...options.names };
  const address = serverAddress(() => d.docker, names);
  const mcp = mcpClient({
    url: async () => {
      const { host, port } = await address.get();
      return `http://${host}:${port}/mcp`;
    },
    token: () => store.token(),
  });
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
    address,
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

test("an install downloads the image, makes the volume and the network, makes the container on it on the card with the most room, starts it, and asks the way to it", async () => {
  const { d, svc, names } = await setup();
  assert.equal((await svc.status()).state, "absent");
  await svc.install();
  const now = await settled(svc);
  assert.equal(now.state, "running");
  assert.equal(now.card, "GPU-bbbb1111");
  assert.deepEqual(d.calls.slice(0, 6), ["pull ghcr.io/prometheion/pithagoras-godot:0.1.0", "volume pithagoras-godot-data", "network pithagoras-godot-net", "create pithagoras-godot", "start pithagoras-godot", `reach pithagoras-godot-net pithagoras-godot ${names.port}`]);
  assert.equal(spec(d).Labels[SPEC_LABEL], specHash(spec(d)), "the spec's hash is in its label");
  assert.equal(spec(d).HostConfig.NetworkMode, "pithagoras-godot-net", "the extension's own network, which has no way out");
  assert.ok(spec(d).Env.includes("GODOT_SERVER_HOST=0.0.0.0"), "the server listens on the container's own network");
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

test("a container from before, on the portal's network, is made again on the extension's own, and the volume stays; a stopped one at its Start", async () => {
  // As the code before this made it: on the portal's network, without the server's host, with a hash of that.
  const before = (running: boolean) => {
    const old = godotSpec({ card: { uuid: "GPU-bbbb1111" }, optix: "none", network: "container:portal-1", token: "t" }, { port: 3880, volume: "pithagoras-godot-data", image: "ghcr.io/prometheion/pithagoras-godot:0.1.0", display: "1600x900" }) as any;
    old.Env = old.Env.filter((e: string) => !e.startsWith("GODOT_SERVER_HOST="));
    return { spec: { ...old, Labels: { [SPEC_LABEL]: "0123456789abcdef" } }, owner: "@pithagoras/godot", id: "old", running, exitCode: 0, startedAt: "t0", logs: "", restarting: false, restarts: 0, networks: {} };
  };
  const one = await setup();
  one.d.volumes.add("pithagoras-godot-data");
  one.d.containers.set("pithagoras-godot", before(true));
  await one.svc.maintain();
  // Until it is made again: a look that began before the remake says nothing of it.
  for (let i = 0; i < 300 && kept(one.d).id === "old"; i++) await delay(10);
  assert.equal((await settled(one.svc)).state, "running");
  assert.equal(spec(one.d).HostConfig.NetworkMode, "pithagoras-godot-net");
  assert.ok(!one.d.calls.includes("remove volume pithagoras-godot-data"));

  const two = await setup();
  two.d.containers.set("pithagoras-godot", before(false));
  await two.svc.maintain();
  assert.deepEqual(two.d.calls, [], "a stopped one waits for Start");
  await two.svc.start();
  assert.equal((await settled(two.svc)).state, "running");
  assert.equal(spec(two.d).HostConfig.NetworkMode, "pithagoras-godot-net");
});

test("a container on a network that was made again is stale, though its server cannot answer there", async () => {
  const { d, svc, server } = await setup();
  await svc.install();
  await settled(svc);
  const first = kept(d).id;
  // Removed and made again under its name: another network, on which the container is not.
  d.networks.set("pithagoras-godot-net", { id: "net-again", owner: "@pithagoras/godot" });
  await server.close();
  await svc.maintain();
  for (let i = 0; i < 300 && kept(d).id === first; i++) await delay(10);
  await settled(svc);
  assert.deepEqual(kept(d).networks, { "pithagoras-godot-net": { NetworkID: "net-again" } });
  assert.equal(kept(d).running, true);
});

test("a server Docker runs that does not answer is reached again, and nothing is stopped or started", async () => {
  const { d, svc, server, names } = await setup();
  await svc.install();
  await settled(svc);
  const made = kept(d).id;
  // The portal's container was made again, or the forwarder removed: nothing answers where the half reaches the server.
  await server.close();
  const calls = d.calls.length;
  await svc.maintain();
  assert.deepEqual(d.calls.slice(calls), [`reach pithagoras-godot-net pithagoras-godot ${names.port}`]);
  assert.equal(kept(d).id, made, "the same container, its volume and its spec kept");
  assert.equal(kept(d).running, true);
});

test("a reach that fails is the install's error", async () => {
  const { d, svc } = await setup();
  d.state.reachFails = "Bind for 127.0.0.1:3880 failed: port is already allocated";
  await svc.install();
  assert.match((await settled(svc)).error, /port is already allocated/);
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

test("Remove takes the container, its network and its tools, and the projects only when asked", async () => {
  const { d, svc, fake } = await setup();
  await svc.install();
  await settled(svc);
  for (let i = 0; i < 100 && !fake.registered().length; i++) await delay(10);
  assert.ok(fake.registered().length > 0);
  const calls = d.calls.length;
  await svc.uninstall(false);
  assert.deepEqual(d.calls.slice(calls), ["remove pithagoras-godot", "remove network pithagoras-godot-net"]);
  assert.ok(!d.networks.has("pithagoras-godot-net"));
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
  assert.ok(!d.calls.includes("pull ghcr.io/prometheion/pithagoras-godot:0.1.0"), "not even the image is downloaded");
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
