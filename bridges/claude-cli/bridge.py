#!/usr/bin/env python3
"""Claude CLI bridge for Agora.

Runs on the machine where you use Claude Code, dials into an Agora hub as a
dial-in agent (pairing token), and forwards channel messages to local Claude
CLI sessions via `claude -p --resume`. Lets you follow up on finished Claude
sessions from your phone while the laptop sits at home.

Protocol (see the Agora README, "Third-party agents"):
  -> {"type": "hello", "agents": [{"id", "name", "requires_mention"}]}
  <- {"type": "inbound", "agent_id", "channel_id", "thread_id", "text", ...}
  -> {"type": "post", "agent_id", "channel_id", "thread_id", "text"}
  -> {"type": "typing" | "progress", ...}   (optional niceties)

Only dependency: `pip install websockets`.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shlex
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

try:
    import websockets
except ImportError:  # pragma: no cover
    sys.exit("missing dependency: pip install websockets")

CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"
MAX_POST_CHARS = 8000
PROGRESS_THROTTLE = 2.0  # seconds between progress frames
TAIL_BYTES = 256 * 1024  # how much of a session .jsonl to scan for the last prompt
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}

# Models a channel may switch to via /model. Keys are what a user can type
# (short aliases + full ids); values are what we pass to `claude --model`.
# We allowlist rather than forward arbitrary strings into the subprocess argv.
ALLOWED_MODELS = {
    "opus": "opus",
    "sonnet": "sonnet",
    "haiku": "haiku",
    "fable": "claude-fable-5",
    "claude-opus-4-8": "claude-opus-4-8",
    "claude-sonnet-5": "claude-sonnet-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
    "claude-fable-5": "claude-fable-5",
}
MODEL_CHOICES = "opus | sonnet | haiku | fable (or a full model id) | default"

# Permission modes, ordered least→most privileged. The rank gates escalation:
# a channel may always *lower* privilege (e.g. → plan) but raising it above the
# bridge's startup default requires CLAUDE_ALLOW_PERMISSION_ESCALATION.
PERMISSION_RANK = {"plan": 0, "default": 1, "acceptEdits": 2, "bypassPermissions": 3}
_PERMISSION_ALIASES = {
    "plan": "plan",
    "default": "default",
    "acceptedits": "acceptEdits",
    "accept": "acceptEdits",
    "edits": "acceptEdits",
    "bypass": "bypassPermissions",
    "bypasspermissions": "bypassPermissions",
    "skip": "bypassPermissions",
}


def normalize_permission_mode(raw: str) -> str | None:
    """Map a user/CLI spelling to a canonical --permission-mode value (or None)."""
    return _PERMISSION_ALIASES.get((raw or "").strip().lower())


def split_permission_args(tokens: list[str]) -> tuple[str, list[str]]:
    """Pull the default permission mode out of the base claude args.

    Returns (default_mode, remaining_tokens). We strip any --permission-mode /
    --dangerously-skip-permissions from the shared base args so that the
    per-binding mode we always pass in run_claude can't collide with a second
    --permission-mode already present in CLAUDE_PERMISSION_ARGS.
    """
    mode = "default"
    out: list[str] = []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t == "--permission-mode" and i + 1 < len(tokens):
            mode = normalize_permission_mode(tokens[i + 1]) or mode
            i += 2
            continue
        if t.startswith("--permission-mode="):
            mode = normalize_permission_mode(t.split("=", 1)[1]) or mode
            i += 1
            continue
        if t == "--dangerously-skip-permissions":
            mode = "bypassPermissions"
            i += 1
            continue
        out.append(t)
        i += 1
    return mode, out


HELP = """Commands (everything else is forwarded to Claude):
/sessions [n] - list recent Claude CLI sessions
/use <n | session-id> - bind this channel/thread to a session
/new <dir> - bind to a fresh session in a directory (must be under an allowed root)
/model <opus|sonnet|haiku|fable|full-id|default> - set the model for this channel
/permissions <plan|acceptEdits|bypass|default|reset> - set the permission mode
/stop - cancel the run in flight on this channel
/status - show the current binding
/help - this message"""


def _reject_insecure_ws(url: str) -> None:
    """Refuse plaintext ws:// to a non-loopback host (token + traffic in clear)."""
    if not url.startswith("ws://"):
        return
    host = (urlsplit(url).hostname or "").lower()
    if host not in LOOPBACK_HOSTS and host not in {h.strip("[]") for h in LOOPBACK_HOSTS}:
        raise SystemExit(
            f"refusing plaintext ws:// to non-loopback host {host!r}: the pairing "
            "token and all messages would cross the network unencrypted. Use wss:// "
            "(or keep the hub on 127.0.0.1)."
        )


