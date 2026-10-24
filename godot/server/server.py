#!/usr/bin/env python3
"""The Godot editor, rendered on the GPU, streamed to a browser and driven over MCP, behind a Pithagoras portal.

This process is the container's supervisor and its only network listener: plain HTTP on GODOT_SERVER_HOST, which
the extension sets to 0.0.0.0 of the container's own network, which only the portal reaches, and every route but
/healthz asks for the one credential, `Authorization: Bearer <token>`. Nobody reaches it directly: the Godot
extension's server half proxies what the viewer asks of it and its stream at /api/x/@pithagoras/godot/ui/ behind the
portal's own sign-in, and adds the token on the way, and relays the MCP tools to the chats.

    /stream/...          the Selkies stream (its WebSocket and its API), piped to Selkies on its Unix socket
    /files/<path>        exports and recordings, for download
    /api/...             what the viewer page calls
    /mcp                 MCP over Streamable HTTP: POST JSON-RPC, JSON replies
    /healthz             liveness, the one route without the token

No page that runs is served from here. The viewer and Selkies' web client are the extension's own, from its package,
on the portal's origin (whose secure context Selkies' WebCodecs need): this process runs the editor, and the editor
runs the agent's code, so nothing it answers is ever run as a page of the portal's.

It starts and restarts the X display (Xvfb), the stream (Selkies) and the editor, and runs the command-line jobs
(script checks, exports, Movie Maker recordings) itself. Editor operations go to the godot_mcp_bridge editor plugin
over a loopback JSON-lines socket; the plugin is copied into and enabled in every project the server opens.

Environment:
    GODOT_SERVER_TOKEN       required; the server refuses to start without it (the Bearer token of every route)
    GODOT_SERVER_HOST        default 127.0.0.1
    GODOT_SERVER_PORT        default 3880
    GODOT_DATA_DIR           default /data
    DISPLAY_SIZE             default 1600x900
    SELKIES_*                passed to Selkies (encoder, bitrate, frame rate, ...)
"""
import base64
import collections
import concurrent.futures
import ctypes
import hmac
import http.server
import json
import os
import re
import resource
import secrets
import select
import shutil
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import zipfile
import zlib

TOKEN = os.environ.get("GODOT_SERVER_TOKEN", "")
HOST = os.environ.get("GODOT_SERVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("GODOT_SERVER_PORT", "3880"))
DATA = os.environ.get("GODOT_DATA_DIR", "/data")
GODOT = os.environ.get("GODOT_BIN", "/opt/godot/godot")
VGLRUN = os.environ.get("VGLRUN", "/opt/VirtualGL/bin/vglrun")
SELKIES = os.environ.get("SELKIES_BIN", "selkies")
# The web client Selkies would otherwise copy into a temporary folder of this user's at every start, served from where
# the image put it instead: root's, so nothing that runs in the container can change what it serves.
SELKIES_WEB = os.environ.get("SELKIES_WEB_ROOT", "/opt/selkies/lib/python3.12/site-packages/selkies/selkies_web")
DISPLAY_SIZE = os.environ.get("DISPLAY_SIZE", "1600x900")
HERE = os.path.dirname(os.path.abspath(__file__))
ADDON_SRC = os.path.join(HERE, "addon", "godot_mcp_bridge")

DISPLAY = ":1"
# Selkies listens on a Unix socket in a folder only this process's user can open: a TCP port on loopback would be open
# to every process in the container's network namespace, the games and the code the editor runs included.
SELKIES_DIR = "/tmp/gs"
SELKIES_SOCKET = os.path.join(SELKIES_DIR, "selkies.sock")
BRIDGE_SECRET = secrets.token_hex(24)   # new every start; only the editor this process launches gets it
SCREEN_W, SCREEN_H = (int(v) for v in DISPLAY_SIZE.lower().split("x"))

PROJECTS = os.path.join(DATA, "projects")
EXPORTS = os.path.join(DATA, "exports")
RENDERS = os.path.join(DATA, "renders")
HOME = os.path.join(DATA, "home")          # the editor's settings live in home/.config/godot
TMP = os.path.join(DATA, "tmp")
STATE_FILE = os.path.join(DATA, ".state.json")
RUNTIME_DIR = "/tmp/runtime"
ADDON_CFG = "res://addons/godot_mcp_bridge/plugin.cfg"
RENDERERS = ("forward_plus", "mobile", "gl_compatibility")
FEATURE = {"forward_plus": "Forward Plus", "mobile": "Mobile", "gl_compatibility": "GL Compatibility"}
MAX_BODY = 64 * 1024 * 1024
MAX_UPLOAD = 2 * 1024 ** 3


def free_port():
    """A TCP port on loopback that nothing listens on now. The editor's own listeners (the bridge, the GDScript
    language server, the debug adapter, the debugger) are on the container's loopback, shared with the games and the
    code the editor runs, so each editor start takes ports that are free rather than Godot's fixed defaults."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# The ports the editor that runs now was started with (editor_env, editor_argv): new at every start.
PORTS = {"bridge": 0, "lsp": 0, "dap": 0, "debug": 0}


class ToolError(Exception):
    """A failure to report to the caller as-is (bad arguments, editor down, job failed)."""


# ---- activity log and process output ---------------------------------------------------------------------------

LOG = collections.deque(maxlen=300)
LOG_LOCK = threading.Lock()


def log(msg, kind="info"):
    line = time.strftime("%H:%M:%S") + " " + msg
    print(line, flush=True)
    with LOG_LOCK:
        LOG.appendleft({"t": round(time.time(), 3), "line": line, "kind": kind})


class Ring:
    """Recent output lines of a process, each with a sequence number so callers can ask for "everything since"."""

    def __init__(self, n):
        self.lines = collections.deque(maxlen=n)
        self.seq = 0
        self.lock = threading.Lock()

    def add(self, text):
        with self.lock:
            self.seq += 1
            self.lines.append((self.seq, text))

    def mark(self):
        with self.lock:
            return self.seq

    def since(self, mark=None, limit=200):
        with self.lock:
            rows = [r for r in self.lines if mark is None or r[0] > mark]
            oldest = self.lines[0][0] if self.lines else self.seq + 1
        return rows[-limit:], (mark is not None and mark + 1 < oldest)


ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
EDITOR_OUT, STREAM_OUT, X_OUT = Ring(6000), Ring(600), Ring(200)
ERR_START = re.compile(r"^(SCRIPT ERROR|USER ERROR|ERROR|SCRIPT WARNING|USER WARNING|WARNING)\b")


def error_lines(lines):
    """Godot's error and warning lines with their indented "at:" / backtrace lines."""
    out, keep = [], False
    for line in lines:
        if ERR_START.match(line):
            out.append(line)
            keep = True
        elif keep and line[:1] in (" ", "\t"):
            out.append(line)
        else:
            keep = False
    return out


def output_since(mark, wait=0.15):
    time.sleep(wait)   # the reader thread is a moment behind the process
    rows, _ = EDITOR_OUT.since(mark, limit=400)
    return [t for _, t in rows]


# ---- supervised processes --------------------------------------------------------------------------------------

def no_core():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))   # crash dumps are 0.3-1.3 GB each on a failing SSD


def not_dumpable():
    """This process is kept from every other process of its user (PR_SET_DUMPABLE 0): none may attach to it, read its
    memory or read its environment, where its token is. The editor, the games and the agent's GDScript run as the same
    user. The processes it starts are not affected: exec makes each dumpable again."""
    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_DUMPABLE, 0) failed")


def kill_group(p, timeout=10):
    for sig, wait in ((signal.SIGTERM, timeout), (signal.SIGKILL, 5)):
        try:
            os.killpg(p.pid, sig)
        except ProcessLookupError:
            return
        try:
            p.wait(wait)
            return
        except subprocess.TimeoutExpired:
            continue


class Supervised:
    """A child process kept running: restarted when it exits by itself (a crash), not after release() or stop().

    Each start() runs a new supervisor thread; a thread that is no longer the current one never starts a process,
    so at most one copy of the process runs even if an old thread is still winding down."""

    def __init__(self, name, ring):
        self.name, self.ring = name, ring
        self.argv = self.env = None
        self.proc = None
        self.want = False
        self.thread = None
        self.state = "stopped"
        self.restarts = 0
        self.crashes = collections.deque(maxlen=5)
        self.on_start = self.on_exit = None
        self.lock = threading.Lock()
        self.wake = threading.Event()   # cuts a restart pause short when release() or stop() is called

    def start(self, argv, env):
        with self.lock:
            self.argv, self.env, self.want = argv, env, True
            self.wake.clear()
            self.thread = threading.Thread(target=self._loop, daemon=True, name=self.name)
            self.thread.start()

    def _loop(self):
        me = threading.current_thread()
        while True:
            with self.lock:   # stop() reads proc under the same lock, so it never misses a process starting
                if not self.want or self.thread is not me:
                    break
                self.state = "starting"
                try:
                    p = subprocess.Popen(self.argv, env=self.env, cwd=HOME, stdin=subprocess.DEVNULL,
                                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
                                         preexec_fn=no_core)
                except OSError as e:
                    p, err = None, e
                self.proc = p
            if p is None:
                log(f"{self.name} could not start: {err}", "error")
                self.wake.wait(5)
                continue
            if self.on_start:
                threading.Thread(target=self.on_start, args=(p,), daemon=True).start()
            for raw in iter(p.stdout.readline, b""):
                self.ring.add(ANSI.sub("", raw.decode("utf-8", "replace").rstrip("\r\n")))
            code = p.wait()
            with self.lock:
                if self.proc is p:
                    self.proc = None
                stale = self.thread is not me
                asked = not self.want
            if stale:
                return   # a newer start() owns the state now
            if self.on_exit:
                self.on_exit(code)
            if asked:
                break   # it was told to quit (a project switch, shutdown): not a crash
            self.state = "crashed"
            self.restarts += 1
            self.crashes.append(time.time())
            pause = 30 if len(self.crashes) == self.crashes.maxlen and time.time() - self.crashes[0] < 120 else 2
            log(f"{self.name} exited with code {code}; restarting in {pause} s", "error")
            self.wake.wait(pause)
        if self.thread is me:
            self.state = "stopped"

    def release(self):
        """The process is about to exit because it was asked to: do not restart it and do not count a crash."""
        with self.lock:
            self.want = False
            self.wake.set()

    def stop(self, timeout=10):
        with self.lock:
            self.want = False
            self.wake.set()
            p, t = self.proc, self.thread
        if p:
            kill_group(p, timeout)
        if t and t is not threading.current_thread():
            t.join(timeout + 20)
            if t.is_alive():
                log(f"{self.name}: the old supervisor thread is still waiting on its process; it will not start "
                    "another one", "error")
        with self.lock:
            if self.thread is t:
                self.thread = None
        self.state = "stopped"

    def pid(self):
        p = self.proc
        return p.pid if p else None


