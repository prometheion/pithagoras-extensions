/** The address as it is judged when it is saved, and the account as the Nextcloud itself answers for it. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkAccount, checkAccountSoon, forgetAccount, normalizeUrl } from "../src/account.ts";

test("an address is https, or http where the person chose it; no login in it, no query, no trailing slash", () => {
  assert.deepEqual(normalizeUrl("https://cloud.example.org/", false), { url: "https://cloud.example.org" });
  assert.deepEqual(normalizeUrl(" https://cloud.example.org/nextcloud// ", false), { url: "https://cloud.example.org/nextcloud" });
  assert.deepEqual(normalizeUrl("https://cloud.example.org:8443", false), { url: "https://cloud.example.org:8443" });
  assert.deepEqual(normalizeUrl("http://nas.lan", true), { url: "http://nas.lan" });
  for (const [bad, why] of [
    ["", /missing/],
    ["cloud.example.org", /not an address|scheme/],
    ["http://nas.lan", /unencrypted/],
    ["file:///etc/passwd", /https/],
    ["ftp://cloud.example.org", /https/],
    ["https://anna:secret@cloud.example.org", /login/],
    ["https://cloud.example.org/?a=1", /query/],
    ["javascript:alert(1)", /https/],
  ] as const) {
    const result = normalizeUrl(bad, false);
    assert.ok("error" in result, `${bad} is refused`);
    assert.match((result as { error: string }).error, why, bad);
  }
});

let basic = "Basic " + Buffer.from("anna:good").toString("base64");
let mode: "nextcloud" | "html" | "error" | "slow" = "nextcloud";
let asked = 0;
const nc = http.createServer((req, res) => {
  asked++;
  if (mode === "slow") return void setTimeout(() => res.end("{}"), 300);
  if (req.url?.startsWith("/ocs/v2.php/cloud/user") && req.headers["ocs-apirequest"] === "true") {
    if (req.headers.authorization !== basic) return res.writeHead(401).end("{}");
    if (mode === "html") return res.writeHead(200, { "content-type": "text/html" }).end("<html>a login page</html>");
    if (mode === "error") return res.writeHead(500).end("boom");
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ocs: { data: { id: "anna", displayname: "Anna Example" } } }));
  }
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => nc.listen(0, "127.0.0.1", () => resolve()));
const url = `http://127.0.0.1:${(nc.address() as AddressInfo).port}`;
after(() => {
  nc.closeAllConnections();
  nc.close();
});
const inst = (password: string) => ({ name: "uni", url, username: "anna", password });

test("the account is asked of the Nextcloud: ok with its name, refused, not Nextcloud, not reachable", async () => {
  assert.deepEqual(await checkAccount(inst("good")), { state: "ok", name: "Anna Example" });
  const refused = await checkAccount(inst("revoked"));
  assert.equal(refused.state, "unauthorized");
  mode = "html";
  assert.equal((await checkAccount(inst("good-html") as never)).state, "unauthorized", "a wrong password is refused whatever the page");
  basic = "Basic " + Buffer.from("anna:good-html").toString("base64");
  forgetAccount(inst("good-html"));
  assert.equal((await checkAccount(inst("good-html"))).state, "other");
  mode = "error";
  assert.equal((await checkAccount(inst("good-html"))).state, "other", "kept for a minute");
  forgetAccount(inst("good-html"));
  assert.match((await checkAccount(inst("good-html"))).error ?? "", /500/);
  const gone = await checkAccount({ name: "x", url: "http://127.0.0.1:9", username: "a", password: "b" });
  assert.equal(gone.state, "unreachable");
  assert.match(gone.error ?? "", /could not be reached/);
});

test("the answer is kept for a minute: the status asking often does not ask the Nextcloud each time", async () => {
  mode = "nextcloud";
  basic = "Basic " + Buffer.from("anna:kept").toString("base64");
  const before = asked;
  await checkAccount(inst("kept"));
  await checkAccount(inst("kept"));
  await Promise.all([checkAccount(inst("kept")), checkAccount(inst("kept"))]);
  assert.equal(asked - before, 1);
});

test("a host that is slow to answer shows as checking, and the answer is there by the next look", async () => {
  mode = "slow";
  basic = "Basic " + Buffer.from("anna:slow").toString("base64");
  assert.deepEqual(await checkAccountSoon(inst("slow"), 30), { state: "checking" });
  await new Promise((r) => setTimeout(r, 400));
  assert.notEqual((await checkAccountSoon(inst("slow"), 30)).state, "checking");
});
