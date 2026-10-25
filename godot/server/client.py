#!/usr/bin/env python3
"""Client and end-to-end test for the Godot server's MCP endpoint (standard library only).

    python3 client.py tools                                    list the tools and their arguments
    python3 client.py call ping
    python3 client.py call add_node '{"type": "Sprite2D", "name": "Hero"}'
    python3 client.py call screenshot '{"target": "game"}' --save game.png
    python3 client.py e2e [--name coin-chase] [--out DIR]      build a small 2D game through MCP alone and check
                                                               every tool on the way
    python3 client.py gametest [--name platformer] [--out DIR] build a small platformer, play it (game_input,
                                                               game_state) and run passing and failing playtests,
                                                               headless and visible

The server comes from GODOT_SERVER_URL (default http://127.0.0.1:3880) and the token from GODOT_SERVER_TOKEN, or
--url / --token. The server is on a network of its own, which only the Pithagoras portal reaches, so run this where
the portal does: on the host, against the forwarder's 127.0.0.1:3880, for a portal on the host's network; in the
portal's container, with --url http://pithagoras-godot:3880, for a portal in a container of its own. The token is
the one the Godot extension keeps in its settings.json.
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request


class MCP:
    def __init__(self, url, token, timeout=900):
        self.url = url.rstrip("/") + ("" if url.rstrip("/").endswith("/mcp") else "/mcp")
        self.token, self.timeout, self.n = token, timeout, 0

    def rpc(self, method, params=None):
        self.n += 1
        body = json.dumps({"jsonrpc": "2.0", "id": str(self.n), "method": method, "params": params or {}}).encode()
        req = urllib.request.Request(self.url, body, {"Content-Type": "application/json",
                                                      "Accept": "application/json, text/event-stream",
                                                      "Authorization": f"Bearer {self.token}"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            msg = json.loads(r.read())
        if "error" in msg:
            raise RuntimeError(f"{method}: {msg['error'].get('message')}")
        return msg["result"]

    def call(self, tool, args=None):
        """(ok, parsed text result or error text, [(base64, mime)] images)"""
        res = self.rpc("tools/call", {"name": tool, "arguments": args or {}})
        text = "\n".join(c["text"] for c in res["content"] if c["type"] == "text")
        images = [(c["data"], c["mimeType"]) for c in res["content"] if c["type"] == "image"]
        try:
            text = json.loads(text)
        except ValueError:
            pass
        return not res.get("isError"), text, images


def save_image(images, path):
    if images:
        with open(path, "wb") as f:
            f.write(base64.b64decode(images[0][0]))
        return path
    return None


# ---- end-to-end -------------------------------------------------------------------------------------------------

PLAYER_GD = '''extends Area2D
## The player: moves with the arrow keys and stays on screen.

const SPEED := 420.0


func _process(delta: float) -> void:
	var dir := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	position += dir * SPEED * delta
	position = position.clamp(Vector2(40, 40), get_viewport_rect().size - Vector2(40, 40))
'''

MAIN_GD = '''extends Node2D
## Touch the goal to score a point; the goal then jumps somewhere else.

var score := 0

@onready var goal: Area2D = $Goal
@onready var label: Label = $ScoreLabel


func _ready() -> void:
	goal.area_entered.connect(_on_goal_reached)
	print("coin chase ready")


func _process(delta: float) -> void:
	goal.rotation += 2.0 * delta


func _on_goal_reached(_area: Area2D) -> void:
	score += 1
	label.text = "Score: %d" % score
	print("score ", score)
	var view := get_viewport_rect().size
	goal.position = Vector2(randf_range(80, view.x - 80), randf_range(110, view.y - 80))
'''

BROKEN_GD = '''extends Node

func _ready() -> void:
	var count: int = "three"
	print(undefined_thing)
'''

HALTS_GD = '''extends Node2D

func _ready() -> void:
	print("this never prints")
	var speed: float = "fast"
'''


PLATFORMER_PLAYER_GD = '''extends CharacterBody2D
## Runs with move_left / move_right and jumps with jump, on the floor only.

const SPEED := 300.0
const JUMP_VELOCITY := -450.0

var gravity: float = ProjectSettings.get_setting("physics/2d/default_gravity")
var jumps := 0
var last_jump_frame := -1


func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y += gravity * delta
	if Input.is_action_just_pressed("jump") and is_on_floor():
		velocity.y = JUMP_VELOCITY
		jumps += 1
		last_jump_frame = Engine.get_physics_frames()
	velocity.x = Input.get_axis("move_left", "move_right") * SPEED
	move_and_slide()
'''

PLATFORMER_MAIN_GD = '''extends Node2D
## A coin for a point, and a bonus button worth ten.

var score := 0

@onready var label: Label = $ScoreLabel


func _ready() -> void:
	$Coin.body_entered.connect(_on_coin)
	$Bonus.pressed.connect(_add.bind(10))


func _on_coin(body: Node) -> void:
	if body.name == "Player":
		_add(1)
		$Coin.queue_free()


func _add(points: int) -> void:
	score += points
	label.text = "Score: %d" % score
'''

PLATFORMER_INPUT_GD = '''for a in [["move_left", KEY_LEFT], ["move_right", KEY_RIGHT], ["jump", KEY_SPACE]]:
	var ev := InputEventKey.new()
	ev.physical_keycode = a[1]
	ProjectSettings.set_setting("input/" + a[0], {"deadzone": 0.2, "events": [ev]})
ProjectSettings.save()
return InputMap.has_action("jump") or ProjectSettings.has_setting("input/jump")'''

TEST_PLATFORMER_GD = '''extends PlayTest


func test_walks_right() -> void:
	var player := node("Player")
	await wait_frames(20)
	var x: float = player.position.x
	await press("move_right", 60)
	print("walked from ", x, " to ", player.position.x, " by frame ", frame)
	check(player.position.x > x + 250, "the player walks right (from %s to %s)" % [x, player.position.x])


func test_jumps_once() -> void:
	var player := node("Player")
	await wait_frames(20)
	var y: float = player.position.y
	await press("jump")
	await wait_frames(12)
	checkpoint("in the air")
	check(player.position.y < y - 40, "the player rises (from %s to %s)" % [y, player.position.y])
	await press("jump")
	await wait_until(func(): return player.is_on_floor(), 120)
	check_eq(player.jumps, 1, "no jump in the air")


func test_coin_scores() -> void:
	await hold("move_right")
	var scored := await wait_until(func(): return node("ScoreLabel").text == "Score: 1", 120)
	await release("move_right")
	checkpoint("coin taken")
	check(scored, "touching the coin scores a point")
'''

TEST_FAILING_GD = '''extends PlayTest


func test_wrong_score() -> void:
	await wait_frames(5)
	check_eq(node("ScoreLabel").text, "Score: 99", "the score at the start")


func test_script_error() -> void:
	await wait_frames(3)
	var player := node("Player")
	player.fly_away()
	check(false, "never reached")
'''


class E2E:
    def __init__(self, mcp, out):
        self.mcp, self.out, self.results = mcp, out, []
        os.makedirs(out, exist_ok=True)

    def step(self, tool, args=None, check=None, save=None, expect_error=False):
        t0 = time.time()
        try:
            ok, res, images = self.mcp.call(tool, args)
        except Exception as e:
            ok, res, images = False, f"{type(e).__name__}: {e}", []
        ms = int((time.time() - t0) * 1000)
        problem = None
        if expect_error:
            problem = "expected an error" if ok else (check(res) if check else None)
        elif not ok:
            problem = str(res)[:400]
        elif check:
            try:
                problem = check(res)
            except Exception as e:
                problem = f"check raised {type(e).__name__}: {e}"
        saved = save_image(images, os.path.join(self.out, save)) if save else None
        status = "ok" if problem is None else "FAIL"
        brief = json.dumps(res)[:150] if not isinstance(res, str) else res[:150]
        print(f"{time.strftime('%H:%M:%S')} {status:4} {tool:17} {ms:6} ms  {brief}"
              + (f"\n{'':32}-> {problem}" if problem else "") + (f"\n{'':32}saved {saved}" if saved else ""), flush=True)
        self.results.append({"tool": tool, "ok": problem is None, "ms": ms, "problem": problem, "saved": saved})
        return res

    def run(self, name, switch=True):
        S = self.step
        S("ping", check=lambda r: None if r["gpu"] and "uuid" in r["gpu"][0] else "no GPU reported")
        projects = S("list_projects")
        existing = {p["name"] for p in projects.get("projects", [])} if isinstance(projects, dict) else set()
        base, i = name, 2
        while name in existing:
            name, i = f"{base}-{i}", i + 1
        previous = projects.get("open") if isinstance(projects, dict) else None
        S("new_project", {"name": name, "template": "2d"},
          check=lambda r: None if r["opened"]["project"] == name else "did not open")
        S("ping", check=lambda r: None if r.get("editor_info", {}).get("rendering_method") == "gl_compatibility"
          and "NVIDIA" in r["editor_info"].get("adapter", "") else f"unexpected renderer/adapter {r.get('editor_info')}")
        S("new_scene", {"path": "res://title.tscn", "root_type": "Control", "root_name": "Title"},
          check=lambda r: None if r["scene"] == "res://title.tscn" else "wrong scene")
        S("add_node", {"type": "Label", "name": "Heading", "properties": {
            "text": "COIN CHASE\nArrow keys to move, touch the green coin",
            "position": [380, 260], "theme_override_font_sizes/font_size": 34,
            "horizontal_alignment": 1}})
        S("save_scene")
        S("run_scene", {"path": "res://title.tscn"}, check=lambda r: None if r["playing"] else "not playing")
        time.sleep(2)
        S("screenshot", {"target": "game"}, save="title-game.png")
        S("stop", check=lambda r: None if not r["playing"] else "still playing")

        S("open_scene", {"path": "res://main.tscn"})
        S("write_file", {"path": "res://player.gd", "content": PLAYER_GD})
        S("add_node", {"type": "Area2D", "name": "Player", "properties": {"position": [200, 324]}},
          check=lambda r: None if r["path"] == "Player" else f"path {r['path']}")
        S("add_node", {"type": "Sprite2D", "name": "Sprite", "parent": "Player",
                       "properties": {"texture": "res://icon.svg", "scale": [0.6, 0.6]}})
        S("add_node", {"type": "CollisionShape2D", "name": "Hitbox", "parent": "Player",
                       "properties": {"shape": {"type": "CircleShape2D", "radius": 36}}})
        S("attach_script", {"node": "Player", "path": "res://player.gd"},
          check=lambda r: None if r["compiles"] else "player.gd does not compile")
        S("add_node", {"type": "Area2D", "name": "Goal", "properties": {"position": [900, 324]}})
        S("add_node", {"type": "Sprite2D", "name": "Coin", "parent": "Goal",
                       "properties": {"texture": "res://icon.svg", "modulate": "#3ddc84", "scale": [0.45, 0.45]}})
        S("add_node", {"type": "CollisionShape2D", "name": "Hitbox", "parent": "Goal",
                       "properties": {"shape": {"type": "CircleShape2D", "radius": 28}}})
        S("add_node", {"type": "Label", "name": "ScoreLabel", "properties": {
            "text": "Score: 0", "position": [24, 16], "theme_override_font_sizes/font_size": 36}})
        S("add_node", {"type": "Node2D", "name": "Temp"})
        S("delete_node", {"node": "Temp"})
        S("set_property", {"node": "Goal/Coin", "properties": {"rotation_degrees": 15, "self_modulate": [1, 1, 1, 1]}},
          check=lambda r: None if abs(r["values"]["rotation_degrees"] - 15) < 1e-3 else "rotation not set")
        S("set_property", {"node": "ScoreLabel", "property": "modulate", "value": "#ffe066"})
        S("attach_script", {"node": ".", "path": "res://main.gd", "source": MAIN_GD},
          check=lambda r: None if r["compiles"] else "main.gd does not compile")
        S("save_scene", check=lambda r: None if r["saved"] == "res://main.tscn" else "not saved")
        S("get_scene_tree", check=lambda r: None if {c["name"] for c in r["root"].get("children", [])}
          == {"Player", "Goal", "ScoreLabel"} else f"unexpected children {[c['name'] for c in r['root'].get('children', [])]}")
        S("check_scripts", check=lambda r: None if r["failed"] == 0 and r["checked"] >= 2 else f"{r}")
        S("write_file", {"path": "res://broken.gd", "content": BROKEN_GD})
        S("check_scripts", {"paths": ["res://broken.gd"]},
          check=lambda r: None if r["failed"] == 1 and any("broken.gd:4" in e for e in r["results"][0]["errors"])
          else f"errors not reported: {r}")
        S("delete_file", {"path": "res://broken.gd"})
        S("list_files", check=lambda r: None if {"res://player.gd", "res://main.gd", "res://main.tscn"}
          <= {e["path"] for e in r["entries"]} and "res://broken.gd" not in {e["path"] for e in r["entries"]} else "missing files")
        S("list_files", {"recursive": False}, check=lambda r: None if "res://addons/" in {e["path"] for e in r["entries"]}
          and not any(e["path"].startswith("res://addons/godot") for e in r["entries"]) else f"{[e['path'] for e in r['entries']]}")

        # Edge cases: refused cleanly, with nothing changed and no dialog left in the editor.
        S("write_file", {"path": "res://bad.bin", "content_base64": "!!!not base64!!!"}, expect_error=True)
        S("add_node", {"type": "Node", "name": "EscapeProbe", "parent": ".."}, expect_error=True)
        S("open_scene", {"path": "res://icon.svg"}, expect_error=True)
        S("save_scene", {"path": "res://notascene.txt"}, expect_error=True)
        S("new_scene", {"path": "res://doomed.tscn", "root_type": "Node2D"})
        S("open_scene", {"path": "res://main.tscn"}, check=lambda r: None if r["scene"] == "res://main.tscn" else f"{r}")
        S("delete_file", {"path": "res://doomed.tscn"}, check=lambda r: None if r.get("closed_tab") else f"tab not closed: {r}")
        S("ping", check=lambda r: None if "res://doomed.tscn" not in r["editor_info"]["open_scenes"]
          and r["editor_info"]["edited_scene"] == "res://main.tscn" else f"{r['editor_info']}")
        S("get_scene_tree", check=lambda r: None if r["scene"] == "res://main.tscn" and {c["name"] for c in r["root"].get("children", [])}
          == {"Player", "Goal", "ScoreLabel"} else f"{r}")

        # A script error that stops the game in the editor's debugger is reported, not hidden.
        S("new_scene", {"path": "res://halts.tscn", "root_type": "Node2D"})
        S("attach_script", {"node": ".", "path": "res://halts.gd", "source": HALTS_GD},
          check=lambda r: None if not r["compiles"] else "halts.gd should not compile")
        S("save_scene")
        S("run_scene", {"path": "res://halts.tscn"}, check=lambda r: None if not r["playing"] and "halts.gd:5" in r.get("halted", "")
          and r["errors"] and r["errors"][0].startswith("halted in debugger") else f"{r}")
        S("get_output", check=lambda r: None if "halts.gd:5" in r.get("halted", "") and not r["playing"] else f"{r}")
        S("stop")
        S("open_scene", {"path": "res://main.tscn"})
        S("delete_file", {"path": "res://halts.tscn"}, check=lambda r: None if r.get("closed_tab") else f"{r}")
        S("delete_file", {"path": "res://halts.gd"})
        S("read_file", {"path": "res://player.gd"}, check=lambda r: None if r["content"] == PLAYER_GD else "content differs")
        S("read_file", {"path": "../../.state.json"}, expect_error=True)
        S("reload", check=lambda r: None if r["scanned"] else "no scan")
        S("execute_gdscript", {"code": 'print("nodes in main: ", scene_root.get_child_count())\n'
                                       'return {"children": scene_root.get_child_count(), "main": ProjectSettings.get_setting("application/run/main_scene")}'},
          check=lambda r: None if r["return"]["children"] == 3 and any("nodes in main: 3" in l for l in r["output"]) else f"{r}")
        S("screenshot", {"target": "editor"}, save="editor.png")
        S("screenshot", {"target": "2d", "max_width": 960}, save="editor-2d.png")
        run = S("run_project", check=lambda r: None if r["playing"] and not r["errors"] else f"{r}")
        time.sleep(2.5)
        S("screenshot", {"target": "game"}, save="game.png")
        S("screenshot", {"target": "screen"}, save="screen.png")
        mark = run.get("output_mark") if isinstance(run, dict) else None
        S("get_output", {"since": mark}, check=lambda r: None if any("coin chase ready" in l for l in r["lines"])
          and not any("SCRIPT ERROR" in l for l in r["lines"]) else f"{r['lines'][-10:]}")
        S("stop", check=lambda r: None if not r["playing"] else "still playing")
        S("record", {"seconds": 3, "fps": 30}, save="record-preview.jpg",
          check=lambda r: None if r["frames"] == 90 and r.get("bytes", 0) > 10000 else f"{r}")
        S("export", {"platform": "web"}, check=lambda r: None if r["folder"] == f"exports/{name}/web"
          and "index.wasm" in r["files"] and "url" not in r else f"{r}")
        S("export", {"platform": "linux"}, check=lambda r: None if f"{name}.x86_64" in r["files"] else f"{r}")
        S("read_file", {"path": "res://doomed.tscn"}, expect_error=True)   # the saves before export did not bring it back

        # Restarting the editor: gracefully while it answers, by force once it is stuck in an endless loop.
        S("restart_editor", check=lambda r: None if r["previous_editor"].startswith("saved") and r["project"] == name else f"{r}")
        S("get_scene_tree", check=lambda r: None if len(r["root"].get("children", [])) == 3 else "scene lost")
        S("execute_gdscript", {"code": "while true:\n\tpass", "timeout": 3}, expect_error=True)
        S("ping", check=lambda r: None if r["editor"] == "not answering" else f"editor {r['editor']}")
        S("restart_editor", check=lambda r: None if r["previous_editor"].startswith("killed") else f"{r}")
        S("get_scene_tree", check=lambda r: None if len(r["root"].get("children", [])) == 3 else "scene lost")
        if switch and previous and previous != name:
            S("open_project", {"name": previous}, check=lambda r: None if r["project"] == previous else "not switched")
            S("open_project", {"name": name}, check=lambda r: None if r["project"] == name else "not switched back")
            S("get_scene_tree", check=lambda r: None if len(r["root"].get("children", [])) == 3 else "scene lost")
        failed = [r for r in self.results if not r["ok"]]
        tools = sorted({r["tool"] for r in self.results})
        print(f"{time.strftime('%H:%M:%S')} DONE project={name} steps={len(self.results)} passed="
              f"{len(self.results) - len(failed)} failed={len(failed)} tools={len(tools)}")
        with open(os.path.join(self.out, "e2e-results.json"), "w") as f:
            json.dump({"project": name, "tools": tools, "results": self.results}, f, indent=1)
        return name, failed


def gametest(e, name):
    """The game-testing tools against a running server: a small platformer built through MCP, played with game_input
    and read with game_state, then playtests that pass and fail, headless and visible."""
    S = e.step
    S("ping")
    projects = S("list_projects")
    existing = {p["name"] for p in projects.get("projects", [])} if isinstance(projects, dict) else set()
    base, i = name, 2
    while name in existing:
        name, i = f"{base}-{i}", i + 1
    S("new_project", {"name": name, "template": "2d"}, check=lambda r: None if r["opened"]["project"] == name else "did not open")
    S("execute_gdscript", {"code": PLATFORMER_INPUT_GD})
    S("restart_editor", check=lambda r: None if r["project"] == name else f"{r}")   # the editor's InputMap from the saved settings
    S("open_scene", {"path": "res://main.tscn"})
    S("add_node", {"type": "CharacterBody2D", "name": "Player", "properties": {"position": [200, 480]}})
    S("add_node", {"type": "CollisionShape2D", "name": "Shape", "parent": "Player",
                   "properties": {"shape": {"type": "RectangleShape2D", "size": [40, 56]}}})
    S("add_node", {"type": "Sprite2D", "name": "Sprite", "parent": "Player",
                   "properties": {"texture": "res://icon.svg", "scale": [0.35, 0.45]}})
    S("attach_script", {"node": "Player", "path": "res://player.gd", "source": PLATFORMER_PLAYER_GD},
      check=lambda r: None if r["compiles"] else f"{r}")
    S("add_node", {"type": "StaticBody2D", "name": "Platform", "properties": {"position": [576, 560]}})
    S("add_node", {"type": "CollisionShape2D", "name": "Shape", "parent": "Platform",
                   "properties": {"shape": {"type": "RectangleShape2D", "size": [1100, 40]}}})
    S("add_node", {"type": "ColorRect", "name": "Look", "parent": "Platform",
                   "properties": {"position": [-550, -20], "size": [1100, 40], "color": "#4a7a3a"}})
    S("add_node", {"type": "Area2D", "name": "Coin", "properties": {"position": [460, 500]}})
    S("add_node", {"type": "CollisionShape2D", "name": "Shape", "parent": "Coin",
                   "properties": {"shape": {"type": "CircleShape2D", "radius": 18}}})
    S("add_node", {"type": "Sprite2D", "name": "Sprite", "parent": "Coin",
                   "properties": {"texture": "res://icon.svg", "scale": [0.25, 0.25], "modulate": "#ffd700"}})
    S("add_node", {"type": "Label", "name": "ScoreLabel", "properties": {"text": "Score: 0", "position": [24, 16],
                                                                         "theme_override_font_sizes/font_size": 32}})
    S("add_node", {"type": "Button", "name": "Bonus", "properties": {"text": "Bonus", "position": [960, 20],
                                                                     "size": [140, 48]}})
    S("attach_script", {"node": ".", "path": "res://main.gd", "source": PLATFORMER_MAIN_GD},
      check=lambda r: None if r["compiles"] else f"{r}")
    S("save_scene")
    S("check_scripts", check=lambda r: None if r["failed"] == 0 else f"{r}")

    # Nothing running: said in one sentence.
    S("game_state", expect_error=True,
      check=lambda t: None if t == "No game is running; start one with run_project (or run_scene)." else t)
    S("run_project", check=lambda r: None if r["playing"] and not r["errors"] else f"{r}")
    S("game_state", check=lambda r: None if {"Player", "Platform", "Coin", "ScoreLabel", "Bonus"}
      <= {n["path"] for n in r["nodes"]} else f"{r}")
    pos = "get_node(\"Player\").position"
    floor = S("game_state", {"expressions": [pos, "get_node(\"Player\").is_on_floor()", "get_node(\"ScoreLabel\").text"],
                             "wait_frames": 30},
              check=lambda r: None if r["values"]["get_node(\"Player\").is_on_floor()"] else f"{r}")
    x0 = floor["values"][pos][0] if isinstance(floor, dict) else 0
    S("game_input", {"action": "move_right", "frames": 60},
      check=lambda r: None if r["frames_held"] == 60 and r["released_frame"] - r["pressed_frame"] == 60 else f"{r}")
    S("game_state", {"expressions": [pos, "get_node(\"ScoreLabel\").text"]},
      check=lambda r: None if r["values"][pos][0] > x0 + 250 and r["values"]["get_node(\"ScoreLabel\").text"] == "Score: 1"
      else f"{r}")
    tap = S("game_input", {"action": "jump"}, check=lambda r: None if r["frames_held"] == 1 else f"{r}")
    pressed = tap.get("pressed_frame") if isinstance(tap, dict) else None
    S("game_state", {"expressions": ["get_node(\"Player\").last_jump_frame", "get_node(\"Player\").jumps",
                                     "get_node(\"Player\").velocity"], "wait_frames": 5},
      check=lambda r: None if r["values"]["get_node(\"Player\").last_jump_frame"] == pressed
      and r["values"]["get_node(\"Player\").jumps"] == 1 else f"jump not seen on frame {pressed}: {r}")
    S("game_input", {"key": "Left", "frames": 20}, check=lambda r: None if r["frames_held"] == 20 else f"{r}")
    S("game_input", {"action": "move_left", "type": "press"}, check=lambda r: None if "pressed_frame" in r else f"{r}")
    S("game_input", {"action": "move_left", "type": "release"}, check=lambda r: None if "released_frame" in r else f"{r}")
    S("game_input", {"mouse": [1030, 44]}, check=lambda r: None if r["frames_held"] == 1 else f"{r}")
    S("game_state", {"expressions": ["score", "get_node(\"ScoreLabel\").text", "get_node(\"Nope\").position", "1 +"],
                     "image": True, "max_width": 960}, save="game-state.png",
      check=lambda r: None if r["values"]["score"] == 11 and set(r.get("errors", {})) == {"get_node(\"Nope\").position", "1 +"}
      else f"{r}")
    S("game_input", {"action": "fly"}, expect_error=True)
    S("game_input", {"key": "Spce"}, expect_error=True)
    S("screenshot", {"target": "game"}, save="game-window.png")
    S("stop", check=lambda r: None if not r["playing"] else "still playing")
    S("game_input", {"action": "jump"}, expect_error=True)

    # A game the editor did not start, and one that does not load the game side: each said, with what works.
    other = S("execute_gdscript", {"code": 'return OS.create_process(OS.get_executable_path(), ["--path", '
                                           'ProjectSettings.globalize_path("res://"), "--position", "120,120"])'})
    time.sleep(3)
    S("game_state", expect_error=True,
      check=lambda t: None if "the editor did not start it" in t and "screenshot(target=game)" in t else t)
    S("execute_gdscript", {"code": f'return OS.kill({other.get("return", 0) if isinstance(other, dict) else 0})'})
    S("execute_gdscript", {"code": 'ProjectSettings.set_setting("application/config/disable_project_settings_override", true)\n'
                                   'return ProjectSettings.save()'})
    S("run_project", check=lambda r: None if r["playing"] else f"{r}")
    S("game_input", {"action": "jump"}, expect_error=True, check=lambda t: None if "no game bridge" in t else t)
    S("stop")
    S("execute_gdscript", {"code": 'ProjectSettings.set_setting("application/config/disable_project_settings_override", false)\n'
                                   'return ProjectSettings.save()'})

    # Playtests: one file that passes, one that fails (a wrong value and a script error), headless and visible.
    S("write_file", {"path": "res://tests/test_platformer.gd", "content": TEST_PLATFORMER_GD})
    S("write_file", {"path": "res://tests/test_failing.gd", "content": TEST_FAILING_GD})
    S("check_scripts", {"paths": ["res://tests/test_platformer.gd", "res://tests/test_failing.gd"]},
      check=lambda r: None if r["failed"] == 0 else f"{r}")
    runs = []

    def passing(r):
        runs.append(r)
        return None if r["passed"] and r["summary"] == "3 of 3 passed" else f"{r}"

    def failing(r):
        fails = {t["test"]: t.get("failures", []) for t in r["tests"]}
        wrong = fails.get("test_failing.gd:test_wrong_score", [{}])[0]
        error = fails.get("test_failing.gd:test_script_error", [{}])[0]
        return None if not r["passed"] and wrong.get("line") == 6 and "Score: 99" in wrong.get("message", "") \
            and error.get("line") == 12 and "fly_away" in error.get("message", "") else f"{r}"

    S("run_playtest", {"path": "res://tests/test_platformer.gd"}, check=passing)
    S("run_playtest", {"path": "res://tests/test_platformer.gd"}, check=passing)
    S("run_playtest", {"path": "res://tests/test_failing.gd"}, check=failing)
    S("run_playtest", {"path": "res://tests/test_platformer.gd", "mode": "visible"}, check=passing, save="checkpoint.png")
    S("run_playtest", {"path": "res://tests/test_failing.gd", "mode": "visible"}, check=failing)
    S("run_playtest", check=lambda r: None if not r["passed"] and r["summary"] == "3 of 5 passed" else f"{r}")
    S("run_playtest", {"path": "res://tests/test_platformer.gd", "test": "test_jumps_once"},
      check=lambda r: None if r["passed"] and [t["test"] for t in r["tests"]] == ["test_platformer.gd:test_jumps_once"] else f"{r}")
    if len(runs) == 3:   # two headless runs and a visible one: the same frames and the same positions
        same = [([(t["test"], t.get("frames")) for t in r["tests"]], [l for l in r.get("output", []) if "walked" in l])
                for r in runs]
        ok = same[0] == same[1] == same[2]
        e.results.append({"tool": "repeatable", "ok": ok, "ms": 0, "problem": None if ok else f"{same}", "saved": None})
        print(f"{time.strftime('%H:%M:%S')} {'ok' if ok else 'FAIL':4} repeatable           {same}")
    S("export", {"platform": "web"}, check=lambda r: None if "index.pck" in r["files"] else f"{r}")
    failed = [r for r in e.results if not r["ok"]]
    print(f"{time.strftime('%H:%M:%S')} DONE project={name} steps={len(e.results)} passed={len(e.results) - len(failed)} "
          f"failed={len(failed)}")
    with open(os.path.join(e.out, "gametest-results.json"), "w") as f:
        json.dump({"project": name, "results": e.results}, f, indent=1)
    return name, failed


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["tools", "call", "e2e", "gametest"])
    ap.add_argument("tool", nargs="?")
    ap.add_argument("args", nargs="?", default="{}")
    ap.add_argument("--url", default=os.environ.get("GODOT_SERVER_URL", "http://127.0.0.1:3880"))
    ap.add_argument("--token", default=os.environ.get("GODOT_SERVER_TOKEN", ""))
    ap.add_argument("--save", help="call: write the first returned image here")
    ap.add_argument("--name", help="e2e / gametest: project name (a suffix is added if it exists)")
    ap.add_argument("--out", default="e2e-out", help="e2e: folder for screenshots and results")
    ap.add_argument("--no-switch", action="store_true", help="e2e: skip the open_project round trip")
    a = ap.parse_args()
    if not a.token:
        sys.exit("set GODOT_SERVER_TOKEN or pass --token")
    mcp = MCP(a.url, a.token)
    if a.command == "tools":
        for t in mcp.rpc("tools/list")["tools"]:
            print(f"{t['name']:18} {', '.join(t['inputSchema'].get('properties', {}))}")
        return
    if a.command == "call":
        ok, res, images = mcp.call(a.tool, json.loads(a.args))
        print(json.dumps(res, indent=1) if not isinstance(res, str) else res)
        if a.save and save_image(images, a.save):
            print(f"saved {a.save}")
        sys.exit(0 if ok else 1)
    info = mcp.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                  "clientInfo": {"name": "godot-server-e2e", "version": "1"}})
    print(f"{time.strftime('%H:%M:%S')} connected to {info['serverInfo']['name']} {info['serverInfo']['version']} at {mcp.url}")
    if a.command == "gametest":
        _, failed = gametest(E2E(mcp, a.out), a.name or "platformer")
    else:
        _, failed = E2E(mcp, a.out).run(a.name or "coin-chase", switch=not a.no_switch)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
