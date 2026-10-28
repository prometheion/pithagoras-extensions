/**
 * The server half of @pithagoras/office -- the portal start/stop entry (the built server.js behind package.json's
 * `server` field). It sets up, in order:
 *
 *   1. setPortal(portal) + the shared HS256 secret file dataDir()/jwt-secret (0600; created ONCE with
 *      crypto.randomBytes(32).toString("hex"), reused on every later boot), which the Document Server is given: editor
 *      configs are signed and callbacks verified with it.
 *   2. registerTools({record}) -- its audit sink lands in portal().audit AND a log line -- and docchat (comments and
 *      the editor's chat as the way to talk to agents: wireDocchat).
 *   3. callback.configure(...) once, with the Document Server's origin (container.dsOrigin) and the boot secret;
 *      live.setMetaResolver(docId -> store.refresh(docId, root)?.mtimeMs ?? null).
 *   4. The UI routes on portal.router (mounted by the portal at /api/x/@pithagoras/office, session-gated there); every
 *      error is JSON {error, message?, code?}.
 *   5. The cookie-free LOOPBACK listener (the Document Server holds no session cookie): http bound to 127.0.0.1 that
 *      serves ONLY GET /doc/<ticket> (the document for the editor) and POST /callback (the save callback). The
 *      Document Server reaches it through Office's relay (container.ts): document.url and callbackUrl name the
 *      island's relay, which hands each request to a tunnel the half holds open to it (back.ts), and the half passes
 *      it on to this listener.
 *   6. Boot: settleKept() (.trash >7d sweep + index-vs-disk settle) FIRST, then the workspace scan
 *      (store.scanWorkspace over portal().folders.list(): every .docx/.xlsx of the agent homes and projects
 *      indexed IN PLACE; POST /documents/rescan re-runs it on demand) + container.lookAfter(), then a 30_000 ms
 *      unref'd interval that re-runs settleKept+lookAfter. The returned cleanup closes the listener and clears it.
 *   7. jszip (the blank document templates) is bundled into server.js by build.mjs, so the package needs nothing
 *      installed beside it.
 *
 * The browser reaches the Document Server only through the portal's GET+POST /ds/ reverse proxy (api.js, the editor
 * frame, every asset and the socket.io channel), behind the session gate like every route here. The Document Server
 * builds every address it hands the browser (the converted document, images, downloads) from the X-Forwarded-Host,
 * -Proto and -Prefix of the editor's own requests, so the proxy sends them: without them it named its own address,
 * http://127.0.0.1/cache/files/..., which no browser can load, and every open ended in "Download failed".
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import { setPortal, portal, dataDir } from "./host";
import * as container from "./container";
import { LIMIT_BOUNDS, limitOk, loadSettings, saveSettings, type OfficeSettings } from "./settings";
import { signJwt } from "./jwt";
import { mintTicket, verifyTicket } from "./tickets";
import * as store from "./store";
import * as live from "./live";
import * as callback from "./callback";
import * as docchat from "./docchat";
import { saveNow } from "./editing";
import { holdWayBack } from "./back";
import { registerTools } from "./tools";
import * as seat from "./seat";
import { PLUGIN_GUID } from "./seat-page";
import { floatingTag } from "./office-ui";
import { writesFromHere } from "../../shared/proxy";

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

/** The editor-config JWT lives 15 minutes: the official DS signing sample uses expiresIn 15*60, and a config is
 * only ever handed to a fresh api.js load right after minting. */
const CONFIG_TTL_MS = 15 * 60 * 1000;
/** A document ticket lives 10 minutes: one editor open-and-fetch window (the tickets module's own default). */
const TICKET_TTL_MS = 600_000;
/** The fallback identity the minted config claims: portal exposes no per-route session user in v1, so every
 * co-edited doc shows this seat (editorConfig.user). */
const EDITOR_USER = { id: "portal-user", name: "Portal" } as const;

const DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function mediaType(ext: "docx" | "xlsx"): string {
  return ext === "docx" ? DOCX_MEDIA : XLSX_MEDIA;
}

/* ------------------------------------------------------------------ */
/* module state (one boot per portal start; the host re-runs us)       */
/* ------------------------------------------------------------------ */

/** Port of the loopback listener once booted (0 before boot / after cleanup); tests reach it via this. */
let loopPort = 0;
export function loopbackPort(): number {
  return loopPort;
}

function logLine(line: string): void {
  try {
    portal().log(line);
  } catch {
    // pre-portal (unit seams) or a dead portal -- console is the floor, never crash a boot.
    console.error(line);
  }
}

/** The ONE audit sink: every mutating op lands in portal().audit AND as one log line. */
function recordAudit(entry: { subject: string; reason?: string; chatId?: string }): void {
  const line = `@pithagoras/office: ${entry.subject}${entry.reason ? ` -- ${entry.reason}` : ""}${entry.chatId ? ` (chat ${entry.chatId})` : ""}`;
  try {
    portal().audit.record({ subject: entry.subject, reason: entry.reason, chatId: entry.chatId });
  } catch (e) {
    logLine(`audit.record refused the entry: ${(e as Error).message}`);
  }
  logLine(line);
}

/** A Start in the audit: the Document Server, and the agents' editor's image beside it. */
function auditStart(r: Awaited<ReturnType<typeof container.startOffice>>, how: string): void {
  recordAudit({ subject: container.DS_NAME, reason: `${r.started ? "document server started" : "document server already running"}${how}` });
  if (r.agent.present) recordAudit({ subject: container.AGENT_IMAGE_TAG, reason: "the agents' editor image is there" });
  else logLine(`@pithagoras/office: the agents' editor image could not be downloaded: ${r.agent.error ?? "unknown"}`);
}

/* ------------------------------------------------------------------ */
/* the shared secret                                                   */
/* ------------------------------------------------------------------ */

/** Create dataDir()/<name> ONCE -- mode 0600, explicit chmod (umask-proof), hex of crypto.randomBytes(32) -- and
 * return its trimmed content. Existing files are reused byte-for-byte (second boot and every one after). */
function ensureSecret(dd: string, name: string): string {
  fs.mkdirSync(dd, { recursive: true });
  const file = path.join(dd, name);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    raw = ""; // missing: generated below
  }
  if (raw.trim().length < 32) fs.writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600 }); // empty or truncated too soon to be a usable secret: (re)generate rather than reuse
  fs.chmodSync(file, 0o600); // the exact perms either way -- never rely on the process umask
  return fs.readFileSync(file, "utf8").trim();
}

/** Read the boot secret from `root` (the portal dataDir by default): the one the Document Server is given (editor
 * configs, callbacks). Boot creates the file; this only reads. */
export function jwtSecret(root?: string): string {
  return fs.readFileSync(path.join(root ?? dataDir(), "jwt-secret"), "utf8").trim();
}

/** The secret document tickets are signed with, which the Document Server is never given: a converter that a hostile
 * file breaks into finds the JWT secret in its environment, and with it alone can forge no ticket to read a
 * document it was not opened on. */
export function ticketSecret(root?: string): string {
  return fs.readFileSync(path.join(root ?? dataDir(), "ticket-secret"), "utf8").trim();
}

