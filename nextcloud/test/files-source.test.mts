import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ANSWER_BYTES, MAX_FILE_BYTES, buildSource, cleanPath, dropSources, errorFromTool, filesHookOf, sourceIdOf, syncSources, wantedSources, type FilesHook, type FilesSource, type SourceContext, type SourceDeps, SourceError } from "../src/files-source.ts";
import type { NextcloudInstance } from "../src/config.ts";
import type { McpResult } from "../src/ncmcp.ts";

/**
 * Nextcloud's files as a source in Files: what it lists, reads, gives to download and saves through the WebDAV tools of the MCP
 * server, who sees it, what it does when Nextcloud is down, and how it is kept in step with Files being there or not. The tools are a
 * small WebDAV of a few files in memory, answering in the shapes the panel's Files tab reads (web/files.tsx).
 */

const inst = (over: Partial<NextcloudInstance> = {}): NextcloudInstance => ({ name: "nextcloud", url: "https://cloud.example.org", username: "anna", password: "pw", ...over });
const primary = { id: "owner", name: "Owner", role: "primary" as const };
const context = (over: Partial<SourceContext> = {}): SourceContext => ({ chatId: "chat1", owner: { kind: "agent" }, person: primary, ...over });

const text = (value: unknown): McpResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refused = (words: string): McpResult => ({ isError: true, content: [{ type: "text", text: words }] });

interface Stored {
  content: string; // text, or base64 where `base64`
  etag: string;
  base64?: boolean;
  type?: string;
  size?: number;
}

/** A WebDAV of a few lines behind the tools the source calls, with the rule of the real server for writes: a file that is there is
 * written only against the etag it has (`if_match`), a new one without. Every call is kept in `calls`. */
function webdav(initial: Record<string, Stored> = {}) {
  const files = new Map<string, Stored>(Object.entries(initial));
  const dirs: Record<string, { name: string; is_directory: boolean; size?: number; content_type?: string; last_modified?: unknown }[]> = {
    "": [{ name: "Docs", is_directory: true }, { name: "notes.txt", is_directory: false, size: 5, content_type: "text/plain", last_modified: "Wed, 21 Oct 2026 07:28:00 GMT" }, { name: "huge.bin", is_directory: false, size: 20 * 1024 * 1024 }],
    Docs: [{ name: "readme.md", is_directory: false, size: 3, last_modified: 1_700_000_000 }],
  };
  const state = { files, dirs, calls: [] as { tool: string; args: any }[], limits: [] as { timeoutMs: number; maxBytes: number }[], etag: 100, fail: undefined as string | Error | undefined, hang: false, noEtagOnWrite: false };
  const call: SourceDeps["call"] = async (_inst, tool, args, limits) => {
    state.calls.push({ tool, args });
    state.limits.push(limits);
    if (state.hang) await new Promise(() => {});
    if (state.fail) throw typeof state.fail === "string" ? new Error(state.fail) : state.fail;
    if (tool === "nc_webdav_list_directory") {
      const rows = dirs[(args.path as string | undefined) ?? ""];
      return rows ? text({ files: rows }) : refused(`Not found: ${args.path}`);
    }
    if (tool === "nc_webdav_read_file") {
      const file = files.get(args.path as string);
      if (!file) return refused(`Not found: ${args.path}`);
      return text({ path: args.path, content: file.content, etag: file.etag, ...(file.base64 ? { encoding: "base64" } : {}), ...(file.type ? { content_type: file.type } : {}) });
    }
    if (tool === "nc_webdav_write_file") {
      const there = files.get(args.path as string);
      if (args.if_match === undefined && there) return refused(`The file ${args.path} already exists`);
      if (args.if_match !== undefined && (!there || there.etag !== args.if_match)) return refused("412 Precondition Failed: the file has changed since it was read");
      const etag = `e${++state.etag}`;
      files.set(args.path as string, { content: args.content as string, etag });
      return text({ path: args.path, created: !there, ...(state.noEtagOnWrite ? {} : { etag }) });
    }
    return refused(`no stand-in for ${tool}`);
  };
  return Object.assign(state, { call });
}

