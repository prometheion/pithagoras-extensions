import { useEffect, useRef, useState } from "react";
import { LuExternalLink, LuMessageSquare, LuUsers } from "react-icons/lu";
import { portal, t } from "../portal";
import { api, sayError, type DocchatItem } from "./api";
import { hookDocchat, mentionList, type DocchatHook } from "./docchat-page";
import { useOfficeState } from "./state";
import { startingUp } from "../office-ui";

/**
 * The Office editor's host: the page's half of `new DocsAPI.DocEditor`. It asks POST /editor-config for its
 * document, loads the Document Server's api.js ONCE (the script is not idempotent -- a second load on the same
 * page breaks it), drops ONLY apiJs from the answered config and hands the rest to DocsAPI with the page's events:
 * the JWT covers exactly the minted object (the JWT signs what is sent, so nothing of it is changed). The lock badge
 * ("N editing now") comes from the shared 5 s poll of /state.
 *
 * An agent edits the same session through an editor of its own (seat.ts), so its edits show here as anyone's do,
 * and nothing is reloaded for them. Every second the page asks GET /editor-state how its key stands: where the file
 * changed outside the editor ("behind": a script, a git pull), a badge says so, and its button loads the new revision
 * in place: a new config, handed to the editor's own refreshFile, which reopens the document in the same frame with
 * the new key. The same happens when the editor asks for it (onRequestRefreshFile: it reconnected to a session that
 * has ended).
 *
 * The editor sends what is typed to the Document Server only once the person pauses, and a reload drops what it has
 * not sent yet: that is in no session, and no copy can keep it. So a reload waits until the editor says everything is
 * sent (onDocumentStateChange false); then the old session holds it, and its close keeps it as a copy.
 *
 * The same component is the Office tab's full page (`place` "page") and the editor in a chat's Office panel ("panel"),
 * beside the conversation and as narrow as the panel is dragged: there its bar also has a way to the full page
 * (`onFullPage`). Each editor has a placeholder of its own, so two on one page never take each other's, and a new
 * document or the panel's close destroys the editor before anything else is built.
 */

/** What DocsAPI leaves on window once api.js has loaded: only what is used, typed as it behaves. */
interface DocsApiLike {
  DocEditor: new (placeholderId: string, config: Record<string, unknown>) => DestroyableEditor;
}
interface DestroyableEditor {
  destroyEditor?: () => void;
  /** Answers the editor's question for its mention list (onRequestUsers). */
  setUsers?: (data: { c: string; users: { name: string; email: string }[] }) => void;
  /** Loads another revision (a config with a new document.key) in the open editor. Taken only where the config had
   * an onRequestRefreshFile event. */
  refreshFile?: (config: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    DocsAPI?: DocsApiLike;
  }
}

/** How often the open editor asks whether its file changed outside it. */
const STANDING_POLL_MS = 1000;

/** How long an editor's app may take to say it started (onAppReady) before it is made anew, once. The app now and then
 * fails while its scripts load, most often when another editor on the page was just torn down (going back to the list
 * and opening a document at once): an exception in its frame, nothing said to the page, and an editor that never
 * opens. Changed by the portal-tier test. */
export const editorTimings = { appReadyMs: 15_000 };

/** Placeholders made on this page, for an id of each editor's own. */
let placeholders = 0;

/** api.js per address, loaded once per page: the promise is cached, and a failure stays said until the page reloads. */
const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  const known = scripts.get(src);
  if (known) return known;
  const load = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`the editor script at ${src} could not be loaded`));
    document.head.appendChild(el);
  });
  scripts.set(src, load);
  return load;
}

/** The most urgent of a document's comment and chat states, as the bar's one chip says it, with a count of the busy ones
 * and every one in its title. Nothing to say: null. */
