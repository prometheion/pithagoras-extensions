import { useEffect, useRef, useState, type ReactNode } from "react";
import { LuAppWindow, LuMaximize2, LuMinimize2, LuX, LuExpand, LuShrink } from "react-icons/lu";
import type { ChatProps, ToolCallView } from "@pithagoras/extension-api";
import { DEBOUNCE_DEFAULT_MS, HEIGHT_DEFAULT } from "../limits";
import { THEME_TOKENS, TRIPLET, type Theme } from "../theme";
import { msg, portal, t } from "../portal";
import { api, type CardSummary } from "./api";
import { CardHost, type Status } from "./host";
import { currentSettings, heard, know, knows, onData, setSettings, useCard, useSettings } from "./store";

/** The page's colours now, as the portal's variables hold them, with light or dark. */
export function pageTheme(mode: "light" | "dark"): Theme {
  const style = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  for (const name of THEME_TOKENS) {
    const value = style.getPropertyValue(`--${name}`).trim();
    if (TRIPLET.test(value)) colors[name] = value;
  }
  return { mode, colors };
}

/** What the line under a card says about the last thing it sent, or could not. */
const SAID: Record<string, string> = {
  wait: msg("Sent: the agent was waiting for this."),
  steer: msg("Sent: the agent gets it at its next step."),
  wake: msg("Sent: the agent is on it."),
  queued: msg("Kept for the agent: it gets it with your next message."),
  large: msg("Not sent: what the card sent is too large."),
  rate: msg("Not sent: the card sends too much at once."),
  closed: msg("Not sent: the card is closed."),
  failed: msg("Not sent: the portal could not be reached."),
};

let asked = false;
/** Settings, read once in the page as the first card is drawn (the page in Settings keeps them up to date after). */
function askSettings(): void {
  if (asked || currentSettings()) return;
  asked = true;
  api.settings().then(setSettings, () => {
    asked = false;
  });
}

