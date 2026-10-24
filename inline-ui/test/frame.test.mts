import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_POLICY, FRAME_HEADERS, FRAME_POLICY, cardDocument, outerPage, readTheme, scriptJson, themeCss } from "../src/server/frame.ts";

const page = (over: Partial<Parameters<typeof cardDocument>[0]> = {}) => ({
  card: { id: "c1", title: "Pick" },
  html: "<button onclick=\"pithagoras.emit('pick', 1)\">One</button>",
  events: ["pick"],
  theme: readTheme(undefined),
  nonce: "n0nce-n0nce",
  origin: "https://portal.example",
  lang: "en",
  ...over,
});

test("the card's policy forbids every way out but its own inline script, styles and data", () => {
  for (const directive of ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:", "media-src data: blob:", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'"]) {
    assert.ok(CARD_POLICY.split("; ").includes(directive), directive);
  }
  assert.match(FRAME_POLICY, /^sandbox allow-scripts allow-forms; /);
  assert.match(FRAME_POLICY, /frame-ancestors 'self'$/);
  assert.equal(FRAME_HEADERS["content-security-policy"], FRAME_POLICY);
  assert.equal(FRAME_HEADERS["cache-control"], "no-store");
});

test("the card: its policy and the bridge come before anything of the model's, and the model's HTML is in its body", () => {
  const doc = cardDocument(page());
  const head = doc.slice(0, doc.indexOf("</head>"));
  assert.ok(head.indexOf('http-equiv="Content-Security-Policy"') < head.indexOf("<script>"), "the policy first");
  assert.ok(head.includes('id="pithagoras-theme"') && head.includes('id="pithagoras-base"'));
  assert.ok(doc.indexOf("pithagoras.emit('pick', 1)") > doc.indexOf("<body>"));
  assert.match(doc, /"nonce":"n0nce-n0nce"/);
  assert.match(doc, /"events":\["pick"\]/);
});

test("nothing given to the card can end its script or its title early", () => {
  const doc = cardDocument(page({ card: { id: "c1", title: "</title><script>alert(1)</script>" }, data: { seq: 2, value: "</script><script>alert(2)</script>" } }));
  assert.equal(doc.match(/<script>/g)?.length, 1, "the bridge's is the only script before the model's HTML");
  assert.doesNotMatch(doc.slice(0, doc.indexOf("<body>")), /alert\(\d\)<\/script>/);
  assert.match(scriptJson({ a: "</script>&\u2028" }), /^\{"a":"\\u003c\/script\\u003e\\u0026\\u2028"\}$/);
});

test("the outer frame holds the card as its srcdoc, escaped, sandboxed as the portal's frame is", () => {
  const outer = outerPage(page({ html: '<p title="a&b">"quoted"</p>' }));
  const srcdoc = /srcdoc="([^"]*)"/.exec(outer)![1];
  assert.ok(!srcdoc.includes("<"), "no markup of the card's is markup of the outer page");
  assert.match(srcdoc, /&quot;quoted&quot;/);
  assert.match(outer, /<iframe sandbox="allow-scripts allow-forms" title="Pick" srcdoc="/);
  assert.doesNotMatch(outer, /<script/, "the outer frame runs nothing of its own");
});

test("the theme a page sends is kept to the portal's names and to three numbers each", () => {
  const theme = readTheme(JSON.stringify({ mode: "dark", colors: { fg: "245 245 247", accent: "red; } body { background: url(x)", made: "1 2 3" } }));
  assert.equal(theme.mode, "dark");
  assert.equal(theme.colors.fg, "245 245 247");
  assert.equal(theme.colors.accent, "8 145 178", "not a colour: the portal's own light accent");
  assert.equal(theme.colors.made, undefined);
  assert.equal(readTheme("not json").mode, "light");
  const css = themeCss(theme);
  assert.match(css, /^:root\{color-scheme:dark;/);
  assert.match(css, /--fg:rgb\(245 245 247\);--fg-rgb:245 245 247;/);
});