function setup(over: { instance?: NextcloudInstance | undefined; persons?: boolean; files?: Record<string, Stored> } = {}) {
  const dav = webdav(over.files ?? { "notes.txt": { content: "hello", etag: "e1", type: "text/plain" } });
  const holder = { inst: "instance" in over ? over.instance : inst() };
  const logged: string[] = [];
  const deps: SourceDeps = { instance: (name) => (holder.inst?.name === name ? holder.inst : undefined), call: dav.call, personsKnown: () => over.persons ?? true, log: (line) => void logged.push(line) };
  const source = buildSource("nextcloud", "Nextcloud", deps);
  return { dav, source, holder, deps, logged };
}

test("a folder is listed with its entries as Files takes them, and the root asks for no path", async () => {
  const { source, dav } = setup();
  const root = await source.list("", context());
  assert.deepEqual(dav.calls[0], { tool: "nc_webdav_list_directory", args: {} });
  assert.deepEqual(root, [
    { name: "Docs", type: "dir" },
    { name: "notes.txt", type: "file", size: 5, mtime: Date.parse("Wed, 21 Oct 2026 07:28:00 GMT") },
    { name: "huge.bin", type: "file", size: 20 * 1024 * 1024 },
  ]);
  assert.deepEqual(await source.list("Docs", context()), [{ name: "readme.md", type: "file", size: 3, mtime: 1_700_000_000_000 }]);
  assert.deepEqual(dav.calls[1], { tool: "nc_webdav_list_directory", args: { path: "Docs" } });
});

test("a file is read as text with a version stamp that changes with its etag, and as bytes when it is not text", async () => {
  const { source, dav } = setup({ files: { "notes.txt": { content: "hello", etag: "e1", type: "text/plain" }, "a.bin": { content: Buffer.from([0, 1, 2, 255]).toString("base64"), etag: "e2", base64: true, type: "application/octet-stream" }, "b64.txt": { content: Buffer.from("häh\n").toString("base64"), etag: "e3", base64: true }, "pic.png": { content: "AAEC", etag: "e4", type: "image/png" } } });
  const one = await source.read("notes.txt", context());
  assert.ok("content" in one && one.content === "hello");
  assert.deepEqual(dav.calls[0], { tool: "nc_webdav_read_file", args: { path: "notes.txt", parse_document: "raw" } }, "raw: what is shown is the file, never an extract of it");
  assert.ok(Number.isSafeInteger(one.mtime) && one.mtime! > 0);
  assert.equal((await source.read("notes.txt", context())).mtime, one.mtime, "the same version, the same stamp");
  dav.files.set("notes.txt", { content: "hello", etag: "e9", type: "text/plain" });
  assert.notEqual((await source.read("notes.txt", context())).mtime, one.mtime, "another etag, another stamp");

  const bin = await source.read("a.bin", context());
  assert.ok("bytes" in bin && Buffer.from(bin.bytes).equals(Buffer.from([0, 1, 2, 255])));
  const b64 = await source.read("b64.txt", context());
  assert.ok("content" in b64 && b64.content === "häh\n", "base64 that is UTF-8 text is shown as text");
  const pic = await source.read("pic.png", context());
  assert.ok("bytes" in pic, "a content type that is not text, with no word of encoding, is base64");
});

test("a file that is not there is `missing`, a folder listing that fails shows the server's words", async () => {
  const { source } = setup();
  await assert.rejects(source.read("nope.txt", context()), { code: "missing", message: /no such file/i });
  await assert.rejects(source.list("Nope", context()), { code: "missing" });
});