/** What a ticket names: a document at one revision. The ticket is refused once the document moved on, so one made
 * for an editor cannot read what an agent or a script wrote later. */
export function ticketSubject(docId: string, mtimeMs: number): string {
  return `${docId}@${mtimeMs}`;
}

/* ------------------------------------------------------------------ */
/* settleKept                                                          */
/* ------------------------------------------------------------------ */

/** Reconcile the library with what is on disk: sweep .trash entries older than 7 days, then drop index entries
 * whose library file vanished (store.pruneMissingDocs). The index is the source of truth -- a docs/<id>/ dir with no
 * entry is NOT added back. Pure function of (root): booted at start and on the interval, unit-tested directly. */
export function settleKept(root?: string): { sweptTrash: number; prunedDocs: string[] } {
  const dd = root ?? dataDir();
  return { sweptTrash: store.sweepTrash(dd), prunedDocs: store.pruneMissingDocs(dd) };
}

/* ------------------------------------------------------------------ */
/* small response helpers                                              */
/* ------------------------------------------------------------------ */

const CODE_STATUS: Record<string, number> = {
  not_found: 404,
  exists: 409,
  unsupported_format: 415,
  invalid_title: 400,
  invalid: 409, // store: a document's file is a link now, or its folder leads elsewhere
  revision_mismatch: 409,
  index_corrupt: 500,
  no_docker: 503,
  too_large: 413, // store's 512 MiB cap: on import, and on every read of a file whole
};

/** Map the coded errors store/container throw onto consistent JSON {error, code?}. */
function codedResponse(res: { status: (c: number) => { json: (b: unknown) => void } }, e: unknown): void {
  const ce = e as Error & { code?: string };
  res.status(CODE_STATUS[ce.code ?? ""] ?? 500).json({ error: ce.message, ...(ce.code ? { code: ce.code } : {}) });
}

/** Where a doc's bytes live NOW: a scanned doc's real workspace file (DocMeta.path), else its library folder. */
function fileFor(root: string, doc: store.DocMeta): string {
  return store.docPath(doc, root);
}

