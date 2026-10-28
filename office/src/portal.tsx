import type { Portal } from "@pithagoras/extension-api";

/** The portal this extension is loaded into, for every part of it: set before anything is registered. */
export let portal: Portal;

export function setPortal(given: Portal): void {
  portal = given;
}

// The extension's texts, in the language in effect: its own German where it has it (see de.ts).
export const t = (text: string, vars?: Record<string, string | number>): string => portal.t(text, vars);
/** A text to be translated where it is shown, marked here as one: a title the portal draws, a label kept in a table. */
export const msg = <T extends string>(text: T): T => text;

/** The Office page -- and where it opens one document. */
export const officeUrl = (docId?: string): string =>
  `/x/${portal.extension}/office${docId ? `?doc=${encodeURIComponent(docId)}` : ""}`;
