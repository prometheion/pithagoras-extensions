import type { Rng } from "./rules";
import type { PuzzleKind, PuzzleView } from "./types";

/**
 * The puzzles the panel plays: made by the server from a kind and a difficulty (and for a riddle, the model's question),
 * and checked by the server against what it kept back. A model asks for "a formation of difficulty 3"; it never has to
 * invent a grid or know a solution.
 *
 * - formation: a grid of array nodes; touching one flips it and its neighbours; light them all (lights out).
 * - runes: runes light up in an order, once; repeat it.
 * - breakthrough: qi circles the meridians; strike when it passes the gate, enough times before the tries run out.
 * - riddle: the model's question, answered by choosing or by writing.
 */

export const PUZZLE_KINDS: readonly PuzzleKind[] = ["formation", "runes", "breakthrough", "riddle"];

/** What the server keeps back to check an answer by. */
export interface PuzzleSecret {
  answers?: string[];
}

export type PuzzleAnswer = { presses: number[] } | { sequence: number[] } | { hits: number } | { answer: string } | { giveUp: true };

export function flip(grid: boolean[], size: number, at: number): void {
  const x = at % size;
  const y = Math.floor(at / size);
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < size && ny < size) grid[ny * size + nx] = !grid[ny * size + nx];
  }
}

export function makePuzzle(
  kind: PuzzleKind,
  difficulty: number,
  given: { title: string; intro?: string; question?: string; answers?: string[]; options?: string[] },
  rng: Rng,
): { view: PuzzleView; secret: PuzzleSecret } {
  const d = Math.min(5, Math.max(1, Math.round(difficulty)));
  const base = { kind, title: given.title, difficulty: d, ...(given.intro ? { intro: given.intro } : {}) };
  switch (kind) {
    case "formation": {
      const size = d <= 2 ? 3 : d <= 4 ? 4 : 5;
      const grid = Array<boolean>(size * size).fill(true);
      // Pressed from solved, so it can always be solved; never already solved.
      do {
        for (let i = 0; i < d + 2; i++) flip(grid, size, Math.floor(rng() * size * size));
      } while (grid.every(Boolean));
      return { view: { ...base, size, grid }, secret: {} };
    }
    case "runes": {
      const runes = d >= 4 ? 8 : 6;
      const sequence = Array.from({ length: 3 + d }, () => Math.floor(rng() * runes));
      return { view: { ...base, runes, sequence }, secret: {} };
    }
    case "breakthrough":
      return { view: { ...base, needed: 3, tries: 3 + (6 - d), window: Math.max(0.07, 0.24 - d * 0.03) }, secret: {} };
    case "riddle": {
      const options = given.options?.length ? given.options : undefined;
      return {
        view: { ...base, question: given.question ?? given.title, ...(options ? { options } : {}), attempts: options ? 1 : 2 },
        secret: { answers: given.answers ?? [] },
      };
    }
  }
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Whether a written answer is one of the answers: the same words, or the answer's words all in it. */
export function matches(answer: string, answers: string[]): boolean {
  const a = words(answer);
  if (!a) return false;
  return answers.some((want) => {
    const w = words(want);
    return !!w && (a === w || ` ${a} `.includes(` ${w} `));
  });
}

/** Whether the answer solves the puzzle. */
export function solves(view: PuzzleView, secret: PuzzleSecret, answer: PuzzleAnswer): boolean {
  if ("giveUp" in answer) return false;
  switch (view.kind) {
    case "formation": {
      if (!("presses" in answer) || !Array.isArray(answer.presses) || answer.presses.length > 400) return false;
      const size = view.size!;
      const grid = [...view.grid!];
      for (const p of answer.presses) {
        if (!Number.isInteger(p) || p < 0 || p >= size * size) return false;
        flip(grid, size, p);
      }
      return grid.every(Boolean);
    }
    case "runes":
      return "sequence" in answer && Array.isArray(answer.sequence) && answer.sequence.length === view.sequence!.length && answer.sequence.every((r, i) => r === view.sequence![i]);
    case "breakthrough":
      return "hits" in answer && typeof answer.hits === "number" && answer.hits >= view.needed! && answer.hits <= view.tries!;
    case "riddle":
      return "answer" in answer && typeof answer.answer === "string" && matches(answer.answer, secret.answers ?? []);
  }
}