XVFB = Supervised("Xvfb", X_OUT)
STREAM = Supervised("selkies", STREAM_OUT)
EDITOR = Supervised("editor", EDITOR_OUT)
EDITOR_READY = threading.Event()
EDITOR_INFO = {}
CURRENT = {"name": None, "since": 0}
PROJECT_LOCK = threading.RLock()     # one project switch at a time
JOB_LOCK = threading.Lock()          # one command-line job (export, recording, check) at a time
BUSY = {"what": None, "since": 0}


class busy:
    def __init__(self, what):
        self.what = what

    def __enter__(self):
        BUSY.update(what=self.what, since=time.time())

    def __exit__(self, *a):
        BUSY.update(what=None, since=0)


def base_env():
    env = {k: v for k, v in os.environ.items() if k != "GODOT_SERVER_TOKEN"}
    env.update(HOME=HOME, DISPLAY=DISPLAY, XDG_RUNTIME_DIR=RUNTIME_DIR, LANG="C.UTF-8")
    return env


def editor_env():
    env = base_env()
    env.update(GODOT_BRIDGE_PORT=str(PORTS["bridge"]), GODOT_BRIDGE_SECRET=BRIDGE_SECRET)
    return env


def new_ports():
    """Ports for the editor about to start (see free_port): the bridge plugin's, the GDScript language server's, the
    debug adapter's, and the debugger's that the games the editor runs connect back to."""
    PORTS.update(bridge=free_port(), lsp=free_port(), dap=free_port(), debug=free_port())


def gl_prefix(proj_dir):
    """Compatibility (OpenGL) projects run under VirtualGL's EGL back end so OpenGL renders on the GPU; Xvfb's own
    GLX is software. Vulkan (Forward+ / Mobile) presents into Xvfb directly."""
    return [VGLRUN, "-d", "egl"] if project_renderer(proj_dir) == "gl_compatibility" else []


def xvfb_argv():
    # Only the socket file in this container's /tmp/.X11-unix: -nolisten local turns off the abstract socket
    # (@/tmp/.X11-unix/X1), which belongs to the network namespace, not to the file system, so no file's mode would
    # keep a process there from it.
    return ["Xvfb", DISPLAY, "-screen", "0", f"{SCREEN_W}x{SCREEN_H}x24", "-s", "0", "-dpms", "-nolisten", "tcp",
            "-nolisten", "local", "-noreset", "+extension", "GLX", "+extension", "RANDR", "+extension", "XTEST",
            "+extension", "XFIXES", "+extension", "DAMAGE", "+extension", "MIT-SHM"]


def selkies_argv():
    return [SELKIES, f"--unix-socket={SELKIES_SOCKET}", f"--web-root={SELKIES_WEB}", "--subfolder=/stream/",
            "--enable-https=false", "--enable-basic-auth=false", "--enable-resize=false", "--audio-enabled=false",
            "--microphone-enabled=false", "--webcam-enabled=false", "--gamepad-enabled=false",
            "--file-transfers=none", "--printing-enabled=false", "--enable-sharing=false", "--second-screen=false",
            "--keyboard-shortcuts=false", "--ui-show-sidebar=false", "--ui-title=Godot editor"]


def selkies_env():
    env = base_env()
    # Software H.264: NVENC refuses a container that only sees the second GPU (it wants /dev/nvidia0).
    for k, v in (("SELKIES_ENCODER", "h264enc"), ("SELKIES_USE_CPU", "true"), ("SELKIES_GPU_ID", "-1"),
                 ("SELKIES_FRAMERATE", "60")):
        env.setdefault(k, v)
    env["HOME"] = "/tmp/selkies-home"
    return env


def editor_argv(proj_dir):
    return gl_prefix(proj_dir) + [GODOT, "--editor", "--path", proj_dir, "--single-window", "--resolution",
                                  f"{SCREEN_W}x{SCREEN_H}", "--position", "0,0", "--audio-driver", "Dummy",
                                  "--lsp-port", str(PORTS["lsp"]), "--dap-port", str(PORTS["dap"]),
                                  "--debug-server", f"tcp://127.0.0.1:{PORTS['debug']}"]


def start_editor(proj_dir):
    """Starts the editor on a project, with new ports (new_ports): kept by its supervisor through its restarts."""
    new_ports()
    EDITOR.start(editor_argv(proj_dir), editor_env())


