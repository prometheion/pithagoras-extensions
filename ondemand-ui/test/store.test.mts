import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CARDS_PER_CHAT } from "../src/limits.ts";
import { CardStore, summary } from "../src/server/store.ts";
import { scratch } from "./fakes.mts";

const made = (store: CardStore, chat = "chat-1", title = "Card") => store.create(chat, { callId: `call-${title}`, title, html: `<p>${title}</p>`, events: { pick: { wake: false } } });

test("cards are numbered in their chat, and kept for the portal alone, outliving the half", () => {
  const dir = scratch();
  const store = new CardStore(dir);
  assert.equal(made(store).id, "c1");
  assert.equal(made(store).id, "c2");
  assert.equal(made(store, "chat-2").id, "c1", "each chat counts its own");
  const again = new CardStore(dir);
  assert.deepEqual(again.cards("chat-1").map((c) => c.id), ["c1", "c2"]);
  assert.equal(again.body("chat-1", "c2")!.html, "<p>Card</p>");
  const files = readdirSync(path.join(dir, "chats"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  for (const f of files) assert.equal(statSync(path.join(f.parentPath, f.name)).mode & 0o777, 0o600, f.name);
});

test("data posted is numbered; new HTML leaves the data before with the old HTML unless data comes with it", () => {
  const store = new CardStore(scratch());
  const card = made(store);
  store.update("chat-1", card.id, { data: { value: { n: 1 } } });
  assert.deepEqual(store.body("chat-1", card.id), { html: "<p>Card</p>", data: { n: 1 } });
  assert.equal(store.card("chat-1", card.id)!.dataSeq, 1);
  const replaced = store.update("chat-1", card.id, { html: "<p>New</p>" });
  assert.equal(replaced.rev, 2);
  assert.deepEqual(store.body("chat-1", card.id), { html: "<p>New</p>" });
  const both = store.update("chat-1", card.id, { html: "<p>Both</p>", data: { value: [1] } });
  assert.deepEqual([both.rev, both.dataSeq], [3, 2]);
  assert.deepEqual(store.body("chat-1", card.id), { html: "<p>Both</p>", data: [1] });
});

test("a closed card says by whom; the pages are told its summary, without its HTML or data", () => {
  const store = new CardStore(scratch());
  const card = store.create("chat-1", { callId: "call-9", title: "Ask", html: "<p>secret-ish</p>", events: {}, wait: { event: "ok", timeoutSec: 60 } });
  store.close("chat-1", card.id, "person");
  const told = summary(store.card("chat-1", card.id)!);
  assert.deepEqual(told, { id: "c1", callId: "call-9", title: "Ask", events: {}, status: "closed", closedBy: "person", rev: 1, dataSeq: 0, wait: { event: "ok" } });
  assert.equal(store.close("chat-1", card.id, "agent")!.closedBy, "person", "closed once");
});

test("past the cards a chat keeps the oldest go, and a deleted chat's folder goes with it", () => {
  const dir = scratch();
  const store = new CardStore(dir);
  for (let i = 0; i < CARDS_PER_CHAT + 2; i++) made(store, "chat-1", `n${i}`);
  const ids = store.cards("chat-1").map((c) => c.id);
  assert.equal(ids.length, CARDS_PER_CHAT);
  assert.equal(ids[0], "c3");
  assert.equal(store.body("chat-1", "c1"), undefined);
  store.forget("chat-1");
  assert.equal(readdirSync(path.join(dir, "chats")).length, 0);
  assert.equal(existsSync(path.join(dir, "chats")), true);
  assert.deepEqual(new CardStore(dir).cards("chat-1"), []);
});
