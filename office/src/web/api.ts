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
  /** The folder of the agent or project it belongs to: the agent's home or the project folder its file is in. */
  owner: string;
  /** What the person calls that agent or project (/state gives it). */
  ownerName?: string;
  /** Mentions in its comments that opened it to those agents' or projects' folders. */
  grants: { folder: string; commentId: string; at: number }[];
  createdBy?: string;
  /** Since when its file has been gone: it stays listed a week, in case it comes back. */
  missingSince?: number;
  /** Which workspace dir the doc lives in, stamped by the scan (store.ts); its owner's folder name where not stamped yet. */
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
  limits?: DocchatLimits;
  /** What each limit may be set to: [least, most]. */
  limitBounds?: Partial<Record<keyof DocchatLimits, [number, number]>>;
  container: OfficeContainer;
  agent: OfficeAgentImage;
  docs: OfficeDoc[];
  /** Every doc has an entry: empty while nobody is editing it, so the badge code needs no null check. */
  locks: Record<string, { id: string; name?: string }[]>;
  /** Where the portal is too old for agents to answer comments and the editor's chat: what the server half says of it. */
  docchatOff?: string;
}

/** POST /editor-config: the plain DocsAPI.DocEditor config plus its JWT and where api.js lives -- apiJs is dropped again before the call. */
export interface EditorConfig extends Record<string, unknown> {
  token: string;
  apiJs: string;
}

/** How a thread's or the editor's chat stands, as the editor's bar shows it (docchat.ts statesOf). */
export interface DocchatItem {
  kind: "thread" | "chat";
  label: string;
  state: "queued" | "working" | "answered" | "not_posted" | "failed" | "interrupted" | "limit" | "idle";
  error?: string;
}

/** The limits of comments and the editor's chat with agents (settings.ts). */
export interface DocchatLimits {
  docchatRuns: number;
  docchatThreads: number;
  docchatReplyChars: number;
  docchatChatMessages: number;
  docchatRemoveAfterS: number;
  docchatChatEndS: number;
  docchatReportsPer10S: number;
  docchatMessageChars: number;
  docchatSaveEveryS: number;
  docchatQueued: number;
}

export type SettingsPatch = { enabled?: boolean; imageTag?: string } & Partial<DocchatLimits>;

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
  /** A new document: in the chat's agent home or project folder with `chat`, else in the home New starts the person's
   * chats in. */
  createDocument: (body: { title: string; type: "word" | "cell"; chat?: string }) =>
    call<OfficeDoc>("/documents", { method: "POST", body: JSON.stringify(body) }),
  renameDocument: (id: string, title: string) =>
    call<OfficeDoc>(`/documents/${encodeURIComponent(id)}/rename`, { method: "POST", body: JSON.stringify({ title }) }),
  deleteDocument: (id: string) => call<{ ok: true }>(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Re-run the workspace scan now (boot does it automatically): { added, updated }. */
  rescanLibrary: () => call<{ added: number; updated: number }>("/documents/rescan", { method: "POST" }),
  editorConfig: (docId: string) => call<EditorConfig>("/editor-config", { method: "POST", body: JSON.stringify({ doc: docId }) }),
  /** How the editor opened with `key` stands to the document now: "behind" means the file changed outside the editor. */
  editorState: (docId: string, key: string) =>
    call<{ standing: "current" | "behind"; docchat?: DocchatItem[]; docchatOff?: string }>(`/editor-state?doc=${encodeURIComponent(docId)}&key=${encodeURIComponent(key)}`),
  /** Who a comment can mention, as the editor's mention list takes them. */
  mentionables: () => call<{ users: { name: string; email: string }[] }>("/mentionables"),
  /** A report of the people's editor (docchat-page.ts): its answer's status, also for one refused. */
  docchat: async (path: string, body: unknown, keepalive = false): Promise<{ ok: boolean; status: number }> => {
    try {
      await call(path, { method: "POST", body: JSON.stringify(body), ...(keepalive ? { keepalive: true } : {}) });
      return { ok: true, status: 200 };
    } catch (e) {
      const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : 0;
      return { ok: false, status };
    }
  },
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
