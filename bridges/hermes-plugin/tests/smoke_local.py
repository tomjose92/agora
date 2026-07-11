"""End-to-end smoke test for the Agora platform plugin against a real hub.

Not collected by pytest — run manually:

    python plugins/agora/tests/smoke_local.py \
        [--server /path/to/agora-server] [--agora-repo /path/to/agora]

It boots a throwaway agora-server on 127.0.0.1 with a temp data dir, mints a
pairing token via the owner API, connects the AgoraAdapter, then drives a full
conversation loop through the hub's REST API:

  1. adapter registers via hello           -> /api/agents shows it live
  2. owner creates group/channel + member  -> hub fans out messages to it
  3. owner posts "@hermes ..."             -> adapter's handle_message fires
  4. adapter.send() replies                -> reply visible in /api/messages
  5. server restarts                       -> adapter reconnects on its own

Requires: the hermes-agent checkout importable (default ~/.hermes/hermes-agent)
and the ``websockets`` package.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

PLUGIN_DIR = Path(__file__).resolve().parent.parent
HERMES_AGENT_CHECKOUT = Path.home() / ".hermes" / "hermes-agent"
DEFAULT_AGORA_REPO = Path.home() / "Coding" / "agora"
# Set by start_server from the hub's "Agora ready at" line — the server falls
# back to an ephemeral port when the requested one is taken.
BASE = ""


def api(method: str, path: str, owner_token: str, payload: dict | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        method=method,
        headers={
            "Authorization": f"Bearer {owner_token}",
            "Content-Type": "application/json",
        },
        data=json.dumps(payload).encode() if payload is not None else None,
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def wait_for(predicate, timeout: float, what: str):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.25)
    raise AssertionError(f"timed out waiting for {what}")


async def await_for(predicate, timeout: float, what: str):
    """Async variant — must be used inside main() so the adapter's sender and
    reconnect tasks keep running on the event loop while we poll."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        await asyncio.sleep(0.25)
    raise AssertionError(f"timed out waiting for {what}")


def load_plugin():
    name = "agora_plugin"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            name, PLUGIN_DIR / "__init__.py",
            submodule_search_locations=[str(PLUGIN_DIR)],
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def start_server(server_bin: Path, agora_repo: Path, data_dir: Path) -> subprocess.Popen:
    """Boot agora-server and set BASE from its "Agora ready at" banner."""
    global BASE
    env = {**os.environ, "AGORA_BIND": "127.0.0.1", "AGORA_PORT": "4571"}
    log_path = data_dir / "server.log"
    log = open(log_path, "w")
    proc = subprocess.Popen(
        [str(server_bin), "--data-dir", str(data_dir)],
        cwd=str(agora_repo),  # so the ui/ dir resolves
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )

    def ready_url():
        if proc.poll() is not None:
            raise AssertionError(
                f"agora-server exited with {proc.returncode}:\n{log_path.read_text()[-2000:]}"
            )
        for line in log_path.read_text().splitlines():
            if line.startswith("Agora ready at "):
                return line.removeprefix("Agora ready at ").strip()
        return None

    def up():
        # Any HTTP response (401/404 included) means the listener is live.
        try:
            urllib.request.urlopen(BASE + "/api/agents", timeout=2)
            return True
        except urllib.error.HTTPError:
            return True
        except Exception:
            return False

    try:
        BASE = wait_for(ready_url, 20, "agora-server to come up")
        wait_for(up, 10, "agora-server API to respond")
    except BaseException:
        proc.terminate()  # don't leak a listener that blocks the next run
        raise
    return proc


