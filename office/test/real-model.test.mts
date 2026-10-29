import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { portalEnv, realModelMay, realModelProxy } from "./portal/real-model.mts";

/**
 * Case p of the real-portal test gives a real model, hosted perhaps, a chat in a portal on this machine with the sandbox
 * off: what keeps the model from a shell there and its key from the portal, held without a portal.
 */

test("the portal of the real-model run is started without the model's key or any other OFFICE_REAL_MODEL setting", () => {
  const env = portalEnv({ PATH: "/bin", HOME: "/h", OFFICE_REAL_MODEL_KEY: "sk-secret", OFFICE_REAL_MODEL_URL: "https://x/v1", OFFICE_REAL_MODEL: "m", OFFICE_E2E_PORT: "1" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", OFFICE_E2E_PORT: "1" });
});

test("the real model's proxy sends on only a request that offers the office tools alone, and adds the key itself", async () => {
  const got: { auth?: string; body: string }[] = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push({ auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = await realModelProxy(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, "sk-secret", realModelMay);
  try {
    const ask = (tools: string[]) => fetch(`${proxy.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [], tools: tools.map((name) => ({ type: "function", function: { name } })) }) });
    const shell = await ask(["office_read", "bash"]);
    assert.equal(shell.status, 403);
    assert.match(await shell.text(), /offers the model a tool other than the office tools \(offered: office_read, bash\)/);
    assert.equal(got.length, 0, "a request offering bash never reached the model");
    assert.deepEqual(proxy.refused, [["office_read", "bash"]]);
    const office = await ask(["office_read", "office_format"]);
    assert.equal(office.status, 200);
    assert.equal(got.length, 1);
    assert.equal(got[0].auth, "Bearer sk-secret");
    assert.ok(!["read", "write", "edit", "ls", "find", "grep", "tools", "ask_question"].some(realModelMay));
  } finally {
    proxy.close();
    upstream.close();
  }
});
