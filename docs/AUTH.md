<!-- ‹ back to [README](../README.md) -->

# Accounts & sign-in

Agora is multi-user: real accounts (a `users` table) with instance roles
(admin/member), per-group roles, and email/invite-link admission. The
`admin_key` in `config.json` is the *operator* credential — it resolves to an
instance admin — not a personal account. On top of pasted-token access, a
deployed server can offer Google and Apple sign-in.

## Google sign-in

Instead of pasting the admin key, a deployed server can offer **Sign in with
Google** — the same OIDC code flow Pantheo's dashboard uses. The web UI's auth
gate, the desktop app's server picker, and the mobile connect screen all grow a
Google button once the server is configured. A successful sign-in mints a
30-day session token (HMAC-signed with `session_secret`) that is accepted
everywhere the admin key is; Google credentials are never stored.

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

Admission is decided by the sign-in rules (existing user → email invite →
valid invite link → config allowlist); the `google_allowed_emails` list is the
fallback that lets a fresh email in and becomes that person's account. An empty
allowlist with no invites keeps Google sign-in disabled outright.

Allowlist entries may be wildcards: `*@example.com` admits everyone at that
domain, and a bare `*` is **open sign-up** — anyone with a Google (or Apple)
account gets a member account on your instance, so only use it on servers
meant to be public. Both allowlists feed the same admission check, so a
wildcard on either admits sign-ins from both providers.

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
  the keychain in the admin key's place.

Sessions expire after 30 days (or all at once if `session_secret` is rotated);
clients drop back to their sign-in screen and one Google tap renews them. The
admin key keeps working unchanged — Google sign-in is additive.

## Sign in with Apple

The iOS app can also sign in with Apple (an App Store requirement once any
third-party login is offered). It takes the native path, not a browser
round-trip: the app presents Apple's system sheet, gets back an **identity
token** (an RS256 JWT audienced to the app's bundle id), and posts it to
`POST /api/auth/apple`. The server verifies the token's signature against
Apple's published JWKS — unlike the Google flow there is no trusted TLS
back-channel, the token arrives from the client — plus issuer, audience,
expiry and the email allowlist, then mints the same 30-day session a Google
sign-in would.

Setup needs no Apple-side credentials on the server, just the allowlist:

```bash
AGORA_APPLE_ALLOWED_EMAILS=you@icloud.com   # comma-separated
# AGORA_APPLE_BUNDLE_ID=app.agora.mobile    # only if you ship a custom build
```

(or `apple_allowed_emails` / `apple_bundle_id` in `config.json`). Restart and
`GET /api/auth/config` reports `{"apple":{"enabled":true}}`; the mobile connect
screen shows the Apple button. The same wildcard entries work here —
`*@example.com` for a domain, `*` for open sign-up (which also counts as a
non-empty allowlist, so it enables the Apple button on its own). If you use
Apple's **Hide My Email**, allowlist
the relay address — it is stable per Apple ID and app. Note the button only
renders in builds carrying the Sign in with Apple entitlement (a paid Apple
Developer team); free-personal-team dev builds strip it and hide the button.

## Account deletion

`DELETE /api/me` (Settings → **Delete account** in the iOS app) erases
everything keyed to the owner — authored messages and their attachments,
threads they started, stars, read markers, pins, mentions, memberships — and
rotates `session_secret`, signing out every device at once. The admin key
survives: it's the instance's admin credential, not a user account. This is
what satisfies App Store guideline 5.1.1(v) for the published app.
