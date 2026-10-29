import { useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useNextcloudInstance } from "./api";

/** The Mail tab: the account's mailboxes with their unread counts, one mailbox's messages in it, and the picked
 * message open to its text and its attachments. Opening a message marks it read; one more tap puts it back. All of
 * it as tool calls on the server, sent where the panel's switcher holds. (The body is shown as it stands: where the
 * server gives HTML, its tags stand in the text.) */

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
}

/** A unix-seconds moment in the reader's words, nothing where it stands at zero. */
const fmtDate = (value?: number): string => (value ? new Date(value * 1000).toLocaleString() : "");

const readAddress = (value: unknown): Address[] =>
  Array.isArray(value) ? value.map((a) => ({ label: typeof a?.label === "string" ? a.label : undefined, email: typeof a?.email === "string" ? a.email : undefined })) : [];

const readBody = (message: Record<string, unknown>): OpenMessage => {
  const flags = (typeof message.flags === "object" && message.flags !== null ? message.flags : {}) as Record<string, unknown>;
  return {
    subject: typeof message.subject === "string" ? message.subject : "",
    dateInt: typeof message.date_int === "number" ? message.date_int : undefined,
    from: readAddress(message.from_ ?? message.from),
    to: readAddress(message.to),
    body: typeof message.body === "string" ? message.body : "",
    html: Boolean(message.has_html_body),
    attachments: (Array.isArray(message.attachments) ? message.attachments : []).map((a) => ({
      name: typeof a?.file_name === "string" ? a.file_name : undefined,
      size: typeof a?.size === "number" ? a.size : undefined,
      mime: typeof a?.mime === "string" ? a.mime : undefined,
    })),
    seen: Boolean(flags.seen),
  };
};

/** A person in an address field: their name where the server gave one, their address otherwise. */
const who = (list: Address[]): string => {
  const first = list[0];
  if (!first) return "";
  if (first.label && first.email) return `${first.label} <${first.email}>`;
  return first.label ?? first.email ?? "";
};

export default function Mail() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // where the mail calls go: the panel's held instance
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
  const [mailboxId, setMailboxId] = useState<number | null>(null);
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [open, setOpen] = useState<{ id: number; message: OpenMessage } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const loadAccounts = () => {
    setAccounts(null);
    void api
      .tool("nc_mail_list_accounts", {}, instance)
      .then((result) => setAccounts((arrayOf(partText(result).data, "results") ?? []).map((a) => ({ id: Number(a.id), email: String(a.email ?? a.emailAddress ?? "") }))))
      .catch((error) => setProblem(sayError(error)));
  };

  useEffect(loadAccounts, [instance]);

  const selectAccount = (id: number) => {
    setAccountId(id);
    setMailboxId(null);
    setMailboxes(null);
    void api
      .tool("nc_mail_list_mailboxes", { account_id: id }, instance)
      .then((result) =>
        setMailboxes(
          (arrayOf(partText(result).data, "results") ?? []).map((m) => ({
            databaseId: Number(m.database_id ?? m.databaseId),
            name: String(m.name ?? ""),
            displayName: typeof m.display_name === "string" ? m.display_name : undefined,
            unread: Number(m.unread ?? 0),
          })),
        ),
      )
      .catch((error) => setProblem(sayError(error)));
  };

  const selectMailbox = (databaseId: number) => {
    setMailboxId(databaseId);
    setOpen(null);
    setMessages(null);
    void api
      .tool("nc_mail_list_messages", { mailbox_id: databaseId, limit: 50 }, instance)
      .then((result) =>
        setMessages(
          (arrayOf(partText(result).data, "results") ?? []).map((m) => {
            const flags = (typeof m.flags === "object" && m.flags !== null ? m.flags : {}) as Record<string, unknown>;
            return {
              databaseId: Number(m.database_id ?? m.databaseId),
              subject: typeof m.subject === "string" ? m.subject : "(no subject)",
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
      .catch((error) => setProblem(sayError(error)));
  };

  const openMessage = (databaseId: number) => {
    setOpen(null);
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
          } catch {
            /* marking is a courtesy; the text stands regardless */
          }
        }
        setOpen({ id: databaseId, message: read });
      })
      .catch((error) => setProblem(sayError(error)));
  };

  const toggleRead = async () => {
    if (busy || open === null) return;
    setBusy(true);
    try {
      await api.tool("nc_mail_set_flags", { message_id: open.id, seen: !open.message.seen }, instance);
      setOpen({ ...open, message: { ...open.message, seen: !open.message.seen } });
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  // ---- the open message ------------------------------------------------------
  if (open !== null) {
    const m = open.message;
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <button type="button" className={portal.ui.classes.ghost} onClick={() => setOpen(null)}>
            ← {t("Messages")}
          </button>
          <span className="flex-1" />
          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void toggleRead()}>
            {m.seen ? t("Mark unread") : t("Mark read")}
          </button>
        </div>
        <div className="nc-share">
          <p className="nc-note-text" style={{ fontWeight: 600, marginBottom: "0.2rem" }}>
            {m.subject || "(no subject)"}
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
        {problem && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>}
      </div>
    );
  }

  // ---- the mailbox's messages --------------------------------------------------
  if (mailboxId !== null) {
    return (
      <div className="space-y-2">
        <button type="button" className={portal.ui.classes.ghost} onClick={() => setMailboxId(null)}>
          ← {t("Mailboxes")}
        </button>
        {messages === null ? (
          problem ? (
            <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The messages could not be read: {error}", { error: problem })}</portal.ui.ErrorBanner>
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
                      {row.subject}
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
        <button type="button" className={portal.ui.classes.ghost} onClick={() => setAccountId(null)}>
          ← {t("Accounts")}
        </button>
        {mailboxes === null ? (
          problem ? (
            <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The mailboxes could not be read: {error}", { error: problem })}</portal.ui.ErrorBanner>
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
    return problem ? (
      <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The mail accounts could not be read: {error}", { error: problem })}</portal.ui.ErrorBanner>
    ) : (
      <portal.ui.RowsSkeleton rows={2} label={t("Loading…")} />
    );
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
