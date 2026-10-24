import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { mcpClient } from "../../shared/mcp.ts";
import { relay } from "../../shared/relay.ts";
import { ACTS, LABELS } from "../src/labels.ts";
import { blenderCalls, RENDERS } from "../src/server/calls.ts";
import { BUNDLED, fakeMcp, fakePortal } from "./fakes.mts";

/** What the extension does around a call of Blender's tools, in the chat it is made in: a render shown in the chat. */

/** A PNG's first bytes, which is what the portal tells a picture by. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function setup() {
  const server = await fakeMcp("tok");
  const fake = fakePortal();
  const mcp = mcpClient({ url: async () => server.url, token: () => "tok" });
  const tools = relay({ portal: fake.portal, prefix: "blender", app: "Blender", mcp, bundled: BUNDLED, labels: LABELS, acts: ACTS, installedFile: path.join(fake.dataDir, "installed"), calls: blenderCalls(fake.portal) });
  tools.setInstalled(true);
  const tool = (name: string) => fake.registered().find((t) => t.name === `blender_${name}`);
  const sent = (name: string) => server.seen.filter((s) => s.method === "tools/call" && s.params.name === name).map((s) => s.params.arguments);
  server.answers.render = () => ({ content: [{ type: "text", text: '{\n "path": "/data/renders/hero.png",\n "engine": "CYCLES"\n}' }, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }], isError: false });
  return { server, fake, tool, sent };
}

test("a render is put in the chat's folder, under a name of the extension's, and the call gives it to the chat", async () => {
  const { fake, tool, sent } = await setup();
  const result = await tool("render").execute("c1", { samples: 16 });
  assert.deepEqual(sent("render"), [{ samples: 16, return_image: true }]);
  const [file] = result.details.files;
  assert.match(file.path, new RegExp(`^${RENDERS}/render-\\d{8}-\\d{6}-[0-9a-f]{6}\\.png$`));
  assert.equal(file.title, "hero.png", "titled with the file the server rendered to");
  assert.deepEqual(readFileSync(path.join(fake.chatDir, file.path)), PNG);
  // The model gets what the server gave, the picture among it, and where the chat's copy is.
  assert.deepEqual(result.content.slice(0, 2).map((p: any) => p.type), ["text", "image"]);
  assert.equal(result.content[1].data, PNG.toString("base64"));
  assert.equal(result.content[2].text, `Shown to the person in the chat, and saved in the chat's folder as ${file.path}.`);
  // A second one is a file of its own, beside the first, in the folder that is there now.
  const again = await tool("render").execute("c2", {});
  assert.notEqual(again.details.files[0].path, file.path);
});

test("a model that asks for no picture gets none, and the person still sees the render", async () => {
  const { fake, tool, sent } = await setup();
  const result = await tool("render").execute("c1", { return_image: false });
  assert.deepEqual(sent("render"), [{ return_image: true }], "the server is asked for the picture all the same");
  assert.deepEqual(result.content.map((p: any) => p.type), ["text", "text"]);
  assert.deepEqual(readFileSync(path.join(fake.chatDir, result.details.files[0].path)), PNG);
});

test("a render that cannot be put in the chat's folder is still the model's, which is told why the chat lacks it", async () => {
  const { fake, tool } = await setup();
  fake.files.makeFolder = () => {
    throw Object.assign(new Error("read-only file system"), { code: "failed" });
  };
  const result = await tool("render").execute("c1", {});
  assert.deepEqual(result.details, {});
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[2].text, "The render could not be shown in the chat: read-only file system");
  assert.match(fake.logs.join("\n"), /could not put a render in the chat's folder: read-only file system/);
});

test("a render that failed fails the call, and nothing is put in the chat's folder", async () => {
  const { server, fake, tool } = await setup();
  server.answers.render = () => ({ content: [{ type: "text", text: "ValueError: scene has no active camera" }], isError: true });
  await assert.rejects(tool("render").execute("c1", {}), /scene has no active camera/);
  assert.throws(() => readFileSync(path.join(fake.chatDir, RENDERS)), /ENOENT/);
});

test("the other tools' calls go to the server as the model gave them, and come back as the server answered", async () => {
  const { server, tool, sent } = await setup();
  server.answers.preview = () => ({ content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], isError: false });
  const result = await tool("preview").execute("c1", { return_image: true });
  assert.deepEqual(sent("preview"), [{ return_image: true }]);
  assert.deepEqual(result, { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], details: {} });
});
