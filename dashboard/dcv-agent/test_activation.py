import json
from types import SimpleNamespace
import unittest
from activation import activate_idle_console, require_idle_console


IDLE = {"id": "console", "type": "console", "owner": "ubuntu", "num-of-connections": 0, "status": "running"}


class ActivationTests(unittest.TestCase):
    def test_busy_virtual_or_foreign_sessions_are_rejected(self):
        for sessions in [[{**IDLE, "num-of-connections": 1}], [{**IDLE, "type": "virtual"}],
                         [{**IDLE, "owner": "other"}], [IDLE, {**IDLE, "id": "other"}], []]:
            with self.subTest(sessions=sessions):
                with self.assertRaisesRegex(RuntimeError, "idle"):
                    require_idle_console(sessions, "console", "ubuntu")

    def test_existing_running_console_is_ready_even_when_another_cannot_be_created(self):
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            if args[1] == "server-ready":
                raise AssertionError("Creation capacity is not existing console health")
            return SimpleNamespace(returncode=0, stdout=json.dumps([IDLE]))

        activate_idle_console("console", "ubuntu", run=run)
        self.assertIn(["systemctl", "restart", "dcvserver"], calls)
        self.assertEqual([args for args in calls if args[0] == "systemctl"],
                         [["systemctl", "restart", "dcvserver"]])

    def test_fresh_guard_precedes_service_mutation(self):
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            return SimpleNamespace(returncode=0, stdout=json.dumps([{**IDLE, "num-of-connections": 1}]))

        with self.assertRaisesRegex(RuntimeError, "idle"):
            activate_idle_console("console", "ubuntu", run=run)
        self.assertEqual(calls, [["dcv", "list-sessions", "--json"]])

    def test_restores_only_the_registered_console_when_autocreation_is_absent(self):
        calls = []
        reads = iter([[IDLE], [], [IDLE]])

        def run(args, **kwargs):
            calls.append(args)
            return SimpleNamespace(returncode=0, stdout=json.dumps(next(reads)) if args[1] == "list-sessions" else "")

        activate_idle_console("console", "ubuntu", run=run)
        self.assertIn(["dcv", "server-ready", "--type=console"], calls)
        self.assertIn(["dcv", "create-session", "console", "--owner", "ubuntu", "--type", "console"], calls)


if __name__ == "__main__":
    unittest.main()
