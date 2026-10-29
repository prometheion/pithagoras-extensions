/**
 * What an install of this extension takes over on its own: every entry in pi's mcp.json that already points at a
 * container running the image -- one the person ran for pi before this extension knew anything of it. Such an entry
 * becomes an instance that adopts the container behind it: its keep-out list comes over as its capability choices,
 * and where the
 * container carries the server's own environment (NEXTCLOUD_HOST, NEXTCLOUD_USERNAME, NEXTCLOUD_PASSWORD), so does
 * that, so the adopted instance stands set at once. It acts only where no instance stands saved yet -- what is set
 * already is the person's own to change -- and what it did, one note each for the settings page, in English (the
 * pages read them through their translations).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Docker } from "../../shared/docker-api";
import { discoverSafe, Discovered } from "./container";
import { capabilitiesFromExcludeText } from "./capabilities";
import { isValidInstanceName, loadInstances, saveInstances, NextcloudInstance } from "./config";

/** The agent's directory, as the portal knows it or by its default place -- where pi's mcp.json stands. */
function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

/** What pi's mcp.json says of its servers, by name to entry: nothing where it names none or does not read. */
export function mcpEntries(dir = agentDir()): Record<string, Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const servers = (parsed as Record<string, unknown>).mcpServers;
    if (typeof servers !== "object" || servers === null) return {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
      if (typeof entry === "object" && entry !== null) out[name] = entry as Record<string, unknown>;
    }
    return out;
  } catch {
    return {}; // no file yet, or none that reads: nothing to take over from there
  }
}

/** The pairing of one act: an entry in pi's config that stands on a container found running the image. */
export interface MatchedEntry {
  /** The entry in pi's config; the instance takes its name with it. */
  name: string;
  /** What that entry holds, for its capability choices. */
  entry: Record<string, unknown>;
  /** The container running the image that the entry's /mcp address points at. */
  container: Discovered;
}

/** The entries of pi's config that stand on a found container: their url is one of the /mcp addresses it publishes. */
export function matchEntries(containers: Discovered[], entries: Record<string, Record<string, unknown>>): MatchedEntry[] {
  const out: MatchedEntry[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!url) continue;
    const container = containers.find((c) => c.endpoint !== undefined && c.endpoint === url);
    if (container) out.push({ name, entry, container });
  }
  return out;
}

/** One variable of a server's own environment, as it stands in the Env list a docker inspect body carries. */
export function envOf(env: unknown, name: string): string {
  if (!Array.isArray(env)) return "";
  for (const item of env) {
    if (typeof item === "string" && item.startsWith(`${name}=`)) return item.slice(name.length + 1).trim();
  }
  return "";
}

/** The capability choices an entry in pi's config stands with: every family whose glob the entry's keep-out list
 * names (a list, or a comma-separated string) comes over turned off; nothing where the entry keeps no list at all.
 */
export function capabilitiesOf(entry: Record<string, unknown>, name: string): Record<string, boolean> | undefined {
  const raw = entry.excludeTools;
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const list = parts.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean);
  if (list.length === 0) return undefined; // the entry keeps no list: every family stands on, nothing to carry over
  return capabilitiesFromExcludeText(name, list.join(","));
}

/** What one matched entry comes over as: the instance that adopts its container, with its capability choices and --
 * where they were read off the container's environment -- its login. */
export function instanceOf(matched: MatchedEntry, login: { url: string; username: string; password: string }): NextcloudInstance {
  const capabilities = capabilitiesOf(matched.entry, matched.name);
  return {
    name: matched.name,
    url: login.url,
    username: login.username,
    password: login.password,
    ...(capabilities !== undefined ? { capabilities } : {}),
    container: `adopted:${matched.container.name}`,
  };
}

/**
 * Take over what already ran, as the file's head says. One note per taken-over entry -- and one where an entry stood
 * to be had but its name could not be made into an instance name (nothing of it moved, so it is named). An empty list
 * says nothing stood to take over: no saved instances aside, no matching entries, or Docker did not answer.
 */
export async function migrateExistingMcpEntries(docker: Docker): Promise<string[]> {
  if (loadInstances().length > 0) return []; // what is set already is the person's own to change, not this module's to second-guess
  const discovery = await discoverSafe();
  if (discovery.error || discovery.containers.length === 0) return [];
  const notes: string[] = [];
  const adopted: NextcloudInstance[] = [];
  for (const matched of matchEntries(discovery.containers, mcpEntries())) {
    if (!isValidInstanceName(matched.name)) {
      notes.push(`The existing entry "${matched.name}" in pi's config was not taken over: an instance name may take letters, numbers, dashes and underscores, and start with a letter.`);
      continue;
    }
    let login = { url: "", username: "", password: "" };
    try {
      const body = await docker.containers.inspect(matched.container.name);
      const env = (body as { Config?: { Env?: string[] } } | undefined)?.Config?.Env;
      login = { url: envOf(env, "NEXTCLOUD_HOST"), username: envOf(env, "NEXTCLOUD_USERNAME"), password: envOf(env, "NEXTCLOUD_PASSWORD") };
    } catch {
      // the container will not give up its environment: it comes over without a login and is set on the page
    }
    adopted.push(instanceOf(matched, login));
    notes.push(
      login.url && login.username && login.password
        ? `The existing entry "${matched.name}" in pi's config was taken over as an instance (adopted container: ${matched.container.name}).`
        : `The existing entry "${matched.name}" in pi's config was taken over as an instance (adopted container: ${matched.container.name}); its login was not read off the container -- set it on this page.`,
    );
  }
  if (adopted.length === 0) return []; // only entries that could not be had: nothing saved, and no note where nothing moved
  saveInstances(adopted);
  return notes;
}