/** Content-Disposition for a download: an ASCII fallback name plus the RFC 5987 UTF-8 form for any non-ASCII title. */
function attachmentHeader(title: string, ext: string): string {
  const raw = `${title}.${ext}`;
  const ascii = raw.replace(/[^\x20-\x7e]/g, "-").replace(/["\\;:,]/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

function jsonRaw(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/* ------------------------------------------------------------------ */
/* the loopback listener                                    */
/* ------------------------------------------------------------------ */

function makeLoopbackHandler(dd: string, tickets: string): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      jsonRaw(res, 404, { error: "no such endpoint on the office loopback listener", code: "not_found" });
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/doc/")) {
      // Tickets are base64url tokens: no percent-decoding -- decodeURIComponent would throw URIError on a
      // malformed escape, and an uncaught throw in the http listener kills the server. verifyTicket enforces the alphabet anyway.
      const ticket = pathname.slice("/doc/".length);
      const verified = verifyTicket(ticket, tickets);
      if (!verified) {
        jsonRaw(res, 401, { error: "invalid or expired document ticket", code: "bad_ticket" });
        return;
      }
      const at = verified.docId.lastIndexOf("@");
      const docId = verified.docId.slice(0, at);
      const doc = at > 0 ? store.refresh(docId, dd) : null;
      if (!doc) {
        jsonRaw(res, 404, { error: `no such document ${docId}`, code: "not_found" });
        return;
      }
      if (ticketSubject(doc.docId, doc.mtimeMs) !== verified.docId) {
        jsonRaw(res, 409, { error: `${doc.docId} changed since this ticket was made; open it again`, code: "revision_mismatch" });
        return;
      }
      let bytes: Buffer;
      try {
        bytes = store.readDoc(doc, dd);
      } catch (e) {
        if ((e as { code?: string }).code === "too_large") jsonRaw(res, 413, { error: (e as Error).message, code: "too_large" });
        else jsonRaw(res, 404, { error: `the library file for ${doc.docId} is missing from disk`, code: "not_found" });
        return;
      }
      res.writeHead(200, { "Content-Type": mediaType(doc.ext), "Cache-Control": "no-store" });
      res.end(bytes);
      return;
    }
    if (req.method === "POST" && pathname === "/callback") {
      callback.handleCallback(req, res);
      return;
    }
    // The agents' browser: its seat page under this run's secret, and each editor's plugin under its token.
    if (seat.handleSeat(req, res, pathname)) return;
    jsonRaw(res, 404, { error: `no such endpoint on the office loopback listener (${req.method} ${pathname})`, code: "not_found" });
  };
}

/* ------------------------------------------------------------------ */
/* editor-config                                                       */
/* ------------------------------------------------------------------ */

/** Whose editor a config is for: a person's, from the Office page (the one route that hands configs out), or an
 * agent's, for its seat in the agents' browser (seat.ts, the only caller of that variant: its configs leave the half
 * only through the seat page's secret route). */
export type EditorAs = { kind: "person" } | { kind: "agent"; home: string; label: string; mode: "edit" | "view" | "comment"; pluginUrl: string };

/** Build (or refuse) the new DocsAPI.DocEditor config for `docId`. The plain object is signed WHOLE -- per the DS
 * signing rule ("the payload must have the same structure as the config"; since 7.1 sign exactly what you send) --
 * and returned as {...config, token, apiJs}: the page drops `apiJs` before calling DocEditor, everything else goes in. */
export function buildEditorConfig(dd: string, secret: string, docId: string, as: EditorAs = { kind: "person" }): { res?: unknown; config?: Record<string, unknown>; ticketUrl?: string; key?: string } {
  // As the file is now: a change made outside the extension is a new revision, so a new key, which the Document
  // Server downloads afresh, and which a save of the old session cannot overwrite.
  const doc = store.refresh(docId, dd);
  if (!doc) return { res: { status: 404, body: { error: `no document with id ${docId}`, code: "not_found" } } };

  if (!fs.existsSync(fileFor(dd, doc))) return { res: { status: 404, body: { error: `the file of "${doc.title}" is gone from disk; it stays listed for a week, in case it comes back`, code: "not_found" } } };
  const record = container.readDsRecord(dd);
  if (!record) return { res: { status: 503, body: { error: "the document server is not configured yet -- start it from the Office page first", code: "ds_not_configured" } } };

  const { token: ticket } = mintTicket(ticketSubject(doc.docId, doc.mtimeMs), TICKET_TTL_MS, ticketSecret(dd));
  // document.url is the ticketed GET on the loopback listener and callbackUrl sits right next door, both through the
  // island's relay: the one address the Document Server reaches, which passes them on to the listener (container.ts).
  const base = `http://${container.NAMES.relay}:${container.BACK_PORT}`;
  // The key of the session already open on this revision where there is one (its own save wrote this revision, so
  // its key pins an older one): the editor joins it instead of opening a second session beside it. People and agents
  // alike: an agent's editor joins the people in the document, and they join it.
  const key = live.sessionKeys(doc.docId).find((k) => callback.keyStanding(k, doc.mtimeMs) === "current") ?? callback.makeKey(doc.docId, doc.mtimeMs);
  const config: Record<string, unknown> = {
    documentType: doc.ext === "docx" ? "word" : "cell",
    // The full editor: "embedded" is OnlyOffice's read-only viewer for a page, with no toolbar and no editing.
    type: "desktop",
    title: doc.title,
    document: {
      fileType: doc.ext,
      key,
      title: `${doc.title}.${doc.ext}`,
      url: `${base}/doc/${ticket}`,
    },
    editorConfig: {
      callbackUrl: `${base}/callback`,
      mode: "edit",
      lang: "en", // v1 default -- portal exposes no per-user locale seam
      user: { id: EDITOR_USER.id, name: EDITOR_USER.name },
      // The editor runs on the portal's own origin (the /ds proxy), where a script has the person's session for the
      // whole portal API. A document's macros and the editor's plugins would run there, held only by OnlyOffice's
      // in-page guard around eval, so neither runs, and a document cannot switch them on. (The Document Server does not
      // hold the page to the signed config; a plugin a page adds to it cannot load from anywhere but the portal's own
      // origin, which the /ds proxy's DS_FRAME_POLICY holds the editor's frame to.)
      customization: { macros: false, plugins: false },
    },
  };
  if (as.kind === "agent") {
    const editorConfig = config.editorConfig as Record<string, unknown>;
    // Comment-only: an editor in edit mode whose document may not be edited, only commented (the agent answers in
    // a comment thread of a document it may only read).
    editorConfig.mode = as.mode === "view" ? "view" : "edit";
    if (as.mode === "comment") (config.document as Record<string, unknown>).permissions = { edit: false, comment: true };
    editorConfig.user = { id: `agent:${callback.keyIdOf(as.home)}`, name: `${as.label} (agent)`, group: "agents" };
    // Its presence comes from the Document Server's callbacks, as anyone's; its mint is no person opening the document.
    live.nameAgent(`agent:${callback.keyIdOf(as.home)}`, `${as.label} (agent)`);
    // Live in view mode too: a viewer's default is "strict", which shows nobody's changes until they save.
    editorConfig.coEditing = { mode: "fast", change: false };
    // The one editor with a plugin: Office's own, which makes the agent's edits (seat-page.ts). It runs in the agents'
    // browser on its own network, on the Document Server's origin there (the relay's way in), where no person's session
    // is.
    editorConfig.customization = { macros: false, plugins: true, compactHeader: true };
    editorConfig.plugins = { pluginsData: [`${as.pluginUrl}config.json`], autostart: [PLUGIN_GUID] };
    return { config, ticketUrl: `${base}/doc/${ticket}`, key };
  }
  live.setUser(doc.docId, { id: EDITOR_USER.id, name: EDITOR_USER.name }, true); // the seat opens: presence on mint
  return { config, ticketUrl: `${base}/doc/${ticket}`, key };
}

/** Keys a command service's `info` said a person is in, with when: a page's reports after a restart are taken without
 * asking again for each. */
const confirmedKeys = new Map<string, number>();

/** Whether `key` is an open editing session of `docId` with a person in it: one the callbacks named, else (after a
 * restart, before the next callback) one the command service's `info` names users of, which also tells `live`. */
async function liveKey(docId: string, key: string): Promise<boolean> {
  if (live.sessionKeys(docId).includes(key)) return true;
  const at = confirmedKeys.get(key);
  if (at !== undefined && Date.now() - at < 10 * 60_000) return true;
  try {
    const info = await callback.command({ c: "info", key });
    const users = info.error === 0 && Array.isArray(info.users) ? (info.users as unknown[]).map(String) : [];
    if (!users.some((u) => !live.isAgentId(u))) return false;
    live.setSession(docId, key, users);
    for (const [k, when] of confirmedKeys) if (Date.now() - when >= 10 * 60_000) confirmedKeys.delete(k);
    confirmedKeys.set(key, Date.now());
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* the UI routes (the portal mounts portal.router at /api/x/@pithagoras/office)*/
/* ------------------------------------------------------------------ */

function registerRoutes(dd: string, secret: string): void {
  const r = portal().router;
  const json = portal().http.json();
  // Changes only from the portal's own pages, as Blender's and Godot's routes: the portal's cookie is SameSite=Lax,
  // which a page on another port or name of the same site is still sent, and these routes delete documents, remove
  // the Document Server and change its image.
  r.use(writesFromHere);

  /** GET /state -> settings + container status + the agents' editor (its image, its download, its browser) + the document
   * list + who has what open. The poller's payload. */
  r.get("/state", async (_req, res) => {
    const s = loadSettings(dd);
    let c: Awaited<ReturnType<typeof container.status>>;
    try {
      c = await container.status();
    } catch (e) {
      c = { state: "stopped", pull: null } as typeof c; // status() should not throw -- never kill the poller
      logLine(`container.status failed: ${(e as Error).message}`);
    }
    const docs = store.refreshAll(dd);
    const locks: Record<string, { id: string; name?: string }[]> = {};
    for (const d of docs) {
      // every doc gets an entry -- the client badge code reads locks[docId] without a null check
      locks[d.docId] = live.usersOf(d.docId).map((u) => ({ id: u.id, name: u.name }));
    }
    const agent = { ...(await container.agentImage()), tag: container.AGENT_IMAGE_TAG, browser: seat.health() };
    const limits = Object.fromEntries(Object.keys(LIMIT_BOUNDS).map((k) => [k, s[k as keyof typeof LIMIT_BOUNDS]]));
    res.json({ enabled: s.enabled, imageTag: s.imageTag, limits, limitBounds: LIMIT_BOUNDS, container: c, agent, docs, locks });
  });

  /** GET /scope?chat=<id> -> { docIds }: what the agent or project of that chat's folder sees (store.docsForHome, the
   * tools' own rule), for the panel beside the chat. A chat whose folder is gone sees the person's library documents. */
  r.get("/scope", async (req, res) => {
    const chatId = typeof req.query?.chat === "string" ? req.query.chat : "";
    let folder = "";
    try {
      folder = chatId ? portal().chats.folder(chatId) : "";
    } catch {
      folder = "";
    }
    const docs = folder ? store.docsForHome(folder, dd) : store.listDocs(dd).filter((d) => d.owner === null && !d.path);
    res.json({ docIds: docs.map((d) => d.docId) });
  });

  /** POST /documents {title, type:"word"|"cell", owner?} -> 201 meta; 409 exists. A failure is logged too, so a live
   * failure LEAVES A LINE in the portal's log (the pre-fix routes logged nothing, which is why the first live
   * create-failure had no trace to read). */
  r.post("/documents", json, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title : "";
    const type = body.type;
    if (title.trim() === "") return res.status(400).json({ error: "a document needs a non-empty { title }", code: "invalid_title" });
    if (type !== "word" && type !== "cell") return res.status(400).json({ error: '{ type } must be "word" or "cell"', code: "unsupported_format" });
    const owner = typeof body.owner === "string" && body.owner !== "" ? body.owner : null;
    try {
      const doc = await store.createDoc({ title, type, owner }, dd);
      recordAudit({ subject: title, reason: `created ${doc.ext} document ${doc.docId}`, chatId: owner ?? undefined });
      res.status(201).json(doc);
    } catch (e) {
      logLine(`POST /documents failed: ${(e as Error).message}`);
      codedResponse(res, e);
    }
  });

  /** POST /documents/rescan -> { added, updated }: re-run the workspace scan NOW over every agent folder (fresh from
   * portal().folders.list()), in addition to the automatic one at boot. The library UI's Rescan button calls it. */
  r.post("/documents/rescan", json, async (_req, res) => {
    try {
      const out = store.scanWorkspace(portal().folders.list().map((f) => f.path), dd);
      logLine(`workspace rescan: ${out.added} added, ${out.updated} refreshed`);
      res.json(out);
    } catch (e) {
      logLine(`workspace rescan failed: ${(e as Error).message}`);
      codedResponse(res, e);
    }
  });

  /** POST /documents/:id/rename {title} -> 200 the new meta; keeps mtimeMs (the open sessions' revision survives a retitle). */
  r.post("/documents/:id/rename", json, async (req, res) => {
    const id = String(req.params?.id ?? "");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title : "";
    if (title.trim() === "") return res.status(400).json({ error: "a rename needs a non-empty { title }", code: "invalid_title" });
    try {
      const doc = store.renameDoc(id, title, dd);
      recordAudit({ subject: `${doc.title} (${id})`, reason: `renamed from ${doc.title}`, chatId: undefined });
      res.json(doc);
    } catch (e) {
      codedResponse(res, e);
    }
  });

  /** GET /documents/:id -> the library bytes as an attachment (download). */
  r.get("/documents/:id", async (req, res) => {
    const doc = store.getDoc(String(req.params?.id ?? ""), dd);
    if (!doc) return res.status(404).json({ error: `no document with id ${String(req.params?.id ?? "")}`, code: "not_found" });
    let bytes: Buffer;
    try {
      bytes = store.readDoc(doc, dd);
    } catch (e) {
      if ((e as { code?: string }).code === "too_large") return codedResponse(res, e);
      return res.status(404).json({ error: `the library file for ${doc.docId} is missing from disk`, code: "not_found" });
    }
    res.setHeader("Content-Type", mediaType(doc.ext));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", attachmentHeader(doc.title, doc.ext));
    res.end(bytes);
  });

  /** DELETE /documents/:id -> moved to .trash (settleKept reclaims after 7 days) + live presence cleared. */
  r.delete("/documents/:id", async (req, res) => {
    const id = String(req.params?.id ?? "");
    try {
      store.deleteDoc(id, dd);
    } catch (e) {
      codedResponse(res, e);
      return;
    }
    live.clearDoc(id); // nobody "has it open" for a gone doc anymore
    seat.closeDoc(id); // and no agent's editor holds it
    void docchat.documentGone(id); // nor a chat of its comments or its editor's chat
    recordAudit({ subject: id, reason: "deleted (moved to .trash)" });
    res.json({ ok: true });
  });

  /** GET /documents/:id/export -> a FRESH copy of the current bytes, exported to a temp dir, served, and the temp
   * gone again (store.exportDoc writes `${title}.ext` next to nothing else -- nothing is ever overwritten). */
  r.get("/documents/:id/export", async (req, res) => {
    const id = String(req.params?.id ?? "");
    const doc = store.getDoc(id, dd);
    if (!doc) return res.status(404).json({ error: `no document with id ${id}`, code: "not_found" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-export-"));
    let bytes: Buffer;
    try {
      const written = store.exportDoc(id, tmp, dd);
      bytes = fs.readFileSync(written);
      recordAudit({ subject: doc.title, reason: `exported (download of a fresh copy)` });
    } catch (e) {
      return codedResponse(res, e); // too large, or a link in its place
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    res.setHeader("Content-Type", mediaType(doc.ext));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", attachmentHeader(doc.title, doc.ext));
    res.end(bytes);
  });

  /** POST /editor-config {doc} -> the config object for `new DocsAPI.DocEditor(el, cfg)`: the plain fields plus
   * token = signJwt(the WHOLE plain config minus the token itself, 15 min) and apiJs (the script src -- drop it
   * before calling DocEditor). On a mint the seat joins live presence. See buildEditorConfig for the refusals, and
   * 503 ds_starting while a start is under way or a new Document Server is still setting itself up (container.settled). */
  r.post("/editor-config", json, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const docId = typeof body.doc === "string" && body.doc !== "" ? body.doc : "";
    if (!docId) return res.status(400).json({ error: 'the body needs { doc: "<document id>" }' });
    // Not while a new Document Server is still making its fonts: it restarts its services at the end, and an editor
    // opened before loses what is typed in it. Nor while a start is under way, which writes ds.json only at its end.
    // The page asks again until it is done.
    if (container.readDsRecord(dd) ? !(await container.settled()) : container.starting()) {
      return res.status(503).json({ error: "the document server is still setting itself up after its first start (about two minutes); the editor opens once it is done", code: "ds_starting" });
    }
    const built = buildEditorConfig(dd, secret, docId);
    if (built.res) {
      const rr = built.res as { status: number; body: Record<string, unknown> };
      return res.status(rr.status).json(rr.body);
    }
    const config = built.config as Record<string, unknown>;
    // purpose "editor-config": the signed typ claim tags this token's family for any future in-portal
    // verification; DS itself checks only the HMAC/expiry and ignores the extra claim.
    // apiJs: ROOT-RELATIVE through this extension's /ds proxy. The browser resolves it against its own page origin
    // (exactly where the user reached the portal, session-gated) -- and api.js' getBasePath() takes everything before
    // "api/documents/api.js" in its script src as the editor iframe base, so the whole editor runs under that prefix.
    // It is NOT part of the signed payload (the client drops it before calling DocEditor).
    res.json({ ...config, token: signJwt(config, CONFIG_TTL_MS, secret, "editor-config"), apiJs: `/api/x/${portal().extension.split("/").map(encodeURIComponent).join("/")}/ds/web-apps/apps/api/documents/api.js` });
  });

  /** POST /settings {enabled?, imageTag?} -> saved + side effects: enabling fires ensureContainer WITHOUT
   * (There is NO co-editing switch in this payload: the agent is a co-editor in its own editor, full stop.)
   * awaiting it forever (catch+log; the response says `starting:true` and reports the container state AS OF NOW --
   * a poller watches it arrive), disabling stops it now. :latest is refused -- a moved tag bricks co-editing keys. */
  r.post("/settings", json, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = loadSettings(dd);
    const patch: Partial<OfficeSettings> = {};
    if ("enabled" in body) {
      if (typeof body.enabled !== "boolean") return res.status(400).json({ error: "{ enabled } must be a boolean", code: "invalid_enabled" });
      patch.enabled = body.enabled as boolean;
    }
    if ("imageTag" in body) {
      const tag = typeof body.imageTag === "string" ? body.imageTag.trim() : "";
      if (tag === "") return res.status(400).json({ error: "{ imageTag } must be a non-empty string like onlyoffice/documentserver:10.0.0.1", code: "invalid_image_tag" });
      if (floatingTag(tag)) return res.status(400).json({ error: "never pin :latest or a tag-less image -- it moves under you and breaks co-editing keys", code: "invalid_image_tag" });
      // Docker for extensions takes an image by its tag and splits the reference at its last colon: a digest
      // (`@sha256:…`) would be split inside the digest, and its download fail.
      if (tag.includes("@")) return res.status(400).json({ error: "name the image by its tag, like onlyoffice/documentserver:10.0.0.1 -- not by a digest", code: "invalid_image_tag" });
      patch.imageTag = tag;
    }
    // The limits of comments and the editor's chat with agents: whole numbers in their bounds.
    for (const key of Object.keys(LIMIT_BOUNDS) as (keyof typeof LIMIT_BOUNDS)[]) {
      if (!(key in body)) continue;
      if (!limitOk(key, body[key])) return res.status(400).json({ error: `{ ${key} } must be a whole number from ${LIMIT_BOUNDS[key][0]} to ${LIMIT_BOUNDS[key][1]}`, code: "invalid_limit" });
      patch[key] = body[key] as number;
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: `no known setting in the body -- send { enabled?, imageTag?, ${Object.keys(LIMIT_BOUNDS).map((k) => `${k}?`).join(", ")} }` });

    const settings = saveSettings(patch, dd);
    const limitsSaid = (Object.keys(LIMIT_BOUNDS) as (keyof typeof LIMIT_BOUNDS)[]).filter((k) => k in patch).map((k) => ` ${k}=${settings[k]}`).join("");
    recordAudit({ subject: "@pithagoras/office settings", reason: `enabled=${settings.enabled} imageTag=${settings.imageTag}${limitsSaid}` });

    let starting = false;
    if (patch.enabled === true && !before.enabled) {
      // fire-and-forget on purpose: a first pull takes minutes and must not hold the response open
      starting = true;
      void container.startOffice(undefined, undefined, dd).then((r2) => auditStart(r2, " (settings)")).catch((e) => logLine(`could not start the document server: ${(e as Error).message}`));
    }
    if (patch.enabled === false && before.enabled) {
      try {
        await container.stopContainer(undefined, dd); // records the user-stopped intent either way
        seat.closeSeats();
      } catch (e) {
        return res.status(503).json({ error: `settings were saved but the container could not be stopped: ${(e as Error).message}`, code: "no_docker", settings });
      }
    }

    const c = await container.status();
    res.json({ settings, container: c, ...(starting ? { starting: true } : {}) });
  });

  /** GET /container/status -> the same object status() builds: state (+ version/memBytes when up), and pull -- the
   * latest pull line while a first start is downloading (the POST /container/start route awaits the whole ensure;
   * progress surfaces here via polling). */
  r.get("/container/status", async (_req, res) => {
    try {
      res.json(await container.status());
    } catch (e) {
      codedResponse(res, e);
    }
  });

  /** POST /container/start -> container.startOffice to completion: adopt or make+start the DS, ds.json written, and the
   * agents' editor's image downloaded beside it; the response carries the resulting status and whether the image is
   * there (its failure does not fail the start: the page says it from /state). Start is all a person does to have
   * Office: it switches Office on as well, or the tools would say it is stopped while its Document Server runs. */
  r.post("/container/start", async (_req, res) => {
    try {
      if (!loadSettings(dd).enabled) {
        saveSettings({ enabled: true }, dd);
        recordAudit({ subject: "@pithagoras/office settings", reason: "enabled=true (Start)" });
      }
      const r2 = await container.startOffice(undefined, undefined, dd);
      auditStart(r2, "");
      res.json({ ...r2, container: await container.status() });
    } catch (e) {
      codedResponse(res, e);
    }
  });

  /** POST /container/stop -> stop + record the user-stopped intent (lookAfter stays quiet while it stands). */
  r.post("/container/stop", async (_req, res) => {
    try {
      await container.stopContainer(undefined, dd);
      seat.closeSeats();
      recordAudit({ subject: container.DS_NAME, reason: "document server stopped" });
      res.json({ container: await container.status() });
    } catch (e) {
      codedResponse(res, e);
    }
  });

  /** POST /container/remove {data?} -> the relay, the Document Server and its network removed
   * (container.removeContainers), with `data` also the Document Server's volumes; recorded as stopped. */
  r.post("/container/remove", json, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      await container.removeContainers(body.data === true, undefined, dd);
      seat.closeSeats();
      recordAudit({ subject: container.DS_NAME, reason: body.data === true ? "document server removed, with its volumes" : "document server removed" });
      res.json({ container: await container.status() });
    } catch (e) {
      codedResponse(res, e);
    }
  });

  /** GET /editor-state?doc=<id>&key=<key> -> { standing }: how the editor that opened `doc` with `key` stands to the
   * document now (callback.keyStanding). "behind": the file changed outside the editor, which the page says;
   * "current": nothing to do. The editor page asks every second while it is open. */
  r.get("/editor-state", async (req, res) => {
    const docId = typeof req.query?.doc === "string" ? req.query.doc : "";
    const key = typeof req.query?.key === "string" ? req.query.key : "";
    const parsed = callback.parseKey(key);
    if (!docId || !parsed || parsed.keyId !== callback.keyIdOf(docId)) return res.status(400).json({ error: "the query needs { doc, key } of an editor opened on that document", code: "invalid" });
    const doc = store.refresh(docId, dd);
    if (!doc) return res.status(404).json({ error: `no document with id ${docId}`, code: "not_found" });
    res.json({ standing: callback.keyStanding(key, doc.mtimeMs), docchat: docchat.statesOf(docId) });
  });

  /** GET /mentionables -> { users }: who a comment can mention, as the editor's mention list takes them (docchat.ts). */
  r.get("/mentionables", (_req, res) => {
    res.json({ users: docchat.mentionables() });
  });

  /** POST /docchat/ready and /docchat/events: what a people's editor reports of comments and its chat (docchat.ts and
   * web/docchat-page.ts). Each names its document and its session's key, which must be a session of that document:
   * one the Document Server's callbacks named, or, for a key not heard of since a restart, one its command service
   * says a person is in. A page of another protocol is told to reload. */
  const docchatBody = portal().http.json({ limit: docchat.CAPS.bytes });
  const checked = async (req: { body?: unknown }, res: { status: (c: number) => { json: (b: unknown) => void } }): Promise<{ docId: string; key: string; panelChat?: string; body: Record<string, unknown> } | null> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.v !== docchat.PROTOCOL) {
      res.status(409).json({ error: "Reload the page: Office was updated", code: "reload_page" });
      return null;
    }
    const docId = typeof body.docId === "string" ? body.docId : "";
    const key = typeof body.key === "string" ? body.key : "";
    const parsed = callback.parseKey(key);
    if (!docId || !parsed || parsed.keyId !== callback.keyIdOf(docId) || !store.getDoc(docId, dd)) {
      res.status(400).json({ error: "the report needs { docId, key } of an editor opened on that document", code: "invalid" });
      return null;
    }
    // Per session and per document: a key made up for each request still shares its document's bucket, and the
    // command service is asked of no more keys than that lets through.
    if (!docchat.rateOk(key, docId)) {
      res.status(429).json({ error: "too many reports: slow down", code: "rate" });
      return null;
    }
    if (!(await liveKey(docId, key))) {
      res.status(409).json({ error: "that editing session is not open", code: "not_live" });
      return null;
    }
    const panelChat = typeof body.panelChat === "string" && body.panelChat ? body.panelChat : undefined;
    return { docId, key, ...(panelChat ? { panelChat } : {}), body };
  };
  r.post("/docchat/ready", docchatBody, async (req, res) => {
    const got = await checked(req, res);
    if (!got) return;
    const comments = Array.isArray(got.body.comments) ? (got.body.comments as docchat.PageComment[]).slice(0, 5000) : [];
    docchat.ready(got.docId, got.key, comments);
    res.json({ ok: true });
  });
  r.post("/docchat/events", docchatBody, async (req, res) => {
    const got = await checked(req, res);
    if (!got) return;
    const events = Array.isArray(got.body.events) ? (got.body.events as docchat.PageEvent[]) : [];
    if (events.length > docchat.CAPS.events) return res.status(413).json({ error: `at most ${docchat.CAPS.events} events a report`, code: "too_large" });
    docchat.report(got.docId, got.key, events, got.panelChat);
    res.json({ ok: true });
  });

  /** GET+POST /ds/<rest...> -> a thin reverse proxy for the browser's Document Server traffic (api.js, the editor
   * iframe and its assets -- AND the socket.io POLLING channel). The editor app talks to docserver over engine.io:
   * GET <app>/10.0.0-<buildhash>/doc/<key>/c/?EIO=4&transport=polling handshakes, then the client's packets (the
   * "40" connect packet, user state, ...) arrive as POSTs to the same path while its next-poll GETs stay open until
   * the server has something to send. A GET-only proxy answered every POST with the portal's 404 and the channel never
   * opened: the editor white-loads forever even though DS is healthy (reproduced by wire replay).
   * The portal mounts us at /api/x/<extension> BEHIND THE SESSION GATE, so only signed-in browsers may reach this --
   * and it forwards to ONE origin only: the Document Server through Office's relay (container.dsOrigin). The upstream
   * path is recomputed from the RAW request URL with its query string included (express params may be decoded; an
   * iframe's ?dockey=... must pass verbatim).
   * Where the browser is: the Document Server makes every absolute address it hands the browser from the
   * X-Forwarded-Proto, -Host and -Prefix of the editor's requests (the converted document Editor.bin, images,
   * downloads, print), and its nginx answers unversioned /web-apps/... and / with a redirect built the same way.
   * Without them it said http://127.0.0.1/cache/files/... (its own Host), which a browser cannot load: "Download
   * failed" on every open. So they are sent, from what the browser asked (behind a reverse proxy, its own forwarded
   * headers), and a redirect is passed on to the browser, never followed here: its target is the portal's public,
   * sign-in-gated address.
   * The upstream ask carries accept-encoding: identity and neither content-encoding nor content-length is copied on
   * the way out: Node's undici fetch AUTO-DECODES gzip bodies but keeps the upstream's compressed content-encoding and
   * COMPRESSED content-length in the response headers, so copying them made Node emit Content-Length for 13.7KB while
   * sending 67KB of decoded bytes. Buffering the body and letting Node compute Content-Length from the ACTUAL bytes
   * makes header and payload exactly consistent.
   * Two transport rules beyond that: polling GETs are HELD open by docserver until it has data (an engine.io ping
   * lands at least every 25s), so the abort window must cover a full ping cycle or the proxy kills healthy long-
   * polls. And the handshake JSON advertises upgrades:["websocket"]: this proxy is fetch-based and cannot relay
   * WebSocket frames, so "websocket" is stripped from every outbound handshake, pinning the client to polling.
   * Refusals: 503 ds_not_configured (never started: no ds.json), 503 ds_unavailable (it did not answer; the way in is
   * asked for again, which puts right a forwarder that went). Nothing below this route mutates portal state: POSTs
   * only ever forward to the DS. */
  const prefix = `/api/x/${portal().extension.split("/").map(encodeURIComponent).join("/")}/ds`;
  const proxyDs = async (req: any, res: any): Promise<void> => {
    const raw = typeof req.url === "string" ? req.url : "";
    const i = raw.indexOf("/ds/");
    if (i === -1) return res.status(404).json({ error: "bad proxy path", code: "not_found" });
    const rest = raw.slice(i + 4); // everything after /ds/, query string included, untouched
    if (!dsPathAllowed(rest)) return res.status(404).json({ error: "not a path of the editor", code: "not_found" });
    if (!container.readDsRecord(dd)) {
      return res.status(503).json({ error: "the document server is not configured yet -- start it from the Office page first", code: "ds_not_configured" });
    }
    const fwdHeaders: Record<string, string> = { "accept-encoding": "identity", ...forwardedFor(req, prefix) };
    let body: Buffer | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      // engine.io POSTs its client packets as raw text/plain; buffer them verbatim. Nothing upstream of this
      // route parses non-JSON bodies, so the stream is still ours when it is one at all.
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const c of req) {
        total += c.length;
        // The handshake advertises maxPayload 100MB; above this a body is refused whole, never sent on cut short.
        if (total > MAX_DS_BODY) return res.status(413).json({ error: `a request to the document server may carry at most ${MAX_DS_BODY / 1024 ** 2} MB`, code: "too_large" });
        chunks.push(c);
      }
      body = Buffer.concat(chunks);
      const ct = req.headers?.["content-type"];
      if (typeof ct === "string") fwdHeaders["content-type"] = ct;
    }
    let origin = "";
    let upstream: Response;
    try {
      origin = await container.dsOrigin();
      upstream = await fetch(`${origin}/${rest}`, {
        method: req.method,
        headers: fwdHeaders,
        body: body && body.length > 0 ? new Uint8Array(body) : undefined,
        redirect: "manual",
        // An idle poll must survive a full engine.io ping cycle (pingInterval 25s) or more; 15s cut healthy
        // long-polls in half and made every doc channel look like it was dying.
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      logLine(`${req.method} /ds/${rest.split("?")[0]} -> ${origin || "(no way in)"} failed: ${(e as Error).message}`);
      // A forwarder that went, or a portal container made again: the next request finds the way in again.
      container.reachAgain().catch(() => {});
      return res.status(503).json({ error: "the document server did not answer", code: "ds_unavailable" });
    }
    // content-encoding / content-length are DELIBERATELY not copied: undici has already decoded any gzip body,
    // so the upstream length now describes compressed bytes we never send. The buffer below IS the payload;
    // Node computes a truthful Content-Length from it.
    for (const k of ["content-type", "cache-control", "content-disposition", "access-control-allow-origin", "location"]) {
      const v = upstream.headers.get(k);
      if (v !== null) res.setHeader(k, v);
    }
    // Everything else (hop-by-hop, set-cookie, server banners, ...) is dropped.
    // The editor's frame (and every page of the Document Server's in it) fetches and frames nothing of another origin.
    // A plugin comes from the editor config's pluginsData, which the page hands the editor as it likes (the Document
    // Server does not hold it to the signed config): a page that changed its config before it opened the editor ran a
    // plugin from anywhere in the person's editor, on the portal's origin. The editor's frame fetches a plugin's
    // config.json and frames its page; this refuses both for any address but the portal's own.
    res.setHeader("content-security-policy", DS_FRAME_POLICY);
    try {
      let buf = Buffer.from(await upstream.arrayBuffer());
      // Pin the socket.io client to polling: strip "websocket" from the engine.io handshake's upgrades list --
      // this proxy cannot relay WebSocket frames (fetch-based), so a promised upgrade could only end in churn.
      if (upstream.status === 200 && buf.length > 2 && buf[0] === 0x30 /* '0', the EIO handshake prefix */ && buf[1] === 0x7b /* '{' */ && !rest.includes("/a/") && !rest.includes("/u/") && !rest.includes("/s/")) {
        try {
          const h = JSON.parse(buf.subarray(1).toString("utf8")); // skip the '0' packet prefix
          if (Array.isArray(h.upgrades) && h.upgrades.includes("websocket")) {
            h.upgrades = h.upgrades.filter((t: unknown) => t !== "websocket");
            // the '0' EIO packet-type prefix is PART of the wire format -- re-serialize behind it
            buf = Buffer.from("0" + JSON.stringify(h), "utf8");
          }
        } catch {
          /* not a handshake shape after all -- forward untouched */
        }
      }
      res.status(upstream.status).end(buf.length === 0 ? undefined : buf);
    } catch (e) {
      logLine(`${req.method} /ds/${rest.split("?")[0]}: the body from ${origin} could not be read: ${(e as Error).message}`);
      if (!res.headersSent) res.status(503).json({ error: "the document server did not answer", code: "ds_unavailable" });
      else res.destroy();
    }
  };
  r.get(/^\/ds\/(.*)$/, proxyDs);
  r.post(/^\/ds\/(.*)$/, proxyDs);
}