def parse_allowed_roots(raw: str) -> list[Path]:
    """Parse a colon-separated CLAUDE_ALLOWED_ROOTS into resolved directories."""
    roots: list[Path] = []
    for part in (raw or "").split(":"):
        part = part.strip()
        if not part:
            continue
        try:
            roots.append(Path(part).expanduser().resolve())
        except OSError:
            continue
    return roots


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------- session scan


def _extract_user_text(content) -> str | None:
    """Pull displayable text out of a user message's `content` field."""
    if isinstance(content, list):
        content = " ".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    if not isinstance(content, str):
        return None
    text = content.strip()
    # Skip meta/command noise (local-command caveats, /slash command records).
    if not text or text.startswith("<"):
        return None
    return text


def _scan_session_file(path: Path) -> dict | None:
    """Return {session_id, cwd, last_prompt, mtime} for one session .jsonl."""
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            if size > TAIL_BYTES:
                f.seek(size - TAIL_BYTES)
                f.readline()  # drop the partial line
            lines = f.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return None
    cwd, last_prompt = None, None
    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if cwd is None and rec.get("cwd"):
            cwd = rec["cwd"]
        if last_prompt is None and rec.get("type") == "user" and not rec.get("isMeta"):
            last_prompt = _extract_user_text(rec.get("message", {}).get("content"))
        if cwd and last_prompt:
            break
    if last_prompt is None:
        return None  # no real user turn in the tail; not worth listing
    return {
        "session_id": path.stem,
        "cwd": cwd or "?",
        "last_prompt": last_prompt,
        "mtime": path.stat().st_mtime,
    }


