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
/** Whether /status answers a failure (the server half is not up), and what the page sent to the instance routes. */
let statusFails = false;
let instancesFail = false;
let posts: { route: string; body: any }[] = [];
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
    if (url.pathname === `${BASE}/status`) return statusFails ? send(502, "application/json", JSON.stringify({ error: "the server half is not running" })) : send(200, "application/json", JSON.stringify(statusBody));
    if (url.pathname === `${BASE}/instances` && req.method === "GET") return instancesFail ? send(502, "application/json", JSON.stringify({ error: "the server half is not running" })) : send(200, "application/json", JSON.stringify(instancesBody));
    if (req.method === "POST" && [`${BASE}/instances`, `${BASE}/instances/remove`, `${BASE}/start`, `${BASE}/reset`].includes(url.pathname)) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      posts.push({ route: url.pathname.slice(BASE.length), body: raw ? JSON.parse(raw) : {} });
      return send(200, "application/json", JSON.stringify({ ...instancesBody, ok: true }));
    }
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
  posts = [];
  statusFails = false;
  instancesFail = false;
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

// ---- Collectives -----------------------------------------------------------------------------------------------

/** A Collectives and WebDAV of a few lines, with the Nextcloud MCP server's rule for writes: an existing file is written
 * only against the etag it has now (`if_match`), a new one without it; anything else is a ToolError. */
function collectivesBackend() {
  const files = new Map<string, { content: string; etag: string }>([["Collectives/Wiki/Readme.md", { content: "old text", etag: "v1" }]]);
  const pages = [{ id: 5, title: "Home", file_name: "Readme.md", file_path: "", collective_path: "Collectives/Wiki", size: 8 }];
  const state = { files, pages, writes: [] as any[], nextEtag: 2, failWrite: undefined as string | undefined };
  on("collectives_get_collectives", () => ({ collectives: [{ id: 1, name: "Wiki", can_edit: true }] }));
  on("collectives_get_pages", () => ({ pages: state.pages }));
  on("collectives_search_pages", () => ({ results: state.pages.slice(0, 1) }));
  on("collectives_get_page", ({ page_id }) => ({ page: { title: "Home" }, content: [...files.entries()].find(([p]) => state.pages.some((x) => x.id === page_id && `${x.collective_path}/${x.file_name}` === p))?.[1].content ?? "" }));
  on("nc_webdav_read_file", ({ path }) => {
    const file = files.get(path);
    if (!file) throw new ToolError(`Not found: ${path}`);
    return { path, content: file.content, etag: file.etag };
  });
  on("nc_webdav_write_file", (args) => {
    state.writes.push(args);
    if (state.failWrite) throw new ToolError(state.failWrite);
    const there = files.get(args.path);
    if (args.if_match === undefined && there) throw new ToolError(`The file ${args.path} already exists`);
    if (args.if_match !== undefined && (!there || there.etag !== args.if_match)) throw new ToolError("412 Precondition Failed: the file has changed since it was read");
    const etag = `v${state.nextEtag++}`;
    files.set(args.path, { content: args.content, etag });
    return { path: args.path, created: !there, etag };
  });
  on("collectives_create_page", ({ title }) => {
    state.pages.push({ id: 6, title, file_name: `${title}.md`, file_path: "", collective_path: "Collectives/Wiki", size: 0 });
    files.set(`Collectives/Wiki/${title}.md`, { content: "", etag: "v0" });
    return { id: 6 };
  });
  return state;
}
const openCollectivePage = async (page: Page) => {
  await page.getByRole("button", { name: /Wiki/ }).click();
  await page.getByRole("button", { name: /Home/ }).click();
  await page.getByLabel("The page's text").waitFor();
};

test("Collectives: saving an existing page writes against the etag it was read with, says Saved, and chains the next save (H3)", async () => {
  const state = collectivesBackend();
  const page = await open("collectives");
  await openCollectivePage(page);
  await page.getByLabel("The page's text").fill("new text");
  await page.getByRole("button", { name: "Save the page" }).click();
  await page.getByRole("status").getByText("Saved.").waitFor();
  assert.equal(state.files.get("Collectives/Wiki/Readme.md")?.content, "new text");
  await page.getByLabel("The page's text").fill("newer text");
  await page.getByRole("button", { name: "Save the page" }).click();
  await page.getByRole("status").getByText("Saved.").waitFor();
  assert.deepEqual(state.writes.map((w) => w.if_match), ["v1", "v2"]);
  await close(page);
});

