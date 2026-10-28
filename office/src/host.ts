import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { Docker } from "../../shared/docker-api";

/**
 * The portal this server half was started with, for every module of it to reach: Docker, the data folder, the log.
 * Set as the half starts (see server.ts), before anything else of it runs, and set again by a start after a stop: the
 * modules are loaded once, and outlive a stop.
 */
let current: ServerPortal | undefined;

export function setPortal(portal: ServerPortal): void {
  current = portal;
}

export function portal(): ServerPortal {
  if (!current) throw new Error("@pithagoras/office's server half has not started");
  return current;
}

/** This extension's own data folder (settings, jwt-secret, the document library). */
export const dataDir = (): string => portal().dataDir();

/** Docker, which @pithagoras/office requires (`pithagoras.requires` in its package.json): there whenever this half runs. */
export function docker(): Docker | undefined {
  return portal().extensions.use("pithagoras-docker");
}

/** What the comment agents and the editor's chat need of the portal (the extension API of thecodacus/pithagoras#339):
 * a chat Office starts in an agent's or a project's folder for nobody to attend, its last answer after a restart,
 * whose a chat is, and who is behind a request. */
const NEEDED: [name: string, has: (p: Record<string, any>) => unknown][] = [
  ["chats.start", (p) => p.chats?.start],
  ["chats.lastAnswer", (p) => p.chats?.lastAnswer],
  ["chats.owner", (p) => p.chats?.owner],
  ["http.person", (p) => p.http?.person],
];

/** The members of `NEEDED` this portal lacks: none on a portal with #339. */
export function missingApi(of: unknown = portal()): string[] {
  const p = (of ?? {}) as Record<string, any>;
  return NEEDED.filter(([, has]) => typeof has(p) !== "function").map(([name]) => name);
}

/** What Office says, on its page, in the editor and in the tools' answers, where the portal is too old for agents to
 * answer comments and the editor's chat. */
export function tooOld(missing: string[]): string {
  return `Agents do not answer comments or the editor's chat here: this portal is too old for it (it lacks ${missing.join(", ")}). Update Pithagoras to a version whose extension API has them.`;
}
