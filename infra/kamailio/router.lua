-- router.lua — Kamailio KEMI routing for vici2 X02
-- All routing logic lives here; kamailio.cfg only loads modules.
--
-- Dispatcher sets:
--   Set 1: inbound DID → FS  (hash by Call-ID, algo 0)
--   Set 2: outbound dialer → FS  (fewest-active, algo 4)
--   Set 20: X03 campaign-affinity  (hash by PV, algo 8) — reserved
--
-- rtpengine (X01): offer/answer/del called in relevant routes;
--   guarded by pcall so an rtpengine outage does not block calls.
--
-- Entry points called by Kamailio KEMI engine:
--   ksr_request_route()         — all initial + in-dialog requests
--   ksr_reply_route()           — 200 OK for INVITE → rtpengine answer
--   ksr_failure_route_fs_failure() — backend failover logic
--   ksr_event_route_xhttp_request() — Prometheus /metrics + /jsonrpc
--   ksr_event_route_rtimer_ds_sync() — periodic DS reload from MySQL

local DS_SET_INBOUND  = 1
local DS_SET_OUTBOUND = 2
-- DS_SET_AFFINITY = 20  -- reserved for X03

-- Permissions ACL groups (match kamailio address table grp values)
local CARRIER_ACL_GROUP  = 1  -- external carrier SIP IPs
local INTERNAL_ACL_GROUP = 2  -- Docker/internal subnet (10.0.0.0/8)

-- ──────────────────────────────────────────────────────────────────────────────
-- Helpers
-- ──────────────────────────────────────────────────────────────────────────────

local function rtpe_offer()
    local ok, err = pcall(function() KSR.rtpengine.offer() end)
    if not ok then
        KSR.xlog.xlog("L_WARN", "rtpengine.offer() failed (X01 unavailable?): " .. tostring(err) .. "\n")
    end
end

local function rtpe_answer()
    local ok, err = pcall(function() KSR.rtpengine.answer() end)
    if not ok then
        KSR.xlog.xlog("L_WARN", "rtpengine.answer() failed (X01 unavailable?): " .. tostring(err) .. "\n")
    end
end

local function rtpe_del()
    local ok, err = pcall(function() KSR.rtpengine.del() end)
    if not ok then
        KSR.xlog.xlog("L_WARN", "rtpengine.del() failed (X01 unavailable?): " .. tostring(err) .. "\n")
    end
end

-- ──────────────────────────────────────────────────────────────────────────────
-- Main request route
-- ──────────────────────────────────────────────────────────────────────────────
function ksr_request_route()
    -- 1. Sanity checks: reject malformed SIP (protects against fuzzing)
    --    1511 = check all; 7 = allow OPTIONS without To-tag
    if KSR.sanity.sanity_check(1511, 7) < 0 then
        KSR.x.exit()
    end

    -- 2. Max-Forwards guard
    if KSR.maxfwd.process_maxfwd(10) < 0 then
        KSR.sl.sl_send_reply(483, "Too Many Hops")
        KSR.x.exit()
    end

    -- 3. Pike rate limiting (anti-flood / DDoS)
    if KSR.pike.pike_check_req() < 0 then
        KSR.xlog.xlog("L_WARN", "PIKE blocked: $si:$sp method=$rm\n")
        KSR.sl.sl_send_reply(429, "Too Many Requests")
        KSR.x.exit()
    end

    -- 4. Self-OPTIONS health check (from keepalived, Docker, or SIPp tests)
    --    rU == nil means no user part (e.g. OPTIONS sip:kamailio)
    if KSR.pv.get("$rm") == "OPTIONS" and KSR.pv.get("$rU") == nil then
        KSR.sl.sl_send_reply(200, "OK")
        KSR.x.exit()
    end

    -- 5. Route in-dialog requests via loose routing (re-INVITE, BYE, CANCEL, ACK)
    if KSR.rr.loose_route() > 0 then
        route_in_dialog()
        KSR.x.exit()
    end

    -- 6. Dispatch initial requests by method
    local method = KSR.pv.get("$rm")

    if method == "INVITE" then
        route_initial_invite()
    elseif method == "REGISTER" then
        -- Kamailio does NOT own agent registrations — FS handles them via WSS profile.
        -- Internal FS registrations and management REGISTERs are similarly unsupported here.
        KSR.sl.sl_send_reply(403, "Registration not handled at this node")
    elseif method == "SUBSCRIBE" or method == "NOTIFY" then
        -- Presence is not handled by Kamailio in vici2; silently accept to avoid errors.
        KSR.sl.sl_send_reply(200, "OK")
    elseif method == "MESSAGE" then
        KSR.sl.sl_send_reply(202, "Accepted")
    else
        KSR.sl.sl_send_reply(405, "Method Not Allowed")
    end
