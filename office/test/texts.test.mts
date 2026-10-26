import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { de } from "../src/de.ts";

/**
 * Every text a person sees has its German: the browser half's (src, by de.ts, as Pithagoras' own i18n test holds its
 * extensions to). What the model reads (the tools) and what the server half answers is English, as pi's is.
 */

const SRC = path.resolve(import.meta.dirname, "../src");

/** Every text the code in src shows, as it is written there: what `t` and `msg` are given. */
function texts(): Map<string, string> {
  const found = new Map<string, string>();
  const files = fs.readdirSync(SRC, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && e.name !== "de.ts");
  for (const entry of files) {
    const file = path.join(entry.parentPath, entry.name);
    const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const literal = (e: ts.Expression | undefined) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ["t", "msg"].includes(n.expression.text)) {
        const key = literal(n.arguments[0]);
        if (key !== undefined) found.set(key, `${path.relative(SRC, file)}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`);
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

test("the Office page in Settings says labels, states, hints and confirmations, never a paragraph of explanation", () => {
  const long = [...texts()].filter(([text, at]) => at.startsWith(`web${path.sep}settings.tsx:`) && text.length > 120);
  assert.deepEqual(long.map(([text, at]) => `${at}: ${text}`), []);
});
