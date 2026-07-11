# Claude CLI bridge

Talk to your local Claude Code sessions from any Agora channel — follow up on
a finished session from your phone while the laptop sits at home.

The bridge runs on the machine where you use `claude`, dials **out** to the
Agora hub (cloud or local, no ports opened on the laptop), registers as an
agent, and forwards channel messages to `claude -p --resume <session>`.

## Setup

1. Mint a pairing token in Agora: Connections page, or

   ```bash
   curl -X POST "https://<agora-host>/api/pairing" \
     -H "Authorization: Bearer <owner-token>" \
     -d '{"name": "claude-macbook"}'
   ```

2. On the laptop:

   ```bash
   pip install websockets
   AGORA_URL=https://<agora-host> AGORA_PAIRING_TOKEN=<token> \
     python3 bridges/claude-cli/bridge.py
   ```

   For a local hub the default `--url ws://127.0.0.1:4470` works as-is; for a
   LAN hub set `"bind": "0.0.0.0"` in the Agora `config.json` first.

3. In Agora, add **Claude** to a channel (member picker), then message it:

   ```
   /sessions            -> 1. mimir — "fix the dispatcher tests" (12m ago) ...
   /use 1               -> bound to that session
   also run the full suite      -> resumed headlessly; reply posted back
   ```

## Commands

| command | effect |
|---|---|
| `/sessions [n]` | list your most recent Claude CLI sessions (from `~/.claude/projects/`) |
| `/use <n \| session-id>` | bind this channel/thread to a session |
| `/new <dir>` | bind to a fresh session started in `<dir>` — **`<dir>` must be under an allowed root** (see below); disabled entirely when no roots are configured |
| `/status` | show the current binding and whether a run is in flight |
| anything else | forwarded to the bound session; the reply is posted back |

Only **human** authors can drive the bridge — messages from other agents/bots
are ignored even when they `@mention` Claude, so a prompt-injected agent in the
same channel can't run code on your machine.

**Permission prompts in the channel.** When Claude needs approval for a tool
(e.g. a Bash command outside the allowed set), the bridge posts the request to
the channel with **Approve / Always allow (this session) / Reject** buttons and
relays your tap back to the CLI, so headless runs no longer silently deny (or
require blanket `--dangerously-skip-permissions`). "Always allow" is remembered
per channel/thread binding, in memory only — a bridge restart re-asks. If
nobody taps within `--permission-timeout` (`CLAUDE_PERMISSION_TIMEOUT`, default
600 s) the request is denied and the buttons lock with a note; the wait counts
against the overall run `--timeout`. The default permission mode is still
`acceptEdits` — edits proceed unprompted, everything else asks.

**Attachments (images, files).** Files sent with a message are forwarded too:
the hub inlines each one (up to 8 MB) into the inbound frame, and the bridge
writes them to a temporary directory it exposes to Claude via `--add-dir`, then
names the saved paths in the prompt so Claude reads them. A message that is
*only* an image — no caption — is still forwarded. The temp dir is deleted after
the run. Files larger than the hub's inline cap can't be read (they arrive as a
name-only note). See [SECURITY.md](SECURITY.md) for the trust caveats.

Bindings are per channel (and per thread), persisted in `state.json` next to
the script, so different channels can drive different sessions. While Claude
works, the bridge streams typing + progress lines to the channel.

## Options

Everything is env-overridable (flags take precedence): `AGORA_URL`,
`AGORA_PAIRING_TOKEN`, `AGENT_ID` / `AGENT_NAME`, `CLAUDE_BIN`,
`CLAUDE_PERMISSION_ARGS` (default `--permission-mode acceptEdits`; set
`--dangerously-skip-permissions` for fully unattended runs), `CLAUDE_TIMEOUT`
(seconds, default 1800), `SESSIONS_LIMIT`, `STATE_FILE`.

Security-relevant options:

- **Pairing token** — supply it via `AGORA_PAIRING_TOKEN`, or point
  `AGORA_PAIRING_TOKEN_FILE` / `--token-file` at a `chmod 600` file. Passing
  `--token` on the command line still works but **warns**, because it's visible
  to other local users in `ps`/`/proc`.
- **`CLAUDE_ALLOWED_ROOTS` / `--allowed-roots`** — colon-separated directories
  that `/new` may start a session under. The target is resolved (defeating
  `../` and symlink escapes) and must equal or sit under one of them. **When
  unset, `/new` is disabled.**
- The bridge **refuses plaintext `ws://` to any non-loopback host** (the pairing
  token would cross the network in the clear) — use `wss://`, or keep the hub on
  `127.0.0.1`.

See [SECURITY.md](SECURITY.md) for the full threat model — this bridge runs an
autonomous coding agent on your machine, so channel access is effectively shell
access.

Note: resuming a session with `-p` continues the conversation but Claude may
issue a new session id; the bridge tracks it automatically, and the follow-up
turns won't appear inside the original interactive terminal session.

## Keep it running (macOS)

Save as `~/Library/LaunchAgents/com.agora.claude-bridge.plist`, then
`launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agora.claude-bridge</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string>
    <string>/path/to/agora/bridges/claude-cli/bridge.py</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>AGORA_URL</key><string>https://your-agora-host</string>
    <key>AGORA_PAIRING_TOKEN</key><string>your-pairing-token</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/claude-bridge.log</string>
  <key>StandardErrorPath</key><string>/tmp/claude-bridge.log</string>
</dict></plist>
```

If runs fail with "Not logged in" (Claude's keychain OAuth credentials aren't
always readable from non-interactive processes), add an `ANTHROPIC_API_KEY`
entry to `EnvironmentVariables` above.
