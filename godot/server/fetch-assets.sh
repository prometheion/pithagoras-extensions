#!/bin/sh
# Fetch and verify the third-party files the image is built from, into assets/ (the Docker build context).
# Run it on a machine with a fast link to GitHub; the build host then needs no downloads from GitHub.
#
#   Godot editor (linux.x86_64 zip)       checked against the release's SHA512-SUMS.txt
#   Godot export templates (.tpz, 1.3 GB) streamed, checked against SHA512-SUMS.txt; only the web (single-threaded)
#                                         and linux release templates are kept
#   Selkies .deb (browser stream)         checked against the release's SHA256SUMS
#   VirtualGL .deb (OpenGL on the GPU)    checked against the SHA-256 pinned below
#   Licence texts                         Godot's LICENSE.txt and COPYRIGHT.txt and Selkies' LICENSE at their release
#                                         tags, checked against the SHA-256 pinned below, for the image's
#                                         /usr/share/doc/pithagoras-godot
#
# Files that are already present and verify are not downloaded again. Needs curl and bsdtar (libarchive: macOS has it,
# Debian and Ubuntu have it in libarchive-tools): the templates are a zip read as it downloads, which GNU tar cannot.
set -eu

GODOT_VERSION="${GODOT_VERSION:-4.7.2}"
SELKIES_VERSION="${SELKIES_VERSION:-2.1.0}"
VGL_VERSION="${VGL_VERSION:-3.1.5}"
VGL_SHA256="${VGL_SHA256:-df3f7788ce41b182a47c0d298e5cd6d2d63579522cb41825970b7726e825485e}"
GODOT_LICENSE_SHA256="${GODOT_LICENSE_SHA256:-b0435e3b3e4e55238f05f4b306f30524a1b2e20147810d436eaa554fa6855c80}"
GODOT_COPYRIGHT_SHA256="${GODOT_COPYRIGHT_SHA256:-cb1980c88089573bcacd7221d777c689bb8bbd778799f24c27fca0fe5f774d6d}"
SELKIES_LICENSE_SHA256="${SELKIES_LICENSE_SHA256:-1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5}"

