import { EVENT_DATA_MAX, HTML_MAX, Refusal, TITLE_MAX, UPDATE_DATA_MAX, WAIT_DEFAULT_SEC, WAIT_MAX_SEC, readEvents, readWait, utf8Length, type EventSpecs } from "../limits";
import { jsonText } from "./delivery";
import { summary, type CardRecord, type CardStore } from "./store";
import type { Outcome, Waits } from "./waits";

/**
 * The agent's three tools, registered in every chat's pi by the server half (`chats.extend`), so that they hold what
 * the routes hold: `ui_show` makes a card (and may wait for one of its events), `ui_update` replaces its HTML or posts
 * data to its script, `ui_close` closes it. Each is the same called by its name or through the `tools` gateway, where
 * the package is lazy: the gateway hands the call's id and signal on, and that id is the one the conversation draws
 * the card at.
 */

export interface ToolDeps {
  store: CardStore;
  waits: Waits;
  /** To the pages open on the chat. */
  push(chatId: string, data: unknown): void;
}

const text = (t: string) => ({ type: "text" as const, text: t });

export const SHOW_DESCRIPTION = [
  "Show the person an interactive card in the chat: HTML you write, with inline CSS and JS, drawn in a sandboxed frame where your call is.",
  "Use it when something is clearer seen or done than read (a chart, a diagram, a preview, a comparison, a small tool) or to collect structured input (a form, a picker, sliders, a choice among visual options). Not for a plain answer, and not for something the person did not ask to see.",
  `The card has no network at all: no fetch, no remote image, font, stylesheet or script, no links out, no nested frames. Inline everything (images as data: URLs or inline SVG). Keep the HTML small (at most ${HTML_MAX / 1024} KB).`,
  `In the card's script: pithagoras.emit(name, data) sends an event, only of a name declared in \`events\` (or \`wait.event\`), with JSON data of at most ${EVENT_DATA_MAX / 1024} KB: send what was chosen or changed, not the whole state. pithagoras.onData(fn) receives what ui_update posts (and the latest post when the card loads). pithagoras.theme is { mode, colors }, and a "pithagoras:theme" event fires on window when it changes.`,
  "Theme colours are CSS variables that follow the portal's light and dark: var(--fg), var(--fg-muted), var(--fg-subtle), var(--canvas), var(--surface), var(--raised), var(--line), var(--accent), var(--accent-fg), var(--ok), var(--warn), var(--danger); each also as --<name>-rgb (\"r g b\", for rgb(var(--accent-rgb) / .2)). A base stylesheet already styles text, headings, buttons (class \"primary\" for the main one), inputs, selects, tables and code like the portal: write only what is particular to the card.",
  "Each event is sent after the person pauses (debounceMs, default 400) and comes to you as a message from the person: at your next step while you are working, otherwise with their next message, or at once, starting your turn, for an event with wake: true (only for a deliberate action such as a Submit or Done button, never for typing or dragging).",
  `With \`wait\`, this call returns only when the card sends that event (with its data), the person closes the card, or timeoutSec passes (default ${WAIT_DEFAULT_SEC}, at most ${WAIT_MAX_SEC}): use it to ask and wait for the answer, as ask_question does, with any UI.`,
  "Returns the card's id, for ui_update and ui_close.",
].join("\n");

export const UPDATE_DESCRIPTION = [
  "Change a card shown with ui_show: post data to its script, or replace its HTML.",
  `data: delivered to the card's pithagoras.onData listeners, the way to update a card live (progress, new results, a reply to what the person did); JSON, at most ${UPDATE_DATA_MAX / 1024} KB.`,
  "html: the card is drawn again from it, and what the person had typed in it and not sent is lost; the data posted before goes with the old HTML unless you give data too.",
].join("\n");

export const CLOSE_DESCRIPTION = "Close a card shown with ui_show once it is no longer needed: it stays in the chat, marked closed, and sends no more events.";