/** Whether Office runs, for the tools: stopped where the person stopped it, switched it off or never started it;
 * starting while a start is under way or a new Document Server still sets itself up (container.settled). */
async function officeState(dd: string): Promise<"running" | "starting" | "stopped"> {
  if (!loadSettings(dd).enabled || container.userStopped(dd)) return "stopped";
  if (!container.readDsRecord(dd)) return container.starting() ? "starting" : "stopped";
  return (await container.settled()) ? "running" : "starting";
}

/* ------------------------------------------------------------------ */
/* the agents' seats                                                   */
/* ------------------------------------------------------------------ */

/** The name people see for an agent in a document: its folder's ("Research (agent)"), or the folder's base name. */
function folderLabel(home: string): string {
  try {
    const folder = portal().folders.list().find((f) => store.canonical(f.path) === home);
    if (folder?.name) return folder.name;
  } catch {
    // no portal folders (a test): the base name below
  }
  return path.basename(home) || "Agent";
}

/** The seats' wiring (seat.ts): the browser through container.ts, an agent's editor config from buildEditorConfig,
 * signed as a person's is. A browser left from a run before is removed first: its page secret is gone with that run,
 * and it holds the Document Server's sessions open. */
function wireSeats(dd: string, secret: string): void {
  const cleared = container.stopAgent().catch(() => {});
  seat.configureSeat({
    ensureAgent: async (url) => {
      await cleared;
      await container.ensureAgent(url, undefined, dd);
    },
    stopAgent: () => container.stopAgent(),
    mint: async ({ home, docId, mode, pluginUrl }) => {
      const built = buildEditorConfig(dd, secret, docId, { kind: "agent", home, label: folderLabel(home), mode, pluginUrl });
      if (built.res) {
        const body = (built.res as { body: { error: string; code?: string } }).body;
        throw new seat.SeatError(body.code === "ds_not_configured" ? "office_stopped" : body.code ?? "failed", body.error);
      }
      const config = built.config as Record<string, unknown>;
      return { config: { ...config, token: signJwt(config, CONFIG_TTL_MS, secret, "editor-config") }, apiJs: `${agentsDs()}/web-apps/apps/api/documents/api.js`, key: built.key as string };
    },
    standing: (docId, key) => {
      const doc = store.refresh(docId, dd);
      if (!doc) return null;
      return callback.keyStanding(key, doc.mtimeMs) === "current" ? "current" : "behind";
    },
    listenerOrigin: () => `http://${container.NAMES.relay}:${container.BACK_PORT}`,
    dsOrigin: agentsDs,
    log: logLine,
  });
  // A Document Server (re)started ends every session the agents' editors were in, and with them the chats of the
  // editor's chat; what waits to be posted is posted once it runs.
  container.whenDsStarted(() => {
    seat.resetSeats("their Document Server started again");
    void docchat.dsStarted().then(() => docchat.postWaiting());
  });
}

