#!/usr/bin/env python3
"""The Blender image's live-view test, as the release runs it after the smoke test: the image started with no network
at all and no GPU, asked from inside the container (curl), as nothing else reaches it. The person's view must follow
what the agent's code does to the scene, whatever that is:

- code that deletes every object (the viewport's own camera with them), removes the viewport's own scene, or loads the
  factory settings: the frame after it, the refresh after the edit and a Save still work, and the log never says a
  datablock "has been removed";
- code that removes the scenes after the first, the person's only scene, or the scene it is in after making another:
  the view, the scene the agent is told of and a Save are the person's scene, with what the code made after;
- code that fails half way: the view is refreshed with what it did before the error; code that calls sys.exit(): the
  same, and Blender keeps running, with the scene;
- a save the code makes itself, a project that cannot be opened, and a project an older server saved with its
  viewport in it: no project keeps the viewport's scene or camera, and there is never a second of them;
- code that takes the first camera there is: it is the person's, not the viewport's;
- a long script that calls refresh_view() between its steps: a frame is made while it runs, and the server says it is
  busy, and since when, by its own clock;
- every frame says when it was made, by the server's clock (X-Viewport-At), as the state it is made by says;
- a call with no code changes nothing: the project stays saved and the view is not made again.

Then the container is removed, with its log printed first where the test did not get to its end.
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
# Lists the viewport's datablocks there are, the server's own and any other: there must be one scene and one camera.
VIEWPORTS = ("import json\nprint(json.dumps(sorted(d.name for d in [*bpy.data.scenes, *bpy.data.objects] "
             "if d.name.startswith(('~viewport', '__viewport')))))")


def ts():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def step(text):
    print(f"{ts()} {text}", flush=True)


def fail(text):
    sys.exit(f"{ts()} {text}")   # the log is printed on the way out (see the end)


def curl(path, body=None, write_out=None):
    """One request from inside the container, with the token: its body, or what `write_out` asks curl for."""
    args = ["docker", "exec", NAME, "curl", "-s", "-H", f"Authorization: Bearer {TOKEN}", "-H", "Content-Type: application/json"]
    if write_out:
        args += ["-o", "/dev/null", "-w", write_out]
    if body is not None:
        args += ["--data-binary", json.dumps(body)]
    return subprocess.run(args + [f"http://127.0.0.1:{PORT}{path}"], capture_output=True, text=True).stdout


def answer(path, body=None):
    """A request's JSON, or the test fails, with the log, where the server gave none (it ended, or answered otherwise)."""
    text = curl(path, body)
    try:
        return json.loads(text)
    except ValueError:
        fail(f"{path} answered no JSON: {text[:400]!r}")


def call(tool, arguments):
    """A tool's call through MCP, as the portal makes it: its text, and whether it is an error."""
    reply = answer("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": arguments}})
    if "result" not in reply:
        fail(f"{tool} answered no result: {reply}")
    result = reply["result"]
    return "\n".join(p.get("text", "") for p in result["content"]), result["isError"]


def state():
    return answer("/api/state")


def frame(why):
    """A frame of the viewer's: a JPEG, which says it was made after the last, by the server's clock, as its state does."""
    before = state()["viewport_at"]
    got = curl("/api/viewport", VIEW, write_out="%{http_code} %{content_type} %header{x-viewport-at}").split()
    if got[:2] != ["200", "image/jpeg"]:
        fail(f"the viewer's frame {why} answered {got}")
    at = float(got[2]) if len(got) > 2 else 0
    if not (at > before and at == state()["viewport_at"]):
        fail(f"the viewer's frame {why} says it was made at {got[2:]}, the state says {state()['viewport_at']}, before {before}")


def run(code, why, error=False):
    """execute_code, which must refresh the view after it: a frame newer than the one before. Its text."""
    before = state()["viewport_at"]
    text, failed = call("execute_code", {"code": code})
    if failed != error:
        fail(f"execute_code {why}: {'it did not fail' if error else 'it failed'}: {text}")
    if not state()["viewport_at"] > before:
        fail(f"the view was not refreshed after the code {why}")
    frame(f"after the code {why}")
    step(f"the view follows the code {why}")
    return text


def scene():
    """The scene the agent is told of: its name and its objects' names."""
    text, failed = call("get_scene_info", {})
    if failed:
        fail(f"get_scene_info failed: {text}")
    info = json.loads(text)
    return info["name"], sorted(o["name"] for o in info["objects"])


def viewports(why):
    """There is one scene and one camera of the viewport's, the server's own, and nothing of one a file came with."""
    text, failed = call("execute_code", {"code": VIEWPORTS, "read_only": True})
    if failed or json.loads(text) != ["~viewport", "~viewport_cam"]:
        fail(f"{why}, the viewport's datablocks are {text}")


