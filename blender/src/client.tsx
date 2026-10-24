import { Suspense } from "react";
import { LuBox } from "react-icons/lu";
import type { ChatProps, Portal } from "@pithagoras/extension-api";
import { LABELS, PREFIX } from "./labels";
import { msg, portal, setPortal, t } from "./portal";
import { BlenderPanel, PanelActions } from "./web/BlenderPanel";
import { forget, installed, useBlenderState } from "./web/state";
import { de } from "./de";
import "./client.css";

/**
 * Blender: a headless Blender in a container, its tools in every chat, and its live viewport beside each chat. Its
 * page in Settings, where its server is installed, started, stopped and removed and its card chosen; the panel beside
 * each chat with the server's viewer in it; and what the chat's card of each of its tools says. Its texts in German
 * are in de.ts.
 */

const isBlenderCall = (name: string) => name.startsWith(`${PREFIX}_`);

/**
 * How the panel's button is in a chat: there once Blender is installed here, with a dot while one of its tools runs
 * in this chat.
 */
function useButton({ chat }: ChatProps) {
  portal.locale.use();
  const { state } = useBlenderState();
  const live = portal.chats.use(chat.id, (feed) => feed.calls.some((call) => isBlenderCall(call.name) && call.status === "running"));
  return { hidden: !installed(state), live, title: t("The Blender view") };
}

export default function blender(given: Portal) {
  setPortal(given);
  forget();
  portal.locale.add("de", de);
  // Only fetched once it is opened.
  const Settings = portal.ui.lazy(() => import("./web/BlenderSettings"), "BlenderSettings");

  portal.slots.register("settings.page", {
    id: "blender",
    title: msg("Blender"),
    icon: LuBox,
    search: [
      {
        title: msg("Blender"),
        words: "blender render rendern 3d scene szene gpu docker install remove start stop installieren entfernen starten anhalten",
      },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Settings />
      </Suspense>
    ),
  });

  portal.slots.register("chat.panel", {
    id: "blender",
    title: msg("Blender"),
    name: "blender",
    icon: LuBox,
    bleed: true,
    component: BlenderPanel,
    actions: PanelActions,
    useButton,
  });

  // What the card of each call says: the portal's own card, with Blender's words for the call.
  for (const [tool, label] of Object.entries(LABELS)) {
    portal.slots.register("chat.tool", {
      id: tool,
      tool: `${PREFIX}_${tool}`,
      describe: () => ({ label: t(label) }),
      component: ({ card }) => <>{card}</>,
    });
  }
}
