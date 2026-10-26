/**
 * Unit tests for src/container.ts: the Document Server and its relay over the fake Docker for extensions of
 * fake-docker.mts, with real tmp dirs for settings/jwt-secret/relay-secret/ds.json/user-stopped, and the relay's own
 * program run with this Node, with the way back of back.ts, against servers of the test's own. Nothing here reaches the
 * Docker socket or portal().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { stamped } from "../../shared/service";
import {
  AGENT_IMAGE,
  AGENT_IMAGE_DIGEST,
  AGENT_IMAGE_TAG,
  BACK_PORT,
  agentImage,
  agentSpec,
  ensureAgent,
  pullAgentImage,
  stopAgent,
  DS_NAME,
  DS_PATHS,
  DS_VOLUME,
  NAMES,
  RELAY_IMAGE,
  RELAY_SCRIPT,
  dsOrigin,
  dsSpec,
  ensureContainer,
  forgetProbe,
  forgetReach,
  lookAfter,
  officeNames,
  reachAgain,
  reachedNow,
  readDsRecord,
  removeContainers,
  settled,
  startOffice,
  status,
  stopContainer,
  userStopped,
  whenDsStarted,
  whenReached,
} from "../src/container";
import { hello, holdWayBack } from "../src/back";
import { fakeDocker } from "./fake-docker.mts";

const DEFAULT_TAG = "onlyoffice/documentserver:10.0.0.1";
const TAG92 = "onlyoffice/documentserver:9.2.1.1";
const NET = "pithagoras-office-ds-net";
/** The agents' browser's own network. */
const AGENTS = "pithagoras-office-ds-agents";
const RELAY = "pithagoras-office-ds-relay";
const KEY = "k".repeat(64);
/** The Document Server's volumes, in the order of DS_PATHS. */
const VOLUMES = [DS_VOLUME, "pithagoras-office-ds-cache", "pithagoras-office-ds-logs", "pithagoras-office-ds-fonts"];

function tmpRoot(settings: Record<string, unknown> = {}, secret: string | null = "s3cret\n"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-container-"));
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: false, imageTag: DEFAULT_TAG, ...settings }));
  if (secret !== null) fs.writeFileSync(path.join(root, "jwt-secret"), secret);
  fs.writeFileSync(path.join(root, "relay-secret"), `${KEY}\n`);
  return root;
}

function fresh(options?: Parameters<typeof fakeDocker>[0]) {
  forgetReach();
  forgetProbe();
  return fakeDocker(options);
}

const made = (m: ReturnType<typeof fakeDocker>, name: string) => m.containers.get(name)!.spec as Record<string, any>;

/* ---------------- the names ---------------- */

test("the names: the Document Server, its volumes, network and relay, each from the environment where it says so", () => {
  assert.equal(DS_NAME, "pithagoras-office-ds");
  assert.equal(DS_VOLUME, "pithagoras-office-ds-data");
  assert.deepEqual([NAMES.network, NAMES.relay, NAMES.port], [NET, RELAY, 3890]);
  assert.deepEqual(Object.values(NAMES.volumes), VOLUMES);
  const other = officeNames({ PITHAGORAS_OFFICE_CONTAINER: "office-test", PITHAGORAS_OFFICE_PORT: "4890", PITHAGORAS_OFFICE_VOLUME: "kept" });
  assert.deepEqual([other.container, other.volume, other.network, other.relay, other.port], ["office-test", "kept", "office-test-net", "office-test-relay", 4890]);
  assert.deepEqual(Object.values(other.volumes), ["kept", "office-test-cache", "office-test-logs", "office-test-fonts"]);
});

test("the Document Server has a named volume at every path its image declares one, so Docker makes no anonymous volume", () => {
  // `docker image inspect onlyoffice/documentserver:10.0.0.1 --format '{{json .Config.Volumes}}'`
  const declared = ["/usr/share/fonts/truetype/custom", "/var/lib/onlyoffice", "/var/log/onlyoffice", "/var/www/onlyoffice/Data"];
  assert.deepEqual(Object.keys(DS_PATHS).sort(), declared);
  const binds = (dsSpec(DEFAULT_TAG, [], NET).HostConfig as { Binds: string[] }).Binds;
  assert.deepEqual(binds.map((b) => b.slice(b.indexOf(":") + 1)).sort(), declared);
  assert.ok(binds.includes("pithagoras-office-ds-cache:/var/lib/onlyoffice"), "the cache, with the forgotten saves, outlives a re-create");
  assert.equal(new Set(binds.map((b) => b.split(":")[0])).size, declared.length, "a volume of its own for each");
});

/* ---------------- ensure: the fresh path ---------------- */

