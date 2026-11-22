/** What the capability families decide: which tools a chat is kept out of, which tabs the panel offers, and which
 * tools the agent has to ask before it calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVE_TOOLS, CAPABILITIES, EARLIER_APPROVE_TOOLS, TABS, approveFor, availableFromTools, capabilityOfTool, exposureWritten, instanceOfTool, tabOffered, toolExposureFor } from "../src/capabilities.ts";

const ask = (had: unknown, given?: unknown) => approveFor(had, given, "uni");

/** pi's matching of a tool name against patterns (createToolNameMatcher in its core/mcp-servers): a name, or a pattern
 * where `*` is any characters and nothing else is a wildcard, against the server's own tool name. */
const matches = (patterns: string[], tool: string) =>
  patterns.some((p) => new RegExp(`^${p.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(tool));

/** pi's exposure of one tool of a server (getMcpToolExposure in its core/mcp-servers): the exact name first, then the first pattern that matches. */
const exposureOf = (toolExposure: Record<string, string>, tool: string): string | undefined =>
  toolExposure[tool] ?? Object.entries(toolExposure).find(([pattern]) => pattern.includes("*") && matches([pattern], tool))?.[1];

test("the agent is asked before mail goes out, a link or a share is made, and before anything is deleted or cleared", () => {
  for (const tool of [
    "nc_mail_send_message", "nc_share_create", "nc_share_create_public_link", "nc_share_delete",
    "nc_webdav_delete_resource", "nc_mail_delete_message", "nc_notes_delete_note", "nc_contacts_delete_contact", "nc_calendar_delete_event",
    "nc_calendar_delete_todo", "nc_cookbook_delete_recipe", "deck_delete_card", "deck_delete_stack", "nc_shopping_list_delete_item",
    "nc_shopping_list_delete_list", "nc_shopping_list_clear_checked_items",
  ]) assert.ok(matches(APPROVE_TOOLS, tool), `${tool} is asked about`);
});

test("the agent is asked before a Talk message, a conversation or a participant, an event or a meeting (Nextcloud mails its attendees), and deletes behind an argument or to the trash", () => {
  for (const tool of [
    "talk_send_message", "talk_create_conversation", "talk_add_participant",
    "nc_calendar_create_event", "nc_calendar_update_event", "nc_calendar_create_meeting",
    "nc_calendar_bulk_operations", "nc_calendar_manage_calendar", "collectives_trash_page", "collectives_trash_collective",
  ]) assert.ok(matches(APPROVE_TOOLS, tool), `${tool} is asked about`);
});

test("the lists earlier versions wrote are known as this extension's own, and none of them is this version's", () => {
  assert.ok(EARLIER_APPROVE_TOOLS.length > 0);
  for (const list of EARLIER_APPROVE_TOOLS) assert.notDeepEqual(list, APPROVE_TOOLS);
});

test("what is asked about is patterns of the server's own tool names with `*` only: the portal refuses pi's names, and `?` is no wildcard of pi's", () => {
  for (const pattern of [...APPROVE_TOOLS, ...EARLIER_APPROVE_TOOLS.flat()]) {
    assert.ok(!pattern.includes("?"), pattern);
    assert.ok(!pattern.startsWith("mcp__") && !pattern.includes("/"), pattern);
  }
});

test("an instance asks about the default, and about what a person added: a list the portal kept, or one still on the entry", () => {
  assert.deepEqual(ask(undefined), APPROVE_TOOLS);
  assert.deepEqual(ask([]), APPROVE_TOOLS, "no list is no choice of the person's");
  assert.deepEqual(ask(APPROVE_TOOLS), APPROVE_TOOLS);
  for (const earlier of EARLIER_APPROVE_TOOLS) assert.deepEqual(ask(earlier), APPROVE_TOOLS, "an earlier default gets this version's");
  assert.deepEqual(ask(["nc_notes_*", "nc_mail_send_message"]), [...APPROVE_TOOLS, "nc_notes_*"]);
  assert.deepEqual(ask(undefined, ["deck_*"]), [...APPROVE_TOOLS, "deck_*"]);
  assert.deepEqual(ask(["deck_*"], ["deck_*", "nc_news_*"]), [...APPROVE_TOOLS, "deck_*", "nc_news_*"]);
  assert.deepEqual(ask(undefined, true), [...APPROVE_TOOLS, "*"], "`true` asked about every tool");
  assert.deepEqual(ask(undefined, false), APPROVE_TOOLS, "the questions cannot be turned off from the entry any more");
  assert.deepEqual(ask(["nc_notes_?", "mcp__uni__x", "uni/x", " ", 3]), [...APPROVE_TOOLS, "nc_notes_*"], "`?` asks about more, what the portal would refuse is left out");
});

test("a list still in the adapter's words is carried as patterns of the tools' own names, as the portal does it: only those match what the portal checks", () => {
  const asked = ask(undefined, ["uni_nc_notes_*", "mcp__uni_nc_mail_*", "*_move_*", "uni_nc_webdav_?rite_file"]);
  for (const tool of ["nc_notes_update_note", "nc_mail_move_message", "nc_webdav_write_file", "nc_webdav_move_resource"]) assert.equal(matches(asked, tool), true, `${tool} is asked about`);
  assert.equal(matches(asked, "nc_calendar_get_event"), false, "and nothing more");
  assert.ok(!asked.some((pattern) => pattern.startsWith("mcp__")), "no pi name, which the portal refuses");
  assert.deepEqual(ask(undefined, EARLIER_APPROVE_TOOLS[0]), APPROVE_TOOLS, "an earlier default is not read as the person's, prefix or not");
});

test("Talk and Tables are families an instance can turn off, though no tab stands for them", () => {
  assert.equal(capabilityOfTool("talk_send_message")?.id, "talk");
  assert.equal(capabilityOfTool("nc_tables_insert_row")?.id, "tables");
  assert.deepEqual(toolExposureFor({ capabilities: { talk: false, tables: false } }), { "talk_*": "hidden", "nc_tables_*": "hidden" });
});

test("reading, listing, writing and saving a draft are not asked about", () => {
  for (const tool of [
    "nc_mail_list_messages", "nc_mail_get_message", "nc_mail_save_draft", "nc_mail_set_flags", "nc_share_list", "nc_webdav_list_directory",
    "nc_webdav_read_file", "nc_webdav_write_file", "nc_notes_create_note", "nc_calendar_create_todo", "deck_create_card", "deck_update_card",
  ]) assert.equal(matches(APPROVE_TOOLS, tool), false, `${tool} runs without asking`);
});

test("every tool the panel calls belongs to a family, and a family that is off keeps its tools out of the chats", () => {
  for (const [tool, family] of [["nc_mail_send_message", "mail"], ["nc_share_create", "sharing"], ["nc_webdav_read_file", "files"], ["deck_get_boards", "deck"], ["collectives_get_page", "collectives"]]) {
    assert.equal(capabilityOfTool(tool)?.id, family);
  }
  assert.equal(capabilityOfTool("nc_unknown_thing"), undefined);
  assert.deepEqual(toolExposureFor({ capabilities: { mail: false, news: true } }), { "nc_mail_*": "hidden" });
  assert.deepEqual(toolExposureFor({}), {});
  const all = toolExposureFor({ capabilities: Object.fromEntries(CAPABILITIES.map((c) => [c.id, false])) });
  assert.equal(Object.keys(all).length, CAPABILITIES.length);
  assert.ok(Object.values(all).every((how) => how === "hidden"));
  for (const key of Object.keys(all)) assert.ok(!key.includes("?"), "pi has no `?` for a tool pattern");
});

test("every tool of a family that is off is hidden by pi's own reading of the entry, and no tool of one that is on", () => {
  const tools = ["nc_mail_send_message", "nc_mail_list_messages", "nc_news_list_feeds", "nc_share_create", "nc_webdav_read_file", "deck_get_boards", "talk_send_message", "nc_unknown_thing"];
  const exposure = toolExposureFor({ capabilities: { mail: false, talk: false } });
  for (const tool of tools) assert.equal(exposureOf(exposure, tool), capabilityOfTool(tool)?.id === "mail" || capabilityOfTool(tool)?.id === "talk" ? "hidden" : undefined, tool);
});

test("a person's own lines in an entry's toolExposure stay, but never one that would leave visible what a family hides", () => {
  const own = {
    "nc_mail_*": "hidden", // a pattern of ours (see `wrote` below): written anew from the choices
    "nc_news_list_feeds": "direct", // an exact name that a hidden pattern covers would win over the pattern
    "nc_mail_send_message": "hidden", // hidden anyway: harmless
    "nc_notes_get_note": "codemode", // a line of the person's, on a family that is on
    "nc_calendar_get_*": "codemode", // a person's pattern, not a family's
    "bad": 3, // not an exposure at all
  };
  const kept = toolExposureFor({ capabilities: { news: false } }, own, ["nc_mail_*"]);
  assert.deepEqual(kept, { "nc_news_*": "hidden", "nc_mail_send_message": "hidden", "nc_notes_get_note": "codemode", "nc_calendar_get_*": "codemode" });
  for (const tool of ["nc_news_list_feeds", "nc_news_get_item"]) assert.equal(exposureOf(kept, tool), "hidden", tool);
  assert.deepEqual(toolExposureFor({ capabilities: { news: false } }, { "nc_mail_*": "hidden" }), { "nc_news_*": "hidden", "nc_mail_*": "hidden" }, "a whole family the person hid in Settings -> MCP stays hidden, whatever its switch says here");
  assert.deepEqual(toolExposureFor({}, { "nc_mail_*": "hidden", "nc_news_*": "hidden" }, ["nc_news_*"]), { "nc_mail_*": "hidden" }, "only what this extension hid itself goes with the family's switch");
  assert.deepEqual(toolExposureFor({}, { "nc_mail_*": "hidden", nc_mail_get_message: "direct" }), { "nc_mail_*": "hidden" }, "and what a person's hidden pattern covers is not left visible by an exact name");
  assert.deepEqual(exposureWritten({ capabilities: { mail: false, news: false } }, { "nc_mail_*": "hidden" }, ["nc_news_*"]), ["nc_news_*"], "a hide that stood there before and is not recorded is the person's, not written by this extension");
  assert.deepEqual(exposureWritten({ capabilities: { mail: false } }, { "nc_mail_*": "hidden" }, ["nc_mail_*"]), ["nc_mail_*"]);
  assert.deepEqual(toolExposureFor({}, "not a map"), {});
  assert.deepEqual(toolExposureFor({}, ["nc_mail_*"]), {});
});

test("a tool of the chats is the instance's by the namespace pi gives it, the longest name first", () => {
  assert.equal(instanceOfTool("mcp__uni__nc_notes_create_note", ["uni", "other"]), "uni");
  assert.equal(instanceOfTool("mcp__my_cloud__nc_notes_create_note", ["my-cloud"]), "my-cloud", "dashes are underscores in pi's names");
  assert.equal(instanceOfTool("mcp__nextcloud_uni__nc_notes_create_note", ["nextcloud", "nextcloud_uni"]), "nextcloud_uni");
  assert.equal(instanceOfTool("mcp__nextcloud__nc_notes_create_note", ["nextcloud", "nextcloud_uni"]), "nextcloud");
  assert.equal(instanceOfTool("uni_nc_notes_create_note", ["uni"]), undefined, "the adapter's spelling is no instance's");
  assert.equal(instanceOfTool("mcp__unix__x", ["uni"]), undefined);
  assert.equal(instanceOfTool("bash", ["uni"]), undefined);
});

test("a family stands available where the endpoint lists one of its tools, and a tab stands where one of its families is on and provided", () => {
  const available = availableFromTools(["nc_mail_list_messages", "nc_webdav_read_file"]);
  assert.equal(available.mail, true);
  assert.equal(available.files, true);
  assert.equal(available.sharing, false);
  const mail = TABS.find((t) => t.id === "mail")!;
  const files = TABS.find((t) => t.id === "files")!;
  const news = TABS.find((t) => t.id === "news")!;
  assert.equal(tabOffered(mail, available, {}), true);
  assert.equal(tabOffered(mail, available, { mail: false }), false, "turned off");
  assert.equal(tabOffered(news, available, {}), false, "not provided");
  assert.equal(tabOffered(files, available, { files: false }), false, "sharing is not provided either");
  assert.equal(tabOffered(files, { files: false, sharing: true }, { sharing: false }), false);
  assert.equal(tabOffered(news, undefined, {}), true, "not asked yet: the choices alone decide");
});
