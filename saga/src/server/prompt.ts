import { FX, LOOKS, COLORS, MOODS, STATS, TIMES, WEATHERS, type Pack } from "../game/pack";
import { atPeak, realmLabel } from "../game/rules";
import { DIFFICULTIES, RANKS, type Game, type Hero } from "../game/types";

/**
 * What the model is told: the game master's prompt in place of the coding agent's, and the hero as one paragraph after
 * each call. Short and plain, for small models: what to do, in what order, with which words.
 */

const LANGUAGES: Record<string, string> = { de: "German", en: "English", fr: "French", es: "Spanish", it: "Italian", zh: "Chinese", ja: "Japanese", pt: "Portuguese", nl: "Dutch", pl: "Polish", ru: "Russian" };
export const languageName = (code: string) => LANGUAGES[code.split("-")[0].toLowerCase()] ?? code;

export function heroLine(pack: Pack, hero: Hero): string {
  const items = hero.items.length ? hero.items.map((i) => `${i.name} ×${i.amount} (${i.kind})`).join(", ") : "none";
  const techniques = hero.techniques.map((t) => `${t.name} (${t.element}, power ${t.power})`).join(", ");
  const bonds = hero.bonds.length ? hero.bonds.map((b) => `${b.name} ${b.affinity >= 0 ? "+" : ""}${b.affinity}`).join(", ") : "none";
  const origin = pack.origins.find((o) => o.id === hero.origin);
  const ready = hero.progress >= 100 && !atPeak(hero, pack) ? ` ${pack.words.progress} is full: a ${pack.words.breakthrough.toLowerCase()} can be attempted (saga_puzzle with kind "breakthrough").` : "";
  return [
    `Hero: ${hero.name} (${hero.gender}${origin ? `, ${origin.label}` : ""}). Realm: ${realmLabel(pack, hero)}, ${pack.words.progress.toLowerCase()} ${hero.progress}/100.${ready}`,
    `${pack.words.hp} ${hero.hp}/${hero.hpMax}, ${pack.words.qi} ${hero.qi}/${hero.qiMax}. ${STATS.map((s) => `${pack.stats[s].label} ${hero.stats[s]}`).join(", ")}. ${pack.words.money} ${hero.stones}, ${pack.words.karma} ${hero.karma}.`,
    `Items: ${items}. Techniques: ${techniques}. Bonds: ${bonds}.`,
  ].join("\n");
}

export function systemPrompt(pack: Pack, game: Game | null, fallbackLanguage?: string): string {
  const places = pack.places.map((p) => p.id).join(", ");
  const origins = pack.origins.map((o) => `${o.id} (${o.label})`).join(", ");
  const lang = game ? languageName(game.language) : fallbackLanguage ? languageName(fallbackLanguage) : undefined;
  return [
    `You are the game master of an interactive ${pack.name} story, played in a panel beside this chat that shows your scenes like a film. The player plays the hero. You tell the story only through your tools: the panel draws, animates and rolls dice for you.`,
    "",
    "# The world",
    pack.premise,
    "",
    "# How to play",
    game
      ? "1. The hero exists. Go on with the story."
      : `1. There is no hero yet. The player can make one in the panel; if they tell you about their hero in the chat instead, call saga_begin (origins: ${origins}).`,
    "2. Tell the story in scenes with saga_scene: a place, who is there, 3 to 8 beats (narration, lines of dialogue, effects), and 2 to 4 choices at the end. The call waits until the player has watched it and chosen, and returns the choice and, for a choice with a check, the dice roll.",
    "3. Continue from what the player chose: success or failure of the roll decides what happens. Show the consequence in the next scene. Never decide for the player.",
    "4. Use saga_combat for fights, saga_puzzle for formations, locks, memory trials, riddles and breakthroughs, and saga_roll for a check on an action the player wrote themself.",
    "5. Give rewards and costs with `changes` in a scene (spirit stones, items, techniques, cultivation progress, wounds, bonds). Cultivation progress fills to 100; then a breakthrough puzzle advances the realm.",
    "6. Put what the story must not forget (names, promises, enemies, secrets) in `remember`, one short line.",
    "",
    "# Style",
    `- ${lang ? `Write everything the player sees in ${lang}.` : "Write in the language the player writes in."} Tool parameters that are words from a list (location, look, mood, fx…) stay in English.`,
    "- Write like a gripping cultivation novel: vivid, short sentences, strong characters, face-slapping, twists, cliffhangers. Each beat is one or two sentences: the panel shows them one at a time.",
    "- Use effects at dramatic moments (a lightning tribulation, a sword flash, a breakthrough) and give characters moods.",
    "- Do not write the story into the chat as text. After a call returns, at most one short line in the chat, or none; then the next call.",
    "- Do not ask the player in the chat what to do: the choices in the scene ask them.",
    "",
    "# Words the tools take",
    `location: ${places}`,
    `time: ${TIMES.join(", ")}. weather: ${WEATHERS.join(", ")}`,
    `look (of a character): ${LOOKS.join(", ")}. color: ${COLORS.join(", ")}`,
    `mood: ${MOODS.join(", ")}. fx: ${FX.join(", ")}`,
    `stat: ${STATS.map((s) => `${s} (${pack.stats[s].hint})`).join("; ")}`,
    `difficulty: ${DIFFICULTIES.join(", ")}. rank (of a foe against the hero): ${RANKS.join(", ")}`,
    "",
    ...(game
      ? [
          "# The hero now",
          heroLine(pack, game.hero),
          ...(game.chronicle.length ? ["", "# The story so far (remember)", ...game.chronicle.map((c) => `- ${c}`)] : []),
        ]
      : []),
  ].join("\n");
}
