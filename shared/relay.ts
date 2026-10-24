import { existsSync, rmSync, writeFileSync } from "node:fs";
import type { Chat, ServerPortal, ToolGuard } from "@pithagoras/extension-api/server";
import { NotAnswering, type McpClient, type McpTool } from "./mcp";

/**
 * The server's MCP tools as the extension's own: registered in every chat's pi (`portal.chats.extend`), listed in
 * Settings → Tools under the package's group (`portal.tools.offer`), switched there per chat, agent, project and mode
 * as any tool is, held by the guard to what each declares, and gone with the extension when it is switched off or
 * removed, as the portal drops what a package registered.
 *
 * What the model is told of them is the extension's own: the list and the instructions that come with the package
 * (`bundled`, from server/tools.json, which the release's smoke test holds the image of the same version to), as they
 * are. The server runs code the agent writes, so nothing it says of itself goes into a chat's prompt: it is asked only
 * to run a call. While it answers (after a start, and at the service's look every 30 seconds), what it lists is
 * compared with the bundled list (`check`), and a difference is said in the log, once, and not taken.
 *
 * A chat's pi is loaded synchronously and is not waited for, so nothing is asked of Docker while a chat loads: the
 * tools are registered while the server's container exists, as the service last found it. That is kept in a file of
 * the extension's own folder (`installedFile`), so that a chat loaded after a portal restart, before the service has
 * looked again, has the tools at once, and the open chats are not loaded again only because the half started.
 *
 * Each tool is named `<prefix>_<the server's name>`: off pi's own names, off the browser's rules, which a name with
 * `browser_` in it is held to, and grouped by eye. The instructions are a guideline, which pi prints once however many
 * tools carry it. One call at a time (`sequential`): one server serves every call, on one thread. What a call returns
 * is outside content (`outside`): it comes from a scene or a project, which may have come from anywhere.
 *
 * What the extension does around a call of a tool, in the chat it is made in, is its own (`calls`): what it adds to
 * the arguments the server gets (a file of the chat's, read as its agent), and what it makes of the result for the
 * model and for the chat (a picture put in the chat's folder, which the chat shows under the call).
 */

/** What the package says of the server's tools: its MCP instructions and its `tools/list`, as server/tools.json has them. */
export interface Bundled {
  instructions: string;
  tools: McpTool[];
}

/** A tool's result as pi takes it: text and pictures in the order the server gave them. */
export type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** What a tool's call answers pi: its parts, for the model, and its `details`, where `files` are what the chat shows. */
export interface Answer {
  content: Part[];
  details: Record<string, unknown>;
}

/** What the extension does around a call of one of the server's tools, in the chat it is made in. */
export interface CallHooks {
  /** The arguments the server is sent, from those the model gave. A throw refuses the call, with its message. */
  arguments?(params: Record<string, unknown>, chat: Chat): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** The answer, from what the server answered (`parts`) and the arguments the model gave. */
  answer?(parts: Part[], params: Record<string, unknown>, chat: Chat): Answer | Promise<Answer>;
}

/** The guard rule a tool the `acts` table does not name is held to: code from anywhere could be behind it. */
const UNNAMED: NonNullable<ToolGuard["acts"]> = ["upload"];

export interface RelayOptions {
  portal: ServerPortal;
  /** What the tools' names start with, before `_`: `blender`. */
  prefix: string;
  /** The app's name, as the model is told it is not running: `Blender`. */
  app: string;
  mcp: McpClient;
  /** The tools and the instructions that come with the package. */
  bundled: Bundled;
  /** What each tool's call is labelled with in pi, by the server's name for it. One not listed is labelled with its name. */
  labels: Record<string, string>;
  /**
   * The guard rules every call of a tool is the shape of, by the server's name for it (see ToolGuard.acts), `[]` for
   * none. One the table does not name is held to `upload`.
   */
  acts: Record<string, NonNullable<ToolGuard["acts"]>>;
  /** Where it is kept that the server's container exists: a file in the extension's own folder. */
  installedFile: string;
  /** What the extension does around a call, by the server's name for the tool: nothing for one not named. */
  calls?: Record<string, CallHooks>;
}

