import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import express from "express";
import { EXTENSION, UI_RECEIVE } from "../src/limits.ts";

/**
 * What the unit tests run the server half against: a portal that keeps what the half tells it and asks of it, and a
 * chat's pi that keeps what is registered in it, with pi's own event bus, as `chats.extend` hands one over.
 */

/** A temporary folder, removed when the tests end. */
export function scratch(prefix = "iui-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A chat's pi, as far as the half uses it: its tools, its handlers, its bus, and the messages it is given. */
export function fakePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const bus = new Map<string, ((data: unknown) => void)[]>();
  const sent: { message: any; options: any }[] = [];
  const pi = {
    registerTool: (tool: any) => void tools.set(tool.name, tool),
    on: (event: string, handler: (...args: any[]) => any) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    events: {
      on: (channel: string, handler: (data: unknown) => void) => {
        bus.set(channel, [...(bus.get(channel) ?? []), handler]);
        return () => bus.set(channel, (bus.get(channel) ?? []).filter((h) => h !== handler));
      },
      emit: (channel: string, data: unknown) => {
        for (const h of bus.get(channel) ?? []) h(data);
      },
    },
    sendMessage: (message: any, options: any) => void sent.push({ message, options }),
  };
  return {
    pi,
    tools,
    sent,
    /** What pi's handlers for `event` answer, as pi asks them. */
    fire: async (event: string, payload: unknown = {}) => Promise.all((handlers.get(event) ?? []).map((h) => h(payload, {}))),
  };
}

export function fakePortal() {
  const router = express.Router();
  const factories: ((pi: any, chat: any) => void)[] = [];
  const opens: ((chatId: string) => unknown)[] = [];
  const events: ((chatId: string, event: Record<string, unknown>) => void)[] = [];
  const life = new Map<string, ((chatId: string) => void)[]>();
  const pushed: { chatId: string; data: any }[] = [];
  const told: { chatId: string; data: any }[] = [];
  const logs: string[] = [];
  const dataDir = scratch("iui-data-");
  const chats = new Map<string, { id: string; title: string; workspace: string; status: "idle" | "running" | "error" | "interrupted" }>();
  const pis = new Map<string, ReturnType<typeof fakePi>>();
  /** Whether `chats.tell` reaches a pi: false, as where pi does not run in the portal's process. */
  let reachable = true;
  const portal = {
    version: 1,
    extension: EXTENSION,
    executor: "host",
    log: (text: string) => void logs.push(text),
    router,
    http: { json: express.json, raw: express.raw, text: express.text },
    dataDir: () => dataDir,
    chats: {
      get: (id: string) => chats.get(id),
      send: (chatId: string, data: unknown) => void pushed.push({ chatId, data }),
      onOpen: (fn: (chatId: string) => unknown) => void opens.push(fn),
      onEvent: (fn: (chatId: string, event: Record<string, unknown>) => void) => void events.push(fn),
      on: (event: string, fn: (chatId: string) => void) => void life.set(event, [...(life.get(event) ?? []), fn]),
      extend: (factory: (pi: any, chat: any) => void) => void factories.push(factory),
      // As the portal's: to the package's pi extension in the chat, over pi's bus, starting the chat's pi if need be.
      tell: async (chatId: string, data: unknown) => {
        told.push({ chatId, data });
        if (!reachable) return false;
        piOf(chatId).pi.events.emit(UI_RECEIVE, { extension: EXTENSION, data });
        return true;
      },
    },
  };
  /** The chat's pi, made as the portal makes one: every factory of the half called with it. */
  function piOf(chatId: string) {
    let made = pis.get(chatId);
    if (!made) {
      made = fakePi();
      pis.set(chatId, made);
      for (const factory of factories) factory(made.pi, chats.get(chatId));
    }
    return made;
  }
  return {
    portal: portal as any,
    dataDir,
    pushed,
    told,
    logs,
    chat(id: string, status: "idle" | "running" = "idle") {
      chats.set(id, { id, title: id, workspace: "/nowhere", status });
      return chats.get(id)!;
    },
    piOf,
    unreachable: () => void (reachable = false),
    opened: (chatId: string) => opens.map((fn) => fn(chatId)),
    /** As the chat's pi says it: to every `onEvent` handler. */
    event: (chatId: string, event: Record<string, unknown>) => events.forEach((fn) => fn(chatId, event)),
    life: (event: string, chatId: string) => (life.get(event) ?? []).forEach((fn) => fn(chatId)),
    /** The router served as the portal serves it, at /api/x/<package>. */
    async serve() {
      const app = express().use(`/api/x/${EXTENSION}`, router);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      after(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/x/${EXTENSION}`;
    },
  };
}

/** A request as the portal's own pages make one: from its origin. */
export async function json(url: string, init: RequestInit & { origin?: string } = {}) {
  const { origin, ...rest } = init;
  const answer = await fetch(url, { ...rest, headers: { "content-type": "application/json", origin: origin ?? new URL(url).origin, ...(rest.headers as Record<string, string>) } });
  const text = await answer.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: answer.status, body, headers: answer.headers };
}
