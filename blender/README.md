# Blender for Pithagoras

`pithagoras-blender` runs a headless [Blender](https://www.blender.org) 5.2 in a container on the portal's Docker host,
gives every chat its tools, and shows its live viewport in a panel beside each chat. The agent builds scenes with
Blender's Python API, checks them with a quick preview and renders them with Cycles on the GPU; the pictures come back
to the model as pictures. The person watches, orbits and renders in the panel, through the portal, without signing in
to anything else.

This extension is not made or endorsed by the Blender Foundation. "Blender" names what it runs.

## What it needs

- Pithagoras 0.3.0 or later.
- [Docker for extensions](https://thecodacus.github.io/pithagoras/guide/docker) (`pithagoras-docker` 1.3.0 or later).
  It ships with the portal but is not on by default; installing this extension from npm brings it along.
- A Linux host with Docker Engine 28.0 or later, which the portal can reach (its socket): the server's network has no
  gateway, which older Docker cannot make. For GPU rendering, an NVIDIA card and the NVIDIA container toolkit. Without
  one, Blender renders on the CPU.
- About 1.2 GB of disk for the image (two builds of 0.1.0 measured 1.14 and 1.24 GB; each release reports its own), and
  room for the projects.

## Installing

In Settings → Extensions → Discover → Install by name: `npm:pithagoras-blender`. The portal says that it brings Docker
for extensions along where that is not on yet.

For development, build it (`npm ci && npm run build` at the repository's root) and install the folder by its path, for
example `/path/to/pithagoras-extensions/blender`. It then waits until Docker for extensions is installed and on.

## The first start

Open Settings → Blender and press **Install**. The extension:

1. finds the cards Docker can give a container, with a short-lived probe container (`<container>-probe`, from
   `ubuntu:24.04`) that runs `nvidia-smi` and looks for the driver's OptiX weights (`nvoptix.bin`);
2. downloads its image, `ghcr.io/prometheion/pithagoras-blender:<version>`, with the progress on the page;
3. makes the volume `pithagoras-blender-data`, the network `pithagoras-blender-net` and the container
   `pithagoras-blender` on it, starts it, and opens the portal's way to it (below, under Security).

The card is the one with the most free memory unless you choose one on the page; the server stays on its card after
that until you choose another. Choosing another card makes a running server again on it at once, and a stopped one at
its next start. The page shows the denoiser the viewport uses: OptiX where the driver's weights are there (bound into
the container from the host where the container toolkit does not mount them), else OpenImageDenoise.

The container is started again by Docker after it exits and when the host starts (restart policy `unless-stopped`),
unless it was stopped on the page or in Settings → Docker, which it then stays. The extension never starts a server
somebody stopped.

It runs on a network of its own, `pithagoras-blender-net`. When the portal's container is made again or restarted, the
server goes on as it was: the extension puts the portal back on the network as it looks after the server.

## The panel

Each chat has a **Blender** button in its header once the server is installed; it shows a dot while one of Blender's
tools runs in that chat. The panel holds the viewer, the extension's own page, which shows what Blender says, in the
portal's language:

- the live viewport, rendered by Blender from where you look: drag to orbit, right-drag or Shift-drag to pan, scroll to
  zoom; Solid (Workbench), Material preview and Rendered (Cycles, denoised). It follows the agent: it is rendered
  again after each of its changes, also one that failed half way, and between the steps of a long script that calls
  `refresh_view()`. While Blender is busy with something that holds its frames back, the view says what and for how
  long, over the picture from before;
- the scene camera's preview and the last render, the timeline of the scene's frame range, and a picker for an
  object's actions;
- the outliner and the render panel, folded at first in a narrow panel (T and N, as in Blender);
- the projects menu: open, create, save, save as, upload a `.blend` and download the open one.

**Fullscreen** in the panel's head shows it on the whole screen. The panel is drawn anew when you switch chats, so
only its orbit camera starts over.

## The tools

The server's MCP tools, as tools of the extension's own, in every chat:

| Tool | What it does |
| --- | --- |
| `blender_ping` | Blender's version, the GPU devices and the open file |
| `blender_get_scene_info` | The scene: engine, resolution, frame range, up to 200 objects |
| `blender_get_object_info` | One object: transform, materials, mesh |
| `blender_execute_code` | Python with `bpy` in Blender, printing what it prints |
| `blender_preview` | A quick Workbench render, returned as a picture |
| `blender_render` | A full render (Cycles, EEVEE or Workbench), saved and returned as a picture |
| `blender_export` | Exports the scene: glb, gltf, fbx, obj, usd or stl |
| `blender_list_projects`, `blender_open_file`, `blender_save_file`, `blender_new_scene` | The projects in `scenes/` |

They are on by default. Settings → Tools lists them under **pithagoras-blender**, where they can be switched off or made
lazy for every chat, and each chat, agent, project or mode can switch them its own way. Their descriptions and the
instructions cost about 0.8k tokens in every request. Switched off or uninstalled, the extension's tools leave every
list and every chat.

What the model is told of them comes with the extension (`server/tools.json`), not from the running server: Blender runs
code the agent writes, so nothing the server says of itself goes into a chat's prompt. The server is only asked to run
a call. Where what it lists differs from the extension's own (an image of another version), the portal's log says so.

Don't add an MCP server named `blender` beside it: its tools would have the same names.

## Security

- **One credential.** The server takes a token, made once for this install (24 random bytes) and kept in the
  extension's own folder in the portal's data folder (`settings.json`, readable by the portal's user alone). Every
  request to the server carries it; no page is ever given it, and there is no default.
- **A network of its own.** The container is on `pithagoras-blender-net`, which Docker for extensions makes internal
  and with no gateway (gateway mode `isolated`): nothing on it reaches the host, the local network or the internet,
  and nothing but the portal reaches it. The server listens on 0.0.0.0 of that network. For a portal on the host's
  network, the forwarder `pithagoras-blender-forward` publishes port 3870 on 127.0.0.1 and passes it on; for a portal
  in a container of its own, that container is on the network.
- **An unprivileged Blender.** Blender runs as the image's own user (`blender`, uid 10001), not root, with none of the
  kernel's capabilities (`--cap-drop ALL`, raw sockets among them) and no way to gain more (`no-new-privileges`). It
  can write its home, `/tmp` and `/data`; the server and Blender itself are root's.
- **Behind the portal's sign-in.** The viewer is served through the portal at `/api/x/pithagoras-blender/ui/`, which only
  a signed-in person reaches. Everyone signed in to the portal can use the panel. The proxy drops the portal's cookie
  and any credential the page sent, adds the token, passes no cookie back, and adds `frame-ancestors 'self'` and
  `nosniff`.
- **Nothing of Blender's runs as the portal.** Blender runs code the agent writes, in the process that answers the
  viewer, so that code can change what the server answers. The viewer's page is the extension's own, from its package;
  every answer of the server's is sandboxed (`Content-Security-Policy: sandbox`), so that one opened as a page of its
  own runs no script, in an origin of its own, with no way to the portal's API. The viewer reads the server's answers as data and
  escapes everything it puts in the page: a render's path is the agent's choice.
- **Changes only from the portal's pages.** Every request of the extension's that changes something (install, start,
  stop, remove, the card, and everything the viewer asks of the server but a read) is refused unless it comes from the
  portal's own pages: the portal's cookie is SameSite=Lax, which a page on another port or another name of the same
  site is still sent.
- **The tools.** What they return is outside content to the guard. `blender_execute_code` runs code in Blender, so after
  a suspected prompt injection the guard asks you before it runs, or refuses it where nobody can answer. That code
  reaches nothing outside the container but the forwarder's port, which leads back to the server itself (section above);
  for a portal in a container of its own, also what is listened for on 0.0.0.0 in that container's network namespace:
  the portal's own port, which asks for its sign-in, and Understory's (3800), which shares the namespace and asks for its
  token. It can still read and change the projects, and what it prints comes back to the chat, which is why the guard
  holds it.

## Data

Projects (`scenes/`), renders, exports and previews are in the Docker volume `pithagoras-blender-data`, mounted at
`/data`. A backup, as an example:

```sh
docker run --rm -v pithagoras-blender-data:/data -v "$PWD":/out ubuntu:24.04 tar czf /out/blender-backup.tgz /data
```

## Settings from the environment

The portal's environment can change each name, for a second portal on the same Docker host or for a test:

| Variable | Default |
| --- | --- |
| `PITHAGORAS_BLENDER_CONTAINER` | `pithagoras-blender` (the probe is `<container>-probe`, the network `<container>-net`, the forwarder `<container>-forward`) |
| `PITHAGORAS_BLENDER_VOLUME` | `<container>-data` |
| `PITHAGORAS_BLENDER_PORT` | `3870`: the server's port, and for a portal on the host's network the forwarder's on 127.0.0.1 |
| `PITHAGORAS_BLENDER_IMAGE` | `ghcr.io/prometheion/pithagoras-blender:<version>` |
| `PITHAGORAS_BLENDER_GPU` | none: a card's UUID or index pins the server to it, and the page shows only that card |

## Removing

Remove the server on the page first (**Remove**, optionally with the projects), then uninstall the extension: the
portal has no uninstall hook, so a container left running keeps running. Remove also removes the network and the
forwarder. Docker for extensions cannot remove an image, so the image stays on disk: `docker image rm
ghcr.io/prometheion/pithagoras-blender:<version>` deletes it.

## Limits

- One Blender serves every chat and you: agents in two chats work on the same open scene, and nothing locks.
- The card's memory is shared with whatever else uses it; a big scene can run out while a model is loaded there.
- An upload through the panel has to arrive within Node's request timeout (300 s): about 3 GB at 10 MB/s.
- A call the agent stops ends the request; Blender finishes what it was doing.
- The chat's card of a call shows the tool's name; Blender's own words for each call (in English and German) are on
  voice mode's cards.
- Each update of the extension leaves the previous image on disk until it is removed by hand.
- Nothing in the container reaches the internet: Blender's online extensions, and code that downloads (a texture from
  a URL), do not work there. Bring files in with the panel's upload.

## Licences

- The extension (its TypeScript, the viewer page `src/viewer.html`, its build and its Dockerfile): Apache-2.0, as the
  rest of this repository.
- `server/server.py` runs inside Blender and uses its Python API, so it is licensed under the GNU General Public License,
  version 3 or any later version ([server/LICENSE](server/LICENSE)), as Blender asks of published scripts.
- The image redistributes the official Blender 5.2.2 build (source GPL-2.0-or-later with parts under other licences,
  binaries GPL-3.0-or-later), which links in libraries of other projects, among them FFmpeg built with x264 and x265
  (GPL as a whole) and others under the GPL, the LGPL or the MPL, and Ubuntu 24.04 packages. Every release that
  publishes an image attaches Blender's source, the source of each of those copyleft libraries as Blender's official
  build fetched it, checked against the hash Blender pins (`scripts/blender-sources.sh`), and a list of the image's
  packages. [NOTICE](NOTICE) says what is in the image and where its sources are; it is in the image at
  `/usr/share/doc/pithagoras-blender/NOTICE`.

## Building and testing

```sh
npm ci                     # at the repository's root
npm run build -w blender   # web/, server.js and viewer.html
npm test -w blender        # unit tests, with Docker, the portal and the server faked
./scripts/pithagoras.sh    # Pithagoras v0.2.0 into .pithagoras/, for the portal-tier tests
PITHAGORAS_DIR=$PWD/.pithagoras npm run test:portal -w blender
docker build -f blender/server/Dockerfile -t pithagoras-blender:dev blender   # the image
./scripts/smoke-blender.sh pithagoras-blender:dev                              # its smoke test
./scripts/viewport-blender.py pithagoras-blender:dev                           # its live view, against the agent's code
```

`server/tools.json` is what the server lists (`tools/list`) and its MCP instructions, which the extension registers in
every chat; the release's smoke test compares the image with it, so a change to the server's tools changes that file,
the label and guard tables in `src/labels.ts` and the labels' German.
