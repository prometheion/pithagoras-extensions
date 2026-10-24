import { useCallback, useEffect, useState } from "react";
import { api, type BlenderHardware, type BlenderState, type Card } from "./api";
import { refresh, useBlenderState } from "./state";
import { msg, portal, t } from "../portal";

/** What each state is called on the page, as its badge says it. */
const PILL: Record<BlenderState["state"], string> = {
  running: msg("Running"),
  starting: msg("Starting"),
  downloading: msg("Downloading"),
  stopped: msg("Stopped"),
  failed: msg("Failed"),
  absent: msg("Not installed"),
  unavailable: msg("Docker missing"),
  foreign: msg("Name taken"),
};

/** What each state means, under the badge. */
const MEANING: Record<BlenderState["state"], string> = {
  running: msg("Blender runs and answers. Its tools are in every chat, and its view is in the panel beside each chat."),
  starting: msg("Blender is starting. Its tools and its view come once it answers."),
  downloading: msg("Blender's image is downloading: about 1 GB the first time."),
  stopped: msg("Blender is stopped and holds no GPU memory. Its projects are kept."),
  failed: msg("Blender stopped with an error. The log below says why."),
  absent: msg("Install downloads Blender's image, makes its container and starts it. Nothing is installed in the portal itself."),
  unavailable: msg("Blender needs Docker for extensions. Install it in Settings → Extensions."),
  foreign: msg("A container named {name} is there that is not this extension's. Rename it or remove it first."),
};

const tone: Partial<Record<BlenderState["state"], string>> = { running: "bg-ok/12 text-ok", failed: "bg-danger/10 text-danger", unavailable: "bg-danger/10 text-danger", foreign: "bg-warn/15 text-warn" };

const gb = (mib: number | null) => (mib === null ? "?" : portal.format.number(mib / 1024, { maximumFractionDigits: 1, minimumFractionDigits: 1 }));

/**
 * What the removal asks. The dialog is drawn by the portal, away from this page, so the box reports its answer to
 * `removeData`, which the page reads once the dialog is answered. Off: the projects stay, for an install after.
 */
function RemoveQuestion({ volume, removeData }: { volume: string; removeData: { current: boolean } }) {
  const [on, setOn] = useState(false);
  return (
    <div className="space-y-3">
      <p>{t("The Blender container is stopped and removed, and its tools leave every chat. Its image stays on disk.")}</p>
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
        <span>
          {t("Also delete the projects (volume {volume})", { volume })}
          <span className="mt-1 block text-xs text-fg-muted">{t("Leave it off to keep the scenes, renders and exports for an install after.")}</span>
        </span>
      </label>
    </div>
  );
}

