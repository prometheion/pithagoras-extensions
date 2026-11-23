import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PuzzleSecret } from "../game/puzzles";
import type { Game } from "../game/types";

/**
 * Each chat's game, kept in the extension's own folder (`portal.dataDir()`, which no agent can write: the hero's
 * numbers are the server's, not something a model or a script in the chat could edit). One file a chat, by a hash of
 * its id, written whole. Beside the game, what checks the puzzle that waits (its answer), which no page is told.
 * Also what the player answered while no call waited for it, to go to the agent with its next turn.
 */

export interface Kept {
  chat: string;
  game: Game | null;
  secret?: PuzzleSecret;
  /** An answer no call waited for: told to the agent as a message (see server.ts). */
  late?: { id: string; text: string; delivered: boolean };
}

function writeWhole(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

export class GameStore {
  private readonly chats = new Map<string, Kept>();

  constructor(private readonly dir: string) {}

  private file(chatId: string): string {
    return path.join(this.dir, "games", `${createHash("sha256").update(chatId).digest("hex").slice(0, 32)}.json`);
  }

  get(chatId: string): Kept {
    let kept = this.chats.get(chatId);
    if (!kept) {
      try {
        const read = JSON.parse(readFileSync(this.file(chatId), "utf8")) as Kept;
        kept = read && read.chat === chatId ? read : { chat: chatId, game: null };
      } catch {
        kept = { chat: chatId, game: null };
      }
      this.chats.set(chatId, kept);
    }
    return kept;
  }

  game(chatId: string): Game | null {
    return this.get(chatId).game;
  }

  /** Changes what is kept for a chat, and writes it. */
  change(chatId: string, fn: (kept: Kept) => void): Kept {
    const kept = this.get(chatId);
    fn(kept);
    mkdirSync(path.dirname(this.file(chatId)), { recursive: true, mode: 0o700 });
    writeWhole(this.file(chatId), kept);
    return kept;
  }

  forget(chatId: string): void {
    this.chats.delete(chatId);
    rmSync(this.file(chatId), { force: true });
  }
}
