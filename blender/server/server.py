# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 Anirban Kar and Contributors
#
# This file runs inside Blender and uses its Python API (bpy), so it is licensed as Blender's scripts are asked to be
# when they are published: under the GNU General Public License, version 3 or (at your option) any later version.
# See LICENSE beside it. The rest of the pithagoras-blender extension is Apache-2.0.
"""Headless Blender server for the pithagoras-blender extension. Runs inside `blender -b --python server.py`.

One HTTP port on the address it is given (`BLENDER_SERVER_HOST`, which the extension sets to 0.0.0.0 of the
container's own network, which only the Pithagoras portal reaches): the API of the extension's viewer (`/api/...`),
the files it shows (`/files/...`) and MCP (`POST /mcp`, Streamable HTTP with a JSON reply to each POST, no session). The viewer's page itself is the extension's, served by the portal, not from here.
Every route asks for `Authorization: Bearer <token>`: the portal's proxy adds it to what the person's browser asks,
and the extension's MCP client sends it. There is no sign-in page and no cookie: the person signs in to the portal,
never to this server.

All work with bpy happens on Blender's main thread, which bpy needs: the HTTP threads queue it there (`run_on_main`)
and the main thread runs it between waits. `execute_code` runs arbitrary Python in this process, as the container's
unprivileged user, which is why the token is required and the port is on the container's own network, which only the
portal reaches; and why nothing this server answers runs as the portal's page (the portal's proxy sandboxes every
answer).

Environment:
    BLENDER_SERVER_TOKEN   required; the server refuses to start without it
    BLENDER_SERVER_HOST    default 127.0.0.1
    BLENDER_SERVER_PORT    default 3870
    BLENDER_DATA_DIR       default /data (scenes, renders, exports)
"""
import base64
import collections
import contextlib
import hmac
import http.server
import io
import json
import math
import os
import queue
import select
import signal
import socket
import sys
import threading
import time
import traceback
import urllib.parse

import bpy
import mathutils

TOKEN = os.environ.get("BLENDER_SERVER_TOKEN", "")
HOST = os.environ.get("BLENDER_SERVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("BLENDER_SERVER_PORT", "3870"))
DATA = os.environ.get("BLENDER_DATA_DIR", "/data")
AUTO_PREVIEW = os.environ.get("BLENDER_AUTO_PREVIEW", "1") != "0"
NVOPTIX = "/usr/share/nvidia/nvoptix.bin"   # the OptiX denoiser's weights, from the NVIDIA driver

# shared with the viewer thread (plain data only; the viewer never touches bpy)
STATE = {"project": {"path": None, "name": "untitled", "dirty": False},
         "preview": None, "preview_at": 0, "scene_at": 0, "renders": collections.deque(maxlen=24),
         "log": collections.deque(maxlen=60), "scene": {}, "busy": None}
STATE_LOCK = threading.Lock()

# Work the HTTP threads need done with bpy runs here, on Blender's main thread, which waits for it (see __main__).
JOBS = queue.Queue()
WAKE_R, WAKE_W = socket.socketpair()   # a byte on WAKE_W wakes the main loop's select() immediately
WAKE_R.setblocking(False)


def run_on_main(fn, timeout=900):
    done, box = threading.Event(), {}

    def job():
        try:
            box["result"] = fn()
        except Exception as e:
            box["error"] = f"{type(e).__name__}: {e}"
            log(f"viewer job failed: {e}")
        finally:
            done.set()

    JOBS.put(job)
    try:
        WAKE_W.send(b"x")
    except OSError:
        pass
    if not done.wait(timeout):
        return {"error": "timed out waiting for Blender"}
    return box


def drain_jobs():
    try:
        while WAKE_R.recv(4096):
            pass
    except (BlockingIOError, OSError):
        pass
    while True:
        try:
            job = JOBS.get_nowait()
        except queue.Empty:
            return
        job()


def log(*a):
    line = time.strftime("%H:%M:%S") + " " + " ".join(str(x) for x in a)
    print(line, flush=True)
    with STATE_LOCK:
        STATE["log"].appendleft(line)


def inside_data(path):
    """Resolve a user path under DATA so requests cannot write or read elsewhere by accident."""
    full = os.path.realpath(os.path.join(DATA, path))
    if not (full == os.path.realpath(DATA) or full.startswith(os.path.realpath(DATA) + os.sep)):
        raise ValueError(f"path must stay inside {DATA}: {path}")
    os.makedirs(os.path.dirname(full), exist_ok=True)
    return full


# ---- GPU setup ---------------------------------------------------------------------------------------------
def setup_gpu():
    prefs = bpy.context.preferences.addons["cycles"].preferences
    chosen = None
    for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.refresh_devices()
        gpus = [d for d in prefs.devices if d.type == kind]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == kind
            chosen = kind
            break
    if chosen is None:
        prefs.compute_device_type = "NONE"
    return {"backend": chosen or "CPU", "devices": [d.name for d in prefs.devices if d.use]}


GPU = None


# ---- commands ----------------------------------------------------------------------------------------------
def obj_summary(o):
    return {"name": o.name, "type": o.type, "location": [round(v, 4) for v in o.location],
            "rotation": [round(v, 4) for v in o.rotation_euler], "scale": [round(v, 4) for v in o.scale],
            "visible": o.visible_get()}


def cmd_ping(p):
    return {"blender": bpy.app.version_string, "gpu": GPU, "file": bpy.data.filepath or None}


def cmd_get_scene_info(p):
    s = bpy.context.scene
    return {"name": s.name, "file": bpy.data.filepath or None, "engine": s.render.engine,
            "frame_range": [s.frame_start, s.frame_end], "resolution": [s.render.resolution_x, s.render.resolution_y],
            "object_count": len(s.objects), "objects": [obj_summary(o) for o in list(s.objects)[:200]],
            "materials": len(bpy.data.materials)}


def cmd_get_object_info(p):
    o = bpy.data.objects.get(p["name"])
    if o is None:
        raise ValueError(f"no object named {p['name']!r}")
    info = obj_summary(o)
    info["materials"] = [m.name for m in getattr(o.data, "materials", []) if m] if o.data else []
    if o.type == "MESH":
        info["mesh"] = {"vertices": len(o.data.vertices), "polygons": len(o.data.polygons)}
    return info


def cmd_execute_code(p):
    out = io.StringIO()
    ns = {"bpy": bpy, "__name__": "__blender_server__"}
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        exec(compile(p["code"], "<request>", "exec"), ns)
    return {"output": out.getvalue()[-20000:]}


PROJECTS = "scenes"   # projects live in /data/scenes/<name>.blend; thumbnails in /data/scenes/.thumbs/


def project_name(name):
    """Turn a user-typed name into a safe file name under /data/scenes."""
    name = str(name or "").strip()
    if name.lower().endswith(".blend"):
        name = name[:-6]
    name = "".join(c for c in name if c.isalnum() or c in " _-.").strip(" .")
    if not name:
        raise ValueError("project name must contain letters or digits")
    return name[:80]


def set_project(path=None, dirty=False):
    rel = os.path.relpath(path, DATA) if path else None
    with STATE_LOCK:
        STATE["project"] = {"path": rel, "name": os.path.splitext(os.path.basename(rel))[0] if rel else "untitled",
                            "dirty": dirty}


def mark_dirty():
    with STATE_LOCK:
        STATE["project"]["dirty"] = True


def thumb_path(rel):
    return os.path.join(DATA, PROJECTS, ".thumbs", os.path.splitext(os.path.basename(rel))[0] + ".jpg")


def make_thumb(rel):
    try:
        render_preview("thumbnail", out=thumb_path(rel), size=(384, 216), fmt="JPEG")
    except Exception as e:
        log(f"thumbnail failed: {e}")


def list_projects():
    root = os.path.join(DATA, PROJECTS)
    os.makedirs(root, exist_ok=True)
    out = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            if f.endswith(".blend"):
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, DATA)
                st = os.stat(full)
                th = thumb_path(rel)
                out.append({"path": rel, "name": os.path.splitext(f)[0], "bytes": st.st_size, "modified": st.st_mtime,
                            "thumb": os.path.relpath(th, DATA) if os.path.exists(th) else None})
    out.sort(key=lambda x: -x["modified"])
    return out


