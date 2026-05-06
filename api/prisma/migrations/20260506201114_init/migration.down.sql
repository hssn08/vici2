-- Down migration for 20260506201114_init (dev/test only).
-- Drops every table created in the init forward migration.
-- Order matters: tables with FKs are dropped before their parents.

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `auth_config`;
DROP TABLE IF EXISTS `settings`;
DROP TABLE IF EXISTS `drop_log`;
DROP TABLE IF EXISTS `recording_log`;
DROP TABLE IF EXISTS `agent_log`;
DROP TABLE IF EXISTS `call_log`;
DROP TABLE IF EXISTS `ivr_trees`;
DROP TABLE IF EXISTS `ingroup_agents`;
DROP TABLE IF EXISTS `ingroups`;
DROP TABLE IF EXISTS `did_numbers`;
DROP TABLE IF EXISTS `gateways`;
DROP TABLE IF EXISTS `carriers`;
DROP TABLE IF EXISTS `dispositions`;
DROP TABLE IF EXISTS `recordings`;
DROP TABLE IF EXISTS `hopper_mirror`;
DROP TABLE IF EXISTS `callbacks`;
DROP TABLE IF EXISTS `zip_codes`;
DROP TABLE IF EXISTS `phone_codes_overrides`;
DROP TABLE IF EXISTS `phone_codes`;
DROP TABLE IF EXISTS `dnc`;
DROP TABLE IF EXISTS `leads`;
DROP TABLE IF EXISTS `call_times`;
DROP TABLE IF EXISTS `scripts`;
DROP TABLE IF EXISTS `pause_codes`;
DROP TABLE IF EXISTS `statuses`;
DROP TABLE IF EXISTS `campaign_lists`;
DROP TABLE IF EXISTS `lists`;
DROP TABLE IF EXISTS `campaigns`;
DROP TABLE IF EXISTS `audit_log`;
DROP TABLE IF EXISTS `sip_credentials`;
DROP TABLE IF EXISTS `user_groups`;
DROP TABLE IF EXISTS `users`;
DROP TABLE IF EXISTS `tenants`;

SET FOREIGN_KEY_CHECKS = 1;
