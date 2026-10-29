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

/** A choice map from the free keep-out lists an earlier version kept: every family whose glob stands in the list is
 * read off there, nothing else -- a glob no family names (the person's own hand work) does not come over, as this
 * module offers no place for it to stand. */
export function capabilitiesFromExcludeText(instanceName: string, text: string): Record<string, boolean> {
  const named = text.split(",").map((part) => part.trim()).filter(Boolean);
  const out: Record<string, boolean> = {};
  for (const cap of CAPABILITIES) if (globsFor(cap, instanceName).some((glob) => named.includes(glob))) out[cap.id] = false;
  return out;
}

/** One tab of the panel and what its showing stands on: at least one of its capabilities turned on. */
export interface PanelTab {
  id: string;
  label: string;
  capabilityIds: string[];
}

/** The tabs, in their order: what the families of today stand under -- with the ones an earlier version of this
 * extension never showed (mail, news and collectives among them) beside them. */
export const TABS: PanelTab[] = [
  { id: "shopping", label: "Shopping List", capabilityIds: ["shopping"] },
  { id: "cookbook", label: "Cookbook", capabilityIds: ["cookbook"] },
  { id: "notes", label: "Notes", capabilityIds: ["notes"] },
  { id: "files", label: "Files & Sharing", capabilityIds: ["files", "sharing"] },
  { id: "deck", label: "Deck", capabilityIds: ["deck"] },
  { id: "calendar", label: "Calendar", capabilityIds: ["calendar"] },
  { id: "contacts", label: "Contacts", capabilityIds: ["contacts"] },
  { id: "mail", label: "Mail", capabilityIds: ["mail"] },
  { id: "news", label: "News", capabilityIds: ["news"] },
  { id: "collectives", label: "Collectives", capabilityIds: ["collectives"] },
];

/** Whether one tab is offered for an instance's standing: where what the endpoint provides is known, at least one
 * of the tab's capabilities provided and not turned off; where it is not known yet, the choices alone decide. */
export function tabOffered(tab: PanelTab, available?: Record<string, boolean>, on: Record<string, boolean> = {}): boolean {
  return tab.capabilityIds.some((id) => on[id] !== false && available?.[id] !== false);
}
