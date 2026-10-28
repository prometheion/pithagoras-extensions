import "./client.css";
import { Suspense, useEffect, useState } from "react";
import type { ComponentType } from "react";
import type { PanelProps, Portal } from "@pithagoras/extension-api";
import { LuBookOpenText, LuCalendarX, LuCloud, LuContactRound, LuFiles, LuKanban, LuListChecks } from "react-icons/lu";
import { msg, portal, setPortal, t } from "./portal";
import { de } from "./de";
import { api, NextcloudStatus } from "./web/api";

/**
 * @pithagoras/nextcloud: its browser half. One panel beside every chat -- the Nextcloud of the keys on this portal,
 * by tabs: the shopping lists, the cookbook and the notes, and beside them the files-and-sharing, deck, calendar and
 * contacts tabs -- all seven working. All of it through its own server half (the /api/x routes),
 * which runs the MCP server's container and knows where things stand; nothing of the Nextcloud talks to the browser
 * itself. Plus its page in Settings: the keys, a save that brings the container and its entry in pi's config to them,
 * and how all stands.
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

/** The Nextcloud panel beside a chat: its tabs and what the chosen one shows. While it has nothing to say (no
 * Nextcloud set) it says that, with the way to where the keys are kept. */
function NextcloudPanel({ panel }: PanelProps) {
  portal.locale.use();
  const [tab, setTab] = useState<TabId>("shopping-list");
  const [status, setStatus] = useState<NextcloudStatus | null>(null);
  useEffect(() => {
    let gone = false;
    void api.status().then((s) => !gone && setStatus(s), () => {});
    return () => {
      gone = true;
    };
  }, []);
  if (status && !status.configured) {
    return (
      <div className="p-3">
        <portal.ui.Empty>{t("No Nextcloud is set yet: fill in the host and the login on the Nextcloud page in Settings.")}</portal.ui.Empty>
      </div>
    );
  }
  return (
    <div className="space-y-2 p-2">
      <div className="nc-tabs" role="tablist">
        <TabButton active={tab === "shopping-list"} onClick={() => setTab("shopping-list")} icon={<LuListChecks />} label={t("Shopping List")} />
        <TabButton active={tab === "cookbook"} onClick={() => setTab("cookbook")} icon={<LuBookOpenText />} label={t("Cookbook")} />
        <TabButton active={tab === "notes"} onClick={() => setTab("notes")} icon={<LuCloud />} label={t("Notes")} />
        <TabButton active={tab === "files"} onClick={() => setTab("files")} icon={<LuFiles />} label={t("Files & Sharing")} />
        <TabButton active={tab === "deck"} onClick={() => setTab("deck")} icon={<LuKanban />} label={t("Deck")} />
        <TabButton active={tab === "calendar"} onClick={() => setTab("calendar")} icon={<LuCalendarX />} label={t("Calendar")} />
        <TabButton active={tab === "contacts"} onClick={() => setTab("contacts")} icon={<LuContactRound />} label={t("Contacts")} />
      </div>
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
      return { title: t("The shopping lists, cookbook, notes, files, deck, calendar and contacts of the portal's Nextcloud") };
    },
  });

  // Its page in Settings: the keys, a save, and how all stands.
  portal.slots.register("settings.page", {
    id: "nextcloud",
    title: msg("Nextcloud"),
    icon: LuCloud,
    search: [{ title: msg("Nextcloud"), words: "nextcloud mcp shopping list cookbook notes files sharing deck calendar contacts container image app password host" }],
    component: () => (
      <Suspense fallback={<SettingsFallback />}>
        <SettingsPage />
      </Suspense>
    ),
  });
}
