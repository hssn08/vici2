-- X03: Multi-FS Campaign Affinity
-- Migration: 20260513330000_x03_multi_fs
-- Direction: UP

CREATE TABLE fs_nodes (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id      INT UNSIGNED NOT NULL,
  name           VARCHAR(64)  NOT NULL,
  host           VARCHAR(128) NOT NULL,
  esl_host       VARCHAR(128) NOT NULL,
  esl_port       SMALLINT UNSIGNED NOT NULL DEFAULT 8021,
  esl_password   VARCHAR(255) NOT NULL,
  weight         SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  status         ENUM('ACTIVE','DRAINING','UNHEALTHY','OFFLINE') NOT NULL DEFAULT 'ACTIVE',
  last_heartbeat DATETIME(3) NULL,
  metadata       JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                 ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_tenant_status (tenant_id, status),
  INDEX idx_status_heartbeat (status, last_heartbeat)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE campaigns
  ADD COLUMN fs_node_id INT UNSIGNED NULL AFTER tenant_id;

ALTER TABLE campaigns
  ADD CONSTRAINT fk_campaigns_fs_node
  FOREIGN KEY (fs_node_id) REFERENCES fs_nodes(id)
  ON DELETE RESTRICT;

-- DOWN (rollback):
-- ALTER TABLE campaigns DROP FOREIGN KEY fk_campaigns_fs_node;
-- ALTER TABLE campaigns DROP COLUMN fs_node_id;
-- DROP TABLE fs_nodes;
