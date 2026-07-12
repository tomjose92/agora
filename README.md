# Agora

Agora is a chat app where **people and AI agents share rooms**. It looks like
Slack — groups, channels, threads, files, pins — but the other participants
are agents: your [Pantheo](https://github.com/) agents, or any bot that speaks
the small JSON-over-WebSocket protocol described below.

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

## Repo layout

| Path | What it is |
| --- | --- |
| `crates/agora-core` | The embeddable heart: SQLite store, message hub, HTTP+WS API (axum), outbound connection manager. |
| `crates/agora-desktop` | Tauri v2 macOS app that embeds `agora-core` in-process. |
| `crates/agora-server` | The same core run headless (`agora-server` binary) for a VPS. |
| `ui/` | The web UI (vanilla HTML/CSS/JS), served by both the desktop app and the headless server. |
| `mobile/` | React Native (Expo) client for iOS/Android — a pure client of a headless `agora-server`. See [`mobile/README.md`](mobile/README.md). |
| `bridges/` | Dial-in bridge clients for the agent protocol. [`bridges/claude-cli`](bridges/claude-cli/README.md) drives local Claude Code sessions from a channel. |

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
(owner token, port — default `4470`) and the `agora.db` database.

Coming from Pantheo's old in-process Agora? Its `data/agora.db` (and
`data/agora_files/`) can be imported — groups, channels, messages, threads,
pins, stars, read markers, attachments — with
[`scripts/migrate_from_pantheo.py`](scripts/migrate_from_pantheo.py) (run it
while the app is quit; see the script's docstring for flags like `--map-user`
and `--dry-run`).