test("Collectives: a page that someone changed meanwhile is said to be changed, and the words stay (H3)", async () => {
  const state = collectivesBackend();
  const page = await open("collectives");
  await openCollectivePage(page);
  state.files.set("Collectives/Wiki/Readme.md", { content: "their text", etag: "v9" });
  await page.getByLabel("The page's text").fill("my text");
  await page.getByRole("button", { name: "Save the page" }).click();
  await page.getByRole("alert").getByText(/changed elsewhere/).waitFor();
  assert.equal(await page.getByLabel("The page's text").inputValue(), "my text");
  assert.equal(state.files.get("Collectives/Wiki/Readme.md")?.content, "their text", "nothing was written over it");
  await close(page);
});

test("Collectives: a new page with text is made, and its text is written into its file (H3)", async () => {
  const state = collectivesBackend();
  const page = await open("collectives");
  await page.getByRole("button", { name: /Wiki/ }).click();
  await page.getByRole("button", { name: /A new page/ }).click();
  await page.getByLabel("The page's title").fill("Plan");
  await page.getByLabel("The page's text").fill("the plan");
  await page.getByRole("button", { name: "Make the page" }).click();
  await page.getByRole("button", { name: /Plan/ }).waitFor();
  await sleep(150);
  assert.equal(state.files.get("Collectives/Wiki/Plan.md")?.content, "the plan");
  assert.equal(state.writes[0].if_match, "v0");
  await close(page);
});

test("Collectives: where the text of a new page cannot be written, the page opens with the words in it and the reason above (H3, M9)", async () => {
  const state = collectivesBackend();
  const page = await open("collectives");
  await page.getByRole("button", { name: /Wiki/ }).click();
  await page.getByRole("button", { name: /A new page/ }).click();
  await page.getByLabel("The page's title").fill("Plan");
  await page.getByLabel("The page's text").fill("the plan");
  state.failWrite = "The disk is full";
  await page.getByRole("button", { name: "Make the page" }).click();
  await page.getByRole("alert").getByText(/The disk is full/).waitFor();
  assert.equal(await page.getByLabel("The page's text").inputValue(), "the plan", "the words are not lost");
  await close(page);
});

test("Collectives: a page that cannot be opened says why; a changed page asks before it is left; an empty search is the whole list again (M9, L14, L19)", async () => {
  const state = collectivesBackend();
  on("collectives_get_page", () => {
    throw new ToolError("Page is gone");
  });
  const page = await open("collectives");
  await page.getByRole("button", { name: /Wiki/ }).click();
  await page.getByRole("button", { name: /Home/ }).click();
  await page.getByRole("alert").getByText("Page is gone").waitFor();
  assert.equal(await page.getByLabel("Search the pages").count(), 1, "still on the pages");
  await page.getByLabel("Search the pages").fill("home");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await sleep(150);
  assert.equal(calledWith("collectives_search_pages").length, 1);
  const before = calledWith("collectives_get_pages").length;
  await page.getByLabel("Search the pages").fill("");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await sleep(150);
  assert.equal(calledWith("collectives_get_pages").length, before + 1, "the whole list is read again");
  handlers.delete("collectives_get_page");
  on("collectives_get_page", () => ({ page: { title: "Home" }, content: [...state.files.values()][0].content }));
  await page.getByRole("button", { name: /Home/ }).click();
  await page.getByLabel("The page's text").fill("changed");
  await answerConfirms(page, false);
  await page.getByRole("button", { name: /← Pages/ }).click();
  await sleep(100);
  assert.equal(await page.getByLabel("The page's text").count(), 1, "asked, and said no: still there");
  await close(page);
});

