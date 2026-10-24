import type { ChatProps, PanelProps } from "@pithagoras/extension-api";
import { PREFIX } from "../labels";
import { portal, t } from "../portal";
import { api } from "./api";
import { installed, useGodotState } from "./state";

/**
 * The Godot editor beside a chat: the server's viewer in a frame, served through the server half on the portal's own
 * origin, with the stream of the real editor in it. While there is no editor to show, it says why and where to go.
 *
 * The stream decodes with WebCodecs, which a browser gives only a secure context, and a frame is one only if the page
 * around it is: over plain HTTP on another name than localhost the frame would load and stay black, so the panel says
 * what to do instead.
 */

export const SETTINGS = "/settings/x/pithagoras-godot";

function Said({ children, settings = true }: { children: string; settings?: boolean }) {
  return (
    <div className="godot-screen">
      <div className="godot-said">
        <p>{children}</p>
        {settings && (
          <button type="button" className="mt-3 underline" onClick={() => portal.navigate(SETTINGS)}>
            {t("Open Settings → Godot")}
          </button>
        )}
      </div>
    </div>
  );
}

/** The note for a page that is not a secure context, shown in the panel and on the Settings page. */
export function insecureNote(): string {
  return t(
    "The Godot editor needs the portal on HTTPS or on localhost: browsers only play the stream in a secure context. Serve the portal with PORTAL_TLS_CERT and PORTAL_TLS_KEY, or open it as http://localhost.",
  );
}

export const HTTPS_GUIDE = "https://thecodacus.github.io/pithagoras/guide/deploying#https";

export function GodotPanel() {
  const lang = portal.locale.use();
  const { state, failed } = useGodotState();
  if (!window.isSecureContext) {
    return (
      <div className="godot-screen">
        <div className="godot-said">
          <p>{insecureNote()}</p>
          <a className="mt-3 inline-block underline" href={HTTPS_GUIDE} target="_blank" rel="noreferrer">
            {t("How to serve the portal over HTTPS")}
          </a>
        </div>
      </div>
    );
  }
  if (!state) return <Said settings={false}>{failed ? t("Could not reach the Godot extension.") : t("Loading…")}</Said>;
  switch (state.state) {
    case "running":
      return (
        <div className="godot-screen">
          <iframe
            src={api.viewerUrl(lang)}
            title={t("The Godot editor")}
            // The editor wants the keyboard and the clipboard, and its menus may go full screen.
            allow="clipboard-read; clipboard-write; fullscreen; keyboard-map"
          />
        </div>
      );
    case "downloading":
      return <Said>{t("Godot is being downloaded: {progress}", { progress: state.progress || "…" })}</Said>;
    case "starting":
      return <Said settings={false}>{t("Godot is starting…")}</Said>;
    case "stopped":
      return <Said>{t("Godot is stopped. Start it in Settings → Godot.")}</Said>;
    case "failed":
      return <Said>{t("Godot failed to start. Settings → Godot shows its log.")}</Said>;
    case "unavailable":
      return <Said>{t("Godot needs Docker for extensions, which does not answer.")}</Said>;
    default:
      return <Said>{t("Godot is not installed yet. Install it in Settings → Godot.")}</Said>;
  }
}

/** What the panel has in its head: Fullscreen, for the panel alone, the one beside it staying where it is. */
export function PanelActions({ panel }: PanelProps) {
  return (
    <button type="button" onClick={() => panel.fullscreen()} className="rounded px-1.5 py-0.5 text-[11px] text-fg-faint transition hover:text-fg">
      {t("Fullscreen")}
    </button>
  );
}

/**
 * How the panel's button is in a chat's header: there once the server is installed (and in a page that is not a
 * secure context too, where the panel says what to do), live while a call of one of its tools runs in this chat.
 */
export function useButton({ chat }: ChatProps) {
  portal.locale.use();
  const { state } = useGodotState();
  const live = portal.chats.use(chat.id, (feed) => feed.calls.some((call) => call.status === "running" && call.name.startsWith(`${PREFIX}_`)));
  return { hidden: !installed(state), live, title: t("The Godot editor") };
}
