/** Text that can sit in a message's markup: nothing in it opens or closes an element. */
export const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
