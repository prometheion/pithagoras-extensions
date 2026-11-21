import type { Color, Element, Fx, ItemKind, Look, Mood, Stat, Time, Weather } from "./pack";

/** What both halves know of a game: the hero, the story so far, and what waits for the player now. */

export interface Item {
  name: string;
  kind: ItemKind;
  amount: number;
}

export interface Technique {
  name: string;
  element: Element;
  /** 1..5: how hard it hits, and what it costs. */
  power: number;
}

export interface Bond {
  name: string;
  /** -100 (sworn enemy) .. 100 (would die for the hero). */
  affinity: number;
}

export interface Hero {
  name: string;
  gender: "male" | "female" | "other";
  origin: string;
  look: Look;
  color: Color;
  stats: Record<Stat, number>;
  hp: number;
  hpMax: number;
  qi: number;
  qiMax: number;
  /** Index into the pack's realms, and the minor stage in it from 0. */
  realm: number;
  step: number;
  /** 0..100 toward the next stage. */
  progress: number;
  stones: number;
  karma: number;
  items: Item[];
  techniques: Technique[];
  bonds: Bond[];
}

export const DIFFICULTIES = ["trivial", "easy", "normal", "hard", "heroic", "impossible"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface Check {
  stat: Stat;
  difficulty: Difficulty;
  /** The chance of success in percent, as the server worked it out when the scene was made. */
  chance: number;
}

export interface Choice {
  text: string;
  check?: Check;
}

export interface CastMember {
  name: string;
  look: Look;
  color: Color;
  side: "left" | "right" | "center";
  /** A picture in the chat's folder for the figure, in place of its silhouette. */
  picture?: string;
}

export type Beat =
  | { kind: "narrate"; text: string }
  | { kind: "say"; who: string; text: string; mood: Mood }
  | { kind: "think"; text: string }
  | { kind: "fx"; fx: Fx; color?: Color; on?: string };

/** One change to the hero, as it was applied: what the panel shows as a line ("+2 Spirit stones"). */
export interface Applied {
  what: "hp" | "qi" | "progress" | "stones" | "karma" | Stat | "item" | "technique" | "bond" | "realm";
  /** The name of the item, technique or bond. */
  name?: string;
  amount: number;
}

export interface Scene {
  title?: string;
  location: string;
  time: Time;
  weather: Weather;
  /** A picture in the chat's folder that the stage shows in place of the place it draws. */
  picture?: string;
  cast: CastMember[];
  beats: Beat[];
  choices: Choice[];
  /** Whether the player may write an action of their own. */
  free: boolean;
  changes: Applied[];
}

export type PuzzleKind = "formation" | "runes" | "breakthrough" | "riddle";

/** A puzzle as the panel is given it: everything but what solves it. */
export interface PuzzleView {
  kind: PuzzleKind;
  title: string;
  intro?: string;
  difficulty: number;
  /** formation: the grid's size and its lit cells (true is lit). */
  size?: number;
  grid?: boolean[];
  /** runes: the sequence shown once, to repeat; the panel shows it, so it is no secret. */
  sequence?: number[];
  runes?: number;
  /** breakthrough: how many strikes of how many tries, and the width of the window, 0..1. */
  needed?: number;
  tries?: number;
  window?: number;
  /** riddle: the question, and the answers to choose from where there are any. */
  question?: string;
  options?: string[];
  attempts?: number;
}

export interface Fighter {
  id: string;
  name: string;
  look: Look;
  color: Color;
  hp: number;
  hpMax: number;
  power: number;
  defense: number;
  rank: Rank;
  /** What its blows look like on the stage. */
  element: Element;
  /** What the panel draws for it now. */
  state: "ready" | "down";
}

export const RANKS = ["weak", "equal", "strong", "boss"] as const;
export type Rank = (typeof RANKS)[number];

export type CombatAction =
  | { action: "strike"; target: string }
  | { action: "technique"; target: string; technique: string }
  | { action: "guard" }
  | { action: "item"; item: string }
  | { action: "flee" };

/** One thing that happened in a round, by the fighters' ids ("hero" for the hero): the panel says it and plays it. */
export interface CombatEvent {
  actor: string;
  act: "strike" | "technique" | "guard" | "item" | "flee" | "attack" | "down";
  target?: string;
  /** Damage dealt, or what was healed for an item. */
  amount?: number;
  crit?: boolean;
  miss?: boolean;
  /** The technique or the item. */
  name?: string;
  element?: Element;
  /** For flee: whether it worked. */
  success?: boolean;
}

export interface CombatTurn {
  round: number;
  events: CombatEvent[];
}

export interface Combat {
  title: string;
  location: string;
  time: Time;
  weather: Weather;
  enemies: Fighter[];
  round: number;
  log: CombatTurn[];
  over?: "victory" | "defeat" | "fled";
  /** Whether the hero may try to flee. */
  canFlee: boolean;
}

export type Pending =
  | { id: string; kind: "scene"; scene: Scene; at: number }
  | { id: string; kind: "puzzle"; puzzle: PuzzleView; at: number }
  | { id: string; kind: "combat"; combat: Combat; at: number };

export type Answer = { kind: "choice"; index: number } | { kind: "free"; text: string } | { kind: "continue" };

export interface Roll {
  stat: Stat;
  difficulty: Difficulty;
  chance: number;
  roll: number;
  success: boolean;
  critical: boolean;
}

/** What became of the last thing the player did: the panel shows it until the next scene comes. */
export interface Outcome {
  id: string;
  kind: "scene" | "puzzle" | "combat";
  /** What the player chose, as text. */
  said: string;
  roll?: Roll;
  solved?: boolean;
  combat?: Combat["over"];
  changes: Applied[];
}

export interface Game {
  pack: string;
  /** The language the story is told in: the page's, when the player made the hero. */
  language: string;
  hero: Hero;
  /** What the story must not forget, a line each, newest last. */
  chronicle: string[];
  pending?: Pending;
  outcome?: Outcome;
  /** The scene shown last, kept on stage behind a puzzle or a fight and while the next one is written. */
  last?: Scene;
  scenes: number;
  next: number;
  startedAt: number;
}

/** What a page is told of a chat: whether it plays a saga at all, and the game when there is one. */
export interface Snapshot {
  type: "snapshot";
  saga: boolean;
  game: Game | null;
}