ts() { date "+%Y-%m-%d %H:%M:%S"; }
step() { echo "$(ts) $*"; }
sha512() { if command -v sha512sum >/dev/null 2>&1; then sha512sum "$@"; else shasum -a 512 "$@"; fi; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

command -v bsdtar >/dev/null 2>&1 || { echo "bsdtar is needed to read the export templates as they download (apt-get install libarchive-tools)" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
A="$HERE/assets"
mkdir -p "$A/templates"
GH="https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-stable"

step "1/6 Godot ${GODOT_VERSION} checksums"
curl -fsSL -o "$A/godot-SHA512-SUMS.txt" "$GH/SHA512-SUMS.txt"

EDITOR_ZIP="Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip"
want_editor="$(grep " ${EDITOR_ZIP}\$" "$A/godot-SHA512-SUMS.txt" | cut -d' ' -f1)"
[ -n "$want_editor" ] || { echo "no checksum for ${EDITOR_ZIP}" >&2; exit 1; }
step "2/6 Godot editor ${EDITOR_ZIP}"
if [ -f "$A/$EDITOR_ZIP" ] && [ "$(sha512 "$A/$EDITOR_ZIP" | cut -d' ' -f1)" = "$want_editor" ]; then
  step "     already present and verified"
else
  curl -fL --progress-bar -o "$A/$EDITOR_ZIP.part" "$GH/$EDITOR_ZIP"
  [ "$(sha512 "$A/$EDITOR_ZIP.part" | cut -d' ' -f1)" = "$want_editor" ] || { echo "SHA512 mismatch for ${EDITOR_ZIP}" >&2; exit 1; }
  mv "$A/$EDITOR_ZIP.part" "$A/$EDITOR_ZIP"
  step "     SHA512 OK"
fi

TPZ="Godot_v${GODOT_VERSION}-stable_export_templates.tpz"
want_tpz="$(grep " ${TPZ}\$" "$A/godot-SHA512-SUMS.txt" | cut -d' ' -f1)"
[ -n "$want_tpz" ] || { echo "no checksum for ${TPZ}" >&2; exit 1; }
KEEP="templates/version.txt templates/web_nothreads_release.zip templates/web_nothreads_debug.zip templates/linux_release.x86_64"
step "3/6 export templates (${TPZ}, keeping web single-threaded + linux release)"
if [ -f "$A/templates/.tpz-sha512" ] && [ "$(cat "$A/templates/.tpz-sha512")" = "$want_tpz" ] \
   && (cd "$A/templates" && sha256 -c SHA256SUMS >/dev/null 2>&1); then
  step "     already present and verified"
else
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/godot-tpz.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  mkfifo "$tmp/stream"
  sha512 < "$tmp/stream" | cut -d' ' -f1 > "$tmp/sum" &
  sumpid=$!
  # bsdtar reads a zip sequentially from a pipe; drain whatever it leaves so the checksum covers the whole file
  curl -fL --progress-bar "$GH/$TPZ" | tee "$tmp/stream" | { bsdtar -xf - -C "$tmp" $KEEP; cat > /dev/null; }
  wait "$sumpid"
  got="$(cat "$tmp/sum")"
  [ "$got" = "$want_tpz" ] || { echo "SHA512 mismatch for ${TPZ}: $got" >&2; exit 1; }
  step "     SHA512 of the full stream OK"
  rm -f "$A/templates/"*
  for f in $KEEP; do mv "$tmp/$f" "$A/templates/"; done
  (cd "$A/templates" && sha256 version.txt web_nothreads_release.zip web_nothreads_debug.zip linux_release.x86_64 > SHA256SUMS)
  echo "$want_tpz" > "$A/templates/.tpz-sha512"
  rm -rf "$tmp"; trap - EXIT
fi
[ "$(cat "$A/templates/version.txt")" = "${GODOT_VERSION}.stable" ] || { echo "templates are not ${GODOT_VERSION}.stable" >&2; exit 1; }

SELKIES_DEB="selkies-${SELKIES_VERSION}-ubuntu24.04-amd64.deb"
step "4/6 Selkies ${SELKIES_VERSION} (${SELKIES_DEB})"
SGH="https://github.com/selkies-project/selkies/releases/download/${SELKIES_VERSION}"
curl -fsSL -o "$A/selkies-SHA256SUMS" "$SGH/SHA256SUMS"
want_selkies="$(grep " ${SELKIES_DEB}\$" "$A/selkies-SHA256SUMS" | cut -d' ' -f1)"
[ -n "$want_selkies" ] || { echo "no checksum for ${SELKIES_DEB}" >&2; exit 1; }
if [ -f "$A/$SELKIES_DEB" ] && [ "$(sha256 "$A/$SELKIES_DEB" | cut -d' ' -f1)" = "$want_selkies" ]; then
  step "     already present and verified"
else
  curl -fL --progress-bar -o "$A/$SELKIES_DEB.part" "$SGH/$SELKIES_DEB"
  [ "$(sha256 "$A/$SELKIES_DEB.part" | cut -d' ' -f1)" = "$want_selkies" ] || { echo "SHA256 mismatch for ${SELKIES_DEB}" >&2; exit 1; }
  mv "$A/$SELKIES_DEB.part" "$A/$SELKIES_DEB"
  step "     SHA256 OK"
fi

VGL_DEB="virtualgl_${VGL_VERSION}_amd64.deb"
step "5/6 VirtualGL ${VGL_VERSION} (${VGL_DEB})"
if [ -f "$A/$VGL_DEB" ] && [ "$(sha256 "$A/$VGL_DEB" | cut -d' ' -f1)" = "$VGL_SHA256" ]; then
  step "     already present and verified"
else
  curl -fL --progress-bar -o "$A/$VGL_DEB.part" "https://github.com/VirtualGL/virtualgl/releases/download/${VGL_VERSION}/${VGL_DEB}"
  [ "$(sha256 "$A/$VGL_DEB.part" | cut -d' ' -f1)" = "$VGL_SHA256" ] || { echo "SHA256 mismatch for ${VGL_DEB}" >&2; exit 1; }
  mv "$A/$VGL_DEB.part" "$A/$VGL_DEB"
  step "     SHA256 OK"
fi

step "6/6 licence texts (Godot ${GODOT_VERSION}-stable, Selkies ${SELKIES_VERSION})"
mkdir -p "$A/licenses"
fetch_text() {   # url, file, sha256
  if [ -f "$A/licenses/$2" ] && [ "$(sha256 "$A/licenses/$2" | cut -d' ' -f1)" = "$3" ]; then return; fi
  curl -fsSL -o "$A/licenses/$2.part" "$1"
  [ "$(sha256 "$A/licenses/$2.part" | cut -d' ' -f1)" = "$3" ] || { echo "SHA256 mismatch for $2" >&2; exit 1; }
  mv "$A/licenses/$2.part" "$A/licenses/$2"
}
RAW="https://raw.githubusercontent.com"
fetch_text "$RAW/godotengine/godot/${GODOT_VERSION}-stable/LICENSE.txt" godot-LICENSE.txt "$GODOT_LICENSE_SHA256"
fetch_text "$RAW/godotengine/godot/${GODOT_VERSION}-stable/COPYRIGHT.txt" godot-COPYRIGHT.txt "$GODOT_COPYRIGHT_SHA256"
fetch_text "$RAW/selkies-project/selkies/${SELKIES_VERSION}/LICENSE" selkies-LICENSE "$SELKIES_LICENSE_SHA256"
step "     SHA256 OK"

# One list the Dockerfile checks again after the files reach the build host.
(cd "$A" && sha256 "$EDITOR_ZIP" "$SELKIES_DEB" "$VGL_DEB" licenses/godot-LICENSE.txt licenses/godot-COPYRIGHT.txt \
  licenses/selkies-LICENSE > SHA256SUMS.build)
du -sh "$A" | sed "s/^/$(ts) assets: /"
step "DONE"
