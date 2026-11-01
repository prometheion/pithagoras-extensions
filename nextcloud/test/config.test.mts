/** What the settings say of themselves: where the store stands (this extension's own data folder, beside pi's files),
 * what a save keeps, the entries this extension remembers it wrote, and what a name may stand under -- each against
 * throwaway directories, never the person's. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadInstances, saveInstances, loadWritten, saveWritten, loadEntriesVersion, ENTRIES_VERSION, configured, isValidInstanceName } from "../src/config.ts";

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

test("a save keeps what it is given and only that: a second instance with its port stands as saved", () => {
  withHome(() => {
    const a = { name: "nextcloud", url: "https://a.example.org", username: "u", password: "p" };
    const b = { name: "uni", url: "https://b.example.org", username: "u", password: "p", capabilities: { mail: false, news: false }, port: 8123 };
    saveInstances([a, b]);
    const loaded = loadInstances();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].name, "nextcloud");
    assert.ok(!(loaded[0] as Record<string, unknown>).capabilities); // nothing named stands unset
    assert.equal(loaded[1].port, 8123); // the saved port comes over
    assert.deepEqual(loaded[1].capabilities, { mail: false, news: false }); // its choices stand as saved
    assert.equal(configured(loaded[1]), true);
  });
});

test("the entries this extension wrote are remembered beside the instances, and a save of the instances keeps them", () => {
  withHome(() => {
    assert.deepEqual(loadWritten(), []);
    assert.equal(loadEntriesVersion(), 1, "no store: entries written the way the first version did");
    saveInstances([{ name: "uni", url: "https://a.example.org", username: "u", password: "p" }]);
    saveWritten(["uni", "uni", "home"]);
    assert.deepEqual(loadWritten(), ["uni", "home"]);
    assert.equal(loadEntriesVersion(), ENTRIES_VERSION);
    saveInstances([]);
    assert.deepEqual(loadWritten(), ["uni", "home"], "a save of the list does not forget what was written");
    assert.equal(loadInstances().length, 0);
  });
});

test("the container name and the choice of plain http stand as saved", () => {
  withHome(() => {
    saveInstances([{ name: "uni", url: "http://nas.lan", allowHttp: true, username: "u", password: "p", port: 8001, container: "pithagoras-nextcloud-mcp-uni" }, { name: "b", url: "https://b", username: "u", password: "p" }]);
    const [a, b] = loadInstances();
    assert.equal(a.allowHttp, true);
    assert.equal(a.container, "pithagoras-nextcloud-mcp-uni");
    assert.equal(b.allowHttp, undefined);
    assert.equal(b.container, undefined);
  });
});

test("the settings file holds app passwords: mode 0600, in a folder of 0700", () => {
  withHome(() => {
    saveInstances([{ name: "uni", url: "https://a.example.org", username: "u", password: "secret" }]);
    assert.equal(fs.statSync(storeFile()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(storeFile())).mode & 0o777, 0o700);
  });
});

test("pi's own settings file is never read or written", () => {
  withHome(() => {
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
    const theirs = path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
    fs.writeFileSync(theirs, JSON.stringify({ url: "https://old.example.org", username: "u", password: "pw", instances: [{ name: "x", url: "y" }], mine: 1 }));
    const before = fs.readFileSync(theirs, "utf8");
    assert.deepEqual(loadInstances(), [], "nothing comes over from it");
    saveInstances([{ name: "uni", url: "https://a.example.org", username: "u", password: "p" }]);
    assert.equal(fs.readFileSync(theirs, "utf8"), before);
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
