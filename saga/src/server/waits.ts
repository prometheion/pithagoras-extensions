/**
 * The calls that wait for the player: a scene for a choice, a puzzle for its end, a fight for its last round. One
 * thing waits in a chat at a time (the game's `pending`), and the call that made it waits on it, until the player
 * answers (the call returns what became of it), the time is up, the run is stopped (the call's signal), or this server
 * half stops. What the player answers after that goes to the agent as a message.
 */

export type Waited<T> = { kind: "answer"; value: T } | { kind: "timeout" } | { kind: "stopped" } | { kind: "ended" };

interface Waiting {
  id: string;
  done(outcome: Waited<unknown>): void;
}

export class Waits {
  private readonly waiting = new Map<string, Waiting>();

  wait<T>(chatId: string, id: string, ms: number, signal?: AbortSignal): Promise<Waited<T>> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve({ kind: "stopped" });
      // A call that waited before in the chat is over: there is one thing to answer at a time.
      this.waiting.get(chatId)?.done({ kind: "ended" });
      const timer = setTimeout(() => done({ kind: "timeout" }), ms);
      const onAbort = () => done({ kind: "stopped" });
      const done = (outcome: Waited<unknown>) => {
        if (this.waiting.get(chatId) !== entry) return;
        this.waiting.delete(chatId);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome as Waited<T>);
      };
      const entry: Waiting = { id, done };
      this.waiting.set(chatId, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  waits(chatId: string, id: string): boolean {
    return this.waiting.get(chatId)?.id === id;
  }

  /** The player's answer: true where a call waited for it, which now has it. */
  answer(chatId: string, id: string, value: unknown): boolean {
    const waiting = this.waiting.get(chatId);
    if (!waiting || waiting.id !== id) return false;
    waiting.done({ kind: "answer", value });
    return true;
  }

  end(chatId?: string): void {
    for (const [key, waiting] of [...this.waiting]) if (chatId === undefined || key === chatId) waiting.done({ kind: "ended" });
  }
}
