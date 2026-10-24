"""The Blender server's own code, run with a stand-in for bpy: what does not need Blender to be told apart. How the
agent's code is run and told (execute_code), how a job of the HTTP threads is run on the main thread, where the log
goes, and that the tools it lists are the ones server/tools.json has. What needs Blender, its scenes and its frames, is
the image's to show (scripts/viewport-blender.py).

    python3 blender/test/server_test.py
"""
import importlib.util
import io
import json
import linecache
import os
import sys
import tempfile
import threading
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "server", "server.py")

# bpy and mathutils as far as the module needs them to load; nothing here asks more of them.
bpy = types.ModuleType("bpy")
bpy.app = types.SimpleNamespace(version_string="5.2.2", handlers=types.SimpleNamespace(persistent=lambda fn: fn))
sys.modules["bpy"] = bpy
sys.modules["mathutils"] = types.ModuleType("mathutils")
os.environ.update(BLENDER_SERVER_TOKEN="token", BLENDER_DATA_DIR=tempfile.mkdtemp(prefix="blender-server-test-"),
                  BLENDER_AUTO_PREVIEW="0")
spec = importlib.util.spec_from_file_location("server", SERVER)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def setUpModule():
    # What the server logs goes to the process's own output (see the last test): kept out of the tests' report.
    sys.__stdout__ = io.StringIO()


def tearDownModule():
    sys.__stdout__ = sys.stdout


def call(kind, **params):
    return server.handle({"token": "token", "type": kind, "params": params})


class ExecuteCode(unittest.TestCase):
    def setUp(self):
        server.set_project(None, dirty=False)

    def test_code_that_ends_itself_is_told_so_and_the_server_goes_on(self):
        for code, error in (("import sys\nsys.exit(0)", "SystemExit: 0"), ("import sys\nsys.exit()", "SystemExit"),
                            ("raise SystemExit('done')", "SystemExit: done"), ("raise KeyboardInterrupt", "KeyboardInterrupt"),
                            ("class Stop(BaseException):\n    pass\nraise Stop()", "Stop")):
            with self.subTest(code=code):
                answer = call("execute_code", code="print('before')\n" + code + "\nprint('after')")
                self.assertEqual(answer["status"], "error")
                self.assertIn("It printed, before the error:\nbefore", answer["message"])
                self.assertIn(error + "\n", answer["message"])
                self.assertTrue(answer["message"].endswith("what came after it did not run. Blender keeps running.)"), answer["message"])
                self.assertNotIn("after\n", answer["message"])
                self.assertTrue(server.STATE["project"]["dirty"], "what ran before it is in the scene")

    def test_a_job_that_raises_systemexit_does_not_end_the_main_loop(self):
        box = {}
        asker = threading.Thread(target=lambda: box.update(server.run_on_main(lambda: sys.exit(3), timeout=10)))
        asker.start()
        while asker.is_alive():
            server.drain_jobs()   # raises, as Blender's main loop would, if the job let SystemExit through
            asker.join(0.01)
        self.assertEqual(box, {"error": "SystemExit: 3"})

    def test_what_a_script_raises_names_its_file_and_line_and_its_text_is_not_kept(self):
        answer = call("execute_code", code="x = 1\nraise ValueError(x)\n", script_name="scripts/broken.py")
        self.assertIn('File "scripts/broken.py", line 2, in <module>\n    raise ValueError(x)\nValueError: 1', answer["message"])
        self.assertEqual(call("execute_code", code="print(2)\n", script_name="scripts/fine.py")["status"], "success")
        call("execute_code", code="print(3)\n")
        kept = [name for name in ("scripts/broken.py", "scripts/fine.py", "<request>") if name in linecache.cache]
        self.assertEqual(kept, [], "another chat's code could read these")

    def test_a_call_refused_before_any_code_ran_changes_nothing(self):
        for params in ({}, {"code": "print(1)", "args": [1]}, {"code": "def (:"}):
            with self.subTest(params=params):
                self.assertEqual(call("execute_code", **params)["status"], "error")
                self.assertFalse(server.STATE["project"]["dirty"], "nothing ran: the project is as it was")
        answer = call("execute_code", code="def (:", script_name="scripts/typo.py")
        self.assertIn('File "scripts/typo.py", line 1', answer["message"])
        self.assertEqual(call("execute_code", code="raise ValueError('half way')")["status"], "error")
        self.assertTrue(server.STATE["project"]["dirty"], "code that ran and failed may have changed the scene")

    def test_the_log_goes_to_the_container_log_also_while_the_code_runs(self):
        # refresh_view() here logs that the scene could not be summarized, there being no scene: from inside the code.
        answer = call("execute_code", code="refresh_view()\nprint('the code')")
        self.assertEqual(answer["result"], {"output": "the code\n"})
        self.assertIn("scene summary failed", sys.__stdout__.getvalue())
        self.assertTrue(any("scene summary failed" in line for line in server.STATE["log"]), "and to the viewer's log")


class Tools(unittest.TestCase):
    def test_the_server_lists_the_tools_and_instructions_server_tools_json_has(self):
        with open(os.path.join(HERE, "..", "server", "tools.json"), encoding="utf8") as f:
            kept = json.load(f)
        listed = server.mcp_dispatch({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]
        self.assertEqual(listed, kept["tools"])
        self.assertEqual(server.MCP_INSTRUCTIONS, kept["instructions"])


if __name__ == "__main__":
    unittest.main()