def wait_for_x(timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if os.path.exists(f"/tmp/.X11-unix/X{DISPLAY[1:]}"):
            return True
        time.sleep(0.2)
    return False


def start_display():
    for stale in (f"/tmp/.X{DISPLAY[1:]}-lock", f"/tmp/.X11-unix/X{DISPLAY[1:]}"):
        try:
            os.remove(stale)
        except FileNotFoundError:
            pass
    XVFB.start(xvfb_argv(), base_env())
    if not wait_for_x():
        log("Xvfb did not come up within 15 s", "error")


def on_xvfb_start(p):
    # After an Xvfb restart (not the first start) the stream and the editor lost their display.
    if XVFB.restarts and wait_for_x():
        log("display restarted; restarting the stream and the editor", "error")
        for proc in (STREAM.proc, EDITOR.proc):
            if proc:
                kill_group(proc, 5)


def on_editor_start(p):
    EDITOR_READY.clear()
    t0 = time.time()
    while p.poll() is None and time.time() - t0 < 300:
        try:
            info = bridge_raw("ping", timeout=3)
        except Exception:
            info = {}
        if not info.get("ready"):   # listening, but the first scan / import is still running
            time.sleep(0.5)
            continue
        EDITOR_INFO.clear()
        EDITOR_INFO.update(info)
        EDITOR.state = "running"
        EDITOR_READY.set()
        log(f"editor ready on {CURRENT['name']} in {time.time() - t0:.1f} s: {info.get('rendering_method')} on "
            f"{info.get('adapter')} ({info.get('graphics_api')})")
        return
    if p.poll() is None:
        log("the editor started but its bridge plugin never answered", "error")


def on_editor_exit(code):
    EDITOR_READY.clear()


def stream_connection(timeout=5):
    """A connection to Selkies, on its Unix socket, checked to be Selkies': the process that listens on it is in the
    session of the Selkies this server started (each supervised process is started as a session of its own). The
    editor, the games and the GDScript the agent runs are the same user as Selkies, so they could put a socket of their
    own at that path; they cannot join another process's session."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(SELKIES_SOCKET)
        pid, _uid, _gid = struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
        if os.getsid(pid) != STREAM.pid():
            raise ConnectionRefusedError(f"the stream's socket is held by process {pid}, which is not the Selkies this server started")
    except OSError:
        s.close()
        raise
    return s


def on_stream_start(p):
    t0 = time.time()
    while p.poll() is None and time.time() - t0 < 120:
        try:
            stream_connection(2).close()
        except OSError:
            time.sleep(0.5)
            continue
        STREAM.state = "running"
        log(f"stream ready in {time.time() - t0:.1f} s")
        return


XVFB.on_start = on_xvfb_start
STREAM.on_start = on_stream_start
EDITOR.on_start, EDITOR.on_exit = on_editor_start, on_editor_exit


# ---- the editor plugin bridge ----------------------------------------------------------------------------------

def bridge_raw(cmd, args=None, timeout=60):
    msg = json.dumps({"id": secrets.token_hex(6), "secret": BRIDGE_SECRET, "cmd": cmd, "args": args or {}}) + "\n"
    try:
        with socket.create_connection(("127.0.0.1", PORTS["bridge"]), timeout=5) as s:
            s.settimeout(timeout)
            s.sendall(msg.encode())
            buf = b""
            while not buf.endswith(b"\n"):
                chunk = s.recv(1 << 20)
                if not chunk:
                    raise ToolError("the editor closed the connection (it may have crashed); get_output shows its last lines")
                buf += chunk
    except socket.timeout:
        raise ToolError(f"the editor did not answer within {timeout} s. It may be busy (a long or endless "
                        "execute_gdscript, or a @tool script stuck in a loop) or blocked by a modal dialog; "
                        "screenshot with target=screen shows which, and restart_editor restarts it")
    except ConnectionRefusedError:
        raise ToolError("the editor is not listening (it may be starting or restarting)")
    r = json.loads(buf)
    if not r.get("ok"):
        raise ToolError(r.get("error") or "the editor reported an error")
    return r.get("result")


def bridge(cmd, args=None, timeout=60, wait_ready=120):
    if not EDITOR_READY.wait(wait_ready):
        raise ToolError("the editor is not running (it may be starting, or crashing; get_output shows why)")
    return bridge_raw(cmd, args, timeout)


def bridge_quiet(cmd, args=None, timeout=20):
    """Best effort (save before a job, a toast): never fails the caller."""
    if not EDITOR_READY.is_set():
        return None
    try:
        return bridge_raw(cmd, args, timeout)
    except Exception as e:
        log(f"editor {cmd} skipped: {e}")
        return None


# ---- projects ----------------------------------------------------------------------------------------------------

def safe_name(name):
    name = str(name or "").strip()
    name = "".join(c for c in name if c.isalnum() or c in " _-.").strip(" .")
    if not name:
        raise ToolError("a project name needs letters or digits")
    return name[:64]


def proj_dir(name):
    return os.path.join(PROJECTS, safe_name(name))


def project_renderer(path):
    try:
        with open(os.path.join(path, "project.godot"), encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return "forward_plus"
    m = re.search(r'^renderer/rendering_method="([^"]+)"', text, re.M)
    return m.group(1) if m else "forward_plus"


def current_dir():
    name = CURRENT["name"]
    if not name:
        raise ToolError("no project is open")
    return proj_dir(name)


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state():
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"project": CURRENT["name"]}, f)
    os.replace(tmp, STATE_FILE)


def list_projects():
    os.makedirs(PROJECTS, exist_ok=True)
    out = []
    for name in sorted(os.listdir(PROJECTS)):
        path = os.path.join(PROJECTS, name)
        if name.startswith(".") or not os.path.isfile(os.path.join(path, "project.godot")):
            continue
        newest, n = os.path.getmtime(os.path.join(path, "project.godot")), 0
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in files:
                n += 1
                if n > 3000:
                    break
                try:
                    newest = max(newest, os.path.getmtime(os.path.join(root, f)))
                except OSError:
                    pass
        out.append({"name": name, "renderer": project_renderer(path), "modified": round(newest),
                    "open": name == CURRENT["name"],
                    "web_export": os.path.isfile(os.path.join(EXPORTS, name, "web", "index.html"))})
    out.sort(key=lambda p: -p["modified"])
    return out


ICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
<rect x="8" y="8" width="112" height="112" rx="26" fill="#478cbf"/>
<rect x="8" y="80" width="112" height="40" rx="0" fill="#3b78a6"/>
<rect x="8" y="94" width="112" height="26" rx="26" fill="#3b78a6"/>
<circle cx="44" cy="54" r="15" fill="#fff"/><circle cx="84" cy="54" r="15" fill="#fff"/>
<circle cx="47" cy="56" r="7" fill="#1d2733"/><circle cx="87" cy="56" r="7" fill="#1d2733"/>
<rect x="46" y="84" width="36" height="8" rx="4" fill="#fff"/>
</svg>
"""

SCENE_2D = """[gd_scene format=3]

[node name="Main" type="Node2D"]
"""

SCENE_3D = """[gd_scene load_steps=4 format=3]

[sub_resource type="ProceduralSkyMaterial" id="ProceduralSkyMaterial_1"]

[sub_resource type="Sky" id="Sky_1"]
sky_material = SubResource("ProceduralSkyMaterial_1")

[sub_resource type="Environment" id="Environment_1"]
background_mode = 2
sky = SubResource("Sky_1")
tonemap_mode = 2

[node name="Main" type="Node3D"]

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_1")

[node name="Sun" type="DirectionalLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.642788, 0.766044, 0, -0.766044, 0.642788, 0, 4, 0)
shadow_enabled = true

[node name="Camera3D" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.939693, 0.34202, 0, -0.34202, 0.939693, 0, 2, 6)
"""

WEB_PRESET = """name="Web"
platform="Web"
runnable=true
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter="addons/godot_mcp_bridge/*"
export_path=""
script_export_mode=2

[preset.{n}.options]

custom_template/debug=""
custom_template/release=""
variant/extensions_support=false
variant/thread_support=false
vram_texture_compression/for_desktop=true
vram_texture_compression/for_mobile=false
html/export_icon=true
html/canvas_resize_policy=2
html/focus_canvas_on_start=true
html/experimental_virtual_keyboard=false
progressive_web_app/enabled=false
"""

LINUX_PRESET = """name="Linux"
platform="Linux"
runnable=true
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter="addons/godot_mcp_bridge/*"
export_path=""
script_export_mode=2

[preset.{n}.options]

custom_template/debug=""
custom_template/release=""
binary_format/embed_pck=false
binary_format/architecture="x86_64"
texture_format/s3tc_bptc=true
texture_format/etc2_astc=false
"""


def project_godot(name, renderer, template):
    lines = ["; Engine configuration file.", "; Created by godot-server.", "", "config_version=5", "",
             "[application]", "", f'config/name="{name}"', 'run/main_scene="res://main.tscn"',
             f'config/features=PackedStringArray("{GODOT_SERIES}", "{FEATURE[renderer]}")',
             'config/icon="res://icon.svg"', "", "[display]", "", "window/size/viewport_width=1152",
             "window/size/viewport_height=648"]
    if template == "2d":
        lines.append('window/stretch/mode="canvas_items"')
    lines += ["", "[editor_plugins]", "", f'enabled=PackedStringArray("{ADDON_CFG}")', "", "[rendering]", "",
              f'renderer/rendering_method="{renderer}"']
    if renderer == "gl_compatibility":
        lines.append('renderer/rendering_method.mobile="gl_compatibility"')
    return "\n".join(lines) + "\n"


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def create_project(name, template="2d", renderer=None):
    name = safe_name(name)
    if template not in ("2d", "3d"):
        raise ToolError("template must be 2d or 3d")
    renderer = renderer or ("gl_compatibility" if template == "2d" else "forward_plus")
    if renderer not in RENDERERS:
        raise ToolError(f"renderer must be one of {', '.join(RENDERERS)}")
    path = os.path.join(PROJECTS, name)
    if os.path.exists(path):
        raise ToolError(f"a project named {name!r} already exists")
    os.makedirs(path)
    write_text(os.path.join(path, "project.godot"), project_godot(name, renderer, template))
    write_text(os.path.join(path, "main.tscn"), SCENE_2D if template == "2d" else SCENE_3D)
    write_text(os.path.join(path, "icon.svg"), ICON_SVG)
    write_text(os.path.join(path, "export_presets.cfg"),
               "[preset.0]\n\n" + WEB_PRESET.format(n=0) + "\n[preset.1]\n\n" + LINUX_PRESET.format(n=1))
    write_text(os.path.join(path, ".gitignore"), ".godot/\n")
    install_addon(path)
    log(f"project {name} created ({template.upper()}, {renderer})")
    return name


def install_addon(path):
    """Copy the bridge plugin into the project (refreshing an older copy) and enable it in project.godot. Only
    called while the editor does not have this project open, since the editor rewrites project.godot itself."""
    dst = os.path.join(path, "addons", "godot_mcp_bridge")
    os.makedirs(dst, exist_ok=True)
    for f in os.listdir(ADDON_SRC):
        src = os.path.join(ADDON_SRC, f)
        with open(src, "rb") as a:
            new = a.read()
        try:
            with open(os.path.join(dst, f), "rb") as b:
                if b.read() == new:
                    continue
        except OSError:
            pass
        with open(os.path.join(dst, f), "wb") as b:
            b.write(new)
    pg = os.path.join(path, "project.godot")
    with open(pg, encoding="utf-8") as f:
        text = f.read()
    if f'"{ADDON_CFG}"' in text:
        return
    sec = re.search(r"^\[editor_plugins\][ \t]*$", text, re.M)
    if sec:
        nxt = re.search(r"^\[", text[sec.end():], re.M)
        end = sec.end() + (nxt.start() if nxt else len(text) - sec.end())
        body = text[sec.end():end]
        m = re.search(r"^enabled=PackedStringArray\((.*)\)[ \t]*$", body, re.M)
        if m:
            inner = m.group(1).strip()
            body = body[:m.start()] + f'enabled=PackedStringArray({inner + ", " if inner else ""}"{ADDON_CFG}")' + body[m.end():]
        else:
            body = f'\n\nenabled=PackedStringArray("{ADDON_CFG}")' + body
        text = text[:sec.end()] + body + text[end:]
    else:
        text = text.rstrip("\n") + f'\n\n[editor_plugins]\n\nenabled=PackedStringArray("{ADDON_CFG}")\n'
    with open(pg, "w", encoding="utf-8") as f:
        f.write(text)


def ensure_preset(path, platform):
    """Name of the project's export preset for platform ("Web" / "Linux"), adding ours if it has none."""
    cfg = os.path.join(path, "export_presets.cfg")
    try:
        with open(cfg, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        text = ""
    indexes = [int(n) for n in re.findall(r"^\[preset\.(\d+)\]", text, re.M)]
    for n in indexes:
        sec = re.search(rf"^\[preset\.{n}\]\s*$(.*?)(?=^\[)", text + "\n[", re.M | re.S)
        if sec and re.search(rf'^platform="{platform}"', sec.group(1), re.M):
            m = re.search(r'^name="([^"]*)"', sec.group(1), re.M)
            if m:
                return m.group(1)
    n = max(indexes) + 1 if indexes else 0
    body = (WEB_PRESET if platform == "Web" else LINUX_PRESET).format(n=n)
    with open(cfg, "a", encoding="utf-8") as f:
        f.write(("\n" if text and not text.endswith("\n\n") else "") + f"[preset.{n}]\n\n" + body)
    log(f"added a {platform} export preset to {os.path.basename(path)}")
    return platform


def editor_answers(timeout=3):
    try:
        bridge_raw("ping", timeout=timeout)
        return True
    except (ToolError, OSError):
        return False


def quit_editor():
    """Stop the editor: saved and quit if it answers, killed if it does not. Returns how it ended."""
    p = EDITOR.proc
    EDITOR.release()   # from here on its exit is asked for: no restart, no crash count
    how = "not running"
    if p:
        how = "killed (it did not answer, so unsaved changes were lost)"
        if EDITOR_READY.is_set() and editor_answers():
            try:
                bridge_raw("quit", timeout=15)
                p.wait(10)
                how = "saved its open scenes and quit"
            except Exception:
                pass
    EDITOR.stop(timeout=5)
    return how


def open_project(name, force=False):
    """Switch the editor to a project (or, with force, restart it on the open one): save the open scenes, stop the
    editor, start it on the project and wait until the plugin answers."""
    name = safe_name(name)
    path = os.path.join(PROJECTS, name)
    if not os.path.isfile(os.path.join(path, "project.godot")):
        raise ToolError(f"no project named {name!r}; list_projects shows what there is")
    with PROJECT_LOCK, busy(f"{'restarting the editor on' if force else 'opening'} {name}"):
        if CURRENT["name"] == name and EDITOR_READY.is_set() and not force:
            return {"project": name, "already_open": True}
        how = quit_editor()
        install_addon(path)
        CURRENT.update(name=name, since=time.time())
        save_state()
        log(f"opening project {name} ({project_renderer(path)})")
        start_editor(path)
        if not EDITOR_READY.wait(240):
            raise ToolError(f"the editor did not come up on {name} within 4 minutes; get_output shows why")
        return {"project": name, "renderer": project_renderer(path), "previous_editor": how,
                "editor": dict(EDITOR_INFO)}


def startup_project():
    name = load_state().get("project")
    if name and os.path.isfile(os.path.join(PROJECTS, name, "project.godot")):
        return name
    projects = list_projects()
    if projects:
        return projects[0]["name"]
    return create_project("starter", "3d")


def resolve_res(path, must_exist=False):
    """res://... (or a path relative to the project) -> (res path, absolute path), refusing anything outside the
    open project and anything inside its .godot cache."""
    base = os.path.realpath(current_dir())
    p = str(path or "").strip()
    if p.startswith("res://"):
        p = p[6:]
    p = p.lstrip("/")
    full = os.path.realpath(os.path.join(base, p))
    if not (full == base or full.startswith(base + os.sep)):
        raise ToolError(f"{path!r} is outside the open project; paths are res:// paths inside it")
    rel = os.path.relpath(full, base).replace(os.sep, "/")
    rel = "" if rel == "." else rel
    if rel == ".godot" or rel.startswith(".godot/"):
        raise ToolError("the .godot folder is the editor's cache and is off limits")
    if must_exist and not os.path.exists(full):
        raise ToolError(f"no such file: res://{rel}")
    return "res://" + rel, full


def zip_project(name):
    path = proj_dir(name)
    if not os.path.isfile(os.path.join(path, "project.godot")):
        raise ToolError(f"no project named {name!r}")
    os.makedirs(TMP, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".zip", dir=TMP)
    os.close(fd)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(path):
            dirs[:] = sorted(d for d in dirs if d != ".godot")
            for f in sorted(files):
                full = os.path.join(root, f)
                z.write(full, os.path.join(os.path.basename(path), os.path.relpath(full, path)))
    return tmp


def unpack_project(zip_path, name_hint):
    with zipfile.ZipFile(zip_path) as z:
        cands = [n for n in z.namelist() if n == "project.godot" or n.endswith("/project.godot")]
        if not cands:
            raise ToolError("the zip has no project.godot")
        top = min(cands, key=lambda n: n.count("/"))
        prefix = top[: -len("project.godot")]
        name = safe_name(name_hint or prefix.rstrip("/").split("/")[-1] or os.path.splitext(os.path.basename(zip_path))[0])
        dest = os.path.join(PROJECTS, name)
        if os.path.exists(dest):
            raise ToolError(f"a project named {name!r} already exists; pick another name")
        staging = dest + ".upload"
        shutil.rmtree(staging, ignore_errors=True)
        total = 0
        try:
            for info in z.infolist():
                if not info.filename.startswith(prefix):
                    continue
                rel = info.filename[len(prefix):]
                if not rel or rel.startswith(".godot/"):
                    continue
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ToolError(f"the zip contains a symbolic link ({rel}); not unpacking it")
                out = os.path.realpath(os.path.join(staging, rel))
                if not out.startswith(os.path.realpath(staging) + os.sep):
                    raise ToolError(f"the zip has a path outside its folder: {info.filename}")
                if info.is_dir():
                    os.makedirs(out, exist_ok=True)
                    continue
                total += info.file_size
                if total > MAX_UPLOAD:
                    raise ToolError("the project is larger than 2 GB unpacked")
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with z.open(info) as src, open(out, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1 << 20)
            install_addon(staging)
            os.replace(staging, dest)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
    log(f"project {name} uploaded ({total} bytes unpacked)")
    return name


# ---- command-line jobs -------------------------------------------------------------------------------------------

def run_job(argv, timeout, env=None, cwd=None):
    """Run a Godot (or ffmpeg) command line to the end; returns (exit code, output lines)."""
    p = subprocess.Popen(argv, env=env or base_env(), cwd=cwd or TMP, stdin=subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=no_core)
    try:
        out, _ = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_group(p, 5)
        out, _ = p.communicate()
        raise ToolError(f"{os.path.basename(argv[0])} did not finish within {timeout} s; output ended with: "
                        + " | ".join(ANSI.sub("", out.decode("utf-8", "replace")).splitlines()[-8:]))
    lines = [ANSI.sub("", l) for l in out.decode("utf-8", "replace").splitlines()]
    return p.returncode, lines


def godot_scripts(path):
    out = []
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if not d.startswith(".") and not (root == path and d == "addons")]
        for f in files:
            if f.endswith(".gd"):
                out.append("res://" + os.path.relpath(os.path.join(root, f), path).replace(os.sep, "/"))
    return sorted(out)


def check_one(path, res):
    code, lines = run_job([GODOT, "--headless", "--path", path, "--check-only", "--script", res], timeout=90)
    errs = [l for l in error_lines(lines) if not l.startswith("WARNING")]
    return {"path": res, "ok": code == 0 and not errs, "errors": errs[:40]}


def png_bytes(w, h, rgb_rows):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rgb_rows), 6)) + chunk(b"IEND", b""))