end

-- ──────────────────────────────────────────────────────────────────────────────
-- In-dialog request handling (re-INVITE, BYE, CANCEL, UPDATE, ACK)
-- These arrive with Route headers pointing back to Kamailio (from Record-Route).
-- ──────────────────────────────────────────────────────────────────────────────
function route_in_dialog()
    local method = KSR.pv.get("$rm")

    -- ACK for non-2xx: pass through immediately (no body, no rtpengine)
    if method == "ACK" then
        KSR.tm.t_relay()
        return
    end

    -- BYE / CANCEL: tear down rtpengine media path
    if method == "BYE" or method == "CANCEL" then
        rtpe_del()
    elseif method == "INVITE" then
        -- re-INVITE (hold/resume): update rtpengine with new SDP
        rtpe_offer()
    end

    KSR.tm.t_relay()
end

-- ──────────────────────────────────────────────────────────────────────────────
-- Initial INVITE routing
-- ──────────────────────────────────────────────────────────────────────────────
function route_initial_invite()
    local set_id
    local algorithm

    -- X03 affinity: if X-FS-Affinity header is present, honor it.
    -- X03 sets this header when a campaign is pinned to a specific FS.
    local affinity = KSR.pv.get("$hdr(X-FS-Affinity)")
    if affinity ~= nil and affinity ~= "" then
        -- Remove the header so it is not forwarded to FS
        KSR.hdr.remove("X-FS-Affinity")
        KSR.xlog.xlog("L_INFO", "X03 affinity INVITE ci=$ci affinity=" .. affinity .. "\n")
        route_affinity_invite(affinity)
        return
    end

    -- Determine traffic class from source IP
    if KSR.permissions.check_address(INTERNAL_ACL_GROUP, "$si", "$sp", "$pr") > 0 then
        -- Source is internal (Docker subnet / dialer engine / FS outbound proxy)
        set_id   = DS_SET_OUTBOUND
        algorithm = 4  -- fewest-active for dialer outbound
    elseif KSR.permissions.check_address(CARRIER_ACL_GROUP, "$si", "$sp", "$pr") > 0 then
        -- Source is a known carrier
        set_id   = DS_SET_INBOUND
        algorithm = 0  -- hash by Call-ID for sticky inbound sessions
    else
        KSR.xlog.xlog("L_WARN",
            "INVITE from unknown source $si:$sp — rejecting (not in carrier or internal ACL)\n")
        KSR.sl.sl_send_reply(403, "Forbidden")
        KSR.x.exit()
    end

    -- Record-Route: ensure all in-dialog requests return through Kamailio.
    -- Required for Call-ID hash affinity on re-INVITE/BYE.
    KSR.rr.record_route()

    -- NAT detection and fixup for WebSocket/browser agents behind NAT.
    -- nat_uac_test(19) = RFC1918 in Contact(1) + RFC1918 in Via(2) + private SDP(16)
    if KSR.nathelper.nat_uac_test(19) > 0 then
        KSR.nathelper.fix_nated_contact()
        KSR.nathelper.fix_nated_sdp(1)
        KSR.setbflag(7)  -- mark for keep-alive pings
    end

    -- rtpengine SDP offer rewrite (X01): pin media through rtpengine
    rtpe_offer()

    -- Dispatcher selection
    if KSR.dispatcher.ds_select_dst(set_id, algorithm) < 0 then
        KSR.xlog.xlog("L_ERR",
            "dispatcher: no active backends in set " .. set_id ..
            " algo=" .. algorithm .. " ci=$ci\n")
        KSR.sl.sl_send_reply(503, "Service Unavailable")
        KSR.hdr.append_after("Retry-After: 30\r\n", nil)
        KSR.x.exit()
    end

    local dst_host = KSR.pv.get("$rd") or "?"
    local dst_port = KSR.pv.get("$rp") or "5060"
    KSR.xlog.xlog("L_INFO",
        "DISPATCH set=" .. set_id .. " algo=" .. algorithm ..
        " dst=" .. dst_host .. ":" .. dst_port ..
        " ci=$ci from=$fu\n")

    -- Register failure route: try next backend on timeout / 5xx
    KSR.tm.t_on_failure("fs_failure")

    KSR.tm.t_relay()
end

