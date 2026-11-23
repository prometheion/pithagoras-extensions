import { makeFighter, playRound, refuse, combatSummary, startCombat, MAX_ENEMIES } from "../game/combat";
import { ELEMENTS, type Element, type Pack, type Stat } from "../game/pack";
import { makePuzzle, solves, PUZZLE_KINDS, type PuzzleAnswer, type PuzzleSecret } from "../game/puzzles";
import {
  LIMITS,
  Refusal,
  readBeats,
  readCast,
  readChanges,
  readChoices,
  readColor,
  readDifficulty,
  readList,
  readLook,
  readName,
  readObject,
  readPicture,
  readPlace,
  readStat,
  readText,
  readTime,
  readWeather,
} from "../game/read";
import { advance, apply, atPeak, check, newHero, roll, type Rng } from "../game/rules";
import { RANKS, type Answer, type Applied, type Combat, type CombatAction, type Game, type Hero, type Outcome, type Pending, type PuzzleKind, type Rank, type Roll, type Scene } from "../game/types";
import { packOf, DEFAULT_PACK } from "../game/xianxia";
import { heroLine } from "./prompt";
import type { GameStore } from "./store";
import type { Waited, Waits } from "./waits";

/**
 * The game, as the tools and the routes play it. A tool sets what waits for the player (`pending`), tells the pages,
 * and waits; a route takes the player's answer, rolls what is to be rolled, applies what it does to the hero, and hands
 * it to the waiting call, which returns it to the model as a few plain sentences. Everything a page is shown is the
 * game itself (`snapshot`), so a page that opens late or reloads shows the same.
 */

export interface SagaDeps {
  store: GameStore;
  waits: Waits;
  /** To the pages open on the chat. */
  push(chatId: string, data: unknown): void;
  /** An answer that no call waited for, to the agent as a message (server.ts). */
  late(chatId: string, text: string): void;
  rng: Rng;
  now(): number;
  /** How long a call waits for the player. */
  waitMs: number;
}