test("ensure (fresh): both images, the volumes, the island, the Document Server on it, the relay, the way in, ds.json", async () => {
  const root = tmpRoot({ enabled: true, imageTag: TAG92 });
  const m = fresh();
  const seen: string[] = [];
  const res = await ensureContainer(m.docker, (s) => seen.push(s.line), root);
  assert.deepEqual(res, { started: true });
  assert.deepEqual(m.calls, [
    `pull ${TAG92}`,
    `pull ${RELAY_IMAGE}`,
    ...VOLUMES.map((v) => `volume ${v}`),
    `network ${NET}`,
    `network ${AGENTS}`,
    `create ${DS_NAME}`,
    `start ${DS_NAME}`,
    `create ${RELAY}`,
    `start ${RELAY}`,
    `reach ${NET} ${RELAY} 3890`,
  ]);
  assert.deepEqual(seen, [`downloading ${TAG92}`, "done", `downloading ${RELAY_IMAGE}`, "done"]);

  // The Document Server: on the island by name, no port published, its JWT in every direction, no plugin manager,
  // and the private-address filter left on.
  const ds = made(m, DS_NAME);
  assert.equal(ds.Image, TAG92);
  assert.equal(ds.HostConfig.NetworkMode, NET);
  assert.equal(ds.HostConfig.PortBindings, undefined);
  assert.equal(ds.ExposedPorts, undefined);
  assert.deepEqual(ds.HostConfig.Binds, Object.keys(DS_PATHS).map((at, i) => `${VOLUMES[i]}:${at}`));
  assert.deepEqual(ds.HostConfig.RestartPolicy, { Name: "unless-stopped" });
  assert.deepEqual(ds.Env, ["JWT_ENABLED=true", "JWT_SECRET=s3cret", "JWT_HEADER=X-Auth-Token", "JWT_IN_BODY=false", "PLUGINS_ENABLED=false"]);
  assert.ok(!ds.Env.some((e: string) => e.startsWith("ALLOW_PRIVATE_IP_ADDRESS")));
  assert.match(ds.Labels["pithagoras.extension-spec"], /^[0-9a-f]{16}$/);

  // The island's relay: the way in to the Document Server's port 80, the way back to the portal's tunnels with the
  // key they open with, hardened as the forwarder of Docker for extensions is.
  const relay = made(m, RELAY);
  assert.equal(relay.Image, RELAY_IMAGE);
  assert.equal(relay.User, "1000:1000");
  assert.deepEqual(relay.Cmd, ["node", "-e", RELAY_SCRIPT]);
  assert.deepEqual(relay.Env, ["IN_PORT=3890", `DS_HOST=${DS_NAME}`, "DS_PORT=80", `BACK_PORT=${BACK_PORT}`, `TUNNEL_KEY=${KEY}`]);
  assert.equal(relay.HostConfig.Binds, undefined);
  assert.deepEqual(relay.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(relay.HostConfig.SecurityOpt, ["no-new-privileges"]);
  assert.equal(relay.HostConfig.ReadonlyRootfs, true);
  assert.equal(relay.HostConfig.Memory, 128 * 1024 ** 2);
  assert.equal(relay.HostConfig.PidsLimit, 64);
  assert.equal(relay.HostConfig.NetworkMode, NET);
  // On the agents' browser's network too: the browser's one way to the Document Server and to the portal.
  assert.deepEqual(Object.keys(relay.NetworkingConfig.EndpointsConfig), [NET, AGENTS]);
  assert.deepEqual(Object.keys(m.containers.get(RELAY)!.inspect.NetworkSettings.Networks).sort(), [AGENTS, NET]);
  assert.equal(ds.NetworkingConfig, undefined, "the Document Server is on the island alone");
  assert.ok(!ds.Env.some((e: string) => e.includes(KEY)), "the Document Server is not given the relay's key");

  assert.deepEqual(readDsRecord(root), { containerId: m.containers.get(DS_NAME)!.info.id, imageTag: TAG92 });
  assert.equal(await dsOrigin(m.docker), "http://127.0.0.1:3890");
  m.state.exec = { output: "", exitCode: 0, timedOut: false }; // done setting itself up (see settled)
  const s = await status(m.docker);
  assert.equal(s.state, "running");
  assert.deepEqual(s.pull, { active: false, line: "done" });
});

test("ensure (portal on the machine or in a container): nothing of Office's shares the portal's network; every container is on the island", async () => {
  for (const [shared, reach] of [["host", { host: "127.0.0.1", port: 3890 }], ["container:abc123", { host: RELAY, port: 3890 }]] as const) {
    const m = fresh({ sharedNetwork: shared, reach });
    await ensureContainer(m.docker, undefined, tmpRoot());
    assert.ok(!m.calls.includes("sharedNetwork"), "the portal's own network is never asked for");
    assert.deepEqual([...m.containers.keys()].sort(), [DS_NAME, RELAY]);
    for (const c of m.containers.values()) assert.equal((c.spec.HostConfig as { NetworkMode: string }).NetworkMode, NET);
    assert.equal(await dsOrigin(m.docker), `http://${reach.host}:3890`);
  }
});

test("ensure (everything running and current): nothing made or started again, {started:false}", async () => {
  const root = tmpRoot();
  const m = fresh();
  await ensureContainer(m.docker, undefined, root);
  m.calls.length = 0;
  assert.deepEqual(await ensureContainer(m.docker, undefined, root), { started: false });
  assert.deepEqual(m.calls.filter((c) => c.startsWith("create") || c.startsWith("start")), []);
});

test("ensure (a Document Server of the version before, on the host's network): made again on the island, the volume kept", async () => {
  const root = tmpRoot();
  const m = fresh();
  m.put(DS_NAME, { Image: DEFAULT_TAG, Env: [], HostConfig: { NetworkMode: "host", Binds: [`${DS_VOLUME}:/var/www/onlyoffice/Data`] } }, { state: "running" });
  await ensureContainer(m.docker, undefined, root);
  assert.ok(m.calls.includes(`create ${DS_NAME}`));
  assert.equal(made(m, DS_NAME).HostConfig.NetworkMode, NET);
  assert.ok(!m.calls.includes(`remove volume ${DS_VOLUME}`));
});

test("ensure (a network made again since): a container on the old one is made again", async () => {
  const root = tmpRoot();
  const m = fresh();
  await ensureContainer(m.docker, undefined, root);
  m.networks.get(NET)!.id = "net-new";
  m.calls.length = 0;
  await ensureContainer(m.docker, undefined, root);
  assert.ok(m.calls.includes(`create ${DS_NAME}`));
  assert.ok(m.calls.includes(`create ${RELAY}`));
});

test("ensure (another relay key): only the relay is made again, the Document Server keeps running", async () => {
  const root = tmpRoot();
  const m = fresh();
  await ensureContainer(m.docker, undefined, root);
  fs.writeFileSync(path.join(root, "relay-secret"), "x".repeat(64));
  m.calls.length = 0;
  assert.deepEqual(await ensureContainer(m.docker, undefined, root), { started: false });
  assert.deepEqual(m.calls.filter((c) => c.startsWith("create")), [`create ${RELAY}`]);
  assert.ok(made(m, RELAY).Env.includes(`TUNNEL_KEY=${"x".repeat(64)}`));
});

test("ensure (another image tag): a running Document Server is left as it runs, a stopped one is made with the new tag", async () => {
  const root = tmpRoot({ imageTag: DEFAULT_TAG });
  const m = fresh();
  await ensureContainer(m.docker, undefined, root);
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: true, imageTag: TAG92 }));
  m.calls.length = 0;
  await ensureContainer(m.docker, undefined, root);
  assert.ok(!m.calls.includes(`create ${DS_NAME}`), "no editing session ends for a tag change");
  assert.equal(made(m, DS_NAME).Image, DEFAULT_TAG);

  await m.docker.containers.stop(DS_NAME);
  await ensureContainer(m.docker, undefined, root);
  assert.equal(made(m, DS_NAME).Image, TAG92);
});

