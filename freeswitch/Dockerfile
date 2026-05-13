# syntax=docker/dockerfile:1.7
# vici2 FreeSWITCH 1.10.12 image — F03 PLAN §12.
# Two-stage build: builder pulls FS + selected modules from the SignalWire
# APT repo (token required); runtime is debian-bookworm-slim with only the
# shared libs FS needs at runtime + our conf tree.

ARG FREESWITCH_VERSION=1.10.12

# ----- builder ---------------------------------------------------------------
FROM debian:bookworm-slim AS builder
ARG SIGNALWIRE_TOKEN
ARG FREESWITCH_VERSION

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Configure SignalWire APT repo. SIGNALWIRE_TOKEN is required (free at
# https://signalwire.com). Token is wiped from the image after package install.
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

# Allowlist install — only the 14 modules F03 PLAN §8 authorizes, plus
# defaults (sounds, music). NOT installing meta-all; smaller surface area.
RUN apt-get update && apt-get install -y --no-install-recommends \
        freeswitch \
        freeswitch-mod-console \
        freeswitch-mod-logfile \
        freeswitch-mod-event-socket \
        freeswitch-mod-sofia \
        freeswitch-mod-loopback \
        freeswitch-mod-conference \
        freeswitch-mod-dialplan-xml \
        freeswitch-mod-dptools \
        freeswitch-mod-commands \
        freeswitch-mod-db \
        freeswitch-mod-hash \
        freeswitch-mod-say-en \
        freeswitch-mod-sndfile \
        freeswitch-mod-native-file \
        freeswitch-mod-local-stream \
        freeswitch-mod-tone-stream \
        freeswitch-mod-xml-curl \
        freeswitch-mod-g722 \
        freeswitch-mod-opus \
        freeswitch-music-default \
        freeswitch-sounds-en-us-callie \
    && rm -rf /var/lib/apt/lists/* /etc/apt/auth.conf

# ----- runtime ---------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
ARG FREESWITCH_VERSION

ENV DEBIAN_FRONTEND=noninteractive

# Shared libs FS requires at runtime. gettext-base provides envsubst (entrypoint).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl3 \
        libsqlite3-0 \
        libpcre3 \
        libcurl4 \
        libldns3 \
        libedit2 \
        libspeexdsp1 \
        libuuid1 \
        libtiff6 \
        libjpeg62-turbo \
        liblua5.2-0 \
        libldap-2.5-0 \
        libopus0 \
        gettext-base \
        sox \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/share/freeswitch /usr/share/freeswitch
COPY --from=builder /etc/freeswitch /etc/freeswitch
COPY --from=builder /usr/lib/freeswitch /usr/lib/freeswitch
COPY --from=builder /usr/bin/fs_cli /usr/bin/fs_cli
COPY --from=builder /usr/bin/freeswitch /usr/bin/freeswitch
COPY --from=builder /var/lib/freeswitch /var/lib/freeswitch

# Replace stock config with vici2 F03 config (compose dev bind-mount may
# overlay this for live edit).
RUN rm -rf /etc/freeswitch/*
COPY conf/ /etc/freeswitch/

# Entrypoint + healthcheck
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

# Create freeswitch user/group with stable UIDs.
RUN groupadd --system --gid 499 freeswitch \
    && useradd --system --uid 499 --gid 499 --home /var/lib/freeswitch \
       --shell /usr/sbin/nologin freeswitch \
    && mkdir -p /var/log/freeswitch /var/lib/freeswitch/recordings /etc/freeswitch/tls \
    && chown -R freeswitch:freeswitch \
         /etc/freeswitch /var/log/freeswitch /var/lib/freeswitch

VOLUME ["/var/lib/freeswitch/recordings", "/var/log/freeswitch"]

# Documented ports — operator must publish these (compose `ports:` or host network)
EXPOSE 5060/udp 5060/tcp \
       5066/tcp \
       5080/udp 5080/tcp \
       7443/tcp \
       8021/tcp \
       16384-32768/udp

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
    CMD /usr/local/bin/healthcheck.sh || exit 1

USER freeswitch

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/bin/freeswitch", "-nf", "-nonat", "-c"]
