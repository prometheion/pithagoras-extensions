import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { VIEW_HTML, viewPageJs } from "./page.mts";

/**
 * The panel's views (the shopping list, the contacts, the calendar, ...) as the portal draws them: the components
 * themselves in Chromium, with the portal's own React, against routes that answer as the server half does -- `/tool`
 * with what a Nextcloud MCP server would say (content parts with JSON in their text, or its isError), which each test
 * scripts for the tools it needs. Each test reads what the views asked (`calls`), and what the page showed.
 *
 *   PITHAGORAS_DIR=<a built Pithagoras> npm run test:portal -w nextcloud
 */

const DIR = process.env.PITHAGORAS_DIR;
if (!DIR) throw new Error("PITHAGORAS_DIR is not set: name a Pithagoras checkout, then PITHAGORAS_DIR=... npm run test:portal -w nextcloud");
const BASE = "/api/x/%40pithagoras/nextcloud";
const CSS = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/client.css"), "utf8");

/** What a tool says: a value (its JSON in a text part), or an error (its words, as isError). */
class ToolError extends Error {}
type Handler = (args: any) => unknown | Promise<unknown>;
const handlers = new Map<string, Handler>();
let calls: { name: string; args: any }[] = [];
/** The status and the instances the routes answer. */
let statusBody: Record<string, unknown> = {};
let instancesBody: Record<string, unknown> = {};
const ALL_ON = Object.fromEntries(["shopping", "cookbook", "notes", "files", "sharing", "deck", "calendar", "contacts", "mail", "news", "collectives"].map((id) => [id, true]));
const instanceRow = (over: Record<string, unknown> = {}) => ({ name: "uni", containerName: "c", state: "running", address: "http://127.0.0.1:8000/mcp", url: "https://cloud.example.org", mcp: { registered: true, on: true }, health: { ok: true }, configured: true, capabilities: { available: ALL_ON, on: {} }, ...over });

let server: http.Server;
let origin = "";
let browser: Browser;
let pageJs = "";

before(async () => {
  pageJs = await viewPageJs(path.resolve(DIR), BASE);
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
    if (url.pathname === "/view.html") return send(200, "text/html", VIEW_HTML);
    if (url.pathname === "/view-page.js") return send(200, "text/javascript", pageJs);
    if (url.pathname === "/client.css") return send(200, "text/css", CSS);
    if (url.pathname === `${BASE}/status`) return send(200, "application/json", JSON.stringify(statusBody));
    if (url.pathname === `${BASE}/instances`) return send(200, "application/json", JSON.stringify(instancesBody));
    if (url.pathname === `${BASE}/tool` && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { name, args } = JSON.parse(raw) as { name: string; args: unknown };
      calls.push({ name, args });
      const handler = handlers.get(name);
      if (!handler) return send(200, "application/json", JSON.stringify({ isError: true, content: [{ type: "text", text: `no stand-in for ${name}` }] }));
      try {
        const value = await handler(args);
        return send(200, "application/json", JSON.stringify({ content: [{ type: "text", text: JSON.stringify(value) }] }));
      } catch (error) {
        if (error instanceof ToolError) return send(200, "application/json", JSON.stringify({ isError: true, content: [{ type: "text", text: error.message }] }));
        return send(500, "application/json", JSON.stringify({ error: (error as Error).message }));
      }
    }
    send(404, "application/json", "{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  handlers.clear();
  calls = [];
  statusBody = { image: "x", instances: [instanceRow()], configured: true };
  instancesBody = { instances: [{ name: "uni", url: "https://cloud.example.org", username: "anna", passwordSet: true, configured: true }] };
});

const on = (name: string, handler: Handler) => handlers.set(name, handler);
const calledWith = (name: string) => calls.filter((c) => c.name === name).map((c) => c.args);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A view on a page of its own (tab id, "panel" or "settings"), with the browser's time zone and clock as asked. */
async function open(view: string, options: { timezone?: string; now?: string } = {}): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, timezoneId: options.timezone ?? "UTC" });
  context.setDefaultTimeout(5_000);
  const page = await context.newPage();
  if (options.now) await page.clock.install({ time: new Date(options.now) });
  await page.goto(`${origin}/view.html?view=${view}`);
  return page;
}
const confirms = (page: Page) => page.evaluate(() => (window as unknown as { __confirms: unknown[] }).__confirms);
const answerConfirms = (page: Page, answer: boolean) => page.evaluate((a) => ((window as unknown as { __confirmAnswer: boolean }).__confirmAnswer = a), answer);
const close = (page: Page) => page.context().close();

