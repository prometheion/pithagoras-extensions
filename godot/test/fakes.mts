import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { ContainerInfo, ContainerSpec, Docker, PullState } from "../../shared/docker-api.ts";

/**
 * What the unit tests stand in for: Docker for extensions (in memory, recording what it was asked), the portal a
 * server half is given (an Express router, what it offered and registered, a folder of its own), and the Godot
 * server's MCP endpoint (on loopback, answering from server/tools.json and from answers a test scripts). Nothing here
 * reaches a Docker daemon or a container.
 */

/** The Godot server's instructions and tools, as the extension relays them (server/tools.json). */
export const LISTED = JSON.parse(readFileSync(new URL("../server/tools.json", import.meta.url), "utf8")) as { instructions: string; tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] };
export const TOOLS = LISTED.tools;

type Kept = { spec: ContainerSpec; owner: string; id: string; running: boolean; exitCode: number; startedAt: string; logs: string; restarting: boolean; restarts: number };

export function fakeDocker(options: { owner?: string; network?: string; gpus?: string; noGpu?: string } = {}) {
  const owner = options.owner ?? "pithagoras-godot";
  const containers = new Map<string, Kept>();
  const volumes = new Set<string>();
  const images = new Set<string>();
  const calls: string[] = [];
  let n = 0;
  const state = {
    network: options.network ?? "container:portal-1",
    /** What nvidia-smi prints in a probe, and the error Docker gives when it will not hand out a GPU. */
    gpus: options.gpus ?? "0, GPU-aaaa0000, NVIDIA GeForce RTX 3060, 11000, 12288\n1, GPU-bbbb1111, NVIDIA GeForce RTX 3060, 158, 12288\nOPTIX=toolkit\n",
    noGpu: options.noGpu,
    available: true,
    pullFails: undefined as string | undefined,
    /** The network namespace a command run in a container finds it in (`readlink /proc/self/ns/net`). */
    namespace: "net:[4026532001]",
  };
  const info = (name: string, kept: Kept): ContainerInfo => ({ name, id: kept.id, image: kept.spec.Image, state: kept.running ? "running" : "exited", status: "", owner: kept.owner, labels: (kept.spec.Labels as Record<string, string>) ?? {} });
  const docker: Docker = {
    available: async () => state.available,
    sharedNetwork: async () => state.network,
    images: {
      present: async (image) => images.has(image),
      async ensure(image, onProgress?: (s: PullState) => void) {
        calls.push(`pull ${image}`);
        if (images.has(image)) return;
        if (state.pullFails) throw new Error(state.pullFails);
        onProgress?.({ active: true, line: "Downloading 10 MB/100 MB" });
        images.add(image);
        onProgress?.({ active: false, line: "done" });
      },
    },
    containers: {
      list: async () => [...containers].filter(([, k]) => k.owner === owner).map(([name, k]) => info(name, k)),
      get: async (name) => (containers.has(name) ? info(name, containers.get(name)!) : undefined),
      async create(name, spec) {
        calls.push(`create ${name}`);
        containers.delete(name);
        containers.set(name, { spec: structuredClone(spec), owner, id: `id${++n}`, running: false, exitCode: 0, startedAt: "", logs: "", restarting: false, restarts: 0 });
        return info(name, containers.get(name)!);
      },
      async start(name) {
        calls.push(`start ${name}`);
        const kept = containers.get(name);
        if (!kept) throw Object.assign(new Error(`There is no container ${name}`), { status: 404 });
        if (name.endsWith("-probe")) {
          if (state.noGpu) throw new Error(state.noGpu);
          kept.logs = state.gpus;
          kept.exitCode = 0;
          return;
        }
        kept.running = true;
        kept.restarts = 0;
        kept.startedAt = `t${++n}`;
      },
      async stop(name) {
        calls.push(`stop ${name}`);
        const kept = containers.get(name);
        if (kept) kept.running = false;
      },
      async remove(name) {
        calls.push(`remove ${name}`);
        containers.delete(name);
      },
      logs: async (name) => containers.get(name)?.logs ?? "",
      async inspect(name) {
        const k = containers.get(name);
        if (!k) return undefined;
        return {
          Id: k.id,
          Config: { Image: k.spec.Image, Labels: k.spec.Labels ?? {} },
          HostConfig: k.spec.HostConfig,
          State: { Running: k.running, Restarting: k.restarting, ExitCode: k.exitCode, StartedAt: k.startedAt },
          RestartCount: k.restarts,
        };
      },
      update: async () => {},
      async exec(name, cmd) {
        calls.push(`exec ${name} ${cmd.join(" ")}`);
        if (!containers.get(name)?.running) throw Object.assign(new Error(`Container ${name} is not running`), { status: 409 });
        return { output: `${state.namespace}\n`, exitCode: 0, timedOut: false };
      },
      adopt: async (name) => info(name, containers.get(name)!),
    },
    volumes: {
      list: async () => [...volumes].map((name) => ({ name, owner })),
      async create(name) {
        calls.push(`volume ${name}`);
        volumes.add(name);
      },
      async remove(name) {
        calls.push(`remove volume ${name}`);
        volumes.delete(name);
      },
      adopt: async () => {},
    },
  };
  /** A container someone else made, under `name`. */
  const foreign = (name: string, by = "") => containers.set(name, { spec: { Image: "x" }, owner: by, id: `id${++n}`, running: true, exitCode: 0, startedAt: "t0", logs: "", restarting: false, restarts: 0 });
  return { docker, containers, volumes, images, calls, state, foreign };
}

