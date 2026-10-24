import type { Portal } from "@pithagoras/extension-api";

/** The portal the extension was loaded into, for every part of it: set before anything is registered. */
export let portal: Portal;

export function setPortal(given: Portal): void {
  portal = given;
}

// The extension's texts, in the language in effect: its own German where it has it (see de.ts).
export const t = (text: string, vars?: Record<string, string | number>) => portal.t(text, vars);
export const tp = (n: number, one: string, other: string, vars?: Record<string, string | number>) => portal.tp(n, one, other, vars);
/** A text to be translated where it is shown, marked here as one: a title the portal draws, a label kept in a table. */
export const msg = <T extends string>(text: T): T => text;

/** Where Blender's page in Settings is. */
export const SETTINGS_PAGE = "/settings/x/pithagoras-blender";
