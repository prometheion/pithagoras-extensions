/**
 * The browser half's pure helpers (src/office-ui.ts): where a page address says its opened document, and the
 * client-side mirror of the server's floating-image-tag refusal. Plain node: no portal, no DOM.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentError, agentHealth, dsHealth, editorsIn, floatingTag, parseDocQuery, startingUp } from "../src/office-ui";

test("parseDocQuery: ?doc=<id> is the opened document; encoded ids come back decoded", () => {
  assert.equal(parseDocQuery("?doc=my-report"), "my-report");
  assert.equal(parseDocQuery("?doc=report%20one&x=1"), "report one");
  assert.equal(parseDocQuery("/office?doc=a-b-c_123"), "a-b-c_123");
});

test("parseDocQuery: no doc, an empty one, or other parameters mean the list view", () => {
  assert.equal(parseDocQuery(""), null);
  assert.equal(parseDocQuery("?folder=9&doc="), null);
  assert.equal(parseDocQuery("?x=1"), null);
});

test("floatingTag: :latest, :stable, @latest and no tag at all are refused, by the server and in the input", () => {
  assert.equal(floatingTag("onlyoffice/documentserver:latest"), true);
  assert.equal(floatingTag("onlyoffice/documentserver:LATEST"), true);
  assert.equal(floatingTag("onlyoffice/documentserver:stable"), true);
  assert.equal(floatingTag("registry.example/onlyoffice@latest"), true);
  assert.equal(floatingTag("onlyoffice/documentserver:10.0.0.1"), false);
  assert.equal(floatingTag("onlyoffice/documentserver@sha256:ca17889f"), false);
  // No tag is :latest to Docker; a registry's port is no tag.
  assert.equal(floatingTag("onlyoffice/documentserver"), true);
  assert.equal(floatingTag("registry.example:5000/onlyoffice/documentserver"), true);
  assert.equal(floatingTag("registry.example:5000/onlyoffice/documentserver:10.0.0.1"), false);
});

test("editorsIn: every doc has a locks entry (empty when nobody is in it); missing maps say none", () => {
  const locks = { a: [], b: [{ id: "u1", name: "n" }, { id: "u2" }] };
  assert.equal(editorsIn(locks, "a"), 0);
  assert.equal(editorsIn(locks, "b"), 2);
  assert.equal(editorsIn(undefined, "a"), 0);
});

test("startingUp: only the server half's 503 ds_starting is waited out; any other refusal is said", () => {
  const refusal = (status: number, body: Record<string, unknown>) => Object.assign(new Error("refused"), { status, body });
  assert.equal(startingUp(refusal(503, { code: "ds_starting" })), true);
  assert.equal(startingUp(refusal(503, { code: "ds_not_configured" })), false);
  assert.equal(startingUp(refusal(404, { code: "ds_starting" })), false);
  assert.equal(startingUp(new Error("network")), false);
  assert.equal(startingUp(null), false);
});

test("dsHealth: a download under way, running, starting, a start that failed (said over the state it left), stopped", () => {
  assert.equal(dsHealth({ state: "stopped", pull: { active: true } }), "downloading");
  assert.equal(dsHealth({ state: "running" }), "running");
  assert.equal(dsHealth({ state: "running", error: "an old failure" }), "running");
  assert.equal(dsHealth({ state: "starting" }), "starting");
  assert.equal(dsHealth({ state: "restarting" }), "starting");
  assert.equal(dsHealth({ state: "stopped", error: "Docker is not reachable" }), "failed");
  assert.equal(dsHealth({ state: "stopped", pull: { active: false } }), "stopped");
  assert.equal(dsHealth({ state: "foreign" }), "other");
});

test("agentHealth: its download, its image missing or refused, and the browser made from it", () => {
  const browser = { running: false, starting: false, editors: 0 };
  assert.equal(agentHealth({ present: false, pull: { active: true } }), "downloading");
  assert.equal(agentHealth({ present: false, pull: null }), "missing");
  assert.equal(agentHealth({ present: false, pull: { active: false, error: "not the build" } }), "failed");
  assert.equal(agentHealth({ present: true, pull: { active: false }, browser }), "ready");
  assert.equal(agentHealth({ present: true, pull: null, browser: { ...browser, starting: true } }), "starting");
  assert.equal(agentHealth({ present: true, pull: null, browser: { ...browser, running: true, editors: 2 } }), "running");
  assert.equal(agentHealth({ present: true, pull: null, browser: { ...browser, error: "did not start" } }), "failed");
  // A download that failed before is over once the image is there.
  assert.equal(agentHealth({ present: true, pull: { active: false, error: "old" }, browser }), "ready");
  assert.equal(agentError({ present: false, pull: { error: "not the build" }, browser: { error: "x" } }), "not the build");
  assert.equal(agentError({ present: true, pull: { error: "old" }, browser: { error: "did not start" } }), "did not start");
});
