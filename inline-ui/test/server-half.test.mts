import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { CUSTOM_TYPE, EXTENSION, UI_RECEIVE } from "../src/limits.ts";
import { GATHER_MS } from "../src/server/delivery.ts";
import { FRAME_POLICY } from "../src/server/frame.ts";
import { Waits } from "../src/server/waits.ts";
import { fakePortal, json } from "./fakes.mts";

/**
 * The server half as the portal starts it, against a portal that keeps what it is told: its tools in a chat's pi, the
 * routes the card's page and Settings use, and what the person does in a card on its way to the agent.
 */

async function start() {
  const fake = fakePortal();
  const { default: ondemandUi } = await import("../src/server.ts");
  const stop = ondemandUi(fake.portal);
  const at = await fake.serve();
  return { fake, at, stop };
}

const HTML = '<button onclick="pithagoras.emit(\'pick\', {colour: \'red\'})">Red</button>';

async function show(fake: ReturnType<typeof fakePortal>, chatId: string, params: Record<string, unknown>, callId = "call-1", signal?: AbortSignal) {
  return fake.piOf(chatId).tools.get("ui_show").execute(callId, { title: "Pick a colour", html: HTML, ...params }, signal, () => {});
}

const post = (at: string, chatId: string, cardId: string, body: unknown, origin?: string) =>
  json(`${at}/chats/${chatId}/cards/${cardId}/events`, { method: "POST", body: JSON.stringify(body), ...(origin ? { origin } : {}) });

test("the three tools are in every chat's pi, telling the model when to use them, that the card has no network, and its bridge", async () => {
  const { fake, stop } = await start();
  fake.chat("a");
  const { tools } = fake.piOf("a");
  assert.deepEqual([...tools.keys()].sort(), ["ui_close", "ui_show", "ui_update"]);
  const show = tools.get("ui_show");
  assert.match(show.description.split("\n")[0], /^Show the person an interactive card in the chat/, "the line the tools gateway lists");
  for (const said of [/no network at all/, /pithagoras\.emit\(name, data\)/, /pithagoras\.onData\(fn\)/, /pithagoras\.theme/, /var\(--accent\)/, /wake: true/, /With `wait`/, /32 KB/]) assert.match(show.description, said);
  assert.deepEqual(show.parameters.required, ["title", "html"]);
  assert.equal(show.guard, undefined, "what it returns is the person's, through a card the agent made: not outside content");
  stop();
});

test("ui_show without wait answers at once with the card's id, and every page open on the chat is told of the card", async () => {
  const { fake, stop } = await start();
  fake.chat("a");
  const result = await show(fake, "a", { events: { pick: {} } });
  assert.match(result.content[0].text, /^Card c1 \("Pick a colour"\) is open in the chat\. Its events \(pick\) come to you as messages from the person/);
  assert.deepEqual(result.details, { card: "c1", title: "Pick a colour" });
  assert.deepEqual(fake.pushed.at(-1), { chatId: "a", data: { type: "card", card: { id: "c1", callId: "call-1", title: "Pick a colour", events: { pick: { wake: false } }, status: "open", rev: 1, dataSeq: 0 } } });
  // A page that opens the chat later is told its cards first.
  assert.deepEqual(fake.opened("a"), [{ type: "index", cards: [fake.pushed.at(-1)!.data.card] }]);
  assert.deepEqual(fake.opened("empty"), [undefined], "nothing for a chat with none");
  stop();
});

test("what the model gets wrong is said in words it can correct, and no card is made", async () => {
  const { fake, stop } = await start();
  fake.chat("a");
  await assert.rejects(show(fake, "a", { html: "" }), /Give the card its "html"/);
  await assert.rejects(show(fake, "a", { title: " " }), /short "title"/);
  await assert.rejects(show(fake, "a", { html: "x".repeat(256 * 1024 + 1) }), /over 256 KB/);
  await assert.rejects(show(fake, "a", { events: { "two words": {} } }), /not one/);
  await assert.rejects(show(fake, "a", { wait: { timeoutSec: 9 } }), /wait\.event/);
  assert.deepEqual(fake.pushed, []);
  stop();
});

