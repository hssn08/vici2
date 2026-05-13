# vici2 — top-level Makefile
# Each target is one shell invocation; complex flows live under scripts/.
# Per SPEC.md §3.11, CI references these targets so local == CI.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# Detect compose file overlay: macOS uses docker-compose.macos.yml override.
COMPOSE := docker compose -f docker-compose.dev.yml
ifeq ($(shell uname -s),Darwin)
  COMPOSE := $(COMPOSE) -f docker-compose.macos.yml
endif

# ----- meta -----------------------------------------------------------------

help: ## Show available targets.
	@awk 'BEGIN {FS = ":.*##"; printf "vici2 — make targets\n\n"} \
		/^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[1m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# ----- environment -----------------------------------------------------------

dev: ## Bring up the full dev stack (build + start + smoke).
	@if [ ! -f .env ]; then echo "[make] copying .env.example -> .env (set SIGNALWIRE_TOKEN!)"; cp .env.example .env; fi
	$(COMPOSE) up --build -d --wait
	@./scripts/smoke.sh || true

dev-watch: ## Bring up the dev stack in watch mode (foreground, hot reload).
	$(COMPOSE) up --watch

dev-down: ## Stop dev stack (preserve volumes).
	$(COMPOSE) down

logs: ## Tail logs from all services.
	$(COMPOSE) logs -f --tail=200

logs-fs: ## Tail freeswitch logs.
	$(COMPOSE) logs -f freeswitch

ps: ## Show running services.
	$(COMPOSE) ps

# ----- build / lint / test ---------------------------------------------------

build: build-images ## Alias for build-images.

build-images: ## Build all docker images in parallel.
	$(COMPOSE) build --parallel

lint: lint-go lint-node lint-xml lint-tenant-index ## Lint everything.

lint-tenant-index: ## Verify every composite index leads with tenant_id (F02 §9).
	@./scripts/ci/check-tenant-index-leadership.sh

lint-fix: ## Auto-fix lint issues where possible.
	pnpm exec eslint . --fix
	pnpm exec prettier --write .
	@if command -v golangci-lint >/dev/null 2>&1; then (cd dialer && golangci-lint run --fix ./...) ; fi

lint-go: ## Run golangci-lint over the dialer module.
	@if command -v golangci-lint >/dev/null 2>&1; then \
		(cd dialer && golangci-lint run ./...) ; \
	else \
		echo "[make] golangci-lint not installed — running 'go vet' instead"; \
		(cd dialer && go vet ./...) ; \
	fi

lint-node: ## Run eslint + prettier over the TS layer.
	pnpm exec eslint .
	pnpm exec prettier --check .

lint-xml: ## Validate FreeSWITCH XML configs.
	@if command -v xmllint >/dev/null 2>&1; then \
		find freeswitch/conf -name '*.xml' -print0 | xargs -0 -r xmllint --noout ; \
	else \
		echo "[make] xmllint not installed — skipping"; \
	fi

typecheck: ## Type-check all services.
	(cd dialer && go vet ./...)
	pnpm -r --if-present run typecheck

test: test-go test-node ## Run all unit tests.

test-go: ## Run Go unit tests.
	(cd dialer && go test ./...)

test-node: ## Run Node unit tests.
	pnpm -r --if-present run test

smoke: ## Smoke-test running stack against /metrics + /health endpoints.
	./scripts/smoke.sh

# ----- ci ---------------------------------------------------------------------
# `make ci` runs everything CI does on a PR. Useful before pushing.
ci: ci-lint ci-test ci-migrations ## Mirror of CI on a PR (lint+test+migration-check).
	@echo "[ci] all local checks passed"

ci-lint: lint ## Run all linters (alias for `make lint`).

ci-test: test ## Run all unit tests (alias for `make test`).

ci-migrations: ## Verify every prisma migration has a down.sql.
	@./scripts/ci/check-migrations.sh

ci-actionlint: ## Lint GitHub Actions workflow YAML (requires actionlint).
	@if command -v actionlint >/dev/null 2>&1; then \
		actionlint -color ; \
	else \
		echo "[ci-actionlint] actionlint not installed — install via 'go install github.com/rhysd/actionlint/cmd/actionlint@latest'"; \
		exit 1; \
	fi

ci-workflows: ci-actionlint ## Alias — lint workflow YAML.

# ----- database --------------------------------------------------------------

db-generate: ## Regenerate Prisma client without touching the DB.
	cd api && pnpm exec prisma generate

db-migrate: ## Apply migrations to the DB (idempotent; CI/prod-safe).
	cd api && pnpm exec prisma migrate deploy

db-migrate-dev: ## Generate new migration from schema diff (dev only).
	cd api && pnpm exec prisma migrate dev

db-deploy: db-migrate ## Alias for db-migrate (CI/prod naming).

db-reset: ## Drop + re-create the dev database (DESTRUCTIVE).
	cd api && pnpm exec prisma migrate reset --force --skip-seed

db-seed: ## Seed reference data (tenants, statuses, phone_codes, …).
	cd api && pnpm exec prisma db seed

