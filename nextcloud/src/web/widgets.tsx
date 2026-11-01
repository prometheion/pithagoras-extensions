/** Small pieces the tabs share: the portal's question before something goes away, and two readers of the words the
 * server gives (an HTML body as text, a moment of the tools as a Date). The portal's own pieces (Segments, confirm,
 * LoadFailed, Field, format) are used directly: a tab keeps no copy of them. */

import { portal, t } from "../portal";

/** The portal's own question before something goes away for good: its dialog over the page (focus on the safe button,
 * Escape to leave, and the person's setting to be asked or not), in place of a question drawn in the panel. */
export function confirmDelete(title: string, message?: string, confirmLabel: string = t("Delete")): Promise<boolean> {
  return portal.ui.confirm({ title, message, confirmLabel, danger: true, deletes: true });
}

/** A message the server gave as HTML, as the text it says: tags gone, line breaks kept. DOMParser makes an inert
 * document -- nothing in it runs or loads -- and its text is all that is taken. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n"), "text/html");
  doc.querySelectorAll("script, style, head").forEach((node) => node.remove());
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

/** A moment the tools gave as a word, as a Date. A bare day ("2025-03-15", what an all-day event carries) is that
 * day in the reader's own zone: `new Date("2025-03-15")` is UTC midnight, which west of Greenwich is still the 14th. */
export function parseWhen(word: string): Date {
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(word);
  return bare ? new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3])) : new Date(word);
}