class _XImage(ctypes.Structure):
    _fields_ = [("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int), ("format", ctypes.c_int),
                ("data", ctypes.c_void_p), ("byte_order", ctypes.c_int), ("bitmap_unit", ctypes.c_int),
                ("bitmap_bit_order", ctypes.c_int), ("bitmap_pad", ctypes.c_int), ("depth", ctypes.c_int),
                ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int)]


_X = {}
X_LOCK = threading.Lock()
_X_ERROR_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)(lambda d, e: 0)


def x_grab(x, y, w, h):
    """PNG of a region of the virtual screen (what the stream shows), read straight from the X server."""
    x, y = max(0, int(x)), max(0, int(y))
    w, h = max(1, min(int(w), SCREEN_W - x)), max(1, min(int(h), SCREEN_H - y))
    with X_LOCK:
        if not _X:
            lib = ctypes.CDLL("libX11.so.6")
            lib.XOpenDisplay.restype = ctypes.c_void_p
            lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
            lib.XDefaultRootWindow.restype = ctypes.c_ulong
            lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
            lib.XGetImage.restype = ctypes.c_void_p
            lib.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
                                      ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
            lib.XDestroyImage.argtypes = [ctypes.c_void_p]
            lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
            lib.XSetErrorHandler(_X_ERROR_HANDLER)   # Xlib's default handler would exit this process
            _X["lib"] = lib
        lib = _X["lib"]
        d = lib.XOpenDisplay(DISPLAY.encode())
        if not d:
            raise ToolError("cannot open the X display")
        try:
            ptr = lib.XGetImage(d, lib.XDefaultRootWindow(d), x, y, w, h, 0xFFFFFFFF, 2)
            if not ptr:
                raise ToolError("the X server returned no image")
            img = ctypes.cast(ptr, ctypes.POINTER(_XImage)).contents
            bpl = img.bytes_per_line
            raw = ctypes.string_at(img.data, bpl * h)
            lib.XDestroyImage(ptr)
        finally:
            lib.XCloseDisplay(d)
    rows = bytearray()
    for yy in range(h):
        line = raw[yy * bpl: yy * bpl + w * 4]
        px = bytearray(w * 3)
        px[0::3], px[1::3], px[2::3] = line[2::4], line[1::4], line[0::4]
        rows.append(0)
        rows += px
    return png_bytes(w, h, rows), w, h


def game_window():
    """Geometry of the running game's window (Godot titles debug runs "<name> (DEBUG)"), or None."""
    env = {"DISPLAY": DISPLAY, "PATH": os.environ["PATH"]}
    r = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", r"\(DEBUG\)$"], env=env,
                       capture_output=True, text=True, timeout=5)
    ids = r.stdout.split()
    if not ids:
        return None
    g = subprocess.run(["xdotool", "getwindowgeometry", "--shell", ids[-1]], env=env, capture_output=True, text=True,
                       timeout=5)
    vals = dict(line.split("=", 1) for line in g.stdout.split() if "=" in line)
    return {k: int(vals[k.upper()]) for k in ("x", "y", "width", "height")}


def do_export(platform, debug):
    name = CURRENT["name"]
    path = current_dir()
    if platform not in ("web", "linux"):
        raise ToolError("platform must be web or linux")
    if platform == "linux" and debug:
        raise ToolError("only the linux release template is installed; export linux without debug")
    preset = ensure_preset(path, "Web" if platform == "web" else "Linux")
    out_dir = os.path.join(EXPORTS, name, platform)
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir)
    target = os.path.join(out_dir, "index.html" if platform == "web" else f"{name}.x86_64")
    with JOB_LOCK, busy(f"exporting {name} ({platform})"):
        bridge_quiet("save_all")
        bridge_quiet("toast", {"text": f"Agent: exporting {platform}..."})
        t0 = time.time()
        code, lines = run_job([GODOT, "--headless", "--path", path, "--export-debug" if debug else "--export-release",
                               preset, target], timeout=900)
        secs = round(time.time() - t0, 1)
        errs = [l for l in error_lines(lines) if not l.startswith("WARNING")]
        if code != 0 or not os.path.isfile(target):
            raise ToolError(f"export failed (exit {code}): " + " | ".join((errs or lines)[-12:]))
        if platform == "linux":
            os.chmod(target, 0o755)
    files = {f: os.path.getsize(os.path.join(out_dir, f)) for f in sorted(os.listdir(out_dir))}
    rel = os.path.relpath(out_dir, DATA)
    # No address to open: a web build run on the portal's origin would run the project's code there (a game's
    # JavaScriptBridge runs any script it likes), so builds are files the person downloads from the viewer's menu.
    res = {"platform": platform, "preset": preset, "seconds": secs, "folder": rel, "files": files,
           "note": "the person can download this build as a .zip from the Godot panel's project menu",
           "warnings": [l for l in error_lines(lines) if l.startswith("WARNING")][:10]}
    bridge_quiet("toast", {"text": f"Agent: {platform} export done in {secs} s"})
    log(f"export {name} {platform} ok in {secs} s")
    return res


