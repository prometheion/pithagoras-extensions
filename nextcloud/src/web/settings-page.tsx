import { useCallback, useEffect, useState } from "react";
import { portal, t } from "../portal";
import { api, sayError, NextcloudStatus, InstanceView } from "./api";
import { Ask, AskState } from "./widgets";
import { isValidInstanceName } from "../instance-name";
import { CAPABILITIES } from "../capabilities";

/** The page in Settings: the instances -- picked one at a time from a switcher over their names, not stacked under
 * each other -- with the fields of the picked one (name, host, login, app password, the capability families on or
 * off per family and grey where its server does not provide them at all), a save that brings its container and its
 * entry in pi's config to what the fields say, and how all stands per instance. The passwords are only ever set,
 * never shown back; every instance keeps its own container -- the extension makes it and takes it away where the
 * instance went. */

/** A field of one card: what the server says of the instance beside what the person has not saved yet. */
type Draft = InstanceView & { password: string; exists: boolean };

const blankDraft = (): Draft => ({ name: "", url: "", username: "", capabilities: {}, passwordSet: false, configured: false, password: "", exists: false });

/** Where one draft stands in the switcher, by key: the saved ones by their name, the one not-saved card under its own. */
const keyOf = (d: Draft): string => (d.exists ? d.name : "new");

/** How an instance's line of standing shows as a dot, as in the office extension: green where it runs and answers
 * with its entry present, yellow while something of it is not yet there (no start yet, no entry, an entry kept off),
 * red where it failed or stops answering -- and grey where it simply stands stopped. */
type InstanceHealth = "ok" | "warn" | "bad" | "idle";
const DOT: Record<InstanceHealth, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-danger", idle: "bg-fg-subtle" };
const WORD: Record<InstanceHealth, string> = { ok: "text-ok", warn: "text-warn", bad: "text-danger", idle: "" };

function healthOf(s: { state: string; mcp: { registered: boolean; on: boolean }; health: { ok: boolean } }): InstanceHealth {
  const st = s.state ?? "";
  if (st === "running") {
    if (!s.health.ok) return "bad"; // it runs, yet nothing answers -- where it should work, it does not
    if (!s.mcp.registered || s.mcp.on === false) return "warn"; // it answers, but the chats are not reached
    return "ok";
  }
  if (st === "failed" || st === "dead") return "bad";
  if (st === "restarting" || st === "") return "warn";
  return "idle"; // created, exited or removed: stopped
}