const SHOW_PARAMETERS = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short heading for the card, shown above it" },
    html: { type: "string", description: "The card: a whole HTML document or a part of one, its CSS in <style> and its JS in <script>, everything inline" },
    events: {
      type: "object",
      description: 'The events the card\'s script may send, by name: {"change": {"debounceMs": 600}, "submit": {"wake": true}}. Leave out for a card that only shows',
      additionalProperties: {
        type: "object",
        properties: {
          debounceMs: { type: "number", description: "How long to wait after the last emit before sending: 100 to 10000, default 400" },
          wake: { type: "boolean", description: "Start your turn when it comes while you are idle. Default false" },
        },
      },
    },
    wait: {
      type: "object",
      description: "Return only once the card sends this event, with its data",
      properties: {
        event: { type: "string", description: "The event's name, as the card emits it" },
        timeoutSec: { type: "number", description: `How long to wait: ${WAIT_DEFAULT_SEC} by default, at most ${WAIT_MAX_SEC}` },
      },
      required: ["event"],
    },
  },
  required: ["title", "html"],
};

const UPDATE_PARAMETERS = {
  type: "object",
  properties: {
    card: { type: "string", description: "The card's id, as ui_show returned it (c1, c2…)" },
    data: { description: "JSON for the card's pithagoras.onData listeners" },
    html: { type: "string", description: "New HTML for the whole card, in place of what it had" },
  },
  required: ["card"],
};

const CLOSE_PARAMETERS = {
  type: "object",
  properties: { card: { type: "string", description: "The card's id, as ui_show returned it" } },
  required: ["card"],
};

function readTitle(raw: unknown): string {
  const title = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) : "";
  if (!title) throw new Refusal('Give the card a short "title".');
  return title;
}

function readHtml(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Refusal('Give the card its "html".');
  if (utf8Length(raw) > HTML_MAX) throw new Refusal(`The card's HTML is over ${HTML_MAX / 1024} KB: make it smaller (draw with code rather than markup, leave out big data: URLs).`);
  return raw;
}

const names = (events: EventSpecs) => Object.keys(events);

function shown(card: CardRecord): string {
  const declared = names(card.events);
  const waking = declared.filter((n) => card.events[n].wake);
  const events = declared.length
    ? ` Its events (${declared.join(", ")}) come to you as messages from the person: at your next step while you are working, otherwise with their next message${waking.length ? `, or at once for ${waking.join(", ")}` : ""}.`
    : " It declares no events: it only shows.";
  return `Card ${card.id} ("${card.title}") is open in the chat.${events} Change it with ui_update, close it with ui_close.`;
}

function waited(card: CardRecord, event: string, outcome: Outcome, timeoutSec: number): string {
  const later = `If the person sends "${event}" later, it comes to you as a message.`;
  switch (outcome.kind) {
    case "event":
      return `The person sent "${event}" from card ${card.id} ("${card.title}"). Its data, as the card's script reported it (JSON):\n${jsonText(outcome.data)}`;
    case "timeout":
      return `Nothing came from card ${card.id} within ${timeoutSec} s. The card is still open. ${later} Close it with ui_close if you no longer need it.`;
    case "closed":
      return outcome.by === "person" ? `The person closed card ${card.id} without sending "${event}".` : `Card ${card.id} was closed with ui_close before "${event}" came.`;
    case "stopped":
      return `The run was stopped before the person sent "${event}". The card is still open. ${later} Do not decide it yourself meanwhile.`;
    case "ended":
      return `The on-demand UI extension was stopped or updated while this call waited. The card is kept; ${later}`;
  }
}

function cardOf(deps: ToolDeps, chatId: string, raw: unknown): CardRecord {
  const id = typeof raw === "string" ? raw.trim() : "";
  const card = id ? deps.store.card(chatId, id) : undefined;
  if (!card) throw new Refusal(`There is no card ${id ? `"${id}"` : "of that id"} in this chat. ui_show returns a card's id (c1, c2…).`);
  return card;
}

