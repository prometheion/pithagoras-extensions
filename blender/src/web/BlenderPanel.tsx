import type { PanelProps } from "@pithagoras/extension-api";
import { api } from "./api";
import { useBlenderState } from "./state";
import { portal, SETTINGS_PAGE, t } from "../portal";

/**
 * The Blender viewer beside a chat: the extension's own page (src/viewer.html), which shows what the server says (its
 * live viewport, rendered by Blender from where the person looks, its outliner, renders and projects), in a frame
 * through the server half, so it is behind the portal's sign-in and the person never signs in to Blender. It is drawn
 * in the page's language (`?lang=`). The page is the extension's and not the server's, as the server runs code the
 * agent writes: what the server answers is never let run on the portal's origin (shared/proxy.ts).
 *
 * While the server does not run, it says why, and where to start it. The panel's body is drawn anew for each chat,
 * so the frame loads again on a chat switch: the viewer reads all it shows from the server, so only its orbit camera
 * starts over.
 */
export function BlenderPanel() {
  const lang = portal.locale.use();
  const { state, failed } = useBlenderState();
  if (state?.state === "running") {
    return (
      <div className="blender-screen">
        <iframe
          src={api.uiUrl(lang)}
          title={t("The Blender view")}
          // What the person copies and pastes in the viewer's fields, and a full screen of its own.
          allow="clipboard-read; clipboard-write; fullscreen"
        />
      </div>
    );
  }
  let said: string;
  if (failed && !state) said = t("Could not reach Blender's server half.");
  else if (!state) said = t("Loading…");
  else if (state.state === "unavailable") said = t("Blender needs Docker for extensions. Install it in Settings → Extensions.");
  else if (state.state === "absent") said = t("Blender is not installed yet. Install it in Settings → Blender.");
  else if (state.state === "foreign") said = t("A container named {name} is there that is not this extension's. Rename it or remove it first.", { name: state.container });
  else if (state.state === "downloading") said = state.progress ? t("Downloading Blender: {progress}", { progress: state.progress }) : t("Downloading Blender…");
  else if (state.state === "starting") said = t("Blender is starting…");
  else if (state.state === "failed") said = t("Blender stopped with an error. Settings → Blender has its log.");
  else said = t("Blender is stopped. Start it in Settings → Blender.");
  const goes = state && !["starting", "downloading"].includes(state.state);
  return (
    <div className="blender-screen">
      <div className="blender-said">
        <p>{said}</p>
        {goes && (
          <button type="button" onClick={() => portal.navigate(SETTINGS_PAGE)}>
            {t("Open Settings → Blender")}
          </button>
        )}
      </div>
    </div>
  );
}

/** What the panel has in its head: Fullscreen, for the panel alone, the one beside it staying where it is. */
export function PanelActions({ panel }: PanelProps) {
  portal.locale.use();
  return (
    <button type="button" onClick={() => panel.fullscreen()} className="rounded px-1.5 py-0.5 text-[11px] text-fg-faint transition hover:text-fg">
      {t("Fullscreen")}
    </button>
  );
}
