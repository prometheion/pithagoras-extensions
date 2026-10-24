import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { fakeDocker, fakeMcp, fakePortal, TOOLS } from "./fakes.mts";

/**
 * Godot's server half as a whole, with Docker and the Godot server stood in for: its routes as the Settings page and
 * the panel call them, the server installed, its tools given to the chats once it answers, the screen changed, and
 * the server removed, with its tools gone from every list.
 */

const docker = fakeDocker();
const fake = fakePortal(docker.docker);
const token = () => JSON.parse(readFileSync(path.join(fake.dataDir, "settings.json"), "utf8")).token as string;
const server = await fakeMcp(token);
// The server's own port is the default; the portal reaches it where Docker's reach says, the stand-in's port.
delete process.env.PITHAGORAS_GODOT_PORT;
docker.state.reach = { host: "127.0.0.1", port: server.port };
process.env.PITHAGORAS_GODOT_CONTAINER = "flairtest-godot";
process.env.PITHAGORAS_GODOT_IMAGE = "flairtest-pithagoras-godot:0.1.0";
const { default: godot } = await import("../src/server.ts");
const stop = godot(fake.portal) as () => void;

const app = express().use("/api/x/%40pithagoras/godot", fake.router);
const portal = http.createServer(app).listen(0, "127.0.0.1");
await new Promise((resolve) => portal.once("listening", resolve));
const at = `http://127.0.0.1:${(portal.address() as AddressInfo).port}/api/x/%40pithagoras/godot`;
after(async () => {
  stop();
  http.globalAgent.destroy();
  portal.closeAllConnections();
  portal.close();
  await server.close();
});

const get = async (route: string) => (await fetch(`${at}${route}`)).json();
/** A change, as the Settings page sends it: from the portal's own origin (`origin`, else another page's). */
const send = async (method: string, route: string, body?: unknown, origin = new URL(at).origin) => {
  const answer = await fetch(`${at}${route}`, { method, headers: { "content-type": "application/json", origin }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: answer.status, body: await answer.json() };
};
const until = async (check: (state: any) => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    const state = await get("/state");
    if (check(state)) return state;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`never: ${what}`);
};

test("before an install: nothing there, and no tools", async () => {
  const state = await get("/state");
  assert.equal(state.state, "absent");
  assert.equal(state.container, "flairtest-godot");
  assert.equal(state.volume, "flairtest-godot-data");
  assert.equal(state.display, "1600x900");
  assert.deepEqual(fake.listed(), []);
  assert.deepEqual(fake.registered(), []);
  assert.equal(fake.upgrades.length, 1, "the stream's upgrades are taken");
});

test("a change from another page is refused before it does anything, as a request with no word of where it is from", async () => {
  for (const [route, origin] of [["/install", "http://127.0.0.1:1"], ["/uninstall", "https://evil.test"], ["/start", ""]] as const) {
    const refused = await send("POST", route, route === "/uninstall" ? { removeData: true } : undefined, origin);
    assert.equal(refused.status, 403, route);
    assert.equal(refused.body.error, "Only the portal's own pages may change this.");
  }
  assert.equal((await send("PUT", "/display", { display: "1280x720" }, "http://localhost:9999")).status, 403);
  assert.equal((await get("/state")).state, "absent", "nothing was installed");
  assert.equal((await get("/state")).display, "1600x900", "nor the screen changed");
});

test("Install makes and starts the container, and once the server answers its tools are every chat's", async () => {
  assert.deepEqual((await send("POST", "/install")).body, { ok: true });
  const state = await until((s) => s.state === "running", "running");
  assert.equal(state.editor.ready, true, "the editor's own state, beside the container's");
  assert.equal(state.editor.log, undefined, "without its activity log, which is the viewer's");
  assert.equal(state.card, "GPU-bbbb1111");
  assert.equal(statSync(path.join(fake.dataDir, "settings.json")).mode & 0o777, 0o600);
  assert.match(token(), /^[0-9a-f]{48}$/);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(token()), "the token is not the page's");
  const spec = docker.containers.get("flairtest-godot")!.spec as any;
  assert.ok(spec.Env.includes(`GODOT_SERVER_TOKEN=${token()}`));
  assert.ok(spec.Env.includes("GODOT_SERVER_PORT=3880"));
  assert.equal(spec.HostConfig.NetworkMode, "flairtest-godot-net");
  assert.ok(docker.calls.includes("reach flairtest-godot-net flairtest-godot 3880"), "the way to the server is Docker's to give");
  assert.equal(spec.Image, "flairtest-pithagoras-godot:0.1.0");
  // The tools are asked for once the server answers, in the background.
  for (let i = 0; i < 200 && !fake.registered().length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fake.registered().length, TOOLS.length);
  assert.ok(fake.listed().some((t) => t.name === "godot_screenshot"));
  assert.ok(fake.counts.reloads >= 1);
});