/** One card, as the GPU section lists it. */
function CardRow({ card, chosen, held, disabled, onChoose }: { card: Card; chosen: boolean; held: boolean; disabled: boolean; onChoose: () => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="radio" name="blender-gpu" checked={chosen} disabled={disabled} onChange={onChoose} />
      <span className="min-w-0 flex-1">
        {card.name} <span className="font-mono text-[11px] text-fg-faint">…{card.uuid.slice(-8)}</span>
        <span className="block text-xs text-fg-muted">{t("{used} of {total} GB in use", { used: gb(card.usedMiB), total: gb(card.totalMiB) })}</span>
      </span>
      {held && <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">{t("In use")}</span>}
    </label>
  );
}

/** Which denoiser the viewport uses, and why: as the server says while it runs, else as the probe found the host. */
function Denoiser({ hardware, state }: { hardware: BlenderHardware | null; state: BlenderState | null }) {
  if (state?.renderer?.backend) {
    return (
      <p className="text-xs text-fg-muted">
        {t("Cycles renders with {backend}; the viewport denoises with {denoiser}.", {
          backend: state.renderer.backend,
          denoiser: state.renderer.denoiser === "OPTIX" ? "OptiX" : "OpenImageDenoise",
        })}
      </p>
    );
  }
  if (!hardware) return null;
  if (!hardware.cards.length) return <p className="text-xs text-fg-muted">{t("Without a GPU the viewport denoises with OpenImageDenoise on the CPU.")}</p>;
  if (hardware.optix === "toolkit") return <p className="text-xs text-fg-muted">{t("Denoiser: OptiX. The container toolkit gives the container the driver's OptiX weights.")}</p>;
  if (hardware.optix === "host") return <p className="text-xs text-fg-muted">{t("Denoiser: OptiX. The driver's OptiX weights are bound into the container from the host.")}</p>;
  return <p className="text-xs text-fg-muted">{t("Denoiser: OpenImageDenoise. The driver's OptiX weights (nvoptix.bin) are not on this host.")}</p>;
}

/**
 * Blender's page in Settings: how its server stands, installing, starting, stopping and removing it, the card it runs
 * on and the denoiser its viewport uses, the end of its log, and what to know about its disk, its memory and who uses it.
 */
export function BlenderSettings() {
  portal.locale.use();
  const { ui } = portal;
  const { state, failed } = useBlenderState();
  const [failure, setFailure] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [hardware, setHardware] = useState<BlenderHardware | null>(null);
  const [probing, setProbing] = useState(true);
  const readHardware = useCallback(async () => {
    setProbing(true);
    try {
      setHardware(await api.hardware());
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setProbing(false);
    }
  }, []);
  // The cards as they are now, read as the page opens: the probe takes a few seconds.
  useEffect(() => void readHardware(), [readHardware]);

  const act = async (work: () => Promise<unknown>) => {
    setActing(true);
    try {
      await work();
    } catch (e) {
      setFailure((e as Error).message);
    }
    await refresh();
    setActing(false);
  };
  const remove = async () => {
    const removeData = { current: false };
    const yes = await ui.confirm({
      title: t("Remove Blender?"),
      message: <RemoveQuestion volume={state?.volume ?? ""} removeData={removeData} />,
      confirmLabel: t("Remove"),
      danger: true,
      deletes: true,
    });
    if (yes) await act(() => api.uninstall(removeData.current));
  };
  const choose = (gpu: string) => act(async () => {
    await api.setGpu(gpu);
    setHardware(await api.hardware());
  });

  const now = state?.state;
  const busy = acting || !!state?.busy;
  const there = now && !["unavailable", "absent", "foreign"].includes(now);
  return (
    <div className="space-y-5">
      {failure && <ui.ErrorBanner onClose={() => setFailure(null)}>{t(failure)}</ui.ErrorBanner>}
      {failed && !state && <ui.ErrorBanner>{t("Could not reach Blender's server half.")}</ui.ErrorBanner>}

      <ui.Section title={t("Status")}>
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-sm text-fg-muted">{now ? t(MEANING[now], { name: state!.container }) : t("Checking…")}</p>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${(now && tone[now]) || "bg-accent/10 text-accent"}`}>{now ? t(PILL[now]) : t("Checking…")}</span>
        </div>
        {state?.progress && <p className="mt-2 font-mono text-[11px] text-fg-faint" role="status">{state.progress}</p>}
        {state?.error && <p role="alert" className="mt-2 text-xs text-danger">{t(state.error)}</p>}
      </ui.Section>

      <ui.Section title={t("Server")}>
        <div className="flex flex-wrap gap-2">
          {(now === "absent" || now === "failed" || now === "stopped") && (
            <button type="button" disabled={busy} className={ui.classes.primarySmall} onClick={() => void act(() => api.act(now === "absent" ? "install" : "start"))}>
              {now === "absent" ? t("Install") : now === "failed" ? t("Try again") : t("Start")}
            </button>
          )}
          {(now === "running" || now === "starting" || (now === "failed" && state?.retrying)) && (
            <button type="button" disabled={busy} className={ui.classes.button} onClick={() => void act(() => api.act("stop"))}>
              {t("Stop")}
            </button>
          )}
          {there && (
            <button type="button" disabled={busy} className={`${ui.classes.button} hover:text-danger`} onClick={() => void remove()}>
              {t("Remove")}
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-fg-faint">{t("Stopping releases the GPU's memory and keeps the projects. Remove the server here before uninstalling the extension: its container keeps running otherwise.")}</p>
      </ui.Section>

      <ui.Section title={t("GPU")} hint={probing ? t("Looking for cards…") : undefined}>
        {hardware && hardware.cards.length > 0 && (
          <div className="space-y-2">
            {hardware.pinned ? (
              <p className="text-xs text-fg-muted">{t("The host fixes the card (PITHAGORAS_BLENDER_GPU).")}</p>
            ) : (
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="blender-gpu" checked={!hardware.chosen} disabled={busy} onChange={() => void choose("")} />
                {t("Automatic: the card with the most free memory")}
              </label>
            )}
            {hardware.cards.map((card) => (
              <CardRow key={card.uuid} card={card} chosen={hardware.pinned || hardware.chosen === card.uuid} held={state?.card === card.uuid} disabled={busy || hardware.pinned} onChoose={() => void choose(card.uuid)} />
            ))}
            <p className="text-xs text-fg-faint">{t("Choosing another card makes a running server again on it now, and a stopped one at its next start.")}</p>
          </div>
        )}
        {hardware && !hardware.cards.length && <p className="text-sm text-fg-muted">{t("No NVIDIA GPU found: Blender renders on the CPU.")}</p>}
        <div className="mt-2">
          <Denoiser hardware={hardware} state={state} />
        </div>
      </ui.Section>

      {state?.log && (
        <ui.Section
          title={t("Log")}
          action={
            <button type="button" className={ui.classes.ghost} onClick={() => void refresh()}>
              {t("Refresh")}
            </button>
          }
        >
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-canvas p-2 font-mono text-[10px] text-fg-faint" aria-label={t("Blender's log")}>
            {state.log}
          </pre>
        </ui.Section>
      )}

      <ui.Section title={t("Good to know")}>
        <ul className="list-disc space-y-1 pl-4 text-xs text-fg-muted">
          <li>{t("Projects, renders and exports are kept in the Docker volume {volume}.", { volume: state?.volume ?? "pithagoras-blender-data" })}</li>
          <li>{t("Removing the server leaves its image on disk. To delete it as well: docker image rm {image}", { image: state?.image ?? "" })}</li>
          <li>{t("Blender shares the card's memory with whatever else uses it: a big scene can run out while a model is loaded there.")}</li>
          <li>{t("One Blender serves every chat and you: agents in two chats work on the same open scene.")}</li>
          <li>
            {t("Who has Blender's tools is set in Settings → Tools.")}{" "}
            <button type="button" className="text-accent hover:underline" onClick={() => portal.navigate("/settings/tools")}>
              {t("Open Settings → Tools")}
            </button>
          </li>
        </ul>
      </ui.Section>
    </div>
  );
}
