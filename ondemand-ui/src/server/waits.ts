/**
 * The ui_show calls that wait for an event of their card (`wait`), as ask_question waits for its answers: until the
 * card sends that event (the call returns its data), the time is up, the card is closed (by the person, or by the agent
 * with ui_close), the run is stopped (the call's signal), or this server half stops. One call waits on a card, the one
 * that made it. What the card sends after the wait is over goes to the agent as any of its events does.
 */

export type Outcome =
  | { kind: "event"; data: unknown }
  | { kind: "timeout" }
  | { kind: "closed"; by: "agent" | "person" }
  | { kind: "stopped" }
  | { kind: "ended" };

interface Waiting {
  event: string;
  done(outcome: Outcome): void;
}

const keyOf = (chatId: string, cardId: string) => `${chatId}\u0000${cardId}`;

export class Waits {
  private readonly waiting = new Map<string, Waiting>();

  wait(chatId: string, cardId: string, event: string, ms: number, signal?: AbortSignal): Promise<Outcome> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve({ kind: "stopped" });
      const key = keyOf(chatId, cardId);
      const timer = setTimeout(() => done({ kind: "timeout" }), ms);
      const onAbort = () => done({ kind: "stopped" });
      const done = (outcome: Outcome) => {
        if (this.waiting.get(key) !== entry) return;
        this.waiting.delete(key);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const entry: Waiting = { event, done };
      this.waiting.set(key, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** The event a call waits for on this card, if one does. */
  waitsFor(chatId: string, cardId: string): string | undefined {
    return this.waiting.get(keyOf(chatId, cardId))?.event;
  }

  /** An event of a card: true where a call waited for it, which now has it. */
  answer(chatId: string, cardId: string, event: string, data: unknown): boolean {
    const waiting = this.waiting.get(keyOf(chatId, cardId));
    if (!waiting || waiting.event !== event) return false;
    waiting.done({ kind: "event", data });
    return true;
  }

  /** The card was closed: true where a call waited on it. */
  close(chatId: string, cardId: string, by: "agent" | "person"): boolean {
    const waiting = this.waiting.get(keyOf(chatId, cardId));
    waiting?.done({ kind: "closed", by });
    return !!waiting;
  }

  /** Every wait of a chat, or of every chat, ended: the chat was deleted, or this server half stops. */
  end(chatId?: string): void {
    for (const [key, waiting] of [...this.waiting]) if (chatId === undefined || key.startsWith(`${chatId}\u0000`)) waiting.done({ kind: "ended" });
  }
}