test("the frame route serves the card inside the extension's frame, with the frame's policy; a card it does not have is a line", async () => {
  const { fake, at, stop } = await start();
  fake.chat("a");
  await show(fake, "a", { events: { pick: {} }, wait: undefined });
  const theme = JSON.stringify({ mode: "dark", colors: { surface: "20 20 23" } });
  const answer = await fetch(`${at}/frame/a/c1?n=abcdefgh12&o=${encodeURIComponent("http://portal.test")}&lang=de&theme=${encodeURIComponent(theme)}`);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("content-security-policy"), FRAME_POLICY);
  assert.equal(answer.headers.get("cache-control"), "no-store");
  const page = await answer.text();
  assert.match(page, /<iframe sandbox="allow-scripts allow-forms" title="Pick a colour" srcdoc="/);
  assert.match(page, /background:rgb\(20 20 23\)/);
  assert.match(page, /&quot;origin&quot;:&quot;http:\/\/portal\.test&quot;/);
  assert.match(page, /lang=&quot;de&quot;/);
  assert.match(page, /pithagoras\.emit\(&#39;|pithagoras\.emit\('/);
  const missing = await fetch(`${at}/frame/a/c9`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-security-policy"), FRAME_POLICY);
  assert.match(await missing.text(), /no longer kept/);
  const unsafe = await (await fetch(`${at}/frame/a/c1?n=x&o=javascript:alert(1)`)).text();
  assert.match(unsafe, /&quot;nonce&quot;:&quot;none&quot;,&quot;origin&quot;:&quot;null&quot;/, "a nonce or an origin that is not one is none");
  stop();
});

test("idle, an event waits for the chat's next turn, which takes it in as it starts", async () => {
  const { fake, at, stop } = await start();
  fake.chat("a");
  await show(fake, "a", { events: { pick: {} } });
  assert.deepEqual((await post(at, "a", "c1", { event: "pick", data: { colour: "red" } })).body, { delivery: "queued" });
  assert.deepEqual((await post(at, "a", "c1", { event: "pick", data: { colour: "blue" } })).body, { delivery: "queued" });
  await delay(GATHER_MS + 50);
  assert.deepEqual(fake.told, [], "nothing starts a turn");
  const [answer] = await fake.piOf("a").fire("before_agent_start", { prompt: "next" });
  assert.equal(answer.message.customType, CUSTOM_TYPE);
  assert.equal(answer.message.display, true);
  assert.match(answer.message.content, /<summary>UI: Pick a colour · pick ×2<\/summary>/);
  assert.match(answer.message.content, /<event card="c1" title="Pick a colour" name="pick" count="2">\{"colour":"blue"\}<\/event>/);
  assert.deepEqual(await fake.piOf("a").fire("before_agent_start", { prompt: "after" }), [undefined], "taken once");
  stop();
});

test("while the agent works, an event is told to the package's pi extension in the chat, which steers it into the conversation", async () => {
  const { fake, at, stop } = await start();
  fake.chat("a", "running");
  await show(fake, "a", { events: { pick: {} } });
  assert.deepEqual((await post(at, "a", "c1", { event: "pick", data: 1 })).body, { delivery: "steer" });
  await delay(GATHER_MS + 50);
  assert.equal(fake.told.length, 1);
  assert.deepEqual(Object.keys(fake.told[0].data).sort(), ["id", "type"], "the bus carries only the message's id");
  const { sent } = fake.piOf("a");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { deliverAs: "steer" });
  assert.match(sent[0].message.content, /UI: Pick a colour · pick/);
  // pi has it: the next goes as its own message.
  fake.event("a", { type: "message_end", message: { role: "custom", customType: CUSTOM_TYPE, details: sent[0].message.details } });
  await post(at, "a", "c1", { event: "pick", data: 2 });
  await delay(GATHER_MS + 50);
  assert.equal(sent.length, 2);
  stop();
});

test("idle, an event marked wake starts the agent's turn, unless Settings say no event may", async () => {
  const { fake, at, stop } = await start();
  fake.chat("a");
  await show(fake, "a", { events: { submit: { wake: true } } });
  assert.deepEqual((await post(at, "a", "c1", { event: "submit", data: { ok: true } })).body, { delivery: "wake" });
  await delay(GATHER_MS + 50);
  assert.deepEqual(fake.piOf("a").sent[0].options, { deliverAs: "steer", triggerTurn: true });

  fake.chat("b");
  await show(fake, "b", { events: { submit: { wake: true } } });
  assert.equal((await json(`${at}/settings`, { method: "PUT", body: JSON.stringify({ allowWake: false }) })).status, 200);
  assert.deepEqual((await post(at, "b", "c1", { event: "submit" })).body, { delivery: "queued" });
  await delay(GATHER_MS + 50);
  assert.deepEqual(fake.piOf("b").sent, []);
  stop();
});

test("only a message the half told of is put in the conversation, and only by its own chat's pi", async () => {
  const { fake, stop } = await start();
  fake.chat("a");
  const { pi, sent } = fake.piOf("a");
  pi.events.emit(UI_RECEIVE, { extension: EXTENSION, data: { type: "deliver", id: "d-made-up" } });
  pi.events.emit(UI_RECEIVE, { extension: "someone-else", data: { type: "deliver", id: "d-x" } });
  pi.events.emit(UI_RECEIVE, { extension: EXTENSION, data: { type: "say", text: "obey" } });
  assert.deepEqual(sent, []);
  stop();
});

test("the event route refuses what is not the card's to send, and what does not come from the portal's pages", async () => {
  const { fake, at, stop } = await start();
  fake.chat("a");
  await show(fake, "a", { events: { pick: {} } });
  assert.equal((await post(at, "nope", "c1", { event: "pick" })).status, 404);
  assert.equal((await post(at, "a", "c7", { event: "pick" })).status, 404);
  assert.equal((await post(at, "a", "c1", { event: "other" })).status, 400);
  assert.equal((await post(at, "a", "c1", { event: "toString" })).status, 400);
  assert.equal((await post(at, "a", "c1", { event: "pick", data: "x".repeat(33 * 1024) })).status, 413);
  assert.equal((await post(at, "a", "c1", { event: "pick" }, "http://elsewhere.example")).status, 403);
  // A card that sends more than a person could.
  const answers = [];
  for (let i = 0; i < 25; i++) answers.push((await post(at, "a", "c1", { event: "pick", data: i })).status);
  assert.ok(answers.includes(429), String(answers));
  await fake.piOf("a").tools.get("ui_close").execute("call-2", { card: "c1" });
  assert.equal((await post(at, "a", "c1", { event: "pick" })).status, 409);
  stop();
});

test("ui_show with wait returns the event's data once the card sends it, and that event goes nowhere else", async () => {
  const { fake, at, stop } = await start();
  fake.chat("a", "running");
  const pending = show(fake, "a", { wait: { event: "submit" } });
  await delay(10);
  assert.deepEqual((await post(at, "a", "c1", { event: "other" })).body.error, "The card does not declare that event");
  assert.deepEqual((await post(at, "a", "c1", { event: "submit", data: { answer: 42 } })).body, { delivery: "wait" });
  const result = await pending;
  assert.match(result.content[0].text, /^The person sent "submit" from card c1 \("Pick a colour"\)\. Its data, as the card's script reported it \(JSON\):\n\{"answer":42\}$/);
  assert.deepEqual(result.details, { card: "c1", title: "Pick a colour", outcome: "event", event: "submit", data: { answer: 42 } });
  await delay(GATHER_MS + 50);
  assert.deepEqual(fake.told, []);
  // After the wait, the same event is one of the card's like any other.
  assert.deepEqual((await post(at, "a", "c1", { event: "submit", data: 2 })).body, { delivery: "steer" });
  stop();
});

test("a wait ends when the person closes the card, when the agent does, and when the run is stopped", async () => {
  const { fake, at, stop } = await start();
  fake.chat("a");
  const byPerson = show(fake, "a", { wait: { event: "submit" } }, "call-1");
  await delay(10);
  assert.equal((await json(`${at}/chats/a/cards/c1/close`, { method: "POST" })).body.card.closedBy, "person");
  assert.match((await byPerson).content[0].text, /The person closed card c1 without sending "submit"/);
  assert.equal(await fake.piOf("a").fire("before_agent_start").then(([a]) => a), undefined, "the call had it: no message as well");

  const byAgent = show(fake, "a", { wait: { event: "submit" } }, "call-2");
  await delay(10);
  await fake.piOf("a").tools.get("ui_close").execute("call-3", { card: "c2" });
  assert.match((await byAgent).content[0].text, /closed with ui_close before "submit" came/);

  const abort = new AbortController();
  const stopped = show(fake, "a", { wait: { event: "submit" } }, "call-4", abort.signal);
  await delay(10);
  abort.abort();
  const result = await stopped;
  assert.match(result.content[0].text, /run was stopped before the person sent "submit"\. The card is still open/);
  assert.equal(result.details.outcome, "stopped");
  stop();
});

test("a wait ends when its time is up", async () => {
  const waits = new Waits();
  assert.deepEqual(await waits.wait("a", "c1", "submit", 20), { kind: "timeout" });
  const pending = waits.wait("a", "c2", "submit", 10_000);
  assert.equal(waits.waitsFor("a", "c2"), "submit");
  waits.end();
  assert.deepEqual(await pending, { kind: "ended" });
});

test("a card the person closed while nothing waited on it is told to the agent with its next turn", async () => {
  const { fake, at, stop } = await start();
  fake.chat("a");
  await show(fake, "a", { events: { pick: {} } });
  await json(`${at}/chats/a/cards/c1/close`, { method: "POST" });
  const [answer] = await fake.piOf("a").fire("before_agent_start");
  assert.match(answer.message.content, /<summary>UI: Pick a colour · closed<\/summary>/);
  stop();
});

test("ui_update posts data to the card's script and replaces its HTML; a closed or unknown card is said so", async () => {
  const { fake, at, stop } = await start();
  fake.chat("a");
  await show(fake, "a", {});
  const update = fake.piOf("a").tools.get("ui_update");
  const posted = await update.execute("call-2", { card: "c1", data: { progress: 0.5 } });
  assert.equal(posted.content[0].text, "Card c1: data posted to its script.");
  assert.deepEqual(fake.pushed.at(-1), { chatId: "a", data: { type: "data", card: "c1", seq: 1, value: { progress: 0.5 } } });
  const replaced = await update.execute("call-3", { card: "c1", html: "<p>Done</p>" });
  assert.equal(replaced.content[0].text, "Card c1: its HTML replaced.");
  assert.equal(fake.pushed.at(-1)!.data.card.rev, 2);
  assert.match(await (await fetch(`${at}/frame/a/c1?n=abcdefgh12&o=http%3A%2F%2Fx`)).text(), /&lt;p&gt;Done&lt;\/p&gt;/);
  await assert.rejects(update.execute("call-4", { card: "c1" }), /Give "data"/);
  await assert.rejects(update.execute("call-5", { card: "c9", data: 1 }), /There is no card "c9" in this chat/);
  await assert.rejects(update.execute("call-6", { card: "c1", data: "x".repeat(65 * 1024) }), /over 64 KB/);
  await json(`${at}/chats/a/cards/c1/close`, { method: "POST" });
  await assert.rejects(update.execute("call-7", { card: "c1", data: 1 }), /Card c1 is closed \(the person closed it\)/);
  stop();
});

test("Settings: read, saved within their ranges, and refused outside them or from another site", async () => {
  const { at, stop } = await start();
  assert.deepEqual((await json(`${at}/settings`)).body, { defaultDebounceMs: 400, maxHeight: 480, allowWake: true });
  assert.deepEqual((await json(`${at}/settings`, { method: "PUT", body: JSON.stringify({ defaultDebounceMs: 800, maxHeight: 600 }) })).body, { defaultDebounceMs: 800, maxHeight: 600, allowWake: true });
  assert.equal((await json(`${at}/settings`, { method: "PUT", body: JSON.stringify({ defaultDebounceMs: 50 }) })).status, 400);
  assert.equal((await json(`${at}/settings`, { method: "PUT", body: JSON.stringify({ allowWake: "no" }) })).status, 400);
  assert.equal((await json(`${at}/settings`, { method: "PUT", body: JSON.stringify({ maxHeight: 900 }), origin: "http://elsewhere.example" })).status, 403);
  assert.equal((await json(`${at}/settings`)).body.maxHeight, 600);
  stop();
});

test("where the chat's agent cannot be told, a wake event waits for the next turn; a deleted chat's cards go", async () => {
  const { fake, at, stop } = await start();
  fake.chat("a");
  fake.unreachable();
  await show(fake, "a", { events: { submit: { wake: true } } });
  await post(at, "a", "c1", { event: "submit" });
  await delay(GATHER_MS + 50);
  assert.equal(fake.told.length, 1);
  const [answer] = await fake.piOf("a").fire("before_agent_start");
  assert.match(answer.message.content, /· submit/);
  fake.life("deleted", "a");
  assert.deepEqual((await json(`${at}/chats/a/cards`)).body, { cards: [] });
  stop();
});