test("Collectives: with Files switched off for the instance, a page of an editable collective still opens to its text, and a new page's text is not lost", async () => {
  const state = collectivesBackend();
  // the server half refuses a family that is off, as its /tool route does
  handlers.delete("nc_webdav_read_file");
  on("nc_webdav_read_file", () => {
    throw new Error("Files is switched off for uni");
  });
  const page = await open("collectives");
  await page.getByRole("button", { name: /Wiki/ }).click();
  await page.getByRole("button", { name: /Home/ }).click();
  await page.getByText("old text").waitFor();
  await page.getByText(/This page cannot be edited here: Files is switched off/).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0, "it opened: no failure to say");
  await page.getByRole("button", { name: /← Pages/ }).click();
  await page.getByRole("button", { name: /A new page/ }).click();
  await page.getByLabel("The page's title").fill("Plan");
  await page.getByLabel("The page's text").fill("the plan");
  await page.getByRole("button", { name: "Make the page" }).click();
  await page.getByRole("alert").getByText(/Plan” is made, but its text could not be put in it/).waitFor();
  assert.equal(await page.getByLabel("Your text, not saved").inputValue(), "the plan", "the words stand on the page opened, to be copied");
  assert.equal(state.writes.length, 0);
  await close(page);
});

// ---- News ------------------------------------------------------------------------------------------------------

test("News: an article's HTML shows as text, a link is only a web address, a failed opening is said, and Back reads the feeds' counts again", async () => {
  let unread = 2;
  on("nc_news_list_feeds", () => ({ results: [{ id: 1, title: "Daily", unread_count: unread }] }));
  on("nc_news_list_items", () => ({ results: [{ id: 7, title: "", unread: true, pub_date: 1_700_000_000 }, { id: 8, title: "Bad", unread: true }] }));
  on("nc_news_get_item", ({ item_id }) => {
    if (item_id === 8) throw new ToolError("The item is gone");
    unread = 1;
    return { item: { title: "", body: "<div><p>Hello <em>world</em></p><p>Second</p></div>", url: "javascript:alert(1)" } };
  });
  const page = await open("news");
  await page.getByRole("button", { name: /Daily/ }).click();
  await page.getByRole("button", { name: /Bad/ }).click();
  await page.getByRole("alert").getByText("The item is gone").waitFor();
  await page.getByRole("button", { name: /\(no title\)/ }).click();
  await page.getByText("Hello world").waitFor();
  assert.equal(await page.locator("pre.nc-file-text").innerText(), "Hello world\nSecond");
  assert.equal(await page.getByRole("link", { name: "Open the original" }).count(), 0, "a javascript: address is no link");
  await page.getByRole("button", { name: /← Items/ }).click();
  await page.getByRole("button", { name: /← Feeds/ }).click();
  await page.getByRole("button", { name: /Daily/ }).getByText("1 unread").waitFor();
  await close(page);
});

// ---- Deck ------------------------------------------------------------------------------------------------------

function deckBackend() {
  const boards = [{ id: 1, title: "Alpha" }, { id: 2, title: "Beta" }];
  const cards: Record<number, Record<number, any>> = { 1: { 11: { id: 11, title: "Card 1", done: false } }, 2: { 21: { id: 21, title: "Beta card", done: false } } };
  on("deck_get_boards", () => ({ boards }));
  on("deck_get_stacks", ({ board_id }) => ({ stacks: [{ id: board_id * 10, title: board_id === 1 ? "To do" : "Doing", cards: Object.values(cards[board_id]) }] }));
  on("deck_get_card", ({ board_id, card_id }) => ({ ...cards[board_id][card_id], description: "d" }));
  on("deck_update_card", ({ board_id, card_id, title, done }) => {
    if (title) cards[board_id][card_id].title = title;
    if (done) cards[board_id][card_id].done = true;
    return {};
  });
  return { boards, cards };
}

test("Deck: after a card is saved or marked done the board behind it shows it too (M12)", async () => {
  deckBackend();
  const page = await open("deck");
  await page.getByRole("button", { name: /Card 1/ }).click();
  await page.getByLabel("Card title").fill("Renamed");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Mark done" }).waitFor();
  assert.equal(await page.getByLabel("Card title").inputValue(), "Renamed");
  await page.getByRole("button", { name: "Mark done" }).click();
  await page.getByText("done", { exact: true }).waitFor();
  await page.getByRole("button", { name: /← Back to the board/ }).click();
  await page.locator(".nc-card-done", { hasText: "Renamed" }).waitFor();
  await close(page);
});