/** Comments and the editor's chat as the way to talk to agents (docchat.ts): the portal's chats and folders, the
 * agents' editors to post with, the saves, and the hooks that tell it of saves, sessions and chats. */
function wireDocchat(dd: string): void {
  docchat.configureDocchat({
    root: dd,
    seatRun: (home, docId, mode, job, options) => seat.run(home, docId, mode, job, options),
    keyOf: seat.keyOf,
    closeEditor: (home, docId, why) => seat.closeEditor(home, docId, why),
    save: (key) => saveNow(key),
    command: (body) => callback.command(body),
    officeState: () => officeState(dd),
    // A scanned document is changed only where the agent could change its file itself (tools.ts asks the same).
    mayWrite: (doc, _folder, chatId) => {
      if (!doc.path) return true;
      if (!chatId) return false;
      try {
        portal().files.identity(path.dirname(doc.path), ".", { likeParent: true, chats: [chatId] });
        return true;
      } catch {
        return false;
      }
    },
    record: (e) => recordAudit(e),
    log: (line) => logLine(`docchat: ${line}`),
  });
  callback.onPersisted((docId, buffer) => docchat.persisted(docId, buffer));
  live.onSessionChange((_docId, key, users) => docchat.sessionUsers(key, users));
  portal().chats.onEvent((chatId, event) => docchat.chatEvent(chatId, event));
  portal().chats.on("deleted", (chatId) => docchat.chatDeleted(chatId));
  portal().folders.on("removed", (folder) => docchat.folderRemoved(folder));
  void dd;
}