test("a file over the limit is not pulled in when the listing has told its size, nor passed on when its answer is that big", async () => {
  const { source, dav } = setup();
  await source.list("", context());
  dav.calls.length = 0;
  await assert.rejects(source.read("huge.bin", context()), { code: "too_large" });
  assert.equal(dav.calls.length, 0, "nothing was asked of Nextcloud");
  // not listed first: the answer itself is too much
  const big = setup({ files: { "big.txt": { content: "x".repeat(MAX_FILE_BYTES + 1), etag: "e1" }, "big.bin": { content: Buffer.alloc(MAX_FILE_BYTES + 3).toString("base64"), etag: "e2", base64: true } } });
  await assert.rejects(big.source.read("big.txt", context()), { code: "too_large" });
  await assert.rejects(big.source.read("big.bin", context()), { code: "too_large" });
});

test("the download address is Nextcloud's own WebDAV address of the file, each name encoded, with no login in it", () => {
  const { source } = setup({ instance: inst({ url: "https://cloud.example.org/nc", username: "anna@example.org", password: "secret-pw" }) });
  const url = source.url("Docs/a b/ü?.txt", context());
  assert.equal(url, "https://cloud.example.org/nc/remote.php/dav/files/anna%40example.org/Docs/a%20b/%C3%BC%3F.txt");
  assert.ok(!url.includes("secret-pw"));
  assert.throws(() => source.url("", context()), { code: "invalid" });
});

test("a save is written against the etag the file has now, and answers with the stamp a later read gives", async () => {
  const { source, dav } = setup();
  const read = await source.read("notes.txt", context());
  const saved = await source.write("notes.txt", "hello world", { ...context(), expected: read.mtime });
  assert.equal(dav.files.get("notes.txt")!.content, "hello world");
  const writes = dav.calls.filter((c) => c.tool === "nc_webdav_write_file");
  assert.deepEqual(writes.map((c) => c.args), [{ path: "notes.txt", content: "hello world", if_match: "e1" }]);
  assert.equal(saved.mtime, (await source.read("notes.txt", context())).mtime, "the stamp it gave back is the one the next read gives");
  // and saved again from the stamp it gave
  await source.write("notes.txt", "third", { ...context(), expected: saved.mtime });
  assert.equal(dav.files.get("notes.txt")!.content, "third");
});

test("a file changed since it was read is `conflict`, and nothing is written", async () => {
  const { source, dav } = setup();
  const read = await source.read("notes.txt", context());
  dav.files.set("notes.txt", { content: "someone else's", etag: "e7" });
  await assert.rejects(source.write("notes.txt", "mine", { ...context(), expected: read.mtime }), { code: "conflict" });
  assert.equal(dav.files.get("notes.txt")!.content, "someone else's");
  assert.equal(dav.calls.filter((c) => c.tool === "nc_webdav_write_file").length, 0);
  // gone since it was read
  dav.files.delete("notes.txt");
  await assert.rejects(source.write("notes.txt", "mine", { ...context(), expected: read.mtime }), { code: "conflict" });
});

test("a change between the check and the write is `conflict` as well: the server's 412 is told apart", async () => {
  const { source, dav } = setup();
  const read = await source.read("notes.txt", context());
  const call = dav.call;
  const racing: SourceDeps = { instance: () => inst(), personsKnown: () => true, call: async (i, tool, args, limits) => {
    if (tool === "nc_webdav_write_file") dav.files.set("notes.txt", { content: "raced", etag: "e8" }); // lands just before the write
    return call(i, tool, args, limits);
  } };
  await assert.rejects(buildSource("nextcloud", "Nextcloud", racing).write("notes.txt", "mine", { ...context(), expected: read.mtime }), { code: "conflict" });
  assert.equal(dav.files.get("notes.txt")!.content, "raced");
});

test("\"save anyway\" (no `expected`) writes over the version there is, and a new file is created without an etag", async () => {
  const { source, dav } = setup();
  await source.write("notes.txt", "over", context());
  assert.equal(dav.files.get("notes.txt")!.content, "over");
  await source.write("new.txt", "fresh", context());
  assert.equal(dav.files.get("new.txt")!.content, "fresh");
  assert.deepEqual(dav.calls.filter((c) => c.tool === "nc_webdav_write_file").map((c) => "if_match" in c.args), [true, false]);
});

