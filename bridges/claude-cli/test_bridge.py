import asyncio
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock


SPEC = importlib.util.spec_from_file_location(
    "claude_bridge", Path(__file__).with_name("bridge.py")
)
bridge = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(bridge)


def make_bridge(peer_agents=""):
    """A Bridge with just enough state to drive handle_inbound."""
    instance = bridge.Bridge.__new__(bridge.Bridge)
    instance.agent_id = "claude-cli"
    instance.agent_name = "Claude"
    instance.peer_agents = bridge.parse_peer_agents(peer_agents)
    instance.context_buffer = {}
    instance.context_buffer_limit = 50
    instance.busy = set()
    instance.bindings = {}
    instance.pending_questions = {}
    instance.set_reaction = Mock()
    instance.clear_reaction = Mock()
    instance.post = Mock()
    instance.forward_to_claude = AsyncMock()
    return instance


def peer_frame(**overrides):
    frame = {
        "channel_id": "c1",
        "author": {"type": "agent", "id": "codex-cli", "name": "Codex"},
        "mentioned": True,
        "any_mention": True,
        "text": "@claude please review the diff",
        "bot_turns_left": 3,
    }
    frame.update(overrides)
    return frame


class PeerConfigTests(unittest.TestCase):
    def test_parse_normalizes_case_whitespace_and_empties(self):
        self.assertEqual(
            bridge.parse_peer_agents(" Codex-CLI ,, other-bot "),
            frozenset({"codex-cli", "other-bot"}),
        )
        self.assertEqual(bridge.parse_peer_agents(""), frozenset())
        self.assertEqual(bridge.parse_peer_agents(None), frozenset())


class PeerInboundTests(unittest.TestCase):
    def test_feature_off_buffers_even_when_mentioned(self):
        instance = make_bridge(peer_agents="")
        asyncio.run(instance.handle_inbound(peer_frame()))
        instance.forward_to_claude.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_allowlisted_peer_mention_drives_claude(self):
        instance = make_bridge(peer_agents="codex-cli")
        asyncio.run(instance.handle_inbound(peer_frame()))
        instance.forward_to_claude.assert_awaited_once()
        args, kwargs = instance.forward_to_claude.await_args
        self.assertTrue(kwargs.get("from_peer"))
        prompt = args[2]
        self.assertIn("Relay note", prompt)
        self.assertIn("Codex", prompt)
        self.assertNotIn("c1", instance.context_buffer)

    def test_unmentioned_peer_message_only_buffers(self):
        instance = make_bridge(peer_agents="codex-cli")
        asyncio.run(instance.handle_inbound(peer_frame(mentioned=False)))
        instance.forward_to_claude.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_non_allowlisted_agent_only_buffers(self):
        instance = make_bridge(peer_agents="codex-cli")
        frame = peer_frame(author={"type": "agent", "id": "rogue-bot", "name": "Rogue"})
        asyncio.run(instance.handle_inbound(frame))
        instance.forward_to_claude.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_peer_text_never_reaches_the_command_table(self):
        instance = make_bridge(peer_agents="codex-cli")
        instance._cmd_new = Mock()
        asyncio.run(instance.handle_inbound(peer_frame(text="/new /tmp")))
        instance._cmd_new.assert_not_called()
        instance.forward_to_claude.assert_awaited_once()
        prompt = instance.forward_to_claude.await_args.args[2]
        self.assertTrue(prompt.startswith("[Relay note"))
        self.assertIn("/new /tmp", prompt)


