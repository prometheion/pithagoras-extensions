import { useEffect, useState } from "react";
import { LuPlus } from "react-icons/lu";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useNextcloudInstance } from "./api";

/** The Contacts tab: one address book chosen of the books; its contacts, with a search that runs over the words of
 * name, e-mail and phone; and one contact open to its detail -- the common fields read and changed (the name, one
 * e-mail, one phone, the organization, a note), and the card taken away. The list tool already answers with the full
 * cards, so opening one costs no extra call. And because the update tool takes plain words for e-mail and phone, what
 * it cannot change -- more than one of each -- stays shown but not touched. All of it as a tool call on the server. */

type Rec = Record<string, unknown>;

const strOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

interface BookRow {
  uri: string;
  displayName: string;
}
/** One contact as the list answers it -- the full card, since that is what the tool gives. */
interface ContactRow {
  uid: string;
  fn: string;
  email?: string;
  phone?: string;
  hasPhoto: boolean;
  organization?: string;
  title?: string;
  note?: string;
  emails: string[];
  phones: string[];
  etag?: string;
}

export default function Contacts() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // the panel's current instance: where the contact calls go
  const [books, setBooks] = useState<BookRow[] | null>(null);
  const [bookProblem, setBookProblem] = useState<string | null>(null);
  const [bookUri, setBookUri] = useState<string | null>(null);

  // the list and its search words (the search runs over the chosen book)
  const [rows, setRows] = useState<ContactRow[] | null>(null);
  const [listProblem, setListProblem] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // the one contact open and its edit words as they stand
  const [contact, setContact] = useState<ContactRow | null>(null);
  const [editFn, setEditFn] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editOrg, setEditOrg] = useState("");
  const [editNote, setEditNote] = useState("");
  const [contactProblem, setContactProblem] = useState<string | null>(null);

  // the new contact form, which stays folded until its button is pressed (Nextcloud does it the same way)
  const [creating, setCreating] = useState(false);
  const [newFn, setNewFn] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newOrg, setNewOrg] = useState("");
  const [newNote, setNewNote] = useState("");

  const [busy, setBusy] = useState(false);

  // the preferred one leads, as the server's own primary_email does
  const pick = (fields: unknown): string | undefined => {
    if (!Array.isArray(fields)) return undefined;
    const list = fields as Rec[];
    const pref = list.find((f) => f.preferred === true && String(f.value ?? "") !== "");
    const first = list.find((f) => String(f.value ?? "") !== "");
    const value = String((pref ?? first)?.value ?? "");
    return value !== "" ? value : undefined;
  };

  const mapRow = (c: Rec): ContactRow => {
    const emails = (Array.isArray(c.emails) ? c.emails : []).map((e: Rec) => String(e.value ?? "")).filter((v: string) => v !== "");
    const phones = (Array.isArray(c.phones) ? c.phones : []).map((p: Rec) => String(p.value ?? "")).filter((v: string) => v !== "");
    return {
      uid: String(c.uid ?? ""),
      fn: String(c.fn ?? ""),
      email: pick(c.emails),
      phone: pick(c.phones),
      hasPhoto: Boolean(c.has_photo),
      organization: strOf(c.organization),
      title: strOf(c.title),
      note: strOf(c.note),
      emails,
      phones,
      etag: strOf(c.etag),
    };
  };

  const loadBooks = () => {
    setBooks(null);
    setBookProblem(null);
    void api
      .tool("nc_contacts_list_addressbooks", {}, instance)
      .then((result) => {
        const found = (arrayOf(partText(result).data, "addressbooks") ?? []).map((b) => ({ uri: String(b.uri), displayName: String(b.displayname ?? b.uri) }));
        setBooks(found);
        if (found.length > 0 && bookUri === null) loadContacts(found[0].uri, "");
      })
      .catch((error) => setBookProblem(sayError(error)));
  };

  useEffect(() => {
    loadBooks();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadContacts = (uri: string | null, query: string) => {
    if (uri === null) return;
    setRows(null);
    setListProblem(null);
    void api
      .tool(query.trim() !== "" ? "nc_contacts_search_contacts" : "nc_contacts_list_contacts", query.trim() !== "" ? { query: query.trim(), addressbook: uri } : { addressbook: uri }, instance)
      .then((result) => {
        const data = partText(result).data;
        const list = typeof data === "object" && data !== null ? (data as Rec).contacts : undefined;
        setRows(Array.isArray(list) ? list.map(mapRow).sort((a, b) => a.fn.localeCompare(b.fn)) : []);
      })
      .catch((error) => setListProblem(sayError(error)));
  };

  // an open search follows its words with a short rest between keystrokes; switching books starts the list again
  useEffect(() => {
    if (bookUri === null) return;
    const id = window.setTimeout(() => loadContacts(bookUri, search), search.trim() === "" ? 0 : 250);
    return () => window.clearTimeout(id);
  }, [search, bookUri]); // eslint-disable-line react-hooks/exhaustive-deps

  const openContact = (row: ContactRow) => {
    if (busy) return;
    setContact(row);
    setContactProblem(null);
    setEditFn(row.fn);
    setEditEmail(row.email ?? "");
    setEditPhone(row.phone ?? "");
    setEditOrg(row.organization ?? "");
    setEditNote(row.note ?? "");
  };

  const saveContact = () => {
    if (contact === null || bookUri === null) return;
    const data: Rec = {};
    let changed = false;
    if (editFn.trim() !== "" && editFn !== contact.fn) {
      data.fn = editFn.trim();
      changed = true;
    }
    if (editEmail !== (contact.email ?? "")) {
      data.email = editEmail; // the update tool takes the one e-mail as a plain word
      changed = true;
    }
    if (editPhone !== (contact.phone ?? "")) {
      data.tel = editPhone; // and the one phone the same way
      changed = true;
    }
    if (editOrg !== (contact.organization ?? "")) {
      data.organization = editOrg;
      changed = true;
    }
    if (editNote !== (contact.note ?? "")) {
      data.note = editNote;
      changed = true;
    }
    if (!changed) return;
    void (async () => {
      setBusy(true);
      try {
        await api.tool("nc_contacts_update_contact", { addressbook: bookUri, uid: contact.uid, contact_data: data, etag: contact.etag ?? "" }, instance);
        loadContacts(bookUri, search);
      } catch (error) {
        setContactProblem(sayError(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  const deleteContact = () => {
    if (contact === null || bookUri === null) return;
    if (!window.confirm(t("Take this contact away for good?"))) return;
    void (async () => {
      setBusy(true);
      try {
        await api.tool("nc_contacts_delete_contact", { addressbook: bookUri, uid: contact.uid }, instance);
        setContact(null);
        loadContacts(bookUri, search);
      } catch (error) {
        setContactProblem(sayError(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  const createContact = () => {
    if (bookUri === null || newFn.trim() === "") return;
    const data: Rec = { fn: newFn.trim() };
    if (newEmail !== "") data.email = newEmail;
    if (newPhone !== "") data.tel = newPhone;
    if (newOrg !== "") data.organization = newOrg;
    if (newNote !== "") data.note = newNote;
    void (async () => {
      setBusy(true);
      try {
        const uid = `pithagoras-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await api.tool("nc_contacts_create_contact", { addressbook: bookUri, uid, contact_data: data }, instance);
        setNewFn("");
        setNewEmail("");
        setNewPhone("");
        setNewOrg("");
        setNewNote("");
        setCreating(false);
        loadContacts(bookUri, search);
      } catch (error) {
        setListProblem(sayError(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  // ---- what is drawn -------------------------------------------------------

  if (contact !== null) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <button type="button" className={portal.ui.classes.ghost} onClick={() => setContact(null)}>
            ← {t("Back to the list")}
          </button>
          <span className="flex-1" />
          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void deleteContact()}>
            {t("Delete this contact")}
          </button>
        </div>

        {contact.emails.length > 1 || contact.phones.length > 1 ? (
          <p className="rounded-md border px-2 py-1 text-xs text-fg-muted" style={{ borderColor: "rgb(var(--line))", background: "rgb(var(--raised))" }}>
            {t("This card carries more than one e-mail or phone; this panel only changes the first of each.")}
          </p>
        ) : null}

        <input className={portal.ui.classes.input} value={editFn} aria-label={t("Full name")} onChange={(e) => setEditFn(e.target.value)} />
        <input className={portal.ui.classes.input} type="email" value={editEmail} placeholder={t("E-mail address")} aria-label={t("E-mail address")} onChange={(e) => setEditEmail(e.target.value)} />
        <input className={portal.ui.classes.input} value={editPhone} placeholder={t("Phone number")} aria-label={t("Phone number")} onChange={(e) => setEditPhone(e.target.value)} />
        <input className={portal.ui.classes.input} value={editOrg} placeholder={t("Organization")} aria-label={t("Organization")} onChange={(e) => setEditOrg(e.target.value)} />
        <textarea className="nc-note-text" rows={3} value={editNote} placeholder={t("Note")} aria-label={t("Note")} onChange={(e) => setEditNote(e.target.value)} />
        {contact.title !== undefined && <p className="px-1 text-xs text-fg-subtle">{t("Title")}: {contact.title}</p>}
        <button type="button" className={portal.ui.classes.primarySmall} disabled={busy} onClick={() => void saveContact()}>
          {t("Save")}
        </button>
        {contactProblem !== null && <portal.ui.ErrorBanner onClose={() => setContactProblem(null)}>{contactProblem}</portal.ui.ErrorBanner>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {books === null ? (
        bookProblem !== null ? (
          <portal.ui.ErrorBanner onClose={() => setBookProblem(null)}>{t("The address books could not be read: {error}", { error: bookProblem })}</portal.ui.ErrorBanner>
        ) : (
          <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
        )
      ) : books.length === 0 ? (
        <portal.ui.Empty>{t("No address books yet.")}</portal.ui.Empty>
      ) : (
        <>
          <div className="flex gap-1" role="group">
            {books.map((b) => (
              <button key={b.uri} type="button" aria-pressed={b.uri === bookUri} className={`nc-tab${b.uri === bookUri ? " nc-tab-on" : ""}`} onClick={() => setBookUri(b.uri)}>
                {b.displayName}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            <input
              className={portal.ui.classes.input}
              style={{ flex: 1, minWidth: 0 }}
              value={search}
              placeholder={t("Search the contacts")}
              aria-label={t("Search the contacts")}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button type="button" className={portal.ui.classes.ghost} disabled={creating || busy} onClick={() => setCreating(!creating)} aria-expanded={creating}>
              <LuPlus size={14} /> {t("New contact")}
            </button>
          </div>

          {creating ? (
            <form className="nc-form">
              <p className="nc-form-title">{t("A new contact in this book")}</p>
              <input className={portal.ui.classes.input} value={newFn} placeholder={t("Full name")} aria-label={t("Full name")} onChange={(e) => setNewFn(e.target.value)} />
              <div className="flex gap-1">
                <input className={portal.ui.classes.input} type="email" value={newEmail} placeholder={t("E-mail address")} aria-label={t("E-mail address")} onChange={(e) => setNewEmail(e.target.value)} />
                <input className={portal.ui.classes.input} value={newPhone} placeholder={t("Phone number")} aria-label={t("Phone number")} onChange={(e) => setNewPhone(e.target.value)} />
              </div>
              <div className="flex gap-1">
                <input className={portal.ui.classes.input} value={newOrg} placeholder={t("Organization")} aria-label={t("Organization")} onChange={(e) => setNewOrg(e.target.value)} />
                <input className={portal.ui.classes.input} value={newNote} placeholder={t("Note")} aria-label={t("Note")} onChange={(e) => setNewNote(e.target.value)} />
              </div>
              <div className="flex gap-1">
                <button type="button" className={portal.ui.classes.primarySmall} disabled={busy || newFn.trim() === ""} onClick={() => void createContact()}>
                  {t("Add")}
                </button>
                <button type="button" className={portal.ui.classes.ghost} onClick={() => setCreating(false)}>
                  {t("Cancel")}
                </button>
              </div>
            </form>
          ) : null}

          {rows === null ? (
            listProblem !== null ? (
              <portal.ui.ErrorBanner onClose={() => setListProblem(null)}>{t("The contacts could not be read: {error}", { error: listProblem })}</portal.ui.ErrorBanner>
            ) : (
              <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
            )
          ) : rows.length === 0 ? (
            <portal.ui.Empty>{search.trim() !== "" ? t("No contact matches these words.") : t("No contacts in this book yet.")}</portal.ui.Empty>
          ) : (
            <ul className="space-y-0.5">
              {rows.map((c) => (
                <li key={c.uid}>
                  <button type="button" className="nc-contact" onClick={() => openContact(c)}>
                    <span className="min-w-0 flex-1 truncate text-left">{c.fn}</span>
                    {c.hasPhoto && <span className="shrink-0 nc-dot" style={{ background: "rgb(var(--fg-subtle))" }} title={t("Has a photo")} />}
                    {c.email !== undefined && <span className="nc-contact-sub shrink-0 truncate">{c.email}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {listProblem !== null && rows !== null && <portal.ui.ErrorBanner onClose={() => setListProblem(null)}>{listProblem}</portal.ui.ErrorBanner>}
        </>
      )}
    </div>
  );
}
