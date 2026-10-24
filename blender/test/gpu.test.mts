import assert from "node:assert/strict";
import { test } from "node:test";
import { mostFree, parseProbe, probe, PROBE_IMAGE } from "../../shared/gpu.ts";
import { memoryDocker } from "./fakes.mts";

/** The GPU probe: nvidia-smi and the look for the OptiX weights, in a short-lived container of the extension's. */

const SMI = [
  "0, GPU-0a0a0a0a-0000-4000-8000-000000000000, NVIDIA GeForce RTX 3060, 9000, 12288",
  "1, GPU-1b1b1b1b-1111-4111-8111-111111111111, NVIDIA GeForce RTX 3060, 158, 12288",
].join("\n");

test("what the probe prints is read into cards, and where the OptiX weights are", () => {
  const { cards, optix } = parseProbe(`${SMI}\nOPTIX=host\n`);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[1], { index: 1, uuid: "GPU-1b1b1b1b-1111-4111-8111-111111111111", name: "NVIDIA GeForce RTX 3060", usedMiB: 158, totalMiB: 12288 });
  assert.equal(optix, "host");
  // The toolkit's own mount wins over the host's file: a bind over it would clash.
  assert.equal(parseProbe(`${SMI}\nOPTIX=toolkit\nOPTIX=host\n`).optix, "toolkit");
  assert.equal(parseProbe(SMI).optix, "none");
  // A name with a comma keeps it, and a line of another shape is skipped.
  assert.equal(parseProbe("0, GPU-a, Card, with comma, [N/A], 8192\nnvidia-smi: warning").cards[0].name, "Card, with comma");
});

test("the card with the most free memory is the default", () => {
  assert.equal(mostFree(parseProbe(SMI).cards)?.index, 1);
  assert.equal(mostFree([]), undefined);
});

test("the probe runs nvidia-smi in a container that sees the host's /usr/share, and is removed after", async () => {
  const d = memoryDocker();
  d.state.onStart = (c) => {
    if (c.name !== "pithagoras-blender-probe") return;
    c.log = `${SMI}\r\nOPTIX=host\r\n`;
    c.state = "exited";
  };
  const found = await probe(d.docker, "pithagoras-blender-probe");
  assert.equal(found.cards.length, 2);
  assert.equal(found.optix, "host");
  assert.equal(found.error, "");
  assert.ok(d.images.has(PROBE_IMAGE), "the probe's image is downloaded first");
  assert.equal(d.containers.has("pithagoras-blender-probe"), false, "the probe is removed");
  assert.ok(d.calls.includes("create pithagoras-blender-probe"));
});

test("a pinned card is the only one the probe asks Docker for", async () => {
  const d = memoryDocker();
  let asked: unknown;
  d.state.onStart = (c) => {
    asked = (c.spec.HostConfig as any).DeviceRequests;
    c.log = SMI.split("\n")[1].replace(/^1,/, "0,");
    c.state = "exited";
  };
  const found = await probe(d.docker, "pithagoras-blender-probe", "GPU-1b1b1b1b-1111-4111-8111-111111111111");
  assert.deepEqual(asked, [{ Driver: "nvidia", DeviceIDs: ["GPU-1b1b1b1b-1111-4111-8111-111111111111"], Capabilities: [["gpu"]] }]);
  assert.equal(found.cards.length, 1);
});

test("Docker refusing the GPU is no GPU, not a failure, and the probe is removed then too", async () => {
  const d = memoryDocker();
  d.state.refuseGpu = true;
  const found = await probe(d.docker, "pithagoras-blender-probe");
  assert.deepEqual(found.cards, []);
  assert.equal(found.optix, "none");
  assert.match(found.error, /could not select device driver/);
  assert.equal(d.containers.has("pithagoras-blender-probe"), false);
});

test("a probe that fails otherwise is removed, and says why", async () => {
  const d = memoryDocker();
  d.docker.containers.start = async () => {
    throw new Error("the disk is full");
  };
  await assert.rejects(probe(d.docker, "pithagoras-blender-probe"), /the disk is full/);
  assert.equal(d.containers.has("pithagoras-blender-probe"), false);
});