export function registerTools(pi: any, chat: { id: string }, deps: ToolDeps): void {
  const chatId = chat.id;
  const pushCard = (card: CardRecord) => deps.push(chatId, { type: "card", card: summary(card) });

  pi.registerTool({
    name: "ui_show",
    label: "Show a card",
    description: SHOW_DESCRIPTION,
    promptSnippet: "show the person an interactive HTML card (a chart, a form, a picker) and get back what they do in it",
    parameters: SHOW_PARAMETERS,
    async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (partial: unknown) => void) {
      const title = readTitle(params?.title);
      const html = readHtml(params?.html);
      const events = readEvents(params?.events);
      const wait = readWait(params?.wait);
      const card = deps.store.create(chatId, { callId: String(toolCallId), title, html, events, ...(wait ? { wait } : {}) });
      pushCard(card);
      const details = { card: card.id, title };
      if (!wait) return { content: [text(shown(card))], details };
      // The card is open and waits: the call's card in the conversation has its id while the call still runs.
      onUpdate?.({ content: [text(`Card ${card.id} is open and waits for "${wait.event}".`)], details });
      const outcome = await deps.waits.wait(chatId, card.id, wait.event, wait.timeoutSec * 1000, signal);
      return {
        content: [text(waited(card, wait.event, outcome, wait.timeoutSec))],
        details: { ...details, outcome: outcome.kind, event: wait.event, ...(outcome.kind === "event" ? { data: outcome.data } : {}) },
      };
    },
  });

  pi.registerTool({
    name: "ui_update",
    label: "Update a card",
    description: UPDATE_DESCRIPTION,
    promptSnippet: "post data to a card shown with ui_show, or replace its HTML",
    parameters: UPDATE_PARAMETERS,
    async execute(_id: string, params: any) {
      const card = cardOf(deps, chatId, params?.card);
      if (card.status === "closed") throw new Refusal(`Card ${card.id} is closed${card.closedBy === "person" ? " (the person closed it)" : ""}: show a new one with ui_show.`);
      const html = params?.html === undefined ? undefined : readHtml(params.html);
      const hasData = params && Object.hasOwn(params, "data");
      if (html === undefined && !hasData) throw new Refusal('Give "data" to post to the card, or "html" to replace it.');
      let data: { value: unknown } | undefined;
      if (hasData) {
        const json = JSON.stringify(params.data ?? null);
        if (utf8Length(json) > UPDATE_DATA_MAX) throw new Refusal(`The data is over ${UPDATE_DATA_MAX / 1024} KB as JSON: post less.`);
        data = { value: JSON.parse(json) };
      }
      const updated = deps.store.update(chatId, card.id, { ...(html !== undefined ? { html } : {}), ...(data ? { data } : {}) });
      pushCard(updated);
      if (data) deps.push(chatId, { type: "data", card: updated.id, seq: updated.dataSeq, value: data.value });
      const did = [html !== undefined ? "its HTML replaced" : "", data ? "data posted to its script" : ""].filter(Boolean).join(" and ");
      return { content: [text(`Card ${updated.id}: ${did}.`)], details: { card: updated.id, html: html !== undefined, data: !!data } };
    },
  });

  pi.registerTool({
    name: "ui_close",
    label: "Close a card",
    description: CLOSE_DESCRIPTION,
    promptSnippet: "close a card shown with ui_show",
    parameters: CLOSE_PARAMETERS,
    async execute(_id: string, params: any) {
      const card = cardOf(deps, chatId, params?.card);
      if (card.status === "closed") return { content: [text(`Card ${card.id} was closed already${card.closedBy === "person" ? ", by the person" : ""}.`)], details: { card: card.id } };
      const closed = deps.store.close(chatId, card.id, "agent")!;
      pushCard(closed);
      deps.waits.close(chatId, card.id, "agent");
      return { content: [text(`Card ${card.id} is closed.`)], details: { card: card.id } };
    },
  });
}

