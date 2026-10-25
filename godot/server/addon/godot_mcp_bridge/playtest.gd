class_name PlayTest
extends RefCounted
## A playtest: a script in res://tests/ named test_*.gd that extends PlayTest. Each of its test_* functions is a test;
## run_playtest runs them in order, each on the scene loaded afresh, in the game itself: headless at a fixed frame
## rate, or in a window over the editor at the same rate. Frames are physics frames, so a run repeats exactly.
##
##     extends PlayTest
##
##     func test_jump() -> void:
##         var player := node("Player")
##         await wait_frames(10)
##         var y: float = player.position.y
##         await press("jump")
##         await wait_frames(15)
##         check(player.position.y < y - 40, "the player rises after jump (from %s to %s)" % [y, player.position.y])
##         checkpoint("in the air")
##
## Await the helpers that take frames (press, hold, release, key, click, move_mouse and the waits). A failed check
## does not stop the test; a script error does, and fails it at its line.

## The scene's root, loaded afresh for this test.
var scene: Node
## Physics frames since this test began.
var frame: int:
	get:
		return Engine.get_physics_frames() - _start

var _runner   # the game's bridge (game.gd), which sends the input and owns the frames
var _file := ""
var _test := ""
var _start := 0
var _failures: Array[Dictionary] = []
var _stopped := false


func _begin(runner, file: String, test: String, root: Node) -> void:
	_runner = runner
	_file = file
	_test = test
	scene = root
	_start = Engine.get_physics_frames()


## Holds an input action (from the project's Input Map) down for some frames, then lets it go.
func press(action: String, frames := 1) -> void:
	await _send({"action": action, "type": "tap", "frames": frames})


## Holds an input action down until release(action).
func hold(action: String) -> void:
	await _send({"action": action, "type": "press"})


## Lets go of an action (or a key, with key = true) held by hold().
func release(action: String, key := false) -> void:
	await _send({"key" if key else "action": action, "type": "release"})


## Presses a key for some frames: "Space", "Enter", "Escape", "Left", "A", "F1".
func key(name: String, frames := 1) -> void:
	await _send({"key": name, "type": "tap", "frames": frames})


## Clicks a mouse button ("left", "right", "middle") at a point in the game's viewport.
func click(at: Vector2, button := "left", frames := 1) -> void:
	await _send({"mouse": [at.x, at.y], "button": button, "type": "tap", "frames": frames})


## Moves the mouse to a point in the game's viewport.
func move_mouse(to: Vector2) -> void:
	await _send({"mouse": [to.x, to.y], "type": "move"})


## Lets the game run for some physics frames.
func wait_frames(n: int) -> void:
	for i in maxi(n, 0):
		if _stopped:
			return
		await _runner.frame_passed


## Lets the game run for some seconds of game time (whole physics frames).
func wait_seconds(seconds: float) -> void:
	await wait_frames(ceili(seconds * Engine.physics_ticks_per_second))


## Waits until condition (a Callable returning true) holds, checked each frame. Gives up after max_frames: that fails
## the test and returns false.
func wait_until(condition: Callable, max_frames := 600) -> bool:
	var line := _caller_line()   # once it has waited, the test's own frame is no longer on the stack
	for i in max_frames + 1:
		if _stopped:
			return false
		if condition.call():
			return true
		if i < max_frames:
			await _runner.frame_passed
	_fail("wait_until gave up after %d frames" % max_frames, line)
	return false


## A node of the scene by its path from the scene's root; a path that names none fails the test and returns null.
func node(path: String) -> Node:
	var n := scene.get_node_or_null(path) if is_instance_valid(scene) else null
	if n == null:
		_fail("no node at '%s'" % path)
	return n


## Fails the test with message unless condition holds; returns condition.
func check(condition: bool, message := "") -> bool:
	if not condition:
		_fail(message if not message.is_empty() else "check failed")
	return condition


## Fails the test unless got == want; returns whether they are equal.
func check_eq(got, want, message := "") -> bool:
	var numbers := [TYPE_INT, TYPE_FLOAT]
	var same: bool
	if typeof(got) in numbers and typeof(want) in numbers:
		same = got == want
	else:
		same = typeof(got) == typeof(want) and got == want
	if not same:
		_fail("%sgot %s, want %s" % [message + ": " if not message.is_empty() else "", var_to_str(got), var_to_str(want)])
	return same


## Fails the test with message.
func fail(message: String) -> void:
	_fail(message)


## Saves a picture of the game as it is now (in a visible run; a headless run notes the frame only).
func checkpoint(name: String) -> void:
	if not _stopped:
		_runner.checkpoint(self, name)


func _send(a: Dictionary) -> void:
	if _stopped:
		return
	var r: Dictionary = await _runner.send(a)
	if r.has("error"):
		_fail(r["error"])


func _fail(message: String, line := -1) -> void:
	if _stopped:
		return
	_failures.append({"line": line if line >= 0 else _caller_line(), "message": message})


## The line of the test file that called into PlayTest: its innermost frame in the backtrace.
func _caller_line() -> int:
	for bt in Engine.capture_script_backtraces(false):
		for i in bt.get_frame_count():
			if bt.get_frame_file(i) == _file:
				return bt.get_frame_line(i)
	return 0