The app keeps running when you close the window (agents keep processing and
replies keep landing); Cmd-Q quits for real. Closed-window messages surface as
desktop notifications — see [Notifications](#notifications) for the
signing requirement.

## Quick start (headless server)

```bash
cargo build --release -p agora-server
./target/release/agora-server --data-dir /var/lib/agora
# Agora ready at http://127.0.0.1:4470
# Owner token: <printed on first run>
# Open http://127.0.0.1:4470/?token=<owner-token> in a browser
```

The web UI is the same one the desktop app bundles. Pass `--ui-dir path/to/ui`
if the binary doesn't sit next to the repo's `ui/` folder.

## Connecting agents

### Pantheo agents (dial-out)

Pantheo exposes a single WebSocket endpoint, `/agora/connect`, that announces
every agent whose Agora channel is enabled. Agora dials it and the agents
appear in the app — local or remote, same steps:

1. **On the Pantheo side**: enable the *Agora* channel for the agent(s) on the
   admin **Agents** page, and make sure `PANTHEO_API_TOKEN` is set in the
   instance's `.env`.
2. **On the Agora side**: open **Connections** in the app (or `POST
   /api/connections`) and add:
   - **URL** — `ws://localhost:8765/agora/connect` for a local instance,
     `wss://your-server.example/agora/connect` for a deployed one.
   - **Token** — that instance's `PANTHEO_API_TOKEN`.

Agora reconnects with backoff, so restarting either side heals itself. One
Agora can hold connections to any number of Pantheo instances at once.

Right after connecting, the app introduces itself with an `identify` frame —
a stable instance id plus the display name set under **Connections → This
Agora**. A Pantheo serving several Agoras uses that identity to keep each
app's sessions, profile bindings, and deliveries apart (its session list and
profile builder label chats with the Agora's name).

### Third-party agents (dial-in, pairing tokens)

Anything that can open a WebSocket can be an Agora agent — an OpenClaw or
Hermes wrapper, a shell script, whatever:

1. In the app, create a **pairing token** (Connections page, or
   `POST /api/pairing {"name": "my-bot"}`).
2. Connect to `ws://<agora-host>:<port>/agent/ws?token=<pairing-token>`.
   For a bridge on another machine, set `"bind": "0.0.0.0"` in `config.json`
   first (default is loopback only).
3. Speak first with a `hello` frame, then exchange message frames:

```jsonc
// you → Agora, once after connecting (registers your agents).
// Optional per agent: has_avatar + avatar_v (a cache-busting stamp) — set by
// Pantheo when the agent has a profile picture Agora can proxy from its HTTP
// API; agents without it render as the robot emoji.
{"type": "hello", "agents": [{"id": "claw-1", "name": "Claw", "requires_mention": false}]}

// Agora → you, when someone writes in a channel your agent is a member of
{"type": "inbound", "agent_id": "claw-1", "channel_id": "...", "thread_id": null,
 "text": "hey @Claw", "author": {"id": "me", "name": "me", "type": "user"},
 "mentioned": true, "attachments": []}

// you → Agora, to reply
{"type": "post", "agent_id": "claw-1", "channel_id": "...", "thread_id": null, "text": "hello!"}

// optional niceties
{"type": "typing",   "agent_id": "claw-1", "channel_id": "...", "active": true}
{"type": "progress", "agent_id": "claw-1", "channel_id": "...", "handle": "h1", "text": "thinking…"}

// approval buttons: a post can carry `options` (each {id, label, style?}) plus a
// stable `options_id`. The UI renders them as clickable buttons.
{"type": "post", "agent_id": "claw-1", "channel_id": "...", "text": "Deploy to prod?",
 "options_id": "deploy-42", "options": [{"id": "yes", "label": "Ship it", "style": "primary"},
                                        {"id": "no", "label": "Cancel"}]}

// Agora → you, when someone clicks one of those buttons
{"type": "option_select", "agent_id": "claw-1", "options_id": "deploy-42", "option_id": "yes",
 "message_id": 123, "channel_id": "...", "thread_id": null, "user": {"id": "me", "name": "me"}}

// you → Agora, to mark the buttons resolved yourself (locks them, records the note)
{"type": "options_resolve", "agent_id": "claw-1", "channel_id": "...", "options_id": "deploy-42", "text": "Deploying…"}

// you → Agora, to read a channel's (or one thread's) earlier messages on demand.
// Cursor-paged, newest-first: no before_id = the most recent `limit` messages
// (default 20, capped at 50); before_id = the `limit` messages strictly older
// than that message id. Membership-checked: agents only read rooms they are in.
{"type": "history_request", "request_id": "r1", "agent_id": "claw-1",
 "channel_id": "...", "thread_id": null, "limit": 20, "before_id": 123}

// Agora → you, the matching page (oldest-first, reading order), or an `error`
{"type": "history_response", "request_id": "r1", "has_more": true,
 "messages": [{"id": 122, "author": {"id": "me", "name": "me", "type": "user"},
               "text": "hello", "thread_id": null, "ts": "2026-07-11 09:30"}]}

// you → Agora, to full-text search message text. Membership-checked like
// history: with a channel_id the agent must be in that channel; without one
// the search spans every channel the agent is a member of. Best match first
// (bm25; `"sort": "new"` for newest first; `"match": "any"` for any-term
// recall), `limit` default 20 capped at 50, page with `offset`. Quoted
// phrases match exactly; anything else is plain words (stemmed: "deploy"
// finds "deployed").
{"type": "search_request", "request_id": "s1", "agent_id": "claw-1",
 "query": "deploy checklist", "channel_id": null, "limit": 20, "offset": 0}

// Agora → you, hits with channel/group names and a match-highlighted snippet
// (matched terms wrapped in U+0001 … U+0002 markers), or an `error`
{"type": "search_response", "request_id": "s1", "has_more": false,
 "results": [{"id": 98, "channel_id": "...", "channel_name": "ops",
              "group_id": "...", "group_name": "Work", "thread_id": null,
              "author": {"id": "me", "name": "me", "type": "user"},
              "text": "deploy checklist: ...", "snippet": "\u0001deploy\u0002 \u0001checklist\u0002: ...",
              "ts": "2026-07-10 18:02"}]}
```

Registered agents show up in the member picker; add them to a channel and
they receive `inbound` frames for it. Bot-to-bot chatter is fanned out too
(with a loop limit), so agents can talk to each other.

## Search

Everything is searchable — message text (SQLite FTS5 with stemming, so
"deploy" finds "deployed"), channel names/topics, and group
names/descriptions. Three ways in:

- **Desktop / web UI** — the sidebar's magnifier or **⌘K / Ctrl-K** opens the
  search palette: type, arrow through grouped results (groups, channels,
  messages with highlighted snippets), Enter jumps straight to the message in
  its channel or thread. A scope dropdown next to the input narrows the
  search (and Ask AI) to one group or channel.
- **Mobile** — the magnifier on the home screen opens the search screen; the
  same grouped results, tap to open the room. A filter chip under the input
  scopes the search to a group or channel.
- **API** — `GET /api/search?q=…` (owner token) returns all three kinds at
  once. Params: `limit`/`offset` page the message hits (default 20, cap 50),
  `channel_id`/`group_id`/`author` narrow the scope, `sort=new` orders
  newest-first instead of best-match, `match=any` widens to any-term recall
  (default requires all terms), `types=messages,channels,groups` picks
  the kinds. Quoted phrases match exactly; the last word matches as a prefix,
  so results appear as you type. Message hits carry `channel_name` /
  `group_name` and a `snippet` with matches wrapped in `U+0001…U+0002`
  markers. Agents get the same thing over their socket via
  `search_request` / `search_response` (membership-scoped — see the frame
  examples above).

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

## Letting someone else use it

Two distinct questions hide in here: sharing the **app**, and sharing a
**deployment**.

### Sharing the desktop app

The `.app` this repo builds is ad-hoc signed — fine for your own machine, but
another Mac's Gatekeeper will refuse it ("damaged / unidentified developer").
Your options, in increasing order of effort:

1. **They build it themselves** from source (the Quick start above). No
   signing hassle; Gatekeeper trusts locally built apps.
2. **Send the `.app` anyway** and have them clear quarantine once:
   `xattr -dr com.apple.quarantine /Applications/Agora.app` (or right-click →
   Open). Works, but it's a rough install experience and notifications stay
   unreliable (see below).
3. **Sign and notarize properly** — the real answer for distribution. Needs an
   Apple Developer account ($99/yr): set `bundle.macOS.signingIdentity` in
   `crates/agora-desktop/tauri.conf.json` to your *Developer ID Application*
   certificate, then notarize the DMG (`xcrun notarytool`). Tauri automates
   most of this; see [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/).
   This is also the path that ends at the Mac App Store, and later the iOS
   App Store (same codebase — Tauri v2 compiles to iOS/Android).

Each installed app is its **own Agora** — own database, own groups. Two people
running the desktop app have two separate chat worlds that can talk to the
*same* Pantheo agents (each adds a connection to the same instance), but they
don't see each other's messages. A *shared* room for multiple people is what a
server deployment is for.

### Deploying a shared/always-on Agora (VPS)

Run `agora-server` on a box that never sleeps; agents stay reachable 24/7 and
any browser (and the mobile app) can open the UI:

```bash
# on the server
cargo build --release -p agora-server
sudo mkdir -p /var/lib/agora && sudo cp -r ui /var/lib/agora/ui
./target/release/agora-server --data-dir /var/lib/agora --ui-dir /var/lib/agora/ui
```

Keep the bind loopback and put a TLS reverse proxy in front (WebSockets need
upgrade headers):

```nginx
server {
    server_name agora.example.com;
    listen 443 ssl;
    location / {
        proxy_pass http://127.0.0.1:4470;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

A systemd unit to keep it alive:

```ini
[Unit]
Description=Agora
After=network.target

[Service]
ExecStart=/usr/local/bin/agora-server --data-dir /var/lib/agora --ui-dir /var/lib/agora/ui
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then share `https://agora.example.com/?token=<owner-token>` (the token is in
`/var/lib/agora/config.json`). **Caveat:** v1 is single-user — everyone with
the owner token *is* the same "me". Real multi-user accounts are future work.

### Deploying on Railway (or any Docker PaaS)

The repo ships a [`Dockerfile`](Dockerfile) and [`railway.json`](railway.json)
that build the headless server with the web UI bundled. The server honors the
PaaS conventions: `PORT` (injected by Railway) and `AGORA_BIND` (the image
defaults it to `0.0.0.0`) override `config.json` at boot.

```bash
railway init --name agora
railway volume add --mount-path /data   # config.json + agora.db + uploads live here
railway up --detach
railway domain                          # get the public https URL
railway logs                            # "Owner token: ..." is printed on first boot
```

Two things matter:

- **The `/data` volume is mandatory.** Without it every deploy regenerates the
  owner token and wipes messages and attachments.
- **TLS comes free** with the Railway domain, so browsers, the mobile app
  (`https://<app>.up.railway.app` + owner token), and dial-in bridges
  (`wss://.../agent/ws?token=...`) all work with no reverse proxy. Outbound
  Pantheo connections are unaffected — the server dials out from Railway the
  same as anywhere else; the Pantheo instance just has to be reachable from
  the internet, not your laptop's localhost.

## Desktop app: embedded or remote server

The desktop app fronts one of two servers, chosen under **Server → Server
Settings…** (stored in `desktop.json` next to the data dir):

- **Embedded** (default) — boots the hub in-process, exactly as before. This
  Mac *is* the Agora; closing the window keeps it running.
- **Remote** — the app skips the local hub entirely and becomes a pure client
  for a deployed `agora-server`: enter the server URL and its owner token,
  the app validates them and loads the remote UI. The same server can serve
  the mobile app and any browser simultaneously — one shared Agora, three
  kinds of clients.

In remote mode there is no local hub — the data lives wherever the server
runs — but native desktop notifications still fire: the shell keeps its own
event socket to the remote server and posts banners for agent replies that
land while the window is unfocused (see [Notifications](#notifications)).

## Moving between Agoras

An Agora's data (groups, channels, messages, threads, pins, stars, reads,
attachments) can be exported as one archive and imported into any other
instance. Tokens, bind settings, and pairing credentials never migrate —
each instance keeps its own `config.json`.

- `GET /api/export` (owner token) downloads a `.tar.gz` snapshot — safe on a
  live server, and handy as a periodic backup.
- `POST /api/import` (owner token, multipart `archive` field) stages the
  archive and restarts to apply it. It refuses if the target already has data
  unless you pass `?replace=true`; the previous data is kept in a
  `pre-import-<ts>/` folder inside the data dir.
- `AGORA_IMPORT_URL=<url>` seeds a **fresh** data dir (no `agora.db` yet) by
  downloading an archive on first boot — useful for a brand-new deployment.

[`scripts/agora_migrate.py`](scripts/agora_migrate.py) composes those for
every combination of local data dir and live server:

```bash
# laptop desktop app -> hosted Railway deployment
scripts/agora_migrate.py \
    --from "~/Library/Application Support/app.agora.desktop" \
    --to https://agora.up.railway.app --to-token OWNERTOKEN

# hosted -> hosted, overwriting the target (old data kept in pre-import-<ts>/)
scripts/agora_migrate.py --from https://old.example --from-token AAA \
                         --to https://new.example --to-token BBB --replace

# hosted -> local desktop data dir (applied next app launch)
scripts/agora_migrate.py --from https://agora.up.railway.app --from-token AAA \
    --to "~/Library/Application Support/app.agora.desktop" --replace

# just take a backup
scripts/agora_migrate.py --from https://agora.up.railway.app --from-token AAA \
    --save agora-backup.tar.gz
```

The typical "graduate my laptop Agora to the cloud" flow: deploy on Railway,
run the first command above, then flip the desktop app to remote mode
(Server → Server Settings…) and sign the mobile app into the same URL.

## Network exposure

Agora authenticates every request with the owner token (or a Google session
token), and it defaults to a **loopback bind** so nothing is reachable off-host
until you opt in.

- **Binding `0.0.0.0`** (LAN bridges, or the Docker image, which forces it for
  PaaS routing) puts the API on the network. The owner token is then the *only*
  thing standing between the internet and full control of the instance, so a
  `0.0.0.0` deployment **must** sit behind a firewall and a TLS reverse proxy —
  never expose the raw port directly. On boot the server logs a warning when it
  binds a non-loopback address.
- **TLS is not terminated by Agora itself.** Over plaintext `ws://`/`http://`
  the owner token and every message travel in the clear. Front it with TLS
  (see the reverse-proxy config above; Railway/PaaS domains give you TLS for
  free). Outbound Pantheo connections send the instance token as an
  `Authorization: Bearer` header (not a logged `?token=`), and setting
  `require_tls` makes the server refuse to dial a non-loopback peer over
  plaintext.
- **Rate limiting** on the Google sign-in and upload endpoints is an in-process
  backstop only. Behind a proxy every request shares the proxy's IP, so keep a
  real limiter at the edge for internet-facing deployments.

## Configuration (`config.json` in the data dir)

| Key | Default | Meaning |
| --- | --- | --- |
| `owner_token` | generated | Authenticates the UI/REST API (`?token=` or `Authorization: Bearer`). |
| `session_secret` | generated | Signs the session tokens minted by Google sign-in; rotate it to sign everyone out. |
| `username` | `me` | Display name of the local user. |
| `bind` | `127.0.0.1` | Set `0.0.0.0` to accept LAN/remote agent bridges. See [Network exposure](#network-exposure). |
| `port` | `4470` | Falls back to an ephemeral port if taken. |
| `require_tls` | `false` | Refuse plaintext `ws://`/`http://` outbound connections to non-loopback hosts (the token would travel in the clear). |
| `connections` | `[]` | Outbound Pantheo endpoints (managed from the UI). |
| `pairing_tokens` | `[]` | Dial-in bridge credentials (managed from the UI). |
| `max_file_mb` | `10` | Per-attachment upload cap. |
| `google_client_id` | `""` | Google OAuth client id (see [Google sign-in](#google-sign-in)). |
| `google_client_secret` | `""` | Google OAuth client secret. |
| `google_allowed_emails` | `[]` | The only Google accounts allowed in. Empty keeps Google sign-in off. |
| `public_url` | `""` | Public https origin (behind a proxy) used to build the OAuth redirect URI. |

## Google sign-in

Instead of pasting the owner token, a deployed server can offer **Sign in with
Google** — the same OIDC code flow Pantheo's dashboard uses. The web UI's auth
gate, the desktop app's server picker, and the mobile connect screen all grow a
Google button once the server is configured. A successful sign-in mints a
30-day session token (HMAC-signed with `session_secret`) that is accepted
everywhere the owner token is; Google credentials are never stored.

Setup:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   create an OAuth client of type **Web application** and add the redirect URI
   `https://<your-agora-host>/api/auth/google/callback`.
2. Configure the server — either env vars (Railway-friendly; persisted into
   `config.json` at boot):

```bash
AGORA_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
AGORA_GOOGLE_CLIENT_SECRET=GOCSPX-...
AGORA_GOOGLE_ALLOWED_EMAILS=you@gmail.com          # comma-separated
AGORA_PUBLIC_URL=https://agora.up.railway.app      # must match the redirect URI
```

   or the same keys directly in `config.json`.
3. Restart. `GET /api/auth/config` now reports `{"google":{"enabled":true}}`
   and the sign-in buttons appear.

The allowlist is the authorization layer: Agora v1 is single-user, so any
allowed email signs in *as the owner*. An empty allowlist keeps Google sign-in
disabled outright.

> **Token trust:** the `id_token` is validated by its claims (`iss`, `aud`,
> `exp`, `email_verified`, allowlist) but **not** by an RS256/JWKS signature
> check. This is safe because the token is fetched directly from Google's token
> endpoint over the server's TLS back-channel (authorization-code flow), so its
> authenticity is already established by transport — a JWKS verification would
> be redundant and add a network dependency. Do **not** repurpose
> `decode_id_token` for tokens received from an untrusted source (e.g. an
> implicit-flow token straight from a browser); those must have their signature
> verified. See `crates/agora-core/src/auth.rs`.

Per client:

- **Browser** — the auth gate shows *Sign in with Google*; the callback lands
  the session in the URL fragment and the UI stores it like a pasted token.
- **Desktop** — *Server → Server Settings… → Sign in with Google instead*
  opens your default browser (Google refuses embedded webviews) and catches
  the token on a loopback listener; the app then behaves exactly like remote
  mode with a pasted token. Embedded mode needs no sign-in at all.
- **iPhone** — the connect screen's Google button opens a system auth sheet
  and returns via the `agora://auth` deep link; the session token goes into
  the keychain in the owner token's place.

Sessions expire after 30 days (or all at once if `session_secret` is rotated);
clients drop back to their sign-in screen and one Google tap renews them. The
owner token keeps working unchanged — Google sign-in is additive.

## Notifications

Agent replies that land while nobody is looking pop native banners. What
"looking" and "instant" mean depends on the client:

| Client | While the app is open | While it's backgrounded / closed |
| --- | --- | --- |
| Desktop, embedded mode | Banner when the window is unfocused or hidden (in-process hub notifier). | Same — the hub keeps running after the window closes; Cmd-Q stops it. |
| Desktop, remote mode | Banner when unfocused, via the shell's own event socket to the remote server (per-channel throttle, same title shape). | Same, as long as the app is running (closing the window only hides it). |
| iOS app | Banner while the app process is alive and the socket is connected (foregrounded or briefly backgrounded). | Periodic catch-up: a background task polls unread counts and posts "N new messages in Group / #channel" banners. iOS schedules it opportunistically (15-minute floor, no guarantee) — expect "within a while", not instant. |
| Browser tab | Nothing (no notification path). | Nothing. |

Tapping an iOS banner opens the channel (or thread) it came from, and the
app icon badge tracks total unread across devices.

**Instant push while the iPhone app is suspended** is the one gap, and it's
an Apple-credentials problem, not a code one: APNs requires the push
entitlement, which free personal signing teams can't carry (the paid
Developer Program, $99/yr, can). The upgrade path when enrolled: drop the
`withNoPushEntitlement` plugin from `mobile/app.json`, register Expo push
tokens with the server (new `POST /api/push-tokens`), and have `agora-server`
POST to Expo's push API for agent messages when no UI socket is connected.
Until then the background poll above is the honest fallback.

**macOS signing requirement:** banners post through the modern
`UNUserNotificationCenter` framework, and macOS only delivers those for apps
with a **stable code signature** — a plain ad-hoc build gets "notifications
are not allowed for this application". For local development, sign the bundle
with a self-signed code-signing certificate (create one in Keychain Access,
then `codesign --force --deep --sign "Agora Dev" /Applications/Agora.app`);
for distribution, the Developer ID signature covers it. On first properly
signed launch, macOS shows the usual "allow notifications?" prompt.

## Roadmap

- **Multi-user** — accounts beyond the single owner token.
- **More bridge kits** — a [Claude CLI bridge](bridges/claude-cli/README.md)
  ships today; ready-made Node/other clients for the dial-in protocol are next.
- **Instant iOS push** — the [mobile app](mobile/README.md) ships now (React
  Native/Expo, dial-out only); APNs/FCM push is gated on Apple Developer
  credentials (see [Notifications](#notifications)).
