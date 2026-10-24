#!/usr/bin/env python3
"""The Blender image's live-view test, as the release runs it after the smoke test: the image started with no network
at all and no GPU, asked from inside the container (curl), as nothing else reaches it. The person's view must follow
what the agent's code does to the scene, whatever that is:

- code that deletes every object (the viewport's own camera with them), removes the viewport's own scene, or loads the
  factory settings: the frame after it, the refresh after the edit and a Save still work, and the log never says a
  datablock "has been removed";
- code that fails half way: the view is refreshed with what it did before the error;
- a long script that calls refresh_view() between its steps: a frame is made while it runs, and the server says it is
  busy, and since when, by its own clock.

Then the container is removed.
    scripts/viewport-blender.py <image>        VIEWPORT_NAME (default blender-viewport) names the container
"""
import json
import os
import secrets
import subprocess
import sys
import threading
import time

IMAGE = sys.argv[1]
NAME = os.environ.get("VIEWPORT_NAME", "blender-viewport")
PORT = 3870
TOKEN = secrets.token_hex(24)
VIEW = {"coords": "blender", "position": [8, -8, 6], "target": [0, 0, 0], "fov": 40, "aspect": 16 / 9, "shading": "SOLID",
        "samples": 1, "width": 320, "full_width": 320, "rest_samples": 1}


def ts():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def step(text):
    print(f"{ts()} {text}", flush=True)


def fail(text):
    print(subprocess.run(["docker", "logs", "--tail", "40", NAME], capture_output=True, text=True).stdout)
    sys.exit(f"{ts()} {text}")


def curl(path, body=None, out_status=False):
    """One request from inside the container, with the token: its body, or its status and type."""
    args = ["docker", "exec", NAME, "curl", "-s", "-H", f"Authorization: Bearer {TOKEN}", "-H", "Content-Type: application/json"]
    if out_status:
        args += ["-o", "/dev/null", "-w", "%{http_code} %{content_type}"]
    if body is not None:
        args += ["--data-binary", json.dumps(body)]
    return subprocess.run(args + [f"http://127.0.0.1:{PORT}{path}"], capture_output=True, text=True).stdout


def call(tool, arguments):
    """A tool's call through MCP, as the portal makes it: its text, and whether it is an error."""
    answer = curl("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": arguments}})
    result = json.loads(answer)["result"]
    return "\n".join(p.get("text", "") for p in result["content"]), result["isError"]


def state():
    return json.loads(curl("/api/state"))


def frame(why):
    got = curl("/api/viewport", VIEW, out_status=True)
    if got != "200 image/jpeg":
        fail(f"the viewer's frame {why} answered {got}")


def run(code, why, error=False):
    """execute_code, which must refresh the view after it: a frame newer than the one before."""
    before = state()["viewport_at"]
    text, failed = call("execute_code", {"code": code})
    if failed != error:
        fail(f"execute_code {why}: {'it did not fail' if error else 'it failed'}: {text}")
    if not state()["viewport_at"] > before:
        fail(f"the view was not refreshed after the code {why}")
    frame(f"after the code {why}")
    step(f"the view follows the code {why}")


try:
    step(f"starting {IMAGE} as {NAME}, with no network")
    subprocess.run(["docker", "run", "-d", "--name", NAME, "--network", "none", "-e", f"BLENDER_SERVER_TOKEN={TOKEN}",
                    "-e", f"BLENDER_SERVER_PORT={PORT}", IMAGE], check=True, capture_output=True)
    step("waiting for MCP to answer ping")
    for _ in range(120):
        if '"result"' in curl("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "ping"}):
            break
        time.sleep(1)
    else:
        fail("MCP did not answer in 120 s")

    frame("as the person first looks")
    call("execute_code", {"code": "bpy.ops.mesh.primitive_cube_add()"})
    run("for o in list(bpy.data.objects):\n    bpy.data.objects.remove(o)\nbpy.ops.mesh.primitive_cube_add()",
        "that deletes every object, the viewport's camera with them")
    run('bpy.data.scenes.remove(bpy.data.scenes["__viewport"])\nbpy.ops.mesh.primitive_uv_sphere_add()',
        "that removes the viewport's own scene")
    run("bpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()",
        "that loads the factory settings")
    run("bpy.ops.mesh.primitive_monkey_add()\nraise RuntimeError('half way')", "that fails half way", error=True)

    before = state()["viewport_at"]
    busy = {}

    def long_script():
        busy["text"], busy["failed"] = call("execute_code", {"code": "import time\nbpy.ops.mesh.primitive_cube_add(location=(3, 0, 0))\nrefresh_view()\ntime.sleep(4)"})

    worker = threading.Thread(target=long_script)
    worker.start()
    time.sleep(2)
    during = state()
    worker.join()
    if busy.get("failed"):
        fail(f"the long script failed: {busy.get('text')}")
    if during["busy"] != "execute_code" or not 0 < during["now"] - during["busy_at"] < 10:
        fail(f"while the script ran, the server said busy={during['busy']!r} since {during.get('busy_at')} (now {during.get('now')})")
    if not during["viewport_at"] > before:
        fail("refresh_view() made no frame while the script ran")
    step("a long script's refresh_view() shows the scene while it runs, and the server says it is busy")

    text, failed = call("save_file", {"path": "scenes/viewport-test.blend"})
    if failed:
        fail(f"Save failed: {text}")
    text, _ = call("execute_code", {"code": "print(sorted(s.name for s in bpy.data.scenes))", "read_only": True})
    if "__viewport" in text:
        fail(f"the viewport's own scene is still there after a save: {text}")
    frame("after the save")
    step("Save works, and leaves the viewport's own scene out of the project")

    log = subprocess.run(["docker", "logs", NAME], capture_output=True, text=True)
    if "has been removed" in log.stdout + log.stderr:
        fail("the log says a datablock the server kept had been removed")
    step(f"DONE: the live view of {IMAGE} follows what the agent's code does")
finally:
    subprocess.run(["docker", "rm", "-f", NAME], capture_output=True)
