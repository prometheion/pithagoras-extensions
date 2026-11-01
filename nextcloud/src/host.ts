import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { Docker } from "../../shared/docker-api";

/**
 * The portal this server half was started with, for every module of it to reach: Docker above all. Set as the
 * half starts (see server.ts); the modules are loaded once and outlive a stop, so it is set again then.
 */
let current: ServerPortal | undefined;

export function setPortal(portal: ServerPortal): void {
  current = portal;
}

export function portal(): ServerPortal {
  if (!current) throw new Error("@pithagoras/nextcloud's server half has not started");
  return current;
}

/** This extension's own data folder (its settings stand there, as Settings keeps the settings of any extension). */
export const dataDir = (): string => portal().dataDir();

/**
 * Docker, which this package declares in its requires (Docker for extensions) — present whenever this half runs; a
 * portal without it cannot start an extension that asked for it, so its absence is a broken install, not a state.
 */
export function docker(): Docker {
  const d = portal().extensions.use<Docker>("pithagoras-docker");
  if (!d) throw new Error("Docker for extensions (pithagoras-docker) is not available to this portal");
  return d;
}

/** This extension's name, as Docker for extensions marks its containers; the scoped one where no portal is set. */
export function ownName(): string {
  try {
    return portal().extension;
  } catch {
    return "@pithagoras/nextcloud";
  }
}

/** Who is behind a request to the package's routes (`http.person`, which a Pithagoras of 0.3.0 and later has). */
interface RequestPerson {
  id: string;
  name: string;
  role: "primary" | "colleague" | "guest" | "unknown";
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * For the whole of the routes, after `writesFromHere`: a request that changes something -- saves an instance, calls
 * a tool that sends mail or deletes -- is the primary person's alone; a colleague or a guest of the portal may read.
 * A portal without `http.person` (older than 0.3.0) has only its own sign-in gate in front of these routes, as before.
 * `/tool` is a POST for every tool, read or not, and counts as a change.
 */
export function personGate(
  req: { method?: string },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  next: () => void,
): void {
  const http = (portal() as unknown as { http: { person?: (req: unknown) => RequestPerson | undefined } }).http;
  if (typeof http.person !== "function") return next();
  let person: RequestPerson | undefined;
  try {
    person = http.person(req);
  } catch {
    person = undefined;
  }
  if (!person) return void res.status(401).json({ error: "Sign in to the portal first." });
  if (!READS.has(req.method ?? "GET") && person.role !== "primary") return void res.status(403).json({ error: "Only the portal's primary person may change this Nextcloud's settings or call its tools." });
  next();
}
