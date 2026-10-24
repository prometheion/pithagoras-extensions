# The Godot editor on the GPU, streamed to the browser and driven over MCP: the container the Pithagoras Godot
# extension runs (see ../README.md). Built in CI and published as ghcr.io/thecodacus/pithagoras-godot:<version>.
# Build context: this folder after ./fetch-assets.sh has filled assets/ (nothing is downloaded from GitHub here).
FROM ubuntu:24.04

ARG GODOT_VERSION=4.7.2
ARG SELKIES_VERSION=2.1.0
ARG VGL_VERSION=3.1.5
ARG VERSION=0.1.0
LABEL org.opencontainers.image.title="pithagoras-godot" \
      org.opencontainers.image.description="The Godot ${GODOT_VERSION} editor on the GPU, streamed with Selkies and driven over MCP, for the Pithagoras Godot extension" \
      org.opencontainers.image.source="https://github.com/thecodacus/pithagoras-flair" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0 AND MIT AND MPL-2.0 AND GPL-2.0-or-later AND LGPL-2.1-or-later AND LGPL-3.0-or-later AND LGPL-2.0-or-later WITH WxWindows-exception-3.1"
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1

# Xvfb with GLX (NVIDIA's Vulkan driver presents into it), the X/GL/font libraries the official Godot build loads,
# xdotool to find the running game's window, ffmpeg to turn recordings into MP4.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates unzip python3 \
      xvfb xauth x11-utils xdotool \
      libvulkan1 libgl1 libegl1 libglx-mesa0 libgl1-mesa-dri libglu1-mesa \
      libxcursor1 libxinerama1 libxrandr2 libxi6 libxkbcommon0 libxext6 libxrender1 libxtst6 \
      libfontconfig1 fonts-dejavu-core \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Selkies (the browser stream) and VirtualGL (OpenGL on the GPU for Compatibility-renderer projects), checked
# against the sums fetch-assets.sh took from the Selkies release and the pinned VirtualGL hash.
COPY assets/SHA256SUMS.build assets/selkies-${SELKIES_VERSION}-ubuntu24.04-amd64.deb assets/virtualgl_${VGL_VERSION}_amd64.deb /tmp/pkgs/
# Ubuntu's image leaves package documentation out (dpkg's path-exclude), so VirtualGL's licence is taken from its .deb.
RUN cd /tmp/pkgs && grep -E '\.deb$' SHA256SUMS.build | sha256sum -c - \
    && apt-get update && apt-get install -y --no-install-recommends ./selkies-*.deb ./virtualgl_*.deb \
    && mkdir -p /usr/share/doc/pithagoras-godot vgl \
    && dpkg-deb --fsys-tarfile ./virtualgl_${VGL_VERSION}_amd64.deb | tar -x -C vgl \
         ./usr/share/doc/virtualgl-${VGL_VERSION}/LICENSE.txt ./usr/share/doc/virtualgl-${VGL_VERSION}/LICENSE-FLTK.txt \
    && mv vgl/usr/share/doc/virtualgl-${VGL_VERSION}/LICENSE.txt /usr/share/doc/pithagoras-godot/virtualgl-LICENSE.txt \
    && mv vgl/usr/share/doc/virtualgl-${VGL_VERSION}/LICENSE-FLTK.txt /usr/share/doc/pithagoras-godot/virtualgl-LICENSE-FLTK.txt \
    && cd / && rm -rf /var/lib/apt/lists/* /tmp/pkgs

# The browser gets Selkies' web client from the extension's package (src/stream, served by its server half), never
# from here. It speaks the stream's protocol of the Selkies installed here, so the build stops unless the installed
# client is the one the package has: selkies-web.sha256 lists its files, and a unit test holds the package to it.
COPY selkies-web.sha256 /tmp/
RUN cd /opt/selkies/lib/python3.12/site-packages/selkies/selkies_web && sha256sum -c /tmp/selkies-web.sha256 \
    && rm /tmp/selkies-web.sha256

# Godot itself, checked against the release's SHA512-SUMS.txt.
COPY assets/godot-SHA512-SUMS.txt assets/Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip /tmp/godot/
RUN cd /tmp/godot \
    && grep " Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip\$" godot-SHA512-SUMS.txt | sha512sum -c - \
    && unzip -q "Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip" -d x \
    && mkdir -p /opt/godot && mv "x/Godot_v${GODOT_VERSION}-stable_linux.x86_64" /opt/godot/godot \
    && ln -s /opt/godot/godot /usr/local/bin/godot && rm -rf /tmp/godot

# Export templates: web (single-threaded) and linux release, taken from the release's .tpz by fetch-assets.sh.
COPY assets/templates/ /opt/godot/templates/${GODOT_VERSION}.stable/
RUN cd /opt/godot/templates/${GODOT_VERSION}.stable && sha256sum -c SHA256SUMS \
    && [ "$(cat version.txt)" = "${GODOT_VERSION}.stable" ]

# What the image redistributes, and under which licences (NOTICE): Godot's licence and its third-party notices, Selkies'
# licence, the licences pixelflux (inside Selkies) gives for itself and for the x264 and x265 it bundles, and VirtualGL's.
COPY assets/SHA256SUMS.build /tmp/lic/
COPY assets/licenses/ /tmp/lic/licenses/
COPY NOTICE /usr/share/doc/pithagoras-godot/NOTICE
RUN cd /tmp/lic && grep ' licenses/' SHA256SUMS.build | sha256sum -c - \
    && mv licenses/* /usr/share/doc/pithagoras-godot/ && rm -rf /tmp/lic \
    && cp /opt/selkies/lib/python3*/site-packages/pixelflux-*.dist-info/licenses/LICENSES.md /usr/share/doc/pithagoras-godot/pixelflux-LICENSES.md

