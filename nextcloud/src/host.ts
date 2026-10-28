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
