import type { Color, Element, Look, Pack, Time, Weather } from "./pack";
import { clamp, level, type Rng } from "./rules";
import type { Combat, CombatAction, CombatEvent, Fighter, Hero, Rank } from "./types";

/**
 * Fights, round by round, on the server: the player picks an action in the panel, the server rolls the hero's blow and
 * every foe's answer, and the panel plays what happened. The model only says who the foes are and how strong (`rank`,
 * against the hero); it never does the arithmetic, and it is told how the fight ended.
 */

const RANK_OFFSET: Record<Rank, number> = { weak: -3, equal: 0, strong: 2, boss: 4 };

export const MAX_ENEMIES = 4;
export const MAX_ROUNDS = 30;

export function makeFighter(id: string, given: { name: string; look: Look; color: Color; rank: Rank; element: Element }, hero: Hero, pack: Pack): Fighter {
  const lv = Math.max(0, level(hero, pack) + RANK_OFFSET[given.rank]);
  const hpMax = Math.round((18 + lv * 11) * (given.rank === "boss" ? 2.2 : 1));
  return {
    id,
    name: given.name,
    look: given.look,
    color: given.color,
    hp: hpMax,
    hpMax,
    power: 5 + lv * 2 + (given.rank === "boss" ? 3 : 0),
    defense: 1 + Math.floor(lv * 0.8),
    rank: given.rank,
    element: given.element,
    state: "ready",
  };
}

export function startCombat(
  title: string,
  where: { location: string; time: Time; weather: Weather },
  enemies: Fighter[],
  canFlee: boolean,
): Combat {
  return { title, ...where, enemies, round: 0, log: [], canFlee };
}

const heroDefense = (hero: Hero, pack: Pack) => Math.floor(hero.stats.body / 2) + level(hero, pack);
const heroStrike = (hero: Hero, pack: Pack) => 4 + hero.stats.body * 1.5 + level(hero, pack) * 2;
const heroTechnique = (hero: Hero, pack: Pack, power: number) => (4 + hero.stats.spirit * 1.6 + level(hero, pack) * 2.2) * (1 + 0.45 * power);
export const techniqueCost = (power: number) => 3 + power * 4;
const vary = (rng: Rng) => 0.85 + rng() * 0.3;

/** What a healing pill gives: a share of vitality and qi. */
export const PILL_HEAL = 0.4;

/** Whether an action can be taken now, and why not, in words for the panel and the route. */
export function refuse(combat: Combat, hero: Hero, action: CombatAction): string | undefined {
  if (combat.over) return "The fight is over.";
  const living = combat.enemies.filter((e) => e.state !== "down");
  if (action.action === "strike" || action.action === "technique") {
    if (!living.some((e) => e.id === action.target)) return "No such foe standing.";
  }
  if (action.action === "technique") {
    const t = hero.techniques.find((x) => x.name === action.technique);
    if (!t) return "The hero does not know that technique.";
    if (hero.qi < techniqueCost(t.power)) return "Not enough qi.";
  }
  if (action.action === "item") {
    const item = hero.items.find((i) => i.name === action.item);
    if (!item || item.kind !== "pill" || item.amount < 1) return "No such pill.";
  }
  if (action.action === "flee" && !combat.canFlee) return "There is no fleeing from this fight.";
  return undefined;
}

