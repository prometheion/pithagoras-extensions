import { useEffect, useState } from "react";
import { LuChevronRight, LuExternalLink, LuFileText, LuFolder, LuEllipsis, LuShare2, LuTrash2, LuUsers } from "react-icons/lu";
import { msg, portal, t } from "../portal";
import { api, partText, sayError, useFamilyOn, useGuard, useNextcloudInstance } from "./api";
import { confirmDelete } from "./widgets";

/** The Files tab: one view that walks the WebDAV tree -- a folder is opened by choosing it, a readable file (text,
 * a common image, a PDF as the server's extracted text) is read into this panel, and everything else is only
 * downloaded. Sharing sits inside it the way Nextcloud itself keeps it: an entry that has shares wears the mark,
 * and a box opens under it where those are seen, added (their permissions picked as chips), taken away, and where
 * a short public download link for it is made. A list of what others hold on you stands beside the tree. All of it
 * as tool calls on the server. */

type Rec = Record<string, unknown>;

const strOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const numOf = (value: unknown): number | undefined => (typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : undefined);

/** What the WebDAV list tool says of one entry. */
interface FileRow {
  name: string;
  path: string; // relative to the files root, no leading slash ("docs/invite.pdf")
  directory: boolean;
  size?: number;
  contentType?: string;
  url?: string; // a link that opens the entry in Nextcloud itself
}

/** What one chosen file reads back as: its text (or the PDF's extracted text), an image as a data URL, else nothing. */
interface Preview {
  row: FileRow;
  kind: "text" | "image" | "pdf";
  body?: string;
  dataUrl?: string;
}

/** What the trash list says of one deleted entry. */
interface TrashRow {
  id: string;
  name?: string;
  originalLocation?: string;
  deletedAt?: number;
}

/** What the share tool says of one share, from its OCS words. */
interface ShareRow {
  id: number;
  shareType: number;
  withName: string;
  target: string;
  permission: number;
  expires?: string;
}

const MAX_INLINE_BYTES = 8 * 1024 * 1024; // above this the panel does not pull a file in whole

const isTextLike = (ct: string): boolean => ct.startsWith("text/") || ct === "application/json" || ct === "application/xml";
const isImage = (ct: string): boolean => ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"].includes(ct);

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
};

/** The OCS tool answers paths with or without a leading slash; the tree's rows have none. Compare on both stripped. */
const normPath = (p: string): string => p.replace(/^\/+/, "");

/** The kinds of share, as the list draws them and the form picks them. */
const knownShareTypes = new Map<number, string>([
  [0, msg("User")],
  [1, msg("Group")],
  [3, msg("Public link")],
  [4, msg("E-Mail address")],
  [6, msg("Federated (ownCloud)")],
  [7, msg("Circle")],
  [10, msg("Talk conversation")],
  [12, msg("Deck card")],
]);

const shareTypes: [number, string][] = [
  [0, msg("User")],
  [1, msg("Group")],
  [4, msg("E-Mail address")],
];

const permissionBits: [number, string][] = [
  [1, msg("read")],
  [2, msg("update")],
  [4, msg("create")],
  [8, msg("delete")],
  [16, msg("share")],
];

const mapShares = (data: unknown): ShareRow[] => {
  let list: unknown = data;
  if (typeof data === "object" && data !== null && Array.isArray((data as Rec).shares)) list = (data as Rec).shares;
  return Array.isArray(list)
    ? list.map((s) => {
        const r = s as Rec;
        return {
          id: Number(r.id ?? 0),
          shareType: numOf(r.share_type ?? r.shareType) ?? -1,
          withName: strOf(r.share_with_display_name ?? r.shareWithDisplayName) ?? strOf(r.share_with ?? r.shareWith) ?? "",
          target: normPath(strOf(r.path ?? r.file_target) ?? ""),
          permission: numOf(r.permission) ?? 0,
          expires: strOf(r.expiration),
        };
      })
    : [];
};

