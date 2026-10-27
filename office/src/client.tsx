import "./client.css";
import { Suspense, useEffect, useState } from "react";
import type { ComponentType } from "react";
import type { Chat, ChatProps, PanelProps, Portal, ToolCallView } from "@pithagoras/extension-api";
import { LuFileText, LuPresentation, LuTable } from "react-icons/lu";
import type { ReactNode } from "react";
import { msg, officeUrl, portal, setPortal, t } from "./portal";
import { refreshOfficeState, useDocGone, useOfficeState } from "./web/state";
import { api, sayError } from "./web/api";
import { compareDocs, loadSort, saveSort, SortBar, type SortChoice } from "./web/sort";
import { choosePanelDoc, editorsIn, panelDoc } from "./office-ui";
import { de } from "./de";

/**
 * @pithagoras/office: its browser half. The Office tab -- the full library with its own workbench chrome (client.css),
 * opened documents in a full-bleed OnlyOffice editor; the office panel beside a chat, which lists the documents the
 * chat sees and opens one in the same editor right there, beside the conversation; the tool cards of its office_*
 * calls, which open their document in that panel; and its page in Settings where the Document Server is run. It
 * registers nav.page + chat.panel + chat.tool entries + settings.page. Its heavy parts load as chunks, the way
 * Understory's do (ui.lazy + Suspense).
 */

/** The editor (web/office-editor.tsx), loaded as the panel first opens a document. Set as the extension is loaded. */
let PanelEditor: ComponentType<{ docId: string; onBack(): void; onFullPage?: () => void; place?: "page" | "panel"; chatId?: string }>;

/**
 * The Office panel beside a chat: its list of documents, or one of them open in the editor, beside the conversation
 * and never in the Office tab (working with the agent means seeing both). What it shows comes from how it was opened
 * (a tool card opens it with `{ doc }`) and what was chosen in it since (panelDoc). While a document is open the panel
 * asks not to be the one closed to make room for a third. Switching documents, going back or closing the panel unmounts
 * the editor, which destroys it (office-editor.tsx); the same document open in the Office tab too is two views of the
 * one session.
 */
function OfficePanel({ chat, panel }: PanelProps) {
  portal.locale.use();
  const state = useOfficeState();
  const docId = panelDoc(panel.params, panel.state);
  const gone = useDocGone(docId);
  const choose = (doc: string | null) => panel.setState(choosePanelDoc(panel.params, doc));
  const open = docId !== null;
  useEffect(() => {
    panel.keep(open);
    // `panel` is a new handle with each change of what it shows; only whether a document is open matters here.
  }, [open]);
  if (!docId) return <PanelList chat={chat} onOpen={(id) => choose(id)} />;
  // The document left the library meanwhile: said, with the way back. One the last answer does not have yet (an
  // agent's new one, opened from its card at once) waits for an answer asked since.
  if (state && !state.docs.some((d) => d.docId === docId)) {
    if (!gone) return <portal.ui.RowsSkeleton rows={3} label={t("Loading…")} />;
    return (
      <div className="p-2">
        <portal.ui.ErrorBanner>
          {t("This document is no longer in the library.")}{" "}
          <button type="button" className={portal.ui.classes.ghost} onClick={() => choose(null)}>
            ← {t("All documents")}
          </button>
        </portal.ui.ErrorBanner>
      </div>
    );
  }
  return (
    <div className="po-panel">
      <Suspense fallback={<portal.ui.RowsSkeleton rows={3} label={t("Loading…")} />}>
        <PanelEditor key={docId} docId={docId} place="panel" chatId={chat.id} onBack={() => choose(null)} onFullPage={() => portal.navigate(officeUrl(docId))} />
      </Suspense>
    </div>
  );
}

/** The documents beside a chat: what its agent or project sees (GET /scope, the tools' own rule): the ones in its
 * folder, the ones it made or was granted, and the person's library documents. The sort choice is the one of
 * web/sort.tsx, persisted under "po-sort" so this panel and the full Office page share it. A row opens its document
 * here, in the panel. */