test("ensure (a container nobody owns by that name): taken over and made again; another extension's: refused", async () => {
  const root = tmpRoot();
  const m = fresh();
  m.put(DS_NAME, { Image: DEFAULT_TAG }, { owner: "", state: "exited" });
  await ensureContainer(m.docker, undefined, root);
  assert.ok(m.calls.includes(`adopt ${DS_NAME}`));
  assert.equal(m.containers.get(DS_NAME)!.info.state, "running");

  const other = fresh();
  other.put(RELAY, { Image: "x" }, { owner: "@someone/else", state: "running" });
  await assert.rejects(ensureContainer(other.docker, undefined, tmpRoot()), (e: Error & { code?: string }) => e.code === "foreign" && /@someone\/else/.test(e.message));
});

test("ensure (no relay key yet): the plain fs error, nothing made", async () => {
  const m = fresh();
  const root = tmpRoot();
  fs.rmSync(path.join(root, "relay-secret"));
  await assert.rejects(ensureContainer(m.docker, undefined, root), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
  assert.ok(!m.calls.some((c) => c.startsWith("create")));
});

test("ensure (docker unavailable): the no_docker error; (missing jwt-secret): the plain fs error", async () => {
  const m = fresh({ available: false });
  await assert.rejects(ensureContainer(m.docker, undefined, tmpRoot()), (e: Error & { code?: string }) => e.code === "no_docker");
  await assert.rejects(ensureContainer(fresh().docker, undefined, tmpRoot({}, null)), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
});

/* ---------------- stop, remove, lookAfter ---------------- */

test("stop: the Document Server stopped and the intent recorded; lookAfter stays quiet; a Start clears it", async () => {
  const root = tmpRoot({ enabled: true });
  const m = fresh();
  await ensureContainer(m.docker, undefined, root);
  await stopContainer(m.docker, root);
  assert.equal(m.containers.get(DS_NAME)!.info.state, "exited");
  assert.equal(m.containers.get(RELAY)!.info.state, "running", "the relay holds nothing and keeps running");
  assert.ok(userStopped(root));
  m.calls.length = 0;
  await lookAfter(m.docker, root);
  assert.deepEqual(m.calls, []);
  await ensureContainer(m.docker, undefined, root);
  assert.equal(userStopped(root), false);
  assert.equal(m.containers.get(DS_NAME)!.info.state, "running");
});

test("remove: the relay, the Document Server and the network; the Document Server's volumes, every one, only when asked", async () => {
  const root = tmpRoot({ enabled: true });
  const m = fresh();
  await ensureContainer(m.docker, undefined, root);
  m.calls.length = 0;
  await removeContainers(false, m.docker, root);
  assert.deepEqual(m.calls, [`remove ${RELAY}`, `remove ${DS_NAME}`, `remove network ${NET}`, `remove network ${AGENTS}`]);
  assert.equal(readDsRecord(root), null);
  assert.ok(userStopped(root), "lookAfter does not make it all again");
  await ensureContainer(m.docker, undefined, root);
  m.calls.length = 0;
  await removeContainers(true, m.docker, root);
  assert.deepEqual(m.calls.filter((c) => c.startsWith("remove volume")), VOLUMES.map((v) => `remove volume ${v}`));
  assert.equal(m.volumes.size, 0);
});

test("lookAfter: off -> nothing; on -> all made; all running -> nothing made; the relay gone -> made again", async () => {
  const root = tmpRoot({ enabled: false });
  const m = fresh();
  await lookAfter(m.docker, root);
  assert.ok(!m.calls.some((c) => c.startsWith("create")));
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: true, imageTag: DEFAULT_TAG }));
  await lookAfter(m.docker, root);
  assert.equal(m.containers.get(DS_NAME)?.info.state, "running");
  m.calls.length = 0;
  await lookAfter(m.docker, root);
  assert.ok(!m.calls.some((c) => c.startsWith("create")));
  m.containers.delete(RELAY);
  await lookAfter(m.docker, root);
  assert.ok(m.calls.includes(`create ${RELAY}`));
  // An install from before the agents' network: it is made, and the relay made again on it.
  m.networks.delete(AGENTS);
  m.calls.length = 0;
  await lookAfter(m.docker, root);
  assert.ok(m.calls.includes(`network ${AGENTS}`) && m.calls.includes(`create ${RELAY}`), m.calls.join(", "));
  assert.ok(!m.calls.includes(`create ${DS_NAME}`), "the Document Server runs on");
});

