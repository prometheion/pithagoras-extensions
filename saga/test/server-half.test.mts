import assert from "node:assert/strict";
import { test } from "node:test";
import { CUSTOM_TYPE } from "../src/server.ts";
import { TOOL_NAMES } from "../src/server/tools.ts";
import { MODE, fakePortal, json, tick } from "./fakes.mts";

/**
 * The server half as the portal starts it: the mode, the tools only in its chats and nothing else there, the game
 * master's prompt, and the game played through the tools and the panel's routes.
 */

async function start() {
  const fake = fakePortal();
  const { default: saga } = await import("../src/server.ts");
  const stop = saga(fake.portal);
  const at = await fake.serve();
  return { fake, at, stop };
}

const post = (url: string, body?: unknown) => json(url, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

async function withHero(fake: Awaited<ReturnType<typeof start>>["fake"], at: string, chatId = "a") {
  fake.chat(chatId);
  fake.piOf(chatId);
  const made = await post(`${at}/chats/${chatId}/hero`, { name: "Lin Feng", gender: "male", origin: "outer_disciple", focus: "mind", lang: "de" });
  assert.equal(made.status, 200);
  return made.body;
}

const SCENE = {
  title: "The Outer Court",
  location: "sect_courtyard",
  time: "dusk",
  cast: [{ name: "Wang Teng", look: "young_master", color: "violet" }],
  beats: [{ narrate: "Laughter rings out." }, { say: "Trash like you, a disciple?", who: "Wang Teng", mood: "smug" }, { fx: "aura", color: "violet" }],
  choices: [{ text: "Endure it" }, { text: "Strike first", check: { stat: "body", difficulty: "hard" } }],
  changes: [{ stones: 2 }],
  remember: "Wang Teng humiliated Lin Feng in the outer court.",
};

test("Saga offers a mode, and only chats in it have its tools, and only those", async () => {
  const { fake, stop } = await start();
  assert.deepEqual(fake.modes.map((m) => m.id), ["saga"]);
  fake.chat("plain", null);
  assert.equal(fake.piOf("plain").tools.size, 0, "a chat in another mode has nothing of Saga");
  fake.chat("a");
  const pi = fake.piOf("a");
  assert.deepEqual([...pi.tools.keys()].sort(), [...TOOL_NAMES].sort());
  const [answer] = await pi.fire("before_agent_start", { systemPrompt: "You are a coding agent." });
  assert.deepEqual(pi.active.at(-1), [...TOOL_NAMES], "the chat's other tools are switched off for its runs");
  pi.active.length = 0;
  await pi.fire("turn_start", {});
  assert.deepEqual(pi.active.at(-1), [...TOOL_NAMES], "and again before every request, should another extension have brought its tools back");
  const [blocked] = await pi.fire("tool_call", { toolName: "mcp" });
  assert.equal(blocked.block, true, "a call of any other tool is refused");
  assert.match(blocked.reason, /There is no tool "mcp" in Saga mode/);
  assert.deepEqual(await pi.fire("tool_call", { toolName: "saga_scene" }), [undefined]);
  assert.match(answer.systemPrompt, /^You are the game master/);
  assert.doesNotMatch(answer.systemPrompt, /coding agent/);
  assert.match(answer.systemPrompt, /There is no hero yet/);
  assert.deepEqual(fake.opened("a"), [{ type: "snapshot", saga: true, game: null }]);
  assert.deepEqual(fake.opened("plain"), [undefined]);
  stop();
});

test("the hero made in the panel starts the story: the agent is woken with a message", async () => {
  const { fake, at, stop } = await start();
  const snap = await withHero(fake, at);
  assert.equal(snap.game.hero.name, "Lin Feng");
  assert.equal(snap.game.language, "de");
  assert.equal(snap.game.hero.stats.mind, 4);
  const pi = fake.piOf("a");
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].message.customType, CUSTOM_TYPE);
  assert.match(pi.sent[0].message.content, /The player made their hero in the panel/);
  assert.deepEqual(pi.sent[0].options, { deliverAs: "steer", triggerTurn: true });
  // Told once: the next turn does not bring it again.
  const [answer] = await pi.fire("before_agent_start", {});
  assert.equal(answer.message, undefined);
  assert.match(answer.systemPrompt, /Write everything the player sees in German/);
  assert.match(answer.systemPrompt, /Hero: Lin Feng/);
  stop();
});

test("a route refuses a chat that is not in Saga mode, and a write from elsewhere", async () => {
  const { fake, at, stop } = await start();
  fake.chat("plain", null);
  assert.equal((await post(`${at}/chats/plain/hero`, { name: "X" })).status, 409);
  assert.equal((await post(`${at}/chats/nope/hero`, { name: "X" })).status, 404);
  fake.chat("a");
  assert.equal((await json(`${at}/chats/a/hero`, { method: "POST", body: "{}", origin: "https://evil.example" })).status, 403);
  stop();
});

