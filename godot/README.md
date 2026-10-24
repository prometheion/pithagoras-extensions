# Godot for Pithagoras

`pithagoras-godot` runs the real Godot 4.7.2 editor in a container on your portal's Docker, rendered on an NVIDIA GPU,
and brings it into Pithagoras in two ways: the agent in every chat gets the editor's 27 tools, and you get the editor's
live screen in a panel beside the chat, where you can watch the agent work and take the mouse and keyboard at any
time. Every edit the agent makes happens in that editor, through its undo history.

Not made or endorsed by the Godot Foundation. "Godot" names what the extension runs.

## What it needs

- Pithagoras 0.2.0 or later.
- **Docker for extensions** (`pithagoras-docker` 1.2.0 or later), which ships with the portal but is not on by
  default. Installing this extension from npm installs or switches it on along with it; installing it from a folder
  does not, and the extension then waits, saying so in Settings → Extensions, until you install Docker for
  extensions from Settings → Extensions → Discover.
- A Linux host with Docker, where the portal runs on the host itself or in a container of its own (Docker for
  extensions shares the portal's network with the server's container).
- For the GPU, an NVIDIA card and the NVIDIA Container Toolkit. Without one, Godot opens Compatibility projects (the
  2D template) with Mesa's software OpenGL and cannot render Forward+ projects.
- The portal over **HTTPS, or opened as `http://localhost`**. The editor's stream decodes with WebCodecs, which
  browsers give only a secure context, and the panel is one only if the portal's page is. Over plain HTTP on another
  name the panel says so and shows how to fix it (`PORTAL_TLS_CERT` and `PORTAL_TLS_KEY`, see the Pithagoras guide's
  [HTTPS section](https://thecodacus.github.io/pithagoras/guide/deploying#https)).

## Installing

In Settings → Extensions → Discover → **Install by name**:

| From | Spec |
|---|---|
| npm | `npm:pithagoras-godot` |
| A built folder, for development | the folder's path on the portal's machine, after `npm run build` in it |

## The first start

Settings → **Godot** → **Install**. The extension downloads its image (`ghcr.io/thecodacus/pithagoras-godot:0.1.0`,
about 0.6 GB unpacked), makes a volume for the projects, makes the container and starts it. The page shows the
download, then the server starting, then the editor's own state ("Editor ready: starter"). The first start makes a
3D project called `starter`; the agent and you make more.

The card: the page lists the NVIDIA cards Docker can give a container, read in a short-lived probe container
(`pithagoras-godot-probe`), with how much of each card's memory is in use. **Automatic** gives a new server the card
with the most free memory and keeps it there; choosing a card moves a running server to it at once (the container is
made again, the projects stay). A host owner can pin the card with `PITHAGORAS_GODOT_GPU`; a pinned card Docker
cannot give (no card by that UUID or index, or no NVIDIA runtime) is said on the page, with Docker's words, and
Install is refused rather than making a container that cannot start.

The screen: 1280 × 720, 1600 × 900 (the default) or 1920 × 1080. The editor fills it, and the panel scales all of it to
fit, so a smaller screen is sharper in a narrow panel. Changing it restarts the editor.

## The panel

The chat's header has a **Godot** button once the server is installed; it shows a dot while one of the Godot tools
runs in that chat. The panel holds the viewer, served by the portal at `/api/x/pithagoras-godot/ui/` behind the
portal's sign-in, so you never sign in to the server. The viewer's page and Selkies' web client (`pages/` in the
package) are the extension's own; what they ask of the server (its API, the downloads, the stream's WebSocket) is
passed on to the container with its token. In it:

