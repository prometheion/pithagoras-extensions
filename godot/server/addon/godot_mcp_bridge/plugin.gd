@tool
extends EditorPlugin
## Bridge between godot-server and this editor.
##
## godot-server (the container's sidecar, which serves MCP) connects to 127.0.0.1:GODOT_BRIDGE_PORT and sends one
## JSON object per line: {"id": "...", "secret": "...", "cmd": "...", "args": {...}}. Each request is handled on the
## editor's main thread and answered with one line: {"id": ..., "ok": true, "result": ...} or
## {"id": ..., "ok": false, "error": "..."}. Scene edits go through the editor's undo/redo, so they show in History
## and can be undone like any other edit. Without GODOT_BRIDGE_SECRET in the environment (any editor outside
## godot-server) the plugin does nothing.

const MAX_LINE := 64 * 1024 * 1024

var _server: TCPServer
var _conns: Array[Dictionary] = []
var _secret := ""
var _err := ""   # set by the value converters when a value cannot be converted
var _ready := false   # true once the editor's first filesystem scan is done (ping reports it)
var _halt := {}   # while the game is stopped in the editor's debugger: {"reason": ..., "stack": [...]}


func _enter_tree() -> void:
	if DisplayServer.get_name() == "headless":
		return   # command-line exports and checks load editor plugins too; they must not take the port
	_secret = OS.get_environment("GODOT_BRIDGE_SECRET")
	if _secret.is_empty():
		return
	var port := int(OS.get_environment("GODOT_BRIDGE_PORT")) if OS.has_environment("GODOT_BRIDGE_PORT") else 9900
	_server = TCPServer.new()
	var err := _server.listen(port, "127.0.0.1")
	print("GODOT_MCP_BRIDGE listening on 127.0.0.1:%d (%s)" % [port, error_string(err)])
	# The virtual display has no vsync: without a cap, continuous redraws (and a game run from the editor) spin.
	Engine.max_fps = 60
	_setup_editor.call_deferred()


func _exit_tree() -> void:
	if _server:
		_server.stop()
		_server = null
	_conns.clear()


func _setup_editor() -> void:
	var es := EditorInterface.get_editor_settings()
	es.set_setting("interface/editor/update_continuously", false)
	# Files the agent writes change on disk under the editor: reload them quietly instead of asking.
	es.set_setting("text_editor/behavior/files/auto_reload_scripts_on_external_change", true)
	es.set_setting("interface/editor/import_resources_when_unfocused", true)
	# There is no window manager: fill the virtual screen.
	DisplayServer.window_set_position(Vector2i.ZERO)
	DisplayServer.window_set_size(DisplayServer.screen_get_size())
	# Commands wait until the first scan (and the imports it starts) is over and the editor has restored its tabs.
	var fs := EditorInterface.get_resource_filesystem()
	await get_tree().process_frame
	while fs.is_scanning():
		await get_tree().create_timer(0.1).timeout
	await get_tree().create_timer(0.5).timeout
	var saved_open := false
	for p in EditorInterface.get_open_scenes():
		saved_open = saved_open or not p.is_empty()
	var main := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if not saved_open and not main.is_empty() and ResourceLoader.exists(main):
		EditorInterface.open_scene_from_path(main)
		await get_tree().process_frame
		_focus_workspace(EditorInterface.get_edited_scene_root())
	_watch_debuggers()
	_ready = true
	print("GODOT_MCP_BRIDGE ready")


# ---- transport -----------------------------------------------------------------------------------------------

func _process(_delta: float) -> void:
	if _server == null:
		return
	while _server.is_connection_available():
		_conns.append({"peer": _server.take_connection(), "buf": PackedByteArray()})
	for i in range(_conns.size() - 1, -1, -1):
		var c: Dictionary = _conns[i]
		var peer: StreamPeerTCP = c["peer"]
		peer.poll()
		var status := peer.get_status()
		if status != StreamPeerTCP.STATUS_CONNECTED:
			if status != StreamPeerTCP.STATUS_CONNECTING:
				_conns.remove_at(i)
			continue
		var avail := peer.get_available_bytes()
		if avail <= 0:
			continue
		var got: Array = peer.get_partial_data(avail)
		if got[0] != OK:
			continue
		var buf: PackedByteArray = c["buf"]
		buf.append_array(got[1])
		var nl := buf.find(10)
		while nl >= 0:
			var line := buf.slice(0, nl).get_string_from_utf8()
			buf = buf.slice(nl + 1)
			_dispatch(peer, line)
			nl = buf.find(10)
		if buf.size() > MAX_LINE:
			peer.disconnect_from_host()
			buf = PackedByteArray()
		c["buf"] = buf


