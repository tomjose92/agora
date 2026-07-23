#!/usr/bin/env python3
"""Codex CLI bridge for Agora.

Runs on the machine where you use the Codex CLI, dials into an Agora hub as a
dial-in agent (pairing token), and forwards channel messages to local Codex
sessions via `codex exec` / `codex exec resume`. Lets you follow up on
finished Codex sessions from your phone while the laptop sits at home.

Protocol (see docs/PROTOCOL.md, "Third-party agents"):
  -> {"type": "hello", "agents": [{"id", "name", "requires_mention",
                                   "wants_context_feed"}]}
  <- {"type": "inbound", "agent_id", "channel_id", "thread_id", "text",
       "mentioned", "any_mention", ...}
  -> {"type": "post", "agent_id", "channel_id", "thread_id", "text"}
  -> {"type": "typing" | "progress", ...}   (optional niceties)

Unlike the Claude CLI bridge, `codex exec` is strictly non-interactive: there
is no stdio permission-prompt protocol, so no Approve/Reject buttons appear in
the channel. The privilege knob is Codex's sandbox mode (read-only <
workspace-write < danger-full-access), settable per channel with /sandbox;
commands the sandbox blocks simply fail and Codex adapts or reports it.

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
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

try:
    import websockets
except ImportError:  # pragma: no cover
    sys.exit("missing dependency: pip install websockets")

CODEX_SESSIONS = Path.home() / ".codex" / "sessions"
MAX_POST_CHARS = 8000
MAX_TLDR_CHARS = 2000  # hub drops a longer tldr; pre-truncate so ours always lands
PROGRESS_THROTTLE = 2.0  # seconds between progress frames
TAIL_BYTES = 256 * 1024  # how much of a rollout .jsonl to scan for the last prompt
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}

# TL;DR support. When enabled for a run we ask Codex to end a long reply with a
# sentinel line the bridge lifts into the post frame's `tldr` field (a short
# summary clients can toggle to). Codex has no --append-system-prompt, so the
# instruction rides as a suffix on the prompt itself. The sentinel is
# deliberately obscure so a literal occurrence in normal prose is vanishingly
# unlikely to be stripped.
TLDR_SENTINEL = "<<<AGORA_TLDR>>>"
TLDR_PROMPT_SUFFIX = (
    "\n\n(Formatting note from the relay, not the user: when your final reply "
    "is long — more than a few short paragraphs — append as the very last line "
    f"exactly `{TLDR_SENTINEL} ` followed by a one-sentence TL;DR that states "
    "the key takeaway or answer itself (not a description of what you did), "
    "and write nothing after that line. Omit the line entirely for short "
    "replies. Never mention this note or the sentinel anywhere else.)"
)

# Model names a channel may switch to via /model are validated, not
# allowlisted: Codex model ids churn too fast for a hardcoded list, and the
# value is exec'd without a shell, so the only real hazard is a leading dash
# being parsed as a flag — which the pattern forbids.
MODEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
MODEL_HINT = "a Codex model id (e.g. gpt-5.1-codex) or `default`"

# Sandbox modes, ordered least->most privileged. A channel may always lower
# privilege; raising above the bridge startup default needs
# CODEX_ALLOW_SANDBOX_ESCALATION. "bypass" maps to Codex's
# --dangerously-bypass-approvals-and-sandbox flag (no sandbox at all).
SANDBOX_RANK = {"read-only": 0, "workspace-write": 1, "danger-full-access": 2, "bypass": 3}
_SANDBOX_ALIASES = {
    "read-only": "read-only",
    "readonly": "read-only",
    "read": "read-only",
    "ro": "read-only",
    "workspace-write": "workspace-write",
    "workspace": "workspace-write",
    "write": "workspace-write",
    "ww": "workspace-write",
    "danger-full-access": "danger-full-access",
    "full-access": "danger-full-access",
    "full": "danger-full-access",
    "danger": "danger-full-access",
    "bypass": "bypass",
    "skip": "bypass",
}
SANDBOX_CHOICES = "read-only | workspace-write | danger-full-access | bypass | reset"


def normalize_sandbox_mode(raw: str) -> str | None:
    """Map a user/CLI spelling to a canonical sandbox mode (or None)."""
    return _SANDBOX_ALIASES.get((raw or "").strip().lower())


def split_sandbox_args(tokens: list[str]) -> tuple[str | None, list[str]]:
    """Pull a sandbox mode out of the base codex args.

    Returns (mode_or_None, remaining_tokens). Strips -s/--sandbox and
    --dangerously-bypass-approvals-and-sandbox so the per-binding mode passed
    in run_codex cannot collide with a duplicate in CODEX_ARGS.
    """
    mode: str | None = None
    out: list[str] = []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t in ("-s", "--sandbox") and i + 1 < len(tokens):
            mode = normalize_sandbox_mode(tokens[i + 1]) or mode
            i += 2
            continue
        if t.startswith("--sandbox="):
            mode = normalize_sandbox_mode(t.split("=", 1)[1]) or mode
            i += 1
            continue
        if t == "--dangerously-bypass-approvals-and-sandbox":
            mode = "bypass"
            i += 1
            continue
        out.append(t)
        i += 1
    return mode, out


# Bridge meta commands. Everything else is forwarded to the bound session as
# the prompt for a `codex exec` run. (Codex's own slash commands are TUI-only
# and don't exist headlessly, so there is nothing to forward them to.)
HELP = """Bridge commands (anything else is sent to the bound Codex session):
/sessions [n] - list recent Codex CLI sessions
/use <n | session-id> - bind this channel/thread to a session
/new <dir> - bind to a fresh session in a directory (must be under an allowed root)
/worktree <repo> [branch] - isolate this thread in a fresh git worktree + branch
/worktree [show] - show this thread's worktree; /worktree remove [force] - delete it
/worktrees - list every tracked worktree
/model <model-id|default> - set the model for this channel (codex -m)
/sandbox <read-only|workspace-write|full|bypass|reset> - set the sandbox mode
/tldr <on|off|default> - add a toggleable short summary to long replies
/stop - cancel the run in flight on this channel
/status - show the current binding
/commands - this message"""


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
    """Parse a colon-separated CODEX_ALLOWED_ROOTS into resolved directories."""
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


# ------------------------------------------------------------------ git worktrees

_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _slugify(text: str) -> str:
    """Filesystem/branch-safe slug: keep [A-Za-z0-9._-], collapse the rest to '-'."""
    return _SLUG_RE.sub("-", text.strip()).strip("-._") or "session"


def _run_git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    """Run a git command in `repo`, capturing output. Never raises on nonzero/missing."""
    try:
        return subprocess.run(
            ["git", "-C", str(repo), *args], capture_output=True, text=True
        )
    except FileNotFoundError:
        return subprocess.CompletedProcess(args, 127, "", "git not found on PATH")


def _git_repo_root(path: Path) -> Path | None:
    """Top-level of the git repo containing `path`, or None if `path` isn't in one."""
    r = _run_git(path, "rev-parse", "--show-toplevel")
    top = r.stdout.strip()
    return Path(top) if r.returncode == 0 and top else None