def do_record(args):
    name = CURRENT["name"]
    path = current_dir()
    fps = int(args.get("fps", 30))
    if not 1 <= fps <= 120:
        raise ToolError("fps must be between 1 and 120")
    frames = int(args.get("frames") or round(float(args.get("seconds", 3)) * fps))
    if not 1 <= frames <= 3600:
        raise ToolError("record between 1 and 3600 frames")
    fmt = args.get("format", "mp4")
    if fmt not in ("mp4", "png"):
        raise ToolError("format must be mp4 or png")
    scene = args.get("scene")
    if scene:
        scene, _ = resolve_res(scene, must_exist=True)
    width, height = args.get("width"), args.get("height")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = os.path.join(RENDERS, name, stamp)
    os.makedirs(out_dir)
    movie = os.path.join(out_dir, "frame.png" if fmt == "png" else "movie.avi")
    override = os.path.join(path, "override.cfg")
    wrote_override = False
    with JOB_LOCK, busy(f"recording {frames} frames of {name}"):
        bridge_quiet("save_all")
        bridge_quiet("toast", {"text": f"Agent: recording {frames} frames at {fps} fps..."})
        if width and height:
            if os.path.exists(override):
                raise ToolError("the project has its own override.cfg; record without width/height")
            # Movie Maker records at the project's window size and ignores --resolution.
            write_text(override, f"[display]\n\nwindow/size/viewport_width={int(width)}\n"
                                 f"window/size/viewport_height={int(height)}\n")
            wrote_override = True
        try:
            t0 = time.time()
            argv = gl_prefix(path) + [GODOT, "--path", path] + ([scene] if scene else []) + [
                "--write-movie", movie, "--fixed-fps", str(fps), "--quit-after", str(frames)]
            code, lines = run_job(argv, timeout=int(frames / fps * 20) + 120, env=base_env())
            secs = round(time.time() - t0, 1)
        finally:
            if wrote_override:
                os.remove(override)
        errs = [l for l in error_lines(lines) if not l.startswith("WARNING")]
        if fmt == "mp4":
            if not os.path.isfile(movie):
                raise ToolError(f"Movie Maker wrote nothing (exit {code}): " + " | ".join((errs or lines)[-10:]))
            mp4 = os.path.join(out_dir, "movie.mp4")
            c2, l2 = run_job(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", movie, "-c:v", "libx264",
                              "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a",
                              "128k", "-movflags", "+faststart", mp4], timeout=600)
            if c2 != 0:
                raise ToolError("ffmpeg could not make the MP4: " + " | ".join(l2[-6:]))
            os.remove(movie)
            preview = os.path.join(out_dir, "preview.jpg")
            run_job(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{frames / fps / 2:.3f}", "-i", mp4,
                     "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", preview], timeout=60)
            outputs = ["movie.mp4"]
            mime = "image/jpeg"
        else:
            pngs = sorted(f for f in os.listdir(out_dir) if f.startswith("frame") and f.endswith(".png"))
            if not pngs:
                raise ToolError(f"Movie Maker wrote no frames (exit {code}): " + " | ".join((errs or lines)[-10:]))
            preview = os.path.join(out_dir, pngs[len(pngs) // 2])
            outputs = pngs
            mime = "image/png"
    rel = os.path.relpath(out_dir, DATA)
    res = {"folder": rel, "frames": frames, "fps": fps, "format": fmt, "seconds": secs,
           "files": outputs if fmt == "mp4" else [outputs[0], "...", outputs[-1]] + (["frame.wav"] if os.path.exists(os.path.join(out_dir, "frame.wav")) else []),
           "errors": errs[:10]}
    if fmt == "mp4":
        res["bytes"] = os.path.getsize(os.path.join(out_dir, "movie.mp4"))
        res["note"] = "the person can download the recording from the Godot panel's project menu"
    image = None
    if os.path.isfile(preview):
        with open(preview, "rb") as f:
            image = (base64.b64encode(f.read()).decode(), mime)
    bridge_quiet("toast", {"text": f"Agent: recorded {frames} frames in {secs} s"})
    log(f"record {name} {frames} frames ({fmt}) ok in {secs} s")
    return res, image


def gpu_info():
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=name,uuid,memory.used,memory.total,driver_version",
                            "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
        rows = []
        for line in r.stdout.strip().splitlines():
            n, u, used, total, drv = [c.strip() for c in line.split(",")]
            rows.append({"name": n, "uuid": u, "memory_used_mib": int(used), "memory_total_mib": int(total), "driver": drv})
        return rows
    except Exception as e:
        return [{"error": str(e)}]


GODOT_VERSION = "?"
GODOT_SERIES = ".".join(os.environ.get("GODOT_VERSION", "4.7").split(".")[:2])   # "4.7", for config/features


# ---- MCP tools ---------------------------------------------------------------------------------------------------

def _obj(props, req=()):
    return {"type": "object", "properties": props, "required": list(req), "additionalProperties": False}


RES = "A res:// path inside the open project (a path relative to the project root also works)."
VALUE_NOTE = ("Values are JSON: [x, y] for a Vector2, [x, y, z] for a Vector3, \"#rrggbb\" or [r, g, b, a] (0-1) "
              "for a Color, \"res://...\" to load a resource, a class name or {\"type\": \"CircleShape2D\", "
              "\"radius\": 20} for a new resource, {\"$expr\": \"Vector2(1, 2) * 3\"} for any Godot expression.")


def t_ping(a, ctx):
    info = {"server": "godot-server", "godot": GODOT_VERSION, "gpu": gpu_info(), "project": CURRENT["name"],
            "renderer": project_renderer(proj_dir(CURRENT["name"])) if CURRENT["name"] else None,
            "editor": EDITOR.state, "editor_restarts": EDITOR.restarts, "display": f"{SCREEN_W}x{SCREEN_H}",
            "stream": STREAM.state}
    if EDITOR_READY.is_set():
        try:
            info["editor_info"] = bridge_raw("ping", timeout=10)
        except ToolError as e:
            info["editor"] = "not answering"
            info["editor_info"] = {"error": str(e)}
    return info


def t_list_projects(a, ctx):
    return {"open": CURRENT["name"], "projects": list_projects()}


def t_new_project(a, ctx):
    with PROJECT_LOCK:
        name = create_project(a.get("name"), a.get("template", "2d"), a.get("renderer"))
    res = {"project": name, "renderer": project_renderer(proj_dir(name)), "main_scene": "res://main.tscn"}
    if a.get("open", True):
        res["opened"] = open_project(name)
    return res


def t_open_project(a, ctx):
    return open_project(a.get("name"))


def t_restart_editor(a, ctx):
    if not CURRENT["name"]:
        raise ToolError("no project is open")
    return open_project(CURRENT["name"], force=True)


def t_list_files(a, ctx):
    res, full = resolve_res(a.get("path", "res://"), must_exist=True)
    if not os.path.isdir(full):
        raise ToolError(f"{res} is not a folder")
    meta = bool(a.get("include_meta", False))
    out = []
    for root, dirs, files in os.walk(full):
        dirs[:] = sorted(d for d in dirs if d != ".godot" and (meta or not d.startswith(".")))
        for d in dirs:
            out.append({"path": "res://" + os.path.relpath(os.path.join(root, d), current_dir()).replace(os.sep, "/") + "/"})
        for f in sorted(files):
            if not meta and (f.endswith((".import", ".uid")) or f.startswith(".")):
                continue
            fp = os.path.join(root, f)
            out.append({"path": "res://" + os.path.relpath(fp, current_dir()).replace(os.sep, "/"),
                        "bytes": os.path.getsize(fp)})
        if len(out) > 3000 or not a.get("recursive", True):
            break   # not recursive: this folder's own files and folders only
    out.sort(key=lambda e: e["path"])
    return {"folder": res, "count": len(out), "entries": out[:3000]}


def t_read_file(a, ctx):
    res, full = resolve_res(a.get("path"), must_exist=True)
    if os.path.isdir(full):
        raise ToolError(f"{res} is a folder; use list_files")
    limit = int(a.get("max_bytes", 1 << 20))
    with open(full, "rb") as f:
        data = f.read(limit + 1)
    out = {"path": res, "bytes": os.path.getsize(full), "truncated": len(data) > limit}
    data = data[:limit]
    try:
        out["content"] = data.decode("utf-8")
    except UnicodeDecodeError:
        out["content_base64"] = base64.b64encode(data).decode()
    return out


def t_write_file(a, ctx):
    res, full = resolve_res(a.get("path"))
    if res == "res://" or res.endswith("/"):
        raise ToolError("give a file path")
    if ("content" in a) == ("content_base64" in a):
        raise ToolError("pass exactly one of content (text) or content_base64")
    if os.path.basename(full) == "project.godot":
        raise ToolError("project.godot is managed by the editor; change project settings with execute_gdscript "
                        "(ProjectSettings.set_setting(...); ProjectSettings.save())")
    args = {"path": res}
    if "content" in a:
        args["content"] = a["content"]
        data = str(a["content"]).encode()
    else:
        args["content_base64"] = re.sub(r"\s+", "", str(a["content_base64"]))
        try:
            data = base64.b64decode(args["content_base64"], validate=True)
        except ValueError as e:   # binascii.Error
            raise ToolError(f"content_base64 is not valid base64 ({e}); nothing was written")
    if EDITOR_READY.is_set():
        return bridge("write_file", args)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as f:
        f.write(data)
    return {"path": res, "bytes": len(data), "note": "the editor is not running; written to disk directly"}


def t_delete_file(a, ctx):
    res, full = resolve_res(a.get("path"), must_exist=True)
    if os.path.isdir(full):
        raise ToolError("delete_file removes files, not folders")
    if os.path.basename(full) == "project.godot":
        raise ToolError("refusing to delete project.godot")
    if EDITOR_READY.is_set():
        return bridge("delete_file", {"path": res})
    os.remove(full)
    for extra in (".import", ".uid"):
        if os.path.exists(full + extra):
            os.remove(full + extra)
    return {"deleted": res}


def t_get_scene_tree(a, ctx):
    return bridge("get_scene_tree", {"max_depth": int(a.get("max_depth", 12))})


def t_open_scene(a, ctx):
    res, _ = resolve_res(a.get("path"), must_exist=True)
    return bridge("open_scene", {"path": res})


def t_new_scene(a, ctx):
    res, _ = resolve_res(a.get("path"))
    args = dict(a, path=res)
    return bridge("new_scene", args)


def t_add_node(a, ctx):
    if not a.get("type") and not a.get("scene"):
        raise ToolError("pass type (a node class) or scene (a .tscn to instance)")
    args = dict(a)
    if a.get("scene"):
        args["scene"], _ = resolve_res(a["scene"], must_exist=True)
    return bridge("add_node", args)


def t_set_property(a, ctx):
    return bridge("set_property", a)


def t_delete_node(a, ctx):
    return bridge("delete_node", a)


def t_attach_script(a, ctx):
    res, _ = resolve_res(a.get("path"))
    out = bridge("attach_script", dict(a, path=res))
    # In the editor a script that is not @tool never reports itself instantiable, so ask the parser instead.
    chk = check_one(current_dir(), res)
    out["compiles"] = chk["ok"]
    if chk["errors"]:
        out["errors"] = chk["errors"]
    return out


def t_save_scene(a, ctx):
    args = dict(a)
    if a.get("path"):
        args["path"], _ = resolve_res(a["path"])
    return bridge("save_scene", args)


def t_reload(a, ctx):
    paths = [resolve_res(p)[0] for p in a.get("paths") or []]
    return bridge("reload", {"paths": paths}, timeout=120)


def debugger_halt():
    """'<error> (<file>:<line>)' while the game the editor runs is stopped in the editor's debugger (a parse error
    in one of its scripts, a runtime error, a breakpoint), else None. A halted game prints nothing."""
    st = bridge_quiet("debugger", timeout=5)
    if not st or not st.get("halted"):
        return None
    stack = st.get("stack") or []
    return (st.get("reason") or "stopped") + (f" ({stack[0]})" if stack else "")


def _run(args, ctx):
    mark = EDITOR_OUT.mark()
    res = bridge("run", args, timeout=30)
    time.sleep(1.5)
    res["output_mark"] = mark
    res["errors"] = [l for l in error_lines(output_since(mark, 0)) if not l.startswith("WARNING")][:30]
    res["note"] = "the game runs in a window over the editor (see the stream); screenshot(target=game) shows it"
    halt = debugger_halt()
    if halt:
        res["playing"] = False
        res["halted"] = "halted in debugger: " + halt
        res["errors"].insert(0, res["halted"])
        res["note"] = ("the game stopped in the editor's debugger and is frozen; fix the error, then stop and run "
                       "again")
    return res


def t_run_project(a, ctx):
    return _run({"mode": "main"}, ctx)


def t_run_scene(a, ctx):
    if a.get("path"):
        return _run({"mode": "custom", "scene": resolve_res(a["path"], must_exist=True)[0]}, ctx)
    return _run({"mode": "current"}, ctx)


def t_stop(a, ctx):
    return bridge("stop", {})


def t_get_output(a, ctx):
    since = a.get("since")
    rows, dropped = EDITOR_OUT.since(None if since is None else int(since), limit=int(a.get("limit", 200)))
    lines = [t for _, t in rows]
    if a.get("errors_only"):
        lines = error_lines(lines)
    out = {"mark": EDITOR_OUT.mark(), "lines": lines, "older_lines_dropped": dropped, "playing": bool(game_window())}
    if out["playing"]:
        halt = debugger_halt()
        if halt:
            out["playing"] = False
            out["halted"] = "halted in debugger: " + halt
    return out


def t_check_scripts(a, ctx):
    path = current_dir()
    paths = [resolve_res(p, must_exist=True)[0] for p in a.get("paths") or []] or godot_scripts(path)
    if not paths:
        return {"checked": 0, "failed": 0, "results": []}
    with busy(f"checking {len(paths)} scripts"):
        with concurrent.futures.ThreadPoolExecutor(3) as ex:
            results = list(ex.map(lambda r: check_one(path, r), paths))
    bad = [r for r in results if not r["ok"]]
    return {"checked": len(results), "failed": len(bad), "results": bad + [{"path": r["path"], "ok": True} for r in results if r["ok"]]}


def t_screenshot(a, ctx):
    target = a.get("target", "editor")
    if target in ("editor", "2d", "3d"):
        r = bridge("screenshot", {"target": target, "max_width": int(a.get("max_width", 0))})
        return {"target": target, "width": r["width"], "height": r["height"], "_image": (r["png_base64"], "image/png")}
    if target == "game":
        g = game_window()
        if not g:
            raise ToolError("no game window is open; run_project or run_scene first")
        png, w, h = x_grab(g["x"], g["y"], g["width"], g["height"])
        return {"target": "game", "window": g, "width": w, "height": h, "_image": (base64.b64encode(png).decode(), "image/png")}
    if target == "screen":
        png, w, h = x_grab(0, 0, SCREEN_W, SCREEN_H)
        return {"target": "screen", "width": w, "height": h, "_image": (base64.b64encode(png).decode(), "image/png")}
    raise ToolError("target must be editor, 2d, 3d, game or screen")


def t_record(a, ctx):
    res, image = do_record(a)
    if image:
        res["_image"] = image
    return res


def t_export(a, ctx):
    return do_export(a.get("platform", "web"), bool(a.get("debug", False)))


def t_execute_gdscript(a, ctx):
    if not str(a.get("code", "")).strip():
        raise ToolError("code is empty")
    mark = EDITOR_OUT.mark()
    try:
        res = bridge("execute", {"code": a["code"]}, timeout=int(a.get("timeout", 60)))
    except ToolError as e:
        raise ToolError(f"{e}\n" + "\n".join(output_since(mark)[-40:]))
    res["output"] = output_since(mark)[-200:]
    return res


TOOLS = [
    ("ping", t_ping, "Versions (Godot, server), the GPU the container renders on, the open project and its renderer, "
     "and the editor's own report (graphics adapter, rendering method, open scenes, whether a game is running).",
     _obj({})),
    ("list_projects", t_list_projects, "Projects on the server (data/projects/<name>), most recently changed first, "
     "with each one's renderer and whether it has a web export. `open` names the project the editor has open.",
     _obj({})),
    ("new_project", t_new_project, "Create a project from a template and (by default) open it in the editor. 2d: a "
     "Node2D main scene, Compatibility renderer (what web exports use; lightest on the GPU). 3d: a Node3D main scene "
     "with a camera, sun and sky, Forward+ renderer. Both have Web and Linux export presets.",
     _obj({"name": {"type": "string", "description": "Folder and project name (letters, digits, space, _ - .)"},
           "template": {"type": "string", "enum": ["2d", "3d"], "default": "2d"},
           "renderer": {"type": "string", "enum": list(RENDERERS),
                        "description": "Default: gl_compatibility for 2d, forward_plus for 3d"},
           "open": {"type": "boolean", "default": True}}, ["name"])),
    ("open_project", t_open_project, "Open another project. The editor saves its open scenes, restarts on the new "
     "project (a few seconds; longer the first time while it imports) and the stream follows.",
     _obj({"name": {"type": "string"}}, ["name"])),
    ("restart_editor", t_restart_editor, "Restart the editor on the open project. Use it when the editor stops "
     "answering (an endless execute_gdscript or @tool script, a stuck dialog). If it still answers it saves its open "
     "scenes and quits first; if not it is killed and unsaved changes are lost. previous_editor says which.",
     _obj({})),
    ("list_files", t_list_files, "Files and folders in the open project (the .godot cache, .import and .uid files "
     "are left out unless include_meta).",
     _obj({"path": {"type": "string", "default": "res://", "description": RES},
           "recursive": {"type": "boolean", "default": True},
           "include_meta": {"type": "boolean", "default": False}})),
    ("read_file", t_read_file, "Read a file of the open project: text as content, anything else as content_base64.",
     _obj({"path": {"type": "string", "description": RES},
           "max_bytes": {"type": "integer", "default": 1048576}}, ["path"])),
    ("write_file", t_write_file, "Create or overwrite a file in the open project. The editor writes it, so it "
     "notices at once: a script open in the script editor shows the new text, an open scene reloads. Use "
     "attach_script to put a script on a node.",
     _obj({"path": {"type": "string", "description": RES},
           "content": {"type": "string", "description": "Text (UTF-8)"},
           "content_base64": {"type": "string", "description": "Binary content, base64"}}, ["path"])),
    ("delete_file", t_delete_file, "Delete a file of the open project (with its .import / .uid companions). A "
     "scene that is open in the editor has its tab closed first (dropping unsaved changes in it), so no later save "
     "writes it back.",
     _obj({"path": {"type": "string", "description": RES}}, ["path"])),
    ("get_scene_tree", t_get_scene_tree, "The scene open in the editor as a tree: name, type, path (relative to the "
     "root, which is what node arguments take), script, and a few key values (position, size, text, texture, shape).",
     _obj({"max_depth": {"type": "integer", "default": 12}})),
    ("open_scene", t_open_scene, "Open a scene (.tscn or .scn) in the editor (it becomes the edited scene; other "
     "open scenes stay in their tabs).", _obj({"path": {"type": "string", "description": RES}}, ["path"])),
    ("new_scene", t_new_scene, "Create a scene file with one root node, save it and open it. set_main makes it the "
     "project's main scene (what run_project and exports start).",
     _obj({"path": {"type": "string", "description": "res://....tscn"},
           "root_type": {"type": "string", "default": "Node2D", "description": "Node class or a class_name script"},
           "root_name": {"type": "string", "description": "Default: the file name in PascalCase"},
           "set_main": {"type": "boolean", "default": False},
           "overwrite": {"type": "boolean", "default": False}}, ["path"])),
    ("add_node", t_add_node, "Add a node to the edited scene, through the editor's undo history, and select it so "
     "it shows in the Scene dock and Inspector. Give type for a new node or scene to instance a .tscn. " + VALUE_NOTE,
     _obj({"type": {"type": "string", "description": "Node class (Sprite2D, CharacterBody2D, Label, ...) or a class_name script"},
           "scene": {"type": "string", "description": "A .tscn to instance instead of type. " + RES},
           "name": {"type": "string"},
           "parent": {"type": "string", "default": ".", "description": "Path from the scene root (\".\" is the root)"},
           "properties": {"type": "object", "description": "Property name -> value, set before the node is added"}})),
    ("set_property", t_set_property, "Set one or more properties of a node in the edited scene (one undoable "
     "action). Sub-properties work with a colon: position:x. " + VALUE_NOTE,
     _obj({"node": {"type": "string", "default": ".", "description": "Path from the scene root"},
           "property": {"type": "string"}, "value": {"description": "New value (see above)"},
           "properties": {"type": "object", "description": "Several at once: name -> value"}})),
    ("delete_node", t_delete_node, "Delete a node (and its children) from the edited scene; undoable.",
     _obj({"node": {"type": "string", "description": "Path from the scene root"}}, ["node"])),
    ("attach_script", t_attach_script, "Attach a GDScript to a node (undoable), writing it first when source is "
     "given, and open it in the script editor. Returns compiles (Godot's --check-only) and the errors if not.",
     _obj({"node": {"type": "string", "default": ".", "description": "Path from the scene root"},
           "path": {"type": "string", "description": "res://....gd"},
           "source": {"type": "string", "description": "GDScript source to write to path first"},
           "open_editor": {"type": "boolean", "default": True}}, ["path"])),
    ("save_scene", t_save_scene, "Save the edited scene (to path when given: Save As, a .tscn or .scn path), or "
     "every open scene with all.",
     _obj({"path": {"type": "string", "description": RES}, "all": {"type": "boolean", "default": False}})),
    ("reload", t_reload, "Make the editor pick up files changed outside it: rescan the project (and reload changed "
     "open scripts), or reload just the given paths. write_file does this by itself.",
     _obj({"paths": {"type": "array", "items": {"type": "string"}}})),
    ("run_project", t_run_project, "Run the project's main scene from the editor, the way the Play button does. "
     "The game opens in a window over the editor, visible in the stream. Returns output_mark for get_output, and the "
     "errors printed so far. A game that stops in the editor's debugger (a script parse or runtime error) returns "
     "playing false and halted with the error and its file:line.",
     _obj({})),
    ("run_scene", t_run_scene, "Run the edited scene, or the scene at path, from the editor.",
     _obj({"path": {"type": "string", "description": RES}})),
    ("stop", t_stop, "Stop the game the editor is running.", _obj({})),
    ("get_output", t_get_output, "The editor's output: its own messages and those of the game it runs (print(), "
     "errors, warnings, script errors with their line), newest last. Pass since (a mark from run_project or an "
     "earlier get_output) to get only what came after it. While the game is stopped in the editor's debugger, "
     "playing is false and halted gives the error and its file:line.",
     _obj({"since": {"type": "integer"}, "limit": {"type": "integer", "default": 200},
           "errors_only": {"type": "boolean", "default": False}})),
    ("check_scripts", t_check_scripts, "Parse and type-check GDScript files (all of the project's, outside addons/, "
     "or the given paths) with Godot's --check-only, and return each failing file's errors with line numbers.",
     _obj({"paths": {"type": "array", "items": {"type": "string"}}})),
    ("screenshot", t_screenshot, "An image of the editor (target editor: the whole window; 2d / 3d: that viewport), "
     "the running game's window (game), or the whole streamed screen (screen).",
     _obj({"target": {"type": "string", "enum": ["editor", "2d", "3d", "game", "screen"], "default": "editor"},
           "max_width": {"type": "integer", "description": "Scale editor images down to this width"}})),
    ("record", t_record, "Record the game with Movie Maker on the GPU: a fixed frame rate, so the result is smooth "
     "however long each frame takes. Saves data/renders/<project>/<time>/movie.mp4 (or the PNG frames) and returns "
     "a frame from the middle.",
     _obj({"seconds": {"type": "number", "default": 3}, "frames": {"type": "integer", "description": "Instead of seconds"},
           "fps": {"type": "integer", "default": 30}, "scene": {"type": "string", "description": "Default: the main scene"},
           "width": {"type": "integer", "description": "Override the window size (with height)"},
           "height": {"type": "integer"}, "format": {"type": "string", "enum": ["mp4", "png"], "default": "mp4"}})),
    ("export", t_export, "Export the open project (open scenes are saved first). web: a single-threaded HTML5 build "
     "under data/exports/<project>/web. linux: an x86_64 binary and .pck under data/exports/<project>/linux. The "
     "person downloads either as a .zip from the Godot panel's project menu; to show the game running, use "
     "run_project.",
     _obj({"platform": {"type": "string", "enum": ["web", "linux"], "default": "web"},
           "debug": {"type": "boolean", "default": False, "description": "Debug build (web only)"}})),
    ("execute_gdscript", t_execute_gdscript, "ARBITRARY CODE: run GDScript inside the editor process (as an "
     "EditorScript would) and return what it prints and returns. The code is the body of a function run(); these "
     "are in scope: scene_root (the edited scene's root), undo_redo (EditorUndoRedoManager), plugin (EditorPlugin), "
     "and EditorInterface. Changes made here bypass the undo history unless you use undo_redo. Prefer the specific "
     "tools; use this for anything they do not cover (project settings, input map, signals, bulk edits). The editor "
     "does nothing else while the code runs: an endless loop freezes it until restart_editor.",
     _obj({"code": {"type": "string", "description": "GDScript statements (or a full script defining func run())"},
           "timeout": {"type": "integer", "default": 60}}, ["code"])),
]
TOOL_MAP = {n: (fn, d, s) for n, fn, d, s in TOOLS}
EDITOR_TOOLS = {"get_scene_tree", "open_scene", "new_scene", "add_node", "set_property", "delete_node",
                "attach_script", "save_scene", "reload", "write_file", "delete_file", "stop"}

MCP_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
MCP_INSTRUCTIONS = (
    "Tools for a real Godot 4 editor running on a GPU in a container. The person may be watching it live in the Godot "
    "panel beside the chat, and one editor is shared by every chat and the person, so check list_projects before you "
    "replace what is open. Every editor edit you make (add_node, set_property, attach_script, write_file, ...) happens "
    "in that editor and goes through its undo history. Typical loop: list_projects / new_project / open_project -> "
    "open_scene or new_scene -> add_node / set_property / attach_script -> save_scene -> check_scripts -> run_project -> "
    "screenshot(target=game) and get_output -> stop -> record or export. File paths are res:// paths inside the "
    "open project; nothing outside it can be read or written. Property values are JSON: [x, y] for Vector2, "
    "\"#rrggbb\" for Color, \"res://...\" to load a resource, {\"type\": \"RectangleShape2D\", \"size\": [32, 32]} "
    "for a new resource, {\"$expr\": \"...\"} for any Godot expression. execute_gdscript runs arbitrary GDScript in "
    "the editor for anything the other tools do not cover. If the editor stops answering, restart_editor restarts it.")


def summarize(args):
    parts = []
    for k, v in args.items():
        if k in ("source", "content", "content_base64", "code"):
            parts.append(f"{k}={len(str(v))} chars")
        elif isinstance(v, (dict, list)):
            s = json.dumps(v, separators=(",", ":"))
            parts.append(f"{k}={s[:60]}{'...' if len(s) > 60 else ''}")
        else:
            s = str(v)
            parts.append(f"{k}={s[:50]}{'...' if len(s) > 50 else ''}")
    return " ".join(parts)


def mcp_call(name, args, ctx):
    fn, _, _ = TOOL_MAP[name]
    t0 = time.time()
    mark = EDITOR_OUT.mark()
    try:
        result = fn(args, ctx)
        ok = True
    except ToolError as e:
        result, ok = str(e), False
    except Exception as e:
        result, ok = f"{type(e).__name__}: {e}", False
        traceback.print_exc()
    ms = int((time.time() - t0) * 1000)
    log(f"{name} {'ok' if ok else 'failed'} in {ms} ms  {summarize(args)}" + ("" if ok else f"  -> {str(result)[:160]}"),
        "tool" if ok else "tool-error")
    if not ok:
        return {"content": [{"type": "text", "text": result}], "isError": True}
    image = result.pop("_image", None) if isinstance(result, dict) else None
    if isinstance(result, dict) and name in EDITOR_TOOLS:
        errs = [l for l in error_lines(output_since(mark, 0.02)) if not l.startswith("WARNING")]
        if errs:
            result["editor_errors"] = errs[:20]
    content = [{"type": "text", "text": json.dumps(result, indent=1)}]
    if image:
        content.append({"type": "image", "data": image[0], "mimeType": image[1]})
    return {"content": content, "isError": False}


def mcp_dispatch(msg, ctx):
    if not isinstance(msg, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}}
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    try:
        if method == "initialize":
            asked = params.get("protocolVersion")
            result = {"protocolVersion": asked if asked in MCP_VERSIONS else MCP_VERSIONS[0],
                      "capabilities": {"tools": {}}, "instructions": MCP_INSTRUCTIONS,
                      "serverInfo": {"name": "godot-server", "version": GODOT_VERSION}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": [{"name": n, "description": d, "inputSchema": s} for n, _, d, s in TOOLS]}
        elif method == "tools/call":
            if params.get("name") not in TOOL_MAP:
                raise LookupError(f"unknown tool {params.get('name')!r}")
            result = mcp_call(params["name"], params.get("arguments") or {}, ctx)
        elif mid is None:
            return None   # notifications/initialized, notifications/cancelled, ...
        else:
            raise LookupError(f"method not found: {method}")
    except LookupError as e:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": str(e)}}
    except Exception as e:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": f"{type(e).__name__}: {e}"}}
    return None if mid is None else {"jsonrpc": "2.0", "id": mid, "result": result}


# ---- HTTP --------------------------------------------------------------------------------------------------------

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm",
        ".pck": "application/octet-stream", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
        ".ico": "image/x-icon", ".json": "application/json", ".mp4": "video/mp4", ".wav": "audio/wav",
        ".zip": "application/zip", ".txt": "text/plain; charset=utf-8"}
HOP = {"connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"}
# What the viewer API's POSTs must declare. The portal's proxy refuses a write from another origin before it gets
# here; these types are what the page itself sends, so anything else is not the page.
POST_TYPES = {"/api/projects/upload": ("application/zip", "application/octet-stream")}


def outputs(name):
    """A project's latest builds (exports/<name>/<platform>) and its recordings (renders/<name>/<time>/movie.mp4),
    newest first: what the viewer's project menu offers to download."""
    name = safe_name(name)
    builds = []
    for platform in ("web", "linux"):
        folder = os.path.join(EXPORTS, name, platform)
        files = [os.path.join(folder, f) for f in sorted(os.listdir(folder))] if os.path.isdir(folder) else []
        files = [f for f in files if os.path.isfile(f)]
        if files:
            builds.append({"platform": platform, "files": len(files), "bytes": sum(os.path.getsize(f) for f in files),
                           "modified": round(max(os.path.getmtime(f) for f in files))})
    recordings = []
    base = os.path.join(RENDERS, name)
    for stamp in sorted(os.listdir(base), reverse=True)[:20] if os.path.isdir(base) else []:
        movie = os.path.join(base, stamp, "movie.mp4")
        if os.path.isfile(movie):
            recordings.append({"path": os.path.relpath(movie, DATA), "bytes": os.path.getsize(movie),
                               "modified": round(os.path.getmtime(movie))})
    return {"project": name, "builds": builds, "recordings": recordings}


def zip_build(name, platform):
    """A project's latest build for a platform as a zip in TMP (the caller removes it), its files in a folder named
    after the project and the platform."""
    name = safe_name(name)
    if platform not in ("web", "linux"):
        raise ToolError("platform must be web or linux")
    folder = os.path.join(EXPORTS, name, platform)
    files = sorted(f for f in os.listdir(folder) if os.path.isfile(os.path.join(folder, f))) if os.path.isdir(folder) else []
    if not files:
        raise ToolError(f"there is no {platform} build of {name}; export it first")
    os.makedirs(TMP, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".zip", dir=TMP)
    os.close(fd)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(os.path.join(folder, f), f"{name}-{platform}/{f}")
    return tmp


def playing():
    """Whether a game the editor runs has its window open, for the viewer's Run and Stop."""
    try:
        return bool(game_window())
    except (OSError, subprocess.SubprocessError):
        return False


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "godot-server"
    timeout = 120   # idle keep-alive connections

    def log_message(self, *a):
        pass

    # -- replies
    def send_body(self, code, ctype, body, headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, code, obj, headers=None):
        self.send_body(code, "application/json", json.dumps(obj).encode(), headers)

    def empty(self, code, headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def redirect(self, where, code=303):
        """To `where`, relative to this page: the viewer is served under the portal's path, not at /."""
        self.empty(code, {"Location": where})

    def send_file(self, full, ctype, headers=None):
        size = os.path.getsize(full)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(full, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1 << 20)

    def read_body(self, limit=MAX_BODY):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            raise ToolError("chunked request bodies are not supported")
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ToolError("request body too large")
        return self.rfile.read(n) if n else b""

    def json_body(self):
        try:
            body = json.loads(self.read_body(1 << 20) or b"{}")
        except ValueError:
            raise ToolError("the request body is not JSON")
        if not isinstance(body, dict):
            raise ToolError("the request body must be a JSON object")
        return body

    # -- the one credential
    def bearer_ok(self):
        auth = self.headers.get("Authorization", "")
        return auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].strip().encode(), TOKEN.encode())

    # -- routing
    def do_GET(self):
        self.route()

    def do_HEAD(self):
        self.route()

    def do_POST(self):
        self.route()

    def do_PUT(self):
        self.route()

    def do_DELETE(self):
        self.route()

    def do_OPTIONS(self):
        self.route()

    def route(self):
        try:
            self._route()
        except ToolError as e:
            self.send_json(400, {"error": str(e)})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as e:
            traceback.print_exc()
            try:
                self.send_json(500, {"error": f"{type(e).__name__}: {e}"})
            except OSError:
                self.close_connection = True

    def _route(self):
        path, _, query = self.path.partition("?")
        method = self.command
        if path == "/healthz":
            return self.send_json(200, {"ok": True, "editor": EDITOR.state})
        if not self.bearer_ok():
            self.close_connection = True   # the body is not read
            return self.send_json(401, {"error": "not connected: this server is reached through the Pithagoras portal"},
                                  {"WWW-Authenticate": 'Bearer realm="godot-server"'})
        if path == "/mcp":
            return self.mcp() if method == "POST" else self.empty(405, {"Allow": "POST"})
        if path == "/stream":
            return self.redirect("stream/", code=301)
        if path.startswith("/stream/"):
            return self.proxy_stream()
        if path.startswith("/files/"):
            return self.serve_files(path)
        if path.startswith("/api/"):
            return self.api(path, query, method)
        self.send_body(404, "text/plain", b"not found")

    # -- MCP
    def mcp(self):
        try:
            body = json.loads(self.read_body())
        except (ValueError, ToolError):
            return self.send_json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
        msgs = body if isinstance(body, list) else [body]
        replies = [r for r in (mcp_dispatch(m, {}) for m in msgs) if r]
        if not replies:
            return self.empty(202)
        self.send_json(200, replies if isinstance(body, list) else replies[0])

    # -- viewer API
    def api(self, path, query, method):
        q = urllib.parse.parse_qs(query)
        if method == "POST":
            ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            allowed = POST_TYPES.get(path, ("application/json",))
            if ctype not in allowed:
                self.close_connection = True   # the body is not read
                return self.send_json(415, {"error": f"Content-Type must be {' or '.join(allowed)}"})
        if path == "/api/state":
            name = CURRENT["name"]
            with LOG_LOCK:
                entries = list(LOG)[:120]
            return self.send_json(200, {
                "project": name, "renderer": project_renderer(proj_dir(name)) if name else None,
                "editor": EDITOR.state, "ready": EDITOR_READY.is_set(), "restarts": EDITOR.restarts,
                "stream": STREAM.state, "busy": BUSY["what"], "log": entries, "godot": GODOT_VERSION,
                "adapter": EDITOR_INFO.get("adapter"), "rendering_method": EDITOR_INFO.get("rendering_method"),
                "playing": EDITOR_READY.is_set() and playing(), "display": [SCREEN_W, SCREEN_H]})
        if path == "/api/projects" and method == "GET":
            return self.send_json(200, {"open": CURRENT["name"], "projects": list_projects()})
        if path == "/api/projects/new" and method == "POST":
            b = self.json_body()
            with PROJECT_LOCK:
                name = create_project(b.get("name"), b.get("template", "2d"), b.get("renderer"))
            return self.send_json(200, open_project(name))
        if path == "/api/projects/open" and method == "POST":
            return self.send_json(200, open_project(self.json_body().get("name")))
        if path == "/api/projects/upload" and method == "POST":
            n = int(self.headers.get("Content-Length") or 0)
            if not 0 < n <= MAX_UPLOAD:
                raise ToolError("upload a .zip between 1 byte and 2 GB")
            os.makedirs(TMP, exist_ok=True)
            fd, tmp = tempfile.mkstemp(suffix=".zip", dir=TMP)
            try:
                with os.fdopen(fd, "wb") as f:
                    left = n
                    while left:
                        chunk = self.rfile.read(min(left, 1 << 20))
                        if not chunk:
                            raise ToolError("upload interrupted")
                        f.write(chunk)
                        left -= len(chunk)
                if not zipfile.is_zipfile(tmp):
                    raise ToolError("that file is not a .zip")
                with PROJECT_LOCK:
                    name = unpack_project(tmp, (q.get("name") or [""])[0])
            finally:
                os.remove(tmp)
            return self.send_json(200, {"project": name})
        m = re.fullmatch(r"/api/projects/([^/]+)/download", path)
        if m and method in ("GET", "HEAD"):
            name = safe_name(urllib.parse.unquote(m.group(1)))
            tmp = zip_project(name)
            try:
                self.send_file(tmp, "application/zip", {"Content-Disposition": f'attachment; filename="{name}.zip"'})
            finally:
                os.remove(tmp)
            return
        m = re.fullmatch(r"/api/projects/([^/]+)/builds/(web|linux)\.zip", path)
        if m and method in ("GET", "HEAD"):
            name = safe_name(urllib.parse.unquote(m.group(1)))
            tmp = zip_build(name, m.group(2))
            try:
                self.send_file(tmp, "application/zip",
                               {"Content-Disposition": f'attachment; filename="{name}-{m.group(2)}.zip"'})
            finally:
                os.remove(tmp)
            return
        if path == "/api/outputs" and method == "GET":
            name = (q.get("project") or [CURRENT["name"] or ""])[0]
            return self.send_json(200, outputs(name))
        # Run and Stop in the viewer: the game runs in the editor, in a window over it, as the Play button there does.
        if path == "/api/run" and method == "POST":
            if not CURRENT["name"]:
                raise ToolError("no project is open")
            log(f"the game of {CURRENT['name']} was started from the viewer")
            return self.send_json(200, _run({"mode": "main"}, {}))
        if path == "/api/stop" and method == "POST":
            log("the game was stopped from the viewer")
            return self.send_json(200, bridge("stop", {}))
        if path == "/api/logs":
            ring = {"editor": EDITOR_OUT, "stream": STREAM_OUT, "x": X_OUT}.get((q.get("source") or ["editor"])[0], EDITOR_OUT)
            rows, _ = ring.since(None, limit=int((q.get("n") or ["300"])[0]))
            return self.send_body(200, "text/plain; charset=utf-8", "\n".join(t for _, t in rows).encode())
        self.send_json(404, {"error": "no such API"})

    # -- static
    def serve_files(self, path):
        rel = urllib.parse.unquote(path[len("/files/"):])
        full = os.path.realpath(os.path.join(DATA, rel))
        allowed = [os.path.realpath(EXPORTS) + os.sep, os.path.realpath(RENDERS) + os.sep]
        if not any(full.startswith(a) for a in allowed) or not os.path.isfile(full):
            return self.send_body(404, "text/plain", b"not found")
        ext = os.path.splitext(full)[1]
        inline = ext in (".mp4", ".png", ".jpg", ".wav")
        self.send_file(full, MIME.get(ext, "application/octet-stream"),
                       {} if inline else {"Content-Disposition": f'attachment; filename="{os.path.basename(full)}"'})

    # -- the stream: a byte pipe to Selkies on its Unix socket
    def proxy_stream(self):
        try:
            up = stream_connection(5)
        except OSError:
            return self.send_body(502, "text/plain", b"the stream is starting; reload in a few seconds")
        ws = self.headers.get("Upgrade", "").lower() == "websocket"
        head = [f"{self.command} {self.path} HTTP/1.1"]
        for k, v in self.headers.items():
            kl = k.lower()
            if kl == "authorization":
                continue   # this server's token, not Selkies'
            if kl in HOP and not (ws and kl in ("connection", "upgrade")):
                continue
            head.append(f"{k}: {v}")
        if not ws:
            head.append("Connection: close")
        try:
            body = b"" if ws else self.read_body()
            up.sendall(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + body)
            if ws:
                self.pipe(up)
            else:
                up.settimeout(60)
                while True:
                    data = up.recv(1 << 16)
                    if not data:
                        break
                    self.connection.sendall(data)
        except (OSError, ToolError):
            pass
        finally:
            up.close()
            self.close_connection = True

    def pipe(self, up):
        """Both directions of a WebSocket on one thread, without blocking: each side has a write queue, so a large
        video frame on its way to the browser never holds up the mouse and keyboard events coming back."""
        cl = self.connection
        cl.setblocking(False)
        up.setblocking(False)
        other = {cl: up, up: cl}
        queue = {cl: bytearray(), up: bytearray()}   # bytes waiting to be written to that socket
        try:
            queue[up] += self.rfile.read1(65536)   # anything already buffered behind the upgrade request
        except (BlockingIOError, TypeError):
            pass
        closed = None
        while True:
            if closed is not None and not queue[other[closed]]:
                return   # one side hung up and everything it sent has been delivered
            readers = [x for x in (cl, up) if x is not closed and len(queue[other[x]]) < (8 << 20)]
            writers = [x for x in (cl, up) if queue[x]]
            readable, writable, _ = select.select(readers, writers, [], 300)
            for x in readable:
                try:
                    data = x.recv(1 << 16)
                except BlockingIOError:
                    continue
                except OSError:
                    return
                if not data:
                    closed = x
                    continue
                queue[other[x]] += data
            for x in writable:
                try:
                    n = x.send(queue[x])
                except BlockingIOError:
                    continue
                except OSError:
                    return
                del queue[x][:n]


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


