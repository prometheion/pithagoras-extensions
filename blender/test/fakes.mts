import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import express from "express";
import type { ContainerInfo, ContainerSpec, Docker, Reach } from "../../shared/docker-api.ts";

/**
 * What the unit tests run the server half against, none of it the machine's: a Docker in memory, a portal that keeps
 * what the half tells it, and an MCP server on loopback that answers as the Blender server does, from the tools.json
 * the image is checked against.
 */

export const EXTENSION = "@pithagoras/blender";

/** A temporary folder, removed when the tests end. */
export function scratch(prefix = "flair-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Held {
  id: string;
  name: string;
  owner: string;
  spec: ContainerSpec;
  state: "created" | "running" | "exited" | "restarting";
  exitCode: number;
  restarts: number;
  startedAt: string;
  log: string;
  /** The networks it is on, by name, with each one's id, as inspect's `NetworkSettings.Networks` has them. */
  networks: Record<string, { NetworkID: string }>;
}

/**
 * Docker for one extension, in memory: what it was asked, in order (`calls`), each container's create body, the
 * volumes, networks and images there are. `refuseGpu` refuses to start a container that asks for a GPU, as Docker does
 * without the NVIDIA runtime; `onStart` says what a started container does (the probe prints and exits). A container
 * made with a `NetworkMode` that names one of the networks is on it, by that network's id. `reach` is where
 * `networks.reach` says the portal reaches a container on it (127.0.0.1 and the port asked for, unless a test says),
 * refused as Docker for extensions refuses it for a network or container there is none of and for a container not on
 * the network, and with `reachFails` in those words.
 */
export function memoryDocker(options: { owner?: string } = {}) {
  const owner = options.owner ?? EXTENSION;
  const containers = new Map<string, Held>();
  const volumes = new Map<string, string>();
  const networks = new Map<string, { id: string; owner: string }>();
  const images = new Set<string>();
  const calls: string[] = [];
  let ids = 0;
  let clock = Date.parse("2026-10-24T00:00:00Z");
  const state = {
    available: true,
    refuseGpu: false,
    /** What a started container does: the probe prints this and exits. */
    onStart: undefined as ((c: Held) => void) | undefined,
    pullFails: undefined as string | undefined,
    reach: undefined as Reach | undefined,
    reachFails: undefined as string | undefined,
  };
  const status = (status: number, message: string) => Object.assign(new Error(message), { status });
  const info = (c: Held): ContainerInfo => ({ name: c.name, id: c.id, image: c.spec.Image, state: c.state, status: c.state, owner: c.owner, labels: (c.spec.Labels as Record<string, string>) ?? {} });
  const mine = (name: string) => {
    const c = containers.get(name);
    if (c && c.owner !== owner) throw status(403, `${name} is ${c.owner || "nobody"}'s container, not ${owner}'s`);
    return c;
  };
  const docker: Docker = {
    available: async () => state.available,
    sharedNetwork: async () => "host",
    images: {
      present: async (image) => images.has(image),
      async ensure(image, onProgress) {
        calls.push(`ensure ${image}`);
        if (images.has(image)) return;
        onProgress?.({ active: true, line: "Downloading [=====>   ] 5MB/10MB" });
        if (state.pullFails) throw status(0, state.pullFails);
        images.add(image);
        onProgress?.({ active: false, line: "done" });
      },
    },
    containers: {
      list: async () => [...containers.values()].filter((c) => c.owner === owner).map(info),
      get: async (name) => (containers.has(name) ? info(containers.get(name)!) : undefined),
      async create(name, spec) {
        calls.push(`create ${name}`);
        if (mine(name)) containers.delete(name);
        const mode = (spec.HostConfig as { NetworkMode?: string } | undefined)?.NetworkMode ?? "";
        const on = networks.get(mode);
        const made: Held = { id: `id${++ids}`, name, owner, spec: structuredClone(spec), state: "created", exitCode: 0, restarts: 0, startedAt: "0001-01-01T00:00:00Z", log: "", networks: on ? { [mode]: { NetworkID: on.id } } : {} };
        containers.set(name, made);
        return info(made);
      },
      async start(name) {
        calls.push(`start ${name}`);
        const c = mine(name);
        if (!c) throw status(404, `There is no container ${name}`);
        if (state.refuseGpu && (c.spec.HostConfig as { DeviceRequests?: unknown[] } | undefined)?.DeviceRequests?.length) {
          throw status(500, 'could not select device driver "nvidia" with capabilities: [[gpu]]');
        }
        c.state = "running";
        c.restarts = 0;
        c.startedAt = new Date((clock += 1000)).toISOString();
        state.onStart?.(c);
      },
      async stop(name) {
        calls.push(`stop ${name}`);
        const c = mine(name);
        if (c) c.state = "exited";
      },
      async remove(name) {
        calls.push(`remove ${name}`);
        if (mine(name)) containers.delete(name);
      },
      async logs(name) {
        const c = mine(name);
        if (!c) throw status(404, `There is no container ${name}`);
        return c.log;
      },
      async inspect(name) {
        const c = mine(name);
        if (!c) return undefined;
        const { HostConfig, ...config } = c.spec as ContainerSpec & { HostConfig?: Record<string, unknown> };
        return {
          Config: { ...config, Labels: c.spec.Labels ?? {} },
          HostConfig: HostConfig ?? {},
          NetworkSettings: { Networks: c.networks },
          State: { Status: c.state, Running: c.state === "running" || c.state === "restarting", Restarting: c.state === "restarting", ExitCode: c.exitCode, StartedAt: c.startedAt },
          RestartCount: c.restarts,
        };
      },
      async update() {},
      async exec(name, cmd) {
        calls.push(`exec ${name} ${cmd.join(" ")}`);
        const c = mine(name);
        if (!c) throw status(404, `There is no container ${name}`);
        if (c.state !== "running") throw status(409, `Container ${name} is not running`);
        return { output: "", exitCode: 0, timedOut: false };
      },
      async adopt(name) {
        const c = containers.get(name);
        if (!c) throw status(404, `There is no container ${name}`);
        c.owner = owner;
        return info(c);
      },
    },
    volumes: {
      list: async () => [...volumes].filter(([, by]) => by === owner).map(([name, by]) => ({ name, owner: by })),
      async create(name) {
        calls.push(`volume ${name}`);
        if (!volumes.has(name)) volumes.set(name, owner);
      },
      async remove(name) {
        calls.push(`remove volume ${name}`);
        volumes.delete(name);
      },
      async adopt(name) {
        volumes.set(name, owner);
      },
    },
    networks: {
      async create(name) {
        calls.push(`network ${name}`);
        const there = networks.get(name);
        if (there && there.owner !== owner) throw status(403, `${name} is ${there.owner || "no extension"}'s network, not ${owner}'s`);
        if (!there) networks.set(name, { id: `net${++ids}`, owner });
        return { name, ...networks.get(name)! };
      },
      get: async (name) => (networks.has(name) ? { name, ...networks.get(name)! } : undefined),
      async reach(name, container, port) {
        calls.push(`reach ${name} ${container} ${port}`);
        if (!networks.has(name)) throw status(404, `There is no network ${name}`);
        const c = mine(container);
        if (!c) throw status(404, `There is no container ${container}`);
        if (!c.networks[name]) throw status(409, `${container} is not on ${name}`);
        if (state.reachFails) throw status(0, state.reachFails);
        return state.reach ?? { host: "127.0.0.1", port };
      },
      async remove(name) {
        calls.push(`remove network ${name}`);
        const on = [...containers.values()].filter((c) => c.owner === owner && c.networks[name]);
        if (on.length) throw status(403, `error while removing network: network ${name} has active endpoints (name:"${on[0].name}")`);
        networks.delete(name);
      },
    },
  };
  /** A container made by someone else, with that owner ("" for nobody's). */
  const foreign = (name: string, by: string) => containers.set(name, { id: `id${++ids}`, name, owner: by, spec: { Image: "other" }, state: "running", exitCode: 0, restarts: 0, startedAt: "", log: "", networks: {} });
  return { docker, containers, volumes, networks, images, calls, state, foreign };
}

