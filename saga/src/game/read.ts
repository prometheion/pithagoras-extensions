import { COLORS, ELEMENTS, FX, ITEM_KINDS, LOOKS, MOODS, STATS, TIMES, WEATHERS, type Color, type Element, type Fx, type ItemKind, type Look, type Mood, type Pack, type Stat, type Time, type Weather } from "./pack";
import { check, clamp, type Change } from "./rules";
import { DIFFICULTIES, type Beat, type CastMember, type Choice, type Difficulty, type Hero } from "./types";

/**
 * What a model wrote, read leniently: a small model writes "Mountain Peak" for mountain_peak, a string where a list
 * was asked, `{"type": "say", "speaker": …}` for `{"say": …, "who": …}`. What can be understood is taken, and what was
 * taken in place of what it wrote is said back to it (`notes`), so that it learns the words without a failed call. Only
 * what cannot be understood at all is refused, with the words it may use.
 */

export class Refusal extends Error {}

export const LIMITS = { beats: 16, text: 700, choices: 4, cast: 4, changes: 12, title: 80, name: 40, remember: 300 } as const;

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[\s-]+/g, "_");

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Words a model is likely to write for one of ours. */
const ALIASES: Record<string, string> = {
  // looks
  man: "hero", boy: "hero", protagonist: "hero", player: "hero", woman: "heroine", girl: "maiden", lady: "maiden", fairy: "maiden", princess: "maiden",
  master: "elder", grandpa: "elder", grandfather: "elder", old: "elder", patriarch: "elder", grandmaster: "elder", old_man: "elder", sage: "elder", granny: "old_woman", matriarch: "old_woman",
  young_lord: "young_master", noble: "young_master", prince: "young_master", rival: "young_master", student: "disciple", servant: "disciple",
  guard: "warrior", soldier: "warrior", swordsman: "warrior", general: "warrior", priest: "monk", buddhist: "monk", trader: "merchant", shopkeeper: "merchant",
  innkeeper: "merchant", kid: "child", devil: "demon", cultist: "demon", wolf: "beast", tiger: "beast", monster: "beast", dragon: "serpent", snake: "serpent",
  ghost: "spirit", phantom: "spirit", soul: "spirit",
  // weather
  fog: "mist", foggy: "mist", misty: "mist", rainy: "rain", snowy: "snow", stormy: "storm", sunny: "clear", windy: "leaves", autumn: "leaves", none: "clear", thunder: "storm", thunderstorm: "storm", blossoms: "petals", sakura: "petals", sparks: "embers", ash: "embers",
  // time
  morning: "dawn", sunrise: "dawn", noon: "day", afternoon: "day", daytime: "day", evening: "dusk", sunset: "dusk", midnight: "night",
  // fx
  thunderbolt: "lightning", tribulation: "lightning", tribulation_lightning: "lightning", qi: "aura", qi_aura: "aura", glow: "aura", sword: "slash",
  sword_slash: "slash", cut: "slash", hit: "impact", punch: "impact", explosion: "shockwave", blast: "shockwave", flames: "fire", frost: "ice",
  healing: "heal", dark: "darkness", shadow: "darkness", light: "golden_light", holy: "golden_light", tremor: "shake", earthquake: "shake",
  // moods
  neutral: "calm", normal: "calm", joyful: "happy", glad: "happy", furious: "angry", rage: "angry", arrogant: "smug", mocking: "smug", surprised: "shocked",
  cold_voice: "cold", icy: "cold", scared: "afraid", fearful: "afraid", resolute: "determined", quiet: "whisper", yell: "shout",
  // stats
  strength: "body", physique: "body", constitution: "body", intelligence: "mind", wisdom: "mind", comprehension: "mind", will: "spirit", soul_power: "spirit",
  luck: "fate", fortune: "fate", karma_luck: "fate",
  // difficulties
  very_easy: "trivial", simple: "easy", medium: "normal", moderate: "normal", average: "normal", difficult: "hard", very_hard: "heroic", legendary: "heroic", extreme: "impossible",
};