/** Where the agents' browser reaches the Document Server: the relay's way in, on the agents' own network. */
function agentsDs(): string {
  return `http://${container.NAMES.relay}:${container.NAMES.port}`;
}

/* ------------------------------------------------------------------ */
/* boot + cleanup                                                      */
/* ------------------------------------------------------------------ */

/** The most a request to the Document Server may carry: above engine.io's maxPayload (100 MB) of the handshake. */
const MAX_DS_BODY = 128 * 1024 * 1024;

/** The Document Server's own endpoints that no browser needs: its statistics and licence (`info`), its cluster
 * switches (`internal`), its command service (`command`, and the older `coauthoring/CommandService.ashx`), which the
 * server half alone calls, through Office's own way in, its conversion services for integrators, and its AI proxy.
 * The rest of what its nginx serves (the editor's files, the socket.io channel, the converted files, downloadas,
 * upload, print...) is the editor's. */
/** What the /ds proxy's answers allow the editor's frame to fetch and frame: the portal's own origin (where the /ds
 * proxy is), and what the editor makes in the page itself (blob:, and data: for fetches of its own images). */
export const DS_FRAME_POLICY = "connect-src 'self' blob: data:; frame-src 'self' blob:";

const DS_DENIED = new Set(["info", "internal", "command", "coauthoring", "converter", "convertservice.ashx", "docbuilder", "ai-proxy"]);

