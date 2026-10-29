/** What an install takes over from pi's config: what mcp.json says of its servers, which of them stand on a found
 * container, what a container's environment gives up -- each against throwaway directories, never the person's. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Docker } from "../shared/docker-api";
import { mcpEntries, matchEntries, envOf, capabilitiesOf, instanceOf, migrateExistingMcpEntries, MatchedEntry } from "../src/migrate.ts";

function withDirs(fn: () => void | Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nextcloud-migrate-"));
  process.env.PI_CODING_AGENT_DIR = home; // where pi's mcp.json stands
  process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR = path.join(home, "data"); // where the taken-over instances would be kept
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      delete process.env.PI_CODING_AGENT_DIR;
      delete process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR;
      fs.rmSync(home, { recursive: true, force: true });
    });
}

function writeMcp(dir: string, mcpServers: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers }));
}

test("mcpEntries reads pi's config by entry name; nothing where there is no file, none that reads, or no servers", () => {
  withDirs(() => {
    assert.deepEqual(mcpEntries(), {}); // no file yet
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"), "{ not json");
    assert.deepEqual(mcpEntries(), {}); // none that reads
    writeMcp(process.env.PI_CODING_AGENT_DIR!, { one: { url: "http://127.0.0.1:18000/mcp" }, two: "not an entry" });
    const entries = mcpEntries();
    assert.equal(Object.keys(entries).length, 1); // an entry that is not an object stands out
    assert.equal(entries.one.url, "http://127.0.0.1:18000/mcp");
  });
});

test("matchEntries pairs each found container with the entry whose url it publishes", () => {
  const containers = [
    { name: "box-a", image: "ghcr.io/cbcoutinho/nextcloud-mcp-server:latest", status: "Up 4 days", endpoint: "http://127.0.0.1:18000/mcp" },
    { name: "box-b", image: "ghcr.io/cbcoutinho/nextcloud-mcp-server:latest", status: "Up 2 days" }, // no published port for the loopback
  ];
  const matched = matchEntries(containers, {
    first: { url: "http://127.0.0.1:18000/mcp", lifecycle: "persistent" },
    second: { url: "http://127.0.0.1:18001/mcp" }, // nothing answers there
    wordless: { command: "npx something" }, // no url at all
  });
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, "first");
  assert.equal(matched[0].container.name, "box-a");
});

test("envOf gives one variable of a container's environment; nothing where it stands not", () => {
  const env = ["PATH=/usr/bin", "NEXTCLOUD_HOST=https://cloud.example.org", "NEXTCLOUD_USERNAME=user", "NEXTCLOUD_PASSWORD=pw"];
  assert.equal(envOf(env, "NEXTCLOUD_HOST"), "https://cloud.example.org");
  assert.equal(envOf(env, "NEXTCLOUD_USERNAME"), "user");
  assert.equal(envOf(env, "NEXTCLOUD_MISSING"), "");
  assert.equal(envOf(undefined, "NEXTCLOUD_HOST"), "");
  assert.equal(envOf("not a list", "NEXTCLOUD_HOST"), "");
});

test("capabilitiesOf takes the entry's keep-out list as its choices -- or nothing where no list stood", () => {
  assert.deepEqual(capabilitiesOf({ excludeTools: ["uni_nc_mail_*", "uni_nc_news_*"] }, "uni"), { mail: false, news: false });
  assert.deepEqual(capabilitiesOf({ excludeTools: " uni_collectives_*,  uni_deck_* , " }, "uni"), { collectives: false, deck: false }); // a comma-separated string stands as named, trimmed
  assert.equal(capabilitiesOf({}, "c"), undefined); // nothing named: every family stands on
});

test("instanceOf makes the adopted instance from a matched entry and its login", () => {
  const matched: MatchedEntry = {
    name: "cloud",
    entry: { url: "http://127.0.0.1:18000/mcp", excludeTools: ["cloud_nc_mail_*"] },
    container: { name: "the-box", image: "ghcr.io/cbcoutinho/nextcloud-mcp-server:latest", status: "Up 4 days", endpoint: "http://127.0.0.1:18000/mcp" },
  };
  const inst = instanceOf(matched, { url: "https://cloud.example.org", username: "user", password: "pw" });
  assert.deepEqual(inst, {
    name: "cloud",
    url: "https://cloud.example.org",
    username: "user",
    password: "pw",
    capabilities: { mail: false },
    container: "adopted:the-box",
  });
});

test("migrateExistingMcpEntries takes over nothing where no entry stands on a found container (and saves nothing then)", async () => {
  await withDirs(async () => {
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
    writeMcp(process.env.PI_CODING_AGENT_DIR!, { faraway: { url: "http://127.0.0.1:59999/mcp" } }); // no container publishes there
    const docker = { containers: { inspect: async () => undefined } } as unknown as Docker;
    assert.deepEqual(await migrateExistingMcpEntries(docker), []);
    assert.ok(!fs.existsSync(path.join(process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR!, "settings.json"))); // nothing moved, nothing saved
  });
});

test("migrateExistingMcpEntries takes over nothing where instances stand already: what is set is not second-guessed", async () => {
  await withDirs(async () => {
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
    writeMcp(process.env.PI_CODING_AGENT_DIR!, {});
    fs.mkdirSync(path.join(process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR!, "."), { recursive: true });
    fs.writeFileSync(
      path.join(process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR!, "settings.json"),
      JSON.stringify({ instances: [{ name: "mine", url: "https://a.example.org", username: "u", password: "p", mcpExcludeTools: "", container: "own" }] }),
    );
    const docker = { containers: { inspect: async () => undefined } } as unknown as Docker;
    assert.deepEqual(await migrateExistingMcpEntries(docker), []);
  });
});
