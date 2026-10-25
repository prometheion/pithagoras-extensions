extends SceneTree
## The bridge's side in the game: the main loop of each game the editor runs while godot-server drives it, and of
## each playtest run_playtest runs.
##
## It gets there on the game's command line, `-s res://addons/godot_mcp_bridge/game.gd`, which the editor plugin adds
## to every run it starts (EditorPlugin._run_scene) and godot-server to the headless playtests it runs. Nothing is
## written to the project: the game's own main scene, autoloads and settings load as they always do, and this
## SceneTree adds no node to them. An exported game never has it: nothing puts it on an export's command line, and
## the presets godot-server writes leave the addon's scripts out.
##
## Over the editor's debugger channel (EngineDebugger, the messages "mcp:..."), it sends the input the editor asks for
## and reads the game's state. Input goes through Input.parse_input_event at the end of a physics frame, after the
## game's own physics, as a real device's input arrives between two frames: what is sent there is seen from the next
## physics frame on, and "frames" are physics frames, so a run at a fixed frame rate repeats exactly.
##
## With GODOT_MCP_PLAYTEST in its environment (a folder holding spec.json), it runs the playtests spec.json names,
## writes what happens to results.jsonl in that folder as it happens, and quits.

## Emitted at the end of each physics frame, after the game's own physics and before the input sent then is applied.
signal frame_passed

const IMAGE_MAX_WIDTH := 640   # checkpoint pictures, which the model reads
const MAX_NODES := 200
const MAX_FRAMES := 36000

var _queue: Array[Sent] = []   # what waits for the end of this physics frame
var _held := {}                # input id -> the Sent that holds it down
var _mouse := Vector2.ZERO     # where the last mouse event put the pointer, in window coordinates
var _buttons := 0              # the mouse buttons held, as a mask

# A playtest run
var _out: FileAccess
var _dir := ""
var _logger: TestLogger
var _shots := 0


## One input sent: what it is, how long it is held, and when it was pressed and released.
class Sent:
	extends RefCounted
	signal done
	var id := ""           # what it holds down: "action:jump", "key:32", "mouse:1"; "" for a mouse move
	var label := ""        # what was sent, as the result says it
	var type := "tap"      # tap, press, release, move
	var frames := 1
	var until := -1        # the physics frame its release is seen from
	var make: Callable     # pressed (bool) -> InputEvent
	var result := {}