// ---- Shopping List ---------------------------------------------------------------------------------------------

function shoppingBackend(items: Record<number, any[]> = { 1: [{ id: 11, name: "Milk", quantity: "2", unit: "l", checked: false }], 2: [{ id: 21, name: "Nails", checked: false }] }) {
  const lists = [{ id: 1, title: "Food" }, { id: 2, title: "Tools" }];
  on("nc_shopping_list_get_lists", () => ({ lists }));
  on("nc_shopping_list_get_items", ({ list_id }) => ({ items: items[list_id] ?? [] }));
  return { lists, items };
}

test("Shopping List: the first list loads its items at once, without pressing the pill that is already pressed (H4)", async () => {
  shoppingBackend();
  const page = await open("shopping");
  await page.getByText("Milk").waitFor();
  assert.deepEqual(calledWith("nc_shopping_list_get_items"), [{ list_id: 1 }]);
  assert.equal(await page.getByRole("button", { name: "Food" }).getAttribute("aria-pressed"), "true");
  await close(page);
});

test("Shopping List: a slow answer for the list pressed first does not overwrite the list pressed second (M11)", async () => {
  const data = shoppingBackend();
  let first = true;
  on("nc_shopping_list_get_items", async ({ list_id }) => {
    if (first) {
      first = false;
      await sleep(400); // the first list's own load is the slow one
    }
    return { items: data.items[list_id] };
  });
  const page = await open("shopping");
  await page.getByRole("button", { name: "Tools" }).click();
  await page.getByText("Nails").waitFor();
  await sleep(600);
  assert.equal(await page.getByText("Milk").count(), 0, "the late answer of Food stays out");
  assert.equal(await page.getByText("Nails").count(), 1);
  await close(page);
});

test("Shopping List: a refused add keeps what was typed; a tick keeps the list on screen while it reloads (L18)", async () => {
  shoppingBackend();
  on("nc_shopping_list_add_items", () => {
    throw new ToolError("The list is read-only");
  });
  const page = await open("shopping");
  await page.getByText("Milk").waitFor();
  await page.getByLabel("Add an item").fill("Bread");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("alert").getByText("The list is read-only").waitFor();
  assert.equal(await page.getByLabel("Add an item").inputValue(), "Bread");
  on("nc_shopping_list_check_item", () => ({}));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  on("nc_shopping_list_get_items", async () => {
    await gate;
    return { items: [{ id: 11, name: "Milk", quantity: "2", unit: "l", checked: true }] };
  });
  await page.getByRole("checkbox").click();
  await sleep(100);
  assert.equal(await page.getByText("Milk").count(), 1, "the items stay on screen while they are read again");
  release();
  await close(page);
});

test("Shopping List: deleting a list asks through the portal's dialog, as a deletion", async () => {
  shoppingBackend();
  on("nc_shopping_list_delete_list", () => ({}));
  const page = await open("shopping");
  await page.getByText("Milk").waitFor();
  await answerConfirms(page, false);
  await page.getByRole("button", { name: "Delete this list" }).click();
  await sleep(100);
  assert.equal(calledWith("nc_shopping_list_delete_list").length, 0, "no yes, no deletion");
  const asked = (await confirms(page)) as any[];
  assert.equal(asked.length, 1);
  assert.equal(asked[0].danger, true);
  assert.equal(asked[0].deletes, true);
  assert.match(asked[0].title, /Food/);
  await answerConfirms(page, true);
  await page.getByRole("button", { name: "Delete this list" }).click();
  await sleep(150);
  assert.deepEqual(calledWith("nc_shopping_list_delete_list"), [{ list_id: 1 }]);
  await close(page);
});

test("Shopping List: a failed load says why and offers to try again", async () => {
  on("nc_shopping_list_get_lists", () => {
    throw new ToolError("Shopping List app is not installed");
  });
  const page = await open("shopping");
  await page.getByRole("alert").getByText(/not installed/).waitFor();
  shoppingBackend();
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByText("Milk").waitFor();
  await close(page);
});