test("lookAfter: all running but the Document Server does not answer through the way in: the way in is asked for again", async () => {
  const root = tmpRoot({ enabled: true });
  const m = fresh({ reach: { host: "127.0.0.1", port: 9 } });
  await ensureContainer(m.docker, undefined, root);
  m.calls.length = 0;
  await lookAfter(m.docker, root);
  assert.deepEqual(m.calls.filter((c) => c.startsWith("reach")), [`reach ${NET} ${RELAY} 3890`]);
});

/* ---------------- status ---------------- */

test("status: absent -> stopped; running -> the version and the memory use read in the container; starting; exited -> stopped", async () => {
  const m = fresh();
  assert.equal((await status(m.docker)).state, "stopped");
  m.put(DS_NAME, stamped(dsSpec(DEFAULT_TAG, [], NET)), { state: "running" });
  m.state.exec = { output: "10.0.0-169\n9175040\n", exitCode: 0, timedOut: false };
  const s = await status(m.docker);
  assert.equal(s.state, "running");
  assert.equal(s.version, "10.0.0-169");
  assert.equal(s.memBytes, 9175040);
  assert.ok(m.calls.some((c) => c.startsWith(`exec ${DS_NAME} sh -c dpkg-query`) && c.includes("memory.current")));
  // Kept for a while: the page polls every 5 s.
  await status(m.docker);
  assert.equal(m.calls.filter((c) => c.includes("dpkg-query")).length, 1);

  m.containers.get(DS_NAME)!.inspect.State = { Status: "running", Running: true, Starting: true };
  assert.equal((await status(m.docker)).state, "starting");
  m.containers.get(DS_NAME)!.info.state = "exited";
  assert.equal((await status(m.docker)).state, "stopped");
  assert.equal((await status(fresh({ available: false }).docker)).state, "stopped");
});

test("status: an answer that is no version or number leaves both out", async () => {
  const m = fresh();
  m.put(DS_NAME, { Image: DEFAULT_TAG }, { state: "running" });
  m.state.exec = { output: "sh: dpkg-query: not found\n", exitCode: 127, timedOut: false };
  const s = await status(m.docker);
  assert.equal(s.version, undefined);
  assert.equal(s.memBytes, undefined);
});

test("a new Document Server that still makes its fonts is starting, and refused to an editor, until its set-up script is done", async () => {
  const m = fresh();
  const ds = m.put(DS_NAME, stamped(dsSpec(DEFAULT_TAG, [], NET)), { state: "running" });
  ds.inspect.Id = "cid-ds";
  ds.inspect.State = { Status: "running", Running: true, StartedAt: "2026-10-25T13:50:58Z" };
  // Its start script makes AllFonts.js and the rest in the background, then restarts the Document Server's services.
  let making = true;
  m.state.answer = (cmd) => {
    const script = cmd.join(" ");
    if (script.includes("AllFonts.js")) {
      assert.match(script, /pgrep -f "documentserver-generate-allfont\[s\]"/, "the bracket keeps pgrep from finding the shell that asks");
      return { output: "", exitCode: making ? 1 : 0, timedOut: false };
    }
    return { output: "10.0.0-169\n9175040\n", exitCode: 0, timedOut: false };
  };
  let s = await status(m.docker);
  assert.equal(s.state, "starting", "it answers its health check, but would restart under an editor");
  assert.equal(s.version, undefined);
  assert.equal(await settled(m.docker), false);

  making = false;
  s = await status(m.docker);
  assert.equal(s.state, "running");
  assert.equal(s.version, "10.0.0-169");
  // Set up stays set up for this run of the container: not asked again at every poll.
  const asked = () => m.calls.filter((c) => c.includes("AllFonts.js")).length;
  const before = asked();
  assert.equal(await settled(m.docker), true);
  await status(m.docker);
  assert.equal(asked(), before);
  // Started again (or made again): asked again.
  ds.inspect.State = { Status: "running", Running: true, StartedAt: "2026-10-25T14:10:00Z" };
  making = true;
  assert.equal(await settled(m.docker), false);

  // Where it cannot be asked, nothing is held back: what is wrong is said where it is.
  m.state.answer = () => ({ output: "", exitCode: null, timedOut: true });
  assert.equal(await settled(m.docker), true);
  assert.equal(await settled(fresh({ available: false }).docker), true);
  const stopped = fresh();
  stopped.put(DS_NAME, stamped(dsSpec(DEFAULT_TAG, [], NET)), { state: "exited" });
  assert.equal(await settled(stopped.docker), true);
});

/* ---------------- the relay's program and the way back ---------------- */