/**
 * One of `list` for what the model wrote: the word, an alias of one, or the nearest. Undefined and the fallback with
 * no note for a value that was left out; a note for one taken in place of another.
 */
function pick<T extends string>(list: readonly T[], raw: unknown, field: string, notes: string[], fallback?: T): T {
  if (raw === undefined || raw === null || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Refusal(`"${field}" is missing. Use one of: ${list.join(", ")}.`);
  }
  if (typeof raw !== "string") {
    if (fallback !== undefined) {
      notes.push(`${field}: ${JSON.stringify(raw)} is not a word, used "${fallback}".`);
      return fallback;
    }
    throw new Refusal(`"${field}" is one of: ${list.join(", ")}.`);
  }
  const n = norm(raw);
  if ((list as readonly string[]).includes(n)) return n as T;
  const alias = ALIASES[n];
  if (alias && (list as readonly string[]).includes(alias)) return alias as T;
  const part = list.find((w) => n.includes(w) || (n.length >= 4 && w.includes(n)));
  const near = part ?? [...list].sort((a, b) => distance(n, a) - distance(n, b))[0];
  if (part || distance(n, near) <= Math.max(2, Math.floor(n.length / 3))) {
    notes.push(`${field}: "${raw}" is not a word the stage knows, used "${near}".`);
    return near;
  }
  if (fallback !== undefined) {
    notes.push(`${field}: "${raw}" is not one of ${list.join(", ")}; used "${fallback}".`);
    return fallback;
  }
  throw new Refusal(`${field}: "${raw}" is not one of: ${list.join(", ")}.`);
}

/** A list the model may have written as one item, as JSON in a string, or as text with a line each. */
function list(raw: unknown): unknown[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      try {
        return list(JSON.parse(t));
      } catch {
        /* text, then */
      }
    }
    return t ? t.split(/\n+/).map((s) => s.trim()).filter(Boolean) : [];
  }
  return [raw];
}

const text = (raw: unknown, max: number): string =>
  typeof raw === "string" || typeof raw === "number" ? String(raw).replace(/\s+/g, " ").trim().slice(0, max) : "";

const obj = (raw: unknown): Record<string, unknown> | undefined => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined);

export function readPlace(pack: Pack, raw: unknown, notes: string[]): string {
  const ids = pack.places.map((p) => p.id);
  // A label ("Sect hall") is a name too.
  if (typeof raw === "string") {
    const byLabel = pack.places.find((p) => norm(p.label) === norm(raw));
    if (byLabel) return byLabel.id;
  }
  return pick(ids, raw, "location", notes);
}

export const readTime = (raw: unknown, notes: string[], fallback: Time = "day"): Time => pick(TIMES, raw, "time", notes, fallback);
export const readWeather = (raw: unknown, notes: string[], fallback: Weather = "clear"): Weather => pick(WEATHERS, raw, "weather", notes, fallback);
export const readLook = (raw: unknown, notes: string[], fallback: Look): Look => pick(LOOKS, raw, "look", notes, fallback);
export const readColor = (raw: unknown, notes: string[], fallback: Color): Color => pick(COLORS, raw, "color", notes, fallback);
export const readStat = (raw: unknown, notes: string[]): Stat => pick(STATS, raw, "stat", notes);
export const readDifficulty = (raw: unknown, notes: string[]): Difficulty => pick(DIFFICULTIES, raw, "difficulty", notes, "normal");

/** A picture in the chat's folder: a relative path, nothing more. */
export function readPicture(raw: unknown, notes: string[]): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const p = typeof raw === "string" ? raw.trim().replace(/^\.\//, "") : "";
  if (!p || p.startsWith("/") || p.split(/[\\/]/).includes("..") || /^[a-z]+:/i.test(p) || !/\.(png|jpe?g|webp|gif)$/i.test(p)) {
    notes.push(`picture: "${String(raw)}" is not a picture in the chat's folder (a relative path to a .png, .jpg or .webp); the stage draws the place instead.`);
    return undefined;
  }
  return p;
}

