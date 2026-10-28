# Office for Pithagoras

`@pithagoras/office` lets you and the agent work on the same Word (`.docx`) and Excel (`.xlsx`) documents. You edit
them in the real [OnlyOffice Document Server](https://github.com/ONLYOFFICE/Docker-DocumentServer) editor, embedded in
the portal, which the extension runs in a container through Docker for extensions; the agent reads and edits the same
documents through tools of its own, in an editor of its own beside you, so you see its changes as it makes them. An
Office tab holds the library.

This extension is not made or endorsed by Ascensio System SIA. "ONLYOFFICE" names what it runs.

## What it needs

- Pithagoras 0.3.0 or later. For agents to answer comments and the editor's chat, a portal whose extension API has
  `chats.start`, `chats.lastAnswer`, `chats.owner` and `http.person`
  ([thecodacus/pithagoras#339](https://github.com/thecodacus/pithagoras/pull/339)); on an older one the rest of Office
  works, and the Office page, the editor's bar and the agents' office tools say that agents do not answer there. Such
  a portal cannot say whose a chat is, so there a chat's panel lists documents, and its agent has office tools, only
  where the chat works in an agent's home or a project's folder itself, not in a folder inside one.
- [Docker for extensions](https://thecodacus.github.io/pithagoras/guide/docker) (`pithagoras-docker` 1.3.0 or later).
  It ships with the portal but is not on by default; installing this extension from npm brings it along.
- A Linux host with Docker Engine 28.0 or later that the portal can reach (its socket): the portal on the machine
  itself, or in Docker (both of Pithagoras' Compose files). On macOS or Windows the portal has to run in Docker.
- Recommended: 1 GB of RAM.
  About 700 MiB were measured while one document is edited. The settings page shows the memory all of Office uses
  while it runs: the Document Server's and, while it runs, the agents' browser's. That browser starts on demand, stops
  10 minutes after its last editor closed, and is capped at 3 GB. The figure is what `docker stats` shows: the
  containers' memory less the file cache the kernel can drop again.
- Disk for the images (`onlyoffice/documentserver`, several GB, Node's `node:22.23.4-alpine3.23`, about 50 MB, for the
  relay below, and for the agents' editor `chromedp/headless-shell:157.0.8103.15`, Chromium's headless shell, about
  540 MB), which the portal pulls on the first start, all at once, with the progress of each shown in Settings.
- Behind a reverse proxy (one that ends TLS, say), a browser that says which page a request comes from, as every
  current one does (`Sec-Fetch-Site`), or a proxy that passes `X-Forwarded-Host` and `X-Forwarded-Proto` (or keeps
  `Host`): the Document Server names the addresses it hands the editor (the opened document among them) by the
  address the browser used, and an `http://` address on an `https://` page is refused by the browser, which shows as
  "Download failed".

## Installing

In Settings → Extensions → Discover → Install by name: `npm:@pithagoras/office`. Then open Settings → Office and press
**Start container** (that switches Office on too). The image is pulled on the first start (`onlyoffice/documentserver:10.0.0.1` by default, the full
tag of the build this version was tested with, never `:latest` or a shorter tag like `10.0`, which move to each new
build: a new build can change the editor's callback and token behaviour, so it is yours to change on purpose, in the
same page). A new Document Server container answers within seconds but then makes its fonts for about two
minutes and restarts its own services; until it is done, Settings says it is starting and the editor waits for it,
as an editor opened before would lose what is typed in it. The same start downloads the agents' editor beside the
Document Server. Settings → Office shows Office as one thing: stopped, downloading (the progress of every download
under way), starting, running, or failed, with the error naming the part that failed (the Document Server or the
agents' editor). Until the agents' editor is there the agents read the saved files and cannot edit; an install that
had the Document Server before gets it with the next **Start container**, and the page says it is missing until then.
It is pinned by its digest: a tag that came to name another build is refused, not run, and said as the error.

## What you get

- **The library**, on the portal's Office tab: create blank Word documents and spreadsheets, open one full screen in
  the embedded editor, sort the list by name, modified, size or type, and download a copy. Every document lives in an
  agent's home or a project's folder and belongs to that agent or project; there are no documents of nobody's. Every
  `.docx` and `.xlsx` in the agents' homes and the projects' folders (not the folders other chats work in, nor the rest
  of the workspace) is indexed when the extension starts, and again with **Rescan**, **in place**: the file is the
  document, and editing it edits that file. **New document** on the Office tab makes it in the home of the agent New
  starts your chats with (the first agent's, unless you picked another on its Agent page); the one in a chat's panel,
  and the agent's `office_create`, make it in that chat's agent home or project folder, as the portal says whose the
  chat is. One whose file is
  gone (a git checkout of another branch, say) stays listed for a week, marked, with its owner and grants, and is the
  same document again when the file comes back. Deleting one moves its real file into the library's trash
  (`.trash/<time>-<id>/` in the data folder), with `document.json`, which says where it was, and what was kept for
  it; the entry is kept for 7 days and then removed. There is no button to restore it, but the file can be moved back
  by hand.
- **A panel beside each chat** with the documents that chat's agent or project sees (below). A document opened there
  opens in the editor right in the panel, beside the conversation, so you watch the agent's edits while you talk to
  it: **← All documents** goes back to the list, and a small button opens it in the Office tab instead. The panel can
  be docked left, right or at the bottom and dragged as narrow or wide as you like; the editor fills it. A card in the
  chat for each call of the agent's tools that names its document opens that document in the same panel (a call that
  lists the documents opens the list). The same document open in the panel and in the Office tab (or in two browser
  tabs) is one editing session seen twice.
- **The agent's tools**, in the chats of agents and projects (a chat in a folder inside a project is the project's,
  as the portal says whose a chat is; the panel beside it lists by the same rule): `office_list`, `office_create`, `office_read`,
  `office_edit` and `office_comments`. An agent sees the documents in its own folder (its home, or its project's) and
  the ones it was granted by a mention; another agent's, and the files in another agent's or project's folder, are not
  there for it, and asking for one gets the same answer as for a document that does not exist. What an agent makes
  goes into its folder and belongs to it, not to one of its chats. A file in its folder is read
  through the portal as the agent itself would read it: with the sandbox on, one the agent could not read is refused,
  and a link is not followed. A document in another agent's home or project folder that you opened to it by a mention
  is read with the portal's rights (your mention says it may), and changed only where the agent could write that
  folder itself: with the sandbox on, it reads and answers in comments.
- **The agent edits beside you, live**: each agent (each agent's or project's folder) that works in a document has an
  OnlyOffice editor of its own open in it, in a browser of Office's own (the agents' editor), in the same editing
  session as the people in the document. People see it there as "<folder name> (agent)", with its
  cursor. `office_read` gives the document as it stands in that editor, with what people typed and have not saved
  yet; `office_edit` makes its edits there, so they show in your editor at once, and nothing you typed is lost or
  written over. An edit is made whole or not at all: every quote, sheet name and position is checked against the
  document as it stands first, and an edit that fails after it changed something is taken back. Where even that
  fails (a person changed the same sheets meanwhile), the agent hears so (`error:partial`) and reads the document
  again. After an edit the Document Server is asked to save the session, and the agent hears the new revision; that
  save holds what you typed until then too.
  Word: replace quoted text, add paragraphs (with a heading style) or a table after a paragraph, remove a paragraph
  (a document keeps one: its only paragraph removed leaves it empty).
  Excel: write values and formulas into a range of any sheet (the editor computes the formulas; `=Data!A1` and
  `='My data'!A1` reach other sheets), and make, rename, move, copy, hide, show and delete sheets, up to 20 of these
  in one call (Excel's rules for names: at most 31 characters, none of `[]:*?/\`, no two alike in any case; one sheet
  always stays visible). A hidden sheet is moved by showing it, moving it and hiding it again. Deleting a sheet turns
  the formulas that name it into `#REF!`, as in Excel. `office_read` lists every sheet with its position and whether
  it is hidden, and reads one sheet or all of them. A change to the sheets shows in your editor once the Document
  Server has let it through, a moment after the call makes it. A sheet the edit deletes is hidden and renamed
  `~deleted …` at once, and goes when the edit's other ops are made. The agent cannot write comments or tracked
  changes (it reads comments with `office_comments`). Calls on one document run one at a time.
  A document nobody has open is opened by the agent's editor alone, and saved when it closes. While an agent's editor
  is in a document its session stays open after the people left it, so it is saved as the last person leaves: what
  they typed is in the file then, not only once the agent's editor closes. The agent's editor of a
  document closes after five minutes without a call; at most three are open at once (the least recently used one
  closes for a fourth); the browser stops ten minutes after its last editor closed, and starts again with the next
  call (a few seconds). Where you stopped Office, `office_read` reads the saved file and says so, and `office_edit` is
  refused until it runs again: there is no other way to write.
  A save that would overwrite a newer revision (the file changed on disk while it was open: a script, a git pull) is
  not lost and does not overwrite it: it is kept beside the document as "<title> (conflict <date time>)", and the audit
  log says so; the agent is told, and its editor of that document closes. A save the Document Server could not hand
  over while the portal was away (it keeps such a save as "forgotten") is taken back once the portal runs again. An
  open editor says within a second or two when the file changed on disk; its button loads the new revision in place.
- **Talk to agents in comments**: type `@` in a comment (the comment box that opens on the text, or a cell's) and pick
  an agent or a project from the list; it inserts `+Aegis` or `+project:Report` (OnlyOffice puts a `+` before what it
  inserts), and typing `@Aegis` or `@project:Report` by hand does the same (in the Comments panel on the left, which has
  no list, too; a name with spaces is matched as a whole, `@My Agent`). Each comment that mentions an agent or project
  starts a chat of its own with it, in that agent's home or project's folder, which shows nowhere in the chat lists and
  needs no chat of yours with that agent, given only that comment: the document's id,
  the thread, and what you wrote. A reply or an edit that mentions an agent on a comment you did not make here (the
  file's own, another tool's) gives it your reply or what you added, never the comment's text as yours. The agent reads the comment's text and the document with its tools, does what you
  asked (`office_edit` changes the document), and its answer appears as its reply in the comment's thread. A reply you
  write in the thread goes to the same chat (only to the ones it mentions, where a thread has several); a reply or an
  edit that mentions another agent adds that one (an edit counts only the mentions it adds). Resolving and reopening keep the chat; deleting the comment removes
  it, two minutes later by default (an undo in that time keeps it; an answer that comes meanwhile is posted only after
  an undo, since a reply would bring the comment back). The agent gets access to the document with the
  mention. Word and spreadsheets alike.
  An agent that may only read the document (a file in a folder it cannot write) still answers in the thread, through an
  editor that may only comment.
  When the agent's edit replaces a larger text that a comment is on, the comment is made again on the new text, with
  its author, time and replies, and its thread and chat go on there.
- **Talk to the document's agent in the editor's chat**: what you write in the editor's own chat (the speech bubble on
  the left) goes to the agent or project the document belongs to (in whose folder it is), in one chat for the editing
  session; its answers come in the editor's chat as the agent's. Messages written while it is still answering reach it
  together as its next message. The chat goes a minute after the last person left the document (a reload in that time
  keeps it), and when the Document Server starts again. An answer that fails, or a run cut off by a restart of the
  portal, says so in the chat, as a comment's does in its thread. An answer that came while Office itself restarted is
  posted once it is back.
- **Nobody is asked from these chats**: the portal holds them as chats nobody attends. They have no question tool, a
  confirmation an extension's tool asks for is answered at once with no, and a call the guard would ask you about is
  refused; the agent hears each refusal and goes on. The editor's bar shows how the agents stand in the document:
  answering, waiting for their turn, or why one could not answer.
- **What counts as your words**: only what you did through the editor's own comment box, reply box and chat, on your
  page. A comment pasted in, brought back by undo, made by someone else, or already in the file starts nothing.
- **Limits, on the Office page in Settings**: comment chats running at once per agent or project (2; more wait their
  turn), comment chats per document (50; a comment refused for it gets its chat when a reply names the agent again
  once there is room), the longest answer in a comment (4,000 characters), messages per answer in the editor's chat
  (4 of 2,048 characters), the seconds before a deleted comment's chat goes (120), the seconds the editor's chat stays
  after the last person left (60), the messages kept for one chat while it answers (20; the oldest go, and it is told
  how many), the longest comment or chat message taken (20,000 characters), the reports of one editing session in
  10 seconds (50; a document takes four times that from all its sessions), and the seconds between saves after
  answers (3). Fixed, as the protocol of the reports and not a limit on your use: 64 events and 256 KB per report
  (the page splits its reports below that, and a long thread's report keeps its latest replies), and the 50 messages
  (20,000 characters) of a session a chat made anew is given again.

## Security

- **A network of its own.** The Document Server is on `pithagoras-office-ds-net`, which Docker for extensions makes
  internal and with no gateway (gateway mode `isolated`): it reaches neither the machine, its loopback, the local
  network nor the internet, and nothing outside the machine reaches it. A converter that a hostile `.docx` breaks into
  finds nothing there but the relay below. Its plugin manager is off (`PLUGINS_ENABLED=false`): it would try the
  internet at every start.
- **One relay is its only way in and back.** Docker for extensions gives a way onto such a network but none back,
  and the Document Server has to fetch each document and report each save. So Office runs one small container of its
  own on that network, `pithagoras-office-ds-relay`, on Node's alpine image, unprivileged, with none of the kernel's
  capabilities, a read-only root and 128 MB, as Docker for extensions runs its forwarder. Its port 3890 leads to the
  Document Server's port 80 (the way in). The way back runs over the way in, opened from the portal's side: the
  extension keeps a few connections to that port open, each opened with a key of the extension's (`relay-secret`),
  which the Document Server is not given; the relay hands each connection the Document Server makes to its port 3891
  to one of them, and the extension passes it on to its listener on 127.0.0.1. Nothing of Office's shares the portal's
  network or is on any network but its own (the relay is on the agents' editor's too, below). The portal reaches the relay as it reaches Blender and Godot: for a
  portal on the host's network, through the forwarder `pithagoras-office-ds-relay-forward`, which publishes port 3890
  on 127.0.0.1; for a portal in a container of its own, by putting that container on the network. Port 80 is never
  published on the machine. A restart of the portal, or of its container, breaks nothing: the portal opens its
  connections to the relay anew.
- **Two routes are open to the Document Server, on a listener of their own.** The container has no portal session,
  so the two things it needs are served by a small listener bound to `127.0.0.1`, which the way back leads to and
  nothing else: a document fetch with a signed ticket for one document at one revision that expires in 10 minutes
  (`GET /doc/<ticket>`), and the save callback (`POST /callback`, which must carry a valid HS256 token). Besides
  them it serves only the agents' editor: its seat page, under a secret that keeps out everything else that reaches
  the listener, and each editor's plugin, under a token that gives that one editor's jobs and nothing else (below).
  The Document Server's own scripts run in the seat page (its `api.js`, its plugin SDK), so that secret is none to
  the Document Server, which holds every document and the JWT secret already: nothing on those paths gives more than
  it has. Nothing else answers there. The editor configs and callbacks are signed with a secret created once in the extension's data folder
  (`jwt-secret`, mode 0600), which the Document Server is given; the tickets with another (`ticket-secret`), which it
  is not, so a converter that a hostile file breaks into cannot forge one. A save is downloaded from the Document
  Server itself, from its files (`/cache/files/`) alone, whatever address the callback names. A document's file is
  read and written at its own name only: a link put in its place is refused, never followed.
- **The agents' editor is a browser of its own, on a network of its own.** `pithagoras-office-ds-agent`, from
  `chromedp/headless-shell` pinned by its digest, runs on `pithagoras-office-ds-agents` alone, with no port published.
  That network is made as the Document Server's is (internal, no gateway), and only the relay is on both: the browser
  reaches the Document Server through the relay's port 3890 alone, which leads to its port 80, where the Document
  Server's nginx keeps its statistics and cluster switches to itself (its own port 8000 beside it, which does not, is
  out of reach), and the extension's listener through the relay's way back; nothing else, never the portal, its pages
  or anyone's session (a portal in a container of its own is on the Document Server's network, not on this one). It
  runs as a user that is not root, with none of the kernel's capabilities,
  no new privileges, a read-only root, its profile in memory, 3 GB of memory and 512 processes at most, and no
  debugging port. Chromium's own sandbox is off (`--no-sandbox`), as it needs what the default seccomp profile refuses:
  the container is the boundary, for a hostile file the editor renders. It opens one page, the seat page, from the
  extension's listener through the relay, under a secret that is new at every start of the server half and is only in
  its command line (`/seat/<secret>/`), and that page opens an editor for each document an agent works in, with a
  config the server half signs. Those configs are the only ones with a plugin: Office's own (people's editors keep
  plugins and macros off, signed). The plugin takes the agent's edits from the listener under a token of its editor's
  (`/plugin/<token>/`), and runs one of four fixed commands with them as data: the model never sends code. Anything
  else on those paths is answered as an unknown address. The agent's write permission is checked before each edit and
  when its editor opens (one it may not change opens read-only), and a file in a folder the agent could not read is
  never opened.
  What this browser does not keep apart: the editors of every document the agents have open (three at most, of any
  agent) are in that one page, on one origin, so a document that got a script running in its editor (a bug of
  OnlyOffice's own; macros are off) reaches the other documents open there at that moment. And `office_read` reads
  through the editor, so a document an agent reads (one it downloaded, say) is converted by the Document Server and
  rendered by this browser with nobody opening it, as a person's editor does when they open it. Such a script could
  also hold the relay's way back, which it shares with the Document Server, until Office is restarted.
- **The editor sits behind the portal's sign-in.** The browser reaches the editor (`api.js`, the editor frame and every
  asset) only through `/api/x/@pithagoras/office/ds/…`, a proxy under the extension's routes, which the portal gates
  like all of them. It forwards GET requests and the POSTs the editor's socket.io channel sends, and only to the
  Document Server, and tells it the address the browser used, which it builds the editor's own addresses from. The
  Document Server's own endpoints are not passed on: its statistics, its cluster switches, its conversion services,
  and its command service, which the portal alone calls (to save the session after an agent's edit), over its own
  way in.
  The editor therefore runs on the portal's own origin, where a script has the signed-in person's session: a
  document's macros and the editor's plugins are switched off in the editor config the portal hands the page, as
  OnlyOffice holds macros apart only by a guard inside the page, and a document cannot switch them on. The Document
  Server 10.0 does not hold the page to the signed config (a page that changes it before it opens the editor gets
  plugins, as measured), so everything the proxy answers carries a content security policy that lets the editor's
  frame fetch and frame nothing but the portal's own origin: a plugin from anywhere else, which the editor's frame
  fetches (its `config.json`) and frames (its page), does not load. A script that could change the config has the
  person's session already. A Document Server on an origin of its own would be the full answer; it is not done here.
- **Changes only from the portal's pages.** Every request of the extension's that changes something (a document
  created, renamed or deleted, the Document Server started, stopped or removed, the settings) is refused unless it
  comes from the portal's own pages: the portal's cookie is SameSite=Lax, which a page on another port or another
  name of the same site is still sent.
- **What the tools return is outside content to the guard**: the text, comments and file names of documents anybody
  may have written. A comment's chat is given the words of the comment it was made for as yours only where you made
  that comment in this portal's editor (your page saw you write it); on any other comment only your reply, or what
  your edit added, is yours. The comment's text, the text it is on, the thread's other replies and the document are
  read with `office_comments` and `office_read`, as outside content. These chats are chats of their own, in Standard
  mode with the tools a new chat of that folder has: none of your chats' modes or tool switches carry over. A comment
  that reads like an order and is read that way can mark the chat; an answer of a marked chat is not posted in the
  document, also one that ended while Office restarted (the portal keeps the mark with the chat).
- **Who can make an agent act through a comment**: the portal's primary person. Every route asks the portal who is
  behind the request: nobody signed in is refused, and a person in another role may list the documents and download
  them but not open them in the editor (an editor is opened for changes), change them, nor talk to the agents through
  comments or the editor's chat (what they write would reach an agent as the primary person's words). Today every login to the portal is its primary person. The mention gives that agent the
  document.
- **Every post into a document is in the audit log**, with its document, thread and chat: each answer, each time it
  was posted again, a post whose outcome is not known (its editor closed or timed out while it ran), and a message of
  the editor's chat that failed after the ones before it went.
- **The agent writes only through its editor**, whose saves go through the same revision check as yours, and each
  document-changing call is recorded in the portal's audit log with the chat that made it, its ops and the revision
  it saved; an edit the editor took without a clear outcome (not sent in time, no answer, cut off) is recorded too,
  as such.

## Data

Everything is in the extension's own data folder, beside the portal's other data: `settings.json` (what you set; a
default you never changed is not written down, so a later version's default applies), `jwt-secret`, `ticket-secret`,
`relay-secret`, `ds.json` (the container and image of the last start), `index.json` (the library), `.trash/`,
`state/threads/<id>.json` (each comment thread's agents, their chats and what waits to be posted) and
`state/sessions.json` (the chats of the editor's chat, by editing session). A document stays where it is, in its
agent's home or project folder; only its entry is in the index. Documents an earlier version made in `docs/<id>/` of
the data folder are moved once, at the first start of this one, into the folder of the agent or project that made
them, else into the default agent's home (the first agent's), keeping their id, grants and revisions; a name taken
there gets a number ("Report (2)"), and each move is in the portal's log. One that cannot be moved yet (no default agent listed) is
tried again at each Rescan and every half minute. The containers (`pithagoras-office-ds`, its
relay `-relay` and the agents' editor `-agent`), the networks (`pithagoras-office-ds-net`, and `-agents` for the
agents' editor) and the Document Server's volumes are Docker's, shown in Settings → Docker under this extension. The
volumes are one for each folder its image keeps apart: `pithagoras-office-ds-cache` (`/var/lib/onlyoffice`: the
cache of open documents, with the saves it could not hand over yet, which the portal takes back once it reaches it
again), `-data` (`/var/www/onlyoffice/Data`, its own keys), `-logs` and `-fonts`. They outlive the container being made again, after an update say.

## Settings from the environment

The portal's environment can change each name, for a second portal on the same Docker host or for a test:

| Variable | Default |
| --- | --- |
| `PITHAGORAS_OFFICE_CONTAINER` | `pithagoras-office-ds` (the network is `<container>-net`, the relay `<container>-relay`, the agents' editor `<container>-agent` on the network `<container>-agents`, the volumes `<container>-cache`, `-logs` and `-fonts`) |
| `PITHAGORAS_OFFICE_VOLUME` | `<container>-data` |
| `PITHAGORAS_OFFICE_PORT` | `3890`: the relay's port to the Document Server, and for a portal on the host's network the forwarder's on 127.0.0.1 |

## Removing

Remove the Document Server in Settings → Office first (**Remove**), then uninstall the extension: the portal has no
uninstall hook, so containers left running keep running. Remove takes the Document Server, its relay, the agents'
editor, the networks (and with them the forwarder) and the Document Server's volumes; the library and every document stay.
Docker for extensions cannot remove an image, so the images stay on disk: `docker image rm
onlyoffice/documentserver:<tag>` deletes the big one, `docker image rm chromedp/headless-shell:157.0.8103.15` the
agents' editor.

## Limits

- Only `.docx` and `.xlsx`. `.pptx` is not supported.
- A comment made while the page could not report it (the tab closed at once, the server half away) starts nothing;
  reply to it again.
- In Word, an agent that may only comment changes the comment through the editor's comment methods, which give it a
  new id: its thread follows. Every person in the editor is "Portal". Such an agent's reads and posts share one
  editor that may only comment.
- A cell comment's answer is posted once the comment is five seconds old: a reply on a cell comment made a moment ago
  was now and then lost. A reply that does not reach the thread is posted again, a few times.
- The agents' browser opens for an answer as it does for the tools (about 0.3-0.45 GB while it runs), and an editor
  opened only to post closes after a minute.
- A file above 512 MiB is not indexed.
- One Document Server for the portal, run by this extension. A container of that name that nobody owns (one from
  before Docker for extensions) is taken over and made again; one of another extension's is refused.
- Not in this version: copying a document into a chat's folder from the library (the library downloads a copy), and
  expiry for the access a comment grants.
- What the portal knows of the editor's sessions (which one saved which revision) is kept in memory. An editor that
  stays open across a restart of the portal, and saved once before it, has its later saves kept as conflict copies,
  not written.
- The agent edits text, paragraphs, tables, cells and sheets; it cannot change formatting beyond a paragraph's style,
  write comments of its own or make tracked changes (it answers in the threads it was asked in). A sheet the agent copies takes the values, formulas, number formats and
  column widths of the old one, not its other formatting (fonts, colours, borders), charts, pictures, row heights or
  settings. An edit made while a person types in the same paragraph merges as the editor merges two people's typing.
- The agents' editors are one portal-wide browser: at most three documents at once, and a call that finds all three
  busy is refused (`error:busy`).

## Licences

Apache-2.0 ([LICENSE](LICENSE)). The built server half bundles jszip 3.10.2 (MIT or GPL-3.0-or-later, used under the
MIT licence) and the browser half icons from react-icons (MIT), drawn from Lucide (ISC); NOTICE says more, and
THIRD-PARTY-LICENSES has the licence texts of what is bundled. The
Document Server image is OnlyOffice's own (AGPL-3.0 for the community edition) and is pulled from Docker Hub by the
portal, not shipped by this package; so is the agents' editor, `chromedp/headless-shell`, the chromedp project's
image of Chromium's headless shell (BSD-3-Clause, with the licences of the components Chromium includes), downloaded
by Start in Settings → Office.

## Building and testing

Office is an npm workspace of this repository; `npm ci` at its root installs what it is built with (esbuild,
tailwindcss, postcss, the extension API, react-icons and jszip).

```sh
npm run build -w office    # web/ and server.js, then the type check of src/ and the tests
npm test -w office         # the unit and integration tests, with Docker, the portal and the Document Server faked
./scripts/pithagoras.sh && PITHAGORAS_DIR=$PWD/.pithagoras npm run test:portal -w office   # under the portal's own extension host; the editor page, the chat's panel and Settings in Chromium
```

The integration tests start nothing in Docker: they run the extension's real loopback listener in the test process,
with a small server of their own standing in for the Document Server's downloads; the seats' tests play the agents'
browser over HTTP. The end-to-end tests run the real Document Server and the agents' editor through Docker for
extensions under the portal's own extension host, open a document in Chromium in the Office page's own editor, and
have the agent edit it beside the person (`e2e.test.mts`, and `spike.test.mts`, which pins what the editor's API does
that the agent's commands rely on); they are opt-in, as they need Docker Engine 28 or later, both images (about
3.5 GB) and a few minutes:

```sh
./scripts/pithagoras.sh && OFFICE_E2E=1 PITHAGORAS_DIR=$PWD/.pithagoras npm run test:e2e -w office
```

`real-portal.test.mts` proves the same in a real portal: the portal's own server started from that folder (built with
`npm run build` there), Docker for extensions and Office installed into it through `POST /api/packages`, a person in
the real Office page in Chromium, and the agent's office tools called from a chat whose model is a script
(`scripted-model.mjs`, no model server needed). `OFFICE_PORTAL_MODE=container` runs the portal in a container of its
own (Node's alpine image, with this machine's Docker socket), on a network of its own:

```sh
OFFICE_E2E=1 PITHAGORAS_DIR=$PWD/.pithagoras [OFFICE_PORTAL_MODE=container] npm run test:real -w office
```

`scripts/make-fixtures.mjs` makes `fixtures/sample.docx` and `fixtures/sample.xlsx` again (`node
scripts/make-fixtures.mjs` in `office/`; the zip entries carry the time of the run, so the bytes differ but not what
the files contain).