test("Deck: a slow board pressed first does not draw its stacks under the board pressed second, and new cards go into the right board (M11)", async () => {
  const data = deckBackend();
  let first = true;
  on("deck_get_stacks", async ({ board_id }) => {
    if (first) {
      first = false;
      await sleep(500);
    }
    return { stacks: [{ id: board_id * 10, title: board_id === 1 ? "To do" : "Doing", cards: Object.values(data.cards[board_id]) }] };
  });
  on("deck_create_card", () => ({}));
  const page = await open("deck");
  await page.getByRole("button", { name: "Beta" }).click();
  await page.getByRole("button", { name: /Beta card/ }).waitFor();
  await sleep(700);
  assert.equal(await page.getByRole("button", { name: /Card 1/ }).count(), 0, "Alpha's late stacks are not drawn");
  await page.getByRole("button", { name: "A new card in this stack" }).click();
  await page.getByLabel("Card title").fill("New");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await sleep(150);
  assert.equal(calledWith("deck_create_card")[0].board_id, 2);
  assert.equal(calledWith("deck_create_card")[0].stack_id, 20);
  await close(page);
});

test("Deck: a card that cannot be opened says why on the board; a stack and a card are deleted only after the portal's dialog says yes (M9, M18)", async () => {
  deckBackend();
  on("deck_get_card", () => {
    throw new ToolError("The card was moved");
  });
  on("deck_delete_stack", () => ({}));
  const page = await open("deck");
  await page.getByRole("button", { name: /Card 1/ }).click();
  await page.getByRole("alert").getByText("The card was moved").waitFor();
  assert.equal(await page.getByRole("button", { name: /Card 1/ }).count(), 1, "the board is still there");
  await answerConfirms(page, false);
  await page.getByRole("button", { name: "Delete this stack" }).click();
  await sleep(100);
  assert.equal(calledWith("deck_delete_stack").length, 0);
  const asked = (await confirms(page)) as any[];
  assert.equal(asked.at(-1).danger, true, "a stack with its cards is a danger");
  await answerConfirms(page, true);
  await page.getByRole("button", { name: "Delete this stack" }).click();
  await sleep(150);
  assert.equal(calledWith("deck_delete_stack").length, 1);
  await close(page);
});

test("Deck: the colours of a new board are named, not hex codes, and say which is chosen", async () => {
  deckBackend();
  const page = await open("deck");
  await page.getByRole("button", { name: /New board/ }).click();
  await page.getByRole("button", { name: "Amber" }).click();
  assert.equal(await page.getByRole("button", { name: "Amber" }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("button", { name: "#0f6bb5" }).count(), 0);
  await close(page);
});

// ---- Notes -----------------------------------------------------------------------------------------------------

function notesBackend() {
  const state = { etag: "n1", content: "body" };
  on("nc_notes_search_notes", () => ({ results: [{ id: 3, title: "Ideas" }, { id: 4, title: "Broken" }] }));
  on("nc_notes_get_note", ({ note_id }) => {
    if (note_id === 4) throw new ToolError("The note file is unreadable");
    return { id: 3, title: "Ideas", content: state.content, etag: state.etag };
  });
  return state;
}

test("Notes: a note changed elsewhere is said to be, with the words kept; saving says Saved; going back asks while there is a change (L14)", async () => {
  const state = notesBackend();
  on("nc_notes_update_note", ({ etag, content }) => {
    if (etag !== state.etag) throw new ToolError("412 Precondition Failed: the note has changed");
    state.content = content;
    state.etag = "n2";
    return {};
  });
  const page = await open("notes");
  await page.getByRole("button", { name: /Ideas/ }).click();
  await page.getByLabel("Note content").fill("my words");
  state.etag = "n9"; // someone else saved it
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("alert").getByText(/changed elsewhere/).waitFor();
  assert.equal(await page.getByLabel("Note content").inputValue(), "my words");
  assert.equal(await page.evaluate(() => (window as any).__unsaved), true);
  await answerConfirms(page, false);
  await page.getByRole("button", { name: /← All notes/ }).click();
  await sleep(100);
  assert.equal(await page.getByLabel("Note content").count(), 1, "asked, and said no: still in the note");
  await close(page);
});

test("Notes: a note that cannot be opened is said, in the list it came from; a delete asks through the portal's dialog", async () => {
  notesBackend();
  on("nc_notes_delete_note", () => ({}));
  const page = await open("notes");
  await page.getByRole("button", { name: /Broken/ }).click();
  await page.getByRole("alert").getByText("The note file is unreadable").waitFor();
  assert.equal(await page.getByRole("button", { name: /Ideas/ }).count(), 1, "the list is there");
  await page.getByRole("button", { name: /Ideas/ }).click();
  await page.getByLabel("Note content").waitFor();
  await answerConfirms(page, false);
  await page.getByRole("button", { name: "Delete this note" }).click();
  await sleep(100);
  assert.equal(calledWith("nc_notes_delete_note").length, 0);
  assert.equal(((await confirms(page)) as any[]).at(-1).deletes, true);
  await answerConfirms(page, true);
  await page.getByRole("button", { name: "Delete this note" }).click();
  await sleep(150);
  assert.equal(calledWith("nc_notes_delete_note").length, 1);
  await close(page);
});

// ---- Cookbook --------------------------------------------------------------------------------------------------

function cookbookBackend() {
  const recipes: any[] = [{ id: 1, name: "Soup", description: "warm", recipeIngredient: ["water"], recipeInstructions: ["boil"] }, { id: 2, name: "Bread", description: "baked", recipeIngredient: ["flour"], recipeInstructions: ["bake"] }];
  on("nc_cookbook_list_recipes", () => ({ recipes: recipes.map(({ id, name }) => ({ id, name })) }));
  on("nc_cookbook_get_recipe", ({ recipe_id }) => recipes.find((r) => r.id === recipe_id));
  on("nc_cookbook_search_recipes", ({ query }) => ({ recipes: recipes.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())).map(({ id, name }) => ({ id, name })) }));
  return recipes;
}