func _dispatch(peer: StreamPeerTCP, line: String) -> void:
	var req = JSON.parse_string(line)
	if not (req is Dictionary):
		_reply(peer, null, false, "request is not a JSON object")
		return
	if str(req.get("secret", "")) != _secret:
		_reply(peer, req.get("id"), false, "unauthorized")
		return
	_run(peer, req)   # a coroutine for some commands; it replies when it finishes


func _run(peer: StreamPeerTCP, req: Dictionary) -> void:
	var id = req.get("id")
	var args: Dictionary = req["args"] if req.get("args") is Dictionary else {}
	_err = ""
	var res = await _call(str(req.get("cmd", "")), args)
	if res is Dictionary and res.has("error"):
		_reply(peer, id, false, str(res["error"]))
	elif res == null:
		_reply(peer, id, false, "the command failed inside the editor; get_output shows the editor's error")
	else:
		_reply(peer, id, true, "", res)


func _reply(peer: StreamPeerTCP, id, ok: bool, error := "", result = null) -> void:
	var msg := {"id": id, "ok": ok}
	if ok:
		msg["result"] = result
	else:
		msg["error"] = error
	if peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		peer.put_data((JSON.stringify(msg) + "\n").to_utf8_buffer())


func _call(cmd: String, a: Dictionary):
	match cmd:
		"ping":
			return _ping()
		"get_scene_tree":
			return _get_scene_tree(a)
		"open_scene":
			return await _open_scene(a)
		"new_scene":
			return await _new_scene(a)
		"save_scene":
			return _save_scene(a)
		"add_node":
			return _add_node(a)
		"set_property":
			return _set_property(a)
		"delete_node":
			return _delete_node(a)
		"attach_script":
			return _attach_script(a)
		"write_file":
			return _write_file(a)
		"delete_file":
			return await _delete_file(a)
		"reload":
			return await _reload(a)
		"run":
			return await _run_game(a)
		"stop":
			return await _stop_game()
		"debugger":
			return _debugger_state()
		"screenshot":
			return await _screenshot(a)
		"execute":
			return await _execute(a)
		"save_all":
			EditorInterface.save_all_scenes()
			return {"saved": Array(EditorInterface.get_open_scenes())}
		"toast":
			_toast(str(a.get("text", "")), int(a.get("severity", 0)))
			return {"shown": true}
		"quit":
			EditorInterface.save_all_scenes()
			get_tree().quit.call_deferred()
			return {"quitting": true}
	return {"error": "unknown command '%s'" % cmd}


# ---- commands --------------------------------------------------------------------------------------------------

func _ping() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var size := DisplayServer.window_get_size()
	return {
		"godot": Engine.get_version_info()["string"],
		"adapter": RenderingServer.get_video_adapter_name(),
		"adapter_vendor": RenderingServer.get_video_adapter_vendor(),
		"graphics_api": RenderingServer.get_video_adapter_api_version(),
		"rendering_method": RenderingServer.get_current_rendering_method(),
		"rendering_driver": RenderingServer.get_current_rendering_driver_name(),
		"vram_used_mb": int(RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_VIDEO_MEM_USED) / 1048576),
		"project_name": str(ProjectSettings.get_setting("application/config/name", "")),
		"main_scene": str(ProjectSettings.get_setting("application/run/main_scene", "")),
		"edited_scene": root.scene_file_path if root else "",
		"open_scenes": Array(EditorInterface.get_open_scenes()),
		"playing": EditorInterface.is_playing_scene(),
		"halted_in_debugger": _debugger_state()["halted"],
		"window_size": [size.x, size.y],
		"ready": _ready,
	}


func _get_scene_tree(a: Dictionary) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"error": "no scene is open; use open_scene or new_scene"}
	return {"scene": root.scene_file_path, "root": _describe(root, root, 0, int(a.get("max_depth", 12)))}


func _describe(n: Node, root: Node, depth: int, max_depth: int) -> Dictionary:
	var d := {"name": str(n.name), "type": n.get_class(), "path": str(root.get_path_to(n))}
	var s = n.get_script()
	if s:
		d["script"] = s.resource_path
	if n != root and not n.scene_file_path.is_empty():
		d["instance"] = n.scene_file_path
	for p in ["position", "size", "text", "texture", "shape", "mesh", "visible"]:
		if p in n:
			var v = n.get(p)
			if v == null or (p == "visible" and v == true) or (p == "text" and str(v).is_empty()):
				continue
			d[p] = _plain(v)
	var kids := []
	if depth < max_depth:
		for c in n.get_children():
			if c.owner == root:
				kids.append(_describe(c, root, depth + 1, max_depth))
	elif n.get_child_count() > 0:
		d["children_not_shown"] = n.get_child_count()
	if not kids.is_empty():
		d["children"] = kids
	return d


