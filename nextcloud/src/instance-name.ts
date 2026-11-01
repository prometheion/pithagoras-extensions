/**
 * The names instances stand under: what pi's mcp.json takes as an entry's name, and so the prefix of that server's
 * tools in the chats. Kept out of the server half on purpose, as the pages check it before a save too -- and this
 * file may take no node imports while it is shared with them.
 */

/** How long an instance's name may be at most, so its prefixed tools stay readable in the chats' tool lists. */
export const INSTANCE_NAME_MAX = 48;

/** Whether a name is one this extension may stand an instance up under: letters, numbers, dashes and underscores,
 * starting with a letter, not longer than it needs to be. */
export function isValidInstanceName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) && name.length <= INSTANCE_NAME_MAX;
}
