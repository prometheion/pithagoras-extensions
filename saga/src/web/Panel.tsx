import { useEffect, useRef, useState } from "react";
import { LuMaximize, LuScrollText, LuPlay, LuPause } from "react-icons/lu";
import type { ChatProps, PanelProps } from "@pithagoras/extension-api";
import type { Applied, Game, Roll } from "../game/types";
import { packOf } from "../game/xianxia";
import { portal, t } from "../portal";
import { api } from "./api";
import { CombatView } from "./Combat";
import { Stage } from "./engine/stage";
import { HeroForm } from "./HeroForm";
import { PuzzleView } from "./Puzzles";
import { ScenePlayer, castFigures } from "./Scene";
import { Sheet } from "./Sheet";
import { useSnapshot } from "./store";
import { DIFFICULTY_LABEL, appliedText, realmOf } from "./words";

/**
 * The panel beside a chat in Saga mode: the stage, and over it what the player does now. A scene plays its beats and
 * ends in choices; a puzzle or a fight takes the stage; between them, the dice of the last choice and the story being
 * written. Without a hero, the form that makes one.
 */

export function SagaPanel({ chat }: PanelProps) {
  portal.locale.use();
  const snap = useSnapshot(chat.id);
  if (!snap) return <div className="saga-said">{t("Loading…")}</div>;
  if (!snap.saga)
    return (
      <div className="saga-said">
        <p>{t("This chat is not in Saga mode. Start a new chat and choose Saga mode above the message box: the agent then becomes the game master of your story.")}</p>
      </div>
    );
  if (!snap.game) return <HeroForm chatId={chat.id} />;
  return <Theatre chatId={chat.id} game={snap.game} />;
}

/** Settings of this browser: whether the scene plays by itself, and how fast text appears. */
export function usePrefs() {
  const store = portal.ui.storage.local;
  const [auto, setAuto] = useState(() => store.get("saga.auto") === "1");
  const [speed] = useState(() => Number(store.get("saga.speed")) || 45);
  return {
    auto,
    speed,
    toggleAuto() {
      store.set("saga.auto", auto ? "0" : "1");
      setAuto(!auto);
    },
  };
}

function Theatre({ chatId, game }: { chatId: string; game: Game }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [sheet, setSheet] = useState(false);
  const prefs = usePrefs();
  const pack = packOf(game.pack);
  const pending = game.pending;

  useEffect(() => {
    const s = new Stage(canvas.current!);
    setStage(s);
    return () => s.destroy();
  }, []);

  // The place: the scene's or the fight's that waits, else the last one shown, else a quiet peak at dusk.
  const where = pending?.kind === "scene" ? pending.scene : pending?.kind === "combat" ? pending.combat : game.last;
  const location = where?.location ?? "mountain_peak";
  const time = where?.time ?? "dusk";
  const weather = where?.weather ?? "mist";
  const pictureRel = pending?.kind === "scene" ? pending.scene.picture : pending?.kind === "combat" ? undefined : game.last?.picture;
  const picture = pictureRel ? api.picture(chatId, pictureRel) : undefined;
  useEffect(() => {
    if (!stage) return;
    const place = pack.places.find((p) => p.id === location) ?? pack.places[0];
    stage.setPlace({ place: place.id, look: place.look, time, weather, ...(picture ? { picture } : {}) });
  }, [stage, location, time, weather, picture]);

  // Between scenes the last cast stays, nobody speaking.
  useEffect(() => {
    if (!stage || pending) return;
    stage.setFigures(game.last ? castFigures(game.last.cast, chatId) : []);
  }, [stage, pending?.id, game.last]);

  return (
    <div className="saga-theatre">
      <div className="saga-stage">
        <canvas ref={canvas} />
      </div>
      <Hud game={game} onSheet={() => setSheet(true)} auto={prefs.auto} onAuto={prefs.toggleAuto} />
      {stage && pending?.kind === "scene" && <ScenePlayer key={pending.id} chatId={chatId} game={game} pending={pending} stage={stage} prefs={prefs} />}
      {stage && pending?.kind === "puzzle" && <PuzzleView key={pending.id} chatId={chatId} pending={pending} stage={stage} />}
      {stage && pending?.kind === "combat" && <CombatView key={pending.id} chatId={chatId} game={game} pending={pending} stage={stage} />}
      {!pending && <Between chatId={chatId} game={game} />}
      {sheet && <Sheet game={game} onClose={() => setSheet(false)} />}
    </div>
  );
}

function Bar({ value, max, kind }: { value: number; max: number; kind: "hp" | "qi" | "progress" }) {
  return (
    <div className={`saga-bar is-${kind}`} title={`${value}/${max}`}>
      <div style={{ width: `${Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100))}%` }} />
    </div>
  );
}

