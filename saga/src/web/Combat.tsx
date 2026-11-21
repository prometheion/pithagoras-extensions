import { useEffect, useRef, useState } from "react";
import { LuFootprints, LuShield, LuSparkles, LuSwords, LuPill } from "react-icons/lu";
import { techniqueCost } from "../game/combat";
import type { Element, Fx } from "../game/pack";
import type { CombatAction, CombatEvent, Game, Pending } from "../game/types";
import { packOf } from "../game/xianxia";
import { t } from "../portal";
import { api } from "./api";
import type { Stage, StageFigure } from "./engine/stage";

/**
 * A fight, round by round: the hero on the left, the foes on the right, each with their vitality. The player picks an
 * action (and a foe), the server plays the round, and the panel plays it back: each blow an effect on the stage and a
 * number over the one it hit, one after the other. When it is over, the player sees how and goes on.
 */

const ELEMENT_FX: Record<Element, Fx> = {
  fire: "fire",
  water: "shockwave",
  wood: "heal",
  metal: "slash",
  earth: "shockwave",
  lightning: "lightning",
  wind: "slash",
  ice: "ice",
  shadow: "darkness",
  light: "golden_light",
  sword: "sword_rain",
  none: "impact",
};

interface Float {
  id: number;
  x: number;
  text: string;
  kind: "damage" | "heal" | "miss" | "crit";
}

