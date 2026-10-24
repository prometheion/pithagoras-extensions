import { EVENT_DATA_MAX } from "../limits";
import { THEME_TOKENS, TRIPLET, type Theme } from "../theme";

export { THEME_TOKENS, type Theme };

/**
 * The page a card is drawn in. The model writes the card's HTML, maybe after reading something somebody else wrote,
 * so it runs where it can reach nothing: no network, no portal, no other card.
 *
 * Two frames, both sandboxed without `allow-same-origin` (so each has an origin of its own that is nobody's: no cookie,
 * no storage, no way to the portal's API) and without popups, top navigation, downloads or dialogs:
 *
 * - The outer one is this route's answer (`outerPage`), served with its policy as a header. It has no script of its
 *   own, and holds the card as the `srcdoc` of an inner frame, filling it.
 * - The inner one is the card (`cardDocument`): the model's HTML after the portal's theme, a base stylesheet and the
 *   bridge (`pithagoras.emit`, `onData`, `theme`), with the same policy as a meta element as well.
 *
 * Why two: a `srcdoc` frame takes the policy of the page it is in, and the portal's own page allows no inline script,
 * so a card put straight into the portal's page could not run. A frame served from a route can, but its own policy
 * does not keep it from navigating itself (`location = …`, a link, a meta refresh), and such a navigation reaches any
 * site with whatever the card put in its address: CSP has no say over where a frame goes, only over what its parent
 * lets it load, and the portal's page lets frames load any site. So the card is the child of a frame whose policy
 * lets its children load nothing (`frame-src 'none'`): a navigation of the card is refused before it is made. The
 * browser tests (test/browser) try each of these in Chromium and Firefox.
 *
 * The bridge also takes away what the policy cannot: WebRTC, whose STUN and TURN requests Chromium makes from a
 * sandboxed frame whatever the policy says, and frames, objects and embeds inside the card, which would run their own
 * script in a realm that still has it.
 */

/** What a card may load: nothing from anywhere, its own inline script and styles, and pictures, fonts and sound it carries. */
export const CARD_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join("; ");

/** The outer frame's: the card's, sandboxed even when opened as a page of its own, and framed only by the portal's pages. */
export const FRAME_POLICY = `sandbox allow-scripts allow-forms; ${CARD_POLICY}; frame-ancestors 'self'`;

export const FRAME_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": FRAME_POLICY,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-dns-prefetch-control": "off",
};

/** The portal's own light colours (its index.css), for a page that said none: a frame opened by itself. */
const FALLBACK: Theme = {
  mode: "light",
  colors: {
    canvas: "250 250 251",
    surface: "255 255 255",
    raised: "244 244 246",
    line: "226 226 231",
    fg: "24 24 27",
    "fg-muted": "74 74 84",
    "fg-subtle": "92 92 102",
    "fg-faint": "104 104 114",
    accent: "8 145 178",
    "accent-fg": "255 255 255",
    ok: "5 150 105",
    warn: "180 120 10",
    danger: "220 38 38",
  },
};

/** The theme a page asked for, as it sent it (JSON), kept to the portal's names and to three numbers each; the rest is the fallback's. */
export function readTheme(raw: unknown): Theme {
  let given: unknown;
  try {
    given = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    given = undefined;
  }
  const g = (given && typeof given === "object" ? given : {}) as { mode?: unknown; colors?: Record<string, unknown> };
  const colors: Record<string, string> = {};
  for (const name of THEME_TOKENS) {
    const value = g.colors && typeof g.colors === "object" ? g.colors[name] : undefined;
    colors[name] = typeof value === "string" && TRIPLET.test(value.trim()) ? value.trim() : FALLBACK.colors[name];
  }
  return { mode: g.mode === "dark" ? "dark" : "light", colors };
}

/** The theme as CSS: each colour as `--name` (a colour) and `--name-rgb` (its three numbers, for a colour with alpha). */
export function themeCss(theme: Theme): string {
  const vars = Object.entries(theme.colors).map(([name, rgb]) => `--${name}:rgb(${rgb});--${name}-rgb:${rgb};`);
  return `:root{color-scheme:${theme.mode};${vars.join("")}}`;
}

