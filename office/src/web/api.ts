import { portal } from "../portal";

/**
 * What the browser half asks of its server half: the routes under the address the portal gives the package
 * (portal.api.url, mounted by the portal at /api/x/@pithagoras/office, session-gated there). A request made while the
 * server half is not running is refused as one the server refused is.
 */

/** One document of the library, as GET /state says it (store.DocMeta verbatim). */
export interface OfficeDoc {
  docId: string;
  title: string;
  ext: "docx" | "xlsx";
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
  /** The document's current revision: its file's mtimeMs. */
  mtimeMs: number;
  /** The folder of the agent or project that made it, or null for one made from the library page or scanned. */
  owner: string | null;
  /** Mentions in its comments that opened it to those agents' or projects' folders. */
  grants: { folder: string; commentId: string; at: number }[];
  createdBy?: string;
  /** Since when its file has been gone: it stays listed a week, in case it comes back. */
  missingSince?: number;
  /** Which workspace dir the doc lives in, stamped by the scan (store.ts); ABSENT for library-made docs -- the UI shows "library". */
  workspace?: string;
}

/** A pull in progress, out of the server half's memory (container.PullState). */
export interface OfficePull {
  active: boolean;
  line: string;
  error?: string;
}

/** The Document Server container, as status() reports it. */
export interface OfficeContainer {
  state: string;
  version?: string;
  memBytes?: number;
  pull?: OfficePull | null;
  /** Why the last start failed, until one succeeds. */
  error?: string;
}

/** The agents' editor (headless Chromium): whether its image is there, how its download goes (Start downloads it), and
 * how the browser made from it stands (seat.health). */
export interface OfficeAgentImage {
  present: boolean;
  pull: OfficePull | null;
  tag: string;
  browser?: { running: boolean; starting: boolean; editors: number; error?: string };
}

/** GET /state -- the payload of the 5 s poll : settings, container, the agents' editor, every doc, who is in what. */
export interface OfficeState {
  enabled: boolean;
  imageTag: string;
  container: OfficeContainer;
  agent: OfficeAgentImage;
  docs: OfficeDoc[];
  /** Every doc has an entry: empty while nobody is editing it, so the badge code needs no null check. */
  locks: Record<string, { id: string; name?: string }[]>;
}

/** POST /editor-config: the plain DocsAPI.DocEditor config plus its JWT and where api.js lives -- apiJs is dropped again before the call. */
export interface EditorConfig extends Record<string, unknown> {
  token: string;
  apiJs: string;
}

export type SettingsPatch = { enabled?: boolean; imageTag?: string };

/** The settings answer: what was saved, where the container stands as of now, and that a start went on its own. */
export interface SettingsAnswer {
  settings: { enabled: boolean; imageTag: string };
  container: OfficeContainer;
  starting?: boolean;
}

/** A JSON route of the server half, at its address. */
const call = async <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);

export const api = {
  state: () => call<OfficeState>("/state"),
  /** The documents the agent or project of a chat sees: the panel beside it shows those. */
  scope: (chatId: string) => call<{ docIds: string[] }>(`/scope?chat=${encodeURIComponent(chatId)}`),
  createDocument: (body: { title: string; type: "word" | "cell"; owner?: string }) =>
    call<OfficeDoc>("/documents", { method: "POST", body: JSON.stringify(body) }),
  renameDocument: (id: string, title: string) =>
    call<OfficeDoc>(`/documents/${encodeURIComponent(id)}/rename`, { method: "POST", body: JSON.stringify({ title }) }),
  deleteDocument: (id: string) => call<{ ok: true }>(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Re-run the workspace scan now (boot does it automatically): { added, updated }. */
  rescanLibrary: () => call<{ added: number; updated: number }>("/documents/rescan", { method: "POST" }),
  editorConfig: (docId: string) => call<EditorConfig>("/editor-config", { method: "POST", body: JSON.stringify({ doc: docId }) }),
  /** How the editor opened with `key` stands to the document now: "behind" means the file changed outside the editor. */
  editorState: (docId: string, key: string) =>
    call<{ standing: "current" | "behind" }>(`/editor-state?doc=${encodeURIComponent(docId)}&key=${encodeURIComponent(key)}`),
  saveSettings: (patch: SettingsPatch) => call<SettingsAnswer>("/settings", { method: "POST", body: JSON.stringify(patch) }),
  /** Awaits the whole start, both images' downloads included -- the page shows their progress from /state meanwhile. */
  startContainer: () => call<{ started: boolean; container: OfficeContainer; agent: { present: boolean; error?: string } }>("/container/start", { method: "POST" }),
  stopContainer: () => call<{ container: OfficeContainer }>("/container/stop", { method: "POST" }),
  /** The Document Server, its relay and its network removed; with `data` also its volumes. */
  removeContainer: (data: boolean) => call<{ container: OfficeContainer }>("/container/remove", { method: "POST", body: JSON.stringify({ data }) }),
  /** The library bytes as an attachment -- plain addresses, the session rides along on the cookie. */
  downloadUrl: (id: string) => portal.api.url(`/documents/${encodeURIComponent(id)}`),
  exportUrl: (id: string) => portal.api.url(`/documents/${encodeURIComponent(id)}/export`),
};

/** A refusal of the server half, in words for where it says the rest. The ApiError of the portal's json() carries
 * exactly that message (the { error } field), so a failure of POST /documents reaches an ErrorBanner
 * verbatim, never a dead click. */
export function sayError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
