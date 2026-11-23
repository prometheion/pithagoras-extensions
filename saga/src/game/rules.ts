import { STATS, type Color, type Element, type ItemKind, type Look, type Pack, type Stat } from "./pack";
import { DIFFICULTIES, type Applied, type Check, type Difficulty, type Hero, type Roll } from "./types";

/**
 * The rules: what a check's chance is, how it is rolled, how a hero grows and what a change does to one. The server
 * applies them, never the model: a model says "a hard Mind check" or "+20 cultivation", and the numbers are these.
 */

/** A number in [0, 1), as Math.random gives one: the server's, or a test's. */
export type Rng = () => number;

export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

export const DIFFICULTY_VALUE: Record<Difficulty, number> = { trivial: 0, easy: 2, normal: 4, hard: 6, heroic: 8, impossible: 11 };

/** The chance of a check in percent, 5..95: a stat equal to the difficulty's value is a coin toss, each point 9 more or less. */
export function chanceOf(hero: Hero, stat: Stat, difficulty: Difficulty): number {
  return clamp(Math.round(50 + (hero.stats[stat] - DIFFICULTY_VALUE[difficulty]) * 9), 5, 95);
}

export function check(hero: Hero, stat: Stat, difficulty: Difficulty): Check {
  return { stat, difficulty, chance: chanceOf(hero, stat, difficulty) };
}

/** 1..100, low is good. A critical success is in the lowest tenth of the chance, a critical failure 96 and up. */
export function roll(c: Check, rng: Rng): Roll {
  const value = Math.floor(rng() * 100) + 1;
  const success = value <= c.chance;
  const critical = success ? value <= Math.max(1, Math.floor(c.chance / 10)) : value >= 96;
  return { stat: c.stat, difficulty: c.difficulty, chance: c.chance, roll: value, success, critical };
}

/** How strong a hero is, as one number for fights: four for each realm, and its minor stages spread over them. */
export function level(hero: Pick<Hero, "realm" | "step">, pack: Pack): number {
  const steps = pack.realms[hero.realm]?.steps ?? 1;
  return hero.realm * 4 + Math.floor((hero.step * 4) / steps);
}

export function maxima(hero: Hero, pack: Pack): { hpMax: number; qiMax: number } {
  const lv = level(hero, pack);
  return { hpMax: 20 + hero.stats.body * 8 + lv * 12, qiMax: 10 + hero.stats.spirit * 6 + lv * 8 };
}

/** The realm and its stage as a person reads it: "Qi Condensation 3", "Core Formation (Early)", "Mortal". */
export function realmLabel(pack: Pack, hero: Pick<Hero, "realm" | "step">, t: (s: string) => string = (s) => s): string {
  const realm = pack.realms[hero.realm];
  if (!realm) return "?";
  if (realm.steps <= 1) return t(realm.name);
  if (realm.stepNames) return `${t(realm.name)} (${t(realm.stepNames[hero.step] ?? "")})`;
  return `${t(realm.name)} ${hero.step + 1}`;
}

export const atPeak = (hero: Hero, pack: Pack): boolean => hero.realm >= pack.realms.length - 1 && hero.step >= (pack.realms.at(-1)?.steps ?? 1) - 1;

/** The next stage, after a breakthrough: maxima raised, healed and filled, progress back to nought. */
export function advance(hero: Hero, pack: Pack): Applied[] {
  if (atPeak(hero, pack)) return [];
  const realm = pack.realms[hero.realm];
  if (hero.step + 1 < realm.steps) hero.step += 1;
  else {
    hero.realm += 1;
    hero.step = 0;
  }
  hero.progress = 0;
  Object.assign(hero, maxima(hero, pack));
  hero.hp = hero.hpMax;
  hero.qi = hero.qiMax;
  return [{ what: "realm", name: realmLabel(pack, hero), amount: 1 }];
}

export function newHero(
  pack: Pack,
  given: { name: string; gender: Hero["gender"]; origin: string; look?: Look; color?: Color; focus?: Stat },
): Hero {
  const origin = pack.origins.find((o) => o.id === given.origin) ?? pack.origins[0];
  const stats = Object.fromEntries(STATS.map((s) => [s, origin.stats[s] ?? 3])) as Record<Stat, number>;
  if (given.focus) stats[given.focus] += 1;
  const hero: Hero = {
    name: given.name,
    gender: given.gender,
    origin: origin.id,
    look: given.look ?? (given.gender === "female" ? "heroine" : "hero"),
    color: given.color ?? "azure",
    stats,
    hp: 0,
    hpMax: 0,
    qi: 0,
    qiMax: 0,
    realm: 0,
    step: 0,
    progress: 0,
    stones: origin.stones ?? 0,
    karma: 0,
    items: (origin.items ?? []).map((i) => ({ ...i })),
    techniques: [{ ...pack.basicTechnique }],
    bonds: [],
  };
  Object.assign(hero, maxima(hero, pack));
  hero.hp = hero.hpMax;
  hero.qi = hero.qiMax;
  return hero;
}

