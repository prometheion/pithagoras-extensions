import { useState } from "react";
import { portal, t } from "../portal";
import { api, sayError } from "./api";
import { agentError, agentHealth, dsHealth, floatingTag, type AgentHealth, type DsHealth } from "../office-ui";
import { refreshOfficeState, useOfficeState } from "./state";

/**
 * The Office page in Settings: a service panel for the Document Server and the agents' editor -- how each stands (and
 * what a download is doing), start and stop, and the pinned image tag. Start downloads both images at once and starts
 * the Document Server; the agents' browser starts when an agent first needs it. Labels, states, errors and the hints
 * a field needs, nothing more: what Office does and where it keeps things is the README's to say.
 * Enabling goes through
 * POST /settings, which answers without waiting for a first pull to finish (`starting`): the pull progress keeps
 * coming in over the shared 5 s poll, and the server half's lookAfter stays quiet while the person has stopped it.
 */

function mem(bytes: number): string {
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.round(bytes / 2 ** 20)} MB`;
}

/** The dot beside a service's name: green while it is up or ready, amber while it comes, red where it failed. */
const DOT: Record<DsHealth | AgentHealth, string> = {
  running: "po-state-live bg-ok",
  ready: "po-state-live bg-ok",
  starting: "po-state-pulling bg-warn",
  downloading: "po-state-pulling bg-warn",
  failed: "bg-danger",
  missing: "bg-fg-subtle",
  stopped: "bg-fg-subtle",
  other: "bg-fg-subtle",
};

/** One service: its name, how it stands, what its download is doing, and why it failed. */
function Service(props: { name: string; health: DsHealth | AgentHealth; said: string; detail?: string; line?: string; error?: string; label: string }) {
  return (
    <div className="po-service" role="status" aria-label={props.label}>
      <div className="po-service-head">
        <span className={`h-2 w-2 rounded-full ${DOT[props.health]}`} />
        {props.name}
        <span className="po-service-state" data-health={props.health}>
          {props.said}
        </span>
      </div>
      {props.detail && <div className="po-service-detail">{props.detail}</div>}
      {props.line && <div className="po-pull-line">{props.line}</div>}
      {props.error && <div className="po-pull-line text-danger">{props.error}</div>}
    </div>
  );
}

export function OfficeSettings() {
  portal.locale.use();
  const state = useOfficeState();
  const [busy, setBusy] = useState<null | "start" | "stop" | "remove" | "settings">(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Null: still saying what the server says. A string: what is in the input now.
  const [tag, setTag] = useState<string | null>(null);

  if (!state) return <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />;

  const c = state.container;
  const running = c.state === "running";
  const ds = dsHealth(c);
  const agent = agentHealth(state.agent);
  // Start is there while anything of Office is not: the Document Server, or the agents' editor's image (an install
  // from before Start downloaded it gets it here).
  const startable = (!running || agent === "missing" || (agent === "failed" && !state.agent.present)) && ds !== "downloading" && agent !== "downloading";
  const dsSaid: Record<DsHealth, string> = {
    downloading: t("Downloading"),
    running: t("Running"),
    starting: t("Starting"),
    failed: t("Failed"),
    stopped: t("Stopped"),
    other: c.state,
  };
  const agentSaid: Record<AgentHealth, string> = {
    downloading: t("Downloading"),
    failed: t("Failed"),
    missing: t("Missing: Start downloads it"),
    running: state.agent.browser?.editors === 1 ? t("Running · 1 document open") : t("Running · {n} documents open", { n: state.agent.browser?.editors ?? 0 }),
    starting: t("Starting"),
    ready: t("Ready"),
  };

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
      // A first start downloads both images and takes minutes; the route awaits it, so this fetch stays open while
      // the progress of both is shown from /state meanwhile.
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
      {/* Both services: how each stands, and what a download is doing. */}
      <Service
        label={t("OnlyOffice Document Server")}
        name={t("OnlyOffice Document Server")}
        health={ds}
        said={dsSaid[ds]}
        detail={[running ? c.version : undefined, c.memBytes !== undefined ? mem(c.memBytes) : undefined].filter(Boolean).join(" · ") || undefined}
        line={c.pull?.active ? c.pull.line : undefined}
        error={ds === "failed" ? c.error : c.pull?.error}
      />
      <Service
        label={t("The agents' editor")}
        name={t("The agents' editor")}
        health={agent}
        said={agentSaid[agent]}
        detail={state.agent.tag}
        line={state.agent.pull?.active ? state.agent.pull.line : undefined}
        error={agent === "failed" ? agentError(state.agent) : undefined}
      />

      {/* Enabling it: with the memory warning before a first start (~4 GB RAM recommended at runtime). */}
      {!state.enabled && <portal.ui.WarnBanner>{t("Needs about 4 GB of RAM while it runs.")}</portal.ui.WarnBanner>}

      <portal.ui.SwitchRow
        title={t("Use Office")}
        on={state.enabled}
        disabled={busy !== null}
        onChange={(on) => void act("settings", () => api.saveSettings({ enabled: on }))}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={portal.ui.classes.button} disabled={busy !== null || !startable} onClick={() => void start()}>
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
