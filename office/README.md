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
- A Docker host the portal can reach (its socket), for the portal's shared network (see Security).
- About 4 GB of RAM for the Document Server container. The settings page warns before the first start, and shows the
  container's memory use once it runs.
- Disk for the image (`onlyoffice/documentserver`, several GB), which the portal pulls on the first start, with the
  progress shown in Settings.

## Installing

In Settings → Extensions → Discover → Install by name: `npm:@pithagoras/office`. Then open Settings → Office, switch it
on and press start. The image is pulled on the first start (`onlyoffice/documentserver:10.0` by default, never
`:latest`: a change of the tag can change the editor's callback and token behaviour, so it is yours to change on
purpose, in the same page).

## What you get

- **The library**, on the portal's Office tab: create blank Word documents and spreadsheets, open one full screen in
  the embedded editor, sort the list by name, modified, size or type, and download a copy. Every `.docx` and `.xlsx` in
  the agents' and projects' folders (what the portal lists as folders) is indexed when the extension starts, and again
  with **Rescan**, **in place**: the scanned file is the document, and editing it edits that file. Deleting one moves
  its real file into the library's trash (`.trash/` in the data folder), where it is kept for 7 days and then removed;
  there is no button to restore it, but the file can be moved back by hand.
- **A panel beside each chat** with the documents nobody owns (the ones scanned or made by you) and the ones that
  chat's agent owns or was granted, and a card in the chat for each call of the agent's tools that names its document.
- **The agent's tools**, in the chats of agents and projects: `office_list`, `office_create`, `office_read`,
  `office_edit` and `office_comments`. An agent sees the documents nobody owns (the ones scanned or made by you), the
  ones it owns and the ones it was granted; another agent's are not there for it, and asking for one gets the same
  answer as for a document that does not exist.
- **Co-editing, with no switch**: the agent is a co-editor like any other. You and the agent can have the same
  document open and edited at once. Every write goes through a revision check: a document's revision is its file's
  modification time, `office_read` shows it, and `office_edit` takes it as `baseRevision` and replaces quoted text
  only if the file is still at that revision. If it moved on (you saved in the meantime), nothing is written and the
  tool answers `error:revision_mismatch`, naming the open editor session where there is one; the agent reads again
  and retries. The Document Server's own saves are held to the same check, so nobody overwrites a newer revision.
  An open editor sees an external change within about 5 seconds. Every revision the agent writes is kept for the
  editor's version history.
- **Wake on mention**: when you comment in a Word document and write `@agent` (the agent that owns the document), or
  `@<name>` or `@project:<name>` for an agent or project by name, and save, that agent's home chat is woken with the
  quoted comment and gets access to that document.

## Security

- **The Document Server sits behind the portal's sign-in.** The browser reaches the editor (`api.js`, the editor frame
  and every asset) only through `/api/x/@pithagoras/office/ds/…`, a proxy under the extension's routes, which
  the portal gates like all of them. It forwards GET requests and the POSTs the editor's socket.io channel sends, and
  only to one origin, the Document Server this extension started (recorded
  in `ds.json`). A portal whose Docker is reached through a container-to-container network, where there is no such
  origin to forward to, is refused with a message that says so.
- **Two routes are open to the container, on a listener of their own.** The container has no portal session, so the
  two things it needs are served by a small listener bound to `127.0.0.1` on a port chosen at each start: a document
  fetch with a signed ticket that expires in 10 minutes (`GET /doc/<ticket>`), and the save callback
  (`POST /callback`, which must carry a valid HS256 token). Nothing else answers there. The tokens are signed with a
  secret created once in the extension's data folder (`jwt-secret`, mode 0600).
- **On a portal on the host's network, the Document Server listens on every interface.** The container joins the
  portal's shared network (`host` for a portal on the machine itself), so the image's own web server answers on port
  80 of every address the machine has, without going through the portal's sign-in: the signed tokens protect the
  requests the portal makes, they are no access control against someone who reaches that port. Firewall the port so
  that only the machine itself reaches it. Binding it to the loopback is not done by this extension.
- **The agent can only write what its revision check allows**, and each document-changing call is recorded in the
  portal's audit log with the chat that made it.

## Data

Everything is in the extension's own data folder, beside the portal's other data: `settings.json`, `jwt-secret`,
`ds.json` (the container and its recorded origin), `index.json` and `docs/<id>/<title>.<ext>` (the library),
`.trash/`, `state/<id>.json` (the comments last seen, so that a comment wakes an agent once) and
`history/<id>/<revision>.zip` (the changes kept for the editor's version history). A scanned document stays where it
is; only its entry is in the index. The container (`pithagoras-office-ds`) and its volume (`pithagoras-office-ds-data`)
are Docker's, shown in Settings → Docker under this extension.

## Limits

- Only `.docx` and `.xlsx`. Comments are read and wake an agent in Word documents; spreadsheet comments are not read.
  `.pptx` is not supported.
- A file above 512 MiB is not indexed.
- One Document Server for the portal, run by this extension. An existing container of that name is adopted, never made
  again.
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
