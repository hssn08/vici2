-- N01 — Notifications Hub
-- Creates notifications and notification_prefs tables.
-- Additive only; no DROP.

-- Enums (MySQL treats ENUMs inline with column definitions)

CREATE TABLE `notifications` (
  `id`        BIGINT       NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT       NOT NULL DEFAULT 1,
  `user_id`   BIGINT       NOT NULL,
  `channel`   ENUM('in_app','email') NOT NULL,
  `category`  VARCHAR(64)  NOT NULL,
  `subject`   VARCHAR(255) NOT NULL,
  `body`      TEXT         NOT NULL,
  `severity`  ENUM('info','warning','error') NOT NULL DEFAULT 'info',
  `link`      VARCHAR(512) NULL,
  `read_at`   DATETIME(6)  NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  INDEX `idx_notif_t_user_read`   (`tenant_id`, `user_id`, `read_at`, `created_at`),
  INDEX `idx_notif_t_user_unread` (`tenant_id`, `user_id`, `created_at`),

  CONSTRAINT `fk_notifications_tenant`
    FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
    ON DELETE CASCADE ON UPDATE NO ACTION,

  CONSTRAINT `fk_notifications_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON DELETE CASCADE ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `notification_prefs` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT,
  `tenant_id`  BIGINT       NOT NULL DEFAULT 1,
  `user_id`    BIGINT       NOT NULL,
  `category`   VARCHAR(64)  NOT NULL,
  `channels`   JSON         NOT NULL,
  `created_at` DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_notif_prefs_t_user_cat` (`tenant_id`, `user_id`, `category`),

  CONSTRAINT `fk_notif_prefs_tenant`
    FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
    ON DELETE CASCADE ON UPDATE NO ACTION,

  CONSTRAINT `fk_notif_prefs_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON DELETE CASCADE ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
