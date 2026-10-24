import assert from "node:assert/strict";
import { test } from "node:test";
import { DEBOUNCE_DEFAULT_MS, EVENTS_MAX, Refusal, debounceOf, declares, maxWaitFor, readEvents, readWait, utf8Length } from "../src/limits.ts";

test("events as the model writes them: an object of names, the short forms, and debounceMs held to 100..10000", () => {
  assert.deepEqual(readEvents({ change: { debounceMs: 600 }, submit: { wake: true }, pick: {} }), { change: { debounceMs: 600, wake: false }, submit: { wake: true }, pick: { wake: false } });
  assert.deepEqual(readEvents(["a", "b"]), { a: { wake: false }, b: { wake: false } });
  assert.deepEqual(readEvents({ a: true }), { a: { wake: false } });
  assert.deepEqual(readEvents({ fast: { debounceMs: 5 }, slow: { debounceMs: 99_999 } }), { fast: { debounceMs: 100, wake: false }, slow: { debounceMs: 10_000, wake: false } });
  assert.deepEqual(readEvents(undefined), {});
});

test("a name that is not one, a wrong value and too many events are said to the model", () => {
  assert.throws(() => readEvents({ "1st": {} }), Refusal);
  assert.throws(() => readEvents({ "a b": {} }), /not one/);
  assert.throws(() => readEvents({ a: { wake: "yes" } }), /wake is true or false/);
  assert.throws(() => readEvents({ a: { debounceMs: "fast" } }), /number of milliseconds/);
  assert.throws(() => readEvents("submit"), /is an object/);
  assert.throws(() => readEvents(Object.fromEntries(Array.from({ length: EVENTS_MAX + 1 }, (_, i) => [`e${i}`, {}]))), /at most/);
});

test("an event named after an object's own members is a name like any other", () => {
  const events = readEvents(JSON.parse('{"constructor": {"wake": true}, "hasOwnProperty": {}}'));
  assert.deepEqual(Object.keys(events).sort(), ["constructor", "hasOwnProperty"]);
  assert.deepEqual(events.constructor, { wake: true });
  assert.equal(declares(events, undefined, "toString"), false, "a name the object has from its prototype is not declared");
  assert.equal(declares(events, undefined, "constructor"), true);
  assert.equal(debounceOf(events, "toString", 300), 300);
  assert.throws(() => readEvents(JSON.parse('{"__proto__": {}}')), /not one/, "nor can a name reach the prototype");
});

test("wait: its event, and timeoutSec held to 5..3600, 600 when not said", () => {
  assert.deepEqual(readWait({ event: "submit" }), { event: "submit", timeoutSec: 600 });
  assert.deepEqual(readWait({ event: "ok", timeoutSec: 1 }), { event: "ok", timeoutSec: 5 });
  assert.deepEqual(readWait({ event: "ok", timeoutSec: 1e6 }), { event: "ok", timeoutSec: 3600 });
  assert.equal(readWait(undefined), undefined);
  assert.throws(() => readWait({}), /wait.event/);
  assert.throws(() => readWait({ event: "ok", timeoutSec: "soon" }), /seconds/);
});

test("a card takes its declared events and the one its call waits for, each with its debounce or the default", () => {
  const events = readEvents({ change: { debounceMs: 250 }, submit: {} });
  assert.equal(declares(events, { event: "done" }, "done"), true);
  assert.equal(declares(events, { event: "done" }, "other"), false);
  assert.equal(debounceOf(events, "change", 700), 250);
  assert.equal(debounceOf(events, "submit", 700), 700);
  assert.equal(debounceOf(events, "done", DEBOUNCE_DEFAULT_MS), 400, "the waited event has the default");
  assert.equal(maxWaitFor(400), 1600);
  assert.equal(maxWaitFor(100), 1000);
});

test("a text's size is counted in UTF-8 bytes, as it is sent", () => {
  for (const s of ["", "abc", "ä", "€", "😀", "a😀b€", "\ud800"]) assert.equal(utf8Length(s), Buffer.byteLength(s, "utf8"), JSON.stringify(s));
});
