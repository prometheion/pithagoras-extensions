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
  const office = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const portalRequire = createRequire(path.join(pithagoras, "package.json"));
  const contents = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { setPortal } from "./src/portal";
import { OfficeEditor } from "./src/web/office-editor";

const BASE = ${JSON.stringify(base)};
window.__events = [];
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
      config.events = {
        ...page,
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
  const result = await build({
    stdin: { contents, resolveDir: office, loader: "jsx", sourcefile: "editor-page.jsx" },
    bundle: true,
    format: "iife",
    target: "es2022",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
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

/** The page around it: the editor's host as the portal's page gives it room. */
export const EDITOR_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}.po-host{height:700px}</style></head><body><div id="root"></div><script src="/editor-page.js"></script></body></html>`;
