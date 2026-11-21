import type { Pack, Stat } from "../game/pack";
import { realmLabel } from "../game/rules";
import type { Applied, Hero } from "../game/types";
import { msg, t } from "../portal";

/** How the panel says the game's things, in the page's language: the pack's words go through the extension's texts. */

export const realmOf = (pack: Pack, hero: Pick<Hero, "realm" | "step">) => realmLabel(pack, hero, t);

export const DIFFICULTY_LABEL: Record<string, string> = {
  trivial: msg("trivial"),
  easy: msg("easy"),
  normal: msg("normal"),
  hard: msg("hard"),
  heroic: msg("heroic"),
  impossible: msg("impossible"),
};

export function appliedText(pack: Pack, a: Applied): string {
  const sign = a.amount > 0 ? "+" : "";
  switch (a.what) {
    case "hp":
      return `${sign}${a.amount} ${t(pack.words.hp)}`;
    case "qi":
      return `${sign}${a.amount} ${t(pack.words.qi)}`;
    case "progress":
      return `${sign}${a.amount} ${t(pack.words.progress)}`;
    case "stones":
      return `${sign}${a.amount} ${t(pack.words.money)}`;
    case "karma":
      return `${sign}${a.amount} ${t(pack.words.karma)}`;
    case "item":
      return a.amount > 0 ? t("Obtained: {name} ×{n}", { name: a.name ?? "", n: a.amount }) : t("Lost: {name} ×{n}", { name: a.name ?? "", n: -a.amount });
    case "technique":
      return t("Technique learned: {name}", { name: a.name ?? "" });
    case "bond":
      return t("{name}: affinity {n}", { name: a.name ?? "", n: `${sign}${a.amount}` });
    case "realm":
      return t("Breakthrough! {realm}", { realm: a.name ?? "" });
    default:
      return `${sign}${a.amount} ${t(pack.stats[a.what as Stat].label)}`;
  }
}
