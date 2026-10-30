import "./client.css";
import { Suspense, useEffect, useState } from "react";
import type { ComponentType } from "react";
import type { PanelProps, Portal } from "@pithagoras/extension-api";
import {LuBookOpenText, LuCalendarX, LuCloud, LuContactRound, LuFiles, LuLayers, LuKanban, LuListChecks, LuMail, LuNewspaper} from "react-icons/lu";
import { msg, portal, setPortal, t } from "./portal";
import { de } from "./de";
import { TABS, tabOffered } from "./capabilities";
import { api, InstanceContext, NextcloudStatus } from "./web/api";

/**
 * @pithagoras/nextcloud: its browser half. One panel beside every chat -- the Nextcloud of the keys on this portal,
 * by tabs, one per capability family the instance's server provides: the shopping lists, the cookbook and the notes,
 * the files-and-sharing, deck, calendar and contacts tabs, and beside them mail, news and collectives -- all of it
 * working, on whichever of the instances the switcher in the header holds (the first where there is more than one).
 * Which tabs stand at all is found from the instance's endpoint: a family its server does not provide stands no tab,
 * and a family its choices turned off stands none either -- offered nowhere, kept out of the chats' tool lists with.
 * All of it through its own server half (the /api/x routes), which runs every instance's MCP server -- each in a
 * container this extension made and keeps for it -- and knows where things stand; nothing of the Nextcloud talks
 * to the browser itself. Plus its page in Settings: the instances, their containers, their entries in pi's config,
 * and how all stands.
 */

let ShoppingList: ComponentType;
let Cookbook: ComponentType;
let Notes: ComponentType;
let Files: ComponentType;
let Deck: ComponentType;
let Calendar: ComponentType;
let Contacts: ComponentType;
let Mail: ComponentType;
let News: ComponentType;
let Collectives: ComponentType;
let SettingsPage: ComponentType;

/** The marks of the tabs, by their id. */
const TAB_ICONS: Record<string, ComponentType> = {
  shopping: LuListChecks,
  cookbook: LuBookOpenText,
  notes: LuCloud,
  files: LuFiles,
  deck: LuKanban,
  calendar: LuCalendarX,
  contacts: LuContactRound,
  mail: LuMail,
  news: LuNewspaper,
  collectives: LuLayers,
};

/** The Nextcloud panel beside a chat: the switcher over its instances, and the tabs of whichever it holds. While it
 * has nothing to say (no Nextcloud set) it says that, with the way to where the keys are kept. */
function NextcloudPanel({ panel }: PanelProps) {
  portal.locale.use();
  // Files stands first and is the view the panel opens on (Simeon, 2026-10-30).
  const [tab, setTab] = useState<string>("files");
  const [status, setStatus] = useState<NextcloudStatus | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  useEffect(() => {
    let gone = false;
    void api.status().then((s) => !gone && setStatus(s), () => {});
    return () => {
      gone = true;
    };
  }, []);
  // The first instance is what the pages talk to, as long as it stands; a chosen one that went gets its place.
  const instances = status?.instances ?? [];
  useEffect(() => {
    if (!status) return;
    const names = status.instances.map((inst) => inst.name);
    if (names.length && (!selected || !names.includes(selected))) setSelected(names[0]);
  }, [status, selected]);
  const held = instances.find((inst) => inst.name === selected) ?? (instances.length ? instances[0] : undefined);
  // The tabs that stand for the instance held: what its endpoint provides of each family beside what its choices
  // turned on -- asked live by the status, so a tab goes away where its server does not have it. Before any early
  // return: a hook after one stands in fewer renders than the others, and React throws where their count changed.
  const offered = TABS.filter((def) => tabOffered(def, held?.capabilities?.available, held?.capabilities?.on ?? {}));
  useEffect(() => {
    if (offered.length && !offered.some((def) => def.id === tab)) setTab(offered[0].id);
  }, [held]);
  // Where the status has not stood yet, nothing is offered at all: a tab mounted before its instance is known
  // would call for one there is none of, and its red answer flashes where there is nothing to say.
  if (!status)
    return (
      <div className="p-3">
        <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
      </div>
    );
  if (status.instances.length === 0) {
    return (
      <div className="p-3">
        <portal.ui.Empty>{t("No Nextcloud is set yet: add an instance on the Nextcloud page in Settings.")}</portal.ui.Empty>
      </div>
    );
  }
  return (
    <div className="space-y-2 p-2">
      {instances.length > 1 && (
        <portal.ui.Select
          value={held?.name ?? selected ?? ""}
          onChange={(value) => setSelected(value)}
          options={instances.map((inst) => ({ value: inst.name, label: inst.name }))}
          size="sm"
          className="w-full"
          aria-label={t("Which of the Nextclouds the pages talk to")}
        />
      )}
      <div className="nc-tabs" role="tablist">
        {offered.map((def) => {
          const Icon = TAB_ICONS[def.id];
          return <TabButton key={def.id} active={tab === def.id} onClick={() => setTab(def.id)} icon={<Icon />} label={t(def.label)} />;
        })}
      </div>
      {held && !held.configured ? (
        <p className="text-sm text-fg-subtle p-1">
          {t("This Nextcloud ({name}) is not set up completely yet: fill it in on the Nextcloud page in Settings.", { name: held.name })}
        </p>
      ) : (
        // The open tab remounts where the instance changes: what it shows belongs to that one and no other, and
        // the tabs read the instance their calls go to from here.
        <div key={held?.name ?? selected ?? "none"}>
          <InstanceContext.Provider value={held?.name}>
            {(() => {
              const Shown = components[tab];
              return Shown ? (
                <Suspense fallback={<portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />}><Shown /></Suspense>
              ) : (
                <p className="text-sm text-fg-subtle p-1">{t("Loading…")}</p>
              );
            })()}
          </InstanceContext.Provider>
        </div>
      )}
    </div>
  );
}

