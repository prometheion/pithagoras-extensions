# Nextcloud for Pithagoras

`@pithagoras/nextcloud` brings your [Nextcloud](https://nextcloud.com) into Pithagoras: the extension runs the
[Nextcloud MCP server](https://github.com/cbcoutinho/nextcloud-mcp-server) in containers of its own through Docker for
extensions — one per instance, each made and kept by the extension — registers each
server in pi's MCP config under its own name so every agent can reach your clouds, and adds a Nextcloud panel to every
chat with ten working tabs: **Shopping List**, **Cookbook**, **Notes**, **Files** (sharing built in, as on Nextcloud), **Deck**, **Calendar**,
**Contacts**, **Mail**, **News** and **Collectives**.

This extension is not made or endorsed by Nextcloud GmbH. "Nextcloud" names the service it talks to.

## What it needs

- Pithagoras 0.3.0 or later and [Docker for extensions](https://thecodacus.github.io/pithagoras/guide/docker)
  (`pithagoras-docker` 1.3.0 or later), which installing this extension from npm brings along with the portal's
  `requires`. A Linux host with Docker Engine 28.0 or later that the portal can reach, as for any container it runs.
- A reachable Nextcloud — your own server in the home lab as much as a hosted one — and an **app password** for the
  user you log in with: in Nextcloud under **Settings ▸ Security ▸ Devices & sessions**, "Add an app password". The
  app name it asks for can be anything; `pithagoras` is a good one. An app password is required: the server logs in
  with HTTP basic authentication, which a Nextcloud with two-factor authentication refuses for the personal password,
  and an app password is the kind that can be revoked on its own when something goes wrong.
- The address with its scheme, `https://…`. A Nextcloud with a certificate the container does not trust (a
  self-signed one, a private CA) is not reached: the extension has no way to give the container your CA. Plain `http://`
  is refused unless you switch it on for the instance (it sends the app password unencrypted).
- The Nextcloud apps the tabs talk to, each only where it is installed on your Nextcloud: Files (always), Deck,
  Calendar, Contacts, Notes, Cookbook, Shopping List, Mail, News and Collectives. A tab whose app is missing does not
  show.
- About 400 MB of disk for the image (`ghcr.io/cbcoutinho/nextcloud-mcp-server:0.203.0`, 360 MB compressed; pulled once,
  shared by all instances), and memory: each container is limited to 1 GB, and a server that is only asked a few things
  now and then uses a fraction of it.

## Installing

In Settings → Extensions → Discover → Install by name: `npm:@pithagoras/nextcloud`. Then open **Settings → Nextcloud**
and add an instance: its name, the host (like `https://cloud.example.org`), the
user name and that app password — and press **Save and apply**. The container starts with them, the server is
registered in pi's config under the instance's own name, and the page's status shows each part: the container (and how
long it has been coming up), the entry in pi's config, and whether the server answers at its `/mcp` address.

The address is judged when you save it: it has to be an address with `https://` (or `http://` with the switch on the
card), without a login in it. A new address or user name needs the app password typed again, as the saved one is not
sent to another host or account. Beside the server's own answer the page shows what your Nextcloud says of the login:
accepted (with your name), refused, or not reachable; the server's "answering" only means that the container runs.

The settings stand in the extension's own data folder (where Pithagoras keeps the settings of any of its extensions),
not beside pi's own files: the password is written there once and then never shown again; the field on the page stays
empty while one is saved, and saving with it left empty keeps what was there.

More than one Nextcloud on this machine? Add as many instances as you have — each gets its own container, its own
port at the loopback of the portal's network, and its own entry in pi's config under its name; an agent that reaches a
`nextcloud` tool talks to exactly the instance the registration names. The panel beside your chat shows a switcher
over the instances above its tabs: whichever it holds is what every tab there shows and changes.

Already running this image yourself? Those containers are not touched by the extension at all: every instance starts
its own container beside them, so the ones you ran come to stand redundant — remove them on your own where you are
done with them. The same goes for a server of your own in pi's MCP config (Settings → MCP) that has the name of an
instance: the extension does not take it over (nor carry its headers or environment over), it refuses the save and says
so. Pick another name, or remove that server first.

The settings page also shows every capability this extension knows about — the tool families of its tabs, one choice
each: files and sharing beside each other, mail, news, collectives among them. Each choice turns that family's tools
off in pi's config where it is turned off, and keeps its tab out of the panel as well; where the instance's endpoint
does not provide a family at all (its server answers without those tools), the choice stands greyed out and is kept
out wherever it would reach. What the endpoint provides is found from its own tool list every time the status looks,
so nothing an earlier version never offered is invented, and a server that starts to offer more shows it on its own.

**Remove** takes an instance away: the settings of it go, and a run behind it takes its container and its entry in pi's
config away (the extension remembers which entries it wrote, and clears those only). **Remove everything** takes the
containers and the entries away and keeps the settings, so **Start again** brings them back without typing anything
new. Stopping or updating the extension does the same removal for every instance and starts them again. Uninstalling
it does not: the portal has no uninstall hook, so remove everything on the page first. (An entry that version 0.1.0
left behind after a removal is not known to the extension: take it out in Settings → MCP.)

## What you get

- **A Nextcloud panel in every chat**, beside the files panel: one place with what your cloud holds, for you and the
  agent that answers there. Its ten tabs, each thin over the MCP server's own tools — and only where the instance's
  endpoint provides the tab's tools:
  - **Shopping List** — the lists (new ones made, renamed, taken away), their items checked as they are bought
    (the check is in Nextcloud, so a phone on the app sees it at once) and each item's name, amount and measure
    amended; new items added at the bottom of the list, items and checked runs removed, everything opened again at once.
  - **Cookbook** — the recipes with ingredients and steps, searched by name or keyword, a recipe set off from its own
    fields (or one imported from its URL wherever a site has marked it up, schema.org) and an old one changed or gone
    where you want.
  - **Notes** — all the notes, searched as you type, opened for reading, edited and saved back in place, and a new
    note set off where none stood yet.
  - **Files** (sharing built in, as on Nextcloud) — browse your files (a new folder or file made on the spot),
    preview images and text and pull a file down; a file moved, renamed, copied or taken away, and what was thrown out
    lies in the trash until it is brought back; beside it the shares: who has what with what permission, new ones added,
    taken away again, and a short public link made of a path.
  - **Deck** — your boards (a new one set off with its color) and their stacks (new ones added), cards by their order,
    due date and labels; new cards set off at the top of a stack, a card's text read and written back.
  - **Calendar** — the month at a glance in a grid like Nextcloud's own calendar, every calendar overlaid in one and a
    pill per one standing its events in or out (turning months stays within a held window, so it costs no call); the
    chosen day's events laid out beneath it; an event opened for its time, place and note changed or gone, new ones set
    off on the day into any calendar; beside it the open tasks across the shown calendars (new ones with their due day),
    ticked off as they are done.
  - **Contacts** — your address books' contacts searched as you type, a card opened and amended in place, new ones
    added and taken away again.
  - **Mail** — the accounts' mailboxes and their messages by subject, sender and preview; new mail written at once —
    sent or kept as a draft; a message opened for its full body and attachments, starred, moved to another mailbox or
    taken away, marked read or unread where the server gives it back.
  - **News** — the feeds with their unread standing and their items; an article opened for its body beside the link
    to its original.
  - **Collectives** — the collectives (a new one set off) and their pages searched as you type, a page opened for
    reading and — where one is not kept read-only — written and saved back; new pages made where the collective allows.
- **The agents reach your clouds too**: every server is registered in pi's config under the instance's name, persistent
  — so a chat can ask "check the milk off the list" or "what did I note down about the fence", and the answer comes
  from Nextcloud. What it may not reach is exactly what its capability choices turn off.
  - **It is not a trusted server.** What Nextcloud returns is other people's words (mail, news, files and boards others
    share, invitations, recipes from any site), so the portal's guard treats it like any outside content: wrapped,
    scanned for injection, and a chat that has read it is tainted. (Version 0.1.0 registered the servers as trusted;
    the first run of this version takes the names out of Settings → Guard's trusted servers again.)
  - **The agent asks you first** before it sends mail (`nc_mail_send_message`), makes a public link or a share
    (`nc_share_create*`, `nc_share_update*`), deletes anything (`*_delete_*`, `nc_share_delete*`) or clears a list
    (`*_clear_*`). The question comes through pi-mcp-adapter's `approveTools` on the entry; a chat nobody sits at (a
    routine, a heartbeat) cannot be asked, and the call is refused. Change the list in Settings → MCP (`approveTools`
    of the entry): a list you set there stays; `false` turns the questions off. Reading, listing, creating notes,
    events, cards and the like are not asked about.

## How it runs

One container per instance, on the portal's shared network (Docker for extensions' `sharedNetwork`): the image is
started from its digest (the build 0.203.0 was tested with; a tag that is pushed again to another build is not run),
with the host, user name and password as its environment, no Linux capability, no new privileges, a limit of 1 GB of
memory, 256 processes and a small log, and Docker's restart policy (`unless-stopped`, so a crash or a restart of the
daemon brings it back; one you stopped in Settings → Docker stays stopped). The first instance stands under
`pithagoras-nextcloud-mcp`, the others under that name with their own slug beside; their servers take the loopback
ports at and above 8000 in order of saving, and a port and a name once saved stay with their instance — adding or
removing the others does not shift or rename what already stands. The extension is each container's owner: it is
created on the first save, rebuilt where the hash of what it was made with (kept as a label) differs — a changed host,
user name, password or port, or a new build of the extension — and removed again when the instance goes away. Every
run also removes the containers of this extension that no instance stands for. The server's entry in pi's config is
written only once the container answers as the Nextcloud MCP server (it names itself "Nextcloud MCP"): a program that
holds the port and answers as something else gets no entry, and the page says so. Nothing of what you have in your
cloud lives inside it; it only speaks to the Nextcloud behind the address you gave it.

