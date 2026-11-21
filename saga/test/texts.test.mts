import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { de } from "../src/de.ts";
import { XIANXIA } from "../src/game/xianxia.ts";

/**
 * Every text a person sees has its German: the browser half's (what `t` and `msg` are given), the pack's words the
 * panel shows through `t`, and the mode as the picker shows it. What the model reads stays English.
 */

const SRC = path.resolve(import.meta.dirname, "../src");

function codeTexts(): Map<string, string> {
  const found = new Map<string, string>();
  const files = fs
    .readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && e.name !== "de.ts" && !path.join(e.parentPath, e.name).includes(`${path.sep}server`) && !path.join(e.parentPath, e.name).includes(`${path.sep}game`));
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

function packTexts(): string[] {
  const p = XIANXIA;
  return [
    ...Object.values(p.stats).flatMap((s) => [s.label, s.hint]),
    ...Object.values(p.words),
    ...p.realms.flatMap((r) => [r.name, ...(r.stepNames ?? [])]),
    ...p.places.map((x) => x.label),
    ...p.origins.flatMap((o) => [o.label, o.story]),
  ];
}

test("every text the panel shows has its German, and de.ts has nothing nobody shows", async () => {
  const want = codeTexts();
  for (const text of packTexts()) if (!want.has(text)) want.set(text, "the Xianxia pack");
  const server = fs.readFileSync(path.join(SRC, "server.ts"), "utf8");
  for (const m of server.matchAll(/(label|description): "([^"]+)"/g)) want.set(m[2], "the mode");
  assert.ok(want.size > 100);
  const missing = [...want.keys()].filter((k) => !(k in de));
  const stale = Object.keys(de).filter((k) => !want.has(k));
  assert.deepEqual(missing.map((k) => `${want.get(k)}: ${k}`), [], "de.ts lacks these");
  assert.deepEqual(stale, [], "de.ts has these nobody shows");
  const words = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [english, german] of Object.entries(de)) assert.deepEqual(words(String(german)), words(english), english);
});