func _open_scene(a: Dictionary):
	var path := str(a.get("path", ""))
	if not _is_scene_path(path):
		return {"error": "%s is not a scene file (.tscn or .scn)" % path}
	if not ResourceLoader.exists(path, "PackedScene"):
		return {"error": "no scene at " + path}
	EditorInterface.open_scene_from_path(path)
	await get_tree().process_frame
	var root := EditorInterface.get_edited_scene_root()
	if root == null or root.scene_file_path != path:
		return {"error": "the editor did not open %s (it may be asking something in a dialog: screenshot with target=screen shows it)" % path}
	_focus_workspace(root)
	_toast("Agent opened " + path)
	return {"scene": root.scene_file_path}


func _new_scene(a: Dictionary):
	var path := str(a.get("path", ""))
	if not path.begins_with("res://") or not path.ends_with(".tscn"):
		return {"error": "path must be a res:// path ending in .tscn"}
	if FileAccess.file_exists(path) and not a.get("overwrite", false):
		return {"error": path + " already exists (pass overwrite: true to replace it)"}
	var type := str(a.get("root_type", "Node2D"))
	var root = _instantiate(type)
	if not (root is Node):
		if root is Object and not (root is RefCounted):
			root.free()
		return {"error": _err if not _err.is_empty() else type + " is not a Node type"}
	var root_name := str(a.get("root_name", path.get_file().get_basename().to_pascal_case()))
	root.name = root_name
	var packed := PackedScene.new()
	packed.pack(root)
	root.free()
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(path.get_base_dir()))
	var err := ResourceSaver.save(packed, path)
	if err != OK:
		return {"error": "saving %s failed: %s" % [path, error_string(err)]}
	EditorInterface.get_resource_filesystem().update_file(path)
	if a.get("set_main", false):
		ProjectSettings.set_setting("application/run/main_scene", path)
		ProjectSettings.save()
	EditorInterface.open_scene_from_path(path)
	await get_tree().process_frame
	_focus_workspace(EditorInterface.get_edited_scene_root())
	_toast("Agent created scene " + path)
	return {"scene": path, "root": root_name, "root_type": type,
		"main_scene": str(ProjectSettings.get_setting("application/run/main_scene", ""))}


func _save_scene(a: Dictionary) -> Dictionary:
	if a.get("all", false):
		EditorInterface.save_all_scenes()
		return {"saved": Array(EditorInterface.get_open_scenes())}
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"error": "no scene is open"}
	var path := str(a.get("path", ""))
	if path.is_empty():
		if root.scene_file_path.is_empty():
			return {"error": "this scene has never been saved; pass path"}
		var err := EditorInterface.save_scene()
		if err != OK:
			return {"error": "saving failed: " + error_string(err)}
		path = root.scene_file_path
	else:
		if not _is_scene_path(path):
			return {"error": "save_scene paths end in .tscn (text) or .scn (binary)"}
		EditorInterface.save_scene_as(path)
		if not FileAccess.file_exists(path) or root.scene_file_path != path:
			return {"error": "saving %s failed; get_output shows the editor's error" % path}
	_toast("Agent saved " + path)
	return {"saved": path}


func _add_node(a: Dictionary) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"error": "no scene is open; use open_scene or new_scene first"}
	var parent := _find_node(root, str(a.get("parent", ".")))
	if parent == null:
		return {"error": "no node at parent path '%s'" % a.get("parent")}
	var node: Node
	if a.has("scene"):
		var packed = load(str(a["scene"])) if ResourceLoader.exists(str(a["scene"])) else null
		if not (packed is PackedScene):
			return {"error": "%s is not a scene" % a["scene"]}
		node = packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
	else:
		var obj = _instantiate(str(a.get("type", "")))
		if not (obj is Node):
			if obj is Object and not (obj is RefCounted):
				obj.free()
			return {"error": _err if not _err.is_empty() else "%s is not a Node type" % a.get("type")}
		node = obj
	if a.has("name"):
		node.name = str(a["name"])
	var props: Dictionary = a["properties"] if a.get("properties") is Dictionary else {}
	var problems := PackedStringArray()
	for key in props:
		var e := _apply(node, str(key), props[key])
		if not e.is_empty():
			problems.append(e)
	if not problems.is_empty():
		node.free()
		return {"error": "; ".join(problems)}
	var ur := get_undo_redo()
	ur.create_action("Agent: add %s" % node.name, UndoRedo.MERGE_DISABLE, root)
	ur.add_do_method(parent, "add_child", node, true)
	ur.add_do_method(node, "set_owner", root)
	ur.add_do_reference(node)
	ur.add_undo_method(parent, "remove_child", node)
	ur.commit_action()
	_select(node)
	_toast("Agent added %s (%s)" % [node.name, node.get_class()])
	return {"path": str(root.get_path_to(node)), "name": str(node.name), "type": node.get_class()}


