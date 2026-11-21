import { useEffect, useRef, useState } from "react";
import { COLORS, COLOR_RGB, STATS, type Color, type Stat } from "../game/pack";
import type { Hero } from "../game/types";
import { XIANXIA } from "../game/xianxia";
import { portal, t } from "../portal";
import { api } from "./api";
import { Stage } from "./engine/stage";
import { rgba } from "./engine/util";

/**
 * The hero, made before the story starts: a name, who they were, what they are good at, the colour of their aura. The
 * stage behind shows them as they choose. Sent, the server makes the hero and tells the game master to begin.
 */
export function HeroForm({ chatId }: { chatId: string }) {
  const lang = portal.locale.use();
  const pack = XIANXIA;
  const [name, setName] = useState("");
  const [gender, setGender] = useState<Hero["gender"]>("male");
  const [origin, setOrigin] = useState(pack.origins[0].id);
  const [focus, setFocus] = useState<Stat>("spirit");
  const [color, setColor] = useState<Color>("azure");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<Stage | null>(null);

  useEffect(() => {
    const s = new Stage(canvas.current!);
    const peak = pack.places.find((p) => p.id === "moonlit_cliff")!;
    s.setPlace({ place: peak.id, look: peak.look, time: "night", weather: "fireflies" });
    stage.current = s;
    return () => s.destroy();
  }, []);
  useEffect(() => {
    stage.current?.setFigures([{ id: "hero", look: gender === "female" ? "heroine" : "hero", color, x: 0.5, facing: 1 }], "hero");
  }, [gender, color]);

  async function begin(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSending(true);
    setError(null);
    stage.current?.play("breakthrough", color, "hero");
    try {
      await api.hero(chatId, { name: name.trim(), gender, origin, focus, color, lang });
    } catch (err) {
      setError((err as Error).message);
      setSending(false);
    }
  }

  const chosen = pack.origins.find((o) => o.id === origin)!;
  return (
    <div className="saga-theatre">
      <div className="saga-stage">
        <canvas ref={canvas} />
      </div>
      <form className="saga-hero-form" onSubmit={begin}>
        <h2>{t("Who are you?")}</h2>
        <label>
          <span>{t("Name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder={t("Lin Feng, Su Yue…")} autoFocus required />
        </label>
        <div className="saga-seg" role="radiogroup" aria-label={t("Gender")}>
          {(["male", "female", "other"] as const).map((g) => (
            <button key={g} type="button" role="radio" aria-checked={gender === g} onClick={() => setGender(g)}>
              {g === "male" ? t("Male") : g === "female" ? t("Female") : t("Other")}
            </button>
          ))}
        </div>
        <span className="saga-label">{t("Origin")}</span>
        <div className="saga-origins">
          {pack.origins.map((o) => (
            <button key={o.id} type="button" aria-pressed={origin === o.id} onClick={() => setOrigin(o.id)}>
              {t(o.label)}
            </button>
          ))}
        </div>
        <p className="saga-hint">{t(chosen.story)}</p>
        <span className="saga-label">{t("Talent")}</span>
        <div className="saga-seg" role="radiogroup" aria-label={t("Talent")}>
          {STATS.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={focus === s} onClick={() => setFocus(s)} title={t(pack.stats[s].hint)}>
              {t(pack.stats[s].label)} {(chosen.stats[s] ?? 3) + (focus === s ? 1 : 0)}
            </button>
          ))}
        </div>
        <span className="saga-label">{t("Aura")}</span>
        <div className="saga-swatches">
          {COLORS.map((c) => (
            <button key={c} type="button" aria-pressed={color === c} aria-label={c} onClick={() => setColor(c)} style={{ background: rgba(COLOR_RGB[c]), boxShadow: color === c ? `0 0 12px ${rgba(COLOR_RGB[c])}` : undefined }} />
          ))}
        </div>
        <button type="submit" className="saga-begin" disabled={sending || !name.trim()}>
          {sending ? t("The heavens stir…") : t("Begin your saga")}
        </button>
        {error && <div className="saga-error">{error}</div>}
      </form>
    </div>
  );
}
