/** What planOwn says of every instance: its container and its loopback port -- stable across adds, removes
 * and reorders of the other instances, and apart where two slugs came to one. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planOwn, PORT, CONTAINER_BASE } from "../src/container.ts";
import type { NextcloudInstance } from "../src/config.ts";

function inst(name: string, over: Partial<NextcloudInstance> = {}): NextcloudInstance {
  return { name, url: "https://cloud.example.org", username: "user", password: "pw", ...over };
}

test("the default instance stands under the base name on the base port", () => {
  const plans = planOwn([inst("nextcloud")]);
  assert.equal(plans.get("nextcloud")?.containerName, CONTAINER_BASE);
  assert.equal(plans.get("nextcloud")?.port, PORT);
});

test("a second instance gets its slug of the name and the next port", () => {
  const plans = planOwn([inst("nextcloud"), inst("uni")]);
  assert.equal(plans.get("uni")?.containerName, `${CONTAINER_BASE}-uni`);
  assert.equal(plans.get("uni")?.port, PORT + 1);
});

test("every instance takes a container and a port, in the list's order", () => {
  const plans = planOwn([inst("a"), inst("b"), inst("c")]);
  assert.equal(plans.get("a")?.containerName, `${CONTAINER_BASE}-a`);
  assert.equal(plans.get("b")?.containerName, `${CONTAINER_BASE}-b`);
  assert.equal(plans.get("c")?.containerName, `${CONTAINER_BASE}-c`);
  assert.equal(plans.get("a")?.port, PORT);
  assert.equal(plans.get("b")?.port, PORT + 1);
  assert.equal(plans.get("c")?.port, PORT + 2);
});

test("two slugs that come to one name stand apart by number", () => {
  const plans = planOwn([inst("Uni Cloud"), inst("uni_cloud")]); // both slug to "uni-cloud"
  assert.equal(plans.get("Uni Cloud")?.containerName, `${CONTAINER_BASE}-uni-cloud`);
  assert.equal(plans.get("uni_cloud")?.containerName, `${CONTAINER_BASE}-uni-cloud-2`);
});

test("a saved port stands where it is free: adding another instance does not shift it", () => {
  // First save plans both; the run keeps the planned ports with the instances (as server.ts does on every apply).
  const first = planOwn([inst("nextcloud"), inst("uni")]);
  for (const plan of first.values()) plan.inst.port = plan.port;
  // A second instance joins, in front of them in the list's order: the old two keep their ports and names.
  const second = planOwn([inst("work"), ...first.values().map((p) => p.inst)]);
  assert.equal(second.get("nextcloud")?.port, PORT);
  assert.equal(second.get("uni")?.port, PORT + 1);
  assert.equal(second.get("work")?.port, PORT + 2); // the new one takes what is free above the base
});

test("removing an instance leaves the others' ports where they stood", () => {
  const first = planOwn([inst("nextcloud"), inst("uni"), inst("work")]);
  for (const plan of first.values()) plan.inst.port = plan.port;
  const rest = [first.get("nextcloud")?.inst, first.get("work")?.inst].filter((i) => i !== undefined);
  const second = planOwn(rest);
  assert.equal(second.get("nextcloud")?.port, PORT);
  assert.equal(second.get("work")?.port, PORT + 2); // not shifted down onto uni's old port
});

test("reordering the list does not move a saved port", () => {
  const first = planOwn([inst("a"), inst("b"), inst("c")]);
  for (const plan of first.values()) plan.inst.port = plan.port;
  const reversed = [...first.values()].reverse().map((p) => p.inst);
  assert.deepEqual(planOwn(reversed).get("b")?.port, PORT + 1);
});

test("a saved port claimed by another instance gives way to the lowest free one", () => {
  const plans = planOwn([inst("a", { port: PORT }), inst("b", { port: PORT }), inst("c")]);
  assert.equal(plans.get("a")?.port, PORT); // first in the list keeps it
  assert.notEqual(plans.get("b")?.port, PORT);
  assert.notEqual(plans.get("c")?.port, plans.get("b")?.port);
  const ports = [...plans.values()].map((p) => p.port).sort((x, y) => x - y);
  assert.deepEqual(ports, [PORT, PORT + 1, PORT + 2]); // nothing twice, nothing below the base
});

test("a saved port that is not a real port is planned fresh", () => {
  const plans = planOwn([inst("a", { port: -3 }), inst("b", { port: Number.NaN })]);
  assert.equal(plans.get("a")?.port, PORT);
  assert.equal(plans.get("b")?.port, PORT + 1);
});