function Hud({ game, onSheet, auto, onAuto }: { game: Game; onSheet(): void; auto: boolean; onAuto(): void }) {
  const pack = packOf(game.pack);
  const h = game.hero;
  return (
    <div className="saga-hud">
      <button type="button" className="saga-hud-hero" onClick={onSheet} title={t("Character sheet")}>
        <span className="saga-hud-name">{h.name}</span>
        <span className="saga-hud-realm">{realmOf(pack, h)}</span>
        <span className="saga-hud-bars">
          <Bar value={h.hp} max={h.hpMax} kind="hp" />
          <Bar value={h.qi} max={h.qiMax} kind="qi" />
          <Bar value={h.progress} max={100} kind="progress" />
        </span>
      </button>
      <div className="saga-hud-right">
        <span className="saga-hud-stones" title={t(pack.words.money)}>
          ◈ {h.stones}
        </span>
        <button type="button" className="saga-icon" onClick={onAuto} aria-pressed={auto} title={auto ? t("Auto-play is on") : t("Auto-play is off")}>
          {auto ? <LuPause /> : <LuPlay />}
        </button>
        <button type="button" className="saga-icon" onClick={onSheet} title={t("Character sheet")}>
          <LuScrollText />
        </button>
      </div>
    </div>
  );
}

/** The changes a scene or a puzzle brought, shown for a few seconds as lines that float in. */
export function Toasts({ game, changes }: { game: Game; changes: Applied[] }) {
  const pack = packOf(game.pack);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setShown(false), 5200);
    return () => clearTimeout(timer);
  }, []);
  if (!shown || !changes.length) return null;
  return (
    <div className="saga-toasts" aria-live="polite">
      {changes.map((c, i) => (
        <div key={i} className={`saga-toast ${c.amount < 0 ? "is-loss" : c.what === "realm" ? "is-realm" : "is-gain"}`} style={{ animationDelay: `${i * 0.25}s` }}>
          {c.what === "realm" ? t("Breakthrough! {realm}", { realm: realmOf(pack, game.hero) }) : appliedText(pack, c)}
        </div>
      ))}
    </div>
  );
}

/** The dice, rolled where the player sees them: a number turning, then where it fell. */
export function Dice({ roll, statLabel }: { roll: Roll; statLabel: string }) {
  const [shown, setShown] = useState(roll.roll);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (n >= 16) {
        clearInterval(timer);
        setShown(roll.roll);
        setDone(true);
      } else setShown(1 + Math.floor(Math.random() * 100));
    }, 70);
    return () => clearInterval(timer);
  }, [roll.roll]);
  const verdict = roll.critical ? (roll.success ? t("Critical success") : t("Critical failure")) : roll.success ? t("Success") : t("Failure");
  return (
    <div className={`saga-dice ${done ? (roll.success ? "is-success" : "is-failure") : ""}`}>
      <div className="saga-dice-label">
        {t("{stat} check", { stat: statLabel })} · {t(DIFFICULTY_LABEL[roll.difficulty] ?? roll.difficulty)} · {roll.chance}%
      </div>
      <div className="saga-dice-number">{shown}</div>
      <div className="saga-dice-verdict">{done ? verdict : "…"}</div>
    </div>
  );
}

/** Between two things to do: what came of the last, and the story being written. */
function Between({ chatId, game }: { chatId: string; game: Game }) {
  const pack = packOf(game.pack);
  const running = portal.chats.use(chatId, (f) => f.running);
  const o = game.outcome;
  return (
    <div className="saga-between">
      {o?.roll && <Dice key={o.id} roll={o.roll} statLabel={t(pack.stats[o.roll.stat].label)} />}
      {o?.kind === "puzzle" && <div className={`saga-verdict ${o.solved ? "is-success" : "is-failure"}`}>{o.solved ? t("Solved") : t("Failed")}</div>}
      {o?.kind === "combat" && (
        <div className={`saga-verdict ${o.combat === "victory" ? "is-success" : "is-failure"}`}>{o.combat === "victory" ? t("Victory") : o.combat === "defeat" ? t("Defeat") : t("Escaped")}</div>
      )}
      {o && o.changes.length > 0 && <Toasts key={`t-${o.id}`} game={game} changes={o.changes} />}
      <div className="saga-unfolds">
        {running ? (
          <>
            <span className="saga-ink" aria-hidden />
            {game.scenes === 0 ? t("The story begins…") : t("The story unfolds…")}
          </>
        ) : (
          <span className="saga-quiet">{t("The game master is waiting. Write in the chat to go on, or to tell them what you want to do.")}</span>
        )}
      </div>
    </div>
  );
}

export function PanelActions({ panel }: PanelProps) {
  return (
    <button type="button" onClick={() => panel.fullscreen()} className="saga-head-button" title={t("Fullscreen")}>
      <LuMaximize />
    </button>
  );
}

/** The panel's button in the chat's header: only in a chat in Saga mode, live while a scene waits for the player. */
export function useButton({ chat }: ChatProps) {
  portal.locale.use();
  const snap = useSnapshot(chat.id);
  return { hidden: !snap?.saga, live: !!snap?.game?.pending, title: t("Saga") };
}

/** Opens the panel by itself in a chat in Saga mode, once, and again whenever something new waits for the player. */
export function AutoOpen({ chat, panels }: ChatProps) {
  const snap = useSnapshot(chat.id);
  const pendingId = snap?.game?.pending?.id;
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!snap?.saga) return;
    const key = pendingId ?? "open";
    if (opened.current === key) return;
    opened.current = key;
    if (!panels.isOpen("saga")) panels.open("saga");
  }, [snap?.saga, pendingId]);
  return null;
}
