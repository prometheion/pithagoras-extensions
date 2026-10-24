import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { Probed } from "../../shared/gpu.ts";
import { mcpClient } from "../../shared/mcp.ts";
import { relay } from "../../shared/relay.ts";
import { serverAddress, service, SPEC_LABEL, type Names } from "../../shared/service.ts";
import { openStore } from "../../shared/store.ts";
import { ACTS, LABELS } from "../src/labels.ts";
import { blenderSpec } from "../src/server/spec.ts";
import { BUNDLED, fakeMcp, fakePortal, memoryDocker, TOOLS } from "./fakes.mts";

/** The Blender server's container through Docker: installed, started, stopped, made again, removed, looked after. */

const CARD0 = { index: 0, uuid: "GPU-0000", name: "RTX 3060", usedMiB: 9000, totalMiB: 12288 };
const CARD1 = { index: 1, uuid: "GPU-1111", name: "RTX 3060", usedMiB: 158, totalMiB: 12288 };

async function setup(options: { names?: Partial<Names>; probed?: Probed } = {}) {
  const fake = fakePortal();
  const store = openStore(fake.dataDir);
  const server = await fakeMcp(store.token());
  const d = memoryDocker();
  const names: Names = { container: "pithagoras-blender", volume: "pithagoras-blender-data", probe: "pithagoras-blender-probe", network: "pithagoras-blender-net", port: server.port, image: "ghcr.io/prometheion/pithagoras-blender:0.1.0", ...options.names };
  const address = serverAddress(() => d.docker, names);
  const mcp = mcpClient({
    url: async () => {
      const { host, port } = await address.get();
      return `http://${host}:${port}/mcp`;
    },
    token: () => store.token(),
  });
  const tools = relay({ portal: fake.portal, prefix: "blender", app: "Blender", mcp, bundled: BUNDLED, labels: LABELS, acts: ACTS, installedFile: path.join(fake.dataDir, "installed") });
  const probes: (string | undefined)[] = [];
  const svc = service({
    portal: fake.portal,
    docker: () => d.docker,
    app: "Blender",
    names,
    store,
    relay: tools,
    mcp,
    spec: (plan) => blenderSpec(plan, names.port, names.volume, names.image),
    probe: async (_docker, _name, pinned) => {
      probes.push(pinned);
      return options.probed ?? { cards: [CARD0, CARD1], optix: "host", error: "" };
    },
    address,
  });
  return { fake, store, server, d, names, svc, tools, probes };
}

/** Until the install or start in the background has ended. */
async function settled(svc: ReturnType<typeof service>) {
  for (let i = 0; i < 200 && (await svc.status()).busy; i++) await delay(10);
}

const spec = (d: ReturnType<typeof memoryDocker>) => d.containers.get("pithagoras-blender")!.spec as any;

test("install downloads the image, makes the volume and the network, makes the container on it on the card with the most free memory, starts it, and asks the way to it", async () => {
  const { d, svc, fake, names } = await setup();
  assert.equal((await svc.status()).state, "absent");
  await svc.install();
  await settled(svc);
  assert.deepEqual(d.calls.filter((c) => !c.startsWith("ensure ubuntu")).slice(0, 6), [
    "ensure ghcr.io/prometheion/pithagoras-blender:0.1.0",
    "volume pithagoras-blender-data",
    "network pithagoras-blender-net",
    "create pithagoras-blender",
    "start pithagoras-blender",
    `reach pithagoras-blender-net pithagoras-blender ${names.port}`,
  ]);
  assert.equal(spec(d).HostConfig.NetworkMode, "pithagoras-blender-net", "the extension's own network, which has no way out");
  assert.ok(spec(d).Env.includes("BLENDER_SERVER_HOST=0.0.0.0"), "the server listens on the container's own network");
  assert.deepEqual(spec(d).HostConfig.DeviceRequests[0].DeviceIDs, ["GPU-1111"]);
  assert.equal(spec(d).HostConfig.Mounts.length, 1, "the host has the OptiX weights and the toolkit does not mount them");
  const now = await svc.status();
  assert.equal(now.state, "running");
  assert.equal(now.card, "GPU-1111");
  // The server answers: its tools come into the chats.
  for (let i = 0; i < 100 && !fake.registered().length; i++) await delay(10);
  assert.equal(fake.registered().length, TOOLS.length);
});

