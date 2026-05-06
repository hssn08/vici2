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

lint: lint-go lint-node lint-xml ## Lint everything.

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

# ----- database --------------------------------------------------------------

db-migrate: ## Run prisma migrate dev (interactive).
	$(COMPOSE) run --rm api pnpm exec prisma migrate dev

db-deploy: ## Run prisma migrate deploy (CI / prod).
	$(COMPOSE) run --rm api pnpm exec prisma migrate deploy

db-reset: ## Reset the dev database (drops data).
	$(COMPOSE) run --rm api pnpm exec prisma migrate reset --skip-seed --force

db-seed: ## Seed dev data (after F02 ships).
	$(COMPOSE) run --rm api pnpm exec ts-node prisma/seed.ts

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

# ----- redis / mysql shells --------------------------------------------------

redis-cli: ## Drop into redis-cli.
	$(COMPOSE) exec redis redis-cli

mysql-cli: ## Drop into mysql shell.
	$(COMPOSE) exec mysql sh -c 'mysql -u$$VICI2_DB_USER -p$$VICI2_DB_PASSWORD $$VICI2_DB_NAME'

# ----- housekeeping ----------------------------------------------------------

clean: ## Stop stack + remove volumes + remove generated artifacts.
	-$(COMPOSE) down -v
	@rm -rf node_modules dialer/bin dialer/tmp **/dist **/.next **/.turbo

reset: clean ## Alias of clean.

hooks: ## Install lefthook git hooks.
	pnpm exec lefthook install

.PHONY: help dev dev-watch dev-down logs logs-fs ps build build-images \
	lint lint-fix lint-go lint-node lint-xml typecheck \
	test test-go test-node smoke \
	db-migrate db-deploy db-reset db-seed \
	fs-up fs-down fs-reload fs-cli redis-cli mysql-cli \
	clean reset hooks
