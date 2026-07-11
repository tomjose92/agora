"""Offline tests for the Agora platform plugin.

Protocol tests are pure (no Hermes runtime needed). Adapter tests require the
``gateway`` package importable (a hermes-agent checkout on sys.path — the
default location ``~/.hermes/hermes-agent`` is tried automatically) and are
skipped when it is not.

Run:  python -m pytest plugins/agora/tests/ -q
"""
from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

PLUGIN_DIR = Path(__file__).resolve().parent.parent
HERMES_AGENT_CHECKOUT = Path.home() / ".hermes" / "hermes-agent"


def _load_plugin_package():
    """Import plugins/agora as a package so its relative imports resolve."""
    name = "agora_plugin"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(
        name,
        PLUGIN_DIR / "__init__.py",
        submodule_search_locations=[str(PLUGIN_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_load_plugin_package()
from agora_plugin import protocol  # noqa: E402


# ── protocol: URL normalization ─────────────────────────────────────────────

def test_normalize_url_https_to_wss():
    url = protocol.normalize_url("https://agora.example.com", "tok123")
    assert url == "wss://agora.example.com/agent/ws?token=tok123"


def test_normalize_url_appends_path_once():
    url = protocol.normalize_url("wss://host/agent/ws", "t")
    assert url == "wss://host/agent/ws?token=t"


def test_normalize_url_bare_host_gets_ws_scheme():
    url = protocol.normalize_url("127.0.0.1:4470", "t")
    assert url == "ws://127.0.0.1:4470/agent/ws?token=t"


def test_normalize_url_query_param_separator():
    url = protocol.normalize_url("wss://host/agent/ws?x=1", "t")
    assert url.endswith("?x=1&token=t")


def test_normalize_url_rejects_plaintext_ws_to_remote_host():
    with pytest.raises(ValueError, match="refusing plaintext"):
        protocol.normalize_url("ws://agora.example.com", "t")
    with pytest.raises(ValueError, match="refusing plaintext"):
        protocol.normalize_url("http://10.0.0.5:4470", "t")


def test_normalize_url_allows_loopback_ws():
    for host in ("127.0.0.1", "localhost", "[::1]"):
        url = protocol.normalize_url(f"ws://{host}:4470", "t")
        assert url.startswith("ws://")


def test_redact_masks_token():
    url = protocol.normalize_url("wss://host", "supersecret")
    assert "supersecret" not in protocol.redact(url)
    assert "token=***" in protocol.redact(url)


# ── protocol: token resolution ──────────────────────────────────────────────

def test_resolve_token_env_wins(monkeypatch):
    monkeypatch.setenv("AGORA_PAIRING_TOKEN", "from-env")
    assert protocol.resolve_token({"pairing_token": "from-extra"}) == "from-env"


def test_resolve_token_file(monkeypatch, tmp_path):
    monkeypatch.delenv("AGORA_PAIRING_TOKEN", raising=False)
    token_file = tmp_path / "token"
    token_file.write_text("from-file\n")
    monkeypatch.setenv("AGORA_PAIRING_TOKEN_FILE", str(token_file))
    assert protocol.resolve_token() == "from-file"


def test_resolve_token_extra_fallback(monkeypatch):
    monkeypatch.delenv("AGORA_PAIRING_TOKEN", raising=False)
    monkeypatch.delenv("AGORA_PAIRING_TOKEN_FILE", raising=False)
    assert protocol.resolve_token({"pairing_token": "from-extra"}) == "from-extra"
    assert protocol.resolve_token() == ""


# ── protocol: chat id round-trip ────────────────────────────────────────────

def test_chat_id_round_trip_without_thread():
    assert protocol.make_chat_id("chan-1", None) == "chan-1"
    assert protocol.split_chat_id("chan-1") == ("chan-1", None)


def test_chat_id_round_trip_with_thread():
    chat_id = protocol.make_chat_id("chan-1", 42)
    assert chat_id == "chan-1:42"
    assert protocol.split_chat_id(chat_id) == ("chan-1", 42)


def test_split_chat_id_non_numeric_suffix_stays_channel():
    # Channel ids containing colons must not be mistaken for threads.
    assert protocol.split_chat_id("team:general") == ("team:general", None)


# ── protocol: mention stripping ─────────────────────────────────────────────

def test_strip_mention_by_agent_id():
    assert protocol.strip_mention("@hermes do it", "hermes", "Hermes") == "do it"


def test_strip_mention_by_name_slug():
    out = protocol.strip_mention("@other-bot, status?", "hermes", "Other Bot")
    assert out == "status?"


def test_strip_mention_leaves_other_mentions():
    text = "@someone-else hello"
    assert protocol.strip_mention(text, "hermes", "Hermes") == text


def test_strip_mention_no_partial_prefix_match():
    text = "@hermes2 hello"
    assert protocol.strip_mention(text, "hermes", "Hermes") == text


# ── protocol: chunking ──────────────────────────────────────────────────────

def test_chunk_text_within_limit():
    assert protocol.chunk_text("short") == ["short"]


def test_chunk_text_splits_at_limit():
    text = "a" * (protocol.MAX_POST_CHARS + 5)
    chunks = protocol.chunk_text(text)
    assert len(chunks) == 2
    assert len(chunks[0]) == protocol.MAX_POST_CHARS
    assert chunks[1] == "aaaaa"
    assert "".join(chunks) == text


def test_chunk_text_empty():
    assert protocol.chunk_text("") == [""]


# ── adapter tests (need the gateway package) ────────────────────────────────

def _gateway_importable() -> bool:
    if importlib.util.find_spec("gateway") is not None:
        return True
    if (HERMES_AGENT_CHECKOUT / "gateway").is_dir():
        sys.path.insert(0, str(HERMES_AGENT_CHECKOUT))
        return importlib.util.find_spec("gateway") is not None
    return False


needs_gateway = pytest.mark.skipif(
    not _gateway_importable(), reason="hermes-agent gateway package not importable"
)


def _ensure_platform_registered():
    """Register the agora platform entry like register(ctx) does in production.

    ``Platform("agora")`` only resolves through the enum's ``_missing_`` hook
    once the platform registry knows the name.
    """
    from gateway.platform_registry import platform_registry, PlatformEntry

    if platform_registry.is_registered("agora"):
        return
    platform_registry.register(PlatformEntry(
        name="agora",
        label="Agora",
        adapter_factory=lambda cfg: None,
        check_fn=lambda: True,
        source="plugin",
    ))


def _make_adapter(monkeypatch, **extra):
    _ensure_platform_registered()
    from agora_plugin.adapter import AgoraAdapter

    for var in (
        "AGORA_URL", "AGORA_PAIRING_TOKEN", "AGORA_PAIRING_TOKEN_FILE",
        "AGORA_AGENT_ID", "AGORA_AGENT_NAME", "AGORA_REQUIRES_MENTION",
        "AGORA_ALLOW_AGENTS",
    ):
        monkeypatch.delenv(var, raising=False)
    config = SimpleNamespace(extra={
        "url": "ws://127.0.0.1:4470",
        "pairing_token": "tok",
        **extra,
    })
    return AgoraAdapter(config)


def _inbound_frame(**overrides):
    frame = {
        "type": "inbound",
        "agent_id": "hermes",
        "message_id": 123,
        "channel_id": "chan-1",
        "thread_id": None,
        "author": {"type": "user", "id": "tom", "name": "Tom"},
        "text": "@hermes hello there",
        "chat_name": "Ops / general",
        "context_note": "You are chatting in Agora",
        "mentioned": True,
        "from_bot": False,
    }
    frame.update(overrides)
    return frame


@needs_gateway
def test_inbound_frame_maps_to_message_event(monkeypatch):
    adapter = _make_adapter(monkeypatch)
    adapter._message_handler = object()  # dispatch guard only
    captured = []

    async def fake_handle(event):
        captured.append(event)

    adapter.handle_message = fake_handle
    asyncio.run(adapter._dispatch_inbound(_inbound_frame()))

    assert len(captured) == 1
    event = captured[0]
    assert event.text == "hello there"  # mention stripped
    assert event.source.chat_id == "chan-1"
    assert event.source.chat_name == "Ops / general"
    assert event.source.chat_type == "group"
    assert event.source.user_id == "tom"
    assert event.source.user_name == "Tom"
    assert event.source.thread_id is None
    assert event.message_id == "123"
    # context_note surfaces once per channel...
    assert event.channel_context == "You are chatting in Agora"

    asyncio.run(adapter._dispatch_inbound(_inbound_frame(text="again")))
    assert captured[1].channel_context is None  # ...and only once


@needs_gateway
def test_inbound_thread_maps_to_composite_chat_id(monkeypatch):
    adapter = _make_adapter(monkeypatch)
    adapter._message_handler = object()
    captured = []

    async def fake_handle(event):
        captured.append(event)

    adapter.handle_message = fake_handle
    asyncio.run(adapter._dispatch_inbound(_inbound_frame(thread_id=7)))

    event = captured[0]
    assert event.source.chat_id == "chan-1:7"
    assert event.source.thread_id == "7"
    assert event.source.parent_chat_id == "chan-1"


@needs_gateway
def test_inbound_from_agents_ignored_by_default(monkeypatch):
    adapter = _make_adapter(monkeypatch)
    adapter._message_handler = object()
    captured = []

    async def fake_handle(event):
        captured.append(event)

    adapter.handle_message = fake_handle
    agent_author = {"type": "agent", "id": "other-bot", "name": "Bot"}
    asyncio.run(adapter._dispatch_inbound(_inbound_frame(author=agent_author)))
    asyncio.run(adapter._dispatch_inbound(_inbound_frame(from_bot=True)))
    assert captured == []


@needs_gateway
def test_inbound_from_agents_allowed_when_opted_in(monkeypatch):
    adapter = _make_adapter(monkeypatch, allow_agents=True)
    adapter._message_handler = object()
    captured = []

    async def fake_handle(event):
        captured.append(event)

    adapter.handle_message = fake_handle
    agent_author = {"type": "agent", "id": "other-bot", "name": "Bot"}
    asyncio.run(adapter._dispatch_inbound(_inbound_frame(author=agent_author)))
    assert len(captured) == 1
    assert captured[0].source.is_bot is True


@needs_gateway
def test_send_chunks_and_enqueues_post_frames(monkeypatch):
    from agora_plugin.adapter import MAX_POST_CHARS

    adapter = _make_adapter(monkeypatch)
    adapter._ws = object()  # pretend connected
    text = "x" * (MAX_POST_CHARS + 10)

    result = asyncio.run(adapter.send("chan-1:5", text))
    assert result.success

    frames = []
    while not adapter._outbox.empty():
        frames.append(adapter._outbox.get_nowait())
    assert len(frames) == 2
    for frame in frames:
        assert frame["type"] == "post"
        assert frame["agent_id"] == "hermes"
        assert frame["channel_id"] == "chan-1"
        assert frame["thread_id"] == 5
    assert "".join(f["text"] for f in frames) == text


@needs_gateway
def test_send_not_connected_is_retryable_failure(monkeypatch):
    adapter = _make_adapter(monkeypatch)
    result = asyncio.run(adapter.send("chan-1", "hi"))
    assert not result.success
    assert result.retryable


@needs_gateway
def test_hello_frame_shape(monkeypatch):
    adapter = _make_adapter(monkeypatch)
    assert adapter.agent_id == "hermes"
    assert adapter.agent_name == "Hermes"
    assert adapter.requires_mention is False
    assert adapter.name == "Agora"
