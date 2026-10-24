import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEBOUNCE_DEFAULT_MS, DEBOUNCE_MAX_MS, DEBOUNCE_MIN_MS, HEIGHT_DEFAULT, HEIGHT_MAX, HEIGHT_MIN, clamp } from "../limits";

/**
 * What the person sets on the extension's page in Settings, kept in `settings.json` in its own folder: the debounce
 * of an event whose card says none, how tall a card is drawn before it scrolls inside, and whether an event may start
 * a turn of the agent's at all (`wake`).
 */
export interface Settings {
  defaultDebounceMs: number;
  maxHeight: number;
  allowWake: boolean;
}

export const DEFAULTS: Settings = { defaultDebounceMs: DEBOUNCE_DEFAULT_MS, maxHeight: HEIGHT_DEFAULT, allowWake: true };

/** Settings as kept or as a page sent them, each held to what it may be, or the default where it is not one. */
export function readSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const number = (value: unknown, min: number, max: number, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? clamp(Math.round(value), min, max) : fallback);
  return {
    defaultDebounceMs: number(r.defaultDebounceMs, DEBOUNCE_MIN_MS, DEBOUNCE_MAX_MS, DEFAULTS.defaultDebounceMs),
    maxHeight: number(r.maxHeight, HEIGHT_MIN, HEIGHT_MAX, DEFAULTS.maxHeight),
    allowWake: typeof r.allowWake === "boolean" ? r.allowWake : DEFAULTS.allowWake,
  };
}

/** What a page asks to change, or why it cannot be: a number outside its range is refused, not quietly moved into it. */
export function checkPatch(raw: unknown): { patch: Partial<Settings> } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Settings are an object" };
  const r = raw as Record<string, unknown>;
  const patch: Partial<Settings> = {};
  const inRange = (key: "defaultDebounceMs" | "maxHeight", min: number, max: number) => {
    const value = r[key];
    if (value === undefined) return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return `${key} is a whole number from ${min} to ${max}`;
    patch[key] = value;
    return null;
  };
  const wrong = inRange("defaultDebounceMs", DEBOUNCE_MIN_MS, DEBOUNCE_MAX_MS) ?? inRange("maxHeight", HEIGHT_MIN, HEIGHT_MAX);
  if (wrong) return { error: wrong };
  if (r.allowWake !== undefined) {
    if (typeof r.allowWake !== "boolean") return { error: "allowWake is true or false" };
    patch.allowWake = r.allowWake;
  }
  return { patch };
}

export function openSettings(dir: string) {
  const file = path.join(dir, "settings.json");
  let kept: Settings;
  try {
    kept = readSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    kept = { ...DEFAULTS };
  }
  return {
    get: (): Settings => kept,
    put(patch: Partial<Settings>): Settings {
      kept = readSettings({ ...kept, ...patch });
      writeFileSync(`${file}.tmp`, JSON.stringify(kept, null, 2), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      return kept;
    },
  };
}
