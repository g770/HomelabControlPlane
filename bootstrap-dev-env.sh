#!/usr/bin/env bash
# Copyright (c) 2026 Homelab Control Plane contributors
# SPDX-License-Identifier: MIT
#
# This script automates bootstrap dev env tasks for the project.
set -euo pipefail

# Simple structured logger helpers to keep output readable.
log()  { printf "\n[%s] %s\n" "$1" "$2"; }
info() { printf "  - %s\n" "$1"; }

log "1/8" "Validating platform and prerequisites"

# This bootstrap intentionally targets apt-based systems only.
if ! command -v apt-get >/dev/null 2>&1; then
  echo "Error: apt-get not found. This script supports Debian/Ubuntu only." >&2
  exit 1
fi

# Ensure sudo is available before doing privileged operations.
if ! command -v sudo >/dev/null 2>&1; then
  echo "Error: sudo is required but not installed." >&2
  exit 1
fi

info "OS detected: $(. /etc/os-release && echo "${PRETTY_NAME:-unknown}")"
info "User: ${USER}"

log "2/8" "Installing base packages (TLS, repos, and system helpers)"

sudo apt-get update
sudo apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  software-properties-common

log "3/8" "Installing Docker Engine + Compose plugin"

if ! command -v docker >/dev/null 2>&1; then
  info "Docker not detected; adding official Docker apt repository."

  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  # VERSION_CODENAME is required for selecting the correct Docker apt channel.
  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
  ARCH="$(dpkg --print-architecture)"

  # Add docker repository using signed-by keyring for modern apt key hygiene.
  echo \
    "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

  sudo apt-get update
  sudo apt-get install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin
else
  info "Docker already installed; skipping package install."
fi

# Ensure daemon is active on boot and now.
sudo systemctl enable --now docker

# Grant non-root docker access to current user.
sudo usermod -aG docker "${USER}"
info "Added ${USER} to docker group."

log "4/8" "Installing Node.js 22 and pnpm via corepack"

# Install Node 22 if missing or older than major version 22.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//;s/\..*$//')" -lt 22 ]]; then
  info "Installing Node.js 22 from NodeSource."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  info "Node already installed ($(node -v)); keeping existing version."
fi

# Some environments lack corepack despite modern node packages.
if ! command -v corepack >/dev/null 2>&1; then
  info "corepack missing; installing globally with npm."
  sudo npm i -g corepack
fi

corepack enable
corepack prepare pnpm@9.15.4 --activate
info "pnpm activated: $(pnpm -v)"

log "5/8" "Installing Go 1.23.7 (official tarball)"

GO_VERSION="1.23.7"
GO_TARBALL="go${GO_VERSION}.linux-amd64.tar.gz"
TMP_DIR="$(mktemp -d)"

# Always cleanup temp artifacts, even on failure.
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

info "Downloading ${GO_TARBALL}"
curl -fsSL "https://go.dev/dl/${GO_TARBALL}" -o "${TMP_DIR}/${GO_TARBALL}"

# Replace system go install directory explicitly for deterministic versioning.
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf "${TMP_DIR}/${GO_TARBALL}"

# Persist PATH update for future shells. Keep idempotent by checking first.
if ! grep -q '/usr/local/go/bin' "${HOME}/.bashrc"; then
  echo 'export PATH=$PATH:/usr/local/go/bin' >> "${HOME}/.bashrc"
  info "Added /usr/local/go/bin to ~/.bashrc"
else
  info "Go PATH already present in ~/.bashrc"
fi

# Export for the current shell so verification works immediately.
export PATH="$PATH:/usr/local/go/bin"

log "6/8" "Verifying installed toolchain versions"
info "node:    $(node -v)"
info "npm:     $(npm -v)"
info "pnpm:    $(pnpm -v)"
info "go:      $(go version)"
info "docker:  $(docker --version)"
info "compose: $(docker compose version)"

log "7/8" "Post-install instructions"
cat <<'EOF'
Docker group membership does not apply retroactively to this shell.

Do one of:
  - log out and back in
  - OR run: newgrp docker

Then validate docker access:
  docker ps
EOF

log "8/8" "Project next steps"
cat <<'EOF'
From the project directory run:
  make lint
  make typecheck
  make test
  docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml up -d --build
EOF
