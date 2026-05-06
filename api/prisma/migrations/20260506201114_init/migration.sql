-- CreateTable
CREATE TABLE `tenants` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(128) NOT NULL,
    `slug` VARCHAR(64) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `settings` JSON NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `tenants_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `username` VARCHAR(64) NOT NULL,
    `email` VARCHAR(128) NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `full_name` VARCHAR(128) NULL,
    `role` ENUM('agent', 'supervisor', 'admin', 'superadmin', 'integrator') NOT NULL,
    `user_group_id` BIGINT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `hotkeys_active` BOOLEAN NOT NULL DEFAULT true,
    `totp_required` BOOLEAN NOT NULL DEFAULT false,
    `last_login_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_users_t_group`(`tenant_id`, `user_group_id`),
    INDEX `idx_users_t_role_active`(`tenant_id`, `role`, `active`),
    UNIQUE INDEX `uk_users_tenant_username`(`tenant_id`, `username`),
    UNIQUE INDEX `uk_users_tenant_email`(`tenant_id`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_groups` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `name` VARCHAR(64) NOT NULL,
    `allowed_campaigns` JSON NOT NULL,
    `allowed_ingroups` JSON NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `uk_user_groups_tenant_name`(`tenant_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sip_credentials` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `user_id` BIGINT NOT NULL,
    `sip_username` VARCHAR(64) NOT NULL,
    `sip_password_ct` VARBINARY(512) NOT NULL,
    `kek_version` SMALLINT NOT NULL DEFAULT 1,
    `last_rotated_at` DATETIME(6) NULL,
    `revoked_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_sip_creds_t_user_kek`(`tenant_id`, `user_id`, `kek_version`),
    UNIQUE INDEX `uk_sip_creds_tenant_user`(`tenant_id`, `sip_username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `actor_user_id` BIGINT NULL,
    `actor_kind` ENUM('user', 'system', 'worker', 'external_api') NOT NULL DEFAULT 'user',
    `action` VARCHAR(64) NOT NULL,
    `entity_type` VARCHAR(32) NOT NULL,
    `entity_id` VARCHAR(64) NULL,
    `before_json` JSON NULL,
    `after_json` JSON NULL,
    `request_id` VARCHAR(64) NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(255) NULL,
    `ts` DATETIME(6) NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `idx_audit_t_actor_ts`(`tenant_id`, `actor_user_id`, `ts`),
    INDEX `idx_audit_t_entity_ts`(`tenant_id`, `entity_type`, `entity_id`, `ts`),
    INDEX `idx_audit_t_action_ts`(`tenant_id`, `action`, `ts`),
    PRIMARY KEY (`id`, `ts`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campaigns` (
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `dial_method` ENUM('MANUAL', 'RATIO', 'PROGRESSIVE', 'ADAPT_HARD', 'ADAPT_AVG', 'ADAPT_TAPERED') NOT NULL DEFAULT 'MANUAL',
    `auto_dial_level` DECIMAL(4, 2) NOT NULL DEFAULT 0.00,
    `adaptive_max_level` DECIMAL(4, 2) NOT NULL DEFAULT 3.00,
    `adaptive_drop_pct` DECIMAL(4, 2) NOT NULL DEFAULT 1.50,
    `dial_timeout_sec` SMALLINT NOT NULL DEFAULT 22,
    `wrapup_seconds` SMALLINT NOT NULL DEFAULT 10,
    `next_agent_call` ENUM('longest_wait', 'random', 'fewest_calls', 'rank') NOT NULL DEFAULT 'longest_wait',
    `available_only_tally` BOOLEAN NOT NULL DEFAULT false,
    `hopper_size_target` INTEGER NOT NULL DEFAULT 0,
    `hopper_multiplier` DECIMAL(3, 1) NOT NULL DEFAULT 2.0,
    `caller_id_carrier_id` BIGINT NULL,
    `caller_id_override` VARCHAR(16) NULL,
    `recording_mode` ENUM('NEVER', 'ONDEMAND', 'ALL', 'ALLFORCE') NOT NULL DEFAULT 'ALL',
    `amd_enabled` BOOLEAN NOT NULL DEFAULT false,
    `amd_action` ENUM('drop', 'vmdrop', 'agent') NOT NULL DEFAULT 'drop',
    `vmdrop_audio` VARCHAR(255) NULL,
    `safe_harbor_audio` VARCHAR(255) NULL,
    `script_id` BIGINT NULL,
    `webform_url` VARCHAR(512) NULL,
    `dial_status_filter` JSON NOT NULL,
    `call_time_id` BIGINT NULL,
    `use_internal_dnc` BOOLEAN NOT NULL DEFAULT true,
    `use_federal_dnc` BOOLEAN NOT NULL DEFAULT true,
    `use_state_dnc` BOOLEAN NOT NULL DEFAULT true,
    `pause_codes_required` ENUM('OFF', 'OPTIONAL', 'FORCE') NOT NULL DEFAULT 'OPTIONAL',
    `hot_keys_active` BOOLEAN NOT NULL DEFAULT true,
    `closer_ingroups` JSON NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_campaigns_t_active_method`(`tenant_id`, `active`, `dial_method`),
    PRIMARY KEY (`tenant_id`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lists` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `name` VARCHAR(128) NOT NULL,
    `description` TEXT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `reset_time` TIME(0) NULL,
    `expiration` DATE NULL,
    `source` VARCHAR(64) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_lists_t_active`(`tenant_id`, `active`),
    UNIQUE INDEX `uk_lists_tenant_name`(`tenant_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campaign_lists` (
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `campaign_id` VARCHAR(32) NOT NULL,
    `list_id` BIGINT NOT NULL,
    `priority` SMALLINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `idx_camp_lists_t_list`(`tenant_id`, `list_id`),
    PRIMARY KEY (`tenant_id`, `campaign_id`, `list_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `statuses` (
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `campaign_id` VARCHAR(32) NOT NULL,
    `status` VARCHAR(8) NOT NULL,
    `description` VARCHAR(128) NOT NULL DEFAULT '',
    `selectable` BOOLEAN NOT NULL DEFAULT true,
    `human_answered` BOOLEAN NOT NULL DEFAULT false,
    `sale` BOOLEAN NOT NULL DEFAULT false,
    `dnc` BOOLEAN NOT NULL DEFAULT false,
    `callback` BOOLEAN NOT NULL DEFAULT false,
    `not_interested` BOOLEAN NOT NULL DEFAULT false,
    `hotkey` CHAR(1) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    PRIMARY KEY (`tenant_id`, `campaign_id`, `status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pause_codes` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `campaign_id` VARCHAR(32) NULL,
    `code` VARCHAR(16) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `billable` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_pause_codes_t_camp_code`(`tenant_id`, `campaign_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `scripts` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `name` VARCHAR(64) NOT NULL,
    `body` MEDIUMTEXT NOT NULL,
    `campaign_id` VARCHAR(32) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_scripts_t_camp`(`tenant_id`, `campaign_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `call_times` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `name` VARCHAR(64) NOT NULL,
    `default_start` TIME(0) NOT NULL DEFAULT '09:00:00',
    `default_end` TIME(0) NOT NULL DEFAULT '21:00:00',
    `state_overrides` JSON NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `uk_call_times_tenant_name`(`tenant_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leads` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `list_id` BIGINT NOT NULL,
    `status` VARCHAR(8) NOT NULL DEFAULT 'NEW',
    `vendor_lead_code` VARCHAR(64) NULL,
    `source_id` VARCHAR(64) NULL,
    `phone_e164` VARCHAR(16) NOT NULL,
    `phone_alt` VARCHAR(16) NULL,
    `phone_alt2` VARCHAR(16) NULL,
    `country_code` CHAR(2) NOT NULL DEFAULT 'US',
    `title` VARCHAR(8) NULL,
    `first_name` VARCHAR(64) NULL,
    `middle_initial` VARCHAR(4) NULL,
    `last_name` VARCHAR(64) NULL,
    `address1` VARCHAR(128) NULL,
    `address2` VARCHAR(128) NULL,
    `city` VARCHAR(64) NULL,
    `state` CHAR(2) NULL,
    `postal_code` VARCHAR(16) NULL,
    `email` VARCHAR(128) NULL,
    `date_of_birth` DATE NULL,
    `gender` ENUM('M', 'F', 'U') NOT NULL DEFAULT 'U',
    `comments` TEXT NULL,
    `rank` INTEGER NOT NULL DEFAULT 0,
    `owner_user_id` BIGINT NULL,
    `custom_data` JSON NOT NULL,
    `called_count` INTEGER NOT NULL DEFAULT 0,
    `last_called_at` DATETIME(6) NULL,
    `last_local_call_time` TIME(0) NULL,
    `tz_offset_min` SMALLINT NULL,
    `known_timezone` VARCHAR(40) NULL,
    `deleted_at` DATETIME(6) NULL,
    `entry_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `modify_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_leads_t_list_status_modify`(`tenant_id`, `list_id`, `status`, `modify_at`),
    INDEX `idx_leads_t_phone`(`tenant_id`, `phone_e164`),
    INDEX `idx_leads_t_status_modify`(`tenant_id`, `status`, `modify_at`),
    INDEX `idx_leads_t_owner_status`(`tenant_id`, `owner_user_id`, `status`),
    INDEX `idx_leads_t_called_count`(`tenant_id`, `called_count`),
    INDEX `idx_leads_t_state`(`tenant_id`, `state`),
    INDEX `idx_leads_t_postal`(`tenant_id`, `postal_code`),
    INDEX `idx_leads_t_vendor`(`tenant_id`, `vendor_lead_code`),
    INDEX `idx_leads_t_deleted`(`tenant_id`, `deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dnc` (
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `phone_e164` VARCHAR(16) NOT NULL,
    `source` ENUM('federal', 'state', 'internal', 'litigator', 'reassigned') NOT NULL,
    `state` CHAR(2) NOT NULL DEFAULT '__',
    `campaign_id` VARCHAR(32) NOT NULL DEFAULT '__GLOBAL__',
    `added_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `added_by` BIGINT NULL,
    `expires_at` DATETIME(6) NULL,
    `notes` VARCHAR(255) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_dnc_phone_only`(`phone_e164`),
    INDEX `idx_dnc_t_source_added`(`tenant_id`, `source`, `added_at`),
    PRIMARY KEY (`tenant_id`, `phone_e164`, `source`, `state`, `campaign_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `phone_codes` (
    `area_code` CHAR(3) NOT NULL,
    `exchange_code` CHAR(3) NOT NULL,
    `state` CHAR(2) NULL,
    `county` VARCHAR(64) NULL,
    `tz_iana` VARCHAR(40) NOT NULL,
    `confidence` ENUM('NPA', 'NXX') NOT NULL DEFAULT 'NXX',
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_phone_codes_state`(`state`),
    INDEX `idx_phone_codes_tz`(`tz_iana`),
    PRIMARY KEY (`area_code`, `exchange_code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `phone_codes_overrides` (
    `area_code` CHAR(3) NOT NULL,
    `exchange_code` CHAR(3) NOT NULL,
    `state` CHAR(2) NULL,
    `county` VARCHAR(64) NULL,
    `tz_iana` VARCHAR(40) NOT NULL,
    `confidence` ENUM('NPA', 'NXX') NOT NULL DEFAULT 'NXX',
    `reason` VARCHAR(255) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `created_by_user_id` BIGINT NULL,

    INDEX `idx_phone_overrides_state`(`state`),
    PRIMARY KEY (`area_code`, `exchange_code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `zip_codes` (
    `zip` CHAR(5) NOT NULL,
    `tz_iana` VARCHAR(40) NOT NULL,
    `state` CHAR(2) NULL,
    `confidence` ENUM('ZIP') NOT NULL DEFAULT 'ZIP',

    INDEX `idx_zip_codes_state`(`state`),
    INDEX `idx_zip_codes_tz`(`tz_iana`),
    PRIMARY KEY (`zip`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `callbacks` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `lead_id` BIGINT NOT NULL,
    `campaign_id` VARCHAR(32) NOT NULL,
    `user_id` BIGINT NULL,
    `callback_at` DATETIME(6) NOT NULL,
    `comments` TEXT NULL,
    `status` ENUM('LIVE', 'PENDING', 'DONE', 'DEAD') NOT NULL DEFAULT 'PENDING',
    `created_by` BIGINT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_callbacks_t_status_due`(`tenant_id`, `status`, `callback_at`),
    INDEX `idx_callbacks_t_user_due`(`tenant_id`, `user_id`, `callback_at`),
    INDEX `idx_callbacks_t_lead`(`tenant_id`, `lead_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `hopper_mirror` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `campaign_id` VARCHAR(32) NOT NULL,
    `lead_id` BIGINT NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `scheduled_at` DATETIME(6) NOT NULL,
    `claimed_by` VARCHAR(64) NULL,
    `claimed_until` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_hopper_t_camp_scheduled`(`tenant_id`, `campaign_id`, `scheduled_at`),
    UNIQUE INDEX `uk_hopper_t_camp_lead`(`tenant_id`, `campaign_id`, `lead_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recordings` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `recording_log_id` BIGINT NOT NULL,
    `share_token` BINARY(16) NULL,
    `share_token_expires_at` DATETIME(6) NULL,
    `legal_hold` BOOLEAN NOT NULL DEFAULT false,
    `lifecycle_state` ENUM('encoding', 'available', 'archived', 'deleted') NOT NULL DEFAULT 'encoding',
    `s3_storage_class` VARCHAR(32) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `uk_recordings_share_token`(`share_token`),
    INDEX `idx_recordings_t_lifecycle`(`tenant_id`, `lifecycle_state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dispositions` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `call_log_id` BIGINT NOT NULL,
    `lead_id` BIGINT NOT NULL,
    `campaign_id` VARCHAR(32) NOT NULL,
    `user_id` BIGINT NULL,
    `status_code` VARCHAR(8) NOT NULL,
    `comments` TEXT NULL,
    `disposed_at` DATETIME(6) NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_disp_t_lead_disposed`(`tenant_id`, `lead_id`, `disposed_at`),
    INDEX `idx_disp_t_camp_disposed`(`tenant_id`, `campaign_id`, `disposed_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `carriers` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `name` VARCHAR(64) NOT NULL,
    `kind` ENUM('twilio', 'telnyx', 'signalwire', 'ringcentral', 'byoc') NOT NULL,
    `proxy` VARCHAR(255) NOT NULL,
    `username_ct` VARBINARY(512) NULL,
    `password_ct` VARBINARY(512) NULL,
    `kek_version` SMALLINT NOT NULL DEFAULT 1,
    `register` BOOLEAN NOT NULL DEFAULT false,
    `caller_id_e164` VARCHAR(16) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `ip_allowlist` JSON NOT NULL,
    `config_json` JSON NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_carriers_t_active`(`tenant_id`, `active`),
    UNIQUE INDEX `uk_carriers_tenant_name`(`tenant_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gateways` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `carrier_id` BIGINT NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `proxy` VARCHAR(255) NOT NULL,
    `realm` VARCHAR(255) NULL,
    `from_user` VARCHAR(64) NULL,
    `from_domain` VARCHAR(255) NULL,
    `extension` VARCHAR(64) NULL,
    `register` BOOLEAN NOT NULL DEFAULT false,
    `expire_seconds` INTEGER NOT NULL DEFAULT 3600,
    `retry_seconds` INTEGER NOT NULL DEFAULT 30,
    `transport` ENUM('udp', 'tcp', 'tls') NOT NULL DEFAULT 'udp',
    `priority` SMALLINT NOT NULL DEFAULT 100,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `template_overrides` JSON NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_gateways_t_carrier_active_pri`(`tenant_id`, `carrier_id`, `active`, `priority`),
    UNIQUE INDEX `uk_gateways_tenant_name`(`tenant_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `did_numbers` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `e164` VARCHAR(16) NOT NULL,
    `carrier_id` BIGINT NOT NULL,
    `route_kind` ENUM('ingroup', 'ivr', 'agent', 'ext', 'voicemail') NOT NULL,
    `route_target` VARCHAR(64) NOT NULL,
    `caller_id_name` VARCHAR(64) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_dids_t_carrier`(`tenant_id`, `carrier_id`),
    INDEX `idx_dids_t_route`(`tenant_id`, `route_kind`, `route_target`),
    UNIQUE INDEX `uk_dids_tenant_e164`(`tenant_id`, `e164`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ingroups` (
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `music_on_hold` VARCHAR(128) NOT NULL DEFAULT 'default',
    `max_queue` INTEGER NOT NULL DEFAULT 100,
    `agent_wait_sec` INTEGER NOT NULL DEFAULT 60,
    `ring_strategy` ENUM('ring_all', 'longest_idle_agent', 'round_robin', 'top_down', 'agent_with_least_talk_time') NOT NULL DEFAULT 'longest_idle_agent',
    `priority` INTEGER NOT NULL DEFAULT 50,
    `closer_only` BOOLEAN NOT NULL DEFAULT false,
    `recording_mode` ENUM('NEVER', 'ALL') NOT NULL DEFAULT 'ALL',
    `no_agent_action` ENUM('voicemail', 'hangup', 'overflow_ingroup') NOT NULL DEFAULT 'voicemail',
    `no_agent_target` VARCHAR(64) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    PRIMARY KEY (`tenant_id`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ingroup_agents` (
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `ingroup_id` VARCHAR(32) NOT NULL,
    `user_id` BIGINT NOT NULL,
    `rank` INTEGER NOT NULL DEFAULT 5,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_ingroup_agents_t_user`(`tenant_id`, `user_id`),
    PRIMARY KEY (`tenant_id`, `ingroup_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ivr_trees` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `name` VARCHAR(64) NOT NULL,
    `description` TEXT NULL,
    `tree_json` JSON NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `uk_ivr_trees_tenant_name`(`tenant_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `call_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `uuid` VARCHAR(40) NOT NULL,
    `parent_uuid` VARCHAR(40) NULL,
    `lead_id` BIGINT NULL,
    `campaign_id` VARCHAR(32) NULL,
    `list_id` BIGINT NULL,
    `user_id` BIGINT NULL,
    `direction` ENUM('out', 'in') NOT NULL,
    `phone_e164` VARCHAR(16) NOT NULL,
    `caller_id` VARCHAR(16) NULL,
    `carrier_id` BIGINT NULL,
    `gateway_id` BIGINT NULL,
    `call_started` DATETIME(6) NOT NULL,
    `call_answered` DATETIME(6) NULL,
    `call_ended` DATETIME(6) NULL,
    `ring_seconds` INTEGER NULL,
    `talk_seconds` INTEGER NULL,
    `hold_seconds` INTEGER NULL,
    `wrap_seconds` INTEGER NULL,
    `status` VARCHAR(8) NULL,
    `hangup_cause` VARCHAR(32) NULL,
    `amd_result` ENUM('none', 'machine', 'human', 'unknown') NOT NULL DEFAULT 'none',
    `is_drop` BOOLEAN NOT NULL DEFAULT false,
    `recording_id` BIGINT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `idx_call_log_t_camp_started`(`tenant_id`, `campaign_id`, `call_started`),
    INDEX `idx_call_log_t_lead_started`(`tenant_id`, `lead_id`, `call_started`),
    INDEX `idx_call_log_t_user_started`(`tenant_id`, `user_id`, `call_started`),
    INDEX `idx_call_log_t_phone_started`(`tenant_id`, `phone_e164`, `call_started`),
    INDEX `idx_call_log_t_status_started`(`tenant_id`, `status`, `call_started`),
    INDEX `idx_call_log_t_carrier_started`(`tenant_id`, `carrier_id`, `call_started`),
    UNIQUE INDEX `uk_call_log_uuid`(`uuid`, `call_started`),
    PRIMARY KEY (`id`, `call_started`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `user_id` BIGINT NOT NULL,
    `campaign_id` VARCHAR(32) NULL,
    `call_log_id` BIGINT NULL,
    `event_at` DATETIME(6) NOT NULL,
    `event` ENUM('login', 'logout', 'pause', 'unpause', 'ready', 'call_start', 'call_end', 'dispo', 'transfer', 'hold', 'retrieve') NOT NULL,
    `pause_code` VARCHAR(16) NULL,
    `duration_sec` INTEGER NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `idx_agent_log_t_user_event`(`tenant_id`, `user_id`, `event_at`),
    INDEX `idx_agent_log_t_camp_event`(`tenant_id`, `campaign_id`, `event_at`),
    INDEX `idx_agent_log_t_call`(`tenant_id`, `call_log_id`),
    PRIMARY KEY (`id`, `event_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recording_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `uuid` VARCHAR(40) NOT NULL,
    `call_log_id` BIGINT NULL,
    `lead_id` BIGINT NULL,
    `campaign_id` VARCHAR(32) NULL,
    `user_id` BIGINT NULL,
    `filename` VARCHAR(255) NOT NULL,
    `storage_url` VARCHAR(512) NULL,
    `start_time` DATETIME(6) NOT NULL,
    `duration_sec` INTEGER NULL,
    `size_bytes` BIGINT NULL,
    `encoded_at` DATETIME(6) NULL,
    `consent_status` ENUM('not_required', 'prompted_accepted', 'prompted_declined', 'assumed') NOT NULL DEFAULT 'not_required',
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `idx_recording_log_t_lead_started`(`tenant_id`, `lead_id`, `start_time`),
    INDEX `idx_recording_log_t_camp_started`(`tenant_id`, `campaign_id`, `start_time`),
    INDEX `idx_recording_log_t_call`(`tenant_id`, `call_log_id`),
    INDEX `idx_recording_log_t_user_started`(`tenant_id`, `user_id`, `start_time`),
    UNIQUE INDEX `uk_recording_log_uuid`(`uuid`, `start_time`),
    PRIMARY KEY (`id`, `start_time`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `drop_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `call_log_id` BIGINT NULL,
    `campaign_id` VARCHAR(32) NOT NULL,
    `phone_e164` VARCHAR(16) NOT NULL,
    `dropped_at` DATETIME(6) NOT NULL,
    `drop_reason` ENUM('no_agent', 'timeout', 'queue_full') NOT NULL,
    `safe_harbor_played` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `idx_drop_log_t_camp_dropped`(`tenant_id`, `campaign_id`, `dropped_at`),
    INDEX `idx_drop_log_t_call`(`tenant_id`, `call_log_id`),
    PRIMARY KEY (`id`, `dropped_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settings` (
    `tenant_id` BIGINT NOT NULL DEFAULT 1,
    `k` VARCHAR(64) NOT NULL,
    `v` JSON NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    PRIMARY KEY (`tenant_id`, `k`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_config` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `totp_grace_period_days` INTEGER NOT NULL DEFAULT 7,
    `password_min_length` INTEGER NOT NULL DEFAULT 12,
    `refresh_token_ttl_seconds` INTEGER NOT NULL DEFAULT 2592000,
    `access_token_ttl_seconds` INTEGER NOT NULL DEFAULT 900,
    `lockout_after_failures` INTEGER NOT NULL DEFAULT 5,
    `lockout_window_seconds` INTEGER NOT NULL DEFAULT 900,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `fk_users_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `fk_users_user_group` FOREIGN KEY (`user_group_id`) REFERENCES `user_groups`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `user_groups` ADD CONSTRAINT `fk_user_groups_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `sip_credentials` ADD CONSTRAINT `fk_sip_creds_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `sip_credentials` ADD CONSTRAINT `fk_sip_creds_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `campaigns` ADD CONSTRAINT `fk_campaigns_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `campaigns` ADD CONSTRAINT `fk_campaigns_caller_carrier` FOREIGN KEY (`caller_id_carrier_id`) REFERENCES `carriers`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `campaigns` ADD CONSTRAINT `fk_campaigns_script` FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `campaigns` ADD CONSTRAINT `fk_campaigns_calltime` FOREIGN KEY (`call_time_id`) REFERENCES `call_times`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `lists` ADD CONSTRAINT `fk_lists_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `campaign_lists` ADD CONSTRAINT `fk_camp_lists_campaign` FOREIGN KEY (`tenant_id`, `campaign_id`) REFERENCES `campaigns`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `campaign_lists` ADD CONSTRAINT `fk_camp_lists_list` FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `statuses` ADD CONSTRAINT `fk_statuses_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `pause_codes` ADD CONSTRAINT `fk_pause_codes_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `pause_codes` ADD CONSTRAINT `fk_pause_codes_campaign` FOREIGN KEY (`tenant_id`, `campaign_id`) REFERENCES `campaigns`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `scripts` ADD CONSTRAINT `fk_scripts_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `scripts` ADD CONSTRAINT `fk_scripts_campaign` FOREIGN KEY (`tenant_id`, `campaign_id`) REFERENCES `campaigns`(`tenant_id`, `id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `call_times` ADD CONSTRAINT `fk_call_times_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `leads` ADD CONSTRAINT `fk_leads_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `leads` ADD CONSTRAINT `fk_leads_list` FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `leads` ADD CONSTRAINT `fk_leads_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `dnc` ADD CONSTRAINT `fk_dnc_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `callbacks` ADD CONSTRAINT `fk_callbacks_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `callbacks` ADD CONSTRAINT `fk_callbacks_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `callbacks` ADD CONSTRAINT `fk_callbacks_campaign` FOREIGN KEY (`tenant_id`, `campaign_id`) REFERENCES `campaigns`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `callbacks` ADD CONSTRAINT `fk_callbacks_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `callbacks` ADD CONSTRAINT `fk_callbacks_creator` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `hopper_mirror` ADD CONSTRAINT `fk_hopper_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `hopper_mirror` ADD CONSTRAINT `fk_hopper_campaign` FOREIGN KEY (`tenant_id`, `campaign_id`) REFERENCES `campaigns`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `hopper_mirror` ADD CONSTRAINT `fk_hopper_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `recordings` ADD CONSTRAINT `fk_recordings_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `dispositions` ADD CONSTRAINT `fk_disp_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `dispositions` ADD CONSTRAINT `fk_disp_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `dispositions` ADD CONSTRAINT `fk_disp_campaign` FOREIGN KEY (`tenant_id`, `campaign_id`) REFERENCES `campaigns`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `dispositions` ADD CONSTRAINT `fk_disp_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `carriers` ADD CONSTRAINT `fk_carriers_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `gateways` ADD CONSTRAINT `fk_gateways_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `gateways` ADD CONSTRAINT `fk_gateways_carrier` FOREIGN KEY (`carrier_id`) REFERENCES `carriers`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `did_numbers` ADD CONSTRAINT `fk_dids_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `did_numbers` ADD CONSTRAINT `fk_dids_carrier` FOREIGN KEY (`carrier_id`) REFERENCES `carriers`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `ingroups` ADD CONSTRAINT `fk_ingroups_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `ingroup_agents` ADD CONSTRAINT `fk_ingroup_agents_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `ingroup_agents` ADD CONSTRAINT `fk_ingroup_agents_ingroup` FOREIGN KEY (`tenant_id`, `ingroup_id`) REFERENCES `ingroups`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `ingroup_agents` ADD CONSTRAINT `fk_ingroup_agents_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `ivr_trees` ADD CONSTRAINT `fk_ivr_trees_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `settings` ADD CONSTRAINT `fk_settings_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;
