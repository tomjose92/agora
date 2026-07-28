import asyncio
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock


SPEC = importlib.util.spec_from_file_location(
    "cursor_bridge", Path(__file__).with_name("bridge.py")
)
bridge = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(bridge)


class ModelSelectionTests(unittest.TestCase):
    def test_cursor_model_ids_and_parameters_are_accepted(self):
        self.assertEqual(bridge.normalize_model("gpt-5"), "gpt-5")
        self.assertEqual(
            bridge.normalize_model("claude-opus-4-8[effort=high,fast=false]"),
            "claude-opus-4-8[effort=high,fast=false]",
        )

    def test_shell_metacharacters_are_rejected(self):
        self.assertIsNone(bridge.normalize_model("gpt-5; touch /tmp/no"))

    def test_aliases_resolve_to_full_ids(self):
        self.assertEqual(bridge.resolve_model("grok"), "cursor-grok-4.5-high-fast")
        self.assertEqual(bridge.resolve_model("OPUS"), "claude-opus-5-thinking-high-fast")
        # Non-alias ids pass through validation unchanged.
        self.assertEqual(bridge.resolve_model("gpt-5.5-high-fast"), "gpt-5.5-high-fast")
        self.assertIsNone(bridge.resolve_model("grok; rm -rf /"))

    def test_model_command_accepts_alias(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.bindings = {"channel": {"cwd": "/tmp"}}
        instance.default_model = None
        instance._save_state = Mock()

        reply = instance._cmd_model("channel", "sonnet")

        self.assertEqual(
            instance.bindings["channel"]["model"], "claude-sonnet-5-thinking-high"
        )
        self.assertIn("claude-sonnet-5-thinking-high", reply)

    def test_model_command_persists_canonical_id(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.bindings = {"channel": {"cwd": "/tmp"}}
        instance.default_model = None
        instance._save_state = Mock()

        reply = instance._cmd_model("channel", "gpt-5")

        self.assertEqual(instance.bindings["channel"]["model"], "gpt-5")
        self.assertIn("gpt-5", reply)
        instance._save_state.assert_called_once()

    def test_default_clears_override_and_falls_back_to_sol(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.bindings = {
            "channel": {"cwd": "/tmp", "model": "gpt-5"}
        }
        instance.default_model = None
        instance._save_state = Mock()

        reply = instance._cmd_model("channel", "default")

        self.assertNotIn("model", instance.bindings["channel"])
        self.assertIn("Cursor Auto", reply)


class CursorBinaryTests(unittest.TestCase):
    def test_explicit_executable_path_is_resolved(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "agent"
            executable.write_text("#!/bin/sh\n")
            executable.chmod(0o700)
            self.assertEqual(
                bridge.resolve_agent_bin(str(executable)), str(executable.resolve())
            )

    def test_missing_explicit_path_returns_none(self):
        self.assertIsNone(bridge.resolve_agent_bin("/definitely/missing/agent"))


class ProgressSnippetTests(unittest.TestCase):
    def test_formats_tool_path_and_phase(self):
        event = {
            "type": "tool_call",
            "subtype": "started",
            "tool_call": {"readToolCall": {"args": {"path": "src/auth.rs"}}},
        }
        self.assertEqual(
            bridge.Bridge._progress_snippet(event),
            "readToolCall started: src/auth.rs",
        )

    def test_formats_terminal_command(self):
        event = {
            "type": "tool_call",
            "subtype": "completed",
            "tool_call": {"terminalToolCall": {"args": {"command": "cargo test"}}},
        }
        self.assertEqual(
            bridge.Bridge._progress_snippet(event),
            "terminalToolCall completed: cargo test",
        )

    def test_falls_back_for_unknown_or_empty_tool_shape(self):
        self.assertEqual(
            bridge.Bridge._progress_snippet(
                {"subtype": "started", "tool_call": {"customToolCall": {}}}
            ),
            "customToolCall started",
        )
        self.assertEqual(
            bridge.Bridge._progress_snippet({"subtype": "started"}),
            "tool started",
        )


class ModeSelectionTests(unittest.TestCase):
    def test_force_requires_bridge_opt_in(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.bindings = {"channel": {"cwd": "/tmp"}}
        instance.default_mode = "agent"
        instance.allow_force = False
        instance.disable_sandbox = False
        instance._save_state = Mock()
        self.assertIn("disabled", instance._cmd_mode("channel", "force"))
        self.assertNotIn("mode", instance.bindings["channel"])


def make_bridge(peer_agents=""):
    """A Bridge with just enough state to drive handle_inbound."""
    instance = bridge.Bridge.__new__(bridge.Bridge)
    instance.agent_id = "cursor-cli"
    instance.agent_name = "Cursor"
    instance.peer_agents = bridge.parse_peer_agents(peer_agents)
    instance.context_buffer = {}
    instance.context_buffer_limit = 50
    instance.busy = set()
    instance.bindings = {}
    instance.set_reaction = Mock()
    instance.clear_reaction = Mock()
    instance.post = Mock()
    instance.forward_to_agent = AsyncMock()
    return instance


def peer_frame(**overrides):
    frame = {
        "channel_id": "c1",
        "author": {"type": "agent", "id": "claude-cli", "name": "Claude"},
        "mentioned": True,
        "any_mention": True,
        "text": "@agent please review the diff",
        "bot_turns_left": 3,
    }
    frame.update(overrides)
    return frame


class PeerConfigTests(unittest.TestCase):
    def test_parse_normalizes_case_whitespace_and_empties(self):
        self.assertEqual(
            bridge.parse_peer_agents(" Claude-CLI ,, other-bot "),
            frozenset({"claude-cli", "other-bot"}),
        )
        self.assertEqual(bridge.parse_peer_agents(""), frozenset())
        self.assertEqual(bridge.parse_peer_agents(None), frozenset())


class PeerInboundTests(unittest.TestCase):
    def test_feature_off_buffers_even_when_mentioned(self):
        instance = make_bridge(peer_agents="")
        asyncio.run(instance.handle_inbound(peer_frame()))
        instance.forward_to_agent.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_allowlisted_peer_mention_drives_agent(self):
        instance = make_bridge(peer_agents="claude-cli")
        asyncio.run(instance.handle_inbound(peer_frame()))
        instance.forward_to_agent.assert_awaited_once()
        args, kwargs = instance.forward_to_agent.await_args
        self.assertTrue(kwargs.get("from_peer"))
        prompt = args[2]
        self.assertIn("Relay note", prompt)
        self.assertIn("Claude", prompt)
        self.assertNotIn("c1", instance.context_buffer)

    def test_unmentioned_peer_message_only_buffers(self):
        instance = make_bridge(peer_agents="claude-cli")
        asyncio.run(instance.handle_inbound(peer_frame(mentioned=False)))
        instance.forward_to_agent.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_non_allowlisted_agent_only_buffers(self):
        instance = make_bridge(peer_agents="claude-cli")
        frame = peer_frame(author={"type": "agent", "id": "rogue-bot", "name": "Rogue"})
        asyncio.run(instance.handle_inbound(frame))
        instance.forward_to_agent.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_peer_text_never_reaches_the_command_table(self):
        instance = make_bridge(peer_agents="claude-cli")
        instance._cmd_new = Mock()
        asyncio.run(instance.handle_inbound(peer_frame(text="/new /tmp")))
        instance._cmd_new.assert_not_called()
        instance.forward_to_agent.assert_awaited_once()
        prompt = instance.forward_to_agent.await_args.args[2]
        self.assertTrue(prompt.startswith("[Relay note"))
        self.assertIn("/new /tmp", prompt)


class PeerPromptTests(unittest.TestCase):
    def test_budget_tiers(self):
        instance = make_bridge(peer_agents="claude-cli")
        plenty = instance._peer_prompt(peer_frame(bot_turns_left=3), "go")
        self.assertIn("2 more agent message(s)", plenty)
        last = instance._peer_prompt(peer_frame(bot_turns_left=1), "go")
        self.assertIn("final relayed agent turn", last)
        spent = instance._peer_prompt(peer_frame(bot_turns_left=0), "go")
        self.assertIn("Do not @mention any agent", spent)
        missing = instance._peer_prompt(peer_frame(bot_turns_left=None), "go")
        self.assertIn("Do not @mention any agent", missing)

    def test_prompt_names_the_peer_and_keeps_the_text(self):
        instance = make_bridge(peer_agents="claude-cli")
        prompt = instance._peer_prompt(peer_frame(), "review the diff")
        self.assertIn('"Claude" (@claude)', prompt)
        self.assertTrue(prompt.endswith("Claude: review the diff"))


class PeerBusyTests(unittest.TestCase):
    def test_busy_peer_turn_buffers_instead_of_noise_post(self):
        instance = make_bridge(peer_agents="claude-cli")
        del instance.forward_to_agent  # exercise the real method
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        handled = asyncio.run(
            instance.forward_to_agent("c1", peer_frame(), "wrapped", from_peer=True)
        )
        # False tells handle_inbound to skip the ✅ reaction — nothing ran.
        self.assertFalse(handled)
        instance.post.assert_not_called()
        self.assertIn("c1", instance.context_buffer)
        instance.clear_reaction.assert_called_once()

    def test_busy_human_turn_still_gets_the_notice(self):
        instance = make_bridge()
        del instance.forward_to_agent
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        frame = {"channel_id": "c1", "author": {"type": "user", "id": "tom"}}
        handled = asyncio.run(instance.forward_to_agent("c1", frame, "hello"))
        self.assertTrue(handled)
        instance.post.assert_called_once()
        self.assertIn("Still working", instance.post.call_args.args[1])


class PromptSuffixTests(unittest.TestCase):
    def test_collab_suffix_rides_only_with_peer_agents(self):
        instance = make_bridge(peer_agents="claude-cli")
        instance.tldr_default = False
        self.assertEqual(
            instance._prompt_suffixes({}), bridge.COLLAB_PROMPT_SUFFIX)
        instance.peer_agents = frozenset()
        self.assertEqual(instance._prompt_suffixes({}), "")
        instance.tldr_default = True
        self.assertEqual(
            instance._prompt_suffixes({}), bridge.TLDR_PROMPT_SUFFIX)


if __name__ == "__main__":
    unittest.main()