class PeerPromptTests(unittest.TestCase):
    def test_budget_tiers(self):
        instance = make_bridge(peer_agents="codex-cli")
        plenty = instance._peer_prompt(peer_frame(bot_turns_left=3), "go")
        self.assertIn("2 more agent message(s)", plenty)
        last = instance._peer_prompt(peer_frame(bot_turns_left=1), "go")
        self.assertIn("final relayed agent turn", last)
        spent = instance._peer_prompt(peer_frame(bot_turns_left=0), "go")
        self.assertIn("Do not @mention any agent", spent)
        missing = instance._peer_prompt(peer_frame(bot_turns_left=None), "go")
        self.assertIn("Do not @mention any agent", missing)

    def test_prompt_names_the_peer_and_keeps_the_text(self):
        instance = make_bridge(peer_agents="codex-cli")
        prompt = instance._peer_prompt(peer_frame(), "review the diff")
        self.assertIn('"Codex" (@codex)', prompt)
        self.assertTrue(prompt.endswith("Codex: review the diff"))


class PeerForwardTests(unittest.TestCase):
    def test_peer_turn_never_answers_a_pending_question(self):
        instance = make_bridge(peer_agents="codex-cli")
        del instance.forward_to_claude  # exercise the real method
        instance._answer_pending_question = Mock(return_value=True)
        asyncio.run(
            instance.forward_to_claude("c1", peer_frame(), "wrapped", from_peer=True)
        )
        instance._answer_pending_question.assert_not_called()
        # No binding: the run stops with the usual notice.
        instance.post.assert_called_once()
        self.assertIn("No session bound", instance.post.call_args.args[1])

    def test_human_turn_still_answers_a_pending_question(self):
        instance = make_bridge()
        del instance.forward_to_claude
        instance._answer_pending_question = Mock(return_value=True)
        frame = {"channel_id": "c1", "author": {"type": "user", "id": "tom"}}
        asyncio.run(instance.forward_to_claude("c1", frame, "option 2"))
        instance._answer_pending_question.assert_called_once()
        instance.post.assert_not_called()

    def test_busy_peer_turn_buffers_instead_of_noise_post(self):
        instance = make_bridge(peer_agents="codex-cli")
        del instance.forward_to_claude
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        handled = asyncio.run(
            instance.forward_to_claude("c1", peer_frame(), "wrapped", from_peer=True)
        )
        # False tells handle_inbound to skip the ✅ reaction — nothing ran.
        self.assertFalse(handled)
        instance.post.assert_not_called()
        self.assertIn("c1", instance.context_buffer)
        instance.clear_reaction.assert_called_once()

    def test_busy_human_turn_still_gets_the_notice(self):
        instance = make_bridge()
        del instance.forward_to_claude
        instance._answer_pending_question = Mock(return_value=False)
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        frame = {"channel_id": "c1", "author": {"type": "user", "id": "tom"}}
        handled = asyncio.run(instance.forward_to_claude("c1", frame, "hello"))
        self.assertTrue(handled)
        instance.post.assert_called_once()
        self.assertIn("Still working", instance.post.call_args.args[1])


class AppendSystemArgsTests(unittest.TestCase):
    def test_blocks_join_into_a_single_flag(self):
        instance = make_bridge(peer_agents="codex-cli")
        instance.tldr_default = True
        args = instance._append_system_args({})
        self.assertEqual(args[0], "--append-system-prompt")
        self.assertEqual(
            args[1],
            bridge.COLLAB_SYSTEM_PROMPT + "\n\n" + bridge.TLDR_SYSTEM_PROMPT,
        )
        self.assertEqual(len(args), 2)

    def test_each_block_rides_alone(self):
        instance = make_bridge(peer_agents="codex-cli")
        instance.tldr_default = False
        self.assertEqual(
            instance._append_system_args({}),
            ["--append-system-prompt", bridge.COLLAB_SYSTEM_PROMPT],
        )
        instance.peer_agents = frozenset()
        instance.tldr_default = True
        self.assertEqual(
            instance._append_system_args({}),
            ["--append-system-prompt", bridge.TLDR_SYSTEM_PROMPT],
        )

    def test_neither_block_means_no_flag(self):
        instance = make_bridge()
        instance.tldr_default = False
        self.assertEqual(instance._append_system_args({}), [])


if __name__ == "__main__":
    unittest.main()
