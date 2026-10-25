# Office for Pithagoras

`@pithagoras/office` lets you and the agent work on the same Word (`.docx`) and Excel (`.xlsx`) documents. You edit
them in the real [OnlyOffice Document Server](https://github.com/ONLYOFFICE/Docker-DocumentServer) editor, embedded in
the portal, which the extension runs in a container through Docker for extensions; the agent reads and edits the same
files through tools of its own. An Office tab holds the library.

This extension is not made or endorsed by Ascensio System SIA. "ONLYOFFICE" names what it runs.

## What it needs

- Pithagoras 0.3.0 or later.
- [Docker for extensions](https://thecodacus.github.io/pithagoras/guide/docker) (`pithagoras-docker` 1.3.0 or later).
  It ships with the portal but is not on by default; installing this extension from npm brings it along.
- A Linux host with Docker Engine 28.0 or later that the portal can reach (its socket): the portal on the machine
  itself, or in Docker (both of Pithagoras' Compose files). On macOS or Windows the portal has to run in Docker.
- About 4 GB of RAM for the Document Server container. The settings page warns before the first start, and shows the
  container's memory use once it runs.
- Disk for the images (`onlyoffice/documentserver`, several GB, and Node's `node:22.23.4-alpine3.23`, about 50 MB,
  for the relays below), which the portal pulls on the first start, with the progress shown in Settings.

## Installing

In Settings → Extensions → Discover → Install by name: `npm:@pithagoras/office`. Then open Settings → Office, switch it
on and press start. The image is pulled on the first start (`onlyoffice/documentserver:10.0.0.1` by default, the full
tag of the build this version was tested with, never `:latest` or a shorter tag like `10.0`, which move to each new
build: a new build can change the editor's callback and token behaviour, so it is yours to change on purpose, in the
same page).

## What you get

- **The library**, on the portal's Office tab: create blank Word documents and spreadsheets, open one full screen in
  the embedded editor, sort the list by name, modified, size or type, and download a copy. Every `.docx` and `.xlsx` in
  the agents' and projects' folders (what the portal lists as folders) is indexed when the extension starts, and again
  with **Rescan**, **in place**: the scanned file is the document, and editing it edits that file. Deleting one moves
  its real file into the library's trash (`.trash/` in the data folder), where it is kept for 7 days and then removed;
  there is no button to restore it, but the file can be moved back by hand.
- **A panel beside each chat** with the documents that chat's agent or project sees (below), and a card in the chat
  for each call of the agent's tools that names its document.
- **The agent's tools**, in the chats of agents and projects: `office_list`, `office_create`, `office_read`,
  `office_edit` and `office_comments`. An agent sees the documents in its own folder, the ones it made and the ones it
  was granted by a mention, and the ones you made in the library; another agent's, and the files in another agent's or
  project's folder, are not there for it, and asking for one gets the same answer as for a document that does not
  exist. What an agent makes or is granted belongs to its folder, not to one of its chats. A file in its folder is read
  through the portal as the agent itself would read it: with the sandbox on, one the agent could not read is refused,
  and a link is not followed.
- **The agent and the editor take turns**: while a document is open in the editor, `office_edit` refuses
  (`error:open_in_editor`) and the agent tries again once it is closed: the Document Server saves what is typed only
  as the last editor closes, under the revision it opened, and an edit landing first would make that save stale.
  Every write goes through a revision check: a document's revision is its file's modification time, `office_read`
  shows it, and `office_edit` takes it as `baseRevision` and replaces quoted text only if the file is still at that
  revision; if it moved on, nothing is written and the tool answers `error:revision_mismatch`. A change made outside
  the extension (a script, a git pull) is a new revision at once. A save from the editor that would overwrite a newer
  revision (the file changed on disk while it was open) is not lost and does not overwrite it: it is kept beside the
  document as "<title> (conflict <date time>)", and the audit log says so. An open editor says within about 5
  seconds when the file changed on disk; reloading it opens the new revision.
- **Wake on mention**: when you comment in a Word document and write `@agent` (the agent that owns the document), or
  `@<name>` or `@project:<name>` for an agent or project by name, and save, that agent's home chat is woken with the
  quoted comment and gets access to that document.

## Security

- **A network of its own.** The Document Server is on `pithagoras-office-ds-net`, which Docker for extensions makes
  internal and with no gateway (gateway mode `isolated`): it reaches neither the machine, its loopback, the local
  network nor the internet, and nothing outside the machine reaches it. A converter that a hostile `.docx` breaks into
  finds nothing there but the two relays below. Its plugin manager is off (`PLUGINS_ENABLED=false`): it would try the
  internet at every start.
- **Two relays are its only way in and back.** Docker for extensions gives a way onto such a network but none back,
  and the Document Server has to fetch each document and report each save. So Office runs two small containers of its
  own on Node's alpine image, unprivileged, with none of the kernel's capabilities, a read-only root and 128 MB, as
  Docker for extensions runs its forwarder:
  - `pithagoras-office-ds-relay`, on the network: port 3890 to the Document Server's port 80 (the way in), and port
    3891 to a socket in the volume `pithagoras-office-ds-relay-sock` (the way back);
  - `pithagoras-office-ds-portal`, on the portal's own loopback (the machine's network for a portal on it, the portal
    container's for one in Docker): that socket to the extension's listener on 127.0.0.1.

  The portal reaches the relay as it reaches Blender and Godot: for a portal on the host's network, through the
  forwarder `pithagoras-office-ds-relay-forward`, which publishes port 3890 on 127.0.0.1; for a portal in a container
  of its own, by putting that container on the network. Port 80 is never published on the machine.
- **Two routes are open to the Document Server, on a listener of their own.** The container has no portal session,
  so the two things it needs are served by a small listener bound to `127.0.0.1`, which the relays lead to and
  nothing else: a document fetch with a signed ticket that expires in 10 minutes (`GET /doc/<ticket>`), and the save
  callback (`POST /callback`, which must carry a valid HS256 token). Nothing else answers there. The tokens are signed
  with a secret created once in the extension's data folder (`jwt-secret`, mode 0600). A save is downloaded from the
  Document Server itself, from its files (`/cache/files/`) alone, whatever address the callback names.
- **The editor sits behind the portal's sign-in.** The browser reaches the editor (`api.js`, the editor frame and every
  asset) only through `/api/x/@pithagoras/office/ds/…`, a proxy under the extension's routes, which the portal gates
  like all of them. It forwards GET requests and the POSTs the editor's socket.io channel sends, and only to the
  Document Server, and tells it the address the browser used, which it builds the editor's own addresses from.
  The editor therefore runs on the portal's own origin, where a script has the signed-in person's session: a
  document's macros and the editor's plugins are switched off in the signed editor config, which the page cannot
  change, as OnlyOffice holds macros apart only by a guard inside the page. A Document Server on an origin of its own
  would be the full answer; it is not done here.
- **The agent can only write what its revision check allows**, and each document-changing call is recorded in the
  portal's audit log with the chat that made it.

## Data

Everything is in the extension's own data folder, beside the portal's other data: `settings.json`, `jwt-secret`,
`ds.json` (the container and image of the last start), `listener-port` (the listener's port, taken again at the
next start), `index.json` and `docs/<id>/<title>.<ext>` (the library),
`.trash/`, `state/<id>.json` (the comments last seen, so that a comment wakes an agent once) and
`history/<id>/<revision>.zip` (the changes kept for the editor's version history). A scanned document stays where it
is; only its entry is in the index. The containers (`pithagoras-office-ds` and its relays `-relay` and `-portal`), the
network (`pithagoras-office-ds-net`) and the volumes (`pithagoras-office-ds-data`, the Document Server's cache of open
documents, and `pithagoras-office-ds-relay-sock`) are Docker's, shown in Settings → Docker under this extension.

## Settings from the environment

The portal's environment can change each name, for a second portal on the same Docker host or for a test:

| Variable | Default |
| --- | --- |
| `PITHAGORAS_OFFICE_CONTAINER` | `pithagoras-office-ds` (the network is `<container>-net`, the relays `<container>-relay` and `<container>-portal`, their volume `<container>-relay-sock`) |
| `PITHAGORAS_OFFICE_VOLUME` | `<container>-data` |
| `PITHAGORAS_OFFICE_PORT` | `3890`: the relay's port to the Document Server, and for a portal on the host's network the forwarder's on 127.0.0.1 |

## Removing

Remove the Document Server in Settings → Office first (**Remove**), then uninstall the extension: the portal has no
uninstall hook, so containers left running keep running. Remove takes the Document Server, both relays, the network
(and with it the forwarder) and both volumes; the library and every document stay. Docker for extensions cannot
remove an image, so the images stay on disk: `docker image rm onlyoffice/documentserver:<tag>` deletes the big one.

## Limits

- Only `.docx` and `.xlsx`. Comments are read and wake an agent in Word documents; spreadsheet comments are not read.
  `.pptx` is not supported.
- A file above 512 MiB is not indexed.
- One Document Server for the portal, run by this extension. A container of that name that nobody owns (one from
  before Docker for extensions) is taken over and made again; one of another extension's is refused.
- Not in this version: copying a document into a chat's folder from the library (the library downloads a copy), and
  expiry for the access a comment grants.

## Licences

Apache-2.0 ([LICENSE](LICENSE)). The built server half bundles jszip 3.10.2 (MIT or GPL-3.0-or-later, used under the
MIT licence) and the browser half icons from react-icons (MIT), drawn from Lucide (ISC); NOTICE says more, and
THIRD-PARTY-LICENSES has the licence texts of what is bundled. The
Document Server image is OnlyOffice's own (AGPL-3.0 for the community edition) and is pulled from Docker Hub by the
portal, not shipped by this package.

## Building and testing

Office is an npm workspace of this repository; `npm ci` at its root installs what it is built with (esbuild,
tailwindcss, postcss, the extension API, react-icons and jszip).

```sh
npm run build -w office    # web/ and server.js, then the type check of src/
npm test -w office         # the unit tests, with Docker, the portal and the Document Server faked
OFFICE_IT_DOCKER=1 npm test -w office   # also the three integration tests that need a Docker CLI that answers
```

The integration tests start nothing in Docker: they run the extension's real loopback listener in the test process,
with a small server of their own standing in for the Document Server's downloads. `scripts/make-fixtures.mjs` makes
`fixtures/sample.docx` and `fixtures/sample.xlsx` again (`node scripts/make-fixtures.mjs` in `office/`; the zip entries carry the time of the run, so the bytes differ
but not what the files contain).
The test files are not type-checked by the build (`tsconfig.json` covers `src/`).
