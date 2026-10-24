import { useEffect, useRef, useState } from "react";
import { LuRefreshCw, LuTrash2 } from "react-icons/lu";
import { msg, portal, t } from "../portal";
import { api, type GodotState, type Hardware, type ServerState } from "./api";
import { HTTPS_GUIDE, insecureNote } from "./GodotPanel";
import { refresh, useGodotState } from "./state";
import { DISPLAYS } from "../displays";

/** What the status pill says for each state of the server. */
const PILL: Record<ServerState, string> = {
  running: msg("Running"),
  starting: msg("Starting"),
  downloading: msg("Downloading"),
  stopped: msg("Stopped"),
  failed: msg("Failed"),
  absent: msg("Not installed"),
  unavailable: msg("Docker missing"),
  foreign: msg("Name taken"),
};

const GB = (mib: number | null) => (mib === null ? "?" : portal.format.number(mib / 1024, { maximumFractionDigits: 1 }));

/**
 * What the uninstall asks. The dialog is drawn by the portal, away from this page, so the box reports its answer to
 * `removeData`, which the page reads once the dialog is answered. Off: the projects stay, for an install after.
 */
function RemoveQuestion({ removeData, volume }: { removeData: { current: boolean }; volume: string }) {
  const [on, setOn] = useState(false);
  return (
    <div className="space-y-3">
      <p>{t("The Godot container is stopped and removed. Its image stays on disk.")}</p>
      <label className="flex items-start gap-2 text-fg">
        <input
          type="checkbox"
          className="mt-1"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            removeData.current = e.target.checked;
          }}
        />
        <span>{t("Also delete the projects (volume {volume})", { volume })}</span>
      </label>
    </div>
  );
}

/** The editor's own state, beside the container's. */
function editorLine(state: GodotState): string | null {
  const e = state.editor;
  if (state.state !== "running" || !e) return null;
  if (e.busy) return t("Editor busy: {what}", { what: e.busy });
  if (e.ready) return t("Editor ready: {project}", { project: e.project ?? "" });
  if (e.editor === "crashed") return t("Editor restarting");
  return t("Editor starting");
}

/**
 * The Godot page in Settings: how the server stands and what the editor is doing, installing, starting, stopping and
 * removing it, the GPU it runs on and the size of its screen, the end of its log, and what to know about it.
 */