test("a scene waits for the choice; the server rolls its check, and the call returns it", async () => {
  const { fake, at, stop } = await start();
  await withHero(fake, at);
  const tool = fake.piOf("a").tools.get("saga_scene");
  const call = tool.execute("c1", SCENE);
  await tick();
  const snap = (await json(`${at}/chats/a`)).body;
  const pending = snap.game.pending;
  assert.equal(pending.kind, "scene");
  assert.equal(pending.scene.location, "sect_courtyard");
  assert.equal(pending.scene.choices[1].check.stat, "body");
  assert.equal(typeof pending.scene.choices[1].check.chance, "number");
  assert.deepEqual(pending.scene.changes, [{ what: "stones", amount: 2 }]);
  assert.equal(snap.game.hero.stones, 7);
  assert.deepEqual(snap.game.chronicle, [SCENE.remember]);
  assert.equal((await post(`${at}/chats/a/scene/${pending.id}`, { answer: { kind: "choice", index: 9 } })).status, 409);
  const answered = await post(`${at}/chats/a/scene/${pending.id}`, { answer: { kind: "choice", index: 1 } });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.outcome.said, "Strike first");
  assert.ok(answered.body.outcome.roll);
  const result = await call;
  assert.match(result.content[0].text, /^The player chose: "Strike first"\. Body check \(hard, \d+%\): rolled \d+, (CRITICAL )?(SUCCESS|FAILURE)\./);
  assert.match(result.content[0].text, /Applied: Spirit stones \+2\./);
  const after = (await json(`${at}/chats/a`)).body.game;
  assert.equal(after.pending, undefined);
  assert.equal(after.outcome.said, "Strike first");
  assert.equal(after.last.location, "sect_courtyard", "the place stays on stage while the next is written");
  stop();
});

test("an action of the player's own, and a scene to watch only", async () => {
  const { fake, at, stop } = await start();
  await withHero(fake, at);
  const tool = fake.piOf("a").tools.get("saga_scene");
  let call = tool.execute("c1", { beats: ["The night is quiet."], location: "moonlit_cliff" });
  await tick();
  let id = (await json(`${at}/chats/a`)).body.game.pending.id;
  assert.equal((await post(`${at}/chats/a/scene/${id}`, { answer: { kind: "free", text: "  I meditate under the moon " } })).status, 200);
  assert.match((await call).content[0].text, /The player acts on their own: "I meditate under the moon"/);
  // Without choices the scene is watched, and goes on with "continue"; without a location it stays where it was.
  call = tool.execute("c2", { beats: [{ narrate: "Dawn comes." }], free: false });
  await tick();
  const pending = (await json(`${at}/chats/a`)).body.game.pending;
  assert.equal(pending.scene.location, "moonlit_cliff");
  assert.equal((await post(`${at}/chats/a/scene/${pending.id}`, { answer: { kind: "free", text: "no" } })).status, 409);
  assert.equal((await post(`${at}/chats/a/scene/${pending.id}`, { answer: { kind: "continue" } })).status, 200);
  assert.match((await call).content[0].text, /^The player has watched the scene\./);
  stop();
});

test("what the model gets wrong is refused in words it can correct, and what it nearly got right is noted", async () => {
  const { fake, at, stop } = await start();
  const tool = () => fake.piOf("a").tools.get("saga_scene");
  fake.chat("a");
  await assert.rejects(tool().execute("c0", SCENE), /There is no hero yet/);
  await withHero(fake, at);
  await assert.rejects(tool().execute("c1", { location: "sect_hall" }), /A scene needs "beats"/);
  await assert.rejects(tool().execute("c1", { location: "spaceship", beats: ["x"] }), /location: "spaceship" is not one of/);
  const call = tool().execute("c2", { location: "Sect Gate", weather: "drizzle", beats: ["Mist."], cast: [{ name: "Old Wu", look: "ninja" }] });
  await tick();
  const id = (await json(`${at}/chats/a`)).body.game.pending.id;
  await post(`${at}/chats/a/scene/${id}`, { answer: { kind: "continue" } });
  const text = (await call).content[0].text;
  assert.match(text, /Notes on your call/);
  assert.match(text, /weather: "drizzle" is not one of clear, mist/);
  assert.match(text, /look: "ninja"/);
  stop();
});

