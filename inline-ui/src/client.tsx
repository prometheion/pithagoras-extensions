import { Suspense } from "react";
import { LuAppWindow } from "react-icons/lu";
import type { Portal } from "@pithagoras/extension-api";
import { de } from "./de";
import { msg, portal, setPortal, t } from "./portal";
import { ShowCall } from "./web/Card";
import { heard } from "./web/store";
import "./client.css";

/**
 * Inline UI: the card a ui_show call makes, drawn live where the call is in the conversation; the portal's own card
 * for ui_update and ui_close, in the extension's words; and its page in Settings. What the server half says of a chat's
 * cards is heard here, as the module is called, so that a card drawn later has it. Its texts in German are in de.ts.
 */
export default function inlineUi(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
  const offServer = portal.server.on(heard);
  // Only fetched once it is opened.
  const Settings = portal.ui.lazy(() => import("./web/Settings"), "UiSettingsPage");

  portal.slots.register("chat.tool", {
    id: "ui_show",
    tool: "ui_show",
    describe: (call) => ({ label: t("Showing a card"), ...(typeof call.input.title === "string" ? { detail: call.input.title } : {}) }),
    component: ShowCall,
  });
  portal.slots.register("chat.tool", {
    id: "ui_update",
    tool: "ui_update",
    describe: (call) => ({ label: t("Updating a card"), ...(typeof call.input.card === "string" ? { detail: call.input.card } : {}) }),
    component: ({ card }) => <>{card}</>,
  });
  portal.slots.register("chat.tool", {
    id: "ui_close",
    tool: "ui_close",
    describe: (call) => ({ label: t("Closing a card"), ...(typeof call.input.card === "string" ? { detail: call.input.card } : {}) }),
    component: ({ card }) => <>{card}</>,
  });

  portal.slots.register("settings.page", {
    id: "inline-ui",
    title: msg("Inline UI"),
    icon: LuAppWindow,
    search: [
      { title: msg("Inline UI"), words: "card cards karte karten ui html interactive interaktiv debounce wake height höhe" },
      { title: msg("Starting the agent"), section: msg("Starting the agent"), words: "wake turn start agent starten" },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Settings />
      </Suspense>
    ),
  });

  return () => offServer();
}