async function freePort(): Promise<number> {
  const s = net.createServer().listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

function run(script: string, env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["-e", script], { env: { ...process.env, ...env }, stdio: "ignore" });
}

async function connectable(at: net.NetConnectOpts): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(at, () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`nothing listens at ${JSON.stringify(at)}`);
}

/** The relay's program, run with this Node, before a Document Server and a listener of the test's own, and the way
 * back of back.ts holding its tunnels to it. */
async function relayWorld(options: { pool?: number } = {}) {
  const ds = http.createServer((req, res) => res.end(`ds ${req.method} ${req.url}`)).listen(0, "127.0.0.1");
  const listener = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res.end(`listener ${req.method} ${req.url} ${Buffer.concat(chunks)}`));
  }).listen(0, "127.0.0.1");
  await Promise.all([once(ds, "listening"), once(listener, "listening")]);
  const [inPort, backPort] = [await freePort(), await freePort()];
  const env = { IN_PORT: String(inPort), DS_HOST: "127.0.0.1", DS_PORT: String((ds.address() as AddressInfo).port), BACK_PORT: String(backPort), TUNNEL_KEY: KEY };
  let relay = run(RELAY_SCRIPT, env);
  await connectable({ port: inPort, host: "127.0.0.1" });
  await connectable({ port: backPort, host: "127.0.0.1" });
  const reach = Promise.resolve({ host: "127.0.0.1", port: inPort });
  const way = holdWayBack({ at: () => reach, key: KEY, to: () => (listener.address() as AddressInfo).port, pool: options.pool });
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(check(), what);
  };
  return {
    inPort,
    backPort,
    way,
    until,
    async restartRelay() {
      relay.kill("SIGTERM");
      await once(relay, "exit");
      relay = run(RELAY_SCRIPT, env);
      await connectable({ port: inPort, host: "127.0.0.1" });
    },
    close() {
      way.stop();
      relay.kill("SIGTERM");
      for (const s of [ds, listener]) {
        s.closeAllConnections();
        s.close();
      }
    },
  };
}

/** A raw connection's whole answer, once the other side closes it (or after `ms`). */
function answerOf(port: number, send: Buffer | string, ms = 2000): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const s = net.connect({ port, host: "127.0.0.1" }, () => s.write(send));
    s.on("data", (c) => chunks.push(c));
    const done = () => resolve(Buffer.concat(chunks).toString());
    s.on("close", done);
    s.on("error", () => {});
    setTimeout(() => {
      s.destroy();
      done();
    }, ms).unref();
  });
}

test("the relay: the way in reaches the Document Server, and the way back reaches the listener through a tunnel the portal holds", async () => {
  const w = await relayWorld();
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${w.inPort}/healthcheck`)).text(), "ds GET /healthcheck");
    await w.until(() => w.way.waiting() === 4, "the portal's tunnels wait at the relay");
    const back = await fetch(`http://127.0.0.1:${w.backPort}/callback`, { method: "POST", body: '{"status":2}' });
    assert.equal(await back.text(), 'listener POST /callback {"status":2}');
    // More requests at once than tunnels wait: each waits for the next, which the portal opens as one is taken.
    const many = await Promise.all(Array.from({ length: 10 }, (_, i) => fetch(`http://127.0.0.1:${w.backPort}/doc/${i}`).then((r) => r.text())));
    assert.deepEqual(many, Array.from({ length: 10 }, (_, i) => `listener GET /doc/${i} `));
    await w.until(() => w.way.waiting() === 4, "and the pool is full again");
  } finally {
    w.close();
  }
});

test("the relay: a connection that opens with a NUL but not the key is closed, and is never handed the Document Server's requests", async () => {
  const w = await relayWorld({ pool: 1 });
  try {
    await w.until(() => w.way.waiting() === 1, "the portal's tunnel waits");
    assert.equal(await answerOf(w.inPort, hello("w".repeat(64))), "", "a wrong key is closed with nothing said");
    assert.equal(await answerOf(w.inPort, Buffer.concat([hello(KEY), Buffer.from("GET / HTTP/1.1\r\n\r\n")])), "", "nor may a tunnel send anything of its own");
    // A taker with the wrong key waits for nothing: the request goes to the portal's own tunnel.
    const thief = net.connect({ port: w.inPort, host: "127.0.0.1" }, () => thief.write(hello("w".repeat(64))));
    thief.on("error", () => {});
    const got: Buffer[] = [];
    thief.on("data", (c) => got.push(c));
    const back = await fetch(`http://127.0.0.1:${w.backPort}/callback`, { method: "POST", body: "x" });
    assert.equal(await back.text(), "listener POST /callback x");
    assert.equal(Buffer.concat(got).length, 0);
    thief.destroy();
  } finally {
    w.close();
  }
});

test("the way back comes back by itself after the relay restarted, as after any restart on either side", async () => {
  const w = await relayWorld({ pool: 2 });
  try {
    await w.until(() => w.way.waiting() === 2, "the portal's tunnels wait");
    await w.restartRelay();
    await w.until(() => w.way.waiting() === 2, "the tunnels are opened again to the new relay");
    const back = await fetch(`http://127.0.0.1:${w.backPort}/callback`, { method: "POST", body: "after" });
    assert.equal(await back.text(), "listener POST /callback after");
  } finally {
    w.close();
  }
});