/**
 * A portal for one server half: an express router behind /api/x/<package>, the tools it offers and registers, a data
 * folder, and the folder of the chat its tools are called in (`chatDir`), read and written through `files` as the
 * portal's own functions do, by a path from that folder. `chats.folder` gives that folder as the portal does, as it
 * really is: the chat's workspace with every link on the way resolved, while the chat names it as it was given
 * (`chat.workspace`, which a test can make a link). Every read is kept with the options it was asked with (`reads`),
 * and every folder made or held to (`folders`); `files.refuse` makes the next read throw a refusal with that code, as
 * the portal's checks do, and `files.refuseFolder` the holding of a folder (`identity`), as for one closed to the agent.
 */
export function fakePortal(options: { dataDir?: string } = {}) {
  const router = express.Router();
  const offers: (() => { name: string; description?: string }[])[] = [];
  const factories: ((pi: any, chat: any) => void)[] = [];
  const logs: string[] = [];
  let reloads = 0;
  let upgrade: ((req: http.IncomingMessage, socket: any, head: Buffer) => void) | undefined;
  const dataDir = options.dataDir ?? scratch("flair-data-");
  const chatDir = scratch("flair-chat-");
  const chat = { id: "chat-1", title: "A chat", workspace: chatDir, status: "running" };
  const uses = new Map<string, unknown>();
  const reads: { rel: string; options: unknown }[] = [];
  const folders: { made?: string; held?: string; options: unknown }[] = [];
  const refusal = (code: string, message: string) => Object.assign(new Error(message), { code });
  const files = {
    refuse: undefined as string | undefined,
    refuseFolder: undefined as string | undefined,
    makeFolder(base: string, rel: string, name: string, asked?: unknown) {
      folders.push({ made: path.posix.join(rel, name), options: asked });
      const made = path.join(base, rel, name);
      if (existsSync(made)) throw refusal("exists", `${name} is there already`);
      mkdirSync(made);
      return path.posix.join(rel, name);
    },
    /** As with `direct`: a link, or anything but a folder, is refused. */
    identity(base: string, rel: string, asked?: unknown) {
      folders.push({ held: rel, options: asked });
      if (files.refuseFolder) throw refusal(files.refuseFolder, `refused: ${rel}`);
      const found = lstatSync(path.join(base, rel), { bigint: true });
      if (!found.isDirectory()) throw refusal("invalid", `not a folder of its own: ${rel}`);
      return { dev: String(found.dev), ino: String(found.ino) };
    },
    create(base: string, rel: string, name: string, data: Buffer) {
      writeFileSync(path.join(base, rel, name), data, { flag: "wx" });
      return path.posix.join(rel, name);
    },
    read(base: string, rel: string, asked?: unknown) {
      reads.push({ rel, options: asked });
      if (files.refuse) throw refusal(files.refuse, `refused: ${rel}`);
      if (path.isAbsolute(rel) || rel.split(/[/\\]/).includes("..")) throw refusal("invalid", `not inside: ${rel}`);
      const full = path.join(base, rel);
      if (!existsSync(full)) throw refusal("missing", `no such file: ${rel}`);
      const bytes = readFileSync(full);
      return bytes.includes(0) ? { binary: true, size: bytes.length, mtime: 0 } : { binary: false, size: bytes.length, mtime: 0, content: bytes.toString("utf8") };
    },
  };
  const portal = {
    version: 1,
    extension: EXTENSION,
    executor: "host",
    log: (text: string) => void logs.push(text),
    router,
    http: { json: express.json, raw: express.raw, text: express.text, upgrade: (handler: typeof upgrade) => void (upgrade = handler) },
    tools: { offer: (fn: () => { name: string; description?: string }[]) => void offers.push(fn) },
    chats: {
      extend: (factory: (pi: any, chat: any) => void) => void factories.push(factory),
      folder: (id: string) => {
        if (id !== chat.id) throw new Error(`no chat ${id}`);
        return realpathSync(chat.workspace);
      },
      reload: async () => {
        reloads++;
        return { reloaded: 0, waiting: 0 };
      },
    },
    extensions: { use: (name: string) => uses.get(name) },
    files,
    dataDir: () => dataDir,
  };
  return {
    portal: portal as any,
    uses,
    logs,
    dataDir,
    chat,
    chatDir,
    files,
    reads,
    folders,
    reloads: () => reloads,
    upgrade: () => upgrade,
    /** What Settings → Tools is offered now. */
    offered: () => offers.flatMap((fn) => fn()),
    /** The tools a chat's pi is given as it loads. */
    registered() {
      const tools: any[] = [];
      for (const factory of factories) factory({ registerTool: (tool: any) => tools.push(tool) }, chat);
      return tools;
    },
    /** The router served as the portal serves it, at /api/x/<package>. */
    async serve() {
      const app = express().use(`/api/x/${EXTENSION}`, router);
      const server = http.createServer(app);
      server.on("upgrade", (req, socket, head) => {
        const prefix = `/api/x/${EXTENSION}`;
        if (!upgrade || !req.url?.startsWith(prefix)) return socket.destroy();
        req.url = req.url.slice(prefix.length) || "/";
        upgrade(req, socket, head);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      after(() => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/x/${EXTENSION}`;
    },
  };
}

/** The Blender server's tools and instructions, as the image lists them and the extension registers them (server/tools.json). */
export const BUNDLED = JSON.parse(readFileSync(new URL("../server/tools.json", import.meta.url), "utf8")) as { instructions: string; tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] };
export const TOOLS = BUNDLED.tools;

/**
 * An MCP server on loopback that answers as the Blender server does: `initialize`, `ping`, `tools/list` from
 * tools.json and `tools/call` as a test says (`answers`), each with the token or a 401. Every request is kept. While
 * `down`, nothing answers: a connection is dropped, as on a loopback the server is not on.
 */
export async function fakeMcp(token: string) {
  const seen: { method: string; params: any; auth: string | undefined }[] = [];
  const answers: Record<string, (args: any) => unknown> = {};
  const state = { instructions: BUNDLED.instructions, tools: TOOLS as unknown[], hang: false, down: false };
  const server = http.createServer((req, res) => {
    if (state.down) return void req.socket.destroy();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "content-length": "0" });
        return res.end();
      }
      if (req.url !== "/mcp") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ path: req.url, gpu: "OPTIX", denoiser: "OPTIX" }));
      }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({ method: message.method, params: message.params, auth: req.headers.authorization });
      const reply = (body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(body as object) }));
      };
      if (state.hang && message.method === "tools/call") return;
      if (message.method === "initialize") return reply({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, instructions: state.instructions, serverInfo: { name: "blender-server", version: "5.2.2" } } });
      if (message.method === "ping") return reply({ result: {} });
      if (message.method === "tools/list") return reply({ result: { tools: state.tools } });
      if (message.method === "tools/call") {
        const answer = answers[message.params.name];
        if (!answer) return reply({ error: { code: -32601, message: `unknown tool '${message.params.name}'` } });
        return reply({ result: answer(message.params.arguments) });
      }
      reply({ error: { code: -32601, message: `method not found: ${message.method}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const port = (server.address() as AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}/mcp`, seen, answers, state, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