# The NVIDIA container toolkit mounts the driver's libraries but not these two loader manifests; without them
# Vulkan and EGL quietly fall back to Mesa's software renderers. Where a toolkit mounts its own, that covers these.
RUN mkdir -p /etc/vulkan/icd.d /usr/share/glvnd/egl_vendor.d \
    && printf '{"file_format_version":"1.0.1","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.4.329"}}\n' \
         > /etc/vulkan/icd.d/nvidia_icd.json \
    && printf '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0"}}\n' \
         > /usr/share/glvnd/egl_vendor.d/10_nvidia.json

# No sound card in a container: ALSA's default device is the null plugin, so games run from the editor open their
# audio quietly instead of logging driver errors (Movie Maker records audio through its own driver).
RUN printf 'pcm.!default { type null }\n' > /etc/asound.conf

# Everything in the container runs as godot (uid 10001), which owns /data and nothing the server serves or runs:
# the server, the editor, the games and the agent's GDScript alike. The image's own files stay root's, so nothing
# that runs here can change them. /tmp/.X11-unix is made as X expects it, root's and open to all with the sticky bit,
# since Xvfb runs as godot too. A new volume at /data takes the folder's owner from the image.
RUN useradd --uid 10001 --user-group --home-dir /data/home --no-create-home --shell /usr/sbin/nologin godot \
    && mkdir -p /data /tmp/.X11-unix && chown godot:godot /data && chmod 1777 /tmp/.X11-unix

ENV GODOT_VERSION=${GODOT_VERSION}
COPY addon/ /opt/godot-server/addon/
COPY server.py /opt/godot-server/

USER 10001:10001
WORKDIR /data
# Nothing is published: the server listens on the loopback of the portal's network namespace.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD python3 -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('GODOT_SERVER_PORT', '3880'), timeout=4)"
# -I: Python's isolated mode, so the server never imports anything from the environment or from a site folder under
# the home the editor writes to, which agent-written code could put there for the next start.
ENTRYPOINT ["python3", "-I", "/opt/godot-server/server.py"]
