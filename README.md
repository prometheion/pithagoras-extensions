# Pithagoras-Extensions
A wild collection of extensions for the Pithagoras Agent.

Each extension here is for [Pithagoras](https://github.com/thecodacus/pithagoras), lives in a folder of its own and is
a separate npm package. You install the ones you want into your portal; nothing here is installed by default.

## Extensions

- [Blender](blender/README.md) (`@pithagoras/blender`): a headless Blender 5.2 in a container on the portal's Docker
  host, its tools in every chat, and its live viewport in a panel beside the chat.
- [Godot](godot/README.md) (`@pithagoras/godot`): the real Godot 4.7 editor on the GPU, run in a container through
  Docker for extensions, its 27 tools in every chat and its live screen in a panel beside the chat.
- [On-demand UI](ondemand-ui/README.md) (`@pithagoras/ondemand-ui`): the agent shows you an interactive card of its
  own HTML in the chat, sandboxed and with no network, and what you do in it comes back to the agent as events. It
  needs no container and no Docker.

Blender and Godot each run their server in a container that the extension makes through Docker for extensions, from an
image tagged with the package's version, so an update of the extension updates its server too. The agent gets the
server's tools as the extension's own tool group, and the panel reaches the server through the portal's sign-in, so
nobody signs in to anything else.

## What they need

Blender and Godot (On-demand UI's README says what it needs):

- Pithagoras 0.3.0 or later.
- [Docker for extensions](https://thecodacus.github.io/pithagoras/guide/docker) (`pithagoras-docker` 1.3.0 or later).
  It ships with the portal but is not on by default; installing one of these extensions from npm brings it along.
- A Linux host with Docker Engine 28.0 or later that the portal can reach. For the GPU, an NVIDIA card and the NVIDIA
  Container Toolkit. Without one, Blender renders on the CPU, and Godot opens Compatibility projects with Mesa's
  software OpenGL but cannot render Forward+ projects.
- For Godot, the portal over HTTPS or opened as `http://localhost`: the editor's stream decodes with WebCodecs, which
  browsers give only a secure context. Over plain HTTP on another name the panel says so; the Pithagoras guide's
  [HTTPS section](https://thecodacus.github.io/pithagoras/guide/deploying#https) shows how to turn it on
  (`PORTAL_TLS_CERT` and `PORTAL_TLS_KEY`).

Each server runs on a network of its own that has no way out: code the agent runs in Blender or Godot reaches neither
the host, its loopback, the local network nor the internet. The portal reaches the server through Docker for
extensions: for a portal on the host's network (both of Pithagoras' Compose files), through a small forwarder
container that publishes the server's port on 127.0.0.1; for a portal in a container on a network of its own, by
putting that container on the server's network. Each extension's README says more under Security.

## Installing

In the portal, Settings → Extensions → Discover → **Install by name**: `npm:@pithagoras/blender`,
`npm:@pithagoras/godot` or `npm:@pithagoras/ondemand-ui`. For Blender and Godot, then open Settings → Blender (or Godot)
and press **Install**: the extension picks a card, downloads its image (`ghcr.io/prometheion/pithagoras-blender` or
`ghcr.io/prometheion/pithagoras-godot`, tagged with the package's version), makes a volume for the projects and starts
the container.

For development, build the repository (below) and install an extension's folder by its path on the portal's machine,
for example `/path/to/pithagoras-extensions/blender`. Installed from a folder, an extension does not bring Docker for
extensions along; it waits until that is installed and on.

## Building

An extension here is built like any Pithagoras extension, against
[`@pithagoras/extension-api`](https://github.com/thecodacus/pithagoras/tree/main/packages/extension-api). See the
Pithagoras docs on extensions for the browser half, the server half and the slots they can fill.

The extensions are npm workspaces of this repository:

```sh
npm ci                     # what every extension is built and tested with
npm run build              # each extension's browser and server halves
npx playwright install chromium firefox   # once: On-demand UI's card is tested in both
npm test                   # the unit tests, with Docker, the portal and the server faked
./scripts/pithagoras.sh    # Pithagoras at the extension API's version (or PITHAGORAS_REF), into .pithagoras/
PITHAGORAS_DIR=$PWD/.pithagoras npm run test:portal   # the portal-tier tests
```

`shared/` holds the server-half modules both extensions use (Docker for extensions' types, settings, a container's
lifecycle, the GPU probe, an MCP client, the tool relay and the proxy). A build bundles what an extension imports of
it into its server half's one file, so a published package needs nothing beside it.

A release is a tag, `blender-v<version>`, `godot-v<version>` or `ondemand-ui-v<version>`, matching the version in that
extension's `package.json`. Merging a pull request that changes that version releases it: the extension's release
workflow (`.github/workflows/blender-release.yml`, `godot-release.yml` or `ondemand-ui-release.yml`) runs on the push to
main, puts the tag on the merged commit and pushes it, and a push to main whose version already has its tag releases
nothing. A tag pushed by hand still makes a release. For Blender and Godot the workflow builds and smoke-tests the
image, pushes it to GHCR and makes a GitHub release with the sources that go with the image; for On-demand UI, which has
no image, it builds and tests the package and makes the GitHub release. Each then publishes the package to npm under the
`@pithagoras` scope, through npm's trusted publishing for that workflow, with no token. The first version of a package
is published by hand, as only a package that is there can be given a trusted publisher; the workflow's header says how.
If the repository or the organization is given a tag ruleset that limits who may create `*-v*` tags, github-actions[bot]
(the GitHub Actions app) has to be on its bypass list, or the workflow's push of the tag is refused. Each extension's
README says how to build its image by hand.

## Licences

Apache-2.0 ([LICENSE](LICENSE)), with two exceptions:

- `blender/server/server.py`, which runs inside Blender and is GPL-3.0-or-later
  ([blender/server/LICENSE](blender/server/LICENSE)).
- The files in `godot/pages/stream/` other than `__gs_shim.js`. They are Selkies 2.1.0's web client, copied
  unchanged, and are MPL-2.0 ([godot/pages/stream/LICENSE](godot/pages/stream/LICENSE)). The `@pithagoras/godot`
  package ships them.

Each extension's README and NOTICE say under which licences what its image redistributes is, and where their sources
are.
