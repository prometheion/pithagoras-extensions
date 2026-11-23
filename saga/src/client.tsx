import { LuSwords } from "react-icons/lu";
import type { Portal } from "@pithagoras/extension-api";
import { de } from "./de";
import { msg, portal, setPortal, t } from "./portal";
import { AutoOpen, PanelActions, SagaPanel, useButton } from "./web/Panel";
import { heard } from "./web/store";
import "./client.css";

/** What the card of each of the game master's calls says in the conversation. */
const LABELS: Record<string, string> = {
  saga_begin: msg("Making the hero"),
  saga_scene: msg("Playing a scene"),
  saga_roll: msg("Rolling the dice"),
  saga_puzzle: msg("Setting a puzzle"),
  saga_combat: msg("Starting a fight"),
  saga_change: msg("Changing the hero"),
  saga_status: msg("Looking at the hero"),
};

/**
 * Saga: the panel beside a chat in Saga mode, where the story plays as a film and the player chooses, fights and
 * solves; it opens by itself in such a chat. The game master's calls are told in the conversation in a word. What the
 * server half says of a chat's game is heard here, as the module is called. Its texts in German are in de.ts.
 */
export default function saga(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
  const offServer = portal.server.on(heard);

  portal.slots.register("chat.panel", {
    id: "saga",
    name: "saga",
    title: msg("Saga"),
    icon: LuSwords,
    bleed: true,
    component: SagaPanel,
    actions: PanelActions,
    useButton,
  });
  portal.slots.register("chat.background", { id: "saga-open", component: AutoOpen });

  for (const [tool, label] of Object.entries(LABELS)) {
    portal.slots.register("chat.tool", {
      id: tool,
      tool,
      describe: (call) => {
        const title = typeof call.input.title === "string" ? call.input.title : undefined;
        return { label: t(label), ...(title ? { detail: title } : {}) };
      },
      component: ({ card }) => <>{card}</>,
    });
  }

  return () => offServer();
}
