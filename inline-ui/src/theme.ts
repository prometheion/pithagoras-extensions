/** The portal's colours a card is given, by the portal's names for them (see "Looking like the portal" in its docs). */
export const THEME_TOKENS = ["canvas", "surface", "raised", "line", "fg", "fg-muted", "fg-subtle", "fg-faint", "accent", "accent-fg", "ok", "warn", "danger"] as const;

/** A colour as the portal's variables hold it: three numbers, "27 22 38". */
export const TRIPLET = /^\d{1,3} \d{1,3} \d{1,3}$/;

export interface Theme {
  mode: "light" | "dark";
  /** Each by its token, as three numbers. */
  colors: Record<string, string>;
}
