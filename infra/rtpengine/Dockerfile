# infra/rtpengine/Dockerfile
# X01 — rtpengine sidecar for FreeSWITCH SRTP offload.
# Base: Debian Bookworm to match SignalWire FS base image.
#
# Kernel module compilation is NOT done here — the module is built against
# the host kernel and loaded on the host. The container runs in userspace mode
# by default; kernel mode is enabled at runtime via RTPENGINE_KERNEL_MODE=1.
#
# Package source: Sipwise APT repo (https://deb.sipwise.com/spce/)
# Version: mr12.5 (current stable). Package name: ngcp-rtpengine.
# Built-in Prometheus endpoint (--prometheus-listen) available since mr11.0.

ARG RTPENGINE_VERSION=mr12.5

FROM debian:bookworm-slim AS base

# Install Sipwise APT repo GPG key and source, then install rtpengine.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
    && curl -fsSL https://deb.sipwise.com/spce/release.gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/sipwise-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/sipwise-archive-keyring.gpg] \
https://deb.sipwise.com/spce/ bookworm main" \
        > /etc/apt/sources.list.d/sipwise.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ngcp-rtpengine \
        # For healthcheck (ng-protocol UDP probe)
        netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Copy config and scripts from build context (infra/rtpengine/).
COPY rtpengine.conf.example /etc/rtpengine/rtpengine.conf.example
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

# ng-control protocol (loopback only; bound to 127.0.0.1 in entrypoint).
EXPOSE 22222/udp
# RTP/RTCP range: 10,000 ports = 5,000 concurrent streams = ~2,500 bridged calls.
EXPOSE 30000-40000/udp
# Built-in Prometheus metrics endpoint (mr11.0+).
EXPOSE 9109/tcp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
