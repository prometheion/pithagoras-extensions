import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Chat, ServerPortal } from "@pithagoras/extension-api/server";
import type { CallHooks, Part } from "../../../shared/relay";

/**
 * What the extension does around a call of Blender's tools, in the chat it is made in (shared/relay.ts, `calls`).
 *
 * `render`: the picture is the person's as well as the model's. The server is always asked for it, and it is put in
 * the chat's folder (`RENDERS`, under a name made here, never one the server or the agent chose), which the call
 * names in its `details.files`, as any tool names a file it gave: the chat shows it under the call, in its picture
 * viewer and in voice mode's pictures. The model gets it as before, unless it asked for none (`return_image: false`),
 * and is told where it was put. One that cannot be put there is still the model's, which is told why the chat does
 * not show it.
 */

/** The folder in a chat's folder that Blender's renders are put in, for the chat to show them. */
export const RENDERS = "blender-renders";

/** The code of a refusal of `portal.files` (see FileRefusal), or nothing for another error. */
const refusal = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;

/** A name made here: the time, and something that tells two in one second apart. */
const fileName = (): string => `render-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}-${randomBytes(3).toString("hex")}.png`;

/** The name of the file the server rendered to, from its answer's text (`{"path": "/data/renders/…"}`), for the chat's title. */
function renderedName(parts: Part[]): string | undefined {
  for (const part of parts) {
    if (part.type !== "text") continue;
    try {
      const said = JSON.parse(part.text) as { path?: unknown };
      if (typeof said.path === "string" && said.path) return path.posix.basename(said.path);
    } catch {
      // Not the server's JSON: no title.
    }
  }
  return undefined;
}

export function blenderCalls(portal: ServerPortal): Record<string, CallHooks> {
  /** Writes the picture into the chat's folder, in `RENDERS`, and returns where, from the folder. */
  function keep(chat: Chat, bytes: Buffer): string {
    const base = portal.chats.folder(chat.id);
    try {
      portal.files.makeFolder(base, "", RENDERS);
    } catch (e) {
      if (refusal(e) !== "exists") throw e;
    }
    return portal.files.create(base, RENDERS, fileName(), bytes);
  }

  return {
    render: {
      arguments: (params) => ({ ...params, return_image: true }),
      answer(parts, params, chat) {
        const picture = parts.find((p) => p.type === "image");
        const model = params.return_image === false ? parts.filter((p) => p.type === "text") : parts;
        if (!picture) return { content: model, details: {} };
        let rel: string;
        try {
          rel = keep(chat, Buffer.from(picture.data, "base64"));
        } catch (e) {
          portal.log(`could not put a render in the chat's folder: ${(e as Error).message}`);
          return { content: [...model, { type: "text", text: `The render could not be shown in the chat: ${(e as Error).message}` }], details: {} };
        }
        const title = renderedName(parts);
        return {
          content: [...model, { type: "text", text: `Shown to the person in the chat, and saved in the chat's folder as ${rel}.` }],
          details: { files: [{ path: rel, ...(title ? { title } : {}) }] },
        };
      },
    },
  };
}
