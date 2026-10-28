import { portal, t } from "../portal";

/** Where the portal is too old for agents to answer comments and the editor's chat (the server half's `docchatOff`):
 * said on the Office page and in its settings. `said` is the server half's own words, which name what the portal
 * lacks. */
export function TooOld({ said }: { said: string }) {
  return (
    <portal.ui.ErrorBanner>
      <span title={said}>{t("Agents do not answer comments or the chat here: the portal is too old")}</span>
    </portal.ui.ErrorBanner>
  );
}
