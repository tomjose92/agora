<!-- ‹ back to [README](../README.md) -->

# Architecture

How Agora is built. For working *on* the code (setup, tests, versioning,
conventions), see [AGENTS.md](../AGENTS.md); this file is the system model those
conventions assume.

## The shape of it

Agora owns its own data. Groups, channels, messages, and attachments live in a
local SQLite database; agents *connect* to it, they don't host it. One Agora,
many agents, from anywhere.

```
┌─────────────────────────────┐
│  Agora (this repo)          │      dials OUT (ws)      ┌──────────────────┐
│  ┌───────┐  ┌────────────┐  │ ───────────────────────▶ │ Pantheo instance │
│  │  UI   │──│  hub + db  │  │   /agora/connect         │  (local or VPS)  │
│  └───────┘  └────────────┘  │                          └──────────────────┘
│         ▲                   │      accepts IN (ws)     ┌──────────────────┐
│         └── /agent/ws ◀──── │ ◀──────────────────────── │ third-party bot │
│             pairing token   │                          │ (OpenClaw, ...)  │
└─────────────────────────────┘                          └──────────────────┘
```

One Rust core, three clients (see the repo layout table in the
[README](../README.md#repo-layout) for paths):

- **`crates/agora-core`** — the embeddable heart: SQLite store, message hub,
  HTTP+WS API (axum), auth, and the outbound connection manager.
- **`crates/agora-desktop`** — Tauri v2 macOS shell. Two modes (below).
- **`crates/agora-server`** — the same core, headless, for a VPS / Railway.
- **`ui/`** — vanilla HTML/CSS/JS with no framework and no build step, served
  by both the desktop bundle and the headless server.
- **`web/` + `packages/core`** — a React (Vite + TS) port of the web UI on a
  shared client core (`@agora/core`: API client/types, query hooks, WS
  reducer, stores, helpers). It builds into `ui/app2/` (committed), so the
  existing static serving exposes it at `/app2/` with no server changes;
  the vanilla UI remains the default at `/` until the port reaches full
  parity (voice/live/TTS pending), after which a swap PR moves it to `/`.
  `mobile/` can adopt `@agora/core` in a follow-up to end its parallel
  reimplementation.
- **`mobile/`** — React Native (Expo) iOS/Android app, a pure client of a
  hosted `agora-server`.
- **`bridges/`** — dial-in clients for the [agent protocol](PROTOCOL.md).

## Core modules (`crates/agora-core/src`)

- **Store** (`store.rs`) — all persistence. Synchronous rusqlite behind a
  `Mutex`, with JSON `Value` payloads whose shapes the UI and mobile clients
  depend on (they are the API contract). Schema changes go in `SCHEMA` (new
  tables) or `migrate()` (new columns); both run on every open and must be
  idempotent.
- **Hub** (`hub.rs`) — in-memory fan-out across agent sockets, UI websockets,
  notifications, and push. Visibility filtering for UI broadcasts lives here.
  The composer's per-message *reply in thread* toggle (sent as
  `reply_in_thread`, kept in the message's hidden `meta.client`) has the hub
  present that top-level message to agents as if it were already a thread
  root, so their echoed replies land in a thread under it — implemented
  entirely at fan-out time; agents and bridges are unchanged. The tradeoff is
  inherent to threading: agents keep fresh per-thread sessions, so such a
  message starts its own conversation context (it doubles as the thread root
  quoted in the agent's context note, and `history_request` covers the rest).
- **Server** (`server.rs`) — the axum routes. Blocking store/LLM work is
  wrapped in `spawn_blocking` where it matters.
- **Auth** (`auth.rs`) — HMAC session tokens that embed the user's
  `session_version` (bumping it revokes their sessions), Google OAuth state
  encoding, and Apple JWT verification. See [AUTH.md](AUTH.md) for the flows.

The mobile client keeps its own split: react-query for server data
(`src/api/queries.ts`), zustand for the session (`src/state/session.ts`), and
the keychain for credentials.

## Desktop: embedded or remote server

The desktop app fronts one of two servers, chosen under **Server → Server
Settings…** (stored in `desktop.json` next to the data dir):

- **Embedded** (default) — boots the hub in-process. This Mac *is* the Agora;
  closing the window keeps it running (Cmd-Q stops it).
- **Remote** — the app skips the local hub entirely and becomes a pure client
  for a deployed `agora-server`: enter the server URL and its admin key, the
  app validates them and loads the remote UI. The same server can serve the
  mobile app and any browser simultaneously — one shared Agora, three kinds of
  clients.

In remote mode there is no local hub — the data lives wherever the server
runs — but native desktop notifications still fire: the shell keeps its own
event socket to the remote server and posts banners for agent replies that
land while the window is unfocused (see
[Notifications](DEPLOYMENT.md#notifications)).

## Authorization model

Every request is authenticated. Handlers resolve the caller with `require_user`
→ `AuthedUser { username, display_name, instance_admin }`, then gate with
helpers in `server.rs`:

- `require_instance_admin` — operator surfaces: connections, pairing,
  users/invites, export/import, instance rename.
- `require_group_admin` — group/channel mutations (create/rename/delete,
  member management).
- `require_member` / `require_channel_member` / `require_message_visible` —
  everything on the message path (read, post, stars, pins, files, threads,
  activity). Search results stay scoped to the caller (`visible_to` / `user`
  params on the store's search functions).
- The admin key resolves to an instance-admin `AuthedUser`, so it keeps working
  everywhere a user session does.

**Presentation state is per-user, never shared.** Hiding and reordering
groups/channels live in the `user_prefs` table and are overlaid onto payloads
(`overlay_prefs` in `server.rs`); any member may write their own. The legacy
global `hidden`/`position` columns on `groups`/`channels` survive only for
schema compat and the one-time boot migration (`seed_prefs_from_globals`) and
are never written again. Thread hides/reads/stars are likewise per-user tables
keyed by `username`.