test("a file whose version Nextcloud does not name is not overwritten blindly", async () => {
  const { dav } = setup();
  const call = dav.call;
  const mute: SourceDeps = { instance: () => inst(), personsKnown: () => true, call: async (i, tool, args, limits) => {
    const result = await call(i, tool, args, limits);
    return tool === "nc_webdav_read_file" ? text({ content: "hello" }) : result; // no etag in the answer
  } };
  await assert.rejects(buildSource("nextcloud", "Nextcloud", mute).write("notes.txt", "x", context()), { code: "failed", message: /which version/ });
  assert.equal(dav.files.get("notes.txt")!.content, "hello");
});

test("only the primary person sees it, and only where an instance is set up with its Files on", () => {
  const { source, holder } = setup();
  assert.equal(source.visible(context()), true);
  for (const role of ["colleague", "guest", "unknown"] as const) assert.equal(source.visible(context({ person: { id: "x", name: "X", role } })), false, role);
  assert.equal(source.visible(context({ person: undefined })), false, "a portal that tells people apart, and a request with none");
  holder.inst = inst({ capabilities: { files: false } });
  assert.equal(source.visible(context()), false, "Files switched off for the instance");
  holder.inst = inst({ password: "" });
  assert.equal(source.visible(context()), false, "not set up completely");
  holder.inst = undefined;
  assert.equal(source.visible(context()), false, "no such instance any more");
  // a portal before 0.3.0 does not tell people apart: the routes of this extension are open to whoever is signed in, and so is this
  const old = setup({ persons: false });
  assert.equal(old.source.visible(context({ person: undefined })), true);
});

test("visible asks no one: it is the settings alone", () => {
  const { source, dav } = setup();
  source.visible(context());
  assert.equal(dav.calls.length, 0);
});

test("a Nextcloud that is down or slow is the source's error and no one else's, in words that carry no address; the detail goes to the log", async () => {
  const { source, dav, logged } = setup();
  dav.fail = "The MCP server at http://127.0.0.1:8000/mcp could not be reached: fetch failed";
  for (const call of [() => source.list("", context()), () => source.read("notes.txt", context())]) {
    await assert.rejects(call(), (error: Error) => /could not be reached/.test(error.message) && !/127\.0\.0\.1|8000|fetch failed/.test(error.message));
  }
  assert.match(logged.join("\n"), /127\.0\.0\.1:8000\/mcp could not be reached: fetch failed/, "the log has the address");
  dav.fail = Object.assign(new Error("The MCP server at http://127.0.0.1:8000/mcp could not be reached: it took longer than 25 s"), { code: "E_TIMEOUT" }) as never;
  await assert.rejects(source.write("notes.txt", "x", context()), (error: Error) => /did not answer in time/.test(error.message) && !/127\.0\.0\.1/.test(error.message));
  dav.fail = undefined;
  assert.equal((await source.list("", context())).length, 3, "and it works again when Nextcloud is back");
});

test("an answer that is not what the tool gives is `failed` with a word, not a crash", async () => {
  const odd: SourceDeps = { instance: () => inst(), personsKnown: () => true, call: async () => ({ content: [{ type: "text", text: "not json" }] }) };
  const source = buildSource("nextcloud", "Nextcloud", odd);
  await assert.rejects(source.list("", context()), { code: "failed" });
  await assert.rejects(source.read("a", context()), { code: "failed" });
  const noFiles: SourceDeps = { ...odd, call: async () => text({ elsewhere: [] }) };
  await assert.rejects(buildSource("nextcloud", "Nextcloud", noFiles).list("", context()), { code: "failed" });
});

