# Agora Mobile

React Native (Expo) client for Agora on iOS and Android. It is a pure client
of a **headless `agora-server`** — the phone cannot host the hub the way the
desktop app does (mobile OSes kill background processes), so run the server
somewhere reachable (home server + Tailscale/VPN, or a VPS behind `wss://`)
and point the app at it.

## Features

Parity with the desktop app v1: groups → channels → threads, unread badges
and read markers with a "New" divider, pins (thread roots) and stars,
@mention autocomplete over live agents and group members, file attachments
(5 per message, inline image previews, share-sheet downloads), live typing
and progress bubbles, agent management, Pantheo connections and pairing
tokens. Markdown-lite rendering (bold/italic/code/links/tables) matches the
desktop `mdLite`. Voice features stay stubbed, same as desktop v1.

Notifications fire locally while the socket is alive (foreground / recently
backgrounded); tapping one opens its channel or thread, and the app icon
badge tracks total unread. While the app is suspended, a background task
(`expo-background-task`) polls unread counts and posts per-channel catch-up
banners — iOS runs it opportunistically (15-minute floor, no guarantee).
True instant push (APNs/FCM) needs the paid Apple Developer Program plus a
small server-side addition; see the root README's Notifications section for
the upgrade path.

## Getting started

```bash
# 1. run a server somewhere (prints the admin key on boot)
cargo run -p agora-server

# 2. run the app
cd mobile
npm install
npm run ios        # or: npm run android
```

On first launch the app asks for the server URL and admin key; both are
kept in the OS keychain. Sign out from Settings to switch servers.

## Development

```bash
npm run typecheck          # tsc --noEmit
npm test                   # unit tests (mdlite, ws reducer, api client)
npm run test:integration   # spawns a real agora-server and hits it
```

The integration suite builds on `target/{debug,release}/agora-server` if
present (else `cargo run`), pins a random high port via the data-dir
`config.json`, and exercises the REST + WS surface with the app's own
`ApiClient`. Since there is no shared schema between the Rust server and the
TS types in `src/api/types.ts`, this suite is what keeps them honest.

Release builds go through EAS (`eas.json`): `eas build --profile preview`.

## Layout

- `app/` — expo-router screens (connect, home, channel, thread, members,
  agents, settings).
- `src/api/` — typed REST client, query hooks, query-key factory.
- `src/ws/` — the `/ws` socket (reconnect with backoff) and the event
  reducer that patches the query cache (`message`, `read`, `typing`,
  `progress`, `pin` frames).
- `src/state/` — session (keychain-backed) and transient live activity.
- `src/lib/` — mdlite parser, theme (ported from `ui/style.css`), helpers.
- `src/components/` — message list pieces, composer, toasts, etc.
