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

export type OfficeSettings = { enabled: boolean; imageTag: string };

/** The image by the full tag of the build it was tested with (DocService 10.0.0 build 169): `10.0` and `10.0.0` move
 * to each new 10.0.x build under every install, which is what `:latest` is refused for. Docker for extensions takes a
 * reference by its tag (it splits at the last colon), so not by its digest. */
export const DEFAULT_SETTINGS: OfficeSettings = { enabled: false, imageTag: "onlyoffice/documentserver:10.0.0.1" };

const FILE = "settings.json";

/** Image tags that were the default once, which a version before stored for everyone who switched Office on (it
 * wrote down every field): read as not set, so the default of this version applies. */
const PAST_DEFAULT_TAGS = new Set(["onlyoffice/documentserver:10.0"]);

/** A field as the file holds it, where it is one of the right type that was set; undefined otherwise. */
function setField(raw: Record<string, unknown>, key: keyof OfficeSettings): unknown {
  const value = raw[key];
  if (value === undefined || typeof value !== typeof DEFAULT_SETTINGS[key]) return undefined;
  if (key === "imageTag" && PAST_DEFAULT_TAGS.has(value as string)) return undefined;
  return value;
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
  return { enabled: field(obj, "enabled"), imageTag: field(obj, "imageTag") };
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
