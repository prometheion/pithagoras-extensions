/**
 * How many events a card, and a chat, may send: a bucket of each that fills at a steady rate up to a burst. The page
 * already sends each event at most once per debounce; this is for a card whose script sends more than a person could.
 */

interface Bucket {
  tokens: number;
  at: number;
}

export interface Rate {
  burst: number;
  perSec: number;
}

export const CARD_RATE: Rate = { burst: 20, perSec: 5 };
export const CHAT_RATE: Rate = { burst: 60, perSec: 10 };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly card: Rate = CARD_RATE,
    private readonly chat: Rate = CHAT_RATE,
  ) {}

  private has(key: string, rate: Rate, now: number): Bucket {
    const was = this.buckets.get(key) ?? { tokens: rate.burst, at: now };
    const bucket = { tokens: Math.min(rate.burst, was.tokens + ((now - was.at) / 1000) * rate.perSec), at: now };
    this.buckets.set(key, bucket);
    return bucket;
  }

  /** Takes one event of a card's: false, and nothing taken, where the card or its chat has sent too many lately. */
  take(chatId: string, cardId: string, now = Date.now()): boolean {
    const chat = this.has(`chat\u0000${chatId}`, this.chat, now);
    const card = this.has(`card\u0000${chatId}\u0000${cardId}`, this.card, now);
    if (chat.tokens < 1 || card.tokens < 1) return false;
    chat.tokens--;
    card.tokens--;
    return true;
  }

  forget(chatId: string): void {
    for (const key of [...this.buckets.keys()]) if (key === `chat\u0000${chatId}` || key.startsWith(`card\u0000${chatId}\u0000`)) this.buckets.delete(key);
  }
}