test("Cookbook: of two recipes pressed one after the other the late answer of the first does not show under the second, and Save changes the second (M11)", async () => {
  const recipes = cookbookBackend();
  on("nc_cookbook_get_recipe", async ({ recipe_id }) => {
    if (recipe_id === 1) await sleep(500);
    return recipes.find((r) => r.id === recipe_id);
  });
  on("nc_cookbook_update_recipe", () => ({}));
  const page = await open("cookbook");
  await page.getByRole("button", { name: /Soup/ }).click();
  await page.getByRole("button", { name: "← All recipes" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "← All recipes" }).click();
  await page.getByRole("button", { name: /Bread/ }).click();
  await page.getByRole("heading", { name: "Bread" }).waitFor();
  await sleep(700);
  assert.equal(await page.getByRole("heading", { name: "Bread" }).count(), 1, "still Bread's own text");
  await page.getByRole("button", { name: /Change this recipe/ }).click();
  await page.getByLabel("The recipe's name").fill("Sourdough");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await sleep(150);
  assert.equal(calledWith("nc_cookbook_update_recipe")[0].recipe_id, 2);
  await close(page);
});

test("Cookbook: a failed import is said in the list it came from; emptying the description is sent as an empty description (M9, L20)", async () => {
  cookbookBackend();
  on("nc_cookbook_import_recipe", () => {
    throw new ToolError("No recipe markup found at that address");
  });
  on("nc_cookbook_update_recipe", () => ({}));
  const page = await open("cookbook");
  await page.getByRole("button", { name: /Soup/ }).waitFor();
  await page.getByLabel("Import a recipe from its URL").fill("https://example.org/r");
  await page.getByRole("button", { name: "Import" }).click();
  await page.getByRole("alert").getByText(/No recipe markup/).waitFor();
  await page.getByRole("button", { name: /Soup/ }).click();
  await page.getByRole("button", { name: /Change this recipe/ }).click();
  await page.getByLabel("What it is").fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await sleep(150);
  assert.equal(calledWith("nc_cookbook_update_recipe")[0].description, "");
  await close(page);
});

test("Cookbook: a recipe taken away asks first, and the search that stands is run again so it is not listed any more (L20)", async () => {
  const recipes = cookbookBackend();
  on("nc_cookbook_delete_recipe", ({ recipe_id }) => {
    recipes.splice(recipes.findIndex((r) => r.id === recipe_id), 1);
    return {};
  });
  const page = await open("cookbook");
  await page.getByLabel("Search the recipes").fill("s");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: /Soup/ }).click();
  await answerConfirms(page, false);
  await page.getByRole("button", { name: "Delete this recipe" }).click();
  await sleep(100);
  assert.equal(calledWith("nc_cookbook_delete_recipe").length, 0);
  await answerConfirms(page, true);
  await page.getByRole("button", { name: "Delete this recipe" }).click();
  await page.getByLabel("Search the recipes").waitFor();
  await sleep(150);
  assert.equal(calledWith("nc_cookbook_search_recipes").length, 2, "the search ran again");
  assert.equal(await page.getByRole("button", { name: /Soup/ }).count(), 0);
  await close(page);
});

