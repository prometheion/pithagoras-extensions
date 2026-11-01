/** Small pieces the tabs share: a switcher of sub-views in one tab (the same chip look as the list pickers), and the
 * panel's own yes-and-no, where the browser's question window would otherwise stand. */

import { portal, t } from "../portal";

export interface SubTab {
  id: string;
  label: string;
}

export function SubTabs({ tabs, active, onChange }: { tabs: SubTab[]; active: string; onChange(id: string): void }) {
  return (
    <div className="nc-subtabs" role="group">
      {tabs.map((tab) => (
        <button key={tab.id} type="button" aria-pressed={tab.id === active} className={`nc-tab${tab.id === active ? " nc-tab-on" : ""}`} onClick={() => onChange(tab.id)}>
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
}

/** What stands for the one thing about to go: its words, and the two ways out of it. */
export interface AskState {
  text: string;
  run(): void;
}

/** The panel asks before something goes away -- its own yes-and-no. No window of the browser is part of this page, so
 * nothing here may be one either (Simeon, 2026-11): every question stands drawn where it happens. */
export function Ask({ ask, onNo }: { ask: AskState; onNo(): void }) {
  return (
    <div className="nc-ask" role="alertdialog" aria-label={ask.text}>
      <p>{ask.text}</p>
      <div className="nc-ask-row">
        <button type="button" className="nc-ask-no" onClick={onNo}>
          {t("No")}
        </button>
        <button
          type="button"
          className="nc-ask-yes"
          onClick={() => {
            const go = ask.run;
            onNo();
            go();
          }}
        >
          {t("Yes")}
        </button>
      </div>
    </div>
  );
}

/** The portal's own question before something goes away for good: its dialog over the page (focus on the safe button,
 * Escape to leave, and the person's setting to be asked or not), in place of a question drawn in the panel. */
export function confirmDelete(title: string, message?: string, confirmLabel: string = t("Delete")): Promise<boolean> {
  return portal.ui.confirm({ title, message, confirmLabel, danger: true, deletes: true });
}
