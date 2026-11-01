import { useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useGuard, useNextcloudInstance } from "./api";
import { confirmDelete } from "./widgets";

/** The Mail tab: the account's mailboxes with their unread counts, one mailbox's messages in it, and the picked
 * message open to its text and its attachments. Opening a message marks it read; one more tap puts it back. All of
 * it as tool calls on the server, sent where the panel's switcher holds. (A body the server gives as HTML is shown as
 * the text it says.) */

interface Account {
  id: number;
  email: string;
}

interface Mailbox {
  databaseId: number;
  name: string;
  displayName?: string;
  unread: number;
}

interface Address {
  label?: string;
  email?: string;
}

interface MessageRow {
  databaseId: number;
  subject: string;
  dateInt?: number;
  from: Address[];
  preview?: string;
  unseen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

interface Attachment {
  name?: string;
  size?: number;
  mime?: string;
}

interface OpenMessage {
  subject: string;
  dateInt?: number;
  from: Address[];
  to: Address[];
  body: string;
  html: boolean;
  attachments: Attachment[];
  seen: boolean;
  flagged: boolean;
}

/** A unix-seconds moment in the reader's words (the portal's language), nothing where it stands at zero. */
const fmtDate = (value?: number): string => (value ? portal.format.dateTime(value * 1000) : "");

const readAddress = (value: unknown): Address[] =>
  Array.isArray(value) ? value.map((a) => ({ label: typeof a?.label === "string" ? a.label : undefined, email: typeof a?.email === "string" ? a.email : undefined })) : [];

/** A message the server gave as HTML, as the text it says: tags gone, line breaks kept. DOMParser makes an inert
 * document -- nothing in it runs or loads -- and its text is all that is taken. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n"), "text/html");
  doc.querySelectorAll("script, style, head").forEach((node) => node.remove());
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

const readBody = (message: Record<string, unknown>): OpenMessage => {
  const flags = (typeof message.flags === "object" && message.flags !== null ? message.flags : {}) as Record<string, unknown>;
  const html = Boolean(message.has_html_body);
  const body = typeof message.body === "string" ? message.body : "";
  return {
    subject: typeof message.subject === "string" ? message.subject : "",
    dateInt: typeof message.date_int === "number" ? message.date_int : undefined,
    from: readAddress(message.from_ ?? message.from),
    to: readAddress(message.to),
    body: html || /^\s*<(!doctype|html|body|div|p|table)\b/i.test(body) ? htmlToText(body) : body,
    html,
    attachments: (Array.isArray(message.attachments) ? message.attachments : []).map((a) => ({
      name: typeof a?.file_name === "string" ? a.file_name : undefined,
      size: typeof a?.size === "number" ? a.size : undefined,
      mime: typeof a?.mime === "string" ? a.mime : undefined,
    })),
    seen: Boolean(flags.seen),
    flagged: Boolean(flags.flagged),
  };
};

/** A person in an address field: their name where the server gave one, their address otherwise. */
const who = (list: Address[]): string => {
  const first = list[0];
  if (!first) return "";
  if (first.label && first.email) return `${first.label} <${first.email}>`;
  return first.label ?? first.email ?? "";
};

/** The words of an address field -- addresses separated by comma or point-comma, each plain (`max@x.de`) or with a
 * name (`Max Muster <max@x.de>`, `"Muster, Max" <max@x.de>`) -- into what the mail tools take: an array of
 * `{label, email}`. A part that is no address is returned apart, to be said. */
export function parseRecipients(word: string): { list: Address[]; bad: string[] } {
  const parts: string[] = [];
  let part = "";
  let quoted = false;
  for (const ch of word) {
    if (ch === '"') quoted = !quoted;
    if ((ch === "," || ch === ";") && !quoted) {
      parts.push(part);
      part = "";
    } else part += ch;
  }
  parts.push(part);
  const list: Address[] = [];
  const bad: string[] = [];
  for (const raw of parts.map((p) => p.trim()).filter((p) => p !== "")) {
    const named = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(raw);
    if (named) {
      const label = named[1].replace(/^"(.*)"$/, "$1").trim();
      list.push(label ? { label, email: named[2] } : { email: named[2] });
    } else if (/^[^<>\s@]+@[^<>\s@]+$/.test(raw)) list.push({ email: raw });
    else bad.push(raw);
  }
  return { list, bad };
}

export default function Mail() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // where the mail calls go: the panel's held instance
  const guard = useGuard();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
  const [mailboxId, setMailboxId] = useState<number | null>(null);
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [open, setOpen] = useState<{ id: number; message: OpenMessage } | null>(null);
  const [busy, setBusy] = useState(false);

