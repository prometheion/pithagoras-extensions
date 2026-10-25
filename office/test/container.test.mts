/**
 * Unit tests for src/container.ts: the Document Server and its two relays over the fake Docker for extensions of
 * fake-docker.mts, with real tmp dirs for settings/jwt-secret/ds.json/user-stopped, and the relays' own programs run
 * with this Node against servers of the test's own. Nothing here reaches the Docker socket or portal().
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
  BACK_PORT,
  DS_NAME,
  DS_VOLUME,
  NAMES,
  PORTAL_SCRIPT,
  RELAY_IMAGE,
  RELAY_SCRIPT,
  dsOrigin,
  dsSpec,
  ensureContainer,
  forgetProbe,
  forgetReach,
  lookAfter,
  officeNames,
  portalSideSpec,
  readDsRecord,
  removeContainers,
  setBackPort,
  status,
  stopContainer,
  userStopped,
} from "../src/container";
import { fakeDocker } from "./fake-docker.mts";

const DEFAULT_TAG = "onlyoffice/documentserver:10.0.0.1";
const TAG92 = "onlyoffice/documentserver:9.2.1.1";
const NET = "pithagoras-office-ds-net";
const RELAY = "pithagoras-office-ds-relay";
const PORTAL_SIDE = "pithagoras-office-ds-portal";
const SOCK = "pithagoras-office-ds-relay-sock";

function tmpRoot(settings: Record<string, unknown> = {}, secret: string | null = "s3cret\n"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-container-"));
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: false, imageTag: DEFAULT_TAG, ...settings }));
  if (secret !== null) fs.writeFileSync(path.join(root, "jwt-secret"), secret);
  return root;
}

function fresh(options?: Parameters<typeof fakeDocker>[0]) {
  forgetReach();
  forgetProbe();
  setBackPort(41234);
  return fakeDocker(options);
}

const made = (m: ReturnType<typeof fakeDocker>, name: string) => m.containers.get(name)!.spec as Record<string, any>;

/* ---------------- the names ---------------- */

test("the names: the Document Server, its volume, network and relays, each from the environment where it says so", () => {
  assert.equal(DS_NAME, "pithagoras-office-ds");
  assert.equal(DS_VOLUME, "pithagoras-office-ds-data");
  assert.deepEqual([NAMES.network, NAMES.relay, NAMES.portalSide, NAMES.sock, NAMES.port], [NET, RELAY, PORTAL_SIDE, SOCK, 3890]);
  const other = officeNames({ PITHAGORAS_OFFICE_CONTAINER: "office-test", PITHAGORAS_OFFICE_PORT: "4890" });
  assert.deepEqual([other.container, other.volume, other.network, other.relay, other.portalSide, other.sock, other.port], ["office-test", "office-test-data", "office-test-net", "office-test-relay", "office-test-portal", "office-test-relay-sock", 4890]);
});

/* ---------------- ensure: the fresh path ---------------- */

