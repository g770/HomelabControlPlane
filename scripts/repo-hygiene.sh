#!/usr/bin/env bash
# Copyright (c) 2026 Homelab Control Plane contributors
# SPDX-License-Identifier: MIT
#
# This script automates repo hygiene tasks for the project.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

required_files=(
  "LICENSE"
  "README.md"
  "CONTRIBUTING.md"
  "CODE_OF_CONDUCT.md"
  "SECURITY.md"
)

missing_files=()
for path in "${required_files[@]}"; do
  if [[ ! -f "${path}" ]]; then
    missing_files+=("${path}")
  fi
done

if (( ${#missing_files[@]} > 0 )); then
  printf 'Missing required repository files:\n' >&2
  printf '  - %s\n' "${missing_files[@]}" >&2
  exit 1
fi

mapfile -t doc_refs < <(
  rg --no-filename -No '(README\.md|TESTING_AGENT\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE|docs/[A-Za-z0-9._/-]+\.md)' \
    README.md docs TESTING_AGENT.md CONTRIBUTING.md SECURITY.md 2>/dev/null \
    | sort -u
)

missing_doc_refs=()
for ref in "${doc_refs[@]}"; do
  if [[ ! -f "${ref}" ]]; then
    missing_doc_refs+=("${ref}")
  fi
done

if (( ${#missing_doc_refs[@]} > 0 )); then
  printf 'Broken documentation references:\n' >&2
  printf '  - %s\n' "${missing_doc_refs[@]}" >&2
  exit 1
fi

mapfile -t script_refs < <(
  rg --no-filename -No '\./scripts/[A-Za-z0-9._/-]+' README.md docs TESTING_AGENT.md package.json Makefile .github 2>/dev/null \
    | sort -u
)

missing_script_refs=()
for ref in "${script_refs[@]}"; do
  if [[ ! -e "${ref#./}" && ! -e "${ref}" ]]; then
    missing_script_refs+=("${ref}")
  fi
done

if (( ${#missing_script_refs[@]} > 0 )); then
  printf 'Broken script references:\n' >&2
  printf '  - %s\n' "${missing_script_refs[@]}" >&2
  exit 1
fi

placeholder_hits=()
while IFS= read -r file; do
  case "${file}" in
    scripts/repo-hygiene.sh)
      continue
      ;;
    apps/api/.env.example|apps/web/.env.example|apps/worker/.env.example|infra/compose/.env.example)
      continue
      ;;
  esac

  if grep -nE 'change_me_to_a_very_long|dev_master_key_change_me_please_32_chars_long' "${file}" >/dev/null 2>&1; then
    while IFS= read -r line; do
      placeholder_hits+=("${file}:${line}")
    done < <(grep -nE 'change_me_to_a_very_long|dev_master_key_change_me_please_32_chars_long' "${file}" || true)
  fi
done < <(git ls-files)

if (( ${#placeholder_hits[@]} > 0 )); then
  printf 'Placeholder secrets found outside env examples:\n' >&2
  printf '  - %s\n' "${placeholder_hits[@]}" >&2
  exit 1
fi

forbidden_hits=()
while IFS= read -r file; do
  case "${file}" in
    scripts/repo-hygiene.sh)
      continue
      ;;
    README.md|TESTING_AGENT.md|CONTRIBUTING.md|SECURITY.md|docs/*|.github/*|apps/api/test/*|apps/web/test/*|apps/worker/test/*|packages/shared/src/*.test.ts|apps/agent/*_test.go)
      continue
      ;;
  esac

  if grep -nE 'DEMO_AGENT_ID|DEMO_AGENT_TOKEN|dev-agent-token|docs/GITHUB_MIGRATION_PLAN\.md' "${file}" >/dev/null 2>&1; then
    while IFS= read -r line; do
      forbidden_hits+=("${file}:${line}")
    done < <(grep -nE 'DEMO_AGENT_ID|DEMO_AGENT_TOKEN|dev-agent-token|docs/GITHUB_MIGRATION_PLAN\.md' "${file}" || true)
  fi
done < <(git ls-files)

if (( ${#forbidden_hits[@]} > 0 )); then
  printf 'Forbidden runtime or stale references found:\n' >&2
  printf '  - %s\n' "${forbidden_hits[@]}" >&2
  exit 1
fi

if grep -n 'prisma:seed' infra/compose/docker-compose.yml >/dev/null 2>&1; then
  printf 'Default compose startup must not run prisma:seed automatically.\n' >&2
  exit 1
fi

printf 'Repository hygiene checks passed.\n'
