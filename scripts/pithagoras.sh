#!/bin/sh
# Fetches Pithagoras at the version of @pithagoras/extension-api this repository builds with (its tag, v<version>)
# into .pithagoras/ (or $PITHAGORAS_DIR), installs what it is built with and builds its server, for the portal-tier
# tests: PITHAGORAS_DIR=.pithagoras npm run test:portal. Nothing outside that folder is changed.
set -eu
ts() { date "+%Y-%m-%d %H:%M:%S"; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR="${PITHAGORAS_DIR:-$ROOT/.pithagoras}"
VERSION=$(node -p "require('$ROOT/node_modules/@pithagoras/extension-api/package.json').version")
TAG="v$VERSION"

echo "$(ts) Pithagoras $TAG into $DIR"
if [ -d "$DIR/.git" ]; then
  echo "$(ts) already cloned: checking out $TAG"
  git -C "$DIR" fetch -q --depth 1 origin tag "$TAG"
  git -C "$DIR" -c advice.detachedHead=false checkout -q "$TAG"
else
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$TAG" https://github.com/thecodacus/pithagoras.git "$DIR"
fi
echo "$(ts) installing its packages (npm ci)"
(cd "$DIR" && npm ci --no-audit --no-fund --loglevel=error)
echo "$(ts) building its server (core/server)"
(cd "$DIR" && npm run build -w core/server --silent)
echo "$(ts) DONE: Pithagoras $TAG at $DIR"