// ---- Files -----------------------------------------------------------------------------------------------------

function filesBackend() {
  const tree: Record<string, any[]> = {
    "": [{ name: "A", is_directory: true }, { name: "B", is_directory: true }, { name: "big.txt", is_directory: false, size: 20 * 1024 * 1024, content_type: "text/plain" }],
    A: [{ name: "a1.txt", is_directory: false, size: 3, content_type: "text/plain" }],
    B: [{ name: "b1.txt", is_directory: false, size: 3, content_type: "text/plain" }],
  };
  on("nc_webdav_list_directory", ({ path }) => ({ files: tree[path ?? ""] ?? [] }));
  on("nc_share_list", () => ({ shares: [] }));
  return tree;
}

test("Files: of two folders opened one after the other, the late rows of the first do not stand under the path of the second (M11)", async () => {
  const tree = filesBackend();
  on("nc_webdav_list_directory", async ({ path }) => {
    if (path === "A") await sleep(500);
    return { files: tree[path ?? ""] };
  });
  const page = await open("files");
  await page.locator(".nc-file-main", { hasText: "A" }).first().click();
  await page.getByRole("button", { name: "Files" }).first().click(); // back to the root while A is slow
  await page.locator(".nc-file-main", { hasText: "B" }).first().click();
  await page.getByText("b1.txt").waitFor();
  await sleep(700);
  assert.equal(await page.getByText("a1.txt").count(), 0);
  assert.equal(await page.getByText("b1.txt").count(), 1);
  await close(page);
});

test("Files: a file over the inline size is not pulled in, and a file's preview can be downloaded", async () => {
  filesBackend();
  const page = await open("files");
  await page.locator(".nc-file-main", { hasText: "big.txt" }).click();
  await page.getByRole("alert").getByText(/larger than this panel reads inline/).waitFor();
  assert.equal(calledWith("nc_webdav_read_file").length, 0);
  on("nc_webdav_read_file", () => ({ content: "hello", etag: "x" }));
  await page.locator(".nc-file-main", { hasText: "A" }).first().click();
  await page.locator(".nc-file-main", { hasText: "a1.txt" }).click();
  await page.locator("pre.nc-file-text").waitFor();
  assert.equal(await page.getByRole("button", { name: "Download" }).count(), 1);
  await close(page);
});

test("Files: a delete asks through the portal's dialog, and the box does not open again on the path that is gone (L10, M18)", async () => {
  const tree = filesBackend();
  on("nc_webdav_delete_resource", ({ path }) => {
    tree[""] = tree[""].filter((f) => f.name !== path);
    return {};
  });
  const page = await open("files");
  await page.locator(".nc-file").filter({ has: page.locator(".nc-file-name", { hasText: /^B$/ }) }).getByRole("button", { name: "The things this one can be done to" }).click();
  await answerConfirms(page, false);
  await page.getByRole("button", { name: "Take it to the trash" }).click();
  await sleep(100);
  assert.equal(calledWith("nc_webdav_delete_resource").length, 0);
  await answerConfirms(page, true);
  await page.getByRole("button", { name: "Take it to the trash" }).click();
  await sleep(300);
  assert.equal(calledWith("nc_webdav_delete_resource").length, 1);
  assert.equal(await page.getByText("What it can be done to").count(), 0, "no box is left open on the deleted entry");
  assert.equal(await page.locator(".nc-file-name", { hasText: /^B$/ }).count(), 0);
  await close(page);
});