## Script errors raised while a playtest runs, so a test that errors fails at its line instead of hanging.
class TestLogger:
	extends Logger
	var lock := Mutex.new()
	var errors: Array[Dictionary] = []

	func _log_error(_function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool,
			error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		if error_type != ERROR_TYPE_SCRIPT:
			return
		lock.lock()
		errors.append({"file": file, "line": line, "message": rationale if not rationale.is_empty() else code})
		lock.unlock()

	func _log_message(_message: String, _error: bool) -> void:
		pass

	func take() -> Array[Dictionary]:
		lock.lock()
		var out := errors.duplicate()
		errors.clear()
		lock.unlock()
		return out


func _initialize() -> void:
	if EngineDebugger.is_active():
		EngineDebugger.register_message_capture("mcp", _on_message)
		EngineDebugger.send_message("mcp:ready", [{"physics_fps": Engine.physics_ticks_per_second}])
	_dir = OS.get_environment("GODOT_MCP_PLAYTEST")
	if not _dir.is_empty():
		_playtests.call_deferred()


func _physics_process(_delta: float) -> bool:
	# Deferred to the end of this physics frame: the tree flushes its message queue after the nodes' physics.
	_end_of_frame.call_deferred()
	return false


func _end_of_frame() -> void:
	frame_passed.emit()   # what waits for a frame runs now, and what it sends is applied below, in this same gap
	var next := Engine.get_physics_frames() + 1   # the first physics frame that sees what is sent now
	for id in _held.keys():
		var held: Sent = _held.get(id)
		if held and held.until >= 0 and held.until <= next:
			_release(held, next)
	while not _queue.is_empty():
		_apply(_queue.pop_front(), next)


# ---- input ---------------------------------------------------------------------------------------------------------

## Sends one input (a = {action | key | mouse, type, frames | seconds, button}) and returns, once it is applied
## (a tap: once it is released), what was sent and the frames.
func send(a: Dictionary) -> Dictionary:
	var sent := _sent(a)
	if not sent.result.is_empty():
		return sent.result   # {"error": ...}
	_queue.append(sent)
	await sent.done
	return sent.result


func _sent(a: Dictionary) -> Sent:
	var s := Sent.new()
	s.type = str(a.get("type", "tap"))
	if not s.type in ["tap", "press", "release", "move"]:
		s.result = {"error": "type must be tap, press, release or move"}
		return s
	if a.has("seconds"):
		s.frames = ceili(float(a["seconds"]) * Engine.physics_ticks_per_second)
	else:
		s.frames = int(a.get("frames", 1))
	if s.frames < 1 or s.frames > MAX_FRAMES:
		s.result = {"error": "hold between 1 and %d physics frames" % MAX_FRAMES}
		return s
	if a.has("action"):
		var action := StringName(str(a["action"]))
		if not InputMap.has_action(action):
			s.result = {"error": "no input action '%s'; the project's own actions: %s (and the built-in ui_* ones)" % [action, ", ".join(_own_actions())]}
			return s
		if s.type == "move":
			s.result = {"error": "move is for the mouse"}
			return s
		s.id = "action:" + action
		s.label = str(action)
		s.make = func(pressed: bool) -> InputEvent:
			var e := InputEventAction.new()
			e.action = action
			e.pressed = pressed
			return e
	elif a.has("key"):
		var code := OS.find_keycode_from_string(str(a["key"]))
		if code == KEY_NONE:
			s.result = {"error": "unknown key '%s'; key names are like Space, Enter, Escape, Left, A, F1" % a["key"]}
			return s
		if s.type == "move":
			s.result = {"error": "move is for the mouse"}
			return s
		s.id = "key:%d" % code
		s.label = "key " + OS.get_keycode_string(code)
		s.make = func(pressed: bool) -> InputEvent:
			var e := InputEventKey.new()
			e.keycode = code
			e.physical_keycode = code
			e.key_label = code
			e.unicode = code if pressed and code >= KEY_SPACE and code <= KEY_ASCIITILDE else 0
			e.pressed = pressed
			return e
	elif a.has("mouse"):
		var p = a["mouse"]
		if not (p is Array and p.size() == 2):
			s.result = {"error": "mouse is a point [x, y] in the game's viewport"}
			return s
		var at := Vector2(float(p[0]), float(p[1]))
		var window_at := root.get_final_transform() * at   # the viewport's coordinates as the window has them
		if s.type == "move":
			s.label = "mouse to [%s, %s]" % [at.x, at.y]
			s.make = func(_pressed: bool) -> InputEvent:
				var e := InputEventMouseMotion.new()
				e.position = window_at
				e.global_position = window_at
				e.relative = window_at - _mouse
				e.button_mask = _buttons
				return e
		else:
			var names := {"left": MOUSE_BUTTON_LEFT, "right": MOUSE_BUTTON_RIGHT, "middle": MOUSE_BUTTON_MIDDLE}
			var button_name := str(a.get("button", "left"))
			if not names.has(button_name):
				s.result = {"error": "button must be left, right or middle"}
				return s
			var button: MouseButton = names[button_name]
			s.id = "mouse:%d" % button
			s.label = "%s mouse button at [%s, %s]" % [button_name, at.x, at.y]
			s.make = func(pressed: bool) -> InputEvent:
				var e := InputEventMouseButton.new()
				e.button_index = button
				e.pressed = pressed
				e.position = window_at
				e.global_position = window_at
				var bit := 1 << (button - 1)
				e.button_mask = (_buttons | bit) if pressed else (_buttons & ~bit)
				return e
	else:
		s.result = {"error": "give action (preferred), key or mouse"}
	return s


func _own_actions() -> PackedStringArray:
	var out := PackedStringArray()
	for action in InputMap.get_actions():
		if not str(action).begins_with("ui_"):
			out.append(str(action))
	return out


func _apply(s: Sent, next: int) -> void:
	match s.type:
		"move":
			_send_event(s.make.call(true))
			s.result = {"sent": s.label, "frame": next}
			s.done.emit()
		"release":
			var held: Sent = _held.get(s.id)
			if held:
				_release(held, next)
			else:
				_send_event(s.make.call(false))
			s.result = {"sent": "release " + s.label, "released_frame": next}
			if not held:
				s.result["note"] = "it was not held by an earlier press"
			s.done.emit()
		_:
			var old: Sent = _held.get(s.id)
			if old:
				_release(old, next)
			_send_event(s.make.call(true))
			_held[s.id] = s
			s.result = {"sent": ("tap " if s.type == "tap" else "press ") + s.label, "pressed_frame": next}
			if s.type == "tap":
				s.until = next + s.frames
			else:
				s.done.emit()   # held until a release


func _release(s: Sent, next: int) -> void:
	_held.erase(s.id)
	_send_event(s.make.call(false))
	if s.type == "tap":
		s.result["released_frame"] = next
		s.result["frames_held"] = next - int(s.result["pressed_frame"])
		s.done.emit()


func _send_event(e: InputEvent) -> void:
	if e is InputEventMouseButton:
		_buttons = e.button_mask
	if e is InputEventMouse:
		_mouse = e.position
		if DisplayServer.get_name() != "headless":
			Input.warp_mouse(e.position)   # so the game's get_mouse_position() agrees with the event
	Input.parse_input_event(e)
	Input.flush_buffered_events()


func release_all() -> void:
	var next := Engine.get_physics_frames() + 1
	for id in _held.keys():
		var held: Sent = _held.get(id)
		if held:
			_release(held, next)


# ---- the editor's requests -----------------------------------------------------------------------------------------

func _on_message(message: String, data: Array) -> bool:
	if message != "call" or data.size() < 3:
		return false
	_answer(data[0], str(data[1]), data[2] if data[2] is Dictionary else {})
	return true


func _answer(id, op: String, a: Dictionary) -> void:
	var result: Dictionary
	match op:
		"input":
			result = await send(a)
		"state":
			result = await state(a)
		_:
			result = {"error": "unknown request '%s'" % op}
	EngineDebugger.send_message("mcp:reply", [id, result])


## The game's state: its node tree, the values of expressions evaluated on the current scene, and its frame (png).
func state(a: Dictionary) -> Dictionary:
	var wait := int(a.get("wait_frames", 0))
	if wait < 0 or wait > MAX_FRAMES:
		return {"error": "wait_frames is between 0 and %d" % MAX_FRAMES}
	for i in wait:
		await frame_passed
	if a.get("image", false):
		await RenderingServer.frame_post_draw   # values and picture of one frame
	var exprs: Array = a["expressions"] if a.get("expressions") is Array else []
	var out := {"frame": Engine.get_physics_frames(), "scene": current_scene.scene_file_path if current_scene else ""}
	if a.get("tree", exprs.is_empty()):
		var tree = nodes(str(a.get("root", "")), int(a.get("max_depth", 6)))
		if tree is String:
			return {"error": tree}
		out["nodes"] = tree
	if not exprs.is_empty():
		var values := {}
		var errors := {}
		for src in exprs:
			var e := Expression.new()
			if e.parse(str(src)) != OK:
				errors[str(src)] = e.get_error_text()
				continue
			var v = e.execute([], current_scene if current_scene else root, false)
			if e.has_execute_failed():
				errors[str(src)] = e.get_error_text() if not e.get_error_text().is_empty() else "it failed"
			else:
				values[str(src)] = plain(v)
		out["values"] = values
		if not errors.is_empty():
			out["errors"] = errors
	if a.get("image", false):
		var img := root.get_texture().get_image()
		if img == null or img.is_empty():
			return {"error": "the game has no rendered frame"}
		var w := int(a.get("max_width", 0))
		if w > 0 and img.get_width() > w:
			img.resize(w, maxi(1, int(round(img.get_height() * float(w) / img.get_width()))), Image.INTERPOLATE_LANCZOS)
		out["png"] = img.save_png_to_buffer()
	return out


## The live tree under the current scene (or under `from`: a path from it, or an absolute one such as /root), one
## entry per node with its path from there, its type and a few telling values; or why it cannot be read.
func nodes(from: String, max_depth: int):
	var base: Node = current_scene if current_scene else root
	if not from.is_empty():
		base = root.get_node_or_null(from) if from.begins_with("/") else base.get_node_or_null(from)
		if base == null:
			return "no node at '%s'" % from
	var out := []
	_walk(base, base, 0, max_depth, out)
	if out.size() > MAX_NODES:
		var more := out.size() - MAX_NODES
		out.resize(MAX_NODES)
		out.append({"more_nodes": more})
	return out


func _walk(n: Node, base: Node, depth: int, max_depth: int, out: Array) -> void:
	var d := {"path": str(base.get_path_to(n)), "type": n.get_class()}
	var s = n.get_script()
	if s is Script and not s.resource_path.is_empty():
		d["script"] = s.resource_path
	for p in ["position", "velocity", "linear_velocity", "text", "value", "animation", "current_animation", "visible"]:
		if not p in n:
			continue
		var v = n.get(p)
		if v == null or (p == "visible" and v) or (p in ["text", "animation", "current_animation"] and str(v).is_empty()):
			continue
		if p == "position" and not v:
			continue   # a zero vector, as most children sit where their parent is
		d[p] = plain(v)
	out.append(d)
	if out.size() > MAX_NODES:
		return
	if depth >= max_depth:
		if n.get_child_count() > 0:
			d["children_not_shown"] = n.get_child_count()
		return
	for c in n.get_children():
		_walk(c, base, depth + 1, max_depth, out)


## A value as JSON: [x, y] for a Vector2, [r, g, b, a] for a Color, a node's path, a resource's path; floats to 3 places.
func plain(v, depth := 0):
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return v
		TYPE_FLOAT:
			return snappedf(v, 0.001)
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(v)
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return [plain(v.x), plain(v.y)]
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return [plain(v.x), plain(v.y), plain(v.z)]
		TYPE_VECTOR4, TYPE_VECTOR4I, TYPE_QUATERNION:
			return [plain(v.x), plain(v.y), plain(v.z), plain(v.w)]
		TYPE_COLOR:
			return [plain(v.r), plain(v.g), plain(v.b), plain(v.a)]
		TYPE_RECT2, TYPE_RECT2I:
			return [plain(v.position.x), plain(v.position.y), plain(v.size.x), plain(v.size.y)]
		TYPE_OBJECT:
			if not is_instance_valid(v):
				return null
			if v is Node:
				return str(v.get_path()) if v.is_inside_tree() else "<%s>" % v.get_class()
			if v is Resource and not v.resource_path.is_empty() and not v.resource_path.contains("::"):
				return v.resource_path
			return "<%s>" % v.get_class()
		TYPE_DICTIONARY:
			if depth > 4:
				return "{...}"
			var out := {}
			for k in v:
				if out.size() >= 50:
					out["..."] = "%d more" % (v.size() - 50)
					break
				out[str(k)] = plain(v[k], depth + 1)
			return out
	if v is Array or typeof(v) >= TYPE_PACKED_BYTE_ARRAY:
		if depth > 4:
			return "[...]"
		var out := []
		for x in v:
			if out.size() >= 50:
				out.append("... %d more" % (v.size() - 50))
				break
			out.append(plain(x, depth + 1))
		return out
	return var_to_str(v)


# ---- playtests -----------------------------------------------------------------------------------------------------

func _emit(event: Dictionary) -> void:
	_out.store_line(JSON.stringify(event))
	_out.flush()


func _playtests() -> void:
	var spec = JSON.parse_string(FileAccess.get_file_as_string(_dir.path_join("spec.json")))
	_out = FileAccess.open(_dir.path_join("results.jsonl"), FileAccess.WRITE)
	if not (spec is Dictionary) or _out == null:
		printerr("godot_mcp_bridge: no playtest spec in ", _dir)
		quit(2)
		return
	_logger = TestLogger.new()
	OS.add_logger(_logger)
	var scene := str(spec.get("scene", ""))
	if scene.is_empty():
		scene = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	# A headless run is started with no scene (its command line names this script); a run from the editor with one.
	if current_scene == null or (not str(spec.get("scene", "")).is_empty() and current_scene.scene_file_path != scene):
		if scene.is_empty() or change_scene_to_file(scene) != OK:
			_emit({"event": "error", "message": "the project has no main scene; give run_playtest a scene"
				if scene.is_empty() else "cannot load the scene '%s'" % scene})
			_finish()
			return
		while current_scene == null or not current_scene.is_node_ready():
			await process_frame
	var only := str(spec.get("test", ""))
	var ran := false
	for file in spec.get("files", []):
		var script = _script_of(str(file))
		if script == null:
			continue
		for name in _tests_of(script, str(file), only):
			ran = true
			await _run_test(script.new(), str(file), name)
	if not ran and not only.is_empty():
		_emit({"event": "error", "message": "no test function named " + only})
	_finish()


## A test file's script, or null after saying why it cannot run.
func _script_of(file: String) -> Script:
	_logger.take()
	var script = load(file) if ResourceLoader.exists(file) else null
	if not (script is Script) or not script.can_instantiate():
		var errs := _logger.take()
		_emit({"event": "error", "file": file, "line": errs[0]["line"] if not errs.is_empty() else 0,
			"message": "does not compile: " + (errs[0]["message"] if not errs.is_empty() else "see the errors")})
		return null
	var base: Script = script
	while base != null and base != PlayTest:
		base = base.get_base_script()
	if base == null:
		_emit({"event": "error", "file": file, "line": 1, "message": "does not extend PlayTest"})
		return null
	return script


## The names of a test file's test_* functions in their order (or only the one named); a file with none is said.
func _tests_of(script: Script, file: String, only: String) -> Array[String]:
	var names: Array[String] = []
	for m in script.get_script_method_list():
		var n := str(m["name"])
		if n.begins_with("test_") and not n in names and (only.is_empty() or n == only):
			names.append(n)
	if names.is_empty() and only.is_empty():
		_emit({"event": "error", "file": file, "line": 1, "message": "has no test_ functions"})
	return names


func _run_test(t: PlayTest, file: String, name: String) -> void:
	# Each test starts the same way in every run, headless or visible: on the scene loaded afresh, at the end of a
	# physics frame (the scene loads in the process step, so it has run the same frames by then).
	await _reload()
	await frame_passed
	t._begin(self, file, name, current_scene)
	_logger.take()
	_emit({"event": "start", "file": file, "test": name, "frame": Engine.get_physics_frames()})
	var state := {"done": false, "frames": 0}
	var body := func() -> void:
		await t.call(name)
		state["done"] = true
		state["frames"] = t.frame
	body.call()
	while true:
		var errs := _logger.take()
		if not errs.is_empty():
			var e: Dictionary = errs[0]
			var here: bool = e["file"] == file
			t._failures.append({"line": e["line"] if here else 0,
				"message": "script error: %s%s" % [e["message"], "" if here else " (%s:%d)" % [e["file"], e["line"]]]})
			break
		if state["done"]:
			break
		await frame_passed
	t._stopped = true   # a test cut short by an error sends nothing more
	release_all()
	for f in t._failures:
		_emit({"event": "check", "file": file, "test": name, "line": f["line"], "message": f["message"]})
	_emit({"event": "end", "file": file, "test": name, "passed": t._failures.is_empty(),
		"frames": state["frames"] if state["done"] else t.frame})


## Loads the scene again, as it is on disk.
func _reload() -> void:
	var old := current_scene
	reload_current_scene()
	while current_scene == null or current_scene == old or not current_scene.is_node_ready():
		await process_frame


## A picture of the frame being drawn now, saved beside the results without holding the test up (none headless).
func checkpoint(t: PlayTest, name: String) -> void:
	var event := {"event": "checkpoint", "file": t._file, "test": t._test, "name": name, "frame": t.frame}
	if DisplayServer.get_name() == "headless":
		_emit(event)
		return
	_shots += 1
	event["image"] = "checkpoint-%d.png" % _shots
	_emit(event)
	await RenderingServer.frame_post_draw
	var img := root.get_texture().get_image()
	if img == null or img.is_empty():
		return
	if img.get_width() > IMAGE_MAX_WIDTH:
		img.resize(IMAGE_MAX_WIDTH, maxi(1, int(round(img.get_height() * float(IMAGE_MAX_WIDTH) / img.get_width()))), Image.INTERPOLATE_LANCZOS)
	img.save_png(_dir.path_join(event["image"]))


func _finish() -> void:
	_emit({"event": "done"})
	_out.close()
	if _logger:
		OS.remove_logger(_logger)
	# A checkpoint's picture is saved after the frame it asked for is drawn; a headless run draws none.
	if DisplayServer.get_name() != "headless":
		await RenderingServer.frame_post_draw
	quit()
