/** Small pieces the tabs share: a switcher of sub-views in one tab (the same chip look as the list pickers). */

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
