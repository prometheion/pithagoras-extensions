import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * The Office page's editor (src/web/office-editor.tsx, the component itself) as a page of its own, for the tests that
 * drive it in a browser: bundled with the portal's own React, from the Pithagoras at `pithagoras` (React is the
 * portal's, which it hands to every extension), with a portal of a few lines that reaches the server half's routes
 * at `base`. It opens the document named by the page's `?doc=`.
 *
 * What the editor does is kept on the page: `__events` (ready, error, warning, asked to refresh, refresh with the new
 * key), `__key` (the key open now), `__editor` (the editor, for a test that closes it) and `__page` (the events the
 * component gave it, for a stand-in editor to call). The Document Server's api.js defines DocsAPI.DocEditor on an
 * object it puts on window first, so the editor is wrapped where the component reads it, not where api.js puts it.
 */
export async function editorPageJs(pithagoras: string, base: string): Promise<string> {
  return bundle(pithagoras, editorPage(base));
}

/** The Office page in Settings (src/web/settings.tsx) as a page of its own, as editorPageJs makes the editor's: with a
 * portal whose UI pieces are plain elements, at `base`. */
export async function settingsPageJs(pithagoras: string, base: string): Promise<string> {
  return bundle(pithagoras, `
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { setPortal } from "./src/portal";
import { OfficeSettings } from "./src/web/settings";

const BASE = ${JSON.stringify(base)};
setPortal({
  extension: "@pithagoras/office",
  t: (text, vars) => text.replace(/\\{(\\w+)\\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m)),
  locale: { use: () => {} },
  api: {
    url: (p) => BASE + p,
    json: async (url, init) => {
      const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init && init.headers) } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(body.error || "HTTP " + r.status), { status: r.status, body });
      return body;
    },
  },
  ui: {
    classes: { ghost: "ghost", button: "button", input: "input", primarySmall: "primary" },
    RowsSkeleton: ({ label }) => h("div", null, label),
    WarnBanner: ({ children }) => h("div", { role: "note" }, children),
    ErrorBanner: ({ children }) => h("div", { role: "alert" }, children),
    SwitchRow: ({ title }) => h("div", null, title),
    Field: ({ label, children }) => h("label", null, label, children),
    confirm: async () => false,
  },
  navigate: () => {},
});
createRoot(document.getElementById("root")).render(h(OfficeSettings));
`);
}

/**
 * A chat as the portal draws it, for the Office panel and the tool cards: the extension loaded as the portal loads it
 * (client.tsx's default export, given a portal of a few lines), its chat.panel entry drawn beside a "conversation"
 * that holds its chat.tool cards for the calls in `window.__calls`, with a panel host that does what Chat.tsx does
 * (open with params, a state the panel keeps while it is open, close, which takes both). The panel's size and where
 * it is docked are the page's to change (`window.__dock({ w, h, dock })`). With `?tab=<id>` the Office tab's page (its
 * nav.page entry) is drawn beside it too, at `?doc=<id>`, as the person may have it open as well. Kept on the page:
 * `__navigated` (where the extension sent the page), `__opens` (each panels.open), `__kept` (panel.keep).
 */
export async function panelPageJs(pithagoras: string, base: string): Promise<string> {
  return bundle(pithagoras, `
import { createElement as h, lazy, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import office from "./src/client";

const BASE = ${JSON.stringify(base)};
const query = new URLSearchParams(location.search);
const registered = {};
window.__navigated = [];
window.__opens = [];
window.__calls = window.__calls || [];
office({
  extension: "@pithagoras/office",
  t: (text, vars) => text.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m)),
  locale: { use: () => {}, add: () => {} },
  api: {
    url: (p) => BASE + p,
    json: async (url, init) => {
      const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init && init.headers) } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(body.error || "HTTP " + r.status), { status: r.status, body });
      return body;
    },
  },
  ui: {
    classes: { ghost: "ghost", button: "button", input: "input", primarySmall: "primary", iconButton: "icon" },
    lazy: (load, name) => lazy(() => load().then((m) => ({ default: m[name] }))),
    RowsSkeleton: ({ label }) => h("div", null, label),
    Empty: ({ children }) => h("div", { role: "note" }, children),
    ErrorBanner: ({ children }) => h("div", { role: "alert" }, children),
    Select: ({ value, options, onChange, ...rest }) => h("select", { value, "aria-label": rest["aria-label"], onChange: (e) => onChange(e.target.value) }, options.map((o) => h("option", { key: o.value, value: o.value }, o.label))),
    confirm: async () => false,
  },
  format: { dateTime: (ms) => new Date(ms).toISOString() },
  navigate: (to) => window.__navigated.push(to),
  useLocation: () => ({ search: "?doc=" + encodeURIComponent(query.get("tab") || "") }),
  slots: { register: (slot, entry) => (registered[slot] = registered[slot] || []).push(entry) },
});

const chat = { id: "chat-1", title: "A chat", workspace: "/work/acme" };
const channel = { send: async () => {}, on: () => () => {} };

function Host() {
  const [open, setOpen] = useState(false);
  const [params, setParams] = useState(undefined);
  const [state, setState] = useState(undefined);
  const [dock, setDock] = useState({ w: 560, h: 320, dock: "right" });
  window.__dock = setDock;
  // As Chat.tsx: an opening sets what it was opened with; a close takes that and the panel's state with it.
  const panels = useMemo(() => ({
    isOpen: () => open,
    open: (id, p) => {
      window.__opens.push([id, p === undefined ? null : p]);
      setOpen(true);
      setParams(p);
    },
    close: () => {
      setOpen(false);
      setParams(undefined);
      setState(undefined);
    },
  }), [open]);
  const handle = useMemo(() => ({ params, state, setState, keep: (k) => (window.__kept = k), guardClose: () => {}, open: () => {}, fullscreen: () => {} }), [params, state]);
  const Panel = registered["chat.panel"][0].component;
  const tools = Object.fromEntries(registered["chat.tool"].map((e) => [e.tool, e.component]));
  const Tab = registered["nav.page"][0].component;
  const bottom = dock.dock === "bottom";
  return h("div", { style: { display: "flex", height: "100vh" } },
    query.get("tab") ? h("div", { id: "tab", style: { width: "640px", display: "flex", flexDirection: "column" } }, h(Tab)) : null,
    h("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: bottom ? "column" : "row" } },
      h("div", { id: "conversation", style: { flex: 1, minWidth: 0, minHeight: 0, overflow: "auto" } },
        h("button", { type: "button", onClick: () => panels.open("office") }, "Office panel button"),
        window.__calls.map((call, i) => h(tools[call.name], { key: i, chat, channel, panels, call, card: h("div", null, "the portal's card") })),
      ),
      open
        ? h("aside", { id: "panel", style: bottom ? { height: dock.h + "px", display: "flex", flexDirection: "column" } : { width: dock.w + "px", display: "flex", flexDirection: "column" } },
            h("button", { type: "button", onClick: () => panels.close("office") }, "Close the panel"),
            // The panel's body, as Chat.tsx draws it for a panel that is not "bleed".
            h("div", { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "auto" } },
              h(Panel, { chat, channel, panels, close: () => panels.close("office"), panel: handle })))
        : null,
    ),
  );
}
createRoot(document.getElementById("root")).render(h(Host));
`);
}