test("an instance that is gone or not set up is said, and no tool is called", async () => {
  const { source, dav, holder } = setup();
  holder.inst = undefined;
  await assert.rejects(source.list("", context()), { code: "missing", message: /gone/ });
  holder.inst = inst({ username: "" });
  await assert.rejects(source.list("", context()), { code: "failed", message: /not set up/ });
  assert.equal(dav.calls.length, 0);
});

test("only Nextcloud paths reach WebDAV: nothing that goes up, nothing absolute, nothing that is a path of this machine", async () => {
  const { source, dav } = setup();
  const bad = ["..", "../etc/passwd", "a/../b", "a/./b", "/etc/passwd", "a//b", "a/", "a\\b", "a\0b", "x".repeat(4097), "C:\\Users\\anna"];
  for (const path of bad) {
    await assert.rejects(source.list(path, context()), { code: "invalid" }, JSON.stringify(path));
    await assert.rejects(source.read(path, context()), { code: "invalid" }, JSON.stringify(path));
    await assert.rejects(source.write(path, "x", context()), { code: "invalid" }, JSON.stringify(path));
    assert.throws(() => source.url(path, context()), { code: "invalid" }, JSON.stringify(path));
  }
  await assert.rejects(source.read("", context()), { code: "invalid" }, "the root is not a file");
  await assert.rejects(source.list(5 as never, context()), { code: "invalid" });
  assert.equal(dav.calls.length, 0, "not one tool call was made for any of them");
  // and the chat's folder, its owner and the rest of the context are no part of a path
  const seen = setup();
  await seen.source.list("Docs", context({ chatId: "../../escape", owner: { kind: "project", name: "/root/repos" } }));
  assert.deepEqual(seen.dav.calls.map((c) => c.args), [{ path: "Docs" }]);
  assert.equal(cleanPath("a/b", "file"), "a/b");
});

test("what the MCP server says in failing is told apart by its words", () => {
  assert.equal(errorFromTool("412 Precondition Failed: the file has changed since it was read").code, "conflict");
  assert.equal(errorFromTool("The file a.txt already exists").code, "exists");
  assert.equal(errorFromTool("Not found: /a.txt").code, "missing");
  assert.equal(errorFromTool("413 Request Entity Too Large").code, "too_large");
  assert.equal(errorFromTool("Something broke").code, undefined);
  assert.ok(errorFromTool("x") instanceof SourceError);
});

// ---- registered with Files ---------------------------------------------------------------------------------

/** Files' hook in a few lines: the sources it holds, by id; and what it refuses. */
function hook(refuse: string[] = []) {
  const held = new Map<string, FilesSource>();
  const api: FilesHook = {
    sources: {
      register: (source) => {
        if (refuse.includes(source.id)) throw new TypeError(`Another extension already has a source called "${source.id}"`);
        held.set(source.id, source);
      },
      unregister: (id) => void held.delete(id),
    },
  };
  return { held, api };
}
const noDeps: SourceDeps = { instance: () => undefined, call: async () => text({}), personsKnown: () => true };

test("the source id and label follow the instances; nothing is set up, nothing is registered", () => {
  assert.equal(sourceIdOf("nextcloud"), "nextcloud");
  assert.equal(sourceIdOf("work"), "nextcloud-work");
  assert.ok(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sourceIdOf("A".repeat(48))));
  assert.deepEqual(wantedSources([]), []);
  assert.deepEqual(wantedSources([inst({ url: "" })]), [], "not set up completely");
  assert.deepEqual(wantedSources([inst({ capabilities: { files: false } })]), [], "Files off for the instance");
  assert.deepEqual(wantedSources([inst()]), [{ id: "nextcloud", name: "nextcloud", label: "Nextcloud" }]);
  assert.deepEqual(wantedSources([inst(), inst({ name: "work" }), inst({ name: "half", password: "" })]).map((w) => w.label), ["Nextcloud (nextcloud)", "Nextcloud (work)"]);
});