func _set_property(a: Dictionary) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"error": "no scene is open"}
	var node := _find_node(root, str(a.get("node", ".")))
	if node == null:
		return {"error": "no node at '%s'" % a.get("node")}
	var props := {}
	if a.get("properties") is Dictionary:
		props = a["properties"].duplicate()
	if a.has("property"):
		props[str(a["property"])] = a.get("value")
	if props.is_empty():
		return {"error": "pass property and value, or properties"}
	var changes := {}
	for key in props:
		var k := str(key)
		if not (k.get_slice(":", 0) in node):
			return {"error": "%s has no property '%s'" % [node.get_class(), k]}
		_err = ""
		var v = _convert_for(node, k, props[key])
		if not _err.is_empty():
			return {"error": "%s: %s" % [k, _err]}
		changes[k] = v
	var ur := get_undo_redo()
	ur.create_action("Agent: set %s on %s" % [", ".join(PackedStringArray(changes.keys())), node.name], UndoRedo.MERGE_DISABLE, root)
	for k in changes:
		ur.add_do_method(node, "set_indexed", NodePath(k), changes[k])
		ur.add_undo_method(node, "set_indexed", NodePath(k), node.get_indexed(NodePath(k)))
	ur.commit_action()
	_select(node)
	_toast("Agent set %s on %s" % [", ".join(PackedStringArray(changes.keys())), node.name])
	var now := {}
	for k in changes:
		now[k] = _plain(node.get_indexed(NodePath(k)))
	return {"node": str(root.get_path_to(node)), "values": now}


func _delete_node(a: Dictionary) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"error": "no scene is open"}
	var node := _find_node(root, str(a.get("node", "")))
	if node == null:
		return {"error": "no node at '%s'" % a.get("node")}
	if node == root:
		return {"error": "the scene root cannot be deleted"}
	var parent := node.get_parent()
	var owned: Array[Node] = []
	_collect_owned(node, root, owned)
	var ur := get_undo_redo()
	ur.create_action("Agent: delete %s" % node.name, UndoRedo.MERGE_DISABLE, root)
	ur.add_do_method(parent, "remove_child", node)
	ur.add_undo_method(parent, "add_child", node, true)
	ur.add_undo_method(parent, "move_child", node, node.get_index())
	for n in owned:
		ur.add_undo_method(n, "set_owner", root)
	ur.add_undo_reference(node)
	ur.commit_action()
	_toast("Agent deleted %s" % node.name)
	return {"deleted": str(a.get("node"))}


func _collect_owned(n: Node, root: Node, out: Array[Node]) -> void:
	if n.owner == root:
		out.append(n)
	for c in n.get_children():
		_collect_owned(c, root, out)


func _attach_script(a: Dictionary) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"error": "no scene is open"}
	var node := _find_node(root, str(a.get("node", ".")))
	if node == null:
		return {"error": "no node at '%s'" % a.get("node")}
	var path := _res(str(a.get("path", "")))
	if path.is_empty() or not path.ends_with(".gd"):
		return {"error": "path must be a res:// path ending in .gd"}
	if a.has("source"):
		var e := _write_script(path, str(a["source"]))
		if not e.is_empty():
			return {"error": e}
	if not ResourceLoader.exists(path):
		return {"error": "no script at " + path}
	var script = load(path)
	if not (script is Script):
		return {"error": path + " is not a script"}
	var old = node.get_script()
	var ur := get_undo_redo()
	ur.create_action("Agent: attach %s to %s" % [path.get_file(), node.name], UndoRedo.MERGE_DISABLE, root)
	ur.add_do_method(node, "set_script", script)
	ur.add_undo_method(node, "set_script", old)
	ur.commit_action()
	_select(node)
	if a.get("open_editor", true):
		EditorInterface.edit_script(script)
	_toast("Agent attached %s to %s" % [path.get_file(), node.name])
	return {"node": str(root.get_path_to(node)), "script": path}


func _write_file(a: Dictionary) -> Dictionary:
	var path := _res(str(a.get("path", "")))
	if path.is_empty():
		return {"error": "path must stay inside the project (res://...)"}
	var e := ""
	var size := 0
	if path.ends_with(".gd") and a.has("content"):
		var text := str(a["content"])
		e = _write_script(path, text)
		size = text.to_utf8_buffer().size()
	else:
		var data: PackedByteArray
		if a.has("content_base64"):
			data = Marshalls.base64_to_raw(str(a["content_base64"]))
		else:
			data = str(a.get("content", "")).to_utf8_buffer()
		size = data.size()
		e = _write_bytes(path, data)
		if e.is_empty():
			EditorInterface.get_resource_filesystem().update_file(path)
			if path in EditorInterface.get_open_scenes():
				EditorInterface.reload_scene_from_path(path)
			elif ResourceLoader.has_cached(path):
				ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_REPLACE)
	if not e.is_empty():
		return {"error": e}
	_toast("Agent wrote " + path)
	return {"path": path, "bytes": size}