done = False
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
    run('bpy.data.scenes.remove(bpy.data.scenes["~viewport"])\nbpy.ops.mesh.primitive_uv_sphere_add()',
        "that removes the viewport's own scene")
    run("bpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()",
        "that loads the factory settings")
    run("bpy.ops.mesh.primitive_monkey_add()\nraise RuntimeError('half way')", "that fails half way", error=True)

    run("for s in list(bpy.data.scenes)[1:]:\n    bpy.data.scenes.remove(s)", "that removes every scene after the first")
    if scene()[0] != "Scene":
        fail(f"after the code that removes every scene after the first, the scene is {scene()}")
    run('bpy.data.scenes.remove(bpy.data.scenes["Scene"])\nbpy.ops.mesh.primitive_cylinder_add()',
        "that removes the person's only scene")
    name, objects = scene()
    if name != "Scene" or "Cylinder" not in objects or any(o.startswith("~") for o in objects):
        fail(f"after the code that removes the person's only scene, the scene is {name} with {objects}")
    run('bpy.data.scenes.new("Studio")\nbpy.data.scenes.remove(bpy.data.scenes["Scene"])\nbpy.ops.mesh.primitive_cone_add()',
        "that makes a scene and removes the one it was in")
    name, objects = scene()
    if name != "Studio" or "Cone" not in objects:
        fail(f"after the code that makes a scene and removes the one it was in, the scene is {name} with {objects}")
    viewports("after the code that removes scenes")
    step("the scene the agent is told of is the person's, with what the code made after removing scenes")

    text = run("bpy.ops.mesh.primitive_torus_add()\nimport sys\nsys.exit(0)", "that calls sys.exit()", error=True)
    if "SystemExit: 0" not in text or "Blender keeps running" not in text:
        fail(f"sys.exit() was told as {text!r}")
    running = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}} {{.RestartCount}}", NAME], capture_output=True, text=True).stdout.split()
    if running != ["true", "0"] or "Torus" not in scene()[1]:
        fail(f"after sys.exit() the container is {running} and the scene has {scene()[1]}")
    step("code that calls sys.exit() is told it did, and Blender keeps running, with the scene")

    run('import os\nos.makedirs("/data/scenes", exist_ok=True)\nbpy.ops.wm.save_as_mainfile(filepath="/data/scenes/direct.blend")',
        "that saves the project itself")
    # What the file has, read from a copy of it without opening it (Blender reads no datablocks from the open file).
    text, failed = call("execute_code", {"code": "import shutil\nshutil.copy('/data/scenes/direct.blend', '/data/scenes/direct-copy.blend')\n"
                                                 "with bpy.data.libraries.load('/data/scenes/direct-copy.blend') as (found, _):\n"
                                                 "    print(sorted(found.scenes), sorted(found.objects))", "read_only": True})
    if failed or "viewport" in text:
        fail(f"the project the code saved holds {text}")
    text, failed = call("open_file", {"path": "scenes/direct.blend"})
    if failed:
        fail(f"the project the code saved does not open: {text}")
    viewports("in the project the code saved, opened")
    text, failed = call("open_file", {"path": "scenes/no-such.blend"})
    if not failed:
        fail("a project that is not there opened")
    frame("after a project that cannot be opened")
    viewports("after a project that cannot be opened")
    run("old = bpy.data.scenes.new('__viewport')\ncam = bpy.data.objects.new('__viewport_cam', bpy.data.cameras.new('__viewport_cam'))\n"
        "old.collection.objects.link(cam)\nbpy.ops.wm.save_as_mainfile(filepath='/data/scenes/older.blend')",
        "that saves a project as an older server left one, with its viewport in it")
    text, failed = call("open_file", {"path": "scenes/older.blend"})
    if failed:
        fail(f"the project with an older viewport in it does not open: {text}")
    frame("after the project with an older viewport in it is opened")
    viewports("in the project with an older viewport in it, opened")
    step("no project keeps the viewport's scene or camera: one saved by the code, one that cannot be opened, an older one")

    text, failed = call("execute_code", {"code": "bpy.ops.object.camera_add()\nprint([o.name for o in bpy.data.objects if o.type == 'CAMERA'][0])"})
    if failed or text.strip() != "Camera":
        fail(f"the first camera there is, is {text!r}")
    step("the first camera there is, is the person's")

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
    if "viewport" in text:
        fail(f"the viewport's own scene is still there after a save: {text}")
    frame("after the save")
    step("Save works, and leaves the viewport's own scene out of the project")

    before = state()
    text, failed = call("execute_code", {})
    after = state()
    if not failed or after["project"]["dirty"] or after["viewport_at"] != before["viewport_at"]:
        fail(f"a call with no code answered {text!r}, and the project is {after['project']}, the view made at {after['viewport_at']} (before {before['viewport_at']})")
    step("a call with no code changes nothing: the project stays saved, and the view is not made again")

    log = subprocess.run(["docker", "logs", NAME], capture_output=True, text=True)
    if "has been removed" in log.stdout + log.stderr:
        fail("the log says a datablock the server kept had been removed")
    step(f"DONE: the live view of {IMAGE} follows what the agent's code does")
    done = True
finally:
    if not done:
        print(subprocess.run(["docker", "logs", "--tail", "80", NAME], capture_output=True, text=True).stdout)
    subprocess.run(["docker", "rm", "-f", NAME], capture_output=True)