/** Whether the /ds proxy passes `rest` (the path after /ds/, with its query) on: as the Document Server's nginx reads a
 * path -- decoded, slashes merged, dot segments resolved, the versioned prefix (`/10.0.0-169/`) taken off -- its first
 * segment must not be one of DS_DENIED. A path that does not decode is refused. */
export function dsPathAllowed(rest: string): boolean {
  let pathname: string;
  try {
    pathname = path.posix.normalize(`/${decodeURIComponent(rest.split("?")[0])}`);
  } catch {
    return false;
  }
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length && /^\d+\.\d+\.\d+[.|-]\w+$/.test(segments[0])) segments.shift();
  return !DS_DENIED.has((segments[0] ?? "").toLowerCase());
}

/** The first of a header's values: a header given twice, or a list a chain of proxies made ("a, b"). */
function first(value: unknown): string | undefined {
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === "string" ? one.split(",")[0]?.trim() || undefined : undefined;
}

/** The page's own origin, as the browser says it: from `Origin`, else from `Referer`, and only for a request the
 * browser itself says comes from the same origin (`Sec-Fetch-Site: same-origin`, which no page can set or change).
 * Nothing where it does not say so: another site's page that links here names its own origin there. */
function browserOrigin(h: Record<string, unknown>): { proto: string; host: string } | undefined {
  if (first(h["sec-fetch-site"]) !== "same-origin") return undefined;
  for (const value of [first(h.origin), first(h.referer)]) {
    if (!value || value === "null") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") return { proto: url.protocol.slice(0, -1), host: url.host };
    } catch {
      // not an address: the next, or the headers below
    }
  }
  return undefined;
}

