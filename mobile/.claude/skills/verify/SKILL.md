---
name: verify
description: Verify agora mobile changes end-to-end by driving the app on expo web with Playwright against a local agora-server.
---

# Verifying agora-mobile changes at runtime

The fastest runtime surface for `mobile/` changes is **expo web** — no
simulator build. FlashList v2, the ws reducer, and all screen logic are pure
JS, so they behave the same as on device. Native-module behavior (keyboard,
push, secure store, speech) is NOT covered — those need `npm run ios`.

## Server + seed

```bash
# build the web UI first if web/dist is missing: npm run build (repo root)
./target/debug/agora-server --data-dir /tmp/agora-verify --ui-dir web/dist &
# prints "Admin key: <KEY>" and the port (falls back to ephemeral if 4470 busy)
# seed via REST: POST /api/groups, /api/groups/$GRP/channels,
#   /api/channels/$CHAN/messages  with  Authorization: Bearer $KEY
```

Gotcha: `GID` is a read-only zsh variable — name the group id var `GRP`.

## Expo web

`react-native-web` is not a dependency (web isn't shipped). Install it
without saving, plus react-dom pinned to match react exactly:

```bash
cd mobile
npm install --no-save react-native-web react-dom@$(node -e "console.log(require('react/package.json').version)")
npx expo start --web --port 8090
```

Two native modules crash the web bundle and need node_modules stubs
(never commit; `npm ci` afterwards restores everything):

- `expo-secure-store/build/ExpoSecureStore.web.js` ships as `export default {}` —
  replace with a localStorage-backed object implementing
  `get/set/deleteValueWithKeyAsync`, `getValueWithKeySync`, `setValueWithKeySync`,
  `canUseBiometricAuthentication`.
- `expo-notifications/build/useLastNotificationResponse.js` — replace body with
  a hook returning `null` (keep BOTH default and named export).

## Driving

Playwright (`playwright-core` + installed Chrome, `channel: "chrome"`).
The server sends no CORS headers, so launch with
`launchPersistentContext(dir, { args: ["--disable-web-security"] })`.

Flow: connect screen (placeholder `https://agora.example.com`) → Continue →
"Sign in as admin" (tap twice: ghost button reveals the key input, placeholder
`admin key (from the server log)`) → home lists groups → tap channel. The
session persists in the chrome profile dir — subsequent runs skip straight
to home.

Gotchas that produce false results:
- Home groups are **accordions, expanded by default** — tapping the group
  name COLLAPSES it. Only tap the group if its channels aren't visible.
- **Enter does not send** in the composer (RN TextInput); blur the input so
  the round send arrow appears bottom-right, then click that Pressable (no
  a11y label — click by position or the ArrowUp svg).
- Playwright's `text=` engine matches a TextInput's typed VALUE too — a
  "message rendered" wait can pass without any send. Assert sends
  **server-side** (`GET /api/channels/$CHAN/messages`).

Scroll assertions: the FlashList container is the tallest scrollable div;
track `scrollHeight - scrollTop - clientHeight` (distance from bottom).
`page.mouse.wheel` triggers pagination like a real user.
