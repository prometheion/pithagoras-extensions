"""The Godot server's own code, without Godot: the tools it lists are the ones server/tools.json has, and what the
game tools do around the editor (game_input and game_state with no game to talk to, what they send it, what comes
back) and around a playtest run (which files run, the command line and environment a headless run gets, and the answer
made of what the game wrote). What needs Godot (the editor plugin and the game side, addon/godot_mcp_bridge) is the
image's to show: `python3 godot/server/client.py gametest` against a running server.

    python3 godot/test/server_test.py
"""
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "server", "server.py")

os.environ.update(GODOT_SERVER_TOKEN="token", GODOT_DATA_DIR=tempfile.mkdtemp(prefix="godot-server-test-"))
spec = importlib.util.spec_from_file_location("server", SERVER)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def setUpModule():
    sys.stdout = io.StringIO()   # what the server logs: kept out of the tests' report
    for d in (server.PROJECTS, server.TMP):
        os.makedirs(d, exist_ok=True)


def tearDownModule():
    sys.stdout = sys.__stdout__


def call(name, args=None):
    return server.mcp_dispatch({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": name, "arguments": args or {}}}, {})["result"]


class Patched:
    """Stands in for module attributes for the length of a with block."""

    def __init__(self, **values):
        self.values, self.saved = values, {}

    def __enter__(self):
        for k, v in self.values.items():
            self.saved[k] = getattr(server, k)
            setattr(server, k, v)
        return self

    def __exit__(self, *a):
        for k, v in self.saved.items():
            setattr(server, k, v)


def project(name, files):
    """A project folder with these files (path -> text), open as the editor's project."""
    path = os.path.join(server.PROJECTS, name)
    for rel, text in files.items():
        server.write_text(os.path.join(path, rel), text)
    server.CURRENT["name"] = name
    return path


class Tools(unittest.TestCase):
    def test_the_server_lists_the_tools_and_instructions_server_tools_json_has(self):
        with open(os.path.join(HERE, "..", "server", "tools.json"), encoding="utf8") as f:
            kept = json.load(f)
        listed = server.mcp_dispatch({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, {})["result"]["tools"]
        self.assertEqual(listed, kept["tools"])
        self.assertEqual(server.MCP_INSTRUCTIONS, kept["instructions"])

    def test_the_loop_plays_reads_and_tests_the_game_and_says_execute_gdscript_is_the_editors(self):
        self.assertIn("run_project -> play it with game_input, look with game_state, screenshot(target=game) and "
                      "get_output -> fix -> write a test in res://tests/ and run_playtest -> stop", server.MCP_INSTRUCTIONS)
        self.assertIn("it does not reach the running game, which game_state reads", server.MCP_INSTRUCTIONS)

    def test_a_result_carries_every_picture_it_has_in_order(self):
        server.TOOL_MAP["probe"] = (lambda a, ctx: {"n": 2, "_images": [("AAA", "image/png"), ("BBB", "image/png")]}, "", {})
        try:
            got = server.mcp_call("probe", {}, {})
        finally:
            del server.TOOL_MAP["probe"]
        self.assertEqual(got["content"][1:], [{"type": "image", "data": "AAA", "mimeType": "image/png"},
                                              {"type": "image", "data": "BBB", "mimeType": "image/png"}])
        self.assertEqual(json.loads(got["content"][0]["text"]), {"n": 2})


class GameTools(unittest.TestCase):
    def test_with_no_game_running_they_say_so_in_one_sentence_and_name_run_project(self):
        with Patched(bridge=lambda cmd, args=None, **k: {"playing": False}, playing=lambda: False):
            for name, args in (("game_input", {"action": "jump"}), ("game_state", {})):
                got = call(name, args)
                self.assertTrue(got["isError"])
                self.assertEqual(got["content"][0]["text"], "No game is running; start one with run_project (or run_scene).")

    def test_a_game_window_the_editor_did_not_start_is_said_with_what_still_works(self):
        with Patched(bridge=lambda cmd, args=None, **k: {"playing": False}, playing=lambda: True):
            text = call("game_state", {})["content"][0]["text"]
        self.assertIn("the editor did not start it", text)
        self.assertIn("screenshot(target=game) and get_output still work", text)
        self.assertIn("run_project", text)

    def test_game_input_takes_one_input(self):
        for args in ({}, {"action": "jump", "key": "Space"}):
            with self.subTest(args=args):
                got = call("game_input", args)
                self.assertTrue(got["isError"])
                self.assertEqual(got["content"][0]["text"], "give one of action (preferred), key or mouse")

    def test_the_game_gets_the_call_with_time_for_the_hold_and_its_errors_come_back(self):
        seen = []

        def bridge(cmd, args=None, timeout=60, **k):
            seen.append((cmd, args, timeout))
            if cmd == "ping":
                return {"playing": True}
            server.EDITOR_OUT.add("SCRIPT ERROR: Invalid access to property 'y' on a base object of type 'Nil'.")
            server.EDITOR_OUT.add("   at: Player._physics_process (res://player.gd:12)")
            return {"sent": "tap jump", "pressed_frame": 120, "released_frame": 150, "frames_held": 30}

        with Patched(bridge=bridge):
            got = call("game_input", {"action": "jump", "frames": 30})
        self.assertFalse(got["isError"])
        self.assertEqual(seen[1], ("game", {"op": "input", "args": {"action": "jump", "frames": 30}, "timeout": 16}, 31))
        self.assertEqual(json.loads(got["content"][0]["text"]), {
            "sent": "tap jump", "pressed_frame": 120, "released_frame": 150, "frames_held": 30,
            "game_errors": ["SCRIPT ERROR: Invalid access to property 'y' on a base object of type 'Nil'.",
                            "   at: Player._physics_process (res://player.gd:12)"]})

    def test_game_state_takes_one_expression_as_a_list_and_its_frame_is_a_picture(self):
        seen = []

        def bridge(cmd, args=None, timeout=60, **k):
            seen.append((cmd, args))
            if cmd == "ping":
                return {"playing": True}
            return {"frame": 300, "values": {"get_node(\"Player\").position": [100.5, 520]}, "png_base64": "iVBORw0K"}

        with Patched(bridge=bridge):
            got = call("game_state", {"expressions": "get_node(\"Player\").position", "image": True})
        self.assertEqual(seen[1][1]["args"]["expressions"], ["get_node(\"Player\").position"])
        self.assertEqual(json.loads(got["content"][0]["text"]), {"frame": 300, "values": {"get_node(\"Player\").position": [100.5, 520]}})
        self.assertEqual(got["content"][1], {"type": "image", "data": "iVBORw0K", "mimeType": "image/png"})


class Playtests(unittest.TestCase):
    def setUp(self):
        self.path = project("platformer", {
            "project.godot": "config_version=5\n",
            "tests/test_jump.gd": "extends PlayTest\n",
            "tests/helpers.gd": "extends RefCounted\n",
            "tests/more/test_coins.gd": "extends PlayTest\n",
            "player.gd": "extends CharacterBody2D\n",
        })

    def test_the_tests_folder_runs_its_test_files_and_a_file_runs_alone(self):
        self.assertEqual(server.playtest_files(None), ["res://tests/test_jump.gd", "res://tests/more/test_coins.gd"])
        self.assertEqual(server.playtest_files("res://tests/more"), ["res://tests/more/test_coins.gd"])
        self.assertEqual(server.playtest_files("tests/helpers.gd"), ["res://tests/helpers.gd"])

    def test_no_tests_says_how_to_write_one_and_nothing_outside_the_project_runs(self):
        with self.assertRaisesRegex(server.ToolError, r"^there is no res://levels; write a test first .*with write_file$"):
            server.playtest_files("res://levels")
        with self.assertRaisesRegex(server.ToolError, "outside the open project"):
            server.playtest_files("../other/tests")
        with self.assertRaisesRegex(server.ToolError, "not a GDScript file"):
            server.playtest_files("res://project.godot")

    def test_a_run_is_refused_before_it_starts_when_it_could_not_finish_or_its_rate_is_wrong(self):
        for args, said in (({"timeout": 600}, "timeout is between 1 and 280 seconds"),
                           ({"fps": 0}, "fps must be between 1 and 240"),
                           ({"mode": "fast"}, "mode must be headless or visible")):
            with self.subTest(args=args):
                got = call("run_playtest", args)
                self.assertTrue(got["isError"])
                self.assertEqual(got["content"][0]["text"], said)

    def test_a_headless_run_is_the_game_at_a_fixed_frame_rate_with_the_game_side_and_its_spec(self):
        bin_dir = tempfile.mkdtemp(prefix="fake-godot-")
        fake = os.path.join(bin_dir, "godot")
        with open(fake, "w") as f:
            f.write(textwrap.dedent(f"""\
                #!{sys.executable}
                import json, os, sys
                out = os.environ["GODOT_MCP_PLAYTEST"]
                spec = json.load(open(os.path.join(out, "spec.json")))
                json.dump({{"argv": sys.argv[1:], "spec": spec}}, open({os.path.join(bin_dir, "seen.json")!r}, "w"))
                print("Godot Engine v4.7.2.stable.official - https://godotengine.org")
                print("player ready")
                print("WARNING: Property not found: 'application/config/disable_project_settings_override'.")
                print("     at: get_setting_with_override (core/config/project_settings.cpp:435)")
                print("SCRIPT ERROR: Invalid call. Nonexistent function 'jumpp' in base 'CharacterBody2D'.")
                print("   at: Player._physics_process (res://player.gd:9)")
                print("coins: 1")
                events = [
                    {{"event": "start", "file": "res://tests/test_jump.gd", "test": "test_jump", "frame": 2}},
                    {{"event": "checkpoint", "file": "res://tests/test_jump.gd", "test": "test_jump", "name": "apex", "frame": 24}},
                    {{"event": "end", "file": "res://tests/test_jump.gd", "test": "test_jump", "passed": True, "frames": 40}},
                    {{"event": "start", "file": "res://tests/test_jump.gd", "test": "test_no_double_jump", "frame": 45}},
                    {{"event": "check", "file": "res://tests/test_jump.gd", "test": "test_no_double_jump", "line": 21, "message": "jumped twice"}},
                    {{"event": "end", "file": "res://tests/test_jump.gd", "test": "test_no_double_jump", "passed": False, "frames": 60}},
                    {{"event": "done"}},
                ]
                with open(os.path.join(out, "results.jsonl"), "w") as f:
                    f.write("".join(json.dumps(e) + "\\n" for e in events))
                """))
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IXUSR)
        with Patched(GODOT=fake):
            got = call("run_playtest", {"path": "res://tests/test_jump.gd", "fps": 30})
        self.assertFalse(got["isError"], got)
        with open(os.path.join(bin_dir, "seen.json")) as f:
            seen = json.load(f)
        self.assertEqual(seen["argv"], ["--headless", "--path", self.path, "--fixed-fps", "30", "-s",
                                        "res://addons/godot_mcp_bridge/game.gd"])
        self.assertEqual(seen["spec"], {"files": ["res://tests/test_jump.gd"], "test": "", "scene": ""})
        self.assertEqual(json.loads(got["content"][0]["text"]), {
            "passed": False, "mode": "headless", "fps": 30, "summary": "1 of 2 passed",
            "tests": [{"test": "test_jump.gd:test_jump", "passed": True, "frames": 40},
                      {"test": "test_jump.gd:test_no_double_jump", "passed": False,
                       "failures": [{"line": 21, "message": "jumped twice"}], "frames": 60}],
            "checkpoints": [{"test": "test_jump.gd:test_jump", "name": "apex", "frame": 24}],
            "note": "checkpoint pictures come with mode visible",
            "errors": ["SCRIPT ERROR: Invalid call. Nonexistent function 'jumpp' in base 'CharacterBody2D'.",
                       "   at: Player._physics_process (res://player.gd:9)"],
            "output": ["player ready", "coins: 1"]})
        self.assertEqual(os.listdir(server.TMP), [], "the run's folder is removed")

    def test_the_answer_says_what_never_finished_what_could_not_run_and_carries_the_pictures(self):
        out = tempfile.mkdtemp(prefix="playtest-")
        with open(os.path.join(out, "checkpoint-1.png"), "wb") as f:
            f.write(b"\x89PNG-1")
        events = [
            {"event": "error", "file": "res://tests/test_broken.gd", "line": 4, "message": "does not compile: Expected end of statement"},
            {"event": "start", "file": "res://tests/test_jump.gd", "test": "test_jump", "frame": 2},
            {"event": "checkpoint", "file": "res://tests/test_jump.gd", "test": "test_jump", "name": "start", "frame": 0, "image": "checkpoint-1.png"},
            {"event": "checkpoint", "file": "res://tests/test_jump.gd", "test": "test_jump", "name": "lost", "frame": 9, "image": "checkpoint-2.png"},
        ]
        res, images = server.playtest_report(events, out, [], "visible", 60, "timed out after 5 s")
        self.assertEqual(res["passed"], False)
        self.assertEqual(res["summary"], "0 of 2 passed; timed out after 5 s")
        self.assertEqual(res["tests"], [
            {"test": "test_broken.gd", "passed": False, "failures": [{"line": 4, "message": "does not compile: Expected end of statement"}]},
            {"test": "test_jump.gd:test_jump", "passed": False, "failures": [{"line": 0, "message": "did not finish: timed out after 5 s"}]}])
        self.assertEqual(res["checkpoints"], [{"test": "test_jump.gd:test_jump", "name": "start", "frame": 0, "image": 1},
                                              {"test": "test_jump.gd:test_jump", "name": "lost", "frame": 9}])
        self.assertEqual(images, [("iVBORy0x", "image/png")])
        self.assertNotIn("note", res)

    def test_a_run_with_no_test_passes_nothing(self):
        res, _ = server.playtest_report([{"event": "done"}], tempfile.mkdtemp(), [], "headless", 60, "done")
        self.assertEqual((res["passed"], res["summary"]), (False, "0 of 0 passed"))

    def test_a_job_out_of_time_keeps_what_it_printed_when_asked_to(self):
        code, lines = server.run_job([sys.executable, "-u", "-c", "print('frame 1'); import time; time.sleep(30)"], 1,
                                     allow_timeout=True)
        self.assertEqual((code, lines), (None, ["frame 1"]))
        with self.assertRaisesRegex(server.ToolError, "did not finish within 1 s"):
            server.run_job([sys.executable, "-c", "import time; time.sleep(30)"], 1)


if __name__ == "__main__":
    unittest.main()
