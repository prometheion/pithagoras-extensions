import type { Request, Response, Router } from "express";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import { writesFromHere } from "../../../shared/proxy";
import { EVENT_DATA_MAX, declares, utf8Length } from "../limits";
import type { Delivery } from "./delivery";
import { FRAME_HEADERS, escapeHtml, outerPage, readTheme } from "./frame";
import type { RateLimiter } from "./rate";
import { checkPatch, type openSettings } from "./settings";
import { summary, type CardStore } from "./store";
import type { Waits } from "./waits";

/**
 * The server half's routes, at /api/x/@pithagoras/ondemand-ui, behind the portal's sign-in like every extension's, and
 * each that changes something refused unless it comes from the portal's own pages (`writesFromHere`):
 *
 *   GET  /settings, PUT /settings          the page in Settings
 *   GET  /chats/:chat/cards                a chat's cards, as the pages are told of them
 *   GET  /frame/:chat/:card                the frame a card is drawn in (see frame.ts)
 *   POST /chats/:chat/cards/:card/events   { event, data }: what the person did in a card
 *   POST /chats/:chat/cards/:card/close    the person closed a card
 */

export interface RouteDeps {
  store: CardStore;
  waits: Waits;
  delivery: Delivery;
  limiter: RateLimiter;
  settings: ReturnType<typeof openSettings>;
  push(chatId: string, data: unknown): void;
  now(): number;
}

const NONCE = /^[A-Za-z0-9_-]{8,64}$/;
const ORIGIN = /^https?:\/\/[^/\s?#@]+$/;
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const one = (value: unknown): string => (typeof value === "string" ? value : "");

/** What the frame route answers for a card it cannot draw: a line, in the frame, with the frame's own policy. */
function noCard(res: Response, text: string): void {
  res.writeHead(404, FRAME_HEADERS);
  res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;padding:12px;font:13px system-ui,sans-serif;color:#888">${escapeHtml(text)}</body>`);
}

export function routes(portal: ServerPortal, router: Router, deps: RouteDeps): void {
  const { store, waits, delivery, limiter, settings } = deps;
  router.use(writesFromHere);

  router.get("/settings", (_req, res) => void res.json(settings.get()));
  router.put("/settings", portal.http.json(), (req: Request, res: Response) => {
    const checked = checkPatch(req.body);
    if ("error" in checked) return void res.status(400).json({ error: checked.error });
    res.json(settings.put(checked.patch));
  });

  router.get("/chats/:chat/cards", (req, res) => {
    if (!portal.chats.get(req.params.chat)) return void res.status(404).json({ error: "No such chat" });
    res.json({ cards: store.cards(req.params.chat).map(summary) });
  });

  router.get("/frame/:chat/:card", (req, res) => {
    const { chat, card: id } = req.params;
    const card = portal.chats.get(chat) ? store.card(chat, id) : undefined;
    const body = card && store.body(chat, id);
    if (!card || !body) return noCard(res, "This card is no longer kept. / Diese Karte ist nicht mehr gespeichert.");
    const nonce = one(req.query.n);
    const origin = one(req.query.o);
    const lang = one(req.query.lang);
    const page = {
      card: { id: card.id, title: card.title },
      html: body.html,
      events: [...new Set([...Object.keys(card.events), ...(card.wait ? [card.wait.event] : [])])],
      ...(card.dataSeq > 0 && Object.hasOwn(body, "data") ? { data: { seq: card.dataSeq, value: body.data } } : {}),
      theme: readTheme(req.query.theme),
      // A nonce and an origin that are not one are none: the card then posts where nothing listens.
      nonce: NONCE.test(nonce) ? nonce : "none",
      origin: ORIGIN.test(origin) ? origin : "null",
      lang: LANG.test(lang) ? lang : "en",
    };
    res.writeHead(200, FRAME_HEADERS);
    res.end(outerPage(page));
  });

  router.post("/chats/:chat/cards/:card/events", portal.http.json({ limit: "64kb" }), (req: Request, res: Response) => {
    const { chat: chatId, card: cardId } = req.params as { chat: string; card: string };
    if (!portal.chats.get(chatId)) return void res.status(404).json({ error: "No such chat" });
    const card = store.card(chatId, cardId);
    if (!card) return void res.status(404).json({ error: "No such card" });
    if (card.status === "closed") return void res.status(409).json({ error: "The card is closed" });
    const { event, data } = (req.body ?? {}) as { event?: unknown; data?: unknown };
    if (typeof event !== "string" || !declares(card.events, card.wait, event)) return void res.status(400).json({ error: "The card does not declare that event" });
    const value = data === undefined ? null : data;
    if (utf8Length(JSON.stringify(value)) > EVENT_DATA_MAX) return void res.status(413).json({ error: "The event's data is too large" });
    const now = deps.now();
    if (!limiter.take(chatId, cardId, now)) return void res.status(429).json({ error: "Too many events" });
    // The call that waits for it has it, and nothing else does.
    if (waits.answer(chatId, cardId, event, value)) return void res.json({ delivery: "wait" });
    const wake = Object.hasOwn(card.events, event) && card.events[event].wake;
    res.json({ delivery: delivery.accept(chatId, { card: card.id, title: card.title, event, data: value, count: 1, wake, at: now, kind: "event" }) });
  });

  router.post("/chats/:chat/cards/:card/close", (req, res) => {
    const { chat: chatId, card: cardId } = req.params;
    if (!portal.chats.get(chatId)) return void res.status(404).json({ error: "No such chat" });
    const card = store.card(chatId, cardId);
    if (!card) return void res.status(404).json({ error: "No such card" });
    if (card.status === "closed") return void res.json({ card: summary(card) });
    const closed = store.close(chatId, cardId, "person", deps.now())!;
    deps.push(chatId, { type: "card", card: summary(closed) });
    // A call that waited on it is told; otherwise the agent hears of it with what else the chat sends it.
    if (!waits.close(chatId, cardId, "person")) delivery.accept(chatId, { card: closed.id, title: closed.title, event: "closed", data: null, count: 1, wake: false, at: deps.now(), kind: "closed" });
    res.json({ card: summary(closed) });
  });
}
