#!/usr/bin/env bash
# Copyright (c) 2026 Homelab Control Plane contributors
# SPDX-License-Identifier: MIT
#
# This script automates go test tasks for the project.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${ROOT_DIR}/apps/agent"

GO_BIN="$(command -v go || true)"
if [[ -z "${GO_BIN}" && -x "${HOME}/.local/go/bin/go" ]]; then
  GO_BIN="${HOME}/.local/go/bin/go"
fi

if [[ -z "${GO_BIN}" ]]; then
  echo "go not found; skipping local apps/agent go test"
  exit 0
fi

cd "${AGENT_DIR}"
"${GO_BIN}" test ./...