db-studio: ## Launch Prisma Studio against the dev DB.
	cd api && pnpm exec prisma studio

db-bootstrap-superadmin: ## Create the initial super-admin user (F05 owns).
	@echo "[db-bootstrap-superadmin] Not yet implemented — F05 IMPLEMENT will provide."
	@echo "[db-bootstrap-superadmin] Per F02 amendment A6, F02 ships the users.password_hash"
	@echo "[db-bootstrap-superadmin] column shape but does NOT seed the super-admin row."
	@echo "[db-bootstrap-superadmin] Set BOOTSTRAP_SUPERADMIN_{EMAIL,PASSWORD,TENANT_ID} in"
	@echo "[db-bootstrap-superadmin] .env, then re-run after F05 lands."
	@exit 0

# ----- freeswitch helpers ----------------------------------------------------

fs-up: ## Start only freeswitch.
	$(COMPOSE) up -d freeswitch

fs-down: ## Stop freeswitch.
	$(COMPOSE) stop freeswitch

fs-reload: ## Reload FS XML + rescan sofia profiles.
	$(COMPOSE) exec freeswitch fs_cli -x "reloadxml" || true
	$(COMPOSE) exec freeswitch fs_cli -x "sofia profile external rescan" || true

fs-cli: ## Drop into fs_cli.
	$(COMPOSE) exec freeswitch fs_cli

# ----- valkey / mysql shells -------------------------------------------------

valkey-cli: ## Drop into valkey-cli.
	$(COMPOSE) exec valkey valkey-cli

# Back-compat alias for muscle memory.
redis-cli: valkey-cli ## Alias of valkey-cli (Redis → Valkey rename, F04 PLAN §1).

mysql-cli: ## Drop into mysql shell.
	$(COMPOSE) exec mysql sh -c 'mysql -u$$VICI2_DB_USER -p$$VICI2_DB_PASSWORD $$VICI2_DB_NAME'