func _delete_file(a: Dictionary):
	var path := _res(str(a.get("path", "")))
	if path.is_empty() or path == "res://":
		return {"error": "path must be a file inside the project (res://...)"}
	var full := ProjectSettings.globalize_path(path)
	if not FileAccess.file_exists(path):
		return {"error": "no such file: " + path}
	# An open scene keeps its tab after its file is gone, and the next save (export, record and project
	# switches all save) would write it back: close the tab first.
	var closed: int = await _close_scene_tab(path)
	if closed < 0:
		return {"error": "%s is open in the editor and its tab could not be closed; close it there first" % path}
	var err := DirAccess.remove_absolute(full)
	if err != OK:
		return {"error": "deleting %s failed: %s" % [path, error_string(err)]}
	for extra in [".import", ".uid"]:
		if FileAccess.file_exists(path + extra):
			DirAccess.remove_absolute(full + extra)
	var fs := EditorInterface.get_resource_filesystem()
	fs.scan()
	await _wait_scan(fs)
	_toast("Agent deleted " + path)
	var res := {"deleted": path}
	if closed > 0:
		res["closed_tab"] = true
	return res


## 0: the scene is not open; 1: its tab was closed (unsaved changes in it are dropped); -1: it could not be closed.
func _close_scene_tab(path: String) -> int:
	var open := false
	for r in EditorInterface.get_open_scene_roots():
		open = open or r.scene_file_path == path
	if not open:
		return 0
	var cur := EditorInterface.get_edited_scene_root()
	var back := cur.scene_file_path if cur != null and cur.scene_file_path != path else ""
	EditorInterface.open_scene_from_path(path)   # already open: this only switches to its tab
	await get_tree().process_frame
	var root := EditorInterface.get_edited_scene_root()
	if root == null or root.scene_file_path != path:
		return -1
	EditorInterface.close_scene()
	await get_tree().process_frame
	if not back.is_empty():
		EditorInterface.open_scene_from_path(back)
		await get_tree().process_frame
	return 1


func _reload(a: Dictionary):
	var fs := EditorInterface.get_resource_filesystem()
	var paths: Array = a["paths"] if a.get("paths") is Array else []
	var reloaded := []
	if paths.is_empty():
		fs.scan()
		await _wait_scan(fs)
		for s in EditorInterface.get_script_editor().get_open_scripts():
			if _reload_script_from_disk(s):
				reloaded.append(s.resource_path)
	else:
		for p in paths:
			var path := _res(str(p))
			if path.is_empty():
				continue
			fs.update_file(path)
			if ResourceLoader.has_cached(path):
				var r = load(path)
				if r is Script:
					if _reload_script_from_disk(r):
						reloaded.append(path)
				elif path in EditorInterface.get_open_scenes():
					EditorInterface.reload_scene_from_path(path)
					reloaded.append(path)
				else:
					ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_REPLACE)
					reloaded.append(path)
		await _wait_scan(fs)
	_toast("Agent rescanned the project")
	return {"scanned": true, "reloaded": reloaded}


func _wait_scan(fs: EditorFileSystem) -> void:
	await get_tree().process_frame
	var t0 := Time.get_ticks_msec()
	while fs.is_scanning() and Time.get_ticks_msec() - t0 < 60000:
		await get_tree().create_timer(0.05).timeout


func _reload_script_from_disk(s: Script) -> bool:
	if s == null or s.resource_path.is_empty() or not FileAccess.file_exists(s.resource_path):
		return false
	var text := FileAccess.get_file_as_string(s.resource_path)
	if text == s.source_code:
		return false
	var old := s.source_code
	s.source_code = text
	s.reload(true)
	_sync_script_editors(old, text)
	return true


func _run_game(a: Dictionary):
	if EditorInterface.is_playing_scene():
		EditorInterface.stop_playing_scene()
		await get_tree().create_timer(0.5).timeout
	_watch_debuggers()
	_halt = {}
	var scene := str(a.get("scene", ""))
	match str(a.get("mode", "main")):
		"main":
			var main := str(ProjectSettings.get_setting("application/run/main_scene", ""))
			if main.is_empty():
				return {"error": "the project has no main scene; use new_scene with set_main, or run_scene"}
			scene = main
			EditorInterface.play_main_scene()
		"current":
			var root := EditorInterface.get_edited_scene_root()
			if root == null:
				return {"error": "no scene is open"}
			scene = root.scene_file_path
			EditorInterface.play_current_scene()
		"custom":
			if not ResourceLoader.exists(scene):
				return {"error": "no such scene: " + scene}
			EditorInterface.play_custom_scene(scene)
	for i in 50:
		await get_tree().create_timer(0.1).timeout
		if EditorInterface.is_playing_scene():
			break
	_toast("Agent started " + scene)
	return {"playing": EditorInterface.is_playing_scene(), "scene": scene}


