import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { de } from "../src/de.ts";
import { LABELS } from "../src/labels.ts";
import { TOOLS } from "./fakes.mts";

/**
 * Every text the person sees has its German: a smaller copy of Pithagoras' own check (tests/i18n.test.mts). The
 * browser half's texts are what the code gives `t`, `tx`, `msg`, `tc` or `tp`, in English, with their German in
 * src/de.ts; the cards of the tools' calls are the label table, which names every tool the server lists; and the
 * viewer the panel frames has an English and a German table of its own, chosen by ?lang=.
 */

const SRC = path.resolve(import.meta.dirname, "../src");

const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.tsx?$/.test(e.name) && e.name !== "de.ts" ? [p] : [];
  });

/** Every text the code shows, as it is written there. */
function texts(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sources(SRC)) {
    const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const literal = (e: ts.Expression | undefined) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const where = `${path.relative(SRC, file)}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;
        const name = n.expression.text;
        if (["t", "tx", "msg"].includes(name)) {
          const key = literal(n.arguments[0]);
          if (key !== undefined) found.set(key, where);
        } else if (name === "tc") {
          found.set(`${literal(n.arguments[0])}\u0004${literal(n.arguments[1])}`, where);
        } else if (name === "tp") {
          found.set(literal(n.arguments[2])!, where);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return found;
}

const words = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

test("every text the browser half shows has its German, and the German has nothing the code no longer says", () => {
  const want = texts();
  assert.ok(want.size > 60);
  const missing = [...want.keys()].filter((k) => !(k in de));
  const stale = Object.keys(de).filter((k) => !want.has(k));
  assert.deepEqual(missing.map((k) => `${want.get(k)}: ${k}`), [], "de.ts lacks these");
  assert.deepEqual(stale, [], "de.ts has these the code no longer shows");
  for (const [key, said] of Object.entries(de)) {
    assert.ok(said.trim(), key);
    assert.deepEqual(words(said), words(key), `${key} fills in other words than the English`);
  }
});

test("the label table names every tool the server lists, and nothing else", () => {
  assert.deepEqual(Object.keys(LABELS).sort(), TOOLS.map((t) => t.name).sort());
  for (const label of Object.values(LABELS)) assert.ok(label in de, label);
});

test("the viewer's English and German tables say the same texts, and every text the viewer shows is in them", () => {
  const html = fs.readFileSync(new URL("../pages/viewer.html", import.meta.url), "utf8");
  const script = html.split("<script>")[1].split("</script>")[0];
  const table = /de: \{([\s\S]*?)\n  \},/.exec(script)![1];
  const german = new Map([...table.matchAll(/^\s+"((?:[^"\\]|\\.)*)": "((?:[^"\\]|\\.)*)",$/gm)].map((m) => [JSON.parse(`"${m[1]}"`), JSON.parse(`"${m[2]}"`)]));
  const shown = new Set([
    ...[...html.matchAll(/data-(?:t|title|aria|placeholder)="([^"]+)"/g)].map((m) => m[1]),
    ...[...script.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]),
  ]);
  assert.ok(shown.size > 40);
  assert.deepEqual([...shown].filter((k) => !german.has(k)), [], "the German table lacks these");
  assert.deepEqual([...german.keys()].filter((k) => !shown.has(k)), [], "the German table has these the viewer no longer shows");
  for (const [key, said] of german) assert.deepEqual(words(said), words(key), key);
  // The page is in the language its address asks for, English otherwise.
  assert.match(script, /get\('lang'\) === 'de' \? 'de' : 'en'/);
});
