/**
 * Builds Saga: its browser half (src/client.tsx) into web/, with the Tailwind utilities its components use made into
 * its own stylesheet from the portal's preset, and its server half (src/server.ts) into server.js. What it makes is
 * not kept in git; `npm pack` and `npm publish` run it first (`prepack`).
 */
import { buildExtension } from "@pithagoras/extension-api/build";

await buildExtension({ dir: import.meta.dirname, tailwind: true, server: "src/server.ts" });
console.log("@pithagoras/saga: built web/ and server.js");
