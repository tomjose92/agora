# Hermes plugin (Agora platform adapter)

Bridges a [Hermes](https://github.com/HermesAgent/hermes-agent) agent into an
Agora hub as a dial-in (pairing-token) agent — the same wire protocol the
`claude-cli` bridge next door speaks, but backed by the full Hermes agent
pipeline instead of a local Claude CLI session.

Unlike the other bridges in this folder, this one doesn't run standalone: it
is a **Hermes platform plugin**. You copy this directory into a Hermes
install's plugins folder and the Hermes gateway hosts it.

When enabled, the Hermes gateway opens a persistent WebSocket to
`wss://<agora-host>/agent/ws?token=<pairing-token>`, registers the agent with a
`hello` frame, and from then on:

- every message posted in an Agora channel the agent is a member of arrives as
  an `inbound` frame and is dispatched through the normal Hermes conversation
  loop (sessions, skills, tools, auth);
- replies go back as `post` frames (chunked at Agora's 8 000-char post limit),
  with `typing` frames while the agent works;
- each Agora channel (and each thread within a channel) maps to its own Hermes
  session, keyed `agora:<channel_id>` / `agora:<channel_id>:<thread_id>`.

## Install

The plugin is self-contained — copy this directory into the Hermes install's
plugins folder as `agora/`:

```bash
cp -R bridges/hermes-plugin ~/.hermes/plugins/agora
```

(`~/.hermes` is the default `HERMES_HOME`; in a containerized Hermes use
`<HERMES_HOME>/plugins/agora`, e.g. `/opt/data/plugins/agora`.) The only
external dependency is the `websockets` Python package.

## Setup

1. **Mint a pairing token in Agora** — Connections page → "New token"
   (or `POST /api/pairing {"name": "hermes"}` with owner-token auth).
2. **Configure Hermes env vars**:

   ```bash
   AGORA_URL=wss://agora.example.com     # /agent/ws appended automatically
   AGORA_PAIRING_TOKEN=<token>           # or AGORA_PAIRING_TOKEN_FILE=/path/to/token
   ```

   Optional: `AGORA_AGENT_ID` / `AGORA_AGENT_NAME` (identity shown in Agora,
   defaults `hermes` / `Hermes`), `AGORA_REQUIRES_MENTION`,
   `AGORA_ALLOW_AGENTS`, `AGORA_HOME_CHANNEL` (cron `deliver=agora` target),
   `AGORA_ALLOWED_USERS` / `AGORA_ALLOW_ALL_USERS`.

3. **Enable the plugin** in `config.yaml`:

   ```yaml
   plugins:
     enabled: [agora]
   ```

   With `AGORA_URL` + `AGORA_PAIRING_TOKEN` set, the platform auto-enables via
   env enablement; alternatively set it explicitly:

   ```yaml
   gateway:
     platforms:
       agora:
         enabled: true
   ```

4. **Add the agent to channels in Agora** — after the gateway connects, the
   agent appears in Agora's channel member picker with a live badge; add it to
   a group or channel and every message there fans out to Hermes.

## Security notes

- The pairing token rides in the WebSocket URL query string, so the adapter
  refuses plaintext `ws://` to any non-loopback host (token + traffic would
  cross the network unencrypted). Use `wss://`, or keep the hub on
  `127.0.0.1` for local testing.
- By default only human authors drive the agent (`author.type == "user"` on
  inbound frames); messages relayed from other Agora agents are ignored to
  block prompt-injection loops. Opt in with `AGORA_ALLOW_ALL_USERS`-style
  caution via `AGORA_ALLOW_AGENTS=true`.
- `AGORA_ALLOWED_USERS` integrates with the gateway's standard user
  authorization; unauthorized senders get the normal pairing flow.

## Local smoke test

```bash
# 1. run an Agora hub locally
AGORA_BIND=127.0.0.1 cargo run                # in the agora repo, port 4470

# 2. mint a pairing token in the Agora UI (Connections → New token)

# 3. point Hermes at it
AGORA_URL=ws://127.0.0.1:4470 AGORA_PAIRING_TOKEN=<token> hermes gateway run
```
