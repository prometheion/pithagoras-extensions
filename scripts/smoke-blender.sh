#!/bin/sh
# The Blender image's smoke test, as the release runs it before the image is pushed: the image started as the extension
# makes it, on a network with no way out made for the run (internal, with no gateway, which takes Docker Engine 28.0 or
# later, and shows that it starts with no internet), with no GPU and a random token, until MCP answers, asked from
# inside the container, as nothing else reaches it; its tools/list and its instructions compared with
# blender/server/tools.json, which the extension offers in their place (a change to the server's tools changes that
# file, the label and guard tables and their German); a script sent with its name, as the portal sends one it read
# from the agent's files, run under that name, with its ARGS;
# the viewer's API and MCP refused without the token; Blender run
# as the image's own user, which cannot change the server; then the container and the network removed.
#   scripts/smoke-blender.sh <image>        SMOKE_PORT (default 3870) and SMOKE_NAME (default blender-smoke) change them
set -eu
ts() { date "+%Y-%m-%d %H:%M:%S"; }
IMAGE="$1"
PORT="${SMOKE_PORT:-3870}"
NAME="${SMOKE_NAME:-blender-smoke}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TOKEN=$(openssl rand -hex 24)
NETWORK="$NAME-net"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker network rm "$NETWORK" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "$(ts) making the network $NETWORK, with no way out"
docker network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated "$NETWORK" >/dev/null
# As JSON: Docker 29's template prints a gateway there is none of as "invalid IP".
config=$(docker network inspect -f '{{json .IPAM.Config}}' "$NETWORK")
if echo "$config" | grep -q '"Gateway":"[0-9a-fA-F]'; then echo "$(ts) $NETWORK has a gateway ($config): this Docker is older than 28.0, which the extension needs"; exit 1; fi

echo "$(ts) starting $IMAGE as $NAME on $NETWORK, port $PORT"
docker run -d --name "$NAME" --network "$NETWORK" -e BLENDER_SERVER_TOKEN="$TOKEN" -e BLENDER_SERVER_HOST=0.0.0.0 -e BLENDER_SERVER_PORT="$PORT" "$IMAGE" >/dev/null
mcp() { docker exec "$NAME" curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$1" "http://127.0.0.1:$PORT/mcp"; }

echo "$(ts) waiting for MCP to answer ping"
i=0
until mcp '{"jsonrpc":"2.0","id":1,"method":"ping"}' | grep -q '"result"'; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then docker logs "$NAME" | tail -40; echo "$(ts) MCP did not answer in 120 s"; exit 1; fi
  sleep 1
done

echo "$(ts) comparing tools/list and the instructions with blender/server/tools.json"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' > "/tmp/$NAME-tools.json"
mcp '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' > "/tmp/$NAME-init.json"
python3 -c '
import json, sys
listed = json.load(open(sys.argv[1]))["result"]["tools"]
instructions = json.load(open(sys.argv[2]))["result"]["instructions"]
kept = json.load(open(sys.argv[3]))
if listed != kept["tools"]:
    sys.exit("the image lists other tools than blender/server/tools.json")
if instructions != kept["instructions"]:
    sys.exit("the image gives other instructions than blender/server/tools.json")
print(len(listed), "tools and the instructions, as blender/server/tools.json has them")
' "/tmp/$NAME-tools.json" "/tmp/$NAME-init.json" "$ROOT/blender/server/tools.json"

echo "$(ts) a script sent with its name reads its ARGS, and its error names the file and the line"
mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"execute_code","arguments":{"script_name":"scripts/smoke.py","args":{"n":2},"code":"print(ARGS[\"n\"] * 21)\nraise ValueError(\"on purpose\")\n"}}}' > "/tmp/$NAME-script.json"
python3 -c '
import json, sys
result = json.load(open(sys.argv[1]))["result"]
text = result["content"][0]["text"]
for want in ("42", "File \"scripts/smoke.py\", line 2, in <module>", "ValueError: on purpose"):
    if want not in text or not result["isError"]:
        sys.exit("the script error does not say " + repr(want) + ": " + text)
print("the script printed 42, and its error names scripts/smoke.py, line 2")
' "/tmp/$NAME-script.json"

echo "$(ts) Blender runs as the image's own user, which cannot change the server"
user=$(docker exec "$NAME" id -un)
[ "$user" = blender ] || { echo "$(ts) Blender runs as $user"; exit 1; }
if docker exec "$NAME" test -w /opt/blender-server/server.py; then echo "$(ts) $user can change server.py"; exit 1; fi

for route in /api/state /files/previews/latest.png /mcp; do
  method=GET; [ "$route" = /mcp ] && method=POST
  code=$(docker exec "$NAME" curl -s -o /dev/null -w "%{http_code}" -X "$method" "http://127.0.0.1:$PORT$route")
  echo "$(ts) $method $route without the token: $code"
  [ "$code" = 401 ] || { echo "$(ts) $route answered $code without the token"; exit 1; }
done

echo "$(ts) DONE: $IMAGE answers MCP with its tools, runs as $user, and refuses requests without the token"
