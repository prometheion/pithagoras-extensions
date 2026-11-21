import { useEffect, useMemo, useRef, useState } from "react";
import { LuChevronsRight, LuSend } from "react-icons/lu";
import { COLOR_RGB } from "../game/pack";
import type { CastMember, Game, Pending } from "../game/types";
import { packOf } from "../game/xianxia";
import { t } from "../portal";
import { api } from "./api";
import { fxDuration } from "./engine/fx";
import type { Stage, StageFigure } from "./engine/stage";
import { rgba } from "./engine/util";
import { Toasts, type usePrefs } from "./Panel";
import { DIFFICULTY_LABEL } from "./words";

/**
 * A scene, played: its title over the stage, then each beat in turn (narration, a line said with its speaker lit, a
 * thought, an effect that plays by itself), at the player's pace or by itself; then its choices, with the chance of
 * each that rolls, and a line for an action of the player's own.
 */

const SPOTS: Record<CastMember["side"], number[]> = { left: [0.2, 0.36, 0.1], right: [0.8, 0.64, 0.9], center: [0.5, 0.5, 0.5] };

export function castFigures(cast: CastMember[], chatId: string): StageFigure[] {
  const used: Record<string, number> = { left: 0, right: 0, center: 0 };
  return cast.map((c) => {
    const spots = SPOTS[c.side];
    const x = spots[Math.min(spots.length - 1, used[c.side]++)];
    return { id: c.name, look: c.look, color: c.color, x, facing: x < 0.5 ? 1 : -1, ...(c.picture ? { picture: api.picture(chatId, c.picture) } : {}) };
  });
}

type Prefs = ReturnType<typeof usePrefs>;

export function ScenePlayer({ chatId, game, pending, stage, prefs }: { chatId: string; game: Game; pending: Extract<Pending, { kind: "scene" }>; stage: Stage; prefs: Prefs }) {
  const scene = pending.scene;
  const pack = packOf(game.pack);
  const [titleShown, setTitleShown] = useState(!!scene.title);
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState(0);
  const [free, setFree] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const figures = useMemo(() => castFigures(scene.cast, chatId), [pending.id]);
  const beat = scene.beats[index];
  const atEnd = index >= scene.beats.length;
  const text = beat && beat.kind !== "fx" ? beat.text : "";
  const done = typed >= text.length;
  const box = useRef<HTMLButtonElement>(null);

  const speaker = beat?.kind === "say" ? figures.find((f) => f.id.toLowerCase() === beat.who.toLowerCase())?.id : undefined;
  useEffect(() => stage.setFigures(figures, speaker), [figures, speaker]);

  useEffect(() => {
    if (!titleShown) return;
    const timer = setTimeout(() => setTitleShown(false), 2400);
    return () => clearTimeout(timer);
  }, []);

  // An effect plays and the scene goes on by itself.
  useEffect(() => {
    if (titleShown || !beat || beat.kind !== "fx") return;
    stage.play(beat.fx, beat.color, beat.on);
    const timer = setTimeout(() => next(), Math.max(700, fxDuration(beat.fx) * 650));
    return () => clearTimeout(timer);
  }, [index, titleShown]);

  // The text comes letter by letter.
  useEffect(() => {
    setTyped(0);
    if (titleShown || !text) return;
    const step = Math.max(1, Math.round(prefs.speed / 30));
    const timer = setInterval(() => {
      setTyped((n) => {
        if (n + step >= text.length) clearInterval(timer);
        return Math.min(text.length, n + step);
      });
    }, 1000 / 30);
    return () => clearInterval(timer);
  }, [index, titleShown]);

  // Auto-play: the next beat once the text has been there long enough to read.
  useEffect(() => {
    if (!prefs.auto || !done || !text || titleShown) return;
    const timer = setTimeout(() => next(), 1200 + text.length * 25);
    return () => clearTimeout(timer);
  }, [prefs.auto, done, index, titleShown]);

  useEffect(() => {
    if (!atEnd) box.current?.focus({ preventScroll: true });
  }, [index, titleShown]);

  function next() {
    setIndex((i) => Math.min(scene.beats.length, i + 1));
  }
  function advance() {
    if (titleShown) return setTitleShown(false);
    if (!done) return setTyped(text.length);
    next();
  }
  async function answer(a: Parameters<typeof api.answer>[2]) {
    setSending(true);
    setError(null);
    try {
      await api.answer(chatId, pending.id, a);
    } catch (e) {
      setError((e as Error).message);
      setSending(false);
    }
  }

  const heroSpeaks = beat?.kind === "say" && beat.who.toLowerCase() === game.hero.name.toLowerCase();
  const nameColor = beat?.kind === "say" ? COLOR_RGB[heroSpeaks ? game.hero.color : (scene.cast.find((c) => c.name.toLowerCase() === beat.who.toLowerCase())?.color ?? "silver")] : undefined;

  return (
    <>
      {scene.changes.length > 0 && <Toasts game={game} changes={scene.changes} />}
      {titleShown && scene.title && (
        <button type="button" className="saga-title" onClick={() => setTitleShown(false)}>
          <span>{scene.title}</span>
          <small>{t(pack.places.find((p) => p.id === scene.location)?.label ?? "")}</small>
        </button>
      )}
      {!titleShown && !atEnd && beat && beat.kind !== "fx" && (
        <button ref={box} type="button" className={`saga-dialogue is-${beat.kind}${beat.kind === "say" ? ` mood-${beat.mood}` : ""}`} onClick={advance}>
          {beat.kind === "say" && (
            <span className="saga-speaker" style={{ color: rgba(nameColor!), borderColor: rgba(nameColor!, 0.5) }}>
              {beat.who}
            </span>
          )}
          <span className="saga-text">
            {beat.kind === "say" ? "“" : ""}
            {text.slice(0, typed)}
            {beat.kind === "say" && done ? "”" : ""}
          </span>
          {done && <span className="saga-more" aria-hidden>▾</span>}
        </button>
      )}
      {!titleShown && !atEnd && (
        <button type="button" className="saga-skip" onClick={() => setIndex(scene.beats.length)} title={t("Skip to the choices")}>
          <LuChevronsRight />
        </button>
      )}
      {atEnd && (
        <div className="saga-choices">
          {scene.choices.map((c, i) => (
            <button key={i} type="button" className="saga-choice" disabled={sending} onClick={() => answer({ kind: "choice", index: i })} style={{ animationDelay: `${i * 0.08}s` }}>
              <span>{c.text}</span>
              {c.check && (
                <span className={`saga-check ${c.check.chance >= 65 ? "is-good" : c.check.chance >= 35 ? "is-even" : "is-bad"}`}>
                  {t(pack.stats[c.check.stat].label)} · {t(DIFFICULTY_LABEL[c.check.difficulty])} · {c.check.chance}%
                </span>
              )}
            </button>
          ))}
          {scene.choices.length === 0 && (
            <button type="button" className="saga-choice is-continue" disabled={sending} onClick={() => answer({ kind: "continue" })}>
              {t("Continue")} ▸
            </button>
          )}
          {scene.free && (
            <form
              className="saga-free"
              onSubmit={(e) => {
                e.preventDefault();
                if (free.trim()) answer({ kind: "free", text: free.trim() });
              }}
            >
              <input value={free} onChange={(e) => setFree(e.target.value)} placeholder={t("Or do something else…")} maxLength={400} disabled={sending} />
              <button type="submit" disabled={sending || !free.trim()} title={t("Do it")}>
                <LuSend />
              </button>
            </form>
          )}
          {error && <div className="saga-error">{error}</div>}
        </div>
      )}
    </>
  );
}