test("Shopping List: a ticked item is struck through", async () => {
  shoppingBackend({ 1: [{ id: 11, name: "Milk", checked: true }], 2: [] });
  const page = await open("shopping");
  const decoration = await page.getByText("Milk").evaluate((el) => getComputedStyle(el).textDecorationLine);
  assert.equal(decoration, "line-through");
  await close(page);
});

// ---- Contacts --------------------------------------------------------------------------------------------------

const ann = (over: Record<string, unknown> = {}) => ({ uid: "u1", fn: "Ann", emails: [{ value: "ann@example.org" }], phones: [], etag: "e1", ...over });
function contactsBackend(books = [{ uri: "contacts", displayname: "Contacts" }, { uri: "work", displayname: "Work" }]) {
  on("nc_contacts_list_addressbooks", () => ({ addressbooks: books }));
  const lists: Record<string, any[]> = { contacts: [ann()], work: [ann({ uid: "w1", fn: "Wendy", emails: [{ value: "wendy@example.org" }] })] };
  on("nc_contacts_list_contacts", ({ addressbook }) => ({ contacts: lists[addressbook] }));
  return lists;
}

test("Contacts: the first book is chosen at once, so search, save, delete and create work (H5)", async () => {
  const lists = contactsBackend();
  on("nc_contacts_search_contacts", ({ query }) => ({ contacts: lists.contacts.filter((c) => c.fn.toLowerCase().includes(query.toLowerCase())) }));
  on("nc_contacts_update_contact", () => ({}));
  on("nc_contacts_create_contact", () => ({}));
  on("nc_contacts_delete_contact", () => ({}));
  const page = await open("contacts");
  await page.locator(".nc-contact", { hasText: "Ann" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Contacts", exact: true }).getAttribute("aria-pressed"), "true", "the first book is marked");
  assert.equal(calledWith("nc_contacts_list_contacts").length, 1, "and the list is read once, not twice");
  await page.getByLabel("Search the contacts").fill("an");
  await page.waitForFunction(() => true);
  await sleep(500);
  assert.deepEqual(calledWith("nc_contacts_search_contacts"), [{ query: "an", addressbook: "contacts" }]);
  await page.getByLabel("Search the contacts").fill("");
  await page.locator(".nc-contact", { hasText: "Ann" }).click();
  await page.getByLabel("Full name").fill("Ann B");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("status").getByText("Saved.").waitFor();
  assert.equal(calledWith("nc_contacts_update_contact").length, 1, "Save made its call");
  await close(page);
});

test("Contacts: after a Save the contact open has the card's new etag, and a second Save sends it (M16)", async () => {
  const lists = contactsBackend();
  let etag = 1;
  on("nc_contacts_update_contact", ({ contact_data, etag: sent }) => {
    lists.contacts[0] = ann({ fn: contact_data.fn ?? "Ann", etag: `e${++etag}` });
    return { sent };
  });
  const page = await open("contacts");
  await page.locator(".nc-contact", { hasText: "Ann" }).click();
  await page.getByLabel("Full name").fill("Ann B");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("status").getByText("Saved.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Save" }).isDisabled(), true, "nothing changed since the Save");
  await page.getByLabel("Full name").fill("Ann C");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("status").getByText("Saved.").waitFor();
  assert.deepEqual(calledWith("nc_contacts_update_contact").map((a) => a.etag), ["e1", "e2"]);
  await close(page);
});