test("syncSources registers each set-up instance, follows a save and a removal, and drops all on stop", () => {
  const { held, api } = hook();
  const registered = new Set<string>();
  const logged: string[] = [];
  const log = (text: string) => void logged.push(text);
  syncSources(api, registered, [], noDeps, log);
  assert.deepEqual([...held.keys()], []);
  syncSources(api, registered, [inst()], noDeps, log);
  assert.deepEqual([...held.keys()], ["nextcloud"]);
  assert.equal(held.get("nextcloud")!.label, "Nextcloud");
  syncSources(api, registered, [inst(), inst({ name: "work" })], noDeps, log);
  assert.deepEqual([...held.keys()].sort(), ["nextcloud", "nextcloud-work"]);
  assert.equal(held.get("nextcloud")!.label, "Nextcloud (nextcloud)", "the label follows the count");
  syncSources(api, registered, [inst({ name: "work" })], noDeps, log);
  assert.deepEqual([...held.keys()], ["nextcloud-work"]);
  syncSources(api, registered, [inst({ name: "work", capabilities: { files: false } })], noDeps, log);
  assert.deepEqual([...held.keys()], [], "Files switched off for the instance");
  syncSources(api, registered, [inst({ name: "work" })], noDeps, log);
  dropSources(api, registered);
  assert.deepEqual([...held.keys()], []);
  assert.equal(registered.size, 0);
  assert.deepEqual(logged, []);
});

test("without Files, or with an older one, nothing is done and nothing breaks", () => {
  const registered = new Set<string>();
  syncSources(undefined, registered, [inst()], noDeps, () => assert.fail("no word to say"));
  assert.equal(registered.size, 0);
  dropSources(undefined, registered);
  // `use` gives nothing: Files not there, switched off, or in a version the range does not take
  assert.equal(filesHookOf(() => undefined), undefined);
  // a host that does not know `optional` refuses the name
  assert.equal(filesHookOf(() => { throw new Error("pithagoras-files is not one this builds on"); }), undefined);
  // a Files that is there but has no sources in what it gives
  assert.equal(filesHookOf(() => ({})), undefined);
  assert.equal(filesHookOf(() => ({ sources: { register: () => {} } })), undefined);
  const { api } = hook();
  assert.equal(filesHookOf((name) => (name === "pithagoras-files" ? api : undefined)), api);
});

test("a source Files refuses is left out and said, and the others still come", () => {
  const { held, api } = hook(["nextcloud"]);
  const registered = new Set<string>();
  const logged: string[] = [];
  syncSources(api, registered, [inst(), inst({ name: "work" })], noDeps, (text) => void logged.push(text));
  assert.deepEqual([...held.keys()], ["nextcloud-work"]);
  assert.deepEqual([...registered], ["nextcloud-work"]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /nextcloud.*Another extension/);
});

test("the registered source is the live one: it follows the settings it is asked with, not the ones it was made with", async () => {
  const { held, api } = hook();
  const holder = { inst: inst() as NextcloudInstance | undefined };
  const calls: string[] = [];
  const deps: SourceDeps = { instance: () => holder.inst, call: async (_i, tool) => (calls.push(tool), text({ files: [] })), personsKnown: () => true };
  syncSources(api, new Set(), [inst()], deps, () => {});
  const source = held.get("nextcloud")!;
  assert.equal(source.visible(context()), true);
  assert.deepEqual(await source.list("", context()), []);
  holder.inst = undefined; // removed in Settings: the source stays registered until the next sync, and shows to no one
  assert.equal(source.visible(context()), false);
  assert.deepEqual(calls, ["nc_webdav_list_directory"]);
});

// ---- review round 1 ------------------------------------------------------------------------------------------