/** One round: the hero's action, then every foe still standing. Changes `combat` and `hero`, and returns what happened. */
export function playRound(combat: Combat, hero: Hero, pack: Pack, action: CombatAction, rng: Rng): CombatEvent[] {
  const events: CombatEvent[] = [];
  combat.round += 1;
  let guarding = false;
  const crit = () => rng() * 100 < 5 + hero.stats.fate * 1.5;
  const hit = (target: Fighter, raw: number, ev: CombatEvent) => {
    if (rng() < 0.08) {
      events.push({ ...ev, miss: true });
      return;
    }
    const c = crit();
    const amount = Math.max(1, Math.round(raw * vary(rng) * (c ? 1.6 : 1) - target.defense));
    target.hp = Math.max(0, target.hp - amount);
    events.push({ ...ev, amount, ...(c ? { crit: true } : {}) });
    if (target.hp === 0) {
      target.state = "down";
      events.push({ actor: target.id, act: "down" });
    }
  };

  switch (action.action) {
    case "strike": {
      const target = combat.enemies.find((e) => e.id === action.target)!;
      hit(target, heroStrike(hero, pack), { actor: "hero", act: "strike", target: target.id });
      break;
    }
    case "technique": {
      const t = hero.techniques.find((x) => x.name === action.technique)!;
      hero.qi -= techniqueCost(t.power);
      const target = combat.enemies.find((e) => e.id === action.target)!;
      hit(target, heroTechnique(hero, pack, t.power), { actor: "hero", act: "technique", target: target.id, name: t.name, element: t.element });
      break;
    }
    case "guard": {
      guarding = true;
      const gained = Math.min(hero.qiMax - hero.qi, Math.round(hero.qiMax * 0.15));
      hero.qi += gained;
      events.push({ actor: "hero", act: "guard", amount: gained });
      break;
    }
    case "item": {
      const item = hero.items.find((i) => i.name === action.item)!;
      item.amount -= 1;
      if (item.amount <= 0) hero.items.splice(hero.items.indexOf(item), 1);
      const healed = Math.min(hero.hpMax - hero.hp, Math.round(hero.hpMax * PILL_HEAL));
      hero.hp += healed;
      hero.qi = Math.min(hero.qiMax, hero.qi + Math.round(hero.qiMax * 0.2));
      events.push({ actor: "hero", act: "item", name: item.name, amount: healed });
      break;
    }
    case "flee": {
      const boss = combat.enemies.some((e) => e.rank === "boss" && e.state !== "down");
      const chance = clamp(30 + hero.stats.fate * 6 - (boss ? 25 : 0), 5, 90);
      const success = rng() * 100 < chance;
      events.push({ actor: "hero", act: "flee", success });
      if (success) {
        combat.over = "fled";
        combat.log.push({ round: combat.round, events });
        return events;
      }
      break;
    }
  }

  if (combat.enemies.every((e) => e.state === "down")) {
    combat.over = "victory";
    combat.log.push({ round: combat.round, events });
    return events;
  }

  const dodge = 0.05 + hero.stats.fate * 0.012;
  for (const enemy of combat.enemies) {
    if (enemy.state === "down") continue;
    if (rng() < dodge) {
      events.push({ actor: enemy.id, act: "attack", target: "hero", miss: true, element: enemy.element });
      continue;
    }
    const raw = enemy.power * vary(rng) - heroDefense(hero, pack) * 0.6;
    const amount = Math.max(1, Math.round(raw * (guarding ? 0.4 : 1)));
    hero.hp = Math.max(0, hero.hp - amount);
    events.push({ actor: enemy.id, act: "attack", target: "hero", amount, element: enemy.element });
    if (hero.hp === 0) break;
  }

  if (hero.hp === 0) {
    // The hero falls, but the story decides what that means: they live, barely.
    hero.hp = 1;
    combat.over = "defeat";
    events.push({ actor: "hero", act: "down" });
  } else if (combat.round >= MAX_ROUNDS) {
    combat.over = "fled";
  }
  combat.log.push({ round: combat.round, events });
  // Only the last rounds go to the pages: what they show.
  if (combat.log.length > 12) combat.log.splice(0, combat.log.length - 12);
  return events;
}

/** How the fight went, for the model. */
export function combatSummary(combat: Combat, hero: Hero): string {
  const down = combat.enemies.filter((e) => e.state === "down").map((e) => e.name);
  const standing = combat.enemies.filter((e) => e.state !== "down").map((e) => `${e.name} (${e.hp}/${e.hpMax})`);
  const how = combat.over === "victory" ? "The hero won." : combat.over === "defeat" ? "The hero was defeated and lies at 1 vitality, at the foes' mercy." : "The hero fled, or the fight broke off.";
  return [
    `${how} Rounds: ${combat.round}.`,
    down.length ? `Defeated: ${down.join(", ")}.` : "",
    standing.length ? `Still standing: ${standing.join(", ")}.` : "",
    `Hero now: vitality ${hero.hp}/${hero.hpMax}, qi ${hero.qi}/${hero.qiMax}.`,
  ]
    .filter(Boolean)
    .join(" ");
}
