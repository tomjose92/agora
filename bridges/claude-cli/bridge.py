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

try:
    import websockets
except ImportError:  # pragma: no cover
    sys.exit("missing dependency: pip install websockets")

CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"
MAX_POST_CHARS = 8000
PROGRESS_THROTTLE = 2.0  # seconds between progress frames
TAIL_BYTES = 256 * 1024  # how much of a session .jsonl to scan for the last prompt

HELP = """Commands (everything else is forwarded to Claude):
/sessions [n] - list recent Claude CLI sessions
/use <n | session-id> - bind this channel/thread to a session
/new <dir> - bind to a fresh session in a directory
/status - show the current binding
/help - this message"""


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
        self.claude_args = shlex.split(args.claude_args)
        self.timeout = args.timeout
        self.sessions_limit = args.sessions
        self.state_file = Path(args.state_file)
        self.bindings: dict[str, dict] = self._load_state()
        self.listings: dict[str, list[dict]] = {}  # binding key -> last /sessions result
        self.busy: set[str] = set()
        self.outbox: asyncio.Queue = asyncio.Queue()

    @staticmethod
    def _normalize_url(url: str, token: str) -> str:
        url = url.rstrip("/")
        url = re.sub(r"^http://", "ws://", url)
        url = re.sub(r"^https://", "wss://", url)
        if not url.startswith(("ws://", "wss://")):
            url = "ws://" + url
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
        if frame.get("author", {}).get("type") != "user" and not frame.get("mentioned"):
            return  # ignore other bots unless they @mention us
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
        cwd = Path(arg).expanduser()
        if not cwd.is_dir():
            return f"Not a directory: {cwd}"
        self.bindings[key] = {"session_id": None, "cwd": str(cwd)}
        self._save_state()
        return f"Will start a fresh Claude session in {cwd} on your next message."

    def _cmd_status(self, key: str) -> str:
        b = self.bindings.get(key)
        if not b:
            return "No session bound here. Run /sessions then /use <n>."
        sid = b["session_id"][:8] + "…" if b["session_id"] else "(new, not started)"
        busy = " — a run is in flight" if key in self.busy else ""
        return f"Session {sid} in {b['cwd']}{busy}"

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
        cmd = [
            self.claude_bin, "-p", text,
            "--output-format", "stream-json", "--verbose",
            *self.claude_args,
        ]
        if binding.get("session_id"):
            cmd += ["--resume", binding["session_id"]]
        log(f"run: session={binding.get('session_id')} cwd={binding['cwd']}")
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=binding["cwd"],
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
        )
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
            proc.kill()
            await proc.wait()
            raise RuntimeError(f"timed out after {self.timeout}s")
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
    ap.add_argument("--token", default=os.environ.get("AGORA_PAIRING_TOKEN", ""),
                    help="pairing token (Connections page or POST /api/pairing)")
    ap.add_argument("--agent-id", default=os.environ.get("AGENT_ID", "claude-cli"))
    ap.add_argument("--agent-name", default=os.environ.get("AGENT_NAME", "Claude"))
    ap.add_argument("--claude-bin", default=os.environ.get("CLAUDE_BIN", "claude"))
    ap.add_argument("--claude-args",
                    default=os.environ.get("CLAUDE_PERMISSION_ARGS", "--permission-mode acceptEdits"),
                    help="extra args for every claude run (permissions etc.)")
    ap.add_argument("--timeout", type=int, default=int(os.environ.get("CLAUDE_TIMEOUT", "1800")),
                    help="per-run timeout in seconds")
    ap.add_argument("--sessions", type=int, default=int(os.environ.get("SESSIONS_LIMIT", "10")),
                    help="how many sessions /sessions lists")
    ap.add_argument("--state-file", default=os.environ.get("STATE_FILE", str(default_state)))
    args = ap.parse_args()
    if not args.token:
        ap.error("--token (or AGORA_PAIRING_TOKEN) is required")
    log(f"claude-cli bridge -> {re.sub(r'token=[^&]+', 'token=***', Bridge._normalize_url(args.url, args.token))}")
    try:
        asyncio.run(Bridge(args).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
