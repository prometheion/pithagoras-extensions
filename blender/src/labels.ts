/**
 * The Blender server's tools, by the server's own names (its `tools/list`, as server/tools.json has it): what a call of
 * each is labelled with in pi and on its card in the chat, in English (German in de.ts), and the guard rules every
 * call of one is the shape of, decided for each tool (`[]`: none). Every one of them is outside content to the guard,
 * since what they return comes from the scene and its files, which may have come from an uploaded .blend.
 *
 * `execute_code` runs Python in Blender, as the container's own unprivileged user, without capabilities, on the
 * portal's loopback: what listens on 127.0.0.1 where the portal runs, which for a portal on the host's network is the
 * host's, it can reach, as the agent's own shell can. So once a conversation has read something that looks like a
 * prompt injection, the guard asks the person before it runs, or refuses it where nobody is there to answer
 * (`upload`). The other tools read the scene, or write only in the container's data folder.
 */

/** Marks a text to be translated where it is shown: a label kept in a table. */
const msg = <T extends string>(text: T): T => text;

export const PREFIX = "blender";

export const LABELS: Record<string, string> = {
  ping: msg("Checking Blender"),
  get_scene_info: msg("Reading the Blender scene"),
  get_object_info: msg("Reading an object in Blender"),
  execute_code: msg("Running Python in Blender"),
  preview: msg("Previewing in Blender"),
  render: msg("Rendering in Blender"),
  export: msg("Exporting from Blender"),
  list_projects: msg("Listing Blender projects"),
  open_file: msg("Opening a Blender project"),
  save_file: msg("Saving the Blender project"),
  new_scene: msg("Starting a new Blender scene"),
};

export const ACTS: Record<string, "upload"[]> = {
  ping: [],
  get_scene_info: [],
  get_object_info: [],
  execute_code: ["upload"],
  preview: [],
  render: [],
  export: [],
  list_projects: [],
  open_file: [],
  save_file: [],
  new_scene: [],
};