test("the viewer and Selkies' web client are the extension's own; what they ask of the server goes on with its token", async () => {
  const pages = path.resolve(import.meta.dirname, "../pages");
  const viewer = await fetch(`${at}/ui/?lang=de`);
  assert.equal(viewer.status, 200);
  assert.equal(await viewer.text(), readFileSync(path.join(pages, "viewer.html"), "utf8"));
  assert.equal(viewer.headers.get("content-security-policy"), "frame-ancestors 'self'");
  assert.equal(viewer.headers.get("x-content-type-options"), "nosniff");
  const stream = await (await fetch(`${at}/ui/stream/`)).text();
  assert.match(stream, /^<!doctype html><html lang="en"><head><script src="__gs_shim.js"><\/script><meta charset="utf-8">/, "the shim first");
  const client = await fetch(`${at}/ui/stream/assets/index-BpOBp7NB.js`);
  assert.equal(await client.text(), readFileSync(path.join(pages, "stream/assets/index-BpOBp7NB.js"), "utf8"));
  assert.match(client.headers.get("content-type")!, /javascript/);
  assert.equal(await (await fetch(`${at}/ui/stream/__gs_shim.js`)).text(), readFileSync(path.join(pages, "stream/__gs_shim.js"), "utf8"));
  const seen = server.served.length;
  // What is not one of those files is the server's: the viewer's API, the stream's.
  assert.equal(await (await fetch(`${at}/ui/api/projects`)).text(), "<p>viewer at /api/projects</p>");
  assert.equal(await (await fetch(`${at}/ui/stream/api/status`)).text(), "<p>viewer at /stream/api/status</p>");
  assert.equal((await fetch(`${at}/ui/stream/LICENSE`)).status, 200, "the licence is not a page: the server's to answer, here the stand-in's");
  assert.deepEqual(server.served.slice(seen), ["/api/projects", "/stream/api/status", "/stream/LICENSE"], "nothing of the pages was asked of the server");
});

test("another screen size makes the running editor again with it; a size not offered, or a GPU not there, is refused", async () => {
  const before = docker.containers.get("flairtest-godot")!.id;
  assert.deepEqual((await send("PUT", "/display", { display: "1280x720" })).body, { display: "1280x720", restarting: true });
  await until((s) => s.state === "running" && !s.busy && docker.containers.get("flairtest-godot")!.id !== before, "made again");
  assert.ok((docker.containers.get("flairtest-godot")!.spec as any).Env.includes("DISPLAY_SIZE=1280x720"));
  assert.equal((await get("/state")).display, "1280x720");
  assert.equal((await send("PUT", "/display", { display: "800x600" })).status, 400);
  const gpu = await send("PUT", "/gpu", { gpu: "GPU-not-here" });
  assert.equal(gpu.status, 400);
  assert.equal(gpu.body.error, "That card is not on this host.");
});

test("the cards, for the page", async () => {
  const hw = await get("/hardware");
  assert.deepEqual(hw.cards.map((c: { uuid: string }) => c.uuid), ["GPU-aaaa0000", "GPU-bbbb1111"]);
  assert.equal(hw.wanted, "GPU-bbbb1111", "the card the server is on");
  assert.equal(hw.chosen, "");
  assert.equal(hw.pinned, false);
});

test("Stop, Start, and Remove with the projects: the tools leave every list", async () => {
  await send("POST", "/stop");
  assert.equal((await until((s) => s.state === "stopped", "stopped")).state, "stopped");
  assert.equal(fake.registered().length, TOOLS.length, "a stopped server keeps its tools: a call says it is not running");
  await send("POST", "/start");
  await until((s) => s.state === "running", "running again");
  const reloads = fake.counts.reloads;
  assert.deepEqual((await send("POST", "/uninstall", { removeData: true })).body, { ok: true });
  assert.equal((await get("/state")).state, "absent");
  assert.ok(!docker.volumes.has("flairtest-godot-data"));
  assert.deepEqual(fake.listed(), []);
  assert.deepEqual(fake.registered(), []);
  assert.ok(fake.counts.reloads > reloads, "the open chats lose them");
  assert.throws(() => statSync(path.join(fake.dataDir, "tools.json")), /ENOENT/);
});
