import { useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useNextcloudInstance } from "./api";

/** The News tab: the feeds with their unread counts, one feed's items in it, and the picked article open to its
 * text beside a way to where it stands. (The body is shown as it stands: where the server gives HTML, its tags stand
 * in the text.) */

interface Feed {
  id: number;
  title: string;
  unreadCount: number;
  updateError?: boolean;
}

interface ItemRow {
  id: number;
  title: string;
  author?: string;
  pubDate?: number;
  url?: string;
  unread: boolean;
  starred: boolean;
}

interface OpenItem {
  title: string;
  author?: string;
  pubDate?: number;
  url?: string;
  body: string;
}

/** A unix-seconds moment in the reader's words, nothing where it stands at zero. */
const fmtDate = (value?: number): string => (value ? new Date(value * 1000).toLocaleString() : "");

export default function News() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // where the calls go: the panel's held instance
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [feedId, setFeedId] = useState<number | null>(null);
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [open, setOpen] = useState<{ id: number; item: OpenItem } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const loadFeeds = () => {
    setFeeds(null);
    void api
      .tool("nc_news_list_feeds", {}, instance)
      .then((result) =>
        setFeeds(
          (arrayOf(partText(result).data, "results") ?? []).map((f) => ({
            id: Number(f.id),
            title: String(f.title ?? ""),
            unreadCount: Number(f.unread_count ?? 0),
            updateError: Number(f.update_error_count ?? 0) > 0,
          })),
        ),
      )
      .catch((error) => setProblem(sayError(error)));
  };

  // the panel remounts this tab for another instance (client.tsx keys it by one), so a first load is all there is
  useEffect(() => { loadFeeds(); }, []);

  const selectFeed = (id: number) => {
    setFeedId(id);
    setOpen(null);
    setItems(null);
    void api
      .tool("nc_news_list_items", { feed_id: id, limit: 50 }, instance)
      .then((result) =>
        setItems(
          (arrayOf(partText(result).data, "results") ?? []).map((i) => ({
            id: Number(i.id),
            title: String(i.title ?? ""),
            author: typeof i.author === "string" && i.author ? i.author : undefined,
            pubDate: typeof i.pub_date === "number" ? i.pub_date : undefined,
            url: typeof i.url === "string" && i.url ? i.url : undefined,
            unread: Boolean(i.unread),
            starred: Boolean(i.starred),
          })),
        ),
      )
      .catch((error) => setProblem(sayError(error)));
  };

  const openItem = (id: number) => {
    setOpen(null);
    void api
      .tool("nc_news_get_item", { item_id: id }, instance)
      .then((result) => {
        const data = partText(result).data as Record<string, unknown> | undefined;
        const value = (typeof data?.item === "object" && data.item !== null ? data.item : data) as Record<string, unknown> | undefined;
        if (!value) throw new Error(t("The article did not answer in a way this panel reads."));
        setOpen({
          id,
          item: {
            title: String(value.title ?? ""),
            author: typeof value.author === "string" && value.author ? value.author : undefined,
            pubDate: typeof value.pub_date === "number" ? value.pub_date : undefined,
            url: typeof value.url === "string" && value.url ? value.url : undefined,
            body: typeof value.body === "string" ? value.body : "",
          },
        });
      })
      .catch((error) => setProblem(sayError(error)));
  };

  // ---- the open article ---------------------------------------------------------
  if (open !== null) {
    const item = open.item;
    return (
      <div className="space-y-2">
        <button type="button" className={portal.ui.classes.ghost} onClick={() => setOpen(null)}>
          ← {t("Items")}
        </button>
        <div className="nc-share">
          <p className="nc-note-text" style={{ fontWeight: 600, marginBottom: "0.2rem" }}>
            {item.title || "(no title)"}
          </p>
          <p className="text-xs text-fg-subtle mb-0.5">
            {[fmtDate(item.pubDate), item.author].filter(Boolean).join(" — ") || ""}
          </p>
          {item.body ? (
            <pre className="nc-file-text">{item.body}</pre>
          ) : (
            <p className="text-sm text-fg-subtle">{t("This article has no body.")}</p>
          )}
          {item.url && (
            <p className="mt-2">
              <a className="text-xs underline" href={item.url} target="_blank" rel="noopener noreferrer">
                {t("Open the original")}
              </a>
            </p>
          )}
        </div>
      </div>
    );
  }

  // ---- the feed's items -----------------------------------------------------------
  if (feedId !== null) {
    return (
      <div className="space-y-2">
        <button type="button" className={portal.ui.classes.ghost} onClick={() => setFeedId(null)}>
          ← {t("Feeds")}
        </button>
        {items === null ? (
          problem ? (
            <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The items could not be read: {error}", { error: problem })}</portal.ui.ErrorBanner>
          ) : (
            <portal.ui.RowsSkeleton rows={5} label={t("Loading…")} />
          )
        ) : items.length === 0 ? (
          <portal.ui.Empty>{t("This feed has no items.")}</portal.ui.Empty>
        ) : (
          <ul className="nc-list">
            {items.map((row) => (
              <li key={row.id}>
                <button type="button" className={`nc-row${row.unread ? "" : " nc-chip-dim"}`} onClick={() => openItem(row.id)}>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">
                      {row.starred && "★ "}
                      {row.title}
                    </span>
                    {(row.author || row.pubDate) && (
                      <span className="block truncate text-xs text-fg-subtle">
                        {[row.author, fmtDate(row.pubDate)].filter(Boolean).join(" — ")}
                      </span>
                    )}
                  </span>
                  {row.unread && <span className="nc-chip flex-shrink-0">{t("new")}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ---- the feeds --------------------------------------------------------------------
  if (feeds === null) {
    return problem ? (
      <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The feeds could not be read: {error}", { error: problem })}</portal.ui.ErrorBanner>
    ) : (
      <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
    );
  }
  if (feeds.length === 0) {
    return <portal.ui.Empty>{t("No news feeds are set up on this Nextcloud.")}</portal.ui.Empty>;
  }
  return (
    <ul className="nc-list">
      {feeds.map((feed) => (
        <li key={feed.id}>
          <button type="button" className="nc-row" onClick={() => selectFeed(feed.id)}>
            <span className="flex-1 truncate">{feed.title}</span>
            {feed.updateError && <span className="nc-chip flex-shrink-0" title={t("The feed could not be updated")}>!</span>}
            {feed.unreadCount > 0 && (
              <span className="nc-chip flex-shrink-0">
                {feed.unreadCount} {t("unread")}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