export function relay(options: RelayOptions) {
  const { portal, prefix, mcp, bundled, installedFile } = options;
  /** Whether the server's container exists, as the service last found it; until it has looked, as it found it before. */
  let installed = existsSync(installedFile);
  const notRunning = `${options.app} is not running. The person can start it in Settings → ${options.app}.`;
  const guideline = bundled.instructions.trim();

  /** A tool's result, from what the server answered: a result it marks as an error is thrown, so pi marks the call failed. */
  function partsOf(result: Awaited<ReturnType<McpClient["callTool"]>>): Part[] {
    const parts: Part[] = [];
    for (const part of result.content ?? []) {
      if (part.type === "text") parts.push({ type: "text", text: String(part.text) });
      else if (part.type === "image") parts.push({ type: "image", data: String(part.data), mimeType: String(part.mimeType) });
    }
    if (result.isError) throw new Error(parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n") || `${options.app} refused the call`);
    return parts;
  }

  function register(pi: any, chat: Chat): void {
    if (!installed) return;
    for (const tool of bundled.tools) {
      const hooks = options.calls?.[tool.name] ?? {};
      const acts = options.acts[tool.name] ?? UNNAMED;
      const guard: ToolGuard = { outside: true, ...(acts.length ? { acts } : {}) };
      pi.registerTool({
        name: `${prefix}_${tool.name}`,
        label: options.labels[tool.name] ?? tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
        ...(guideline ? { promptGuidelines: [guideline] } : {}),
        executionMode: "sequential",
        guard,
        async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
          const given = params ?? {};
          const sent = hooks.arguments ? await hooks.arguments(given, chat) : given;
          let result;
          try {
            result = await mcp.callTool(tool.name, sent, signal);
          } catch (e) {
            if (e instanceof NotAnswering) throw new Error(notRunning);
            throw e;
          }
          const parts = partsOf(result);
          return hooks.answer ? await hooks.answer(parts, given, chat) : { content: parts, details: {} };
        },
      });
    }
  }

  portal.tools.offer(() => (installed ? bundled.tools.map((t) => ({ name: `${prefix}_${t.name}`, description: t.description ?? "" })) : []));
  portal.chats.extend((pi, chat) => register(pi, chat));

  /** The difference last said in the log, so that a server that goes on listing it is not said again at each look. */
  let said = "";

  return {
    /** The tools as they are registered now, by the server's names: for the routes and the tests. */
    tools: () => (installed ? bundled.tools.map((t) => t.name) : []),
    /**
     * Whether the server's container exists, as the service found it. A change is kept, and hands the open chats the
     * tools, or takes them away.
     */
    setInstalled(now: boolean): void {
      if (now === installed) return;
      installed = now;
      if (now) writeFileSync(installedFile, "", { mode: 0o600 });
      else rmSync(installedFile, { force: true });
      void portal.chats.reload().catch((e) => portal.log(`could not give the open chats ${options.app}'s tools: ${(e as Error).message}`));
    },
    /**
     * The server answers: what it lists and its instructions, compared with the bundled ones. Where they differ (an
     * image of another version, or code the agent ran that changed the server), the log says which tools, and the
     * bundled ones stay what is offered and registered.
     */
    async check(): Promise<void> {
      const [info, listed] = await Promise.all([mcp.initialize(), mcp.listTools()]);
      const shape = (t: McpTool) => JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      const own = new Map(bundled.tools.map((t) => [t.name, shape(t)]));
      const theirs = new Map(listed.map((t) => [t.name, shape(t)]));
      const differ = [
        ...[...theirs.keys()].filter((name) => !own.has(name)).map((name) => `${name} is not the extension's`),
        ...[...own.keys()].filter((name) => !theirs.has(name)).map((name) => `${name} is not listed`),
        ...[...own.keys()].filter((name) => theirs.has(name) && theirs.get(name) !== own.get(name)).map((name) => `${name} is described otherwise`),
        ...(info.instructions.trim() !== guideline ? ["its instructions are others"] : []),
      ].join("; ");
      if (differ && differ !== said) portal.log(`the ${options.app} server lists other tools than the extension's own (${differ}): the extension's are the ones offered`);
      said = differ;
    },
  };
}

export type Relay = ReturnType<typeof relay>;
