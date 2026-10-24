# The Blender server of the pithagoras-blender extension: headless Blender with its viewer's API and MCP on one
# loopback port, for hosts with Docker, and for the GPU the NVIDIA container toolkit. Built from the extension's folder
# (`docker build -f server/Dockerfile .`), so that its NOTICE goes into the image; .dockerignore lets nothing else in.
FROM ubuntu:24.04

ARG BLENDER_VERSION=5.2.2
ARG BLENDER_SERIES=5.2
ENV DEBIAN_FRONTEND=noninteractive

# Runtime libraries the official Linux build links against. libegl1/libgl1 are the GLVND loaders; the NVIDIA
# toolkit injects the vendor libraries (EGL for EEVEE, OptiX for Cycles) when NVIDIA_DRIVER_CAPABILITIES=all.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils \
      libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libice6 \
      libgl1 libegl1 libglx0 libopengl0 libxext6 libxrandr2 libxinerama1 libxcursor1 \
    && rm -rf /var/lib/apt/lists/*

# Official tarball, verified against blender.org's published checksum.
RUN set -eux; \
    base="https://download.blender.org/release/Blender${BLENDER_SERIES}"; \
    file="blender-${BLENDER_VERSION}-linux-x64.tar.xz"; \
    curl -fsSL -o "/tmp/${file}" "${base}/${file}"; \
    curl -fsSL "${base}/blender-${BLENDER_VERSION}.sha256" | grep " ${file}\$" > /tmp/sum; \
    cd /tmp && sha256sum -c sum; \
    mkdir -p /opt/blender && tar -xJf "/tmp/${file}" -C /opt/blender --strip-components=1; \
    rm -f "/tmp/${file}" /tmp/sum; \
    ln -s /opt/blender/blender /usr/local/bin/blender

# The extension's version, which the image is tagged with.
ARG VERSION=0.1.0
LABEL org.opencontainers.image.source="https://github.com/prometheion/pithagoras-extensions" \
      org.opencontainers.image.title="pithagoras-blender" \
      org.opencontainers.image.description="Headless Blender with MCP and the API of its browser viewer, for the pithagoras-blender extension of Pithagoras" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

# Blender runs as a user of its own, not root: it runs the Python the agent writes. What it may write is its home,
# /tmp and /data; the server and Blender itself are root's, so that code it runs cannot change them on disk.
RUN useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin blender \
    && mkdir /data && chown blender:blender /data

COPY server/server.py /opt/blender-server/
# What the image holds, under which licences, and where their sources are: the extension's NOTICE and the GPL of
# server.py.
COPY NOTICE /usr/share/doc/pithagoras-blender/NOTICE
COPY server/LICENSE /usr/share/doc/pithagoras-blender/LICENSE.GPL-3.0

# Scenes, renders and exports live here; the extension mounts its volume over it, which takes the folder's owner when
# Docker makes it. Nothing is published: the server binds the portal's loopback, which the container shares.
WORKDIR /data
USER blender

ENTRYPOINT ["blender", "-b", "--factory-startup", "--python", "/opt/blender-server/server.py", "--"]