-- ──────────────────────────────────────────────────────────────────────────────
-- X03 campaign-affinity routing (direct FS selection)
-- Called when X-FS-Affinity header is present.
-- affinity_uri: full SIP URI of the target FS (e.g. "sip:10.0.1.11:5060")
-- ──────────────────────────────────────────────────────────────────────────────
function route_affinity_invite(affinity_uri)
    KSR.rr.record_route()

    if KSR.nathelper.nat_uac_test(19) > 0 then
        KSR.nathelper.fix_nated_contact()
        KSR.nathelper.fix_nated_sdp(1)
        KSR.setbflag(7)
    end

    rtpe_offer()

    -- Set request URI directly to the affinity target
    KSR.pv.sets("$ru", affinity_uri)

    KSR.xlog.xlog("L_INFO", "X03 affinity direct route ci=$ci dst=" .. affinity_uri .. "\n")

    KSR.tm.t_on_failure("fs_failure")
    KSR.tm.t_relay()
end

-- ──────────────────────────────────────────────────────────────────────────────
-- Failure route: try next backend on timeout / 5xx error
-- Called by tm when a forwarded INVITE gets a failure response or times out.
-- Max retries: 2 (3 total FS attempts) before sending 503 to client.
-- ──────────────────────────────────────────────────────────────────────────────
function ksr_failure_route_fs_failure()
    -- If client cancelled, nothing to do
    if KSR.tm.t_is_canceled() > 0 then
        return
    end

    local last_code = KSR.pv.get("$T_reply_code") or 0

    -- Fail over on: 503 (overloaded), 408 (timeout), 500 (FS crash),
    -- or 0 (no response / connection refused)
    if last_code == 503 or last_code == 408 or last_code == 500 or last_code == 0 then
        -- Mark current destination as inactive + probing so future calls skip it
        KSR.dispatcher.ds_mark_dst("ip")

        KSR.xlog.xlog("L_WARN",
            "FS backend failed code=" .. last_code ..
            " dst=$rd marking inactive, trying next ci=$ci\n")

        -- Try next available destination in the set
        if KSR.dispatcher.ds_next_dst() < 0 then
            KSR.xlog.xlog("L_ERR",
                "No more backends available in set — sending 503 ci=$ci\n")
            KSR.tm.t_reply(503, "All backends failed")
            return
        end

        -- Re-register failure route for the next attempt (max retries enforced by tm)
        KSR.tm.t_on_failure("fs_failure")
        KSR.tm.t_relay()
    end
    -- For other codes (e.g. 486 Busy, 603 Decline), let the reply propagate to caller
end

-- ──────────────────────────────────────────────────────────────────────────────
-- Reply route: rtpengine answer rewrite on 200 OK for INVITE
-- ──────────────────────────────────────────────────────────────────────────────
function ksr_reply_route()
    local code   = KSR.pv.get("$rs") or 0
    local method = KSR.pv.get("$rm") or ""

    if method == "INVITE" and code >= 200 and code < 300 then
        -- 200 OK: complete the rtpengine media path (answer SDP rewrite)
        rtpe_answer()
    end
end

-- ──────────────────────────────────────────────────────────────────────────────
-- xHTTP event route — handles HTTP requests on :9090/:8080
-- Prometheus metrics endpoint and JSONRPC management API
-- ──────────────────────────────────────────────────────────────────────────────
function ksr_event_route_xhttp_request()
    local path = KSR.pv.get("$hu") or ""

    -- Strip query string for matching
    local base_path = path:match("([^?]+)") or path

    if base_path == "/metrics" then
        -- Prometheus scrape endpoint (xhttp_prom module)
        KSR.xhttp_prom.dispatch()
        return
    end

    if base_path == "/jsonrpc" then
        -- Kamailio management API (kamcmd over HTTP)
        KSR.jsonrpcs.dispatch()
        return
    end

    if base_path == "/health" or base_path == "/" then
        -- Simple liveness check for Docker healthcheck / load balancer probes
        KSR.xhttp.xhttp_reply("200", "OK", "text/plain", "OK\n")
        return
    end

    KSR.xhttp.xhttp_reply("404", "Not Found", "text/plain", "Not found\n")
end

-- ──────────────────────────────────────────────────────────────────────────────
-- RTtimer event: periodic dispatcher reload from MySQL
-- Fires every 60 seconds (configured in kamailio.cfg rtimer modparam).
-- Ensures both Kamailio replicas converge on the same FS pool state
-- within 60s of any change made via dispatcher-list-renderer.py.
-- ──────────────────────────────────────────────────────────────────────────────
function ksr_event_route_rtimer_ds_sync()
    local ok, err = pcall(function()
        KSR.dispatcher.ds_reload()
    end)
    if not ok then
        KSR.xlog.xlog("L_ERR", "ds_reload failed (DB unavailable?): " .. tostring(err) .. "\n")
    else
        KSR.xlog.xlog("L_DEBUG", "ds_reload completed (rtimer)\n")
    end
end
