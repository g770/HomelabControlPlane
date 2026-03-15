#!/usr/bin/env bash
# Copyright (c) 2026 Homelab Control Plane contributors
# SPDX-License-Identifier: MIT
#
# This script automates go coverage gate tasks for the project.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${ROOT_DIR}/apps/agent"
OUTPUT_DIR="${ROOT_DIR}/coverage/go"
MIN_STATEMENT_COVERAGE="${GO_MIN_COVERAGE:-80}"

GO_BIN="$(command -v go || true)"
if [[ -z "${GO_BIN}" && -x "${HOME}/.local/go/bin/go" ]]; then
  GO_BIN="${HOME}/.local/go/bin/go"
fi

if [[ -z "${GO_BIN}" ]]; then
  echo "go not found; skipping Go coverage gate locally"
  exit 0
fi

mkdir -p "${OUTPUT_DIR}"
cd "${AGENT_DIR}"

"${GO_BIN}" test ./... -covermode=atomic -coverprofile="${OUTPUT_DIR}/coverage.out"

TOTAL_LINE="$("${GO_BIN}" tool cover -func="${OUTPUT_DIR}/coverage.out" | tail -n 1)"
TOTAL_PCT="$(echo "${TOTAL_LINE}" | awk '{print $3}' | sed 's/%//')"

if [[ -z "${TOTAL_PCT}" ]]; then
  echo "Unable to parse Go total coverage from: ${TOTAL_LINE}" >&2
  exit 1
fi

awk -v total="${TOTAL_PCT}" -v min="${MIN_STATEMENT_COVERAGE}" 'BEGIN {
  if (total + 0 < min + 0) {
    printf("Go statement coverage %.2f%% is below minimum %.2f%%\n", total + 0, min + 0) > "/dev/stderr";
    exit 1;
  }
}'

echo "Go statement coverage ${TOTAL_PCT}% (minimum ${MIN_STATEMENT_COVERAGE}%)"
