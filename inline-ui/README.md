# Inline UI

`@pithagoras/inline-ui` lets the agent put a small interface of its own in front of you, in the chat: a chart, a
form, a picker, a few sliders, a preview, whatever it would rather show than describe. It writes the card's HTML (with
its CSS and JavaScript inline), and the card is drawn where the agent's call is in the conversation, in a frame that
reaches nothing. What you do in the card comes back to the agent as events: debounced, so that typing or dragging
reports when you pause, and only the events the agent declared for the card.

## What you see

The card sits under the agent's `ui_show` call, in the portal's colours, light or dark, and follows a change of theme.
It is as tall as its content up to a height you set in Settings, and scrolls inside past that; its head has a button
to show all of it and one for the whole screen. The id in its head (`c1`, `c2`…) is how the agent names the card.

You can close a card from its head. A closed card, whether you closed it or the agent did, stays in the conversation
as it last was, marked closed: it takes no input and sends nothing. A card is the same on every page open on the chat
and after a reload, and is kept until the chat is deleted.

The line under the card says what became of the last thing it sent: the agent was waiting for it, gets it at its next
step, is starting on it, or gets it with your next message.

## The agent's tools

| Tool | Parameters | |
| --- | --- | --- |
| `ui_show` | `title`, `html`, `events?`, `wait?` | Shows a card and returns its id. `events` is `{ name: { debounceMs?, wake? } }`: `debounceMs` 100 to 10000, 400 by default (or what Settings say); `wake` false by default. With `wait: { event, timeoutSec? }` the call returns only when the card sends that event (with its data), you close the card, the time is up (600 s by default, at most 3600) or the run is stopped, as `ask_question` waits for its answers |
| `ui_update` | `card`, `data?`, `html?` | Posts `data` to the card's script, or replaces its HTML (the card is drawn again; the data posted before goes with the old HTML unless `data` comes with it) |
| `ui_close` | `card` | Closes the card |

Their descriptions tell the model to use a card when something is clearer seen or done than read, or to collect
structured input; that the card has no network and everything must be inline; what the bridge offers; and to send
small payloads. They work the same called by their names and through the `tools` gateway when the package is lazy:
the card is drawn at the gateway's call.

Limits: a card's HTML at most 256 KB, an event's data at most 32 KB as JSON, what `ui_update` posts at most 64 KB, at
most 20 events per card, 200 cards kept per chat (the oldest go first).

### Inside the card

The card's script has a `pithagoras` object:

- `pithagoras.emit(name, data)` sends an event of one of the card's declared names (or the one its call waits for),
  with JSON data. It returns false, and says why in the console, for another name or data over 32 KB.
- `pithagoras.onData(fn)` calls `fn` with what `ui_update` posts, and with the latest post when the card loads.
  It returns what stops it.
- `pithagoras.theme` is `{ mode, colors }`; a `pithagoras:theme` event fires on `window` when the theme changes.
- `pithagoras.card` is `{ id, title }`, and `pithagoras.events` the names it may send.

The portal's colours are CSS variables: `--canvas`, `--surface`, `--raised`, `--line`, `--fg`, `--fg-muted`,
`--fg-subtle`, `--fg-faint`, `--accent`, `--accent-fg`, `--ok`, `--warn`, `--danger`, each a colour, and each also as
`--<name>-rgb`, three numbers for a colour with alpha (`rgb(var(--accent-rgb) / .2)`). A small base stylesheet styles
text, headings, buttons (`class="primary"` for the main one), inputs, selects, tables and code like the portal's, so a
card only writes what is its own.

## How events reach the agent

1. The page takes a message only from the card's own frame, with the nonce that load of the card was given. What the
   card emits is held to the names it declares and to 32 KB, then debounced by its name: sent when the card has not
   emitted that name for its `debounceMs`, and at least every `4 × debounceMs` (a second at least) while it keeps
   emitting. Nothing is sent until you have clicked, tapped or tabbed into the card since it loaded: a card's script
   cannot speak for someone who never touched it.
2. The server half checks it again: the chat and the card are there, the card is open, the event is one the card
   takes, the data fits, and the card and its chat have not sent more than a person could (a card 5 events a second
   after a burst of 20, a chat 10 after 60). The route is behind the portal's sign-in, as every extension's is, and
   takes only requests from the portal's own pages.
