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
import base64
import binascii
import json
import os
import re
import shlex
import shutil
import sys
import tempfile
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

HELP = """Commands (everything else is forwarded to Claude):
/sessions [n] - list recent Claude CLI sessions
/use <n | session-id> - bind this channel/thread to a session
/new <dir> - bind to a fresh session in a directory (must be under an allowed root)
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


# ----------------------------------------------------------- attachments


def _safe_filename(name: str) -> str:
    """Reduce an untrusted attachment filename to a harmless basename.

    Strips any directory components (defeating ``../`` traversal) and replaces
    anything outside a conservative charset, so a channel member can't steer
    where the file lands or smuggle shell/path metacharacters into the prompt.
    """
    name = os.path.basename(name or "")
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name).lstrip(".")
    return name[:120] or "attachment"


def _unique_path(dest: Path, name: str) -> Path:
    """A path under ``dest`` for ``name`` that doesn't collide with a sibling."""
    path = dest / name
    if not path.exists():
        return path
    stem, dot, ext = name.partition(".")
    i = 1
    while True:
        cand = dest / f"{stem}-{i}{dot}{ext}"
        if not cand.exists():
            return cand
        i += 1


def materialize_attachments(attachments: list, dest_dir: Path) -> tuple[list[Path], list[str]]:
    """Write inlined attachment bytes into ``dest_dir`` for Claude to read.

    The hub inlines files up to a size cap as base64 (``data_b64``); larger ones
    arrive as name-only refs with no bytes. Returns the saved paths plus a list
    of human/agent-readable note lines describing every attachment (saved,
    oversized, or undecodable) to append to the prompt.
    """
    saved: list[Path] = []
    notes: list[str] = []
    for att in attachments:
        if not isinstance(att, dict):
            continue
        filename = att.get("filename") or "attachment"
        mime = att.get("mime") or "application/octet-stream"
        b64 = att.get("data_b64")
        if not b64:
            size = att.get("size")
            notes.append(
                f"- {filename} ({mime}, {size} bytes) — too large to inline; not available locally"
            )
            continue
        try:
            data = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            notes.append(f"- {filename} ({mime}) — could not be decoded, skipped")
            continue
        path = _unique_path(dest_dir, _safe_filename(filename))
        try:
            path.write_bytes(data)
        except OSError as e:
            notes.append(f"- {filename} ({mime}) — could not be written ({e}), skipped")
            continue
        saved.append(path)
        notes.append(f"- {path} ({mime}, {len(data)} bytes)")
    return saved, notes


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
        self.allowed_roots = parse_allowed_roots(args.allowed_roots)
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
        # An image/file with no caption is still a real turn — forward it so
        # long as something (text or an attachment) actually came through.
        if not text and not (frame.get("attachments") or []):
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

    def _stage_attachments(self, frame: dict, text: str) -> tuple[str, list[str], str | None]:
        """Drop any inbound attachments to a temp dir and build the prompt.

        Returns ``(prompt, extra_args, tmpdir)``. Bytes are written to a fresh
        temp dir which is exposed to Claude via ``--add-dir`` (so its Read tool
        can open them without prompting), and every saved path is named in the
        prompt so the model knows to look at them. ``tmpdir`` is ``None`` when
        there's nothing to stage; the caller removes it after the run.
        """
        attachments = frame.get("attachments") or []
        if not attachments:
            return text, [], None
        tmpdir = tempfile.mkdtemp(prefix="agora-att-")
        saved, notes = materialize_attachments(attachments, Path(tmpdir))
        prompt = text
        if notes:
            block = "The Agora message included these attachments:\n" + "\n".join(notes)
            prompt = f"{text}\n\n{block}".strip() if text else block
        extra_args = ["--add-dir", tmpdir] if saved else []
        if not saved:
            # Nothing landed on disk (all oversized/undecodable) — no point
            # keeping an empty dir around or widening Claude's read scope.
            shutil.rmtree(tmpdir, ignore_errors=True)
            tmpdir = None
        return prompt, extra_args, tmpdir

    async def run_claude(self, key: str, frame: dict, binding: dict, text: str) -> str:
        prompt, extra_args, tmpdir = self._stage_attachments(frame, text)
        try:
            cmd = [
                self.claude_bin, "-p", prompt,
                "--output-format", "stream-json", "--verbose",
                *extra_args,
                *self.claude_args,
            ]
            if binding.get("session_id"):
                cmd += ["--resume", binding["session_id"]]
            log(f"run: session={binding.get('session_id')} cwd={binding['cwd']}"
                + (f" attachments@{tmpdir}" if tmpdir else ""))
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
                # stream parse error, disconnect, cancellation) must kill the
                # child, otherwise it keeps auto-applying edits after a reported
                # failure.
                if proc.returncode is None:
                    proc.kill()
                    await proc.wait()
            if result_text is None:
                stderr = (await proc.stderr.read()).decode("utf-8", errors="replace").strip()
                raise RuntimeError(stderr[-500:] or f"claude exited {proc.returncode} with no result")
            return result_text
        finally:
            if tmpdir:
                shutil.rmtree(tmpdir, ignore_errors=True)

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
                    help="extra args for every claude run (permissions etc.)")
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