/** What makes a card look like the portal's own parts, in light and dark, before any rule of the model's. */
export const BASE_CSS = `
html{background:var(--surface)}
body{margin:0;padding:12px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--fg);overflow-wrap:anywhere;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{margin:0 0 .5em;line-height:1.25;font-weight:600}h1{font-size:1.35em}h2{font-size:1.2em}h3{font-size:1.05em}h4{font-size:1em}
p,ul,ol{margin:0 0 .75em}
a{color:var(--accent)}
small,.muted{color:var(--fg-muted)}
hr{border:0;border-top:1px solid var(--line);margin:12px 0}
button{font:inherit;color:var(--fg);background:var(--raised);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.primary,button[type=submit]{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
button:disabled{opacity:.5;cursor:default}
input,select,textarea{font:inherit;color:var(--fg);background:var(--canvas);border:1px solid var(--line);border-radius:8px;padding:6px 8px;max-width:100%;box-sizing:border-box}
input[type=checkbox],input[type=radio],input[type=range],progress{accent-color:var(--accent);padding:0}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--fg-muted);font-weight:600}
code,pre,kbd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
pre{background:var(--canvas);border:1px solid var(--line);border-radius:8px;padding:8px;overflow:auto}
img,svg,canvas,video{max-width:100%}
`.trim();

/**
 * The bridge, run before anything of the model's. `__INIT__` is replaced with what this card is told as it is served:
 * its nonce and the portal's origin (where it posts), its events, its theme and the data last posted to it.
 */
const BRIDGE = `(function () {
"use strict";
var INIT = __INIT__;
var NO_FRAMES = /^(IFRAME|FRAME|FRAMESET|OBJECT|EMBED|FENCEDFRAME|PORTAL)$/;
var NO_LINKS = /(^|\\s)(dns-prefetch|preconnect|prefetch|prerender|preload|modulepreload)(\\s|$)/i;
["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection"].forEach(function (name) {
  try { delete window[name]; } catch (e) {}
  try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch (e) {}
});
function sweep(node) {
  if (!node || node.nodeType !== 1) return;
  if (NO_FRAMES.test(node.tagName) || (node.tagName === "LINK" && NO_LINKS.test(node.getAttribute("rel") || ""))) {
    node.remove();
    console.warn("A card cannot hold " + node.tagName.toLowerCase() + " elements: it was taken out.");
    return;
  }
  if (node.querySelectorAll) node.querySelectorAll("iframe,frame,frameset,object,embed,fencedframe,portal,link").forEach(sweep);
}
new MutationObserver(function (records) {
  records.forEach(function (r) { r.addedNodes.forEach(sweep); });
}).observe(document, { childList: true, subtree: true });

var up = window.parent && window.parent.parent;
function post(message) {
  message.pithagoras = 1;
  message.nonce = INIT.nonce;
  try { up.postMessage(message, INIT.origin); } catch (e) {}
}
var root = document.documentElement;
var themeStyle = document.getElementById("pithagoras-theme");
var theme = INIT.theme;
function applyTheme(next) {
  if (!next || typeof next !== "object" || !next.colors || typeof next.colors !== "object") return;
  var mode = next.mode === "dark" ? "dark" : "light";
  var colors = {};
  var css = ":root{color-scheme:" + mode + ";";
  Object.keys(next.colors).forEach(function (name) {
    var value = String(next.colors[name]);
    if (!/^[a-z-]{1,20}$/.test(name) || !/^\\d{1,3} \\d{1,3} \\d{1,3}$/.test(value)) return;
    colors[name] = "rgb(" + value + ")";
    css += "--" + name + ":rgb(" + value + ");--" + name + "-rgb:" + value + ";";
  });
  if (themeStyle) themeStyle.textContent = css + "}";
  root.setAttribute("data-theme", mode);
  theme = Object.freeze({ mode: mode, colors: Object.freeze(colors) });
  try { window.dispatchEvent(new CustomEvent("pithagoras:theme", { detail: theme })); } catch (e) {}
}
applyTheme(INIT.theme);

var declared = INIT.events.slice();
var listeners = [];
var dataSeq = INIT.data ? INIT.data.seq : 0;
var last = INIT.data ? { value: INIT.data.value } : null;
function bytes(text) {
  try { return new TextEncoder().encode(text).length; } catch (e) { return text.length * 3; }
}
function call(fn, value) {
  try { fn(value); } catch (e) { console.error(e); }
}
var api = {
  card: Object.freeze({ id: INIT.card.id, title: INIT.card.title }),
  events: Object.freeze(declared.slice()),
  get theme() { return theme; },
  emit: function (name, data) {
    name = String(name);
    if (declared.indexOf(name) < 0) {
      console.warn("pithagoras.emit(\\"" + name + "\\"): not one of this card's events (" + (declared.join(", ") || "none") + "), so it was not sent.");
      return false;
    }
    var json = data === undefined ? "null" : JSON.stringify(data);
    if (json === undefined) json = "null";
    if (bytes(json) > INIT.maxBytes) {
      console.warn("pithagoras.emit(\\"" + name + "\\"): its data is over " + Math.round(INIT.maxBytes / 1024) + " KB as JSON, so it was not sent. Send what was chosen, not the whole state.");
      return false;
    }
    post({ type: "emit", name: name, json: json });
    return true;
  },
  onData: function (fn) {
    if (typeof fn !== "function") throw new TypeError("pithagoras.onData takes a function");
    listeners.push(fn);
    if (last) {
      var value = last.value;
      setTimeout(function () { if (listeners.indexOf(fn) >= 0) call(fn, value); }, 0);
    }
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }
};
Object.defineProperty(window, "pithagoras", { value: Object.freeze(api), enumerable: true, writable: false, configurable: false });
window.addEventListener("message", function (event) {
  if (event.source !== up) return;
  var m = event.data;
  if (!m || m.pithagoras !== 1 || m.nonce !== INIT.nonce) return;
  if (m.type === "data" && typeof m.seq === "number" && m.seq > dataSeq) {
    dataSeq = m.seq;
    last = { value: m.value };
    listeners.slice().forEach(function (fn) { call(fn, m.value); });
  } else if (m.type === "theme") {
    applyTheme(m.theme);
  }
});
var height = -1;
function report() {
  var h = Math.ceil(root.getBoundingClientRect().height);
  if (h !== height) {
    height = h;
    post({ type: "size", height: h });
  }
}
var observer = new ResizeObserver(report);
observer.observe(root);
document.addEventListener("DOMContentLoaded", function () {
  if (document.body) observer.observe(document.body);
  report();
});
window.addEventListener("load", report);
post({ type: "ready" });
})();`;