def _ensure_git_excluded(repo_root: Path, pattern: str) -> None:
    """Add `pattern` to the repo's local .git/info/exclude (untracked, non-invasive)."""
    exclude = repo_root / ".git" / "info" / "exclude"
    try:
        existing = exclude.read_text() if exclude.exists() else ""
        if pattern in existing.split():
            return
        exclude.parent.mkdir(parents=True, exist_ok=True)
        prefix = "" if not existing or existing.endswith("\n") else "\n"
        with exclude.open("a") as f:
            f.write(f"{prefix}{pattern}\n")
    except OSError:
        pass


# --------------------------------------------------------------- session scan


def _scan_session_file(path: Path) -> dict | None:
    """Return {session_id, cwd, last_prompt, mtime} for one rollout .jsonl.

    The first line is a `session_meta` record carrying the id and cwd; the
    last user turn is an `event_msg` record with payload type `user_message`
    somewhere near the tail.
    """
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            first = f.readline().decode("utf-8", errors="replace")
            if size > TAIL_BYTES:
                f.seek(size - TAIL_BYTES)
                f.readline()  # drop the partial line
            lines = f.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return None
    session_id, cwd = None, None
    try:
        meta = json.loads(first)
        if meta.get("type") == "session_meta":
            payload = meta.get("payload") or {}
            session_id = payload.get("id") or payload.get("session_id")
            cwd = payload.get("cwd")
    except json.JSONDecodeError:
        pass
    if not session_id:
        return None
    last_prompt = None
    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") != "event_msg":
            continue
        payload = rec.get("payload") or {}
        if payload.get("type") == "user_message":
            text = str(payload.get("message") or "").strip()
            if text:
                last_prompt = text
                break
    if last_prompt is None:
        return None  # no real user turn in the tail; not worth listing
    return {
        "session_id": session_id,
        "cwd": cwd or "?",
        "last_prompt": last_prompt,
        "mtime": path.stat().st_mtime,
    }