function PanelList({ chat, onOpen }: { chat: Chat; onOpen(docId: string): void }) {
  portal.locale.use();
  const state = useOfficeState();
  const [sort, setSort] = useState<SortChoice>(loadSort);
  // What this chat's agent or project sees, by the server half's own rule: asked again whenever the state moves.
  const [scope, setScope] = useState<Set<string> | null>(null);
  useEffect(() => {
    let gone = false;
    api.scope(chat.id).then((s) => !gone && setScope(new Set(s.docIds)), () => {});
    return () => {
      gone = true;
    };
  }, [chat.id, state]);
  if (!state || !scope) return <portal.ui.RowsSkeleton rows={3} label={t("Loading…")} />;
  const chooseSort = (next: SortChoice) => {
    setSort(next);
    saveSort(next);
  };
  const mine = [...state.docs].filter((d) => scope.has(d.docId)).sort((a, b) => compareDocs(a, b, sort.key, sort.dir));
  return (
    <div className="space-y-1 p-2">
      <PanelNewDocument />
      {mine.length === 0 ? (
        <portal.ui.Empty>{t("No office documents yet -- the workspace .docx and .xlsx files, human-made docs, and the ones this chat owns or was granted by a comment mention will appear here.")}</portal.ui.Empty>
      ) : (
        <>
          <SortBar sort={sort} onSort={chooseSort} />
          {mine.map((doc) => {
            const n = editorsIn(state.locks, doc.docId);
            return (
              <div key={doc.docId} className="po-row">
                <button type="button" className="po-open" onClick={() => onOpen(doc.docId)}>
                  {doc.ext === "docx" ? (
                    <LuFileText className="po-ext po-ext-word" aria-hidden />
                  ) : (
                    <LuTable className="po-ext po-ext-cell" aria-hidden />
                  )}
                  <span style={{ minWidth: 0 }}>
                    <span className="po-title">{doc.title}</span>
                    <span className="po-meta">
                      {t("{title}.{ext}", { title: doc.title, ext: doc.ext })}
                      {n > 0 ? ` · ${n === 1 ? t("1 editing now") : t("{n} editing now", { n })}` : ""}
                    </span>
                  </span>
                </button>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/** The panel's slim new-document row: title + a word/sheet kind toggle + create, on the SAME api.createDocument
 * as the page's NewDocument -- and like it it passes NO owner, so a doc made here is unowned and lands where the
 * workspace docs already are: every chat's panel and the global library. */
function PanelNewDocument() {
  portal.locale.use();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"word" | "cell">("word");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const make = async () => {
    if (title.trim() === "" || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.createDocument({ title: title.trim(), type: kind });
      setTitle("");
      void refreshOfficeState(); // the new doc appears in this panel immediately, not on the next 5 s poll
    } catch (e) {
      setProblem(sayError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="po-newcompact"
      onSubmit={(e) => {
        e.preventDefault();
        void make();
      }}
    >
      <input
        className={portal.ui.classes.input}
        value={title}
        maxLength={200}
        placeholder={t("New document title")}
        aria-label={t("New document title")}
        onChange={(e) => setTitle(e.target.value)}
      />
      <span className="po-kind">
        <button type="button" aria-pressed={kind === "word"} className={`po-kind-btn${kind === "word" ? " po-kind-on" : ""}`} onClick={() => setKind("word")} title={t("Word (.docx)")} aria-label={t("Word (.docx)")}>
          <LuFileText aria-hidden />
        </button>
        <button type="button" aria-pressed={kind === "cell"} className={`po-kind-btn${kind === "cell" ? " po-kind-on" : ""}`} onClick={() => setKind("cell")} title={t("Sheet (.xlsx)")} aria-label={t("Sheet (.xlsx)")}>
          <LuTable aria-hidden />
        </button>
      </span>
      <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || title.trim() === ""}>
        {t("Add")}
      </button>
      {problem && (
        <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The document could not be made: {error}", { error: problem })}</portal.ui.ErrorBanner>
      )}
    </form>
  );
}

/** What the office tools reported, beside their text: which document, and a way to open it. The portal's own card
 * says it best while a call runs or failed, so those stay as they are (the docs extension's tool-card precedent). */
interface OfficeToolDetails {
  action?: string;
  id?: string;
  title?: string;
  ext?: "docx" | "xlsx";
  mtimeMs?: number;
  from?: number;
  to?: number;
  ops?: number;
  documents?: unknown[];
}

function OfficeCall(props: ChatProps & { call: ToolCallView; card: ReactNode }) {
  portal.locale.use();
  const state = useOfficeState();
  const { call, card } = props;
  const d = call.details as OfficeToolDetails | undefined;
  if (call.status !== "done" || !d || typeof d.action !== "string") return card;

  const heading: Record<string, string> = {
    create: t("Created a document"),
    read: t("Read a document"),
    edit: t("Edited a document"),
    comments: t("Read the comments of a document"),
    list: t("Listed the office documents"),
  };
  const titleText = heading[d.action];
  if (!titleText) return card;

  // The tool names its document by id alone; its title comes from what the poll has (or the call said it).
  let name: string | null = d.title ?? null;
  if (d.id) name ??= state?.docs.find((x) => x.docId === d.id)?.title ?? null;
  const facts: string[] = [];
  if (d.action === "list") {
    facts.push(d.documents?.length === 1 ? t("1 document") : t("{n} documents", { n: d.documents?.length ?? 0 }));
  } else if (d.id) {
    const ext = d.ext ?? state?.docs.find((x) => x.docId === d.id)?.ext;
    facts.push(ext ? `${name ?? d.id}.${ext}` : name ?? d.id);
    if (d.action === "edit") {
      facts.push(typeof d.from === "number" && typeof d.to === "number" ? t("Revision {from} to {to}", { from: d.from, to: d.to }) : typeof d.to === "number" ? t("Revision {n}", { n: d.to }) : "");
      facts.push(typeof d.ops === "number" ? (d.ops === 1 ? t("1 edit") : t("{n} edits", { n: d.ops })) : "");
    } else if (typeof d.mtimeMs === "number") facts.push(t("Revision {n}", { n: d.mtimeMs }));
  }

  const doc = d.action === "list" ? null : typeof d.id === "string" && d.id !== "" ? d.id : undefined;
  if (doc === undefined) return card; // nothing to open: the portal's card already said enough
  // In the chat's Office panel, beside the conversation: the document, or (for a list) the panel's list. A new object
  // each time, so a card opens its own document again after another was chosen in the panel. Where there is no
  // panel to open (a card drawn outside a chat), the Office tab.
  const show = () => {
    try {
      props.panels.open("office", doc === null ? {} : { doc });
    } catch {
      portal.navigate(officeUrl(doc ?? undefined));
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-raised/40 p-2">
      <LuPresentation />
      <div style={{ minWidth: 0, flex: 1 }}>
        <span className="text-xs text-fg-muted">{titleText}</span>
        {name && <p className="truncate text-sm text-fg">{name}</p>}
        {facts.filter(Boolean).length > 0 && <p className="text-[11px] text-fg-subtle">{facts.filter(Boolean).join(" · ")}</p>}
      </div>
      <button type="button" className={portal.ui.classes.ghost} onClick={show}>
        {t("Open in Office")}
      </button>
    </div>
  );
}

function PageFallback() {
  portal.locale.use();
  return <div className="flex flex-1 items-center justify-center text-sm text-fg-subtle">{t("Loading…")}</div>;
}

function SettingsFallback() {
  portal.locale.use();
  return <p className="text-sm text-fg-subtle">{t("Loading…")}</p>;
}

export default function office(given: Portal): void {
  setPortal(given);
  portal.locale.add("de", de);
  // Its heavy parts, fetched only when they are opened (the Understory idiom).
  const Page = portal.ui.lazy(() => import("./web/library"), "OfficePage");
  const Settings = portal.ui.lazy(() => import("./web/settings"), "OfficeSettings");
  PanelEditor = portal.ui.lazy(() => import("./web/office-editor"), "OfficeEditor");
  const fallback = <PageFallback />;

  // The Office tab: the full library at /x/@pithagoras/office/office, its chrome its own (client.css), a document
  // open as ?doc=<id> in the whole page.
  portal.slots.register("nav.page", {
    id: "office",
    title: msg("Office"),
    icon: LuPresentation,
    component: () => (
      <Suspense fallback={fallback}>
        <Page />
      </Suspense>
    ),
  });

  // Beside every chat -- shown for all: every unowned (workspace-scanned / human-made) doc
  // is shared by every chat, plus what this one owns or was granted; where there is nothing at all, it says so. A
  // document opens in it, beside the conversation (`portal.panels.open("office", { doc })` reaches it from anywhere).
  portal.slots.register("chat.panel", {
    id: "office",
    name: "office",
    title: msg("Office"),
    icon: LuPresentation,
    component: OfficePanel,
    useButton: () => {
      portal.locale.use();
      return { title: t("The office documents this chat owns or was granted") };
    },
  });

  // A call of one of the tools, in place of the portal's card for a finished one that names its document.
  for (const tool of ["office_list", "office_create", "office_read", "office_edit", "office_comments"]) {
    portal.slots.register("chat.tool", { id: tool, tool, component: OfficeCall });
  }

  // Its page in Settings: how Office stands, Start, Stop and Remove, and its image tag.
  portal.slots.register("settings.page", {
    id: "office",
    title: msg("Office"),
    icon: LuPresentation,
    search: [
      { title: msg("Office"), words: "office onlyoffice document server container image tag pull download start stop remove agent editor chromium" },
    ],
    component: () => (
      <Suspense fallback={<SettingsFallback />}>
        <Settings />
      </Suspense>
    ),
  });
}
