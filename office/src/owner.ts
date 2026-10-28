/**
 * Whose a chat is, for its documents: the one rule the agent's office tools (tools.ts) and the Office panel beside a
 * chat (server.ts `/scope`, its New document) share, so that the panel lists the documents the chat's agent can work
 * on with its tools, no more and no fewer.
 */
import { canonical } from "./store";
import { portal339 } from "./extension-api-339.temporary";

/** The default agent's home: the folder folders.list() marks `home`, the agent a chat, channel or routine goes to when
 * none is named. Undefined where it is not listed (gone, out of reach). */
export function defaultHome(): string | undefined {
  const home = portal339().folders.list().find((f) => f.kind === "agent" && f.home);
  return home && canonical(home.path);
}

/** Whether this portal says whose a chat is (chats.owner, the extension API of thecodacus/pithagoras#339). */
export const ownerKnown = (): boolean => typeof portal339().chats.owner === "function";

/**
 * The agent's home or the project's folder a chat's documents belong to, canonical: whose the portal says the chat is
 * (chats.owner: a chat in a folder inside a project is the project's, one in a link in an agent's home the agent's).
 * Undefined for a chat that is neither's (the workspace root itself). Throws `not_found` where there is no such chat.
 *
 * A portal older than #339 cannot say it: there a chat is an agent's or a project's only where the folder it works in,
 * as the portal gives it, is exactly that agent's home or that project's folder as folders.list() gives it, which is
 * all such a portal tells for certain (the rule the tools had before #339); one in a folder inside them, or in a link,
 * is neither's there.
 */
export function chatOwner(chatId: string): string | undefined {
  const p = portal339();
  if (!ownerKnown()) {
    let at: string;
    try {
      at = p.chats.folder(chatId);
    } catch {
      throw Object.assign(new Error(`there is no chat ${chatId}, or its folder is gone`), { code: "not_found" });
    }
    const f = p.folders.list().find((f) => (f.kind === "agent" || f.kind === "project") && f.path === at);
    return f && canonical(f.path);
  }
  if (!p.chats.get(chatId)) throw Object.assign(new Error(`there is no chat ${chatId}`), { code: "not_found" });
  const owner = p.chats.owner(chatId);
  return owner ? canonical(owner.path) : undefined;
}