  // What went wrong, drawn at the top of whatever view stands (a failed send is seen in the form it came from), and
  // what a load could not read (drawn in place of the list, with a way to try again). Both clear when a new request starts.
  const [problem, setProblem] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // the made message's words as they stand in the form: sent away or laid down as a draft where an account is picked
  const [composing, setComposing] = useState(false);
  const [cTo, setCTo] = useState("");
  const [cCc, setCCc] = useState("");
  const [cBcc, setCBcc] = useState("");
  const [cSubject, setCSubject] = useState("");
  const [cBody, setCBody] = useState("");
  // where the opened message is moved to, and a short word said once after what stood behind it
  const [moveBox, setMoveBox] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const draft = composing && (cTo.trim() !== "" || cCc.trim() !== "" || cBcc.trim() !== "" || cSubject.trim() !== "" || cBody.trim() !== "");
  portal.ui.useUnsavedDraft(draft);

  /** Leaving the form with words in it asks first; true where it may go on. */
  const mayDropDraft = async (): Promise<boolean> =>
    !draft || (await portal.ui.confirm({ title: t("Throw this message away?"), message: t("What you wrote is not sent and not saved."), confirmLabel: t("Throw it away"), danger: true }));

  const loadAccounts = () => {
    const current = guard("accounts");
    setAccounts(null);
    setLoadError(null);
    void api
      .tool("nc_mail_list_accounts", {}, instance)
      .then((result) => current() && setAccounts((arrayOf(partText(result).data, "results") ?? []).map((a) => ({ id: Number(a.id), email: String(a.email ?? a.emailAddress ?? "") }))))
      .catch((error) => current() && setLoadError(sayError(error)));
  };

  // the panel remounts this tab for another instance (client.tsx keys it by one), so a first load is all there is
  useEffect(() => { loadAccounts(); }, []);

  const toMailbox = (m: Record<string, unknown>): Mailbox => ({
    databaseId: Number(m.database_id ?? m.databaseId),
    name: String(m.name ?? ""),
    displayName: typeof m.display_name === "string" ? m.display_name : undefined,
    unread: Number(m.unread ?? 0),
  });

  /** The mailboxes of an account, read again; those on screen stay while they come (the counts after a move or a send). */
  const loadMailboxes = (id: number, keep = false) => {
    const current = guard("mailboxes");
    if (!keep) setMailboxes(null);
    setLoadError(null);
    void api
      .tool("nc_mail_list_mailboxes", { account_id: id }, instance)
      .then((result) => current() && setMailboxes((arrayOf(partText(result).data, "results") ?? []).map(toMailbox)))
      .catch((error) => current() && setLoadError(sayError(error)));
  };

  const selectAccount = (id: number) => {
    setAccountId(id);
    setMailboxId(null);
    setProblem(null);
    loadMailboxes(id);
  };

  const loadMessages = (databaseId: number, keep = false) => {
    const current = guard("messages");
    if (!keep) setMessages(null);
    setLoadError(null);
    void api
      .tool("nc_mail_list_messages", { mailbox_id: databaseId, limit: 50 }, instance)
      .then((result) =>
        current() &&
        setMessages(
          (arrayOf(partText(result).data, "results") ?? []).map((m) => {
            const flags = (typeof m.flags === "object" && m.flags !== null ? m.flags : {}) as Record<string, unknown>;
            return {
              databaseId: Number(m.database_id ?? m.databaseId),
              subject: typeof m.subject === "string" ? m.subject : "",
              dateInt: typeof m.date_int === "number" ? m.date_int : undefined,
              from: readAddress(m.from_ ?? m.from),
              preview: typeof m.preview_text === "string" ? m.preview_text : undefined,
              unseen: !Boolean(flags.seen),
              flagged: Boolean(flags.flagged),
              hasAttachments: Boolean(flags.has_attachments),
            };
          }),
        ),
      )
      .catch((error) => current() && setLoadError(sayError(error)));
  };

  const selectMailbox = (databaseId: number) => {
    setMailboxId(databaseId);
    setOpen(null);
    setProblem(null);
    loadMessages(databaseId);
  };

  /** A message's flags changed: its row in the list says so, and the mailbox's unread count follows. */
  const flagged = (id: number, patch: { seen?: boolean; flagged?: boolean }) => {
    const row = messages?.find((m) => m.databaseId === id);
    setMessages((rows) => rows && rows.map((m) => (m.databaseId === id ? { ...m, ...(patch.seen !== undefined ? { unseen: !patch.seen } : {}), ...(patch.flagged !== undefined ? { flagged: patch.flagged } : {}) } : m)));
    if (row && patch.seen !== undefined && row.unseen === patch.seen) {
      const delta = patch.seen ? -1 : 1;
      setMailboxes((boxes) => boxes && boxes.map((b) => (b.databaseId === mailboxId ? { ...b, unread: Math.max(0, b.unread + delta) } : b)));
    }
  };