export default function Files() {
  portal.locale.use();
  const instance = useNextcloudInstance(); // the panel's current instance: where the file and share calls go
  const guard = useGuard();
  // Sharing switched off for the instance: the server refuses its tools, so no share is read, shown or offered here.
  const sharing = useFamilyOn("sharing");

  // the tree: where it stands, what it shows, and one file read into the panel
  const [path, setPath] = useState("");
  const [rows, setRows] = useState<FileRow[] | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);

  // sharing as it stands across the cloud (what badges the entries and feeds their boxes), what is on you,
  // and the one entry whose box is open under its row
  const [allShares, setAllShares] = useState<ShareRow[] | null>(null);
  const [withMe, setWithMe] = useState(false);
  const [withMeShares, setWithMeShares] = useState<ShareRow[] | null>(null);
  const [shareProblem, setShareProblem] = useState<string | null>(null);
  const [boxFor, setBoxFor] = useState<string | null>(null);

  // the tree's own making and moving: a new folder or file where it stands, the one entry whose action box is
  // open under its row, and the trash as it stands beside the tree
  const [newKind, setNewKind] = useState<null | "folder" | "file">(null);
  const [newName, setNewName] = useState("");
  const [busyNew, setBusyNew] = useState(false);
  const [createProblem, setCreateProblem] = useState<string | null>(null);
  const [actFor, setActFor] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashRows, setTrashRows] = useState<TrashRow[] | null>(null);
  const [trashProblem, setTrashProblem] = useState<string | null>(null);

  // ---- the tree --------------------------------------------------------------

  const loadListing = (at: string, keep = false) => {
    const current = guard("rows"); // only the folder asked for last is drawn: a slow earlier one must not put its rows under this path
    if (!keep) setRows(null);
    setFileProblem(null);
    void api
      .tool("nc_webdav_list_directory", at === "" ? {} : { path: at }, instance)
      .then((result) => {
        if (!current()) return;
        const data = partText(result).data;
        const files = typeof data === "object" && data !== null ? (data as Rec).files : undefined;
        const mapped: FileRow[] = Array.isArray(files)
          ? files.map((f) => {
              const r = f as Rec;
              const name = String(r.name ?? "");
              return {
                name,
                path: at === "" ? name : `${at}/${name}`,
                directory: Boolean(r.is_directory ?? r.isDirectory),
                size: numOf(r.size),
                contentType: strOf(r.content_type ?? r.contentType),
                url: strOf(r.url),
              };
            })
          : [];
        mapped.sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1));
        setRows(mapped);
      })
      .catch((error) => current() && setFileProblem(sayError(error)));
  };

  // Where the view stands drives the listing itself: a folder chosen or a crumb walked back to re-pulls its rows,
  // and the first pull is the one at the root.
  useEffect(() => {
    loadListing(path);
  }, [path]);

  const download = async (row: FileRow): Promise<void> => {
    if (row.size !== undefined && row.size > MAX_INLINE_BYTES) throw new Error(t("This file is larger than this panel reads inline."));
    const result = await api.tool("nc_webdav_read_file", { path: row.path, parse_document: "raw" }, instance);
    const data = partText(result).data;
    const b64 = typeof data === "object" && data !== null ? strOf((data as Rec).content) : undefined;
    if (b64 === undefined) throw new Error(t("The file did not answer in a way this panel reads."));
    // The row may say nothing of its size; the length of the answer is what it is then -- decoded bytes from it, capped
    // before they come into memory at all.
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    if (Math.floor(b64.length / 4) * 3 - pad > MAX_INLINE_BYTES) throw new Error(t("This file is larger than this panel reads inline."));
    let raw: string;
    try {
      raw = atob(b64);
    } catch {
      throw new Error(t("The file did not answer in a way this panel reads."));
    }
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: row.contentType ?? "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = row.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const open = async (row: FileRow): Promise<void> => {
    if (row.directory) {
      setPreview(null);
      setBoxFor(null);
      setPath(row.path);
      return;
    }
    if (previewBusy) return;
    const ct = row.contentType ?? "";
    if (row.size !== undefined && row.size > MAX_INLINE_BYTES && (ct === "application/pdf" || isTextLike(ct) || isImage(ct))) {
      setPreviewProblem(t("This file is larger than this panel reads inline."));
      return;
    }
    if (ct !== "application/pdf" && !isTextLike(ct) && !isImage(ct)) {
      // the rest has no view this panel can draw: it is only downloaded
      setPreviewProblem(null);
      setPreviewBusy(true);
      try {
        await download(row);
      } catch (error) {
        setPreviewProblem(sayError(error));
      } finally {
        setPreviewBusy(false);
      }
      return;
    }
    setPreviewBusy(true);
    setPreview(null);
    setPreviewProblem(null);
    try {
      if (ct === "application/pdf") {
        const result = await api.tool("nc_webdav_read_file", { path: row.path }, instance);
        const data = partText(result).data;
        const body = typeof data === "object" && data !== null ? strOf((data as Rec).content) ?? "" : "";
        setPreview({ row, kind: "pdf", body });
      } else if (isImage(ct)) {
        const result = await api.tool("nc_webdav_read_file", { path: row.path, parse_document: "raw" }, instance);
        const data = partText(result).data;
        const b64 = typeof data === "object" && data !== null ? strOf((data as Rec).content) : undefined;
        if (b64 === undefined) throw new Error(t("The file did not answer in a way this panel reads."));
        setPreview({ row, kind: "image", dataUrl: `data:${ct};base64,${b64}` });
      } else {
        const result = await api.tool("nc_webdav_read_file", { path: row.path }, instance);
        const data = partText(result).data;
        const body = typeof data === "object" && data !== null ? strOf((data as Rec).content) ?? "" : "";
        setPreview({ row, kind: "text", body });
      }
    } catch (error) {
      setPreviewProblem(sayError(error));
    } finally {
      setPreviewBusy(false);
    }
  };

  // ---- sharing -----------------------------------------------------------------

  const loadShareIndex = () => {
    if (!sharing) return;
    const current = guard("shares");
    void api
      .tool("nc_share_list", {}, instance)
      .then((result) => current() && setAllShares(mapShares(partText(result).data)))
      .catch((error) => current() && setShareProblem(sayError(error)));
  };

  useEffect(() => {
    loadShareIndex();
  }, []);

  const loadWithMe = () => {
    const current = guard("withMe");
    setWithMeShares(null);
    setShareProblem(null);
    void api
      .tool("nc_share_list", { shared_with_me: true }, instance)
      .then((result) => {
        if (!current()) return;
        const mapped = mapShares(partText(result).data);
        mapped.sort((a, b) => a.target.localeCompare(b.target));
        setWithMeShares(mapped);
      })
      .catch((error) => current() && setShareProblem(sayError(error)));
  };

  useEffect(() => {
    if (withMe) loadWithMe();
  }, [withMe]);

  const loadTrash = (keep = false) => {
    const current = guard("trash");
    if (!keep) setTrashRows(null);
    setTrashProblem(null);
    void api
      .tool("nc_webdav_list_trash", {}, instance)
      .then((result) => {
        if (!current()) return;
        const data = partText(result).data;
        const list = typeof data === "object" && data !== null ? (data as Rec).items : undefined;
        setTrashRows(
          Array.isArray(list)
            ? list.map((e) => {
                const r = e as Rec;
                return { id: String(r.id ?? ""), name: strOf(r.name), originalLocation: strOf(r.original_location ?? r.originalLocation), deletedAt: numOf(r.deleted_at ?? r.deletedAt) };
              })
            : [],
        );
      })
      .catch((error) => current() && setTrashProblem(sayError(error)));
  };

  useEffect(() => {
    if (trashOpen) loadTrash();
  }, [trashOpen]);

  /** What a new folder or file goes where it stands, and the list looks again at once. */
  const createEntry = async () => {
    const name = newName.trim();
    if (busyNew || newKind === null || name === "") return;
    const at = path === "" ? name : `${path}/${name}`;
    setBusyNew(true);
    setCreateProblem(null);
    try {
      if (newKind === "folder") await api.tool("nc_webdav_create_directory", { path: at }, instance);
      else await api.tool("nc_webdav_write_file", { path: at, content: "" }, instance); // fail-closed on the server: no file is quietly overwritten
      setNewKind(null);
      setNewName("");
      loadListing(path, true); // the folder as it stands now
    } catch (error) {
      setCreateProblem(sayError(error));
    } finally {
      setBusyNew(false);
    }
  };

  /** What is shared at one entry of the tree -- its box and its mark draw from this. */
  const sharesAt = (at: string): ShareRow[] => (allShares ?? []).filter((s) => s.target === at);

  /** Where a "shared with me" entry lives: its folder, walked to in the tree. */
  const gotoShare = (share: ShareRow) => {
    setWithMe(false);
    setPreview(null);
    const i = share.target.lastIndexOf("/");
    setPath(i > 0 ? share.target.slice(0, i) : "");
  };

  const crumbs = path === "" ? [] : path.split("/");

  // ---- what is drawn ---------------------------------------------------------------

  return (
    <div className="space-y-2">
      {preview !== null ? (
        <>
          <div className="flex items-center gap-1">
            <button type="button" className={portal.ui.classes.ghost} onClick={() => setPreview(null)}>
              ← {t("Back to the list")}
            </button>
            <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{preview.row.name}</span>
            <button
              type="button"
              className={portal.ui.classes.ghost}
              disabled={previewBusy}
              onClick={() => {
                setPreviewProblem(null);
                void download(preview.row).catch((error) => setPreviewProblem(sayError(error)));
              }}
            >
              {t("Download")}
            </button>
            {preview.row.url !== undefined && (
              <a href={preview.row.url} target="_blank" rel="noreferrer" className={portal.ui.classes.ghost} title={t("Open in Nextcloud")}>
                <LuExternalLink />
              </a>
            )}
          </div>
          {preview.kind === "image" && preview.dataUrl !== undefined ? (
            <img src={preview.dataUrl} alt={preview.row.name} className="nc-preview-img" />
          ) : (
            <>
              {preview.kind === "pdf" && <p className="px-1 text-xs text-fg-subtle">{t("The PDF's text as the server extracted it; the layout stays on Nextcloud.")}</p>}
              <pre className="nc-file-text">{preview.body ?? ""}</pre>
            </>
          )}
          {previewProblem !== null && <portal.ui.ErrorBanner onClose={() => setPreviewProblem(null)}>{previewProblem}</portal.ui.ErrorBanner>}
        </>
      ) : withMe ? (
        <>
          <nav className="nc-crumbs" aria-label={t("Where you are")}>
            <button type="button" onClick={() => { setWithMe(false); }}>{t("Files")}</button>
            <LuChevronRight size={11} className="text-fg-subtle" />
            <span className="truncate">{t("Shared with me")}</span>
          </nav>
          {withMeShares === null ? (
            shareProblem !== null ? (
              <portal.ui.LoadFailed error={t("The shares could not be read: {error}", { error: shareProblem })} onRetry={loadWithMe} />
            ) : (
              <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
            )
          ) : withMeShares.length === 0 ? (
            <portal.ui.Empty>{t("Nothing is shared with you.")}</portal.ui.Empty>
          ) : (
            <ul className="space-y-1">
              {withMeShares.map((share) => (
                <li key={share.id}>
                  <button type="button" className="nc-file" onClick={() => gotoShare(share)} title={t("Go to it in the list")}>
                    <LuUsers className="shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{share.withName || t("Unknown share")}</span>
                      <span className="block truncate text-xs text-fg-subtle" title={share.target}>{share.target}</span>
                    </span>
                    <span className="nc-chip nc-chip-dim shrink-0">{t(knownShareTypes.get(share.shareType) ?? msg("Other share"))}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : trashOpen ? (
        <>
          <nav className="nc-crumbs" aria-label={t("Where you are")}>
            <button type="button" onClick={() => { setTrashOpen(false); }}>{t("Files")}</button>
            <LuChevronRight size={11} className="text-fg-subtle" />
            <span className="truncate">{t("Trash")}</span>
          </nav>
          {trashRows === null ? (
            trashProblem !== null ? (
              <portal.ui.LoadFailed error={t("The trash could not be read: {error}", { error: trashProblem })} onRetry={() => loadTrash()} />
            ) : (
              <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
            )
          ) : trashRows.length === 0 ? (
            <portal.ui.Empty>{t("The trash is empty.")}</portal.ui.Empty>
          ) : (
            <ul className="space-y-1">
              {trashRows.map((entry) => (
                <li key={entry.id} className="nc-file" title={entry.originalLocation ?? ""}>
                  <LuTrash2 className="shrink-0 text-fg-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{entry.name ?? t("(unnamed)")}</span>
                    <span className="block truncate text-xs text-fg-subtle">
                      {entry.originalLocation !== undefined ? t("was {location}", { location: entry.originalLocation }) : ""}
                      {entry.deletedAt !== undefined ? ` · ${portal.format.date(entry.deletedAt * 1000)}` : ""}
                    </span>
                  </span>
                  <button type="button" className={portal.ui.classes.primarySmall} onClick={() => {
                    setTrashProblem(null);
                    void api.tool("nc_webdav_restore_from_trash", { entry_id: entry.id }, instance)
                      .then(() => {
                        loadTrash(true);
                        loadListing(path, true); // what came back stands in the folder it was taken from
                      })
                      .catch((error) => setTrashProblem(sayError(error)));
                  }}>
                    {t("Restore")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {trashProblem !== null && trashRows !== null && <portal.ui.ErrorBanner onClose={() => setTrashProblem(null)}>{trashProblem}</portal.ui.ErrorBanner>}
        </>
      ) : (
        <>
          {/* The path and the Shared-with-me entry stand on their own lines: a long path must not push
              the chip to a second row and leave a gap under it. */}
          <div className="nc-files-head">
            <nav className="nc-crumbs" aria-label={t("Where you are")}>
              <button type="button" onClick={() => { setPath(""); }}>{t("Files")}</button>
              {crumbs.map((segment, i) => (
                <span key={i} className="inline-flex min-w-0 items-center gap-0.5">
                  <LuChevronRight size={11} className="text-fg-subtle" />
                  <button type="button" onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>
                    {segment}
                  </button>
                </span>
              ))}
            </nav>
            <div>
              {sharing && (
                <button type="button" className={`nc-tab${withMe ? " nc-tab-on" : ""}`} onClick={() => { setPreview(null); setTrashOpen(false); setWithMe(true); }} title={t("What others hold on you")}>
                  <LuUsers />
                  <span>{t("Shared with me")}</span>
                </button>
              )}
              <button type="button" className={`nc-tab${trashOpen ? " nc-tab-on" : ""}`} onClick={() => { setPreview(null); setWithMe(false); setTrashOpen(true); }} title={t("What was taken away")}>
                <LuTrash2 />
                <span>{t("Trash")}</span>
              </button>
            </div>
          </div>

          {/* A new folder or file where the list stands: one word, and the list looks again at once. */}
          {newKind === null ? (
            <div className="flex gap-1">
              <button type="button" className={portal.ui.classes.ghost} onClick={() => { setNewKind("folder"); setNewName(""); }}>
                + {t("A new folder")}
              </button>
              <button type="button" className={portal.ui.classes.ghost} onClick={() => { setNewKind("file"); setNewName(""); }}>
                + {t("A new file")}
              </button>
            </div>
          ) : (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void createEntry();
              }}
            >
              <input className={portal.ui.classes.input} value={newName} placeholder={newKind === "folder" ? t("The folder's name") : t("The file's name")} aria-label={newKind === "folder" ? t("The folder's name") : t("The file's name")} onChange={(e) => setNewName(e.target.value)} />
              <button type="submit" className={portal.ui.classes.primarySmall} disabled={busyNew || newName.trim() === ""}>{t("Add")}</button>
              <button type="button" className={portal.ui.classes.ghost} onClick={() => setNewKind(null)} aria-label={t("Cancel")}>×</button>
            </form>
          )}
          {createProblem !== null && <portal.ui.ErrorBanner onClose={() => setCreateProblem(null)}>{createProblem}</portal.ui.ErrorBanner>}
          {shareProblem !== null && <portal.ui.ErrorBanner onClose={() => setShareProblem(null)}>{t("The shares could not be read: {error}", { error: shareProblem })}</portal.ui.ErrorBanner>}
          {rows === null ? (
            fileProblem !== null ? (
              <portal.ui.LoadFailed error={t("The files could not be read: {error}", { error: fileProblem })} onRetry={() => loadListing(path)} />
            ) : (
              <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
            )
          ) : rows.length === 0 ? (
            <portal.ui.Empty>{t("No files here.")}</portal.ui.Empty>
          ) : (
            <ul className="space-y-0.5">
              {rows.map((row) => {
                const shares = sharesAt(row.path);
                // A row is a pick (open or download) beside a mark of its own (the box under it): two controls,
                // so the pick is a button inside the row, not the row itself -- nested buttons would not stand.
                return (
                  <li key={row.path}>
                    <div className="nc-file" title={row.directory ? row.name : t("Open or download this file")}>
                      <button type="button" className="nc-file-main" disabled={previewBusy} onClick={() => void open(row)}>
                        {row.directory ? <LuFolder className="nc-file-dir shrink-0" /> : <LuFileText className="shrink-0" />}
                        <span className="nc-file-name">{row.name}</span>
                        {!row.directory && row.size !== undefined && <span className="nc-file-size">{formatBytes(row.size)}</span>}
                      </button>
                      {sharing && (
                        <button
                          type="button"
                          className={`nc-row-share${shares.length > 0 ? " is-shared" : ""}`}
                          title={shares.length > 0 ? t("What is shared at this one") : t("Share this one")}
                          aria-label={t("Shares of this one")}
                          onClick={() => { setActFor(null); setBoxFor(boxFor === row.path ? null : row.path); }}
                        >
                          <LuShare2 />
                        </button>
                      )}
                      <button
                        type="button"
                        className={`nc-row-share${actFor === row.path ? " is-shared" : ""}`}
                        title={t("Move, copy or take it away")}
                        aria-label={t("The things this one can be done to")}
                        onClick={() => { setBoxFor(null); setActFor(actFor === row.path ? null : row.path); }}
                      >
                        <LuEllipsis />
                      </button>
                    </div>
                    {actFor === row.path && (
                      <ActionsBox
                        entry={row}
                        instance={instance}
                        onChanged={() => {
                          loadListing(path, true);
                          loadShareIndex();
                        }}
                        onClose={() => setActFor(null)}
                      />
                    )}
                    {sharing && boxFor === row.path && (
                      <SharingBox
                        entryPath={row.path}
                        shares={shares}
                        instance={instance}
                        onChanged={loadShareIndex}
                        onClose={() => setBoxFor(null)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {previewProblem !== null && rows !== null && (
            <portal.ui.ErrorBanner onClose={() => setPreviewProblem(null)}>{previewProblem}</portal.ui.ErrorBanner>
          )}
        </>
      )}
    </div>
  );
}

/** The box that opens under one entry of the tree: what is shared at it and who with, the way a new share of it
 * is added (the permission picked as chips, not boxes), and the short public link for it. It calls the same tools
 * on the server and tells its list to look again where anything moved. */
function SharingBox({
  entryPath,
  shares,
  instance,
  onChanged,
  onClose,
}: {
  entryPath: string;
  shares: ShareRow[];
  instance?: string;
  onChanged(): void;
  onClose(): void;
}) {
  portal.locale.use();
  const [form, setForm] = useState({ shareWith: "", shareType: 0, read: true, update: false, create: false, del: false, share: false });
  const [minutes, setMinutes] = useState("30");
  const [linkResult, setLinkResult] = useState<{ url: string; downloadUrl?: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const permissionValue = (): number =>
    (form.read ? 1 : 0) | (form.update ? 2 : 0) | (form.create ? 4 : 0) | (form.del ? 8 : 0) | (form.share ? 16 : 0);

  const addShare = async () => {
    const with_ = form.shareWith.trim();
    if (busy || with_ === "") return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_share_create", { path: entryPath, share_with: with_, share_type: form.shareType, permissions: permissionValue() }, instance);
      setForm({ ...form, shareWith: "" });
      onChanged();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const removeShare = async (id: number) => {
    if (busy) return;
    if (!(await confirmDelete(t("Take this share away?"), undefined, t("Take this share away")))) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_share_delete", { share_id: id }, instance);
      onChanged();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const makeLink = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setLinkResult(null);
    try {
      const result = await api.tool("nc_share_create_public_link", { path: entryPath, expires_in_minutes: Number(minutes) > 0 ? Number(minutes) : 30 }, instance);
      const data = partText(result).data;
      if (typeof data === "object" && data !== null && typeof (data as Rec).url === "string") {
        setLinkResult({ url: (data as Rec).url as string, downloadUrl: strOf((data as Rec).download_url) });
        onChanged(); // the link is a share: the index looks again, so the entry wears its mark
      } else {
        setProblem(t("The link did not answer in a way this panel reads."));
      }
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleBit = (key: "read" | "update" | "create" | "del" | "share") => setForm({ ...form, [key]: !form[key] });

  return (
    <div className="nc-sharebox">
      <div className="flex items-center gap-1">
        <LuShare2 className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{t("Shares")}</span>
        <button type="button" className={portal.ui.classes.ghost} onClick={onClose} aria-label={t("Close this box")}>
          ×
        </button>
      </div>

      {shares.length > 0 && (
        <ul className="space-y-1">
          {shares.map((share) => (
            <li key={share.id} className="nc-sharebox-row">
              <span className="min-w-0 flex-1 truncate text-sm" title={share.withName}>{share.withName || t("Unknown share")}</span>
              <span className="nc-chip nc-chip-dim shrink-0">{t(knownShareTypes.get(share.shareType) ?? msg("Other share"))}</span>
              {share.expires !== undefined && <span className="nc-chip nc-chip-dim shrink-0">{share.expires}</span>}
              <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void removeShare(share.id)} aria-label={t("Take this share away")}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="nc-form"
        onSubmit={(e) => {
          e.preventDefault();
          void addShare();
        }}
      >
        <p className="nc-form-title">{t("Add a share")}</p>
        <div className="flex gap-1">
          <div className="w-40 shrink">
          <portal.ui.Select
            size="sm"
            className="w-full"
            value={String(form.shareType)}
            aria-label={t("Shared with")}
            onChange={(v) => setForm({ ...form, shareType: Number(v), shareWith: "" })}
            options={shareTypes.map(([value, label]) => ({ value: String(value), label: t(label) }))}
          />
          </div>
          <input className={portal.ui.classes.input} value={form.shareWith} placeholder={t("The name of it")} aria-label={t("The name of the user, group or address")} onChange={(e) => setForm({ ...form, shareWith: e.target.value })} />
        </div>
        <div className="nc-perm-row" role="group" aria-label={t("What they may do")}>
          {permissionBits.map(([bit, label]) => (
            <button
              type="button"
              key={bit}
              aria-pressed={form[bit === 1 ? "read" : bit === 2 ? "update" : bit === 4 ? "create" : bit === 8 ? "del" : "share"]}
              className={`nc-chip${form[bit === 1 ? "read" : bit === 2 ? "update" : bit === 4 ? "create" : bit === 8 ? "del" : "share"] ? " nc-chip-on" : ""}`}
              onClick={() => toggleBit(bit === 1 ? "read" : bit === 2 ? "update" : bit === 4 ? "create" : bit === 8 ? "del" : "share")}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || form.shareWith.trim() === "" || permissionValue() === 0}>
          {t("Share")}
        </button>
      </form>

      <form
        className="nc-form"
        onSubmit={(e) => {
          e.preventDefault();
          void makeLink();
        }}
      >
        <p className="nc-form-title">{t("A public download link")}</p>
        <div className="flex gap-1">
          <input className={portal.ui.classes.inputSmall} type="number" min={1} value={minutes} aria-label={t("How long, in minutes")} onChange={(e) => setMinutes(e.target.value)} />
          <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy}>
            {t("Make the link")}
          </button>
        </div>
        {linkResult !== null && (
          <p className="nc-form-result">
            <a href={linkResult.url} target="_blank" rel="noreferrer">{linkResult.url}</a>
            <button type="button" className={portal.ui.classes.ghost} onClick={() => void portal.ui.copyText(linkResult.url)}>
              {t("Copy the link")}
            </button>
            {linkResult.downloadUrl !== undefined && <span className="block text-fg-subtle">{linkResult.downloadUrl}</span>}
          </p>
        )}
      </form>

      {problem !== null && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>}
    </div>
  );
}

/** The box that opens under one entry of the tree for what it can be done to: moved (or renamed, which is a move
 * by another word), copied, or taken away. It calls the same tools on the server and tells its list to look again.
 * A move onto what already stands there fails closed; that is how it is meant. */
function ActionsBox({
  entry,
  instance,
  onChanged,
  onClose,
}: {
  entry: FileRow;
  instance?: string;
  onChanged(): void;
  onClose(): void;
}) {
  portal.locale.use();
  const [moveTarget, setMoveTarget] = useState(entry.path);
  const [copyTarget, setCopyTarget] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const move = async () => {
    const to = moveTarget.trim().replace(/^\/+/, "");
    if (busy || to === "" || to === entry.path) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_webdav_move_resource", { source_path: entry.path, destination_path: to }, instance);
      onChanged();
      onClose();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    const to = copyTarget.trim().replace(/^\/+/, "");
    if (busy || to === "") return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_webdav_copy_resource", { source_path: entry.path, destination_path: to }, instance);
      setCopyTarget("");
      onChanged();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteEntry = async () => {
    if (busy) return;
    if (!(await confirmDelete(t("Take {name} to the trash?", { name: entry.name }), undefined, t("Take it to the trash")))) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.tool("nc_webdav_delete_resource", { path: entry.path }, instance);
      onChanged();
      onClose(); // the box closes last: the entry is gone, and nothing reopens a box on its path
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nc-sharebox">
      <div className="flex items-center gap-1">
        <LuEllipsis className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{t("What it can be done to")}</span>
        <button type="button" className={portal.ui.classes.ghost} onClick={onClose} aria-label={t("Close this box")}>
          ×
        </button>
      </div>

      <form
        className="nc-form"
        onSubmit={(e) => {
          e.preventDefault();
          void move();
        }}
      >
        <p className="nc-form-title">{t("Move or rename")}</p>
        <input className={portal.ui.classes.input} value={moveTarget} placeholder={entry.path} aria-label={t("The new path")} onChange={(e) => setMoveTarget(e.target.value)} />
        <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || moveTarget.trim() === "" || moveTarget.trim().replace(/^\/+/, "") === entry.path}>
          {t("Move")}
        </button>
      </form>

      <form
        className="nc-form"
        onSubmit={(e) => {
          e.preventDefault();
          void copy();
        }}
      >
        <p className="nc-form-title">{t("Copy")}</p>
        <input className={portal.ui.classes.input} value={copyTarget} placeholder={t("Where the copy goes")} aria-label={t("Where the copy goes")} onChange={(e) => setCopyTarget(e.target.value)} />
        <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || copyTarget.trim() === ""}>
          {t("Copy")}
        </button>
      </form>

      <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void deleteEntry()}>
        {t("Take it to the trash")}
      </button>

      {problem !== null && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>}
    </div>
  );
}
