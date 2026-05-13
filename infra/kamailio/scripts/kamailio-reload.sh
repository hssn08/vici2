#!/bin/bash
# infra/kamailio/scripts/kamailio-reload.sh
# X02: Hot-reload Kamailio dispatcher and Lua routing script.
# Called by keepalived notify_master hook and by ops after config changes.
# Safe to run while Kamailio is serving calls — no restart required.
set -euo pipefail

echo "[kamailio-reload] Reloading dispatcher from DB..."
kamcmd dispatcher.reload

echo "[kamailio-reload] Reloading Lua routing script..."
kamcmd app_lua.reload /etc/kamailio/router.lua

echo "[kamailio-reload] Reloading permissions (carrier ACL)..."
kamcmd permissions.reload

echo "[kamailio-reload] Done."
