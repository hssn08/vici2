-- Down migration for 20260506201800_pause_codes_unique.
DROP INDEX `uk_pause_codes_t_camp_code` ON `pause_codes`;
