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
  fileName?: string;
  filePath?: string;
  collectivePath?: string;
}

const strOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

const readPage = (value: Record<string, unknown>): PageRow => ({
  id: Number(value.id),
  title: String(value.title ?? value.file_name ?? ""),
  emoji: typeof value.emoji === "string" && value.emoji ? value.emoji : undefined,
  lastEditor: typeof value.last_user_display_name === "string" && value.last_user_display_name ? value.last_user_display_name : undefined,
  size: Number(value.size ?? 0),
  fileName: strOf(value.fileName ?? value.file_name),
  filePath: strOf(value.filePath ?? value.file_path),
  collectivePath: strOf(value.collectivePath ?? value.collective_path),
});

/** Where the page's text stands in the files, from its three words (nothing where it was not given). */
const pagePath = (page: { fileName?: string; filePath?: string; collectivePath?: string }): string | undefined => {
  if (page.collectivePath === undefined || page.fileName === undefined) return undefined;
  const middle = page.filePath !== undefined && page.filePath !== "" ? `${page.filePath}/` : "";
  return `${page.collectivePath}/${middle}${page.fileName}`;
};

export default function Collectives() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // where the calls go: the panel's held instance
  const [collectives, setCollectives] = useState<Collective[] | null>(null);
  const [collectiveId, setCollectiveId] = useState<number | null>(null);
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState<(PageRow & { content: string }) | null>(null);
  const [pageDraft, setPageDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // what the picked collective may be done to, and the forms that make a collective or a page
  const [canEditHere, setCanEditHere] = useState(false);
  const [collectiveFormOpen, setCollectiveFormOpen] = useState(false);
  const [newColName, setNewColName] = useState("");
  const [newColEmoji, setNewColEmoji] = useState("");
  const [pageFormOpen, setPageFormOpen] = useState(false);
  const [newPageTitle, setNewPageTitle] = useState("");
  const [newPageContent, setNewPageContent] = useState("");

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

  const selectCollective = (c: Collective) => {
    setCollectiveId(c.id);
    setCanEditHere(Boolean(c.canEdit));
    setOpen(null);
    setQuery("");
    setPages(null);
    void api
      .tool("collectives_get_pages", { collective_id: c.id }, instance)
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

  const openPage = (row: PageRow) => {
    if (collectiveId === null || row.id === 0) return;
    setOpen(null);
    void api
      .tool("collectives_get_page", { collective_id: collectiveId, page_id: row.id }, instance)
      .then((result) => {
        const data = partText(result).data as Record<string, unknown> | undefined;
        if (!data || typeof data.content !== "string") throw new Error(t("The page did not answer in a way this panel reads."));
        // its own words as they stand where it stands: the title from the answer, else the one the list gave
        const title = (typeof data.page === "object" && data.page !== null ? String((data.page as Record<string, unknown>).title ?? row.title) : row.title);
        setOpen({ ...row, title, content: data.content });
        setPageDraft(data.content);
      })
      .catch((error) => setProblem(sayError(error)));
  };

  /** The picked page's text written back where it stands (the way the tools themselves say a page is worded). */
  const savePage = async () => {
    if (busy || open === null) return;
    const at = pagePath(open);
    if (at === undefined) {
      setProblem(t("This page's place in the files could not be read."));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_webdav_write_file", { path: at, content: pageDraft }, instance);
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const createCollective = async () => {
    if (busy || newColName.trim() === "") return;
    const name = newColName.trim();
    const emoji = newColEmoji.trim();
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.tool("collectives_create_collective", { name, ...(emoji !== "" ? { emoji } : {}) }, instance);
      setCollectiveFormOpen(false);
      setNewColName("");
      setNewColEmoji("");
      loadCollectives();
      // the made one picked out of what stands after: where its id is read from the answer, it is opened at once
      const data = partText(result).data;
      const id = Number(typeof data === "object" && data !== null ? (data as Record<string, unknown>).id : NaN);
      if (!Number.isNaN(id)) selectCollective({ id, name, canEdit: true });
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const createPage = async () => {
    if (busy || collectiveId === null || newPageTitle.trim() === "") return;
    const title = newPageTitle.trim();
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.tool("collectives_create_page", { collective_id: collectiveId, parent_id: 0, title }, instance);
      setPageFormOpen(false);
      setNewPageTitle("");
      // the made page's own words: read back where it stands to find its file in the files
      const pagesResult = await api.tool("collectives_get_pages", { collective_id: collectiveId }, instance);
      const pdata = partText(pagesResult).data;
      const list = (arrayOf(pdata, "pages") ?? arrayOf(pdata, "results") ?? []) as Record<string, unknown>[];
      setPages(list.map(readPage));
      if (newPageContent !== "") {
        const data = partText(result).data;
        const id = Number(typeof data === "object" && data !== null ? (data as Record<string, unknown>).id : NaN);
        if (!Number.isNaN(id)) {
          const created = list.find((r) => Number(r.id) === id);
          if (created !== undefined) {
            const at = pagePath(created);
            if (at !== undefined) await api.tool("nc_webdav_write_file", { path: at, content: newPageContent }, instance);
          }
        }
      }
      setNewPageContent("");
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  // ---- the open page ---------------------------------------------------------------
  if (open !== null) {
    const writable = canEditHere && pagePath(open) !== undefined;
    return (
      <div className="space-y-2">
        <button type="button" className={portal.ui.classes.ghost} onClick={() => setOpen(null)}>
          ← {t("Pages")}
        </button>
        <div className="nc-share">
          {open.title && <p className="nc-note-text" style={{ fontWeight: 600, marginBottom: "0.2rem" }}>{open.title}</p>}
          {writable ? (
            <textarea
              className={`${portal.ui.classes.input} w-full min-h-[45%] font-mono text-xs`} // the page's own text, laid out for writing
              value={pageDraft}
              aria-label={t("The page's text")}
              onChange={(e) => setPageDraft(e.target.value)}
            />
          ) : open.content ? (
            <pre className="nc-file-text">{open.content}</pre>
          ) : (
            <p className="text-sm text-fg-subtle">{t("This page is empty.")}</p>
          )}
        </div>
        {writable && (
          <button type="button" className={portal.ui.classes.primary} disabled={busy} onClick={() => void savePage()}>
            {t("Save the page")}
          </button>
        )}
        {problem !== null && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>}
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
        {canEditHere && (
          pageFormOpen ? (
            <form
              className="nc-form space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void createPage();
              }}
            >
              <input
                className={portal.ui.classes.inputSmall}
                value={newPageTitle}
                placeholder={t("The page's title")}
                aria-label={t("The page's title")}
                onChange={(e) => setNewPageTitle(e.target.value)}
                required
              />
              <textarea
                className={`${portal.ui.classes.inputSmall} w-full min-h-[4rem]`}
                value={newPageContent}
                placeholder={t("Its text (leave it empty where the page is made blank)")}
                aria-label={t("The page's text")}
                onChange={(e) => setNewPageContent(e.target.value)}
              />
              <div className="flex gap-2">
                <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || newPageTitle.trim() === ""}>
                  {t("Make the page")}
                </button>
                <button
                  type="button"
                  className={portal.ui.classes.ghost}
                  onClick={() => {
                    setPageFormOpen(false);
                    setNewPageTitle("");
                    setNewPageContent("");
                  }}
                >
                  {t("Cancel")}
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className={portal.ui.classes.ghost} onClick={() => setPageFormOpen(true)}>
              + {t("A new page")}
            </button>
          )
        )}
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
                <button type="button" className="nc-row" onClick={() => openPage(row)}>
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
  // the form that makes a collective stands at the top of what is not made yet, and beside the list where some stand
  const collectiveForm = (
    <form
      className="nc-form space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void createCollective();
      }}
    >
      <input
        className={portal.ui.classes.inputSmall}
        value={newColName}
        placeholder={t("The collective's name")}
        aria-label={t("The collective's name")}
        onChange={(e) => setNewColName(e.target.value)}
        required
      />
      <input
        className={`${portal.ui.classes.inputSmall} w-20`}
        value={newColEmoji}
        placeholder={t("An emoji (nothing where none is wanted)")}
        aria-label={t("An emoji")}
        onChange={(e) => setNewColEmoji(e.target.value)}
      />
      <div className="flex gap-2">
        <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || newColName.trim() === ""}>
          {t("Make the collective")}
        </button>
        <button
          type="button"
          className={portal.ui.classes.ghost}
          onClick={() => {
            setCollectiveFormOpen(false);
            setNewColName("");
            setNewColEmoji("");
          }}
        >
          {t("Cancel")}
        </button>
      </div>
    </form>
  );

  if (collectives.length === 0) {
    return (
      <div className="space-y-2">
        <portal.ui.Empty>{t("No collectives are set up on this Nextcloud.")}</portal.ui.Empty>
        {collectiveFormOpen ? collectiveForm : (
          <button type="button" className={portal.ui.classes.ghost} onClick={() => setCollectiveFormOpen(true)}>
            + {t("A new collective")}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {collectiveFormOpen ? collectiveForm : (
        <button type="button" className={portal.ui.classes.ghost} onClick={() => setCollectiveFormOpen(true)}>
          + {t("A new collective")}
        </button>
      )}
      <ul className="nc-list">
        {collectives.map((c) => (
          <li key={c.id}>
            <button type="button" className="nc-row" onClick={() => selectCollective(c)}>
              <span className="flex-1 truncate">{c.emoji ? `${c.emoji} ` : ""}{c.name}</span>
              {!c.canEdit && <span className="text-xs text-fg-subtle flex-shrink-0">{t("read-only")}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
