import { useEffect, useRef, useState } from "react";
import { LuUsers } from "react-icons/lu";
import { portal, t } from "../portal";
import { api, sayError } from "./api";
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
 */

/** What DocsAPI leaves on window once api.js has loaded: only what is used, typed as it behaves. */
interface DocsApiLike {
  DocEditor: new (placeholderId: string, config: Record<string, unknown>) => DestroyableEditor;
}
interface DestroyableEditor {
  destroyEditor?: () => void;
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

export function OfficeEditor({ docId, onBack }: { docId: string; onBack(): void }) {
  portal.locale.use();
  const state = useOfficeState();
  const doc = state?.docs.find((d) => d.docId === docId);
  const [problem, setProblem] = useState<string | null>(null);
  /** The Document Server has filled its iframe into the placeholder: the loading state is done. */
  const [ready, setReady] = useState(false);
  /** A new Document Server is still making its fonts (the server half's ds_starting): asked again until it is done. */
  const [settingUp, setSettingUp] = useState(false);
  /** The file changed outside the editor since it opened (a script, a git pull): the badge with its button. */
  const [behind, setBehind] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const editor = useRef<DestroyableEditor | null>(null);
  /** Loads the document's newest revision into the open editor (set by the effect below, for the badge's button). */
  const reload = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let alive = true;
    let watch: ReturnType<typeof setInterval> | undefined;
    let again: ReturnType<typeof setTimeout> | undefined;
    let standing: ReturnType<typeof setInterval> | undefined;
    /** The document.key the editor has open now. */
    let key = "";
    let reloading = false;
    /** The editor holds typing it has not sent to the Document Server yet (onDocumentStateChange). */
    let unsent = false;
    /** A reload was asked for while there was such typing: it is made once that is sent. */
    let wanted = false;
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
      };
      return config;
    };
    const keyOf = (config: Record<string, unknown>) => String((config.document as { key?: unknown } | undefined)?.key ?? "");

    /** A new editor in the host box. */
    const build = (config: Record<string, unknown>) => {
      if (!window.DocsAPI) throw new Error("api.js loaded but DocsAPI is not on window -- the Document Server answered with something that is not its script");
      if (!box.current) return;
      // DocsAPI.DocEditor takes a PLACEHOLDER ID: api.js runs document.getElementById on the first argument and then
      // replaces that element with its iframe. Pass the host box itself and getElementById stringifies it to
      // "[object HTMLDivElement]", finds nothing, and silently builds no editor (reproduced live against DS 10.0).
      const ph = document.createElement("div");
      ph.id = "po-doceditor";
      box.current.querySelector("#po-doceditor")?.remove(); // never stack placeholders across remounts
      box.current.appendChild(ph);
      editor.current = new window.DocsAPI.DocEditor(ph.id, config);
      key = keyOf(config);
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
      if (again !== undefined) clearTimeout(again);
      if (standing !== undefined) clearInterval(standing);
      reload.current = async () => {};
      try {
        editor.current?.destroyEditor?.(); // where the loaded api.js exposes it
      } catch {
        // a destroyed or half-built editor must not take the page down with it
      }
      document.getElementById("po-doceditor")?.remove(); // sweep a placeholder DS never replaced; ours to clean, not React's
      editor.current = null;
    };
  }, [docId]);

  const users = state?.locks[docId] ?? [];

  return (
    <div className="po-page po-editor po-editor-page">
      <div className="po-editor-bar">
        <button type="button" className={portal.ui.classes.ghost} onClick={onBack}>
          ← {t("All documents")}
        </button>
        <span className="po-editor-title">{doc ? `${doc.title}.${doc.ext}` : "…"}</span>
        <span className="po-editor-spacer" />
        {users.length > 0 && (
          <span className="po-chip po-chip-lock" title={users.map((u) => u.name ?? u.id).join(", ")}>
            <LuUsers aria-hidden />
            {users.length === 1 ? t("1 editing now") : t("{n} editing now", { n: users.length })}
          </span>
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
