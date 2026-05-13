-- N02 — Email Template System
-- Migration: email_templates, email_template_versions, users.preferred_lang

-- Add preferred_lang to users (instant algorithm on InnoDB — no table rebuild)
ALTER TABLE users
  ADD COLUMN preferred_lang VARCHAR(10) NOT NULL DEFAULT 'en'
    COMMENT 'BCP 47 language tag; used by email-delivery worker for template lookup';

-- email_templates: one active template per (tenant_id, category, lang)
CREATE TABLE email_templates (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT       NOT NULL DEFAULT 1,
  category    VARCHAR(64)  NOT NULL,
  lang        VARCHAR(10)  NOT NULL DEFAULT 'en',
  subject     VARCHAR(255) NOT NULL,
  html_body   MEDIUMTEXT   NOT NULL,
  text_body   MEDIUMTEXT   NOT NULL,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  version     SMALLINT     NOT NULL DEFAULT 1,
  created_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uk_email_tpl_t_cat_lang (tenant_id, category, lang),
  INDEX idx_email_tpl_t_active_cat (tenant_id, active, category),
  CONSTRAINT fk_email_tpl_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- email_template_versions: version history (last 10 per template)
CREATE TABLE email_template_versions (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT       NOT NULL,
  template_id BIGINT       NOT NULL,
  version     SMALLINT     NOT NULL,
  subject     VARCHAR(255) NOT NULL,
  html_body   MEDIUMTEXT   NOT NULL,
  text_body   MEDIUMTEXT   NOT NULL,
  saved_at    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uk_email_tpl_ver_id_v (template_id, version),
  INDEX idx_email_tpl_ver_t_tpl (tenant_id, template_id),
  CONSTRAINT fk_email_tpl_ver_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fk_email_tpl_ver_tpl FOREIGN KEY (template_id) REFERENCES email_templates (id)
    ON DELETE CASCADE ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
