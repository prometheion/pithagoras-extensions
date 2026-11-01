import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * The Nextcloud panel's views (src/web/*.tsx, the components themselves) as pages of their own, for the tests that
 * drive them in a browser: bundled with the portal's own React (from the Pithagoras at `pithagoras`), with a portal of
 * a few lines whose UI pieces are plain elements, and routes at `base` that the test answers: `/tool` as the server
 * half does (the Nextcloud MCP server's content parts, raw), `/status` and `/instances`.
 *
 * The page shows the view named by `?view=` (a tab's id, "panel" for the whole panel, "settings" for the page in
 * Settings), inside the instance named "uni". What the portal's UI pieces were asked is kept on the page:
 * `__confirms` (each `ui.confirm` asked, answered by `window.__confirmAnswer`, true unless a test sets it) and
 * `__unsaved` (what `ui.useUnsavedDraft` was last given).
 */
export async function viewPageJs(pithagoras: string, base: string): Promise<string> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const portalRequire = createRequire(path.join(pithagoras, "package.json"));
  const result = await build({
    stdin: { contents: PAGE(base), resolveDir: root, loader: "jsx", sourcefile: "page.jsx" },
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

const PAGE = (base: string) => `
import { createElement as h, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import nextcloud from "./src/client";
import { InstanceContext } from "./src/web/api";
import ShoppingList from "./src/web/shopping-list";
import Cookbook from "./src/web/cookbook";
import Notes from "./src/web/notes";
import Files from "./src/web/files";
import Deck from "./src/web/deck";
import Calendar from "./src/web/calendar";
import Contacts from "./src/web/contacts";
import Mail from "./src/web/mail";
import News from "./src/web/news";
import Collectives from "./src/web/collectives";

const BASE = ${JSON.stringify(base)};
const query = new URLSearchParams(location.search);
window.__confirms = [];
window.__unsaved = false;
window.__copied = [];
const registered = {};
const fmt = (d, o) => new Date(d).toLocaleString("en-US", { timeZone: "UTC", ...(o || {}) });
const portal = {
  extension: "@pithagoras/nextcloud",
  t: (text, vars) => text.replace(/\\{(\\w+)\\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m)),
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
  format: {
    number: (n) => String(n),
    date: (d, o) => new Date(d).toLocaleDateString("en-US", o),
    dateTime: (d, o) => new Date(d).toLocaleString("en-US", o),
    time: (d, o) => new Date(d).toLocaleTimeString("en-US", o),
  },
  ui: {
    classes: { input: "input", inputSmall: "input-small", codeArea: "code", button: "button", primary: "primary", primarySmall: "primary-small", ghost: "ghost", viewerButton: "viewer", iconButton: "icon" },
    lazy: (load, name) => lazy(() => load().then((m) => ({ default: m[name] }))),
    RowsSkeleton: ({ label }) => h("div", { role: "status" }, label || "…"),
    Empty: ({ children }) => h("div", { role: "note" }, children),
    ErrorBanner: ({ children, onClose }) => h("div", { role: "alert" }, children, onClose ? h("button", { type: "button", "aria-label": "Dismiss", onClick: onClose }, "x") : null),
    WarnBanner: ({ children }) => h("div", { role: "note" }, children),
    LoadFailed: ({ error, onRetry }) => h("div", { role: "alert" }, String(error && error.message ? error.message : error), h("button", { type: "button", onClick: onRetry }, "Retry")),
    Select: ({ value, options, onChange, ...rest }) => h("select", { value, "aria-label": rest["aria-label"], onChange: (e) => onChange(e.target.value) }, options.map((o) => h("option", { key: o.value, value: o.value }, o.label))),
    Segments: ({ label, value, options, onChange }) => h("div", { role: "group", "aria-label": label }, options.map((o) => h("button", { key: o.id, type: "button", "aria-pressed": o.id === value, onClick: () => onChange(o.id) }, o.label))),
    Field: ({ label, hint, children }) => h("label", null, h("span", null, label), children, hint ? h("small", null, hint) : null),
    SwitchRow: ({ title, on, onChange, disabled }) => h("label", null, h("input", { type: "checkbox", checked: on, disabled, onChange: (e) => onChange(e.target.checked) }), title),
    Switch: ({ on, onChange, label, disabled }) => h("input", { type: "checkbox", "aria-label": label, checked: on, disabled, onChange: (e) => onChange(e.target.checked) }),
    Markdown: ({ children }) => h("div", { "data-markdown": true }, children),
    useUnsavedDraft: (unsaved) => { window.__unsaved = unsaved; },
    confirm: async (options) => { window.__confirms.push(options); return window.__confirmAnswer === undefined ? true : window.__confirmAnswer; },
    asksBeforeDeleting: () => true,
    copyText: async (text) => { window.__copied.push(text); return true; },
    tabKeys: () => {},
  },
  slots: { register: (slot, entry) => (registered[slot] = registered[slot] || []).push(entry) },
};
nextcloud(portal);

const views = { shopping: ShoppingList, cookbook: Cookbook, notes: Notes, files: Files, deck: Deck, calendar: Calendar, contacts: Contacts, mail: Mail, news: News, collectives: Collectives };

function Page() {
  const view = query.get("view") || "shopping";
  const [shown, setShown] = useState(true);
  window.__toggle = () => setShown((s) => !s);
  if (view === "panel") {
    const Panel = registered["chat.panel"][0].component;
    return h(Panel, { chat: { id: "chat-1" }, panel: {} });
  }
  if (view === "settings") {
    const Settings = registered["settings.page"][0].component;
    return h(Settings, null);
  }
  const View = views[view];
  return shown ? h(InstanceContext.Provider, { value: "uni" }, h(View)) : h("div", null, "away");
}
createRoot(document.getElementById("root")).render(h(Page));
`;

/** The page around a view, with Nextcloud's own stylesheet. */
export const VIEW_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/client.css"><style>body{margin:0;width:420px;font:14px sans-serif}</style></head><body><div id="root"></div><script src="/view-page.js"></script></body></html>`;
