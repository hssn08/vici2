-- =============================================================================
-- C03 — hash_triggers
-- BEFORE INSERT triggers on all five immutable audit tables.
--
-- Each trigger:
--   1. Reads the prior row's row_hash under SELECT … FOR UPDATE (same tenant)
--      to serialize concurrent inserts within a chain.
--   2. Sets prev_hash (or the 64-zero sentinel for the first row).
--   3. Sets hash_at = NOW(6).
--   4. Computes row_hash = SHA2(CONCAT_WS(CHAR(31), …), 256)
--
-- CHAR(31) = ASCII Unit Separator 0x1F (not present in VARCHAR/JSON fields;
-- enforced by the TS Zod schema on the writer).
--
-- NULL fields: serialised as the two-char literal string '\N' (MySQL LOAD DATA
-- convention). This distinguishes NULL from ''.
--
-- Timestamps: DATE_FORMAT(col, '%Y-%m-%dT%H:%i:%s.%fZ') — always UTC because
-- the server runs default_time_zone='+00:00'.
--
-- id IS in the hash so row deletion is detectable (a deleted row creates a
-- prev_hash mismatch on the next row). MySQL BEFORE INSERT fires with NEW.id
-- already populated for AUTO_INCREMENT (confirmed MySQL 8.0.40 behaviour;
-- pinned in F02 §2).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. audit_log
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `audit_log_hash_chain`;
DELIMITER //
CREATE TRIGGER `audit_log_hash_chain`
BEFORE INSERT ON `audit_log`
FOR EACH ROW
BEGIN
    DECLARE prior_hash CHAR(64);
    SELECT row_hash
      INTO prior_hash
      FROM `audit_log`
     WHERE tenant_id = NEW.tenant_id
     ORDER BY id DESC
     LIMIT 1
     FOR UPDATE;
    IF prior_hash IS NULL OR prior_hash = '' THEN
        SET prior_hash = REPEAT('0', 64);
    END IF;
    SET NEW.prev_hash = prior_hash;
    SET NEW.hash_at   = COALESCE(NEW.ts, NOW(6));
    SET NEW.row_hash  = SHA2(CONCAT_WS(CHAR(31),
        NEW.prev_hash,
        LPAD(CAST(NEW.tenant_id AS CHAR), 20, '0'),
        'audit_log',
        LPAD(CAST(NEW.id AS CHAR), 20, '0'),
        DATE_FORMAT(NEW.ts, '%Y-%m-%dT%H:%i:%s.%fZ'),
        COALESCE(CAST(NEW.actor_user_id AS CHAR), '\\N'),
        NEW.actor_kind,
        NEW.action,
        NEW.entity_type,
        COALESCE(NEW.entity_id, '\\N'),
        COALESCE(JSON_EXTRACT(NEW.before_json, '$'), '\\N'),
        COALESCE(JSON_EXTRACT(NEW.after_json,  '$'), '\\N'),
        COALESCE(NEW.request_id, '\\N'),
        COALESCE(NEW.ip_address, '\\N'),
        COALESCE(NEW.user_agent, '\\N')
    ), 256);
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- 2. call_window_audit
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `call_window_audit_hash_chain`;
DELIMITER //
CREATE TRIGGER `call_window_audit_hash_chain`
BEFORE INSERT ON `call_window_audit`
FOR EACH ROW
BEGIN
    DECLARE prior_hash CHAR(64);
    SELECT row_hash
      INTO prior_hash
      FROM `call_window_audit`
     WHERE tenant_id = NEW.tenant_id
     ORDER BY id DESC
     LIMIT 1
     FOR UPDATE;
    IF prior_hash IS NULL OR prior_hash = '' THEN
        SET prior_hash = REPEAT('0', 64);
    END IF;
    SET NEW.prev_hash = prior_hash;
    SET NEW.hash_at   = COALESCE(NEW.created_at, NOW(6));
    SET NEW.row_hash  = SHA2(CONCAT_WS(CHAR(31),
        NEW.prev_hash,
        LPAD(CAST(NEW.tenant_id AS CHAR), 20, '0'),
        'call_window_audit',
        LPAD(CAST(NEW.id AS CHAR), 20, '0'),
        DATE_FORMAT(NEW.created_at, '%Y-%m-%dT%H:%i:%s.%fZ'),
        CAST(NEW.lead_id AS CHAR),
        NEW.phone_e164,
        NEW.campaign_id,
        NEW.decision,
        NEW.reason,
        COALESCE(NEW.tz_iana, '\\N'),
        COALESCE(NEW.tz_confidence, '\\N'),
        COALESCE(NEW.state_code, '\\N'),
        COALESCE(NEW.zip, '\\N'),
        COALESCE(DATE_FORMAT(NEW.party_local, '%Y-%m-%dT%H:%i:%s.%fZ'), '\\N'),
        COALESCE(CAST(NEW.party_dow AS CHAR), '\\N'),
        COALESCE(CAST(NEW.effective_open_min AS CHAR), '\\N'),
        COALESCE(CAST(NEW.effective_close_min AS CHAR), '\\N'),
        COALESCE(NEW.rule_applied, '\\N'),
        NEW.enforcement_point,
        COALESCE(DATE_FORMAT(NEW.next_open_at, '%Y-%m-%dT%H:%i:%s.%fZ'), '\\N'),
        COALESCE(NEW.call_uuid, '\\N')
    ), 256);
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- 3. originate_audit
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `originate_audit_hash_chain`;
DELIMITER //
CREATE TRIGGER `originate_audit_hash_chain`
BEFORE INSERT ON `originate_audit`
FOR EACH ROW
BEGIN
    DECLARE prior_hash CHAR(64);
    SELECT row_hash
      INTO prior_hash
      FROM `originate_audit`
     WHERE tenant_id = NEW.tenant_id
     ORDER BY id DESC
     LIMIT 1
     FOR UPDATE;
    IF prior_hash IS NULL OR prior_hash = '' THEN
        SET prior_hash = REPEAT('0', 64);
    END IF;
    SET NEW.prev_hash = prior_hash;
    SET NEW.hash_at   = COALESCE(NEW.originated_at, NOW(6));
    SET NEW.row_hash  = SHA2(CONCAT_WS(CHAR(31),
        NEW.prev_hash,
        LPAD(CAST(NEW.tenant_id AS CHAR), 20, '0'),
        'originate_audit',
        LPAD(CAST(NEW.id AS CHAR), 20, '0'),
        DATE_FORMAT(NEW.originated_at, '%Y-%m-%dT%H:%i:%s.%fZ'),
        CAST(NEW.lead_id AS CHAR),
        NEW.phone_e164,
        COALESCE(NEW.campaign_id, '\\N'),
        NEW.outcome,
        COALESCE(NEW.tcpa_reason, '\\N'),
        COALESCE(NEW.dnc_decision, '\\N'),
        COALESCE(JSON_EXTRACT(NEW.dnc_sources, '$'), '\\N'),
        COALESCE(NEW.tcpa_decision, '\\N'),
        COALESCE(NEW.call_uuid, '\\N'),
        COALESCE(JSON_EXTRACT(NEW.dnc_sources, '$'), '\\N')
    ), 256);
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- 4. consent_log
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `consent_log_hash_chain`;
DELIMITER //
CREATE TRIGGER `consent_log_hash_chain`
BEFORE INSERT ON `consent_log`
FOR EACH ROW
BEGIN
    DECLARE prior_hash CHAR(64);
    SELECT row_hash
      INTO prior_hash
      FROM `consent_log`
     WHERE tenant_id = NEW.tenant_id
     ORDER BY id DESC
     LIMIT 1
     FOR UPDATE;
    IF prior_hash IS NULL OR prior_hash = '' THEN
        SET prior_hash = REPEAT('0', 64);
    END IF;
    SET NEW.prev_hash = prior_hash;
    SET NEW.hash_at   = COALESCE(NEW.created_at, NOW(6));
    SET NEW.row_hash  = SHA2(CONCAT_WS(CHAR(31),
        NEW.prev_hash,
        LPAD(CAST(NEW.tenant_id AS CHAR), 20, '0'),
        'consent_log',
        LPAD(CAST(NEW.id AS CHAR), 20, '0'),
        NEW.call_uuid,
        CAST(NEW.lead_id AS CHAR),
        NEW.phone_e164,
        NEW.prompt_id,
        COALESCE(NEW.dtmf_response, '\\N'),
        NEW.outcome,
        NEW.language,
        DATE_FORMAT(NEW.prompt_played_at, '%Y-%m-%dT%H:%i:%s.%fZ')
    ), 256);
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- 5. dnc_sync_log
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `dnc_sync_log_hash_chain`;
DELIMITER //
CREATE TRIGGER `dnc_sync_log_hash_chain`
BEFORE INSERT ON `dnc_sync_log`
FOR EACH ROW
BEGIN
    DECLARE prior_hash CHAR(64);
    -- dnc_sync_log has no tenant_id column (global table); chain is global
    SELECT row_hash
      INTO prior_hash
      FROM `dnc_sync_log`
     ORDER BY id DESC
     LIMIT 1
     FOR UPDATE;
    IF prior_hash IS NULL OR prior_hash = '' THEN
        SET prior_hash = REPEAT('0', 64);
    END IF;
    SET NEW.prev_hash = prior_hash;
    SET NEW.hash_at   = COALESCE(NEW.started_at, NOW(6));
    SET NEW.row_hash  = SHA2(CONCAT_WS(CHAR(31),
        NEW.prev_hash,
        LPAD(CAST(1 AS CHAR), 20, '0'),
        'dnc_sync_log',
        LPAD(CAST(NEW.id AS CHAR), 20, '0'),
        NEW.source,
        NEW.kind,
        COALESCE(NEW.file_hash, '\\N'),
        CAST(NEW.added AS CHAR),
        CAST(NEW.removed AS CHAR),
        DATE_FORMAT(NEW.started_at, '%Y-%m-%dT%H:%i:%s.%fZ'),
        COALESCE(DATE_FORMAT(NEW.completed_at, '%Y-%m-%dT%H:%i:%s.%fZ'), '\\N')
    ), 256);
END //
DELIMITER ;
