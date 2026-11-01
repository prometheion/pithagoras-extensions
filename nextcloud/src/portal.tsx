import type { Portal } from "@pithagoras/extension-api";

/** The portal this extension is loaded into, for every part of it: set before anything is registered. */
export let portal: Portal;

export function setPortal(given: Portal): void {
  portal = given;
}

// The extension's texts, in the language in effect: its own German where it has it (see de.ts).
export const t = (text: string, vars?: Record<string, string | number>): string => portal.t(text, vars);
/** A text to be translated where it is shown, marked here as one: a title the portal draws. */
export const msg = <T extends string>(text: T): T => text;
