import { useEffect, useRef, useState } from "react";
import { flip, type PuzzleAnswer } from "../game/puzzles";
import type { Pending, PuzzleView as View } from "../game/types";
import { t } from "../portal";
import { api } from "./api";
import type { Stage } from "./engine/stage";

/**
 * The puzzles, played over the stage: what the server made of a kind and a difficulty, and what the player does sent
 * back for the server to check. The stage plays along (an aura while the formation turns, lightning on a breakthrough).
 */

const RUNES = ["天", "地", "玄", "黄", "宇", "宙", "洪", "荒"];

export function PuzzleView({ chatId, pending, stage }: { chatId: string; pending: Extract<Pending, { kind: "puzzle" }>; stage: Stage }) {
  const p = pending.puzzle;
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [intro, setIntro] = useState(!!p.intro);

  useEffect(() => {
    stage.setFigures([]);
    stage.play(p.kind === "breakthrough" ? "aura" : "golden_light", p.kind === "breakthrough" ? "azure" : "gold");
  }, []);

  async function send(answer: PuzzleAnswer, fx?: Parameters<Stage["play"]>[0]) {
    if (sent) return;
    setSent(true);
    if (fx) stage.play(fx);
    try {
      // A moment for the stage to play what happened before the panel moves on.
      await new Promise((r) => setTimeout(r, fx ? 1200 : 200));
      await api.puzzle(chatId, pending.id, answer);
    } catch (e) {
      setError((e as Error).message);
      setSent(false);
    }
  }

  return (
    <div className="saga-puzzle">
      <div className="saga-puzzle-head">
        <strong>{p.title}</strong>
        <span>{"★".repeat(p.difficulty)}</span>
      </div>
      {intro ? (
        <div className="saga-puzzle-intro">
          <p>{p.intro}</p>
          <button type="button" className="saga-choice is-continue" onClick={() => setIntro(false)}>
            {t("Begin")} ▸
          </button>
        </div>
      ) : (
        <>
          {p.kind === "formation" && <Formation view={p} disabled={sent} onSolved={(presses) => send({ presses }, "golden_light")} />}
          {p.kind === "runes" && <Runes view={p} disabled={sent} onDone={(sequence, right) => send({ sequence }, right ? "golden_light" : "darkness")} />}
          {p.kind === "breakthrough" && <Breakthrough view={p} stage={stage} disabled={sent} onDone={(hits, ok) => send({ hits }, ok ? "breakthrough" : "lightning")} />}
          {p.kind === "riddle" && <Riddle view={p} disabled={sent} onAnswer={(answer) => send({ answer })} />}
          {p.kind !== "breakthrough" && (
            <button type="button" className="saga-giveup" disabled={sent} onClick={() => send({ giveUp: true })}>
              {t("Give up")}
            </button>
          )}
        </>
      )}
      {error && <div className="saga-error">{error}</div>}
    </div>
  );
}

function Formation({ view, disabled, onSolved }: { view: View; disabled: boolean; onSolved(presses: number[]): void }) {
  const size = view.size!;
  const [grid, setGrid] = useState(view.grid!);
  const [presses, setPresses] = useState<number[]>([]);
  const lit = grid.filter(Boolean).length;
  function press(i: number) {
    if (disabled) return;
    const next = [...grid];
    flip(next, size, i);
    const all = [...presses, i];
    setGrid(next);
    setPresses(all);
    if (next.every(Boolean)) onSolved(all);
  }
  return (
    <div className="saga-formation-wrap">
      <p className="saga-hint">{t("Touch a node to turn it and its neighbours. Light every node of the array.")}</p>
      <div className="saga-formation" style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}>
        {grid.map((on, i) => (
          <button key={i} type="button" className={`saga-node ${on ? "is-on" : ""}`} onClick={() => press(i)} aria-pressed={on} aria-label={t("Node {n}", { n: i + 1 })} />
        ))}
      </div>
      <div className="saga-puzzle-foot">
        <span>
          {lit}/{grid.length}
        </span>
        <span>{t("Moves: {n}", { n: presses.length })}</span>
        <button
          type="button"
          disabled={disabled || !presses.length}
          onClick={() => {
            setGrid(view.grid!);
            setPresses([]);
          }}
        >
          {t("Reset")}
        </button>
      </div>
    </div>
  );
}

