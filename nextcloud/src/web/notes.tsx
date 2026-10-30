import { useEffect, useState } from "react";
import { LuNotebookPen } from "react-icons/lu";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useNextcloudInstance } from "./api";

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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteRow[] | null>(null);
  const [chosenId, setChosenId] = useState<number | null>(null);
  const [note, setNote] = useState<{ title: string; content: string; etag: string } | null>(null);
  const [editedTitle, setEditedTitle] = useState("");
  const [editedContent, setEditedContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const search = (text: string) => {
    setResults(null);
    void api
      .tool("nc_notes_search_notes", { query: text }, instance)
      .then((result) => {
        const rows = (arrayOf(partText(result).data, "results") ?? []).map((r) => ({ id: Number(r.id), title: String(r.title ?? ""), category: typeof r.category === "string" ? r.category : undefined }));
        setResults(rows);
      })
      .catch((error) => setProblem(sayError(error)));
  };

  useEffect(() => {
    search(""); // all the notes, to start with
  }, []);

  const open = (id: number) => {
    setChosenId(id);
    setNote(null);
    void api
      .tool("nc_notes_get_note", { note_id: id }, instance)
      .then((result) => {
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
      .catch((error) => setProblem(sayError(error)));
  };

  const save = async () => {
    if (busy || chosenId === null || note === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_notes_update_note", { note_id: chosenId, etag: note.etag, title: editedTitle, content: editedContent, category: null }, instance);
      open(chosenId); // the etag moved; read it back as it stands now
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || chosenId === null) return;
    if (!window.confirm(t("Remove this note for good?"))) return;
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

  if (chosenId === null) {
    return (
      <div className="space-y-2">
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
        {results === null ? (
          problem ? (
            <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The notes could not be read: {error}", { error: problem })}</portal.ui.ErrorBanner>
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
      <div className="flex items-center gap-1">
        <button type="button" className={portal.ui.classes.ghost} onClick={() => setChosenId(null)}>
          ← {t("All notes")}
        </button>
        <span className="flex-1" />
        <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void remove()} aria-label={t("Delete this note")}>
          {t("Delete this note")}
        </button>
      </div>
      {note === null ? (
        <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
      ) : (
        <>
          <input className={portal.ui.classes.input} value={editedTitle} aria-label={t("Note title")} onChange={(e) => setEditedTitle(e.target.value)} />
          <textarea className="nc-note-text" rows={10} value={editedContent} aria-label={t("Note content")} onChange={(e) => setEditedContent(e.target.value)} />
          <button type="button" className={portal.ui.classes.primarySmall} disabled={busy || (editedTitle === note.title && editedContent === note.content)} onClick={() => void save()}>
            {t("Save")}
          </button>
        </>
      )}
      {problem && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>}
    </div>
  );
}
