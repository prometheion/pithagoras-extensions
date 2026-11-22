/** How an instance's entry in pi's config is written through `portal.mcp`: pi's own keys only, `toolExposure` for the
 * families that are off, `approve` as the option beside it -- against a fake of the portal's mcp, throwaway
 * directories for the store, and a portal that keeps `approve` or one that does not. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { carryOver, syncEntry, stopEntries, type McpPort } from "../src/entries.ts";
import { loadHid, saveHid, loadStopped } from "../src/config.ts";
import { APPROVE_TOOLS } from "../src/capabilities.ts";

/** The adapter's keys, which pi does not read and the portal refuses where a server is on. */
const ADAPTER_KEYS = ["lifecycle", "idleTimeout", "requestTimeoutMs", "directTools", "includeTools", "excludeTools", "approveTools", "approve", "debug", "trace", "toolPrefix", "disabled", "auth", "bearerToken", "bearerTokenEnv", "exposeResources", "socket"];

async function withHome(fn: () => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nextcloud-entries-"));
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR = path.join(home, "data");
  try {
    await fn();
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** The mcp of a portal: `keeps` says whether it keeps `approve` (a portal before the option takes the entry only,
 * and answers `get` without it). `failSet` makes the next sets throw. */
function fakeMcp(keeps = true) {
  const entries = new Map<string, Record<string, unknown>>();
  const gates = new Map<string, string[]>();
  const calls: { name: string; entry: Record<string, unknown> | undefined; options?: { approve?: string[] } }[] = [];
  const state = { failSet: false };
  const port: McpPort = {
    get: (name) => {
      const entry = entries.get(name);
      return entry && { entry: structuredClone(entry), on: entry.enabled !== false, ...(keeps ? { approve: gates.get(name) ?? [] } : {}) };
    },
    set: async (name, entry, options) => {
      calls.push({ name, entry: entry && structuredClone(entry), options });
      if (state.failSet) throw new Error("the portal could not write the file");
      if (entry === undefined) {
        entries.delete(name);
        gates.delete(name);
      } else {
        entries.set(name, structuredClone(entry));
        if (keeps) gates.set(name, options?.approve ?? []);
        else gates.delete(name);
      }
      return { reloaded: 0, waiting: 0 };
    },
  };
  return { port, entries, gates, calls, state };
}

const ADDRESS = "http://127.0.0.1:8000/mcp";
const inst = (capabilities?: Record<string, boolean>) => ({ name: "uni", url: "https://cloud.example.org", username: "u", password: "p", ...(capabilities ? { capabilities } : {}) });

test("an entry is pi's own: the url and a toolExposure for the families that are off, no key of the adapter, and what asks first is the approve option", async () => {
  await withHome(async () => {
    const mcp = fakeMcp();
    assert.equal(await syncEntry(mcp.port, inst({ mail: false, talk: false }), ADDRESS, false, false), true);
    assert.deepEqual(mcp.entries.get("uni"), { url: ADDRESS, toolExposure: { "nc_mail_*": "hidden", "talk_*": "hidden" } });
    for (const key of ADAPTER_KEYS) assert.ok(!(key in mcp.entries.get("uni")!), key);
    assert.deepEqual(mcp.calls.at(-1)?.options, { approve: APPROVE_TOOLS });
    assert.deepEqual(mcp.gates.get("uni"), APPROVE_TOOLS);
    for (const pattern of APPROVE_TOOLS) assert.ok(!pattern.startsWith("mcp__") && !pattern.includes("?"), pattern);
    // and an instance with every family on has no toolExposure at all
    const plain = fakeMcp();
    await syncEntry(plain.port, inst(), ADDRESS, false, false);
    assert.deepEqual(plain.entries.get("uni"), { url: ADDRESS });
    assert.deepEqual(plain.calls.at(-1)?.options, { approve: APPROVE_TOOLS });
  });
});

test("an entry an earlier version wrote, with the adapter's keys, is written again as pi's own, with what it hid and asked about kept", async () => {
  await withHome(async () => {
    const mcp = fakeMcp();
    mcp.entries.set("uni", { url: ADDRESS, lifecycle: "persistent", directTools: true, excludeTools: ["uni_nc_mail_*"], approveTools: ["nc_notes_*", "uni_deck_*"], bearerToken: "x" });
    mcp.gates.set("uni", []);
    assert.equal(await syncEntry(mcp.port, inst({ mail: false }), ADDRESS, false, true), true);
    const written = mcp.entries.get("uni")!;
    assert.deepEqual(written, { url: ADDRESS, toolExposure: { "nc_mail_*": "hidden" } });
    for (const key of ADAPTER_KEYS) assert.ok(!(key in written), key);
    assert.deepEqual(mcp.gates.get("uni"), [...APPROVE_TOOLS, "nc_notes_*", "uni_deck_*", "deck_*"]);
    assert.deepEqual(mcp.calls.map((c) => c.entry === undefined), [true, false], "removed first, so that the name leaves Settings -> Guard's trusted servers");
  });
});

test("an entry that is already what it would be is not said again, and a switched-off server stays switched off", async () => {
  await withHome(async () => {
    const mcp = fakeMcp();
    await syncEntry(mcp.port, inst({ mail: false }), ADDRESS, false, false);
    mcp.calls.length = 0;
    assert.equal(await syncEntry(mcp.port, inst({ mail: false }), ADDRESS, true, false), false);
    assert.equal(mcp.calls.length, 0);
    assert.deepEqual(carryOver("uni", { url: "x", disabled: true, lifecycle: "lazy" }), { enabled: false });
    assert.throws(() => carryOver("uni", { includeTools: ["a"] }), /includeTools/);
    assert.throws(() => carryOver("uni", { exposeResources: false }), /exposeResources/);
  });
});

test("a portal that does not keep approve is not written to: an entry it holds is refused, and a first write is read back and taken away", async () => {
  await withHome(async () => {
    const old = fakeMcp(false);
    old.entries.set("uni", { url: ADDRESS, lifecycle: "persistent", approveTools: ["*_delete_*"] });
    await assert.rejects(syncEntry(old.port, inst({ mail: false }), ADDRESS, true, false), /does not keep the `approve` option/);
    assert.equal(old.calls.length, 0, "nothing is written over what the old portal reads");
    assert.deepEqual(old.entries.get("uni"), { url: ADDRESS, lifecycle: "persistent", approveTools: ["*_delete_*"] });

    const first = fakeMcp(false);
    await assert.rejects(syncEntry(first.port, inst({ mail: false }), ADDRESS, false, false), /Update Pithagoras/);
    assert.equal(first.entries.has("uni"), false, "no entry stands rather than one that asks nothing");
    assert.deepEqual(first.calls.map((c) => c.entry === undefined), [false, true]);
    assert.deepEqual(loadHid(), {}, "and nothing is recorded of it");

    // a portal that keeps approve but changes it is no better
    const odd = fakeMcp();
    const set = odd.port.set;
    odd.port.set = (name, entry, options) => set(name, entry, entry ? { approve: [] } : options);
    await assert.rejects(syncEntry(odd.port, inst(), ADDRESS, false, false), /does not keep the `approve` option/);
    assert.equal(odd.entries.has("uni"), false);
  });
});

test("what the extension hid is recorded before the write, so that a run that stops between the two leaves no line that looks the person's", async () => {
  await withHome(async () => {
    const mcp = fakeMcp();
    mcp.state.failSet = true;
    await assert.rejects(syncEntry(mcp.port, inst({ mail: false }), ADDRESS, false, false), /could not write/);
    assert.deepEqual(loadHid(), { uni: ["nc_mail_*"] }, "recorded before the write");
    // the write went through in a run that then stopped: the record says the line is the extension's, and mail on again drops it
    mcp.state.failSet = false;
    mcp.entries.set("uni", { url: ADDRESS, toolExposure: { "nc_mail_*": "hidden" } });
    mcp.gates.set("uni", APPROVE_TOOLS);
    await syncEntry(mcp.port, inst({ mail: true }), ADDRESS, true, false);
    assert.deepEqual(mcp.entries.get("uni"), { url: ADDRESS });
    assert.deepEqual(loadHid(), {});
  });
});

test("a line the person took out by hand does not stay recorded as the extension's: their own hide of it later is theirs", async () => {
  await withHome(async () => {
    const mcp = fakeMcp();
    // run 1, mail off
    await syncEntry(mcp.port, inst({ mail: false }), ADDRESS, false, false);
    assert.deepEqual(loadHid(), { uni: ["nc_mail_*"] });
    // the person takes the line out in Settings -> MCP; run 2, mail on: the entry is what it should be, nothing is written
    mcp.entries.set("uni", { url: ADDRESS });
    mcp.calls.length = 0;
    assert.equal(await syncEntry(mcp.port, inst({ mail: true }), ADDRESS, true, false), false);
    assert.equal(mcp.calls.length, 0);
    assert.deepEqual(loadHid(), {}, "pruned although nothing was written");
    // the person hides the family themselves; run 3, mail on: theirs stays
    mcp.entries.set("uni", { url: ADDRESS, toolExposure: { "nc_mail_*": "hidden" } });
    await syncEntry(mcp.port, inst({ mail: true }), ADDRESS, true, false);
    assert.deepEqual(mcp.entries.get("uni"), { url: ADDRESS, toolExposure: { "nc_mail_*": "hidden" } });
    assert.deepEqual(loadHid(), {});
  });
});

test("a record left from an earlier run is replaced by what the entry says now", async () => {
  await withHome(async () => {
    saveHid("uni", ["nc_news_*"]);
    const mcp = fakeMcp();
    await syncEntry(mcp.port, inst({ mail: false }), ADDRESS, false, false);
    assert.deepEqual(loadHid(), { uni: ["nc_mail_*"] });
  });
});

test("a stop switches the entries that are on off and keeps them with their toolExposure, their approve and the person's own lines", async () => {
  await withHome(async () => {
    const mcp = fakeMcp();
    await syncEntry(mcp.port, inst({ mail: false }), ADDRESS, false, false);
    // the person's own lines and patterns, added in Settings -> MCP
    mcp.entries.set("uni", { ...mcp.entries.get("uni")!, toolExposure: { "nc_mail_*": "hidden", nc_notes_get_note: "hidden" }, timeout: 30 });
    mcp.gates.set("uni", [...APPROVE_TOOLS, "nc_notes_update_*"]);
    await stopEntries(mcp.port, ["uni"]);
    assert.deepEqual(mcp.entries.get("uni"), { url: ADDRESS, toolExposure: { "nc_mail_*": "hidden", nc_notes_get_note: "hidden" }, timeout: 30, enabled: false });
    assert.deepEqual(mcp.gates.get("uni"), [...APPROVE_TOOLS, "nc_notes_update_*"], "the approve is passed again: a set without it would drop it");
    assert.deepEqual(loadStopped(), ["uni"]);
    // the next start switches it on, and only that: the url and the family lines are written anew, the person's stay
    assert.equal(await syncEntry(mcp.port, inst({ mail: false }), "http://127.0.0.1:8001/mcp", true, false), true);
    assert.deepEqual(mcp.entries.get("uni"), { url: "http://127.0.0.1:8001/mcp", toolExposure: { "nc_mail_*": "hidden", nc_notes_get_note: "hidden" }, timeout: 30 });
    assert.deepEqual(mcp.gates.get("uni"), [...APPROVE_TOOLS, "nc_notes_update_*"]);
    assert.deepEqual(loadStopped(), []);
  });
});

test("an entry that was off before the stop (the person's, or the move's) is not recorded, and stays off through a restart", async () => {
  await withHome(async () => {
    const mcp = fakeMcp();
    await syncEntry(mcp.port, inst(), ADDRESS, false, false);
    mcp.entries.set("uni", { ...mcp.entries.get("uni")!, enabled: false });
    mcp.calls.length = 0;
    await stopEntries(mcp.port, ["uni"]);
    assert.deepEqual(mcp.calls, [], "nothing is written");
    assert.deepEqual(loadStopped(), []);
    await syncEntry(mcp.port, inst(), ADDRESS, true, false);
    assert.equal(mcp.entries.get("uni")!.enabled, false);
  });
});

test("a stopped entry that the person switched on meanwhile is left alone by the start, and the record goes; one that is gone is not written by the stop", async () => {
  await withHome(async () => {
    const mcp = fakeMcp();
    await syncEntry(mcp.port, inst(), ADDRESS, false, false);
    await stopEntries(mcp.port, ["uni"]);
    const { enabled, ...on } = mcp.entries.get("uni")!;
    mcp.entries.set("uni", on);
    mcp.calls.length = 0;
    assert.equal(await syncEntry(mcp.port, inst(), ADDRESS, true, false), false);
    assert.deepEqual(mcp.calls, []);
    assert.deepEqual(loadStopped(), []);
    mcp.entries.delete("uni");
    await stopEntries(mcp.port, ["uni"]);
    assert.deepEqual(mcp.calls, []);
  });
});
