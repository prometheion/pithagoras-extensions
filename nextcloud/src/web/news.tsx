import { useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, partText, arrayOf, sayError, useGuard, useNextcloudInstance } from "./api";
import { htmlToText } from "./widgets";

/** The News tab: the feeds with their unread counts, one feed's items in it, and the picked article open to its
 * text beside a way to where it stands. (A body the server gives as HTML is shown as the text it says.) */

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

/** A unix-seconds moment in the reader's words (the portal's language), nothing where it stands at zero. */
const fmtDate = (value?: number): string => (value ? portal.format.dateTime(value * 1000) : "");

/** Only a web address is a link: whatever else a feed puts in an item's url is shown as no link at all. */
const safeLink = (url?: string): string | undefined => (url !== undefined && /^https?:\/\//i.test(url) ? url : undefined);

export default function News() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // where the calls go: the panel's held instance
  const guard = useGuard();
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [feedId, setFeedId] = useState<number | null>(null);
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [open, setOpen] = useState<{ id: number; item: OpenItem } | null>(null);
  const [problem, setProblem] = useState<string | null>(null); // an opening that failed: drawn in whatever view stands
  const [loadError, setLoadError] = useState<string | null>(null); // a list that could not be read

  /** The feeds, read again; those on screen stay while they come where `keep` says so (their unread counts after reading). */
  const loadFeeds = (keep = false) => {
    const current = guard("feeds");
    if (!keep) setFeeds(null);
    setLoadError(null);
    void api
      .tool("nc_news_list_feeds", {}, instance)
      .then((result) =>
        current() &&
        setFeeds(
          (arrayOf(partText(result).data, "results") ?? []).map((f) => ({
            id: Number(f.id),
            title: String(f.title ?? ""),
            unreadCount: Number(f.unread_count ?? 0),
            updateError: Number(f.update_error_count ?? 0) > 0,
          })),
        ),
      )
      .catch((error) => current() && setLoadError(sayError(error)));
  };

  // the panel remounts this tab for another instance (client.tsx keys it by one), so a first load is all there is
  useEffect(() => { loadFeeds(); }, []);

  const loadItems = (id: number) => {
    const current = guard("items");
    setItems(null);
    setLoadError(null);
    void api
      .tool("nc_news_list_items", { feed_id: id, limit: 50 }, instance)
      .then((result) =>
        current() &&
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
      .catch((error) => current() && setLoadError(sayError(error)));
  };

  const selectFeed = (id: number) => {
    setFeedId(id);
    setOpen(null);
    setProblem(null);
    loadItems(id);
  };

  const openItem = (id: number) => {
    const current = guard("item");
    setOpen(null);
    setProblem(null);
    void api
      .tool("nc_news_get_item", { item_id: id }, instance)
      .then((result) => {
        if (!current()) return;
        const data = partText(result).data as Record<string, unknown> | undefined;
        const value = (typeof data?.item === "object" && data.item !== null ? data.item : data) as Record<string, unknown> | undefined;
        if (!value) throw new Error(t("The article did not answer in a way this panel reads."));
        const body = typeof value.body === "string" ? value.body : "";
        setOpen({
          id,
          item: {
            title: String(value.title ?? ""),
            author: typeof value.author === "string" && value.author ? value.author : undefined,
            pubDate: typeof value.pub_date === "number" ? value.pub_date : undefined,
            url: typeof value.url === "string" && value.url ? value.url : undefined,
            // an article is mostly HTML: shown as the text it says, not its tags
            body: /<[a-z!/][^>]*>/i.test(body) ? htmlToText(body) : body,
          },
        });
      })
      .catch((error) => current() && setProblem(sayError(error)));
  };

  const banner = problem !== null ? <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner> : null;

  // ---- the open article ---------------------------------------------------------
  if (open !== null) {
    const item = open.item;
    const link = safeLink(item.url);
    return (
      <div className="space-y-2">
        {banner}
        <button type="button" className={portal.ui.classes.ghost} onClick={() => setOpen(null)}>
          ← {t("Items")}
        </button>
        <div className="nc-share">
          <p className="nc-note-text" style={{ fontWeight: 600, marginBottom: "0.2rem" }}>
            {item.title || t("(no title)")}
          </p>
          <p className="text-xs text-fg-subtle mb-0.5">
            {[fmtDate(item.pubDate), item.author].filter(Boolean).join(" — ") || ""}
          </p>
          {item.body ? (
            <pre className="nc-file-text">{item.body}</pre>
          ) : (
            <p className="text-sm text-fg-subtle">{t("This article has no body.")}</p>
          )}
          {link && (
            <p className="mt-2">
              <a className="text-xs underline" href={link} target="_blank" rel="noopener noreferrer">
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
        {banner}
        <button type="button" className={portal.ui.classes.ghost} onClick={() => { setFeedId(null); setLoadError(null); setProblem(null); loadFeeds(true); }}>
          ← {t("Feeds")}
        </button>
        {items === null ? (
          loadError ? (
            <portal.ui.LoadFailed error={t("The items could not be read: {error}", { error: loadError })} onRetry={() => loadItems(feedId)} />
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
                      {row.title || t("(no title)")}
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
    return loadError ? (
      <portal.ui.LoadFailed error={t("The feeds could not be read: {error}", { error: loadError })} onRetry={() => loadFeeds()} />
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
