/** How an instance's container is made and kept: from the image's digest, hardened, with its spec hashed into a
 * label -- so that a container is remade when what it was made with changed, and only then, whatever Docker's inspect
 * shows of its environment. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureOwn, makeSpec, planOwn, releaseOwn, IMAGE, IMAGE_BY_DIGEST, IMAGE_DIGEST, CONTAINER_BASE, PORT } from "../src/container.ts";
import { SPEC_LABEL } from "../../shared/service.ts";
import type { NextcloudInstance } from "../src/config.ts";
import { fakeDocker } from "./fake-docker.mts";

const inst = (name: string, over: Partial<NextcloudInstance> = {}): NextcloudInstance => ({ name, url: "https://cloud.example.org", username: "anna", password: "pw", ...over });

function world() {
  const fake = fakeDocker();
  fake.state.images.add(IMAGE); // the tag is downloaded ...
  fake.state.images.add(IMAGE_BY_DIGEST); // ... and is the build the digest names
  return fake;
}

test("a container is made from the image's digest, not its tag, and the tag is what is downloaded", async () => {
  const fake = world();
  const plan = planOwn([inst("nextcloud")]).get("nextcloud")!;
  await ensureOwn(fake.docker, plan);
  assert.match(IMAGE_DIGEST, /^sha256:[0-9a-f]{64}$/);
  assert.ok(fake.calls.includes(`pull ${IMAGE}`));
  const made = fake.containers.get(CONTAINER_BASE)!;
  assert.equal(made.spec.Image, IMAGE_BY_DIGEST);
  assert.ok(!String(made.spec.Image).includes("0.203.0"));
});

test("a tag that came to name another build is not run: the digest is not there after the download", async () => {
  const fake = fakeDocker();
  fake.state.images.add(IMAGE); // downloaded, but not the build the digest names
  const plan = planOwn([inst("nextcloud")]).get("nextcloud")!;
  await assert.rejects(() => ensureOwn(fake.docker, plan), /not the build this version of the extension runs/);
  assert.equal(fake.containers.size, 0);
});

test("the container holds no capability, no new privileges, a memory and process limit, a log limit and a restart policy", async () => {
  const fake = world();
  const spec = await makeSpec(fake.docker, inst("nextcloud"), PORT);
  const host = spec.HostConfig as Record<string, any>;
  assert.deepEqual(host.CapDrop, ["ALL"]);
  assert.deepEqual(host.SecurityOpt, ["no-new-privileges"]);
  assert.ok(host.Memory > 0 && host.Memory <= 4 * 1024 ** 3);
  assert.ok(host.PidsLimit > 0);
  assert.equal(host.LogConfig.Type, "json-file");
  assert.deepEqual(host.RestartPolicy, { Name: "unless-stopped" });
  assert.equal(host.NetworkMode, "host");
  assert.ok((spec.Labels as Record<string, string>)[SPEC_LABEL]);
});

test("the endpoint takes only its own loopback Host and no browser's Origin, and the image's metrics server is off", async () => {
  const fake = world();
  const env = (await makeSpec(fake.docker, inst("nextcloud"), 8123)).Env as string[];
  for (const wanted of ["MCP_DNS_REBINDING_PROTECTION=true", "MCP_ALLOWED_HOSTS=127.0.0.1:8123", "CORS_ALLOW_ORIGINS=http://127.0.0.1:8123", "METRICS_ENABLED=false"])
    assert.ok(env.includes(wanted), wanted);
  assert.equal(env.some((e) => e.startsWith("MCP_ALLOWED_ORIGINS=")), false, "no origin is allowed: the SDK then refuses every request that carries one");
});

test("every start it asks for is checked first, and one the check refuses is not made", async () => {
  const fake = world();
  const plan = planOwn([inst("nextcloud")]).get("nextcloud")!;
  const checks: string[] = [];
  await assert.rejects(() => ensureOwn(fake.docker, plan, async () => { checks.push("made"); throw new Error("port 8000 is taken"); }), /taken/);
  assert.equal(fake.calls.some((c) => c.startsWith("start ")), false);
  await ensureOwn(fake.docker, plan, async () => void checks.push("made, not started"));
  await ensureOwn(fake.docker, plan, async () => void checks.push("running")); // running: nothing to start, no check
  await fake.docker.containers.stop(CONTAINER_BASE);
  await ensureOwn(fake.docker, plan, async () => void checks.push("stopped"));
  assert.deepEqual(checks, ["made", "made, not started", "stopped"]);
});

test("a save with nothing changed makes nothing again, although Docker's inspect shows the environment with the image's own variables, in another order", async () => {
  const fake = world();
  const plan = planOwn([inst("nextcloud")]).get("nextcloud")!;
  assert.equal(await ensureOwn(fake.docker, plan), true);
  assert.deepEqual(fake.calls.filter((c) => c.startsWith("create ")), [`create ${CONTAINER_BASE}`]);
  const env = (fake.containers.get(CONTAINER_BASE)!.inspect.Config.Env as string[]);
  assert.ok(env.includes("LANG=C.UTF-8"), "the fake shows what a real inspect shows");
  assert.notDeepEqual(env.filter((e) => e.startsWith("NEXTCLOUD_")), (await makeSpec(fake.docker, plan.inst, plan.port) as any).Env, "in another order than it was given");

  assert.equal(await ensureOwn(fake.docker, plan), false);
  assert.equal(await ensureOwn(fake.docker, planOwn([inst("nextcloud")]).get("nextcloud")!), false);
  assert.deepEqual(fake.calls.filter((c) => c.startsWith("create ") || c.startsWith("remove ")), [`create ${CONTAINER_BASE}`], "nothing remade");
});

test("a changed password, host, user or port remakes it; a stopped one is started and not remade", async () => {
  const fake = world();
  await ensureOwn(fake.docker, planOwn([inst("nextcloud")]).get("nextcloud")!);
  for (const [i, over] of [{ password: "other" }, { url: "https://other.example.org" }, { username: "bob" }].entries()) {
    const before = fake.calls.filter((c) => c.startsWith("create ")).length;
    assert.equal(await ensureOwn(fake.docker, planOwn([inst("nextcloud", over)]).get("nextcloud")!), true, `case ${i}`);
    assert.equal(fake.calls.filter((c) => c.startsWith("create ")).length, before + 1);
    await ensureOwn(fake.docker, planOwn([inst("nextcloud", over)]).get("nextcloud")!);
    // and back to the next case from what stands now
    fake.calls.length = 0;
    await ensureOwn(fake.docker, planOwn([inst("nextcloud")]).get("nextcloud")!);
  }
  const plan = planOwn([inst("nextcloud")]).get("nextcloud")!;
  await fake.docker.containers.stop(CONTAINER_BASE);
  fake.calls.length = 0;
  assert.equal(await ensureOwn(fake.docker, plan), false);
  assert.deepEqual(fake.calls.filter((c) => /^(create|remove|start) /.test(c)), [`start ${CONTAINER_BASE}`]);
  plan.port += 1;
  assert.equal(await ensureOwn(fake.docker, plan), true, "another port is another spec");
});

test("a container that is not this extension's is never taken or removed", async () => {
  const fake = world();
  fake.put(CONTAINER_BASE, { Image: "x" }, { owner: "somebody-else" });
  await assert.rejects(() => ensureOwn(fake.docker, planOwn([inst("nextcloud")]).get("nextcloud")!), /not this extension's/);
  await releaseOwn(fake.docker, CONTAINER_BASE);
  assert.ok(fake.containers.has(CONTAINER_BASE));
});

test("a saved container name stands when another instance's name comes to the same slug", () => {
  const plans = planOwn([inst("Uni", { container: `${CONTAINER_BASE}-uni-2`, port: 8001 }), inst("uni", { container: `${CONTAINER_BASE}-uni`, port: 8000 })]);
  assert.equal(plans.get("Uni")?.containerName, `${CONTAINER_BASE}-uni-2`);
  assert.equal(plans.get("uni")?.containerName, `${CONTAINER_BASE}-uni`);
  // removing "uni" does not rename "Uni"
  assert.equal(planOwn([inst("Uni", { container: `${CONTAINER_BASE}-uni-2`, port: 8001 })]).get("Uni")?.containerName, `${CONTAINER_BASE}-uni-2`);
  // a saved name that is not one of the extension's own is ignored
  assert.equal(planOwn([inst("a", { container: "postgres" })]).get("a")?.containerName, `${CONTAINER_BASE}-a`);
});
