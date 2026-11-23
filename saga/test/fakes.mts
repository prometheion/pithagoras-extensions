import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import express from "express";
import { UI_RECEIVE } from "../src/server.ts";

/**
 * What the unit tests run the server half against: a portal that keeps what the half tells it, offers its mode, and
 * makes each chat's pi as the portal does (every factory called with it), with pi's own event bus.
 */

export const EXTENSION = "@pithagoras/saga";
export const MODE = `${EXTENSION}/saga`;

export function scratch(prefix = "saga-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function fakePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const bus = new Map<string, ((data: unknown) => void)[]>();
  const sent: { message: any; options: any }[] = [];
  const active: string[][] = [];
  const pi = {
    registerTool: (tool: any) => void tools.set(tool.name, tool),
    on: (event: string, handler: (...args: any[]) => any) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    setActiveTools: (names: string[]) => void active.push(names),
    events: {
      on: (channel: string, handler: (data: unknown) => void) => void bus.set(channel, [...(bus.get(channel) ?? []), handler]),
      emit: (channel: string, data: unknown) => {
        for (const h of bus.get(channel) ?? []) h(data);
      },
    },
    sendMessage: (message: any, options: any) => void sent.push({ message, options }),
  };
  return { pi, tools, sent, active, fire: async (event: string, payload: unknown = {}) => Promise.all((handlers.get(event) ?? []).map((h) => h(payload, {}))) };
}

export function fakePortal() {
  const router = express.Router();
  const factories: ((pi: any, chat: any) => void)[] = [];
  const opens: ((chatId: string) => unknown)[] = [];
  const life = new Map<string, ((chatId: string) => void)[]>();
  const pushed: { chatId: string; data: any }[] = [];
  const told: { chatId: string; data: any }[] = [];
  const modes: any[] = [];
  const logs: string[] = [];
  const dataDir = scratch("saga-data-");
  const chats = new Map<string, { id: string; title: string; workspace: string; status: string; mode?: string }>();
  const pis = new Map<string, ReturnType<typeof fakePi>>();
  const portal = {
    version: 1,
    extension: EXTENSION,
    executor: "host",
    log: (text: string) => void logs.push(text),
    router,
    http: { json: express.json, raw: express.raw, text: express.text, send: () => {} },
    dataDir: () => dataDir,
    modes: {
      provide: (mode: any) => {
        modes.push(mode);
        return `${EXTENSION}/${mode.id}`;
      },
    },
    files: { open: () => ({ fd: -1, size: 0, name: "x", mtime: 0, change: "" }) },
    chats: {
      get: (id: string) => chats.get(id),
      folder: () => "/nowhere",
      send: (chatId: string, data: unknown) => void pushed.push({ chatId, data }),
      onOpen: (fn: (chatId: string) => unknown) => void opens.push(fn),
      onEvent: () => {},
      on: (event: string, fn: (chatId: string) => void) => void life.set(event, [...(life.get(event) ?? []), fn]),
      extend: (factory: (pi: any, chat: any) => void) => void factories.push(factory),
      tell: async (chatId: string, data: unknown) => {
        told.push({ chatId, data });
        piOf(chatId).pi.events.emit(UI_RECEIVE, { extension: EXTENSION, data });
        return true;
      },
    },
  };
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
    pushed,
    told,
    modes,
    logs,
    chat(id: string, mode: string | null = MODE) {
      chats.set(id, { id, title: id, workspace: "/nowhere", status: "idle", ...(mode ? { mode } : {}) });
      return chats.get(id)!;
    },
    piOf,
    opened: (chatId: string) => opens.map((fn) => fn(chatId)),
    life: (event: string, chatId: string) => (life.get(event) ?? []).forEach((fn) => fn(chatId)),
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
  return { status: answer.status, body };
}

/** Lets what was started settle: a call that waits has registered its wait. */
export const tick = () => new Promise((r) => setImmediate(r));
