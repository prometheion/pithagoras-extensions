import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Case p of real-portal.test.mts, its real model: what the model may be offered, the proxy it is reached through, and
 * the environment the portal is started with. Apart from the test so that test/real-model.test.mts holds them without a
 * portal.
 */

/** The environment the portal on the machine is started with: this one's, without the real model's settings, so its
 * key reaches neither the portal nor what the portal runs (pi's bash runs with the portal's environment). */
export function portalEnv(from: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(from).filter(([k]) => !k.startsWith("OFFICE_REAL_MODEL")));
}

/** pi's own tools, which a chat has before the portal has seen it registered any: switched off for case p's chat. */
export const PI_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** The tools a real model may be offered (case p): the office tools alone. Nothing else, so a hosted model has no shell
 * and no file tools on this machine, where the portal runs with the sandbox off. */
export const realModelMay = (name: string) => /^office_[a-z]+$/.test(name);

/**
 * A proxy to an OpenAI-compatible model API at `base` (".../v1"): what the portal sends to `<url>/<path>` goes to
 * `<base>/<path>`, with the key where one is given, and every request's JSON is kept (`requests`), so a test reads the
 * tool calls a model made and the results it got. The answers pass through as they come (streamed). A request that
 * offers the model a tool `may` does not allow is not sent on: it is answered 403 and its tools kept (`refused`).
 */
export async function realModelProxy(base: string, key: string | undefined, may: (tool: string) => boolean): Promise<{ url: string; requests: unknown[]; refused: string[][]; close: () => void }> {
  const requests: unknown[] = [];
  const refused: string[][] = [];
  const target = base.replace(/\/+$/, "");
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let sent: { tools?: { function?: { name?: string }; name?: string }[] } | undefined;
      try {
        sent = JSON.parse(body.toString("utf8"));
        requests.push(sent);
      } catch {
        // not JSON (a GET): nothing to keep
      }
      const offered = (sent?.tools ?? []).map((t) => String(t.function?.name ?? t.name ?? ""));
      if (offered.some((name) => !may(name))) {
        refused.push(offered);
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `the test's proxy sends no request that offers the model a tool other than the office tools (offered: ${offered.join(", ")})` } }));
        return;
      }
      const headers: Record<string, string> = { "content-type": String(req.headers["content-type"] ?? "application/json") };
      if (key) headers.authorization = `Bearer ${key}`;
      void fetch(`${target}${String(req.url).replace(/^\/v1/, "")}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }).then(
        async (answer) => {
          res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
          if (answer.body) for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
          res.end();
        },
        (e: Error) => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `the model's API did not answer: ${e.message}` } }));
        },
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, refused, close: () => server.close() };
}

