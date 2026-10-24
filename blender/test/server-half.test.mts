import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { openStore } from "../../shared/store.ts";
import { fakeMcp, fakePortal, memoryDocker, TOOLS } from "./fakes.mts";

/**
 * Blender's server half as the portal starts it: its routes at /api/x/@pithagoras/blender, its tools, its viewer through
 * the proxy, with Docker in memory and an MCP server standing in for the container where Docker's reach says the
 * portal reaches it.
 */

async function start() {
  const fake = fakePortal();
  // The token is made before the half starts, so that the stand-in server can ask for it.
  const server = await fakeMcp(openStore(fake.dataDir).token());
  delete process.env.PITHAGORAS_BLENDER_PORT;
  const d = memoryDocker();
  // The server's own port is the default; the portal reaches it where reach says, the stand-in's port.
  d.state.reach = { host: "127.0.0.1", port: server.port };
  d.state.onStart = (c) => {
    if (c.name !== "pithagoras-blender-probe") return;
    c.log = "0, GPU-1b1b1b1b, NVIDIA GeForce RTX 3060, 158, 12288\nOPTIX=host\n";
    c.state = "exited";
  };
  fake.uses.set("pithagoras-docker", d.docker);
  const { default: blender } = await import("../src/server.ts");
  const stop = blender(fake.portal);
  const at = await fake.serve();
  return { fake, server, d, at, stop };
}

const json = (url: string, init?: RequestInit) => fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("Settings → Blender through install to running, with its tools in every chat and its viewer through the portal", async () => {
  const { fake, server, d, at, stop } = await start();
  assert.equal((await json(`${at}/state`)).body.state, "absent");

  const hardware = await json(`${at}/hardware`);
  assert.deepEqual(hardware.body.cards.map((c: { uuid: string }) => c.uuid), ["GPU-1b1b1b1b"]);
  assert.equal(hardware.body.optix, "host");
  assert.equal(hardware.body.pinned, false);

  assert.equal((await json(`${at}/install`, { method: "POST", headers: { "sec-fetch-site": "same-origin" } })).status, 200);
  let state;
  for (let i = 0; i < 200; i++) {
    state = (await json(`${at}/state`)).body;
    if (state.state === "running") break;
    await delay(10);
  }
  assert.equal(state.state, "running");
  assert.deepEqual(state.renderer, { backend: "OPTIX", denoiser: "OPTIX" });
  assert.ok(d.containers.has("pithagoras-blender"));
  assert.ok(d.calls.includes("reach pithagoras-blender-net pithagoras-blender 3870"), "the way to the server is Docker's to give");
  assert.ok((d.containers.get("pithagoras-blender")!.spec as any).Env.includes("BLENDER_SERVER_PORT=3870"));
  for (let i = 0; i < 100 && !fake.registered().length; i++) await delay(10);
  assert.equal(fake.registered().length, TOOLS.length);
  assert.equal(fake.offered().length, TOOLS.length);

  // The viewer: the extension's own page, and the server's API through the proxy, with the server's token.
  const page = await fetch(`${at}/ui/`);
  assert.equal(await page.text(), readFileSync(new URL("../src/viewer.html", import.meta.url), "utf8"));
  const api = await fetch(`${at}/ui/api/state`);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).path, "/api/state");
  assert.match(api.headers.get("content-security-policy")!, /sandbox/);

  // A change from another page of the same site is refused on every route; the portal's own pages are let through.
  const host = new URL(at).host;
  assert.equal((await json(`${at}/stop`, { method: "POST", headers: { origin: `http://${host.replace(/:\d+$/, ":9999")}` } })).status, 403);
  assert.equal((await json(`${at}/uninstall`, { method: "POST", headers: { origin: "http://evil.example" }, body: JSON.stringify({ removeData: true }) })).status, 403);
  assert.equal((await json(`${at}/gpu`, { method: "PUT", headers: { "sec-fetch-site": "same-site" }, body: JSON.stringify({ gpu: "" }) })).status, 403);
  assert.equal((await json(`${at}/state`)).body.state, "running");

  const here = { origin: `http://${host}` };
  assert.equal((await json(`${at}/gpu`, { method: "PUT", headers: here, body: JSON.stringify({ gpu: 3 }) })).status, 400);
  assert.equal((await json(`${at}/gpu`, { method: "PUT", headers: here, body: JSON.stringify({ gpu: "GPU-gone" }) })).body.error, "That card is not on this host.");

  assert.equal((await json(`${at}/stop`, { method: "POST", headers: here })).status, 200);
  assert.equal((await json(`${at}/state`)).body.state, "stopped");
  assert.equal((await json(`${at}/uninstall`, { method: "POST", headers: here, body: JSON.stringify({ removeData: "yes" }) })).status, 400);
  assert.equal((await json(`${at}/uninstall`, { method: "POST", headers: here, body: JSON.stringify({ removeData: true }) })).status, 200);
  assert.equal((await json(`${at}/state`)).body.state, "absent");
  assert.equal(d.volumes.size, 0);
  assert.deepEqual(fake.registered(), []);
  stop();
  await server.close();
});
