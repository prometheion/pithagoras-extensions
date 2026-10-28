/**
 * The browser half's pure helpers: no React, no portal, no DOM of their own -- so they can be unit-tested from
 * the node side exactly as the server half's seams are. Everything that needs the portal sits in portal.tsx and web/.
 */

/**
 * The document open on the Office page, out of its address: `?doc=<id>` says it (the same convention the docs
 * extension uses for `?folder=&doc=`). Encoded ids come back decoded; anything else means the list view.
 */
export function parseDocQuery(search: string): string | null {
  // Tolerated as it comes from the page's address -- a query, or even an address with its path still on it.
  const query = search.includes("?") ? search.slice(search.indexOf("?") + 1) : search;
  const doc = new URLSearchParams(query).get("doc");
  return doc && doc !== "" ? doc : null;
}

/**
 * A reference whose image moves under you, which breaks the co-editing keys: `:latest` or `:stable`, `@latest`, and
 * one with no tag at all, which Docker reads as `:latest`. A colon before the last "/" is a registry's port, not a tag.
 * One rule for both halves: POST /settings refuses such a tag (400 invalid_image_tag), and the Settings page refuses it
 * in the input before it is sent.
 */
export function floatingTag(tag: string): boolean {
  const name = tag.trim().slice(tag.trim().lastIndexOf("/") + 1);
  return /:(latest|stable)$/i.test(tag) || /@latest$/i.test(tag) || !/[:@]/.test(name);
}

/** How many are in a document right now, out of the polled locks map: every doc has an entry, empty when nobody. */
export function editorsIn(locks: Record<string, { id: string; name?: string }[]> | undefined, docId: string): number {
  return (locks?.[docId] ?? []).length;
}

/** The server half's refusal while a new Document Server is still setting itself up (POST /editor-config answers 503
 * ds_starting, as the portal's ApiError carries it): the editor page waits and asks again instead of saying it. */
export function startingUp(e: unknown): boolean {
  const refused = e as { status?: unknown; body?: { code?: unknown } } | null;
  return refused?.status === 503 && refused.body?.code === "ds_starting";
}

/** What the Office page in Settings says of the Document Server: how it stands, out of /state's `container`. */
export type DsHealth = "downloading" | "running" | "starting" | "failed" | "stopped" | "other";

export function dsHealth(c: { state: string; pull?: { active: boolean } | null; error?: string }): DsHealth {
  if (c.pull?.active) return "downloading";
  if (c.state === "running") return "running";
  if (c.state === "starting" || c.state === "restarting") return "starting";
  // A start that failed is said until one succeeds, over the state it left behind (stopped, or nothing there).
  if (c.error) return "failed";
  if (c.state === "stopped") return "stopped";
  return "other";
}

/** What it says of the agents' editor: its image (downloaded by Start), and the browser made from it. */
export type AgentHealth = "downloading" | "failed" | "missing" | "running" | "starting" | "ready";

export function agentHealth(a: {
  present: boolean;
  pull: { active: boolean; error?: string } | null;
  browser?: { running: boolean; starting: boolean; editors?: number; error?: string };
}): AgentHealth {
  if (a.pull?.active) return "downloading";
  if (!a.present) return a.pull?.error ? "failed" : "missing";
  // A start under way is said over the failure of the one before: that error is kept until a start succeeds.
  if (a.browser?.starting) return "starting";
  if (a.browser?.error) return "failed";
  if (a.browser?.running) return "running";
  return "ready";
}

/** The error to show beside a failed agents' editor: its download's, or its browser's last start's. */
export function agentError(a: { present: boolean; pull: { error?: string } | null; browser?: { error?: string } }): string | undefined {
  return a.present ? a.browser?.error : a.pull?.error;
}

/**
 * What the Office page in Settings says of Office: one thing, made of the Document Server and the agents' editor, both
 * always needed. Downloading while either downloads; failed where either did, with `failed` naming the part and
 * `error` why; starting while the Document Server starts; stopped (or another state of its container) while it does
 * not run; missing while it runs without the agents' editor's image (an install from before Start downloaded it: Start
 * gets it); running when both are there (the agents' browser idle, starting or at work).
 */
export type OfficeHealth = "downloading" | "failed" | "starting" | "stopped" | "other" | "missing" | "running";

export function officeHealth(
  c: Parameters<typeof dsHealth>[0],
  a: Parameters<typeof agentHealth>[0],
): { health: OfficeHealth; failed?: "ds" | "agent"; error?: string } {
  const ds = dsHealth(c);
  const agent = agentHealth(a);
  if (ds === "downloading" || agent === "downloading") return { health: "downloading" };
  if (ds === "failed") return { health: "failed", failed: "ds", error: c.error };
  if (agent === "failed") return { health: "failed", failed: "agent", error: agentError(a) };
  if (ds === "starting" || ds === "stopped" || ds === "other") return { health: ds };
  return { health: agent === "missing" ? "missing" : "running" };
}

/**
 * Which document a chat's Office panel shows, out of what it was opened with (`panels.open("office", { doc })`, from a
 * tool card) and what was chosen in it since (`panel.setState`: a row opened, or back to the list). A choice holds
 * only for the opening it was made in (`for`, that opening's params): the next opening, from a card, shows its own
 * document again. Null: the list.
 */
export interface PanelChoice {
  doc: string | null;
  for: unknown;
}

export function panelDoc(params: unknown, state: unknown): string | null {
  const chose = state as PanelChoice | null | undefined;
  if (chose && typeof chose === "object" && "for" in chose && Object.is(chose.for, params)) return typeof chose.doc === "string" && chose.doc !== "" ? chose.doc : null;
  const asked = params as { doc?: unknown } | null | undefined;
  return asked && typeof asked === "object" && typeof asked.doc === "string" && asked.doc !== "" ? asked.doc : null;
}

/** The choice of `doc` (or the list, for null) in the panel as it was opened with `params`. */
export function choosePanelDoc(params: unknown, doc: string | null): PanelChoice {
  return { doc, for: params };
}