function Runes({ view, disabled, onDone }: { view: View; disabled: boolean; onDone(sequence: number[], right: boolean): void }) {
  const seq = view.sequence!;
  const count = view.runes!;
  const [showing, setShowing] = useState<number | null>(-1);
  const [input, setInput] = useState<number[]>([]);
  const [flash, setFlash] = useState<number | null>(null);
  const speed = Math.max(380, 900 - view.difficulty * 100);
  useEffect(() => {
    if (showing === null) return;
    const timer = setTimeout(() => setShowing(showing + 1 >= seq.length ? null : showing + 1), showing < 0 ? 900 : speed);
    return () => clearTimeout(timer);
  }, [showing]);
  const lit = showing !== null && showing >= 0 ? seq[showing] : flash;
  function press(r: number) {
    if (showing !== null || disabled) return;
    setFlash(r);
    setTimeout(() => setFlash(null), 200);
    const next = [...input, r];
    setInput(next);
    const wrong = next.some((x, i) => x !== seq[i]);
    if (wrong || next.length === seq.length) onDone(next, !wrong);
  }
  return (
    <div className="saga-runes-wrap">
      <p className="saga-hint">{showing !== null ? t("Watch the runes light up…") : t("Now touch them in the same order.")}</p>
      <div className={`saga-runes is-${count}`}>
        {Array.from({ length: count }, (_, r) => (
          <button key={r} type="button" className={`saga-rune ${lit === r ? "is-lit" : ""}`} onClick={() => press(r)} disabled={showing !== null || disabled}>
            {RUNES[r]}
          </button>
        ))}
      </div>
      <div className="saga-puzzle-foot">
        <span>
          {input.length}/{seq.length}
        </span>
      </div>
    </div>
  );
}

function Breakthrough({ view, stage, disabled, onDone }: { view: View; stage: Stage; disabled: boolean; onDone(hits: number, ok: boolean): void }) {
  const needed = view.needed!;
  const tries = view.tries!;
  const win = view.window! * Math.PI * 2;
  const [hits, setHits] = useState(0);
  const [used, setUsed] = useState(0);
  const [gate, setGate] = useState(() => Math.random() * Math.PI * 2);
  const [mark, setMark] = useState<"hit" | "miss" | null>(null);
  const angle = useRef(0);
  const dot = useRef<SVGCircleElement>(null);
  const speed = 2.2 + view.difficulty * 0.55;
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      angle.current = (angle.current + ((now - last) / 1000) * speed) % (Math.PI * 2);
      last = now;
      if (dot.current) {
        dot.current.setAttribute("cx", String(50 + Math.cos(angle.current - Math.PI / 2) * 40));
        dot.current.setAttribute("cy", String(50 + Math.sin(angle.current - Math.PI / 2) * 40));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  function strike() {
    if (disabled || used >= tries || hits >= needed) return;
    const d = Math.abs(((angle.current - gate + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const hit = d <= win / 2;
    const h = hits + (hit ? 1 : 0);
    const u = used + 1;
    setHits(h);
    setUsed(u);
    setMark(hit ? "hit" : "miss");
    setTimeout(() => setMark(null), 300);
    stage.play(hit ? "aura" : "shake", hit ? "gold" : undefined);
    setGate(Math.random() * Math.PI * 2);
    if (h >= needed) onDone(h, true);
    else if (u >= tries || tries - u < needed - h) onDone(h, false);
  }
  const arc = (from: number, to: number) => {
    const p = (a: number) => `${50 + Math.cos(a - Math.PI / 2) * 40} ${50 + Math.sin(a - Math.PI / 2) * 40}`;
    return `M ${p(from)} A 40 40 0 ${to - from > Math.PI ? 1 : 0} 1 ${p(to)}`;
  };
  return (
    <div className="saga-break-wrap">
      <p className="saga-hint">{t("Guide the qi through the gate: strike when it passes the glowing arc.")}</p>
      <button type="button" className={`saga-break ${mark ? `is-${mark}` : ""}`} onClick={strike} disabled={disabled}>
        <svg viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r="40" className="saga-break-ring" />
          <path d={arc(gate - win / 2, gate + win / 2)} className="saga-break-gate" />
          <circle ref={dot} cx="50" cy="10" r="4" className="saga-break-dot" />
          <text x="50" y="55" textAnchor="middle">
            {hits}/{needed}
          </text>
        </svg>
      </button>
      <div className="saga-puzzle-foot">
        <span>{t("Tries left: {n}", { n: tries - used })}</span>
      </div>
    </div>
  );
}

function Riddle({ view, disabled, onAnswer }: { view: View; disabled: boolean; onAnswer(answer: string): void }) {
  const [text, setText] = useState("");
  return (
    <div className="saga-riddle">
      <p className="saga-riddle-q">{view.question}</p>
      {view.options?.length ? (
        <div className="saga-choices is-inline">
          {view.options.map((o) => (
            <button key={o} type="button" className="saga-choice" disabled={disabled} onClick={() => onAnswer(o)}>
              {o}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="saga-free"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onAnswer(text.trim());
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Your answer…")} disabled={disabled} maxLength={200} />
          <button type="submit" disabled={disabled || !text.trim()}>
            ▸
          </button>
        </form>
      )}
    </div>
  );
}