- the editor itself, streamed by Selkies: mouse, keyboard and the clipboard in both directions;
- the project menu (the project's name, top left): every project with its renderer, Open, New 2D / New 3D, Upload
  .zip, Download open project, and the open project's latest builds (`export`) and recordings (`record`) to download;
- **Run** and **Stop**: the project's main scene runs in the editor, in a window over it, as the editor's own Play
  button runs it;
- **Activity**: the agent's calls as they happen.

Fullscreen in the panel's head gives it the whole screen. Only one view of the stream is connected at a time: opening
the panel in another chat, tab or device takes it over, and the one that lost it says so, with **Reconnect here**.
Switching chats reconnects the stream (2-3 s).

## The tools

The server's MCP tools are the extension's own tools in every chat, named `godot_` and the server's name:
`godot_ping`, `godot_list_projects`, `godot_new_project`, `godot_open_project`, `godot_restart_editor`,
`godot_list_files`, `godot_read_file`, `godot_write_file`, `godot_delete_file`, `godot_get_scene_tree`,
`godot_open_scene`, `godot_new_scene`, `godot_add_node`, `godot_set_property`, `godot_delete_node`,
`godot_attach_script`, `godot_save_scene`, `godot_reload`, `godot_run_project`, `godot_run_scene`, `godot_stop`,
`godot_get_output`, `godot_check_scripts`, `godot_screenshot`, `godot_record`, `godot_export` and
`godot_execute_gdscript`. Their descriptions, their schemas and the server's MCP instructions (said to the agent
once) are the ones this version of the extension was released with, in `server/tools.json`, which the release's smoke
test holds the image to: never what the running server says of itself, since the agent's code runs in that container.
A tool the server lists that the file does not name is not relayed, and one it names that the server does not list
(an older image) is not offered.

They are on in every chat by default. Settings → Tools lists them under **pithagoras-godot**, where the group or a
single tool can be switched off, or made lazy (offered through the `tools` tool instead of in every request: the 27
cost about 3k tokens a request), for the whole portal, an agent, a project or a mode. They leave every chat when the
extension is switched off or removed, and while the server is not installed.

`godot_screenshot` and `godot_record` return a picture, which reaches the model as a picture (a model that sees
pictures, `input: ["text", "image"]`). The chat's card of the call shows its text; the picture is what the panel
shows.

Don't add an MCP server named `godot` beside this extension: its tools would have the same names.

## Security

- **What the agent's code runs as.** The container runs as the image's own user (`godot`, uid 10001), not root, with
  no Linux capabilities at all (`CapDrop: ALL`) and `no-new-privileges`: the server, Xvfb, Selkies, the editor, the
  games and the agent's GDScript alike. The image's files (the server, Selkies, Godot) are root's and cannot be
  changed from inside. The server runs Python in isolated mode (`-I`, so nothing written under its home is imported
  at its next start) and keeps its own process from the others of its user (`PR_SET_DUMPABLE` 0: none can attach to
  it or read its memory or its environment). It takes the stream's Unix socket only from the Selkies it started (the
  listener's process has to be in that Selkies' session), so code in the container cannot put a server of its own
  in Selkies' place.
