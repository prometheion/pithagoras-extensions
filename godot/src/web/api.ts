import { msg, portal } from "../portal";

/**
 * What the browser half asks of Godot's server half: its own routes, under the address the portal gives the package
 * (`portal.api.url`). A request made while the server half is not running is refused as one the server refused is.
 */

const call = async <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);

/** How the Godot server stands (shared/service.ts `Status`), with the editor's own state while it answers, and the screen. */
export interface GodotState {
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
  /** The editor, as the server says it is, while the server answers. */
  editor?: { ready: boolean; editor: string; project: string | null; renderer: string | null; busy: string | null; restarts: number; adapter: string | null; godot: string };
  display: string;
}

export type ServerState = GodotState["state"];

export interface Card {
  index: number;
  uuid: string;
  name: string;
  usedMiB: number | null;
  totalMiB: number | null;
}

/** The cards as the probe found them, the one chosen on the page, whether the host pinned one, and the one the server is or would be on. */
export interface Hardware {
  cards: Card[];
  error: string;
  chosen: string;
  pinned: boolean;
  wanted?: string;
}

/**
 * The server half's own sentences (shared/service.ts and server/routes.ts), which the page shows in the page's
 * language (de.ts). Docker's own words are shown as Docker wrote them.
 */
export const SAID = [
  msg("Godot is being set up already."),
  msg("Docker does not answer."),
  msg("Wait for the setup to finish."),
  msg("Godot exited. Its log says why."),
  msg("The host fixes the card for this server."),
  msg("That card is not on this host."),
  msg("A container named pithagoras-godot is there that is not this extension's. Rename or remove it first."),
  msg("Choose one of the screen sizes offered."),
  msg("The card PITHAGORAS_GODOT_GPU names is not on this host."),
];

export const api = {
  state: () => call<GodotState>("/state"),
  hardware: () => call<Hardware>("/hardware"),
  install: () => call<{ ok: true }>("/install", { method: "POST" }),
  start: () => call<{ ok: true }>("/start", { method: "POST" }),
  stop: () => call<{ ok: true }>("/stop", { method: "POST" }),
  uninstall: (removeData: boolean) => call<{ ok: true }>("/uninstall", { method: "POST", body: JSON.stringify({ removeData }) }),
  setGpu: (gpu: string) => call<{ selected: string; restarting: boolean }>("/gpu", { method: "PUT", body: JSON.stringify({ gpu }) }),
  setDisplay: (display: string) => call<{ display: string; restarting: boolean }>("/display", { method: "PUT", body: JSON.stringify({ display }) }),
  /** The viewer, through the server half, in the page's language. */
  viewerUrl: (lang: string) => `${portal.api.url("/ui/")}?lang=${encodeURIComponent(lang)}`,
};
