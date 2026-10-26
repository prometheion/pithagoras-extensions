import { useState } from "react";
import { portal, t } from "../portal";
import { api, sayError } from "./api";
import { floatingTag } from "../office-ui";
import { refreshOfficeState, useOfficeState } from "./state";

/**
 * The Office page in Settings: a service panel for the Document Server -- where it stands (and what a first pull is
 * doing), start and stop, the pinned image tag, and the agents' editor (its image, downloaded here). Labels, states,
 * errors and the hints a field needs, nothing more: what Office does and where it keeps things is the README's to say.
 * Enabling goes through
 * POST /settings, which answers without waiting for a first pull to finish (`starting`): the pull progress keeps
 * coming in over the shared 5 s poll, and the server half's lookAfter stays quiet while the person has stopped it.
 */

function mem(bytes: number): string {
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.round(bytes / 2 ** 20)} MB`;
}

export function OfficeSettings() {
  portal.locale.use();
  const state = useOfficeState();
  const [busy, setBusy] = useState<null | "start" | "stop" | "remove" | "settings" | "agent">(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Null: still saying what the server says. A string: what is in the input now.
  const [tag, setTag] = useState<string | null>(null);

  if (!state) return <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />;

  const c = state.container;
  const running = c.state === "running";
  const pull = c.pull;

  async function act(kind: NonNullable<typeof busy>, work: () => Promise<unknown>): Promise<void> {
    setBusy(kind);
    setProblem(null);
    try {
      await work();
      await refreshOfficeState();
    } catch (e) {
      setProblem(sayError(e));
    } finally {
      setBusy(null);
    }
  }

  const saveTag = () =>
    act("settings", async () => {
      const next = (tag ?? state.imageTag).trim();
      if (next === "") throw new Error(t("{ imageTag } must be a non-empty string like onlyoffice/documentserver:10.0.0.1"));
      // The same refusal the server makes, made here first: never a floating tag (it breaks the co-editing keys).
      if (floatingTag(next)) throw new Error(t("Pin a full tag, never :latest or none."));
      await api.saveSettings({ imageTag: next });
    });

  const start = () =>
    act("start", async () => {
      // A first start pulls the whole image and takes minutes; the route awaits it, so this fetch stays open while
      // the pull progress is shown from /state meanwhile.
      await api.startContainer();
      setTag(null);
    });

  const stop = () => act("stop", async () => {
    await api.stopContainer();
    setTag(null);
  });

  const remove = async () => {
    const ok = await portal.ui.confirm({
      title: t("Remove the Document Server?"),
      message: t("Its containers, network and volumes go, with any save it could not hand over yet. The documents and the image stay."),
      confirmLabel: t("Remove"),
      danger: true,
      deletes: true,
    });
    if (ok) await act("remove", () => api.removeContainer(true));
  };

  return (
    <div className="space-y-4">
      {/* The service itself: where it stands, and what a pull is doing. */}
      <div className="po-service" role="status">
        <div className="po-service-head">
          <span
            className={
              "h-2 w-2 rounded-full " +
              (running ? "po-state-live bg-ok" : c.state === "starting" || (pull?.active ?? false) ? "po-state-pulling bg-warn" : "bg-fg-subtle")
            }
          />
          {t("OnlyOffice Document Server")}
        </div>
        <div className="po-service-detail">
          {c.state}
          {running && c.version ? ` · ${c.version}` : ""}
          {c.memBytes !== undefined ? ` · ${mem(c.memBytes)}` : ""}
        </div>
        {pull && pull.active && (
          <div className="po-pull-line">
            {t("Pulling the image")} · {pull.line}
            {pull.error ? <span className="text-danger"> — {pull.error}</span> : null}
          </div>
        )}
      </div>

      {/* The agents' editor: the image of the browser they edit in, downloaded on request (a tool never does). */}
      <div className="po-service" role="status">
        <div className="po-service-head">
          <span className={"h-2 w-2 rounded-full " + (state.agent.present ? "bg-ok" : state.agent.pull?.active ? "po-state-pulling bg-warn" : "bg-fg-subtle")} />
          {t("The agents' editor")}
        </div>
        <div className="po-service-detail">
          {state.agent.present ? t("Downloaded") : t("Not downloaded")}
        </div>
        <div className="po-pull-line font-mono">{state.agent.tag}</div>
        {state.agent.pull?.active && <div className="po-pull-line">{t("Pulling the image")} · {state.agent.pull.line}</div>}
        {state.agent.pull?.error && !state.agent.present && <div className="po-pull-line text-danger">{state.agent.pull.error}</div>}
        {!state.agent.present && (
          <div>
            <button type="button" className={portal.ui.classes.button} disabled={busy !== null || (state.agent.pull?.active ?? false)} onClick={() => void act("agent", () => api.pullAgent())}>
              {state.agent.pull?.active ? t("Downloading…") : t("Download")}
            </button>
          </div>
        )}
      </div>

      {/* Enabling it: with the memory warning before a first start (~4 GB RAM recommended at runtime). */}
      {!state.enabled && <portal.ui.WarnBanner>{t("Needs about 4 GB of RAM while it runs.")}</portal.ui.WarnBanner>}

      <portal.ui.SwitchRow
        title={t("Use Office")}
        on={state.enabled}
        disabled={busy !== null}
        onChange={(on) => void act("settings", () => api.saveSettings({ enabled: on }))}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={portal.ui.classes.button} disabled={busy !== null || running} onClick={() => void start()}>
          {busy === "start" ? t("Starting…") : t("Start container")}
        </button>
        <button type="button" className={portal.ui.classes.button} disabled={busy !== null || !running} onClick={() => void stop()}>
          {busy === "stop" ? t("Stopping…") : t("Stop container")}
        </button>
        <button type="button" className={portal.ui.classes.button} disabled={busy !== null} onClick={() => void remove()}>
          {busy === "remove" ? t("Removing…") : t("Remove")}
        </button>
      </div>

      <portal.ui.Field label={t("Image tag (pinned)")} hint={t("A full tag, never :latest. Applies at the next start.")}>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${portal.ui.classes.input} mt-1 font-mono text-xs`}
            style={{ maxWidth: "24rem" }}
            value={tag ?? state.imageTag}
            aria-label={t("Image tag (pinned)")}
            disabled={busy !== null || running}
            onChange={(e) => setTag(e.target.value)}
          />
          <button type="button" className={portal.ui.classes.primarySmall} disabled={busy !== null || running} onClick={() => void saveTag()}>
            {t("Save")}
          </button>
        </div>
      </portal.ui.Field>

      {problem && (
        <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>
      )}
    </div>
  );
}