def cmd_new_scene(p):
    VP.update(scene=None, cam=None, dirty=True, mode=None)
    bpy.ops.wm.read_factory_settings(use_empty=bool(p.get("empty", True)))
    global GPU
    GPU = setup_gpu()   # factory reset also resets preferences
    set_project(None, dirty=False)
    if p.get("name"):   # a named new project is saved straight away so it shows up in the workspace list
        return cmd_save_file({"path": f"{PROJECTS}/{project_name(p['name'])}.blend"})
    return {"ok": True}


def cmd_open_file(p):
    VP.update(scene=None, cam=None, dirty=True, mode=None)
    path = inside_data(p["path"])
    if not os.path.isfile(path):
        raise FileNotFoundError(f"no such project: {p['path']}")
    bpy.ops.wm.open_mainfile(filepath=path)
    set_project(path, dirty=False)
    rel = os.path.relpath(path, DATA)
    if not os.path.exists(thumb_path(rel)):
        make_thumb(rel)
    return {"file": bpy.data.filepath}


def cmd_save_file(p):
    if VP["scene"] is not None and VP["scene"].name in bpy.data.scenes:
        cam = VP["cam"]
        bpy.data.scenes.remove(VP["scene"])
        if cam is not None and cam.name in bpy.data.objects:
            data = cam.data
            bpy.data.objects.remove(cam)
            bpy.data.cameras.remove(data)
    VP.update(scene=None, cam=None, dirty=True, mode=None)
    path = inside_data(p["path"])
    bpy.ops.wm.save_as_mainfile(filepath=path)
    set_project(path, dirty=False)
    make_thumb(os.path.relpath(path, DATA))
    return {"file": path}


