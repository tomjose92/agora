"""Agora platform adapter for Hermes Agent.

Dial-in bridge to an Agora hub, speaking the same JSON-over-WebSocket frame
protocol as Agora's bundled claude-cli bridge:

    -> {"type": "hello", "agents": [{"id", "name", "requires_mention"}]}
    <- {"type": "inbound", "agent_id", "channel_id", "thread_id", "text",
        "author": {"type", "id", "name"}, "chat_name", "attachments", ...}
    -> {"type": "post", "agent_id", "channel_id", "thread_id", "text"}
    -> {"type": "typing", "agent_id", "channel_id", "thread_id", "active"}

Auth is a pairing token riding as a ``?token=`` query parameter on the
``/agent/ws`` upgrade — Agora returns HTTP 401 on a bad token and sends no
ack after ``hello``.

Configuration in config.yaml::

    gateway:
      platforms:
        agora:
          enabled: true
          extra:
            url: wss://agora.example.com   # /agent/ws appended automatically
            pairing_token: "..."           # prefer AGORA_PAIRING_TOKEN env
            agent_id: hermes
            agent_name: Hermes
            requires_mention: false
            allow_agents: false            # respond to other bots' messages

Or via environment variables (overrides config.yaml):
    AGORA_URL, AGORA_PAIRING_TOKEN (or AGORA_PAIRING_TOKEN_FILE),
    AGORA_AGENT_ID, AGORA_AGENT_NAME, AGORA_REQUIRES_MENTION,
    AGORA_ALLOW_AGENTS, AGORA_HOME_CHANNEL,
    AGORA_ALLOWED_USERS, AGORA_ALLOW_ALL_USERS
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

from gateway.platforms.base import (
    BasePlatformAdapter,
    SendResult,
    MessageEvent,
    MessageType,
)
from gateway.config import Platform

from .protocol import (
    MAX_POST_CHARS,
    WS_MAX_SIZE,
    chunk_text,
    make_chat_id,
    normalize_url,
    redact as _redact,
    resolve_token,
    split_chat_id,
    strip_mention,
    truthy as _truthy,
)

# Typing frames are transient on the hub; auto-clear ours if the base
# adapter's keep-typing heartbeat stops refreshing them.
TYPING_TTL = 12.0


class AgoraAdapter(BasePlatformAdapter):
    """Async Agora adapter implementing the BasePlatformAdapter interface."""

    def __init__(self, config, **kwargs):
        platform = Platform("agora")
        super().__init__(config=config, platform=platform)

        extra = getattr(config, "extra", {}) or {}
        self.base_url = os.getenv("AGORA_URL") or extra.get("url", "")
        self.token = resolve_token(extra)
        self.agent_id = os.getenv("AGORA_AGENT_ID") or extra.get("agent_id", "hermes")
        self.agent_name = os.getenv("AGORA_AGENT_NAME") or extra.get("agent_name", "Hermes")
        rm = os.getenv("AGORA_REQUIRES_MENTION")
        self.requires_mention = _truthy(rm) if rm is not None else bool(extra.get("requires_mention", False))
        aa = os.getenv("AGORA_ALLOW_AGENTS")
        self.allow_agents = _truthy(aa) if aa is not None else bool(extra.get("allow_agents", False))

        # Runtime state
        self._url: str = ""
        self._ws = None
        self._run_task: Optional[asyncio.Task] = None
        self._ready = asyncio.Event()
        self._closing = False
        self._outbox: asyncio.Queue = asyncio.Queue()
        self._typing_off_timers: Dict[str, asyncio.Task] = {}
        # Channels whose context_note has already been surfaced this process.
        self._context_seen: set[str] = set()

    @property
    def name(self) -> str:
        return "Agora"

    # ── Connection lifecycle ──────────────────────────────────────────────

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        """Dial the Agora hub, register via hello, and start the pump."""
        if not self.base_url or not self.token:
            logger.error("Agora: url and pairing token must be configured")
            self._set_fatal_error(
                "config_missing",
                "AGORA_URL and AGORA_PAIRING_TOKEN must be set",
                retryable=False,
            )
            return False
        try:
            import websockets  # noqa: F401
        except ImportError:
            self._set_fatal_error(
                "missing_dependency",
                "The 'websockets' package is required: pip install websockets",
                retryable=False,
            )
            return False
        try:
            self._url = normalize_url(self.base_url, self.token)
        except ValueError as e:
            logger.error("Agora: %s", e)
            self._set_fatal_error("insecure_url", str(e), retryable=False)
            return False

        self._closing = False
        self._ready.clear()
        self._run_task = asyncio.create_task(self._run_loop())
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=30.0)
        except asyncio.TimeoutError:
            logger.error("Agora: could not connect to %s within 30s", _redact(self._url))
            await self.disconnect()
            self._set_fatal_error(
                "connect_failed",
                f"could not reach Agora hub at {_redact(self._url)}",
                retryable=True,
            )
            return False

        self._mark_connected()
        logger.info(
            "Agora: connected to %s as agent %r (%s)",
            _redact(self._url), self.agent_id, self.agent_name,
        )
        return True

    async def disconnect(self) -> None:
        self._closing = True
        self._mark_disconnected()
        for timer in self._typing_off_timers.values():
            timer.cancel()
        self._typing_off_timers.clear()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
        if self._run_task and not self._run_task.done():
            self._run_task.cancel()
            try:
                await self._run_task
            except asyncio.CancelledError:
                pass
        self._run_task = None
        self._ready.clear()

    async def _run_loop(self) -> None:
        """Connect → hello → pump; reconnect with exponential backoff."""
        import websockets

        backoff = 1.0
        while not self._closing:
            try:
                async with websockets.connect(self._url, max_size=WS_MAX_SIZE) as ws:
                    self._ws = ws
                    # Register first: Agora silently drops every non-hello
                    # frame that arrives before registration.
                    await ws.send(json.dumps({
                        "type": "hello",
                        "agents": [{
                            "id": self.agent_id,
                            "name": self.agent_name,
                            "requires_mention": self.requires_mention,
                        }],
                    }))
                    backoff = 1.0
                    self._ready.set()
                    self._mark_connected()
                    await self._pump(ws)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("Agora: disconnected: %r", e)
            finally:
                self._ws = None
                self._ready.clear()
            if self._closing:
                break
            logger.info("Agora: reconnecting in %.0fs", backoff)
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                raise
            backoff = min(backoff * 2, 60.0)

    async def _pump(self, ws) -> None:
        """Drain the outbox and dispatch inbound frames concurrently."""
        async def sender() -> None:
            while True:
                frame = await self._outbox.get()
                await ws.send(json.dumps(frame))

        send_task = asyncio.create_task(sender())
        try:
            async for raw in ws:
                try:
                    frame = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                if frame.get("type") == "inbound" and frame.get("agent_id") == self.agent_id:
                    asyncio.create_task(self._handle_inbound(frame))
        finally:
            send_task.cancel()
            try:
                await send_task
            except asyncio.CancelledError:
                pass

    # ── Inbound ───────────────────────────────────────────────────────────

    async def _handle_inbound(self, frame: dict) -> None:
        try:
            await self._dispatch_inbound(frame)
        except Exception:
            # A bad frame must never kill the receive loop's task group.
            logger.exception("Agora: error handling inbound frame")

    async def _dispatch_inbound(self, frame: dict) -> None:
        if not self._message_handler:
            return
        author = frame.get("author") or {}
        # Humans-only by default: a prompt-injected agent in the same channel
        # must not be able to drive this agent (parity with the claude bridge).
        is_bot = author.get("type") != "user" or bool(frame.get("from_bot"))
        if is_bot and not self.allow_agents:
            return

        text = strip_mention(frame.get("text") or "", self.agent_id, self.agent_name)
        media_urls, media_types = self._cache_attachments(frame.get("attachments") or [])
        if not text and not media_urls:
            return

        channel_id = str(frame.get("channel_id") or "")
        if not channel_id:
            return
        thread_id = frame.get("thread_id")
        chat_id = make_chat_id(channel_id, thread_id)

        source = self.build_source(
            chat_id=chat_id,
            chat_name=frame.get("chat_name") or channel_id,
            chat_type="group",
            user_id=str(author.get("id") or "unknown"),
            user_name=author.get("name") or author.get("id") or "unknown",
            thread_id=str(thread_id) if thread_id is not None else None,
            parent_chat_id=channel_id if thread_id is not None else None,
            is_bot=is_bot,
            message_id=str(frame.get("message_id") or ""),
        )

        # Surface Agora's channel roster/context once per channel per process
        # (it repeats verbatim on every frame — no need to bloat transcripts).
        channel_context = None
        context_note = frame.get("context_note")
        if context_note and chat_id not in self._context_seen:
            self._context_seen.add(chat_id)
            channel_context = str(context_note)

        message_type = MessageType.TEXT
        if media_urls:
            first = media_types[0] if media_types else ""
            if first.startswith("image/"):
                message_type = MessageType.PHOTO
            elif first.startswith("audio/"):
                message_type = MessageType.AUDIO
            else:
                message_type = MessageType.DOCUMENT

        event = MessageEvent(
            text=text,
            message_type=message_type,
            source=source,
            raw_message=frame,
            message_id=str(frame.get("message_id") or int(time.time() * 1000)),
            media_urls=media_urls,
            media_types=media_types,
            channel_context=channel_context,
        )
        await self.handle_message(event)

    def _cache_attachments(self, attachments: list) -> tuple[List[str], List[str]]:
        """Decode inlined base64 attachments into local cache files."""
        media_urls: List[str] = []
        media_types: List[str] = []
        for att in attachments:
            if not isinstance(att, dict):
                continue
            data_b64 = att.get("data_b64")
            if not data_b64:
                continue  # oversized attachment: Agora sends name-only
            try:
                data = base64.b64decode(data_b64)
            except Exception:
                continue
            mime = str(att.get("mime") or "application/octet-stream")
            filename = str(att.get("filename") or "attachment.bin")
            ext = Path(filename).suffix or ""
            try:
                from gateway.platforms.base import (
                    cache_audio_from_bytes,
                    cache_document_from_bytes,
                    cache_image_from_bytes,
                )
                if mime.startswith("image/"):
                    path = cache_image_from_bytes(data, ext=ext or ".jpg")
                elif mime.startswith("audio/"):
                    path = cache_audio_from_bytes(data, ext=ext or ".ogg")
                else:
                    path = cache_document_from_bytes(data, filename)
            except Exception as e:
                logger.warning("Agora: failed to cache attachment %r: %s", filename, e)
                continue
            media_urls.append(path)
            media_types.append(mime)
        return media_urls, media_types

    # ── Outbound ──────────────────────────────────────────────────────────

    def _enqueue(self, frame: dict) -> None:
        self._outbox.put_nowait(frame)

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        if self._ws is None:
            return SendResult(success=False, error="Not connected to Agora hub", retryable=True)
        channel_id, thread_id = split_chat_id(str(chat_id))
        # A thread_id passed via metadata (cron / send_message tool) wins over
        # one encoded in the chat_id.
        meta_thread = (metadata or {}).get("thread_id")
        if meta_thread is not None and str(meta_thread).isdigit():
            thread_id = int(str(meta_thread))
        for chunk in chunk_text(content):
            self._enqueue({
                "type": "post",
                "agent_id": self.agent_id,
                "channel_id": channel_id,
                "thread_id": thread_id,
                "text": chunk,
            })
        return SendResult(success=True, message_id=str(int(time.time() * 1000)))

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        if self._ws is None:
            return
        channel_id, thread_id = split_chat_id(str(chat_id))
        self._enqueue({
            "type": "typing",
            "agent_id": self.agent_id,
            "channel_id": channel_id,
            "thread_id": thread_id,
            "active": True,
        })
        self._schedule_typing_off(str(chat_id), channel_id, thread_id)

    def _schedule_typing_off(self, key: str, channel_id: str, thread_id: Optional[int]) -> None:
        """Auto-clear the typing indicator once the heartbeat stops refreshing it."""
        old = self._typing_off_timers.pop(key, None)
        if old:
            old.cancel()

        async def _off() -> None:
            try:
                await asyncio.sleep(TYPING_TTL)
                self._enqueue({
                    "type": "typing",
                    "agent_id": self.agent_id,
                    "channel_id": channel_id,
                    "thread_id": thread_id,
                    "active": False,
                })
            except asyncio.CancelledError:
                pass
            finally:
                self._typing_off_timers.pop(key, None)

        self._typing_off_timers[key] = asyncio.create_task(_off())

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "group"}
