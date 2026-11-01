/**
 * @pithagoras/nextcloud's settings as they stand to be kept and read: the instances, held in this extension's own
 * data folder (dataDir()/settings.json), with the names of the entries this extension wrote into pi's mcp.json (so
 * that it clears those and only those).
 *
 * Where the data folder stands is as the portal knows it for this extension (dataDir); PITHAGORAS_NEXTCLOUD_DATA_DIR
 * says elsewhere, for a test or an embedder. Reads are merged over the defaults field by field: a file that is
 * missing, unreadable or not one this module wrote yields what stands of itself, silently -- nothing here logs.
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./host";
import { CAPABILITIES } from "./capabilities";

/** One Nextcloud this portal talks to: its login, how the capability families of its MCP server stand with it --
 * turned off in its entry in pi's config and in its pages where it chose so, everything on otherwise. Every
 * instance holds its own container (this extension's image, marked with its name), on the port and under the name
 * saved for it here: once chosen they stay with the instance, unset takes the next free ones at the planning. */
export interface NextcloudInstance {
  /** The instance by its name: the entry in pi's mcp.json under it, and the prefix of that server's tools for the chats. */
  name: string;
  /** The Nextcloud host the MCP server may talk to, as NEXTCLOUD_HOST: e.g. https://cloud.example.org. */
  url: string;
  /** The person's explicit choice to send the app password over plain http (a Nextcloud on the home network, say). */
  allowHttp?: boolean;
  /** A user of that host, as NEXTCLOUD_USERNAME. */
  username: string;
  /** An app password of that user (Nextcloud Settings > Security > Devices & sessions), as NEXTCLOUD_PASSWORD. Set only, never answered back. */
  password: string;
  /** The capability families turned off for this instance, by family id; a family that stands none is on -- what an
   * endpoint provides at all is found from its tool list, not here (see capabilities). */
  capabilities?: Record<string, boolean>;
  /** The loopback port its server listens on in its own container, kept where the keys so that adding, removing or
   * renaming another instance does not shift it (see planOwn). Unset until the first save plans it. */
  port?: number;
  /** The name of its container, kept for the same reason: another instance's name coming or going does not rename it. */
  container?: string;
}

/** The name the default instance goes by, and the container of the first one is named after. */
export const DEFAULT_INSTANCE_NAME = "nextcloud";

/** The name rules, shared with the pages (this file's node imports keep them out of it); re-exported from here so
 * the server half reads them as it did before. */
export { isValidInstanceName, INSTANCE_NAME_MAX } from "./instance-name";

const FILE = "settings.json"; // the store file, by that name in this module's data folder

/** The folder this module keeps its settings in: the extension's own data folder, where nothing says elsewhere. */
export function settingsRoot(): string {
  return process.env.PITHAGORAS_NEXTCLOUD_DATA_DIR?.trim() || dataDir();
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

/** One entry of a list as it stands, read over its defaults; nothing where it names no instance. */
function instanceFrom(raw: unknown): NextcloudInstance | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const name = text(o.name);
  if (!name) return undefined;
  const port = typeof o.port === "number" && Number.isInteger(o.port) && o.port > 0 && o.port <= 65535 ? o.port : undefined;
  const capabilities = capabilitiesFrom(o.capabilities);
  const container = text(o.container);
  return {
    name,
    url: text(o.url),
    username: text(o.username),
    password: text(o.password),
    ...(o.allowHttp === true ? { allowHttp: true } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    port,
    ...(container !== "" ? { container } : {}),
  };
}

/** What the store holds as a whole: the instances, the names of the entries in pi's mcp.json this extension wrote
 * (and so may clear), and the version of how those entries are written (see ENTRIES_VERSION). */
interface Store {
  instances: NextcloudInstance[];
  written: string[];
  entries: number;
}

/** How the entries in pi's mcp.json are written now. 1 (not stored) wrote them as trusted servers; 2 does not, and
 * the first run after the change takes the name out of Settings -> Guard's trusted servers (writing a server again
 * does not: only removing it does). */
export const ENTRIES_VERSION = 2;

/** What this module's own store holds -- or nothing at all where no store stands yet. */
function readStore(): Store | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(settingsRoot(), FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const o = parsed as Record<string, unknown>;
    const list = Array.isArray(o.instances) ? o.instances.map(instanceFrom).filter((i): i is NextcloudInstance => i !== undefined) : [];
    const written = Array.isArray(o.written) ? o.written.filter((n): n is string => typeof n === "string" && n !== "") : [];
    return { instances: list, written, entries: typeof o.entries === "number" ? o.entries : 1 };
  } catch {
    return undefined; // no store yet -- or none that reads, which the first save makes one of again
  }
}

function writeStore(store: Store): void {
  writeAtomic(path.join(settingsRoot(), FILE), Buffer.from(JSON.stringify(store, null, 2) + "\n", "utf8"));
}

const emptyStore = (): Store => ({ instances: [], written: [], entries: 1 });

/** The instances as they stand. */
export function loadInstances(): NextcloudInstance[] {
  return (readStore() ?? emptyStore()).instances;
}

/** The instances set to the list, in this module's own store; what the list holds after, read back. */
export function saveInstances(list: NextcloudInstance[]): NextcloudInstance[] {
  writeStore({ ...(readStore() ?? emptyStore()), instances: list.map((inst) => ({ ...inst })) });
  return loadInstances();
}

/** The names of the entries in pi's mcp.json that this extension wrote: the only ones it ever clears. */
export function loadWritten(): string[] {
  return (readStore() ?? emptyStore()).written;
}

/** How the entries stand written (see ENTRIES_VERSION). */
export function loadEntriesVersion(): number {
  return (readStore() ?? emptyStore()).entries;
}

/** Remember which entries this extension wrote, and with which version of how it writes them. */
export function saveWritten(names: string[], entries: number = ENTRIES_VERSION): void {
  writeStore({ ...(readStore() ?? emptyStore()), written: [...new Set(names)], entries });
}

/** Whether the instance names a Nextcloud to talk to: url, username and password all set. */
export function configured(inst: NextcloudInstance): boolean {
  return Boolean(inst.url && inst.username && inst.password);
}

function writeAtomic(dest: string, bytes: Buffer): void {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  // The file holds app passwords: where the temporary name stood before (a crashed run), it is narrowed anyway.
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
}
