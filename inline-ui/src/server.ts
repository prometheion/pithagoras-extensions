import type { ServerPortal } from "@pithagoras/extension-api/server";
import { UI_RECEIVE } from "./limits";
import { Delivery } from "./server/delivery";
import { RateLimiter } from "./server/rate";
import { routes } from "./server/routes";
import { openSettings } from "./server/settings";
import { CardStore, summary } from "./server/store";
import { registerTools } from "./server/tools";
import { Waits } from "./server/waits";

/**
 * Inline UI's server half: the agent's tools (`ui_show`, `ui_update`, `ui_close`) in every chat's pi, each chat's
 * cards kept in the extension's own folder and told to the pages open on the chat, the frame each card is drawn in,
 * and what the person does in a card taken from the page and brought to the agent (server/delivery.ts).
 *
 * The package's pi extension is the one the server half adds to every chat (`chats.extend`): beside the tools, it puts
 * what waits for the chat's next turn into that turn (`before_agent_start`), and the messages it is told of on pi's bus
 * (`chats.tell`) into the conversation (`pi.sendMessage`). So it runs where pi runs in the portal's own process (the
 * host executor), and not in a process of its own.
 */
export default function inlineUi(portal: ServerPortal) {
  const data = portal.dataDir();
  const settings = openSettings(data);
  const store = new CardStore(data);
  const waits = new Waits();
  const limiter = new RateLimiter();
  const push = (chatId: string, message: unknown) => portal.chats.send(chatId, message);
  const delivery = new Delivery({
    now: () => Date.now(),
    running: (chatId) => portal.chats.get(chatId)?.status === "running",
    tell: (chatId, message) => portal.chats.tell(chatId, message),
    allowWake: () => settings.get().allowWake,
    outbox: { get: (chatId) => store.outbox(chatId), set: (chatId, entries) => store.setOutbox(chatId, entries) },
    log: (text) => portal.log(text),
  });

  portal.chats.extend((pi, chat) => {
    registerTools(pi, chat, { store, waits, push });
    pi.on("before_agent_start", () => {
      const message = delivery.take(chat.id);
      return message ? { message } : undefined;
    });
    pi.events?.on(UI_RECEIVE, (said: { extension?: unknown; data?: { type?: unknown; id?: unknown } } | undefined) => {
      if (said?.extension !== portal.extension || said.data?.type !== "deliver") return;
      const claimed = delivery.claim(chat.id, said.data.id);
      if (claimed) pi.sendMessage(claimed.message, claimed.options);
    });
  });

  portal.chats.onEvent((chatId, event) => {
    if (event.type === "message_end" || event.type === "agent_end") delivery.heard(chatId, event);
  });
  const letGo = (chatId: string) => delivery.stopped(chatId);
  portal.chats.on("stopped", letGo);
  portal.chats.on("finished", letGo);
  portal.chats.on("deleted", (chatId) => {
    waits.end(chatId);
    delivery.forget(chatId);
    limiter.forget(chatId);
    store.forget(chatId);
  });
  // A page that opens a chat is told its cards; nothing for a chat that has none.
  portal.chats.onOpen((chatId) => {
    const cards = store.cards(chatId);
    return cards.length ? { type: "index", cards: cards.map(summary) } : undefined;
  });

  routes(portal, portal.router, { store, waits, delivery, limiter, settings, push, now: () => Date.now() });

  return () => {
    waits.end();
    delivery.dispose();
  };
}