test("the way back goes only where the way in was given, and opens its tunnels at once when it is given anew", async () => {
  const m = fresh({ reach: { host: "127.0.0.1", port: 9 } });
  assert.equal(reachedNow(), undefined, "nothing before the first ask: the way back waits, and asks Docker for nothing");
  let nudged = 0;
  whenReached(() => nudged++);
  try {
    await reachAgain(m.docker);
    assert.equal(nudged, 1);
    assert.deepEqual(await reachedNow(), { host: "127.0.0.1", port: 9 });
  } finally {
    whenReached(undefined);
  }
  assert.equal(m.calls.filter((c) => c.startsWith("reach")).length, 1);
});

/* ---------------- the agents' browser ---------------- */

const AGENT = "pithagoras-office-ds-agent";
const PAGE = `http://${RELAY}:${BACK_PORT}/seat/${"a".repeat(64)}/`;

test("the agents' browser: on a network of its own alone, nothing published, hardened, not root, its profile in memory, the image by its digest", () => {
  assert.equal(NAMES.agent, AGENT);
  assert.match(AGENT_IMAGE_DIGEST, /^sha256:[0-9a-f]{64}$/);
  assert.equal(AGENT_IMAGE, `chromedp/headless-shell@${AGENT_IMAGE_DIGEST}`);
  assert.match(AGENT_IMAGE_TAG, /^chromedp\/headless-shell:\d+\.\d+\.\d+\.\d+$/, "a fixed Chromium build, never latest");
  const spec = agentSpec(AGENTS, PAGE) as Record<string, any>;
  assert.equal(spec.Image, AGENT_IMAGE);
  assert.equal(spec.User, "1000:1000");
  assert.deepEqual(spec.Entrypoint, ["/headless-shell/headless-shell"], "the image's own start script, which opens a debugging port, is not run");
  assert.equal(spec.Cmd.at(-1), PAGE);
  assert.ok(spec.Cmd.includes("--headless") && spec.Cmd.includes("--no-sandbox"));
  assert.ok(!spec.Cmd.some((a: string) => /remote-debugging/.test(a)), "no debugging port");
  const host = spec.HostConfig;
  assert.equal(host.NetworkMode, AGENTS);
  assert.equal(spec.NetworkingConfig, undefined, "on that one network alone");
  assert.equal(host.PortBindings, undefined);
  assert.equal(host.Privileged, undefined);
  assert.deepEqual(host.CapDrop, ["ALL"]);
  assert.deepEqual(host.SecurityOpt, ["no-new-privileges"]);
  assert.equal(host.ReadonlyRootfs, true);
  assert.equal(host.Memory, 3 * 1024 ** 3);
  assert.equal(host.PidsLimit, 512);
  assert.deepEqual(Object.keys(host.Tmpfs), ["/tmp"]);
  assert.equal(host.ShmSize, 512 * 1024 ** 2);
  assert.ok(host.LogConfig.Config["max-size"]);
  assert.ok(spec.Env.includes("HOME=/tmp"));
});

test("ensureAgent: made on the agents' network from the pinned image and started; as it is, nothing again; another page secret, made again; stopped, started", async () => {
  const root = tmpRoot({ enabled: true });
  const m = fresh();
  m.state.images.add(AGENT_IMAGE);
  await ensureContainer(m.docker, undefined, root);
  m.calls.length = 0;
  await ensureAgent(PAGE, m.docker, root);
  assert.deepEqual(m.calls, [`create ${AGENT}`, `start ${AGENT}`]);
  const spec = made(m, AGENT);
  assert.equal(spec.Image, AGENT_IMAGE);
  assert.equal(spec.HostConfig.NetworkMode, AGENTS);
  assert.deepEqual(Object.keys(m.containers.get(AGENT)!.inspect.NetworkSettings.Networks), [AGENTS], "not on the island");
  assert.deepEqual(spec.HostConfig.RestartPolicy, { Name: "no" }, "never started again by Docker with a page secret of a run gone by");
  m.calls.length = 0;
  await ensureAgent(PAGE, m.docker, root);
  assert.deepEqual(m.calls, []);
  await ensureAgent(PAGE.replace("aaaa", "bbbb"), m.docker, root);
  assert.deepEqual(m.calls, [`create ${AGENT}`, `start ${AGENT}`]);
  m.containers.get(AGENT)!.inspect.State = { Status: "exited", Running: false };
  m.calls.length = 0;
  await ensureAgent(PAGE.replace("aaaa", "bbbb"), m.docker, root);
  assert.deepEqual(m.calls, [`start ${AGENT}`]);
  assert.ok(!(m.calls as string[]).some((c) => c.startsWith("pull")));
});

test("ensureAgent never downloads: without the image it is agent_editor_missing; with Office stopped office_stopped; without its network office_stopped", async () => {
  const root = tmpRoot({ enabled: true });
  const m = fresh();
  await ensureContainer(m.docker, undefined, root);
  m.calls.length = 0;
  await assert.rejects(ensureAgent(PAGE, m.docker, root), (e: Error & { code?: string }) => e.code === "agent_editor_missing");
  assert.ok(!m.calls.some((c) => c.startsWith("pull") || c.startsWith("create")), m.calls.join(", "));
  m.state.images.add(AGENT_IMAGE);
  await stopContainer(m.docker, root);
  await assert.rejects(ensureAgent(PAGE, m.docker, root), (e: Error & { code?: string }) => e.code === "office_stopped");
  assert.equal(m.containers.get(AGENT), undefined);
  const bare = fresh();
  bare.state.images.add(AGENT_IMAGE);
  await assert.rejects(ensureAgent(PAGE, bare.docker, tmpRoot({ enabled: true })), (e: Error & { code?: string }) => e.code === "office_stopped");
});

