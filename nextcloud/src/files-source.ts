/**
 * Nextcloud's files as a source in Files (`pithagoras-files` 0.2.0 and later), a root of its own beside the chat's
 * folder in the chat's Files tab: listed, read, downloaded and saved through the same WebDAV tools of the Nextcloud MCP
 * server that the panel's own Files tab calls (see web/files.tsx) -- never a second way into the cloud.
 *
 * This module knows the shape of the hook and of the tools' answers, and nothing of the portal: what it needs of the
 * server half (the instances as they stand, one tool call, whether the portal tells people apart) is handed to it, so
 * that it runs under test without a portal. server.ts wires it and keeps it in step with the settings.
 *
 * A source's paths are Nextcloud paths and nothing else: the chat, its owner and its folder are in the context Files
 * gives every call, and none of it is read here.
 */
import { createHash } from "node:crypto";
import type { RequestPerson } from "../../shared/person-gate";
import { configured, type NextcloudInstance } from "./config";
import type { McpResult } from "./ncmcp";

/** The id of the extension this one builds on, as its package.json names it under `optional`. */
export const FILES_EXTENSION = "pithagoras-files";

/** What Files tells a source of every call: the chat the panel is open on, whose it is, and the person at the page. */
export interface SourceContext {
  chatId: string;
  owner?: { name?: string; kind?: string };
  person?: RequestPerson;
}

export interface SourceEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
  /** Milliseconds since the epoch. */
  mtime?: number;
}

export type SourceFile = { content: string; mtime?: number } | { bytes: Uint8Array; mtime?: number };

/** A source as Files takes it (its own `FilesSource`, as far as this extension uses it). */
export interface FilesSource {
  id: string;
  label: string;
  visible(context: SourceContext): boolean;
  list(path: string, context: SourceContext): Promise<SourceEntry[]>;
  read(path: string, context: SourceContext): Promise<SourceFile>;
  url(path: string, context: SourceContext): string;
  write(path: string, content: string, context: SourceContext & { expected?: number }): Promise<{ mtime?: number }>;
}

/** What `portal.extensions.use("pithagoras-files")` gives. */
export interface FilesHook {
  sources: { register(source: FilesSource): void; unregister(id: string): void };
}

/** An error Files knows by its `code` (missing, conflict, invalid, exists, too_large, failed): it keeps the meaning it has for the
 * chat's folder, and its message is shown as it is. Any other error is shown as "Nextcloud: message". */
export class SourceError extends Error {
  constructor(message: string, readonly code?: "missing" | "conflict" | "invalid" | "exists" | "too_large" | "failed") {
    super(message);
  }
}

/** What the source needs of the server half. */
export interface SourceDeps {
  /** The instance by its name as the settings hold it now: undefined where it is gone. */
  instance(name: string): NextcloudInstance | undefined;
  /** One WebDAV tool of the instance's Nextcloud MCP server, called through the extension's one way to call a tool (the same
   * checks as the panel's), within the time Files gives a source. Rejects with why it could not be called. */
  call(instance: NextcloudInstance, tool: string, args: Record<string, unknown>): Promise<McpResult>;
  /** Whether this portal tells people apart (`http.person`, a Pithagoras of 0.3.0 and later). */
  personsKnown(): boolean;
}

/** The most of a file the source pulls in to show or send: the panel reads no more than that inline either. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const KNOWN_TTL_MS = 60_000;
const KNOWN_MAX = 2_000;

// ---- helpers -------------------------------------------------------------------------------------------------

/** The path as Nextcloud's tools take it: names joined by `/`, "" the root. Files checks the same before it calls, but a source that
 * hands a path to WebDAV does not rest on that: nothing that goes up, nothing absolute, nothing that is not a Nextcloud path. */
