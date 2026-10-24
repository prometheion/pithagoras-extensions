import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimiter } from "../src/server/rate.ts";

test("a card may send its burst at once, then as fast as its bucket fills", () => {
  const limiter = new RateLimiter({ burst: 3, perSec: 2 }, { burst: 100, perSec: 100 });
  const at = 1_000_000;
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.take("chat", "c1", at)), [true, true, true, false]);
  assert.equal(limiter.take("chat", "c1", at + 400), false, "0.8 of an event later");
  assert.equal(limiter.take("chat", "c1", at + 500), true, "one event later");
  assert.equal(limiter.take("chat", "c2", at), true, "another card has its own");
});

test("a chat's cards share the chat's bucket", () => {
  const limiter = new RateLimiter({ burst: 10, perSec: 10 }, { burst: 4, perSec: 1 });
  const at = 5000;
  const taken = ["c1", "c2", "c3", "c4", "c5"].map((card) => limiter.take("chat", card, at));
  assert.deepEqual(taken, [true, true, true, true, false]);
  assert.equal(limiter.take("other", "c1", at), true, "another chat has its own");
  limiter.forget("chat");
  assert.equal(limiter.take("chat", "c5", at), true, "a deleted chat's buckets go");
});