test("a save whose answer has no etag still hands back the file's version: the next save from the same view is checked, not a \"save anyway\"", async () => {
  const { source, dav } = setup();
  const opened = await source.read("notes.txt", context());
  dav.noEtagOnWrite = true; // a proxy strips the etag from the write's answer
  const first = await source.write("notes.txt", "mine1", { ...context(), expected: opened.mtime });
  assert.ok(first.mtime !== undefined && first.mtime > 0, "a version, not nothing (Files would keep 0)");
  assert.equal(first.mtime, (await source.read("notes.txt", context())).mtime, "and it is the version the file has now");
  dav.files.set("notes.txt", { content: "someone else's", etag: "other" });
  await assert.rejects(source.write("notes.txt", "mine2", { ...context(), expected: first.mtime }), { code: "conflict" });
  assert.equal(dav.files.get("notes.txt")!.content, "someone else's");
});

test("one call of Files has one time for all its tool calls: each gets what is left, and a save is not begun with too little of it", async () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const { dav, deps } = setup();
    const slow: SourceDeps = { ...deps, callMs: 10_000, call: async (i, tool, args, limits) => {
      const answer = await dav.call(i, tool, args, limits);
      if (tool === "nc_webdav_read_file") now += 4_000; // the pre-read of a save is slow
      return answer;
    } };
    const source = buildSource("nextcloud", "Nextcloud", slow);
    await source.write("notes.txt", "x", context());
    assert.deepEqual(dav.limits.map((l) => l.timeoutMs), [10_000, 6_000], "the write gets what the pre-read left");
    assert.ok(dav.limits.every((l) => l.maxBytes === MAX_ANSWER_BYTES));
    // a pre-read that takes nearly all of it: nothing is written, since Files will have reported the failure by the time it would land
    dav.calls.length = 0;
    const slower: SourceDeps = { ...slow, call: async (i, tool, args, limits) => {
      const answer = await dav.call(i, tool, args, limits);
      if (tool === "nc_webdav_read_file") now += 9_000;
      return answer;
    } };
    await assert.rejects(buildSource("nextcloud", "Nextcloud", slower).write("notes.txt", "y", context()), /did not answer in time/);
    assert.deepEqual(dav.calls.map((c) => c.tool), ["nc_webdav_read_file"], "no write was sent");
  } finally {
    Date.now = realNow;
  }
});

test("a status in the words counts, a number in a path does not: a folder called 412 is `missing`, not a conflict", async () => {
  assert.equal(errorFromTool("Folder Reports/412 not found").code, "missing");
  assert.equal(errorFromTool("Not found: invoices/412.txt").code, "missing");
  assert.equal(errorFromTool("Not found: Reports/404 and 413").code, "missing");
  assert.equal(errorFromTool("HTTP 412 for invoices/a.txt").code, "conflict");
  assert.equal(errorFromTool("Client error '412 Precondition Failed' for url 'https://cloud.example.org/x'").code, "conflict");
  assert.equal(errorFromTool("status code: 413").code, "too_large");
  // through a save: the pre-read of a removed file called 412.txt is `missing`, so \"save anyway\" creates it again
  const { dav } = setup({ files: {} });
  const call = dav.call;
  const gone: SourceDeps = { instance: () => inst(), personsKnown: () => true, call: async (i, tool, args, limits) => tool === "nc_webdav_read_file" ? refused("File not found: invoices/412 failed.txt") : call(i, tool, args, limits) };
  const written = await buildSource("nextcloud", "Nextcloud", gone).write("invoices/412.txt", "again", context());
  assert.ok(written.mtime && written.mtime > 0);
  assert.equal(dav.files.get("invoices/412.txt")!.content, "again");
});