test("the browser goes when Office stops, when it is removed (before its network), and by stopAgent; lookAfter never starts it", async () => {
  const root = tmpRoot({ enabled: true });
  const m = fresh();
  m.state.images.add(AGENT_IMAGE);
  await ensureContainer(m.docker, undefined, root);
  await ensureAgent(PAGE, m.docker, root);
  await stopAgent(m.docker);
  assert.equal(m.containers.get(AGENT), undefined);
  await ensureAgent(PAGE, m.docker, root);
  await stopContainer(m.docker, root);
  assert.equal(m.containers.get(AGENT), undefined, "stopped with the Document Server");
  await ensureContainer(m.docker, undefined, root);
  await ensureAgent(PAGE, m.docker, root);
  m.calls.length = 0;
  await removeContainers(false, m.docker, root);
  assert.deepEqual(m.calls.slice(0, 2), [`remove ${AGENT}`, `remove ${RELAY}`]);
  // lookAfter makes the Document Server and its relay, never the browser.
  const n = fresh();
  n.state.images.add(AGENT_IMAGE);
  await lookAfter(n.docker, tmpRoot({ enabled: true }));
  assert.ok(n.containers.get(DS_NAME));
  assert.equal(n.containers.get(AGENT), undefined);
});

test("the browser's image: downloaded by its tag on request, then there by its digest; a tag that names another build is refused", async () => {
  const m = fresh();
  assert.deepEqual(await agentImage(m.docker), { present: false, pull: null });
  // Docker has the pinned build under the tag: the digest is there after the download.
  const ensure = m.docker.images.ensure;
  m.docker.images.ensure = async (image, onProgress) => {
    await ensure(image, onProgress);
    if (image === AGENT_IMAGE_TAG) m.state.images.add(AGENT_IMAGE);
  };
  await pullAgentImage(m.docker);
  assert.ok(m.calls.includes(`pull ${AGENT_IMAGE_TAG}`));
  assert.deepEqual(await agentImage(m.docker), { present: true, pull: { active: false, line: "done" } });
  // The tag moved on: what was downloaded is not the pinned build.
  const n = fresh();
  await assert.rejects(pullAgentImage(n.docker), (e: Error & { code?: string }) => e.code === "agent_editor_missing" && e.message.includes(AGENT_IMAGE_DIGEST));
  const after = await agentImage(n.docker);
  assert.equal(after.present, false);
  assert.match(after.pull?.error ?? "", /not the build/);
});

test("the browser's image: a download that cannot begin says why on the Office page (no Docker, a failing pull)", async () => {
  const m = fresh({ available: false });
  await assert.rejects(pullAgentImage(m.docker), (e: Error & { code?: string }) => e.code === "no_docker");
  assert.deepEqual((await agentImage(m.docker)).pull, { active: false, line: "", error: "Docker is not reachable" });
  const n = fresh();
  n.docker.images.ensure = async () => {
    throw new Error("pull access denied: no internet");
  };
  await assert.rejects(pullAgentImage(n.docker), /no internet/);
  assert.equal((await agentImage(n.docker)).pull?.error, "pull access denied: no internet");
  // Asked again with the image there (Docker says nothing of a download it need not make): no error, nothing under way.
  n.state.images.add(AGENT_IMAGE);
  n.docker.images.ensure = async () => {};
  await pullAgentImage(n.docker);
  assert.deepEqual(await agentImage(n.docker), { present: true, pull: null });
});

test("a start that (re)started the Document Server tells so (the agents' editors' sessions are over); one that found it running does not", async () => {
  const root = tmpRoot({ enabled: true });
  const m = fresh();
  let told = 0;
  whenDsStarted(() => told++);
  try {
    await ensureContainer(m.docker, undefined, root);
    assert.equal(told, 1);
    await ensureContainer(m.docker, undefined, root);
    assert.equal(told, 1, "running as it was: nothing ended");
    m.containers.get(DS_NAME)!.inspect.State = { Status: "exited", Running: false };
    await lookAfter(m.docker, root);
    assert.equal(told, 2, "revived after a crash");
  } finally {
    whenDsStarted(undefined);
  }
});

/* ---------------- Start: everything Office runs on ---------------- */

/** A Docker that has the pinned build of the agents' editor under its tag, as one would after downloading it. */
function pinnedTag(m: ReturnType<typeof fakeDocker>) {
  const ensure = m.docker.images.ensure;
  m.docker.images.ensure = async (image, onProgress) => {
    await ensure(image, onProgress);
    if (image === AGENT_IMAGE_TAG) m.state.images.add(AGENT_IMAGE);
  };
}

test("Start: the Document Server's images and the agents' editor's are downloaded at once, the Document Server started, and the image there by its digest", async () => {
  const root = tmpRoot({ enabled: true });
  const m = fresh();
  pinnedTag(m);
  const seen: string[] = [];
  const res = await startOffice(m.docker, (s) => seen.push(s.line), root);
  assert.deepEqual(res, { started: true, agent: { present: true } });
  // Both begin before either ends: the page shows both downloads.
  assert.deepEqual(m.calls.slice(0, 2).sort(), [`pull ${AGENT_IMAGE_TAG}`, `pull ${DEFAULT_TAG}`]);
  assert.ok(m.calls.includes(`pull ${RELAY_IMAGE}`) && m.calls.includes(`start ${DS_NAME}`));
  assert.equal(m.containers.get(AGENT), undefined, "the browser itself starts when an agent needs it");
  assert.deepEqual(await agentImage(m.docker), { present: true, pull: { active: false, line: "done" } });
  m.state.exec = { output: "", exitCode: 0, timedOut: false };
  assert.equal((await status(m.docker)).state, "running");
});

