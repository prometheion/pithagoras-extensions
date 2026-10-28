/**
 * The way back from the Document Server to the portal, held open from the portal's side (see container.ts): a few
 * connections to the relay through the way in, each opened with the relay's key, wait there as tunnels. The relay hands
 * each connection the Document Server makes to its port 3891 (a document fetch, a save callback) to the next one; the
 * first bytes on a tunnel are that request, and from then on it is joined to the extension's loopback listener, as if
 * the Document Server had connected there itself. One that is taken is replaced at once, so the next request finds one
 * waiting.
 *
 * Nothing here asks Docker for the way in: a tunnel goes where the way in was last given (`at`), and waits while there
 * is none, as it does after the person removed the Document Server, so it never makes again what they removed. Where
 * the relay is not reached, or closes a tunnel at once, it is tried again later, from half a second up to 30 seconds
 * apart; where the way in is given anew (`nudge`), at once.
 */
import net from "node:net";
import type { Reach } from "../../shared/docker-api";

export interface WayBackOptions {
  /** Where the way in was last given, or nothing before it was. */
  at: () => Promise<Reach> | undefined;
  /** The relay's key (the extension's `relay-secret`). */
  key: string;
  /** The loopback listener's port. */
  to: () => number;
  /** How many tunnels wait at once. */
  pool?: number;
}

export interface WayBack {
  /** Tunnels opened at once, where some are missing: the way in was given anew. */
  nudge(): void;
  /** How many tunnels are connected and wait, for tests. */
  waiting(): number;
  /** Every tunnel closed, the joined ones with them, and none opened again. */
  stop(): void;
}

/** What a tunnel opens with: a NUL (which no HTTP request starts with), the key, a newline. */
export function hello(key: string): Buffer {
  return Buffer.from(`\0${key}\n`);
}

/** Two connections joined as the relay joins them: half-closes passed on, a close or failure closes both. */
function join(a: net.Socket, b: net.Socket): void {
  for (const s of [a, b]) s.setNoDelay(true);
  const close = () => {
    a.destroy();
    b.destroy();
  };
  for (const s of [a, b]) {
    s.on("error", close);
    s.on("close", close);
  }
  a.pipe(b).pipe(a);
}

/** A tunnel that lived this long before it closed unused was fine: the next one is opened at once. */
const LIVED_MS = 10_000;

export function holdWayBack(options: WayBackOptions): WayBack {
  const pool = options.pool ?? 4;
  const greeting = hello(options.key);
  const sockets = new Set<net.Socket>();
  let opening = 0; // tunnels being opened, or waiting at the relay
  let connected = 0; // of those, the ones that wait
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const fill = () => {
    if (stopped) return;
    // Counted first: an open that fails at once gives its place back before the next is begun.
    const missing = pool - opening;
    opening += Math.max(0, missing);
    for (let i = 0; i < missing; i++) void open();
  };
  const later = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      fill();
    }, Math.min(30_000, 500 * 2 ** Math.min(failures - 1, 6)));
    timer.unref();
  };
  const failed = () => {
    opening--;
    failures++;
    later();
  };

  async function open(): Promise<void> {
    let at: Reach;
    try {
      const where = options.at();
      if (!where) return failed();
      at = await where;
    } catch {
      return failed();
    }
    if (stopped) {
      opening--;
      return;
    }
    const s = net.connect({ host: at.host, port: at.port, allowHalfOpen: true });
    sockets.add(s);
    let since = 0;
    let used = false;
    s.on("connect", () => {
      since = Date.now();
      connected++;
      s.setNoDelay(true);
      s.setKeepAlive(true, 30_000);
      s.write(greeting);
    });
    s.on("error", () => s.destroy());
    // The relay ended it while it waited (a relay that stops): closed, and another opened.
    s.on("end", () => {
      if (!used) s.destroy();
    });
    s.once("data", (chunk: Buffer) => {
      used = true;
      opening--;
      connected--;
      failures = 0;
      fill();
      s.pause();
      s.unshift(chunk);
      join(s, net.connect({ host: "127.0.0.1", port: options.to(), allowHalfOpen: true }));
    });
    s.on("close", () => {
      sockets.delete(s);
      if (used) return;
      if (since) connected--;
      if (since && Date.now() - since >= LIVED_MS) {
        opening--;
        failures = 0;
        fill();
      } else failed();
    });
  }

  fill();
  return {
    nudge() {
      failures = 0;
      if (timer) clearTimeout(timer);
      timer = undefined;
      fill();
    },
    waiting: () => connected,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const s of sockets) s.destroy();
    },
  };
}
