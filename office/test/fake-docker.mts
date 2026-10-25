/**
 * A Docker for extensions that keeps what it is asked to make in memory, as the 1.3.0 API answers it: containers by
 * name with Docker's own inspect body (the spec's labels, its network by the network's id, its state), this
 * extension's networks and volumes, and `networks.reach` answering where it is told to. Every call is recorded in
 * `calls`, as "<what> <name>", so a test reads what was done in order. Nothing reaches a socket.
 */
import type { ContainerInfo, ContainerSpec, Docker, ExecResult, NetworkInfo, PullState, Reach } from "../../shared/docker-api";

export const OWNER = "@pithagoras/office";

export interface FakeContainer {
  info: ContainerInfo;
  spec: ContainerSpec;
  /** Docker's inspect body, as `containers.inspect` gives it. */
  inspect: Record<string, any>;
}

export function fakeDocker(options: { sharedNetwork?: string; reach?: Reach; available?: boolean } = {}) {
  const containers = new Map<string, FakeContainer>();
  const networks = new Map<string, NetworkInfo>();
  const volumes = new Map<string, string>();
  const calls: string[] = [];
  const state = {
    available: options.available ?? true,
    sharedNetwork: options.sharedNetwork ?? "host",
    reach: options.reach ?? ({ host: "127.0.0.1", port: 3890 } as Reach),
    exec: { output: "", exitCode: 1, timedOut: false } as ExecResult,
    images: new Set<string>(),
  };
  let ids = 0;

  const notFound = (name: string) => Object.assign(new Error(`no container ${name}`), { status: 404 });
  const setState = (c: FakeContainer, status: string) => {
    c.info.state = status;
    c.inspect.State = { Status: status, Running: status === "running" };
  };

  /** A container as Docker would have it, made from `spec` (for tests that start with one there already). */
  function put(name: string, spec: ContainerSpec, extra: { owner?: string; state?: string; networkId?: string } = {}): FakeContainer {
    const host = (spec.HostConfig ?? {}) as Record<string, unknown>;
    const mode = String(host.NetworkMode ?? "default");
    const island = networks.get(mode);
    const c: FakeContainer = {
      info: { name, id: `cid-${++ids}`, image: spec.Image, state: "created", status: "", owner: extra.owner ?? OWNER, labels: (spec.Labels as Record<string, string>) ?? {} },
      spec,
      inspect: {
        Config: { Image: spec.Image, Labels: spec.Labels ?? {} },
        HostConfig: host,
        NetworkSettings: { Networks: island ? { [island.name]: { NetworkID: extra.networkId ?? island.id } } : {} },
      },
    };
    setState(c, extra.state ?? "created");
    containers.set(name, c);
    return c;
  }

  const docker = {
    available: async () => state.available,
    sharedNetwork: async () => {
      calls.push("sharedNetwork");
      return state.sharedNetwork;
    },
    images: {
      present: async (image: string) => state.images.has(image),
      ensure: async (image: string, onProgress?: (s: PullState) => void) => {
        calls.push(`pull ${image}`);
        onProgress?.({ active: true, line: `downloading ${image}` });
        onProgress?.({ active: false, line: "done" });
        state.images.add(image);
      },
    },
    containers: {
      list: async () => [...containers.values()].filter((c) => c.info.owner === OWNER).map((c) => ({ ...c.info })),
      get: async (name: string) => {
        const c = containers.get(name);
        return c ? { ...c.info } : undefined;
      },
      create: async (name: string, spec: ContainerSpec) => {
        calls.push(`create ${name}`);
        const there = containers.get(name);
        if (there && there.info.owner !== OWNER) throw Object.assign(new Error(`${name} is not ${OWNER}'s`), { status: 403 });
        return { ...put(name, spec).info };
      },
      start: async (name: string) => {
        calls.push(`start ${name}`);
        const c = containers.get(name);
        if (!c) throw notFound(name);
        setState(c, "running");
      },
      stop: async (name: string) => {
        calls.push(`stop ${name}`);
        const c = containers.get(name);
        if (!c) throw notFound(name);
        setState(c, "exited");
      },
      remove: async (name: string) => {
        calls.push(`remove ${name}`);
        containers.delete(name);
      },
      logs: async () => "",
      inspect: async (name: string) => containers.get(name)?.inspect,
      update: async () => {},
      exec: async (name: string, cmd: string[]) => {
        calls.push(`exec ${name} ${cmd.join(" ")}`);
        return state.exec;
      },
      adopt: async (name: string) => {
        calls.push(`adopt ${name}`);
        const c = containers.get(name);
        if (!c) throw notFound(name);
        if (c.info.owner !== "") throw Object.assign(new Error(`${name} is ${c.info.owner}'s`), { status: 403 });
        c.info.owner = OWNER;
        return { ...c.info };
      },
    },
    volumes: {
      list: async () => [...volumes.entries()].filter(([, owner]) => owner === OWNER).map(([name, owner]) => ({ name, owner })),
      create: async (name: string) => {
        calls.push(`volume ${name}`);
        const owner = volumes.get(name);
        if (owner !== undefined && owner !== OWNER) throw Object.assign(new Error(`volume ${name} is not ${OWNER}'s`), { status: 409 });
        volumes.set(name, OWNER);
      },
      remove: async (name: string) => {
        calls.push(`remove volume ${name}`);
        volumes.delete(name);
      },
      adopt: async (name: string) => {
        calls.push(`adopt volume ${name}`);
        if (volumes.get(name) !== "") throw Object.assign(new Error(`volume ${name} is not nobody's`), { status: 403 });
        volumes.set(name, OWNER);
      },
    },
    networks: {
      create: async (name: string) => {
        calls.push(`network ${name}`);
        const there = networks.get(name) ?? { name, id: `net-${++ids}`, owner: OWNER };
        networks.set(name, there);
        return { ...there };
      },
      get: async (name: string) => {
        const n = networks.get(name);
        return n ? { ...n } : undefined;
      },
      reach: async (name: string, container: string, port: number) => {
        calls.push(`reach ${name} ${container} ${port}`);
        return { ...state.reach };
      },
      remove: async (name: string) => {
        calls.push(`remove network ${name}`);
        networks.delete(name);
      },
    },
  } as unknown as Docker;

  return { docker, calls, state, containers, networks, volumes, put };
}
