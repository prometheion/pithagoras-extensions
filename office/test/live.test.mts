/**
 * Unit tests for src/live.ts' presence TTL: a tracked (server-minted or heartbeat-fed) user auto-expires after
 * the TTL instead of holding the lock forever; a live session stays by heartbeating;
 * co-edit semantics are otherwise unchanged (a fresh open still locks, the explicit flag is independent).
 * Pure in-memory module -- no portal, no fs; short real timers only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { usersOf, setUser, setLocked, isLocked, pollState, clearDoc, resetLive, setPresenceTtl, getPresenceTtl, setSession, sessionKeys, agentsOf, nameAgent } from "../src/live";
import { editorsIn } from "../src/office-ui";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("presence TTL: a non-heartbeating user auto-expires and stops locking", async () => {
  resetLive();
  setPresenceTtl(50);
  setUser("doc-a", { id: "portal-user", name: "Portal" }, true);
  assert.equal(usersOf("doc-a").length, 1, "freshly minted presence locks immediately");
  assert.equal(pollState("doc-a", 0).locked, true);

  await sleep(80); // past the 50 ms TTL with no heartbeat
  assert.deepEqual(usersOf("doc-a"), [], "the stuck presence expired (no terminal close needed)");
  assert.equal(pollState("doc-a", 0).locked, false, "expired presence must not keep refusing agent edits");

  resetLive();
});

test("presence TTL: every status-1 heartbeat pushes the expiry forward, a live session never trips it", async () => {
  resetLive();
  setPresenceTtl(120);
  setUser("doc-b", { id: "portal-user", name: "Portal" }, true);
  const first = usersOf("doc-b")[0];

  await sleep(70);
  setUser("doc-b", { id: "portal-user", name: "Portal" }, true); // heartbeat re-sets expiresAt (but keeps `at`)
  const second = usersOf("doc-b")[0];
  assert.equal(second.at, first.at, "the badge still shows the FIRST join time");

  await sleep(70); // 140 ms since the original mint (> TTL), but only 70 ms since the heartbeat
  assert.equal(usersOf("doc-b").length, 1, "heartbeats keep a live session present past its original TTL");
  assert.equal(pollState("doc-b", 0).locked, true);

  await sleep(80); // now past even the heartbeated expiry
  assert.deepEqual(usersOf("doc-b"), [], "and it still expires once heartbeats stop");
  resetLive();
});

test("TTL settings: setPresenceTtl rejects nonsense values; default is 15 minutes (the config signature lifetime)", () => {
  resetLive();
  assert.equal(getPresenceTtl(), 15 * 60_000, "default TTL matches CONFIG_TTL_MS (editor-config signature lifetime)");
  setPresenceTtl(0);
  setPresenceTtl(-5);
  setPresenceTtl(Number.NaN);
  assert.equal(getPresenceTtl(), 15 * 60_000, "non-positive/NaN TTLs are ignored rather than stored");
  resetLive(); // also restores the default after a real change
});

test("co-edit semantics unchanged: explicit lock flag is independent of presence; clearDoc still clears both", () => {
  resetLive();
  setLocked("doc-c", true); // e.g. a status-6 "keep locked" with no tracked user at all
  assert.equal(usersOf("doc-c").length, 0);
  assert.equal(isLocked("doc-c"), true);
  assert.equal(pollState("doc-c", 0).locked, true, "the explicit flag locks on its own");

  setUser("doc-d", { id: "portal-user" }, true);
  clearDoc("doc-d"); // the DELETE /documents/:id path -- presence AND flag gone at once
  assert.deepEqual(usersOf("doc-d"), []);
  assert.equal(isLocked("doc-d"), false);
  resetLive();
});

test("agents' editors: they count for the sessions and agentsOf, not as people: no usersOf, no lock, no badge", () => {
  resetLive();
  nameAgent("agent:abc", "Research (agent)");
  setSession("doc-z", "key-1", ["agent:abc"]);
  setUser("doc-z", { id: "agent:abc" }, true, { confirmed: true });
  assert.deepEqual(sessionKeys("doc-z"), ["key-1"]);
  assert.deepEqual(agentsOf("doc-z"), [{ id: "agent:abc", name: "Research (agent)" }]);
  assert.deepEqual(usersOf("doc-z"), []);
  assert.equal(pollState("doc-z", 0).locked, false);
  assert.equal(isLocked("doc-z"), false);
  // What the /state route gives the library's badge is usersOf: no agent in it.
  assert.equal(editorsIn({ "doc-z": usersOf("doc-z") }, "doc-z"), 0);
  // An agent never named (a callback after a restart) is shown by its id.
  setUser("doc-z", { id: "agent:def" }, true, { confirmed: true });
  assert.deepEqual(agentsOf("doc-z").map((a) => a.name), ["Research (agent)", "agent:def"]);
  resetLive();
});
