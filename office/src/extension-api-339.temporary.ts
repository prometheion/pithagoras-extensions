/**
 * TEMPORARY: the members of the extension API that thecodacus/pithagoras#339 adds and Office uses, until
 * @pithagoras/extension-api is published with them (this repository has ^0.2.0, which lacks them). Delete this file
 * once it is: import `StartChatOptions`, `ChatAnswer`, `ChatOwner` and `RequestPerson` from
 * "@pithagoras/extension-api/server", and use `portal()` of host.ts wherever `portal339()` is used now.
 *
 * Shapes as packages/extension-api/server.d.ts of #339 declares them, only the parts Office reads.
 */
import type { IncomingMessage } from "node:http";
import type { AgentFolder, Chat, ServerPortal } from "@pithagoras/extension-api/server";
import { portal } from "./host";

/** What a chat a package starts in a folder is made with (`chats.start`). */
export interface StartChatOptions {
  /** The folder of an agent or a project, by its path as `folders.list()` gives it. */
  folder: string;
  title: string;
  /** Whether it shows in the chat lists; `false` only with `unattended: true`. */
  listed?: boolean;
  /** A chat nobody attends: no ask_question, every dialog answered at once with its no-answer value, the guard refusing
   * a held call rather than asking, the folder's default tools. */
  unattended?: true;
}

/** Where the last run of a chat a package made stands (`chats.lastAnswer`). */
export interface ChatAnswer {
  status: "running" | "done" | "stopped" | "error";
  answer: string;
  marked?: true;
  error?: string;
}

/** A folder as `folders.list()` gives it, with the mark of the home New starts the person's chats in. */
export type FolderEntry = AgentFolder & { newChats?: true };

/** Whose a chat is (`chats.owner`): an agent's home or a project's folder, as `folders.list()` gives it. */
export type ChatOwner = FolderEntry & { kind: "agent" | "project" };

export type PersonRole = "primary" | "colleague" | "guest" | "unknown";

/** Who is behind a request to the package's routes (`http.person`). */
export interface RequestPerson {
  id: string;
  name: string;
  role: PersonRole;
}

/** What #339 adds, first, so that its `folders.list` (with `newChats`) is the one a call resolves to. */
type Added = {
  chats: {
    start(options: StartChatOptions): Chat;
    lastAnswer(chatId: string): ChatAnswer | undefined;
    owner(chatId: string): ChatOwner | undefined;
  };
  folders: { list(): FolderEntry[] };
  http: { person(req: IncomingMessage): RequestPerson | undefined };
};

export type Portal339 = Added & ServerPortal;

/** The portal, typed with what #339 adds. Whether this portal has it is host.ts `missingApi()`'s to say. */
export const portal339 = (): Portal339 => portal() as unknown as Portal339;
