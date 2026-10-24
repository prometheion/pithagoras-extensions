#!/bin/sh
# Fetches Pithagoras at the version of @pithagoras/extension-api this repository builds with (its tag, v<version>)
# into .pithagoras/ (or $PITHAGORAS_DIR), installs what it is built with and builds its server, for the portal-tier
# tests, which start an extension's server half under the portal's own extension host:
#
#   ./scripts/pithagoras.sh && PITHAGORAS_DIR=$PWD/.pithagoras npm run test:portal
#
# PITHAGORAS_REPO names another place to clone it from (a local checkout). Nothing outside that folder is changed.
set -eu
ts() { date "+%Y-%m-%d %H:%M:%S"; }
step() { echo "$(ts) $*"; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR="${PITHAGORAS_DIR:-$ROOT/.pithagoras}"
REPO="${PITHAGORAS_REPO:-https://github.com/thecodacus/pithagoras.git}"
VERSION=$(node -p "require('$ROOT/node_modules/@pithagoras/extension-api/package.json').version")
TAG="v$VERSION"

step "1/3 Pithagoras $TAG from $REPO into $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q --depth 1 origin tag "$TAG"
  git -C "$DIR" -c advice.detachedHead=false checkout -q "$TAG"
else
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$TAG" "$REPO" "$DIR"
fi
step "2/3 its packages (npm ci)"
(cd "$DIR" && npm ci --no-audit --no-fund --loglevel=error)
step "3/3 its server (core/server)"
(cd "$DIR" && npm run build -w core/server --silent)
step "DONE: Pithagoras $TAG at $DIR"