- **What it reaches.** The container is in the portal's network namespace. For a portal run in Docker that is the
  portal container's loopback: the portal itself, the other extensions' servers there, and the internet as the
  portal reaches it. For a portal run on the host itself it is the host's network: every service listening on the
  host's loopback, the local network, and the internet. That is what `godot_execute_gdscript`, a `@tool` script or a
  game reaches, as the agent's own shell does in a portal without the sandbox. A private network between the portal
  and an extension's server would narrow this; Pithagoras 0.2.0 has none. The server's token is in the container's
  environment, which code there can read (the init process is the same user's): with it, that code can call the
  server it already runs in, nothing more.
- **Nothing it serves runs on the portal's origin.** The viewer and Selkies' web client come from the package, and
  the server sends no page: what it answers is JSON, files to download (served with `sandbox`, and as attachments
  but for pictures and videos), and the stream's frames. Web builds are files to download, not pages served there:
  a web export runs the project's code, and Godot's JavaScriptBridge lets a game run any script in the page. The image's
  build stops unless the Selkies in it has the web client the package serves (`server/selkies-web.sha256`).
- **One credential.** A token made at random when the server is first installed (24 bytes), kept in the extension's
  own folder (`settings.json`, mode 0600, which only the portal's user can open), and given to the container. Every
  route of the server but `/healthz` asks for it as `Authorization: Bearer`. The portal's proxy adds it; no page is
  given it. There is no password, default or otherwise.
- **Loopback only.** The container shares the portal's network namespace (Docker for extensions' `sharedNetwork`: the
  host's for a portal on the host, the portal container's otherwise) and publishes nothing. The server listens on
  127.0.0.1. Selkies listens on a Unix socket in a folder only the server can open, and the X display is the
  container's own (`-nolisten local`). The editor's own listeners (its bridge plugin, with a secret of its own per
  start, the GDScript language server, the debug adapter and the debugger) take free loopback ports at each start.
- **Through the portal.** Every route of the extension is behind the portal's sign-in, and any of them that changes
  something (Install, Start, Stop, Remove, the card, the screen, and every write the viewer makes) is refused unless it
  comes from the portal's own pages, by its Origin or `Sec-Fetch-Site: same-origin`: the portal's cookie is
  SameSite=Lax, which a page on another port of the same address is still sent. The proxy sends the server the request
  without the portal's cookie and the page's own credentials, adds the token, lets only the portal frame the answers
  (`frame-ancestors 'self'`), adds `nosniff`, and passes no cookie the container sets.
- **The tools run code, and say only what the package says.** `godot_execute_gdscript` runs GDScript in the editor;
  written scripts load at once and `@tool` scripts run in the editor; every game is a program. Every Godot tool's
  result is outside content to the guard, and once a conversation has read a result the guard flags as a likely
  prompt injection, it holds `godot_write_file`, `godot_attach_script`, `godot_run_project`, `godot_run_scene`,
  `godot_record` and `godot_execute_gdscript` as uploads: it asks you first, or refuses where nobody can answer. What
  the model is told of the tools, and the instructions in every chat's prompt, are the package's (`server/tools.json`),
  never what the running server says of itself.
- **Who can use it.** Everyone signed in to the portal can use the panel, and drive the editor from it.
- **The other direction.** A process in the portal's network namespace can reach the server's port, but not without
  the token. With the sandbox on, agents run as users of their own and cannot read it; with it off, the agent runs as
  the portal's user and could.

## Data

Projects, builds, recordings and the editor's settings are in the Docker volume `pithagoras-godot-data` at `/data` in
the container:

| In the volume | |
|---|---|
| `projects/<name>/` | the projects (each gets the editor plugin `addons/godot_mcp_bridge`) |
| `exports/<name>/web/`, `exports/<name>/linux/` | the latest build of each kind |
| `renders/<name>/<time>/` | recordings: `movie.mp4` and `preview.jpg`, or the PNG frames |
| `home/` | the editor's settings |

To back it up, for example: `docker run --rm -v pithagoras-godot-data:/data -v "$PWD":/out ubuntu tar czf /out/godot-backup.tgz /data`.

## Settings the portal's environment can change

| Variable | Default | |
|---|---|---|
| `PITHAGORAS_GODOT_CONTAINER` | `pithagoras-godot` | the container's name; the probe is `<name>-probe` |
| `PITHAGORAS_GODOT_VOLUME` | `<container>-data` | the projects' volume |
| `PITHAGORAS_GODOT_PORT` | `3880` | the server's port on the portal's loopback |
| `PITHAGORAS_GODOT_IMAGE` | `ghcr.io/thecodacus/pithagoras-godot:<version>` | another image, such as one built locally |
| `PITHAGORAS_GODOT_GPU` | | a card's UUID or index: the only card the server is given |

They are for a second portal on the same Docker daemon, for tests, and for a host owner who keeps the server off a
card or a port.

## Removing it

**Remove** on the Settings page first, then uninstall the extension: the container is restarted by Docker unless
stopped (`unless-stopped`), and outlives the extension, which has no say once it is uninstalled. Remove asks whether to
delete the projects too. The image stays on disk, as other containers may use it: `docker image rm
ghcr.io/thecodacus/pithagoras-godot:0.1.0` deletes it.

## Limits

- One editor serves every chat and you: agents in two chats work in the same open project, and nothing locks.
- One view of the stream at a time; the panel's frame reloads, and the stream reconnects, on every chat switch.
- A modal dialog in the editor blocks the agent's calls until someone answers it in the panel; `godot_restart_editor`
  clears it.
- No window manager: a game opens as a window over the editor, not in the editor's Game tab.
- The stream is encoded on the CPU (x264): NVENC wants the first GPU's device node, which a container that sees only
  another card does not have.
- Port 3880 on the portal's loopback (the host's, for a portal on the host): a port in use shows as the server failing
  to start, with "Address already in use" in its log; `PITHAGORAS_GODOT_PORT` moves it.