export default function NextcloudSettings() {
  portal.locale.use();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [status, setStatus] = useState<NextcloudStatus | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // what is about to go away, where it happens -- the panel's own yes-and-no, no window of the browser
  const [ask, setAsk] = useState<AskState | null>(null);
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

  useEffect(() => {
    loadInstances(new Map());
    refresh();
  }, [loadInstances, refresh]);

  // The picked card stays the one it was where its key still stands -- a removed one gives its place to the first.
  const keys = (drafts ?? []).map(keyOf);
  useEffect(() => {
    if (drafts && drafts.length > 0 && !keys.includes(selected)) setSelected(keys[0]);
  }, [drafts, keys, selected]);

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
        const before = was?.find((d) => d.exists && d.name === view.name);
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
      const fields: Record<string, unknown> = {
        name: card.name.trim(),
        url: card.url.trim(),
        username: card.username.trim(),
        capabilities: card.capabilities ?? {}, // the choices as they stand in the card; the server keeps only what stands
      };
      if (card.password !== "") fields.password = card.password; // it is only set, never answered back
      const answered = await api.saveInstance(fields);
      takeAnswered(answered.instances, card.name.trim());
      setSelected(card.name.trim());
      refresh();
      if (answered.task) setProblem(answered.task);
      else setSaved(true);
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const removeCard = async (card: Draft, asked = false) => {
    if (busy || !card.exists) return;
    if (!asked) {
      setAsk({ text: t("Remove the instance {name}? Its container goes with it.", { name: card.name }), run() { void removeCard(card, true); } });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const answered = await api.removeInstance(card.name);
      takeAnswered(answered.instances);
      setSelected(""); // the picked key is gone: the effect takes the first
      refresh();
    } catch (error) {
      setProblem(sayError(error));
    } finally {
      setBusy(false);
    }
  };

  const addCard = () => {
    if (busy || drafts?.some((d) => !d.exists)) return; // one not-saved card at a time: it would have no name to stand under yet
    setDrafts((was) => (was ?? []).concat(blankDraft()));
    setSelected("new");
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

  const removeEverything = async (asked = false) => {
    if (busy) return;
    if (!asked) {
      setAsk({ text: t("Remove the containers this extension made and its entries in pi's config? The settings stay."), run() { void removeEverything(true); } });
      return;
    }
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

  if (drafts === null) return <portal.ui.RowsSkeleton rows={3} label={t("Loading…")} />;
  const held = drafts.find((d) => keyOf(d) === selected) ?? drafts[0];

  return (
    <div className="space-y-3 p-4">
      {ask !== null && <Ask ask={ask} onNo={() => setAsk(null)} />}
      {problem && <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>}
      {saved && !problem && <span className="text-xs text-fg-muted">{t("Saved.")}</span>}

      {drafts.length === 0 ? (
        <p className="rounded border border-dashed p-3 text-sm text-fg-muted">{t("No instance yet: add your first Nextcloud below.")}</p>
      ) : (
        <>
          {/* The instances by their names, picked one at a time from the portal's own select -- the same switcher
           * the panel beside the chats has. */}
          <div className="flex items-center gap-2">
            <portal.ui.Select
              value={keyOf(held)}
              onChange={(v) => setSelected(v)}
              disabled={busy}
              aria-label={t("Which instance is picked")}
              options={drafts.map((d) => ({
                value: keyOf(d),
                label: d.exists ? d.name : t("New instance"),
                hint: d.exists && d.url !== "" ? d.url : undefined,
              }))}
            />
            <button type="button" className={portal.ui.classes.ghost} disabled={busy || drafts.some((d) => !d.exists)} onClick={addCard}>
              {t("Add")}
            </button>
          </div>

          {held && (
            <InstanceCard
              card={held}
              busy={busy}
              drafts={drafts}
              save={(e) => { e.preventDefault(); void saveCard(held); }}
              remove={() => void removeCard(held)}
              onChange={(patch) => setDrafts((was) => was?.map((d) => (keyOf(d) === keyOf(held) ? { ...d, ...patch } : d)) ?? [])}
              status={status?.instances.find((i) => i.name === held.name.trim())}
            />
          )}
        </>
      )}

      {(status?.error || (status?.task && !problem)) && (
        <section className="space-y-1 text-xs">
          {status.task && (
            <p className="flex items-center gap-1.5 text-fg-muted">
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-warn" />
              {t("Working: {task}", { task: status.task })}
            </p>
          )}
          {status.error && <portal.ui.ErrorBanner onClose={() => {}}>{status.error}</portal.ui.ErrorBanner>}
        </section>
      )}

      {(drafts.some((d) => d.exists) || status?.configured) && (
        <div className="flex gap-2 border-t pt-3">
          <button type="button" className={portal.ui.classes.ghost} disabled={busy || !status?.configured} onClick={() => void startAgain()}>
            {t("Start again")}
          </button>
          <span className="flex-1" />
          <button type="button" className={portal.ui.classes.ghost} disabled={busy || drafts.length === 0} onClick={() => void removeEverything()}>
            {t("Remove everything")}
          </button>
        </div>
      )}
    </div>
  );
}

/** One card of one instance: its fields in a compact grid, what its container and its entry in pi's config say of
 * it in one line, and a save that brings both to where the fields ask for them. */
function InstanceCard({ card, busy, drafts, save, remove, onChange, status }: { card: Draft; busy: boolean; drafts: Draft[]; save(e: React.FormEvent): void; remove(): void; onChange(patch: Partial<Draft>): void; status?: { containerName: string; state: string; mcp: { registered: boolean; on: boolean; url?: string }; health: { ok: boolean; server?: { name: string; version: string }; error?: string }; capabilities?: { available: Record<string, boolean>; on: Record<string, boolean> } } }) {
  portal.locale.use();
  const name = card.name.trim();
  const nameOk = isValidInstanceName(name); // the same rule the server keeps: one place for it, not two
  const nameTakenByAnother = name !== "" && drafts.some((d) => d !== card && d.name.trim() === name);
  /** One family on or off in the card's choices: an on stands nowhere in them, only the offs do. */
  const setCapability = (id: string, on: boolean) => {
    const next = { ...(card.capabilities ?? {}) };
    if (on) delete next[id];
    else next[id] = false;
    onChange({ capabilities: Object.keys(next).length > 0 ? next : {} });
  };
  return (
    <form onSubmit={save} className="space-y-3 rounded border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t("Name")}</span>
          <input className={portal.ui.classes.input} value={card.name} placeholder={t("e.g. nextcloud_uni")} disabled={busy || card.exists} onChange={(e) => onChange({ name: e.target.value })} />
          {!nameOk && name !== "" && <span className="mt-1 block text-xs text-fg-muted">{t("Letters, numbers, dashes and underscores; it must start with a letter.")}</span>}
          {nameTakenByAnother && <span className="mt-1 block text-xs text-fg-muted">{t("Another instance carries this name already.")}</span>}
        </label>
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
          <input className={portal.ui.classes.input} type="password" value={card.password} autoComplete="new-password" placeholder={card.passwordSet ? t("(set -- leave empty to keep it)") : t("(not set yet)")} disabled={busy} title={t("Made in Nextcloud under Settings, Security, Devices & sessions. It is only ever set, never shown back.")} onChange={(e) => onChange({ password: e.target.value })} />
        </label>
      </div>

      <div className="block text-sm">
        <span className="mb-1 block font-medium" title={t("A family off keeps its tools out of the chats and takes what shows it with. Where the server does not provide a family at all, it stands grey -- offered nowhere.")}>
          {t("What this server offers to the chats and the pages")}
        </span>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
          {CAPABILITIES.map((cap) => {
            const provided = status?.capabilities?.available[cap.id]; // grey where the endpoint says it does not have it
            return (
              <label key={cap.id} className={`flex items-center gap-2 ${provided === false ? "opacity-40" : ""}`}>
                <input type="checkbox" checked={(card.capabilities?.[cap.id] ?? true)} disabled={busy || provided === false} onChange={(e) => setCapability(cap.id, e.target.checked)} />
                <span>{t(cap.label)}</span>
              </label>
            );
          })}
        </div>
      </div>

      {status && (
        <div className="flex items-center gap-1.5 text-xs text-fg-muted">
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[healthOf(status)]}`} />
          <span>
            <span className={WORD[healthOf(status)] || undefined}>{status.state}</span> ·{" "}
            {status.mcp.registered ? t("entry present") : t("entry absent")} ·{" "}
            {status.health.ok ? (t("answering") + (status.health.server ? ` ${status.health.server.name}` : "")) : status.health.error}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button type="submit" className={portal.ui.classes.primary} disabled={busy || !nameOk || nameTakenByAnother}>
          {t("Save and apply")}
        </button>

        <span className="flex-1" />
        {card.exists && (
          <button type="button" className={portal.ui.classes.ghost} disabled={busy} onClick={remove}>
            {t("Remove")}
          </button>
        )}
      </div>
    </form>
  );
}
