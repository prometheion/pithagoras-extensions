import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { Probed } from "../../shared/gpu.ts";
import { mcpClient } from "../../shared/mcp.ts";
import { relay } from "../../shared/relay.ts";
import { service, SPEC_LABEL, type Names } from "../../shared/service.ts";
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
  const names: Names = { container: "pithagoras-blender", volume: "pithagoras-blender-data", probe: "pithagoras-blender-probe", port: server.port, image: "ghcr.io/thecodacus/pithagoras-blender:0.1.0", ...options.names };
  const mcp = mcpClient({ url: () => `http://127.0.0.1:${names.port}/mcp`, token: () => store.token() });
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
    netns: () => d.state.namespace,
  });
  return { fake, store, server, d, names, svc, tools, probes };
}

/** Until the install or start in the background has ended. */
async function settled(svc: ReturnType<typeof service>) {
  for (let i = 0; i < 200 && (await svc.status()).busy; i++) await delay(10);
}

const spec = (d: ReturnType<typeof memoryDocker>) => d.containers.get("pithagoras-blender")!.spec as any;

test("install downloads the image, makes the volume, makes the container on the card with the most free memory, and starts it", async () => {
  const { d, svc, fake } = await setup();
  assert.equal((await svc.status()).state, "absent");
  await svc.install();
  await settled(svc);
  assert.deepEqual(d.calls.filter((c) => !c.startsWith("ensure ubuntu")), [
    "ensure ghcr.io/thecodacus/pithagoras-blender:0.1.0",
    "volume pithagoras-blender-data",
    "create pithagoras-blender",
    "start pithagoras-blender",
  ]);
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

test("a container on another network is stale too", async () => {
  const { d, svc } = await setup();
  await svc.install();
  await settled(svc);
  d.state.network = "container:new-portal";
  await svc.status();
  await settled(svc);
  assert.equal(spec(d).HostConfig.NetworkMode, "container:new-portal");
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

test("uninstall removes the container and its tools, and the projects only when asked", async () => {
  const { d, svc, fake } = await setup();
  await svc.install();
  await settled(svc);
  for (let i = 0; i < 100 && !fake.registered().length; i++) await delay(10);
  await svc.uninstall(false);
  assert.equal(d.containers.has("pithagoras-blender"), false);
  assert.equal(d.volumes.has("pithagoras-blender-data"), true);
  assert.deepEqual(fake.registered(), []);
  await svc.install();
  await settled(svc);
  await svc.uninstall(true);
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

test("a server left in the namespace of the portal's last run is started again, and joins the portal's", async () => {
  const { d, svc, server, fake } = await setup();
  await svc.install();
  await settled(svc);
  assert.equal((await svc.status()).state, "running");
  // The portal's container started again under the same id: a namespace of its own, which the server is not in, so
  // nothing answers on the portal's loopback.
  d.state.namespace = "net:[4026532999]";
  server.state.down = true;
  d.state.onStart = (c) => {
    if (c.netns === d.state.namespace) server.state.down = false;
  };
  assert.equal((await svc.status()).state, "starting", "Docker says it runs, and it does not answer");
  const creates = d.calls.filter((c) => c === "create pithagoras-blender").length;
  await svc.maintain();
  await settled(svc);
  assert.deepEqual(d.calls.slice(-3), ["exec pithagoras-blender readlink /proc/self/ns/net", "stop pithagoras-blender", "start pithagoras-blender"]);
  assert.equal(d.calls.filter((c) => c === "create pithagoras-blender").length, creates, "the container is kept");
  assert.equal((await svc.status()).state, "running");
  assert.match(fake.logs.join("\n"), /network namespace the portal is no longer in/);
});

test("a server that is starting in the portal's namespace is left to start, and one that answers is not looked into", async () => {
  const { d, svc, server } = await setup();
  await svc.install();
  await settled(svc);
  await svc.maintain();
  assert.ok(!d.calls.some((c) => c.startsWith("exec")), "it answers: nothing is run in it");
  server.state.down = true;
  await svc.maintain();
  assert.equal(d.calls.at(-1), "exec pithagoras-blender readlink /proc/self/ns/net");
  assert.ok(!d.calls.includes("stop pithagoras-blender"), "the same namespace: it is starting, and is left to");
  // One somebody stopped is not looked into, nor started.
  await svc.stop();
  const calls = d.calls.length;
  await svc.maintain();
  assert.deepEqual(d.calls.slice(calls), []);
});