export function docchatChip(items: DocchatItem[]): { text: string; title: string; tone: "busy" | "problem" } | null {
  const order: DocchatItem["state"][] = ["failed", "not_posted", "no_chat", "nobody", "limit", "interrupted", "working", "queued"];
  const shown = items.filter((i) => order.includes(i.state));
  if (!shown.length) return null;
  const first = [...shown].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))[0];
  const busy = shown.filter((i) => i.state === "working" || i.state === "queued").length;
  const name = first.label;
  const say: Record<string, string> = {
    failed: t("{name} could not answer", { name }),
    not_posted: t("{name} answered; not posted after a suspected prompt injection", { name }),
    no_chat: t("{name} has no chat to work from: start one with {name}", { name }),
    nobody: t("Nobody answers in this document's chat: no agent or project owns it"),
    limit: t("Too many comment chats in this document: delete some comments"),
    interrupted: t("{name} was interrupted before it answered", { name }),
    working: busy > 1 ? t("Agents are answering ({n})", { n: busy }) : first.kind === "chat" ? t("{name} is answering in the chat", { name }) : t("{name} is answering a comment", { name }),
    queued: busy > 1 ? t("Agents are answering ({n})", { n: busy }) : t("{name} waits for its turn", { name }),
  };
  const title = shown.map((i) => `${i.label ? `${i.label}: ` : ""}${i.state}${i.error ? ` (${i.error})` : ""}`).join("\n");
  return { text: say[first.state], title, tone: first.state === "working" || first.state === "queued" ? "busy" : "problem" };
}

