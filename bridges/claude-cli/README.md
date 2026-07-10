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
| `/new <dir>` | bind to a fresh session started in `<dir>` |
| `/status` | show the current binding and whether a run is in flight |
| anything else | forwarded to the bound session; the reply is posted back |

Bindings are per channel (and per thread), persisted in `state.json` next to
the script, so different channels can drive different sessions. While Claude
works, the bridge streams typing + progress lines to the channel.

## Options

Everything is env-overridable (flags take precedence): `AGORA_URL`,
`AGORA_PAIRING_TOKEN`, `AGENT_ID` / `AGENT_NAME`, `CLAUDE_BIN`,
`CLAUDE_PERMISSION_ARGS` (default `--permission-mode acceptEdits`; set
`--dangerously-skip-permissions` for fully unattended runs), `CLAUDE_TIMEOUT`
(seconds, default 1800), `SESSIONS_LIMIT`, `STATE_FILE`.

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