/** The tabs' components, filled where the package registers its half. */
const components: Record<string, ComponentType> = {};

/** One of the working tabs: its name and its mark, chosen as pressed. */
function TabButton({ active, onClick, icon, label }: { active: boolean; onClick(): void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`nc-tab${active ? " nc-tab-on" : ""}`}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SettingsFallback() {
  portal.locale.use();
  return <p className="text-sm text-fg-subtle">{t("Loading…")}</p>;
}

export default function nextcloud(given: Portal): void {
  setPortal(given);
  portal.locale.add("de", de);
  // The tabs and the settings page, fetched only when they are opened (the Understory idiom).
  ShoppingList = portal.ui.lazy(() => import("./web/shopping-list"), "default");
  Cookbook = portal.ui.lazy(() => import("./web/cookbook"), "default");
  Notes = portal.ui.lazy(() => import("./web/notes"), "default");
  Files = portal.ui.lazy(() => import("./web/files"), "default");
  Deck = portal.ui.lazy(() => import("./web/deck"), "default");
  Calendar = portal.ui.lazy(() => import("./web/calendar"), "default");
  Contacts = portal.ui.lazy(() => import("./web/contacts"), "default");
  Mail = portal.ui.lazy(() => import("./web/mail"), "default");
  News = portal.ui.lazy(() => import("./web/news"), "default");
  Collectives = portal.ui.lazy(() => import("./web/collectives"), "default");
  SettingsPage = portal.ui.lazy(() => import("./web/settings-page"), "default");
  components.shopping = ShoppingList;
  components.cookbook = Cookbook;
  components.notes = Notes;
  components.files = Files;
  components.deck = Deck;
  components.calendar = Calendar;
  components.contacts = Contacts;
  components.mail = Mail;
  components.news = News;
  components.collectives = Collectives;

  // Beside every chat -- shown for all: the Nextcloud of this portal's keys, by tabs.
  portal.slots.register("chat.panel", {
    id: "nextcloud",
    name: "nextcloud",
    title: msg("Nextcloud"),
    icon: LuCloud,
    component: NextcloudPanel,
    useButton: () => {
      portal.locale.use();
      return { title: t("The shopping lists, cookbook, notes, files, deck, calendar, contacts, mail, news and collectives of this portal's Nextclouds") };
    },
  });

  // Its page in Settings: the keys, a save, and how all stands.
  portal.slots.register("settings.page", {
    id: "nextcloud",
    title: msg("Nextcloud"),
    icon: LuCloud,
    search: [{ title: msg("Nextcloud"), words: "nextcloud mcp instances instance container containers port image app password host capabilities mail news collectives" }],
    component: () => (
      <Suspense fallback={<SettingsFallback />}>
        <SettingsPage />
      </Suspense>
    ),
  });
}