export function OfficeEditor({ docId, onBack, onFullPage, place = "page", chatId }: { docId: string; onBack(): void; onFullPage?: () => void; place?: "page" | "panel"; chatId?: string }) {
  portal.locale.use();
  /** This editor's own placeholder id: DocsAPI finds its place by id, on the whole page. */
  const [holder] = useState(() => `po-doceditor-${++placeholders}`);
  const state = useOfficeState();
  const doc = state?.docs.find((d) => d.docId === docId);
  const [problem, setProblem] = useState<string | null>(null);
  /** The Document Server has filled its iframe into the placeholder: the loading state is done. */
  const [ready, setReady] = useState(false);
  /** A new Document Server is still making its fonts (the server half's ds_starting): asked again until it is done. */
  const [settingUp, setSettingUp] = useState(false);
  /** The file changed outside the editor since it opened (a script, a git pull): the badge with its button. */
  const [behind, setBehind] = useState(false);
  /** How the document's comment and chat conversations with agents stand (GET /editor-state). */
  const [talk, setTalk] = useState<DocchatItem[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const editor = useRef<DestroyableEditor | null>(null);
  /** Loads the document's newest revision into the open editor (set by the effect below, for the badge's button). */
  const reload = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let alive = true;
    let watch: ReturnType<typeof setInterval> | undefined;
    let remake: ReturnType<typeof setTimeout> | undefined;
    let again: ReturnType<typeof setTimeout> | undefined;
    let standing: ReturnType<typeof setInterval> | undefined;
    /** The document.key the editor has open now. */
    let key = "";
    let reloading = false;
    /** The editor holds typing it has not sent to the Document Server yet (onDocumentStateChange). */
    let unsent = false;
    /** A reload was asked for while there was such typing: it is made once that is sent. */
    let wanted = false;
    /** The editor's comments and chat, told to the server half (docchat-page.ts): hooked anew in each editor made. */
    let docchat: DocchatHook | null = null;
    const mentions = mentionList(api.mentionables);
    setProblem(null);
    setReady(false);
    setSettingUp(false);
    setBehind(false);

    /** A minted config as DocsAPI takes it: apiJs dropped (the JWT was signed over the config without it), the page's
     * events added (DocsAPI keeps them out of what it sends on). */
    const asConfig = (minted: Awaited<ReturnType<typeof api.editorConfig>>): Record<string, unknown> => {
      const config: Record<string, unknown> = { ...minted };
      delete config.apiJs;
      config.events = {
        // The session it was in has ended, and what it has not sent cannot be sent any more: loaded at once.
        onRequestRefreshFile: () => {
          unsent = false;
          void reload.current();
        },
        onDocumentStateChange: (event: { data?: unknown }) => {
          unsent = event?.data === true;
          if (!unsent && wanted) void reload.current();
        },
        // Typing "@" in a comment asks who can be mentioned: the agents and the projects.
        onRequestUsers: (event: { data?: { c?: string; search?: string } }) => {
          const asked = event?.data ?? {};
          if (asked.c !== "mention") return;
          mentions(String(asked.search ?? "")).then(
            (users) => editor.current?.setUsers?.({ c: "mention", users }),
            () => editor.current?.setUsers?.({ c: "mention", users: [] }),
          );
        },
        onAppReady: () => docchat?.appReady(),
        onDocumentReady: () => docchat?.documentReady(),
      };
      return config;
    };
    const keyOf = (config: Record<string, unknown>) => String((config.document as { key?: unknown } | undefined)?.key ?? "");

    /** A new editor in the host box; made anew once where its app does not say it started (editorTimings). */
    const build = (config: Record<string, unknown>, tries = 0) => {
      if (!window.DocsAPI) throw new Error("api.js loaded but DocsAPI is not on window -- the Document Server answered with something that is not its script");
      if (!box.current) return;
      // DocsAPI.DocEditor takes a PLACEHOLDER ID: api.js runs document.getElementById on the first argument and then
      // replaces that element with its iframe. Pass the host box itself and getElementById stringifies it to
      // "[object HTMLDivElement]", finds nothing, and silently builds no editor (reproduced live against DS 10.0).
      const ph = document.createElement("div");
      ph.id = holder;
      document.getElementById(holder)?.remove(); // never stack placeholders across remounts
      box.current.appendChild(ph);
      // The editor takes the config it is given as its own: a copy each time, the events kept as they are.
      const { events, ...data } = config;
      const copy = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
      let started = false;
      const given = (events ?? {}) as { onAppReady?: () => void };
      // The editor's comments and chat are heard in the frame of this placeholder, in each editor made.
      docchat?.stop();
      docchat = hookDocchat({
        frame: () => box.current?.querySelector("iframe") ?? null,
        docId,
        key: () => key,
        user: String(((copy.editorConfig as { user?: { id?: unknown } } | undefined)?.user?.id) ?? ""),
        ...(chatId ? { panelChat: chatId } : {}),
        post: (path, body, keepalive) => api.docchat(path, body, keepalive),
      });
      const made = new window.DocsAPI.DocEditor(ph.id, {
        ...copy,
        events: {
          ...(events as object),
          onAppReady: () => {
            started = true;
            given.onAppReady?.();
          },
        },
      });
      editor.current = made;
      key = keyOf(config);
      if (remake !== undefined) clearTimeout(remake);
      if (tries < 1) {
        remake = setTimeout(() => {
          if (!alive || started || editor.current !== made) return;
          try {
            made.destroyEditor?.();
          } catch {
            // a half-built editor must not stop the new one
          }
          build(config, tries + 1);
        }, editorTimings.appReadyMs);
      }
    };

    /** The newest revision into the open editor: a fresh config (a new key) through the editor's refreshFile, which
     * keeps the frame and reopens the document in it; an editor without it is made again. */
    reload.current = async () => {
      if (!editor.current) return;
      if (unsent) {
        wanted = true;
        return;
      }
      if (reloading) return;
      reloading = true;
      wanted = false;
      try {
        const config = asConfig(await api.editorConfig(docId));
        if (!alive) return;
        // Typed while the config was asked for: loaded once that is sent too.
        if (unsent) {
          wanted = true;
          return;
        }
        if (keyOf(config) !== key) {
          if (typeof editor.current?.refreshFile === "function") {
            editor.current.refreshFile(config);
            key = keyOf(config);
          } else {
            try {
              editor.current?.destroyEditor?.();
            } catch {
              // a half-built editor must not stop the new one
            }
            build(config);
          }
          unsent = false;
        }
        setBehind(false);
        setProblem(null);
      } catch (e) {
        if (alive) setProblem(sayError(e));
      } finally {
        reloading = false;
      }
    };

    const open = async () => {
      try {
        let minted: Awaited<ReturnType<typeof api.editorConfig>>;
        try {
          minted = await api.editorConfig(docId);
        } catch (e) {
          if (!startingUp(e)) throw e;
          if (alive) {
            setSettingUp(true);
            again = setTimeout(() => void open(), 3000);
          }
          return;
        }
        setSettingUp(false);
        if (!alive || !box.current) return;
        await loadScript(minted.apiJs);
        if (!alive || !box.current) return;
        build(asConfig(minted));
        // onDocumentReady, as close to it as this tier can get: DS fills its own iframe into the placeholder.
        watch = setInterval(() => {
          if (box.current?.querySelector("iframe")) {
            setReady(true);
            if (watch !== undefined) clearInterval(watch);
          }
        }, 500);
        standing = setInterval(() => {
          if (reloading || !key) return;
          const asked = key;
          api.editorState(docId, asked).then((answer) => {
            if (!alive || asked !== key) return;
            setBehind(answer.standing === "behind");
            setTalk(Array.isArray(answer.docchat) ? answer.docchat : []);
          }, () => {
            // the server half restarting, or the network: asked again in a second
          });
        }, STANDING_POLL_MS);
      } catch (e) {
        if (alive) setProblem(sayError(e));
      }
    };
    void open();
    return () => {
      alive = false;
      if (watch !== undefined) clearInterval(watch);
      if (remake !== undefined) clearTimeout(remake);
      if (again !== undefined) clearTimeout(again);
      if (standing !== undefined) clearInterval(standing);
      reload.current = async () => {};
      docchat?.stop();
      docchat = null;
      try {
        editor.current?.destroyEditor?.(); // where the loaded api.js exposes it
      } catch {
        // a destroyed or half-built editor must not take the page down with it
      }
      document.getElementById(holder)?.remove(); // sweep a placeholder DS never replaced; ours to clean, not React's
      editor.current = null;
    };
  }, [docId, holder, chatId]);

  const users = state?.locks[docId] ?? [];
  const chip = docchatChip(talk);

  return (
    <div className={place === "page" ? "po-page po-editor po-editor-page" : "po-editor po-editor-panel"} data-doc={docId}>
      <div className="po-editor-bar">
        <button type="button" className={portal.ui.classes.ghost} onClick={onBack}>
          ← {t("All documents")}
        </button>
        <span className="po-editor-title">{doc ? `${doc.title}.${doc.ext}` : "…"}</span>
        <span className="po-editor-spacer" />
        {users.length > 0 && (
          // In a panel just the number: the words would take the bar a second row at a narrow panel's width.
          <span
            className="po-chip po-chip-lock"
            title={users.map((u) => u.name ?? u.id).join(", ")}
            role={place === "panel" ? "img" : undefined}
            aria-label={place === "panel" ? (users.length === 1 ? t("1 editing now") : t("{n} editing now", { n: users.length })) : undefined}
          >
            <LuUsers aria-hidden />
            {place === "panel" ? users.length : users.length === 1 ? t("1 editing now") : t("{n} editing now", { n: users.length })}
          </span>
        )}
        {chip && (
          // In a panel just the icon: the words would take the bar a second row; they are its name and title.
          <span
            className={`po-chip po-chip-talk${chip.tone === "problem" ? " po-chip-talk-problem" : ""}`}
            title={`${chip.text}\n${chip.title}`}
            role={place === "panel" ? "img" : "status"}
            aria-label={chip.text}
          >
            <LuMessageSquare aria-hidden />
            {place === "panel" ? null : chip.text}
          </span>
        )}
        {onFullPage && (
          <button type="button" className={portal.ui.classes.iconButton} onClick={onFullPage} title={t("Open in the Office tab")} aria-label={t("Open in the Office tab")}>
            <LuExternalLink aria-hidden />
          </button>
        )}
        {behind && (
          <span className="po-chip po-chip-stale">
            {t("This document changed on disk since it opened")}
            {" — "}
            <button type="button" className="po-refresh" onClick={() => void reload.current()}>
              {t("reload it (what you typed here since is kept as a copy)")}
            </button>
          </span>
        )}
      </div>
      {problem && (
        <portal.ui.ErrorBanner>
          {problem}{" "}
          <button
            type="button"
            className={portal.ui.classes.ghost}
            onClick={() => portal.navigate(`/settings/x/${portal.extension}`)}
          >
            {t("Open the Office settings")}
          </button>
        </portal.ui.ErrorBanner>
      )}
      <div className="po-host" ref={box}>
        {!ready && !problem && (
          <div className="po-loading">
            {settingUp
              ? t("The Document Server is still setting itself up after its first start, which takes about two minutes. The editor opens once it is done…")
              : t("Loading the editor — the first start of a Document Server can take a while…")}
          </div>
        )}
      </div>
    </div>
  );
}