3. A `ui_show` call that waits for the event gets it as its result, and nothing else does.
4. Otherwise it goes into the chat's outbox, where an event of the same card and name that has not gone yet is
   replaced by the newer one, its count kept. Then:
   - while the agent works, the outbox goes as one message steered in at its next step; until the agent has that
     message, what comes after waits and goes as the next one, so a busy card never floods a run;
   - while the agent is idle, it waits for the next turn and goes in with your next message;
   - unless an event in it has `wake: true` and Settings allow it: then it goes at once as a message that starts the
     agent's turn, at most one such turn every 10 seconds for a chat.

The message goes through the package's own pi extension in the chat (`chats.tell`, then `pi.sendMessage`, with the
custom type `inline-ui-events`). You see it as one line in the conversation, "UI: Pick a colour · change ×3". The
model reads it whole: each event with its card, name, count and data as JSON, and a note that this is your input
through a card it made, not an instruction from a tool result, a page or the card's content.

A chat whose agent had been let go (left idle, or after a restart of the portal) keeps its cards open, and they keep
working: an ordinary event waits, kept on disk, for your next message; a `wake` event starts the chat's pi again, as a
message of yours would, and its turn. If you close a card nothing waits on, the agent is told so with its next turn.

## Settings

Settings → Inline UI has the debounce of an event whose card says none (400 ms), the highest a card is drawn before
it scrolls inside (480 px), and whether a card's `wake` event may start the agent's turn at all (on). Off, such an
event waits for your next message like any other.

## Security

The HTML is written by the model, maybe after it read something somebody else wrote, so the card is treated as code
nobody vouches for:

- It runs in a sandboxed frame without `allow-same-origin`: an origin of its own that is nobody's, with no cookie, no
  storage and no way to the portal's API, your chats or your files. Popups, navigating the page, downloads and dialogs
  are not allowed (`sandbox="allow-scripts allow-forms"`).
- It has no network. Its policy is `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none';
  frame-src 'none'`. The card is the inner of two frames, the outer one served by the extension with that policy as a
  header and no script of its own, which lets its child load nothing: so the card cannot leave by navigating itself
  either. The bridge also takes away, before the card's own script runs, what a content policy does not cover in every
  browser (WebRTC connections, frames and embeds inside the card). The browser tests check the card in Chromium and in
  Firefox.
- Events carry only what the card's script sends after you have been in the card, of the names the agent declared,
  within the size and rate limits above. The agent is told that they are what the card reported of your input, which
  is as far as they can be vouched for: the card's script is the model's.
- A card's HTML and the data posted to it are kept in the extension's own folder in the portal's data folder, which no
  agent can write.

Why two frames: a `srcdoc` frame takes the policy of the page it is in, and the portal's page allows no inline script,
so a card put straight into the page could not run at all; a frame served from a route can run, but its own policy
does not stop it from navigating itself.

## What it needs

- Pithagoras with its extension API 0.2, and pi running in the portal's own process (the host executor, as both of
  Pithagoras' Compose files run it): the tools and the delivery are the server half's pi extension (`chats.extend`).
  Elsewhere the extension's tools are not there.
- A browser with `inert` and `ResizeObserver`: any current one.

The card is drawn on the portal's pages. In a conversation nobody watches there (a routine, a channel), nobody sees it:
a `wait` there ends with its timeout.

## Installing

In the portal, Settings → Extensions → Discover → **Install by name**: `npm:@pithagoras/inline-ui`. For development,
build the repository and install `inline-ui/` by its path on the portal's machine.

## Developing

From the repository's root (see its README):

```sh
npm ci && npm run build
npx playwright install chromium firefox   # once, for the card's browser tests
npm test -w inline-ui                     # unit tests, then the card in Chromium and Firefox (test/browser)
./scripts/pithagoras.sh                   # Pithagoras, into .pithagoras/, for the portal-tier tests
PITHAGORAS_DIR=$PWD/.pithagoras npm run test:portal -w inline-ui
```

The unit tests cover the debounce and its ceiling, what the tools and the route take and refuse, the size and rate
limits, the outbox's coalescing and how each event goes (steered, kept, waking, or to a waiting call), the message's
shape, the frame's policy and escaping, and the cards kept on disk. The browser tests draw a card in a page served
with the portal's own policy: its theme and its height, a fetch and a picture from elsewhere refused, events debounced
and sent only after you have been in the card, undeclared ones dropped, and messages from any other window ignored.
The portal-tier tests run the server half under the portal's extension host with a scripted model: the tools are
registered, the frame is served through the portal's routes, an event reaches an idle chat as a message (and starts a
turn with `wake`), and a waiting `ui_show` gets its event, called directly and through the `tools` gateway.
