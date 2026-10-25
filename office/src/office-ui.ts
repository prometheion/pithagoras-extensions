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
