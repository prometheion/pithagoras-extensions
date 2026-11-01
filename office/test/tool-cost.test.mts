/**
 * What Office's tools cost in every request of a chat that has them: each one's description, its schema and the line
 * pi lists it by in the system prompt, counted as Pithagoras' own tests/tool-texts.test.mts counts its tools (a
 * quarter of a token to the character). A text that grows past its cap fails here; the caps are the lengths agreed
 * for each tool, with 3 % room for a word to be changed. A change of a cap says why in its commit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTools, __resetToolsForTests } from "../src/tools";

type Registered = { name: string; description: string; parameters: unknown; promptSnippet?: string };

const tokens = (text: string) => Math.ceil(text.length / 4);
/** A tool's cost as the model is charged for it: the description, the schema and the line pi lists it by. */
const cost = (tool: Registered) => tokens(tool.description) + tokens(JSON.stringify(tool.parameters)) + (tool.promptSnippet ? tokens(`- ${tool.name}: ${tool.promptSnippet}`) : 0);

/** The agreed cost of each tool, in tokens (office_screenshot: about 260 in the plan of #13, 254 as written: `large` says
 * that a picture is never larger than the editor draws it; office_format about 650 in the plan, 704 as written, after two
 * real-model runs of #13's PR 2 (an op's quote is its first key's value, set is flat, both with examples), 706 since its
 * first review (a cell's text keys leave out link), 711 since a table of contents updates itself (owner point 15: "it
 * updates itself"); office_read 246 -> 301 with
 * `formatting` and lists, 303 since it reads tables' and cells' own formatting; office_edit 958 -> 974 with `nth` and any paragraph style; office_create 190 -> 200: a Word
 * document starts with the paragraph "New document", which a model kept when it was told the document starts empty).
 * #13's PR 3, spreadsheets (plan: office_format ~910, office_edit ~1,050, office_read ~330): office_format 706 -> 929
 * with its sheet ops and keys, 936 after the second real-model run (a sheet border's sides are the range's edges);
 * office_edit 974 -> 1,068 with rows and columns, 1,061 since its first review (it said "Formatting: office_format."
 * twice); office_read 301 -> 329 with a sheet's formatting, 336 since its first
 * review (the text names office_screenshot for a sheet's alignment and borders, as the owner's answer 7 has it).
 * Merged with PR 2 as it stood at 1440423 (its table of contents text and its cell formatting): the caps below are
 * the merged texts' measured costs (office_read 303 and 336 -> 339, office_edit 974 and 1,061 -> 1,061, office_format 711
 * and 936 -> 941: the table of contents's "it updates itself" and the cell formatting's words, with the sheet's).
 * #13's PR 4, the sheet extras (plan: office_format ~1,050, office_edit ~1,090, office_read ~330): office_format 941 ->
 * 1,153 with a conditional format, validation, a link, a chart, a filter and a table (one example each; the refusals
 * name the keys and values the text leaves out), office_edit 1,061 -> 1,140 with sort and names (their five keys in
 * the schema among it), office_read 339 -> 355 with what it now lists of a sheet. */
const AGREED: Record<string, number> = {
  office_list: 113,
  office_create: 200,
  office_read: 355,
  office_edit: 1140,
  office_format: 1153,
  office_comments: 181,
  office_screenshot: 254,
};
const ROOM = 1.03;

function tools(): Registered[] {
  const out: Registered[] = [];
  __resetToolsForTests();
  registerTools({ extend: (factory) => factory({ registerTool: (t: Registered) => out.push(t) }, { id: "chat" }), owner: () => "/f/atlas", root: "/nowhere", log: () => {} });
  __resetToolsForTests();
  return out;
}

test("every office tool has an agreed cost, and none costs more than that", () => {
  const all = tools();
  assert.deepEqual(all.map((t) => t.name).sort(), Object.keys(AGREED).sort());
  const over = all.filter((t) => cost(t) > Math.ceil(AGREED[t.name] * ROOM)).map((t) => `${t.name}: ${cost(t)} tokens, agreed ${AGREED[t.name]}`);
  assert.deepEqual(over, []);
});

test("all office tools together cost what their caps add up to", () => {
  const total = tools().reduce((n, t) => n + cost(t), 0);
  const agreed = Object.values(AGREED).reduce((n, c) => n + c, 0);
  assert.ok(total <= Math.ceil(agreed * ROOM), `${total} tokens, agreed ${agreed}`);
  assert.equal(agreed, 3396);
});

test("office_edit sends formatting to office_format once, for Word and sheets alike", () => {
  const edit = tools().find((t) => t.name === "office_edit")!;
  assert.equal(edit.description.split("Formatting: office_format.").length - 1, 1, edit.description);
});