/** A change to the hero, as the model's input was read (scene.ts). */
export type Change =
  | { what: "hp" | "qi" | "progress" | "stones" | "karma"; amount: number }
  | { what: Stat; amount: number }
  | { what: "item"; name: string; amount: number; kind: ItemKind }
  | { what: "technique"; name: string; element: Element; power: number }
  | { what: "bond"; name: string; amount: number };

/** Applies changes to the hero, each held to what it may be, and says what each did. */
export function apply(hero: Hero, pack: Pack, changes: Change[]): Applied[] {
  const applied: Applied[] = [];
  for (const c of changes) {
    switch (c.what) {
      case "hp": {
        const was = hero.hp;
        hero.hp = clamp(hero.hp + c.amount, 1, hero.hpMax);
        if (hero.hp !== was) applied.push({ what: "hp", amount: hero.hp - was });
        break;
      }
      case "qi": {
        const was = hero.qi;
        hero.qi = clamp(hero.qi + c.amount, 0, hero.qiMax);
        if (hero.qi !== was) applied.push({ what: "qi", amount: hero.qi - was });
        break;
      }
      case "progress": {
        const was = hero.progress;
        hero.progress = clamp(hero.progress + c.amount, 0, 100);
        if (hero.progress !== was) applied.push({ what: "progress", amount: hero.progress - was });
        break;
      }
      case "stones": {
        const was = hero.stones;
        hero.stones = Math.max(0, hero.stones + c.amount);
        if (hero.stones !== was) applied.push({ what: "stones", amount: hero.stones - was });
        break;
      }
      case "karma": {
        const was = hero.karma;
        hero.karma = clamp(hero.karma + c.amount, -100, 100);
        if (hero.karma !== was) applied.push({ what: "karma", amount: hero.karma - was });
        break;
      }
      case "item": {
        const at = hero.items.findIndex((i) => i.name.toLowerCase() === c.name.toLowerCase());
        if (c.amount > 0) {
          if (at >= 0) hero.items[at].amount += c.amount;
          else hero.items.push({ name: c.name, kind: c.kind, amount: c.amount });
          applied.push({ what: "item", name: c.name, amount: c.amount });
        } else if (at >= 0) {
          const taken = Math.min(hero.items[at].amount, -c.amount);
          hero.items[at].amount -= taken;
          if (hero.items[at].amount <= 0) hero.items.splice(at, 1);
          if (taken) applied.push({ what: "item", name: c.name, amount: -taken });
        }
        break;
      }
      case "technique": {
        if (hero.techniques.some((t) => t.name.toLowerCase() === c.name.toLowerCase())) break;
        hero.techniques.push({ name: c.name, element: c.element, power: c.power });
        applied.push({ what: "technique", name: c.name, amount: 1 });
        break;
      }
      case "bond": {
        let bond = hero.bonds.find((b) => b.name.toLowerCase() === c.name.toLowerCase());
        if (!bond) {
          bond = { name: c.name, affinity: 0 };
          hero.bonds.push(bond);
        }
        const was = bond.affinity;
        bond.affinity = clamp(bond.affinity + c.amount, -100, 100);
        applied.push({ what: "bond", name: bond.name, amount: bond.affinity - was });
        break;
      }
      default: {
        // A stat: at most two points at once, and never below 1.
        const stat = c.what as Stat;
        const was = hero.stats[stat];
        hero.stats[stat] = clamp(was + clamp(c.amount, -2, 2), 1, 20);
        if (hero.stats[stat] !== was) {
          applied.push({ what: stat, amount: hero.stats[stat] - was });
          const max = maxima(hero, pack);
          hero.hp = Math.min(hero.hp + Math.max(0, max.hpMax - hero.hpMax), max.hpMax);
          hero.qi = Math.min(hero.qi + Math.max(0, max.qiMax - hero.qiMax), max.qiMax);
          Object.assign(hero, max);
        }
      }
    }
  }
  return applied;
}

export const isDifficulty = (v: unknown): v is Difficulty => typeof v === "string" && (DIFFICULTIES as readonly string[]).includes(v);
