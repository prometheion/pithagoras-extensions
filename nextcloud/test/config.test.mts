/** What the keys say of themselves: what an earlier version's flat keys come over as, what a save keeps and drops,
 * and what a name may stand under -- each against a throwaway agent directory, never the person's. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadInstances, saveInstances, configured, excludeList, excludeFor, excludeDefault, isValidInstanceName, DEFAULT_INSTANCE_NAME } from "../src/config.ts";

function withHome(fn: () => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nextcloud-settings-"));
  process.env.PI_CODING_AGENT_DIR = home;
  try {
    fn();
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("nothing saved means no instance stands", () => {
  withHome(() => assert.deepEqual(loadInstances(), []));
});

test("the flat keys of an earlier version come over as its one instance, and a save drops them", () => {
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
    assert.equal(inst.mcpExcludeTools, "x_*");
    assert.equal(inst.container, "own");
    assert.equal(configured(inst), true);

    const saved = saveInstances([inst]);
    assert.equal(saved.length, 1);
    const file: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), "utf8"));
    assert.ok(Array.isArray(file.instances)); // the new shape stands
    for (const legacy of ["url", "username", "password", "mcpExcludeTools"]) assert.equal(legacy in file, false);
    assert.equal(file.otherKey, 1); // nothing else of the file touched
  });
});

test("a save keeps what it is given and only that: a second instance with its port stands as saved", () => {
  withHome(() => {
    const a = { name: "nextcloud", url: "https://a.example.org", username: "u", password: "p", mcpExcludeTools: "", container: "own" };
    const b = { name: "uni", url: "https://b.example.org", username: "u", password: "p", mcpExcludeTools: "uni_nc_mail_*", container: "adopted:somebox", port: 8123 };
    saveInstances([a, b]);
    const loaded = loadInstances();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].name, "nextcloud");
    assert.equal(loaded[1].container, "adopted:somebox");
    assert.equal(loaded[1].port, 8123); // the saved port comes over
    assert.equal(configured(loaded[1]), true);
    assert.deepEqual(excludeList(loaded[1]), ["uni_nc_mail_*"]);
    assert.equal(excludeDefault("uni"), "uni_nc_mail_*,uni_nc_news_*,uni_collectives_*");
  });
});

test("an entry that names no instance is dropped, and a container field it does not know comes home to own", () => {
  withHome(() => {
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"),
      JSON.stringify({ instances: [{ url: "https://x" }, { name: "ok", container: "adopted:" }, { name: "fine", port: -2 }] }),
    );
    const insts = loadInstances();
    assert.equal(insts.length, 2);
    assert.equal(insts[0].container, "own");
    assert.equal(insts[1].port, undefined); // a port that is not a real one stands unset
  });
});

test("an empty keep-out field takes the default list for its name; a named one stands as named, trimmed", () => {
  assert.ok(excludeFor({ name: "home", url: "", username: "", password: "", mcpExcludeTools: "", container: "own" }).length > 0);
  assert.deepEqual(
    excludeFor({ name: "home", url: "", username: "", password: "", mcpExcludeTools: "", container: "own" }),
    excludeDefault("home").split(",").map((part) => part.trim()).filter(Boolean),
  );
  assert.deepEqual(
    excludeFor({ name: "home", url: "", username: "", password: "", mcpExcludeTools: " home_nc_mail_*,  ", container: "own" }),
    ["home_nc_mail_*"],
  );
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
