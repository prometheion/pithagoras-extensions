/**
 * A trailing debounce with a ceiling: each value pushed waits `waitMs` for another, and the last one is sent once
 * none came for that long, or once `maxWaitMs` has passed since the first of the burst, whichever is first. So a
 * slider dragged for ten seconds reports every `maxWaitMs`, and a click reports `waitMs` after it.
 */

export interface Clock {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Debounced<T> {
  push(value: T): void;
  /** Sends what waits now, if anything does. */
  flush(): void;
  /** Drops what waits. */
  cancel(): void;
  waiting(): boolean;
}

export function debounce<T>(send: (value: T) => void, waitMs: number, maxWaitMs: number, clock: Clock = realClock): Debounced<T> {
  let timer: unknown;
  let first: number | undefined;
  let pending: { value: T } | undefined;
  const stop = () => {
    if (timer !== undefined) clock.clear(timer);
    timer = undefined;
  };
  const flush = () => {
    stop();
    const held = pending;
    pending = undefined;
    first = undefined;
    if (held) send(held.value);
  };
  return {
    push(value) {
      const now = clock.now();
      pending = { value };
      first ??= now;
      stop();
      timer = clock.set(flush, Math.max(0, Math.min(waitMs, first + maxWaitMs - now)));
    },
    flush,
    cancel() {
      stop();
      pending = undefined;
      first = undefined;
    },
    waiting: () => pending !== undefined,
  };
}
