import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * An extension's settings, in `settings.json` in its own folder (`portal.dataDir()`, which the portal keeps for itself
 * alone, 0700), for its owner alone (0600): it holds the token its server is started with. Each setting is left out
 * until it is said. Understory keeps its settings the same way.
 */
export interface Settings {
  /**
   * The one credential of the extension's server: made once, the first time it is asked for, and given to the
   * container as its token. The proxy and the MCP client send it on every request; no page is ever given it, and
   * there is no default one.
   */
  token?: string;
  /** The card chosen on the Settings page, by UUID; empty, or not said, for the card with the most free memory. */
  gpu?: string;
  /** Godot's virtual screen, as `1600x900`. */
  display?: string;
}

export interface Store {
  setting<K extends keyof Settings>(key: K): Settings[K];
  /** Keeps `patch` beside what was said before, the whole file put in place at once through a file beside it. */
  putSettings(patch: Settings): void;
  /** The server's token: the one kept, or one made now (24 random bytes, as hex) and kept. */
  token(): string;
}

/** Reads the settings in `dir`, as the half starts. Nothing there yet, or nothing that can be read, is no setting said. */
export function openStore(dir: string): Store {
  const file = path.join(dir, "settings.json");
  let kept: Settings;
  try {
    kept = JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    kept = {};
  }
  const putSettings = (patch: Settings) => {
    kept = { ...kept, ...patch };
    writeFileSync(`${file}.tmp`, JSON.stringify(kept, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  return {
    setting: (key) => kept[key],
    putSettings,
    token() {
      if (!kept.token) putSettings({ token: randomBytes(24).toString("hex") });
      return kept.token!;
    },
  };
}
