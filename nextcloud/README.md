# Nextcloud for Pithagoras

`@pithagoras/nextcloud` brings your [Nextcloud](https://nextcloud.com) into Pithagoras: the extension runs the
[Nextcloud MCP server](https://github.com/cbcoutinho/nextcloud-mcp-server) in containers of its own through Docker for
extensions — one per instance, or a container you already run that it takes over without touching it — registers each
server in pi's MCP config under its own name so every agent can reach your clouds, and adds a Nextcloud panel to every
chat with seven working tabs: **Shopping List**, **Cookbook**, **Notes**, **Files & Sharing**, **Deck**, **Calendar**
and **Contacts**.

This extension is not made or endorsed by Nextcloud GmbH. "Nextcloud" names the service it talks to.

## What it needs

- Pithagoras 0.3.0 or later and [Docker for extensions](https://thecodacus.github.io/pithagoras/guide/docker)
  (`pithagoras-docker` 1.3.0 or later), which installing this extension from npm brings along with the portal's
  `requires`. A Linux host with Docker Engine 28.0 or later that the portal can reach, as for any container it runs.
- A reachable Nextcloud — your own server in the home lab as much as a hosted one — and an **app password** for the
  user you log in with: in Nextcloud under **Settings ▸ Security ▸ Devices & sessions**, "Add an app password". The
  app name it asks for can be anything; `pithagoras` is a good one. A personal password works, but an app password is
  the kind that can be revoked on its own when something goes wrong.
- About 150 MB of disk for the image (`ghcr.io/cbcoutinho/nextcloud-mcp-server:v0.202.2`, pulled once, shared by all
  instances).

## Installing

In Settings → Extensions → Discover → Install by name: `npm:@pithagoras/nextcloud`. Then open **Settings → Nextcloud**
and add an instance: its name (the first one stands as `nextcloud`), the host (like `https://cloud.example.org`), the
user name and that app password — and press **Save and apply**. The container starts with them, the server is
registered in pi's config under the instance's own name, and the page's status shows each part: the container (and how
long it has been coming up), the entry in pi's config, and whether the server answers at its `/mcp` address.

The password is written to pi's own settings file once and then never shown again; the field on the page stays empty
while one is saved, and saving with it left empty keeps what was there.

More than one Nextcloud on this machine? Add as many instances as you have — each gets its own container, its own
port at the loopback of the portal's network, and its own entry in pi's config under its name; an agent that reaches a
`nextcloud` tool talks to exactly the instance the registration names. The panel beside your chat shows a switcher
over the instances above its tabs: whichever it holds is what every tab there shows and changes.

Already running this image yourself — with your own name, ports or settings? Adopt that container instead of making a
new one: on the instance's card choose the found container in place of *own*. The extension then only registers the
server in pi's config; it never starts, stops, amends or removes an adopted one, and what you set yourself stays as
you set it.

The settings page also names what the agents may reach: by default each server's mail, news and collectives tools are
kept out of pi's config (its shopping list, cookbook and notes are what this panel works with), and that list is a
plain field — tool-name globs, comma-separated — so you can keep more out or give some back.

**Remove** takes an instance away: its entry in pi's config always goes, and its own container with it — an adopted one
untouched. The settings stay where they were shown on the page, so putting the instance back starts it without typing
anything new. Uninstalling the extension does the same removal for every instance.

## What you get

- **A Nextcloud panel in every chat**, beside the files panel: one place with what your cloud holds, for you and the
  agent that answers there. Its seven tabs, each thin over the MCP server's own tools:
  - **Shopping List** — the lists, their items checked as they are bought (the check is in Nextcloud, so a phone on
    the app sees it at once), new items added at the bottom of the list, items and checked runs removed.
  - **Cookbook** — the recipes with ingredients and steps, searched by name or keyword, and a recipe imported from its
    URL wherever a site has marked it up (schema.org).
  - **Notes** — all the notes, searched as you type, opened for reading, edited and saved back in place.
  - **Files & Sharing** — browse your files, preview images and text and pull a file down; beside it the shares: who
    has what with what permission, new ones added, taken away again, and a short public link made of a path.
  - **Deck** — your boards' stacks and cards by their order, due date and labels; new cards set off at the top of a
    stack, a card's text read and written back.
  - **Calendar** — day by day what stands in which calendar, an event opened for its time, place and note changed or
    gone; beside it the open tasks with their due days, ticked off as they are done.
  - **Contacts** — your address books' contacts searched as you type, a card opened and amended in place, new ones
    added and taken away again.
- **The agents reach your clouds too**: every server is registered in pi's config, persistent, trusted, with nothing
  direct besides what its registration names — so a chat can ask "check the milk off the list" or "what did I note down
  about the fence", and the answer comes from Nextcloud. What it may not reach is exactly the keep-out list above.

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
