/**
 * The capability families a Nextcloud MCP server offers, and how this extension knows them: by the raw prefixes
 * their tool names begin with. Two things turn with one choice per instance per family -- whether the chats' tool
 * list keeps it out (the `toolExposure` of its entry in pi's config) and whether the panel shows what belongs to it; and
 * whether a family is provided at all is found by asking the running endpoint for its tools, never assumed: a
 * family the server does not provide is offered nowhere -- no tab for it, nothing to keep out.
 *
 * This file keeps node imports away from it on purpose: both halves of the extension read it (the browser half
 * ships it into its bundle).
 */

/** One family of the server's tools: what this extension calls it, and the raw prefixes its tools' names begin with. */
export interface Capability {
  /** The family as this extension names it in settings and status. */
  id: string;
  /** What the pages call it. */
  label: string;
  /** The raw tool-name prefixes whose tools belong to the family. */
  prefixes: string[];
}

/** The families, in the order the settings page lists them. Files and sharing stand apart -- the panel shows them
 * under one tab, but what an instance keeps out of the chats' tool list is kept separate for each of them. */
export const CAPABILITIES: Capability[] = [
  { id: "shopping", label: "Shopping List", prefixes: ["nc_shopping_list_"] },
  { id: "cookbook", label: "Cookbook", prefixes: ["nc_cookbook_"] },
  { id: "notes", label: "Notes", prefixes: ["nc_notes_"] },
  { id: "files", label: "Files", prefixes: ["nc_webdav_"] },
  { id: "sharing", label: "Sharing", prefixes: ["nc_share_"] },
  { id: "deck", label: "Deck", prefixes: ["deck_"] },
  { id: "calendar", label: "Calendar", prefixes: ["nc_calendar_"] },
  { id: "contacts", label: "Contacts", prefixes: ["nc_contacts_"] },
  { id: "mail", label: "Mail", prefixes: ["nc_mail_"] },
  { id: "news", label: "News", prefixes: ["nc_news_"] },
  { id: "collectives", label: "Collectives", prefixes: ["collectives_"] },
  // No tab of the panel stands for these two, but the server offers their tools to every user whose Nextcloud has
  // the app: Talk posts as the person and invites by mail, so it has to be something an instance can turn off.
  { id: "talk", label: "Talk", prefixes: ["talk_"] },
  { id: "tables", label: "Tables", prefixes: ["nc_tables_"] },
];

/** The one family a raw tool name stands with -- none where no family names it. */
export function capabilityOfTool(name: string): Capability | undefined {
  return CAPABILITIES.find((cap) => cap.prefixes.some((prefix) => name.startsWith(prefix)));
}

/** What an endpoint's tool list says of every family: present where at least one of its tools stands in it. */
export function availableFromTools(toolNames: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const cap of CAPABILITIES) out[cap.id] = toolNames.some((name) => capabilityOfTool(name)?.id === cap.id);
  return out;
}

/** The patterns of one family in an entry's `toolExposure`, against the raw tool names the server gives: one per prefix. */
export function patternsFor(cap: Capability): string[] {
  return cap.prefixes.map((prefix) => `${prefix}*`);
}

/** Whether a pattern matches a name as pi matches the keys of `toolExposure`: `*` for any characters, no other wildcard. */
function matches(pattern: string, name: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(name);
}

/** The patterns of the families an instance turned off: what this extension hides in the entry's `toolExposure`. */
export function familyPatterns(inst: { capabilities?: Record<string, boolean> }): string[] {
  return CAPABILITIES.filter((cap) => inst.capabilities?.[cap.id] === false).flatMap(patternsFor);
}

/**
 * The patterns of `familyPatterns` that this extension itself puts into the entry now, to be recorded as its own
 * (`wrote` of the next run): not one the person had hidden already, which stays theirs whatever the family's switch
 * says. `own` is what the entry says of its tools now, `wrote` what the extension recorded of its last run.
 */
export function exposureWritten(inst: { capabilities?: Record<string, boolean> }, own: unknown, wrote: readonly string[] = []): string[] {
  const lines = own && typeof own === "object" && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
  return familyPatterns(inst).filter((pattern) => lines[pattern] !== "hidden" || wrote.includes(pattern));
}