/** The editor page's own source: the editor of the page's `?doc=`, its events kept on the page. */
function editorPage(base: string): string {
  return `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { setPortal } from "./src/portal";
import { OfficeEditor, editorTimings } from "./src/web/office-editor";

const BASE = ${JSON.stringify(base)};
window.__events = [];
// A test that makes an editor's app fail does not wait the full time before it is made anew.
if (window.__appFailsOnce) editorTimings.appReadyMs = 300;
setPortal({
  extension: "@pithagoras/office",
  t: (text, vars) => text.replace(/\\{(\\w+)\\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m)),
  locale: { use: () => {} },
  api: {
    url: (p) => BASE + p,
    json: async (url, init) => {
      const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init && init.headers) } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(body.error || "HTTP " + r.status), { status: r.status, body });
      return body;
    },
  },
  ui: { classes: { ghost: "ghost" }, ErrorBanner: ({ children }) => createElement("div", { role: "alert" }, children) },
  navigate: () => {},
});

const wrapped = new WeakMap();
function recorded(Real) {
  if (!wrapped.has(Real)) {
    wrapped.set(Real, function (id, config) {
      const page = config.events || {};
      window.__page = page;
      // A test that adds to the editor's config (events of its own) before the editor is made.
      if (window.__configHook) window.__configHook(config);
      config.events = {
        ...page,
        ...config.events,
        onDocumentReady: () => window.__events.push(["ready"]),
        onError: (e) => window.__events.push(["error", e && e.data]),
        onWarning: (e) => window.__events.push(["warning", e && e.data]),
        onRequestRefreshFile: () => {
          window.__events.push(["asked to refresh"]);
          page.onRequestRefreshFile && page.onRequestRefreshFile();
        },
      };
      window.__key = config.document.key;
      const editor = new Real(id, config);
      window.__editor = editor;
      if (typeof editor.refreshFile === "function") {
        const refresh = editor.refreshFile.bind(editor);
        editor.refreshFile = (next) => {
          window.__events.push(["refresh", next.document.key]);
          window.__key = next.document.key;
          refresh(next);
        };
      }
      return editor;
    });
  }
  return wrapped.get(Real);
}
let given;
Object.defineProperty(window, "DocsAPI", {
  configurable: true,
  get: () => given && new Proxy(given, { get: (api, name) => (name === "DocEditor" && api.DocEditor ? recorded(api.DocEditor) : api[name]) }),
  set: (api) => void (given = api),
});

const doc = new URLSearchParams(location.search).get("doc");
createRoot(document.getElementById("root")).render(createElement(OfficeEditor, { docId: doc, onBack: () => {} }));
`;
}

/** `contents` (a page's source) bundled with the portal's own React. */
async function bundle(pithagoras: string, contents: string): Promise<string> {
  const office = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const portalRequire = createRequire(path.join(pithagoras, "package.json"));
  const result = await build({
    stdin: { contents, resolveDir: office, loader: "jsx", sourcefile: "page.jsx" },
    bundle: true,
    format: "iife",
    target: "es2022",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
    // client.tsx imports its stylesheet; the pages serve src/client.css themselves.
    loader: { ".css": "empty" },
    plugins: [
      {
        name: "the-portals-react",
        setup(b) {
          b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => ({ path: portalRequire.resolve(args.path) }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

/** A chat with its Office panel (panelPageJs), and Office's own stylesheet, which lays the editor out. */
export const PANEL_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/client.css"><style>body{margin:0}</style></head><body><div id="root"></div><script src="/panel-page.js"></script></body></html>`;

/** A page for the Office page in Settings. */
export const SETTINGS_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/settings-page.js"></script></body></html>`;

/** The page around it: the editor's host as the portal's page gives it room. */
export const EDITOR_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}.po-host{height:700px}</style></head><body><div id="root"></div><script src="/editor-page.js"></script></body></html>`;
