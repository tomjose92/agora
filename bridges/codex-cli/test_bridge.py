import importlib.util
import unittest
from pathlib import Path
from unittest.mock import Mock


SPEC = importlib.util.spec_from_file_location(
    "codex_bridge", Path(__file__).with_name("bridge.py")
)
bridge = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(bridge)


class ModelSelectionTests(unittest.TestCase):
    def test_friendly_names_are_case_insensitive(self):
        self.assertEqual(bridge.normalize_model("sol"), "gpt-5.6-sol")
        self.assertEqual(bridge.normalize_model("TERRA"), "gpt-5.6-terra")
        self.assertEqual(bridge.normalize_model(" luna "), "gpt-5.6-luna")

    def test_unknown_models_are_rejected(self):
        self.assertIsNone(bridge.normalize_model("gpt-unlisted"))

    def test_model_command_persists_canonical_id(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.bindings = {"channel": {"cwd": "/tmp"}}
        instance.default_model = bridge.DEFAULT_MODEL
        instance._save_state = Mock()

        reply = instance._cmd_model("channel", "luna")

        self.assertEqual(instance.bindings["channel"]["model"], "gpt-5.6-luna")
        self.assertIn("gpt-5.6-luna", reply)
        instance._save_state.assert_called_once()

    def test_default_clears_override_and_falls_back_to_sol(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.bindings = {
            "channel": {"cwd": "/tmp", "model": "gpt-5.6-terra"}
        }
        instance.default_model = bridge.DEFAULT_MODEL
        instance._save_state = Mock()

        reply = instance._cmd_model("channel", "default")

        self.assertNotIn("model", instance.bindings["channel"])
        self.assertIn("gpt-5.6-sol", reply)


class SandboxSelectionTests(unittest.TestCase):
    def test_workspace_git_selects_permission_profile(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)

        self.assertEqual(
            instance._sandbox_args("workspace-git"),
            ["-c", "default_permissions=workspace-git"],
        )


if __name__ == "__main__":
    unittest.main()
