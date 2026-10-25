/**
 * Builds Office: its browser half (src/client.tsx) into web/, with the Tailwind utilities its components use made into
 * its own stylesheet from the portal's preset, and its server half (src/server.ts) into server.js, with jszip (the
 * blank document templates) bundled into it, so the published package needs nothing installed beside it. What it makes
 * is not kept in git; `npm pack` and `npm publish` run it first (`prepack`).
 *
 * What it is built with (esbuild, tailwindcss, postcss, the extension API, the icons, jszip) is the repository's,
 * installed once at its root (`npm ci`).
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
  // jszip is CommonJS and requires Node's own modules: ESM has no `require` for them to use.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  legalComments: "eof",
  logLevel: "warning",
});
console.log("@pithagoras/office: built web/ and server.js");