# ----- F04 Valkey Lua sync ---------------------------------------------------
# `shared/lua/` is the single source of truth (F04 PLAN §7.5). The dialer
# binary uses go:embed which can only reach files inside its package, and
# the api package reads via fs from a sibling `lua/` dir. This target
# keeps both copies in sync.
valkey-sync-lua: ## Copy shared/lua/*.lua → dialer + api embed dirs.
	@cp shared/lua/*.lua dialer/internal/valkey/lua/
	@cp shared/lua/*.lua api/src/lib/valkey/lua/
	@diff -r shared/lua/ dialer/internal/valkey/lua/ >/dev/null \
		&& diff -r shared/lua/ api/src/lib/valkey/lua/ >/dev/null \
		&& echo "[valkey] lua sync OK"

# ----- C03 audit immutability ------------------------------------------------
#
# audit-ddl: safe DDL wrapper that writes an audit.schema.modified row before
# executing the SQL, preventing silent trigger/schema changes (PLAN §7.3).
# Usage: make audit-ddl FILE=infra/mysql/migrations/fix.sql REASON="short desc"
#
# audit-verify-7d: CI shortcut that verifies the last 7 days for all tables.
# Requires DATABASE_URL_AUDIT_READER in environment.

AUDIT_DDL_FILE   ?= $(error set FILE=path/to/migration.sql)
AUDIT_DDL_REASON ?= $(error set REASON="short description")

audit-ddl: ## Safe DDL on audit tables: writes audit.schema.modified row first.
	@if [ -z "$(FILE)" ]; then echo "[audit-ddl] Usage: make audit-ddl FILE=<sql> REASON='<desc>'"; exit 1; fi
	@if [ -z "$(REASON)" ]; then echo "[audit-ddl] REASON is required"; exit 1; fi
	@echo "[audit-ddl] Running DDL with audit trail: $(FILE)"
	@SHA=$$(sha256sum "$(FILE)" | awk '{print $$1}'); \
	$(COMPOSE) exec -T mysql sh -c "mysql -u\$$VICI2_DBA_USER -p\$$VICI2_DBA_PASSWORD \$$VICI2_DB_NAME" <<'SQL'
INSERT INTO audit_log (tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id, before_json, after_json, ts)
VALUES (1, NULL, 'system', 'audit.schema.modified', 'schema', '$(FILE)',
        JSON_OBJECT('file_path', '$(FILE)', 'file_sha256', '$$SHA'),
        JSON_OBJECT('reason', '$(REASON)', 'dba_user', USER()), NOW(6));
SQL
	@$(COMPOSE) exec -T mysql sh -c "mysql -u\$$VICI2_DBA_USER -p\$$VICI2_DBA_PASSWORD \$$VICI2_DB_NAME" < "$(FILE)"
	@echo "[audit-ddl] DDL applied: $(FILE)"

audit-verify-7d: ## Verify last 7 days of audit chain for all tables (CI/smoke).
	@echo "[audit-verify] Running 7-day chain verification for tenant 1..."
	@FROM=$$(date -u -d '7 days ago' '+%Y-%m-%d' 2>/dev/null || date -u -v-7d '+%Y-%m-%d'); \
	 TO=$$(date -u '+%Y-%m-%d'); \
	 for TABLE in audit_log call_window_audit originate_audit consent_log dnc_sync_log; do \
	   echo "[audit-verify] Checking $$TABLE $$FROM → $$TO"; \
	   tsx scripts/verify-audit-chain.ts \
	     --tenant 1 --table $$TABLE \
	     --from "$$FROM" --to "$$TO" \
	     --public-keys ./vici2-public-keys \
	   || { echo "[audit-verify] FAIL: $$TABLE"; exit 2; }; \
	 done
	@echo "[audit-verify] All tables OK"

# ----- backup / restore (O02) ------------------------------------------------

backup-mysql: ## Run a MySQL daily backup (--dry-run by default; set DRY_RUN=false to upload).
	@ARGS="--env dev --archive-class daily"; \
	 [ "$$(echo $${DRY_RUN:-true})" = "false" ] || ARGS="$$ARGS --dry-run"; \
	 scripts/backup/mysql.sh $$ARGS

backup-valkey: ## Run a Valkey daily backup (dry-run by default).
	@ARGS="--env dev --archive-class daily"; \
	 [ "$$(echo $${DRY_RUN:-true})" = "false" ] || ARGS="$$ARGS --dry-run"; \
	 scripts/backup/valkey.sh $$ARGS --docker-cp

backup-preflight: ## Run the host preflight check for backup operations.
	@scripts/backup/preflight-host.sh

# Restore from a backup artifact. BACKUP= sets the S3 key date portion (YYYY-MM-DD).
# Example: make restore-from-backup BACKUP=2026-05-12
restore-from-backup: ## Restore MySQL from S3 backup to staging. Requires BACKUP=YYYY-MM-DD.
	@if [ -z "$${BACKUP:-}" ]; then \
	  echo "ERROR: BACKUP=YYYY-MM-DD is required (e.g. make restore-from-backup BACKUP=2026-05-12)"; \
	  exit 1; \
	fi; \
	scripts/restore/from-s3.sh \
	  --service mysql \
	  --date "$${BACKUP}" \
	  --target staging

# ----- D03 timezone resolver -------------------------------------------------

build-phone-codes: ## Refresh db/seeds/phone_codes.csv from NANPA + LCG crosswalk.
	@echo "[build-phone-codes] Building phone_codes seed data…"
	(cd dialer && go run ../scripts/build-phone-codes.go)

build-zip-codes: ## Refresh db/seeds/zip_codes.csv from Census ZCTA + TBB polygons.
	@echo "[build-zip-codes] Building zip_codes seed data…"
	(cd dialer && go run ../scripts/build-zip-codes.go)

db-seed-tz: ## UPSERT phone_codes + zip_codes + publish FULL invalidate.
	@echo "[db-seed-tz] Seeding timezone reference tables…"
	cd api && pnpm exec prisma db seed

test-tz: ## Run all D03 unit tests (Go + Node).
	@echo "[test-tz] Running Go tz tests…"
	(cd dialer && go test ./internal/tz/... -v)
	@echo "[test-tz] Running Node tz tests…"
	cd api && node_modules/.bin/vitest run src/tz/__tests__

bench-tz: ## Run Go benchmarks for D03 timezone resolver.
	@echo "[bench-tz] Running D03 benchmarks…"
	(cd dialer && go test -bench=. -benchtime=5s ./internal/tz/)

tz-debug: ## Ad-hoc resolver debug. Usage: make tz-debug PHONE=+13175551212
	@if [ -z "$${PHONE:-}" ]; then \
	  echo "Usage: make tz-debug PHONE=+13175551212 [ZIP=46201] [STATE=IN]"; \
	  exit 1; \
	fi
	@echo "[tz-debug] Resolving $$PHONE…"
	cd api && PHONE="$$PHONE" ZIP="$$ZIP" STATE="$$STATE" \
	  node --loader ts-node/esm src/tz/debug-cli.ts

# ----- housekeeping ----------------------------------------------------------

clean: ## Stop stack + remove volumes + remove generated artifacts.
	-$(COMPOSE) down -v
	@rm -rf node_modules dialer/bin dialer/tmp **/dist **/.next **/.turbo

reset: clean ## Alias of clean.

hooks: ## Install lefthook git hooks.
	pnpm exec lefthook install

.PHONY: help dev dev-watch dev-down logs logs-fs ps build build-images \
	lint lint-fix lint-go lint-node lint-xml lint-tenant-index typecheck \
	test test-go test-node smoke \
	ci ci-lint ci-test ci-migrations ci-actionlint ci-workflows \
	db-generate db-migrate db-migrate-dev db-deploy db-reset db-seed \
	db-studio db-bootstrap-superadmin \
	fs-up fs-down fs-reload fs-cli valkey-cli redis-cli mysql-cli \
	valkey-sync-lua audit-ddl audit-verify-7d \
	backup-mysql backup-valkey backup-preflight restore-from-backup \
	clean reset hooks \
	build-phone-codes build-zip-codes db-seed-tz test-tz bench-tz tz-debug
