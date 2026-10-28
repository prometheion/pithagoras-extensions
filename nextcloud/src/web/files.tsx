import { useEffect, useState } from "react";
import { LuChevronRight, LuDownload, LuExternalLink, LuFileText, LuFolder } from "react-icons/lu";
import { portal, t } from "../portal";
import { api, partText, sayError } from "./api";
import { SubTabs } from "./widgets";

/** The Files & Sharing tab: its files view walks the WebDAV tree from the root down -- a folder is opened by
 * choosing it, a readable file (text, a common image, a PDF as the server's extracted text) is read into this
 * panel, and everything else is only downloaded; and its shares view lists who has what and what they may do with
 * it, adds a share, takes one away, and makes a short public download link. All of it as a tool call on the server. */

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

export default function FilesAndSharing() {
  portal.locale.use();
  const [view, setView] = useState<"files" | "shares">("files");

  // the files view: where it stands, what it shows, and one file read into the panel
  const [path, setPath] = useState("");
  const [rows, setRows] = useState<FileRow[] | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);

  // the shares view: the list and what it is shown of (mine or others'), plus the forms that change it
  const [shares, setShares] = useState<ShareRow[] | null>(null);
  const [shareProblem, setShareProblem] = useState<string | null>(null);
  const [sharedWithMe, setSharedWithMe] = useState(false);
  const [form, setForm] = useState({ path: "", shareWith: "", shareType: 0, read: true, update: false, create: false, del: false, share: false });
  const [linkPath, setLinkPath] = useState("");
  const [linkMinutes, setLinkMinutes] = useState("30");
  const [linkResult, setLinkResult] = useState<{ url: string; downloadUrl?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- the files view ------------------------------------------------------

  const loadListing = (at: string) => {
    setRows(null);
    setFileProblem(null);
    void api
      .tool("nc_webdav_list_directory", at === "" ? {} : { path: at })
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

  useEffect(() => {
    loadListing("");
  }, []);

  const download = async (row: FileRow): Promise<void> => {
    if (row.size !== undefined && row.size > MAX_INLINE_BYTES) throw new Error(t("This file is larger than this panel reads inline."));
    const result = await api.tool("nc_webdav_read_file", { path: row.path, parse_document: "raw" });
    const data = partText(result).data;
    const b64 = typeof data === "object" && data !== null ? strOf((data as Rec).content) : undefined;
    if (b64 === undefined) throw new Error(t("The file did not answer in a way this panel reads."));
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
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
        const result = await api.tool("nc_webdav_read_file", { path: row.path });
        const data = partText(result).data;
        const body = typeof data === "object" && data !== null ? strOf((data as Rec).content) ?? "" : "";
        setPreview({ row, kind: "pdf", body });
      } else if (isImage(ct)) {
        const result = await api.tool("nc_webdav_read_file", { path: row.path, parse_document: "raw" });
        const data = partText(result).data;
        const b64 = typeof data === "object" && data !== null ? strOf((data as Rec).content) : undefined;
        if (b64 === undefined) throw new Error(t("The file did not answer in a way this panel reads."));
        setPreview({ row, kind: "image", dataUrl: `data:${ct};base64,${b64}` });
      } else {
        const result = await api.tool("nc_webdav_read_file", { path: row.path });
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

  const crumbs = path === "" ? [] : path.split("/");
  const shareTypes: [number, string][] = [
    [0, t("User")],
    [1, t("Group")],
    [4, t("E-Mail address")],
  ];
  const knownShareTypes = new Map<number, string>([
    [0, t("User")],
    [1, t("Group")],
    [3, t("Public link")],
    [4, t("E-Mail address")],
    [6, t("Federated (ownCloud)")],
    [7, t("Circle")],
    [10, t("Talk conversation")],
    [12, t("Deck card")],
  ]);

  // ---- the shares view -----------------------------------------------------

  const loadShares = () => {
    setShares(null);
    setShareProblem(null);
    void api
      .tool("nc_share_list", sharedWithMe ? { shared_with_me: true } : {})
      .then((result) => {
        const data = partText(result).data;
        let list: unknown = data;
        if (typeof data === "object" && data !== null && Array.isArray((data as Rec).shares)) list = (data as Rec).shares;
        const mapped: ShareRow[] = Array.isArray(list)
          ? list.map((s) => {
              const r = s as Rec;
              return {
                id: Number(r.id ?? 0),
                shareType: numOf(r.share_type ?? r.shareType) ?? -1,
                withName: strOf(r.share_with_display_name ?? r.shareWithDisplayName) ?? strOf(r.share_with ?? r.shareWith) ?? "",
                target: strOf(r.path ?? r.file_target) ?? "",
                permission: numOf(r.permission) ?? 0,
                expires: strOf(r.expiration),
              };
            })
          : [];
        mapped.sort((a, b) => a.target.localeCompare(b.target));
        setShares(mapped);
      })
      .catch((error) => setShareProblem(sayError(error)));
  };

  useEffect(() => {
    if (view === "shares") loadShares();
  }, [view]);

  const permissionValue = (): number =>
    (form.read ? 1 : 0) | (form.update ? 2 : 0) | (form.create ? 4 : 0) | (form.del ? 8 : 0) | (form.share ? 16 : 0);

  const addShare = async () => {
    const at = form.path.trim();
    const with_ = form.shareWith.trim();
    if (busy || at === "" || with_ === "") return;
    setBusy(true);
    setShareProblem(null);
    try {
      await api.tool("nc_share_create", { path: at, share_with: with_, share_type: form.shareType, permissions: permissionValue() });
      setForm({ ...form, path: "", shareWith: "" });
      loadShares();
    } catch (error) {
      setShareProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const removeShare = async (id: number) => {
    if (busy) return;
    if (!window.confirm(t("Take this share away?"))) return;
    setBusy(true);
    setShareProblem(null);
    try {
      await api.tool("nc_share_delete", { share_id: id });
      loadShares();
    } catch (error) {
      setShareProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const makeLink = async () => {
    const at = linkPath.trim();
    if (busy || at === "") return;
    setBusy(true);
    setShareProblem(null);
    setLinkResult(null);
    try {
      const result = await api.tool("nc_share_create_public_link", { path: at, expires_in_minutes: Number(linkMinutes) > 0 ? Number(linkMinutes) : 30 });
      const data = partText(result).data;
      if (typeof data === "object" && data !== null && typeof (data as Rec).url === "string") {
        setLinkResult({ url: (data as Rec).url as string, downloadUrl: strOf((data as Rec).download_url) });
        setLinkPath("");
      } else {
        setShareProblem(t("The link did not answer in a way this panel reads."));
      }
    } catch (error) {
      setShareProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const permissionBits: [number, string][] = [
    [1, t("read")],
    [2, t("update")],
    [4, t("create")],
    [8, t("delete")],
    [16, t("share")],
  ];

  // ---- what is drawn -------------------------------------------------------

  return (
    <div className="space-y-2">
      <SubTabs
        tabs={[
          { id: "files", label: t("Files") },
          { id: "shares", label: t("Shares") },
        ]}
        active={view}
        onChange={(id) => setView(id as "files" | "shares")}
      />

      {view === "files" && (
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
          ) : (
            <>
              <div className="nc-crumbs" aria-label={t("Where you are")}>
                <button type="button" onClick={() => { setPreview(null); setPath(""); }}>{t("Files")}</button>
                {crumbs.map((segment, i) => (
                  <span key={i} className="inline-flex items-center gap-0.5">
                    <LuChevronRight size={11} className="text-fg-subtle" />
                    <button type="button" onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>
                      {segment}
                    </button>
                  </span>
                ))}
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
                  {rows.map((row) => (
                    <li key={row.path}>
                      <button type="button" className="nc-file" disabled={previewBusy} onClick={() => void open(row)} title={row.directory ? row.name : t("Open or download this file")}>
                        {row.directory ? <LuFolder className="shrink-0" /> : <LuFileText className="shrink-0" />}
                        <span className="nc-file-name">{row.name}</span>
                        {!row.directory && row.size !== undefined && <span className="nc-file-size">{formatBytes(row.size)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {previewProblem !== null && rows !== null && (
                <div className="flex items-start gap-1">
                  <span className="mt-1 shrink-0 text-fg-muted"><LuDownload /></span>
                  <portal.ui.ErrorBanner onClose={() => setPreviewProblem(null)}>{previewProblem}</portal.ui.ErrorBanner>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {view === "shares" && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <SubTabs
              tabs={[
                { id: "mine", label: t("My shares") },
                { id: "withme", label: t("Shared with me") },
              ]}
              active={sharedWithMe ? "withme" : "mine"}
              onChange={(id) => setSharedWithMe(id === "withme")}
            />
          </div>

          {shares === null ? (
            shareProblem !== null ? (
              <portal.ui.ErrorBanner onClose={() => setShareProblem(null)}>{t("The shares could not be read: {error}", { error: shareProblem })}</portal.ui.ErrorBanner>
            ) : (
              <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
            )
          ) : shares.length === 0 ? (
            <portal.ui.Empty>{sharedWithMe ? t("Nothing is shared with you.") : t("No shares yet.")}</portal.ui.Empty>
          ) : (
            <ul className="space-y-1">
              {shares.map((share) => (
                <li key={share.id} className="nc-share">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm">{share.withName || t("Unknown share")}</span>
                    <span className="nc-chip">{knownShareTypes.get(share.shareType) ?? share.shareType}</span>
                  </div>
                  {share.target !== "" && <p className="min-w-0 truncate pl-1 text-xs text-fg-subtle" title={share.target}>{share.target}</p>}
                  <div className="flex flex-wrap items-center gap-1 pl-1">
                    {permissionBits.filter(([bit]) => (share.permission & bit) !== 0).map(([_, label]) => (
                      <span key={label} className="nc-chip">{label}</span>
                    ))}
                    {share.expires !== undefined && <span className="nc-chip nc-chip-dim">{share.expires}</span>}
                    {!sharedWithMe && (
                      <button type="button" className={`${portal.ui.classes.ghost} ml-auto`} disabled={busy} onClick={() => void removeShare(share.id)} aria-label={t("Take this share away")}>
                        ×
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {form.shareType === 3 ? null : (
            <form
              className="nc-form"
              onSubmit={(e) => {
                e.preventDefault();
                void addShare();
              }}
            >
              <p className="nc-form-title">{t("Add a share")}</p>
              <input className={portal.ui.classes.input} value={form.path} placeholder={t("Path, e.g. docs/invite.pdf")} aria-label={t("Path of the file or folder")} onChange={(e) => setForm({ ...form, path: e.target.value })} />
              <div className="flex gap-1">
                <select className={portal.ui.classes.inputSmall} value={form.shareType} aria-label={t("Shared with")} onChange={(e) => setForm({ ...form, shareType: Number(e.target.value), shareWith: "" })}>
                  {shareTypes.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <input className={portal.ui.classes.input} value={form.shareWith} placeholder={t("The name of it")} aria-label={t("The name of the user, group or address")} onChange={(e) => setForm({ ...form, shareWith: e.target.value })} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {permissionBits.map(([bit, label]) => (
                  <label key={bit} className="inline-flex items-center gap-1">
                    <input type="checkbox" checked={Boolean(form[bit === 1 ? "read" : bit === 2 ? "update" : bit === 4 ? "create" : bit === 8 ? "del" : "share"])} onChange={(e) => setForm({ ...form, [bit === 1 ? "read" : bit === 2 ? "update" : bit === 4 ? "create" : bit === 8 ? "del" : "share"]: e.target.checked })} />
                    {label}
                  </label>
                ))}
              </div>
              <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || form.path.trim() === "" || form.shareWith.trim() === "" || permissionValue() === 0}>
                {t("Share")}
              </button>
            </form>
          )}

          <form
            className="nc-form"
            onSubmit={(e) => {
              e.preventDefault();
              void makeLink();
            }}
          >
            <p className="nc-form-title">{t("A public download link")}</p>
            <div className="flex gap-1">
              <input className={portal.ui.classes.input} value={linkPath} placeholder={t("Path of the file or folder")} aria-label={t("Path of the file or folder")} onChange={(e) => setLinkPath(e.target.value)} />
              <input className={portal.ui.classes.inputSmall} type="number" min={1} value={linkMinutes} aria-label={t("How long, in minutes")} onChange={(e) => setLinkMinutes(e.target.value)} />
            </div>
            <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || linkPath.trim() === ""}>
              {t("Make the link")}
            </button>
            {linkResult !== null && (
              <p className="nc-form-result">
                <a href={linkResult.url} target="_blank" rel="noreferrer">{linkResult.url}</a>
                {linkResult.downloadUrl !== undefined && <span className="block text-fg-subtle">{linkResult.downloadUrl}</span>}
              </p>
            )}
          </form>

          {shareProblem !== null && shares !== null && <portal.ui.ErrorBanner onClose={() => setShareProblem(null)}>{shareProblem}</portal.ui.ErrorBanner>}
        </div>
      )}
    </div>
  );
}
