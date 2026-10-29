/** What the settings say of themselves: where the store stands (this extension's own data folder, beside pi's files),
 * what an earlier version kept in pi's config file comes over as, what a save keeps and drops there, and what a name
 * may stand under -- each against throwaway directories, never the person's. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadInstances, saveInstances, configured, isValidInstanceName, DEFAULT_INSTANCE_NAME } from "../src/config.ts";

function withHome(fn: () => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nextcloud-settings-"));
  process.env.PI_CODING_AGENT_DIR = home; // where pi's config file (the legacy one) stands
  process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR = path.join(home, "data"); // where this module keeps its settings
  try {
    fn();
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function storeFile(): string {
  return path.join(process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR!, "settings.json");
}

test("nothing saved means no instance stands", () => {
  withHome(() => assert.deepEqual(loadInstances(), []));
});

test("the flat keys of an earlier version come over as its one instance, and leave pi's config file then", () => {
  withHome(() => {
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"),
      JSON.stringify({ url: "https://cloud.example.org", username: "user", password: "pw", mcpExcludeTools: "x_*", otherKey: 1 }),
    );
    const [inst] = loadInstances();
    assert.equal(inst.name, DEFAULT_INSTANCE_NAME);
    assert.equal(inst.url, "https://cloud.example.org");
    assert.equal(inst.username, "user");
    assert.equal(inst.password, "pw");
    assert.deepEqual(inst.capabilities, {}); // an unrecognized keep-out list comes over as no choices
    assert.equal(inst.container, "own");
    assert.equal(configured(inst), true);

    // The store stands in this module's own data folder from the first load -- and pi's config file is no longer read of again.
    const stored: Record<string, unknown> = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
    assert.ok(Array.isArray(stored.instances) && (stored.instances as unknown[]).length === 1);
    const legacyAfterLoad: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), "utf8"));
    for (const legacy of ["url", "username", "password", "mcpExcludeTools", "instances"]) assert.equal(legacy in legacyAfterLoad, false);
    assert.equal(legacyAfterLoad.otherKey, 1); // nothing else of the file touched

    const saved = saveInstances([inst]);
    assert.equal(saved.length, 1);
    assert.ok(fs.existsSync(storeFile())); // and a save stands where the store does
  });
});

test("a save keeps what it is given and only that: a second instance with its port stands as saved", () => {
  withHome(() => {
    const a = { name: "nextcloud", url: "https://a.example.org", username: "u", password: "p", container: "own" };
    const b = { name: "uni", url: "https://b.example.org", username: "u", password: "p", capabilities: { mail: false, news: false }, container: "adopted:somebox", port: 8123 };
    saveInstances([a, b]);
    const loaded = loadInstances();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].name, "nextcloud");
    assert.ok(!(loaded[0] as Record<string, unknown>).capabilities); // nothing named stands unset
    assert.equal(loaded[1].container, "adopted:somebox");
    assert.equal(loaded[1].port, 8123); // the saved port comes over
    assert.deepEqual(loaded[1].capabilities, { mail: false, news: false }); // its choices stand as saved
    assert.equal(configured(loaded[1]), true);
  });
});

test("an earlier version's saved list comes over entry by entry, and leaves pi's config file then", () => {
  withHome(() => {
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"),
      JSON.stringify({ instances: [{ url: "https://x" }, { name: "ok", container: "adopted:" }, { name: "fine", port: -2 }] }),
    );
    const insts = loadInstances();
    assert.equal(insts.length, 2);
    assert.equal(insts[0].container, "own"); // an entry that names no instance is dropped; a container field it does not know comes home to own
    assert.equal(insts[1].port, undefined); // a port that is not a real one stands unset
    const afterLoad: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), "utf8"));
    assert.equal("instances" in afterLoad, false); // the list came over and left there
  });
});

test("an old flat entry's keep-out list comes over as its capability choices", () => {
  withHome(() => {
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"),
      JSON.stringify({ url: "https://u.example.org", username: "u@x", password: "pw", mcpExcludeTools: " nextcloud_nc_mail_* , nextcloud_collectives_* " }),
    );
    const inst = loadInstances()[0];
    assert.equal(inst.name, DEFAULT_INSTANCE_NAME); // the flat entry came under that version's one name
    assert.deepEqual(inst.capabilities, { mail: false, collectives: false }); // only what the list named stands off
  });
});

test("a name may take letters, numbers, dashes and underscores -- starting with a letter, at the length it needs", () => {
  assert.ok(isValidInstanceName("nextcloud"));
  assert.ok(isValidInstanceName("My-Cloud_2"));
  assert.equal(isValidInstanceName(""), false);
  assert.equal(isValidInstanceName("1cloud"), false);
  assert.equal(isValidInstanceName("has space"), false);
  assert.equal(isValidInstanceName("cloud.example.org"), false);
  assert.equal(isValidInstanceName("a".repeat(49)), false);
  assert.ok(isValidInstanceName("a".repeat(48)));
});
