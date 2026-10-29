/**
 * @pithagoras/nextcloud's own fields as pi holds them: keys in the agent's config file (PI_CODING_AGENT_DIR or
 * ~/.pi/agent), beside pi's own -- where they live, the portal's Extensions page lists them and restores them, and a
 * save here is a merged write over that file, nothing else of it touched.
 *
 * The keys are read from a variable named after what it holds, as literals: the portal scans this package's source
 * for such reads to know which keys to show (see detectSettingKeys in @pithagoras/server) -- so nowhere else in this
 * package may another key be read off a name that ends in "settings". The one current key is `instances`, a list of
 * the Nextclouds this portal knows; the four flat keys beside it are what an earlier version saved and are still
 * read here, to carry over as the first instance (see loadInstances), and go on the next save.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** One Nextcloud this portal talks to: its login, what its entry in pi's config keeps out of the chats' tool lists,
 * and where its /mcp endpoint lives -- a container this extension made (`own`), or one already running that it
 * adopted by name (`adopted:<docker container name>`). */
export interface NextcloudInstance {
  /** The instance by its name: the entry in pi's mcp.json under it, and the prefix of that server's tools for the chats. */
  name: string;
  /** The Nextcloud host the MCP server may talk to, as NEXTCLOUD_HOST: e.g. https://cloud.example.org. */
  url: string;
  /** A user of that host, as NEXTCLOUD_USERNAME. */
  username: string;
  /** An app password of that user (Nextcloud Settings > Security > Devices & sessions), as NEXTCLOUD_PASSWORD. Set only, never answered back. */
  password: string;
  /** Comma-separated tool-name globs the mcp.json entry excludes, matched against pi-mcp-adapter's names (<instance>_<tool>). Empty takes the default. */
  mcpExcludeTools: string;
  /** Where the /mcp endpoint lives: `own` -- a container this extension made and keeps, or `adopted:<name>` -- one that was already running. */
  container: string;
  /** The loopback port its server listens on in its own container, kept where the keys so that adding, removing or
   * renaming another instance does not shift it (see planOwn). Unset until the first save plans it. */
  port?: number;
}

/** The name the one instance of an earlier version carried in pi's config, so its migration lands where it stood. */
export const DEFAULT_INSTANCE_NAME = "nextcloud";

/** What a blank keep-out list takes of itself, for an instance by its name: mail, news and collectives kept out, as
 * the chats' tool lists only want what this extension brings to its pages (v0.202.2 has no talk tools). */
export function excludeDefault(name: string): string {
  return `${name}_nc_mail_*,${name}_nc_news_*,${name}_collectives_*`;
}

/** The name rules, shared with the pages (this file's node imports keep them out of it); re-exported from here so
 * the server half reads them as it did before. */
export { isValidInstanceName, INSTANCE_NAME_MAX } from "./instance-name";

/** Whether the container field says the endpoint is in a container that was already running, and if so by what name. */
export const isAdopted = (container: string): boolean => container.startsWith("adopted:");
export const adoptedName = (container: string): string => container.slice("adopted:".length);

const FILE = "settings.json"; // pi's config file, by that name

/** The agent's directory, as the portal knows it or by its default place. */
function dir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

/** What the file holds as a whole, an object: nothing where there is none (or it says something that is not one). */
function readAll(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir(), FILE), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // no file yet, or none that reads: empty stands
  }
  return {};
}

/** One entry of the list as the file holds it, read over its defaults; nothing where it names no instance. */
function instanceFrom(raw: unknown): NextcloudInstance | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const name = text(o.name);
  if (!name) return undefined;
  const container = text(o.container);
  const port = typeof o.port === "number" && Number.isInteger(o.port) && o.port > 0 && o.port <= 65535 ? o.port : undefined;
  return {
    name,
    url: text(o.url),
    username: text(o.username),
    password: text(o.password),
    mcpExcludeTools: text(o.mcpExcludeTools) || excludeDefault(name),
    container: container === "own" || (isAdopted(container) && adoptedName(container) !== "") ? container : "own",
    port,
  };
}

/**
 * The instances as the file holds them. Where it still has only what an earlier version saved -- its four flat keys
 * -- they come over as the one implicit instance under the name that version's entry in pi's config carried, so a
 * saved set keeps working unchanged; where nothing is saved at all, nothing stands (the pages say to add one).
 */
export function loadInstances(): NextcloudInstance[] {
  const settings = readAll();
  if (Array.isArray(settings.instances)) {
    return (settings.instances as unknown[]).map(instanceFrom).filter((i): i is NextcloudInstance => i !== undefined);
  }
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const url = text(settings.url);
  const username = text(settings.username);
  const password = text(settings.password);
  if (!url && !username && !password) return [];
  return [
    {
      name: DEFAULT_INSTANCE_NAME,
      url,
      username,
      password,
      mcpExcludeTools: text(settings.mcpExcludeTools) || excludeDefault(DEFAULT_INSTANCE_NAME),
      container: "own",
    },
  ];
}

/** The instances set to the list (the rest of the file stays as it is; the flat keys an earlier version kept are
 * dropped then, having come over as the first instance already), and what the list holds after. */
export function saveInstances(list: NextcloudInstance[]): NextcloudInstance[] {
  const all = readAll();
  all.instances = list.map((inst) => ({ ...inst }));
  for (const legacy of ["url", "username", "password", "mcpExcludeTools"]) delete all[legacy];
  writeAtomic(path.join(dir(), FILE), Buffer.from(JSON.stringify(all, null, 2) + "\n", "utf8"));
  return loadInstances();
}

/** Whether the instance names a Nextcloud to talk to: url, username and password all set. */
export function configured(inst: NextcloudInstance): boolean {
  return Boolean(inst.url && inst.username && inst.password);
}

/** The keep-out list as mcp.json takes it: trimmed, empty ones dropped. */
export function excludeList(inst: NextcloudInstance): string[] {
  return inst.mcpExcludeTools.split(",").map((part) => part.trim()).filter(Boolean);
}

function writeAtomic(dest: string, bytes: Buffer): void {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
}
