import { useEffect, useState } from "react";
import { LuNotebookPen } from "react-icons/lu";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useGuard, useNextcloudInstance } from "./api";
import { confirmDelete } from "./widgets";

/** The Notes tab: the notes by a word, one chosen open to its text -- edited and saved (the etag travels with it,
 * so an edit made elsewhere is not quietly lost), or taken away. All of it as a tool call on the server. */

interface NoteRow {
  id: number;
  title: string;
  category?: string;
}

export default function Notes() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // the panel's current instance: where the note calls go
  const guard = useGuard();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteRow[] | null>(null);
  const [chosenId, setChosenId] = useState<number | null>(null);
  const [note, setNote] = useState<{ title: string; content: string; etag: string } | null>(null);
  const [editedTitle, setEditedTitle] = useState("");
  const [editedContent, setEditedContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null); // a change or an opening that failed: drawn in whatever view stands
  const [loadError, setLoadError] = useState<string | null>(null); // the list that could not be read
  const [saved, setSaved] = useState(false);

  // the made note's words as they stand: open in the list view where nothing is chosen yet
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");

  const search = (text: string, keep = false) => {
    const current = guard("list");
    if (!keep) setResults(null);
    setLoadError(null);
    void api
      .tool("nc_notes_search_notes", { query: text }, instance)
      .then((result) => {
        if (!current()) return;
        const rows = (arrayOf(partText(result).data, "results") ?? []).map((r) => ({ id: Number(r.id), title: String(r.title ?? ""), category: typeof r.category === "string" ? r.category : undefined }));
        setResults(rows);
      })
      .catch((error) => current() && setLoadError(sayError(error)));
  };

  useEffect(() => {
    search(""); // all the notes, to start with
  }, []);

  const open = (id: number) => {
    const current = guard("note");
    setChosenId(id);
    setNote(null);
    setProblem(null);
    void api
      .tool("nc_notes_get_note", { note_id: id }, instance)
      .then((result) => {
        if (!current()) return;
        const data = partText(result).data;
        if (typeof data === "object" && data !== null && typeof (data as Record<string, unknown>).etag === "string") {
          const n = data as Record<string, unknown>;
          setNote({ title: String(n.title ?? ""), content: String(n.content ?? ""), etag: n.etag as string });
          setEditedTitle(String(n.title ?? ""));
          setEditedContent(String(n.content ?? ""));
        } else {
          setProblem(t("The note did not answer in a way this panel reads."));
        }
      })
      .catch((error) => {
        if (!current()) return;
        setChosenId(null); // back to the list, with the reason above it
        setProblem(sayError(error));
      });
  };

  const dirty = note !== null && (editedTitle !== note.title || editedContent !== note.content);
  portal.ui.useUnsavedDraft(dirty || (creating && (newTitle.trim() !== "" || newContent.trim() !== "")));

  const save = async () => {
    if (busy || chosenId === null || note === null) return;
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await api.tool("nc_notes_update_note", { note_id: chosenId, etag: note.etag, title: editedTitle, content: editedContent, category: null }, instance);
      open(chosenId); // the etag moved; read it back as it stands now
      setSaved(true);
      search(query, true);
    } catch (error) {
      const said = sayError(error);
      // Changed elsewhere since it was opened: said as that, and the words stay in the form.
      setProblem(/412|precondition|etag|changed|modified|conflict/i.test(said) ? t("The note was changed elsewhere since you opened it. Your words are still here; open the note again to see the new text. ({error})", { error: said }) : said);
    } finally {
      setBusy(false);
    }
  };

  const back = async () => {
    if (dirty && !(await portal.ui.confirm({ title: t("Leave this note without saving?"), message: t("What you changed in it is lost."), confirmLabel: t("Leave"), danger: true }))) return;
    setChosenId(null);
    setNote(null);
    setSaved(false);
    setProblem(null);
  };

  const create = async () => {
    if (busy) return;
    const title = newTitle.trim();
    if (title === "" && newContent.trim() === "") return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.tool("nc_notes_create_note", { title, content: newContent, category: "" }, instance); // no category: the note goes in the plain one
      setCreating(false);
      setNewTitle("");
      setNewContent("");
      search(""); // the list as it stands now
      // the made note's own id, where the answer carries it: opened to what was just made
      const data = partText(result).data;
      if (typeof data === "object" && data !== null) {
        const id = Number((data as Record<string, unknown>).id);
        if (!Number.isNaN(id) && id !== 0) open(id);
      }
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || chosenId === null) return;
    if (!(await confirmDelete(t("Remove this note for good?"), note?.title, t("Delete this note")))) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_notes_delete_note", { note_id: chosenId }, instance);
      setChosenId(null);
      setNote(null);
      search(query);
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const banner = problem ? <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner> : null;

  if (chosenId === null) {
    return (
      <div className="space-y-2">
        {banner}
        {/* The search is the whole of this tab while no note is open: it stands in one bordered block under a
            title, not as bare controls above an empty page. */}
        <div className="nc-note-intro">
          <p className="nc-form-title">{t("Search your notes")}</p>
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              search(query.trim());
            }}
          >
            <input className={portal.ui.classes.input} value={query} placeholder={t("Search the notes")} aria-label={t("Search the notes")} onChange={(e) => setQuery(e.target.value)} />
            <button type="submit" className={portal.ui.classes.primarySmall}>
              {t("Search")}
            </button>
          </form>
        </div>
        <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => setCreating((c) => !c)}>
          {creating ? "−" : "+"} {t("A new note")}
        </button>
        {creating && (
          <form
            className="nc-form"
            style={{ gap: "0.9rem" }}
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <p className="nc-form-title">{t("A new note")}</p>
            <div className="space-y-1">
              <span className="block text-xs font-medium text-fg-muted">{t("Title")}</span>
              <input
                className={portal.ui.classes.input}
                value={newTitle}
                placeholder={t("What it is about")}
                aria-label={t("Title")}
                onChange={(e) => setNewTitle(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <span className="block text-xs font-medium text-fg-muted">{t("Content")}</span>
              <textarea
                className="nc-note-text"
                rows={8}
                value={newContent}
                placeholder={t("Write here")}
                aria-label={t("Content")}
                onChange={(e) => setNewContent(e.target.value)}
              />
            </div>
            <div className="flex gap-1">
              <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || (newTitle.trim() === "" && newContent.trim() === "")}>
                {t("Add")}
              </button>
              <button type="button" className={portal.ui.classes.ghost} onClick={() => setCreating(false)}>
                {t("Cancel")}
              </button>
            </div>
          </form>
        )}
        {results === null ? (
          loadError ? (
            <portal.ui.LoadFailed error={t("The notes could not be read: {error}", { error: loadError })} onRetry={() => search(query.trim())} />
          ) : (
            <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
          )
        ) : results.length === 0 ? (
          <portal.ui.Empty>{query === "" ? t("No notes yet.") : t("Nothing found for “{query}”.", { query })}</portal.ui.Empty>
        ) : (
          <ul className="space-y-1">
            {results.map((row) => (
              <li key={row.id}>
                <button type="button" className="nc-open" onClick={() => open(row.id)}>
                  <LuNotebookPen className="shrink-0 text-fg-subtle" />
                  <span className="nc-open-title">{row.title}</span>
                  {row.category && row.category !== "" && <span className="nc-chip nc-chip-dim">{row.category}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {banner}
      <div className="flex items-center gap-1">
        <button type="button" className={portal.ui.classes.ghost} onClick={() => void back()}>
          ← {t("All notes")}
        </button>
        <span className="flex-1" />
        <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void remove()} aria-label={t("Delete this note")}>
          {t("Delete this note")}
        </button>
        <button type="button" className={portal.ui.classes.primarySmall} disabled={busy || note === null || (editedTitle === note.title && editedContent === note.content)} onClick={() => void save()}>
          {t("Save")}
        </button>
        {saved && !dirty && <span className="text-xs text-fg-subtle" role="status">{t("Saved.")}</span>}
      </div>
      {note === null ? (
        <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
      ) : (
        <div className="nc-note-edit">
          <input className="nc-note-title" value={editedTitle} aria-label={t("Note title")} onChange={(e) => setEditedTitle(e.target.value)} />
          <textarea className="nc-note-text" rows={8} value={editedContent} aria-label={t("Note content")} onChange={(e) => setEditedContent(e.target.value)} />
        </div>
      )}
    </div>
  );
}
