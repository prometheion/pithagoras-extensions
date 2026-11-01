/**
 * Builds Nextcloud: its browser half (src/client.tsx) into web/, with the Tailwind utilities its components use made into
 * its own stylesheet from the portal's preset, and its server half (src/server.ts) into server.js. What it makes is not
 * kept in git; `npm pack` runs it first (`prepack`).
 *
 * The server half has no packages of its own beside node: everything it needs comes from the portal's extension API
 * and the pithagoras-docker helper, which it asks for by name at runtime -- so nothing is bundled into server.js but
 * its own source.
 *
 * What it is built with (esbuild, tailwindcss, postcss, the extension API) is the repository's, installed once at its
 * root (`npm ci`).
 */
import path from "node:path";
import { build } from "esbuild";
import { buildExtension } from "@pithagoras/extension-api/build";

const HERE = import.meta.dirname;
await buildExtension({ dir: HERE, tailwind: true });
await build({
  entryPoints: [path.join(HERE, "src", "server.ts")],
  outfile: path.join(HERE, "server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  legalComments: "eof",
  logLevel: "warning",
});
console.log("@pithagoras/nextcloud: built web/ and server.js");
