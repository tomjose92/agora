<!-- ‹ back to [README](../README.md) -->

# Deployment & operations

Sharing the app, shipping releases, running a shared server, moving data
between instances, network hardening, configuration, and notifications.

## Sharing the desktop app

The `.app` this repo builds is ad-hoc signed — fine for your own machine, but
another Mac's Gatekeeper will refuse it ("damaged / unidentified developer").
Your options, in increasing order of effort:

1. **They build it themselves** from source (the Quick start in the README). No
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

## Releases and auto-update

Tagged releases are built by CI
([.github/workflows/release-desktop.yml](../.github/workflows/release-desktop.yml)):
push a `v*` tag and a macOS runner produces a universal DMG plus signed
updater artifacts and a `latest.json` feed, attached to a **draft** GitHub
Release — publish the draft to ship. The app checks that feed on every
launch (silently installing updates for the next start) and on demand via
**Agora → Check for Updates…** in the app menu, which walks through native
install/restart dialogs. Local `scripts/redeploy.sh` builds compile the
updater out (`--no-default-features`) so a dev install is never silently
replaced by a published release. Updater artifacts are signed with the
project's updater key (`plugins.updater.pubkey` in `tauri.conf.json`); CI
needs the private key in the `TAURI_SIGNING_PRIVATE_KEY` repo secret. Until
the Apple signing secrets are configured the workflow ad-hoc signs, so
downloads still hit Gatekeeper — options 1/2 above apply. A Mac App Store
build must exclude the updater: `--no-default-features` on `agora-desktop`
compiles it out.

Each installed app is its **own Agora** — own database, own groups. Two people
running the desktop app have two separate chat worlds that can talk to the
*same* Pantheo agents (each adds a connection to the same instance), but they
don't see each other's messages. A *shared* room for multiple people is what a
server deployment is for.

## Deploying a shared/always-on Agora (VPS)

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

Then share `https://agora.example.com/?token=<admin-key>` (the token is in
`/var/lib/agora/config.json`), or invite users so they sign in with their own
accounts — see [AUTH.md](AUTH.md).

## Deploying on Railway (or any Docker PaaS)

The repo ships a [`Dockerfile`](../Dockerfile) and [`railway.json`](../railway.json)
that build the headless server with the web UI bundled. The server honors the
PaaS conventions: `PORT` (injected by Railway) and `AGORA_BIND` (the image
defaults it to `0.0.0.0`) override `config.json` at boot.

```bash
railway init --name agora
railway volume add --mount-path /data   # config.json + agora.db + uploads live here
railway up --detach
railway domain                          # get the public https URL
railway logs                            # "Admin key: ..." is printed on first boot
```

Two things matter:

- **The `/data` volume is mandatory.** Without it every deploy regenerates the
  admin key and wipes messages and attachments.
- **TLS comes free** with the Railway domain, so browsers, the mobile app
  (`https://<app>.up.railway.app` + admin key), and dial-in bridges
  (`wss://.../agent/ws?token=...`) all work with no reverse proxy. Outbound
  Pantheo connections are unaffected — the server dials out from Railway the
  same as anywhere else; the Pantheo instance just has to be reachable from
  the internet, not your laptop's localhost.

## Moving between Agoras

An Agora's data (groups, channels, messages, threads, pins, stars, reads,
attachments) can be exported as one archive and imported into any other
instance. Tokens, bind settings, and pairing credentials never migrate —
each instance keeps its own `config.json`.

- `GET /api/export` (admin key) downloads a `.tar.gz` snapshot — safe on a
  live server, and handy as a periodic backup.
- `POST /api/import` (admin key, multipart `archive` field) stages the
  archive and restarts to apply it. It refuses if the target already has data
  unless you pass `?replace=true`; the previous data is kept in a
  `pre-import-<ts>/` folder inside the data dir.
- `AGORA_IMPORT_URL=<url>` seeds a **fresh** data dir (no `agora.db` yet) by
  downloading an archive on first boot — useful for a brand-new deployment.

[`scripts/agora_migrate.py`](../scripts/agora_migrate.py) composes those for
every combination of local data dir and live server:

```bash
# laptop desktop app -> hosted Railway deployment
scripts/agora_migrate.py \
    --from "~/Library/Application Support/app.agora.desktop" \
    --to https://agora.up.railway.app --to-token ADMINKEY

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

Agora authenticates every request with the admin key (or a Google session
token), and it defaults to a **loopback bind** so nothing is reachable off-host
until you opt in.

- **Binding `0.0.0.0`** (LAN bridges, or the Docker image, which forces it for
  PaaS routing) puts the API on the network. The admin key is then the *only*
  thing standing between the internet and full control of the instance, so a
  `0.0.0.0` deployment **must** sit behind a firewall and a TLS reverse proxy —
  never expose the raw port directly. On boot the server logs a warning when it
  binds a non-loopback address.
- **TLS is not terminated by Agora itself.** Over plaintext `ws://`/`http://`
  the admin key and every message travel in the clear. Front it with TLS
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
| `admin_key` | generated | Operator credential for the UI/REST API (`?token=` or `Authorization: Bearer`). Resolves to an instance-admin user. |
| `session_secret` | generated | Signs the session tokens minted by Google/Apple sign-in; rotate it to sign everyone out. |
| `username` | `me` | Display name of the bootstrap local user. |
| `bind` | `127.0.0.1` | Set `0.0.0.0` to accept LAN/remote agent bridges. See [Network exposure](#network-exposure). |
| `port` | `4470` | Falls back to an ephemeral port if taken. |
| `require_tls` | `false` | Refuse plaintext `ws://`/`http://` outbound connections to non-loopback hosts (the token would travel in the clear). |
| `connections` | `[]` | Outbound Pantheo endpoints (managed from the UI). |
| `pairing_tokens` | `[]` | Dial-in bridge credentials (managed from the UI). |
| `max_file_mb` | `10` | Per-attachment upload cap. |
| `google_client_id` | `""` | Google OAuth client id (see [AUTH.md](AUTH.md#google-sign-in)). |
| `google_client_secret` | `""` | Google OAuth client secret. |
| `google_allowed_emails` | `[]` | Google accounts allowed to sign in (fallback admission when no invite matches). Empty keeps Google sign-in off. |
| `apple_allowed_emails` | `[]` | Apple-account emails allowed to sign in (see [AUTH.md](AUTH.md#sign-in-with-apple)). Empty keeps Apple sign-in off. |
| `apple_bundle_id` | `""` | iOS bundle id the Apple identity token must be issued for. Empty means the stock app (`app.agora.mobile`). |
| `public_url` | `""` | Public https origin (behind a proxy) used to build the OAuth redirect URI. |

## Notifications

Agent replies that land while nobody is looking pop native banners. What
"looking" and "instant" mean depends on the client:

| Client | While the app is open | While it's backgrounded / closed |
| --- | --- | --- |
| Desktop, embedded mode | Banner when the window is unfocused or hidden (in-process hub notifier). | Same — the hub keeps running after the window closes; Cmd-Q stops it. |
| Desktop, remote mode | Banner when unfocused, via the shell's own event socket to the remote server (per-channel throttle, same title shape). | Same, as long as the app is running (closing the window only hides it). |
| iOS / Android app | No banner while focused (socket still updates the UI). | Instant remote push via Expo → APNs/FCM for agent messages. The app registers an Expo push token at `POST /api/push-tokens`; `agora-server` fans out on notify-worthy messages (per-channel throttle). If push registration fails (simulator, denied permission), a background unread poll remains as fallback. |
| Browser tab | Nothing (no notification path). | Nothing. |

Tapping a mobile banner opens the channel (or thread) it came from, and the
app icon badge tracks total unread across devices.

Remote push needs a paid Apple Developer Program membership for iOS (APNs
entitlement + EAS push credentials) and a native rebuild after enabling the
`expo-notifications` plugin. Sign-out calls `DELETE /api/push-tokens` so the
server stops waking that device.

**macOS signing requirement:** banners post through the modern
`UNUserNotificationCenter` framework, and macOS only delivers those for apps
with a **stable code signature** — a plain ad-hoc build gets "notifications
are not allowed for this application". For local development, sign the bundle
with a self-signed code-signing certificate (create one in Keychain Access,
then `codesign --force --deep --sign "Agora Dev" /Applications/Agora.app`);
for distribution, the Developer ID signature covers it. On first properly
signed launch, macOS shows the usual "allow notifications?" prompt.