/**
 * What an instance keeps out of the chats' tool list, as the `toolExposure` of its entry in pi's config: every
 * family it turned off, as the patterns of its prefixes, `hidden`. A choice that stands none keeps nothing (an
 * instance with no choices keeps nothing -- everything is offered). Only patterns, never an exact name of ours: pi
 * takes an exact name before any pattern, so a name that stood beside them could leave visible what a family hides.
 *
 * `own` is what the entry says of its tools already, `wrote` the patterns of the families that this extension put
 * there itself (see exposureWritten). A person's own lines in it stay -- a tool they hid by name, or a whole family
 * they hid in Settings -> MCP while its switch here is on -- but not the extension's own lines for the families,
 * which are written anew from the choices, and not an exact name of another exposure that a pattern of a family
 * that is off covers: that would win over the pattern and leave the tool visible. An exact name under a pattern of
 * the person's own (`*` hidden, a few tools shown by name) stays: that is how they say it.
 */
export function toolExposureFor(inst: { capabilities?: Record<string, boolean> }, own?: unknown, wrote: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pattern of familyPatterns(inst)) out[pattern] = "hidden";
  const ours = new Set(CAPABILITIES.flatMap(patternsFor));
  if (own && typeof own === "object" && !Array.isArray(own)) {
    for (const [name, how] of Object.entries(own)) {
      if (typeof how !== "string" || name in out) continue;
      if (ours.has(name) && how === "hidden" && wrote.includes(name)) continue; // what this extension hid for a family that is on again
      out[name] = how;
    }
  }
  // Only the patterns this extension hides now: a person's own `*: hidden` with a few tools named as exceptions (the way
  // to say what includeTools did) is a setup of theirs, whose exceptions stay.
  const mine = familyPatterns(inst);
  for (const name of Object.keys(out)) if (out[name] !== "hidden" && !name.includes("*") && mine.some((pattern) => matches(pattern, name))) delete out[name];
  return out;
}

/** The tools the agent may not call without the person's yes, by their raw names as the server gives them, which the
 * portal matches whatever the instance is called (the `approve` option of `portal.mcp.set`, not a key of the entry):
 * what goes out to other people (mail, a Talk message, a conversation or a participant added, an event or a meeting
 * with attendees, whom Nextcloud mails an invitation), a public link or a share, and everything that deletes, clears
 * or takes to the trash -- the calendar's bulk operations and its calendar management among them, which delete by an
 * argument the gate cannot look at. Whole tools: an event without attendees is asked about too. Overwrites and moves
 * of files and mail are not asked about (the README says so). Patterns with `*` only, no `?`. */
export const APPROVE_TOOLS = [
  "nc_mail_send_message",
  "nc_share_create*",
  "nc_share_update*",
  "nc_share_delete*",
  "talk_send_message",
  "talk_create_conversation",
  "talk_add_participant",
  "nc_calendar_create_event",
  "nc_calendar_update_event",
  "nc_calendar_create_meeting",
  "nc_calendar_bulk_operations",
  "nc_calendar_manage_calendar",
  "*_delete_*",
  "*_clear_*",
  "*_trash_*",
];

/** Every list an earlier version of this extension asked about as the entry's `approveTools`: what it holds of them is
 * this extension's default, not a choice of the person's. A version that changes APPROVE_TOOLS adds the one it
 * replaces here. */
export const EARLIER_APPROVE_TOOLS: string[][] = [
  ["nc_mail_send_message", "nc_share_create*", "nc_share_update*", "nc_share_delete*", "*_delete_*", "*_clear_*"],
];

/** The prefixes the adapter gave a server's tools (`<server>_`, `<short>_`, `mcp__<server>_`, dashes as underscores),
 * which its `approveTools` patterns were matched with. The portal matches the server's own tool names only. */
function adapterPrefixes(server: string): string[] {
  const long = server.replace(/-/g, "_");
  const short = server.replace(/-?mcp$/i, "").replace(/-/g, "_") || "mcp";
  return [`${long}_`, `${short}_`, `mcp__${long}_`];
}

/** The patterns of a tool's own name that `prefix` + the name matches `pattern` by: what is left of the pattern once
 * the prefix has been matched against its start, wherever a `*` may take any part of it (`*_delete_*` for `uni_`
 * leaves `delete_*` and `*_delete_*`). The same way the portal carries an adapter's list over. */
function throughPrefix(pattern: string, prefix: string): string[] {
  const seen = new Map<string, string[]>();
  const walk = (i: number, j: number): string[] => {
    if (j === prefix.length) return i < pattern.length ? [pattern.slice(i)] : [];
    if (i === pattern.length) return [];
    const key = `${i}:${j}`;
    const known = seen.get(key);
    if (known) return known;
    const c = pattern[i];
    const found = c === "*" ? [...walk(i + 1, j), ...walk(i, j + 1)] : c === "?" || c === prefix[j] ? walk(i + 1, j + 1) : [];
    seen.set(key, found);
    return found;
  };
  return [...new Set(walk(0, 0))];
}

