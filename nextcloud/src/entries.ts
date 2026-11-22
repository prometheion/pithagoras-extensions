/**
 * An instance's entry in pi's mcp.json, as this extension writes it through `portal.mcp`: the loopback `url` of its
 * container, the `toolExposure` that hides the families the instance turned off, and -- beside the file, as the
 * `approve` option -- what asks the person before a call. None of the adapter's keys is written; an entry an earlier
 * version wrote with them is written again without them. server.ts decides when an instance's entry is due; this
 * says how one is made, kept and checked.
 */
import { isDeepStrictEqual } from "node:util";
import { loadHid, saveHid, type NextcloudInstance } from "./config";
import { approveFor, exposureWritten, toolExposureFor } from "./capabilities";

/** The part of `portal.mcp` this reads and writes (a real portal's is the whole of it). `approve` is missing from what
 * a portal before the option answers. */
export interface McpPort {
  get(name: string): { entry: Record<string, unknown>; on?: boolean; approve?: string[] } | undefined;
  set(name: string, entry: Record<string, unknown> | undefined, options?: { approve?: string[] }): Promise<unknown>;
}

/** Why a portal that does not keep `approve` is not written to: on it, the entry's `toolExposure` and the questions
 * would be ignored, and every tool of every family would run unasked. */
const oldPortal = (name: string): string =>
  `${name}: this portal does not keep the \`approve\` option of portal.mcp.set (the portal's own MCP support, thecodacus/pithagoras#387), so nothing would ask before mail goes out or something is deleted, and the families switched off would be offered. The server's entry is not written. Update Pithagoras to a release that has it.`;

/** What an entry in pi's config keeps of itself where this extension rewrites it: what pi reads of the person's own
 * tuning of that server (that it is switched off, its timeout and description, how its tools are exposed) -- but not
 * how the server is reached, which the instance says now, never a login (a header, a token or an environment someone
 * put on an entry of that name is not sent on to the container), and none of the adapter's keys, which an entry an
 * earlier version wrote has (`lifecycle`, `debug`, `directTools`, `excludeTools`, `approveTools` ...): pi does not read
 * them, and the portal refuses an entry that has one. The two the person may have set to narrow what the agent reaches,
 * `includeTools` and `exposeResources: false`, have no word in pi's entry: dropped, they would widen it unseen, so the
 * entry stays as it is and the run says so. An entry the portal's move left switched off stays switched off: the move
 * does that for several reasons (the adapter was off, a list of switches had its tools off, a rule it could not carry)
 * and does not say which, so only the person switches it on, in Settings -> MCP (the status says so). */
export function carryOver(name: string, entry: Record<string, unknown> | undefined): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  if (!entry) return kept;
  const narrowing = [Array.isArray(entry.includeTools) && entry.includeTools.length ? "includeTools" : "", entry.exposeResources === false ? "exposeResources" : ""].filter(Boolean);
  if (narrowing.length)
    throw new Error(`${name}: its entry in pi's mcp.json has ${narrowing.join(" and ")}, which pi does not read, so writing it without would offer more than the person chose. Take it out in Settings -> MCP (hide the tools in its toolExposure instead), then press Start.`);
  for (const key of ["enabled", "timeout", "description", "exposure"]) if (key in entry) kept[key] = entry[key];
  if (entry.disabled === true) kept.enabled = false;
  return kept;
}

/**
 * Bring one instance's entry to where its choices ask for it. Says whether it wrote: where the entry is this
 * extension's own and already what it would be, nothing is said again (every set reloads the open chats).
 *
 * `own` is whether the entry stands in the extension's list of what it wrote, `earlier` whether it is one an earlier
 * version wrote (which counted as the person's own, trusted: it is removed first, as writing a server again does not
 * take its name out of Settings -> Guard's trusted servers).
 *
 * The portal has to keep `approve`: a portal that does not (see oldPortal) takes only the entry, and an entry
 * with a `toolExposure` and no `approve` would run every call unasked. One that has an entry already says so by the
 * answer of `get` (no `approve` in it); a first write is read back, and taken away again where it was not kept.
 *
 * What the extension hid itself (`hid` in the store, see exposureWritten) is recorded before the write, with what the
 * record held (a crash between the two leaves a pattern recorded that is not in the file, which the next run
 * drops, never one in the file that is not recorded, which would stay as if it were the person's), and is brought to
 * what the entry says after it -- also where nothing is written, so that a line the person took out by hand does
 * not stay recorded.
 */
export async function syncEntry(mcp: McpPort, inst: NextcloudInstance, address: string, own: boolean, earlier: boolean): Promise<boolean> {
  const there = mcp.get(inst.name);
  if (there && !Array.isArray(there.approve)) throw new Error(oldPortal(inst.name));
  const kept = carryOver(inst.name, there?.entry);
  const wrote = loadHid()[inst.name] ?? [];
  const toolExposure = toolExposureFor(inst, there?.entry.toolExposure, wrote);
  const entry = { ...kept, url: address, ...(Object.keys(toolExposure).length ? { toolExposure } : {}) };
  // What this extension asks about by default, in this version or an earlier one, gets this version's list (a wider
  // one reaches every install that ran an earlier one); what a person added to it stays.
  const approve = approveFor(there?.approve, there?.entry.approveTools, inst.name);
  const hid = exposureWritten(inst, there?.entry.toolExposure, wrote);
  if (there && own && isDeepStrictEqual(there.entry, entry) && isDeepStrictEqual(there.approve, approve)) {
    saveHid(inst.name, hid);
    return false;
  }
  saveHid(inst.name, [...new Set([...wrote, ...hid])]);
  if (there && earlier) await mcp.set(inst.name, undefined);
  await mcp.set(inst.name, entry, { approve });
  const back = mcp.get(inst.name);
  if (!back || !isDeepStrictEqual(back.approve, approve)) {
    await mcp.set(inst.name, undefined).catch(() => {}); // not kept: no entry stands rather than one that asks nothing
    saveHid(inst.name, []);
    throw new Error(oldPortal(inst.name));
  }
  saveHid(inst.name, hid);
  return true;
}
