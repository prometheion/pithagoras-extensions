/**
 * The Godot server's tools, by the server's own names (its `tools/list`, kept in server/tools.json): what a call of
 * each is labelled with in pi and on its card in the chat, in English (German in de.ts), and the guard rules every
 * call of one is the shape of. Each is relayed as `godot_<name>`. Read by both halves: the server half gives pi the
 * label and the guard, the browser half the card's words.
 *
 * Every one of them is outside content to the guard, since what they return comes from projects and files that may
 * have come from anywhere.
 */

/** Marks a text to be translated where it is shown: a label kept in a table. */
const msg = <T extends string>(text: T): T => text;

export const PREFIX = "godot";

export const LABELS: Record<string, string> = {
  ping: msg("Checking Godot"),
  list_projects: msg("Listing Godot projects"),
  new_project: msg("Creating a Godot project"),
  open_project: msg("Opening a Godot project"),
  restart_editor: msg("Restarting the Godot editor"),
  list_files: msg("Listing project files"),
  read_file: msg("Reading a project file"),
  write_file: msg("Writing a project file"),
  delete_file: msg("Deleting a project file"),
  get_scene_tree: msg("Reading the scene tree"),
  open_scene: msg("Opening a scene"),
  new_scene: msg("Creating a scene"),
  add_node: msg("Adding a node"),
  set_property: msg("Setting a property"),
  delete_node: msg("Deleting a node"),
  attach_script: msg("Attaching a script"),
  save_scene: msg("Saving the scene"),
  reload: msg("Reloading files"),
  run_project: msg("Running the game"),
  run_scene: msg("Running a scene"),
  stop: msg("Stopping the game"),
  get_output: msg("Reading the editor output"),
  game_input: msg("Playing the game"),
  game_state: msg("Reading the game's state"),
  run_playtest: msg("Running a playtest"),
  check_scripts: msg("Checking scripts"),
  screenshot: msg("Taking a screenshot in Godot"),
  record: msg("Recording the game"),
  export: msg("Exporting the project"),
  execute_gdscript: msg("Running GDScript in the editor"),
};

/**
 * The guard rules every call of each tool is the shape of, decided for each (`[]`: none; the relay holds a tool this
 * table does not name to `upload`). The ones that run code, or write code the editor runs, are uploads: a GDScript file
 * loads as soon as it is written, a `@tool` script runs in the editor, and a game is a program. So are the ones that
 * drive the running game or run code in it: game_input plays it as run_project starts it, game_state evaluates
 * expressions in it (any method can be called), and run_playtest runs the agent's tests in it. Once the conversation
 * has read a result the guard flags as a likely prompt injection, the guard asks the person before each of their
 * calls, or refuses where nobody can answer, since that code can change the projects and what it prints comes back to
 * the chat, though its network has no way out (see the README on what it reaches). The others read the project or the
 * editor, or change the project through the editor's own operations, in the container's data folder.
 */
export const ACTS: Record<string, "upload"[]> = {
  ping: [],
  list_projects: [],
  new_project: [],
  open_project: [],
  restart_editor: [],
  list_files: [],
  read_file: [],
  write_file: ["upload"],
  delete_file: [],
  get_scene_tree: [],
  open_scene: [],
  new_scene: [],
  add_node: [],
  set_property: [],
  delete_node: [],
  attach_script: ["upload"],
  save_scene: [],
  reload: [],
  run_project: ["upload"],
  run_scene: ["upload"],
  stop: [],
  get_output: [],
  game_input: ["upload"],
  game_state: ["upload"],
  run_playtest: ["upload"],
  check_scripts: [],
  screenshot: [],
  record: ["upload"],
  export: [],
  execute_gdscript: ["upload"],
};
