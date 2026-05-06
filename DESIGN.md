# Vici2 — A Modern Vicidial Alternative on FreeSWITCH

## 0. Summary

Build an open contact-center suite that is feature-comparable to Vicidial but rebuilt on FreeSWITCH instead of Asterisk, with a modern web stack instead of PHP+AJAX, MySQL for lead/campaign data, BYOC SIP trunking (Twilio Elastic SIP, RingCentral, generic), and WebRTC agent softphone in the browser.

MVP target: **manual dial, lead management, transfer (blind/warm/3-way), recording, dispositions, callbacks**. Phase 2: **progressive + predictive auto-dial**. Phase 3: **inbound/blended, IVR, multi-server scale**.

---

## 1. What Vicidial Actually Does (research distilled)

### 1.1 Components
- **Asterisk** PBX with MeetMe (or ConfBridge) — every agent occupies a private conference room while logged in; calls join their room.
- **PHP agent screen** (`www/agc/vicidial.php`) — server-rendered HTML + AJAX polling, refresh every ~1s. ([source](https://github.com/inktel/Vicidial/blob/master/www/agc/vicidial.php))
- **PHP admin screens** for campaigns, lists, in-groups, DNC, scripts, dispositions, users, servers.
- **Perl daemons** under `bin/`:
  - `AST_VDhopper.pl` — every ~60s populates `vicidial_hopper` from `vicidial_list` after applying filters (status, time zone, DNC, dial-count limits, recycle delays).
  - `AST_VDauto_dial.pl` — every 2.5–3s pulls leads from hopper and originates calls via Asterisk Manager Interface (AMI).
  - `AST_VDadapt.pl` — every minute, recalculates per-campaign dial level based on drop rate metrics.
  - `AST_update.pl`, `AST_send_action_child.pl`, `ADMIN_keepalive_ALL.pl`, `AST_conf_update_screen.pl` — supervise channels, archive logs, clean stale conferences.
- **AGI scripts** under `agi/` — `agi-VDAD_ALL_outbound.agi`, `agi-VDAD_ALL_inbound.agi`, `agi-VDAD_RINGALL.agi` route answered calls into the right agent's MeetMe room.
- **MySQL** (MyISAM) — 50+ tables, 4 of them are `MEMORY` engine for hot live state.

### 1.2 Dialing modes ([PREDICTIVE.txt](https://github.com/inktel/Vicidial/blob/master/docs/PREDICTIVE.txt), [vicistack settings](https://vicistack.com/blog/vicidial-predictive-dialer-settings/))
| Mode | Behavior |
|---|---|
| `MANUAL` | `auto_dial_level = 0`. Agent clicks "Dial Next". |
| `RATIO` | Fixed multiplier. e.g. `2.0` ⇒ dial 2 lines per ready agent. No adaptation. |
| `ADAPT_HARD_LIMIT` | Predictive; never exceed drop% target — clamps hard. |
| `ADAPT_AVERAGE` | Holds drop% as a running average, may briefly exceed. |
| `ADAPT_TAPERED` | Lenient early-shift, tightens as the day progresses. The default recommendation. |

Key knobs: `adaptive_dropped_percentage` (default 3.0; recommend 1.5), `adaptive_maximum_level` (default 3.0), `auto_dial_level` (current/starting level), `available_only_ratio_tally` (count only READY agents vs all unpaused), `dial_timeout` (default 26s; recommend 18–22), `wrapup_seconds`, `next_agent_call` strategy (`longest_wait_time` recommended), `calls_per_second`.

### 1.3 The agent–MeetMe model (the architectural heart of Vicidial)
From [ConfBridge Documentation](https://www.vicidial.org/docs/ConfBridge%20Documentation.txt):

> When an agent logs into Vicidial their phone gets called by Vicidial. When that call connects the agent gets placed into a MeetMe conference. For the most part they stay within that conference the entire time they are logged into Vicidial. … When an auto dial phone call answers it goes through the outbound routing agi and ultimately gets routed into an agent's MeetMe phone conference.

This single primitive — *agent always in their own conference, calls get pushed in* — is what makes hold/transfer/3-way/leave-3way/recording all uniform operations.

### 1.4 Transfer / conference operations ([AGENT_API.txt](https://vicidial.org/docs/AGENT_API.txt))
Every transfer flows through the agent's MeetMe room. The `transfer_conference` API enumerates the universe:
- `HANGUP_XFER` — drop the third party only.
- `HANGUP_BOTH` — drop customer + third party.
- `BLIND_TRANSFER` — push customer to a defined number, agent leaves.
- `LEAVE_VM` — blind-transfer customer to campaign voicemail-drop extension.
- `LOCAL_CLOSER` — send customer to another agent via an in-group queue (warm/blind toggle via `consultative=YES`).
- `DIAL_WITH_CUSTOMER` — 3-way call: ring third party while customer stays in conf.
- `PARK_CUSTOMER_DIAL` — park customer on MoH, dial third party privately, then optionally rejoin.
- `LEAVE_3WAY_CALL` — agent drops out, customer + third party stay connected; agent goes to dispo screen.

### 1.5 Lead lifecycle
1. Admin uploads CSV → rows in `vicidial_list` with `status='NEW'`, `list_id`, time-zone derived from area code via `vicidial_phone_codes`.
2. `AST_VDhopper.pl` filters by: campaign `dial_status` whitelist, local-call-time window (`9am-9pm`, called-party tz), DNC, `called_count`/`dial_count_limit`, `lead_filter_id` SQL fragment, recycle delays. Inserts into `vicidial_hopper` (MEMORY).
3. `AST_VDauto_dial.pl` reads from hopper, originates outbound legs, marks lead `called_since_last_reset='Y'`.
4. On answer, AGI looks up the lead from `vicidial_auto_calls`, joins the call to a free agent's conference, marks `vicidial_live_agents.status='INCALL'`, writes `vicidial_log`.
5. Agent dispositions → updates `vicidial_list.status`, writes `vicidial_agent_log`, increments `called_count`.
6. Recycling pushes the lead back to dialable after a per-status delay if its new status is in the campaign's `dial_status` list.

### 1.6 Compliance posture (TCPA/TSR — non-negotiable for US dialing)
- **3% drop limit** per campaign per rolling 30-day window. A "drop" = live answer with no agent within 2s. ([SIPNEX](https://www.sipnex.ca/blog/abandoned-call-rate-fcc-rules))
- **Safe-harbor message** required when dropping: "this call was for telemarketing purposes," seller name + phone + opt-out IVR.
- **8 AM–9 PM called-party local time** based on phone area code. Some states are stricter — apply most-restrictive.
- **DNC scrub ≤31 days** old before each call (federal + 11 state lists + internal DNC + reassigned-numbers DB).
- **Identification announcement** at call start.
- **Recording consent**: federal one-party; 12 states require two-party (CA, FL, IL, MD, MA, MT, NH, PA, WA + a few). ([FCC](https://www.fcc.gov/cgb/consumerfacts/recordcalls.html))
- **Opt-out within 10 business days**.

### 1.7 Why we are *not* literally cloning Vicidial
- Asterisk MeetMe is deprecated; ConfBridge migration is painful.
- 50-table MyISAM schema with `vicidial_manager` AMI queue at 5–10M rows/month is operationally painful.
- PHP+AJAX polling is wasteful; a WebSocket push model is cleaner.
- Per-server Asterisk-config sprawl is hard to scale horizontally.

---

## 2. Vici2 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (Agent / Admin / Supervisor)                       │
│  Next.js + React + Zustand + SIP.js (WSS)                   │
└──────────────┬─────────────────────────┬────────────────────┘
        HTTPS │REST + WS                │WSS (SIP signaling)
              ▼                          ▼
┌─────────────────────────┐  ┌──────────────────────────────┐
│   API Gateway           │  │  FreeSWITCH cluster           │
│   Node.js (Fastify)     │  │  - mod_sofia (WSS + UDP/TCP)  │
│   - Auth, RBAC          │  │  - mod_callcenter (queues)    │
│   - Lead CRUD           │  │  - mod_conference (xfer/3way) │
│   - Campaign config     │  │  - mod_avmd / commercial AMD  │
│   - WS push (agent UI)  │  │  - mod_event_socket           │
└────┬───────────────┬────┘  │  - mod_xml_curl (dyn config)  │
     │               │       └──────┬─────────────────┬──────┘
     ▼               ▼              │ ESL              │SIP/RTP
┌─────────┐   ┌─────────────┐       ▼                  ▼
│  MySQL  │   │  Redis      │  ┌────────────────┐ ┌──────────┐
│ (8.x)   │   │ (live state │  │ Dialer Engine  │ │ Carriers │
│ leads,  │   │  pub/sub)   │  │ (Go or Node)   │ │ Twilio   │
│ logs,   │   │             │  │ - Hopper       │ │ RingCntr │
│ campaign│   └─────────────┘  │ - Pacing       │ │ BYOC SIP │
└─────────┘                    │ - Originate    │ └──────────┘
                               └────────┬───────┘
                                        │MySQL
                                        ▼
                                 (CDR + recording_log)
```

### 2.1 Service responsibilities

| Service | Responsibility |
|---|---|
| **API Gateway** (Node 20 + Fastify + Prisma) | REST endpoints for admin/CRUD; WebSocket channels per agent for state push; auth (JWT + refresh). |
| **Dialer Engine** (Go preferred for concurrency, Node OK) | Owns the hopper fill loop, the pacing loop, ESL `bgapi originate`, channel-event subscription, drop-rate accounting, AMD handling. Stateless — multiple instances coordinate via Redis locks. |
| **FreeSWITCH** | Real telephony: SIP registration of carriers, WSS for agent browser, conference-per-agent, recording, eavesdrop/whisper/barge. Configured by static XML for profiles + `mod_xml_curl` against the API for dialplans/users so you don't restart for every change. |
| **MySQL 8** | Persistent: leads, lists, campaigns, users, logs, recordings metadata, DNC. InnoDB for everything except hot ephemeral state. |
| **Redis** | Live state we'd otherwise put in MEMORY tables: `agent:{id}:state`, `campaign:{id}:dial_level`, `hopper:{campaign}` sorted set, drop-rate sliding window, distributed locks for hopper consumption. Pub/sub for fan-out to API WebSockets. |
| **Worker** (same Go process or separate) | DNC scrub jobs, lead import, recycle scheduler, recording archival, daily reports. |
| **Object store** (S3/MinIO) | Recordings WAV → MP3 + transcripts. |

### 2.2 Why Redis instead of MEMORY tables
Vicidial uses MEMORY engine because it's "fast enough" inside MySQL. Redis is purpose-built for this exact pattern: per-agent state hashes, sorted sets for hopper priority, atomic `LMOVE` for hopper consumption, pub/sub for UI fan-out, sliding-window counters for drop-rate accounting. One operational concern eliminated.

### 2.3 Why FreeSWITCH conference-per-agent (Vicidial's pattern, kept)
We keep the "agent always in a conference, calls get pushed in" model because every transfer/3-way operation collapses to *channel join/leave conference*. `mod_conference` supports up to ~200k concurrent conferences and `conference_set_auto_outcall` for warm/3-way. The alternative (`mod_callcenter` + bridge) makes 3-way and "leave-3way" awkward.

`mod_callcenter` is still useful — for inbound *queues* feeding into the agent-conference model.

---

## 3. Tech Stack Decisions

| Layer | Pick | Why |
|---|---|---|
| FreeSWITCH | 1.10.x (LTS) | Active, ConfBridge-replacement is built-in, mod_verto + WSS native. |
| Browser SIP | **SIP.js over WSS** | Standards-based; FreeSWITCH 1.10 supports it natively. mod_verto is FS-proprietary; SIP.js portable. |
| Backend lang | **Go** for dialer engine, **Node 20** for API/UI | Go: predictable goroutine pacing, low GC pauses. Node: ergonomic for REST + WS + Prisma. |
| ORM | Prisma (Node) + sqlx (Go) | Avoid mixing ORMs; Go service does narrow, hot-path queries. |
| DB | MySQL 8.0 InnoDB | Asked for. Use partitioning on `call_log` / `agent_log` by month. |
| Cache/state | Redis 7 | Streams + sorted sets + pub/sub. |
| Web UI | Next.js 14 + React + Tailwind + Zustand | Fast iteration; SSR for admin, CSR for agent. |
| Containers | Docker Compose for dev, k8s optional for prod | FS in host-network mode (RTP). |
| Recording storage | Local NFS or S3-compatible | Stream WAV → encoded MP3 → upload. |

---

## 4. FreeSWITCH Layout

### 4.1 Modules to load
```
mod_sofia, mod_event_socket, mod_xml_curl,
mod_conference, mod_callcenter, mod_fifo,
mod_avmd, mod_amd (or mod_com_amd if budget),
mod_dptools, mod_db, mod_cdr_csv, mod_cdr_pg_csv (optional),
mod_loopback, mod_local_stream, mod_native_file, mod_sndfile,
mod_spandsp (T.38/fax not needed but ships), mod_tone_stream
```

### 4.2 Sofia profiles
- **internal** (port 5060) — agent SIP endpoints (legacy hardphones) and WSS for browsers (SIP over secure WebSockets, port 7443).
- **external** (port 5080) — outbound/inbound to carriers. Each carrier as a `gateway` under `sip_profiles/external/`.

### 4.3 Carrier gateways (one file per carrier, all under external)

**Twilio Elastic SIP** (`sip_profiles/external/twilio.xml`) — per the [Twilio + FreeSWITCH guide](https://www.twilio.com/en-us/blog/getting-started-placing-outbound-calls-with-twilio-elastic-sip-trunking-and-freeswitch-html):
```xml
<include>
  <gateway name="twilio">
    <param name="username" value="${TWILIO_TERMINATION_USER}"/>
    <param name="password" value="${TWILIO_TERMINATION_PASS}"/>
    <param name="realm" value="Twilio-outbound"/>
    <param name="proxy" value="${TENANT}.pstn.twilio.com"/>
    <param name="register" value="false"/>
    <param name="caller-id-in-from" value="true"/>
    <param name="codec-prefs" value="PCMU,PCMA"/>
    <param name="dtmf-type" value="rfc2833"/>
  </gateway>
</include>
```
Plus IP-ACL allowlist of Twilio's edge IPs in `acl.conf.xml` for inbound. Numbers must be E.164 with `+`.

**RingCentral** — register=true, host `sip.ringcentral.com`, separate registration per DID.

**BYOC** — same shape; we expose an admin UI `Carriers → Add` that writes the XML and triggers `sofia profile external rescan`.

### 4.4 Dialplan contexts
- `from_carrier` — calls from gateways → IVR / DID lookup → in-group queue.
- `from_agent` — calls originated by browser/agent SIP → outbound through carrier.
- `internal_dialer` — dialer-engine-originated outbound legs land here on answer → bridge into agent conference.
- `agent_conference` — extension to put a logged-in agent in their personal conference room.

We keep dialplans short and let `mod_xml_curl` ask the API for routing decisions on-demand (DID lookup, agent state, in-group selection).

### 4.5 Agent conference primitive
Each logged-in agent gets `conference_${agent_id}@default`. On login, browser dials `*9${agent_id}` over WSS → dialplan answers → `conference $agent_id@default+flags{moderator,mute=false}`. They sit there until logout.

Dialer engine, on customer answer, runs:
```
uuid_transfer <customer-uuid> conference:${agent_id}@default inline
```
or equivalently `uuid_setvar` + transfer to a dialplan extension that runs the conference app.

### 4.6 Recording
On answer-and-bridge, set:
```xml
<action application="set" data="RECORD_STEREO=true"/>
<action application="set" data="RECORD_MIN_SEC=2"/>
<action application="set" data="recording_follow_transfer=true"/>
<action application="record_session"
  data="$${recordings_dir}/${strftime(%Y/%m/%d)}/${campaign_id}_${lead_id}_${uuid}.wav"/>
```
Naming convention mirrors Vicidial: `campaign_id_leadid_uuid_starttime.wav`. CDR webhook (`mod_xml_curl` or `mod_event_socket` listener) inserts a `recording_log` row on `RECORD_STOP`.

### 4.7 Eavesdrop / whisper / barge (supervisor)
Supervisor button → API → `bgapi originate user/${sup} 'queue_dtmf:w2@500,eavesdrop:${target_uuid}' inline`.
DTMF map (per FreeSWITCH eavesdrop docs):
- `1` listen-customer only
- `2` whisper-agent (coaching)
- `3` barge (3-way)
- `0` toggle silent

---

## 5. MySQL Schema (simplified, InnoDB, ~25 tables vs Vicidial's 52)

### 5.1 Core tables

```sql
-- Tenants/users
CREATE TABLE users (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  username      VARCHAR(64) UNIQUE NOT NULL,
  email         VARCHAR(128) UNIQUE,
  password_hash VARCHAR(128) NOT NULL,
  full_name     VARCHAR(128),
  role          ENUM('agent','supervisor','admin','superadmin') NOT NULL,
  user_group_id BIGINT,
  active        BOOLEAN DEFAULT TRUE,
  hotkeys_active BOOLEAN DEFAULT TRUE,
  sip_password  VARCHAR(64),       -- for WSS registration
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (user_group_id)
);

CREATE TABLE user_groups (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(64) UNIQUE NOT NULL,
  allowed_campaigns JSON,           -- ["camp_a","camp_b"]
  allowed_ingroups  JSON
);

-- Carriers (BYOC)
CREATE TABLE carriers (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(64) UNIQUE NOT NULL,
  kind          ENUM('twilio','ringcentral','byoc') NOT NULL,
  proxy         VARCHAR(255),       -- sip.commpeak.com or twilio host
  username      VARCHAR(128),
  password      VARCHAR(128),       -- encrypted at rest
  register      BOOLEAN DEFAULT FALSE,
  caller_id_e164 VARCHAR(16),       -- default outbound CID
  active        BOOLEAN DEFAULT TRUE,
  -- inbound auth
  ip_allowlist  JSON,               -- ["54.172.60.0/30",...]
  config_json   JSON                -- arbitrary extra Sofia params
);

-- DIDs (inbound numbers → routing)
CREATE TABLE did_numbers (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  e164         VARCHAR(16) UNIQUE NOT NULL,
  carrier_id   BIGINT NOT NULL,
  route_kind   ENUM('ingroup','ivr','agent','ext','voicemail') NOT NULL,
  route_target VARCHAR(64) NOT NULL,
  caller_id_name VARCHAR(64),
  active       BOOLEAN DEFAULT TRUE,
  FOREIGN KEY (carrier_id) REFERENCES carriers(id)
);
```

```sql
-- Campaigns
CREATE TABLE campaigns (
  id                 VARCHAR(32) PRIMARY KEY,           -- e.g. 'SOLAR_Q2'
  name               VARCHAR(128) NOT NULL,
  active             BOOLEAN DEFAULT TRUE,
  dial_method        ENUM('MANUAL','RATIO','PROGRESSIVE',
                          'ADAPT_HARD','ADAPT_AVG','ADAPT_TAPERED') DEFAULT 'MANUAL',
  auto_dial_level    DECIMAL(4,2) DEFAULT 0.00,
  adaptive_max_level DECIMAL(4,2) DEFAULT 3.00,
  adaptive_drop_pct  DECIMAL(4,2) DEFAULT 1.50,         -- our default 1.5 (safer than 3)
  dial_timeout_sec   SMALLINT DEFAULT 22,
  wrapup_seconds     SMALLINT DEFAULT 10,
  next_agent_call    ENUM('longest_wait','random','fewest_calls','rank') DEFAULT 'longest_wait',
  available_only_tally BOOLEAN DEFAULT FALSE,
  hopper_size_target INT DEFAULT 0,                     -- 0 = auto
  hopper_multiplier  DECIMAL(3,1) DEFAULT 2.0,
  caller_id_carrier_id BIGINT,                          -- which carrier's CID to use
  caller_id_override VARCHAR(16),
  recording_mode     ENUM('NEVER','ONDEMAND','ALL','ALLFORCE') DEFAULT 'ALL',
  amd_enabled        BOOLEAN DEFAULT FALSE,
  amd_action         ENUM('drop','vmdrop','agent') DEFAULT 'drop',
  vmdrop_audio       VARCHAR(255),
  safe_harbor_audio  VARCHAR(255),                      -- TCPA drop announcement
  script_id          BIGINT,
  webform_url        VARCHAR(512),
  dial_status_filter JSON,                              -- ["NEW","NA","B","CALLBK"]
  call_time_id       BIGINT,                            -- FK to call_times
  use_internal_dnc   BOOLEAN DEFAULT TRUE,
  use_federal_dnc    BOOLEAN DEFAULT TRUE,
  use_state_dnc      BOOLEAN DEFAULT TRUE,
  pause_codes_required ENUM('OFF','OPTIONAL','FORCE') DEFAULT 'OPTIONAL',
  hot_keys_active    BOOLEAN DEFAULT TRUE,
  closer_ingroups    JSON,                              -- in-group IDs that closers from this campaign serve
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE call_times (
  id        BIGINT PRIMARY KEY AUTO_INCREMENT,
  name      VARCHAR(64),
  default_start TIME DEFAULT '09:00',
  default_end   TIME DEFAULT '21:00',
  state_overrides JSON                       -- {"WA":["08:00","20:00"], ...}
);

CREATE TABLE campaign_lists (
  campaign_id VARCHAR(32),
  list_id     BIGINT,
  PRIMARY KEY (campaign_id, list_id)
);

CREATE TABLE lists (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(128) NOT NULL,
  active        BOOLEAN DEFAULT TRUE,
  reset_time    TIME,                  -- daily list reset
  expiration    DATE,
  source        VARCHAR(64),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Status definitions (per-campaign; system defaults seeded)
CREATE TABLE statuses (
  campaign_id VARCHAR(32),
  status      VARCHAR(8),                          -- 'NEW','SALE','NA','B','DNC',...
  description VARCHAR(128),
  selectable  BOOLEAN DEFAULT TRUE,
  human_answered BOOLEAN DEFAULT FALSE,
  sale        BOOLEAN DEFAULT FALSE,
  dnc         BOOLEAN DEFAULT FALSE,
  callback    BOOLEAN DEFAULT FALSE,
  hotkey      CHAR(1),
  PRIMARY KEY (campaign_id, status)
);
```

```sql
-- THE LEAD TABLE — the heart of the system
CREATE TABLE leads (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  list_id         BIGINT NOT NULL,
  status          VARCHAR(8) DEFAULT 'NEW',
  vendor_lead_code VARCHAR(64),
  source_id       VARCHAR(64),
  phone_e164      VARCHAR(16) NOT NULL,
  phone_alt       VARCHAR(16),
  phone_alt2      VARCHAR(16),
  country_code    CHAR(2) DEFAULT 'US',
  title           VARCHAR(8),
  first_name      VARCHAR(64),
  middle_initial  VARCHAR(4),
  last_name       VARCHAR(64),
  address1        VARCHAR(128),
  address2        VARCHAR(128),
  city            VARCHAR(64),
  state           CHAR(2),
  postal_code     VARCHAR(16),
  email           VARCHAR(128),
  date_of_birth   DATE,
  gender          ENUM('M','F','U') DEFAULT 'U',
  comments        TEXT,
  rank            INT DEFAULT 0,                  -- priority bias
  owner_user_id   BIGINT,                         -- if owner-dialing only
  custom_data     JSON,                           -- arbitrary fields per list
  -- lifecycle
  called_count    INT DEFAULT 0,
  last_called_at  DATETIME,
  last_local_call_time TIME,
  modify_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  entry_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- timezone (computed at insert from area code or postal)
  tz_offset_min   SMALLINT,                       -- minutes from UTC, signed
  INDEX idx_list_status (list_id, status),
  INDEX idx_phone (phone_e164),
  INDEX idx_status_modify (status, modify_at),
  INDEX idx_list_status_modify (list_id, status, modify_at)
);

-- DNC (federal + state + internal merged; flagged by source)
CREATE TABLE dnc (
  phone_e164  VARCHAR(16) NOT NULL,
  source      ENUM('federal','state','internal','litigator','reassigned') NOT NULL,
  state       CHAR(2),                            -- for state DNC
  campaign_id VARCHAR(32),                        -- internal-per-campaign DNC; NULL = global
  added_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (phone_e164, source, state, campaign_id)
);

-- Phone code → timezone (seeded from NANP area-code data)
CREATE TABLE phone_codes (
  area_code  CHAR(3) PRIMARY KEY,
  state      CHAR(2),
  tz_name    VARCHAR(32),                         -- America/New_York
  tz_offset_min SMALLINT
);

-- Callbacks
CREATE TABLE callbacks (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  lead_id       BIGINT NOT NULL,
  campaign_id   VARCHAR(32) NOT NULL,
  user_id       BIGINT,                           -- NULL = anyone
  callback_at   DATETIME NOT NULL,
  comments      TEXT,
  status        ENUM('LIVE','PENDING','DONE','DEAD') DEFAULT 'PENDING',
  created_by    BIGINT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (callback_at, status),
  INDEX (lead_id)
);
```

```sql
-- Logs (the volume tables — partition monthly)
CREATE TABLE call_log (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  uuid          VARCHAR(40) UNIQUE,                -- FreeSWITCH UUID
  parent_uuid   VARCHAR(40),
  lead_id       BIGINT,
  campaign_id   VARCHAR(32),
  list_id       BIGINT,
  user_id       BIGINT,                           -- who handled
  direction     ENUM('out','in') NOT NULL,
  phone_e164    VARCHAR(16) NOT NULL,
  caller_id     VARCHAR(16),
  carrier_id    BIGINT,
  call_started  DATETIME,
  call_answered DATETIME,
  call_ended    DATETIME,
  ring_seconds  INT,
  talk_seconds  INT,
  hold_seconds  INT,
  wrap_seconds  INT,
  status        VARCHAR(8),                       -- final disposition
  hangup_cause  VARCHAR(32),                      -- NORMAL_CLEARING, etc.
  amd_result    ENUM('none','machine','human','unknown') DEFAULT 'none',
  is_drop       BOOLEAN DEFAULT FALSE,            -- TCPA: live answer w/ no agent in 2s
  recording_id  BIGINT,
  INDEX (campaign_id, call_started),
  INDEX (lead_id),
  INDEX (call_started)
)
PARTITION BY RANGE (TO_DAYS(call_started)) (
  PARTITION p_2026_05 VALUES LESS THAN (TO_DAYS('2026-06-01')),
  ...
);

CREATE TABLE agent_log (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id       BIGINT NOT NULL,
  campaign_id   VARCHAR(32),
  call_log_id   BIGINT,
  event_at      DATETIME,
  event         ENUM('login','logout','pause','unpause','ready','call_start',
                    'call_end','dispo','transfer','hold','retrieve'),
  pause_code    VARCHAR(16),
  duration_sec  INT,
  metadata      JSON,
  INDEX (user_id, event_at),
  INDEX (campaign_id, event_at)
);

CREATE TABLE recording_log (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  uuid          VARCHAR(40),
  call_log_id   BIGINT,
  lead_id       BIGINT,
  campaign_id   VARCHAR(32),
  user_id       BIGINT,
  filename      VARCHAR(255),
  storage_url   VARCHAR(512),                     -- s3://bucket/path
  start_time    DATETIME,
  duration_sec  INT,
  size_bytes    BIGINT,
  encoded_at    DATETIME,
  INDEX (lead_id),
  INDEX (start_time)
);

-- Drop log for TCPA reporting
CREATE TABLE drop_log (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  call_log_id   BIGINT,
  campaign_id   VARCHAR(32),
  phone_e164    VARCHAR(16),
  dropped_at    DATETIME,
  drop_reason   ENUM('no_agent','timeout','queue_full'),
  safe_harbor_played BOOLEAN DEFAULT FALSE,
  INDEX (campaign_id, dropped_at)
);

-- Inbound queues (in-groups)
CREATE TABLE ingroups (
  id            VARCHAR(32) PRIMARY KEY,
  name          VARCHAR(128),
  music_on_hold VARCHAR(128) DEFAULT 'default',
  max_queue     INT DEFAULT 100,
  agent_wait_sec INT DEFAULT 60,
  ring_strategy ENUM('ring_all','longest_idle_agent','round_robin','top_down','agent_with_least_talk_time') DEFAULT 'longest_idle_agent',
  priority      INT DEFAULT 50,
  closer_only   BOOLEAN DEFAULT FALSE,
  recording_mode ENUM('NEVER','ALL') DEFAULT 'ALL',
  no_agent_action ENUM('voicemail','hangup','overflow_ingroup') DEFAULT 'voicemail',
  no_agent_target VARCHAR(64)
);

CREATE TABLE ingroup_agents (
  ingroup_id VARCHAR(32),
  user_id    BIGINT,
  rank       INT DEFAULT 5,           -- skill / priority
  PRIMARY KEY (ingroup_id, user_id)
);

CREATE TABLE pause_codes (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  campaign_id VARCHAR(32),                          -- NULL = global
  code        VARCHAR(16) NOT NULL,
  name        VARCHAR(64),
  billable    BOOLEAN DEFAULT TRUE,
  UNIQUE (campaign_id, code)
);

CREATE TABLE scripts (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(64),
  body MEDIUMTEXT,                                  -- HTML w/ {{lead.first_name}} placeholders
  campaign_id VARCHAR(32)
);

CREATE TABLE settings (
  k VARCHAR(64) PRIMARY KEY,
  v JSON
);
```

### 5.2 Live state — Redis only (no MEMORY tables)
```
agent:{user_id} → HASH {status, campaign_id, lead_id, call_uuid, last_change_at, pause_code, ingroups, server}
agents:by_status:READY → SORTED SET (score = ts of last state change) — used for "longest_wait" pick
agents:by_campaign:{campaign_id}:READY → SORTED SET
campaign:{cid}:dial_level → STRING (decimal)
campaign:{cid}:drop_window → STREAM (entries per call: {answered:1, dropped:0|1, ts}); trim to last 30d
campaign:{cid}:hopper → SORTED SET (score = priority desc + entry ts) of lead_ids
hopper:lock:{cid}:{lead_id} → STRING TTL 30s (claimed by a dialer instance)
calls:active:{uuid} → HASH {lead_id, campaign_id, agent_id, started_at, state}
broadcast:agent:{user_id} → pub/sub channel for the WS gateway
```

---

## 6. Backend services in detail

### 6.1 Hopper Filler (Go goroutine, every 30s per active campaign)
Replaces `AST_VDhopper.pl`. Pseudocode:

```go
func fillHopper(c Campaign) {
  target := computeHopperTarget(c)      // c.hopper_size_target or auto = ready_agents * dial_level * (60/dial_timeout) * multiplier
  current := redis.ZCard("campaign:"+c.ID+":hopper")
  need := target - current
  if need <= 0 { return }

  rows := db.Query(`
    SELECT id, list_id, phone_e164, tz_offset_min, state, status
    FROM leads
    WHERE list_id IN (SELECT list_id FROM campaign_lists WHERE campaign_id=?)
      AND status IN (?)                                          -- c.dial_status_filter
      AND (last_called_at IS NULL OR
           last_called_at < NOW() - INTERVAL recycleDelay(status) MINUTE)
      AND called_count < ?                                       -- c.max_dial_count
      AND NOT EXISTS (
        SELECT 1 FROM dnc d
         WHERE d.phone_e164 = leads.phone_e164
           AND ( (d.source='federal' AND ?)                      -- c.use_federal_dnc
              OR (d.source='state' AND d.state=leads.state AND ?)
              OR (d.source='internal' AND (d.campaign_id IS NULL OR d.campaign_id=?))
              OR d.source='litigator' OR d.source='reassigned' )
      )
      -- time-zone window: lead's local time must be within campaign call window
      AND localTimeNow(leads.tz_offset_min, leads.state) BETWEEN ? AND ?
    ORDER BY rank DESC, last_called_at IS NULL DESC, last_called_at ASC
    LIMIT ?`, ..., need)

  pipe := redis.Pipeline()
  for r := range rows {
    score := float64(r.Rank)*1e10 + float64(time.Now().Unix())
    pipe.ZAdd("campaign:"+c.ID+":hopper", Z{score, r.LeadID})
  }
  pipe.Exec()
}
```

The time-window check is the critical TCPA compliance gate — leads outside their local 8am–9pm fall through silently.

### 6.2 Dialer Loop (Go, runs every `1000ms / calls_per_second` per campaign)
Replaces `AST_VDauto_dial.pl`.

```go
func dialTick(c Campaign) {
  switch c.DialMethod {
  case "MANUAL":     return
  case "RATIO":      level = c.AutoDialLevel
  case "PROGRESSIVE": level = 1.0
  case "ADAPT_*":    level = redis.Get("campaign:"+c.ID+":dial_level")
  }
  agents := countAgents(c, c.AvailableOnlyTally)   // READY [+ INCALL if !available_only]
  desired := int(math.Round(float64(agents) * level))
  active := countActiveOutboundCalls(c)
  toDial := desired - active
  for i := 0; i < toDial; i++ {
    leadID := redis.ZPopMin("campaign:"+c.ID+":hopper")  // atomic pop
    if leadID == "" { return }
    redis.SetEX("hopper:lock:"+c.ID+":"+leadID, "1", 30s)
    go originate(c, leadID)
  }
}

func originate(c Campaign, leadID int64) {
  lead := db.Get(leadID)
  cid := pickCallerID(c, lead)                     // local-presence per area code optional
  uuid := newUUID()
  vars := fmt.Sprintf(
    "{origination_uuid=%s,origination_caller_id_number=%s,"+
    "campaign_id=%s,lead_id=%d,call_timeout=%d,"+
    "hangup_after_bridge=true,ignore_early_media=true,"+
    "execute_on_answer='park'}",   // park; we'll bridge in CHANNEL_ANSWER handler
    uuid, cid, c.ID, leadID, c.DialTimeoutSec)
  esl.BgAPI("originate", vars+"sofia/gateway/"+c.CarrierName+"/"+lead.PhoneE164+
            " &park()")
  insertCallLog(uuid, leadID, c, "out")
}
```

### 6.3 ESL event handler (Go goroutine)
Listens on FreeSWITCH event socket, switches on Event-Name:

| Event | Action |
|---|---|
| `CHANNEL_PROGRESS` / `CHANNEL_PROGRESS_MEDIA` | mark ringing |
| `CHANNEL_ANSWER` | start AMD; if AMD off, immediately try to bridge to a READY agent's conference. If no agent found within 2s → `is_drop=true`, play safe-harbor audio, hang up, write `drop_log`, update `campaign:{}:drop_window` stream. |
| `CUSTOM avmd::beep` | machine confirmed → either hangup or play vmdrop audio per `c.amd_action` |
| `CHANNEL_BRIDGE` | mark `agent_log` `call_start`; flip `agent:{id}.status=INCALL` |
| `CHANNEL_HANGUP_COMPLETE` | finalize `call_log` (talk seconds, hangup_cause); flip agent → `WRAPUP` for `c.wrapup_seconds`, then `READY` |
| `RECORD_STOP` | insert `recording_log`, kick worker to encode + upload |
| `CUSTOM conference::maintenance member-add/remove` | track who's in a conference for transfer state |

### 6.4 Adaptive engine (every 15s per campaign)
Replaces `AST_VDadapt.pl`.

```
window = redis.XRange("campaign:"+cid+":drop_window", last_30_days)
answered = sum(window.answered)
dropped  = sum(window.dropped)
drop_pct = 100 * dropped / max(answered,1)

case dial_method:
  ADAPT_HARD:    if drop_pct >= drop_target: level = max(1.0, level - 0.2)
                 else:                       level = min(max_level, level + 0.05)
  ADAPT_AVG:     err = drop_target - drop_pct
                 level = clamp(level + err*0.05, 1.0, max_level)
  ADAPT_TAPERED: shift_progress = elapsed/total_shift
                 effective_target = drop_target * (1 - 0.5*shift_progress)
                 ... same as AVG but vs effective_target
redis.Set("campaign:"+cid+":dial_level", level)
```

### 6.5 Agent picker (called from CHANNEL_ANSWER handler)
```
pick = redis.ZRangeByScore("agents:by_campaign:"+cid+":READY", -inf, +inf, LIMIT 0 1)  // longest-waiting first
if pick == nil: return DROP
redis.ZRem("agents:by_campaign:"+cid+":READY", pick)        // claim — atomic
agent_state.status = "RESERVED"
return pick
```

### 6.6 API Gateway (Node + Fastify) — agent endpoints
```
POST /api/agent/login                  → returns SIP creds, opens WS
WS   /api/agent/ws                      → server pushes call events, lead data, state
POST /api/agent/state                   → READY / PAUSED (with code) / WRAPUP
POST /api/agent/manual_dial             → {phone_e164, lead_id?, alt_dial?}
POST /api/agent/hangup
POST /api/agent/dispo                   → {status, comments, callback_at?}
POST /api/agent/transfer                → {kind: 'blind'|'vm'|'closer'|'3way'|'park_dial', ...}
POST /api/agent/transfer/leave_3way
POST /api/agent/transfer/hangup_third
POST /api/agent/dtmf                    → {digits}
POST /api/agent/recording               → {action: 'pause'|'resume'} (if ALLFORCE, 403)
POST /api/agent/lookup_lead             → {phone_e164}
POST /api/agent/update_lead             → {lead_id, fields:{...}}
POST /api/agent/skip                    → preview-mode skip
POST /api/agent/callback/snooze
GET  /api/agent/script
GET  /api/agent/webform_url
```

---

## 7. Agent Browser UI (Next.js + React + SIP.js)

### 7.1 Layout
```
┌────────────────────────────────────────────────────────────────────┐
│  Top bar:  [Campaign ▾]  [State: READY 00:42]  [Pause ▾]  [Logout] │
├────────────────────────────────────────────────────────────────────┤
│ Left  │  Lead Info (name, phone, address, tz, called_count, comments)│
│ panel │  Tabs: [Script] [Form] [History] [Notes]                   │
│       │                                                             │
│       │  ┌─Call controls────────────────────────────────────────┐  │
│       │  │ [Hangup] [Hold] [Mute] [DTMF] [Record◉]              │  │
│       │  │ [Manual Dial…] [Transfer ▾] [3-way ▾] [Callback]     │  │
│       │  └──────────────────────────────────────────────────────┘  │
│       │                                                             │
│       │  Disposition: [SALE NI CALLBK DNC NA WRONG …] (hotkeys 1-9) │
└───────┴─────────────────────────────────────────────────────────────┘
Bottom bar: queue depth, ready agents, drop% today, your calls today
```

### 7.2 SIP.js wiring
On login, browser opens `wss://fs.example.com:7443` with `aor=sip:1042@fs.example.com`, registers with the user's `sip_password`. Auto-answer is on for inbound INVITES (the dialer is going to push calls in). The WSS connection is the audio path; the WS to API is the control plane.

```js
const sip = new SimpleUser(`wss://${FS_HOST}:7443`, {
  aor: `sip:${userId}@${FS_HOST}`,
  userAgentOptions: { authorizationUsername: String(userId), authorizationPassword: sipPass },
  media: { remote: { audio: audioRef.current } },
  delegate: { onCallReceived: () => sip.answer() }   // auto-answer
});
await sip.connect();
await sip.register();
// Dialer "calls" us at *9{userId} which the dialplan answers and joins us to our conference.
await sip.call(`sip:*9${userId}@${FS_HOST}`);
```

### 7.3 Manual-dial flow (MVP)
1. Agent clicks **Manual Dial** → modal: phone (+ optional `lead_id` lookup, alt-dial toggle).
2. UI calls `POST /api/agent/manual_dial`.
3. API resolves/creates a lead, writes `call_log` row (status `INPROG`), then via ESL: `bgapi originate {campaign_id=...,lead_id=...,origination_caller_id_number=<cid>}sofia/gateway/<carrier>/<phone> &transfer('conf_${userId}' XML default)`.
4. Carrier rings the customer; on answer, FS executes the transfer → customer joins agent's conference. Agent's browser already has audio via SIP.js leg.
5. ESL handler emits `call_started` over WS, UI swaps to "in call" state.
6. Agent works the lead, hits **Hangup** → `POST /api/agent/hangup` → `bgapi uuid_kill`.
7. UI shows disposition picker (or hotkeys). Submit → `POST /api/agent/dispo` updates `leads.status`, writes `agent_log`, writes `call_log.status`, schedules callback if applicable, then UI returns to READY (after `wrapup_seconds`).

### 7.4 Transfer flows (mapped to FS ops)
| User intent | FS ops |
|---|---|
| **Blind transfer** to a number | `uuid_transfer <customer_uuid> ext-out:${phone} XML default`. Agent stays in conf, but the customer leaves. |
| **Voicemail drop** | `uuid_transfer <customer_uuid> playback:${vmdrop.wav} XML default` then hangup customer. Lead status auto-set to `AVMA`. |
| **Closer / agent in-group** | `uuid_transfer <customer_uuid> ingroup:${ingroup_id} XML default` — dialplan does `callcenter ${ingroup_id}@default`. Agent stays or leaves based on consultative flag. |
| **3-way (DIAL_WITH_CUSTOMER)** | `bgapi originate {originate_timeout=30}sofia/gateway/${carrier}/${third_party} 'conference:conf_${userId}+flags{join-only}' inline`. Third leg lands directly in the same conf as customer + agent. |
| **Consultative warm transfer** | Originate third party into a *separate* private conf with the agent only; the customer stays in the original conf alone (with MoH). When agent confirms, do `conference move` of the customer into the new conf, then leave. |
| **Leave 3-way** | Agent leg is `conference kick`-ed from conf; customer + third party stay until either hangs up. `recording_follow_transfer=true` keeps the recording running. |
| **Park** | Move customer to a parking lot conf with MoH; agent goes to dispo screen. |

### 7.5 Hotkeys
SIP.js doesn't capture keyboard events. We bind 0-9 → submit dispo with the matching `statuses.hotkey` if `campaigns.hot_keys_active=true` and current state is `WRAPUP`. F1 = hold, F3 = hangup, Ctrl+T = transfer menu, Ctrl+P = pause.

### 7.6 Real-time push
Server-side, every state change publishes to Redis `broadcast:agent:{user_id}`. The Fastify WS gateway subscribes per connected agent and forwards. No polling.

---

## 8. Admin & Supervisor UIs

### 8.1 Admin (Next.js)
- **Campaigns** — wizard for `campaigns` row + dial method picker with explanations + dial-status filter chips.
- **Lists** — CSV upload (chunked, server-side parse, mapping UI for custom fields → `leads.custom_data`), preview, lead count by status, per-list overrides.
- **Leads** — search, edit, manual add, mass status change, recycle, push to hopper.
- **DNC** — bulk import federal/state CSVs (we sync federal weekly via FTC API), per-campaign internal DNC view, opt-out queue (manual review).
- **Carriers** — Add/edit Twilio/RingCentral/BYOC, test SIP option (sends OPTIONS, shows response), live registration status.
- **DIDs** — assign inbound numbers to in-groups / IVRs / agents.
- **In-Groups** — define queues, ring strategy, music, max queue, no-agent action.
- **Scripts** — WYSIWYG with `{{lead.field}}` placeholders.
- **Pause Codes** — per campaign or global.
- **Users / User Groups** — agent provisioning, generates SIP password.
- **Servers** — for multi-FS deployments, lists each FS box, current load.
- **Reports** — call summary, agent productivity, drop% per campaign per day (TCPA report), DNC scrub log, recording search/playback.

### 8.2 Supervisor
- **Live wallboard** — agent status grid, queue depths, drop% gauge, calls/sec.
- **Listen / whisper / barge** — click an active call → `POST /api/sup/eavesdrop` issues `bgapi originate user/${sup_id} 'eavesdrop:${uuid}' inline`. DTMF 1/2/3 toggles modes.
- **Recording playback** — list, search by lead/agent/campaign, play in browser, download.
- **Agent kick / pause** — force agent state.

---

## 9. Compliance Layer (TCPA / DNC) — built in, not bolted on

| Concern | Mechanism in Vici2 |
|---|---|
| **8am–9pm called-party local time** | Hopper filler runs `localTimeNow(lead.tz_offset_min, lead.state)` via campaign's `call_times` row (with state overrides for stricter states). Leads outside window are silently skipped — never enter the hopper. |
| **3% drop limit** | `campaign:{cid}:drop_window` Redis stream, 30-day rolling. Adaptive engine reads it. Admin sees drop% live; if it's >2.5% the dial-level engine refuses to raise level. |
| **Safe-harbor message on drop** | When dialer abandons after live answer (no agent in 2s), play `c.safe_harbor_audio` before hangup; record in `drop_log.safe_harbor_played=true`. |
| **DNC scrub** | `dnc` table populated by a worker that pulls federal weekly, state monthly. Hopper filler joins against `dnc` per call (every call, not pre-batch). Internal DNC dispositions are inserted by the agent screen with `source='internal'` instantly. |
| **Reassigned numbers** | Optional integration with FCC RND DB; same `dnc.source='reassigned'` mechanism. |
| **Identification announcement** | Optional opening dialplan step that plays a 1-2s caller-ID prompt before bridging to the agent. |
| **Recording consent** | `campaigns.recording_consent_audio` plays before bridge in 2-party-consent states (lookup `lead.state` against built-in list). If disagreement, drop. |
| **Opt-out within 10 days** | Admin opt-out queue + Webhook from incoming SMS/email STOP keyword → immediate insert into `dnc(source=internal)`. |
| **Audit trail** | Every dial appended to `call_log` with `is_drop`, `amd_result`, `caller_id`, recording reference. DNC-scrub jobs log to `agent_log` with `event='system_dnc_sync'`. |

---

## 10. Build Phases

### Phase 1 — MVP "Manual Dial Center" (4–6 weeks)
- FreeSWITCH + Sofia profiles + one carrier (Twilio) + WSS for browser.
- Conference-per-agent dialplan.
- Schemas: `users`, `carriers`, `campaigns`(MANUAL only), `lists`, `leads`, `statuses`, `call_log`, `agent_log`, `recording_log`, `dnc`(internal only), `phone_codes`, `callbacks`.
- API: agent login, WS, manual_dial, hangup, dispo, callbacks, lead lookup, transfer (blind + 3-way + leave-3way + vm-drop).
- UI: Agent screen with SIP.js, Admin: campaigns/lists/leads/users/carriers/DIDs.
- Recording on every call, simple browser playback.
- Compliance: 8–9pm local-time enforcement, internal DNC, recording consent for 2-party states.

### Phase 2 — Auto-dialer (3–4 weeks)
- Hopper filler + dialer loop + adaptive engine.
- `RATIO`, `PROGRESSIVE`, `ADAPT_TAPERED` modes.
- Federal + state DNC sync workers.
- AMD via `mod_avmd` (beep) + simple silence-based heuristic; optional commercial AMD.
- Drop% gauge, safe-harbor audio.
- Hotkeys, pause codes, wrapup timer.

### Phase 3 — Inbound / Blended (3–4 weeks)
- In-groups via `mod_callcenter`; ring strategies.
- DID inbound routing.
- IVR builder (admin UI generates dialplans pushed via `mod_xml_curl` cache).
- Closer/blended: agent serves both campaign and in-group depending on activity.
- Supervisor listen/whisper/barge.

### Phase 4 — Scale & polish (ongoing)
- Multi-FS sharding (one campaign affines to one FS box for conference locality; agent SIP can register to any).
- S3 recording archival + Whisper transcription.
- Real-time analytics dashboard (Grafana on Prometheus exporters in dialer engine).
- Mobile supervisor app.
- WebRTC video for agent training.

---

## 11. Risks & open decisions

| Risk | Mitigation |
|---|---|
| **AMD accuracy** — `mod_avmd` only detects beeps, `mod_amd` is moderate, `mod_com_amd` is paid (~$). | Start without AMD (just live answer + 2s drop window); add commercial AMD only if drop% strain demands it. |
| **WSS NAT/cert pain** | Require valid LE cert on FS hostname; document. Use STUN; FreeSWITCH `ext-rtp-ip=auto-nat`. |
| **Carrier short-call & SHAKEN/STIR** | Use STIR-attested carriers (Twilio handles A/B); add `verstat` checks on inbound. |
| **Conference-per-agent at scale (1k+ agents)** | Each conf is cheap (no MOH on idle), but FS event volume scales linearly. Shard agents across FS instances; the API gateway picks the right ESL host per agent. |
| **MySQL hot rows on `leads`** | Lead status update on dispo could lock heavily. Use UPDATE by PK only; never SELECT…FOR UPDATE in agent path. Statistics queries hit a 5-min materialized snapshot. |
| **Dialer engine HA** | Multiple Go instances, Redis SETNX lock per `(campaign_id, tick)` so only one instance ticks per slot; hopper consumption is atomic via `ZPOPMIN`. |
| **Predictive licensing fear** | Make `MANUAL` and `PROGRESSIVE` (dial 1 per ready agent) the safe defaults. Predictive only behind a campaign-level toggle with mandatory drop% target ≤ 2%. |

---

## 12. Repository layout (proposed)

```
vici2/
├── docker-compose.yml             # mysql, redis, freeswitch, api, dialer, web
├── freeswitch/
│   ├── Dockerfile
│   ├── conf/
│   │   ├── autoload_configs/event_socket.conf.xml
│   │   ├── sip_profiles/internal.xml          # WSS + UDP for hardphones
│   │   ├── sip_profiles/external.xml
│   │   ├── sip_profiles/external/twilio.xml.tmpl   # rendered from carriers table
│   │   ├── dialplan/default/00_internal_dialer.xml
│   │   ├── dialplan/default/01_agent_conference.xml
│   │   ├── dialplan/public/00_from_carrier.xml
│   │   └── autoload_configs/callcenter.conf.xml.tmpl
│   └── tls/
├── api/                            # Node 20 + Fastify + Prisma
│   ├── src/{routes,services,ws,esl,prisma}
│   └── prisma/schema.prisma
├── dialer/                         # Go
│   ├── cmd/dialer/main.go
│   ├── internal/{esl,hopper,pacing,adapt,events,db}
│   └── go.mod
├── web/                            # Next.js
│   ├── app/{agent,admin,sup}
│   ├── components/sip/{SimpleUser.ts,Hotkeys.ts}
│   └── lib/api.ts
├── workers/                        # Node — DNC sync, recording encode, reports
└── db/
    ├── migrations/                 # SQL
    └── seeds/{phone_codes.sql,statuses.sql}
```

---

## 13. Up-front decisions to confirm before coding

1. **Backend language for the dialer engine: Go or Node?** Recommendation: **Go** — predictable goroutine pacing matters for 100+ originates/sec and you don't want Node event-loop hiccups under GC. API + workers stay Node.
2. **Browser SIP: SIP.js (WSS standard) vs mod_verto?** Recommendation: **SIP.js** — portable, FS 1.10 supports it natively, no proprietary lock-in.
3. **MySQL or PostgreSQL?** You asked for MySQL → **MySQL 8 InnoDB** with monthly partitions on log tables.
4. **Single-tenant or multi-tenant?** I've assumed single-tenant. If multi-tenant, every table needs `tenant_id` and Redis keys get a `t:{tid}:` prefix.
5. **Recording legal default**: assume **2-party consent for all calls** (over-comply); play a recording-notice prompt before bridge. Toggleable per campaign for one-party-consent states.
6. **AMD**: start **off**. Drop% accounting + 2s safe-harbor handles the legal floor without false-positive AMD costing you live answers.
7. **First-stretch carrier pick**: **Twilio** is the easiest dev experience; RingCentral support second; generic BYOC last (it's just a config form).

---

# Part II — Reality Check, Limits, Cost, Complexity

(Appended after a second research pass. Sources: FreeSWITCH mailing list, Issue #1729, Vicistack Kamailio guide, Newfies-Dialer docs, Twilio/Telnyx/SignalWire/Flowroute pricing pages, FCC orders, ViciStack CRM integration guide.)

## 14. What we CAN do, and what we CANNOT do

### 14.1 ✅ Things this design will do well

| Feature | Why it works |
|---|---|
| **Manual dial + transfer + 3-way + recording** | FreeSWITCH `mod_conference` + `record_session` are mature; conference-per-agent maps cleanly to every transfer mode. The agent UI is tractable React + SIP.js. **MVP is realistic in 4–6 weeks.** |
| **Inbound queues (in-groups)** | `mod_callcenter` + `mod_fifo` are production-tested. Better ergonomics than Asterisk's app_queue. |
| **BYOC + Twilio + RingCentral SIP** | One Sofia gateway per carrier; admin UI templates the XML. This part is straightforward. |
| **WebRTC agent softphone (under ~150 concurrent per FS box)** | Works but with caveats — see §15. |
| **Predictive dialing up to ~50 agents per FS box** | Hopper + adaptive engine in Go is more deterministic than Vicidial's Perl scripts. |
| **MySQL lead/log layer up to ~10M leads / 1M calls per month** | InnoDB with monthly partitions handles this without sharding. |
| **Compliance-first design** (TCPA 8–9pm, 3% drop, internal+federal DNC, recording consent gates) | Built into the schema and hopper filler so it's hard to bypass. |
| **CRM webhook integration (Salesforce/HubSpot/Zoho/Pipedrive)** | Established pattern: REST `add_lead`, `external_dial`, disposition webhook. Already a 1-week feature. |

### 14.2 ⚠️ Things this design CAN do but will cost real engineering

| Feature | What's hard about it |
|---|---|
| **AMD (answering machine detection)** with acceptable accuracy | `mod_avmd` only detects beeps. `mod_amd` is mediocre. `mod_com_amd` is paid (~$2k+/server). State-of-the-art now is ML-based AMD (Twilio's AsyncAmd, Pindrop). Plan: ship without AMD; use `mod_avmd` for voicemail-drop only; integrate Twilio's AMD API or commercial solution if drop% becomes a problem. |
| **WebRTC + SRTP at >150 concurrent agents on one FS box** | Documented production issue: at ~150 concurrent SRTP/WebRTC sessions FreeSWITCH starts dropping packets even at low CPU ([source](http://lists.freeswitch.org/pipermail/freeswitch-users/2017-October/128122.html)). Workaround: offload SRTP to `rtpengine` running alongside FS, or split agents across multiple FS instances. |
| **Conference-per-agent at >900 active conferences** | Hard wall at ~900 conferences (1796 sessions) due to thread-creation limits in `switch_core_session.c` — even on a 36-core 72GB box, even at 20% CPU. Famous "Artoo R2D2" log message ([Issue #1729](https://github.com/signalwire/freeswitch/issues/1729)). Sharding required above ~500 concurrent agents. |
| **Multi-server scaling with state coherence** | Once you have >1 FS box, you need Kamailio in front (see §16). Adds operational complexity. |
| **STIR/SHAKEN A-attestation maintenance** | Even with proper attestation, carriers will label your number "Spam Likely" if call patterns look spammy. Requires reputation management — see §17. |
| **TCPA-grade audit trail** | Every dial, every DNC scrub, every recording, every consent acquisition needs to survive 4-year statute of limitations + discovery. Requires immutable logging + S3 lock. |
| **"Nice" call-quality at 0.5% packet loss** | Need Opus codec (better loss concealment) and `rtpengine` to do transcoding so PSTN side stays PCMU. Adds another moving piece. |

### 14.3 ❌ Things this design CANNOT do well, or shouldn't try

| Anti-feature | Why we shouldn't |
|---|---|
| **Replace Vicidial 1:1 in features** | Vicidial has 19 years of accreted features (300+ campaign settings, 50+ tables, 25+ Perl daemons, dozens of report screens). We won't match that breadth. We aim for the 80/20: cover the features 95% of users actually use. |
| **Self-host SIP carrier service** (originate calls without an upstream) | We're an end-user / aggregator, not a CLEC. Always rely on Twilio/Telnyx/Bandwidth/etc. Don't try to peer with carriers directly until $10M+ revenue. |
| **Sub-50ms voice latency over commodity internet** | Browser → FS over WSS adds 30–80ms typical. PSTN leg adds another 40–120ms. International is worse. We can't fix physics; we can pick low-latency carriers and edge-deploy FS. |
| **Run on a single machine at >100 agents** | The math says no — see §15. |
| **Deeply customized dispositions / nested webforms / fully custom IVR designer** | Possible, but each is a 3–6 week feature. Phase 4+. |
| **AI voice agents / outbound bots** | Different product. Don't conflate. |
| **Predictive dialing for international markets without local presence** | Caller-ID rep + STIR/SHAKEN are US-specific. International outbound needs a different stack per country. |
| **Replace Salesforce / HubSpot / a CRM** | We are a dialer + lead management *for* outbound campaigns. Lead enrichment, deal pipelines, marketing automation — leave to CRMs we integrate with. |

## 15. FreeSWITCH at scale — the real numbers

Source: FreeSWITCH mailing list, [signalwire/freeswitch#1729](https://github.com/signalwire/freeswitch/issues/1729), production deployment reports.

### 15.1 Single-instance ceilings (16-core / 64 GB box, FS 1.10, Linux)

| Workload | Practical ceiling per FS instance |
|---|---|
| Plain SIP bridging (no transcoding, PCMU both legs) | **~3,000 concurrent calls** |
| WebRTC + SRTP on one leg, PCMU PSTN | **~150 concurrent** before degradation (RTT spikes, packet loss) |
| WebRTC end-to-end (both legs SRTP) | **~80–120 concurrent** |
| Active conferences (mod_conference) | **~900 conferences = 1,796 sessions** — hard thread-creation wall |
| New calls per second (originate) | **~50 CPS sustained**, ~100 peak. Sofia is single-threaded for SIP UA. |
| Concurrent SIP registrations | **~10,000** before subscribe/notify storms cause segfaults |
| Call recording (MixMonitor) | Disk I/O bound. NVMe handles 500+ concurrent. SATA chokes ~200. |

### 15.2 Conference-per-agent — when does it break?

| Agents | Active calls | Conferences | Per-FS verdict |
|---|---|---|---|
| 50 | ~150 | 50 (idle) + 50 (in-call) = 100 | Easy. One box. |
| 100 | ~300 | 200 | Single box, watch SRTP if WebRTC. |
| 500 | ~1500 | 1000 | **Sharding required** (Kamailio + 2-3 FS boxes). |
| 1000 | ~3000 | 2000 | Multi-FS mandatory. Kamailio + 4-6 FS boxes + dedicated MySQL + Redis cluster. |
| 5000 | ~15000 | 10000 | Different system. Geographic distribution, dedicated rtpengine farm, MySQL sharded. |

**Implication for the design:** Add a **Phase 3.5** — Kamailio SIP load balancer + per-campaign FS affinity — between our Phase 3 and Phase 4. This turns the design from "one-box system" into "horizontally-scalable system." Without it, ~100-agent ceiling per deployment.

### 15.3 What actually breaks first (in production)

Real failure modes from FS mailing lists:
1. **Thread exhaustion** at ~1800 sessions (Artoo). Workaround: split into multiple FS instances on same box, each in its own LXC/container.
2. **SRTP throughput collapse** ~150 WebRTC connections — root cause unknown, well-documented. Workaround: `rtpengine` for SRTP↔RTP bridging.
3. **`vicidial_manager`-style AMI/ESL command queue overflow** — ours is direct ESL bgapi so we avoid this, but the equivalent risk: Redis pub/sub backpressure if dialer engine outpaces ESL handler.
4. **Stuck channels** after BYE loss — `core_session_hangup` race. Need a janitor goroutine that finds calls in `call_log` with `call_started > 4h ago` and no `call_ended`, calls `uuid_kill`.
5. **MySQL InnoDB lock waits** on hot rows during predictive bursts — mitigated in our design by Redis-first state, MySQL only for persistent writes.
6. **Conference cleanup leaks** — Vicidial added `AST_conf_update_screen.pl` for this exact problem. We need an equivalent: every 60s sweep `conference list` and kill conferences with 0 members.

## 16. Kamailio is not optional past 100 agents

[Vicistack production guide](https://vicistack.com/blog/vicidial-kamailio-load-balancing) maps this stage-by-stage:

```
Stage 1 (≤50 agents):     1 FS, no Kamailio
Stage 2 (50–100 agents):  Kamailio + 2 FS (Kamailio can co-locate on FS box)
Stage 3 (100–200 agents): Kamailio (dedicated VM) + 3 FS
Stage 4 (200–500 agents): 2× Kamailio (VRRP/keepalived) + 5 FS
Stage 5 (500+ agents):    2× Kamailio per region + 10+ FS + rtpengine cluster + MySQL replicas
```

What Kamailio adds:
- **Health probing** of FS instances (SIP OPTIONS pings every 10–15s).
- **Weighted round-robin** or **fewest-active-calls** dispatch.
- **Automatic failover** when an FS box returns 503.
- **Call-id affinity** so re-INVITEs/BYEs reach the same FS that handled the INVITE.
- **OpenSIPS 2.3+ has `freeswitch_esl` driver** that subscribes to FS HEARTBEAT events for true load-aware routing — better than blind round-robin.

**Architectural implication:** Phase 3.5 of our build adds Kamailio. The dialer engine and API gateway need to learn to "pin a campaign to a FS instance" so all conferences for that campaign are co-located (avoids cross-instance audio bridging). This is a 2–3 week project on top of the Phase 3 in-group work.

## 17. The cost story (real 2026 numbers)

Sources: [Twilio SIP pricing](https://twilio.com/en-us/sip-trunking/pricing/us), [Telnyx pricing](https://telnyx.com/pricing/elastic-sip), [SignalWire voice pricing](https://signalwire.com/pricing/voice), [Flowroute pricing](https://flowroute.com/pricing-details), [Nextiva 2026 SIP guide](https://www.nextiva.com/blog/sip-trunk-pricing.html).

### 17.1 Per-minute outbound rates (US 48-state, 2026)

| Carrier | Outbound /min | Inbound local /min | DID /mo | Channel/CPS pricing |
|---|---|---|---|---|
| **SignalWire** | **$0.0080** (or **$0.0030 SIP-to-SIP**) | $0.0066 / $0.0030 SIP | $0.50 | First CPS free; $15/mo per additional 2-20 CPS |
| **Telnyx** | $0.005–0.009 | $0.0035 | $1.00 | $12/mo first 10 channels, drops to $8/mo at 250+ |
| **Flowroute** | $0.00833 | $0.005 | $0.50 | No channel limit |
| **Twilio Elastic SIP** | $0.013 (started ~$0.0025 with volume) | $0.0085 | $1.15 | CPS-based pricing tiers |
| **Bandwidth.com** | Custom (~$0.005–0.008) | Custom | Custom | Annual contract required |
| **Nextiva (channel-based)** | Included | Included | Included | $24.95/channel/mo unlimited |

### 17.2 Real cost per agent per month

Assumptions: 50 agents × 4 talk-hours/day × 22 work-days/month = **8.8 talk-hours/agent/day average × 22 = 193 talk-hours/agent/month** (conservatively, with predictive dialer connect-rate). At 4h/day:

| Volume model | Total minutes/mo | Twilio | Telnyx | SignalWire | Flowroute |
|---|---|---|---|---|---|
| 50 agents, 4 talk-h/day | ~528,000 | $6,864 | $2,640 | $1,584 | $4,398 |
| **per agent** | | **$137/mo** | **$53/mo** | **$32/mo** | **$88/mo** |
| 100 agents | 1,056,000 | $13,728 | $5,280 | $3,168 | $8,797 |
| **per agent** | | **$137/mo** | **$53/mo** | **$32/mo** | **$88/mo** |

Plus DIDs (maybe 100 numbers @ $1 = $100/mo), STIR/SHAKEN (~$0.001/call), recording storage (S3 ~$23/TB-mo).

**Recommendation:** Default to **Telnyx** (Tier-1 carrier reputation + $0.005/min + good API + easy STIR/SHAKEN). **SignalWire** for cost-optimized SIP-to-SIP. **Twilio** as the "easy onboarding / branded calling" option for premium customers. **Always** support BYOC for customers with their own carrier deals.

### 17.3 Hosting cost (the dialer infrastructure itself)

| Component | Recommended size | Cost (AWS/Hetzner) |
|---|---|---|
| FS box (per ~100 agents) | 16-core, 32 GB, NVMe | $200–400/mo |
| MySQL primary | 8-core, 32 GB, 500 GB NVMe | $150–300/mo |
| Redis | 4-core, 16 GB | $50–100/mo |
| API + dialer engine + workers | 8-core, 16 GB | $100–150/mo |
| Web (Next.js) | 4-core, 8 GB | $30–80/mo |
| Kamailio (when needed) | 4-core, 8 GB × 2 | $60–160/mo |
| S3 recording (50 agents, 6mo retention) | ~5 TB | $115/mo |
| **Total infra at 50 agents** | | **~$700–1,200/mo** |
| **Total at 100 agents (multi-FS)** | | **~$1,500–2,500/mo** |

**Per-agent infra cost: $14–25/mo.** Negligible vs carrier minutes.

### 17.4 SaaS pricing leverage (if you sell this)

Vicidial-managed-hosting providers charge $40–150/agent/mo on top of carrier costs. With a clean stack and modern UI you can credibly charge **$80–120/agent/mo** at 50–500 agents, leaving $40–80/agent/mo gross margin after infra + carrier markup.

## 18. STIR/SHAKEN, TCPA, and "will the FCC sue me?"

The compliance landscape **2025-2026**:

### 18.1 STIR/SHAKEN reality
- All US carriers are required to attest. **A-attestation** = caller fully authenticated and authorized to use the number; **B** = authenticated caller, partial number ownership; **C** = call traversal only.
- **"A" attestation is not enough.** Carriers (T-Mobile especially) and analytics companies (Hiya, First Orion, TNS) maintain reputation databases. High call volume + high "no answer" + low call duration = "Spam Likely" label, regardless of attestation.
- **Mitigations:**
  - **Branded calling**: register names with First Orion (CallerID), Hiya Connect, TNS — ~$3–10/number/mo. Shows "ACME Corp" instead of "Spam Likely."
  - **Number rotation**: don't burn one DID into oblivion. Pool of 50–500 numbers per campaign, rotate.
  - **Local presence**: caller-ID matches called party's area code. Improves answer rates 30–60%.
  - **Use carrier with high reputation**: Twilio, Bandwidth, Telnyx all do A-attestation by default for owned numbers.

### 18.2 TCPA one-to-one consent
- FCC's "one-to-one consent" rule (FCC 23-107) was **vacated by the 11th Circuit Court** in IMC v FCC (Jan 2025). As of 2026 it is **NOT in effect**, but the FCC may re-issue with modified rules.
- **Bottom line:** lead aggregators are still operating under the prior rule (single consent can cover multiple sellers), but you should design the consent capture to support both — store consent per (consumer, seller) pair so you can switch behavior with a flag.

### 18.3 State Mini-TCPAs (proliferating)
- **Florida (FTSA)** — strict consent + private right of action. Class actions filed by the dozens.
- **Washington** — opt-out within 10 days, recording consent two-party.
- **Oklahoma, Maryland, NY** — variations.
- **Mitigation:** apply most-restrictive rule per called-party state (we already model this with `call_times.state_overrides`).

### 18.4 AI-call rule (FCC 24-17, Feb 2024)
- AI-generated voice calls are now treated as "artificial or prerecorded voice" requiring prior express written consent.
- **Implication for us:** the safe-harbor "drop" message and any IVR voice prompts should be **clearly identifiable as recorded** and not impersonate a human. Our current design uses pre-recorded `safe_harbor_audio` — fine. If we ever add ElevenLabs-style cloned voices, separate consent flow required.

### 18.5 Recording consent — updated 2-party state list (12 states + DC)
California, Connecticut, Delaware, Florida, Illinois, Maryland, Massachusetts, Michigan (with caveat), Montana, Nevada (effective 2026), New Hampshire, Pennsylvania, Washington. **No state has moved from two-party to one-party recently.** Some have *added* private rights of action increasing exposure.

**Operational rule:** Default to **all-party consent** with announcement at call start. Per-campaign override only with legal sign-off.

### 18.6 DNC scrubbing operations
- **Federal DNC**: FTC API at `telemarketing.donotcall.gov`. Free for first 5 area codes, then $87/area code/year (capped at $24,134/year for all 280+ area codes). Must download daily/weekly Change Lists and fold into local DNC.
- **State DNC**: 11 states have separate lists, some free, some paid. Consolidated services like DNC.com / LeadCompliant ($300–2000/mo) handle all of them.
- **Reassigned Numbers Database** (RND, FCC): $0.0023/query batch, or unlimited subscription ~$3,500/mo. Important for "safe harbor" against TCPA suits about reassigned mobile numbers.
- **Litigator suppression** (Blacklist Alliance, TCPA Defense Force): $500–2000/mo. Real defense — known TCPA litigators file ~80% of suits.

### 18.7 Practical compliance posture for <50 agents
Realistic minimum:
1. Pull federal DNC weekly, scrub before every campaign launch.
2. Use Twilio/Telnyx/Bandwidth (they handle STIR/SHAKEN attestation A automatically for owned numbers).
3. Internal DNC instant suppression on opt-out.
4. 8am–9pm called-party-local-time enforcement (already in design).
5. ≤2% drop rate target per campaign per 30 days.
6. Recording consent prompt for all calls.
7. 4-year audit log retention.
8. Add litigator-list scrub once revenue justifies the $500/mo.

**Do NOT skip:** federal DNC scrub, time-zone enforcement, internal opt-out, recording consent. These are the bare-minimum-not-to-get-sued items.

## 19. Existing FreeSWITCH-based dialers — what we can learn

| Project | Stack | Strengths | What they don't do (that we will) |
|---|---|---|---|
| **Newfies-Dialer** ([docs](https://docs.newfies-dialer.org/)) | FS + Django + Celery + Redis + **Postgres** | Voice broadcast at scale (millions of calls/day), multi-server, REST API, Lua IVR | **Not a real call center** — agent UI is minimal, no predictive (just power dial), no sophisticated transfer. Heavy bias to outbound IVR. |
| **ICTDialer** | FS + ICTCore + PHP | SMS + voice + fax in one platform, multi-tenant | Old PHP UI. Less active community. No predictive. |
| **Hello Hunter** (commercial) | FS-based predictive | The only published FS-based predictive dialer | Closed source. Limited transparency. |
| **OpenACD** | Erlang + FS | Clean inbound queueing | Project effectively dormant. Nobody uses. |
| **Wombat Dialer** (Loway) | Asterisk-based | Proven predictive engine | Asterisk-only, paid. Worth learning predictive UX from. |

**Takeaway:** Nobody has shipped a true open-source full-featured Vicidial replacement on FreeSWITCH. Closest is Newfies-Dialer (broadcast) + a custom agent layer. **We are filling a real gap.** That also means we're building things nobody has solved cleanly yet, so expect rough edges in months 6–12.

## 20. Complexity assessment

### 20.1 Engineering effort, calibrated

| Phase | Description | Realistic team-effort |
|---|---|---|
| **Phase 1** — Manual dial MVP | Single FS, single carrier (Twilio), agent UI, transfers, recording, dispositions, callbacks, basic admin | **2 senior eng × 6 weeks = 12 person-weeks** |
| **Phase 2** — Auto-dialer | Hopper, pacing, adaptive, AMD, federal DNC sync, drop-rate enforcement, hotkeys | **2 senior eng × 6 weeks = 12 person-weeks** |
| **Phase 3** — Inbound + blended | In-groups, IVR builder, supervisor listen/whisper/barge, DID routing | **2 senior eng × 6 weeks = 12 person-weeks** |
| **Phase 3.5** — Kamailio + multi-FS | SIP load balancer, campaign-to-FS affinity, fault tolerance | **1 senior eng × 4 weeks = 4 person-weeks** |
| **Phase 4** — CRM integrations + reporting + analytics | Salesforce/HubSpot/Zoho webhooks, branded calling, S3 archival, Whisper transcription | **2 eng × 6 weeks = 12 person-weeks** |
| **Compliance hardening** (ongoing) | State DNC, RND, litigator lists, audit retention, SOC2-prep | **1 eng + 1 lawyer × 4 weeks = 4 person-weeks + legal hours** |
| **Production hardening** (ongoing) | Janitor jobs, monitoring, alerting, runbooks, on-call rotation | **1 eng × continuous** |

**Total to "credibly competitive with Vicidial for 80% of users": ~56 person-weeks ≈ 14 months for a 2-person senior team, or 7 months for a 4-person team.** Add legal/compliance review (~$30k) and a paid security audit ($15-30k) before serving regulated industries.

This matches reality: the open-source Newfies-Dialer team has been at it for 12+ years; Vicidial took 19 years to reach its current state. Yes, you have the benefit of modern tools, but telephony is full of edge cases that take time to find.

### 20.2 Will it work great?

**At MVP (Phase 1–2, ≤50 agents, single FS, single carrier):** Yes, very confidently. The components are mature and well-understood. SIP.js + FreeSWITCH + a simple Go dialer is a known-good combination.

**At Phase 3 (≤100 agents, blended, supervisor):** Yes, with discipline around test coverage. The complexity jump is mostly UX and edge-case handling.

**At Phase 3.5–4 (>100 agents, multi-FS, multi-tenant):** Yes if you put a senior SRE on it. This is where things get expensive operationally. You'll have on-call pages.

**At Vicidial-comparable scale (1000+ agents):** Achievable but you're now running a serious telephony platform. Plan for a 5–10 person engineering org plus dedicated compliance, security, and SRE.

### 20.3 Highest-risk areas to watch

1. **WebRTC quality at scale** — solved by adding rtpengine + offloading SRTP. Plan for it from Phase 1.
2. **AMD accuracy** — affects user-perceived quality more than anything else. Don't ship custom AMD; integrate Twilio AsyncAmd or pay for mod_com_amd.
3. **TCPA exposure** — one bad campaign can bankrupt a small operator. Build the audit trail correctly from day 1.
4. **Predictive math edge cases** — ratio/adapt math is finicky; copy Vicidial's exact algorithm rather than inventing.
5. **State coherence across dialer engine restarts** — Redis is the source of truth for live state; design recovery semantics carefully.

## 21. What to ADD that wasn't in the original design

Things the second research pass surfaced as either important or table-stakes:

### 21.1 Must-add (not in v1 design)

| Addition | Where it goes | Why |
|---|---|---|
| **rtpengine** for SRTP offload | Phase 2 minimum, mandatory by Phase 3 | Solves the ~150-WebRTC packet-loss wall on FreeSWITCH. Co-locate on FS host. |
| **Channel janitor** goroutine | Phase 1 | Sweeps stuck channels, dead conferences. Vicidial learned this the hard way. |
| **CRM webhook framework** (REST + outbound webhooks) | Phase 1 (POST endpoints) → Phase 4 (full bidirectional) | Designs already mention REST add_lead/external_dial. Add: outbound webhooks on call_start, call_end, dispo, transfer. Mirror VICIdial's URL hooks. |
| **Number pool / rotation** | Phase 2 | Prevents single-DID burnout under STIR/SHAKEN reputation systems. Pool of 50–500 numbers per campaign. |
| **Local-presence caller-ID matching** | Phase 2 | Match called area code → answer rates jump 30–60%. Pull from carriers like Telnyx that sell local-presence DID packs. |
| **Branded calling integration** | Phase 4 | First Orion / Hiya / TNS APIs to register caller-ID name. ~$3–10/DID/mo. |
| **Reassigned-numbers DB scrub** | Phase 4 (or Phase 2 if regulated industry) | FCC RND. $0.0023/query or ~$3.5k/mo unlimited. |
| **Litigator suppression list** | Phase 4 | Blacklist Alliance / TCPA Defense Force. ~$500–2000/mo. ~80% of TCPA suits are by known plaintiffs. |
| **Audit log immutability** | Phase 1 | S3 with object lock for `call_log`, `agent_log`, `dnc` changes. 4-year retention. |
| **Whisper-based call transcription** | Phase 4 | Per-call transcript searchable in admin. Cheap (~$0.006/min via OpenAI). Big QA value. |
| **Real-time wallboard / dashboard** (Grafana on Prometheus exporters) | Phase 3 | Supervisor needs a TV-mounted view of agent states + drop% gauge. |
| **PostgreSQL migration option** | Phase 4 (consider) | Vicidial chose MySQL by accident of history; Newfies-Dialer migrated *to* Postgres for performance. Not blocking — InnoDB 8 is fine — but evaluate if scale-out becomes painful. |
| **Multi-tenant from day 1** (cheap) or "v1 single-tenant, refactor later" (risky) | Decide before Phase 1 | Adding `tenant_id` everywhere later is expensive. Even if launching single-tenant, **add the column now** — leave it nullable / default 1. |

### 21.2 Nice-to-have (Phase 4+)

- **Voicemail drop detector** — uses AMD beep detection to precisely time the drop after the beep. Improves callback rates 2–8%.
- **Power dialer / preview mode** — agents can preview lead before dial, separate from predictive.
- **SMS integration** — Twilio/Telnyx SMS via same carrier. Opt-out keyword handling auto-feeds DNC.
- **Click-to-call browser extension** — Chrome extension that detects phone numbers on any web page and offers click-to-dial through the agent's logged-in session.
- **AI agent coach** — real-time transcription + LLM scoring of agent calls (compliance phrases, sentiment, objection handling). Hot product category right now.
- **Mobile supervisor app** — view agent grid, listen-only, push notifications for drop% spikes.
- **Custom IVR designer** (drag-drop) — admin tool that compiles to FS dialplan via mod_xml_curl.
- **Skills-based routing** — assign skills to agents (Spanish, technical, billing), in-group requires skill set, picker filters by match.
- **Custom dispositions per campaign + status-group overrides** — Vicidial parity.
- **Email + chat in agent screen** (omnichannel) — Vicidial does this; we don't have to but it's a competitive moat.

## 22. Updated recommended phasing

| Phase | Weeks | New scope | Cumulative agent ceiling |
|---|---|---|---|
| **1** — Manual MVP | 0–6 | Per original Phase 1 + channel janitor + audit log immutability + tenant_id columns | 25 |
| **2** — Auto-dialer | 6–12 | Per original Phase 2 + rtpengine + number pool + local presence | 50 |
| **3** — Inbound/blended | 12–18 | Per original Phase 3 + Grafana wallboard | 100 (single FS limit) |
| **3.5** — Multi-FS scale-out | 18–22 | Kamailio + campaign-to-FS affinity + Redis cluster | 500 |
| **4** — Integrations + premium compliance | 22–30 | CRMs + branded calling + RND + litigator lists + Whisper transcription | 500+ |
| **5** — Differentiators | 30+ | AI coach, custom IVR designer, omnichannel, mobile supervisor | unbounded |

## 23. Bottom-line answer

**Will this work great?** Yes — at MVP scale (≤50 agents), with high confidence. The pieces are mature and the design is clean.

**Will it scale?** Yes — but you'll need Kamailio + multi-FS + rtpengine starting around 100 agents. That's a known transition with a clear playbook.

**Will it match Vicidial feature-for-feature?** No, not in year 1. Vicidial has 19 years of accreted features. We aim for the ~80% of features that ~95% of users actually use.

**Is it worth building vs. just deploying Vicidial?** **Yes if** (a) you want a modern UX agents will actually like, (b) you want to integrate cleanly with modern stacks (CRMs, Slack, Whisper), (c) you want to sell SaaS at $80–120/agent/mo, or (d) you want to ship niche features (AI coaching, voice cloning, omnichannel). **No if** you just need a working dialer for an internal team — Vicidial works fine and is free.

**Biggest risks:** TCPA exposure (build audit trail correctly), WebRTC SRTP scaling (use rtpengine), AMD accuracy (don't roll your own), predictive math edge cases (mirror Vicidial closely).

**Suggested next step:** Build Phase 1 (4–6 weeks) as a working proof. Run real calls through it. The lessons from real-world testing will reshape Phases 2–3 more than any further design work will.

