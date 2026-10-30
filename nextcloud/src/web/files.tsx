import { useEffect, useState } from "react";
import { LuChevronRight, LuExternalLink, LuFileText, LuFolder, LuShare2, LuUsers } from "react-icons/lu";
import { portal, t } from "../portal";
import { api, partText, sayError, useNextcloudInstance } from "./api";

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
  [0, "User"],
  [1, "Group"],
  [3, "Public link"],
  [4, "E-Mail address"],
  [6, "Federated (ownCloud)"],
  [7, "Circle"],
  [10, "Talk conversation"],
  [12, "Deck card"],
]);

const shareTypes: [number, string][] = [
  [0, "User"],
  [1, "Group"],
  [4, "E-Mail address"],
];

const permissionBits: [number, string][] = [
  [1, "read"],
  [2, "update"],
  [4, "create"],
  [8, "delete"],
  [16, "share"],
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

  // ---- the tree --------------------------------------------------------------

  const loadListing = (at: string) => {
    setRows(null);
    setFileProblem(null);
    void api
      .tool("nc_webdav_list_directory", at === "" ? {} : { path: at }, instance)
      .then((result) => {
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
      .catch((error) => setFileProblem(sayError(error)));
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
    void api
      .tool("nc_share_list", {}, instance)
      .then((result) => setAllShares(mapShares(partText(result).data)))
      .catch((error) => setShareProblem(sayError(error)));
  };

  useEffect(() => {
    loadShareIndex();
  }, []);

  const loadWithMe = () => {
    setWithMeShares(null);
    void api
      .tool("nc_share_list", { shared_with_me: true }, instance)
      .then((result) => {
        const mapped = mapShares(partText(result).data);
        mapped.sort((a, b) => a.target.localeCompare(b.target));
        setWithMeShares(mapped);
      })
      .catch((error) => setShareProblem(sayError(error)));
  };

  useEffect(() => {
    if (withMe) loadWithMe();
  }, [withMe]);

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
          <div className="nc-crumbs" aria-label={t("Where you are")}>
            <button type="button" onClick={() => { setWithMe(false); }}>{t("Files")}</button>
            <LuChevronRight size={11} className="text-fg-subtle" />
            <span className="truncate">{t("Shared with me")}</span>
          </div>
          {withMeShares === null ? (
            shareProblem !== null ? (
              <portal.ui.ErrorBanner onClose={() => setShareProblem(null)}>{t("The shares could not be read: {error}", { error: shareProblem })}</portal.ui.ErrorBanner>
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
                    <span className="nc-chip nc-chip-dim shrink-0">{t(knownShareTypes.get(share.shareType) ?? "Public link")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          {/* The path and the Shared-with-me entry stand on their own lines: a long path must not push
              the chip to a second row and leave a gap under it. */}
          <div className="nc-files-head">
            <div className="nc-crumbs" aria-label={t("Where you are")}>
              <button type="button" onClick={() => { setPath(""); }}>{t("Files")}</button>
              {crumbs.map((segment, i) => (
                <span key={i} className="inline-flex min-w-0 items-center gap-0.5">
                  <LuChevronRight size={11} className="text-fg-subtle" />
                  <button type="button" onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>
                    {segment}
                  </button>
                </span>
              ))}
            </div>
            <div>
              <button type="button" className={`nc-tab${withMe ? " nc-tab-on" : ""}`} onClick={() => setWithMe(true)} title={t("What others hold on you")}>
                <LuUsers />
                <span>{t("Shared with me")}</span>
              </button>
            </div>
          </div>
          {rows === null ? (
            fileProblem !== null ? (
              <portal.ui.ErrorBanner onClose={() => setFileProblem(null)}>{t("The files could not be read: {error}", { error: fileProblem })}</portal.ui.ErrorBanner>
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
                      <button
                        type="button"
                        className={`nc-row-share${shares.length > 0 ? " is-shared" : ""}`}
                        title={shares.length > 0 ? t("What is shared at this one") : t("Share this one")}
                        aria-label={t("Shares of this one")}
                        onClick={() => setBoxFor(boxFor === row.path ? null : row.path)}
                      >
                        <LuShare2 />
                      </button>
                    </div>
                    {boxFor === row.path && (
                      <SharingBox
                        entryPath={row.path}
                        shares={shares}
                        instance={instance}
                        onChanged={() => {
                          setBoxFor(row.path); // a fresh box on the same path, so its lists and forms look again
                          loadShareIndex();
                        }}
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
    if (!window.confirm(t("Take this share away?"))) return;
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
              <span className="nc-chip nc-chip-dim shrink-0">{t(knownShareTypes.get(share.shareType) ?? "Public link")}</span>
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
            {linkResult.downloadUrl !== undefined && <span className="block text-fg-subtle">{linkResult.downloadUrl}</span>}
          </p>
        )}
      </form>

      {problem !== null && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>}
    </div>
  );
}
