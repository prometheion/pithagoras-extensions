import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFighter, playRound, refuse, startCombat } from "../src/game/combat.ts";
import { flip, makePuzzle, matches, solves } from "../src/game/puzzles.ts";
import { Refusal, readBeats, readCast, readChanges, readChoices, readPlace, readPicture } from "../src/game/read.ts";
import { advance, apply, chanceOf, check, level, newHero, realmLabel, roll } from "../src/game/rules.ts";
import { XIANXIA } from "../src/game/xianxia.ts";

/** The rules and what a model writes, read: the parts of the game that need no server. */

const pack = XIANXIA;
const hero = () => newHero(pack, { name: "Lin Feng", gender: "male", origin: "outer_disciple" });
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test("a new hero has its origin's stats, items and stones, the basic technique, and full vitality and qi", () => {
  const h = newHero(pack, { name: "Su Yue", gender: "female", origin: "reincarnated", focus: "mind" });
  assert.deepEqual(h.stats, { body: 2, mind: 6, spirit: 5, fate: 2 });
  assert.equal(h.look, "heroine");
  assert.equal(h.hp, h.hpMax);
  assert.equal(h.qi, h.qiMax);
  assert.deepEqual(h.techniques, [pack.basicTechnique]);
  assert.equal(realmLabel(pack, h), "Mortal");
});

test("a check is a coin toss at the difficulty's value, held to 5..95, and the roll is low-is-good with criticals", () => {
  const h = hero();
  h.stats.mind = 4;
  assert.equal(chanceOf(h, "mind", "normal"), 50);
  assert.equal(chanceOf(h, "mind", "impossible"), 5);
  assert.equal(chanceOf(h, "mind", "trivial"), 86);
  h.stats.mind = 20;
  assert.equal(chanceOf(h, "mind", "trivial"), 95);
  const c = { stat: "mind" as const, difficulty: "normal" as const, chance: 50 };
  assert.deepEqual(roll(c, () => 0.0), { ...c, roll: 1, success: true, critical: true });
  assert.equal(roll(c, () => 0.3).success, true);
  assert.equal(roll(c, () => 0.6).success, false);
  assert.equal(roll(c, () => 0.99).critical, true);
});

test("a breakthrough climbs the stages, then the realms, and stops at the peak", () => {
  const h = hero();
  h.progress = 100;
  assert.deepEqual(advance(h, pack), [{ what: "realm", name: "Body Tempering 1", amount: 1 }]);
  assert.equal(h.progress, 0);
  for (let i = 0; i < 9; i++) advance(h, pack);
  assert.equal(realmLabel(pack, h), "Qi Condensation 1");
  assert.equal(h.hp, h.hpMax);
  assert.ok(level(h, pack) > 0);
  h.realm = pack.realms.length - 1;
  h.step = 0;
  assert.deepEqual(advance(h, pack), []);
});

test("changes are held to what they may be, and say what they did", () => {
  const h = hero();
  const applied = apply(h, pack, [
    { what: "body", amount: 5 },
    { what: "hp", amount: -1000 },
    { what: "stones", amount: -999 },
    { what: "progress", amount: 150 },
    { what: "item", name: "Qi Gathering Pill", amount: -5, kind: "pill" },
    { what: "item", name: "Jade Slip", amount: 1, kind: "manual" },
    { what: "technique", name: "Azure Sword", element: "sword", power: 3 },
    { what: "technique", name: "azure sword", element: "sword", power: 3 },
    { what: "bond", name: "Lin Yue", amount: 30 },
  ]);
  assert.equal(h.hp, 1, "vitality never below 1 from a change");
  assert.equal(h.stones, 0);
  assert.equal(h.progress, 100);
  assert.equal(h.stats.body, 6, "a stat moves at most 2 at once");
  assert.deepEqual(h.items, [{ name: "Jade Slip", kind: "manual", amount: 1 }]);
  assert.equal(h.techniques.length, 2, "a technique is learned once");
  assert.deepEqual(h.bonds, [{ name: "Lin Yue", affinity: 30 }]);
  assert.deepEqual(
    applied.map((a) => a.what),
    ["body", "hp", "stones", "progress", "item", "item", "technique", "bond"],
  );
});