## Settings from the environment

The portal's environment can change these, for a second portal on the same Docker host or for a test:

| Variable | Default |
| --- | --- |
| `PITHAGORAS_NEXTCLOUD_CONTAINER` | `pithagoras-nextcloud-mcp` (a further instance is `<container>-<slug of its name>`) |
| `PITHAGORAS_NEXTCLOUD_PORT` | `8000`: the first instance's port on the loopback; the others take the next free ones above |
| `PITHAGORAS_NEXTCLOUD_DATA_DIR` | the extension's data folder, where `settings.json` (mode 0600) is kept |
| `PITHAGORAS_NEXTCLOUD_ANSWER_MS` | `60000`: how long a container is given to answer as the Nextcloud MCP server before the run says it did not |

## Security

The containers are not on a network of their own. Blender's and Godot's stand where no code they run can reach the
machine or the internet at all, and so should Office's Document Server — but a Nextcloud MCP server that cannot get
to your cloud could do nothing. So each stands on the portal's shared loopback (Docker for extensions' shared
network) instead, and what that means depends on where the portal runs:

- **The portal in a container on a network of its own** (not one of Pithagoras' own Compose files): the loopback is
  the portal container's. The server listens on `127.0.0.1` there, and only that container (the portal, and whatever
  its agents run inside it) reaches it.
