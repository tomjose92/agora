# Claude CLI bridge — security & privacy

This bridge is, by design, a way to run an autonomous coding agent on your
machine from a chat channel. That makes its blast radius large: whoever can
post in a channel the bridge is a member of can cause code to run on the host
it runs on. Read this before exposing it beyond a trusted, single-user setup.

The lists below are ordered by decreasing severity. Security (what an attacker
can *do*) and privacy (what an attacker can *learn*) are kept separate.

## Security issues

1. **Remote code execution by design.** Every non-command message is passed to
   `claude -p` with `--permission-mode acceptEdits` by default (and the README
   suggests `--dangerously-skip-permissions` for unattended use). Claude runs
   with your full user privileges — no sandbox — so it can read your SSH keys,
   keychain, cloud credentials, and edit/delete any file you can. This is the
   feature; treat channel access as shell access.
   *Not mitigated in code.* Reduce it by running Claude with a confirming
   permission mode, as a dedicated low-privilege user, or inside a container/VM.

2. **Any channel participant is an operator.** The bridge trusts whoever the hub
   says is in the channel; there is no per-sender allowlist.
   - *Addressed:* it no longer accepts commands from non-user authors. Other
     agents/bots can no longer drive it even by `@mention` (closes the path
     where a prompt-injected sandboxed agent runs code on your laptop). See
     `handle_inbound` in [bridge.py](bridge.py).
   - *Still open:* any *human* the hub admits to the channel is fully trusted.
     There is no per-user authorization list in the bridge.

3. **The pairing token is an unscoped master key.**
   - *Addressed (bridge side):* the token can now be supplied via
     `AGORA_PAIRING_TOKEN` or `--token-file` (read a `chmod 600` file) instead of
     `--token`, which is visible to other local users in `ps`/`/proc`; `--token`
     still works but warns. The bridge also refuses plaintext `ws://` to any
     non-loopback host (`_reject_insecure_ws`), so a LAN misconfiguration can't
     send the token and traffic in the clear — use `wss://`.
   - *Still open (hub side, Rust):* the token rides in the URL query string
     (`?token=`) and so lands in server/proxy logs; it is unscoped (not limited
     to one agent id or channel set) and never expires. Fixing these means
     accepting the token from an `Authorization` header and adding scope/expiry
     to `PairingToken` in
     `crates/agora-core/src/server.rs` (`agent_ws`) and `config.rs`.

4. **`/new` could start a session in any directory.**
   - *Addressed:* `/new` is now gated by an allowlist. Set
     `CLAUDE_ALLOWED_ROOTS` (colon-separated) or `--allowed-roots`; the target is
     resolved (`Path.resolve()`, defeating `../`/symlink escapes) and must be
     equal to or under an allowed root. When unset, `/new` is **disabled**.
     See `_cmd_new` in [bridge.py](bridge.py).

5. **Orphaned Claude process after a failed run.**
   - *Addressed:* `run_claude` now kills the child on every exit path via a
     `finally` (previously only a timeout killed it). Before this, a stream
     parse error / disconnect left `claude` running and auto-applying edits
     after the user was told the run "failed."

6. **Bounded memory DoS on large output.** The subprocess stdout limit is 64 MB
   (raised from asyncio's 64 KB default so `stream-json` lines carrying whole
   files don't crash the reader). A single pathological line can still make the
   bridge buffer up to 64 MB. Acceptable for single-user use; note it if you
   ever multi-tenant this.

## Privacy issues

1. **`/sessions` discloses your work.** It scans `~/.claude/projects/` and posts
   each recent session's working-directory name and **last user prompt** (up to
   90 chars) into the channel. Anyone with channel access can enumerate what
   you're working on and read prompt fragments (possibly secrets you pasted).
   *Not mitigated.* Consider redacting prompts or gating `/sessions`.

2. **Reply exfiltration.** Replies are whatever Claude outputs, chunked at 8000
   chars. Any file Claude reads can be echoed straight into the channel. Inherent
   to the feature; bounded only by the permission mode (#1 in Security).

3. **`/status` leaks absolute paths** of the bound session's working directory.

4. **Credential/state at rest.**
   - `state.json` (channel→session bindings, working dirs) is written with the
     default umask and can be world-readable. `chmod 600` it, or point
     `STATE_FILE` at a private location.
   - The README's launchd fallback puts a plaintext `ANTHROPIC_API_KEY` in a
     plist under `~/Library/LaunchAgents/`. Prefer the OAuth keychain login where
     possible; if you must use a key file, restrict its permissions.

## Summary of what changed in code

| Issue | Status | Where |
|---|---|---|
| Non-user authors can drive it (2) | Fixed | `handle_inbound` |
| Orphaned child on failure (5) | Fixed | `run_claude` (finally-kill) |
| `/new` any directory (4) | Fixed | `_cmd_new` + `CLAUDE_ALLOWED_ROOTS` |
| Token on CLI / plaintext ws (3, partial) | Fixed (bridge side) | `main`, `_reject_insecure_ws` |
| RCE / no sandbox (1) | Open | operational (run Claude confined) |
| Token in query string, unscoped, no expiry (3) | Open | hub (`server.rs`, `config.rs`) |
| `/sessions` / `/status` disclosure (privacy 1, 3) | Open | `format_sessions`, `_cmd_status` |
| `state.json` perms, plaintext API key (privacy 4) | Open | operational |
