# Nextcloud for Pithagoras

`@pithagoras/nextcloud` brings your [Nextcloud](https://nextcloud.com) into Pithagoras: the extension runs the
[Nextcloud MCP server](https://github.com/cbcoutinho/nextcloud-mcp-server) in its own container through Docker for
extensions, registers that server in pi's MCP config so every agent can reach your cloud, and adds a Nextcloud tab to
every chat with three working panels — **Shopping List**, **Cookbook** and **Notes** — plus the places of what comes in
the next phase (Files & Sharing, Deck, Calendar, Contacts).

This extension is not made or endorsed by Nextcloud GmbH. "Nextcloud" names the service it talks to.

## What it needs

- Pithagoras 0.3.0 or later and [Docker for extensions](https://thecodacus.github.io/pithagoras/guide/docker)
  (`pithagoras-docker` 1.3.0 or later), which installing this extension from npm brings along with the portal's
  `requires`. A Linux host with Docker Engine 28.0 or later that the portal can reach, as for any container it runs.
- A reachable Nextcloud — your own server in the home lab as much as a hosted one — and an **app password** for the
  user you log in with: in Nextcloud under **Settings ▸ Security ▸ Devices & sessions**, "Add an app password". The
  app name it asks for can be anything; `pithagoras` is a good one. A personal password works, but an app password is
  the kind that can be revoked on its own when something goes wrong.
- About 150 MB of disk for the image (`ghcr.io/cbcoutinho/nextcloud-mcp-server:0.202.2`, pulled on the first start).

## Installing

In Settings → Extensions → Discover → Install by name: `npm:@pithagoras/nextcloud`. Then open **Settings → Nextcloud**
and fill in the three fields — the host (like `https://cloud.example.org`), the user name and that app password — and
press **Save and apply**. The container starts with them, is registered in pi's config under the name `nextcloud`, and
the page's status shows each part: the container (and how long it has been coming up), the entry in pi's config, and
whether the server answers at its `/mcp` address.

The password is written to pi's own settings file once and then never shown again; the field on the page stays empty
while one is saved, and saving with it left empty keeps what was there. What a container reads is set only while the
portal is up: an older container started before this extension was installed is taken over on the first start, and a
container that stops of its own — the portal's host losing Docker, say — is found again or rebuilt, not reported as
gone.

The settings page also names what the agents may reach: by default the server's mail, news and collectives tools are
kept out of pi's config (its shopping list, cookbook and notes are what this extension works with), and that list is a
plain field — tool-name globs, comma-separated — so you can keep more out or give some back.

**Remove** takes the container and its entry in pi's config away; the settings stay, so **Save and apply** puts it all
back again without typing anything. Uninstalling the extension does the same removal.

## What you get

- **A Nextcloud tab in every chat**, beside the files panel: one place with what your cloud holds, for you and the
  agent that answers there. Its three panels today, each thin over the MCP server's own tools:
  - **Shopping List** — the lists, their items checked as they are bought (the check is in Nextcloud, so a phone on
    the app sees it at once), new items added at the bottom of the list, items and checked runs removed.
  - **Cookbook** — the recipes with ingredients and steps, searched by name or keyword, and a recipe imported from its
    URL wherever a site has marked it up (schema.org).
  - **Notes** — all the notes, searched as you type, opened for reading, edited and saved back in place.
- **The agents reach your cloud too**: the same server is registered in pi's config under `nextcloud`, persistent,
  trusted, with nothing direct besides what that registration names — so a chat can ask "check the milk off the list"
  or "what did I note down about the fence", and the answer comes from Nextcloud. What it may not reach is exactly the
  keep-out list above.

## How it runs

One container, `pithagoras-nextcloud-mcp`, on the portal's shared network: inside its own namespace, reachable by the
portal at `127.0.0.1` and not from the machine around it, with the image pinned to the release this version was built
against and the host, user name and password given as its environment. The extension is that container's owner: it is
created on the first save, taken over when found (its label says whose it is), rebuilt when the host or the user name
has changed — a new password goes in with a restart instead — and removed again when the extension goes away. Nothing
of what you have in your cloud lives inside it; it only speaks to the Nextcloud behind the address you gave it.