/** The card itself: its head, its frame, and the line under it. */
function CardView({ chatId, card, waiting }: { chatId: string; card: CardSummary; waiting: boolean }) {
  const lang = portal.locale.use();
  const { mode, theme } = portal.theme.use();
  const settings = useSettings();
  const box = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const host = useRef<CardHost | null>(null);
  const rev = useRef(card.rev);
  // What the frame is loaded with, as it is when it loads: read through these, not kept from the first drawing.
  const now = useRef({ mode, lang });
  now.current = { mode, lang };
  const [status, setStatus] = useState<Status | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState(false);
  const [height, setHeight] = useState(0);
  const open = card.status === "open";
  const maxHeight = settings?.maxHeight ?? HEIGHT_DEFAULT;

  useEffect(() => {
    const made = new CardHost(box.current!, {
      title: card.title,
      events: card.events,
      wait: card.wait,
      defaultDebounceMs: currentSettings()?.defaultDebounceMs ?? DEBOUNCE_DEFAULT_MS,
      maxHeight: currentSettings()?.maxHeight ?? HEIGHT_DEFAULT,
      fill: false,
      open,
      src: (nonce) => api.frameUrl(chatId, card.id, rev.current, nonce, pageTheme(now.current.mode), now.current.lang),
      theme: () => pageTheme(now.current.mode),
      send: (event, data) => api.event(chatId, card.id, event, data),
      onStatus: setStatus,
      onHeight: setHeight,
    });
    host.current = made;
    const offData = onData(chatId, card.id, (seq, value) => made.postData(seq, value));
    return () => {
      offData();
      made.destroy();
      host.current = null;
    };
    // One frame for the card, for as long as it is drawn: what changes is told to it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, card.id]);

  // Its HTML replaced: drawn again.
  useEffect(() => {
    if (rev.current === card.rev) return;
    rev.current = card.rev;
    host.current?.load();
  }, [card.rev]);

  useEffect(() => {
    host.current?.configure({ events: card.events, wait: card.wait, open, defaultDebounceMs: settings?.defaultDebounceMs ?? DEBOUNCE_DEFAULT_MS, maxHeight: expanded || full ? Number.POSITIVE_INFINITY : maxHeight, fill: full });
  }, [card.events, card.wait, open, settings, expanded, full, maxHeight]);

  useEffect(() => host.current?.setTheme(pageTheme(mode)), [mode, theme]);

  useEffect(() => {
    const changed = () => setFull(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  const close = () => {
    api.close(chatId, card.id).then(
      (r) => heard(chatId, { type: "card", card: r.card }),
      () => setStatus({ kind: "dropped", reason: "failed" }),
    );
  };
  const said = status ? t(SAID[status.kind === "sent" ? status.delivery : status.reason]) : "";
  const state = !open ? (card.closedBy === "person" ? t("Closed by you") : t("Closed")) : waiting ? t("Waiting for you") : "";
  return (
    <div ref={shell} className={`odui-card ${open ? "" : "is-closed"} ${full ? "is-full" : ""}`} data-card={card.id}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <LuAppWindow className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg" title={card.title}>
          {card.title}
        </span>
        {state && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${open ? "bg-accent/10 text-accent" : "bg-fg/5 text-fg-muted"}`}>{state}</span>}
        <span className="shrink-0 font-mono text-[11px] text-fg-faint" title={t("The agent knows this card as {id}", { id: card.id })}>
          {card.id}
        </span>
        {(height > maxHeight || expanded) && !full && (
          <button type="button" className="odui-icon" onClick={() => setExpanded((v) => !v)} title={expanded ? t("Show less") : t("Show all of it")} aria-label={expanded ? t("Show less") : t("Show all of it")} aria-pressed={expanded}>
            {expanded ? <LuShrink aria-hidden /> : <LuExpand aria-hidden />}
          </button>
        )}
        <button
          type="button"
          className="odui-icon"
          onClick={() => (full ? void document.exitFullscreen() : void shell.current?.requestFullscreen?.())}
          title={full ? t("Leave full screen") : t("Full screen")}
          aria-label={full ? t("Leave full screen") : t("Full screen")}
        >
          {full ? <LuMinimize2 aria-hidden /> : <LuMaximize2 aria-hidden />}
        </button>
        {open && (
          <button type="button" className="odui-icon" onClick={close} title={t("Close the card")} aria-label={t("Close the card")}>
            <LuX aria-hidden />
          </button>
        )}
      </div>
      <div ref={box} className="odui-frame-box" />
      {(said || !open) && (
        <p className="m-0 border-t border-line px-3 py-1 text-[11px] text-fg-faint" role="status">
          {!open ? t("This card is closed: it takes no input and sends nothing.") : said}
        </p>
      )}
    </div>
  );
}

/**
 * How a ui_show call is drawn in the conversation: the portal's own card for the call (what it was called with, what
 * it returned), and under it the card the call made, live, wherever the conversation is open: on every page open on
 * the chat, after a reload, and once the call is long over.
 */
export function ShowCall({ chat, call, card }: ChatProps & { call: ToolCallView; card: ReactNode }) {
  portal.locale.use();
  const details = call.details as { card?: unknown } | undefined;
  const cardId = typeof details?.card === "string" ? details.card : undefined;
  const made = useCard(chat.id, call.callId, cardId);
  useEffect(askSettings, []);
  // A page told nothing of the chat's cards yet (its module came after the chat opened, and the server half said
  // nothing then) asks once the call has run.
  useEffect(() => {
    if (made || knows(chat.id) || call.status === "writing") return;
    api.cards(chat.id).then((r) => know(chat.id, r.cards), () => {});
  }, [made, chat.id, call.status]);
  let below: ReactNode = null;
  if (made) below = <CardView chatId={chat.id} card={made} waiting={call.status === "running" && !!made.wait && made.status === "open"} />;
  else if (call.status === "running") below = <p className="odui-note">{t("Opening the card…")}</p>;
  else if (call.status === "done" && cardId) below = <p className="odui-note">{t("This card is no longer kept.")}</p>;
  return (
    <>
      {card}
      {below}
    </>
  );
}