/** JSON that can sit in a <script> as it is: nothing in it ends the element or reads as markup. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Text for an attribute or an element's content. */
export const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface CardPage {
  card: { id: string; title: string };
  html: string;
  /** The events it takes: the declared ones, and the one its call waits for. */
  events: string[];
  /** What ui_update last posted to it, with its number. */
  data?: { seq: number; value: unknown };
  theme: Theme;
  /** What the page drawing it gave: its nonce for this load, and its origin, where the card posts. */
  nonce: string;
  origin: string;
  lang: string;
}

/** The card: the theme, the base stylesheet and the bridge, then the model's HTML, whole document or part of one. */
export function cardDocument(page: CardPage): string {
  const init = { nonce: page.nonce, origin: page.origin, card: page.card, events: page.events, theme: page.theme, data: page.data ?? null, maxBytes: EVENT_DATA_MAX };
  return [
    `<!doctype html><html lang="${escapeHtml(page.lang)}" data-theme="${page.theme.mode}"><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${CARD_POLICY}">`,
    `<meta http-equiv="x-dns-prefetch-control" content="off">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(page.card.title)}</title>`,
    `<style id="pithagoras-theme">${themeCss(page.theme)}</style>`,
    `<style id="pithagoras-base">${BASE_CSS}</style>`,
    `<script>${BRIDGE.replace("__INIT__", () => scriptJson(init))}</script>`,
    // A whole document of the model's goes in as it is: the parser folds its <html> and <body> into these, and what
    // its <head> had (styles, a title) works where it lands. A policy of its own in a meta element is outside <head>
    // and is ignored, and could only have narrowed this one.
    `</head><body>`,
    page.html,
    `</body></html>`,
  ].join("");
}

/** The route's answer: a frame that holds the card, filling it, with the card's background behind it as it loads. */
export function outerPage(page: CardPage): string {
  const surface = page.theme.colors.surface;
  return [
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off">`,
    `<style>:root{color-scheme:${page.theme.mode}}html,body{margin:0;height:100%;overflow:hidden;background:rgb(${surface})}iframe{display:block;border:0;width:100%;height:100%}</style>`,
    `</head><body><iframe sandbox="allow-scripts allow-forms" title="${escapeHtml(page.card.title)}" srcdoc="${escapeHtml(cardDocument(page))}"></iframe></body></html>`,
  ].join("");
}