/** What tells the Document Server where the browser is (see the /ds proxy): the host and scheme the browser used, and
 * the prefix the proxy serves it under. The browser's own word first (browserOrigin): a reverse proxy in front that
 * ends TLS and says nothing of it, or that sends its upstream's name as Host, would otherwise have the Document Server
 * name http:// or that upstream in what it hands an https:// page, which the browser refuses (a blank editor frame, or
 * "Download failed"). Else a reverse proxy's own forwarded headers, else the request's Host and whether it came over
 * TLS. */
export function forwardedFor(req: { headers?: Record<string, unknown>; socket?: { encrypted?: boolean } }, prefix: string): Record<string, string> {
  const h = req.headers ?? {};
  const browser = browserOrigin(h);
  const host = browser?.host ?? first(h["x-forwarded-host"]) ?? first(h.host);
  const proto = browser?.proto ?? first(h["x-forwarded-proto"]) ?? (req.socket?.encrypted ? "https" : "http");
  return { ...(host ? { "x-forwarded-host": host } : {}), "x-forwarded-proto": proto, "x-forwarded-prefix": prefix };
}

export default async function officeServer(portalObj: ServerPortal): Promise<() => Promise<void>> {
  setPortal(portalObj);
  const dd = portal().dataDir();
  const secret = ensureSecret(dd, "jwt-secret"); // the Document Server's HS256 secret: editor configs and callbacks
  const tickets = ensureSecret(dd, "ticket-secret"); // the document tickets', which the Document Server never sees
  const relayKey = ensureSecret(dd, "relay-secret"); // the key the way back's tunnels open with at the relay

  // the seams, as their module headers describe them (audit lands in portal().audit AND a log line). The tools read and
  // edit through the agents' editors (seat.ts) while Office runs; they ask here whether it does.
  registerTools({ root: dd, record: recordAudit, officeState: () => officeState(dd) });
  // Owners and grants were chat ids before: moved to the folders those chats work in.
  try {
    const moved = store.migrateOwners((chatId) => {
      try {
        return portal().chats.folder(chatId);
      } catch {
        return undefined;
      }
    }, dd);
    if (moved) logLine(`@pithagoras/office: ${moved} document(s) now owned by a folder instead of a chat`);
  } catch (e) {
    logLine(`@pithagoras/office: owners could not be moved to folders: ${(e as Error).message}`);
  }
  wireDocchat(dd);
  callback.configure({ getState: () => container.readDsRecord(dd), getSecret: () => secret, getOrigin: () => container.dsOrigin(), root: dd, record: recordAudit });
  live.setMetaResolver((docId) => store.refresh(docId, dd)?.mtimeMs ?? null);

  registerRoutes(dd, secret);
  wireSeats(dd, secret);

  // the cookie-free loopback listener, on 127.0.0.1 alone, and the way back to it (back.ts)
  const server = http.createServer(makeLoopbackHandler(dd, tickets));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  loopPort = (server.address() as AddressInfo).port;
  const wayBack = holdWayBack({ at: container.reachedNow, key: relayKey, to: () => loopPort });
  container.whenReached(() => wayBack.nudge());

  // boot settle: reclaim trash + reconcile index vs disk, then adopt an existing DS if settings say it should run
  try {
    for (const gone of settleKept(dd).prunedDocs) void docchat.documentGone(gone);
  } catch (e) {
    logLine(`settleKept at boot failed: ${(e as Error).message}`);
  }
  // the workspace scan indexes every .docx/.xlsx of the agent folders IN PLACE (product decision: no manual import
  // any more -- what the agents work in IS the library). settleKept runs FIRST on purpose: it prunes entries whose
  // file vanished while the portal slept, so the scan then REFRESHES only surviving files instead of re-adding them.
  try {
    const out = store.scanWorkspace(portal().folders.list().map((f) => f.path), dd);
    logLine(`workspace scan at boot: ${out.added} added, ${out.updated} refreshed`);
  } catch (e) {
    logLine(`workspace scan at boot failed: ${(e as Error).message}`);
  }
  void container.lookAfter(undefined, dd); // fire-and-forget; logs its own failures

  // Saves the Document Server kept as forgotten while this half was away (its callback refused until its retries ran
  // out) are taken back once in each run, as soon as the Document Server answers: asked again at each look until then.
  let recovered = false;
  const recover = () => {
    if (recovered || !container.readDsRecord(dd)) return;
    callback.recoverForgotten().then((n) => {
      recovered = true;
      if (n) recordAudit({ subject: container.DS_NAME, reason: `${n} save(s) the document server had kept as forgotten were taken back` });
    }, () => {});
  };
  recover();
  // The records of comments' and the editor's chats: runs that went on, removals, sessions still open, posts waiting.
  void docchat.boot().catch((e) => logLine(`docchat boot failed: ${(e as Error).message}`));

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      for (const gone of settleKept(dd).prunedDocs) void docchat.documentGone(gone);
    } catch (e) {
      logLine(`settleKept failed: ${(e as Error).message}`);
    }
    void container.lookAfter(undefined, dd);
    recover();
  }, 30_000);
  timer.unref(); // never hold the portal process open

  return async () => {
    stopped = true;
    clearInterval(timer);
    loopPort = 0;
    seat.stopSeats();
    container.whenDsStarted(undefined);
    await container.stopAgent().catch(() => {});
    container.whenReached(undefined);
    wayBack.stop();
    // close() alone would wait on keep-alive connections held open by clients (undici fetch among them);
    // dropping the idle ones is what lets a portal stop -- and a test's cleanup -- actually finish
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