test("Files: a link made is copyable and the entry wears its share mark at once; a restore from the trash that fails says so and one that works shows the file (L10, M9)", async () => {
  filesBackend();
  let shared = false;
  on("nc_share_list", () => ({ shares: shared ? [{ id: 1, share_type: 3, path: "/A", share_with: "", permission: 1 }] : [] }));
  on("nc_share_create_public_link", () => {
    shared = true;
    return { url: "https://cloud.example.org/s/abc" };
  });
  const page = await open("files");
  await page.locator(".nc-file", { hasText: "A" }).first().getByRole("button", { name: "Shares of this one" }).click();
  await page.getByRole("button", { name: "Make the link" }).click();
  await page.getByRole("link", { name: "https://cloud.example.org/s/abc" }).waitFor();
  await page.getByRole("button", { name: "Copy the link" }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).__copied), ["https://cloud.example.org/s/abc"]);
  await page.locator(".nc-row-share.is-shared").first().waitFor();
  on("nc_webdav_list_trash", () => ({ items: [{ id: "t1", name: "old.txt", original_location: "/old.txt", deleted_at: 1_700_000_000 }] }));
  on("nc_webdav_restore_from_trash", () => {
    throw new ToolError("A file of that name is there already");
  });
  await page.getByRole("button", { name: "Trash" }).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("alert").getByText(/already/).waitFor();
  await close(page);
});

test("Files: with Sharing switched off for the instance, the files are listed and no share is read or offered", async () => {
  filesBackend();
  statusBody = { image: "x", instances: [instanceRow({ capabilities: { available: ALL_ON, on: { sharing: false } } })], configured: true };
  const page = await open("panel");
  await page.locator(".nc-file-main", { hasText: "A" }).first().waitFor();
  await sleep(200);
  assert.equal(calledWith("nc_share_list").length, 0, "the server would refuse it");
  assert.equal(await page.getByRole("alert").count(), 0, "no error for a choice the person made");
  assert.equal(await page.getByRole("button", { name: "Shares of this one" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Shared with me" }).count(), 0);
  await close(page);
});

test("Files: with Files switched off and Sharing on, the Files tab is not offered (its shares stand on the files' rows)", async () => {
  filesBackend();
  on("nc_calendar_list_calendars", () => ({ calendars: [] }));
  statusBody = { image: "x", instances: [instanceRow({ capabilities: { available: ALL_ON, on: { files: false } } })], configured: true };
  const page = await open("panel");
  await page.getByRole("tab", { name: "Calendar" }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "Files" }).count(), 0);
  await sleep(200);
  assert.equal(calledWith("nc_webdav_list_directory").length, 0);
  await close(page);
});

// ---- The panel itself --------------------------------------------------------------------------------------------

test("Panel: a status that cannot be read is said, with a way to try again; the panel reads it again when it is looked at again (M10)", async () => {
  statusFails = true;
  const page = await open("panel");
  await page.getByRole("alert").getByText(/the server half is not running/).waitFor();
  statusFails = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByRole("tab", { name: "Files" }).waitFor();
  // a Save in Settings meanwhile: another instance stands, and the panel finds it when it is looked at again
  statusBody = { image: "x", instances: [instanceRow(), instanceRow({ name: "home", url: "https://home.example.org" })], configured: true };
  assert.equal(await page.getByLabel("Which of the Nextclouds the pages talk to").count(), 0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByLabel("Which of the Nextclouds the pages talk to").waitFor();
  await close(page);
});

test("Panel: only the tabs the instance offers are in the tab list, which the keys move along; the way out is not a tab; the muted words are muted (L9, L13, M17)", async () => {
  statusBody = { image: "x", instances: [instanceRow({ capabilities: { available: { ...ALL_ON, mail: false, news: false }, on: {} } })], configured: true };
  const page = await open("panel");
  await page.getByRole("tab", { name: "Files" }).waitFor();
  const names = await page.getByRole("tab").allInnerTexts();
  assert.deepEqual(names.map((n) => n.trim()), ["Files", "Calendar", "Contacts", "Notes", "Deck", "Collectives", "Cookbook", "Shopping List"]);
  assert.equal(await page.getByRole("tablist").getByRole("link").count(), 0, "the link out is not inside the tab list");
  assert.equal(await page.getByRole("tab", { name: "Files" }).getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("tab", { name: "Calendar" }).getAttribute("tabindex"), "-1", "one tab stands in the tab order");
  assert.equal(await page.getByRole("tabpanel").count(), 1);
  const color = await page.getByRole("tab", { name: "Calendar" }).evaluate((el) => getComputedStyle(el).color);
  assert.equal(color, "rgb(185, 185, 195)", "a tab that is not chosen is drawn in the muted colour of the theme");
  await close(page);
});

test("Panel: a tab the instance does not offer is never mounted, not even for one render", async () => {
  statusBody = { image: "x", instances: [instanceRow({ capabilities: { available: { ...ALL_ON, files: false, sharing: false }, on: {} } })], configured: true };
  on("nc_calendar_list_calendars", () => ({ calendars: [] }));
  on("nc_webdav_list_directory", () => ({ files: [] }));
  const page = await open("panel");
  await page.getByRole("tab", { name: "Calendar" }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "Calendar" }).getAttribute("aria-selected"), "true", "the first tab offered is the one shown");
  await sleep(200);
  assert.equal(calledWith("nc_webdav_list_directory").length, 0, "Files, which this instance does not offer, was never asked for anything");
  await close(page);
});