test("what a small model writes is read leniently, and what was taken in its place is said back", () => {
  const notes: string[] = [];
  assert.equal(readPlace(pack, "Sect Hall", notes), "sect_hall");
  assert.equal(readPlace(pack, "mountain peak", notes), "mountain_peak");
  assert.equal(readPlace(pack, "mountian_peak", notes), "mountain_peak");
  assert.throws(() => readPlace(pack, "spaceship", []), Refusal);
  const beats = readBeats(
    [
      "The wind howls.",
      { type: "say", speaker: "Elder Mo", text: "Kneel!", emotion: "furious" },
      { narration: "Silence." },
      { effect: "tribulation lightning" },
      { thought: "Not today." },
      { say: "", who: "" },
    ],
    notes,
  );
  assert.deepEqual(beats, [
    { kind: "narrate", text: "The wind howls." },
    { kind: "say", who: "Elder Mo", text: "Kneel!", mood: "angry" },
    { kind: "narrate", text: "Silence." },
    { kind: "fx", fx: "lightning" },
    { kind: "think", text: "Not today." },
  ]);
  assert.deepEqual(readBeats('[{"narrate": "As JSON in a string"}]', []), [{ kind: "narrate", text: "As JSON in a string" }]);
  const cast = readCast([{ name: "Elder Mo", look: "Grandmaster" }, "Wang Teng"], notes);
  assert.deepEqual(cast, [
    { name: "Elder Mo", look: "elder", color: "gold", side: "right" },
    { name: "Wang Teng", look: "disciple", color: "silver", side: "left" },
  ]);
  const choices = readChoices(["Bow", { text: "Refuse", check: { stat: "will", difficulty: "very hard" } }, { label: "Run", stat: "luck", difficulty: "medium" }], hero(), notes);
  assert.deepEqual(choices[0], { text: "Bow" });
  assert.deepEqual(choices[1].check && [choices[1].check.stat, choices[1].check.difficulty], ["spirit", "heroic"]);
  assert.deepEqual(choices[2].check && [choices[2].check.stat, choices[2].check.difficulty], ["fate", "normal"]);
  assert.ok(notes.length > 0);
});

test("changes in every shape a model writes them", () => {
  const notes: string[] = [];
  assert.deepEqual(readChanges({ hp: -5, "spirit stones": "+3" }, notes), [
    { what: "hp", amount: -5 },
    { what: "stones", amount: 3 },
  ]);
  assert.deepEqual(
    readChanges([{ type: "item", name: "Pill", amount: 2, kind: "pill" }, { stat: "xp", amount: 10 }, { technique: "Flame Palm", element: "fire" }, { bond: "Lin Yue", amount: 5 }, { nonsense: 1 }], notes),
    [
      { what: "item", name: "Pill", amount: 2, kind: "pill" },
      { what: "progress", amount: 10 },
      { what: "technique", name: "Flame Palm", element: "fire", power: 2 },
      { what: "bond", name: "Lin Yue", amount: 5 },
    ],
  );
  assert.match(notes.at(-1)!, /was not understood/);
});

test("a picture is only a relative path to a picture in the chat's folder", () => {
  const notes: string[] = [];
  assert.equal(readPicture("art/peak.png", notes), "art/peak.png");
  assert.equal(readPicture("./peak.JPG", notes), "peak.JPG");
  for (const bad of ["/etc/passwd.png", "../x.png", "https://x.org/a.png", "notes.txt"]) assert.equal(readPicture(bad, notes), undefined);
});

test("a fight: blows, guarding, pills, foes falling, victory", () => {
  const h = hero();
  h.items.push({ name: "Healing Pill", kind: "pill", amount: 1 });
  const foe = makeFighter("e1", { name: "Bandit", look: "warrior", color: "silver", rank: "weak", element: "none" }, h, pack);
  const c = startCombat("Ambush", { location: "pine_forest", time: "day", weather: "clear" }, [foe], true);
  assert.equal(refuse(c, h, { action: "strike", target: "e9" }), "No such foe standing.");
  assert.equal(refuse(c, h, { action: "item", item: "Nothing" }), "No such pill.");
  h.hp = 10;
  playRound(c, h, pack, { action: "item", item: "Qi Gathering Pill" }, () => 0.5);
  assert.ok(h.hp > 10 - foe.power, "healed before the foe struck");
  const rng = seq(0.5);
  while (!c.over) playRound(c, h, pack, { action: "strike", target: "e1" }, rng);
  assert.equal(c.over, "victory");
  assert.equal(foe.state, "down");
  assert.equal(refuse(c, h, { action: "guard" }), "The fight is over.");
});

