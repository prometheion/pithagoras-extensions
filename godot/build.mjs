/**
 * Builds the Godot extension: its browser half (src/client.tsx) into web/, with the Tailwind utilities its components
 * use made into its own stylesheet from the portal's preset, and its server half (src/server.ts) into lib/server.js,
 * with the repository's shared server modules (../shared) and the server's tools (server/tools.json) bundled into it.
 * What it makes is not kept in git; `npm pack` and `npm publish` build first (prepack).
 *
 * The server half is built as buildExtension builds one, into lib/ rather than beside package.json: there it is one
 * folder below the package, as src/server.ts is, so both find the pages it serves (pages/: the viewer, and Selkies'
 * web client in pages/stream) at ../pages, as they are in the repository and in the package.
 */
import path from "node:path";
import { build } from "esbuild";
import { buildExtension } from "@pithagoras/extension-api/build";

const HERE = import.meta.dirname;
await buildExtension({ dir: HERE, tailwind: true });
await build({
  entryPoints: [path.join(HERE, "src", "server.ts")],
  outfile: path.join(HERE, "lib", "server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Its packages are imported where it runs, from its own node_modules: a native one cannot be bundled.
  packages: "external",
  legalComments: "eof",
  logLevel: "warning",
});
console.log("@pithagoras/godot: built web/ and lib/server.js");