test("a download that fails says why, and nothing is made", async () => {
  const { d, svc } = await setup();
  d.state.pullFails = "denied: requested access to the resource is denied";
  await svc.install();
  await settled(svc);
  const now = await svc.status();
  assert.equal(now.state, "absent");
  assert.match(now.error, /denied/);
  assert.equal(d.containers.size, 0);
});

test("a server not answering yet is starting; one that exited with an error has failed; one stopped is stopped", async () => {
  const { d, svc, server } = await setup();
  await svc.install();
  await settled(svc);
  await server.close();
  assert.equal((await svc.status()).state, "starting");
  const held = d.containers.get("pithagoras-blender")!;
  held.state = "exited";
  held.exitCode = 1;
  const failed = await svc.status();
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "Blender exited. Its log says why.");
  held.exitCode = 0;
  assert.equal((await svc.status()).state, "stopped");
  held.state = "restarting";
  assert.equal((await svc.status()).state, "failed", "Docker trying it again is a failure until it answers");
});

test("a running container that is stale is made again at once, and the volume stays", async () => {
  const { d, svc, store } = await setup();
  await svc.install();
  await settled(svc);
  const first = spec(d).Labels[SPEC_LABEL];
  store.putSettings({ gpu: "GPU-0000" });
  const now = await svc.status();
  assert.equal(now.busy, true, "it is being made again");
  await settled(svc);
  assert.notEqual(spec(d).Labels[SPEC_LABEL], first);
  assert.deepEqual(spec(d).HostConfig.DeviceRequests[0].DeviceIDs, ["GPU-0000"]);
  assert.equal(d.containers.get("pithagoras-blender")!.state, "running");
  assert.equal(d.calls.filter((c) => c === "remove volume pithagoras-blender-data").length, 0);
});

test("the portal reaches the server where reach says, which need not be the server's own port", async () => {
  const { d, svc, server, fake } = await setup({ names: { port: 3870 } });
  d.state.reach = { host: "127.0.0.1", port: server.port };
  await svc.install();
  await settled(svc);
  assert.ok(spec(d).Env.includes("BLENDER_SERVER_PORT=3870"));
  assert.ok(d.calls.includes("reach pithagoras-blender-net pithagoras-blender 3870"));
  assert.equal((await svc.status()).state, "running");
  for (let i = 0; i < 100 && !fake.registered().length; i++) await delay(10);
  assert.equal(fake.registered().length, TOOLS.length);
});

test("a container from before, on the portal's network, is made again on the extension's own, and the volume stays", async () => {
  const before = (state: "running" | "exited") => {
    // As the code before this made it: on the portal's network, without the server's host, with a hash of that.
    const old = blenderSpec({ card: { uuid: "GPU-1111" }, optix: "host", network: "container:portal-1", token: "t" }, 3870, "pithagoras-blender-data", "ghcr.io/prometheion/pithagoras-blender:0.1.0") as any;
    old.Env = old.Env.filter((e: string) => !e.startsWith("BLENDER_SERVER_HOST="));
    return { id: "old", name: "pithagoras-blender", owner: "pithagoras-blender", spec: { ...old, Labels: { [SPEC_LABEL]: "0123456789abcdef" } }, state, exitCode: 0, restarts: 0, startedAt: "2026-10-23T00:00:00.000Z", log: "", networks: {} };
  };
  const running = await setup();
  running.d.volumes.set("pithagoras-blender-data", "pithagoras-blender");
  running.d.containers.set("pithagoras-blender", before("running"));
  assert.equal((await running.svc.status()).busy, true, "made again at the first look");
  // Until it is made again: a look that began before the remake says nothing of it.
  for (let i = 0; i < 200 && running.d.containers.get("pithagoras-blender")!.id === "old"; i++) await delay(10);
  await settled(running.svc);
  assert.equal(spec(running.d).HostConfig.NetworkMode, "pithagoras-blender-net");
  assert.equal(running.d.containers.get("pithagoras-blender")!.state, "running");
  assert.equal((await running.svc.status()).state, "running");
  assert.ok(!running.d.calls.includes("remove volume pithagoras-blender-data"));

  const stopped = await setup();
  stopped.d.containers.set("pithagoras-blender", before("exited"));
  await stopped.svc.maintain();
  assert.equal(stopped.d.containers.get("pithagoras-blender")!.id, "old", "a stopped one waits for Start");
  assert.deepEqual(stopped.d.calls, []);
  await stopped.svc.start();
  await settled(stopped.svc);
  assert.equal(spec(stopped.d).HostConfig.NetworkMode, "pithagoras-blender-net");
  assert.equal(stopped.d.containers.get("pithagoras-blender")!.state, "running");
});