test("ensure (fresh): both images, both volumes, the island, the Document Server on it, the relays, the way in, ds.json", async () => {
  const root = tmpRoot({ enabled: true, imageTag: TAG92 });
  const m = fresh();
  const seen: string[] = [];
  const res = await ensureContainer(m.docker, (s) => seen.push(s.line), root);
  assert.deepEqual(res, { started: true });
  assert.deepEqual(m.calls.filter((c) => !c.startsWith("sharedNetwork")), [
    `pull ${TAG92}`,
    `pull ${RELAY_IMAGE}`,
    `volume ${DS_VOLUME}`,
    `volume ${SOCK}`,
    `network ${NET}`,
    `create ${DS_NAME}`,
    `start ${DS_NAME}`,
    `create ${RELAY}`,
    `start ${RELAY}`,
    `create ${PORTAL_SIDE}`,
    `start ${PORTAL_SIDE}`,
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
  assert.deepEqual(ds.HostConfig.Binds, [`${DS_VOLUME}:/var/www/onlyoffice/Data`]);
  assert.deepEqual(ds.HostConfig.RestartPolicy, { Name: "unless-stopped" });
  assert.deepEqual(ds.Env, ["JWT_ENABLED=true", "JWT_SECRET=s3cret", "JWT_HEADER=X-Auth-Token", "JWT_IN_BODY=false", "PLUGINS_ENABLED=false"]);
  assert.ok(!ds.Env.some((e: string) => e.startsWith("ALLOW_PRIVATE_IP_ADDRESS")));
  assert.match(ds.Labels["pithagoras.extension-spec"], /^[0-9a-f]{16}$/);

  // The island's relay: the way in to the Document Server's port 80, the way back to the socket, hardened as the
  // forwarder of Docker for extensions is.
  const relay = made(m, RELAY);
  assert.equal(relay.Image, RELAY_IMAGE);
  assert.equal(relay.User, "1000:1000");
  assert.deepEqual(relay.Cmd, ["node", "-e", RELAY_SCRIPT]);
  assert.deepEqual(relay.Env, ["IN_PORT=3890", `DS_HOST=${DS_NAME}`, "DS_PORT=80", `BACK_PORT=${BACK_PORT}`, "BACK_SOCKET=/home/node/portal.sock"]);
  for (const spec of [relay, made(m, PORTAL_SIDE)]) {
    assert.deepEqual(spec.HostConfig.Binds, [`${SOCK}:/home/node`]);
    assert.deepEqual(spec.HostConfig.CapDrop, ["ALL"]);
    assert.deepEqual(spec.HostConfig.SecurityOpt, ["no-new-privileges"]);
    assert.equal(spec.HostConfig.ReadonlyRootfs, true);
    assert.equal(spec.HostConfig.Memory, 128 * 1024 ** 2);
    assert.equal(spec.HostConfig.PidsLimit, 64);
  }
  assert.equal(relay.HostConfig.NetworkMode, NET);
  // The portal-side relay: on the portal's own loopback, to the listener's port.
  const side = made(m, PORTAL_SIDE);
  assert.equal(side.HostConfig.NetworkMode, "host");
  assert.deepEqual(side.Env, ["BACK_SOCKET=/home/node/portal.sock", "TO_PORT=41234"]);
  assert.deepEqual(side.Cmd, ["node", "-e", PORTAL_SCRIPT]);

  assert.deepEqual(readDsRecord(root), { containerId: m.containers.get(DS_NAME)!.info.id, imageTag: TAG92 });
  assert.equal(await dsOrigin(m.docker), "http://127.0.0.1:3890");
  const s = await status(m.docker);
  assert.equal(s.state, "running");
  assert.deepEqual(s.pull, { active: false, line: "done" });
});

test("ensure (portal in a container): the portal-side relay shares the portal container's namespace, and the way in is by name", async () => {
  const root = tmpRoot();
  const m = fresh({ sharedNetwork: "container:abc123", reach: { host: RELAY, port: 3890 } });
  await ensureContainer(m.docker, undefined, root);
  assert.equal(made(m, PORTAL_SIDE).HostConfig.NetworkMode, "container:abc123");
  assert.equal(made(m, DS_NAME).HostConfig.NetworkMode, NET);
  assert.equal(await dsOrigin(m.docker), `http://${RELAY}:3890`);
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
  assert.ok(!m.calls.includes(`create ${PORTAL_SIDE}`), "the portal-side relay is not on the island");
});

test("ensure (the listener on another port after a restart): only the portal-side relay is made again", async () => {
  const root = tmpRoot();
  const m = fresh();
  await ensureContainer(m.docker, undefined, root);
  setBackPort(45678);
  m.calls.length = 0;
  assert.deepEqual(await ensureContainer(m.docker, undefined, root), { started: false });
  assert.deepEqual(m.calls.filter((c) => c.startsWith("create")), [`create ${PORTAL_SIDE}`]);
  assert.ok(made(m, PORTAL_SIDE).Env.includes("TO_PORT=45678"));
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

test("ensure (before the listener runs): refused, nothing made", async () => {
  const m = fresh();
  setBackPort(0);
  await assert.rejects(ensureContainer(m.docker, undefined, tmpRoot()), (e: Error & { code?: string }) => e.code === "not_ready");
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
  assert.equal(m.containers.get(RELAY)!.info.state, "running", "the relays hold nothing and keep running");
  assert.ok(userStopped(root));
  m.calls.length = 0;
  await lookAfter(m.docker, root);
  assert.deepEqual(m.calls, []);
  await ensureContainer(m.docker, undefined, root);
  assert.equal(userStopped(root), false);
  assert.equal(m.containers.get(DS_NAME)!.info.state, "running");
});

test("remove: the relays, the Document Server, the network and the socket volume; the data volume only when asked", async () => {
  const root = tmpRoot({ enabled: true });
  const m = fresh();
  await ensureContainer(m.docker, undefined, root);
  m.calls.length = 0;
  await removeContainers(false, m.docker, root);
  assert.deepEqual(m.calls, [`remove ${PORTAL_SIDE}`, `remove ${RELAY}`, `remove ${DS_NAME}`, `remove network ${NET}`, `remove volume ${SOCK}`]);
  assert.equal(readDsRecord(root), null);
  assert.ok(userStopped(root), "lookAfter does not make it all again");
  await ensureContainer(m.docker, undefined, root);
  m.calls.length = 0;
  await removeContainers(true, m.docker, root);
  assert.ok(m.calls.includes(`remove volume ${DS_VOLUME}`));
});

test("lookAfter: off -> nothing; on -> all made; all running -> nothing made; a relay gone -> made again", async () => {
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
  m.containers.delete(PORTAL_SIDE);
  await lookAfter(m.docker, root);
  assert.ok(m.calls.includes(`create ${PORTAL_SIDE}`));
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
  assert.equal(m.calls.filter((c) => c.startsWith("exec")).length, 1);

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

/* ---------------- the relays' programs ---------------- */

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

test("the relays' programs: the way in reaches the Document Server, and the way back reaches the listener through the socket", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "office-relay-"));
  const sock = path.join(dir, "portal.sock");
  // The Document Server and the extension's listener, as far as the relays are concerned.
  const ds = http.createServer((req, res) => res.end(`ds ${req.url}`)).listen(0, "127.0.0.1");
  const listener = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res.end(`listener ${req.method} ${req.url} ${Buffer.concat(chunks)}`));
  }).listen(0, "127.0.0.1");
  await Promise.all([once(ds, "listening"), once(listener, "listening")]);
  const [inPort, backPort] = [await freePort(), await freePort()];
  fs.writeFileSync(sock, "left by the one before");
  const relay = run(RELAY_SCRIPT, { IN_PORT: String(inPort), DS_HOST: "127.0.0.1", DS_PORT: String((ds.address() as AddressInfo).port), BACK_PORT: String(backPort), BACK_SOCKET: sock });
  const side = run(PORTAL_SCRIPT, { BACK_SOCKET: sock, TO_PORT: String((listener.address() as AddressInfo).port) });
  try {
    await connectable({ port: inPort, host: "127.0.0.1" });
    await connectable({ path: sock });
    assert.equal(await (await fetch(`http://127.0.0.1:${inPort}/healthcheck`)).text(), "ds /healthcheck");
    const back = await fetch(`http://127.0.0.1:${backPort}/callback`, { method: "POST", body: '{"status":2}' });
    assert.equal(await back.text(), 'listener POST /callback {"status":2}');
  } finally {
    relay.kill("SIGTERM");
    side.kill("SIGTERM");
    ds.closeAllConnections();
    listener.closeAllConnections();
    ds.close();
    listener.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the portal-side relay's spec changes with the portal's container and the listener's port, so either makes it again", () => {
  const key = "pithagoras.extension-spec";
  const label = (mode: string, port: number) => (stamped(portalSideSpec(mode, port)).Labels as Record<string, string>)[key];
  assert.notEqual(label("host", 1000), label("container:new", 1000));
  assert.notEqual(label("host", 1000), label("host", 1001));
});
