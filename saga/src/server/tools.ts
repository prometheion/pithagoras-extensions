import { COLORS, ELEMENTS, FX, ITEM_KINDS, LOOKS, MOODS, STATS, TIMES, WEATHERS } from "../game/pack";
import { PUZZLE_KINDS } from "../game/puzzles";
import { Refusal } from "../game/read";
import { DIFFICULTIES, RANKS } from "../game/types";
import { XIANXIA } from "../game/xianxia";
import type { Saga, ToolResult } from "./saga";

/**
 * The game master's tools, registered only in a chat in Saga mode (server.ts). Their parameters are plain and their
 * words are lists (enums), so that a small model fills in a form rather than inventing a format; what it gets wrong is
 * read leniently (game/read.ts) or refused in words it can correct.
 */

export const TOOL_NAMES = ["saga_begin", "saga_scene", "saga_roll", "saga_puzzle", "saga_combat", "saga_change", "saga_status"] as const;

const str = (description: string) => ({ type: "string", description });
const en = (values: readonly string[], description: string) => ({ type: "string", enum: [...values], description });

const CHANGES = {
  type: "array",
  description:
    'Changes to the hero, applied when the scene starts and shown to the player. Each one of: {"stones": 5}, {"hp": -10}, {"qi": -5}, {"progress": 20} (cultivation, 0..100), {"karma": 5}, {"body": 1} (a stat, at most ±2), {"item": "Name", "amount": 1, "kind": "pill"}, {"technique": "Name", "element": "fire", "power": 2}, {"bond": "Character name", "amount": 10}',
  items: {
    type: "object",
    properties: {
      stones: { type: "number" },
      hp: { type: "number" },
      qi: { type: "number" },
      progress: { type: "number" },
      karma: { type: "number" },
      body: { type: "number" },
      mind: { type: "number" },
      spirit: { type: "number" },
      fate: { type: "number" },
      item: { type: "string" },
      technique: { type: "string" },
      bond: { type: "string" },
      amount: { type: "number" },
      kind: { type: "string", enum: [...ITEM_KINDS] },
      element: { type: "string", enum: [...ELEMENTS] },
      power: { type: "number", description: "1..5" },
    },
  },
};

const BEGIN = {
  type: "object",
  properties: {
    name: str("The hero's name"),
    gender: en(["male", "female", "other"], "The hero's gender"),
    origin: en(
      XIANXIA.origins.map((o) => o.id),
      `Who the hero was: ${XIANXIA.origins.map((o) => `${o.id} = ${o.label}`).join("; ")}`,
    ),
    focus: en(STATS, "The stat the hero is best at: +1"),
    color: en(COLORS, "The colour of the hero's aura"),
    language: str('The language the player writes in, as a code: "de", "en"…'),
  },
  required: ["name"],
};

const SCENE = {
  type: "object",
  properties: {
    title: str("Optional caption shown as the scene opens, like a chapter title"),
    location: en(
      XIANXIA.places.map((p) => p.id),
      "Where the scene is. Leave out to stay where the last scene was",
    ),
    time: en(TIMES, "Time of day. Default day"),
    weather: en(WEATHERS, "Default clear"),
    cast: {
      type: "array",
      description: "The characters on stage besides the hero (at most 4)",
      items: {
        type: "object",
        properties: { name: str("Their name"), look: en(LOOKS, "What they look like"), color: en(COLORS, "Their colour"), side: en(["left", "right", "center"], "Where they stand") },
        required: ["name", "look"],
      },
    },
    beats: {
      type: "array",
      description:
        'The scene, in order, 3 to 8 beats, each ONE of: {"narrate": "text"}, {"say": "text", "who": "Name", "mood": "angry"}, {"think": "the hero\'s thought"}, {"fx": "lightning", "color": "azure"}. The hero speaks with who = the hero\'s name.',
      items: {
        type: "object",
        properties: {
          narrate: str("Narration: one or two sentences"),
          say: str("A line of dialogue"),
          who: str("Who says it"),
          mood: en(MOODS, "How they say it"),
          think: str("The hero's thought"),
          fx: en(FX, "An effect the stage plays"),
          color: en(COLORS, "The effect's colour"),
        },
      },
    },
    choices: {
      type: "array",
      description: "2 to 4 choices for the player at the end. Give a risky one a check. Leave out for a scene that only needs to be watched",
      items: {
        type: "object",
        properties: {
          text: str("What the hero does"),
          check: { type: "object", description: "A dice roll this choice needs", properties: { stat: en(STATS, "The stat it rolls"), difficulty: en(DIFFICULTIES, "How hard") }, required: ["stat", "difficulty"] },
        },
        required: ["text"],
      },
    },
    changes: CHANGES,
    remember: str("One short line the story must not forget (a name, a promise, an enemy, a secret)"),
    picture: str("Optional: a picture in the chat's folder (relative path, .png/.jpg/.webp) shown in place of the drawn place"),
  },
  required: ["beats"],
};