def cmd_render(p):
    s = bpy.context.scene
    engine = p.get("engine", "CYCLES").upper()
    available = {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    eevee = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in available else "BLENDER_EEVEE"   # name changed across versions
    s.render.engine = {"CYCLES": "CYCLES", "EEVEE": eevee, "WORKBENCH": "BLENDER_WORKBENCH"}.get(engine, engine)
    if s.render.engine == "CYCLES":
        s.cycles.device = "GPU" if GPU and GPU["backend"] != "CPU" and p.get("device", "GPU") == "GPU" else "CPU"
        if "samples" in p:
            s.cycles.samples = int(p["samples"])
    if "resolution" in p:
        s.render.resolution_x, s.render.resolution_y = (int(v) for v in p["resolution"])
        s.render.resolution_percentage = 100
    if "frame" in p:
        s.frame_set(int(p["frame"]))
    if s.camera is None:
        raise ValueError("scene has no active camera")
    out = inside_data(p.get("path", f"renders/render_{int(time.time())}.png"))
    s.render.image_settings.file_format = "PNG"
    s.render.filepath = out
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    res = {"path": out, "engine": s.render.engine, "seconds": round(time.time() - t0, 2),
           "device": s.cycles.device if s.render.engine == "CYCLES" else "GPU (OpenGL/EGL)"}
    if p.get("return_image", False):
        with open(out, "rb") as f:
            res["png_base64"] = base64.b64encode(f.read()).decode()
    return res


def cmd_export(p):
    fmt = p.get("format", "glb").lower()
    path = inside_data(p["path"])
    if fmt in ("glb", "gltf"):
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB" if fmt == "glb" else "GLTF_SEPARATE")
    elif fmt == "fbx":
        bpy.ops.export_scene.fbx(filepath=path)
    elif fmt == "obj":
        bpy.ops.wm.obj_export(filepath=path)
    elif fmt in ("usd", "usdc", "usda"):
        bpy.ops.wm.usd_export(filepath=path)
    elif fmt == "stl":
        bpy.ops.wm.stl_export(filepath=path)
    else:
        raise ValueError(f"unsupported format {fmt!r}")
    return {"path": path, "bytes": os.path.getsize(path)}


def frame_camera_for_preview(scene):
    """A temporary camera aimed at everything visible, for scenes that have no camera yet."""
    objs = [o for o in scene.objects if o.type not in ("CAMERA", "LIGHT") and o.visible_get()]
    pts = [o.matrix_world @ mathutils.Vector(c) for o in objs for c in o.bound_box] or [mathutils.Vector((0, 0, 0))]
    lo = mathutils.Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = mathutils.Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center, radius = (lo + hi) / 2, max((hi - lo).length / 2, 1.0)
    cam_data = bpy.data.cameras.new("__preview_cam")
    cam = bpy.data.objects.new("__preview_cam", cam_data)
    scene.collection.objects.link(cam)
    direction = mathutils.Vector((1.0, -1.2, 0.8)).normalized()
    cam.location = center + direction * radius * 3.0
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.lens = 40
    return cam


def render_preview(reason, out=None, size=(960, 540), fmt="PNG"):
    """Fast Workbench render of the current scene: /data/previews/latest.png for the viewer, or `out` (thumbnails)."""
    is_preview = out is None
    s = bpy.context.scene
    saved = (s.render.engine, s.render.resolution_x, s.render.resolution_y, s.render.resolution_percentage,
             s.render.filepath, s.camera)
    temp_cam = None
    try:
        if s.camera is None:
            temp_cam = frame_camera_for_preview(s)
            s.camera = temp_cam
        s.render.engine = "BLENDER_WORKBENCH"
        s.display.shading.light = "STUDIO"
        s.display.shading.color_type = "MATERIAL"
        s.render.resolution_x, s.render.resolution_y, s.render.resolution_percentage = size[0], size[1], 100
        out = out or os.path.join(DATA, "previews", "latest.png")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        saved_fmt = s.render.image_settings.file_format
        s.render.image_settings.file_format = fmt
        s.render.filepath = out
        bpy.ops.render.render(write_still=True)
        s.render.image_settings.file_format = saved_fmt
        if is_preview:
            with STATE_LOCK:
                STATE["preview"], STATE["preview_at"] = out, time.time()
    except Exception as e:
        log(f"preview failed: {e}")
    finally:
        (s.render.engine, s.render.resolution_x, s.render.resolution_y, s.render.resolution_percentage,
         s.render.filepath, s.camera) = saved
        if temp_cam is not None:
            cam_data = temp_cam.data
            bpy.data.objects.remove(temp_cam)
            bpy.data.cameras.remove(cam_data)


def action_fcurves(action):
    try:
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    yield from bag.fcurves
    except AttributeError:   # Blender before layered actions
        yield from action.fcurves


def action_keys(action):
    return {int(round(k.co.x)) for fc in action_fcurves(action) for k in fc.keyframe_points}


def action_fits(action, obj):
    """Was this action made for this object? Its slot is named after the object, or (for imported and older
    files) it animates bones this armature has."""
    try:
        if any(sl.identifier == "OB" + obj.name for sl in action.slots):
            return True
    except AttributeError:
        pass
    if obj.type == "ARMATURE":
        for fc in action_fcurves(action):
            if fc.data_path.startswith('pose.bones["'):
                return fc.data_path[12:].split('"', 1)[0] in obj.data.bones
    return False


def action_summary(action):
    start, end = (int(round(v)) for v in action.frame_range)
    fcs = list(action_fcurves(action))[:4000]
    # a loop authored the usual way repeats its first frame at the end; the browser skips that repeat when cycling
    loops = end > start and bool(fcs) and all(abs(fc.evaluate(start) - fc.evaluate(end)) < 1e-4 for fc in fcs)
    return {"name": action.name, "start": start, "end": end, "loops": loops, "keys": sorted(action_keys(action))[:400]}


def animation_info(scene):
    """Frame range, rate and keyframes for the browser's timeline, and for each object that has more than one
    action made for it, the list to choose from."""
    objs = [o for o in scene.objects if not o.name.startswith("__")]
    used, targets = set(), []
    for o in objs:
        own = o.animation_data.action if o.animation_data else None
        for owner in (o, o.data, getattr(o.data, "shape_keys", None)):
            ad = getattr(owner, "animation_data", None)
            if ad and ad.action:
                used.add(ad.action)
        fitting = [a for a in bpy.data.actions if a == own or action_fits(a, o)]
        if len(fitting) > 1:
            targets.append({"object": o.name, "active": own.name if own else None,
                            "actions": [action_summary(a) for a in sorted(fitting, key=lambda a: a.name)]})
    keys = set().union(*(action_keys(a) for a in used)) if used else set()
    return {"start": scene.frame_start, "end": scene.frame_end, "frame": scene.frame_current,
            "fps": round(scene.render.fps / scene.render.fps_base, 3),
            "animated": bool(keys) or bool(targets) or any(
                o.rigid_body or o.particle_systems or
                any(m.type in ("CLOTH", "FLUID", "SOFT_BODY", "OCEAN", "DYNAMIC_PAINT") for m in o.modifiers) for o in objs),
            "keys": sorted(keys)[:600], "targets": targets[:20]}


def summarize_scene(reason):
    """Object list (with bounds) for the outliner, and the scene's bounds for framing the live view."""
    try:
        objs, pts_all = [], []
        # the collection tree, and for each object the first collection that holds it (None = the scene's own)
        collections, home = [], {}

        def walk(coll, parent):
            for o in coll.objects:
                home.setdefault(o.name, parent)
            for child in coll.children:
                collections.append({"name": child.name, "parent": parent, "hidden": child.hide_render})
                walk(child, child.name)

        walk(bpy.context.scene.collection, None)
        for o in bpy.context.scene.objects:
            if o.name.startswith("__"):
                continue
            pts = [o.matrix_world @ mathutils.Vector(c) for c in o.bound_box] if o.type not in ("CAMERA", "LIGHT", "EMPTY") else [o.matrix_world.translation.copy()]
            lo = [min(p[i] for p in pts) for i in range(3)]
            hi = [max(p[i] for p in pts) for i in range(3)]
            if o.type not in ("CAMERA", "LIGHT", "EMPTY"):
                pts_all += pts
            objs.append({"name": o.name, "type": o.type, "location": [round(v, 3) for v in o.location],
                         "parent": o.parent.name if o.parent else None, "collection": home.get(o.name),
                         "hidden": o.hide_render,
                         "center": [round((lo[i] + hi[i]) / 2, 3) for i in range(3)],
                         "size": round(max(max(hi[i] - lo[i] for i in range(3)), 0.5), 3)})
        objs.sort(key=lambda o: ({"CAMERA": 0, "LIGHT": 1}.get(o["type"], 2), o["name"]))
        if pts_all:
            lo = [min(p[i] for p in pts_all) for i in range(3)]; hi = [max(p[i] for p in pts_all) for i in range(3)]
            bounds = {"center": [round((lo[i] + hi[i]) / 2, 3) for i in range(3)],
                      "size": round(max(max(hi[i] - lo[i] for i in range(3)), 1.0), 3)}
        else:
            bounds = {"center": [0, 0, 0], "size": 4}
        with STATE_LOCK:
            STATE["scene_at"] = time.time()
            STATE["scene"] = {"objects": objs[:500], "collections": collections[:200], "bounds": bounds, "reason": reason,
                              "anim": animation_info(bpy.context.scene)}
    except Exception as e:
        log(f"scene summary failed: {e}")


def blender_from_three(v):
    """glTF/three.js is Y-up; Blender is Z-up. (x, y, z)_three -> (x, -z, y)_blender."""
    return mathutils.Vector((v[0], -v[2], v[1]))


def place_camera(cam, view):
    if view.get("coords") == "blender":
        pos, target = mathutils.Vector(view["position"]), mathutils.Vector(view["target"])
    else:
        pos, target = blender_from_three(view["position"]), blender_from_three(view["target"])
    cam.location = pos
    cam.rotation_euler = (target - pos).to_track_quat("-Z", "Y").to_euler()
    cam.data.sensor_fit = "VERTICAL"
    cam.data.angle_y = math.radians(float(view.get("fov", 40)))


def view_resolution(view, width=None):
    w = int(width or view.get("width", 1280))
    h = int(round(w / max(0.2, float(view.get("aspect", 16 / 9))) / 2) * 2)
    return [w, h]


VIEWPORT_JPG = os.path.join(DATA, "viewport", "live.jpg")


VP = {"scene": None, "cam": None, "dirty": True, "mode": None}


def viewport_scene(mode):
    """A hidden scene that links the user's objects and owns its own camera and engine settings.

    Orbiting only moves VP["cam"], so nothing the renderer has cached is invalidated: Cycles keeps the scene on the
    GPU between frames (use_persistent_data) and EEVEE keeps its shaders. The user's scene is never modified.
    Rebuilt only after an edit (dirty) or a shading-mode change."""
    src = bpy.context.scene
    vp = VP["scene"]
    if vp is not None and vp.name not in bpy.data.scenes:
        vp = None
    if vp is None or VP["dirty"]:
        if vp is not None:
            cam = VP["cam"]
            bpy.data.scenes.remove(vp)
            if cam is not None and cam.name in bpy.data.objects:
                data = cam.data
                bpy.data.objects.remove(cam)
                bpy.data.cameras.remove(data)
        vp = bpy.data.scenes.new("__viewport")
        for coll in src.collection.children:
            vp.collection.children.link(coll)
        for obj in src.collection.objects:
            if not obj.name.startswith("__"):
                vp.collection.objects.link(obj)
        vp.world = src.world
        vp.frame_current = src.frame_current
        for k in ("view_transform", "look", "exposure", "gamma"):
            setattr(vp.view_settings, k, getattr(src.view_settings, k))
        vp.display_settings.display_device = src.display_settings.display_device
        cam = bpy.data.objects.new("__viewport_cam", bpy.data.cameras.new("__viewport_cam"))
        vp.collection.objects.link(cam)
        vp.camera = cam
        vp.render.resolution_percentage = 100
        vp.render.image_settings.file_format = "JPEG"
        vp.render.image_settings.quality = 82
        vp.render.filepath = VIEWPORT_JPG
        VP.update(scene=vp, cam=cam, dirty=False, mode=None)
    if VP["mode"] != mode:
        if mode in ("RENDERED", "MATERIAL"):
            # Both are Cycles kept resident on the GPU (use_persistent_data): a camera move costs ~25 ms.
            # MATERIAL trades light bounces for speed; RENDERED uses the scene's own Cycles settings.
            # (EEVEE was measured at ~530 ms fixed overhead per headless frame, so it is not used here.)
            vp.render.engine = "CYCLES"
            vp.render.use_persistent_data = True
            vp.cycles.device = "GPU" if GPU and GPU["backend"] != "CPU" else "CPU"
            vp.cycles.use_denoising = True
            try:
                vp.cycles.denoiser = denoiser()
                vp.cycles.denoising_use_gpu = True
            except (AttributeError, TypeError):
                pass
            vp.cycles.use_adaptive_sampling = True
            sc = src.cycles
            if mode == "MATERIAL":
                vp.cycles.max_bounces, vp.cycles.diffuse_bounces, vp.cycles.glossy_bounces = 3, 1, 2
                vp.cycles.transmission_bounces, vp.cycles.transparent_max_bounces = 2, 4
                vp.cycles.caustics_reflective = vp.cycles.caustics_refractive = False
                if hasattr(vp.cycles, "use_fast_gi"):
                    vp.cycles.use_fast_gi = True
            else:
                for k in ("max_bounces", "diffuse_bounces", "glossy_bounces", "transmission_bounces",
                          "volume_bounces", "transparent_max_bounces", "caustics_reflective", "caustics_refractive"):
                    if hasattr(sc, k):
                        setattr(vp.cycles, k, getattr(sc, k))
                if hasattr(vp.cycles, "use_fast_gi"):
                    vp.cycles.use_fast_gi = getattr(sc, "use_fast_gi", False)
        else:
            vp.render.engine = "BLENDER_WORKBENCH"
            vp.display.shading.light = "STUDIO"
            vp.display.shading.color_type = "MATERIAL"
        VP["mode"] = mode
    return vp


FRAME_HOLD = {"frame": None}   # the scene's own frame while the viewport is showing a different one
ACTION_HOLD = {}               # object name -> (its own action name, slot identifier, had animation data) while the
                               # viewport is showing a different action on it


def assign_action(obj, action, slot_identifier=None):
    ad = obj.animation_data or obj.animation_data_create()
    ad.action = action
    if action is not None and hasattr(ad, "action_slot"):
        wanted = [sl for sl in ad.action_suitable_slots if sl.identifier == slot_identifier]
        if wanted:
            ad.action_slot = wanted[0]
        elif ad.action_slot is None and len(ad.action_suitable_slots):
            ad.action_slot = ad.action_suitable_slots[0]


def restore_action(name):
    own, slot, had_data = ACTION_HOLD.pop(name)
    obj = bpy.data.objects.get(name)
    if obj is None:
        return
    if not had_data:
        obj.animation_data_clear()
    else:
        assign_action(obj, bpy.data.actions.get(own) if own else None, slot)


def show_actions(wanted):
    """Play other actions on objects for the viewport: {object name: action name}. Anything not asked for goes
    back to the object's own action."""
    wanted = {name: bpy.data.actions.get(action) for name, action in wanted.items()}
    wanted = {name: action for name, action in wanted.items() if action is not None and name in bpy.data.objects}
    for name in [n for n in ACTION_HOLD if n not in wanted]:
        restore_action(name)
    for name, action in wanted.items():
        obj = bpy.data.objects[name]
        ad = obj.animation_data
        if ad and ad.action == action:
            continue
        if name not in ACTION_HOLD:
            slot = ad.action_slot.identifier if ad and getattr(ad, "action_slot", None) else None
            ACTION_HOLD[name] = (ad.action.name if ad and ad.action else None, slot, ad is not None)
        assign_action(obj, action)


def release_frame():
    """Put the scene back on its own frame and actions after the viewport showed others. Called before every
    command and every non-viewport job, so the timeline in the browser never changes what they see or save."""
    f = FRAME_HOLD["frame"]
    if f is None and not ACTION_HOLD:
        return
    FRAME_HOLD["frame"] = None
    for name in list(ACTION_HOLD):
        restore_action(name)
    scene = bpy.context.scene
    scene.frame_set(scene.frame_current if f is None else f)


def render_viewport(view):
    """One live-viewport frame from the browser's viewpoint. Only the camera, resolution, sample count and frame
    change between frames, which is what keeps them fast.

    Rendering a scene other than the active one takes its frame from the active scene, so showing frame N means
    moving the active scene to N for the render; release_frame() moves it back."""
    mode = view.get("shading", "SOLID").upper()
    t0 = time.time()
    vp = viewport_scene(mode)
    show_actions(view.get("actions") or {})
    if view.get("frame") is not None:
        main, frame = bpy.context.scene, int(view["frame"])
        own = main.frame_current if FRAME_HOLD["frame"] is None else FRAME_HOLD["frame"]
        FRAME_HOLD["frame"] = own if frame != own else None
        main.frame_current = frame
    place_camera(VP["cam"], view)
    vp.render.resolution_x, vp.render.resolution_y = view_resolution(view)
    samples = max(1, int(view.get("samples", 1)))
    if mode in ("RENDERED", "MATERIAL"):
        vp.cycles.samples = samples
    os.makedirs(os.path.dirname(VIEWPORT_JPG), exist_ok=True)
    try:
        bpy.ops.render.render(write_still=True, scene=vp.name)
    except RuntimeError as e:
        if mode in ("RENDERED", "MATERIAL") and "denoiser" in str(e).lower() and vp.cycles.denoiser != "OPENIMAGEDENOISE":
            log("OptiX denoiser unavailable, switching the viewport to OpenImageDenoise")
            DENOISE["fallback"] = True
            vp.cycles.denoiser = "OPENIMAGEDENOISE"
            bpy.ops.render.render(write_still=True, scene=vp.name)
        else:
            raise
    with open(VIEWPORT_JPG, "rb") as f:
        data = f.read()
    took = round(time.time() - t0, 3)
    with STATE_LOCK:
        STATE["viewport_view"] = dict(view)
        STATE["viewport_at"] = time.time()
        STATE["viewport_ms"] = int(took * 1000)
    return data, took


def refresh_viewport(reason):
    """After an edit, rebuild the viewport scene and re-render whatever the browser is looking at."""
    VP["dirty"] = True
    with STATE_LOCK:
        view = STATE.get("viewport_view")
    if view:
        try:
            render_viewport(dict(view, width=view.get("full_width", view.get("width", 1280)),
                                 samples=view.get("rest_samples", view.get("samples", 1))))
        except Exception as e:
            log(f"viewport refresh failed: {e}")


def job_render_view(view):
    """Render from the browser's current viewpoint and frame without disturbing the scene's own camera or frame."""
    release_frame()
    s = bpy.context.scene
    own_frame = s.frame_current
    saved_cam = s.camera
    cam_data = bpy.data.cameras.new("__view_cam")
    cam = bpy.data.objects.new("__view_cam", cam_data)
    s.collection.objects.link(cam)
    try:
        place_camera(cam, view)
        s.camera = cam
        show_actions(view.get("actions") or {})
        params = {"engine": view.get("engine", "CYCLES"), "samples": int(view.get("samples", 64)),
                  "resolution": view_resolution(view), "path": f"renders/view_{int(time.time())}.png"}
        params["frame"] = int(view["frame"]) if view.get("frame") is not None else own_frame
        res = cmd_render(params)
        res["frame"] = s.frame_current
        with STATE_LOCK:
            STATE["renders"].appendleft({"rel": os.path.relpath(res["path"], DATA), "engine": res["engine"],
                                         "seconds": res["seconds"]})
        log(f"render from browser view ok in {res['seconds']}s")
        return res
    finally:
        s.camera = saved_cam
        bpy.data.objects.remove(cam)
        bpy.data.cameras.remove(cam_data)
        FRAME_HOLD["frame"] = own_frame
        release_frame()


def job_set_camera(view):
    """Move the scene's camera (creating one if needed) to the browser's viewpoint."""
    release_frame()
    s = bpy.context.scene
    cam = s.camera
    if cam is None:
        cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
        s.collection.objects.link(cam)
        s.camera = cam
    place_camera(cam, view)
    s.render.resolution_x, s.render.resolution_y = view_resolution(view, s.render.resolution_x)
    log(f"scene camera moved to browser view ({cam.name})")
    after_scene_change("set_camera")
    return {"camera": cam.name, "location": [round(v, 3) for v in cam.location]}


def cmd_preview(p):
    render_preview("requested")
    res = {"path": STATE["preview"]}
    if p.get("return_image", False):
        with open(STATE["preview"], "rb") as f:
            res["png_base64"] = base64.b64encode(f.read()).decode()
    return res


def cmd_list_projects(p):
    with STATE_LOCK:
        current = dict(STATE["project"])
    return {"current": current, "projects": list_projects()}


COMMANDS = {
    "ping": cmd_ping, "get_scene_info": cmd_get_scene_info, "get_object_info": cmd_get_object_info,
    "execute_code": cmd_execute_code, "new_scene": cmd_new_scene, "open_file": cmd_open_file,
    "save_file": cmd_save_file, "render": cmd_render, "export": cmd_export, "preview": cmd_preview,
    "list_projects": cmd_list_projects,
}
CHANGES_SCENE = {"execute_code", "new_scene", "open_file"}


# ---- the HTTP port: the viewer's API, files, MCP ------------------------------------------------------------
DENOISE = {"fallback": False}   # set when the viewport's OptiX denoiser failed and it switched to OpenImageDenoise


def denoiser():
    """The viewport's denoiser: OptiX where Cycles runs on OptiX and the driver's OptiX weights are here, until it
    failed once; OpenImageDenoise otherwise."""
    optix = GPU and GPU["backend"] == "OPTIX" and os.path.exists(NVOPTIX) and not DENOISE["fallback"]
    return "OPTIX" if optix else "OPENIMAGEDENOISE"


# ---------- MCP over Streamable HTTP: POST /mcp, Authorization: Bearer <token> ----------
MCP_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
MCP_PATH_NOTE = "Paths are relative to the server's data folder; projects live in scenes/<name>.blend."
MCP_INSTRUCTIONS = (
    "Tools for a headless Blender 5 server with GPU rendering. Build and edit scenes with execute_code (bpy), check "
    "your work with preview (it returns an image), render with render, and keep projects in scenes/ with "
    "save_file / open_file / list_projects. The person watches the scene in the Blender panel beside the chat, "
    "which refreshes after every scene change; its timeline plays the scene's frame range, so set frame_start / "
    "frame_end / fps when you animate. One Blender is shared by every chat and the person: check list_projects "
    "before replacing the open scene. " + MCP_PATH_NOTE)


def _obj(props, req=()):
    return {"type": "object", "properties": props, "required": list(req)}


MCP_TOOLS = [
    ("ping", "Blender version, GPU devices and the open file.", _obj({})),
    ("get_scene_info", "Current scene: engine, resolution, frame range and up to 200 objects with transforms.", _obj({})),
    ("get_object_info", "Transform, dimensions, materials and mesh stats of one object.",
     _obj({"name": {"type": "string", "description": "Object name"}}, ["name"])),
    ("execute_code", "Run Python in Blender with `bpy` available; returns whatever it prints. Use this to build or "
     "change anything in the scene. The live browser view refreshes afterwards.",
     _obj({"code": {"type": "string", "description": "Python source"},
           "read_only": {"type": "boolean", "default": False, "description": "Set true when the code only inspects "
                         "the scene: skips the unsaved-changes mark and the browser view refresh"}}, ["code"])),
    ("preview", "Quick Workbench render from the scene camera (or an automatic view if there is none), returned as "
     "an image. Use it to check your work after edits.", _obj({})),
    ("render", "Full render from the scene camera, saved under renders/ unless `path` is given. Returns the image "
     "unless return_image is false.",
     _obj({"engine": {"type": "string", "enum": ["CYCLES", "EEVEE", "WORKBENCH"], "default": "CYCLES"},
           "samples": {"type": "integer", "description": "Cycles samples"},
           "resolution": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
           "frame": {"type": "integer"}, "path": {"type": "string", "description": "Output .png path. " + MCP_PATH_NOTE},
           "return_image": {"type": "boolean", "default": True}})),
    ("export", "Export the scene to a file under the data folder.",
     _obj({"format": {"type": "string", "enum": ["glb", "gltf", "fbx", "obj", "usd", "stl"]},
           "path": {"type": "string", "description": "Output path, e.g. exports/scene.glb. " + MCP_PATH_NOTE}},
          ["format", "path"])),
    ("list_projects", "Projects (.blend files) in scenes/, newest first, plus the open project and whether it has "
     "unsaved changes.", _obj({})),
    ("open_file", "Open a .blend, replacing the current scene (unsaved changes are lost; check list_projects first).",
     _obj({"path": {"type": "string", "description": "e.g. scenes/island.blend. " + MCP_PATH_NOTE}}, ["path"])),
    ("save_file", "Save the scene to a .blend (also makes it the open project and writes its thumbnail).",
     _obj({"path": {"type": "string", "description": "e.g. scenes/my_project.blend. " + MCP_PATH_NOTE}}, ["path"])),
    ("new_scene", "Start a new scene, replacing the current one (unsaved changes are lost). With `name` it is saved "
     "straight away as scenes/<name>.blend.",
     _obj({"name": {"type": "string"},
           "empty": {"type": "boolean", "default": True, "description": "false = Blender's default cube scene"}})),
]
MCP_TOOL_NAMES = {n for n, _, _ in MCP_TOOLS}


def mcp_call_tool(name, args):
    """Run one tool through the same path as a TCP command (token check, busy state, log, live-view refresh)."""
    if name in ("render", "preview"):
        args = dict(args, return_image=args.get("return_image", True))
    box = run_on_main(lambda: handle({"token": TOKEN, "type": name, "params": args}))
    r = box.get("result") or {"status": "error", "message": box.get("error", "no reply")}
    if r.get("status") != "success":
        return {"content": [{"type": "text", "text": r.get("message", json.dumps(r))}], "isError": True}
    result = r["result"]
    png = result.pop("png_base64", None) if isinstance(result, dict) else None
    if name == "execute_code" and isinstance(result, dict) and set(result) == {"output"}:
        content = [{"type": "text", "text": result["output"] or "(no output)"}]
    else:
        content = [{"type": "text", "text": json.dumps(result, indent=1)}]
    if png:
        content.append({"type": "image", "data": png, "mimeType": "image/png"})
    return {"content": content, "isError": False}


def mcp_dispatch(msg):
    """One JSON-RPC message in, the reply dict out (None for notifications)."""
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    try:
        if method == "initialize":
            asked = params.get("protocolVersion")
            result = {"protocolVersion": asked if asked in MCP_VERSIONS else MCP_VERSIONS[0],
                      "capabilities": {"tools": {}}, "instructions": MCP_INSTRUCTIONS,
                      "serverInfo": {"name": "blender-server", "version": bpy.app.version_string}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": [{"name": n, "description": d, "inputSchema": sc} for n, d, sc in MCP_TOOLS]}
        elif method == "tools/call":
            if params.get("name") not in MCP_TOOL_NAMES:
                raise LookupError(f"unknown tool {params.get('name')!r}")
            result = mcp_call_tool(params["name"], params.get("arguments") or {})
        elif mid is None:
            return None   # notifications/initialized, notifications/cancelled, ...
        else:
            raise LookupError(f"method not found: {method}")
    except LookupError as e:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": str(e)}}
    except Exception as e:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": f"{type(e).__name__}: {e}"}}
    return None if mid is None else {"jsonrpc": "2.0", "id": mid, "result": result}




class Viewer(http.server.BaseHTTPRequestHandler):
    """The one HTTP port: the viewer's API, its files and MCP, each behind the token."""

    def log_message(self, *a):
        pass

    def authorized(self):
        """`Authorization: Bearer <token>`, compared in constant time. The portal's proxy adds it to every request."""
        auth = self.headers.get("Authorization", "")
        return auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].strip().encode(), TOKEN.encode())

    def refuse(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Bearer realm="blender-server"')
        body = b'{"error":"not connected: open Blender from the portal"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if not self.authorized():
            return self.refuse()
        if path == "/mcp":
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0) or 0)))
            except Exception:
                self.reply(400, "application/json", json.dumps(
                    {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}).encode())
                return
            replies = [r for r in (mcp_dispatch(m) for m in (body if isinstance(body, list) else [body])) if r]
            if not replies:   # only notifications or responses: accepted, nothing to send back
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.reply(200, "application/json", json.dumps(replies if isinstance(body, list) else replies[0]).encode())
            return
        if path == "/api/viewport":
            n = min(int(self.headers.get("Content-Length", 0) or 0), 65536)
            try:
                view = json.loads(self.rfile.read(n) or b"{}")
            except Exception as e:
                self.reply(400, "application/json", json.dumps({"error": str(e)}).encode())
                return
            box = run_on_main(lambda: render_viewport(view), timeout=120)
            if "result" in box:
                data, took = box["result"]
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("X-Render-Seconds", str(took))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            else:
                self.reply(500, "application/json", json.dumps(box).encode())
            return
        if path == "/api/project":
            n = min(int(self.headers.get("Content-Length", 0) or 0), 65536)
            try:
                req = json.loads(self.rfile.read(n) or b"{}")
                action = req.get("action")
                if action not in ("open", "new", "save", "save_as"):
                    raise ValueError("action must be open, new, save or save_as")
            except Exception as e:
                self.reply(400, "application/json", json.dumps({"error": str(e)}).encode())
                return

            def job():
                with STATE_LOCK:
                    STATE["busy"] = {"open": "opening project", "new": "creating project",
                                     "save": "saving", "save_as": "saving"}[action]
                try:
                    release_frame()
                    if action == "open":
                        r = cmd_open_file({"path": req["path"]})
                        after_scene_change("open_file")
                    elif action == "new":
                        r = cmd_new_scene({"name": req.get("name"), "empty": req.get("template") == "empty"})
                        after_scene_change("new_scene")
                    elif action == "save":
                        cur = STATE["project"]["path"]
                        if not cur:
                            raise ValueError("this project has no name yet; use Save as")
                        r = cmd_save_file({"path": cur})
                    else:
                        r = cmd_save_file({"path": f"{PROJECTS}/{project_name(req.get('name'))}.blend"})
                    log(f"workspace: {action} {STATE['project']['path']}")
                    return r
                finally:
                    with STATE_LOCK:
                        STATE["busy"] = None

            box = run_on_main(job)
            self.reply(200 if "result" in box else 400, "application/json", json.dumps(box).encode())
            return
        if path == "/api/project/upload":
            try:
                name = project_name(urllib.parse.parse_qs(self.path.partition("?")[2]).get("name", [""])[0])
                n = int(self.headers.get("Content-Length", 0) or 0)
                if n <= 0 or n > 2 * 1024 ** 3:
                    raise ValueError("upload must be between 1 byte and 2 GB")
                dest = inside_data(f"{PROJECTS}/{name}.blend")
                tmp = dest + ".upload"
                with open(tmp, "wb") as f:
                    left = n
                    while left:
                        chunk = self.rfile.read(min(left, 1 << 20))
                        if not chunk:
                            raise ValueError("upload interrupted")
                        f.write(chunk)
                        left -= len(chunk)
                with open(tmp, "rb") as f:
                    head = f.read(7)
                # plain, zstd-compressed (Blender's default) or gzip-compressed (older Blender) .blend
                if not (head == b"BLENDER" or head[:4] == b"\x28\xb5\x2f\xfd" or head[:2] == b"\x1f\x8b"):
                    os.remove(tmp)
                    raise ValueError("that file is not a .blend")
                os.replace(tmp, dest)
                log(f"workspace: uploaded {os.path.relpath(dest, DATA)} ({n} bytes)")
                self.reply(200, "application/json", json.dumps({"result": {"path": os.path.relpath(dest, DATA)}}).encode())
            except Exception as e:
                self.reply(400, "application/json", json.dumps({"error": str(e)}).encode())
            return
        if path in ("/api/render_view", "/api/set_camera"):
            n = min(int(self.headers.get("Content-Length", 0) or 0), 65536)
            try:
                view = json.loads(self.rfile.read(n) or b"{}")
                for k in ("position", "target"):
                    if len(view.get(k, [])) != 3:
                        raise ValueError(f"{k} must be [x, y, z]")
            except Exception as e:
                self.reply(400, "application/json", json.dumps({"error": str(e)}).encode())
                return
            label = "render from browser view" if path == "/api/render_view" else "set scene camera"
            fn = job_render_view if path == "/api/render_view" else job_set_camera

            def job():
                with STATE_LOCK:
                    STATE["busy"] = label
                try:
                    return fn(view)
                finally:
                    with STATE_LOCK:
                        STATE["busy"] = None

            box = run_on_main(job)
            self.reply(200 if "result" in box else 500, "application/json", json.dumps(box).encode())
            return
        self.reply(404, "text/plain", b"not found")

    def do_GET(self):
        path = self.path.partition("?")[0]
        if not self.authorized():
            return self.refuse()
        if path == "/mcp":   # no server-initiated stream: every reply comes back on its POST
            self.send_response(405)
            self.send_header("Allow", "POST")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/api/projects":
            self.reply(200, "application/json", json.dumps({"projects": list_projects()}).encode())
        elif path == "/api/state":
            with STATE_LOCK:
                body = {"project": dict(STATE["project"]), "preview_at": STATE["preview_at"], "scene_at": STATE["scene_at"],
                        "viewport_at": STATE.get("viewport_at", 0), "viewport_ms": STATE.get("viewport_ms"), "scene": STATE["scene"], "busy": STATE["busy"],
                        "log": list(STATE["log"]), "renders": list(STATE["renders"]),
                        "blender": bpy.app.version_string, "gpu": (GPU or {}).get("backend", "?"), "denoiser": denoiser()}
            self.reply(200, "application/json", json.dumps(body).encode())
        elif path.startswith("/files/"):
            try:
                full = os.path.realpath(os.path.join(DATA, urllib.parse.unquote(path[len("/files/"):])))
                if not full.startswith(os.path.realpath(DATA) + os.sep) or not full.lower().endswith((".png", ".jpg", ".exr", ".blend")):
                    raise FileNotFoundError
                with open(full, "rb") as f:
                    ext = full.rsplit(".", 1)[-1].lower()
                    ctype = {"png": "image/png", "jpg": "image/jpeg"}.get(ext, "application/octet-stream")
                    data = f.read()
                    if ext == "blend":
                        self.send_response(200)
                        self.send_header("Content-Type", ctype)
                        self.send_header("Content-Length", str(len(data)))
                        # The name as RFC 6266 quotes it: a project's name is whatever its path was saved as.
                        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + urllib.parse.quote(os.path.basename(full)))
                        self.end_headers()
                        self.wfile.write(data)
                    else:
                        self.reply(200, ctype, data, cache=False)
            except FileNotFoundError:
                self.reply(404, "text/plain", b"not found")
        else:
            self.reply(404, "text/plain", b"not found")

    def reply(self, code, ctype, body, cache=False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)