test("Contacts: a slow list of the first book does not overwrite the book pressed after it (M11)", async () => {
  const lists = contactsBackend();
  let first = true;
  on("nc_contacts_list_contacts", async ({ addressbook }) => {
    if (first) {
      first = false;
      await sleep(500);
    }
    return { contacts: lists[addressbook] };
  });
  const page = await open("contacts");
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await page.getByRole("button", { name: "Wendy" }).waitFor();
  await sleep(700);
  assert.equal(await page.locator(".nc-contact", { hasText: "Ann" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Work", exact: true }).getAttribute("aria-pressed"), "true");
  await close(page);
});

test("Contacts: a delete asks through the portal's dialog; going back with a changed contact asks too", async () => {
  contactsBackend();
  on("nc_contacts_delete_contact", () => ({}));
  const page = await open("contacts");
  await page.locator(".nc-contact", { hasText: "Ann" }).click();
  await page.getByLabel("Full name").fill("Ann changed");
  assert.equal(await page.evaluate(() => (window as any).__unsaved), true, "the portal is told there is a draft");
  await answerConfirms(page, false);
  await page.getByRole("button", { name: "← Back to the list" }).click();
  await sleep(100);
  assert.equal(await page.getByLabel("Full name").count(), 1, "still in the contact");
  await page.getByRole("button", { name: "Delete this contact" }).click();
  await sleep(100);
  assert.equal(calledWith("nc_contacts_delete_contact").length, 0);
  assert.equal(((await confirms(page)) as any[]).at(-1).deletes, true);
  await answerConfirms(page, true);
  await page.getByRole("button", { name: "Delete this contact" }).click();
  await page.getByRole("button", { name: "Contacts", exact: true }).waitFor();
  assert.equal(calledWith("nc_contacts_delete_contact").length, 1);
  await close(page);
});

test("Contacts: the error of a failed contact list is drawn, with a way to try again", async () => {
  on("nc_contacts_list_addressbooks", () => ({ addressbooks: [{ uri: "contacts", displayname: "Contacts" }] }));
  on("nc_contacts_list_contacts", () => {
    throw new ToolError("Contacts app is off");
  });
  const page = await open("contacts");
  await page.getByRole("alert").getByText(/Contacts app is off/).waitFor();
  on("nc_contacts_list_contacts", () => ({ contacts: [ann()] }));
  await page.getByRole("button", { name: "Retry" }).click();
  await page.locator(".nc-contact", { hasText: "Ann" }).waitFor();
  await close(page);
});

// ---- Mail ------------------------------------------------------------------------------------------------------

const msg = (id: number, subject: string, seen = true) => ({ database_id: id, subject, date_int: 1_700_000_000, from_: [{ label: "Bob", email: "bob@example.org" }], flags: { seen }, preview_text: "…" });
function mailBackend() {
  const state = { unread: 1, inbox: [msg(100, "Hello", false), msg(101, "Older")], body: "Hi Anna" as string, html: false };
  on("nc_mail_list_accounts", () => ({ results: [{ id: 1, email: "anna@example.org" }] }));
  on("nc_mail_list_mailboxes", () => ({ results: [{ database_id: 10, name: "INBOX", unread: state.unread }, { database_id: 11, name: "Archive", unread: 0 }] }));
  on("nc_mail_list_messages", ({ mailbox_id }) => ({ results: mailbox_id === 10 ? state.inbox : [] }));
  on("nc_mail_get_message", ({ message_id }) => ({ message: { subject: "Hello", date_int: 1_700_000_000, from_: [{ label: "Bob", email: "bob@example.org" }], to: [], body: state.body, has_html_body: state.html, flags: { seen: message_id !== 100 }, attachments: [] } }));
  on("nc_mail_set_flags", () => ({}));
  return state;
}
async function mailCompose(page: Page) {
  await page.getByRole("button", { name: /anna@example.org/ }).click();
  await page.getByRole("button", { name: /A new message/ }).click();
}

test("Mail: Enter in a field of the compose form does not send; only the Send button does (H8)", async () => {
  mailBackend();
  on("nc_mail_send_message", () => ({}));
  const page = await open("mail");
  await mailCompose(page);
  await page.getByLabel("To, comma-separated").fill("max@example.org");
  await page.getByLabel("To, comma-separated").press("Enter");
  await page.getByLabel("Subject").press("Enter");
  await sleep(150);
  assert.equal(calledWith("nc_mail_send_message").length, 0, "nothing has gone out");
  await page.getByLabel("Subject").fill("Hi");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("status").getByText("The message is sent.").waitFor();
  assert.equal(calledWith("nc_mail_send_message").length, 1);
  await close(page);
});

test("Mail: a message with no subject and no text is asked about before it is sent (H8)", async () => {
  mailBackend();
  on("nc_mail_send_message", () => ({}));
  const page = await open("mail");
  await mailCompose(page);
  await page.getByLabel("To, comma-separated").fill("max@example.org");
  await answerConfirms(page, false);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await sleep(150);
  assert.equal(calledWith("nc_mail_send_message").length, 0);
  assert.match(((await confirms(page)) as any[])[0].title, /empty/i);
  await close(page);
});

test("Mail: a send the server refuses says why, in the form it came from, and keeps the words (H7)", async () => {
  mailBackend();
  on("nc_mail_send_message", () => {
    throw new ToolError("SMTP refused: relay denied");
  });
  const page = await open("mail");
  await mailCompose(page);
  await page.getByLabel("To, comma-separated").fill("max@example.org");
  await page.getByLabel("Subject").fill("Hi");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("alert").getByText("SMTP refused: relay denied").waitFor();
  assert.equal(await page.getByLabel("Subject").inputValue(), "Hi", "the form is still there with its words");
  assert.equal(await page.evaluate(() => (window as any).__unsaved), true);
  await close(page);
});

test("Mail: names and quoted names with a comma are read as one recipient each; a part that is no address is said, not sent", async () => {
  mailBackend();
  on("nc_mail_save_draft", () => ({}));
  const page = await open("mail");
  await mailCompose(page);
  await page.getByLabel("To, comma-separated").fill('"Muster, Max" <max@example.de>, Anna Beispiel <anna@example.de>, plain@example.de');
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.getByRole("status").getByText(/Drafts/).waitFor();
  assert.deepEqual(JSON.parse(calledWith("nc_mail_save_draft")[0].to), [{ label: "Muster, Max", email: "max@example.de" }, { label: "Anna Beispiel", email: "anna@example.de" }, { email: "plain@example.de" }]);
  await page.getByRole("button", { name: /A new message/ }).click();
  await page.getByLabel("To, comma-separated").fill("max@example.de, not an address");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.getByRole("alert").getByText(/Not an address: not an address/).waitFor();
  assert.equal(calledWith("nc_mail_save_draft").length, 1);
  await close(page);
});

test("Mail: reading a message takes the new mark off its row and the unread count off its mailbox (M13)", async () => {
  mailBackend();
  const page = await open("mail");
  await page.getByRole("button", { name: /anna@example.org/ }).click();
  await page.getByRole("button", { name: /INBOX/ }).getByText("1 unread").waitFor();
  await page.getByRole("button", { name: /INBOX/ }).click();
  await page.getByRole("button", { name: /new\s*Hello/ }).click();
  await page.getByText("Hi Anna").waitFor();
  await page.getByRole("button", { name: /← Messages/ }).click();
  await page.getByRole("button", { name: /Hello/ }).waitFor();
  assert.equal(await page.locator(".nc-chip", { hasText: "new" }).count(), 0, "the new chip is gone");
  await page.getByRole("button", { name: /← Mailboxes/ }).click();
  await page.getByRole("button", { name: /INBOX/ }).waitFor();
  assert.equal(await page.getByText(/\d+ unread/).count(), 0, "and the mailbox counts nothing unread");
  await close(page);
});

test("Mail: a body the server gave as HTML shows the text it says, not its tags", async () => {
  const state = mailBackend();
  state.html = true;
  state.body = "<html><body><p>Dear <b>Anna</b>,</p><p>see you<br>soon</p><script>alert(1)</script></body></html>";
  const page = await open("mail");
  await page.getByRole("button", { name: /anna@example.org/ }).click();
  await page.getByRole("button", { name: /INBOX/ }).click();
  await page.getByRole("button", { name: /Hello/ }).first().click();
  const text = await page.locator("pre.nc-file-text").innerText();
  assert.equal(text, "Dear Anna,\nsee you\nsoon");
  await close(page);
});

test("Mail: a message that cannot be opened says why, and the list is still there to go on from (M9)", async () => {
  mailBackend();
  on("nc_mail_get_message", () => {
    throw new ToolError("IMAP connection lost");
  });
  const page = await open("mail");
  await page.getByRole("button", { name: /anna@example.org/ }).click();
  await page.getByRole("button", { name: /INBOX/ }).click();
  await page.getByRole("button", { name: /Hello/ }).click();
  await page.getByRole("alert").getByText("IMAP connection lost").waitFor();
  assert.equal(await page.getByRole("button", { name: /Older/ }).count(), 1);
  await close(page);
});

test("Mail: deleting a message asks through the portal's dialog first; the mailboxes' counts are read again after it", async () => {
  const state = mailBackend();
  on("nc_mail_delete_message", () => {
    state.unread = 0;
    return {};
  });
  const page = await open("mail");
  await page.getByRole("button", { name: /anna@example.org/ }).click();
  await page.getByRole("button", { name: /INBOX/ }).click();
  await page.getByRole("button", { name: /Older/ }).click();
  await answerConfirms(page, false);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await sleep(100);
  assert.equal(calledWith("nc_mail_delete_message").length, 0);
  await answerConfirms(page, true);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: /← Mailboxes/ }).waitFor();
  assert.equal(calledWith("nc_mail_delete_message").length, 1);
  assert.equal(calledWith("nc_mail_list_mailboxes").length, 2, "the counts were asked again");
  await close(page);
});

// ---- Calendar --------------------------------------------------------------------------------------------------

const NOW = "2025-03-10T12:00:00-04:00";
const ev = (uid: string, summary: string, start: string, end: string, allDay = false) => ({ uid, summary, start, end, all_day: allDay, calendar_name: "personal", recurring: false });
function calendarBackend(events: any[]) {
  const state = { events };
  on("nc_calendar_list_calendars", () => ({ calendars: [{ name: "personal", display_name: "Personal", read_only: false, enabled: true }] }));
  on("nc_calendar_list_events", () => ({ events: state.events }));
  on("nc_calendar_get_event", ({ event_uid }) => state.events.find((e) => e.uid === event_uid));
  return state;
}
const cellOf = (page: Page, summary: string) => page.locator(".nc-monthcell", { hasText: summary });
const dayNumber = (page: Page, summary: string) => cellOf(page, summary).locator(".nc-monthnum").allInnerTexts();

test("Calendar: after a delete the grid asks the server again and the event is gone (H6)", async () => {
  const state = calendarBackend([ev("e1", "Meeting", "2025-03-12T10:00:00", "2025-03-12T11:00:00")]);
  on("nc_calendar_delete_event", () => {
    state.events = [];
    return {};
  });
  const page = await open("calendar", { now: NOW });
  await cellOf(page, "Meeting").waitFor();
  await cellOf(page, "Meeting").click();
  await page.locator(".nc-event", { hasText: "Meeting" }).click();
  await page.getByRole("button", { name: "Delete this event" }).click();
  await page.getByRole("button", { name: /← Back to the agenda/ }).waitFor({ state: "detached" });
  await page.locator(".calendar-pane").waitFor();
  await sleep(200);
  assert.equal(calledWith("nc_calendar_list_events").length, 2, "the window was read again");
  assert.equal(await cellOf(page, "Meeting").count(), 0, "and Meeting is not on the grid any more");
  await close(page);
});

test("Calendar: a new event shows on the grid without moving to another month and back (H6)", async () => {
  const state = calendarBackend([]);
  on("nc_calendar_create_event", ({ title }) => {
    state.events = [ev("n1", title, "2025-03-10T09:00:00", "2025-03-10T10:00:00")];
    return {};
  });
  const page = await open("calendar", { now: NOW });
  await page.getByRole("button", { name: /New event/ }).click();
  await page.getByLabel("What it is").fill("Dentist");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await cellOf(page, "Dentist").waitFor();
  await close(page);
});

test("Calendar: an all-day event stands on its own day west of UTC, not the day before (M14)", async () => {
  calendarBackend([ev("h1", "Holiday", "2025-03-15", "2025-03-16", true)]);
  const page = await open("calendar", { now: NOW, timezone: "America/New_York" });
  await cellOf(page, "Holiday").first().waitFor();
  assert.deepEqual(await dayNumber(page, "Holiday"), ["15"]);
  await cellOf(page, "Holiday").click();
  await page.locator(".nc-event", { hasText: "Holiday" }).click();
  assert.equal(await page.getByLabel("On which day").inputValue(), "2025-03-15", "and the detail says the 15th as well");
  await close(page);
});

test("Calendar: an event of several days, and one that ends at midnight, stand on each of their days (M15)", async () => {
  calendarBackend([ev("t1", "Trip", "2025-03-17T09:00:00", "2025-03-19T17:00:00"), ev("t2", "Night", "2025-03-20T22:00:00", "2025-03-21T00:00:00"), ev("t3", "Camp", "2025-03-24", "2025-03-27", true)]);
  const page = await open("calendar", { now: NOW });
  await cellOf(page, "Trip").first().waitFor();
  assert.deepEqual(await dayNumber(page, "Trip"), ["17", "18", "19"]);
  assert.deepEqual(await dayNumber(page, "Night"), ["20"], "ending at midnight, it does not reach the 21st");
  assert.deepEqual(await dayNumber(page, "Camp"), ["24", "25", "26"], "an all-day end is the day after the last");
  await close(page);
});

test("Calendar: a window that came back full says it is cut short (M15)", async () => {
  calendarBackend(Array.from({ length: 500 }, (_, i) => ev(`x${i}`, `E${i}`, "2025-03-12T10:00:00", "2025-03-12T11:00:00")));
  const page = await open("calendar", { now: NOW });
  await page.getByText(/Showing the first 500 events/).waitFor();
  await close(page);
});

test("Calendar: of two events pressed one after the other, the late answer of the first does not replace the second (M11)", async () => {
  calendarBackend([ev("a", "Alpha", "2025-03-10T09:00:00", "2025-03-10T10:00:00"), ev("b", "Beta", "2025-03-10T11:00:00", "2025-03-10T12:00:00")]);
  const events = [ev("a", "Alpha", "2025-03-10T09:00:00", "2025-03-10T10:00:00"), ev("b", "Beta", "2025-03-10T11:00:00", "2025-03-10T12:00:00")];
  on("nc_calendar_get_event", async ({ event_uid }) => {
    if (event_uid === "a") await sleep(500);
    return events.find((e) => e.uid === event_uid);
  });
  const page = await open("calendar", { now: NOW });
  await page.locator(".nc-event", { hasText: "Alpha" }).click();
  await page.locator(".nc-event", { hasText: "Beta" }).click({ timeout: 2000 }).catch(() => {});
  await page.getByLabel("Event title").waitFor();
  await sleep(700);
  assert.equal(await page.getByLabel("Event title").inputValue(), "Beta");
  await close(page);
});

test("Calendar: an end before the start is said, and the form stays as it was; a failed opening and a failed create are drawn (L12, M9)", async () => {
  calendarBackend([ev("e1", "Meeting", "2025-03-10T10:00:00", "2025-03-10T11:00:00")]);
  on("nc_calendar_update_event", () => ({}));
  const page = await open("calendar", { now: NOW });
  await page.locator(".nc-event", { hasText: "Meeting" }).click();
  await page.getByLabel("To", { exact: true }).fill("2025-03-10T09:00");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("alert").getByText("The event ends before it starts.").waitFor();
  assert.equal(calledWith("nc_calendar_update_event").length, 0);
  assert.equal(await page.getByLabel("Event title").count(), 1, "the form is still open");
  on("nc_calendar_get_event", () => {
    throw new ToolError("Calendar server is busy");
  });
  await answerConfirms(page, true);
  await page.getByRole("button", { name: /← Back to the agenda/ }).click();
  await page.locator(".nc-event", { hasText: "Meeting" }).click();
  await page.getByRole("alert").getByText("Calendar server is busy").waitFor();
  on("nc_calendar_create_event", () => {
    throw new ToolError("Calendar is read-only");
  });
  await page.getByRole("button", { name: /New event/ }).click();
  await page.getByLabel("What it is").fill("X");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("alert").getByText("Calendar is read-only").waitFor();
  await close(page);
});

test("Calendar: a todo is deleted only after the portal's dialog says yes", async () => {
  calendarBackend([]);
  on("nc_calendar_list_todos", () => ({ todos: [{ uid: "t1", summary: "Water plants", status: "NEEDS-ACTION", due: "2025-03-15" }] }));
  on("nc_calendar_delete_todo", () => ({}));
  const page = await open("calendar", { now: NOW, timezone: "America/New_York" });
  await page.getByRole("button", { name: "Todos" }).click();
  await page.getByText("Water plants").waitFor();
  assert.ok(await page.getByText("Mar 15").count(), "the due day is the 15th west of UTC as well");
  await answerConfirms(page, false);
  await page.getByRole("button", { name: "Take this todo away" }).click();
  await sleep(100);
  assert.equal(calledWith("nc_calendar_delete_todo").length, 0);
  await answerConfirms(page, true);
  await page.getByRole("button", { name: "Take this todo away" }).click();
  await sleep(200);
  assert.equal(calledWith("nc_calendar_delete_todo").length, 1);
  await close(page);
});
