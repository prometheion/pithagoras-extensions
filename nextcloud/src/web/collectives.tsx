import { useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useNextcloudInstance } from "./api";

/** The Collectives tab: the collectives, one collective's pages in it (with a search over them), and the picked
 * page open to its text. */

interface Collective {
  id: number;
  name: string;
  emoji?: string;
  canEdit: boolean;
}

interface PageRow {
  id: number;
  title: string;
  emoji?: string;
  lastEditor?: string;
  size: number;
}

const readPage = (value: Record<string, unknown>): PageRow => ({
  id: Number(value.id),
  title: String(value.title ?? value.file_name ?? ""),
  emoji: typeof value.emoji === "string" && value.emoji ? value.emoji : undefined,
  lastEditor: typeof value.last_user_display_name === "string" && value.last_user_display_name ? value.last_user_display_name : undefined,
  size: Number(value.size ?? 0),
});

export default function Collectives() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // where the calls go: the panel's held instance
  const [collectives, setCollectives] = useState<Collective[] | null>(null);
  const [collectiveId, setCollectiveId] = useState<number | null>(null);
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState<{ id: number; title: string; content: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const loadCollectives = () => {
    setCollectives(null);
    void api
      .tool("collectives_get_collectives", {}, instance)
      .then((result) =>
        setCollectives(
          (arrayOf(partText(result).data, "collectives") ?? []).map((c) => ({
            id: Number(c.id),
            name: String(c.name ?? ""),
            emoji: typeof c.emoji === "string" && c.emoji ? c.emoji : undefined,
            canEdit: Boolean(c.can_edit ?? c.canEdit),
          })),
        ),
      )
      .catch((error) => setProblem(sayError(error)));
  };

  // the panel remounts this tab for another instance (client.tsx keys it by one), so a first load is all there is
  useEffect(() => { loadCollectives(); }, []);

  const selectCollective = (id: number) => {
    setCollectiveId(id);
    setOpen(null);
    setQuery("");
    setPages(null);
    void api
      .tool("collectives_get_pages", { collective_id: id }, instance)
      .then((result) => {
        const data = partText(result).data;
        const list = (arrayOf(data, "pages") ?? arrayOf(data, "results") ?? []) as Record<string, unknown>[];
        setPages(list.map(readPage));
      })
      .catch((error) => setProblem(sayError(error)));
  };

  const search = () => {
    const text = query.trim();
    if (!text || collectiveId === null) return;
    setSearching(true);
    void api
      .tool("collectives_search_pages", { collective_id: collectiveId, query: text }, instance)
      .then((result) => {
        const data = partText(result).data;
        const list = (arrayOf(data, "results") ?? arrayOf(data, "pages") ?? []) as Record<string, unknown>[];
        setPages(list.map(readPage));
      })
      .catch((error) => setProblem(sayError(error)))
      .finally(() => setSearching(false));
  };

  const openPage = (id: number) => {
    if (collectiveId === null) return;
    setOpen(null);
    void api
      .tool("collectives_get_page", { collective_id: collectiveId, page_id: id }, instance)
      .then((result) => {
        const data = partText(result).data as Record<string, unknown> | undefined;
        if (!data || typeof data.content !== "string") throw new Error(t("The page did not answer in a way this panel reads."));
        const title = (typeof data.page === "object" && data.page !== null ? ((data.page as Record<string, unknown>).title ?? "") : "");
        setOpen({ id, title: String(title), content: data.content });
      })
      .catch((error) => setProblem(sayError(error)));
  };

  // ---- the open page ---------------------------------------------------------------
  if (open !== null) {
    return (
      <div className="space-y-2">
        <button type="button" className={portal.ui.classes.ghost} onClick={() => setOpen(null)}>
          ← {t("Pages")}
        </button>
        <div className="nc-share">
          {open.title && <p className="nc-note-text" style={{ fontWeight: 600, marginBottom: "0.2rem" }}>{open.title}</p>}
          {open.content ? <pre className="nc-file-text">{open.content}</pre> : <p className="text-sm text-fg-subtle">{t("This page is empty.")}</p>}
        </div>
      </div>
    );
  }

  // ---- the collective's pages ---------------------------------------------------------
  if (collectiveId !== null) {
    return (
      <div className="space-y-2">
        <button type="button" className={portal.ui.classes.ghost} onClick={() => setCollectiveId(null)}>
          ← {t("Collectives")}
        </button>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <input className={`${portal.ui.classes.input} min-w-0 flex-1`} value={query} placeholder={t("Search the pages")} aria-label={t("Search the pages")} onChange={(e) => setQuery(e.target.value)} />
          <button type="submit" className={portal.ui.classes.primary} disabled={searching}>
            {t("Search")}
          </button>
        </form>
        {pages === null ? (
          problem && !searching ? (
            <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The pages could not be read: {error}", { error: problem })}</portal.ui.ErrorBanner>
          ) : (
            <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
          )
        ) : pages.length === 0 ? (
          <portal.ui.Empty>{query.trim() ? t("Nothing matched the search.") : t("This collective has no pages yet.")}</portal.ui.Empty>
        ) : (
          <ul className="nc-list">
            {pages.map((row) => (
              <li key={row.id}>
                <button type="button" className="nc-row" onClick={() => openPage(row.id)}>
                  <span className="flex-1 truncate">{row.emoji ? `${row.emoji} ` : ""}{row.title}</span>
                  <span className="text-xs text-fg-subtle flex flex-col items-end gap-0.5 flex-shrink-0">
                    {row.size > 0 && <span>{Math.max(1, Math.round(row.size / 1024))} KiB</span>}
                    {row.lastEditor && <span className="truncate max-w-[8rem]">{row.lastEditor}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ---- the collectives ------------------------------------------------------------------
  if (collectives === null) {
    return problem ? (
      <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The collectives could not be read: {error}", { error: problem })}</portal.ui.ErrorBanner>
    ) : (
      <portal.ui.RowsSkeleton rows={3} label={t("Loading…")} />
    );
  }
  if (collectives.length === 0) {
    return <portal.ui.Empty>{t("No collectives are set up on this Nextcloud.")}</portal.ui.Empty>;
  }
  return (
    <ul className="nc-list">
      {collectives.map((c) => (
        <li key={c.id}>
          <button type="button" className="nc-row" onClick={() => selectCollective(c.id)}>
            <span className="flex-1 truncate">{c.emoji ? `${c.emoji} ` : ""}{c.name}</span>
            {!c.canEdit && <span className="text-xs text-fg-subtle flex-shrink-0">{t("read-only")}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
