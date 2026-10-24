/**
 * The sizes of the editor's virtual screen the page offers, read by both halves: the server half makes the container
 * with one (server/spec.ts), the Settings page offers them. Smaller is sharper in a panel beside a chat.
 */
export const DISPLAYS = ["1280x720", "1600x900", "1920x1080"] as const;
export type Display = (typeof DISPLAYS)[number];
export const DEFAULT_DISPLAY: Display = "1600x900";

/** The screen size kept in the settings, where it is one the page offers; else the default. */
export const displayOf = (kept: string | undefined): Display => (DISPLAYS as readonly string[]).includes(kept ?? "") ? (kept as Display) : DEFAULT_DISPLAY;
