#!/usr/bin/env bash
# Copyright (c) 2026 Homelab Control Plane contributors
# SPDX-License-Identifier: MIT
#
# This script automates build labagent container tasks for the project.
set -euo pipefail

# Builds labagent binaries using Docker only (no local Go toolchain required)
# and writes artifacts to a host directory.
#
# Usage:
#   ./scripts/build-labagent-container.sh
#   ./scripts/build-labagent-container.sh --os linux --arch arm64 --output dist/agent
#   ./scripts/build-labagent-container.sh --matrix

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="${ROOT_DIR}/apps/agent/Dockerfile"
CONTEXT_DIR="${ROOT_DIR}"
OUT_DIR="${ROOT_DIR}/dist/agent"

TARGET_OS="${TARGET_OS:-linux}"
TARGET_ARCH="${TARGET_ARCH:-amd64}"
MATRIX="false"

# Implements usage.
usage() {
  cat <<EOF
Build labagent binaries in a container and export artifacts to host.

Options:
  --os <goos>         Target OS (default: linux)
  --arch <goarch>     Target arch (default: amd64)
  --output <dir>      Output dir (default: dist/agent)
  --matrix            Build: linux/amd64, linux/arm64, darwin/amd64, darwin/arm64
  -h, --help          Show help
EOF
}

# Implements require cmd.
require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

# Builds one.
build_one() {
  local goos="$1"
  local goarch="$2"
  local out_dir="$3"

  mkdir -p "$out_dir"
  echo "Building ${goos}/${goarch} with Docker..."

  DOCKER_BUILDKIT=1 docker build \
    --file "$DOCKERFILE" \
    --target artifact \
    --build-arg TARGETOS="$goos" \
    --build-arg TARGETARCH="$goarch" \
    --output "type=local,dest=${out_dir}" \
    "$CONTEXT_DIR" >/dev/null

  if [[ ! -f "${out_dir}/labagent-${goos}-${goarch}" ]]; then
    echo "Expected artifact missing: ${out_dir}/labagent-${goos}-${goarch}" >&2
    exit 1
  fi
  chmod +x "${out_dir}/labagent-${goos}-${goarch}" || true
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --os)
      TARGET_OS="${2:-}"
      shift 2
      ;;
    --arch)
      TARGET_ARCH="${2:-}"
      shift 2
      ;;
    --output)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --matrix)
      MATRIX="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_cmd docker

if [[ ! -f "$DOCKERFILE" ]]; then
  echo "Dockerfile not found: $DOCKERFILE" >&2
  exit 1
fi

if [[ "$MATRIX" == "true" ]]; then
  build_one linux amd64 "$OUT_DIR"
  build_one linux arm64 "$OUT_DIR"
  build_one darwin amd64 "$OUT_DIR"
  build_one darwin arm64 "$OUT_DIR"
  echo "Done. Artifacts in ${OUT_DIR}"
  exit 0
fi

if [[ -z "$TARGET_OS" || -z "$TARGET_ARCH" ]]; then
  echo "--os and --arch must be non-empty." >&2
  exit 1
fi

build_one "$TARGET_OS" "$TARGET_ARCH" "$OUT_DIR"
echo "Done. Artifacts in ${OUT_DIR}"