def start_server():
    srv = http.server.ThreadingHTTPServer((HOST, PORT), Viewer)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log(f"blender {bpy.app.version_string} serving the viewer's API and MCP on http://{HOST}:{PORT}/, data dir {DATA}, gpu {GPU}")


def after_scene_change(kind):
    if kind == "execute_code" or kind == "set_camera":
        mark_dirty()
    if AUTO_PREVIEW:
        render_preview(kind)
        summarize_scene(kind)
        refresh_viewport(kind)


def handle(req):
    if not isinstance(req, dict) or req.get("token") != TOKEN:
        return {"status": "error", "message": "unauthorized"}
    kind = req.get("type")
    fn = COMMANDS.get(kind)
    if fn is None:
        return {"status": "error", "message": f"unknown command {kind!r}; available: {sorted(COMMANDS)}"}
    t0 = time.time()
    with STATE_LOCK:
        STATE["busy"] = kind
    try:
        release_frame()
        result = fn(req.get("params") or {})
        log(f"{kind} ok in {time.time() - t0:.2f}s")
        if kind == "render":
            with STATE_LOCK:
                STATE["renders"].appendleft({"rel": os.path.relpath(result["path"], DATA), "engine": result["engine"],
                                             "seconds": result["seconds"]})
        if kind in CHANGES_SCENE and not (kind == "execute_code" and (req.get("params") or {}).get("read_only")):
            after_scene_change(kind)
        return {"status": "success", "result": result}
    except Exception as e:  # report to the caller, keep serving
        log(f"{kind} failed: {e}")
        return {"status": "error", "message": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()[-4000:]}
    finally:
        with STATE_LOCK:
            STATE["busy"] = None



def stop(*_):
    """`docker stop` (SIGTERM): end at once, with 0, so a stop is not taken for a crash. Blender, the container's first
    process, would otherwise ignore the signal and be killed ten seconds later."""
    os._exit(0)


if __name__ == "__main__":
    if not TOKEN:
        print("BLENDER_SERVER_TOKEN is not set; refusing to start a server that can execute code.", file=sys.stderr)
        sys.exit(1)
    signal.signal(signal.SIGTERM, stop)
    os.makedirs(DATA, exist_ok=True)
    GPU = setup_gpu()
    start_server()
    if AUTO_PREVIEW:
        render_preview("startup")
        summarize_scene("startup")
    # Blender's main thread from here on: it runs what the HTTP threads queue for bpy (run_on_main), woken at once by
    # a byte on WAKE_W, and looks again every second.
    while True:
        select.select([WAKE_R], [], [], 1.0)
        drain_jobs()