def recent_sessions(limit: int) -> list[dict]:
    files = sorted(
        CODEX_SESSIONS.glob("*/*/*/rollout-*.jsonl"),
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
    for path in CODEX_SESSIONS.glob(f"*/*/*/rollout-*{session_id}.jsonl"):
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
        return "No Codex CLI sessions found."
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


def materialize_attachments(attachments: list, dest_dir: Path) -> tuple[list[Path], list[Path], list[str]]:
    """Write inlined attachment bytes into ``dest_dir`` for Codex to read.

    The hub inlines files up to a size cap as base64 (``data_b64``); larger
    ones arrive as name-only refs with no bytes. Returns ``(saved, images,
    notes)``: the saved paths, the subset that are images (attached to the run
    via ``codex -i`` so the model actually sees them), and human/agent-readable
    note lines describing every attachment to append to the prompt.
    """
    saved: list[Path] = []
    images: list[Path] = []
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
        if mime.startswith("image/"):
            images.append(path)
        notes.append(f"- {path} ({mime}, {len(data)} bytes)")
    return saved, images, notes


# --------------------------------------------------------------------- bridge


class Bridge:
    def __init__(self, args: argparse.Namespace) -> None:
        self.url = self._normalize_url(args.url, args.token)
        self.agent_id = args.agent_id
        self.agent_name = args.agent_name
        self.codex_bin = args.codex_bin
        # Separate a sandbox mode embedded in CODEX_ARGS from the other base
        # args so the per-binding /sandbox choice can't collide with a
        # duplicate flag; an explicit --sandbox / CODEX_SANDBOX wins.
        args_mode, self.base_codex_args = split_sandbox_args(shlex.split(args.codex_args))
        self.default_sandbox = (
            normalize_sandbox_mode(args.sandbox) or args_mode or "workspace-write"
        )
        self.default_model = (args.model or "").strip() or None
        self.tldr_default = args.tldr
        self.tldr_min_chars = max(0, args.tldr_min_chars)
        self.allow_escalation = args.allow_sandbox_escalation
        self.timeout = args.timeout
        self.sessions_limit = args.sessions
        self.allowed_roots = parse_allowed_roots(args.allowed_roots)
        self.auto_worktree = args.auto_worktree
        self.state_file = Path(args.state_file)
        self.bindings: dict[str, dict] = self._load_state()
        self.listings: dict[str, list[dict]] = {}  # binding key -> last /sessions result
        self.busy: set[str] = set()
        self.procs: dict[str, asyncio.subprocess.Process] = {}  # key -> running codex
        self.stop_requested: set[str] = set()  # keys cancelled via /stop
        self.outbox: asyncio.Queue = asyncio.Queue()
        # Per-binding backlog of messages we saw but stayed silent on (someone
        # else was @mentioned). Flushed into the prompt as context the next time
        # we're actually addressed, so a late @mention arrives already caught up.
        self.context_buffer: dict[str, list[str]] = {}
        self.context_buffer_limit = max(0, args.context_buffer)

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

    def post(self, key_frame: dict, text: str, tldr: str | None = None) -> None:
        base = {
            "type": "post",
            "agent_id": self.agent_id,
            "channel_id": key_frame["channel_id"],
            "thread_id": key_frame.get("thread_id"),
        }
        first = True
        while text:
            chunk, text = text[:MAX_POST_CHARS], text[MAX_POST_CHARS:]
            frame = {**base, "text": chunk}
            # A tldr summarizes the whole reply, so it rides only the first
            # chunk (the hub also requires it be strictly shorter than that
            # chunk's text — trivially true for a one-sentence summary).
            if first and tldr:
                frame["tldr"] = tldr
            self.send(frame)
            first = False

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
            "handle": f"codex:{frame['channel_id']}:{frame.get('thread_id') or 0}",
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

    def _buffer_context(self, key: str, frame: dict) -> None:
        """Remember a message we stayed silent on, to replay as context the next
        time we're addressed. Bounded to the most recent N per binding."""
        if self.context_buffer_limit <= 0:
            return
        text = (frame.get("text") or "").strip()
        if not text:
            n = len(frame.get("attachments") or [])
            if not n:
                return
            text = f"[{n} attachment(s)]"
        author = (frame.get("author") or {}).get("name") or "someone"
        buf = self.context_buffer.setdefault(key, [])
        buf.append(f"{author}: {text}")
        if len(buf) > self.context_buffer_limit:
            del buf[: len(buf) - self.context_buffer_limit]

    def _flush_context(self, key: str, text: str) -> str:
        """Prepend and clear this binding's buffered context, if any."""
        backlog = self.context_buffer.pop(key, None)
        if not backlog:
            return text
        return (
            "[Earlier messages in this channel, for context only — you did not "
            "reply to these:]\n"
            + "\n".join(backlog)
            + "\n[End of earlier messages. Now, the message addressed to you:]\n"
            + text
        )

    async def handle_inbound(self, frame: dict) -> None:
        key = self.binding_key(frame)
        # Only humans may drive Codex. Non-user authors (other agents/bots) are
        # never acted on even when they @mention us: a prompt-injected agent in
        # the same channel must never be able to run code on this machine. We do
        # keep their text as context for a later @mention.
        if frame.get("author", {}).get("type") != "user":
            self._buffer_context(key, frame)
            return
        # Respond only when addressed: we're @mentioned, or no agent was tagged
        # at all (open floor). Otherwise someone else was tagged — stay silent
        # but remember the turn so a later @mention lands with the context.
        addressed = bool(frame.get("mentioned")) or not frame.get("any_mention")
        if not addressed:
            self._buffer_context(key, frame)
            return
        text = self._strip_mention(frame.get("text") or "")
        # An image/file with no caption is still a real turn — forward it so
        # long as something (text or an attachment) actually came through.
        if not text and not (frame.get("attachments") or []):
            return
        cmd, _, rest = text.partition(" ")
        cmd, rest = cmd.lower(), rest.strip()
        if cmd == "/commands":
            self.post(frame, HELP)
        elif cmd == "/sessions":
            limit = int(rest) if rest.isdigit() else self.sessions_limit
            sessions = await asyncio.to_thread(recent_sessions, limit)
            self.listings[key] = sessions
            self.post(frame, format_sessions(sessions))
        elif cmd == "/use":
            self.post(frame, await asyncio.to_thread(self._cmd_use, key, rest))
        elif cmd == "/new":
            self.post(frame, await asyncio.to_thread(self._cmd_new, key, rest))
        elif cmd == "/worktree":
            self.post(frame, await asyncio.to_thread(self._cmd_worktree, key, rest))
        elif cmd == "/worktrees":
            self.post(frame, await asyncio.to_thread(self._worktree_list))
        elif cmd == "/model":
            self.post(frame, self._cmd_model(key, rest))
        elif cmd == "/sandbox":
            self.post(frame, self._cmd_sandbox(key, rest))
        elif cmd == "/tldr":
            self.post(frame, self._cmd_tldr(key, rest))
        elif cmd == "/stop":
            self.post(frame, self._cmd_stop(key))
        elif cmd == "/status":
            self.post(frame, self._cmd_status(key))
        else:
            await self.forward_to_codex(key, frame, text)

    # ---------------------------------------------------------- commands

    def _set_binding(self, key: str, session_id: str | None, cwd: str) -> None:
        """Write session/cwd for a channel, keeping any model/sandbox overrides."""
        prev = self.bindings.get(key) or {}
        binding: dict = {"session_id": session_id, "cwd": cwd}
        for k in ("model", "sandbox", "tldr"):
            if k in prev:
                binding[k] = prev[k]
        self.bindings[key] = binding
        self._save_state()

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
                return f"Session {arg} not found under {CODEX_SESSIONS}."
        self._set_binding(key, info["session_id"], info["cwd"])
        prompt = info["last_prompt"][:120]
        return (
            f"Bound to session {info['session_id'][:8]}… in {info['cwd']}\n"
            f'Last prompt: "{prompt}"\nJust type to continue it.'
        )

    def _under_allowed_root(self, path: Path) -> bool:
        return any(path == root or path.is_relative_to(root) for root in self.allowed_roots)

    def _cmd_new(self, key: str, arg: str) -> str:
        if not arg:
            return "Usage: /new <directory>"
        if not self.allowed_roots:
            return (
                "/new is disabled: no allowed roots configured. Set "
                "CODEX_ALLOWED_ROOTS (colon-separated dirs) or --allowed-roots "
                "on the bridge, then restart it."
            )
        try:
            cwd = Path(arg).expanduser().resolve()
        except OSError as e:
            return f"Cannot resolve {arg!r}: {e}"
        if not cwd.is_dir():
            return f"Not a directory: {cwd}"
        if not self._under_allowed_root(cwd):
            allowed = ", ".join(str(r) for r in self.allowed_roots)
            return f"{cwd} is not under an allowed root. Allowed: {allowed}"
        # With auto-worktree on, /new into a git repo gets an isolated worktree
        # so simultaneous threads never write to the same tree (see /worktree).
        if self.auto_worktree and _git_repo_root(cwd):
            return self._create_worktree(key, str(cwd), "")
        self._set_binding(key, None, str(cwd))
        return f"Will start a fresh Codex session in {cwd} on your next message."

    # --------------------------------------------------- git worktrees

    def _worktree_dir(self, repo_root: Path, slug: str) -> Path | None:
        """Pick a worktree dir under an allowed root: sibling first, then in-repo."""
        sibling = repo_root.parent / f"{repo_root.name}.worktrees" / slug
        if self._under_allowed_root(sibling):
            return sibling
        inside = repo_root / ".worktrees" / slug
        if self._under_allowed_root(inside):
            return inside
        return None

    def _attach_worktree(self, key: str, path: Path, branch: str, base: Path) -> None:
        b = self.bindings.get(key) or {}
        b["worktree"] = {"path": str(path), "branch": branch, "base": str(base)}
        self.bindings[key] = b
        self._save_state()

    def _create_worktree(self, key: str, repo_arg: str, branch_arg: str) -> str:
        if not self.allowed_roots:
            return (
                "/worktree is disabled: no allowed roots configured. Set "
                "CODEX_ALLOWED_ROOTS or --allowed-roots, then restart the bridge."
            )
        if not repo_arg:
            return "Usage: /worktree <repo> [branch]"
        try:
            target = Path(repo_arg).expanduser().resolve()
        except OSError as e:
            return f"Cannot resolve {repo_arg!r}: {e}"
        if not target.is_dir():
            return f"Not a directory: {target}"
        if not self._under_allowed_root(target):
            allowed = ", ".join(str(r) for r in self.allowed_roots)
            return f"{target} is not under an allowed root. Allowed: {allowed}"
        repo_root = _git_repo_root(target)
        if not repo_root:
            return f"{target} is not inside a git repository. Use /new for non-git dirs."
        # Branch: user-supplied, else derived from the binding key (channel[:thread]),
        # so each thread lands on its own branch and worktrees can't collide.
        branch = _slugify(branch_arg) if branch_arg else f"agora/{_slugify(key)}"
        path = self._worktree_dir(repo_root, _slugify(branch.replace("/", "-")))
        if path is None:
            allowed = ", ".join(str(r) for r in self.allowed_roots)
            return (
                f"Can't place a worktree for {repo_root.name} under any allowed root "
                f"({allowed}). Add its parent dir to CODEX_ALLOWED_ROOTS."
            )
        if path.exists():
            # Idempotent: a thread re-running /worktree just rebinds to its own dir.
            self._set_binding(key, None, str(path))
            self._attach_worktree(key, path, branch, repo_root)
            return f"Reusing worktree {path} (branch {branch}). Just type to start."
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            return f"Cannot create {path.parent}: {e}"
        r = _run_git(repo_root, "worktree", "add", str(path), "-b", branch)
        if r.returncode != 0 and "already exists" in (r.stderr or ""):
            # Branch exists already — check it out into the new worktree instead.
            r = _run_git(repo_root, "worktree", "add", str(path), branch)
        if r.returncode != 0:
            return f"git worktree add failed:\n{(r.stderr or r.stdout).strip()[:600]}"
        if path.is_relative_to(repo_root):
            _ensure_git_excluded(repo_root, ".worktrees/")
        self._set_binding(key, None, str(path))
        self._attach_worktree(key, path, branch, repo_root)
        log(f"worktree add: {path} (branch {branch}) off {repo_root}")
        return (
            f"Worktree ready: {path}\nBranch: {branch} (off {repo_root.name})\n"
            "This thread now runs isolated here. Just type to start."
        )

    def _worktree_status(self, key: str) -> str:
        wt = (self.bindings.get(key) or {}).get("worktree")
        if not wt:
            return "No worktree on this thread. Create one with /worktree <repo> [branch]."
        missing = "" if Path(wt["path"]).is_dir() else "  ⚠ directory missing"
        return (
            f"Worktree: {wt['path']}{missing}\n"
            f"Branch: {wt['branch']}\nBase repo: {wt['base']}"
        )

    def _worktree_list(self) -> str:
        rows = [
            (k, b["worktree"])
            for k, b in self.bindings.items()
            if isinstance(b, dict) and b.get("worktree")
        ]
        if not rows:
            return "No worktrees tracked. Create one with /worktree <repo> [branch]."
        lines = ["Tracked worktrees (per thread):"]
        for k, wt in rows:
            missing = "" if Path(wt["path"]).is_dir() else " (missing)"
            lines.append(f"• [{k}] {wt['branch']} → {wt['path']}{missing}")
        return "\n".join(lines)

    def _remove_worktree(self, key: str, force: bool) -> str:
        wt = (self.bindings.get(key) or {}).get("worktree")
        if not wt:
            return "No worktree on this thread."
        if key in self.busy:
            return "A run is in flight here — /stop it before removing the worktree."
        base, path, branch = Path(wt["base"]), wt["path"], wt["branch"]
        args = ["worktree", "remove", path] + (["--force"] if force else [])
        r = _run_git(base, *args)
        if r.returncode != 0:
            err = (r.stderr or r.stdout).strip()
            hint = ""
            if not force and ("modified or untracked" in err or "use --force" in err
                              or "is dirty" in err.lower()):
                hint = ("\nThe worktree has uncommitted changes. Commit/merge them, "
                        "or run /worktree remove force to discard.")
            return f"git worktree remove failed:\n{err[:400]}{hint}"
        # Safe branch delete (-d) unless forced (-D); keep the branch if unmerged.
        br = _run_git(base, "branch", "-D" if force else "-d", branch)
        branch_note = (
            f"Branch {branch} deleted."
            if br.returncode == 0
            else f"Kept branch {branch} — {(br.stderr or '').strip()[:140]}"
        )
        self._set_binding(key, None, str(base))  # rebind to the base repo, fresh session
        log(f"worktree remove: {path} (branch {branch})")
        return f"Removed worktree {path}.\n{branch_note}\nThread rebound to {base}."

    def _cmd_worktree(self, key: str, arg: str) -> str:
        sub, _, rest = arg.partition(" ")
        sub, rest = sub.strip().lower(), rest.strip()
        if not sub or sub == "show":
            return self._worktree_status(key)
        if sub == "list":
            return self._worktree_list()
        if sub == "remove":
            return self._remove_worktree(key, force=("force" in rest.split()
                                                     or "--force" in rest.split()))
        # Anything else is a repo path: /worktree <repo> [branch]
        repo_arg, _, branch_arg = arg.partition(" ")
        return self._create_worktree(key, repo_arg.strip(), branch_arg.strip())

    def _cmd_model(self, key: str, arg: str) -> str:
        b = self.bindings.get(key)
        if not b:
            return "No session bound here. Run /sessions then /use <n>."
        if not arg:
            cur = b.get("model") or self.default_model or "session default"
            return f"Model: {cur}\nUsage: /model <{MODEL_HINT}>"
        choice = arg.strip()
        if choice.lower() == "default":
            b.pop("model", None)
            self.bindings[key] = b
            self._save_state()
            fell_back = self.default_model or "session default"
            return f"Model reset to the bridge default ({fell_back})."
        if not MODEL_RE.fullmatch(choice):
            return f"That doesn't look like a model id. Use {MODEL_HINT}."
        b["model"] = choice
        self.bindings[key] = b
        self._save_state()
        return f"Model set to {choice} for this channel. Next messages use `codex -m {choice}`."

    def _cmd_sandbox(self, key: str, arg: str) -> str:
        b = self.bindings.get(key)
        if not b:
            return "No session bound here. Run /sessions then /use <n>."
        default = self.default_sandbox
        if not arg:
            cur = b.get("sandbox") or default
            return (
                f"Sandbox mode: {cur} (bridge default: {default})\n"
                f"Usage: /sandbox <{SANDBOX_CHOICES}>"
            )
        choice = arg.strip().lower()
        if choice == "reset":
            b.pop("sandbox", None)
            self.bindings[key] = b
            self._save_state()
            return f"Sandbox mode reset to the bridge default ({default})."
        mode = normalize_sandbox_mode(choice)
        if not mode:
            return f"Unknown mode. Options: {SANDBOX_CHOICES}."
        if SANDBOX_RANK[mode] > SANDBOX_RANK[default] and not self.allow_escalation:
            return (
                f"Refusing to escalate from {default} to {mode}: privilege escalation "
                "is disabled. Restart the bridge with "
                "CODEX_ALLOW_SANDBOX_ESCALATION=1 to allow it. You can always "
                "lower privilege (e.g. /sandbox read-only)."
            )
        b["sandbox"] = mode
        self.bindings[key] = b
        self._save_state()
        return f"Sandbox mode set to {mode} for this channel."

    def _tldr_enabled(self, binding: dict) -> bool:
        """Whether this binding should ask Codex for a TL;DR (channel override
        wins over the bridge default)."""
        choice = binding.get("tldr")
        return self.tldr_default if choice is None else bool(choice)

    def _cmd_tldr(self, key: str, arg: str) -> str:
        b = self.bindings.get(key)
        if not b:
            return "No session bound here. Run /sessions then /use <n>."
        default_label = "on" if self.tldr_default else "off"
        if not arg:
            cur = "on" if self._tldr_enabled(b) else "off"
            return (
                f"TL;DR summaries: {cur} (bridge default: {default_label})\n"
                "Usage: /tldr <on | off | default>"
            )
        choice = arg.strip().lower()
        if choice == "default":
            b.pop("tldr", None)
            self.bindings[key] = b
            self._save_state()
            return f"TL;DR reset to the bridge default ({default_label})."
        if choice in ("on", "off"):
            b["tldr"] = choice == "on"
            self.bindings[key] = b
            self._save_state()
            state = "on" if b["tldr"] else "off"
            return (
                f"TL;DR summaries {state} for this channel. Long replies will "
                + ("carry a toggleable short summary." if b["tldr"] else "post in full only.")
            )
        return "Unknown option. Usage: /tldr <on | off | default>"

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
        mode = b.get("sandbox") or self.default_sandbox
        tldr = "on" if self._tldr_enabled(b) else "off"
        busy = " — a run is in flight" if key in self.busy else ""
        wt = b.get("worktree")
        wt_line = f"\nWorktree: {wt['branch']} @ {wt['path']}" if wt else ""
        return (
            f"Session {sid} in {b['cwd']}\nModel: {model}\n"
            f"Sandbox: {mode}\nTL;DR: {tldr}{busy}{wt_line}"
        )

    # ------------------------------------------------------------- codex

    async def forward_to_codex(self, key: str, frame: dict, text: str) -> None:
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
            # Catch Codex up on anything we heard but stayed silent on — but
            # never prepend context onto a bare slash-command turn, which must
            # reach Codex verbatim.
            if not text.lstrip().startswith("/"):
                text = self._flush_context(key, text)
            reply = await self.run_codex(key, frame, binding, text)
            body, tldr = self._split_tldr(
                reply, self._tldr_enabled(binding), self.tldr_min_chars)
            self.post(frame, body or "(empty response)", tldr)
        except Exception as e:  # degrade to a chat message, never crash the loop
            log(f"codex run failed: {e!r}")
            self.post(frame, f"Codex run failed: {e}")
        finally:
            self.busy.discard(key)
            self.typing(frame, False)

    @staticmethod
    def _split_tldr(reply: str, enabled: bool, min_chars: int) -> tuple[str, str | None]:
        """Lift a trailing ``TLDR_SENTINEL`` line out of Codex's reply.

        Returns ``(body, tldr)``. When TL;DR is off, the sentinel is absent, or
        anything looks off (empty summary/body, a reply below ``min_chars``, or
        a summary not actually shorter than the body the hub would reject), the
        summary is dropped (``tldr=None``) — but a valid sentinel line is always
        stripped from the body so it never leaks into the visible message. A
        normal reply with no sentinel is returned untouched.
        """
        if not enabled or not reply or TLDR_SENTINEL not in reply:
            return reply, None
        lines = reply.splitlines()
        idx = next(
            (i for i in range(len(lines) - 1, -1, -1)
             if lines[i].lstrip().startswith(TLDR_SENTINEL)),
            None,
        )
        if idx is None:
            return reply, None
        tldr = lines[idx].lstrip()[len(TLDR_SENTINEL):].strip()
        body = "\n".join(lines[:idx]).rstrip()
        if not tldr:
            return reply, None  # bare marker, nothing to summarize with
        if not body:
            return tldr, None  # reply was essentially just the summary line
        tldr = tldr[:MAX_TLDR_CHARS]
        # Drop (but still strip) the summary when the body is short enough to
        # read whole, or when the summary isn't strictly shorter than the body
        # (the hub would reject that anyway).
        if len(body) < min_chars or len(tldr) >= len(body):
            return body, None
        return body, tldr

    def _stage_attachments(self, frame: dict, text: str) -> tuple[str, list[str], str | None]:
        """Drop any inbound attachments to a temp dir and build the prompt.

        Returns ``(prompt, extra_args, tmpdir)``. Bytes are written to a fresh
        temp dir; every saved path is named in the prompt so the model knows to
        look at them (Codex's sandbox restricts *writes*, not reads, so no
        extra flag is needed for it to open them). Images are additionally
        attached via ``codex -i`` so the model actually sees the pixels.
        ``tmpdir`` is ``None`` when there's nothing to stage; the caller
        removes it after the run.
        """
        attachments = frame.get("attachments") or []
        if not attachments:
            return text, [], None
        tmpdir = tempfile.mkdtemp(prefix="agora-att-")
        saved, images, notes = materialize_attachments(attachments, Path(tmpdir))
        prompt = text
        if notes:
            block = "The Agora message included these attachments:\n" + "\n".join(notes)
            prompt = f"{text}\n\n{block}".strip() if text else block
        extra_args: list[str] = []
        for img in images:
            extra_args += ["-i", str(img)]
        if not saved:
            # Nothing landed on disk (all oversized/undecodable) — no point
            # keeping an empty dir around.
            shutil.rmtree(tmpdir, ignore_errors=True)
            tmpdir = None
        return prompt, extra_args, tmpdir

    def _sandbox_args(self, mode: str) -> list[str]:
        # -c works on both `exec` and `exec resume` (plain -s exists only on
        # `exec`), so the config override is the uniform spelling. "bypass" is
        # the no-sandbox flag instead.
        if mode == "bypass":
            return ["--dangerously-bypass-approvals-and-sandbox"]
        return ["-c", f"sandbox_mode={mode}"]

    async def run_codex(self, key: str, frame: dict, binding: dict, text: str) -> str:
        prompt, extra_args, tmpdir = self._stage_attachments(frame, text)
        mode = binding.get("sandbox") or self.default_sandbox
        model = binding.get("model") or self.default_model
        if self._tldr_enabled(binding):
            prompt += TLDR_PROMPT_SUFFIX
        try:
            cmd = [self.codex_bin, "exec"]
            if binding.get("session_id"):
                cmd += ["resume", binding["session_id"]]
            cmd += [
                "--json",
                "--skip-git-repo-check",
                *self._sandbox_args(mode),
                *extra_args,
                *self.base_codex_args,
            ]
            if model:
                cmd += ["-m", model]
            cmd += ["-"]  # read the prompt from stdin (keeps it out of ps/argv)
            log(
                f"run: session={binding.get('session_id')} cwd={binding['cwd']} "
                f"model={model or 'default'} sandbox={mode}"
                + (f" attachments@{tmpdir}" if tmpdir else "")
            )
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=binding["cwd"],
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.PIPE,
                # JSONL events are single lines that can carry whole command
                # outputs; the default 64 KB readline limit is far too small.
                limit=64 * 1024 * 1024,
            )
            self.procs[key] = proc  # so /stop can find and kill this run
            assert proc.stdin is not None
            proc.stdin.write(prompt.encode())
            proc.stdin.close()
            reply_parts: list[str] = []
            error_parts: list[str] = []
            new_session_id: str | None = None
            turn_failed = False
            last_progress = 0.0
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
                        if kind == "thread.started":
                            new_session_id = event.get("thread_id") or new_session_id
                        elif kind in ("item.started", "item.completed"):
                            item = event.get("item") or {}
                            if kind == "item.completed" and item.get("type") == "agent_message":
                                if item.get("text"):
                                    reply_parts.append(item["text"])
                            elif kind == "item.completed" and item.get("type") == "error":
                                if item.get("message"):
                                    error_parts.append(item["message"])
                            else:
                                snippet = self._progress_snippet(kind, item)
                                if snippet and time.monotonic() - last_progress > PROGRESS_THROTTLE:
                                    last_progress = time.monotonic()
                                    self.progress(frame, snippet)
                        elif kind == "error":
                            if event.get("message"):
                                error_parts.append(str(event["message"]))
                        elif kind == "turn.failed":
                            err = (event.get("error") or {}).get("message")
                            if err:
                                error_parts.append(str(err))
                            turn_failed = True
                            break
                        elif kind == "turn.completed":
                            break
                    await proc.wait()
            except TimeoutError:
                raise RuntimeError(f"timed out after {self.timeout}s")
            finally:
                # Never leave an orphaned codex running: any exit path (timeout,
                # stream parse error, disconnect, cancellation) must kill the
                # child, otherwise it keeps working after a reported failure.
                if proc.returncode is None:
                    proc.kill()
                    await proc.wait()
                self.procs.pop(key, None)
            if key in self.stop_requested:
                self.stop_requested.discard(key)
                return "Stopped."
            if turn_failed or (not reply_parts and error_parts):
                detail = "\n".join(error_parts) or "unknown error"
                return f"(codex error) {detail[:2000]}"
            if not reply_parts:
                stderr = (await proc.stderr.read()).decode("utf-8", errors="replace").strip()
                raise RuntimeError(stderr[-500:] or f"codex exited {proc.returncode} with no result")
            # Resume keeps the thread id, but a fresh session mints one; track
            # it (successful runs only) so follow-ups continue the conversation.
            if new_session_id and new_session_id != binding.get("session_id"):
                binding["session_id"] = new_session_id
                self.bindings[key] = binding
                self._save_state()
            return "\n\n".join(reply_parts)
        finally:
            if tmpdir:
                shutil.rmtree(tmpdir, ignore_errors=True)

    @staticmethod
    def _progress_snippet(kind: str, item: dict) -> str | None:
        itype = item.get("type")
        if itype == "command_execution":
            command = str(item.get("command") or "").strip()
            if kind == "item.started" and command:
                return f"$ {command[:200]}"
            return None
        if kind != "item.completed":
            return None
        if itype == "reasoning" and item.get("text"):
            return str(item["text"]).replace("\n", " ")[-200:]
        if itype == "web_search" and item.get("query"):
            return f"searching: {str(item['query'])[:180]}"
        if itype == "file_change":
            changes = item.get("changes") or []
            paths = [str(c.get("path") or "") for c in changes if isinstance(c, dict)]
            paths = [p for p in paths if p]
            if paths:
                shown = ", ".join(Path(p).name for p in paths[:4])
                more = f" (+{len(paths) - 4} more)" if len(paths) > 4 else ""
                return f"editing {shown}{more}"
        if itype == "todo_list":
            items = item.get("items") or []
            current = next(
                (i.get("text") for i in items
                 if isinstance(i, dict) and not i.get("completed")),
                None,
            )
            if current:
                return f"todo: {str(current)[:180]}"
        return None

    # --------------------------------------------------------- main loop

    async def run(self) -> None:
        backoff = 1.0
        while True:
            try:
                # ping_timeout: the library's 20s default kills healthy
                # connections whenever the hub is slow to pong (its agent
                # socket handler can sit in a large send or blocking store
                # work and not read pings for a while). 60s rides those
                # stalls out; genuinely dead links still get reaped.
                async with websockets.connect(
                    self.url, max_size=64 * 1024 * 1024, ping_timeout=60
                ) as ws:
                    log("connected, registering agent")
                    await ws.send(json.dumps({
                        "type": "hello",
                        "agents": [{
                            "id": self.agent_id,
                            "name": self.agent_name,
                            "requires_mention": False,
                            # Keep hearing everything (so context accumulates) but
                            # only reply when addressed; also ask the server for a
                            # feed of agent chatter we aren't @mentioned in.
                            "wants_context_feed": self.context_buffer_limit > 0,
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
                if frame.get("agent_id") != self.agent_id:
                    continue
                if frame.get("type") == "inbound":
                    asyncio.create_task(self.handle_inbound(frame))
        finally:
            send_task.cancel()


def load_env_file(path: Path, *, override: bool = False) -> int:
    """Populate ``os.environ`` from a simple ``KEY=VALUE`` .env file.

    A tiny, dependency-free parser (the bridge stays `pip install websockets`
    only): blank lines and ``#`` comments are skipped, an optional leading
    ``export `` is stripped, and matching single/double quotes around a value
    are removed. By default a value already present in the real environment
    wins — so ``AGORA_PAIRING_TOKEN=… python3 bridge.py`` still overrides the
    file — and CLI flags win over both (argparse reads ``os.environ`` for its
    defaults only after this runs). Returns how many keys were applied.
    """
    try:
        raw = path.read_text()
    except OSError:
        return 0
    applied = 0
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if override or key not in os.environ:
            os.environ[key] = value
            applied += 1
    return applied


def _env_file_from_argv(argv: list[str], default: Path) -> Path:
    """Resolve which .env file to load before argparse runs.

    Honors ``--env-file <path>`` / ``--env-file=<path>`` on the command line,
    then ``AGORA_BRIDGE_ENV_FILE``, else falls back to ``default`` (.env next
    to this script).
    """
    for i, tok in enumerate(argv):
        if tok == "--env-file" and i + 1 < len(argv):
            return Path(argv[i + 1]).expanduser()
        if tok.startswith("--env-file="):
            return Path(tok.split("=", 1)[1]).expanduser()
    override = os.environ.get("AGORA_BRIDGE_ENV_FILE")
    return Path(override).expanduser() if override else default


def main() -> None:
    script_dir = Path(__file__).resolve().parent
    default_state = script_dir / "state.json"
    # Load a .env before building the parser so every arg's os.environ-derived
    # default can come from the file (real env vars and CLI flags still win).
    env_file = _env_file_from_argv(sys.argv[1:], script_dir / ".env")
    loaded = load_env_file(env_file)
    if loaded:
        log(f"loaded {loaded} setting(s) from {env_file}")
    ap = argparse.ArgumentParser(description="Codex CLI bridge for Agora")
    ap.add_argument("--env-file", default=str(env_file),
                    help="path to a KEY=VALUE .env file of bridge settings "
                         "(default: .env beside this script; AGORA_BRIDGE_ENV_FILE "
                         "overrides the path; real env vars and CLI flags win)")
    ap.add_argument("--url", default=os.environ.get("AGORA_URL", "ws://127.0.0.1:4470"),
                    help="Agora base URL (http(s)/ws(s); /agent/ws appended if missing)")
    ap.add_argument("--token", default=None,
                    help="pairing token. DISCOURAGED on the CLI (visible in ps/proc); "
                         "prefer AGORA_PAIRING_TOKEN or --token-file")
    ap.add_argument("--token-file", default=os.environ.get("AGORA_PAIRING_TOKEN_FILE"),
                    help="read the pairing token from this file (chmod 600 it)")
    ap.add_argument("--allowed-roots", default=os.environ.get("CODEX_ALLOWED_ROOTS", ""),
                    help="colon-separated dirs /new sessions may start under; "
                         "/new is disabled when empty")
    ap.add_argument("--auto-worktree", action="store_true",
                    default=os.environ.get("CODEX_AUTO_WORKTREE", "").lower()
                    in ("1", "true", "yes"),
                    help="/new into a git repo creates an isolated git worktree + "
                         "branch per thread instead of binding the repo directly "
                         "(also available on demand via /worktree)")
    ap.add_argument("--agent-id", default=os.environ.get("AGENT_ID", "codex-cli"))
    ap.add_argument("--agent-name", default=os.environ.get("AGENT_NAME", "Codex"))
    ap.add_argument("--codex-bin", default=os.environ.get("CODEX_BIN", "codex"))
    ap.add_argument("--codex-args", default=os.environ.get("CODEX_ARGS", ""),
                    help="extra args for every codex run; a sandbox flag here "
                         "becomes the default, overridable per channel with /sandbox")
    ap.add_argument("--sandbox", default=os.environ.get("CODEX_SANDBOX", ""),
                    help="default sandbox mode for every run (default: "
                         "workspace-write; channels override with /sandbox); one "
                         f"of: {SANDBOX_CHOICES.replace(' | reset', '')}")
    ap.add_argument("--model", default=os.environ.get("CODEX_MODEL", ""),
                    help="default model for every run (channels override with "
                         "/model); empty = the codex config default")
    ap.add_argument("--allow-sandbox-escalation", action="store_true",
                    default=os.environ.get("CODEX_ALLOW_SANDBOX_ESCALATION", "").lower()
                    in ("1", "true", "yes"),
                    help="allow /sandbox to raise privilege above the bridge "
                         "default (off by default; lowering privilege is always allowed)")
    ap.add_argument("--tldr", action="store_true",
                    default=os.environ.get("CODEX_TLDR", "").lower() in ("1", "true", "yes"),
                    help="ask Codex to add a toggleable short summary to long "
                         "replies (off by default; channels override with /tldr)")
    ap.add_argument("--tldr-min-chars", type=int,
                    default=int(os.environ.get("CODEX_TLDR_MIN_CHARS", "1500")),
                    help="only summarize replies at least this many chars long")
    ap.add_argument("--timeout", type=int, default=int(os.environ.get("CODEX_TIMEOUT", "1800")),
                    help="per-run timeout in seconds")
    ap.add_argument("--sessions", type=int, default=int(os.environ.get("SESSIONS_LIMIT", "10")),
                    help="how many sessions /sessions lists")
    ap.add_argument("--state-file", default=os.environ.get("STATE_FILE", str(default_state)))
    ap.add_argument("--context-buffer", type=int,
                    default=int(os.environ.get("CONTEXT_BUFFER", "50")),
                    help="max messages to buffer per channel while staying silent "
                         "(replayed as context when next @mentioned; 0 disables)")
    args = ap.parse_args()
    if args.sandbox and not normalize_sandbox_mode(args.sandbox):
        ap.error(f"unknown --sandbox mode {args.sandbox!r}; "
                 f"use one of: {SANDBOX_CHOICES.replace(' | reset', '')}")
    if args.model and not MODEL_RE.fullmatch(args.model.strip()):
        ap.error(f"--model {args.model!r} doesn't look like a model id")
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
    log(f"codex-cli bridge -> {re.sub(r'token=[^&]+', 'token=***', Bridge._normalize_url(args.url, args.token))}")
    try:
        asyncio.run(Bridge(args).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