export function CombatView({ chatId, game, pending, stage }: { chatId: string; game: Game; pending: Extract<Pending, { kind: "combat" }>; stage: Stage }) {
  const pack = packOf(game.pack);
  const combat = pending.combat;
  const hero = game.hero;
  const [target, setTarget] = useState<string | undefined>();
  const [menu, setMenu] = useState<"technique" | "item" | null>(null);
  const [busy, setBusy] = useState(false);
  const [floats, setFloats] = useState<Float[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const floatId = useRef(0);
  const living = combat.enemies.filter((e) => e.state !== "down");
  const chosen = living.find((e) => e.id === target) ?? living[0];

  const xOf = (id: string) => {
    if (id === "hero") return 0.22;
    const n = combat.enemies.length;
    const i = Math.max(0, combat.enemies.findIndex((e) => e.id === id));
    return n === 1 ? 0.72 : 0.56 + (i * 0.32) / (n - 1);
  };
  const figures = (): StageFigure[] => [
    { id: "hero", look: hero.look, color: hero.color, x: 0.22, facing: 1, down: combat.over === "defeat", scale: 0.68 },
    ...combat.enemies.map((e) => ({ id: e.id, look: e.look, color: e.color, x: xOf(e.id), facing: -1 as const, down: e.state === "down", scale: e.rank === "boss" ? 0.85 : 0.62 })),
  ];
  useEffect(() => stage.setFigures(figures()), [combat.round, combat.over]);
  useEffect(() => {
    if (combat.round === 0) stage.play("shockwave", "white");
  }, []);

  const nameOf = (id: string) => (id === "hero" ? hero.name : (combat.enemies.find((e) => e.id === id)?.name ?? "?"));
  function line(e: CombatEvent): string {
    const vars = { who: nameOf(e.actor), target: e.target ? nameOf(e.target) : "", n: e.amount ?? 0, name: e.name ?? "" };
    switch (e.act) {
      case "strike":
        return e.miss ? t("{who} strikes at {target} and misses.", vars) : e.crit ? t("{who} strikes {target}: critical! −{n}", vars) : t("{who} strikes {target}: −{n}", vars);
      case "technique":
        return e.miss ? t("{who} unleashes {name}, but {target} evades.", vars) : e.crit ? t("{who} unleashes {name} on {target}: critical! −{n}", vars) : t("{who} unleashes {name} on {target}: −{n}", vars);
      case "guard":
        return t("{who} guards and gathers qi (+{n}).", vars);
      case "item":
        return t("{who} swallows {name} (+{n}).", vars);
      case "flee":
        return e.success ? t("{who} escapes!", vars) : t("{who} tries to flee, but is cut off.", vars);
      case "attack":
        return e.miss ? t("{who} attacks, but {target} dodges.", vars) : t("{who} attacks {target}: −{n}", vars);
      case "down":
        return t("{who} falls.", vars);
    }
  }

  function float(on: string, text: string, kind: Float["kind"]) {
    const id = ++floatId.current;
    setFloats((f) => [...f, { id, x: xOf(on), text, kind }]);
    setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1300);
  }

  async function act(action: CombatAction) {
    if (busy) return;
    setBusy(true);
    setMenu(null);
    setError(null);
    try {
      const { combat: after } = await api.act(chatId, pending.id, action);
      const events = after.log.at(-1)?.events ?? [];
      for (const e of events) {
        playEvent(e);
        setLines((l) => [...l.slice(-3), line(e)]);
        await new Promise((r) => setTimeout(r, e.act === "down" ? 250 : 650));
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  function playEvent(e: CombatEvent) {
    const on = e.target ?? e.actor;
    switch (e.act) {
      case "strike":
        stage.play("slash", hero.color, on);
        break;
      case "technique":
        stage.play(ELEMENT_FX[e.element ?? "none"], hero.color, on);
        break;
      case "attack":
        stage.play(e.element && e.element !== "none" ? ELEMENT_FX[e.element] : "impact", combat.enemies.find((x) => x.id === e.actor)?.color, "hero");
        break;
      case "guard":
        stage.play("aura", hero.color, "hero");
        break;
      case "item":
        stage.play("heal", undefined, "hero");
        break;
      case "down":
        stage.play("flash");
        break;
    }
    if (e.act === "strike" || e.act === "technique" || e.act === "attack") {
      if (e.miss) float(on, t("miss"), "miss");
      else {
        stage.hurt(on);
        float(on, `−${e.amount}`, e.crit ? "crit" : "damage");
      }
    }
    if (e.act === "item" || e.act === "guard") float("hero", `+${e.amount}`, "heal");
  }

  const pills = hero.items.filter((i) => i.kind === "pill" && i.amount > 0);
  const over = combat.over;

  return (
    <>
      <div className="saga-foes">
        {combat.enemies.map((e) => (
          <button key={e.id} type="button" className={`saga-foe ${e.state === "down" ? "is-down" : ""} ${chosen?.id === e.id ? "is-target" : ""}`} onClick={() => setTarget(e.id)} disabled={e.state === "down"}>
            <span className="saga-foe-name">
              {e.name}
              {e.rank === "boss" ? " ☠" : ""}
            </span>
            <span className="saga-bar is-hp">
              <span style={{ width: `${(e.hp / e.hpMax) * 100}%` }} />
            </span>
          </button>
        ))}
      </div>
      {floats.map((f) => (
        <div key={f.id} className={`saga-float is-${f.kind}`} style={{ left: `${f.x * 100}%` }}>
          {f.text}
        </div>
      ))}
      <div className="saga-combat">
        <div className="saga-combat-log" aria-live="polite">
          {lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
        {over ? (
          <div className="saga-combat-over">
            <div className={`saga-verdict ${over === "victory" ? "is-success" : "is-failure"}`}>{over === "victory" ? t("Victory") : over === "defeat" ? t("Defeat") : t("Escaped")}</div>
            <button type="button" className="saga-choice is-continue" disabled={busy} onClick={() => api.endCombat(chatId, pending.id).catch((e) => setError((e as Error).message))}>
              {t("Continue")} ▸
            </button>
          </div>
        ) : (
          <>
            {menu === "technique" && (
              <div className="saga-menu">
                {hero.techniques.map((tq) => {
                  const cost = techniqueCost(tq.power);
                  return (
                    <button key={tq.name} type="button" disabled={busy || hero.qi < cost || !chosen} onClick={() => chosen && act({ action: "technique", target: chosen.id, technique: tq.name })}>
                      <span>{tq.name}</span>
                      <small>
                        {"✦".repeat(tq.power)} · {cost} {t(pack.words.qi)}
                      </small>
                    </button>
                  );
                })}
              </div>
            )}
            {menu === "item" && (
              <div className="saga-menu">
                {pills.length ? (
                  pills.map((i) => (
                    <button key={i.name} type="button" disabled={busy} onClick={() => act({ action: "item", item: i.name })}>
                      <span>{i.name}</span>
                      <small>×{i.amount}</small>
                    </button>
                  ))
                ) : (
                  <div className="saga-hint">{t("You have no pills.")}</div>
                )}
              </div>
            )}
            <div className="saga-actions">
              <button type="button" disabled={busy || !chosen} onClick={() => chosen && act({ action: "strike", target: chosen.id })}>
                <LuSwords />
                {t("Strike")}
              </button>
              <button type="button" disabled={busy} aria-pressed={menu === "technique"} onClick={() => setMenu(menu === "technique" ? null : "technique")}>
                <LuSparkles />
                {t("Technique")}
              </button>
              <button type="button" disabled={busy} onClick={() => act({ action: "guard" })}>
                <LuShield />
                {t("Guard")}
              </button>
              <button type="button" disabled={busy} aria-pressed={menu === "item"} onClick={() => setMenu(menu === "item" ? null : "item")}>
                <LuPill />
                {t("Pill")}
              </button>
              {combat.canFlee && (
                <button type="button" disabled={busy} onClick={() => act({ action: "flee" })}>
                  <LuFootprints />
                  {t("Flee")}
                </button>
              )}
            </div>
          </>
        )}
        {error && <div className="saga-error">{error}</div>}
      </div>
    </>
  );
}