test("an answer that comes after the call stopped waiting goes to the agent as a message", async () => {
  const { fake, at, stop } = await start();
  await withHero(fake, at);
  const pi = fake.piOf("a");
  pi.sent.length = 0;
  const abort = new AbortController();
  const call = pi.tools.get("saga_scene").execute("c1", SCENE, abort.signal);
  await tick();
  abort.abort();
  assert.match((await call).content[0].text, /The run was stopped before the player answered/);
  const id = (await json(`${at}/chats/a`)).body.game.pending.id;
  await post(`${at}/chats/a/scene/${id}`, { answer: { kind: "choice", index: 0 } });
  await tick();
  assert.equal(pi.sent.length, 1);
  assert.match(pi.sent[0].message.content, /The player chose: &quot;Endure it&quot;|The player chose: "Endure it"/);
  stop();
});

test("a puzzle is made, checked by the server, and a breakthrough advances the realm", async () => {
  const { fake, at, stop } = await start();
  await withHero(fake, at);
  const pi = fake.piOf("a");
  const call = pi.tools.get("saga_puzzle").execute("c1", { kind: "breakthrough", title: "Body Tempering" });
  await tick();
  const pending = (await json(`${at}/chats/a`)).body.game.pending;
  assert.equal(pending.puzzle.kind, "breakthrough");
  await post(`${at}/chats/a/puzzle/${pending.id}`, { answer: { hits: pending.puzzle.needed } });
  const text = (await call).content[0].text;
  assert.match(text, /SUCCEEDED/);
  assert.match(text, /Realm: Body Tempering 1/);

  const riddle = pi.tools.get("saga_puzzle").execute("c2", { kind: "riddle", question: "What climbs without legs?", answer: "smoke", options: ["a snake", "smoke"] });
  await tick();
  const r = (await json(`${at}/chats/a`)).body.game.pending;
  assert.deepEqual(r.puzzle.options, ["a snake", "smoke"]);
  assert.equal(JSON.stringify(r).includes('"answers"'), false, "the page is not told the answer");
  await post(`${at}/chats/a/puzzle/${r.id}`, { answer: { answer: "a snake" } });
  assert.match((await riddle).content[0].text, /The player FAILED the puzzle/);
  await assert.rejects(pi.tools.get("saga_puzzle").execute("c3", { kind: "riddle", question: "?" }), /needs its "answer"/);
  stop();
});

test("a fight is played round by round through the panel, and its end goes to the call", async () => {
  const { fake, at, stop } = await start();
  await withHero(fake, at);
  const pi = fake.piOf("a");
  const call = pi.tools.get("saga_combat").execute("c1", { title: "Ambush", enemies: [{ name: "Bandit", look: "warrior", rank: "minion" }], location: "pine_forest" });
  await tick();
  const pending = (await json(`${at}/chats/a`)).body.game.pending;
  assert.equal(pending.combat.enemies[0].rank, "weak");
  assert.equal((await post(`${at}/chats/a/combat/${pending.id}/end`)).status, 409, "not over yet");
  let combat = pending.combat;
  for (let i = 0; i < 40 && !combat.over; i++) {
    const r = await post(`${at}/chats/a/combat/${pending.id}`, { action: { action: "strike", target: "e1" } });
    assert.equal(r.status, 200);
    combat = r.body.combat;
  }
  assert.ok(combat.over);
  assert.equal((await post(`${at}/chats/a/combat/${pending.id}`, { action: { action: "guard" } })).status, 409);
  assert.equal((await post(`${at}/chats/a/combat/${pending.id}/end`)).status, 200);
  assert.match((await call).content[0].text, /^The hero (won|was defeated|fled)/);
  stop();
});

test("saga_roll, saga_change and saga_status", async () => {
  const { fake, at, stop } = await start();
  await withHero(fake, at);
  const tools = fake.piOf("a").tools;
  assert.match((await tools.get("saga_roll").execute("c1", { stat: "fate", difficulty: "easy", reason: "Catch the falling jade" })).content[0].text, /^Catch the falling jade: Fate check \(easy, \d+%\)/);
  assert.ok((await json(`${at}/chats/a`)).body.game.outcome.roll, "the panel shows the dice");
  const changed = await tools.get("saga_change").execute("c2", { changes: [{ technique: "Azure Cloud Sword", element: "sword", power: 3 }] });
  assert.match(changed.content[0].text, /technique Azure Cloud Sword/);
  const status = await tools.get("saga_status").execute("c3", {});
  assert.match(status.content[0].text, /Techniques: Basic Palm Strike \(none, power 1\), Azure Cloud Sword \(sword, power 3\)/);
  stop();
});

test("a deleted chat's game goes with it", async () => {
  const { fake, at, stop } = await start();
  await withHero(fake, at);
  fake.life("deleted", "a");
  fake.chat("a");
  assert.equal((await json(`${at}/chats/a`)).body.game, null);
  stop();
});
