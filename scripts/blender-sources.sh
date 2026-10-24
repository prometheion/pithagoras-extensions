#!/bin/sh
# The sources of the copyleft libraries (GPL, LGPL and MPL) the official Linux build of Blender includes, as the
# release attaches them beside Blender's own source: the official build links them in, so the corresponding source of
# the binary in the image is Blender's source and theirs. Each is read from Blender's own source tarball, which pins it:
# build_files/build_environment/cmake/versions.cmake has each library's file, its hash and its licence, and
# download.cmake the branch of Blender's mirror (projects.blender.org/blender/lib-source) the official build fetched it
# from. Each is downloaded from there and checked against its pinned hash. The patches the build applies to them are in
# the tarball itself (build_files/build_environment/patches/).
#
# A library versions.cmake marks GPL, LGPL or MPL that is neither on the list nor among those the Linux build leaves out
# (build_files/build_environment/CMakeLists.txt says which) stops the script: an update of Blender that adds one must
# add it here, after reading that file.
#   scripts/blender-sources.sh <blender version> <folder>   the folder has blender-<version>.tar.xz; the sources go there
set -eu
ts() { date "+%Y-%m-%d %H:%M:%S"; }
VERSION="$1"
OUT="$2"
TARBALL="$OUT/blender-$VERSION.tar.xz"
# In the official Linux build (build_files/build_environment/CMakeLists.txt of Blender 5.2), by versions.cmake's names.
LINUX="FFMPEG X264 X265 LAME FFTW FLAC SNDFILE OPENAL GMP POTRACE FRIBIDI LIBHEIF RUBBERBAND OPENVDB EIGEN"
# Built for Windows and macOS only.
NOT_LINUX="ICONV"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "$(ts) reading the libraries' pins from $TARBALL"
for file in versions.cmake download.cmake; do
  tar -xJf "$TARBALL" -O "blender-$VERSION/build_files/build_environment/cmake/$file" > "$WORK/$file"
done

python3 - "$WORK" "$LINUX" "$NOT_LINUX" > "$WORK/list" <<'EOF'
import re, sys
work, linux, not_linux = sys.argv[1], sys.argv[2].split(), sys.argv[3].split()
values = {}
for line in open(f"{work}/versions.cmake", encoding="utf8"):
    m = re.match(r"\s*set\((\w+)\s+(.*?)\s*\)\s*(#.*)?$", line)
    if m and not m.group(2).startswith("[=["):
        values[m.group(1)] = m.group(2).strip('"')
def expand(text):
    return re.sub(r"\$\{(\w+)\}", lambda m: expand(values[m.group(1)]), text)
series = re.search(r"^set\(BLENDER_VERSION (\S+)\)", open(f"{work}/download.cmake", encoding="utf8").read(), re.M).group(1)
copyleft = sorted(k[: -len("_LICENSE")] for k, v in values.items() if k.endswith("_LICENSE") and ("GPL" in v or "MPL" in v))
unknown = [name for name in copyleft if name not in linux and name not in not_linux]
if unknown:
    sys.exit(f"versions.cmake marks these GPL, LGPL or MPL, and this script does not know them: {', '.join(unknown)}")
for name in linux:
    if f"{name}_FILE" not in values:
        sys.exit(f"versions.cmake has no {name}_FILE: the list in this script is not Blender's any more")
    print("|".join([name, expand(values[f"{name}_VERSION"]), values[f"{name}_LICENSE"].removeprefix("SPDX:"), expand(values[f"{name}_FILE"]),
                    values[f"{name}_HASH_TYPE"].lower(), values[f"{name}_HASH"],
                    f"https://projects.blender.org/blender/lib-source/media/branch/blender-v{series}-release/{expand(values[f'{name}_FILE'])}"]))
EOF

MANIFEST="$OUT/blender-$VERSION-libraries.txt"
echo "The copyleft libraries (GPL, LGPL, MPL) in the official Linux build of Blender $VERSION, with the files attached beside this list." > "$MANIFEST"
echo "Pinned by build_files/build_environment/cmake/versions.cmake in blender-$VERSION.tar.xz; patched as build_files/build_environment/patches/ there says." >> "$MANIFEST"
while IFS='|' read -r name version licence file kind hash url; do
  echo "$(ts) $name $version ($licence): $file"
  curl -fsSL -o "$OUT/$file" "$url"
  python3 -c 'import hashlib, sys; d = hashlib.new(sys.argv[1], open(sys.argv[2], "rb").read()).hexdigest(); sys.exit(0 if d == sys.argv[3] else f"{sys.argv[2]}: {sys.argv[1]} is {d}, versions.cmake pins {sys.argv[3]}")' "$kind" "$OUT/$file" "$hash"
  printf '%s\t%s\t%s\t%s\t%s:%s\n' "$name" "$version" "$licence" "$file" "$kind" "$hash" >> "$MANIFEST"
done < "$WORK/list"

echo "$(ts) DONE: $(($(wc -l < "$MANIFEST") - 2)) library sources in $OUT, each checked against its pinned hash, listed in $(basename "$MANIFEST")"
