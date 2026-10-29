import "./client.css";
import { Suspense, useEffect, useState } from "react";
import type { ComponentType } from "react";
import type { PanelProps, Portal } from "@pithagoras/extension-api";
import { LuBookOpenText, LuCalendarX, LuCloud, LuContactRound, LuFiles, LuKanban, LuListChecks } from "react-icons/lu";
import { msg, portal, setPortal, t } from "./portal";
import { de } from "./de";
import { api, setCurrentInstance, NextcloudStatus } from "./web/api";

/**
 * @pithagoras/nextcloud: its browser half. One panel beside every chat -- the Nextcloud of the keys on this portal,
 * by tabs: the shopping lists, the cookbook and the notes, and beside them the files-and-sharing, deck, calendar and
 * contacts tabs -- all seven working, on whichever of the instances the switcher in the header holds (the first
 * where there is more than one). All of it through its own server half (the /api/x routes), which runs every
 * instance's MCP server -- in a container this extension made, or one it adopted -- and knows where things stand;
 * nothing of the Nextcloud talks to the browser itself. Plus its page in Settings: the instances, their containers
 * (made or adopted), their entries in pi's config, and how all stands.
 */

/** The tabs, by what they show. */
type TabId = "shopping-list" | "cookbook" | "notes" | "files" | "deck" | "calendar" | "contacts";

let ShoppingList: ComponentType;
let Cookbook: ComponentType;
let Notes: ComponentType;
let Files: ComponentType;
let Deck: ComponentType;
let Calendar: ComponentType;
let Contacts: ComponentType;
let SettingsPage: ComponentType;

/** The Nextcloud panel beside a chat: the switcher over its instances, and the tabs of whichever it holds. While it
 * has nothing to say (no Nextcloud set) it says that, with the way to where the keys are kept. */
function NextcloudPanel({ panel }: PanelProps) {
  portal.locale.use();
  const [tab, setTab] = useState<TabId>("shopping-list");
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
  useEffect(() => {
    setCurrentInstance(selected);
  }, [selected]);
  const held = instances.find((inst) => inst.name === selected) ?? (instances.length ? instances[0] : undefined);
  if (status && !status.configured) {
    return (
      <div className="p-3">
        <portal.ui.Empty>{t("No Nextcloud is set yet: add an instance on the Nextcloud page in Settings.")}</portal.ui.Empty>
      </div>
    );
  }
  return (
    <div className="space-y-2 p-2">
      {instances.length > 1 && (
        <div className="nc-instance" role="tablist" aria-label={t("Which of the Nextclouds the pages talk to")}>
          {instances.map((inst) => (
            <InstanceButton
              key={inst.name}
              active={inst.name === (held?.name ?? selected)}
              onClick={() => setSelected(inst.name)}
              label={`${inst.name}${inst.mode === "adopted" ? ` (${t("adopted")})` : ""}`}
            />
          ))}
        </div>
      )}
      <div className="nc-tabs" role="tablist">
        <TabButton active={tab === "shopping-list"} onClick={() => setTab("shopping-list")} icon={<LuListChecks />} label={t("Shopping List")} />
        <TabButton active={tab === "cookbook"} onClick={() => setTab("cookbook")} icon={<LuBookOpenText />} label={t("Cookbook")} />
        <TabButton active={tab === "notes"} onClick={() => setTab("notes")} icon={<LuCloud />} label={t("Notes")} />
        <TabButton active={tab === "files"} onClick={() => setTab("files")} icon={<LuFiles />} label={t("Files & Sharing")} />
        <TabButton active={tab === "deck"} onClick={() => setTab("deck")} icon={<LuKanban />} label={t("Deck")} />
        <TabButton active={tab === "calendar"} onClick={() => setTab("calendar")} icon={<LuCalendarX />} label={t("Calendar")} />
        <TabButton active={tab === "contacts"} onClick={() => setTab("contacts")} icon={<LuContactRound />} label={t("Contacts")} />
      </div>
      {held && !held.configured ? (
        <p className="text-sm text-fg-subtle p-1">
          {t("This Nextcloud ({name}) is not set up completely yet: fill it in on the Nextcloud page in Settings.", { name: held.name })}
        </p>
      ) : (
        // The open tab remounts where the instance changes: what it shows belongs to that one and no other.
        <div key={held?.name ?? selected ?? "none"}>
          {tab === "shopping-list" ? (
            <Suspense fallback={<portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />}>
              <ShoppingList />
            </Suspense>
          ) : tab === "cookbook" ? (
            <Suspense fallback={<portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />}>
              <Cookbook />
            </Suspense>
          ) : tab === "notes" ? (
            <Suspense fallback={<portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />}>
              <Notes />
            </Suspense>
          ) : tab === "files" ? (
            <Suspense fallback={<portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />}>
              <Files />
            </Suspense>
          ) : tab === "deck" ? (
            <Suspense fallback={<portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />}>
              <Deck />
            </Suspense>
          ) : tab === "calendar" ? (
            <Suspense fallback={<portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />}>
              <Calendar />
            </Suspense>
          ) : (
            <Suspense fallback={<portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />}>
              <Contacts />
            </Suspense>
          )}
        </div>
      )}
    </div>
  );
}

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

/** One of the instances in the switcher: its name, chosen as pressed. */
function InstanceButton({ active, onClick, label }: { active: boolean; onClick(): void; label: string }) {
  return (
    <button type="button" role="tab" aria-selected={active} className={`nc-instance-btn${active ? " nc-instance-btn-on" : ""}`} onClick={onClick}>
      {label}
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
  SettingsPage = portal.ui.lazy(() => import("./web/settings-page"), "default");

  // Beside every chat -- shown for all: the Nextcloud of this portal's keys, by tabs.
  portal.slots.register("chat.panel", {
    id: "nextcloud",
    name: "nextcloud",
    title: msg("Nextcloud"),
    icon: LuCloud,
    component: NextcloudPanel,
    useButton: () => {
      portal.locale.use();
      return { title: t("The shopping lists, cookbook, notes, files, deck, calendar and contacts of this portal's Nextclouds") };
    },
  });

  // Its page in Settings: the keys, a save, and how all stands.
  portal.slots.register("settings.page", {
    id: "nextcloud",
    title: msg("Nextcloud"),
    icon: LuCloud,
    search: [{ title: msg("Nextcloud"), words: "nextcloud mcp instances instance adopt adopted container containers port image app password host" }],
    component: () => (
      <Suspense fallback={<SettingsFallback />}>
        <SettingsPage />
      </Suspense>
    ),
  });
}