export function readCast(raw: unknown, notes: string[]): CastMember[] {
  const out: CastMember[] = [];
  const sides: CastMember["side"][] = ["right", "left", "center"];
  for (const one of list(raw).slice(0, LIMITS.cast)) {
    const o = obj(one) ?? { name: one };
    const name = text(o.name ?? o.who, LIMITS.name);
    if (!name) continue;
    const look = readLook(o.look ?? o.type ?? o.role, notes, "disciple");
    const side = o.side === "left" || o.side === "right" || o.side === "center" ? o.side : sides[out.length % sides.length];
    const picture = readPicture(o.picture, notes);
    out.push({ name, look, color: readColor(o.color, notes, look === "demon" ? "crimson" : look === "elder" ? "gold" : "silver"), side, ...(picture ? { picture } : {}) });
  }
  return out;
}

/** One beat: narration, a line said, a thought, or an effect, in any of the shapes a model writes them. */
function readBeat(raw: unknown, notes: string[]): Beat | undefined {
  if (typeof raw === "string") return raw.trim() ? { kind: "narrate", text: text(raw, LIMITS.text) } : undefined;
  const o = obj(raw);
  if (!o) return undefined;
  const type = typeof o.type === "string" ? norm(o.type) : typeof o.kind === "string" ? norm(o.kind) : "";
  const fx = o.fx ?? o.effect ?? (type === "fx" || type === "effect" ? o.name ?? o.value : undefined);
  if (fx !== undefined) {
    const colour = o.color === undefined ? undefined : readColor(o.color, notes, "white");
    const on = text(o.on ?? o.target, LIMITS.name);
    return { kind: "fx", fx: pick<Fx>(FX, fx, "fx", notes, "flash"), ...(colour ? { color: colour } : {}), ...(on ? { on } : {}) };
  }
  const say = o.say ?? o.line ?? o.dialogue ?? (type === "say" || type === "dialogue" || type === "speech" ? o.text : undefined);
  const who = text(o.who ?? o.speaker ?? o.name ?? o.character, LIMITS.name);
  if (say !== undefined && who) return { kind: "say", who, text: text(say, LIMITS.text), mood: pick<Mood>(MOODS, o.mood ?? o.emotion, "mood", notes, "calm") };
  const think = o.think ?? o.thought ?? (type === "think" || type === "thought" ? o.text : undefined);
  if (think !== undefined) return { kind: "think", text: text(think, LIMITS.text) };
  const narrate = o.narrate ?? o.narration ?? o.text ?? o.say;
  if (narrate !== undefined) return { kind: "narrate", text: text(narrate, LIMITS.text) };
  return undefined;
}

export function readBeats(raw: unknown, notes: string[]): Beat[] {
  const all = list(raw);
  if (all.length > LIMITS.beats) notes.push(`beats: ${all.length} were given, the stage plays the first ${LIMITS.beats}. Keep a scene short and play the next one after.`);
  return all
    .slice(0, LIMITS.beats)
    .map((b) => readBeat(b, notes))
    .filter((b): b is Beat => !!b && (b.kind === "fx" || b.text.length > 0));
}

export function readChoices(raw: unknown, hero: Hero, notes: string[]): Choice[] {
  const out: Choice[] = [];
  const all = list(raw);
  if (all.length > LIMITS.choices) notes.push(`choices: at most ${LIMITS.choices}; the rest were left out.`);
  for (const one of all.slice(0, LIMITS.choices)) {
    const o = obj(one) ?? { text: one };
    const said = text(o.text ?? o.label ?? o.option ?? o.choice, 160);
    if (!said) continue;
    const c = obj(o.check) ?? (o.stat !== undefined ? o : undefined);
    if (c && c.stat !== undefined) {
      try {
        out.push({ text: said, check: check(hero, readStat(c.stat, notes), readDifficulty(c.difficulty, notes)) });
        continue;
      } catch (e) {
        notes.push(`choice "${said}": ${(e as Error).message} It has no check.`);
      }
    }
    out.push({ text: said });
  }
  return out;
}

