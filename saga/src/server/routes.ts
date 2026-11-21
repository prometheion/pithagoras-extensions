import { closeSync } from "node:fs";
import type { Request, Response, Router } from "express";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import { writesFromHere } from "../../../shared/proxy";
import type { PuzzleAnswer } from "../game/puzzles";
import { Refusal } from "../game/read";
import type { Answer, CombatAction } from "../game/types";
import type { Saga } from "./saga";

/**
 * The panel's routes, at /api/x/@pithagoras/saga, behind the portal's sign-in, each that changes something refused
 * unless it comes from the portal's own pages (`writesFromHere`), and only for a chat in Saga mode:
 *
 *   GET  /chats/:chat                      the game, as the pages are told of it
 *   POST /chats/:chat/hero                 { name, gender, origin, focus, color, lang }: the hero the player made
 *   POST /chats/:chat/scene/:id            { answer }: a choice, an action of their own, or "go on"
 *   POST /chats/:chat/puzzle/:id           { answer }: the puzzle's answer, or giving up
 *   POST /chats/:chat/combat/:id           { action }: one round of the fight
 *   POST /chats/:chat/combat/:id/end       the fight's end has been seen: it goes to the agent
 *   GET  /chats/:chat/picture?path=        a picture in the chat's folder, for a scene that shows one
 */

export interface RouteDeps {
  saga: Saga;
  isSaga(chatId: string): boolean;
  /** The hero was made in the panel: the agent is told, and starts the story. */
  begun(chatId: string, text: string): void;
}

const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

function refused(res: Response, e: unknown): void {
  if (e instanceof Refusal) return void res.status(409).json({ error: e.message });
  throw e;
}

function readAnswer(raw: unknown): Answer | undefined {
  const a = raw as { kind?: unknown; index?: unknown; text?: unknown } | null;
  if (!a || typeof a !== "object") return undefined;
  if (a.kind === "choice" && Number.isInteger(a.index)) return { kind: "choice", index: a.index as number };
  if (a.kind === "free" && typeof a.text === "string") return { kind: "free", text: a.text.slice(0, 2000) };
  if (a.kind === "continue") return { kind: "continue" };
  return undefined;
}

function readPuzzleAnswer(raw: unknown): PuzzleAnswer | undefined {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return undefined;
  if (a.giveUp === true) return { giveUp: true };
  if (Array.isArray(a.presses)) return { presses: a.presses.slice(0, 400) as number[] };
  if (Array.isArray(a.sequence)) return { sequence: a.sequence.slice(0, 40) as number[] };
  if (typeof a.hits === "number") return { hits: a.hits };
  if (typeof a.answer === "string") return { answer: a.answer.slice(0, 400) };
  return undefined;
}

function readAction(raw: unknown): CombatAction | undefined {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return undefined;
  const s = (v: unknown) => (typeof v === "string" ? v.slice(0, 80) : "");
  switch (a.action) {
    case "strike":
      return { action: "strike", target: s(a.target) };
    case "technique":
      return { action: "technique", target: s(a.target), technique: s(a.technique) };
    case "guard":
      return { action: "guard" };
    case "item":
      return { action: "item", item: s(a.item) };
    case "flee":
      return { action: "flee" };
  }
  return undefined;
}

export function routes(portal: ServerPortal, router: Router, deps: RouteDeps): void {
  const { saga } = deps;
  router.use(writesFromHere);

  const chatOf = (req: Request, res: Response): string | undefined => {
    const chatId = String(req.params.chat);
    if (!portal.chats.get(chatId)) return void res.status(404).json({ error: "No such chat" });
    if (!deps.isSaga(chatId)) return void res.status(409).json({ error: "This chat is not in Saga mode" });
    return chatId;
  };

  router.get("/chats/:chat", (req, res) => {
    const chatId = String(req.params.chat);
    if (!portal.chats.get(chatId)) return void res.status(404).json({ error: "No such chat" });
    res.json(deps.isSaga(chatId) ? saga.snapshot(chatId) : { type: "snapshot", saga: false, game: null });
  });

  router.post("/chats/:chat/hero", portal.http.json({ limit: "8kb" }), (req: Request, res: Response) => {
    const chatId = chatOf(req, res);
    if (!chatId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const lang = typeof body.lang === "string" && LANG.test(body.lang) ? body.lang : "en";
    try {
      const game = saga.begin(chatId, body, lang);
      deps.begun(chatId, `The player made their hero in the panel.\n${saga.beginText(game)}`);
      res.json(saga.snapshot(chatId));
    } catch (e) {
      refused(res, e);
    }
  });

  router.post("/chats/:chat/scene/:id", portal.http.json({ limit: "8kb" }), (req: Request, res: Response) => {
    const chatId = chatOf(req, res);
    if (!chatId) return;
    const answer = readAnswer((req.body ?? {}).answer);
    if (!answer) return void res.status(400).json({ error: "No answer" });
    try {
      res.json({ outcome: saga.answerScene(chatId, String(req.params.id), answer) });
    } catch (e) {
      refused(res, e);
    }
  });

  router.post("/chats/:chat/puzzle/:id", portal.http.json({ limit: "8kb" }), (req: Request, res: Response) => {
    const chatId = chatOf(req, res);
    if (!chatId) return;
    const answer = readPuzzleAnswer((req.body ?? {}).answer);
    if (!answer) return void res.status(400).json({ error: "No answer" });
    try {
      res.json({ outcome: saga.answerPuzzle(chatId, String(req.params.id), answer) });
    } catch (e) {
      refused(res, e);
    }
  });

  router.post("/chats/:chat/combat/:id", portal.http.json({ limit: "4kb" }), (req: Request, res: Response) => {
    const chatId = chatOf(req, res);
    if (!chatId) return;
    const action = readAction((req.body ?? {}).action);
    if (!action) return void res.status(400).json({ error: "No action" });
    try {
      res.json({ combat: saga.act(chatId, String(req.params.id), action) });
    } catch (e) {
      refused(res, e);
    }
  });

  router.post("/chats/:chat/combat/:id/end", (req: Request, res: Response) => {
    const chatId = chatOf(req, res);
    if (!chatId) return;
    try {
      res.json({ outcome: saga.endCombat(chatId, String(req.params.id)) });
    } catch (e) {
      refused(res, e);
    }
  });

  router.get("/chats/:chat/picture", (req: Request, res: Response) => {
    const chatId = chatOf(req, res);
    if (!chatId) return;
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    if (!rel) return void res.status(400).json({ error: "No path" });
    try {
      const file = portal.files.open(portal.chats.folder(chatId), rel, { likeParent: true, chats: [chatId] });
      if (!file.mimeType?.startsWith("image/")) {
        closeSync(file.fd);
        return void res.status(415).json({ error: "Not a picture" });
      }
      portal.http.send(req, res, file);
    } catch (e) {
      const code = (e as { code?: string }).code;
      res.status(code === "missing" ? 404 : 400).json({ error: "No such picture" });
    }
  });
}
