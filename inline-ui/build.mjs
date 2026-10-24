/**
 * Builds Inline UI: its browser half (src/client.tsx) into web/, with the Tailwind utilities its components use
 * made into its own stylesheet from the portal's preset, and its server half (src/server.ts) into server.js, with the
 * frame it serves each card in (src/server/frame.ts) bundled into it. What it makes is not kept in git; `npm pack` and
 * `npm publish` run it first (`prepack`).
 *
 * What it is built with (esbuild, tailwindcss, postcss, the extension API, the icons) is the repository's, installed
 * once at its root (`npm ci`).
 */
import { buildExtension } from "@pithagoras/extension-api/build";

await buildExtension({ dir: import.meta.dirname, tailwind: true, server: "src/server.ts" });
console.log("@pithagoras/inline-ui: built web/ and server.js");
