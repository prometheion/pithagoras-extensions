import { useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useGuard, useNextcloudInstance } from "./api";

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
  const guard = useGuard();
  const [collectives, setCollectives] = useState<Collective[] | null>(null);
  const [collectiveId, setCollectiveId] = useState<number | null>(null);
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  /** The page open: what the list knew of it, its text as it was read, and the etag of its file at that moment -- the
   * save is made against it, so what someone else wrote in between is not quietly written over. */
  const [open, setOpen] = useState<(PageRow & { content: string; etag?: string; notEditable?: string }) | null>(null);
  const [pageDraft, setPageDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null); // a change or an opening that failed: drawn in whatever view stands
  const [loadError, setLoadError] = useState<string | null>(null); // a list that could not be read

  // what the picked collective may be done to, and the forms that make a collective or a page
  const [canEditHere, setCanEditHere] = useState(false);
  const [collectiveFormOpen, setCollectiveFormOpen] = useState(false);
  const [newColName, setNewColName] = useState("");
  const [newColEmoji, setNewColEmoji] = useState("");
  const [pageFormOpen, setPageFormOpen] = useState(false);
  const [newPageTitle, setNewPageTitle] = useState("");
  const [newPageContent, setNewPageContent] = useState("");

  const dirty = open !== null && pageDraft !== open.content;
  portal.ui.useUnsavedDraft(dirty || (pageFormOpen && (newPageTitle.trim() !== "" || newPageContent.trim() !== "")));

  const loadCollectives = () => {
    const current = guard("collectives");
    setCollectives(null);
    setLoadError(null);
    void api
      .tool("collectives_get_collectives", {}, instance)
      .then((result) =>
        current() &&
        setCollectives(
          (arrayOf(partText(result).data, "collectives") ?? []).map((c) => ({
            id: Number(c.id),
            name: String(c.name ?? ""),
            emoji: typeof c.emoji === "string" && c.emoji ? c.emoji : undefined,
            canEdit: Boolean(c.can_edit ?? c.canEdit),
          })),
        ),
      )
      .catch((error) => current() && setLoadError(sayError(error)));
  };

  // the panel remounts this tab for another instance (client.tsx keys it by one), so a first load is all there is
  useEffect(() => { loadCollectives(); }, []);

  const toPages = (result: Awaited<ReturnType<typeof api.tool>>, ...keys: string[]): PageRow[] => {
    const data = partText(result).data;
    return keys.reduce<Record<string, unknown>[] | undefined>((found, key) => found ?? (arrayOf(data, key) as Record<string, unknown>[] | undefined), undefined)?.map(readPage) ?? [];
  };

  /** The pages of a collective, read again; those on screen stay while they come where `keep` says so. */
  const loadPages = (id: number, keep = false) => {
    const current = guard("pages");
    if (!keep) setPages(null);
    setLoadError(null);
    void api
      .tool("collectives_get_pages", { collective_id: id }, instance)
      .then((result) => current() && setPages(toPages(result, "pages", "results")))
      .catch((error) => current() && setLoadError(sayError(error)));
  };

  const selectCollective = (c: Collective) => {
    setCollectiveId(c.id);
    setCanEditHere(Boolean(c.canEdit));
    setOpen(null);
    setQuery("");
    setProblem(null);
    loadPages(c.id);
  };

  const search = () => {
    if (collectiveId === null) return;
    const text = query.trim();
    if (!text) {
      loadPages(collectiveId); // nothing to look for is the whole list again, not the last search's result
      return;
    }
    const current = guard("pages");
    setSearching(true);
    setProblem(null);
    void api
      .tool("collectives_search_pages", { collective_id: collectiveId, query: text }, instance)
      .then((result) => current() && setPages(toPages(result, "results", "pages")))
      .catch((error) => current() && setProblem(sayError(error)))
      .finally(() => current() && setSearching(false));
  };

  /** A page opened to its text, with the etag of its file when it can be written. `draft` is words to put in it instead
   * (a new page's). Says whether it opened. */
  const showPage = async (row: PageRow, draft?: string): Promise<boolean> => {
    if (collectiveId === null || row.id === 0) return false;
    const current = guard("page");
    setOpen(null);
    setSaved(false);
    setProblem(null);
    try {
      const result = await api.tool("collectives_get_page", { collective_id: collectiveId, page_id: row.id }, instance);
      const data = partText(result).data as Record<string, unknown> | undefined;
      if (!data || typeof data.content !== "string") throw new Error(t("The page did not answer in a way this panel reads."));
      // its own words as they stand where it stands: the title from the answer, else the one the list gave
      const title = (typeof data.page === "object" && data.page !== null ? String((data.page as Record<string, unknown>).title ?? row.title) : row.title);
      const at = pagePath(row);
      let etag: string | undefined;
      let notEditable: string | undefined;
      if (canEditHere && at !== undefined) {
        // The file as it stands now: its etag is what a save is made against (the server writes an existing file only
        // then). Where it cannot be read (Files switched off for the instance, say), the page still opens, to be read.
        try {
          const read = partText(await api.tool("nc_webdav_read_file", { path: at }, instance)).data;
          etag = typeof read === "object" && read !== null ? strOf((read as Record<string, unknown>).etag) : undefined;
        } catch (error) {
          notEditable = sayError(error);
        }
      }
      if (!current()) return false;
      setOpen({ ...row, title, content: data.content, etag, notEditable });
      setPageDraft(draft ?? data.content);
      return true;
    } catch (error) {
      if (current()) setProblem(sayError(error));
      return false;
    }
  };

  const leavePage = async () => {
    if (dirty && !(await portal.ui.confirm({ title: t("Leave this page without saving?"), message: t("What you changed in it is lost."), confirmLabel: t("Leave"), danger: true }))) return;
    setOpen(null);
    setSaved(false);
  };

  /** The picked page's text written back where it stands, against the etag it was read with. */
  const savePage = async () => {
    if (busy || open === null) return;
    const at = pagePath(open);
    if (at === undefined || open.etag === undefined) {
      setProblem(t("This page's place in the files could not be read."));
      return;
    }
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      const answer = partText(await api.tool("nc_webdav_write_file", { path: at, content: pageDraft, if_match: open.etag }, instance)).data;
      let etag = typeof answer === "object" && answer !== null ? strOf((answer as Record<string, unknown>).etag) : undefined;
      if (etag === undefined) {
        // the server did not return one (a proxy strips it): the file read again gives it
        const read = partText(await api.tool("nc_webdav_read_file", { path: at }, instance)).data;
        etag = typeof read === "object" && read !== null ? strOf((read as Record<string, unknown>).etag) : undefined;
      }
      setOpen({ ...open, content: pageDraft, etag });
      setSaved(true);
      if (collectiveId !== null) loadPages(collectiveId, true);
    } catch (error) {
      const said = sayError(error);
      // The page was changed by someone else since it was opened: said as that, and the words stay here.
      setProblem(/412|precondition|etag|changed|modified|conflict/i.test(said) ? t("The page was changed elsewhere since you opened it. Your words are still here; open the page again to see the new text. ({error})", { error: said }) : said);
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
    const content = newPageContent;
    setBusy(true);
    setProblem(null);
    // The typed text leaves the form only once it stands somewhere else: in the page's file, or in the open page.
    let made = false;
    try {
      const result = await api.tool("collectives_create_page", { collective_id: collectiveId, parent_id: 0, title }, instance);
      made = true;
      setPageFormOpen(false);
      setNewPageTitle("");
      // the made page's own words: read back where it stands to find its file in the files
      const list = toPages(await api.tool("collectives_get_pages", { collective_id: collectiveId }, instance), "pages", "results");
      setPages(list);
      if (content === "") return;
      const data = partText(result).data;
      const id = Number(typeof data === "object" && data !== null ? (data as Record<string, unknown>).id : NaN);
      const created = list.find((r) => r.id === id);
      if (created === undefined) {
        setPageFormOpen(true); // the words stand in the form again
        setProblem(t("The page “{title}” is made, but its text could not be put in it: the page was not found in the list.", { title }));
        return;
      }
      // The page's file exists now (the server made it with the page): its text is written against the etag it has.
      // Where that fails the page stands open with the words in it, ready to be saved again -- they are not lost.
      try {
        const at = pagePath(created);
        if (at === undefined) throw new Error(t("This page's place in the files could not be read."));
        const read = partText(await api.tool("nc_webdav_read_file", { path: at }, instance)).data;
        const etag = typeof read === "object" && read !== null ? strOf((read as Record<string, unknown>).etag) : undefined;
        if (etag === undefined) throw new Error(t("The page's file did not say which version it is."));
        await api.tool("nc_webdav_write_file", { path: at, content, if_match: etag }, instance);
        setNewPageContent("");
        loadPages(collectiveId, true);
      } catch (error) {
        // The page open with the words in it holds them (to be saved again, or copied where it cannot be written);
        // where it does not open either, the form does.
        if (await showPage(created, content)) setNewPageContent("");
        else setPageFormOpen(true);
        setProblem(t("The page “{title}” is made, but its text could not be put in it: {error}", { title, error: sayError(error) }));
      }
    } catch (error) {
      if (made) setPageFormOpen(true); // made, but what came after failed: the words stand in the form again
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const banner = problem !== null ? <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner> : null;

  // ---- the open page ---------------------------------------------------------------
  if (open !== null) {
    const writable = canEditHere && open.etag !== undefined;
    return (
      <div className="space-y-2">
        {banner}
        <button type="button" className={portal.ui.classes.ghost} onClick={() => void leavePage()}>
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
            <portal.ui.Markdown>{open.content}</portal.ui.Markdown>
          ) : (
            <p className="text-sm text-fg-subtle">{t("This page is empty.")}</p>
          )}
          {!writable && dirty && (
            // Words that could not be written (a new page's, where its file cannot be read): kept here to be copied.
            <textarea className={`${portal.ui.classes.input} w-full min-h-[25%] font-mono text-xs`} value={pageDraft} readOnly aria-label={t("Your text, not saved")} />
          )}
          {canEditHere && open.notEditable !== undefined && (
            <p className="text-xs text-fg-subtle">{t("This page cannot be edited here: {error}", { error: open.notEditable })}</p>
          )}
        </div>
        {writable && (
          <div className="flex items-center gap-2">
            <button type="button" className={portal.ui.classes.primary} disabled={busy || !dirty} onClick={() => void savePage()}>
              {t("Save the page")}
            </button>
            {saved && !dirty && <span className="text-xs text-fg-subtle" role="status">{t("Saved.")}</span>}
          </div>
        )}
      </div>
    );
  }

  // ---- the collective's pages ---------------------------------------------------------
  if (collectiveId !== null) {
    return (
      <div className="space-y-2">
        {banner}
        <button type="button" className={portal.ui.classes.ghost} onClick={() => { setProblem(null); setLoadError(null); setCollectiveId(null); }}>
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
          loadError ? (
            <portal.ui.LoadFailed error={t("The pages could not be read: {error}", { error: loadError })} onRetry={() => loadPages(collectiveId)} />
          ) : (
            <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
          )
        ) : pages.length === 0 ? (
          <portal.ui.Empty>{query.trim() ? t("Nothing matched the search.") : t("This collective has no pages yet.")}</portal.ui.Empty>
        ) : (
          <ul className="nc-list">
            {pages.map((row) => (
              <li key={row.id}>
                <button type="button" className="nc-row" onClick={() => void showPage(row)}>
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
    return loadError ? (
      <portal.ui.LoadFailed error={t("The collectives could not be read: {error}", { error: loadError })} onRetry={loadCollectives} />
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
        {banner}
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
      {banner}
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