test("a fight lost leaves the hero at 1 vitality, and a boss is harder to flee", () => {
  const h = hero();
  const boss = makeFighter("e1", { name: "Demon Lord", look: "demon", color: "crimson", rank: "boss", element: "shadow" }, h, pack);
  const c = startCombat("Doom", { location: "demon_realm", time: "night", weather: "embers" }, [boss], true);
  while (!c.over) playRound(c, h, pack, { action: "guard" }, () => 0.5);
  assert.equal(c.over, "defeat");
  assert.equal(h.hp, 1);
  const none = startCombat("x", { location: "arena", time: "day", weather: "clear" }, [boss], false);
  assert.equal(refuse(none, h, { action: "flee" }), "There is no fleeing from this fight.");
});

test("puzzles are made solvable, and checked by the server", () => {
  const f = makePuzzle("formation", 3, { title: "Seal" }, seq(0.1, 0.5, 0.9, 0.3, 0.7));
  assert.equal(f.view.size, 4);
  assert.ok(!f.view.grid!.every(Boolean));
  // Solve it by brute force over the first row's presses (lights out is solved by chasing down).
  const size = f.view.size!;
  let solution: number[] | undefined;
  for (let mask = 0; mask < 1 << size && !solution; mask++) {
    const grid = [...f.view.grid!];
    const presses: number[] = [];
    for (let x = 0; x < size; x++) if (mask & (1 << x)) (flip(grid, size, x), presses.push(x));
    for (let y = 1; y < size; y++) for (let x = 0; x < size; x++) if (!grid[(y - 1) * size + x]) (flip(grid, size, y * size + x), presses.push(y * size + x));
    if (grid.every(Boolean)) solution = presses;
  }
  assert.ok(solution, "a formation can be solved");
  assert.equal(solves(f.view, f.secret, { presses: solution! }), true);
  assert.equal(solves(f.view, f.secret, { presses: [] }), false);
  assert.equal(solves(f.view, f.secret, { presses: [999] }), false);

  const r = makePuzzle("runes", 2, { title: "Runes" }, seq(0.2, 0.8));
  assert.equal(r.view.sequence!.length, 5);
  assert.equal(solves(r.view, r.secret, { sequence: r.view.sequence! }), true);
  assert.equal(solves(r.view, r.secret, { sequence: [...r.view.sequence!].reverse() }), r.view.sequence!.join() === [...r.view.sequence!].reverse().join());

  const b = makePuzzle("breakthrough", 5, { title: "Breakthrough" }, Math.random);
  assert.equal(solves(b.view, b.secret, { hits: 3 }), true);
  assert.equal(solves(b.view, b.secret, { hits: 2 }), false);
  assert.equal(solves(b.view, b.secret, { hits: 99 }), false);

  const q = makePuzzle("riddle", 1, { title: "Riddle", question: "What has roots nobody sees?", answers: ["A mountain"] }, Math.random);
  assert.equal(q.view.question, "What has roots nobody sees?");
  assert.equal((q.view as any).answers, undefined, "the answer is not in what the page is given");
  assert.equal(solves(q.view, q.secret, { answer: "a  Mountain!" }), true);
  assert.equal(solves(q.view, q.secret, { answer: "it is a mountain" }), true);
  assert.equal(solves(q.view, q.secret, { answer: "a tree" }), false);
  assert.equal(matches("", ["x"]), false);
  assert.equal(solves(q.view, q.secret, { giveUp: true }), false);
});

test("a check made for a choice carries its chance", () => {
  const h = hero();
  assert.deepEqual(check(h, "fate", "hard"), { stat: "fate", difficulty: "hard", chance: chanceOf(h, "fate", "hard") });
});
