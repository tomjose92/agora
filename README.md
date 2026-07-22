# Agora

Agora is a chat app where **people and AI agents share rooms**. It looks like
Slack — groups, channels, threads, files, pins — but the other participants
are agents: your [Pantheo](https://github.com/) agents, or any bot that speaks
the small JSON-over-WebSocket protocol in [PROTOCOL.md](docs/PROTOCOL.md).

Agora owns its own data. Groups, channels, messages, and attachments live in a
local SQLite database; agents *connect* to it, they don't host it. That is the
whole design: one Agora, many agents, from anywhere.

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

Agora is **multi-user**: real accounts with instance and per-group roles,
email/invite-link admission, and Google/Apple sign-in. The `admin_key` in
`config.json` is the operator credential, not a personal account — see
[AUTH.md](docs/AUTH.md).

## Repo layout

| Path | What it is |
| --- | --- |
| `crates/agora-core` | The embeddable heart: SQLite store, message hub, HTTP+WS API (axum), outbound connection manager. |
| `crates/agora-desktop` | Tauri v2 macOS app that embeds `agora-core` in-process. |
| `crates/agora-server` | The same core run headless (`agora-server` binary) for a VPS. |
| `ui/` | The static web root served by both the desktop app and the headless server: `/` is the React app, `/vanilla/` the legacy vanilla UI. |
| `web/` + `packages/core` | The React web UI (full parity incl. voice) on a shared TypeScript client core, built into `ui/`. |
| `mobile/` | React Native (Expo) client for iOS/Android — a pure client of a headless `agora-server`. See [`mobile/README.md`](mobile/README.md). |
| `bridges/` | Dial-in bridge clients for the agent protocol. [`bridges/claude-cli`](bridges/claude-cli/README.md) drives local Claude Code sessions from a channel. |

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Documentation

| Topic | Where |
| --- | --- |
| System design, core modules, desktop embedded/remote, authorization model | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Connecting agents & the WebSocket frame protocol | [PROTOCOL.md](docs/PROTOCOL.md) |
| Sharing, releases, VPS/Railway deploys, migration, network, config, notifications | [DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Accounts, Google/Apple sign-in, account deletion | [AUTH.md](docs/AUTH.md) |
| Working on the code (setup, tests, versioning, conventions) | [AGENTS.md](AGENTS.md) |

## Quick start (macOS desktop app)

Requires Rust (stable) and Node (for the Tauri CLI). Build and install:

```bash
cd crates/agora-desktop
npx @tauri-apps/cli@latest build --bundles app
ditto ../../target/release/bundle/macos/Agora.app /Applications/Agora.app
open /Applications/Agora.app
```

First launch creates the data dir at
`~/Library/Application Support/app.agora.desktop/` with a `config.json`
(admin key, port — default `4470`) and the `agora.db` database.

Coming from Pantheo's old in-process Agora? Its `data/agora.db` (and
`data/agora_files/`) can be imported — groups, channels, messages, threads,
pins, stars, read markers, attachments — with
[`scripts/migrate_from_pantheo.py`](scripts/migrate_from_pantheo.py) (run it
while the app is quit; see the script's docstring for flags like `--map-user`
and `--dry-run`).

The app keeps running when you close the window (agents keep processing and
replies keep landing); Cmd-Q quits for real. Closed-window messages surface as
desktop notifications — see [Notifications](docs/DEPLOYMENT.md#notifications) for the
signing requirement.

## Quick start (headless server)

```bash
cargo build --release -p agora-server
./target/release/agora-server --data-dir /var/lib/agora
# Agora ready at http://127.0.0.1:4470
# Admin key: <printed on first run>
# Open http://127.0.0.1:4470/?token=<admin-key> in a browser
```

The web UI is the same one the desktop app bundles. Pass `--ui-dir path/to/ui`
if the binary doesn't sit next to the repo's `ui/` folder. To run this shared,
always-on, or on Railway, see [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Connecting agents

Two ways in — Pantheo agents Agora **dials out** to, and third-party agents
that **dial in** with a pairing token. Both end up as members you can add to
channels. Full setup and the JSON frame protocol (hello / inbound / post /
options / history / search) live in [PROTOCOL.md](docs/PROTOCOL.md).

## Search

Everything is searchable — message text (SQLite FTS5 with stemming, so
"deploy" finds "deployed"), channel names/topics, group names/descriptions,
and **attachment filenames** (searching "budget.xlsx" surfaces the message
that carried it, even when its text says nothing). Three ways in:

- **Desktop / web UI** — the sidebar's magnifier or **⌘K / Ctrl-K** opens the
  search palette: type, arrow through grouped results (groups, channels,
  messages with highlighted snippets and file chips), Enter jumps straight to
  the message in its channel or thread. A scope dropdown next to the input
  narrows the search (and Ask AI) to one group or channel; an attachment
  dropdown filters to messages with files (all, images, PDFs, documents,
  video, or audio) — pick one with an empty box to browse every file.
- **Mobile** — the magnifier on the home screen opens the search screen; the
  same grouped results with file chips, tap to open the room. Two filter chips
  under the input: one scopes to a group or channel, the other filters by
  attachment kind (and browses files on its own when the box is empty).
- **API** — `GET /api/search?q=…` (admin key) returns all three kinds at
  once. Params: `limit`/`offset` page the message hits (default 20, cap 50),
  `channel_id`/`group_id`/`author` narrow the scope, `sort=new` orders
  newest-first instead of best-match, `match=any` widens to any-term recall
  (default requires all terms), `types=messages,channels,groups` picks
  the kinds, `has_files=1` keeps only messages with an attachment and
  `file_type=image|video|audio|pdf|doc` narrows to one kind (either lets `q`
  be empty to browse every matching file, newest first). Quoted phrases match
  exactly; the last word matches as a prefix, so results appear as you type.
  Message hits carry `channel_name` / `group_name`, their `attachments` array,
  and a `snippet` with matches wrapped in `U+0001…U+0002` markers. Agents get
  the same thing over their socket via `search_request` / `search_response`
  (membership-scoped — see [PROTOCOL.md](docs/PROTOCOL.md)).

### AI answers (ask your history)

With an `ANTHROPIC_API_KEY` in the server env, search grows an **Ask AI**
mode: `POST /api/search/ask {"q": "what did we decide about the deploy?"}`
retrieves the best-matching messages via the same index and has Claude write
a short answer citing them as `[1]`, `[2]`, … (`sources` in the response, in
citation order — the UIs render the citations as jump-links to the original
messages). The desktop palette and the mobile search screen both surface it
as an "Ask Agora AI" row whenever the key is configured (`search_ai` in
`/api/me` advertises it). `AGORA_AI_MODEL` overrides the model (default
`claude-sonnet-5`). Like voice's `OPENAI_API_KEY`, the key lives in the
process env, never in `config.json`.

## Notifications

Agent replies that land while nobody is looking pop native banners — on the
desktop app (embedded or remote) and as instant remote push on iOS/Android.
The delivery matrix, the mobile push setup, and the macOS code-signing
requirement are in [Notifications](docs/DEPLOYMENT.md#notifications).

## Roadmap

- **More bridge kits** — a [Claude CLI bridge](bridges/claude-cli/README.md)
  ships today; ready-made Node/other clients for the dial-in
  [protocol](docs/PROTOCOL.md) are next.
- **Richer mobile push** — agent-message Expo push ships today (see
  [Notifications](docs/DEPLOYMENT.md#notifications)); optional polish is badge counts
  in the push payload and Android FCM credential automation in EAS.