def recent_sessions(limit: int) -> list[dict]:
    files = sorted(
        CLAUDE_PROJECTS.glob("*/*.jsonl"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    out: list[dict] = []
    for path in files:
        if len(out) >= limit:
            break
        info = _scan_session_file(path)
        if info:
            out.append(info)
    return out


def find_session(session_id: str) -> dict | None:
    for path in CLAUDE_PROJECTS.glob(f"*/{session_id}.jsonl"):
        return _scan_session_file(path)
    return None


def _age(ts: float) -> str:
    delta = max(0, int(time.time() - ts))
    if delta < 3600:
        return f"{delta // 60}m ago"
    if delta < 86400:
        return f"{delta // 3600}h ago"
    return f"{delta // 86400}d ago"


def format_sessions(sessions: list[dict]) -> str:
    if not sessions:
        return "No Claude CLI sessions found."
    lines = []
    for i, s in enumerate(sessions, 1):
        prompt = s["last_prompt"].replace("\n", " ")
        if len(prompt) > 90:
            prompt = prompt[:90] + "…"
        proj = Path(s["cwd"]).name if s["cwd"] != "?" else "?"
        lines.append(f'{i}. {proj} — "{prompt}" ({_age(s["mtime"])})')
    lines.append("\nReply /use <n> to bind this channel to a session.")
    return "\n".join(lines)


# --------------------------------------------------------------------- bridge


class Bridge:
    def __init__(self, args: argparse.Namespace) -> None:
        self.url = self._normalize_url(args.url, args.token)
        self.agent_id = args.agent_id
        self.agent_name = args.agent_name
        self.claude_bin = args.claude_bin
        # Separate the default permission mode from the rest of the base args so
        # a per-binding /permissions choice can override it without duplication.
        self.default_permission_mode, self.base_claude_args = split_permission_args(
            shlex.split(args.claude_args)
        )
        self.default_model = (args.model or "").strip() or None
        self.allow_escalation = args.allow_permission_escalation
        self.timeout = args.timeout
        self.sessions_limit = args.sessions
        self.allowed_roots = parse_allowed_roots(args.allowed_roots)
        self.state_file = Path(args.state_file)
        self.bindings: dict[str, dict] = self._load_state()
        self.listings: dict[str, list[dict]] = {}  # binding key -> last /sessions result
        self.busy: set[str] = set()
        self.procs: dict[str, asyncio.subprocess.Process] = {}  # key -> running claude
        self.stop_requested: set[str] = set()  # keys whose run was cancelled via /stop
        self.outbox: asyncio.Queue = asyncio.Queue()

    @staticmethod
    def _normalize_url(url: str, token: str) -> str:
        url = url.rstrip("/")
        url = re.sub(r"^http://", "ws://", url)
        url = re.sub(r"^https://", "wss://", url)
        if not url.startswith(("ws://", "wss://")):
            url = "ws://" + url
        _reject_insecure_ws(url)
        if "/agent/ws" not in url:
            url += "/agent/ws"
        sep = "&" if "?" in url else "?"
        return f"{url}{sep}token={token}"

    # ------------------------------------------------------------- state

    def _load_state(self) -> dict[str, dict]:
        try:
            return json.loads(self.state_file.read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_state(self) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.state_file.write_text(json.dumps(self.bindings, indent=2))

    # ------------------------------------------------------------ frames

    def send(self, frame: dict) -> None:
        self.outbox.put_nowait(frame)

    def post(self, key_frame: dict, text: str) -> None:
        base = {
            "type": "post",
            "agent_id": self.agent_id,
            "channel_id": key_frame["channel_id"],
            "thread_id": key_frame.get("thread_id"),
        }
        while text:
            chunk, text = text[:MAX_POST_CHARS], text[MAX_POST_CHARS:]
            self.send({**base, "text": chunk})

    def typing(self, frame: dict, active: bool) -> None:
        self.send({
            "type": "typing",
            "agent_id": self.agent_id,
            "channel_id": frame["channel_id"],
            "thread_id": frame.get("thread_id"),
            "active": active,
        })

    def progress(self, frame: dict, text: str) -> None:
        self.send({
            "type": "progress",
            "agent_id": self.agent_id,
            "channel_id": frame["channel_id"],
            "thread_id": frame.get("thread_id"),
            "handle": f"claude:{frame['channel_id']}:{frame.get('thread_id') or 0}",
            "text": text,
        })

    # ----------------------------------------------------------- inbound

    @staticmethod
    def binding_key(frame: dict) -> str:
        tid = frame.get("thread_id")
        cid = frame["channel_id"]
        return f"{cid}:{tid}" if tid else cid

    def _strip_mention(self, text: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", self.agent_name.lower()).strip("-")
        return re.sub(
            rf"^@({re.escape(self.agent_id)}|{re.escape(slug)})\b[:,]?\s*",
            "",
            text.strip(),
            flags=re.IGNORECASE,
        )

    async def handle_inbound(self, frame: dict) -> None:
        # Only humans may drive Claude. Non-user authors (other agents/bots) are
        # ignored even when they @mention us: a prompt-injected agent in the same
        # channel must never be able to run code on this machine.
        if frame.get("author", {}).get("type") != "user":
            return
        text = self._strip_mention(frame.get("text") or "")
        if not text:
            return
        key = self.binding_key(frame)
        cmd, _, rest = text.partition(" ")
        cmd, rest = cmd.lower(), rest.strip()
        if cmd == "/help":
            self.post(frame, HELP)
        elif cmd == "/sessions":
            limit = int(rest) if rest.isdigit() else self.sessions_limit
            sessions = await asyncio.to_thread(recent_sessions, limit)
            self.listings[key] = sessions
            self.post(frame, format_sessions(sessions))
        elif cmd == "/use":
            self.post(frame, await asyncio.to_thread(self._cmd_use, key, rest))
        elif cmd == "/new":
            self.post(frame, self._cmd_new(key, rest))
        elif cmd == "/model":
            self.post(frame, self._cmd_model(key, rest))
        elif cmd == "/permissions":
            self.post(frame, self._cmd_permissions(key, rest))
        elif cmd == "/stop":
            self.post(frame, self._cmd_stop(key))
        elif cmd == "/status":
            self.post(frame, self._cmd_status(key))
        elif cmd.startswith("/"):
            self.post(frame, f"Unknown command {cmd}.\n{HELP}")
        else:
            await self.forward_to_claude(key, frame, text)

    # ---------------------------------------------------------- commands

    def _cmd_use(self, key: str, arg: str) -> str:
        if not arg:
            return "Usage: /use <n from /sessions | session-id>"
        if arg.isdigit():
            listing = self.listings.get(key) or recent_sessions(self.sessions_limit)
            idx = int(arg) - 1
            if not 0 <= idx < len(listing):
                return f"No session #{arg} — run /sessions first."
            info = listing[idx]
        else:
            info = find_session(arg)
            if not info:
                return f"Session {arg} not found under {CLAUDE_PROJECTS}."
        self.bindings[key] = {"session_id": info["session_id"], "cwd": info["cwd"]}
        self._save_state()
        prompt = info["last_prompt"][:120]
        return (
            f"Bound to session {info['session_id'][:8]}… in {info['cwd']}\n"
            f'Last prompt: "{prompt}"\nJust type to continue it.'
        )

    def _cmd_new(self, key: str, arg: str) -> str:
        if not arg:
            return "Usage: /new <directory>"
        if not self.allowed_roots:
            return (
                "/new is disabled: no allowed roots configured. Set "
                "CLAUDE_ALLOWED_ROOTS (colon-separated dirs) or --allowed-roots "
                "on the bridge, then restart it."
            )
        try:
            cwd = Path(arg).expanduser().resolve()
        except OSError as e:
            return f"Cannot resolve {arg!r}: {e}"
        if not cwd.is_dir():
            return f"Not a directory: {cwd}"
        if not any(cwd == root or cwd.is_relative_to(root) for root in self.allowed_roots):
            allowed = ", ".join(str(r) for r in self.allowed_roots)
            return f"{cwd} is not under an allowed root. Allowed: {allowed}"
        self.bindings[key] = {"session_id": None, "cwd": str(cwd)}
        self._save_state()
        return f"Will start a fresh Claude session in {cwd} on your next message."

    def _cmd_model(self, key: str, arg: str) -> str:
        b = self.bindings.get(key)
        if not b:
            return "No session bound here. Run /sessions then /use <n>."
        if not arg:
            cur = b.get("model") or self.default_model or "session default"
            return f"Model: {cur}\nUsage: /model <{MODEL_CHOICES}>"
        choice = arg.strip().lower()
        if choice == "default":
            b.pop("model", None)
            self.bindings[key] = b
            self._save_state()
            fell_back = self.default_model or "session default"
            return f"Model reset to the bridge default ({fell_back})."
        model = ALLOWED_MODELS.get(choice)
        if not model:
            return f"Unknown model {arg!r}. Options: {MODEL_CHOICES}"
        b["model"] = model
        self.bindings[key] = b
        self._save_state()
        return f"Model set to {model} for this channel."

    def _cmd_permissions(self, key: str, arg: str) -> str:
        b = self.bindings.get(key)
        if not b:
            return "No session bound here. Run /sessions then /use <n>."
        default = self.default_permission_mode
        if not arg:
            cur = b.get("permission_mode") or default
            return (
                f"Permission mode: {cur} (bridge default: {default})\n"
                "Usage: /permissions <plan | acceptEdits | bypass | default | reset>"
            )
        choice = arg.strip().lower()
        if choice == "reset":
            b.pop("permission_mode", None)
            self.bindings[key] = b
            self._save_state()
            return f"Permission mode reset to the bridge default ({default})."
        mode = normalize_permission_mode(choice)
        if not mode:
            return "Unknown mode. Options: plan, acceptEdits, bypass, default, reset."
        if PERMISSION_RANK[mode] > PERMISSION_RANK[default] and not self.allow_escalation:
            return (
                f"Refusing to escalate from {default} to {mode}: privilege escalation "
                "is disabled. Restart the bridge with "
                "CLAUDE_ALLOW_PERMISSION_ESCALATION=1 to allow it. You can always "
                "lower privilege (e.g. /permissions plan)."
            )
        b["permission_mode"] = mode
        self.bindings[key] = b
        self._save_state()
        return f"Permission mode set to {mode} for this channel."

    def _cmd_stop(self, key: str) -> str:
        proc = self.procs.get(key)
        if not proc or proc.returncode is not None:
            return "Nothing running here."
        self.stop_requested.add(key)
        proc.kill()
        return "Stopping the current run…"

    def _cmd_status(self, key: str) -> str:
        b = self.bindings.get(key)
        if not b:
            return "No session bound here. Run /sessions then /use <n>."
        sid = b["session_id"][:8] + "…" if b["session_id"] else "(new, not started)"
        model = b.get("model") or self.default_model or "session default"
        mode = b.get("permission_mode") or self.default_permission_mode
        busy = " — a run is in flight" if key in self.busy else ""
        return f"Session {sid} in {b['cwd']}\nModel: {model}\nPermissions: {mode}{busy}"

    # ------------------------------------------------------------ claude

    async def forward_to_claude(self, key: str, frame: dict, text: str) -> None:
        binding = self.bindings.get(key)
        if not binding:
            self.post(frame, "No session bound here yet. Run /sessions then /use <n>.")
            return
        if key in self.busy:
            self.post(frame, "Still working on the previous message — try again when it's done.")
            return
        self.busy.add(key)
        self.typing(frame, True)
        try:
            reply = await self.run_claude(key, frame, binding, text)
            self.post(frame, reply or "(empty response)")
        except Exception as e:  # degrade to a chat message, never crash the loop
            log(f"claude run failed: {e!r}")
            self.post(frame, f"Claude run failed: {e}")
        finally:
            self.busy.discard(key)
            self.typing(frame, False)

    async def run_claude(self, key: str, frame: dict, binding: dict, text: str) -> str:
        mode = binding.get("permission_mode") or self.default_permission_mode
        model = binding.get("model") or self.default_model
        cmd = [
            self.claude_bin, "-p", text,
            "--output-format", "stream-json", "--verbose",
            "--permission-mode", mode,
            *self.base_claude_args,
        ]
        if model:
            cmd += ["--model", model]
        if binding.get("session_id"):
            cmd += ["--resume", binding["session_id"]]
        log(f"run: session={binding.get('session_id')} cwd={binding['cwd']} "
            f"model={model or 'default'} mode={mode}")
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=binding["cwd"],
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
            # stream-json events are single lines that can carry whole file
            # contents; the default 64 KB readline limit is far too small.
            limit=64 * 1024 * 1024,
        )
        self.procs[key] = proc  # so /stop can find and kill this run
        result_text, last_progress = None, 0.0
        try:
            async with asyncio.timeout(self.timeout):
                assert proc.stdout is not None
                async for raw in proc.stdout:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    kind = event.get("type")
                    if kind == "assistant":
                        snippet = self._progress_snippet(event)
                        if snippet and time.monotonic() - last_progress > PROGRESS_THROTTLE:
                            last_progress = time.monotonic()
                            self.progress(frame, snippet)
                    elif kind == "result":
                        result_text = event.get("result") or ""
                        if event.get("is_error"):
                            result_text = f"(claude error) {result_text}"
                        else:
                            # Resuming with -p can fork to a new session id;
                            # track it (successful runs only) so follow-ups
                            # keep continuing the same conversation.
                            new_sid = event.get("session_id")
                            if new_sid and new_sid != binding.get("session_id"):
                                binding["session_id"] = new_sid
                                self.bindings[key] = binding
                                self._save_state()
                await proc.wait()
        except TimeoutError:
            raise RuntimeError(f"timed out after {self.timeout}s")
        finally:
            # Never leave an orphaned claude running: any exit path (timeout,
            # stream parse error, disconnect, cancellation) must kill the child,
            # otherwise it keeps auto-applying edits after a reported failure.
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
            self.procs.pop(key, None)
        if key in self.stop_requested:
            self.stop_requested.discard(key)
            return "Stopped."
        if result_text is None:
            stderr = (await proc.stderr.read()).decode("utf-8", errors="replace").strip()
            raise RuntimeError(stderr[-500:] or f"claude exited {proc.returncode} with no result")
        return result_text

    @staticmethod
    def _progress_snippet(event: dict) -> str | None:
        blocks = event.get("message", {}).get("content") or []
        texts, tools = [], []
        for b in blocks:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and b.get("text"):
                texts.append(b["text"])
            elif b.get("type") == "tool_use":
                tools.append(b.get("name", "tool"))
        if texts:
            snippet = " ".join(texts)[-200:]
            return snippet
        if tools:
            return "using " + ", ".join(tools)
        return None

    # --------------------------------------------------------- main loop

    async def run(self) -> None:
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(self.url, max_size=64 * 1024 * 1024) as ws:
                    log("connected, registering agent")
                    await ws.send(json.dumps({
                        "type": "hello",
                        "agents": [{
                            "id": self.agent_id,
                            "name": self.agent_name,
                            "requires_mention": False,
                        }],
                    }))
                    backoff = 1.0
                    await self._pump(ws)
            except (OSError, websockets.WebSocketException) as e:
                log(f"disconnected: {e!r}")
            except asyncio.CancelledError:
                raise
            log(f"reconnecting in {backoff:.0f}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)

    async def _pump(self, ws) -> None:
        async def sender() -> None:
            while True:
                frame = await self.outbox.get()
                await ws.send(json.dumps(frame))

        send_task = asyncio.create_task(sender())
        try:
            async for raw in ws:
                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if frame.get("type") == "inbound" and frame.get("agent_id") == self.agent_id:
                    asyncio.create_task(self.handle_inbound(frame))
        finally:
            send_task.cancel()


def main() -> None:
    default_state = Path(__file__).resolve().parent / "state.json"
    ap = argparse.ArgumentParser(description="Claude CLI bridge for Agora")
    ap.add_argument("--url", default=os.environ.get("AGORA_URL", "ws://127.0.0.1:4470"),
                    help="Agora base URL (http(s)/ws(s); /agent/ws appended if missing)")
    ap.add_argument("--token", default=None,
                    help="pairing token. DISCOURAGED on the CLI (visible in ps/proc); "
                         "prefer AGORA_PAIRING_TOKEN or --token-file")
    ap.add_argument("--token-file", default=os.environ.get("AGORA_PAIRING_TOKEN_FILE"),
                    help="read the pairing token from this file (chmod 600 it)")
    ap.add_argument("--allowed-roots", default=os.environ.get("CLAUDE_ALLOWED_ROOTS", ""),
                    help="colon-separated dirs /new sessions may start under; "
                         "/new is disabled when empty")
    ap.add_argument("--agent-id", default=os.environ.get("AGENT_ID", "claude-cli"))
    ap.add_argument("--agent-name", default=os.environ.get("AGENT_NAME", "Claude"))
    ap.add_argument("--claude-bin", default=os.environ.get("CLAUDE_BIN", "claude"))
    ap.add_argument("--claude-args",
                    default=os.environ.get("CLAUDE_PERMISSION_ARGS", "--permission-mode acceptEdits"),
                    help="extra args for every claude run (permissions etc.); the "
                         "permission mode here is the default, overridable per channel "
                         "with /permissions")
    ap.add_argument("--model", default=os.environ.get("CLAUDE_MODEL", ""),
                    help="default model for every run (channels can override with "
                         f"/model); one of: {MODEL_CHOICES}")
    ap.add_argument("--allow-permission-escalation", action="store_true",
                    default=os.environ.get("CLAUDE_ALLOW_PERMISSION_ESCALATION", "").lower()
                    in ("1", "true", "yes"),
                    help="allow /permissions to raise privilege above the bridge "
                         "default (off by default; lowering privilege is always allowed)")
    ap.add_argument("--timeout", type=int, default=int(os.environ.get("CLAUDE_TIMEOUT", "1800")),
                    help="per-run timeout in seconds")
    ap.add_argument("--sessions", type=int, default=int(os.environ.get("SESSIONS_LIMIT", "10")),
                    help="how many sessions /sessions lists")
    ap.add_argument("--state-file", default=os.environ.get("STATE_FILE", str(default_state)))
    args = ap.parse_args()
    if args.token:
        log("warning: --token on the command line is visible to other local users "
            "(ps/proc). Prefer AGORA_PAIRING_TOKEN or --token-file.")
    else:
        if args.token_file:
            try:
                args.token = Path(args.token_file).expanduser().read_text().strip()
            except OSError as e:
                ap.error(f"cannot read --token-file {args.token_file}: {e}")
        else:
            args.token = os.environ.get("AGORA_PAIRING_TOKEN", "")
    if not args.token:
        ap.error("a pairing token is required (AGORA_PAIRING_TOKEN, --token-file, or --token)")
    log(f"claude-cli bridge -> {re.sub(r'token=[^&]+', 'token=***', Bridge._normalize_url(args.url, args.token))}")
    try:
        asyncio.run(Bridge(args).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