test("Start: an image of the agents' editor that cannot be downloaded leaves the Document Server running and says why; the next Start gets only the image", async () => {
  const root = tmpRoot({ enabled: true });
  const m = fresh();
  const ensure = m.docker.images.ensure;
  m.docker.images.ensure = async (image, onProgress) => {
    if (image === AGENT_IMAGE_TAG) throw new Error("pull access denied: no internet");
    return ensure(image, onProgress);
  };
  const res = await startOffice(m.docker, undefined, root);
  assert.deepEqual(res, { started: true, agent: { present: false, error: "pull access denied: no internet" } });
  assert.ok(m.containers.get(DS_NAME) && m.containers.get(RELAY));
  assert.equal((await agentImage(m.docker)).pull?.error, "pull access denied: no internet");
  // An install whose Document Server runs and whose image is missing (as one from before Start downloaded it).
  m.docker.images.ensure = ensure;
  pinnedTag(m);
  m.calls.length = 0;
  assert.deepEqual(await startOffice(m.docker, undefined, root), { started: false, agent: { present: true } });
  assert.deepEqual(m.calls.filter((c) => !c.startsWith("pull ") || c === `pull ${AGENT_IMAGE_TAG}`).filter((c) => /^(pull|create|start|remove|stop) /.test(c)), [`pull ${AGENT_IMAGE_TAG}`], "nothing made or started again");
  assert.deepEqual((await agentImage(m.docker)).present, true);
});

test("Start: a Document Server that cannot start fails it, and status says why until a start succeeds; a stop takes it back", async () => {
  const root = tmpRoot({ enabled: true });
  const m = fresh();
  pinnedTag(m);
  const start = m.docker.containers.start;
  m.docker.containers.start = async (name) => {
    if (name === DS_NAME) throw new Error("port is already allocated");
    return start(name);
  };
  await assert.rejects(startOffice(m.docker, undefined, root), /port is already allocated/);
  assert.equal((await status(m.docker)).error, "port is already allocated");
  assert.equal((await agentImage(m.docker)).present, true, "the image came all the same");
  m.docker.containers.start = start;
  await startOffice(m.docker, undefined, root);
  assert.equal((await status(m.docker)).error, undefined);
  m.containers.get(DS_NAME)!.inspect.State = { Status: "exited", Running: false }; // it crashed
  m.docker.containers.start = async () => {
    throw new Error("again");
  };
  await assert.rejects(ensureContainer(m.docker, undefined, root));
  assert.equal((await status(m.docker)).error, "again", "a start of lookAfter's says so too");
  await stopContainer(m.docker, root);
  assert.equal((await status(m.docker)).error, undefined);
  const gone = fresh({ available: false });
  await assert.rejects(startOffice(gone.docker, undefined, root), (e: Error & { code?: string }) => e.code === "no_docker");
  assert.equal((await status(m.docker)).error, "Docker is not reachable");
});

test("Start: a download of the Document Server's image that failed is over once a start succeeds with an image already there", async () => {
  const root = tmpRoot({ enabled: true, imageTag: TAG92 });
  const m = fresh();
  pinnedTag(m);
  const ensure = m.docker.images.ensure;
  // As the portal's ensure does: the failure said as the download's last state, then thrown.
  m.docker.images.ensure = async (image, onProgress) => {
    if (image === TAG92) {
      onProgress?.({ active: false, line: "", error: "manifest unknown" });
      throw new Error("manifest unknown");
    }
    return ensure(image, onProgress);
  };
  await assert.rejects(startOffice(m.docker, undefined, root), /manifest unknown/);
  assert.equal((await status(m.docker)).pull?.error, "manifest unknown");
  // The tag put right, its image there already: Docker downloads nothing and says nothing of it.
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: true, imageTag: DEFAULT_TAG }));
  m.state.images.add(DEFAULT_TAG);
  m.state.images.add(RELAY_IMAGE);
  m.docker.images.ensure = async (image, onProgress) => {
    if (m.state.images.has(image)) return;
    return ensure(image, onProgress);
  };
  await startOffice(m.docker, undefined, root);
  const now = await status(m.docker);
  assert.equal(now.error, undefined);
  assert.equal(now.pull?.error, undefined, "no old download error under a Document Server that runs");
});

test("the agents' editor's image: two downloads asked at once are one; lookAfter never downloads it", async () => {
  const m = fresh();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const ensure = m.docker.images.ensure;
  m.docker.images.ensure = async (image, onProgress) => {
    await held;
    await ensure(image, onProgress);
    if (image === AGENT_IMAGE_TAG) m.state.images.add(AGENT_IMAGE);
  };
  const one = pullAgentImage(m.docker);
  const two = pullAgentImage(m.docker);
  release();
  await Promise.all([one, two]);
  assert.equal(m.calls.filter((c) => c === `pull ${AGENT_IMAGE_TAG}`).length, 1);
  const n = fresh();
  await lookAfter(n.docker, tmpRoot({ enabled: true }));
  assert.ok(n.containers.get(DS_NAME));
  assert.ok(!n.calls.includes(`pull ${AGENT_IMAGE_TAG}`), n.calls.join(", "));
});
