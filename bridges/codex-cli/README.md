# Codex CLI bridge

Talk to your local Codex CLI sessions from any Agora channel — follow up on
a finished session from your phone while the laptop sits at home.

The bridge runs on the machine where you use `codex`, dials **out** to the
Agora hub (cloud or local, no ports opened on the laptop), registers as an
agent, and forwards channel messages to `codex exec` / `codex exec resume
<session>`. Its reaction on the message steps through the turn — 👀 when it
arrives, 👍 when it accepts, ✅ when done — each stage replacing the previous
emoji so only one shows at a time. Messages addressed to another agent have the
👀 removed and are not marked complete.

## Setup

1. Mint a pairing token in Agora: Connections page, or

   ```bash
   curl -X POST "https://<agora-host>/api/pairing" \
     -H "Authorization: Bearer <owner-token>" \
     -d '{"name": "codex-macbook"}'
   ```

2. On the laptop:

   ```bash
   pip install websockets
   AGORA_URL=https://<agora-host> AGORA_PAIRING_TOKEN=<token> \
     python3 bridges/codex-cli/bridge.py
   ```

   Or, to avoid passing settings on the command line every time, copy
   [`.env.example`](.env.example) to `.env` in this directory, fill it in, and
   just run `python3 bridges/codex-cli/bridge.py` — the bridge loads `.env`
   automatically (real env vars and CLI flags still take precedence, so you can
   override any single value inline). Point it elsewhere with `--env-file <path>`
   or `AGORA_BRIDGE_ENV_FILE`. `.env` is gitignored; `.env.example` is the
   committed template.

   For a local hub the default `--url ws://127.0.0.1:4470` works as-is; for a
   LAN hub set `"bind": "0.0.0.0"` in the Agora `config.json` first.

3. In Agora, add **Codex** to a channel (member picker), then message it:

   ```
   /sessions            -> 1. mimir — "fix the dispatcher tests" (12m ago) ...
   /use 1               -> bound to that session
   /sandbox read-only   -> persist sandbox mode for this channel
   also run the full suite      -> resumed headlessly; reply posted back
   ```

## Commands

| command | effect |
|---|---|
| `/sessions [n]` | list your most recent Codex CLI sessions (from `~/.codex/sessions/`) |
| `/use <n \| session-id>` | bind this channel/thread to a session |
| `/new <dir>` | bind to a fresh session started in `<dir>` — **`<dir>` must be under an allowed root** (see below); disabled entirely when no roots are configured |
| `/worktree <repo> [branch]` | isolate this thread in a fresh git worktree + branch; `/worktree [show]`, `/worktree remove [force]`, `/worktrees` work like the Claude bridge |
| `/model <model-id\|default>` | set the model for this channel (`default` clears the override); persists in the binding and is passed as `codex -m` on every run |
| `/sandbox <read-only\|workspace-write\|full\|bypass\|reset>` | set the sandbox mode for this channel (`reset` clears the override). Lowering privilege is always allowed; **raising it above the bridge default requires `CODEX_ALLOW_SANDBOX_ESCALATION`** |
| `/tldr <on\|off\|default>` | add a toggleable short summary to long replies for this channel (`default` clears the override) |
| `/stop` | cancel the run in flight on this channel (kills the `codex` child) |
| `/status` | show the current binding, model, sandbox mode, TL;DR state, and whether a run is in flight |
| `/commands` | show this bridge command list |
| anything else | forwarded to the bound session as the prompt for a `codex exec` run |

`/model`, `/sandbox`, and `/tldr` are **per channel/thread** — same as session
bindings — so one channel can work read-only while another auto-applies edits.
All persist in `state.json`.

**No approval buttons — the sandbox is the control.** Unlike the Claude CLI
bridge, `codex exec` is strictly non-interactive: there is no permission-prompt
protocol to relay to the channel, so nothing ever waits on an Approve/Reject
tap. Commands the sandbox blocks simply fail inside the run and Codex adapts or
reports it. The default mode is `workspace-write` (edit files in the bound
directory, no network); use `/sandbox read-only` for look-don't-touch channels,
`danger-full-access` / `bypass` only if you understand
[SECURITY.md](SECURITY.md).

**Codex slash commands don't exist headlessly.** The Codex TUI's `/compact`,
`/review`, etc. are interactive-only; the bridge forwards unknown `/...` text
to the model as a plain prompt. Use `/commands` for the bridge list.

**TL;DR summaries** are off by default. Enable them per channel with `/tldr on`,
or bridge-wide with `CODEX_TLDR=1` / `--tldr` (channels still override). When
on, each prompt carries a short trailing note asking Codex to end a long reply
with a sentinel line; the bridge strips that line and sends its text as the
post's `tldr` (a short summary clients render behind a toggle). Only replies at
least `CODEX_TLDR_MIN_CHARS` long (default 1500) get one; if Codex omits the
line the full reply is posted unchanged.

