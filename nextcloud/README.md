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
  app name it asks for can be anything; `pithagoras` is a good one. A personal password works, but an app password is
  the kind that can be revoked on its own when something goes wrong.
- About 150 MB of disk for the image (`ghcr.io/cbcoutinho/nextcloud-mcp-server:0.203.0`, pulled once, shared by all
  instances).

## Installing

In Settings → Extensions → Discover → Install by name: `npm:@pithagoras/nextcloud`. Then open **Settings → Nextcloud**
and add an instance: its name, the host (like `https://cloud.example.org`), the
user name and that app password — and press **Save and apply**. The container starts with them, the server is
registered in pi's config under the instance's own name, and the page's status shows each part: the container (and how
long it has been coming up), the entry in pi's config, and whether the server answers at its `/mcp` address.

The settings stand in the extension's own data folder (where Pithagoras keeps the settings of any of its extensions),
not beside pi's own files: the password is written there once and then never shown again; the field on the page stays
empty while one is saved, and saving with it left empty keeps what was there. Where an earlier version kept the settings
in pi's own config file, they come over once at the first start and leave that file then.

More than one Nextcloud on this machine? Add as many instances as you have — each gets its own container, its own
port at the loopback of the portal's network, and its own entry in pi's config under its name; an agent that reaches a
`nextcloud` tool talks to exactly the instance the registration names. The panel beside your chat shows a switcher
over the instances above its tabs: whichever it holds is what every tab there shows and changes.

Already running this image yourself? Those containers are not touched by the extension at all: every instance starts
its own container beside them, so the ones you ran come to stand redundant — remove them on your own where you are
done with them.

The settings page also shows every capability this extension knows about — the tool families of its tabs, one choice
each: files and sharing beside each other, mail, news, collectives among them. Each choice turns that family's tools
off in pi's config where it is turned off, and keeps its tab out of the panel as well; where the instance's endpoint
does not provide a family at all (its server answers without those tools), the choice stands greyed out and is kept
out wherever it would reach. What the endpoint provides is found from its own tool list every time the status looks,
so nothing an earlier version never offered is invented, and a server that starts to offer more shows it on its own.

**Remove** takes an instance away: its entry in pi's config always goes, and its container with it. The settings stay
where they were shown on the page, so putting the instance back starts it without typing anything new. Uninstalling the extension does the same removal for every instance.

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
- **The agents reach your clouds too**: every server is registered in pi's config, persistent, trusted, with nothing
  direct besides what its registration names — so a chat can ask "check the milk off the list" or "what did I note down
  about the fence", and the answer comes from Nextcloud. What it may not reach is exactly what its capability
  choices turn off.

## How it runs

One container per own instance, on the portal's shared network: inside its own namespace, reachable by the portal at
`127.0.0.1` and not from the machine around it, with the image pinned to the release this version was built against
and the host, user name and password given as its environment. The first instance stands under `pithagoras-nextcloud-mcp`,
the others under that name with their own slug beside; their servers take the loopback ports at and above 8000 in
order of saving, and a port once saved stays with its instance — adding or removing the others does not shift what
already stands. The extension is each container's owner: it is created on the first save, taken over when found (its
label says whose it is), rebuilt where the host, the user name or the password has changed, and removed again when the
instance or the extension goes away. Nothing of what you have in your cloud lives inside it; it only speaks to the
Nextcloud behind the address you gave it.

## Security

The containers are not on a network of their own. Blender's and Godot's stand where no code they run can reach the
machine or the internet at all, and so should Office's Document Server — but a Nextcloud MCP server that cannot get
to your cloud could do nothing. So each stands on the portal's shared loopback (Docker for extensions' shared
network) instead, and what it exposes there is held down to the smallest: its /mcp endpoint binds to `127.0.0.1` of
that namespace only, so the portal alone can reach it; nothing else listens, and nothing in the container has a way
to your machine beyond the Nextcloud address you gave it.

The login stands with the extension's own settings: its name, host, user name and app password sit in the
extension's data folder on the portal's machine, written once and never shown again. Use an **app password** rather
than your personal one — Settings ▸ Security ▸ Devices & sessions lets you revoke that one on its own when it stops
being wanted; removing an instance or uninstalling the extension takes the entry away again.

The image itself is the community's (cbcoutinho/nextcloud-mcp-server), pinned to a release: this extension ships no
code of its, and what runs in the container is that project's — read it where you would read anything else your
cloud credentials are handed to.
