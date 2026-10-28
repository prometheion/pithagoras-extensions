/**
 * @pithagoras/nextcloud's own fields as pi holds them: flat keys in the agent's config file (PI_CODING_AGENT_DIR
 * or ~/.pi/agent), beside pi's own -- where they live, the portal's Extensions page lists them and restores them,
 * and a save here is a merged write over that file, nothing else of it touched.
 *
 * The four keys are read from a variable named after what it holds, as literals: the portal scans this package's
 * source for such reads to know which keys to show (see detectSettingKeys in @pithagoras/server) -- so nowhere
 * else in this package may another key be read off a name that ends in "settings".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The Nextcloud this extension talks to, and what its mcp.json entry keeps out of the chats' tool lists. */
export interface NextcloudSettings {
  /** The Nextcloud host the MCP server may talk to, as NEXTCLOUD_HOST: e.g. https://cloud.example.org. */
  url: string;
  /** A user of that host, as NEXTCLOUD_USERNAME. */
  username: string;
  /** An app password of that user (Nextcloud Settings > Security > Devices & sessions), as NEXTCLOUD_PASSWORD. */
  password: string;
  /** Comma-separated tool-name globs the mcp.json entry excludes, matched against pi-mcp-adapter's names (<server>_<tool>). Empty takes the default. */
  mcpExcludeTools: string;
}

/** What the keys hold where they are not set: no host or login yet, and a keep-out list that frees the chats' tool
 * lists of what this extension does not bring to its pages -- mail, news and collectives (v0.202.2 has no talk tools). */
export const DEFAULT_SETTINGS: NextcloudSettings = {
  url: "",
  username: "",
  password: "",
  mcpExcludeTools: "nextcloud_nc_mail_*,nextcloud_nc_news_*,nextcloud_collectives_*",
};

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

/** The extension's own keys, as the file holds them over the defaults (a blank keep-out list takes the default). */
export function loadSettings(): NextcloudSettings {
  const settings = readAll();
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  return {
    url: text(settings.url),
    username: text(settings.username),
    password: text(settings.password),
    mcpExcludeTools: text(settings.mcpExcludeTools) || DEFAULT_SETTINGS.mcpExcludeTools,
  };
}

/** Set some of the keys (the rest of the file stays as it is) and return what the keys hold after. */
export function saveSettings(patch: Partial<NextcloudSettings>): NextcloudSettings {
  const all = readAll();
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof NextcloudSettings)[]) {
    const value = patch[key];
    if (typeof value === "string") all[key] = value;
  }
  writeAtomic(path.join(dir(), FILE), Buffer.from(JSON.stringify(all, null, 2) + "\n", "utf8"));
  return loadSettings();
}

/** Whether the keys name a Nextcloud to talk to: url, username and password all set. */
export function configured(s: NextcloudSettings): boolean {
  return Boolean(s.url && s.username && s.password);
}

/** The keep-out list as mcp.json takes it: trimmed, empty ones dropped. */
export function excludeList(s: NextcloudSettings): string[] {
  return s.mcpExcludeTools.split(",").map((part) => part.trim()).filter(Boolean);
}

function writeAtomic(dest: string, bytes: Buffer): void {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
}
