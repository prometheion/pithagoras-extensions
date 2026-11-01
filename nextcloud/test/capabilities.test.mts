/** What the capability families decide: which tools a chat is kept out of, which tabs the panel offers, and which
 * tools the agent has to ask before it calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVE_TOOLS, CAPABILITIES, EARLIER_APPROVE_TOOLS, TABS, availableFromTools, capabilityOfTool, excludeGlobs, tabOffered } from "../src/capabilities.ts";

/** pi-mcp-adapter's matching (types.ts matchesToolPattern): a glob with * and ?, or a name, against the raw tool name. */
const matches = (patterns: string[], tool: string) =>
  patterns.some((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(tool));

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

test("Talk and Tables are families an instance can turn off, though no tab stands for them", () => {
  assert.equal(capabilityOfTool("talk_send_message")?.id, "talk");
  assert.equal(capabilityOfTool("nc_tables_insert_row")?.id, "tables");
  assert.deepEqual(excludeGlobs({ name: "uni", capabilities: { talk: false, tables: false } }), ["uni_talk_*", "uni_nc_tables_*"]);
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
  assert.deepEqual(excludeGlobs({ name: "uni", capabilities: { mail: false, news: true } }), ["uni_nc_mail_*"]);
  assert.deepEqual(excludeGlobs({ name: "uni" }), []);
  assert.deepEqual(excludeGlobs({ name: "uni", capabilities: Object.fromEntries(CAPABILITIES.map((c) => [c.id, false])) }).length, CAPABILITIES.length);
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
