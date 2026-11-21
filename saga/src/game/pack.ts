/**
 * A pack is a world the engine can tell a story in: the places it draws, the ladder a hero climbs, what a hero starts
 * as, and the names of things. The engine itself (the stage, the effects, the figures, the rules) is the same for every
 * pack; Xianxia (xianxia.ts) is the first. Everything a model may name is a word from a list here, so that a model only
 * picks and never draws, animates or computes.
 */

export const TIMES = ["dawn", "day", "dusk", "night"] as const;
export type Time = (typeof TIMES)[number];

export const WEATHERS = ["clear", "mist", "rain", "snow", "petals", "storm", "embers", "fireflies", "leaves"] as const;
export type Weather = (typeof WEATHERS)[number];

/** What a figure on the stage looks like: a silhouette the stage draws, lit in its colour. */
export const LOOKS = [
  "hero",
  "heroine",
  "young_master",
  "maiden",
  "elder",
  "old_woman",
  "disciple",
  "warrior",
  "monk",
  "merchant",
  "child",
  "demon",
  "beast",
  "serpent",
  "spirit",
] as const;
export type Look = (typeof LOOKS)[number];

export const COLORS = ["white", "azure", "jade", "crimson", "gold", "violet", "black", "silver", "rose", "amber"] as const;
export type Color = (typeof COLORS)[number];

/** As RGB, for the stage: a figure's rim light, its aura, the glow of its name. */
export const COLOR_RGB: Record<Color, [number, number, number]> = {
  white: [235, 238, 245],
  azure: [90, 170, 255],
  jade: [80, 220, 160],
  crimson: [235, 60, 70],
  gold: [255, 200, 80],
  violet: [170, 110, 255],
  black: [70, 70, 90],
  silver: [190, 200, 215],
  rose: [255, 130, 180],
  amber: [255, 150, 50],
};

export const MOODS = ["calm", "happy", "angry", "sad", "smug", "shocked", "cold", "afraid", "determined", "whisper", "shout"] as const;
export type Mood = (typeof MOODS)[number];

/** The effects the stage plays: each a few seconds of light, particles and camera, in the colour given or its own. */
export const FX = [
  "lightning",
  "aura",
  "slash",
  "impact",
  "breakthrough",
  "fire",
  "ice",
  "heal",
  "darkness",
  "flash",
  "shake",
  "petals",
  "shockwave",
  "sword_rain",
  "golden_light",
] as const;
export type Fx = (typeof FX)[number];

/** What a place has on its stage. */
export const FEATURES = [
  "pagodas",
  "pines",
  "bamboo",
  "waterfall",
  "lake",
  "walls",
  "clouds_below",
  "lanterns",
  "pillars",
  "cave",
  "ruins",
  "big_moon",
  "blood_sky",
  "palace",
  "stalls",
  "cliff",
  "gate",
  "graves",
  "stars_dense",
  "river",
] as const;
export type Feature = (typeof FEATURES)[number];

export interface PlaceLook {
  /** Outdoors: sky and ridges. Indoors: walls, a floor, and light from where it is lit. */
  kind: "outdoor" | "interior";
  /** How many mountain ridges stand behind each other, 0 for none (a plain, a sea), and how jagged they are, 0..1. */
  ridges: number;
  roughness: number;
  /** How high the nearest ridge reaches, as a share of the stage's height. */
  height: number;
  features: Feature[];
  /** A colour laid over the whole stage, "r g b" and how strongly, 0..1. */
  tint?: { rgb: [number, number, number]; amount: number };
}

export interface Place {
  id: string;
  /** In English: the portal shows it through the extension's own texts. */
  label: string;
  look: PlaceLook;
}

export interface Stage {
  /** Its name, in English. */
  name: string;
  /** Minor stages in the realm: 1 for a realm that has none. */
  steps: number;
  /** The names of its minor stages where they are not numbered: "Early", "Middle", "Late". */
  stepNames?: string[];
}

export interface Origin {
  id: string;
  label: string;
  /** A sentence for the model: who the hero was before the story. */
  story: string;
  stats: Partial<Record<Stat, number>>;
  items?: { name: string; kind: ItemKind; amount: number }[];
  stones?: number;
}

export const STATS = ["body", "mind", "spirit", "fate"] as const;
export type Stat = (typeof STATS)[number];

export const ITEM_KINDS = ["pill", "treasure", "manual", "material", "weapon", "token", "other"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ELEMENTS = ["fire", "water", "wood", "metal", "earth", "lightning", "wind", "ice", "shadow", "light", "sword", "none"] as const;
export type Element = (typeof ELEMENTS)[number];

export interface Pack {
  id: string;
  name: string;
  /** What the model is told the world is, in a few lines. */
  premise: string;
  /** What a stat is called and what it is for, in English. */
  stats: Record<Stat, { label: string; hint: string }>;
  /** Hit points, the energy techniques cost, the currency, and the progress toward the next stage, as this world calls them. */
  words: { hp: string; qi: string; money: string; progress: string; karma: string; breakthrough: string };
  realms: Stage[];
  places: Place[];
  origins: Origin[];
  /** The technique every hero knows from the start. */
  basicTechnique: { name: string; element: Element; power: number };
}