  const openMessage = (databaseId: number) => {
    const current = guard("open");
    setOpen(null);
    setProblem(null);
    void api
      .tool("nc_mail_get_message", { message_id: databaseId }, instance)
      .then(async (result) => {
        const data = partText(result).data as Record<string, unknown> | undefined;
        const message = (typeof data?.message === "object" && data.message !== null ? data.message : data) as Record<string, unknown> | undefined;
        if (!message) throw new Error(t("The message did not answer in a way this panel reads."));
        const read = readBody(message);
        // Opening is reading: where it stood unread, mark it seen (and say so beside the text).
        if (!read.seen) {
          try {
            await api.tool("nc_mail_set_flags", { message_id: databaseId, seen: true }, instance);
            read.seen = true;
            flagged(databaseId, { seen: true });
          } catch {
            /* marking is a courtesy; the text stands regardless */
          }
        }
        if (current()) setOpen({ id: databaseId, message: read });
      })
      .catch((error) => current() && setProblem(sayError(error)));
  };

  const toggleRead = async () => {
    if (busy || open === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const seen = !open.message.seen;
      await api.tool("nc_mail_set_flags", { message_id: open.id, seen }, instance);
      setOpen({ ...open, message: { ...open.message, seen } });
      flagged(open.id, { seen });
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const starToggle = async () => {
    if (busy || open === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const star = !open.message.flagged;
      await api.tool("nc_mail_set_flags", { message_id: open.id, flagged: star }, instance);
      setOpen({ ...open, message: { ...open.message, flagged: star } });
      flagged(open.id, { flagged: star });
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  /** The opened message laid away to the picked mailbox; its id is dead with the move, so the mailbox is read again,
   * and the mailboxes with it (their counts moved). */
  const moveOpen = () => {
    if (busy || open === null || moveBox === null || mailboxId === null || moveBox === mailboxId || accountId === null) return;
    setBusy(true);
    setProblem(null);
    void api
      .tool("nc_mail_move_message", { message_id: open.id, destination_mailbox_id: moveBox }, instance)
      .then(() => {
        setOpen(null);
        loadMessages(mailboxId, true);
        loadMailboxes(accountId, true);
      })
      .catch((error) => setProblem(sayError(error)))
      .finally(() => setBusy(false));
  };

  const deleteOpen = async () => {
    if (busy || open === null || mailboxId === null || accountId === null) return;
    if (!(await confirmDelete(t("Take this message to the trash?"), open.message.subject, t("Delete")))) return;
    setBusy(true);
    setProblem(null);
    void api
      .tool("nc_mail_delete_message", { message_id: open.id }, instance)
      .then(() => {
        setOpen(null);
        loadMessages(mailboxId, true);
        loadMailboxes(accountId, true);
      })
      .catch((error) => setProblem(sayError(error)))
      .finally(() => setBusy(false));
  };

  const clearForm = () => {
    setComposing(false);
    setCTo("");
    setCCc("");
    setCBcc("");
    setCSubject("");
    setCBody("");
  };

  /** The made message sent away or laid down as a draft, from the one account it stands under. Only the Send button
   * sends: Enter in a field of the form does nothing, as a mail that has gone cannot be taken back. */
  const sendOrDraft = async (mode: "send" | "draft") => {
    if (busy || accountId === null) return;
    const to = parseRecipients(cTo);
    const cc = parseRecipients(cCc);
    const bcc = parseRecipients(cBcc);
    const bad = [...to.bad, ...cc.bad, ...bcc.bad];
    if (bad.length > 0) {
      setProblem(t("Not an address: {words}", { words: bad.join(", ") }));
      return;
    }
    if (to.list.length === 0) {
      setProblem(t("Give the message at least one recipient."));
      return;
    }
    if (mode === "send" && cSubject.trim() === "" && cBody.trim() === "" && !(await portal.ui.confirm({ title: t("Send an empty message?"), message: t("It has no subject and no text."), confirmLabel: t("Send") }))) return;
    // the mail tools take their recipients as a JSON array of {"label", "email"} objects, as a word
    const args: Record<string, unknown> = { account_id: accountId, to: JSON.stringify(to.list), subject: cSubject.trim(), body: cBody };
    if (cc.list.length > 0) args.cc = JSON.stringify(cc.list);
    if (bcc.list.length > 0) args.bcc = JSON.stringify(bcc.list);
    setBusy(true);
    setProblem(null);
    try {
      await api.tool(mode === "send" ? "nc_mail_send_message" : "nc_mail_save_draft", args, instance);
      clearForm();
      setNotice(mode === "send" ? t("The message is sent.") : t("The draft is laid down in the account's Drafts."));
      loadMailboxes(accountId, true); // the mailboxes' counts as they stand now
    } catch (error) {
      setProblem(sayError(error)); // the form stays as it was, with the reason above it
    } finally {
      setBusy(false);
    }
  };

  const banner = problem ? <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner> : null;
  const failed = (text: string, retry: () => void) => <portal.ui.LoadFailed error={text} onRetry={retry} />;

  // ---- the open message ------------------------------------------------------
  if (open !== null) {
    const m = open.message;
    return (
      <div className="space-y-2">
        {banner}
        <div className="flex items-center gap-1">
          <button type="button" className={portal.ui.classes.ghost} onClick={() => { setProblem(null); setOpen(null); }}>
            ← {t("Messages")}
          </button>
          <span className="flex-1" />
          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void starToggle()} title={m.flagged ? t("Take the star off") : t("Star this message")}>
            {m.flagged ? "★" : "☆"}
          </button>
          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void toggleRead()}>
            {m.seen ? t("Mark unread") : t("Mark read")}
          </button>
          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void deleteOpen()}>
            {t("Delete")}
          </button>
        </div>
        {mailboxes !== null && mailboxes.length > 1 && (
          <div className="flex items-center gap-1">
            <portal.ui.Select
              size="sm"
              className="min-w-0 flex-1"
              value={moveBox === null ? "" : String(moveBox)}
              aria-label={t("Move this message to")}
              onChange={(v) => setMoveBox(v === "" ? null : Number(v))}
              options={([
                { value: "", label: t("Move this message to…") },
                ...mailboxes.filter((box) => box.databaseId !== mailboxId).map((box) => ({ value: String(box.databaseId), label: box.displayName ?? box.name })),
              ] as { value: string; label: string }[])}
            />
            <button type="button" className={portal.ui.classes.primarySmall} disabled={busy || moveBox === null} onClick={() => void moveOpen()}>
              {t("Move")}
            </button>
          </div>
        )}
        <div className="nc-share">
          <p className="nc-note-text" style={{ fontWeight: 600, marginBottom: "0.2rem" }}>
            {m.subject || t("(no subject)")}
          </p>
          <p className="text-xs text-fg-subtle mb-0.5">
            {who(m.from)} — {fmtDate(m.dateInt)}
            {m.to.length > 0 && ` → ${who(m.to)}`}
          </p>
          {m.body ? (
            <pre className="nc-file-text">{m.body}</pre>
          ) : (
            <p className="text-sm text-fg-subtle">{t("This message has no body.")}</p>
          )}
          {m.attachments.length > 0 && (
            <div className="mt-2 space-y-1">
              <p className="nc-form-title">{t("Attachments")}</p>
              {m.attachments.map((a, i) => (
                <p key={i} className="text-xs text-fg-muted">
                  {a.name ?? t("(unnamed)")}{a.size !== undefined ? ` · ${Math.max(1, Math.round(a.size / 1024))} KiB` : ""}
                  {a.mime ? ` · ${a.mime}` : ""}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- the mailbox's messages --------------------------------------------------
  if (mailboxId !== null) {
    return (
      <div className="space-y-2">
        {banner}
        <button type="button" className={portal.ui.classes.ghost} onClick={() => { setProblem(null); setLoadError(null); setMailboxId(null); }}>
          ← {t("Mailboxes")}
        </button>
        {messages === null ? (
          loadError ? (
            failed(t("The messages could not be read: {error}", { error: loadError }), () => loadMessages(mailboxId))
          ) : (
            <portal.ui.RowsSkeleton rows={5} label={t("Loading…")} />
          )
        ) : messages.length === 0 ? (
          <portal.ui.Empty>{t("This mailbox is empty.")}</portal.ui.Empty>
        ) : (
          <ul className="nc-list">
            {messages.map((row) => (
              <li key={row.databaseId}>
                <button type="button" className={`nc-row${row.unseen ? "" : " nc-chip-dim"}`} onClick={() => openMessage(row.databaseId)}>
                  <span style={{ flex: "1 1 auto", minWidth: 0 }}>
                    <span className="block truncate">
                      {row.unseen && <span className="nc-chip mr-1 align-middle">{t("new")}</span>}
                      {row.flagged && "★ "}
                      {row.subject || t("(no subject)")}
                    </span>
                    <span className="block truncate text-xs text-fg-subtle">
                      {who(row.from)}{row.preview ? ` — ${row.preview}` : ""}
                    </span>
                  </span>
                  <span className="text-xs text-fg-subtle flex flex-col items-end gap-0.5 flex-shrink-0">
                    <span>{fmtDate(row.dateInt)}</span>
                    {row.hasAttachments && <span title={t("Has attachments")}>📎</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ---- the account's mailboxes ---------------------------------------------------
  if (accountId !== null) {
    return (
      <div className="space-y-2">
        {banner}
        <div className="flex items-center gap-1">
          <button type="button" className={portal.ui.classes.ghost} onClick={() => void mayDropDraft().then((ok) => { if (!ok) return; clearForm(); setProblem(null); setLoadError(null); setAccountId(null); })}>
            ← {t("Accounts")}
          </button>
          <span className="flex-1" />
          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => { if (composing) void mayDropDraft().then((ok) => ok && clearForm()); else { setComposing(true); setNotice(null); } }}>
            {composing ? "−" : "+"} {t("A new message")}
          </button>
        </div>
        {notice !== null && <p className="text-xs text-fg-muted" role="status">{notice}</p>}
        {composing && (
          <form className="nc-form" onSubmit={(e) => e.preventDefault()}>
            <input className={portal.ui.classes.input} value={cTo} placeholder={t("To, comma-separated")} aria-label={t("To, comma-separated")} onChange={(e) => setCTo(e.target.value)} />
            <div className="flex gap-1">
              <input className={portal.ui.classes.input} value={cCc} placeholder={t("Cc (optional)")} aria-label={t("Cc (optional)")} onChange={(e) => setCCc(e.target.value)} />
              <input className={portal.ui.classes.input} value={cBcc} placeholder={t("Bcc (optional)")} aria-label={t("Bcc (optional)")} onChange={(e) => setCBcc(e.target.value)} />
            </div>
            <input className={portal.ui.classes.input} value={cSubject} placeholder={t("Subject")} aria-label={t("Subject")} onChange={(e) => setCSubject(e.target.value)} />
            <textarea className="nc-note-text" rows={6} value={cBody} placeholder={t("The message's text")} aria-label={t("The message's text")} onChange={(e) => setCBody(e.target.value)} />
            <div className="flex gap-1">
              <button type="button" className={portal.ui.classes.primarySmall} disabled={busy || cTo.trim() === ""} onClick={() => void sendOrDraft("send")}>
                {t("Send")}
              </button>
              <button type="button" className={portal.ui.classes.ghost} disabled={busy || cTo.trim() === ""} onClick={() => void sendOrDraft("draft")}>
                {t("Save as draft")}
              </button>
              <button type="button" className={portal.ui.classes.ghost} onClick={() => void mayDropDraft().then((ok) => ok && clearForm())}>
                {t("Cancel")}
              </button>
            </div>
          </form>
        )}
        {mailboxes === null ? (
          loadError ? (
            failed(t("The mailboxes could not be read: {error}", { error: loadError }), () => loadMailboxes(accountId))
          ) : (
            <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
          )
        ) : mailboxes.length === 0 ? (
          <portal.ui.Empty>{t("This account has no mailboxes.")}</portal.ui.Empty>
        ) : (
          <ul className="nc-list">
            {mailboxes.map((box) => (
              <li key={box.databaseId}>
                <button type="button" className="nc-row" onClick={() => selectMailbox(box.databaseId)}>
                  <span className="flex-1 truncate">{box.displayName ?? box.name}</span>
                  {box.unread > 0 && <span className="nc-chip">{box.unread} {t("unread")}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ---- the accounts -------------------------------------------------------------
  if (accounts === null) {
    return loadError ? failed(t("The mail accounts could not be read: {error}", { error: loadError ?? "" }), loadAccounts) : <portal.ui.RowsSkeleton rows={2} label={t("Loading…")} />;
  }
  if (accounts.length === 0) {
    return <portal.ui.Empty>{t("No mail account is set up on this Nextcloud.")}</portal.ui.Empty>;
  }
  return (
    <ul className="nc-list">
      {accounts.map((account) => (
        <li key={account.id}>
          <button type="button" className="nc-row" onClick={() => selectAccount(account.id)}>
            <span className="flex-1 truncate">{account.email}</span>
            <span className="text-xs text-fg-subtle">{t("Mailboxes")}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
