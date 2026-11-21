import { LuX } from "react-icons/lu";
import { STATS } from "../game/pack";
import type { Game } from "../game/types";
import { packOf } from "../game/xianxia";
import { t } from "../portal";
import { realmOf } from "./words";

/** The hero, whole: realm, numbers, techniques, belongings, bonds, and what the story remembers. */
export function Sheet({ game, onClose }: { game: Game; onClose(): void }) {
  const pack = packOf(game.pack);
  const h = game.hero;
  const origin = pack.origins.find((o) => o.id === h.origin);
  return (
    <div className="saga-sheet" role="dialog" aria-label={t("Character sheet")}>
      <div className="saga-sheet-head">
        <div>
          <div className="saga-sheet-name">{h.name}</div>
          <div className="saga-sheet-sub">
            {origin ? t(origin.label) : ""} · {realmOf(pack, h)}
          </div>
        </div>
        <button type="button" className="saga-icon" onClick={onClose} title={t("Close")}>
          <LuX />
        </button>
      </div>
      <div className="saga-sheet-body">
        <section>
          <div className="saga-row">
            <span>{t(pack.words.progress)}</span>
            <span>{h.progress}/100</span>
          </div>
          <div className="saga-bar is-progress is-wide">
            <div style={{ width: `${h.progress}%` }} />
          </div>
          {h.progress >= 100 && <p className="saga-hint">{t("Your cultivation is full: a breakthrough awaits.")}</p>}
          <div className="saga-row">
            <span>{t(pack.words.hp)}</span>
            <span>
              {h.hp}/{h.hpMax}
            </span>
          </div>
          <div className="saga-row">
            <span>{t(pack.words.qi)}</span>
            <span>
              {h.qi}/{h.qiMax}
            </span>
          </div>
          <div className="saga-row">
            <span>{t(pack.words.money)}</span>
            <span>{h.stones}</span>
          </div>
          <div className="saga-row">
            <span>{t(pack.words.karma)}</span>
            <span>{h.karma}</span>
          </div>
        </section>
        <section className="saga-stats">
          {STATS.map((s) => (
            <div key={s} className="saga-stat" title={t(pack.stats[s].hint)}>
              <span>{t(pack.stats[s].label)}</span>
              <strong>{h.stats[s]}</strong>
            </div>
          ))}
        </section>
        <section>
          <h3>{t("Techniques")}</h3>
          {h.techniques.map((tq) => (
            <div key={tq.name} className="saga-row">
              <span>{tq.name}</span>
              <span className="saga-dim">{"✦".repeat(tq.power)}</span>
            </div>
          ))}
        </section>
        <section>
          <h3>{t("Belongings")}</h3>
          {h.items.length ? (
            h.items.map((i) => (
              <div key={i.name} className="saga-row">
                <span>{i.name}</span>
                <span className="saga-dim">×{i.amount}</span>
              </div>
            ))
          ) : (
            <p className="saga-dim">{t("Nothing.")}</p>
          )}
        </section>
        {h.bonds.length > 0 && (
          <section>
            <h3>{t("Bonds")}</h3>
            {h.bonds.map((b) => (
              <div key={b.name} className="saga-bond">
                <span>{b.name}</span>
                <span className="saga-affinity">
                  <span className={b.affinity >= 0 ? "is-pos" : "is-neg"} style={{ width: `${Math.abs(b.affinity) / 2}%`, [b.affinity >= 0 ? "left" : "right"]: "50%" }} />
                </span>
                <span className="saga-dim">{b.affinity > 0 ? `+${b.affinity}` : b.affinity}</span>
              </div>
            ))}
          </section>
        )}
        {game.chronicle.length > 0 && (
          <section>
            <h3>{t("Chronicle")}</h3>
            <ul className="saga-chronicle">
              {game.chronicle.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
