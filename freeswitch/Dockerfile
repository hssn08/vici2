# syntax=docker/dockerfile:1.7
# vici2 FreeSWITCH 1.10.x image. Pulls from SignalWire APT repo.
# A SIGNALWIRE_TOKEN (free signup at https://signalwire.com) is required to
# install the freeswitch-meta-vanilla package set.

ARG FREESWITCH_VERSION=1.10.12

# ----- builder ---------------------------------------------------------------
FROM debian:bookworm-slim AS builder
ARG SIGNALWIRE_TOKEN
ARG FREESWITCH_VERSION

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Configure SignalWire APT repo. Token is required; surface a clear error early
# so misconfigured builds fail fast.
RUN if [ -z "${SIGNALWIRE_TOKEN}" ]; then \
        echo "ERROR: SIGNALWIRE_TOKEN build-arg is required."; exit 2; fi \
    && curl -fsSL --user "signalwire:${SIGNALWIRE_TOKEN}" \
         https://freeswitch.signalwire.com/repo/deb/debian-release/signalwire-freeswitch-repo.gpg \
         -o /usr/share/keyrings/signalwire-freeswitch-repo.gpg \
    && echo "machine freeswitch.signalwire.com login signalwire password ${SIGNALWIRE_TOKEN}" \
         > /etc/apt/auth.conf \
    && chmod 600 /etc/apt/auth.conf \
    && echo "deb [signed-by=/usr/share/keyrings/signalwire-freeswitch-repo.gpg] https://freeswitch.signalwire.com/repo/deb/debian-release/ bookworm main" \
         > /etc/apt/sources.list.d/freeswitch.list

RUN apt-get update && apt-get install -y --no-install-recommends \
        freeswitch-meta-vanilla \
        freeswitch-mod-shout \
        freeswitch-mod-callcenter \
        freeswitch-mod-curl \
        freeswitch-mod-cidlookup \
        freeswitch-music-default \
        freeswitch-sounds-en-us-callie \
    && rm -rf /var/lib/apt/lists/* /etc/apt/auth.conf

# ----- runtime ---------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
ARG FREESWITCH_VERSION

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl3 \
        libsqlite3-0 \
        libpcre3 \
        libcurl4 \
        libldns3 \
        libedit2 \
        libspeexdsp1 \
        libldns3 \
        libuuid1 \
        libtiff6 \
        libjpeg62-turbo \
        liblua5.2-0 \
        libldap-2.5-0 \
        sox \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/share/freeswitch /usr/share/freeswitch
COPY --from=builder /etc/freeswitch /etc/freeswitch
COPY --from=builder /usr/lib/freeswitch /usr/lib/freeswitch
COPY --from=builder /usr/bin/fs_cli /usr/bin/fs_cli
COPY --from=builder /usr/bin/freeswitch /usr/bin/freeswitch
COPY --from=builder /var/lib/freeswitch /var/lib/freeswitch

# Create freeswitch user/group with stable UIDs.
RUN groupadd --system --gid 499 freeswitch \
    && useradd --system --uid 499 --gid 499 --home /var/lib/freeswitch \
       --shell /usr/sbin/nologin freeswitch \
    && mkdir -p /var/log/freeswitch /var/lib/freeswitch/recordings \
    && chown -R freeswitch:freeswitch /etc/freeswitch /var/log/freeswitch /var/lib/freeswitch

# Document SPEC.md ports list (host network in dev; explicit publish in prod / mac).
EXPOSE 5060/udp 5060/tcp 5080/udp 5080/tcp 7443/tcp 8021/tcp
EXPOSE 16384-32768/udp

USER freeswitch

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
    CMD fs_cli -x "status" 2>/dev/null | grep -q ^UP || exit 1

ENTRYPOINT ["/usr/bin/freeswitch", "-nf", "-c", "-nonat"]