def link_templates():
    """Godot looks for export templates in ~/.local/share/godot/export_templates/<version>; they are in the image."""
    src = "/opt/godot/templates"
    dst = os.path.join(HOME, ".local", "share", "godot", "export_templates")
    os.makedirs(dst, exist_ok=True)
    for v in os.listdir(src):
        link = os.path.join(dst, v)
        if os.path.islink(link) and os.readlink(link) == os.path.join(src, v):
            continue
        if os.path.islink(link) or os.path.isfile(link):
            os.remove(link)
        elif os.path.isdir(link):
            shutil.rmtree(link)
        os.symlink(os.path.join(src, v), link)


def shutdown(signum, frame):
    log("stopping")
    p = EDITOR.proc
    EDITOR.release()
    if p and EDITOR_READY.is_set():
        try:
            bridge_raw("quit", timeout=5)
            p.wait(5)
        except Exception:
            pass
    for s in (EDITOR, STREAM, XVFB):
        s.stop(timeout=3)
    os._exit(0)


def main():
    global GODOT_VERSION
    if not TOKEN:
        print("GODOT_SERVER_TOKEN is not set; refusing to start a server that runs arbitrary code.", file=sys.stderr)
        sys.exit(1)
    no_core()
    not_dumpable()
    for d in (PROJECTS, EXPORTS, RENDERS, HOME, TMP):
        os.makedirs(d, exist_ok=True)
    os.makedirs(RUNTIME_DIR, mode=0o700, exist_ok=True)
    os.makedirs(SELKIES_DIR, mode=0o700, exist_ok=True)
    os.chmod(SELKIES_DIR, 0o700)
    os.makedirs("/tmp/selkies-home", exist_ok=True)
    link_templates()
    r = subprocess.run([GODOT, "--version"], capture_output=True, text=True, timeout=30, env=base_env())
    GODOT_VERSION = (r.stdout.strip().splitlines() or ["?"])[-1]
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    srv = Server((HOST, PORT), Handler)
    log(f"godot-server {GODOT_VERSION} on http://{HOST}:{PORT}, data in {DATA}, display {SCREEN_W}x{SCREEN_H}")
    log(f"GPU: {', '.join(g.get('name', '?') + ' ' + g.get('uuid', '') for g in gpu_info())}")
    start_display()
    STREAM.start(selkies_argv(), selkies_env())
    name = startup_project()
    path = proj_dir(name)
    install_addon(path)
    CURRENT.update(name=name, since=time.time())
    save_state()
    log(f"opening project {name} ({project_renderer(path)})")
    start_editor(path)
    srv.serve_forever()


if __name__ == "__main__":
    main()