test("the download address is made of the user's id where Nextcloud gave one, and of the login name before that; no double slash", () => {
  const { deps } = setup({ instance: inst({ username: "anna@example.org", url: "https://cloud.example.org/" }) });
  const source = buildSource("nextcloud", "Nextcloud", { ...deps, instance: () => inst({ username: "anna@example.org", url: "https://cloud.example.org/" }) });
  assert.equal(source.url("Docs/a b.txt", context()), "https://cloud.example.org/remote.php/dav/files/anna%40example.org/Docs/a%20b.txt", "not asked yet: the login name");
  const asked = buildSource("nextcloud", "Nextcloud", { ...deps, instance: () => inst({ username: "anna@example.org", url: "https://cloud.example.org/" }), accountId: () => "anna" });
  assert.equal(asked.url("Docs/a b.txt", context()), "https://cloud.example.org/remote.php/dav/files/anna/Docs/a%20b.txt");
});

test("every call checks the person itself: a colleague gets nothing from list, read, url or write even when it is called without visible", async () => {
  const { source, dav } = setup();
  for (const role of ["colleague", "guest", "unknown"] as const) {
    const other = context({ person: { id: "x", name: "X", role } });
    await assert.rejects(source.list("", other), { code: "missing" }, role);
    await assert.rejects(source.read("notes.txt", other), { code: "missing" }, role);
    await assert.rejects(source.write("notes.txt", "x", other), { code: "missing" }, role);
    assert.throws(() => source.url("notes.txt", other), { code: "missing" }, role);
  }
  await assert.rejects(source.list("", context({ person: undefined })), { code: "missing" }, "a request with no person on a portal that tells people apart");
  assert.equal(dav.calls.length, 0, "not one tool call");
  // and a portal that does not tell people apart lets whoever is signed in through, as its routes do
  const old = setup({ persons: false });
  assert.equal((await old.source.list("", context({ person: undefined }))).length, 3);
});

test("what the tool or the MCP server said does not reach the Files tab, and goes to the log", async () => {
  const words = "Not found: https://cloud.internal.example/remote.php/dav/files/anna/Private/plan.txt";
  assert.doesNotMatch(errorFromTool(words).message, /internal|anna|Private/);
  assert.doesNotMatch(errorFromTool("boom at https://cloud.internal.example/x").message, /internal/);
  assert.doesNotMatch(errorFromTool("The file https://cloud.internal.example/y already exists").message, /internal/);
  const { deps, logged } = setup();
  const refusing: SourceDeps = { ...deps, call: async (_i, _tool, args) => (refused(`httpx failed for url 'https://cloud.internal.example/remote.php/dav/files/anna/${args.path}'`)) };
  await assert.rejects(buildSource("nextcloud", "Nextcloud", refusing).read("notes.txt", context()), (error: Error) => !/internal|anna/.test(error.message));
  assert.match(logged.join("\n"), /cloud\.internal\.example\/remote\.php\/dav\/files\/anna\/notes\.txt/);
});

test("an answer past the limit is `too_large` whether or not the listing told the size: every call is bounded, the answer is never taken whole", async () => {
  const { dav, deps } = setup();
  const bigError = Object.assign(new Error("The answer of the MCP server is larger than 11 bytes"), { code: "E_ANSWER_TOO_BIG" });
  const bounded: SourceDeps = { ...deps, call: async (i, tool, args, limits) => {
    await dav.call(i, tool, args, limits);
    throw bigError;
  } };
  const source = buildSource("nextcloud", "Nextcloud", bounded);
  // never listed (or listed over a minute ago): the size is not known, the call is
  await assert.rejects(source.read("huge.bin", context()), { code: "too_large", message: /larger than the 8 MB/ });
  assert.equal(dav.limits[0].maxBytes, MAX_ANSWER_BYTES);
  assert.ok(MAX_ANSWER_BYTES > (MAX_FILE_BYTES * 4) / 3 && MAX_ANSWER_BYTES < 2 * MAX_FILE_BYTES, "room for a file of the limit as base64, and not much more");
});

test("a name no instance may have makes no source: a settings file edited by hand does not make Files refuse one", () => {
  assert.deepEqual(wantedSources([inst({ name: "bad name!" }), inst({ name: "9lives" }), inst({ name: "work" })]).map((w) => w.id), ["nextcloud-work"]);
});