func _stop_game():
	var was := EditorInterface.is_playing_scene()
	EditorInterface.stop_playing_scene()
	for i in 30:
		if not EditorInterface.is_playing_scene():
			break
		await get_tree().create_timer(0.1).timeout
	return {"stopped": was, "playing": EditorInterface.is_playing_scene()}


func _screenshot(a: Dictionary):
	var target := str(a.get("target", "editor"))
	var vp: Viewport
	match target:
		"editor":
			vp = EditorInterface.get_base_control().get_viewport()
		"2d":
			vp = EditorInterface.get_editor_viewport_2d()
		"3d":
			vp = EditorInterface.get_editor_viewport_3d(0)
		_:
			return {"error": "target must be editor, 2d or 3d"}
	EditorInterface.get_base_control().queue_redraw()
	await get_tree().process_frame
	await get_tree().process_frame
	var img := vp.get_texture().get_image()
	var max_width := int(a.get("max_width", 0))
	if max_width > 0 and img.get_width() > max_width:
		img.resize(max_width, int(round(img.get_height() * float(max_width) / img.get_width())), Image.INTERPOLATE_LANCZOS)
	return {"png_base64": Marshalls.raw_to_base64(img.save_png_to_buffer()), "width": img.get_width(), "height": img.get_height()}


func _execute(a: Dictionary):
	var code := str(a.get("code", ""))
	var indent := "    " if RegEx.create_from_string("(?m)^ +\\S").search(code) else "\t"
	var src := "@tool\nextends RefCounted\n\nvar plugin: EditorPlugin\nvar undo_redo: EditorUndoRedoManager\nvar scene_root: Node\n\n"
	if RegEx.create_from_string("(?m)^func\\s+run\\s*\\(").search(code):
		src += code + "\n"
	else:
		src += "func run():\n"
		var has_body := false
		for line in code.split("\n"):
			src += indent + line + "\n"
			if not line.strip_edges().is_empty() and not line.strip_edges().begins_with("#"):
				has_body = true
		if not has_body:
			src += indent + "pass\n"
	var script := GDScript.new()
	script.source_code = src
	var err := script.reload()
	if err != OK:
		return {"error": "the code does not compile (%s); the parser's message is in the output below" % error_string(err)}
	var obj = script.new()
	obj.plugin = self
	obj.undo_redo = get_undo_redo()
	obj.scene_root = EditorInterface.get_edited_scene_root()
	var ret = await obj.run()
	return {"return": _plain(ret)}


# ---- helpers ---------------------------------------------------------------------------------------------------

func _res(path: String) -> String:
	if not path.begins_with("res://"):
		path = "res://" + path.trim_prefix("/")
	path = path.simplify_path()
	if not path.begins_with("res://") or path.contains("/../") or path.ends_with("/.."):
		return ""
	return path


## Node paths are relative to the edited scene's root and never leave it (the editor's own UI is its parent).
func _find_node(root: Node, path: String) -> Node:
	if path.is_empty() or path == "." or path == str(root.name):
		return root
	if path.begins_with("/") or path.contains(".."):
		return null
	var n := root.get_node_or_null(NodePath(path))
	if n == null and path.begins_with(str(root.name) + "/"):
		n = root.get_node_or_null(NodePath(path.substr(str(root.name).length() + 1)))
	if n != null and n != root and not root.is_ancestor_of(n):
		return null
	return n


func _is_scene_path(path: String) -> bool:
	return path.begins_with("res://") and (path.ends_with(".tscn") or path.ends_with(".scn"))


## A game run from the editor that hits a script error (a parse error when it loads a script, a runtime error) or a
## breakpoint stops in the editor's debugger and prints nothing. Each debugger session reports it with its breaked
## signal (reason) and stack_dump signal; sessions are made as games start, so this runs again before each run.
func _watch_debuggers() -> void:
	for d in EditorInterface.get_base_control().find_children("*", "ScriptEditorDebugger", true, false):
		if d.has_signal("breaked") and not d.is_connected("breaked", _on_debugger_breaked):
			d.connect("breaked", _on_debugger_breaked)
		if d.has_signal("stack_dump") and not d.is_connected("stack_dump", _on_debugger_stack):
			d.connect("stack_dump", _on_debugger_stack)
		if d.has_signal("stopped") and not d.is_connected("stopped", _on_debugger_stopped):
			d.connect("stopped", _on_debugger_stopped)


func _on_debugger_breaked(really: bool, _can_debug: bool, reason: String, _has_stack: bool) -> void:
	_halt = {"reason": reason, "stack": []} if really else {}


func _on_debugger_stack(stack: Array) -> void:
	if _halt.is_empty():
		return
	var frames := []
	for f in stack:
		if f is Dictionary:
			var fn := str(f.get("function", ""))
			frames.append("%s:%s%s" % [f.get("file", "?"), f.get("line", "?"), " in " + fn if not fn.is_empty() else ""])
	_halt["stack"] = frames


