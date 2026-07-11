"""Pure helpers for the Agora dial-in frame protocol.

Kept free of ``gateway.*`` imports so the standalone cron sender and the
offline unit tests can use them without a full Hermes runtime on the path.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, List, Optional
from urllib.parse import urlsplit

# Agora hub caps a single post at 8000 chars (bridge MAX_POST_CHARS).
MAX_POST_CHARS = 8000
# Frames can inline attachments base64-encoded up to 8 MB.
WS_MAX_SIZE = 64 * 1024 * 1024
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def truthy(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def redact(url: str) -> str:
    """Mask the pairing token in a URL for logging."""
    return re.sub(r"token=[^&]+", "token=***", url)


def normalize_url(url: str, token: str) -> str:
    """Build the full ``/agent/ws?token=...`` URL from a base URL.

    Mirrors the claude-cli bridge: http(s) is rewritten to ws(s), a bare
    host gets ``ws://`` prepended, ``/agent/ws`` is appended if missing and
    the pairing token rides as a query parameter.

    Raises ValueError for plaintext ws:// to a non-loopback host — the token
    and all traffic would cross the network unencrypted.
    """
    url = url.strip().rstrip("/")
    url = re.sub(r"^http://", "ws://", url)
    url = re.sub(r"^https://", "wss://", url)
    if not url.startswith(("ws://", "wss://")):
        url = "ws://" + url
    if url.startswith("ws://"):
        host = (urlsplit(url).hostname or "").lower().strip("[]")
        if host not in LOOPBACK_HOSTS:
            raise ValueError(
                f"refusing plaintext ws:// to non-loopback host {host!r}: the "
                "pairing token and all messages would cross the network "
                "unencrypted. Use wss:// (or keep the hub on 127.0.0.1)."
            )
    if "/agent/ws" not in url:
        url += "/agent/ws"
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}token={token}"


def resolve_token(extra: Optional[dict] = None) -> str:
    """Pairing token from env, token file, or config extra (in that order)."""
    token = os.getenv("AGORA_PAIRING_TOKEN", "").strip()
    if token:
        return token
    token_file = os.getenv("AGORA_PAIRING_TOKEN_FILE", "").strip()
    if token_file:
        try:
            return Path(token_file).expanduser().read_text().strip()
        except OSError:
            return ""
    return str((extra or {}).get("pairing_token", "") or "").strip()


def make_chat_id(channel_id: str, thread_id: Any) -> str:
    """Session chat id: ``<channel_id>`` or ``<channel_id>:<thread_id>``."""
    if thread_id is None or thread_id == "":
        return str(channel_id)
    return f"{channel_id}:{thread_id}"


def split_chat_id(chat_id: str) -> tuple[str, Optional[int]]:
    """Invert make_chat_id.

    Agora thread ids are integers, so only a numeric suffix after the last
    colon is treated as a thread — channel ids containing colons stay intact.
    """
    channel_id, sep, tail = chat_id.rpartition(":")
    if sep and tail.isdigit():
        return channel_id, int(tail)
    return chat_id, None


def strip_mention(text: str, agent_id: str, agent_name: str) -> str:
    """Strip a leading @agent-id / @agent-name-slug mention from *text*."""
    slug = re.sub(r"[^a-z0-9]+", "-", agent_name.lower()).strip("-")
    return re.sub(
        rf"^@({re.escape(agent_id)}|{re.escape(slug)})\b[:,]?\s*",
        "",
        text.strip(),
        flags=re.IGNORECASE,
    )


def chunk_text(text: str, limit: int = MAX_POST_CHARS) -> List[str]:
    """Split *text* into <= limit sized chunks (Agora rejects oversized posts)."""
    chunks: List[str] = []
    while text:
        chunks.append(text[:limit])
        text = text[limit:]
    return chunks or [""]
