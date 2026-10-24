import { Suspense } from "react";
import { LuGamepad2 } from "react-icons/lu";
import type { Portal } from "@pithagoras/extension-api";
import { LABELS, PREFIX } from "./labels";
import { msg, portal, setPortal, t } from "./portal";
import { GodotPanel, PanelActions, useButton } from "./web/GodotPanel";
import { forget } from "./web/state";
import { de } from "./de";
import "./client.css";

/**
 * Godot: the real Godot editor, run in a container on the portal's Docker, for the agent and the person to work in
 * together. Its page in Settings, where the server is installed, started, stopped and removed and its GPU and screen are
 * chosen; the editor's live screen in a panel beside each chat; and what the chat's card says of a call of each of its
 * tools. The tools themselves are the server half's (server.ts). Its texts in German are in de.ts.
 */
export default function godot(given: Portal) {
  setPortal(given);
  forget();
  portal.locale.add("de", de);
  // Only fetched once it is opened.
  const Settings = portal.ui.lazy(() => import("./web/GodotSettings"), "GodotSettings");

  portal.slots.register("settings.page", {
    id: "godot",
    title: msg("Godot"),
    icon: LuGamepad2,
    search: [
      {
        title: msg("Godot"),
        words: "godot game engine editor spiel spiele docker container gpu install remove start stop screen installieren entfernen starten anhalten bildschirm",
      },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Settings />
      </Suspense>
    ),
  });

  portal.slots.register("chat.panel", {
    id: "godot",
    title: msg("Godot"),
    name: "godot",
    icon: LuGamepad2,
    bleed: true,
    component: GodotPanel,
    actions: PanelActions,
    useButton,
  });

  // What the card of each tool's call says: the portal's own card, with the tool's words in the page's language.
  for (const [tool, label] of Object.entries(LABELS)) {
    portal.slots.register("chat.tool", {
      id: tool,
      tool: `${PREFIX}_${tool}`,
      describe: () => ({ label: t(label) }),
      component: ({ card }) => <>{card}</>,
    });
  }
}
