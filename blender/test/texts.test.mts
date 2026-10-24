import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { de } from "../src/de.ts";
import { ACTS, LABELS } from "../src/labels.ts";
import { TOOLS } from "./fakes.mts";

/**
 * Every text a person sees has its German: the browser half's (src, by de.ts, as Pithagoras' own i18n test holds its
 * extensions to), the label of every tool the server lists, and the viewer page's two tables.
 */

const SRC = path.resolve(import.meta.dirname, "../src");

/** Every text the code in src shows, as it is written there: what `t`, `tx` and `msg` are given, and a count's `other` form. */
function texts(): Map<string, string> {
  const found = new Map<string, string>();
  const files = fs.readdirSync(SRC, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && e.name !== "de.ts");
  for (const entry of files) {
    const file = path.join(entry.parentPath, entry.name);
    const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const literal = (e: ts.Expression | undefined) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const where = `${path.relative(SRC, file)}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;
        const name = n.expression.text;
        if (name === "t" || name === "tx" || name === "msg") {
          const key = literal(n.arguments[0]);
          if (key !== undefined) found.set(key, where);
        } else if (name === "tp") {
          const other = literal(n.arguments[2]);
          assert.ok(other !== undefined, `${where}: tp takes its forms as they are written`);
          found.set(other, where);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return found;
}

test("every text the browser half shows has its German, and de.ts has nothing the code no longer shows", () => {
  const want = texts();
  assert.ok(want.size > 50);
  const missing = [...want.keys()].filter((k) => !(k in de));
  const stale = Object.keys(de).filter((k) => !want.has(k));
  assert.deepEqual(missing.map((k) => `${want.get(k)}: ${k}`), [], "de.ts lacks these");
  assert.deepEqual(stale, [], "de.ts has these the code no longer shows");
  // A name to fill in is there in German too.
  const words = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [english, german] of Object.entries(de)) assert.deepEqual(words(String(german)), words(english), english);
});

test("every tool the server lists has a label and a guard rule decided for it, and each is a tool's", () => {
  assert.deepEqual(Object.keys(LABELS).sort(), TOOLS.map((t) => t.name).sort());
  assert.deepEqual(Object.keys(ACTS).sort(), TOOLS.map((t) => t.name).sort());
});

const viewer = fs.readFileSync(new URL("../src/viewer.html", import.meta.url), "utf8");
/** The viewer's two tables, read as the page reads them. */
const tables = (() => {
  const start = viewer.indexOf("const TEXTS = {");
  const end = viewer.indexOf("\n};", start);
  return new Function(`${viewer.slice(start, end + 3)}\nreturn TEXTS;`)() as { en: Record<string, string>; de: Record<string, string> };
})();

test("the viewer's English and German tables have the same texts, with the same names to fill in", () => {
  assert.deepEqual(Object.keys(tables.de).sort(), Object.keys(tables.en).sort());
  const words = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(tables.en)) assert.deepEqual(words(tables.de[key]), words(tables.en[key]), key);
});

test("every text the viewer asks for is in its tables", () => {
  const asked = new Set<string>();
  for (const m of viewer.matchAll(/\bdata-t(?:-title|-aria|-placeholder|-alt|-html)?="([^"]+)"/g)) asked.add(m[1]);
  for (const m of viewer.matchAll(/\btr\('([^']+)'/g)) asked.add(m[1]);
  // Asked for by a name made in the code: the views of the gizmo, the shading modes, and the work the server says it is busy with.
  for (const m of viewer.matchAll(/tr\('((?:view|shade)\.)' \+/g)) asked.delete(m[1]);
  const missing = [...asked].filter((k) => !(k in tables.en));
  assert.deepEqual(missing, []);
  for (const view of ["Right", "Left", "Front", "Back", "Top", "Bottom"]) assert.ok(`view.${view}` in tables.en);
  for (const shade of ["SOLID", "MATERIAL", "RENDERED"]) assert.ok(`shade.${shade}` in tables.en);
});
