/**
 * Builds Blender: its browser half (src/client.tsx) into web/, with the Tailwind utilities its components use made
 * into its own stylesheet from the portal's preset, and its server half (src/server.ts) into server.js, with what it
 * imports from ../shared and the server's tools (server/tools.json) bundled into it, and the viewer's page
 * (src/viewer.html) beside it, where the server half reads it from. What it makes is not kept in git; `npm pack` and
 * `npm publish` run it first (`prepack`).
 *
 * What it is built with (esbuild, tailwindcss, postcss, the extension API, the icons) is the repository's, installed
 * once at its root (`npm ci`).
 */
import { copyFileSync } from "node:fs";
import path from "node:path";
import { buildExtension } from "@pithagoras/extension-api/build";

const HERE = import.meta.dirname;
await buildExtension({ dir: HERE, tailwind: true, server: "src/server.ts" });
copyFileSync(path.join(HERE, "src", "viewer.html"), path.join(HERE, "viewer.html"));
console.log("pithagoras-blender: built web/, server.js and viewer.html");