- **The portal on the machine itself, or in a container on the host's network** (both of Pithagoras' Compose files):
  the loopback is the machine's. The server listens on `127.0.0.1:8000` and up — not on the network, but **every process
  on the machine can reach it, and it checks nobody**: the Nextcloud MCP server has no login of its own in this mode,
  and its tools run as the account whose app password it holds. A token in front of it would stand on the same
  loopback and protect nothing (Docker for extensions has no network with a way out and no way to the portal's
  machine; that is what would fix this, and it is not there yet). What the extension does about it: the agent is asked
  before the tools that send, share and delete (above); the app password is the revocable kind; the container has
  no capability and is limited. If other people have shell access on that machine, or you run other services that
  you do not trust on its loopback, do not run this extension there, or use an account on your Nextcloud that may only
  do what you are content for any of them to do.

The login stands with the extension's own settings: its name, host, user name and app password sit in the
extension's data folder on the portal's machine (`settings.json`, mode 0600), written once and never shown again.
Use an **app password** rather than your personal one — Settings ▸ Security ▸ Devices & sessions lets you revoke that
one on its own when it stops being wanted. The app password is handed to the container as its environment, so it is
visible in `docker inspect` to whoever may use Docker on the machine (as for any container).

The image itself is the community's (cbcoutinho/nextcloud-mcp-server), pinned to a release and started from its
digest: this extension ships no code of its, and what runs in the container is that project's — read it where you
would read anything else your cloud credentials are handed to. It is not run with a read-only root filesystem or as a
non-root user: those were not tried against the image, and a server that fails to start for it helps nobody.

## Limits

- No upload of files from the panel (files are browsed, previewed, downloaded, moved, copied, shared and deleted).
- Calendar: events of a series that Nextcloud repeats are listed but not changed here; the grid reads the 13 months around
  the one shown, at most 500 events, and says so when the answer is cut short. A time the panel writes (an event's, a
  card's due date) is sent as the wall-clock time you see, which Nextcloud reads in its own zone.
- Mail shows a message as text (HTML is flattened to its text); there is no HTML view and no attachment download.
- A panel tab drops what was typed in it when you switch to another tab of the panel (the portal asks before the page
  or a dialog is closed on unsaved words, and a view asks before it is left by its own buttons).
- A tool call is given 120 s; a very large file read can time out.

## Licences

Apache-2.0 ([LICENSE](LICENSE)). The browser half bundles icons from react-icons (MIT), drawn from Lucide (ISC); NOTICE
says more, and THIRD-PARTY-LICENSES has the licence texts of what is bundled. The server image is the Nextcloud MCP
server project's own (AGPL-3.0), pulled from GHCR by the portal, not shipped by this package; its source is in the
project's repository, at the tag this version pulls.

## Building and testing

Nextcloud is an npm workspace of this repository; `npm ci` at its root installs what it is built with.

```sh
npm run build -w nextcloud    # web/ and server.js, then the type check of src/ and the tests
npm test -w nextcloud         # the unit tests: settings, container recipe, the MCP client, texts, the release step
./scripts/pithagoras.sh && PITHAGORAS_DIR=$PWD/.pithagoras npm run test:portal -w nextcloud   # under the portal's own extension host, and the panel's views in Chromium
```

The portal-tier tests start the server half under the portal's own extension host, with a fake Docker daemon, a
stand-in MCP server on the port a container is told to hold and a stand-in Nextcloud; the panel's views are the
components themselves in Chromium (Playwright), against a `/tool` route that answers as the server half does.
