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
   /model sonnet        -> persist model for this channel (claude --model)
   also run the full suite      -> resumed headlessly; reply posted back
   /compact             -> Claude headless slash command, forwarded to the session
   ```

## Commands

| command | effect |
|---|---|
| `/sessions [n]` | list your most recent Claude CLI sessions (from `~/.claude/projects/`) |
| `/use <n \| session-id>` | bind this channel/thread to a session |
| `/new <dir>` | bind to a fresh session started in `<dir>` — **`<dir>` must be under an allowed root** (see below); disabled entirely when no roots are configured |
| `/model <opus\|sonnet\|haiku\|fable\|…\|default>` | set the model for this channel (`default` clears the override); persists in the binding and is passed as `claude --model` on every run |
| `/permissions <plan\|acceptEdits\|bypass\|default\|reset>` | set the permission mode for this channel (`reset` clears the override). Lowering privilege is always allowed; **raising it above the bridge default requires `CLAUDE_ALLOW_PERMISSION_ESCALATION`** |
| `/stop` | cancel the run in flight on this channel (kills the `claude` child) |
| `/status` | show the current binding, model, permission mode, and whether a run is in flight |
| `/commands` | show this bridge command list |
| anything else | forwarded to the bound session (plain text **and** Claude CLI slash commands the headless CLI supports, e.g. `/compact`, `/usage`, `/context`) |

`/model` and `/permissions` are **per channel/thread** — same as session bindings —
so one channel can plan read-only on Sonnet while another auto-applies on Opus.
Both persist in `state.json`. Bridge `/model` is intentional (not Claude's TUI
`/model` picker): it sticks across runs via `--model`.

**Claude slash commands from chat.** Non-bridge messages go to `claude -p`
(headless — no interactive terminal UI). Only commands the CLI exposes for that
mode work when forwarded (see each run's `system/init` `slash_commands`).
Interactive-only ones like `/help` fail with Claude's "isn't available in this
environment" / `Unknown skill`; use `/commands` for the bridge list.

Only **human** authors can drive the bridge — messages from other agents/bots
are ignored even when they `@mention` Claude, so a prompt-injected agent in the
same channel can't run code on your machine.

**Permission prompts in the channel.** When Claude needs approval for a tool
(e.g. a Bash command outside the allowed set), the bridge posts the request to
the channel with **Approve / Always allow (this session) / Reject** buttons and
relays your tap back to the CLI, so headless runs no longer silently deny (or
require blanket `--dangerously-skip-permissions`). The request is summarized
per tool (the command for Bash, the URL and prompt for WebFetch, the file path
for edits, …) rather than dumped as raw JSON. "Always allow" is remembered
per channel/thread binding, in memory only — a bridge restart re-asks. If
nobody taps within `--permission-timeout` (`CLAUDE_PERMISSION_TIMEOUT`, default
600 s) the request is denied and the buttons lock with a note; the wait counts
against the overall run `--timeout`. The default permission mode is still
`acceptEdits` — edits proceed unprompted, everything else asks — and channels
can override with `/permissions`. The CLI's `ExitPlanMode` gate is reworded for
the channel: it posts as "Claude finished planning and wants approval to start
implementing this plan" with the plan text and **Approve plan / Reject** buttons
(no "always" option — each plan is approved on its own), since approving it is
what lets Claude leave plan mode and start editing.

**Clarifying questions.** When Claude asks a question (its `AskUserQuestion`
tool), there is no Approve/Reject step — the bridge posts each question to the
channel with one button per option. Tap an option, or just reply with text to
answer in your own words (a comma-separated reply picks several options on a
multi-select question). Answers are returned to the CLI as the tool's result;
questions nobody answers within `--permission-timeout` are denied so the run
can continue.

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
`--dangerously-skip-permissions` for fully unattended runs — the permission mode
here is just the **default**, overridable per channel with `/permissions`),
`CLAUDE_MODEL` (default model for every run, e.g. `opus`; channels override with
`/model`), `CLAUDE_ALLOW_PERMISSION_ESCALATION` (`1` to let `/permissions` raise
privilege above the default — off by default), `CLAUDE_TIMEOUT` (seconds,
default 1800), `SESSIONS_LIMIT`, `STATE_FILE`.

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