export function cleanPath(path: unknown, what: "folder" | "file"): string {
  if (typeof path !== "string" || path.length > 4096 || path.includes("\0") || path.includes("\\")) throw new SourceError("That is not a path in Nextcloud", "invalid");
  if (path !== "" && path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new SourceError("That is not a path in Nextcloud", "invalid");
  if (what === "file" && path === "") throw new SourceError("A file has a path", "invalid");
  return path;
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const strOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** What a tool answered in its first text part: JSON where it is JSON. A tool that said no (isError) is thrown with its words. */
function dataOf(result: McpResult, tool: string): Rec {
  const part = (result.content ?? []).find((p) => p.type === "text");
  const text = typeof part?.text === "string" ? part.text : "";
  if (result.isError === true) throw errorFromTool(text || `${tool} said no without a word for it.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SourceError(`${tool} did not answer in a way this source reads.`, "failed");
  }
  if (!isRec(parsed)) throw new SourceError(`${tool} did not answer in a way this source reads.`, "failed");
  return parsed;
}

/** What the MCP server said when a tool failed, as the code Files knows it by. The words stay the server's. */
export function errorFromTool(text: string): SourceError {
  if (/already exists/i.test(text)) return new SourceError(text, "exists");
  if (/\b412\b|precondition|changed since|modified since/i.test(text)) return new SourceError(text, "conflict");
  if (/not found|\b404\b|does not exist|doesn't exist|no such/i.test(text)) return new SourceError(text, "missing");
  if (/\b413\b|too large|too big/i.test(text)) return new SourceError(text, "too_large");
  return new SourceError(text);
}

/** A time Nextcloud gave as a number (seconds or milliseconds) or a date (the HTTP date of a WebDAV answer), as milliseconds. */
function timeOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === "string" && value.trim() !== "") {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return timeOf(Number(value));
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * A number for the version of a file, to give as `mtime` of a read and to be given back as `expected` of a save: made of the file's
 * etag (the content's hash where the server gave none). Files only compares it for equality -- it shows the listing's times, not
 * this -- and an etag, not a time with a second's grain, is what says whether the file has changed.
 */
function stampOf(etag: string | undefined, content: Buffer): number {
  const basis = etag !== undefined ? etag.replace(/^W\//, "").replace(/^"|"$/g, "") : content;
  return parseInt(createHash("sha1").update(basis).digest("hex").slice(0, 13), 16) + 1;
}

const textLike = (type: string): boolean => type.startsWith("text/") || /json|xml|javascript|yaml|toml|csv|x-sh/i.test(type);

/** Whether the bytes are text: UTF-8 all through, no NUL. A BOM is kept, so that a save writes back what was read. */
function textOf(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** One file as the server read it: what its words are (text or bytes), and its version. */
interface Read {
  file: SourceFile;
  etag?: string;
  stamp: number;
}

function readFrom(data: Rec, tool: string): Read {
  const content = data.content;
  if (typeof content !== "string") throw new SourceError(`${tool} did not answer in a way this source reads.`, "failed");
  const etag = strOf(data.etag);
  const type = (strOf(data.content_type) ?? strOf(data.contentType) ?? "").toLowerCase();
  // With "raw" the server sends text as text and everything else as base64, saying so (`encoding`). One that does not say is
  // taken by its content type: text for a text type, base64 for any other.
  const base64 = data.encoding === "base64" || (data.encoding === undefined && type !== "" && !textLike(type));
  if (!base64) {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > MAX_FILE_BYTES) throw new SourceError(tooLarge(bytes.length), "too_large");
    return { file: { content }, etag, stamp: stampOf(etag, bytes) };
  }
  const pad = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const size = Math.floor(content.length / 4) * 3 - pad;
  if (size > MAX_FILE_BYTES) throw new SourceError(tooLarge(size), "too_large");
  const bytes = Buffer.from(content, "base64");
  const text = textOf(bytes);
  return { file: text !== undefined ? { content: text } : { bytes: new Uint8Array(bytes) }, etag, stamp: stampOf(etag, bytes) };
}

const tooLarge = (size: number): string => `This file (${(size / 1024 / 1024).toFixed(1)} MB) is larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB this source reads. Download it from Nextcloud.`;

// ---- the source ----------------------------------------------------------------------------------------------

/** The id of the source of the instance: `nextcloud` for the default one, `nextcloud-<name>` for any other (an instance's name is letters,
 * numbers, dashes and underscores from a letter, 48 at most: always an id Files takes). */
export const sourceIdOf = (name: string): string => (name === "nextcloud" ? "nextcloud" : `nextcloud-${name}`);

/** The source of one instance, by its name: the instance is looked up at each call, so what the settings say now is what counts. */
export function buildSource(instanceName: string, label: string, deps: SourceDeps): FilesSource {
  /** What a folder's listing said of its files, for a minute: a read refuses a file over the limit without pulling it in. */
  const known = new Map<string, { size: number; at: number }>();
  const remember = (path: string, size: number | undefined): void => {
    if (size === undefined) return;
    known.delete(path);
    known.set(path, { size, at: Date.now() });
    while (known.size > KNOWN_MAX) known.delete(known.keys().next().value as string);
  };

  /** The instance, where it is set up and its Files are on; the reason for a call that cannot be made otherwise. */
  const usable = (): NextcloudInstance => {
    const inst = deps.instance(instanceName);
    if (!inst) throw new SourceError(`The Nextcloud instance ${instanceName} is gone.`, "missing");
    if (!configured(inst)) throw new SourceError(`The Nextcloud instance ${instanceName} is not set up completely yet.`, "failed");
    return inst;
  };

  const readNow = async (inst: NextcloudInstance, path: string): Promise<Read> => {
    const tool = "nc_webdav_read_file";
    return readFrom(dataOf(await deps.call(inst, tool, { path, parse_document: "raw" }), tool), tool);
  };

  return {
    id: sourceIdOf(instanceName),
    label,

    // Settings only, never the network: this is asked every time Files lists its sources, and has 5 seconds.
    visible(context) {
      // The instances are the portal's primary person's (the settings and the tool calls are theirs alone): nobody else sees them.
      // A portal that does not tell people apart has the same rule as the routes of this extension then: whoever is signed in.
      if (deps.personsKnown() && context?.person?.role !== "primary") return false;
      const inst = deps.instance(instanceName);
      return inst !== undefined && configured(inst) && inst.capabilities?.files !== false;
    },

    async list(path) {
      const at = cleanPath(path, "folder");
      const inst = usable();
      const tool = "nc_webdav_list_directory";
      const files = dataOf(await deps.call(inst, tool, at === "" ? {} : { path: at }), tool).files;
      if (!Array.isArray(files)) throw new SourceError(`${tool} did not answer in a way this source reads.`, "failed");
      const out: SourceEntry[] = [];
      for (const raw of files) {
        if (!isRec(raw)) continue;
        const name = strOf(raw.name);
        if (name === undefined) continue;
        const dir = Boolean(raw.is_directory ?? raw.isDirectory);
        const size = typeof raw.size === "number" && Number.isFinite(raw.size) ? raw.size : typeof raw.size === "string" && raw.size !== "" && Number.isFinite(Number(raw.size)) ? Number(raw.size) : undefined;
        const mtime = timeOf(raw.last_modified ?? raw.lastModified ?? raw.modified ?? raw.mtime);
        if (!dir) remember(at === "" ? name : `${at}/${name}`, size);
        out.push({ name, type: dir ? "dir" : "file", ...(size !== undefined && !dir ? { size } : {}), ...(mtime !== undefined ? { mtime } : {}) });
      }
      return out;
    },

    async read(path) {
      const at = cleanPath(path, "file");
      const inst = usable();
      const listed = known.get(at);
      if (listed && Date.now() - listed.at < KNOWN_TTL_MS && listed.size > MAX_FILE_BYTES) throw new SourceError(tooLarge(listed.size), "too_large");
      const read = await readNow(inst, at);
      return { ...read.file, mtime: read.stamp };
    },

    // Nextcloud's own WebDAV address of the file, which the person's browser opens with the login it has there: no login of this
    // extension's is in it, and the file is not pulled through the portal.
    url(path) {
      const at = cleanPath(path, "file");
      const inst = usable();
      return `${inst.url}/remote.php/dav/files/${encodeURIComponent(inst.username)}/${at.split("/").map(encodeURIComponent).join("/")}`;
    },

    async write(path, content, context) {
      const at = cleanPath(path, "file");
      if (typeof content !== "string") throw new SourceError("There is no text to save", "invalid");
      const inst = usable();
      // The server writes a file that is there only against the etag it has now. The file as it stands is read for it; when the person read
      // another version (or it is gone), nothing is written. "Save anyway" (no `expected`) writes against the etag it has now, or creates.
      let current: Read | undefined;
      try {
        current = await readNow(inst, at);
      } catch (error) {
        if (!(error instanceof SourceError) || error.code !== "missing") throw error;
      }
      if (context?.expected !== undefined) {
        if (!current) throw new SourceError("The file was removed or moved in Nextcloud since you opened it.", "conflict");
        if (current.stamp !== context.expected) throw new SourceError("The file was changed in Nextcloud since you opened it.", "conflict");
      }
      if (current && current.etag === undefined) throw new SourceError("Nextcloud did not say which version of the file this is, so it is not overwritten.", "failed");
      const tool = "nc_webdav_write_file";
      const saved = dataOf(await deps.call(inst, tool, { path: at, content, ...(current?.etag !== undefined ? { if_match: current.etag } : {}) }), tool);
      const etag = strOf(saved.etag);
      return etag !== undefined ? { mtime: stampOf(etag, Buffer.alloc(0)) } : {};
    },
  };
}

// ---- keeping the registered sources in step with the settings ---------------------------------------------

/** What `use` gave for Files: its hook, or nothing -- Files not there, switched off, or older than the hook (the host gives nothing then), or
 * a host that does not know `optional` at all (it throws). */
export function filesHookOf(use: (name: string) => unknown): FilesHook | undefined {
  let hook: unknown;
  try {
    hook = use(FILES_EXTENSION);
  } catch {
    return undefined;
  }
  const sources = isRec(hook) ? hook.sources : undefined;
  return isRec(sources) && typeof sources.register === "function" && typeof sources.unregister === "function" ? (hook as unknown as FilesHook) : undefined;
}

/** The sources the settings ask for: one for each instance that is set up and has its Files on. "Nextcloud" where there is one, and the
 * instance's name added where there are several. */
export function wantedSources(instances: NextcloudInstance[]): { id: string; name: string; label: string }[] {
  const usable = instances.filter((inst) => configured(inst) && inst.capabilities?.files !== false);
  return usable.map((inst) => ({ id: sourceIdOf(inst.name), name: inst.name, label: usable.length > 1 ? `Nextcloud (${inst.name})` : "Nextcloud" }));
}

/**
 * Registers what the settings ask for with Files and takes away what they no longer ask for (`registered` is the ids this has given, kept by
 * the caller). Without Files' hook it does nothing at all. A source Files refuses (another extension has the id) is reported to `log` and
 * left out; the others are not held up by it.
 */
export function syncSources(hook: FilesHook | undefined, registered: Set<string>, instances: NextcloudInstance[], deps: SourceDeps, log: (text: string) => void): void {
  if (!hook) return;
  const wanted = wantedSources(instances);
  for (const id of [...registered]) {
    if (wanted.some((w) => w.id === id)) continue;
    try {
      hook.sources.unregister(id);
    } catch (error) {
      log(`Nextcloud: its source ${id} could not be taken away from Files: ${(error as Error).message}`);
    }
    registered.delete(id);
  }
  for (const w of wanted) {
    try {
      hook.sources.register(buildSource(w.name, w.label, deps)); // its own id again replaces the earlier one: a new label comes that way
      registered.add(w.id);
    } catch (error) {
      registered.delete(w.id);
      log(`Nextcloud: Files did not take the source ${w.id}: ${(error as Error).message}`);
    }
  }
}

/** Every source this has given, taken away again: for the stop function of the server half (a source is not taken away by itself). */
export function dropSources(hook: FilesHook | undefined, registered: Set<string>): void {
  for (const id of registered) {
    try {
      hook?.sources.unregister(id);
    } catch {
      // Files is stopping as well
    }
  }
  registered.clear();
}