const AMOUNTED: Record<string, Change["what"]> = {
  hp: "hp", health: "hp", vitality: "hp", life: "hp", qi: "qi", energy: "qi", mana: "qi", progress: "progress", cultivation: "progress", exp: "progress",
  xp: "progress", experience: "progress", stones: "stones", spirit_stones: "stones", money: "stones", gold: "stones", coins: "stones", karma: "karma", merit: "karma",
  body: "body", mind: "mind", spirit: "spirit", fate: "fate", strength: "body", luck: "fate", comprehension: "mind", will: "spirit",
};

const number = (raw: unknown): number | undefined => {
  const n = typeof raw === "string" ? Number(raw.replace(/^\+/, "")) : raw;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : undefined;
};

/**
 * Changes to the hero: `{"stones": 5}`, `{"item": "Pill", "amount": 1}`, `{"technique": "Azure Sword", "element": "sword"}`,
 * `{"bond": "Lin Yue", "amount": 10}`, and the shapes `{"type": "item", "name": …}` and `{"stat": "hp", "amount": -5}`.
 */
export function readChanges(raw: unknown, notes: string[]): Change[] {
  const out: Change[] = [];
  const entries = list(raw);
  // One object with several keys: {"hp": -5, "stones": 3}.
  const flat = entries.length === 1 && obj(entries[0]) && !("item" in obj(entries[0])!) && !("type" in obj(entries[0])!) && !("technique" in obj(entries[0])!) && !("bond" in obj(entries[0])!) && !("stat" in obj(entries[0])!) ? Object.entries(obj(entries[0])!).map(([k, v]) => ({ [k]: v })) : entries;
  for (const one of flat.slice(0, LIMITS.changes)) {
    const o = obj(one);
    if (!o) continue;
    const type = typeof o.type === "string" ? norm(o.type) : typeof o.what === "string" ? norm(o.what) : undefined;
    const amount = number(o.amount ?? o.value ?? o.delta);
    if (o.item !== undefined || type === "item") {
      const name = text(type === "item" ? o.name ?? o.item : o.item, LIMITS.name);
      if (name) out.push({ what: "item", name, amount: amount ?? 1, kind: pick<ItemKind>(ITEM_KINDS, o.kind, "item kind", notes, "other") });
      continue;
    }
    if (o.technique !== undefined || type === "technique") {
      const name = text(type === "technique" ? o.name ?? o.technique : o.technique, LIMITS.name);
      if (name) out.push({ what: "technique", name, element: pick<Element>(ELEMENTS, o.element, "element", notes, "none"), power: clamp(number(o.power) ?? 2, 1, 5) });
      continue;
    }
    if (o.bond !== undefined || type === "bond" || type === "relationship") {
      const name = text(type ? o.name ?? o.bond : o.bond, LIMITS.name);
      if (name && amount !== undefined) out.push({ what: "bond", name, amount: clamp(amount, -50, 50) });
      continue;
    }
    const key = typeof o.stat === "string" ? norm(o.stat) : type ?? Object.keys(o).map(norm).find((k) => k in AMOUNTED);
    const what = key ? AMOUNTED[key] : undefined;
    const value = o.stat !== undefined || type ? amount : number(Object.entries(o).find(([k]) => norm(k) === key)?.[1]);
    if (!what || value === undefined) {
      notes.push(`changes: ${JSON.stringify(o).slice(0, 80)} was not understood and left out. Write {"stones": 5}, {"hp": -10}, {"progress": 20}, {"item": "Name", "amount": 1}, {"technique": "Name"} or {"bond": "Name", "amount": 10}.`);
      continue;
    }
    out.push({ what, amount: clamp(value, -1000, 1000) } as Change);
  }
  return out;
}

export function readName(raw: unknown, field: string): string {
  const name = text(raw, LIMITS.name);
  if (!name) throw new Refusal(`Give "${field}" a name.`);
  return name;
}

export const readText = text;
export const readList = list;
export const readObject = obj;
