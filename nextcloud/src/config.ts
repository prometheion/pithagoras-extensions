/**
 * @pithagoras/nextcloud's settings as they stand to be kept and read: the instances, held in this extension's own
 * data folder (dataDir()/settings.json) -- not beside pi's own files, where an earlier version kept them. What that
 * version wrote into pi's config file (the one saved list under `instances`, or its four flat keys) comes over once,
 * at the first load where no setting of this module stands yet, and leaves pi's file then; every save keeps on
 * dropping whatever is still there of it.
 *
 * Where the data folder stands is as the portal knows it for this extension (dataDir); PITHAGORAS_NEXTCLOUD_DATA_DIR
 * says elsewhere, for a test or an embedder. Reads are merged over the defaults field by field: a file that is
 * missing, unreadable or not one this module wrote yields what stands of itself, silently -- nothing here logs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "./host";
import { CAPABILITIES, capabilitiesFromExcludeText } from "./capabilities";

/** One Nextcloud this portal talks to: its login, how the capability families of its MCP server stand with it --
 * turned off in its entry in pi's config and in its pages where it chose so, everything on otherwise -- and where
 * its /mcp endpoint lives: a container this extension made (`own`), or one already running that it adopted by name
 * (`adopted:<docker container name>`). */
export interface NextcloudInstance {
  /** The instance by its name: the entry in pi's mcp.json under it, and the prefix of that server's tools for the chats. */
  name: string;
  /** The Nextcloud host the MCP server may talk to, as NEXTCLOUD_HOST: e.g. https://cloud.example.org. */
  url: string;
  /** A user of that host, as NEXTCLOUD_USERNAME. */
  username: string;
  /** An app password of that user (Nextcloud Settings > Security > Devices & sessions), as NEXTCLOUD_PASSWORD. Set only, never answered back. */
  password: string;
  /** The capability families turned off for this instance, by family id; a family that stands none is on -- what an
   * endpoint provides at all is found from its tool list, not here (see capabilities). */
  capabilities?: Record<string, boolean>;
  /** Where the /mcp endpoint lives: `own` -- a container this extension made and keeps, or `adopted:<name>` -- one that was already running. */
  container: string;
  /** The loopback port its server listens on in its own container, kept where the keys so that adding, removing or
   * renaming another instance does not shift it (see planOwn). Unset until the first save plans it. */
  port?: number;
}

/** The name the one instance of an earlier version carried in pi's config, so its migration lands where it stood. */
export const DEFAULT_INSTANCE_NAME = "nextcloud";

/** The name rules, shared with the pages (this file's node imports keep them out of it); re-exported from here so
 * the server half reads them as it did before. */
export { isValidInstanceName, INSTANCE_NAME_MAX } from "./instance-name";

/** Whether the container field says the endpoint is in a container that was already running, and if so by what name. */
export const isAdopted = (container: string): boolean => container.startsWith("adopted:");
export const adoptedName = (container: string): string => container.slice("adopted:".length);

const FILE = "settings.json"; // the store file, by that name in this module's data folder

/** What an earlier version kept in pi's config, and what a save drops there: its one list key and its four flat keys. */
const LEGACY_KEYS = ["instances", "url", "username", "password", "mcpExcludeTools"] as const;

/** The folder this module keeps its settings in: the extension's own data folder, where nothing says elsewhere. */
export function settingsRoot(): string {
  return process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR?.trim() || dataDir();
}

/** The agent's directory, as the portal knows it or by its default place -- where pi's config file stands. */
function legacyDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

/** What the file of pi's config holds as a whole, an object: nothing where there is none (or it says something that
 * is not one). */
function legacyRead(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(legacyDir(), FILE), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // no file yet, or none that reads: empty stands
  }
  return {};
}

/** Whether that file still holds one of the keys an earlier version kept: something to carry over and drop. */
function hasLegacyKeys(settings: Record<string, unknown>): boolean {
  return LEGACY_KEYS.some((key) => key in settings);
}

/** The capability map a record holds as one: only the families this module names, and only where the value says a
 * choice; nothing else of it kept -- and nothing at all where it stands none (a missing map is "everything on"). */
