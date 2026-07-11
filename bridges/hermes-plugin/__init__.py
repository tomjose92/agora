"""Plugin: agora

Bridges a Hermes agent into an Agora hub as a dial-in (pairing-token) agent,
speaking the same WebSocket frame protocol as Agora's claude-cli bridge.
See README.md in this directory for setup and the protocol summary.

Registration is defensive: on Hermes images that predate the platform-plugin
API (or outside the gateway, where ``gateway.*`` modules may not import),
``register`` silently no-ops instead of raising — matching the other plugins
in this repo.
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Dict, List, Optional


def _config_extra(config) -> dict:
    return getattr(config, "extra", {}) or {}


def check_requirements() -> bool:
    """The only dependency beyond env config is the websockets package."""
    try:
        import websockets  # noqa: F401
    except ImportError:
        return False
    return True


def _resolve_settings(extra: dict) -> tuple[str, str]:
    """(url, token) from env > config extra."""
    from .protocol import resolve_token

    url = os.getenv("AGORA_URL") or str(extra.get("url", "") or "")
    return url.strip(), resolve_token(extra)


def validate_config(config) -> bool:
    url, token = _resolve_settings(_config_extra(config))
    return bool(url and token)


def is_connected(config) -> bool:
    """Configured (env or config.yaml) — used by gateway status displays."""
    return validate_config(config)


def _env_enablement() -> Optional[dict]:
    """Seed ``PlatformConfig.extra`` from env vars during gateway config load.

    Called before adapter construction so ``hermes gateway status`` and
    ``get_connected_platforms()`` reflect env-only configuration. Returns
    ``None`` when Agora isn't minimally configured (caller skips auto-enable).
    The token itself stays in the environment — only non-secret settings are
    seeded into ``extra``.
    """
    from .protocol import resolve_token

    url = os.getenv("AGORA_URL", "").strip()
    if not url or not resolve_token():
        return None
    seed: dict = {"url": url}
    agent_id = os.getenv("AGORA_AGENT_ID", "").strip()
    if agent_id:
        seed["agent_id"] = agent_id
    agent_name = os.getenv("AGORA_AGENT_NAME", "").strip()
    if agent_name:
        seed["agent_name"] = agent_name
    rm = os.getenv("AGORA_REQUIRES_MENTION", "").strip().lower()
    if rm:
        seed["requires_mention"] = rm in {"1", "true", "yes", "on"}
    aa = os.getenv("AGORA_ALLOW_AGENTS", "").strip().lower()
    if aa:
        seed["allow_agents"] = aa in {"1", "true", "yes", "on"}
    home = os.getenv("AGORA_HOME_CHANNEL", "").strip()
    if home:
        seed["home_channel"] = {
            "chat_id": home,
            "name": os.getenv("AGORA_HOME_CHANNEL_NAME", home),
        }
    return seed


async def _standalone_send(
    pconfig,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[List[str]] = None,
    force_document: bool = False,
) -> Dict[str, Any]:
    """Ephemeral connect → hello → post → close, for out-of-process cron.

    Used by ``tools/send_message_tool._send_via_adapter`` when the gateway
    runner is not in this process. ``media_files`` is accepted for signature
    parity but not meaningful — Agora dial-in posts are text frames.
    """
    from .protocol import chunk_text, normalize_url, split_chat_id

    try:
        import websockets
    except ImportError:
        return {"error": "Agora standalone send: pip install websockets"}

    extra = _config_extra(pconfig)
    url_base, token = _resolve_settings(extra)
    if not url_base or not token:
        return {"error": "Agora standalone send: AGORA_URL and AGORA_PAIRING_TOKEN must be configured"}
    try:
        url = normalize_url(url_base, token)
    except ValueError as e:
        return {"error": f"Agora standalone send: {e}"}

    agent_id = os.getenv("AGORA_AGENT_ID") or extra.get("agent_id", "hermes")
    agent_name = os.getenv("AGORA_AGENT_NAME") or extra.get("agent_name", "Hermes")
    channel_id, parsed_thread = split_chat_id(str(chat_id))
    if thread_id is not None and str(thread_id).isdigit():
        parsed_thread = int(str(thread_id))

    try:
        async with asyncio.timeout(30):
            async with websockets.connect(url, max_size=1024 * 1024) as ws:
                # Register first — Agora drops pre-hello frames silently.
                await ws.send(json.dumps({
                    "type": "hello",
                    "agents": [{
                        "id": agent_id,
                        "name": agent_name,
                        "requires_mention": True,  # ephemeral: never fan-in
                    }],
                }))
                for chunk in chunk_text(message):
                    await ws.send(json.dumps({
                        "type": "post",
                        "agent_id": agent_id,
                        "channel_id": channel_id,
                        "thread_id": parsed_thread,
                        "text": chunk,
                    }))
    except asyncio.CancelledError:
        raise
    except TimeoutError:
        return {"error": "Agora standalone send: timed out after 30s"}
    except Exception as e:
        return {"error": f"Agora standalone send failed: {e}"}
    import time as _time
    return {"success": True, "message_id": str(int(_time.time() * 1000))}


def interactive_setup() -> None:
    """Interactive ``hermes gateway setup`` flow for the Agora platform."""
    from hermes_cli.setup import (
        prompt,
        prompt_yes_no,
        save_env_value,
        get_env_value,
        print_header,
        print_info,
        print_warning,
        print_success,
    )

    print_header("Agora")
    existing_url = get_env_value("AGORA_URL")
    if existing_url:
        print_info(f"Agora: already configured (hub: {existing_url})")
        if not prompt_yes_no("Reconfigure Agora?", False):
            return

    print_info("Connect Hermes to an Agora hub as a dial-in agent.")
    print_info("   Mint a pairing token on Agora's Connections page (New token).")
    print()

    url = prompt("Agora hub URL (e.g. wss://agora.example.com)", default=existing_url or "")
    if not url:
        print_warning("Hub URL is required — skipping Agora setup")
        return
    save_env_value("AGORA_URL", url.strip())

    token = prompt("Pairing token", password=True)
    if token:
        save_env_value("AGORA_PAIRING_TOKEN", token.strip())
    elif not get_env_value("AGORA_PAIRING_TOKEN"):
        print_warning("A pairing token is required — skipping Agora setup")
        return

    agent_id = prompt("Agent id (default: hermes)", default=get_env_value("AGORA_AGENT_ID") or "")
    if agent_id:
        save_env_value("AGORA_AGENT_ID", agent_id.strip())
    agent_name = prompt("Agent display name (default: Hermes)", default=get_env_value("AGORA_AGENT_NAME") or "")
    if agent_name:
        save_env_value("AGORA_AGENT_NAME", agent_name.strip())

    if prompt_yes_no("Only respond when @mentioned in a channel?", False):
        save_env_value("AGORA_REQUIRES_MENTION", "true")
    else:
        save_env_value("AGORA_REQUIRES_MENTION", "false")

    print()
    print_info("🔒 Access control: restrict which Agora users can talk to the bot")
    if prompt_yes_no("Allow all channel members to talk to the bot?", True):
        save_env_value("AGORA_ALLOW_ALL_USERS", "true")
        save_env_value("AGORA_ALLOWED_USERS", "")
    else:
        save_env_value("AGORA_ALLOW_ALL_USERS", "false")
        allowed = prompt(
            "Allowed Agora user ids (comma-separated)",
            default=get_env_value("AGORA_ALLOWED_USERS") or "",
        )
        save_env_value("AGORA_ALLOWED_USERS", (allowed or "").replace(" ", ""))

    home = prompt(
        "Home channel id for cron delivery (optional)",
        default=get_env_value("AGORA_HOME_CHANNEL") or "",
    )
    if home:
        save_env_value("AGORA_HOME_CHANNEL", home.strip())

    print()
    print_success("Agora configuration saved to ~/.hermes/.env")
    print_info("Restart the gateway for changes to take effect: hermes gateway restart")


def register(ctx) -> None:
    """Plugin entry point: called by the Hermes plugin system."""
    reg = getattr(ctx, "register_platform", None)
    if reg is None:
        # Hermes image predates the platform-plugin API — don't raise.
        return
    try:
        from .adapter import AgoraAdapter
    except Exception:
        # gateway.* not importable in this context (e.g. bare CLI tooling).
        return
    try:
        reg(
            name="agora",
            label="Agora",
            adapter_factory=lambda cfg: AgoraAdapter(cfg),
            check_fn=check_requirements,
            validate_config=validate_config,
            is_connected=is_connected,
            required_env=["AGORA_URL", "AGORA_PAIRING_TOKEN"],
            install_hint="pip install websockets",
            setup_fn=interactive_setup,
            env_enablement_fn=_env_enablement,
            cron_deliver_env_var="AGORA_HOME_CHANNEL",
            standalone_sender_fn=_standalone_send,
            allowed_users_env="AGORA_ALLOWED_USERS",
            allow_all_env="AGORA_ALLOW_ALL_USERS",
            max_message_length=8000,
            emoji="🏛️",
            pii_safe=False,
            allow_update_command=True,
            platform_hint=(
                "You are chatting in Agora, a shared multi-agent chat hub where "
                "humans and agents share channels. Markdown renders normally. "
                "Posts are limited to 8000 characters (long replies are split "
                "automatically). Mention channel members with @handle. Keep "
                "responses conversational."
            ),
        )
    except Exception:
        pass