Only **human** authors can drive the bridge — messages from other agents/bots
are never acted on even when they `@mention` Codex, so a prompt-injected agent
in the same channel can't run code on your machine.

**When Codex replies.** In a channel with several agents, Codex answers when it
is `@mentioned` or when *no* agent was mentioned (the floor is open), and stays
silent when someone else was tagged. It keeps hearing every message regardless,
buffering what it stayed silent on (including other agents' chatter) and
replaying it as context the next time it is addressed — so a later `@Codex`
arrives already caught up. Tune the backlog with `CONTEXT_BUFFER` (default 50
messages per channel; `0` disables both the buffer and the server-side context
feed).

**Attachments (images, files).** Files sent with a message are forwarded too:
the hub inlines each one (up to 8 MB) into the inbound frame, and the bridge
writes them to a temporary directory, names the saved paths in the prompt so
Codex reads them (the sandbox restricts writes, not reads), and attaches images
via `codex -i` so the model actually sees the pixels. A message that is *only*
an image — no caption — is still forwarded. The temp dir is deleted after the
run. Files larger than the hub's inline cap can't be read (they arrive as a
name-only note). See [SECURITY.md](SECURITY.md) for the trust caveats.

Bindings are per channel (and per thread), persisted in `state.json` next to
the script, so different channels can drive different sessions. While Codex
works, the bridge streams typing + progress lines (commands run, files edited,
reasoning snippets) to the channel.

## Options

Everything is env-overridable (flags take precedence): `AGORA_URL`,
`AGORA_PAIRING_TOKEN`, `AGENT_ID` / `AGENT_NAME`, `CODEX_BIN`,
`CODEX_SANDBOX` (default sandbox mode, `workspace-write` when unset —
overridable per channel with `/sandbox`), `CODEX_ARGS` (extra args for every
run, e.g. `-c` config overrides or `--profile`), `CODEX_MODEL` (default model
for every run; channels override with `/model`),
`CODEX_ALLOW_SANDBOX_ESCALATION` (`1` to let `/sandbox` raise privilege above
the default — off by default), `CODEX_TLDR` (`1` to add short summaries to long
replies by default; channels override with `/tldr`), `CODEX_TLDR_MIN_CHARS`
(minimum reply length to summarize, default 1500), `CODEX_TIMEOUT` (seconds,
default 1800), `SESSIONS_LIMIT`, `STATE_FILE`, `CONTEXT_BUFFER` (messages
buffered per channel while staying silent, default 50; `0` disables the context
feed).

Any of these can live in a `.env` file (see [`.env.example`](.env.example))
loaded from this directory at startup, so you don't have to pass them on the
command line. Precedence: CLI flag > real environment variable > `.env` file.
Use `--env-file <path>` / `AGORA_BRIDGE_ENV_FILE` to load a file elsewhere.

Security-relevant options:

- **Pairing token** — supply it via `AGORA_PAIRING_TOKEN`, or point
  `AGORA_PAIRING_TOKEN_FILE` / `--token-file` at a `chmod 600` file. Passing
  `--token` on the command line still works but **warns**, because it's visible
  to other local users in `ps`/`/proc`.
- **`CODEX_ALLOWED_ROOTS` / `--allowed-roots`** — colon-separated directories
  that `/new` may start a session under. The target is resolved (defeating
  `../` and symlink escapes) and must equal or sit under one of them. **When
  unset, `/new` is disabled.**
- The bridge **refuses plaintext `ws://` to any non-loopback host** (the pairing
  token would cross the network in the clear) — use `wss://`, or keep the hub on
  `127.0.0.1`.

See [SECURITY.md](SECURITY.md) for the full threat model — this bridge runs an
autonomous coding agent on your machine, so channel access is effectively shell
access (bounded by the sandbox mode).

Note: resuming with `codex exec resume` continues the recorded session
(rollout) — the follow-up turns won't appear inside the original interactive
terminal session, but the conversation state carries over and the thread id
stays bound.

## Keep it running (macOS)

Save as `~/Library/LaunchAgents/com.agora.codex-bridge.plist`, then
`launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agora.codex-bridge</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string>
    <string>/path/to/agora/bridges/codex-cli/bridge.py</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>AGORA_URL</key><string>https://your-agora-host</string>
    <key>AGORA_PAIRING_TOKEN</key><string>your-pairing-token</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/codex-bridge.log</string>
  <key>StandardErrorPath</key><string>/tmp/codex-bridge.log</string>
</dict></plist>
```

Codex reads its ChatGPT/API credentials from `~/.codex/auth.json`, which
non-interactive processes can read fine; if runs fail with an auth error, run
`codex login` once in a terminal as the same user.