function capabilitiesFrom(raw: unknown): Record<string, boolean> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (CAPABILITIES.some((cap) => cap.id === key) && typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One entry of a list as it stands, read over its defaults; nothing where it names no instance. Where an earlier
 * version's keep-out text still stands (a file written before the capabilities stood), it comes over as choices: one
 * family off per glob it named, nothing else -- so what the chats' tool lists kept out stays kept out word for word. */
function instanceFrom(raw: unknown): NextcloudInstance | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const name = text(o.name);
  if (!name) return undefined;
  const container = text(o.container);
  const port = typeof o.port === "number" && Number.isInteger(o.port) && o.port > 0 && o.port <= 65535 ? o.port : undefined;
  const capabilities =
    capabilitiesFrom(o.capabilities) ?? (text(o.mcpExcludeTools) !== "" ? capabilitiesFromExcludeText(name, text(o.mcpExcludeTools)) : undefined);
  return {
    name,
    url: text(o.url),
    username: text(o.username),
    password: text(o.password),
    ...(capabilities !== undefined ? { capabilities } : {}),
    container: container === "own" || (isAdopted(container) && adoptedName(container) !== "") ? container : "own",
    port,
  };
}

/** What this module's own store holds: the list as it stands -- or nothing at all where no store stands yet, so a
 * first load can tell "never saved" from "saved and empty" (an empty list is what a save of an empty one wrote). */
function readStore(): NextcloudInstance[] | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(settingsRoot(), FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const list = (parsed as Record<string, unknown>).instances;
    if (!Array.isArray(list)) return [];
    return list.map(instanceFrom).filter((i): i is NextcloudInstance => i !== undefined);
  } catch {
    return undefined; // no store yet -- or none that reads, which the first load makes one of again
  }
}

/** What an earlier version kept in pi's config says of its instances: the saved list where it has one; else its four
 * flat keys as their one implicit instance under the name that version's entry in pi's config carried -- and nothing
 * where all of them stand empty. */
function instancesFromLegacy(legacy: Record<string, unknown>): NextcloudInstance[] {
  if (Array.isArray(legacy.instances)) {
    return (legacy.instances as unknown[]).map(instanceFrom).filter((i): i is NextcloudInstance => i !== undefined);
  }
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const url = text(legacy.url);
  const username = text(legacy.username);
  const password = text(legacy.password);
  if (!url && !username && !password) return [];
  return [
    {
      name: DEFAULT_INSTANCE_NAME,
      url,
      username,
      password,
      ...(text(legacy.mcpExcludeTools) !== "" ? { capabilities: capabilitiesFromExcludeText(DEFAULT_INSTANCE_NAME, text(legacy.mcpExcludeTools)) } : {}),
      container: "own",
    },
  ];
}

/** The instances as they stand: what this module's own store holds where it does -- and where it does not yet, what
 * an earlier version kept in pi's config file comes over once and leaves there. */
export function loadInstances(): NextcloudInstance[] {
  const stored = readStore();
  if (stored !== undefined) return stored;
  const legacy = legacyRead();
  if (!hasLegacyKeys(legacy)) return [];
  const list = instancesFromLegacy(legacy);
  writeStore(list); // the store stands from now on: pi's file is no longer read of again for this
  dropLegacyKeys(); // and what came over (or had nothing to come over) leaves pi's file then
  return list;
}

/** The instances set to the list, in this module's own store -- and whatever pi's config file still holds of the old
 * keys leaves there. What the list holds after, read back. */
export function saveInstances(list: NextcloudInstance[]): NextcloudInstance[] {
  writeStore(list.map((inst) => ({ ...inst })));
  dropLegacyKeys();
  return loadInstances();
}

/** Whatever of the old keys still stands in pi's config file leaves there: a merged write over it, nothing else of
 * the file touched. */
function dropLegacyKeys(): void {
  const legacy = legacyRead();
  if (!hasLegacyKeys(legacy)) return;
  for (const key of LEGACY_KEYS) delete legacy[key];
  writeAtomic(path.join(legacyDir(), FILE), Buffer.from(JSON.stringify(legacy, null, 2) + "\n", "utf8"));
}

function writeStore(list: NextcloudInstance[]): void {
  writeAtomic(path.join(settingsRoot(), FILE), Buffer.from(JSON.stringify({ instances: list }, null, 2) + "\n", "utf8"));
}

/** Whether the instance names a Nextcloud to talk to: url, username and password all set. */
export function configured(inst: NextcloudInstance): boolean {
  return Boolean(inst.url && inst.username && inst.password);
}

function writeAtomic(dest: string, bytes: Buffer): void {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  // The file holds app passwords: where the temporary name stood before (a crashed run), it is narrowed anyway.
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
}