// ---- The page in Settings -----------------------------------------------------------------------------------------

const card = (name: string, over: Record<string, unknown> = {}) => ({ name, url: `https://${name}.example.org`, username: "anna", passwordSet: true, configured: true, ...over });

test("Settings: instances that cannot be read are said, with a way to try again (M10)", async () => {
  instancesFail = true;
  const page = await open("settings");
  await page.getByRole("alert").getByText(/The instances could not be read: the server half is not running/).waitFor();
  instancesFail = false;
  instancesBody = { instances: [] };
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByText("No instance yet").waitFor();
  await close(page);
});

test("Settings: saving one card keeps what was typed in another and in a card not saved yet; typed words are told to the portal (L17, M18)", async () => {
  instancesBody = { instances: [card("uni"), card("home")] };
  statusBody = { image: "x", instances: [instanceRow({ name: "uni" }), instanceRow({ name: "home" })], configured: true };
  const page = await open("settings");
  await page.getByLabel("Nextcloud host").waitFor();
  assert.equal(await page.evaluate(() => (window as any).__unsaved), false);
  // card uni: change the host; then card home: type a new host there too, then save home only
  await page.getByLabel("Nextcloud host").fill("https://uni-new.example.org");
  assert.equal(await page.evaluate(() => (window as any).__unsaved), true, "typed words are a draft for the portal");
  await page.getByLabel("Which instance is picked").selectOption({ label: "home" });
  await page.getByLabel("Nextcloud host").fill("https://home-new.example.org");
  await page.getByRole("button", { name: "Save and apply" }).click();
  await page.getByRole("status").getByText("Saved.").waitFor();
  assert.equal(posts[0].body.url, "https://home-new.example.org");
  await page.getByLabel("Which instance is picked").selectOption({ label: "uni" });
  assert.equal(await page.getByLabel("Nextcloud host").inputValue(), "https://uni-new.example.org", "the unsaved host of the other card is still there");
  assert.equal(await page.evaluate(() => (window as any).__unsaved), true);
  await close(page);
});

test("Settings: what the Nextcloud says of the login is shown beside the server's own answer; plain http is a switch of its own", async () => {
  instancesBody = { instances: [card("uni", { url: "http://nas.lan" })] };
  statusBody = { image: "x", instances: [instanceRow({ name: "uni", account: { state: "unauthorized" } })], configured: true };
  const page = await open("settings");
  await page.getByText("Nextcloud refuses the user name or the app password").waitFor();
  await page.getByText(/answering/).waitFor();
  await page.getByRole("checkbox", { name: /Send the app password over plain http/ }).check();
  await page.getByRole("button", { name: "Save and apply" }).click();
  await page.getByRole("status").getByText("Saved.").waitFor();
  assert.equal(posts[0].body.allowHttp, true);
  await close(page);
});

test("Settings: removing an instance asks through the portal's dialog first", async () => {
  instancesBody = { instances: [card("uni")] };
  statusBody = { image: "x", instances: [instanceRow({ name: "uni" })], configured: true };
  const page = await open("settings");
  await page.getByRole("button", { name: "Remove", exact: true }).waitFor();
  await answerConfirms(page, false);
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await sleep(100);
  assert.equal(posts.filter((p) => p.route === "/instances/remove").length, 0);
  await answerConfirms(page, true);
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await sleep(150);
  assert.equal(posts.filter((p) => p.route === "/instances/remove").length, 1);
  await close(page);
});
