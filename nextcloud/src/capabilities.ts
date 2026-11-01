/**
 * The capability families a Nextcloud MCP server offers, and how this extension knows them: by the raw prefixes
 * their tool names begin with. Two things turn with one choice per instance per family -- whether the chats' tool
 * list keeps it out (the globs in its entry in pi's config) and whether the panel shows what belongs to it; and
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

/** The globs of one family against the names pi-mcp-adapter gives the tools (<instance>_<tool>): one per prefix. */
export function globsFor(cap: Capability, instanceName: string): string[] {
  return cap.prefixes.map((prefix) => `${instanceName}_${prefix}*`);
}

/** What an instance keeps out of the chats' tool list on its explicit choices: every family it turned off; a
 * choice that stands none keeps nothing (an instance with no choices keeps nothing -- everything is offered). */
export function excludeGlobs(inst: { name: string; capabilities?: Record<string, boolean> }): string[] {
  const out: string[] = [];
  for (const cap of CAPABILITIES) if (inst.capabilities?.[cap.id] === false) out.push(...globsFor(cap, inst.name));
  return out;
}

/** The tools the agent may not call without the person's yes, by their raw names, which pi-mcp-adapter matches
 * whatever the instance is called (`approveTools` of the instance's entry): what goes out to other people (mail, a
 * Talk message, a conversation or a participant added, an event or a meeting with attendees, whom Nextcloud mails an
 * invitation), a public link or a share, and everything that deletes, clears or takes to the trash -- the calendar's
 * bulk operations and its calendar management among them, which delete by an argument the gate cannot look at. Whole
 * tools: an event without attendees is asked about too. Overwrites and moves of files and mail are not asked about
 * (the README says so). A person's own list in the entry takes this one's place. */
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

/** Every list an earlier version of this extension wrote as the entry's `approveTools`: an entry that holds one of
 * them holds this extension's default, not a choice of the person's, and gets the list of this version. A version
 * that changes APPROVE_TOOLS adds the one it replaces here. */
export const EARLIER_APPROVE_TOOLS: string[][] = [
  ["nc_mail_send_message", "nc_share_create*", "nc_share_update*", "nc_share_delete*", "*_delete_*", "*_clear_*"],
];

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
