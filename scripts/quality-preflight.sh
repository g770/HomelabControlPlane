#!/usr/bin/env bash
# Copyright (c) 2026 Homelab Control Plane contributors
# SPDX-License-Identifier: MIT
#
# This script verifies that the local Node.js and Go toolchains are new enough
# to run the repository's full quality gates.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIN_NODE_MAJOR=22
MIN_GO_MAJOR=1
MIN_GO_MINOR=23

# Prefer the runtime npm is already using before falling back to PATH lookup.
node_bin="${NODE_BINARY:-${npm_node_execpath:-$(command -v node || true)}}"
if [[ -z "${node_bin}" ]]; then
  echo "Node.js is required but was not found." >&2
  exit 1
fi

node_version_raw="$("${node_bin}" -v 2>/dev/null || true)"
if [[ -z "${node_version_raw}" ]]; then
  echo "Node.js is required but was not found." >&2
  exit 1
fi

node_version="${node_version_raw#v}"
node_major="${node_version%%.*}"
if [[ "${node_major}" -lt "${MIN_NODE_MAJOR}" ]]; then
  echo "Node ${MIN_NODE_MAJOR}+ is required for full quality checks; found ${node_version_raw}." >&2
  echo "Use the repo .nvmrc (22) or install a compatible runtime before running quality gates." >&2
  exit 1
fi

# Fall back to the user-local Go install path used by the dev setup docs.
go_bin="$(command -v go || true)"
if [[ -z "${go_bin}" && -x "${HOME}/.local/go/bin/go" ]]; then
  go_bin="${HOME}/.local/go/bin/go"
fi

if [[ -z "${go_bin}" ]]; then
  echo "Go is required for agent quality checks but was not found." >&2
  exit 1
fi

go_version_raw="$("${go_bin}" version 2>/dev/null | awk '{print $3}' | sed 's/^go//')"
go_major="${go_version_raw%%.*}"
go_minor="${go_version_raw#*.}"
go_minor="${go_minor%%.*}"

if [[ -z "${go_major}" || -z "${go_minor}" ]]; then
  echo "Unable to parse Go version from: ${go_version_raw}" >&2
  exit 1
fi

if [[ "${go_major}" -lt "${MIN_GO_MAJOR}" || ( "${go_major}" -eq "${MIN_GO_MAJOR}" && "${go_minor}" -lt "${MIN_GO_MINOR}" ) ]]; then
  echo "Go ${MIN_GO_MAJOR}.${MIN_GO_MINOR}+ is required; found ${go_version_raw}." >&2
  exit 1
fi

echo "Quality preflight OK"
echo "  root: ${ROOT_DIR}"
echo "  node: v${node_version}"
echo "  go:   ${go_version_raw} (${go_bin})"
