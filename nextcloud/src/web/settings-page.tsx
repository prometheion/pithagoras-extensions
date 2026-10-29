import { useCallback, useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, sayError, NextcloudStatus, InstanceView, DiscoveredContainer } from "./api";

/** The page in Settings: the instances (name, host, login, app password, keep-out list, and where each one's /mcp
 * endpoint lives -- a container this extension made, or one it adopted by name), a save per instance that brings its
 * container and its entry in pi's config to what the fields say, and how all stands per instance. The passwords are
 * only ever set, never shown back; an adopted container is never made again, pulled or removed by this extension. */

/** A field of one card: what the server says of the instance beside what the person has not saved yet. */
type Draft = InstanceView & { password: string; exists: boolean };

const blankDraft = (): Draft => ({ name: "", url: "", username: "", mcpExcludeTools: "", passwordSet: false, configured: false, container: "own", password: "", exists: false });

export default function NextcloudSettings() {
  portal.locale.use();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [status, setStatus] = useState<NextcloudStatus | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredContainer[] | null>(null);
  const [discoverNote, setDiscoverNote] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loadInstances = useCallback((passwords: Map<string, string>) => {
    void api
      .instances()
      .then((r) =>
        setDrafts(r.instances.map((view) => ({ ...view, password: passwords.get(view.name) ?? "", exists: true }))),
      )
      .catch(() => {});
  }, []);

  const refresh = useCallback(() => {
    void api.status().then(setStatus).catch(() => {});
  }, []);

  const refreshDiscovery = useCallback(() => {
    void api
      .discover()
      .then((r) => {
        setDiscovered(r.containers);
        setDiscoverNote(r.note);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadInstances(new Map());
    refresh();
    refreshDiscovery();
  }, [loadInstances, refresh, refreshDiscovery]);

  // While a save is bringing things to where they should stand, the status moves: watch it until it does not.
  const task = status?.task;
  useEffect(() => {
    if (!task) return;
    const timer = window.setInterval(() => void api.status().then(setStatus).catch(() => {}), 2000);
    return () => window.clearInterval(timer);
  }, [task]);

  /** What the server answered with for every instance back into the cards: the saved ones as they stand, the not-saved
   * fields of a card keep what they held (a password that went in clears its field). */
  const takeAnswered = (instances: InstanceView[], clearedPasswordOf?: string) => {
    setDrafts((was) =>
      instances.map((view) => {
        const before = was?.find((d) => d.name === view.name && d.exists);
        return { ...view, password: view.name === clearedPasswordOf ? "" : (before?.password ?? ""), exists: true };
      }),
    );
  };

  const saveCard = async (card: Draft) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      const fields: Record<string, string> = {
        name: card.name.trim(),
        url: card.url.trim(),
        username: card.username.trim(),
        mcpExcludeTools: card.mcpExcludeTools.trim(),
        container: card.container,
      };
      if (card.password !== "") fields.password = card.password; // it is only set, never answered back
      const answered = await api.saveInstance(fields);
      takeAnswered(answered.instances, card.name.trim());
      refresh();
      refreshDiscovery();
      if (answered.task) setProblem(answered.task);
      else setSaved(true);
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const removeCard = async (card: Draft) => {
    if (busy || !card.exists) return;
    if (!window.confirm(t("Remove the instance {name}? Its own container, where it has one, goes with it; an adopted one stays running.", { name: card.name }))) return;
    setBusy(true);
    setProblem(null);
    try {
      const answered = await api.removeInstance(card.name);
      takeAnswered(answered.instances);
      refresh();
      refreshDiscovery();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const startAgain = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      setStatus(await api.start());
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const removeEverything = async () => {
    if (busy) return;
    if (!window.confirm(t("Remove the containers this extension made and its entries in pi's config? The settings stay, and an adopted container keeps running where it ran."))) return;
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

  if (drafts === null) return <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />;

  return (
    <div className="mx-auto max-w-xl space-y-4 p-4">
      <p className="text-sm text-fg-muted">
        {t("This extension runs the Nextcloud MCP server for each of its instances -- in a container it made and keeps, or one already running that it adopted by name -- and registers every instance in pi's config for the chats. Each instance needs a host and an app password.")}
      </p>

      {problem && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>}
      {saved && !problem && <p className="text-xs text-fg-muted">{t("Saved.")}</p>}

      {drafts.length === 0 && (
        <p className="rounded border border-dashed p-3 text-sm text-fg-muted">{t("No instance yet: add your first Nextcloud below.")}</p>
      )}

      {drafts.map((card, index) => (
        <InstanceCard key={card.name || `new-${index}`} card={card} busy={busy} drafts={drafts} save={(e) => { e.preventDefault(); void saveCard(card); }} remove={() => void removeCard(card)} onChange={(patch) => setDrafts((was) => was?.map((d, i) => (i === index ? { ...d, ...patch } : d)) ?? [])} status={status?.instances.find((i) => i.name === card.name.trim())} discovered={discovered} discoverNote={discoverNote} />
      ))}

      <div className="flex gap-2">
        <button type="button" className={portal.ui.classes.button} disabled={busy || drafts.every((d) => !d.exists)} onClick={() => setDrafts((was) => (was ?? []).concat(blankDraft()))}>
          {t("Add an instance")}
        </button>
        <button type="button" className={portal.ui.classes.button} disabled={busy || !status?.configured} onClick={() => void startAgain()}>
          {t("Start again")}
        </button>
        <span className="flex-1" />
        <button type="button" className={portal.ui.classes.ghost} disabled={busy || drafts.length === 0} onClick={() => void removeEverything()}>
          {t("Remove everything")}
        </button>
      </div>

      {(status?.error || status?.task) && (
        <section className="space-y-1 text-sm">
          <h3 className="font-medium">{t("Status")}</h3>
          {status.task && <p className="text-xs text-fg-muted">{t("Working: {task}", { task: status.task })}</p>}
          {status.error && <portal.ui.ErrorBanner onClose={() => {}}>{status.error}</portal.ui.ErrorBanner>}
        </section>
      )}
    </div>
  );
}

/** One card of one instance: its fields, what its container and its entry in pi's config say of it, and a save that
 * brings both to where the fields ask for them. */
function InstanceCard({ card, busy, drafts, save, remove, onChange, status, discovered, discoverNote }: { card: Draft; busy: boolean; drafts: Draft[]; save(e: React.FormEvent): void; remove(): void; onChange(patch: Partial<Draft>): void; status?: { mode: string; containerName: string; state: string; mcp: { registered: boolean; on: boolean; url?: string }; health: { ok: boolean; server?: { name: string; version: string }; error?: string } }; discovered: DiscoveredContainer[] | null; discoverNote?: string }) {
  portal.locale.use();
  const name = card.name.trim();
  const nameOk = /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) && name.length <= 48;
  const nameTakenByAnother = name !== "" && drafts.some((d) => d !== card && d.name.trim() === name);
  const adopted = card.container.startsWith("adopted:");
  return (
    <form onSubmit={save} className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="block text-sm flex-1">
          <span className="mb-1 block font-medium">{t("Name")}</span>
          <input className={portal.ui.classes.input} value={card.name} placeholder={t("e.g. nextcloud_uni")} disabled={busy || card.exists} onChange={(e) => onChange({ name: e.target.value })} />
        </label>
        <div className="flex flex-col items-end justify-end gap-1 pb-1">
          <span className={`text-xs ${adopted ? "text-fg-muted" : "text-fg-subtle"}`}>{adopted ? t("adopted container") : t("own container")}</span>
          {card.exists && (
            <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={remove}>
              {t("Remove")}
            </button>
          )}
        </div>
      </div>
      {!nameOk && name !== "" && (
        <p className="text-xs text-fg-muted">{t("Letters, numbers, dashes and underscores; it must start with a letter.")}</p>
      )}
      {nameTakenByAnother && <p className="text-xs text-fg-muted">{t("Another instance carries this name already.")}</p>}

      <label className="block text-sm">
        <span className="mb-1 block font-medium">{t("Nextcloud host")}</span>
        <input className={portal.ui.classes.input} value={card.url} placeholder="https://cloud.example.org" disabled={busy} onChange={(e) => onChange({ url: e.target.value })} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">{t("Username")}</span>
        <input className={portal.ui.classes.input} value={card.username} autoComplete="username" disabled={busy} onChange={(e) => onChange({ username: e.target.value })} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">{t("App password")}</span>
        <input className={portal.ui.classes.input} type="password" value={card.password} autoComplete="new-password" placeholder={card.passwordSet ? t("(set -- leave empty to keep it)") : t("(not set yet)")} disabled={busy} onChange={(e) => onChange({ password: e.target.value })} />
        <span className="mt-1 block text-xs text-fg-subtle">{t("Made in Nextcloud under Settings, Security, Devices & sessions. It is only ever set, never shown back.")}</span>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">{t("Tools the chats must not get from this server")}</span>
        <input className={portal.ui.classes.input} value={card.mcpExcludeTools} placeholder={t("empty: take the default keep-out list")} disabled={busy} onChange={(e) => onChange({ mcpExcludeTools: e.target.value })} />
        <span className="mt-1 block text-xs text-fg-subtle">{name !== "" && nameOk ? t("Tool-name globs, comma-separated; this server's tools carry the prefix {name}_.", { name }) : t("Tool-name globs, comma-separated.")}</span>
      </label>

      <div className="block text-sm">
        <span className="mb-1 block font-medium">{t("Where its /mcp endpoint runs")}</span>
        <select className={portal.ui.classes.input} value={card.container} disabled={busy || discovered === null} onChange={(e) => onChange({ container: e.target.value })}>
          <option value="own">{t("Make a new container and keep it")}</option>
          {(discovered ?? []).map((c) => {
            const takenByAnother = c.takenBy !== undefined && c.takenBy !== name;
            return (
              <option key={c.name} value={`adopted:${c.name}`} disabled={takenByAnother}>
                `${c.name} · ${c.status}${c.endpoint ? ` · ${c.endpoint.replace(/^http:\/\//, "").replace(/\/mcp$/, "")}` : ""}${takenByAnother ? ` (${c.takenBy})` : ""}`
              </option>
            );
          })}
        </select>
        {adopted && <span className="mt-1 block text-xs text-fg-subtle">{t("An adopted container is never made again, pulled or removed by this extension; it only says where it runs.")}</span>}
        {discovered !== null && discovered.length === 0 && !discoverNote && (
          <span className="mt-1 block text-xs text-fg-subtle">{t("No container of this image was found on this machine right now.")}</span>
        )}
        {discoverNote && <span className="mt-1 block text-xs text-fg-subtle">{discoverNote}</span>}
      </div>

      {status && (
        <div className="space-y-1">
          <StatusLine label={t("Container")} value={status.state} detail={`${status.mode === "adopted" ? t("adopted") : t("own")} · ${status.containerName}`} />
          <StatusLine label={t("MCP entry in pi's config")} value={status.mcp.registered ? t("present") : t("absent")} detail={status.mcp.url ?? ""} />
          <StatusLine label={t("Server at /mcp")} value={status.health.ok ? t("answering") : t("not answering")} detail={status.health.ok && status.health.server ? `${status.health.server.name} ${status.health.server.version}` : (status.health.error ?? "")} />
        </div>
      )}

      <div className="flex gap-2">
        <button type="submit" className={portal.ui.classes.primary} disabled={busy || !nameOk || nameTakenByAnother}>
          {t("Save and apply")}
        </button>
      </div>
    </form>
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