func _on_debugger_stopped() -> void:
	_halt = {}


func _debugger_state() -> Dictionary:
	if _halt.is_empty() or not EditorInterface.is_playing_scene():
		return {"halted": false}
	# "reason", not "error": a reply with an "error" key is a failed command (see _run)
	return {"halted": true, "reason": _halt.get("reason", ""), "stack": _halt.get("stack", [])}


func _select(node: Node) -> void:
	var sel := EditorInterface.get_selection()
	sel.clear()
	sel.add_node(node)
	EditorInterface.edit_node(node)
	_focus_workspace(node)


func _focus_workspace(n: Node) -> void:
	if n is Node3D:
		EditorInterface.set_main_screen_editor("3D")
	elif n is CanvasItem:
		EditorInterface.set_main_screen_editor("2D")


func _toast(text: String, severity := 0) -> void:
	EditorInterface.get_editor_toaster().push_toast(text, severity)


func _write_bytes(path: String, data: PackedByteArray) -> String:
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(path.get_base_dir()))
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return "cannot write %s: %s" % [path, error_string(FileAccess.get_open_error())]
	f.store_buffer(data)
	f.close()
	return ""


## Scripts the editor already has loaded are saved through the resource itself, so the editor's copy, its
## modification time and any open script tab stay in step and no "newer on disk" dialog comes up.
func _write_script(path: String, source: String) -> String:
	if ResourceLoader.has_cached(path):
		var s = load(path)
		if s is Script:
			var old: String = s.source_code
			s.source_code = source
			var err := ResourceSaver.save(s, path)
			if err != OK:
				return "saving %s failed: %s" % [path, error_string(err)]
			s.reload(true)
			_sync_script_editors(old, source)
			EditorInterface.get_resource_filesystem().update_file(path)
			return ""
	var e := _write_bytes(path, source.to_utf8_buffer())
	if not e.is_empty():
		return e
	EditorInterface.get_resource_filesystem().update_file(path)
	return ""


## Open script tabs keep their own text; put the new source in the tab that still shows the old one (a tab with
## unsaved edits of its own is left alone).
func _sync_script_editors(old: String, source: String) -> void:
	for ed in EditorInterface.get_script_editor().get_open_script_editors():
		var ce = ed.get_base_editor()
		if ce is CodeEdit and ce.text == old:
			ce.text = source
			ce.tag_saved_version()


func _instantiate(type: String):
	if type.is_empty():
		_err = "no type given"
		return null
	if ClassDB.class_exists(type):
		if not ClassDB.can_instantiate(type):
			_err = "%s cannot be instantiated (abstract or editor-only)" % type
			return null
		return ClassDB.instantiate(type)
	for g in ProjectSettings.get_global_class_list():
		if str(g["class"]) == type:
			var script = load(str(g["path"]))
			if script is Script and script.can_instantiate():
				return script.new()
	_err = "unknown class '%s'" % type
	return null


func _apply(obj: Object, key: String, value) -> String:
	if not (key.get_slice(":", 0) in obj):
		return "%s has no property '%s'" % [obj.get_class(), key]
	_err = ""
	var v = _convert_for(obj, key, value)
	if not _err.is_empty():
		var e := "%s: %s" % [key, _err]
		_err = ""
		return e
	obj.set_indexed(NodePath(key), v)
	return ""


## JSON values to what the property holds: [x, y] -> Vector2, "#rrggbb" -> Color, "res://..." -> the loaded
## resource, "CircleShape2D" or {"type": "CircleShape2D", "radius": 20} -> a new resource, {"$expr": "..."} -> the
## value of a Godot expression such as "Vector2(1, 2) * 3".
func _convert_for(obj: Object, key: String, value):
	if value is Dictionary and value.has("$expr"):
		return _eval(str(value["$expr"]))
	var type := typeof(obj.get_indexed(NodePath(key)))
	var hint := ""
	if not key.contains(":"):
		for p in obj.get_property_list():
			if p["name"] == key:
				type = p["type"]
				hint = str(p["hint_string"]) if not str(p["hint_string"]).is_empty() else str(p["class_name"])
				break
	return _to_type(value, type, hint)


