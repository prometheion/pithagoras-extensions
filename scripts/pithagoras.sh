#!/bin/sh
# Fetches Pithagoras at the version of @pithagoras/extension-api this repository builds with (its tag, v<version>)
# into .pithagoras/ (or $PITHAGORAS_DIR), installs what it is built with and builds its server, for the portal-tier
# tests, which start an extension's server half under the portal's own extension host:
#
#   ./scripts/pithagoras.sh && PITHAGORAS_DIR=$PWD/.pithagoras npm run test:portal
#
# PITHAGORAS_REPO names another place to clone it from (a local checkout). PITHAGORAS_REF another commit, branch or
# tag to fetch than that version's tag: one with what the extensions need of Pithagoras that no release has yet (the
# CI's, until the next release). Nothing outside that folder is changed.
set -eu
ts() { date "+%Y-%m-%d %H:%M:%S"; }
step() { echo "$(ts) $*"; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR="${PITHAGORAS_DIR:-$ROOT/.pithagoras}"
REPO="${PITHAGORAS_REPO:-https://github.com/thecodacus/pithagoras.git}"
VERSION=$(node -p "require('$ROOT/node_modules/@pithagoras/extension-api/package.json').version")
REF="${PITHAGORAS_REF:-v$VERSION}"

step "1/3 Pithagoras $REF from $REPO into $DIR"
# Fetched by its name, whatever it is: `git clone --branch` takes no commit.
if [ ! -d "$DIR/.git" ]; then
  git init -q "$DIR"
  git -C "$DIR" remote add origin "$REPO"
fi
git -C "$DIR" fetch -q --depth 1 origin "$REF"
git -C "$DIR" -c advice.detachedHead=false checkout -q FETCH_HEAD
step "2/3 its packages (npm ci)"
(cd "$DIR" && npm ci --no-audit --no-fund --loglevel=error)
step "3/3 its server (core/server)"
(cd "$DIR" && npm run build -w core/server --silent)
step "DONE: Pithagoras $REF at $DIR"