export function GodotSettings() {
  portal.locale.use();
  const { ui } = portal;
  const { state, failed } = useGodotState();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hardware, setHardware] = useState<Hardware | null>(null);
  const [hardwareError, setHardwareError] = useState("");
  const alive = useRef(true);
  /** The cards as the probe reads them now, with the one the server holds: as the page opens, and after an action. */
  const probe = () =>
    api.hardware().then(
      (h) => alive.current && (setHardware(h), setHardwareError("")),
      (e) => alive.current && setHardwareError((e as Error).message),
    );
  useEffect(() => {
    alive.current = true;
    void probe();
    return () => {
      alive.current = false;
    };
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await refresh();
      setBusy(false);
      void probe();
    }
  };
  const remove = async () => {
    if (!state) return;
    const removeData = { current: false };
    if (!(await ui.confirm({ title: t("Remove Godot?"), message: <RemoveQuestion removeData={removeData} volume={state.volume} />, confirmLabel: t("Remove"), danger: true, deletes: true }))) return;
    await act(() => api.uninstall(removeData.current));
  };
  const chooseGpu = (gpu: string) => act(() => api.setGpu(gpu));

  if (!state) return failed ? <ui.LoadFailed error={t("Could not reach the Godot extension.")} onRetry={refresh} /> : <ui.RowsSkeleton rows={4} label={t("Loading…")} />;

  const working = busy || state.busy;
  const btn = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition disabled:opacity-40";
  const primary = `${btn} bg-accent/12 text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20`;
  const quiet = `${btn} bg-fg/5 text-fg-muted hover:bg-fg/10`;
  const there = !["absent", "unavailable", "foreign", "downloading"].includes(state.state);
  const said = (text: string) => t(text);
  const line = editorLine(state);
  // The host pinned a card Docker does not give: the server half refuses to install, and the page says why first.
  const pinMissing = !!hardware && hardware.pinned && !hardware.cards.length;

  return (
    <div className="space-y-5">
      {error && <ui.ErrorBanner onClose={() => setError("")}>{said(error)}</ui.ErrorBanner>}
      {!window.isSecureContext && (
        <ui.WarnBanner>
          {insecureNote()}{" "}
          <a className="underline" href={HTTPS_GUIDE} target="_blank" rel="noreferrer">
            {t("How to serve the portal over HTTPS")}
          </a>
        </ui.WarnBanner>
      )}

      <ui.Section title={t("Status")}>
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-xs text-fg-muted">
            {state.state === "unavailable"
              ? t("Godot needs Docker for extensions. Install it in Settings → Extensions.")
              : state.state === "foreign"
                ? t("A container named {name} is there already and is not this extension's. Rename or remove it first.", { name: state.container })
                : t("The real Godot editor runs in a container on this host's Docker, with its tools in every chat and its screen in a panel beside the chat.")}
          </p>
          <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">{t(PILL[state.state])}</span>
        </div>
        {line && <p className="mt-2 text-xs text-fg-faint">{line}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {state.state === "absent" && (
            <button type="button" disabled={working || pinMissing} onClick={() => act(api.install)} className={primary}>
              {working && <LuRefreshCw aria-hidden className="h-3.5 w-3.5 animate-spin" />}
              {t("Install (downloads about 0.6 GB)")}
            </button>
          )}
          {(state.state === "stopped" || state.state === "failed") && (
            <button type="button" disabled={working} onClick={() => act(api.start)} className={primary}>
              {t("Start")}
            </button>
          )}
          {(state.state === "running" || state.state === "starting" || state.state === "failed") && (
            <button type="button" disabled={working} onClick={() => act(api.stop)} className={quiet}>
              {t("Stop")}
            </button>
          )}
          {there && (
            <button type="button" disabled={working} onClick={() => void remove()} className={`${quiet} hover:bg-danger/10 hover:text-danger`}>
              <LuTrash2 aria-hidden className="h-3.5 w-3.5" /> {t("Remove")}
            </button>
          )}
        </div>
        {state.state === "downloading" && state.progress && <p className="mt-2 font-mono text-[11px] text-fg-faint">{state.progress}</p>}
        {state.error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {said(state.error)}
          </p>
        )}
      </ui.Section>

      <ui.Section title={t("GPU")}>
        {hardwareError && <p className="text-xs text-danger">{said(hardwareError)}</p>}
        {!hardware && !hardwareError && <p className="text-xs text-fg-faint">{t("Looking for GPUs…")}</p>}
        {pinMissing && <p className="text-xs text-danger">{t("The card PITHAGORAS_GODOT_GPU names is not on this host.")}</p>}
        {hardware && !hardware.cards.length && !hardware.pinned && <p className="text-xs text-fg-muted">{t("No NVIDIA GPU found: Godot opens Compatibility projects with software OpenGL and cannot render Forward+ projects.")}</p>}
        {hardware && hardware.error && !hardware.cards.length && <p className="mt-1 font-mono text-[11px] text-fg-faint">{hardware.error}</p>}
        {hardware && hardware.cards.length > 0 && (
          <div className="space-y-1.5" role="radiogroup" aria-label={t("GPU")}>
            {!hardware.pinned && (
              <label className="flex items-center gap-2 text-xs">
                <input type="radio" name="godot-gpu" disabled={working} checked={!hardware.chosen} onChange={() => void chooseGpu("")} />
                {t("Automatic: the card with the most free memory")}
              </label>
            )}
            {hardware.cards.map((card) => (
              <label key={card.uuid} className="flex items-center gap-2 text-xs">
                <input type="radio" name="godot-gpu" disabled={working || hardware.pinned} checked={hardware.pinned || hardware.chosen === card.uuid} onChange={() => void chooseGpu(card.uuid)} />
                <span className="text-fg">{card.name}</span>
                <span className="font-mono text-[11px] text-fg-faint">…{card.uuid.slice(-8)}</span>
                <span className="text-fg-faint">{t("{used} of {total} GB in use", { used: GB(card.usedMiB), total: GB(card.totalMiB) })}</span>
                {state.card === card.uuid && <span className="rounded bg-fg/5 px-1.5 text-[11px] text-fg-muted">{t("in use by Godot")}</span>}
              </label>
            ))}
            {hardware.pinned && <p className="text-xs text-fg-faint">{t("The host pins Godot to this card (PITHAGORAS_GODOT_GPU).")}</p>}
          </div>
        )}
        <p className="mt-2 text-xs text-fg-faint">
          {t("A Forward+ editor needs about 0.55 GB, a running game or a recording as much again. Compatibility projects (the 2D template) are lighter.")}
        </p>
      </ui.Section>

      <ui.Section title={t("Screen")}>
        <ui.Segments label={t("Screen")} value={state.display} options={DISPLAYS.map((d) => ({ id: d, label: d.replace("x", " × ") }))} onChange={(display) => void act(() => api.setDisplay(display))} />
        <p className="mt-2 text-xs text-fg-faint">{t("Smaller is sharper in the panel; changing it restarts the editor.")}</p>
      </ui.Section>

      {state.log && (
        <ui.Section
          title={t("Log")}
          action={
            <button type="button" onClick={() => void refresh()} className="text-xs text-fg-muted hover:text-fg">
              {t("Refresh")}
            </button>
          }
        >
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-fg/5 p-2 font-mono text-[10px] text-fg-faint" aria-label={t("Godot server log")}>
            {state.log}
          </pre>
        </ui.Section>
      )}

      <ui.Section title={t("Good to know")}>
        <ul className="list-disc space-y-1.5 pl-4 text-xs text-fg-muted">
          <li>{t("Projects are kept in the Docker volume {volume}. Remove keeps them unless you ask for them to go too.", { volume: state.volume })}</li>
          <li>{t("The image stays on disk after Remove. To delete it: docker image rm {image}", { image: state.image })}</li>
          <li>{t("Remove the server here before you uninstall the extension: the container outlives the extension.")}</li>
          <li>{t("One editor serves every chat and you: agents in two chats work in the same open project.")}</li>
          <li>{t("The GPU's memory is shared with whatever else uses the card.")}</li>
          <li>
            {t("Which chats have the Godot tools is set in Settings → Tools.")}{" "}
            <button type="button" className="underline" onClick={() => portal.navigate("/settings/tools")}>
              {t("Open Settings → Tools")}
            </button>
          </li>
        </ul>
      </ui.Section>
    </div>
  );
}
