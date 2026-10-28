# Nextcloud Extension — Concept

One extension that **installs and runs the Nextcloud MCP server** for you and gives the portal a full UI on top of it. You only ever enter **URL, user, app-password** in the settings page; everything else (container, MCP registration, panels) is automatic.

## 1. What we build on

- **MCP server**: [cbcoutinho/nextcloud-mcp-server](https://github.com/cbcoutinho/nextcloud-mcp-server) — Python, AGPL-3.0, 110+ tools across Notes (7), Calendar (20+), Contacts (8), Files/WebDAV (14), Deck (15), Cookbook (13), Tables (5), Sharing (10+), News (8), Mail (13), Collectives (16), Talk (6), Shopping List (12).
  - Docker image: `ghcr.io/cbcoutinho/nextcloud-mcp-server` (internal port **8000**, endpoint **`/mcp`**, streamable-HTTP).
  - Config via env: `NEXTCLOUD_HOST`, `NEXTCLOUD_USERNAME`, `NEXTCLOUD_PASSWORD` (README explicitly recommends an **app password**).
- **Reference extension**: `@pithagoras/office` in this repo — the exact pattern we copy (two halves, docker helper, settings page, MCP-style direct API calls from panels).

### Current setup (what this replaces)

Simeon already runs two manual containers (`127.0.0.1:18000→8000` for `piggidragon@tbug.elyros.de`, `127.0.0.1:18001→8000` for `piggidragon-uni@…`) plus a hand-written `/root/.pi/agent/mcp.json`. v1 targets **one instance** (the main account); multi-instance is a follow-up. The extension can optionally **adopt** an existing container (`dockerFor.adopt`) to migrate without downtime — see §9.

## 2. Architecture

Standard Pithagoras split (see office):

```
┌─ portal process ─────────────────────────────┐   ┌─ server process (isolated) ────────────┐   ┌─ docker container ───────────────────────┐
│ client.tsx                                   │   │ server.ts                               │   │ nextcloud-mcp-server                    │
│  · chat.panel "nextcloud" (tab bar, §4)      │   │  · pithagoras-docker: create/manage     │   │ ghcr.io/…/nextcloud-mcp-server         │
│  · settings.page (auto-restored): url, user, │◄─┤    container + loopback forwarder       │◄─┤ env: NEXTCLOUD_HOST/USERNAME/PASSWORD   │
│    password                                  │REST│  · portal.mcp.set(...) registers the    │HTTP│ /mcp (port 8000)                       │
│  · fetch("/api/x/nextcloud/*")               │──►│    MCP entry in pi's mcp.json           │──►└──────────────┬─────────────────────────┘
└──────────────────────────────────────────────┘   │  · REST: status, tool call proxy (§4.3) │                  ▼ reaches Nextcloud host
                                                   └─────────────────────────────────────────┘        (tailnet/LAN/whatever url is)
```

- **Client half** (`pithagoras.client` in package.json): UI only. Talks to our own REST API, never to Nextcloud directly. No secrets on the client beyond what the settings page already holds.
- **Server half** (`pithagoras.server`, runs isolated in its own process with a 512 MB heap cap): owns the container, owns the MCP registration, serves `/api/x/nextcloud/*`. It is also where `portal.mcp.set()` goes — the extension that owns the server lifecycle is the right owner of its mcp.json entry.

## 3. Container management (server half)

Via **`pithagoras-docker`** (`requires: { "pithagoras-docker": "^1.3.0" }`, exactly like office):

- `dockerFor.containers.create()` → pinned image tag, env from settings, port on the helper's loopback forwarder (same mechanism office uses for DocServer).
- **Network**: use `dockerFor.networks.sharedNetwork()` — *not* the isolated default. The MCP container must have **egress to `NEXTCLOUD_HOST`**; the isolated network is deliberately cut off and would break it. Exposure stays tight: only loopback forwarder on the host, container itself reaches nothing except Nextcloud + (pinning caveat: keep a fixed image tag per install, update = explicit re-save).
- Lifecycle: create on first settings save; recreate (re-apply env) when `url`/`username` changes; restart/re-pull only via an explicit "update" action in the settings page; stop + remove container when the extension is disabled/uninstalled.
- Health: poll the forwarder's `/mcp` (or image healthcheck) and surface running/stopped/error in both the settings page and the panel header.

## 4. UI: one panel, seven tabs

Registered as **one** `portal.slots.set("chat.panel", …)` with id `nextcloud` (like office's single panel) and an internal tab bar — matches "one sidebar tab for everything the MCP offers" without flooding every chat with eight nav entries. Deep-linking later: `portal.panels.open("nextcloud")` + `useShown()`.

| Tab | MCP tool group | UI sketch |
|---|---|---|
| **Files** | Files/WebDAV (14) + Sharing (10+) | Path breadcrumb + file list; click → preview/download for pdf/image, download otherwise; sub-view "Shares" listing who-what with create-share dialog. See §5 for integration with the shipped Files extension. |
| **Deck** | Deck (15) | Board picker → stack columns with cards; rename/create/reorder; labels/assignees shown as badges. |
| **Notes** | Notes (7) | Left: note list + keyword search; right: content, edit/save/delete. |
| **Calendar** | Calendar (20+) | Month grid or day list of events (+todos sub-tab); click event → details/edit form (date, summary, location, description). |
| **Contacts** | Contacts (8) | Address book picker → contact list; detail view with editable CardDAV fields. |
| **Cookbook** | Cookbook (13) | Recipe grid/list → detail (ingredients, steps); "import from URL" action (schema.org). |
| **Shopping List** | Shopping List (12) | List picker → checkable items; add/remove/clear-checked; (nice-to-have: "add recipe ingredients" using the one-call tool). |

### 4.3 How panels call the MCP server

The panel needs data *directly* (not through the LLM), so it speaks streamable-HTTP to the same running container that pi talks to — no second implementation of any feature:

```ts
import { mcpClient } from "./shared/mcp.js"; // already exists in this repo
const mcp = mcpClient(serverAddress /* e.g. http://127.0.0.1:<port>/mcp */);
const r = await mcp.tools.call("list_files", { path: "/" });
// result content parts are text carrying JSON → parse
```

Two layers, both behind our REST API (the client never holds the container address):

1. **Tool-call proxy**: `POST /api/x/nextcloud/tool { name, args }` — server half forwards to the container with `tools.call`, returns normalized result. Covers *every* MCP feature automatically (even future tools).
2. **Convenience endpoints** where a tab needs composites: e.g. `/files?path=` merges `list_files` + share list; `/shopping/nextcloud-<id>/add-items`. Keep these thin; the tool name is still the single source of truth.

Tool names are hardcoded per tab (stable, documented by the server) with a fallback: on `unknown tool` error, call `mcp.listTools()` once and re-render an "update available" hint rather than failing silently.

## 5. Files + the shipped extension — proposed core changes

The shipped Files extension (`pithagoras-files`, lives in the **Pithagoras core repo**, not here) is chat-workspace-scoped: its client drives off `portal.chats.use(chat.id)` and renders only files under the chat's workspace folder. It registers a `chat.panel` ("files") + voice window, but **exposes no provider hook** — so we cannot render an arbitrary WebDAV tree inside it from an extension today.

**Design decision: v1 works with zero core changes** (own "Files" tab in our panel, §4), and the shipped-extension integration is a *separate, optional* core PR that makes it nicer. Both are listed; neither blocks shipping.

### Core change A — Files source provider (the one you asked about)

Filed as [thecodacus/pithagoras#344](https://github.com/thecodacus/pithagoras/issues/344).

In the core repo's files extension, add an injection point so other extensions can mount additional file trees into the existing Files tab:

```ts
// pithagoras-files server half (core): new optional capability
export type FilesSource = {
  id: string;              // "nextcloud"
  label: string;
  list(path: string): Promise<FileEntry[]>;
  read(path: string): Promise<{ content?: string, binary?: Buffer }>;
  url?(path: string): string;          // for download/open links
  write?(path: string, data: ...): Promise<void>;   // optional → tab shows read-only if absent
};
// client half (core): portal.provide("pithagoras-files-sources", factory) consumed by FilesPanel
```

Then in `pithagoras-nextcloud`:

```jsonc
// package.json
"requires": { "pithagoras-docker": "^1.3.0", "pithagoras-files": "*" }
// server.ts
portal.use("pithagoras-files-sources")?.register(nextcloudFilesSource);
```

Result: the **existing** Files tab gains a "Nextcloud" root next to workspace folders; opening a file works everywhere (chat panel, voice window). Fallback if this PR stalls or lands late: our own Files tab is already there and gets hidden/flagged-redundant once A ships.

### ~~Core change B — settings page secret masking~~ (not needed)

Resolved without a core change: the extension renders its **own** settings page component (`src/web/settings-page.tsx`), which already uses `type="password"` with "(set — leave empty to keep it)" semantics — the password is only ever set, never shown back.

**Bottom line:** nothing is *required* for a fully working v1. The only proposed core change is A ([#344](https://github.com/thecodacus/pithagoras/issues/344)). Per Simeon's decision (2026-10): core changes stay **issues for now, implemented separately later** — the extension never blocks on them.

## 6. MCP registration for pi

Server half writes the entry once per settings change:

```ts
await portal.mcp.set({
  url: `${serverAddress}/mcp`,       // loopback forwarder address from pithagoras-docker
  lifecycle: "persistent",           // same as the current manual entry
  trusted: true,                     // self-installed, pinned image; skips Guard review
});
```

- `directTools` stays **off**: 120+ tools eager would burn ~40k tokens per chat context — lazy discovery via pi-mcp-adapter is the point. (Matches current mcp.json.)
- **Advanced setting** `mcp.excludeTools` (string list, default reflects what Simeon uses now: Mail/News/Collectives/Talk tables): applied in the same `mcp.set` call. Keeps context slim without hiding anything from the panels — panels always talk to the full server directly.
- Uninstall/disable → `portal.mcp.set(null)` cleans the entry; container removed per §3.

## 7. Settings (user-visible)

Auto-restored settings page (static defaults in code, per the package-source heuristic — keep defaults as literals so restore sees them):

| Key | Field | Notes |
|---|---|---|
| `url` | Nextcloud URL | e.g. `https://tbug.elyros.de`; changed → container recreated |
| `username` | username | |
| `password` | app password | hint: Settings ▸ Security ▸ Devices & sessions; core change B for masking |
| `mcp.excludeTools` | (advanced) comma list | default: `mail, news, collectives, talk` tool groups as in current mcp.json |

Status block on the same page: container state, MCP server health, "pi is connected via mcp.json ✓/✗", actions **Update image / Restart**.

## 8. Security posture (Aegis-default: local/self-hosted)

- Self-hosted container, loopback-only forwarder; the only network peer it ever talks to is your own Nextcloud.
- AGPL-3.0 of the MCP server is fine as a separate process/image — no license coupling with the Apache-2.0 extension code.
- `trusted: true` bypasses Guard for this server; justified by pinned image + self-hosted + user-owned credentials. Alternative (keep untrusted → per-call Gate review) available as a setting if someone wants maximum friction.
- No secrets leave the settings page; server half passes them only into container env, never logs/REST responses.

## 9. Phasing

1. **Phase 1 — plumbing + reads**: scaffold (`@pithagoras/nextcloud`), docker lifecycle §3, mcp registration §6, settings page §7, tool-proxy REST API; panels: Shopping List, Cookbook (simplest, read+tick), Notes.
2. **Phase 2 — the big tabs**: Files (+Shares), Deck, Calendar, Contacts with their CRUD forms.
3. **Phase 3 — integrations**: core change A (Files source hook), optional adoption of Simeon's existing 18000/18001 containers (`dockerFor.adopt`), multi-instance support if the uni account stays a need.

## 10. Open questions

- Multi-instance from day one or Phase 3? (Current manual setup has two accounts; v1 spec says main account only.)
- Adopt existing containers on install, or always own a fresh one?
- Core change B: confirm current masking behavior of the generated settings page before scoping.
- Calendar tab UX: month grid (heavier) vs day list + week strip (cheaper) — decide in Phase 2.