- An upload must arrive within Node's request timeout (300 s): about 3 GB at 10 MB/s, less on a slow link; the
  server takes up to 2 GB.
- After a host restart with the portal in Docker, Docker may start this container before the portal's; the page then
  shows it failed, and Start makes it again on the portal's network.
- When the portal's container is made again (an update), the server's container is made again on the new one's
  network at the half's first look; when it restarts under the same id (Settings → About → Restart, or Docker
  restarting it), the server's container is started again in the portal's new network namespace. Either way the
  editor starts again: what was not saved in the open scenes is lost, as nothing could reach the old one to save it.
- Only Chrome is tested.

## Licences

The extension's own code (TypeScript, the viewer `pages/viewer.html`, the stream page's shim
`pages/stream/__gs_shim.js`, the server `server/server.py`, the end-to-end client `server/client.py` and the editor
plugin `server/addon/godot_mcp_bridge`) is under the Apache License 2.0 (see LICENSE and NOTICE). The plugin is copied
into each project the server opens, and is Apache-2.0 there; Godot is MIT, so a project and its plugins may be under any
licence.

The npm package contains no Godot. It does contain Selkies 2.1.0's web client, unchanged (`pages/stream`: the files
of `selkies/selkies_web` that the stream page loads, its index.html served with one script tag added for the shim),
under the Mozilla Public License 2.0, whose text is beside it (`pages/stream/LICENSE`); its source is Selkies' own at
https://github.com/selkies-project/selkies/tree/2.1.0.

The image it runs redistributes, unchanged: Godot 4.7.2 (MIT, with the third-party notices of its COPYRIGHT.txt),
Selkies 2.1.0 (MPL-2.0) with the Python packages of its own environment, each under its own licence in its
dist-info folder; among them pixelflux 2.2.1 (MPL-2.0, bundling libx264 and x265, GPL-2.0-or-later, so that combined
binary is under the GPL, and libde265, LGPL-3.0-or-later) and pcmflux 2.2.0 (MPL-2.0, bundling AlmaLinux 8 builds of
libpulse, libsndfile, libsystemd, libgcrypt and other libraries under LGPL-2.1-or-later, each a separate shared
library); VirtualGL 3.1.5 (the wxWindows Library Licence 3.1); and Ubuntu 24.04 packages, each under its own licence.
The image carries the licence texts and a NOTICE in `/usr/share/doc/pithagoras-godot`, and each release that publishes
an image attaches the sources the GPL and the LGPL ask for that are not in Ubuntu's archive (pixelflux and the x264,
x265 and libde265 it was built from; pcmflux and the AlmaLinux source RPMs of the LGPL libraries it bundles;
VirtualGL), with the list of Ubuntu packages and versions in the image. See `server/NOTICE`.

## Building it

```sh
npm ci                     # in the repository's root: the workspace's tools
npm run build -w godot     # web/ and lib/server.js
npm test -w godot          # the unit tests
```

The image: `server/fetch-assets.sh` fetches and checks what it is built from into `server/assets/` (the Godot editor
and export templates, Selkies and VirtualGL packages, licence texts; it needs curl and bsdtar, `libarchive-tools` on
Debian and Ubuntu), then `docker build server/`. The release workflow does both, tests the image
(`server/smoke-test.sh`, which runs it as the extension does, and holds its tools and instructions to
`server/tools.json`), and publishes it before the package.

Selkies' web client in `pages/stream` is copied unchanged from Selkies' .deb (`selkies/selkies_web`), and
`server/selkies-web.sha256` lists its files: the image's build checks the Selkies it installs against the list, and a
unit test checks `pages/stream` against it. Moving Selkies means copying the new client there and writing the list
again.
