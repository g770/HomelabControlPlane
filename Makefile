# Copyright (c) 2026 Homelab Control Plane contributors
# SPDX-License-Identifier: MIT
#
# This file defines the common development and automation targets for the repository.
SHELL := /bin/bash
PNPM ?= npx -y pnpm@9.15.4

.PHONY: dev test lint migrate seed typecheck format quality-preflight quality-check compose-up compose-down agent-build agent-build-container clean-generated

dev:
	$(PNPM) dev

test:
	$(PNPM) test

lint:
	$(PNPM) lint

typecheck:
	$(PNPM) typecheck

migrate:
	$(PNPM) migrate

seed:
	@echo "No repository seed step is required."

format:
	$(PNPM) format

quality-preflight:
	$(PNPM) quality:preflight

quality-check:
	$(PNPM) quality:check

compose-up:
	docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml up -d --build

compose-down:
	docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml down -v

agent-build:
	./scripts/build-labagent-container.sh

agent-build-container:
	./scripts/build-labagent-container.sh

clean-generated:
	rm -rf coverage apps/api/dist apps/web/dist apps/worker/dist packages/shared/dist apps/web/test-results infra/compose/logs
