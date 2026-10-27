import { useState } from "react";
import { portal, t } from "../portal";
import { api, sayError } from "./api";
import { floatingTag, officeHealth, type OfficeHealth } from "../office-ui";
import { refreshOfficeState, useOfficeState } from "./state";

/**
 * The Office page in Settings: Office as one thing -- how it stands (and what its downloads are doing), start, stop and
 * remove, and the pinned image tag. Start downloads every image at once (the Document Server's and the agents'
 * editor's) and starts the Document Server; the agents' browser starts when an agent first needs it. The person sees
 * one state; a failure names the part that failed. Labels, states, errors and the hints a field needs, nothing more:
 * what Office does and where it keeps things is the README's to say. Enabling goes through POST /settings, which
 * answers without waiting for a first pull to finish (`starting`): the pull progress keeps coming in over the shared
 * 5 s poll, and the server half's lookAfter stays quiet while the person has stopped it.
 */

function mem(bytes: number): string {
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.round(bytes / 2 ** 20)} MB`;
}

/** The dot beside the state: green while it runs, amber while it comes, red where it failed. */
const DOT: Record<OfficeHealth, string> = {
  running: "po-state-live bg-ok",
  starting: "po-state-pulling bg-warn",
  downloading: "po-state-pulling bg-warn",
  failed: "bg-danger",
  missing: "bg-warn",
  stopped: "bg-fg-subtle",
  other: "bg-fg-subtle",
};

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
  const office = officeHealth(c, state.agent);
  // Start is there while anything of Office is not: the Document Server, or the agents' editor's image (an install
  // from before Start downloaded it gets it here), and no download is under way.
  const startable = (!running || !state.agent.present) && office.health !== "downloading";
  const said: Record<OfficeHealth, string> = {
    downloading: t("Downloading"),
    failed: t("Failed"),
    starting: t("Starting"),
    stopped: t("Stopped"),
    other: c.state,
    missing: t("Agents' editor missing: Start downloads it"),
    running: t("Running"),
  };
  const editors = state.agent.browser?.editors ?? 0;
  const detail = [
    running ? c.version : undefined,
    c.memBytes !== undefined ? mem(c.memBytes) : undefined,
    office.health === "running" && editors > 0 ? (editors === 1 ? t("Agents in 1 document") : t("Agents in {n} documents", { n: editors })) : undefined,
  ].filter(Boolean);
  // Both downloads, as one progress: the lines of whichever are under way.
  const pulling = [c.pull, state.agent.pull].filter((p) => p?.active).map((p) => p!.line);
  const error =
    office.failed === "ds" ? t("Document Server: {error}", { error: office.error ?? "" }) : office.failed === "agent" ? t("Agents' editor: {error}", { error: office.error ?? "" }) : undefined;

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
      title: t("Remove Office?"),
      message: t("Its containers, networks and volumes go, with any save not handed over yet. Documents and images stay."),
      confirmLabel: t("Remove"),
      danger: true,
      deletes: true,
    });
    if (ok) await act("remove", () => api.removeContainer(true));
  };

  return (
    <div className="space-y-4">
      {/* Office, as one thing: how it stands, what its downloads are doing, and which part failed. */}
      <div className="po-service" role="status" aria-label={t("Office")}>
        <div className="po-service-head">
          <span className={`h-2 w-2 rounded-full ${DOT[office.health]}`} />
          {t("Office")}
          <span className="po-service-state" data-health={office.health}>
            {said[office.health]}
          </span>
        </div>
        {detail.length > 0 && <div className="po-service-detail">{detail.join(" · ")}</div>}
        {pulling.map((line, i) => (
          <div key={i} className="po-pull-line">
            {line}
          </div>
        ))}
        {error && <div className="po-pull-line text-danger">{error}</div>}
      </div>
      <p className="text-xs text-fg-subtle">{t("At least 1 GB of RAM, more with each person and agent in a document.")}</p>

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