test("a container on a network that was made again is stale", async () => {
  const { d, svc } = await setup();
  await svc.install();
  await settled(svc);
  const first = d.containers.get("pithagoras-blender")!.id;
  // Removed and made again under its name: another network, on which the container is not.
  d.networks.set("pithagoras-blender-net", { id: "net-again", owner: "pithagoras-blender" });
  assert.equal((await svc.status()).busy, true);
  await settled(svc);
  assert.notEqual(d.containers.get("pithagoras-blender")!.id, first);
  assert.deepEqual(d.containers.get("pithagoras-blender")!.networks, { "pithagoras-blender-net": { NetworkID: "net-again" } });
  assert.equal((await svc.status()).state, "running");
});

test("a reach that fails is the install's error", async () => {
  const { d, svc } = await setup();
  d.state.reachFails = "Bind for 127.0.0.1:3870 failed: port is already allocated";
  await svc.install();
  await settled(svc);
  assert.match((await svc.status()).error, /port is already allocated/);
});

test("a stale container somebody stopped is not started by the look, and is made again at its next start", async () => {
  const { d, svc, store } = await setup();
  await svc.install();
  await settled(svc);
  await svc.stop();
  store.putSettings({ gpu: "GPU-0000" });
  const creates = d.calls.filter((c) => c === "create pithagoras-blender").length;
  await svc.maintain();
  await svc.maintain();
  assert.equal(d.containers.get("pithagoras-blender")!.state, "exited", "the look never starts a stopped container");
  assert.equal(d.calls.filter((c) => c === "create pithagoras-blender").length, creates);
  await svc.start();
  await settled(svc);
  assert.equal(d.calls.filter((c) => c === "create pithagoras-blender").length, creates + 1);
  assert.equal(d.containers.get("pithagoras-blender")!.state, "running");
});

test("a start of a container that is current only starts it", async () => {
  const { d, svc } = await setup();
  await svc.install();
  await settled(svc);
  await svc.stop();
  const creates = d.calls.filter((c) => c === "create pithagoras-blender").length;
  await svc.start();
  await settled(svc);
  assert.equal(d.calls.filter((c) => c === "create pithagoras-blender").length, creates);
  assert.equal(d.containers.get("pithagoras-blender")!.state, "running");
});