func _to_type(value, type: int, hint: String):
	if value is Dictionary and value.has("$expr"):
		return _eval(str(value["$expr"]))
	if value == null:
		return null
	match type:
		TYPE_BOOL:
			return bool(value)
		TYPE_INT:
			return int(value)
		TYPE_FLOAT:
			return float(value)
		TYPE_STRING:
			return str(value)
		TYPE_STRING_NAME:
			return StringName(str(value))
		TYPE_NODE_PATH:
			return NodePath(str(value))
		TYPE_VECTOR2, TYPE_VECTOR2I, TYPE_VECTOR3, TYPE_VECTOR3I, TYPE_VECTOR4, TYPE_RECT2, TYPE_RECT2I, TYPE_COLOR:
			return _vec(value, type)
		TYPE_OBJECT:
			return _object(value, hint)
		TYPE_PACKED_VECTOR2_ARRAY:
			var out := PackedVector2Array()
			for p in value:
				out.append(Vector2(p[0], p[1]))
			return out
		TYPE_PACKED_COLOR_ARRAY:
			var out := PackedColorArray()
			for c in value:
				out.append(_vec(c, TYPE_COLOR))
			return out
		TYPE_PACKED_FLOAT32_ARRAY:
			return PackedFloat32Array(value)
		TYPE_PACKED_INT32_ARRAY:
			return PackedInt32Array(value)
		TYPE_PACKED_STRING_ARRAY:
			return PackedStringArray(value)
	return value


func _vec(value, type: int):
	if value is String:
		if type == TYPE_COLOR and not value.contains("("):
			return Color(value)
		return _eval(value)
	if value is Dictionary:
		var keys := ["r", "g", "b", "a"] if type == TYPE_COLOR else ["x", "y", "z", "w"]
		var arr := []
		for k in keys:
			if value.has(k):
				arr.append(value[k])
		value = arr
	if not (value is Array):
		_err = "expected an array for a " + type_string(type)
		return null
	var f: Array = value
	var need: int = {TYPE_VECTOR2: 2, TYPE_VECTOR2I: 2, TYPE_VECTOR3: 3, TYPE_VECTOR3I: 3, TYPE_VECTOR4: 4,
		TYPE_RECT2: 4, TYPE_RECT2I: 4, TYPE_COLOR: 3}[type]
	if f.size() < need:
		_err = "a %s needs %d numbers" % [type_string(type), need]
		return null
	match type:
		TYPE_VECTOR2:
			return Vector2(f[0], f[1])
		TYPE_VECTOR2I:
			return Vector2i(int(f[0]), int(f[1]))
		TYPE_VECTOR3:
			return Vector3(f[0], f[1], f[2])
		TYPE_VECTOR3I:
			return Vector3i(int(f[0]), int(f[1]), int(f[2]))
		TYPE_VECTOR4:
			return Vector4(f[0], f[1], f[2], f[3])
		TYPE_RECT2:
			return Rect2(f[0], f[1], f[2], f[3])
		TYPE_RECT2I:
			return Rect2i(int(f[0]), int(f[1]), int(f[2]), int(f[3]))
		TYPE_COLOR:
			return Color(f[0], f[1], f[2], f[3] if f.size() > 3 else 1.0)
	return null


func _object(value, hint: String):
	if value is String:
		var s: String = value
		if s.begins_with("res://") or s.begins_with("uid://"):
			if not ResourceLoader.exists(s):
				_err = "no resource at " + s
				return null
			return load(s)
		return _instantiate(s)
	if value is Dictionary and value.has("type"):
		var o = _instantiate(str(value["type"]))
		if o == null:
			return null
		for k in value:
			if str(k) == "type":
				continue
			var e := _apply(o, str(k), value[k])
			if not e.is_empty():
				_err = e
				return null
		return o
	_err = "expected a res:// path, a class name, or {\"type\": ..., <properties>} for a " + (hint if not hint.is_empty() else "resource")
	return null


func _eval(expr: String):
	var e := Expression.new()
	if e.parse(expr) != OK:
		_err = "cannot parse '%s': %s" % [expr, e.get_error_text()]
		return null
	var v = e.execute([], null, false)
	if e.has_execute_failed():
		_err = "'%s' failed: %s" % [expr, e.get_error_text()]
		return null
	return v


func _plain(v):
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return v
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(v)
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return [v.x, v.y]
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return [v.x, v.y, v.z]
		TYPE_VECTOR4, TYPE_VECTOR4I, TYPE_QUATERNION:
			return [v.x, v.y, v.z, v.w]
		TYPE_COLOR:
			return [v.r, v.g, v.b, v.a]
		TYPE_RECT2, TYPE_RECT2I:
			return [v.position.x, v.position.y, v.size.x, v.size.y]
		TYPE_DICTIONARY:
			var out := {}
			for k in v:
				out[str(k)] = _plain(v[k])
			return out
		TYPE_OBJECT:
			if not is_instance_valid(v):
				return null
			if v is Resource and not v.resource_path.is_empty() and not v.resource_path.contains("::"):
				return v.resource_path
			if v is Node and v.is_inside_tree():
				return str(v.get_path())
			return "<%s>" % v.get_class()
	if v is Array or typeof(v) >= TYPE_PACKED_BYTE_ARRAY:
		var out := []
		for x in v:
			out.append(_plain(x))
		return out
	return var_to_str(v)
