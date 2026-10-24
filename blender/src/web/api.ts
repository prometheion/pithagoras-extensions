import { msg, portal } from "../portal";

/**
 * What the browser half asks of Blender's server half: its own routes, under the address the portal gives the package
 * (`portal.api.url`). A request made while the server half is not running is refused as one the server refused is, so
 * that what asked says so where it says the rest.
 */

/** A JSON route of the server half. */
const call = async <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);

/** How the Blender server stands (shared/service.ts `Status`), with what the server says of its renderer while it answers. */
export interface BlenderState {
  state: "unavailable" | "absent" | "foreign" | "downloading" | "starting" | "running" | "stopped" | "failed";
  busy: boolean;
  progress: string;
  error: string;
  log: string;
  container: string;
  volume: string;
  image: string;
  card?: string;
  retrying?: boolean;
  /** The GPU backend Cycles uses (OPTIX, CUDA, CPU…) and the denoiser of the viewport (OPTIX or OPENIMAGEDENOISE). */
  renderer?: { backend: string; denoiser: string };
}

export interface Card {
  index: number;
  uuid: string;
  name: string;
  usedMiB: number | null;
  totalMiB: number | null;
}

/** The cards as the probe found them, the one chosen on the page, whether the host pinned one, and the one the server is or would be on. */
export interface BlenderHardware {
  cards: Card[];
  optix: "toolkit" | "host" | "none";
  error: string;
  chosen: string;
  pinned: boolean;
  wanted?: string;
}

/**
 * The server half's own sentences, which the page shows in the page's language (de.ts). Docker's own words are shown
 * as Docker wrote them.
 */
export const SERVER_SAYS = [
  msg("Blender is being set up already."),
  msg("Docker does not answer."),
  msg("Wait for the setup to finish."),
  msg("Blender exited. Its log says why."),
  msg("The host fixes the card for this server."),
  msg("That card is not on this host."),
  msg("The card PITHAGORAS_BLENDER_GPU names is not on this host."),
];

export const api = {
  state: () => call<BlenderState>("/state"),
  hardware: () => call<BlenderHardware>("/hardware"),
  act: (action: "install" | "start" | "stop") => call<{ ok: true }>(`/${action}`, { method: "POST" }),
  uninstall: (removeData: boolean) => call<{ ok: true }>("/uninstall", { method: "POST", body: JSON.stringify({ removeData }) }),
  setGpu: (gpu: string) => call<{ selected: string; restarting: boolean }>("/gpu", { method: "PUT", body: JSON.stringify({ gpu }) }),
  /** Where the server's viewer is, through the server half, in the page's language. */
  uiUrl: (lang: string) => `${portal.api.url("/ui/")}?lang=${encodeURIComponent(lang)}`,
};
