# infra/kamailio/Dockerfile
# X02 — Kamailio 6.0 SIP dispatcher for vici2.
# Base image: kamailio/kamailio:6.0-bullseye (official Kamailio Docker image).
# Adds Lua 5.4 KEMI scripting, MySQL backend, TLS, rtpengine module, Prometheus.
#
# Modules installed beyond the base image:
#   kamailio-mysql-modules  — dispatcher DB backend + permissions ACL
#   kamailio-tls-modules    — SIP-TLS :5061 and WSS :7443
#   kamailio-lua-modules    — KEMI Lua routing (app_lua)
#   kamailio-extra-modules  — pike, htable, topoh, nathelper, rtpengine, xhttp_prom
#   python3 + python3-pymysql — dispatcher-list-renderer.py, check_fs_load.py

FROM kamailio/kamailio:6.0-bullseye

RUN apt-get update && apt-get install -y --no-install-recommends \
        kamailio-extra-modules \
        kamailio-mysql-modules \
        kamailio-tls-modules \
        kamailio-lua-modules \
        kamailio-utils-modules \
        lua5.4 \
        liblua5.4-dev \
        python3 \
        python3-pymysql \
        python3-requests \
        sipsak \
    && rm -rf /var/lib/apt/lists/*

# Main Kamailio config
COPY kamailio.cfg  /etc/kamailio/kamailio.cfg
COPY tls.cfg       /etc/kamailio/tls.cfg
COPY router.lua    /etc/kamailio/router.lua
COPY dispatcher.list /etc/kamailio/dispatcher.list
COPY acl-carriers.conf /etc/kamailio/acl-carriers.conf

# Management scripts
COPY scripts/ /usr/local/bin/kamailio-scripts/
RUN chmod +x /usr/local/bin/kamailio-scripts/*.sh

# TLS certificate directory (populated at runtime via secret/volume)
RUN mkdir -p /etc/kamailio/tls

# Ports: SIP UDP+TCP 5060, SIP-TLS 5061, WSS 7443, Prometheus 9090, JSONRPC 8080
EXPOSE 5060/udp 5060/tcp 5061/tcp 7443/tcp 9090/tcp 8080/tcp

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD /usr/local/bin/kamailio-scripts/healthcheck.sh

ENTRYPOINT ["/usr/local/bin/kamailio-scripts/entrypoint.sh"]
CMD ["kamailio", "-DD", "-E", "-e"]