export function fakePortal(docker?: Docker) {
  const dataDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "flair-godot-")));
  const offered: (() => { name: string; description?: string }[])[] = [];
  const factories: ((pi: any, chat: any) => void)[] = [];
  const upgrades: ((...args: any[]) => void)[] = [];
  const lines: string[] = [];
  const counts = { reloads: 0 };
  const router = express.Router();
  const portal = {
    version: 1,
    extension: "pithagoras-godot",
    executor: "host",
    log: (text: string) => void lines.push(text),
    dataDir: () => dataDir,
    router,
    http: { json: express.json, raw: express.raw, text: express.text, upgrade: (h: any) => void upgrades.push(h), endWithLogin: () => () => {}, send: () => {} },
    tools: { offer: (fn: any) => void offered.push(fn), exceptions: () => ({ byDefault: true, chats: [], routines: [] }) },
    chats: {
      extend: (fn: any) => void factories.push(fn),
      reload: async () => {
        counts.reloads++;
        return { reloaded: 0, waiting: 0 };
      },
    },
    extensions: { use: () => docker },
  };
  /** The tools a chat's pi would be given now. */
  const registered = () => {
    const tools: any[] = [];
    for (const f of factories) f({ registerTool: (t: any) => tools.push(t) }, { id: "chat-1", title: "", workspace: "/tmp", status: "idle" });
    return tools;
  };
  const listed = () => offered.flatMap((fn) => fn());
  return { portal: portal as any, dataDir, lines, counts, registered, listed, upgrades, router };
}

/**
 * The Godot server, standing in: its MCP endpoint, answering what a test scripts, its /api/state, and its pages, each
 * only with the token it checks (a text, or what reads the one the extension made).
 */
export async function fakeMcp(token: string | (() => string)) {
  const expected = () => (typeof token === "string" ? token : token());
  const seen: { method: string; params: any; auth?: string }[] = [];
  /** The paths it was asked for besides /mcp and /api/state, in order. */
  const served: string[] = [];
  const answers = new Map<string, any>();
  let instructions = LISTED.instructions;
  let tools = TOOLS;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${expected()}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "not connected" }));
        return;
      }
      if (req.url === "/api/state") {
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ready: true, editor: "running", project: "starter", renderer: "forward_plus", busy: null, restarts: 0, adapter: "NVIDIA GeForce RTX 3060", godot: "4.7.2.stable", log: [{ line: "the activity log" }] }));
      }
      if (req.url !== "/mcp") {
        served.push(req.url!);
        return void res.writeHead(200, { "content-type": "text/html" }).end(`<p>viewer at ${req.url}</p>`);
      }
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, params: msg.params, auth: req.headers.authorization });
      const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, instructions, serverInfo: { name: "godot-server", version: "4.7.2.stable" } });
      if (msg.method === "ping") return reply({});
      if (msg.method === "tools/list") return reply({ tools });
      if (msg.method === "tools/call") {
        const scripted = answers.get(msg.params.name);
        if (scripted === "hang") return;
        if (scripted === "rpc-error") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool 'nope'" } }));
        if (scripted === "not-json") return res.writeHead(502, { "content-type": "text/plain" }).end("bad gateway");
        return reply(scripted ?? { content: [{ type: "text", text: "{}" }], isError: false });
      }
      res.writeHead(200).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }));
    });
  });
  // The stream: a WebSocket that answers with a greeting, with the headers it came with kept.
  const upgrades: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
  server.on("upgrade", (req, socket) => {
    upgrades.push({ url: req.url, headers: req.headers });
    socket.on("error", () => {});
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello from the stream");
    socket.end();
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    served,
    upgrades,
    answers,
    setInstructions: (text: string) => void (instructions = text),
    setTools: (next: typeof TOOLS) => void (tools = next),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