test("a container of that name that is not this extension's is left alone and said", async () => {
  const { d, svc } = await setup();
  d.foreign("pithagoras-blender", "someone-else");
  assert.equal((await svc.status()).state, "foreign");
  await assert.rejects(svc.install(), /not this extension's/);
  await assert.rejects(svc.uninstall(false), /not this extension's/);
  assert.equal(d.containers.get("pithagoras-blender")!.owner, "someone-else");
  assert.ok(!d.calls.some((c) => c.startsWith("create") || c.startsWith("remove")));
});

test("uninstall removes the container, its network and its tools, and the projects only when asked", async () => {
  const { d, svc, fake } = await setup();
  await svc.install();
  await settled(svc);
  for (let i = 0; i < 100 && !fake.registered().length; i++) await delay(10);
  const calls = d.calls.length;
  await svc.uninstall(false);
  assert.deepEqual(d.calls.slice(calls), ["remove pithagoras-blender", "remove network pithagoras-blender-net"]);
  assert.equal(d.containers.has("pithagoras-blender"), false);
  assert.equal(d.networks.has("pithagoras-blender-net"), false);
  assert.equal(d.volumes.has("pithagoras-blender-data"), true);
  assert.deepEqual(fake.registered(), []);
  await svc.install();
  await settled(svc);
  const again = d.calls.length;
  await svc.uninstall(true);
  assert.deepEqual(d.calls.slice(again), ["remove pithagoras-blender", "remove network pithagoras-blender-net", "remove volume pithagoras-blender-data"]);
  assert.equal(d.volumes.has("pithagoras-blender-data"), false);
});

test("with no GPU the server is made with none, and Docker unavailable is said", async () => {
  const { d, svc } = await setup({ probed: { cards: [], optix: "none", error: "could not select device driver" } });
  await svc.install();
  await settled(svc);
  assert.deepEqual(spec(d).HostConfig.DeviceRequests, []);
  assert.deepEqual(spec(d).HostConfig.Mounts, []);
  d.state.available = false;
  assert.equal((await svc.status()).state, "unavailable");
});

test("a card pinned by the host is the only one asked for, and cannot be changed on the page", async () => {
  const { d, svc, probes } = await setup({ names: { gpu: "GPU-1111" }, probed: { cards: [CARD1], optix: "toolkit", error: "" } });
  await svc.install();
  await settled(svc);
  assert.deepEqual(probes, ["GPU-1111"]);
  assert.deepEqual(spec(d).HostConfig.DeviceRequests[0].DeviceIDs, ["GPU-1111"]);
  assert.deepEqual(spec(d).HostConfig.Mounts, [], "the toolkit mounts the OptiX weights itself");
  await assert.rejects(svc.chooseGpu("GPU-0000"), /The host fixes the card/);
  const hardware = await svc.hardware();
  assert.equal(hardware.pinned, true);
});

test("a card chosen on the page must be on the host; the automatic choice keeps the card the server is on", async () => {
  const { d, svc, store } = await setup();
  await assert.rejects(svc.chooseGpu("GPU-gone"), /That card is not on this host/);
  await svc.chooseGpu("GPU-0000");
  assert.equal(store.setting("gpu"), "GPU-0000");
  await svc.install();
  await settled(svc);
  assert.deepEqual(spec(d).HostConfig.DeviceRequests[0].DeviceIDs, ["GPU-0000"]);
  // Back to automatic: the server stays where it is, though another card has more free memory.
  await svc.chooseGpu("");
  await settled(svc);
  assert.deepEqual(spec(d).HostConfig.DeviceRequests[0].DeviceIDs, ["GPU-0000"]);
});

test("the token is made once, kept for the portal's user alone, and given to the container", async () => {
  const { d, svc, store, fake } = await setup();
  await svc.install();
  await settled(svc);
  const token = store.token();
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.ok(spec(d).Env.includes(`BLENDER_SERVER_TOKEN=${token}`));
  assert.equal(openStore(fake.dataDir).token(), token);
  const { statSync } = await import("node:fs");
  assert.equal(statSync(path.join(fake.dataDir, "settings.json")).mode & 0o777, 0o600);
});

test("a server Docker runs that does not answer is reached again, and nothing is stopped or started", async () => {
  const { d, svc, server } = await setup();
  await svc.install();
  await settled(svc);
  const reaches = () => d.calls.filter((c) => c.startsWith("reach")).length;
  const once = reaches();
  await svc.maintain();
  assert.equal(reaches(), once, "it answers: the way to it is not asked again");
  // The portal's container was made again, or the forwarder removed: nothing answers where the half reaches the server.
  server.state.down = true;
  assert.equal((await svc.status()).state, "starting", "Docker says it runs, and it does not answer");
  const calls = d.calls.length;
  await svc.maintain();
  assert.deepEqual(d.calls.slice(calls), [`reach pithagoras-blender-net pithagoras-blender ${server.port}`]);
  server.state.down = false;
  assert.equal((await svc.status()).state, "running");
  // One somebody stopped is neither reached nor started.
  await svc.stop();
  const stopped = d.calls.length;
  await svc.maintain();
  assert.deepEqual(d.calls.slice(stopped), []);
});
