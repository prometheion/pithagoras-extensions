import assert from "node:assert/strict";
import { test } from "node:test";
import { debounce, type Clock } from "../src/debounce.ts";

/** A clock that moves only when the test says, running what is due as it goes. */
function manual() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    set: (fn, ms) => {
      const id = next++;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (id) => void due.delete(id as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const first = [...due.entries()].sort((a, b) => a[1].at - b[1].at).find(([, d]) => d.at <= until);
      if (!first) break;
      now = first[1].at;
      due.delete(first[0]);
      first[1].fn();
    }
    now = until;
  };
  return { clock, advance };
}

test("the last value goes once nothing came for the wait", () => {
  const { clock, advance } = manual();
  const sent: number[] = [];
  const d = debounce((v: number) => sent.push(v), 400, 1600, clock);
  d.push(1);
  advance(300);
  d.push(2);
  advance(300);
  d.push(3);
  advance(399);
  assert.deepEqual(sent, []);
  advance(1);
  assert.deepEqual(sent, [3]);
  assert.equal(d.waiting(), false);
});

test("input that never pauses still goes once the ceiling has passed since the first of the burst", () => {
  const { clock, advance } = manual();
  const sent: number[] = [];
  const d = debounce((v: number) => sent.push(v), 400, 1600, clock);
  // Every 100 ms for 4 seconds, as a slider dragged.
  for (let i = 1; i <= 40; i++) {
    d.push(i);
    advance(100);
  }
  assert.deepEqual(sent, [16, 32], "every 1600 ms, the latest value then");
  advance(400);
  assert.deepEqual(sent, [16, 32, 40], "and the last one once it stops");
});

test("flush sends what waits at once, and cancel drops it", () => {
  const { clock, advance } = manual();
  const sent: string[] = [];
  const d = debounce((v: string) => sent.push(v), 400, 1600, clock);
  d.push("a");
  d.flush();
  assert.deepEqual(sent, ["a"]);
  d.flush();
  assert.deepEqual(sent, ["a"], "nothing waits: nothing sent");
  d.push("b");
  d.cancel();
  advance(5000);
  assert.deepEqual(sent, ["a"]);
});