const ROLL = {
  type: "object",
  properties: { stat: en(STATS, "The stat it rolls"), difficulty: en(DIFFICULTIES, "How hard"), reason: str("What is attempted, in a few words, shown to the player") },
  required: ["stat", "difficulty"],
};

const PUZZLE = {
  type: "object",
  properties: {
    kind: en(PUZZLE_KINDS, "formation: light every node of an array (locks, seals, formations). runes: repeat a sequence (memory trials, inscriptions). breakthrough: the hero's breakthrough to the next stage. riddle: your own question"),
    difficulty: { type: "number", description: "1 (easy) to 5 (very hard)" },
    title: str("Shown above the puzzle"),
    intro: str("One or two sentences shown before it"),
    question: str("riddle only: the question"),
    answer: str("riddle only: the answer (with options: the right option's text)"),
    options: { type: "array", items: { type: "string" }, description: "riddle only, optional: 2 to 4 answers to choose from" },
  },
  required: ["kind"],
};

const COMBAT = {
  type: "object",
  properties: {
    title: str("Shown above the fight"),
    enemies: {
      type: "array",
      description: "The foes (1 to 4)",
      items: {
        type: "object",
        properties: {
          name: str("Their name"),
          look: en(LOOKS, "What they look like"),
          rank: en(RANKS, "How strong against the hero: weak, equal, strong, boss"),
          element: en(ELEMENTS, "What their attacks look like"),
          color: en(COLORS, "Their colour"),
        },
        required: ["name", "rank"],
      },
    },
    location: en(
      XIANXIA.places.map((p) => p.id),
      "Where. Leave out to stay where the last scene was",
    ),
    time: en(TIMES, "Time of day"),
    weather: en(WEATHERS, "Weather"),
    canFlee: { type: "boolean", description: "Whether the hero may flee. Default true" },
  },
  required: ["enemies"],
};

const CHANGE = { type: "object", properties: { changes: CHANGES }, required: ["changes"] };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

/** Runs a tool's body, a Refusal becoming what the model reads and corrects rather than a failure it cannot read. */
async function guarded(run: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Refusal) throw new Error(`${e.message} Fix the call and try again.`);
    throw e;
  }
}

export function registerTools(pi: any, chat: { id: string }, saga: Saga): void {
  const chatId = chat.id;
  const tool = (name: string, label: string, description: string, snippet: string, parameters: object, run: (params: any, signal?: AbortSignal) => Promise<ToolResult> | ToolResult) =>
    pi.registerTool({
      name,
      label,
      description,
      promptSnippet: snippet,
      parameters,
      async execute(_id: string, params: any, signal?: AbortSignal) {
        return guarded(() => run(params ?? {}, signal));
      },
    });

  tool(
    "saga_begin",
    "Make the hero",
    "Make the player's hero and start a new story. Only when there is no hero yet, or the player asks to start over; usually the player makes the hero in the panel and you are told.",
    "make the player's hero and start a new story",
    BEGIN,
    (p) => text(saga.beginText(saga.begin(chatId, p, typeof p.language === "string" ? p.language.trim().toLowerCase() : "en"))),
  );
  tool(
    "saga_scene",
    "Play a scene",
    [
      "Play one scene of the story in the panel, like a film: the place, the characters, beats of narration and dialogue, effects, then choices.",
      "The call waits until the player has watched it and chosen, and returns what they chose (and the dice roll, for a choice with a check). Then continue with the next scene.",
    ].join(" "),
    "play a scene of the story in the panel and get the player's choice",
    SCENE,
    (p, signal) => saga.scene(chatId, p, signal),
  );
  tool(
    "saga_roll",
    "Roll a check",
    "Roll a check for something risky the player wrote themself (not for a choice: give choices a check instead). Returns success or failure; the player sees the dice.",
    "roll a dice check for the hero",
    ROLL,
    (p) => saga.rollCheck(chatId, p),
  );
  tool(
    "saga_puzzle",
    "Give a puzzle",
    "Give the player a puzzle in the panel: the panel makes and checks it. Waits until it is solved, failed or given up. A breakthrough advances the hero's realm by itself when it succeeds, and wounds them when it fails.",
    "give the player a puzzle (formation, runes, breakthrough, riddle)",
    PUZZLE,
    (p, signal) => saga.puzzle(chatId, p, signal),
  );
  tool(
    "saga_combat",
    "Start a fight",
    "Start a fight in the panel: the player fights it round by round, and the server rolls every blow. Waits until it is won, lost or fled, and returns how it went.",
    "start a turn-based fight in the panel",
    COMBAT,
    (p, signal) => saga.combat(chatId, p, signal),
  );
  tool(
    "saga_change",
    "Change the hero",
    "Change the hero outside a scene (rewards, costs, learning a technique). In a scene, use its `changes` instead.",
    "change the hero's numbers, items, techniques or bonds",
    CHANGE,
    (p) => saga.change(chatId, p.changes ?? p),
  );
  tool("saga_status", "Look at the hero", "The hero as they are now, and what the story remembers.", "look at the hero and the story so far", { type: "object", properties: {} }, () => saga.status(chatId));
}
