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
 *
 * `execute_code` with a `path`: a script in the agent's own files, which it writes once and edits there, run in
 * place of code written inline. The file is read here, in the portal, as the chat's agent (`likeParent` for that
 * chat: what the sandbox closes to the agent is refused, as is anything outside the chat's folder), before the guard
 * looks at the call (`prepare`), which is then the script's text, as `code`, and its path in the chat's folder
 * (`script_name`), the name it runs under on the server, so that an error names the file and the line. So what the
 * guard holds the call to, and what the person is shown when it asks them about it after a suspected prompt
 * injection, is the code that runs and its args, not the name of a file that may say anything by the time it runs.
 * The container never mounts the agent's files, and reads none of them.
 *
 * Shown no path, the guard does not hold the call to what it keeps by a path's name from somebody who is not the
 * primary user (a place secrets are kept: `.env`, `.ssh/`, `.secrets/`, `auth.json`, a `token` or `credentials` file;
 * the primary user's private notes). So a script is a .py file, in no hidden folder and with no hidden name, which
 * none of those is.
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

/** Whether a path in the chat's folder, relative to it, is one of a script that is run: see above. */
const runnable = (rel: string): boolean => rel.endsWith(".py") && !rel.split(path.sep).some((name) => name.startsWith("."));

/**
 * Where `given` is in the chat's folder `base`, relative to it: a path relative to the folder, or absolute inside it,
 * as it really is or as the chat names it (`workspace`, which can reach it through a link). Nothing for a path
 * outside it, or the folder itself.
 */
function inFolder(chat: Chat, base: string, given: string): string | undefined {
  const below = (root: string, at: string) => {
    const rel = path.relative(root, at);
    return rel && rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel) ? rel : undefined;
  };
  return below(base, path.resolve(base, given)) ?? below(path.resolve(chat.workspace), path.resolve(chat.workspace, given));
}

export function blenderCalls(portal: ServerPortal): Record<string, CallHooks> {
  /** The script `given`, read as the chat's agent would read it: its path in the chat's folder, and its text. */
  function script(chat: Chat, given: string): { rel: string; text: string } {
    const base = portal.chats.folder(chat.id);
    const rel = inFolder(chat, base, given);
    if (!rel) throw new Error(`${given} is not in this chat's folder: only a script there can be run. Save it there first.`);
    if (!runnable(rel)) throw new Error(`${given} is not a script that can be run: only a .py file is, in no hidden folder and with no hidden name.`);
    let read;
    try {
      read = portal.files.read(base, rel, { likeParent: true, chats: [chat.id] });
    } catch (e) {
      if (refusal(e) === "missing") throw new Error(`There is no file ${given} in this chat's folder.`);
      if (refusal(e) === "invalid") throw new Error(`${given} is not a file this chat's agent may read.`);
      throw new Error(`${given} could not be read: ${(e as Error).message}`);
    }
    if (read.binary) throw new Error(`${given} is not a text file, or is over 1 MB.`);
    return { rel, text: read.content };
  }

  /**
   * Writes the picture into the chat's folder, in `RENDERS`, and returns where, from the folder. The folder is held to
   * what the chat's agent may use, as it is for what is read for it: one closed to the agent, which it could have
   * renamed onto the name, or a link, is refused (`invalid`), and nothing is written in it. Between that look and the
   * write the folder could still be swapped; `files.create` takes no `FolderUse` to hold it to as it writes.
   */
  function keep(chat: Chat, bytes: Buffer): string {
    const base = portal.chats.folder(chat.id);
    const use = { likeParent: true, chats: [chat.id] };
    try {
      portal.files.makeFolder(base, "", RENDERS, use);
    } catch (e) {
      if (refusal(e) !== "exists") throw e;
    }
    portal.files.identity(base, RENDERS, { ...use, direct: true });
    return portal.files.create(base, RENDERS, fileName(), bytes);
  }

  return {
    execute_code: {
      prepare(params, chat) {
        if (params.path === undefined) return params;
        if (params.code !== undefined) throw new Error("Give code or path, not both.");
        const { path: given, ...rest } = params;
        const { rel, text } = script(chat, String(given));
        return { ...rest, code: text, script_name: rel };
      },
      arguments(params) {
        if (typeof params.code !== "string") throw new Error("Give code, the Python to run, or path, a .py script in this chat's folder.");
        return params;
      },
    },
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
