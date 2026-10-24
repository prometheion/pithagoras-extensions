import { useEffect, useState } from "react";
import { DEBOUNCE_MAX_MS, DEBOUNCE_MIN_MS, HEIGHT_MAX, HEIGHT_MIN } from "../limits";
import { portal, t } from "../portal";
import { api, type UiSettings } from "./api";
import { setSettings } from "./store";

/** A whole number from `min` to `max`, as typed; nothing for anything else. */
const whole = (text: string, min: number, max: number): number | undefined => {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const n = Number(text);
  return n >= min && n <= max ? n : undefined;
};

/**
 * Inline UI's page in Settings: how long an event waits for the person to pause when its card says nothing, how tall
 * a card is drawn before it scrolls inside, and whether a card's event may start the agent's turn at all.
 */
export function UiSettingsPage() {
  portal.locale.use();
  const { ui } = portal;
  const [kept, setKept] = useState<UiSettings | null>(null);
  const [debounce, setDebounce] = useState("");
  const [height, setHeight] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const take = (s: UiSettings) => {
    setKept(s);
    setSettings(s);
    setDebounce(String(s.defaultDebounceMs));
    setHeight(String(s.maxHeight));
  };
  useEffect(() => {
    api.settings().then(take, (e: Error) => setFailure(e.message));
  }, []);

  const save = async (patch: Partial<UiSettings>) => {
    setSaving(true);
    try {
      take(await api.saveSettings(patch));
      setFailure(null);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const debounceMs = whole(debounce, DEBOUNCE_MIN_MS, DEBOUNCE_MAX_MS);
  const maxHeight = whole(height, HEIGHT_MIN, HEIGHT_MAX);
  const dirty = !!kept && (debounce !== String(kept.defaultDebounceMs) || height !== String(kept.maxHeight));
  ui.useUnsavedDraft(dirty);
  if (!kept) return failure ? <ui.LoadFailed error={failure} onRetry={() => api.settings().then(take, (e: Error) => setFailure(e.message))} /> : <ui.RowsSkeleton rows={3} label={t("Loading…")} />;

  return (
    <div className="space-y-5">
      {failure && <ui.ErrorBanner onClose={() => setFailure(null)}>{failure}</ui.ErrorBanner>}
      <ui.Section title={t("Cards")} hint={t("The agent shows a card with ui_show: HTML it writes, drawn under its message in a frame that reaches nothing.")}>
        <div className="space-y-4">
          <ui.Field label={t("Wait after the last change (ms)")} hint={t("How long a card's event waits for the person to pause before it is sent, where the card does not say: {min} to {max}.", { min: DEBOUNCE_MIN_MS, max: DEBOUNCE_MAX_MS })}>
            <input className={ui.classes.input} inputMode="numeric" value={debounce} onChange={(e) => setDebounce(e.target.value)} aria-invalid={debounceMs === undefined} />
          </ui.Field>
          <ui.Field label={t("Highest a card is drawn (px)")} hint={t("Past this a card scrolls inside, and its head has a button to show all of it: {min} to {max}.", { min: HEIGHT_MIN, max: HEIGHT_MAX })}>
            <input className={ui.classes.input} inputMode="numeric" value={height} onChange={(e) => setHeight(e.target.value)} aria-invalid={maxHeight === undefined} />
          </ui.Field>
          <div className="flex gap-2">
            <button type="button" className={ui.classes.primarySmall} disabled={!dirty || saving || debounceMs === undefined || maxHeight === undefined} onClick={() => void save({ defaultDebounceMs: debounceMs, maxHeight })}>
              {t("Save")}
            </button>
            {dirty && (
              <button type="button" className={ui.classes.ghost} onClick={() => take(kept)}>
                {t("Cancel")}
              </button>
            )}
          </div>
        </div>
      </ui.Section>
      <ui.Section title={t("Starting the agent")}>
        <ui.SwitchRow
          title={t("Let a card start the agent's turn")}
          detail={t("An event the agent marks wake (a Submit button, say) starts its turn when it is idle. Off, such an event waits for your next message, as every other does.")}
          on={kept.allowWake}
          disabled={saving}
          onChange={(on) => void save({ allowWake: on })}
        />
      </ui.Section>
      <ui.Section title={t("Good to know")}>
        <ul className="list-disc space-y-1 pl-4 text-xs text-fg-muted">
          <li>{t("A card has no network and no way into the portal: it cannot load anything from anywhere, nor read your chats or files.")}</li>
          <li>{t("A card sends only once you have clicked or typed in it, and only the events the agent declared for it.")}</li>
          <li>{t("While the agent works, what you do in a card reaches it at its next step; while it is idle, with your next message.")}</li>
          <li>{t("Cards are kept with their chat, on every page open on it, and go when the chat is deleted.")}</li>
        </ul>
      </ui.Section>
    </div>
  );
}
