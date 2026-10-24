#!/bin/sh
# The image's smoke test, which the release workflow runs before it publishes the image: the image started with no
# GPU and a random token, MCP answering ping, its tools/list and the instructions its initialize gives equal to the
# committed tools.json, which is what the extension relays (a change to the server's tools or instructions must change
# that file, and with it the label table and its German), and the viewer's routes refusing a request
# without the token. The checks run inside the container, with its own Python. The container is removed at the end,
# whatever happened.
#
#   godot/server/smoke-test.sh ghcr.io/thecodacus/pithagoras-godot:0.1.0
#
# NAME, PORT and NETWORK change the container's name, the server's port and the container's network (by default
# pithagoras-godot-smoke, 3880 and host: the runner's loopback, as the portal's would be).
set -eu
IMAGE="${1:?the image to test}"
NAME="${NAME:-pithagoras-godot-smoke}"
PORT="${PORT:-3880}"
NETWORK="${NETWORK:-host}"
HERE=$(cd "$(dirname "$0")" && pwd)
ts() { date "+%Y-%m-%d %H:%M:%S"; }
step() { echo "$(ts) $*"; }
TOKEN=$(python3 -c "import secrets; print(secrets.token_hex(24))")
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

step "1/3 starting $IMAGE as $NAME (no GPU, network $NETWORK, port $PORT)"
# As the extension makes it: its own user, no capabilities, no way to gain one.
docker run -d --name "$NAME" --network "$NETWORK" --init --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
  -e GODOT_SERVER_TOKEN="$TOKEN" -e GODOT_SERVER_PORT="$PORT" "$IMAGE" >/dev/null
docker cp "$HERE/tools.json" "$NAME:/tmp/tools.json"

step "2/3 MCP ping, initialize and tools/list against tools.json, and the routes without the token"
docker exec -i "$NAME" python3 - "$PORT" "$TOKEN" <<'PY'
import json, sys, time, urllib.error, urllib.request
port, token = sys.argv[1], sys.argv[2]
base = f"http://127.0.0.1:{port}"
def rpc(method, params=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode()
    req = urllib.request.Request(base + "/mcp", body, {"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())["result"]
for _ in range(120):
    try:
        rpc("ping")
        break
    except (OSError, ValueError):
        time.sleep(1)
else:
    sys.exit("the server did not answer ping within 120 s")
kept = json.load(open("/tmp/tools.json"))
said = rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "1"}})["instructions"]
if said != kept["instructions"]:
    sys.exit("initialize gives other instructions than tools.json")
got = rpc("tools/list")["tools"]
want = kept["tools"]
if got != want:
    names = lambda tools: [t["name"] for t in tools]
    sys.exit(f"tools/list is not tools.json: {names(got)} against {names(want)} (or a description or schema differs)")
print(f"  {len(got)} tools and the instructions, as tools.json has them")
for path in ("/", "/api/state", "/mcp", "/stream/"):
    try:
        urllib.request.urlopen(urllib.request.Request(base + path, b"{}" if path == "/mcp" else None), timeout=10)
        sys.exit(f"{path} answered without the token")
    except urllib.error.HTTPError as e:
        if e.code != 401:
            sys.exit(f"{path} answered {e.code} without the token, not 401")
print("  /, /api/state, /mcp and /stream/ answer 401 without the token")
PY

step "3/3 removing $NAME"
docker rm -f "$NAME" >/dev/null
trap - EXIT
step "DONE"