/** A tool's answer, as pi takes it. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  details?: unknown;
}

const result = (text: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text }], ...(details !== undefined ? { details } : {}) });

const CHRONICLE_MAX = 40;

const notesText = (notes: string[]) => (notes.length ? `\n\nNotes on your call (fix them next time): ${notes.join(" ")}` : "");

function rollText(pack: Pack, r: Roll): string {
  const what = `${pack.stats[r.stat].label} check (${r.difficulty}, ${r.chance}%): rolled ${r.roll}`;
  return `${what}, ${r.critical ? (r.success ? "CRITICAL SUCCESS" : "CRITICAL FAILURE") : r.success ? "SUCCESS" : "FAILURE"}.`;
}

export function changesText(pack: Pack, applied: Applied[]): string {
  if (!applied.length) return "";
  const word = (a: Applied) => {
    switch (a.what) {
      case "hp":
        return pack.words.hp;
      case "qi":
        return pack.words.qi;
      case "progress":
        return pack.words.progress;
      case "stones":
        return pack.words.money;
      case "karma":
        return pack.words.karma;
      case "item":
      case "technique":
      case "bond":
        return `${a.what} ${a.name}`;
      case "realm":
        return `realm: now ${a.name}`;
      default:
        return pack.stats[a.what as Stat]?.label ?? a.what;
    }
  };
  return `Applied: ${applied.map((a) => (a.what === "realm" || a.what === "technique" ? word(a) : `${word(a)} ${a.amount >= 0 ? "+" : ""}${a.amount}`)).join(", ")}.`;
}

export class Saga {
  constructor(private readonly deps: SagaDeps) {}

  game(chatId: string): Game | null {
    return this.deps.store.game(chatId);
  }

  pack(game: Game | null): Pack {
    return packOf(game?.pack);
  }

  snapshot(chatId: string) {
    return { type: "snapshot" as const, saga: true, game: this.game(chatId) };
  }

  private tell(chatId: string): void {
    this.deps.push(chatId, this.snapshot(chatId));
  }

  private need(chatId: string): Game {
    const game = this.game(chatId);
    if (!game) throw new Refusal("There is no hero yet. Wait for the player to make one in the panel, or call saga_begin with what they told you.");
    return game;
  }

  // --- making the hero ---

  begin(chatId: string, raw: Record<string, unknown>, language: string): Game {
    const pack = packOf(DEFAULT_PACK);
    const notes: string[] = [];
    const name = readName(raw.name, "name");
    const gender = raw.gender === "female" || raw.gender === "other" ? raw.gender : "male";
    const originRaw = typeof raw.origin === "string" ? raw.origin.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
    const origin = pack.origins.find((o) => o.id === originRaw || o.label.toLowerCase() === String(raw.origin ?? "").toLowerCase())?.id ?? pack.origins[0].id;
    const focus = raw.focus === undefined || raw.focus === null || raw.focus === "" ? undefined : readStat(raw.focus, notes);
    const color = raw.color === undefined ? undefined : readColor(raw.color, notes, "azure");
    const hero = newHero(pack, { name, gender, origin, ...(focus ? { focus } : {}), ...(color ? { color } : {}) });
    const game: Game = { pack: pack.id, language: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language) ? language : "en", hero, chronicle: [], scenes: 0, next: 1, startedAt: this.deps.now() };
    this.deps.waits.end(chatId);
    this.deps.store.change(chatId, (k) => {
      k.game = game;
      delete k.secret;
      delete k.late;
    });
    this.tell(chatId);
    return game;
  }

  beginText(game: Game): string {
    const pack = this.pack(game);
    const origin = pack.origins.find((o) => o.id === game.hero.origin)!;
    return [`The hero is made. ${origin.story}`, heroLine(pack, game.hero), "Now open the story with saga_scene: a strong first scene that shows who the hero is and where they stand, ending in a choice."].join("\n");
  }

  // --- what waits for the player ---

  private setPending(chatId: string, make: (id: string) => Pending, secret?: PuzzleSecret, extra?: (game: Game) => void): Pending {
    let pending!: Pending;
    this.deps.store.change(chatId, (k) => {
      const game = k.game!;
      pending = make(`p${game.next++}`);
      game.pending = pending;
      delete game.outcome;
      if (secret) k.secret = secret;
      else delete k.secret;
      extra?.(game);
    });
    this.tell(chatId);
    return pending;
  }

  private async waitFor<T>(chatId: string, id: string, signal?: AbortSignal): Promise<Waited<T>> {
    return this.deps.waits.wait<T>(chatId, id, this.deps.waitMs, signal);
  }

  private notAnswered(w: Waited<unknown>): ToolResult {
    switch (w.kind) {
      case "timeout":
        return result("The player has not answered yet; it stays open in the panel. Their answer will come to you as a message. End your turn now with one short line, and do not decide for them.", { waited: "timeout" });
      case "stopped":
        return result("The run was stopped before the player answered. It stays open in the panel; their answer will come to you as a message. Do not decide for them.", { waited: "stopped" });
      default:
        return result("This call was replaced or the Saga extension restarted while it waited. What the player answers comes to you as a message.", { waited: "ended" });
    }
  }

  // --- scenes ---

  async scene(chatId: string, raw: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const game = this.need(chatId);
    const pack = this.pack(game);
    const notes: string[] = [];
    const beats = readBeats(raw.beats ?? raw.story ?? raw.script, notes);
    if (!beats.length) throw new Refusal('A scene needs "beats": a list such as [{"narrate": "…"}, {"say": "…", "who": "Name", "mood": "smug"}, {"fx": "lightning"}].');
    const prev = game.last;
    const location = raw.location === undefined && prev ? prev.location : readPlace(pack, raw.location, notes);
    const cast = readCast(raw.cast ?? raw.characters, notes);
    // Who speaks and is not in the cast stands in it, unless it is the hero.
    for (const b of beats) {
      if (b.kind !== "say" || cast.length >= LIMITS.cast) continue;
      if (b.who.toLowerCase() === game.hero.name.toLowerCase() || cast.some((c) => c.name.toLowerCase() === b.who.toLowerCase())) continue;
      cast.push({ name: b.who, look: "disciple", color: "silver", side: cast.length % 2 ? "left" : "right" });
    }
    const choices = readChoices(raw.choices ?? raw.options, game.hero, notes);
    const changes = readChanges(raw.changes, notes);
    const remember = readText(raw.remember, LIMITS.remember);
    const picture = readPicture(raw.picture ?? raw.image, notes);
    const title = readText(raw.title, LIMITS.title);
    let applied: Applied[] = [];
    const pending = this.setPending(
      chatId,
      (id) => {
        const scene: Scene = {
          ...(title ? { title } : {}),
          location,
          time: readTime(raw.time, notes, prev?.time ?? "day"),
          weather: readWeather(raw.weather, notes, raw.location === undefined && prev ? prev.weather : "clear"),
          ...(picture ? { picture } : {}),
          cast,
          beats,
          choices,
          free: raw.free !== false,
          changes: [],
        };
        return { id, kind: "scene", scene, at: this.deps.now() };
      },
      undefined,
      (g) => {
        applied = apply(g.hero, pack, changes);
        if (g.pending?.kind === "scene") {
          g.pending.scene.changes = applied;
          g.last = g.pending.scene;
        }
        g.scenes += 1;
        if (remember) g.chronicle = [...g.chronicle, remember].slice(-CHRONICLE_MAX);
      },
    );
    const w = await this.waitFor<{ said: string; roll?: Roll; answer: Answer }>(chatId, pending.id, signal);
    if (w.kind !== "answer") {
      const not = this.notAnswered(w);
      return { ...not, content: [{ type: "text", text: not.content[0].text + notesText(notes) }] };
    }
    const g = this.game(chatId)!;
    return result(
      [this.answerText(pack, w.value), changesText(pack, applied), heroLine(pack, g.hero), "Continue the story from this with saga_scene (or saga_combat, saga_puzzle)."].filter(Boolean).join("\n") + notesText(notes),
      { scene: pending.id, said: w.value.said, ...(w.value.roll ? { roll: w.value.roll } : {}) },
    );
  }

  private answerText(pack: Pack, v: { said: string; roll?: Roll; answer: Answer }): string {
    if (v.answer.kind === "continue") return "The player has watched the scene.";
    if (v.answer.kind === "free") return `The player acts on their own: "${v.said}". Decide what happens; if it is risky, call saga_roll first.`;
    return `The player chose: "${v.said}".${v.roll ? ` ${rollText(pack, v.roll)}` : ""}`;
  }

  /** The player's answer to the scene that waits. */
  answerScene(chatId: string, id: string, answer: Answer): Outcome {
    const game = this.game(chatId);
    const pending = game?.pending;
    if (!game || !pending || pending.id !== id || pending.kind !== "scene") throw new Refusal("That scene is no longer waiting.");
    const scene = pending.scene;
    let said = "";
    let r: Roll | undefined;
    if (answer.kind === "choice") {
      const choice = scene.choices[answer.index];
      if (!choice) throw new Refusal("No such choice.");
      said = choice.text;
      if (choice.check) r = roll(choice.check, this.deps.rng);
    } else if (answer.kind === "free") {
      if (!scene.free) throw new Refusal("This scene takes no action of your own.");
      said = answer.text.replace(/\s+/g, " ").trim().slice(0, 400);
      if (!said) throw new Refusal("Write what you do.");
    } else if (scene.choices.length) throw new Refusal("Choose one of the choices.");
    const outcome: Outcome = { id, kind: "scene", said, ...(r ? { roll: r } : {}), changes: [] };
    this.finish(chatId, outcome);
    const value = { said, ...(r ? { roll: r } : {}), answer };
    if (!this.deps.waits.answer(chatId, id, value)) this.deps.late(chatId, `${this.answerText(this.pack(game), value)}\n${heroLine(this.pack(game), this.game(chatId)!.hero)}\nContinue the story from this with saga_scene.`);
    return outcome;
  }

  private finish(chatId: string, outcome: Outcome): void {
    this.deps.store.change(chatId, (k) => {
      const g = k.game!;
      delete g.pending;
      delete k.secret;
      g.outcome = outcome;
    });
    this.tell(chatId);
  }

  // --- a roll on its own ---

  rollCheck(chatId: string, raw: Record<string, unknown>): ToolResult {
    const game = this.need(chatId);
    const pack = this.pack(game);
    const notes: string[] = [];
    const c = check(game.hero, readStat(raw.stat, notes), readDifficulty(raw.difficulty, notes));
    const r = roll(c, this.deps.rng);
    const reason = readText(raw.reason, 120);
    this.deps.store.change(chatId, (k) => {
      k.game!.outcome = { id: `r${k.game!.next++}`, kind: "scene", said: reason, roll: r, changes: [] };
    });
    this.tell(chatId);
    return result(`${reason ? `${reason}: ` : ""}${rollText(pack, r)} Show what follows with saga_scene.${notesText(notes)}`, { roll: r });
  }

  // --- puzzles ---

  async puzzle(chatId: string, raw: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const game = this.need(chatId);
    const pack = this.pack(game);
    const notes: string[] = [];
    const kindRaw = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
    const kind = (PUZZLE_KINDS as string[]).includes(kindRaw)
      ? (kindRaw as PuzzleKind)
      : /lock|array|seal|grid|formation/.test(kindRaw)
        ? "formation"
        : /memor|rune|sequence|pattern/.test(kindRaw)
          ? "runes"
          : /break|advance|tribulation|meditat/.test(kindRaw)
            ? "breakthrough"
            : /riddle|question|quiz/.test(kindRaw)
              ? "riddle"
              : undefined;
    if (!kind) throw new Refusal(`"kind" is one of: ${PUZZLE_KINDS.join(", ")}.`);
    if (kind === "breakthrough" && atPeak(game.hero, pack)) throw new Refusal("The hero is at the peak of the path: there is no realm above.");
    const difficultyRaw = Number(raw.difficulty);
    const difficulty = Number.isFinite(difficultyRaw) ? difficultyRaw : kind === "breakthrough" ? Math.min(5, 1 + Math.floor(game.hero.realm / 2)) : 2;
    const title = readText(raw.title, LIMITS.title) || (kind === "breakthrough" ? pack.words.breakthrough : kind[0].toUpperCase() + kind.slice(1));
    const intro = readText(raw.intro ?? raw.text, LIMITS.text);
    let question: string | undefined;
    let answers: string[] | undefined;
    let options: string[] | undefined;
    if (kind === "riddle") {
      question = readText(raw.question, LIMITS.text);
      if (!question) throw new Refusal('A riddle needs its "question", and its "answer".');
      options = readList(raw.options).map((o) => readText(o, 120)).filter(Boolean).slice(0, 4);
      const given = raw.answer ?? raw.answers;
      answers = (typeof given === "number" && options[given] ? [options[given]] : readList(given).map((a) => readText(a, 120))).filter(Boolean);
      if (!answers.length) throw new Refusal('A riddle needs its "answer": the word or words that solve it (for options, the right option\'s text).');
      if (options.length && !options.some((o) => answers!.some((a) => a.toLowerCase() === o.toLowerCase()))) {
        notes.push("riddle: the answer was not one of the options, so it was added as one.");
        options = [...options.slice(0, 3), answers[0]].sort(() => this.deps.rng() - 0.5);
      }
    }
    const made = makePuzzle(kind, difficulty, { title, ...(intro ? { intro } : {}), ...(question ? { question } : {}), ...(answers ? { answers } : {}), ...(options?.length ? { options } : {}) }, this.deps.rng);
    const pending = this.setPending(chatId, (id) => ({ id, kind: "puzzle", puzzle: made.view, at: this.deps.now() }), made.secret);
    const w = await this.waitFor<{ solved: boolean; applied: Applied[]; gaveUp: boolean }>(chatId, pending.id, signal);
    if (w.kind !== "answer") return this.notAnswered(w);
    const g = this.game(chatId)!;
    return result(
      [this.puzzleText(pack, kind, w.value), changesText(pack, w.value.applied), heroLine(pack, g.hero), "Continue the story from this with saga_scene."].filter(Boolean).join("\n") + notesText(notes),
      { puzzle: pending.id, solved: w.value.solved },
    );
  }

  private puzzleText(pack: Pack, kind: PuzzleKind, v: { solved: boolean; gaveUp: boolean }): string {
    if (kind === "breakthrough") return v.solved ? `The ${pack.words.breakthrough.toLowerCase()} SUCCEEDED: the hero has reached a new stage. Show it with fx "breakthrough".` : `The ${pack.words.breakthrough.toLowerCase()} FAILED: qi deviation wounds the hero and costs cultivation progress.`;
    if (v.gaveUp) return "The player GAVE UP on the puzzle.";
    return v.solved ? "The player SOLVED the puzzle." : "The player FAILED the puzzle.";
  }

  answerPuzzle(chatId: string, id: string, answer: PuzzleAnswer): Outcome {
    const kept = this.deps.store.get(chatId);
    const game = kept.game;
    const pending = game?.pending;
    if (!game || !pending || pending.id !== id || pending.kind !== "puzzle") throw new Refusal("That puzzle is no longer waiting.");
    const pack = this.pack(game);
    const solved = solves(pending.puzzle, kept.secret ?? {}, answer);
    let applied: Applied[] = [];
    this.deps.store.change(chatId, (k) => {
      const hero = k.game!.hero;
      if (pending.puzzle.kind === "breakthrough") {
        applied = solved ? advance(hero, pack) : apply(hero, pack, [{ what: "hp", amount: -Math.round(hero.hpMax * 0.25) }, { what: "progress", amount: -30 }]);
      }
    });
    const gaveUp = "giveUp" in answer;
    const outcome: Outcome = { id, kind: "puzzle", said: pending.puzzle.title, solved, changes: applied };
    this.finish(chatId, outcome);
    const value = { solved, applied, gaveUp };
    if (!this.deps.waits.answer(chatId, id, value)) {
      this.deps.late(chatId, [this.puzzleText(pack, pending.puzzle.kind, value), changesText(pack, applied), heroLine(pack, this.game(chatId)!.hero), "Continue the story from this with saga_scene."].filter(Boolean).join("\n"));
    }
    return outcome;
  }

  // --- fights ---

  async combat(chatId: string, raw: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const game = this.need(chatId);
    const pack = this.pack(game);
    const notes: string[] = [];
    const given = readList(raw.enemies ?? raw.foes ?? raw.enemy);
    if (!given.length) throw new Refusal('A fight needs "enemies": [{"name": "Wang Teng", "look": "young_master", "rank": "equal"}].');
    if (given.length > MAX_ENEMIES) notes.push(`enemies: at most ${MAX_ENEMIES}; the rest were left out.`);
    const enemies = given.slice(0, MAX_ENEMIES).map((one, i) => {
      const o = readObject(one) ?? { name: one };
      const name = readName(o.name, "enemy");
      const rankRaw = typeof o.rank === "string" ? o.rank.trim().toLowerCase() : "";
      const rank: Rank = (RANKS as readonly string[]).includes(rankRaw) ? (rankRaw as Rank) : /boss|master|elder|patriarch/.test(rankRaw) ? "boss" : /strong|hard|high|superior/.test(rankRaw) ? "strong" : /weak|easy|low|minion|lesser/.test(rankRaw) ? "weak" : "equal";
      if (rankRaw && rankRaw !== rank) notes.push(`rank: "${o.rank}" read as "${rank}".`);
      const look = readLook(o.look, notes, "warrior");
      const elementRaw = typeof o.element === "string" ? o.element.toLowerCase() : "";
      const element: Element = (ELEMENTS as readonly string[]).includes(elementRaw) ? (elementRaw as Element) : look === "demon" ? "shadow" : "none";
      return makeFighter(`e${i + 1}`, { name, look, color: readColor(o.color, notes, look === "demon" ? "crimson" : "silver"), rank, element }, game.hero, pack);
    });
    const prev = game.last;
    const location = raw.location === undefined && prev ? prev.location : readPlace(pack, raw.location ?? pack.places[0].id, notes);
    const title = readText(raw.title, LIMITS.title) || enemies.map((e) => e.name).join(", ");
    const c = startCombat(title, { location, time: readTime(raw.time, notes, prev?.time ?? "day"), weather: readWeather(raw.weather, notes, prev?.weather ?? "clear") }, enemies, raw.canFlee !== false && raw.flee !== false);
    const pending = this.setPending(chatId, (id) => ({ id, kind: "combat", combat: c, at: this.deps.now() }));
    const w = await this.waitFor<{ combat: Combat }>(chatId, pending.id, signal);
    if (w.kind !== "answer") return this.notAnswered(w);
    const g = this.game(chatId)!;
    return result([combatSummary(w.value.combat, g.hero), heroLine(pack, g.hero), "Continue the story from this with saga_scene: show the end of the fight and its consequences (loot with changes)."].join("\n") + notesText(notes), {
      combat: pending.id,
      over: w.value.combat.over,
    });
  }

  /** One action of the player in the fight that waits: the round is played, and the pages shown it. */
  act(chatId: string, id: string, action: CombatAction): Combat {
    const game = this.game(chatId);
    const pending = game?.pending;
    if (!game || !pending || pending.id !== id || pending.kind !== "combat") throw new Refusal("That fight is no longer going on.");
    const pack = this.pack(game);
    let combat!: Combat;
    let why: string | undefined;
    this.deps.store.change(chatId, (k) => {
      const p = k.game!.pending as Extract<Pending, { kind: "combat" }>;
      why = refuse(p.combat, k.game!.hero, action);
      if (why) return;
      playRound(p.combat, k.game!.hero, pack, action, this.deps.rng);
      combat = p.combat;
    });
    if (why) throw new Refusal(why);
    this.tell(chatId);
    return combat;
  }

  /** The player has seen how the fight ended: it goes to the agent. */
  endCombat(chatId: string, id: string): Outcome {
    const game = this.game(chatId);
    const pending = game?.pending;
    if (!game || !pending || pending.id !== id || pending.kind !== "combat" || !pending.combat.over) throw new Refusal("That fight is not over.");
    const outcome: Outcome = { id, kind: "combat", said: pending.combat.title, combat: pending.combat.over, changes: [] };
    const combat = pending.combat;
    this.finish(chatId, outcome);
    if (!this.deps.waits.answer(chatId, id, { combat })) {
      const pack = this.pack(game);
      this.deps.late(chatId, `${combatSummary(combat, this.game(chatId)!.hero)}\n${heroLine(pack, this.game(chatId)!.hero)}\nContinue the story from this with saga_scene.`);
    }
    return outcome;
  }

  // --- status ---

  status(chatId: string): ToolResult {
    const game = this.game(chatId);
    if (!game) return result("There is no hero yet. The player can make one in the panel, or tell you who they want to be: then call saga_begin.");
    const pack = this.pack(game);
    return result(
      [
        heroLine(pack, game.hero),
        game.chronicle.length ? `Remembered:\n${game.chronicle.map((c) => `- ${c}`).join("\n")}` : "",
        game.pending ? `Waiting for the player: a ${game.pending.kind}.` : "",
        `Scenes so far: ${game.scenes}.`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  /** The hero's changes outside a scene: for saga_change. */
  change(chatId: string, raw: unknown): ToolResult {
    const game = this.need(chatId);
    const pack = this.pack(game);
    const notes: string[] = [];
    const changes = readChanges(raw, notes);
    if (!changes.length) throw new Refusal('Nothing to change. Write "changes": [{"stones": 5}, {"item": "Name", "amount": 1}].' + notesText(notes));
    let applied: Applied[] = [];
    this.deps.store.change(chatId, (k) => {
      applied = apply(k.game!.hero, pack, changes);
    });
    this.tell(chatId);
    return result(`${changesText(pack, applied) || "Nothing changed."}\n${heroLine(pack, this.game(chatId)!.hero)}${notesText(notes)}`, { applied });
  }
}
