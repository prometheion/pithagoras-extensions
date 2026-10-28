/**
 * @pithagoras/office settings: dataDir()/settings.json, merged over defaults field by field.
 *
 * Pure over a root directory -- no portal calls happen here except through the `root` default
 * (dataDir()), and no logging: a missing or corrupt file yields the defaults SILENTLY. The server
 * logs at its call site if it cares; keeping this module side-effect free also lets unit tests pass
 * plain tmp dirs without reaching portal().
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./host";

export type OfficeSettings = {
  enabled: boolean;
  imageTag: string;
  /** Comments and the editor's chat with agents (docchat.ts): comment chats of one agent or project that run at once. */
  docchatRuns: number;
  /** Comment threads with agents in one document. */
  docchatThreads: number;
  /** The longest answer posted in a comment thread, in characters. */
  docchatReplyChars: number;
  /** The most messages (of 2,048 characters each) an answer in the editor's chat is posted as. */
  docchatChatMessages: number;
  /** Seconds a deleted comment's chat waits before it goes (an undo in that time keeps it). */
  docchatRemoveAfterS: number;
  /** Seconds after the last person left an editing session before its chat goes. */
  docchatChatEndS: number;
  /** Reports the people's editors of one editing session may send in 10 seconds (POST /docchat/*). */
  docchatReportsPer10S: number;
  /** The longest comment, reply or chat message taken from a report, in characters (the rest is cut). */
  docchatMessageChars: number;
  /** Seconds between saves of a document after answers were posted in it. */
  docchatSaveEveryS: number;
  /** Messages kept for one chat while it answers (the oldest go beyond it). */
  docchatQueued: number;
};

/** What each limit may be set to: whole numbers in these bounds (POST /settings refuses others). */
export type LimitKey = "docchatRuns" | "docchatThreads" | "docchatReplyChars" | "docchatChatMessages" | "docchatRemoveAfterS" | "docchatChatEndS" | "docchatReportsPer10S" | "docchatMessageChars" | "docchatSaveEveryS" | "docchatQueued";
export const LIMIT_BOUNDS: Record<LimitKey, [number, number]> = {
  docchatRuns: [1, 20],
  docchatThreads: [1, 1000],
  // An answer cut at the limit ends in " (…)", and a reply read back is cut at 20,000 characters (seat-page.ts): the
  // longest must still read back whole.
  docchatReplyChars: [200, 19_990],
  docchatChatMessages: [1, 20],
  docchatRemoveAfterS: [0, 86_400],
  docchatChatEndS: [0, 86_400],
  docchatReportsPer10S: [10, 1000],
  // The page cuts what it reports at 20,000 characters.
  docchatMessageChars: [200, 20_000],
  docchatSaveEveryS: [1, 600],
  docchatQueued: [1, 200],
};

/** The image by the full tag of the build it was tested with (DocService 10.0.0 build 169): `10.0` and `10.0.0` move
 * to each new 10.0.x build under every install, which is what `:latest` is refused for. Docker for extensions takes a
 * reference by its tag (it splits at the last colon), so not by its digest. */
export const DEFAULT_SETTINGS: OfficeSettings = {
  enabled: false,
  imageTag: "onlyoffice/documentserver:10.0.0.1",
  docchatRuns: 2,
  docchatThreads: 50,
  docchatReplyChars: 4000,
  docchatChatMessages: 4,
  docchatRemoveAfterS: 120,
  docchatChatEndS: 60,
  docchatReportsPer10S: 50,
  docchatMessageChars: 20_000,
  docchatSaveEveryS: 3,
  docchatQueued: 20,
};

const FILE = "settings.json";

/** Image tags that were the default once, which a version before stored for everyone who switched Office on (it
 * wrote down every field): read as not set, so the default of this version applies. */
const PAST_DEFAULT_TAGS = new Set(["onlyoffice/documentserver:10.0"]);

/** A field as the file holds it, where it is one of the right type that was set; undefined otherwise. */
function setField(raw: Record<string, unknown>, key: keyof OfficeSettings): unknown {
  const value = raw[key];
  if (value === undefined || typeof value !== typeof DEFAULT_SETTINGS[key]) return undefined;
  if (key === "imageTag" && PAST_DEFAULT_TAGS.has(value as string)) return undefined;
  // A limit out of its bounds (a file edited by hand) is not set: its default applies.
  if (key in LIMIT_BOUNDS && !limitOk(key as keyof typeof LIMIT_BOUNDS, value)) return undefined;
  return value;
}

/** Whether `value` is a whole number in the bounds of the limit `key`. */
export function limitOk(key: keyof typeof LIMIT_BOUNDS, value: unknown): boolean {
  const [min, max] = LIMIT_BOUNDS[key];
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function field<K extends keyof OfficeSettings>(raw: Record<string, unknown>, key: K): OfficeSettings[K] {
  return (setField(raw, key) as OfficeSettings[K] | undefined) ?? DEFAULT_SETTINGS[key];
}

/** Read root/settings.json and merge it over DEFAULTS field by field; unknown fields are ignored -- LEGACY files
 * written before the co-editing switch existed still carry a "coEdit" key, which is loaded without crashing and
 * simply never surfaced. Missing file, unreadable file, or anything that is not a JSON object -> DEFAULT_SETTINGS
 * (returned silently -- no logging in this module). */
export function loadSettings(root = dataDir()): OfficeSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(root, FILE), "utf8"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  const obj = raw as Record<string, unknown>;
  return Object.fromEntries((Object.keys(DEFAULT_SETTINGS) as (keyof OfficeSettings)[]).map((key) => [key, field(obj, key)])) as OfficeSettings;
}

/** Apply a patch of any subset of fields (ignoring absent/undefined and unknown ones) over what the file holds, persist
 * that atomically (tmp file in the same directory + rename) and return the settings as they load now. Only fields the
 * person set are stored: a default (the image tag) they never chose is not written down, so a later version's
 * default reaches them. */
export function saveSettings(patch: Partial<OfficeSettings>, root = dataDir()): OfficeSettings {
  const stored: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, FILE), "utf8"));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof OfficeSettings)[]) {
        const value = setField(raw, key);
        if (value !== undefined) stored[key] = value;
      }
    }
  } catch {
    // missing or unreadable: nothing set yet
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !(key in DEFAULT_SETTINGS)) continue; // unknown keys are ignored
    stored[key] = value;
  }
  writeAtomic(path.join(root, FILE), Buffer.from(JSON.stringify(stored, null, 2) + "\n", "utf8"));
  return loadSettings(root);
}

function writeAtomic(dest: string, bytes: Buffer): void {
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
}