async def main(server_bin: Path, agora_repo: Path) -> None:
    if str(HERMES_AGENT_CHECKOUT) not in sys.path and (HERMES_AGENT_CHECKOUT / "gateway").is_dir():
        sys.path.insert(0, str(HERMES_AGENT_CHECKOUT))

    load_plugin()
    from agora_plugin.adapter import AgoraAdapter
    from gateway.platform_registry import platform_registry, PlatformEntry

    if not platform_registry.is_registered("agora"):
        platform_registry.register(PlatformEntry(
            name="agora", label="Agora",
            adapter_factory=lambda cfg: None, check_fn=lambda: True,
        ))

    tmp = Path(tempfile.mkdtemp(prefix="agora-smoke-"))
    proc = start_server(server_bin, agora_repo, tmp)
    adapter = None
    try:
        owner_token = json.loads((tmp / "config.json").read_text())["owner_token"]
        pairing = api("POST", "/api/pairing", owner_token, {"name": "hermes-smoke"})
        print(f"[1] hub up, pairing token minted: {pairing['token'][:8]}…")

        # -- connect the adapter -------------------------------------------
        for var in ("AGORA_URL", "AGORA_PAIRING_TOKEN", "AGORA_PAIRING_TOKEN_FILE",
                    "AGORA_AGENT_ID", "AGORA_AGENT_NAME"):
            os.environ.pop(var, None)
        config = SimpleNamespace(extra={
            "url": BASE.replace("http://", "ws://"),
            "pairing_token": pairing["token"],
        })
        adapter = AgoraAdapter(config)
        inbox: asyncio.Queue = asyncio.Queue()

        async def capture(event):
            await inbox.put(event)

        adapter.handle_message = capture
        adapter._message_handler = object()  # dispatch guard only

        assert await adapter.connect(), "adapter.connect() failed"
        agents = api("GET", "/api/agents", owner_token)["agents"]
        hermes = next(a for a in agents if a["id"] == "hermes")
        assert hermes["live"], f"agent not live: {hermes}"
        print("[2] adapter connected; hub shows agent 'hermes' live")

        # -- channel membership + inbound fan-out --------------------------
        group = api("POST", "/api/groups", owner_token, {"name": "Smoke"})
        channel = api("POST", f"/api/groups/{group['id']}/channels", owner_token,
                      {"name": "general"})
        api("POST", f"/api/groups/{group['id']}/members", owner_token,
            {"member_type": "agent", "member_id": "hermes"})
        api("POST", f"/api/channels/{channel['id']}/messages", owner_token,
            {"text": "@hermes hello from the smoke test"})

        event = await asyncio.wait_for(inbox.get(), timeout=10)
        assert event.text == "hello from the smoke test", event.text
        assert event.source.chat_id == channel["id"]
        assert event.source.user_name == "me"
        print(f"[3] inbound fan-out ok: {event.text!r} in {event.source.chat_name!r}")

        # -- outbound reply -------------------------------------------------
        result = await adapter.send(event.source.chat_id, "Hi! Hermes here.")
        assert result.success, result.error

        def reply_visible():
            msgs = api("GET", f"/api/channels/{channel['id']}/messages", owner_token)["messages"]
            return any(
                m.get("text") == "Hi! Hermes here."
                and m.get("author_type") == "agent"
                and m.get("author_id") == "hermes"
                for m in msgs
            )

        await await_for(reply_visible, 10, "agent reply in channel")
        print("[4] outbound post ok: reply visible in channel history")

        # -- reconnect after hub restart ------------------------------------
        old_base = BASE
        proc.terminate()
        proc.wait(timeout=10)
        await asyncio.sleep(1)
        proc = start_server(server_bin, agora_repo, tmp)
        assert BASE == old_base, f"hub came back on a different port ({BASE}); rerun"

        def live_again():
            try:
                agents = api("GET", "/api/agents", owner_token)["agents"]
                return any(a["id"] == "hermes" and a["live"] for a in agents)
            except Exception:
                return False

        await await_for(live_again, 30, "adapter to reconnect after hub restart")
        print("[5] reconnect ok: agent live again after hub restart")

        print("\nSMOKE TEST PASSED")
    finally:
        if adapter is not None:
            await adapter.disconnect()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--agora-repo", type=Path, default=DEFAULT_AGORA_REPO)
    ap.add_argument("--server", type=Path, default=None,
                    help="agora-server binary (default: <repo>/target/release/agora-server)")
    args = ap.parse_args()
    server_bin = args.server or args.agora_repo / "target" / "release" / "agora-server"
    if not server_bin.exists():
        sys.exit(f"agora-server binary not found at {server_bin}")
    asyncio.run(main(server_bin, args.agora_repo))
