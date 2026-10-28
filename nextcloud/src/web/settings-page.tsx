import { useCallback, useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, sayError, NextcloudStatus, NextcloudSettingsView } from "./api";

/** The page in Settings: the keys (host, login, app password, keep-out list), a save that brings the container and
 * its entry in pi's config to them, and how all stands -- the container's state, the entry, the server answering or
 * not, and what a save is doing on the person's behalf right now. The password is only ever set, never shown back. */

export default function NextcloudSettings() {
  portal.locale.use();
  const [view, setView] = useState<NextcloudSettingsView | null>(null);
  const [password, setPassword] = useState("");
  const [excludeTools, setExcludeTools] = useState<string | null>(null);
  // A draft of the keep-out list, stood up from what is saved when it first shows; a cleared line means "take the default".
  useEffect(() => {
    if (view !== null && excludeTools === null) setExcludeTools(view.mcpExcludeTools);
  }, [view, excludeTools]);
  const [status, setStatus] = useState<NextcloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(() => {
    void api.settings().then(setView).catch(() => {});
    void api.status().then(setStatus).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  // While a save is bringing things to where they should stand, the status moves: watch it until it does not.
  const task = status?.task;
  useEffect(() => {
    if (!task) return;
    const timer = window.setInterval(() => void api.status().then(setStatus).catch(() => {}), 2000);
    return () => window.clearInterval(timer);
  }, [task]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || view === null) return;
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      const patch: Record<string, string> = { url: view.url.trim(), username: view.username.trim(), mcpExcludeTools: excludeTools !== null ? excludeTools.trim() : view.mcpExcludeTools.trim() };
      if (password !== "") patch.password = password;
      const answered = await api.saveSettings(patch);
      setView({ url: answered.url, username: answered.username, mcpExcludeTools: answered.mcpExcludeTools, configured: answered.configured });
      setPassword(""); // it is set now; nothing to offer again
      if (answered.task) setProblem(answered.task);
      else setSaved(true);
      refresh();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      setStatus(await api.start());
      refresh();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (busy) return;
    if (!window.confirm(t("Remove the container and its entry in pi's config? The settings stay."))) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.reset();
      refresh();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  if (view === null) return <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />;

  const configured = view.configured;
  return (
    <div className="mx-auto max-w-xl space-y-4 p-4">
      <p className="text-sm text-fg-muted">{t("This extension runs the Nextcloud MCP server in its own container and registers it in pi's config for the chats. It needs a host and an app password of yours.")}</p>

      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t("Nextcloud host")}</span>
          <input className={portal.ui.classes.input} value={view.url} placeholder="https://cloud.example.org" onChange={(e) => setView({ ...view, url: e.target.value })} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t("Username")}</span>
          <input className={portal.ui.classes.input} value={view.username} autoComplete="username" onChange={(e) => setView({ ...view, username: e.target.value })} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t("App password")}</span>
          <input className={portal.ui.classes.input} type="password" value={password} autoComplete="new-password" placeholder={view.passwordSet ? t("(set -- leave empty to keep it)") : t("(not set yet)")} onChange={(e) => setPassword(e.target.value)} />
          <span className="mt-1 block text-xs text-fg-subtle">{t("Made in Nextcloud under Settings, Security, Devices & sessions. It is only ever set, never shown back.")}</span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t("Tools the chats must not get from this server")}</span>
          <input className={portal.ui.classes.input} value={excludeTools ?? ""} placeholder={t("empty: take the default keep-out list")} onChange={(e) => setExcludeTools(e.target.value)} />
          <span className="mt-1 block text-xs text-fg-subtle">{t("Tool-name globs, comma-separated; this server's tools carry the prefix nextcloud_.")}</span>
        </label>

        {problem && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>}
        {saved && !problem && <p className="text-xs text-fg-muted">{t("Saved.")}</p>}

        <div className="flex gap-2">
          <button type="submit" className={portal.ui.classes.primary} disabled={busy || (view.url.trim() === "" && view.username.trim() === "")}>
            {t("Save and apply")}
          </button>
          <button type="button" className={portal.ui.classes.button} disabled={busy || !configured} onClick={() => void start()}>
            {t("Start again")}
          </button>
          <span className="flex-1" />
          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={() => void reset()}>
            {t("Remove")}
          </button>
        </div>
      </form>

      <section className="space-y-1 text-sm">
        <h3 className="font-medium">{t("Status")}</h3>
        {status === null ? (
          <p className="text-xs text-fg-subtle">{t("Loading…")}</p>
        ) : (
          <>
            <StatusLine label={t("Container")} value={status.state} detail={`${status.container} · ${status.image}`} />
            <StatusLine label={t("MCP entry in pi's config")} value={status.mcp.registered ? t("present") : t("absent")} detail={status.mcp.url ?? ""} />
            <StatusLine label={t("Server at /mcp")} value={status.health.ok ? t("answering") : t("not answering")} detail={status.health.ok && status.health.server ? `${status.health.server.name} ${status.health.server.version}` : (status.health.error ?? "")} />
            {status.task && <p className="text-xs text-fg-muted">{t("Working: {task}", { task: status.task })}</p>}
            {status.error && <portal.ui.ErrorBanner onClose={() => {}}>{status.error}</portal.ui.ErrorBanner>}
          </>
        )}
      </section>
    </div>
  );
}

/** One line of the status: its name, how it stands, and what else there is to say. */
function StatusLine({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <p className="text-xs text-fg-muted">
      <span className="font-medium text-fg">{label}:</span> {value}
      {detail && detail !== "" && <span> · {detail}</span>}
    </p>
  );
}