/**
 * What an instance's calls ask the person about: the default, and what a person added to it. A pattern this
 * extension asks about by default (in this version or an earlier one) is its own; any other that the instance asks
 * about already is the person's, a list they gave that the portal kept when it moved the entry from the adapter, and
 * stays, so they are never asked about less than before. `had` is the patterns the portal holds for the server now
 * (`portal.mcp.get(...).approve`); `given` is the `approveTools` of the entry, where an earlier version's is still in
 * it (a list, or `true` for every tool), in the adapter's words: a pattern with the adapter's prefix (`<server>_...`)
 * is carried as the pattern of the tool's own name, the way the portal does it, as only that matches.
 */
export function approveFor(had: unknown, given: unknown, server: string): string[] {
  const known = new Set([...APPROVE_TOOLS, ...EARLIER_APPROVE_TOOLS.flat()]);
  const extra: string[] = [];
  const add = (pattern: string) => {
    // A pi name or a `<server>/<tool>` could never match here, and the portal refuses a list that has one.
    if (pattern === "" || pattern.startsWith("mcp__") || pattern.includes("/") || known.has(pattern) || extra.includes(pattern)) return;
    extra.push(pattern);
  };
  for (const [list, adapters] of [[had, false], [given === true ? ["*"] : given, true]] as const) {
    if (!Array.isArray(list)) continue;
    for (const one of list) {
      // `?` was the adapter's wildcard for one character: to ask about more is safe, to ask about less is not.
      const pattern = typeof one === "string" ? one.trim().replace(/\?/g, "*") : "";
      add(pattern);
      if (adapters && !known.has(pattern)) for (const prefix of adapterPrefixes(server)) for (const own of throughPrefix(pattern.replace(/-/g, "_"), prefix)) add(own);
    }
  }
  return [...APPROVE_TOOLS, ...extra];
}

/** The instance a tool of the chats belongs to, by the name pi gives it, `mcp__<server>__<tool>` (the server's dashes
 * as underscores): of the instances whose namespace the name stands under, the one with the longest name, as the
 * servers `a` and `a_` have names that begin alike. None where it is no instance's. */
export function instanceOfTool(toolName: string, instanceNames: string[]): string | undefined {
  let best: string | undefined;
  for (const name of instanceNames) {
    if (toolName.startsWith(`mcp__${name.replace(/-/g, "_")}__`) && (!best || name.length > best.length)) best = name;
  }
  return best;
}

/** One tab of the panel and what its showing stands on: at least one of its capabilities turned on. */
export interface PanelTab {
  id: string;
  label: string;
  capabilityIds: string[];
}

/** The tabs, in their order: Files stands first and is the default view, then Calendar, Contacts, Notes, Deck,
 * Collectives, Cookbook, Shopping List, Mail, News. */
export const TABS: PanelTab[] = [
  { id: "files", label: "Files", capabilityIds: ["files"] }, // the shares stand on the files' rows: no rows, no shares
  { id: "calendar", label: "Calendar", capabilityIds: ["calendar"] },
  { id: "contacts", label: "Contacts", capabilityIds: ["contacts"] },
  { id: "notes", label: "Notes", capabilityIds: ["notes"] },
  { id: "deck", label: "Deck", capabilityIds: ["deck"] },
  { id: "collectives", label: "Collectives", capabilityIds: ["collectives"] },
  { id: "cookbook", label: "Cookbook", capabilityIds: ["cookbook"] },
  { id: "shopping", label: "Shopping List", capabilityIds: ["shopping"] },
  { id: "mail", label: "Mail", capabilityIds: ["mail"] },
  { id: "news", label: "News", capabilityIds: ["news"] },
];

/** Whether one family stands on for the panel: not turned off, and not found missing from the endpoint (where that
 * is not known yet, the choice alone decides). */
export function familyOn(id: string, available?: Record<string, boolean>, on: Record<string, boolean> = {}): boolean {
  return on[id] !== false && available?.[id] !== false;
}

/** Whether one tab is offered for an instance's standing: where what the endpoint provides is known, at least one
 * of the tab's capabilities provided and not turned off; where it is not known yet, the choices alone decide. */
export function tabOffered(tab: PanelTab, available?: Record<string, boolean>, on: Record<string, boolean> = {}): boolean {
  return tab.capabilityIds.some((id) => familyOn(id, available, on));
}
