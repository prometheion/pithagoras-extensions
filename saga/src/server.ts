import { randomBytes } from "node:crypto";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import { escapeXml } from "./server/escape";
import { systemPrompt } from "./server/prompt";
import { routes } from "./server/routes";
import { Saga } from "./server/saga";
import { GameStore } from "./server/store";
import { registerTools, TOOL_NAMES } from "./server/tools";
import { Waits } from "./server/waits";
import { packOf } from "./game/xianxia";

/** pi's event bus, between the portal and the package's pi extension in a chat (`chats.tell`). */
export const UI_RECEIVE = "pithagoras:v1:ui:receive";
/** The customType of the messages that bring the player's late answers into the chat. */
export const CUSTOM_TYPE = "saga-player";
/** How long a call waits for the player before it lets the turn end. */
export const WAIT_MS = 20 * 60 * 1000;

/**
 * Saga's server half: a chat mode in which the agent is the game master. In a chat in the mode, and only there, the
 * agent has the game's tools and nothing else (its other tools are switched off for the chat's runs, `setActiveTools`),
 * and its prompt is the game master's (`before_agent_start`). The game itself is the server's (server/saga.ts): the
 * tools set what the player is to answer, the panel answers it through the routes, and the server rolls and counts.
 *
 * What the player answers while no call waits (the call timed out, or the run was stopped) goes to the agent as a
 * message through the package's pi extension: told on pi's bus (`chats.tell`, which starts the chat's pi if need be),
 * then `pi.sendMessage`, which starts a turn while the agent is idle. A hero made in the panel goes the same way, so
 * the story starts without the player typing anything.
 */
export default function saga(portal: ServerPortal) {
  const store = new GameStore(portal.dataDir());
  const waits = new Waits();
  const SAGA = portal.modes.provide({
    id: "saga",
    label: "Saga mode",
    description: "A story you play: the agent is the game master of a cultivation saga, told like a film in a panel beside the chat, with choices, dice, fights and puzzles. The agent has no other tools here.",
  });
  const isSaga = (chatId: string) => portal.chats.get(chatId)?.mode === SAGA;

  const late = (chatId: string, text: string) => {
    const id = `l-${randomBytes(9).toString("base64url")}`;
    store.change(chatId, (k) => {
      // What waited before and was not told goes with it.
      const before = k.late && !k.late.delivered ? `${k.late.text}\n\n` : "";
      k.late = { id, text: `${before}${text}`, delivered: false };
    });
    portal.chats.tell(chatId, { type: "deliver", id }).catch((e: Error) => portal.log(`could not reach the agent of chat ${chatId}: ${e.message}`));
  };

  const game = new Saga({ store, waits, push: (chatId, data) => portal.chats.send(chatId, data), late, rng: Math.random, now: () => Date.now(), waitMs: WAIT_MS });

  /** What waits to be told to the agent, taken once. */
  const takeLate = (chatId: string, id?: string) => {
    const kept = store.get(chatId);
    if (!kept.late || kept.late.delivered || (id !== undefined && kept.late.id !== id)) return undefined;
    const { text } = kept.late;
    store.change(chatId, (k) => {
      k.late!.delivered = true;
    });
    return {
      customType: CUSTOM_TYPE,
      content: `<saga-player>\n<summary>Saga: the player has answered</summary>\n<note>${escapeXml(text)}</note>\n</saga-player>`,
      display: true,
    };
  };

  portal.chats.extend((pi, chat) => {
    if (chat.mode !== SAGA) return;
    registerTools(pi, chat, game);
    const only = () => {
      try {
        pi.setActiveTools?.([...TOOL_NAMES]);
      } catch (e) {
        portal.log(`could not narrow the tools of chat ${chat.id}: ${(e as Error).message}`);
      }
    };
    pi.on("session_start", only);
    // Another extension can bring its tools back later in a run (an MCP adapter that connects, a reload, a retry):
    // the tools are narrowed again before every request, and a call of any other tool is refused all the same.
    pi.on("turn_start", only);
    pi.on("tool_call", (event: { toolName?: unknown } | undefined) => {
      const name = String(event?.toolName ?? "");
      if ((TOOL_NAMES as readonly string[]).includes(name)) return undefined;
      return { block: true, reason: `There is no tool "${name}" in Saga mode: only ${TOOL_NAMES.join(", ")}. Tell the story with saga_scene.` };
    });
    pi.on("before_agent_start", () => {
      only();
      const g = game.game(chat.id);
      const message = takeLate(chat.id);
      return { systemPrompt: systemPrompt(packOf(g?.pack), g), ...(message ? { message } : {}) };
    });
    pi.events?.on(UI_RECEIVE, (said: { extension?: unknown; data?: { type?: unknown; id?: unknown } } | undefined) => {
      if (said?.extension !== portal.extension || said.data?.type !== "deliver" || typeof said.data.id !== "string") return;
      const message = takeLate(chat.id, said.data.id);
      if (message) pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
    });
  });

  portal.chats.on("deleted", (chatId) => {
    waits.end(chatId);
    store.forget(chatId);
  });
  portal.chats.onOpen((chatId) => (isSaga(chatId) ? game.snapshot(chatId) : undefined));

  routes(portal, portal.router, { saga: game, isSaga, begun: late });

  return () => waits.end();
}
