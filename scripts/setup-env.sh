#!/usr/bin/env bash
# Copyright (c) 2026 Homelab Control Plane contributors
# SPDX-License-Identifier: MIT
#
# This script automates setup env tasks for the project.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_ENV_FILE="${ROOT_DIR}/apps/api/.env"
WEB_ENV_FILE="${ROOT_DIR}/apps/web/.env"
WORKER_ENV_FILE="${ROOT_DIR}/apps/worker/.env"
COMPOSE_ENV_FILE="${ROOT_DIR}/infra/compose/.env"

FORCE="false"
NON_INTERACTIVE="false"
DRY_RUN="false"

DEFAULT_WEB_ORIGIN="http://localhost:5173"
DEFAULT_API_PUBLIC_URL="http://localhost:4000"
DEFAULT_LOCAL_DATABASE_URL=""
DEFAULT_LOCAL_REDIS_URL="redis://localhost:56379"
DEFAULT_COMPOSE_DATABASE_URL=""
DEFAULT_COMPOSE_REDIS_URL="redis://redis:6379"

DEFAULT_AGENT_INSTALL_QUEUE_NAME="agent-install-jobs"
DEFAULT_AGENT_INSTALL_SECRET_TTL_SEC="900"
DEFAULT_AGENT_BINARY_STORE_ROOT="/opt/homelab-agent-binaries"

# Implements detect primary ipv4.
detect_primary_ipv4() {
  local detected=""

  if command -v ip >/dev/null 2>&1; then
    detected="$(
      ip -4 route get 1.1.1.1 2>/dev/null \
        | awk '{for(i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' \
        || true
    )"
  fi

  if [[ -z "$detected" ]] && command -v hostname >/dev/null 2>&1; then
    detected="$(
      hostname -I 2>/dev/null \
        | tr ' ' '\n' \
        | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $0 !~ /^127\./ {print; exit}' \
        || true
    )"
  fi

  if [[ -z "$detected" ]] && command -v ip >/dev/null 2>&1; then
    detected="$(
      ip -o -4 addr show up scope global 2>/dev/null \
        | awk '{print $4}' \
        | cut -d/ -f1 \
        | awk '$0 !~ /^127\./ {print; exit}' \
        || true
    )"
  fi

  printf '%s' "$detected"
}

# Implements log.
log() {
  printf "[setup-env] %s\n" "$1"
}

# Implements warn.
warn() {
  printf "[setup-env] WARNING: %s\n" "$1" >&2
}

# Implements usage.
usage() {
  cat <<'EOF'
Usage: ./scripts/setup-env.sh [options]

Interactive environment setup for:
  - apps/api/.env
  - apps/web/.env
  - apps/worker/.env
  - infra/compose/.env

Options:
  --force            Overwrite existing .env files without prompt (backups are still created)
  --non-interactive  Use defaults and generated secrets without prompts
  --dry-run          Print resulting .env content without writing files
  -h, --help         Show this help

Notes:
  - The built-in admin password is created from the web UI on first start.
  - The OpenAI API key is configured later from Settings and is not written into env files.
EOF
}

# Implements section.
section() {
  printf "\n"
  log "$1"
  log "$2"
}

# Implements prompt yes no.
prompt_yes_no() {
  local question="$1"
  local default_choice="${2:-y}"
  local response
  local suffix="[y/N]"
  if [[ "$default_choice" == "y" ]]; then
    suffix="[Y/n]"
  fi

  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    [[ "$default_choice" == "y" ]]
    return
  fi

  while true; do
    read -r -p "${question} ${suffix}: " response
    response="$(printf '%s' "$response" | tr '[:upper:]' '[:lower:]')"
    if [[ -z "$response" ]]; then
      response="$default_choice"
    fi
    if [[ "$response" == "y" || "$response" == "yes" ]]; then
      return 0
    fi
    if [[ "$response" == "n" || "$response" == "no" ]]; then
      return 1
    fi
    echo "Please enter y or n."
  done
}

# Implements prompt text.
prompt_text() {
  local label="$1"
  local default_value="${2:-}"
  local allow_empty="${3:-false}"
  local secret="${4:-false}"
  local value=""

  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    printf '%s' "$default_value"
    return
  fi

  while true; do
    if [[ "$secret" == "true" ]]; then
      if [[ -n "$default_value" ]]; then
        read -r -s -p "${label} [press enter to keep default]: " value
      else
        read -r -s -p "${label}: " value
      fi
      printf "\n" >&2
      if [[ -z "$value" ]]; then
        value="$default_value"
      fi
    else
      if [[ -n "$default_value" ]]; then
        read -r -p "${label} [${default_value}]: " value
        value="${value:-$default_value}"
      else
        read -r -p "${label}: " value
      fi
    fi

    if [[ "$allow_empty" == "true" || -n "$value" ]]; then
      printf '%s' "$value"
      return
    fi
    echo "Value cannot be empty."
  done
}

# Implements validate url.
validate_url() {
  local value="$1"
  [[ "$value" =~ ^https?://[^[:space:]]+$ ]]
}

# Implements validate positive int.
validate_positive_int() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] && [[ "$value" -gt 0 ]]
}

# Implements random alnum.
random_alnum() {
  local length="${1:-48}"
  local value=""
  while [[ "${#value}" -lt "$length" ]]; do
    value+="$(
      LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c "$length" || true
    )"
  done
  printf '%s' "${value:0:length}"
}

# Implements normalize url.
normalize_url() {
  local raw="$1"
  printf '%s' "${raw%/}"
}

# Implements dotenv value.
dotenv_value() {
  local value="$1"
  if [[ -z "$value" ]]; then
    printf ''
    return
  fi
  if [[ "$value" =~ ^[A-Za-z0-9_./:@,+=%-]+$ ]]; then
    printf '%s' "$value"
    return
  fi

  local escaped="${value//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  printf '"%s"' "$escaped"
}

# Implements backup file.
backup_file() {
  local file="$1"
  local stamp="$2"
  if [[ -f "$file" ]]; then
    cp "$file" "${file}.bak.${stamp}"
    log "Backed up ${file} -> ${file}.bak.${stamp}"
  fi
}

# Implements begin env output.
begin_env_output() {
  local file="$1"
  local title="$2"
  local stamp="$3"

  if [[ "$DRY_RUN" == "true" ]]; then
    printf "\n# ----- %s (%s) -----\n" "$title" "$file"
    return
  fi

  mkdir -p "$(dirname "$file")"
  backup_file "$file" "$stamp"
  : > "$file"
  chmod 600 "$file"
}

# Implements append env line.
append_env_line() {
  local file="$1"
  local key="$2"
  local value="$3"
  local line="${key}=$(dotenv_value "$value")"

  if [[ "$DRY_RUN" == "true" ]]; then
    printf "%s\n" "$line"
  else
    printf "%s\n" "$line" >> "$file"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE="true"
      shift
      ;;
    --non-interactive)
      NON_INTERACTIVE="true"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
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

if [[ "$NON_INTERACTIVE" == "true" ]]; then
  FORCE="true"
fi

if [[ "$NON_INTERACTIVE" != "true" && ! -t 0 ]]; then
  echo "[setup-env] ERROR: Interactive mode requires a TTY. Re-run in a terminal or use --non-interactive." >&2
  exit 1
fi

detected_host_ip="$(detect_primary_ipv4)"
if [[ -n "$detected_host_ip" ]]; then
  DEFAULT_API_PUBLIC_URL="http://${detected_host_ip}:4000"
  DEFAULT_WEB_ORIGIN="http://${detected_host_ip}:5173"
fi

TARGET_FILES=(
  "$API_ENV_FILE"
  "$WEB_ENV_FILE"
  "$WORKER_ENV_FILE"
  "$COMPOSE_ENV_FILE"
)

if [[ "$FORCE" != "true" ]]; then
  existing_count=0
  for file in "${TARGET_FILES[@]}"; do
    if [[ -f "$file" ]]; then
      existing_count=$((existing_count + 1))
    fi
  done
  if [[ "$existing_count" -gt 0 ]]; then
    if ! prompt_yes_no "Found ${existing_count} existing .env files. Overwrite them?" "n"; then
      echo "Canceled."
      exit 0
    fi
  fi
fi

echo
log "Collecting configuration values..."
log "The OpenAI API key is configured later in Settings and is not written into env files."

section "Browser and API routing" "Choose the URLs browsers use for the UI and API. These values drive CORS and frontend API calls."
api_public_url=""
while true; do
  api_public_url="$(prompt_text "Browser-facing API URL for the dashboard" "$DEFAULT_API_PUBLIC_URL" "false" "false")"
  api_public_url="$(normalize_url "$api_public_url")"
  if validate_url "$api_public_url"; then
    break
  fi
  echo "Please enter a valid URL like http://localhost:4000"
done

web_origin=""
while true; do
  web_origin="$(prompt_text "Browser origin allowed to call the API (CORS)" "$DEFAULT_WEB_ORIGIN" "false" "false")"
  web_origin="$(normalize_url "$web_origin")"
  if validate_url "$web_origin"; then
    break
  fi
  echo "Please enter a valid URL like http://localhost:5173"
done

section "Shared secrets" "These secrets protect login tokens, encrypted app secrets, and the local Postgres container."
jwt_secret=""
if prompt_yes_no "Generate JWT_SECRET automatically for signing admin sessions?" "y"; then
  jwt_secret="$(random_alnum 64)"
else
  while true; do
    jwt_secret="$(prompt_text "JWT_SECRET for signing admin sessions (min 32 characters)" "" "false" "true")"
    if [[ "${#jwt_secret}" -ge 32 ]]; then
      break
    fi
    echo "JWT_SECRET must be at least 32 characters."
  done
fi

app_master_key=""
if prompt_yes_no "Generate APP_MASTER_KEY automatically for encrypting stored app secrets?" "y"; then
  app_master_key="$(random_alnum 64)"
else
  while true; do
    app_master_key="$(prompt_text "APP_MASTER_KEY for encrypting stored app secrets (min 32 characters)" "" "false" "true")"
    if [[ "${#app_master_key}" -ge 32 ]]; then
      break
    fi
    echo "APP_MASTER_KEY must be at least 32 characters."
  done
fi

postgres_password=""
if prompt_yes_no "Generate POSTGRES_PASSWORD automatically for the Docker Compose database?" "y"; then
  postgres_password="$(random_alnum 32)"
else
  postgres_password="$(prompt_text "POSTGRES_PASSWORD for the Docker Compose database" "" "false" "true")"
fi

DEFAULT_LOCAL_DATABASE_URL="postgresql://homelab:${postgres_password}@localhost:55432/homelab"
DEFAULT_COMPOSE_DATABASE_URL="postgresql://homelab:${postgres_password}@postgres:5432/homelab"

section "AI and discovery" "Choose the default AI model name and discovery behavior. The OpenAI API key is added later from Settings."
openai_model="$(prompt_text "Default OPENAI_MODEL name used when AI features are enabled" "gpt-5-mini" "false" "false")"

discovery_enabled="true"
if prompt_yes_no "Enable service discovery jobs and dashboard workflows?" "y"; then
  discovery_enabled="true"
else
  discovery_enabled="false"
fi

discovery_ai_enabled="false"
if [[ "$discovery_enabled" == "true" ]]; then
  if prompt_yes_no "Enable AI-assisted discovery once an OpenAI key is configured in Settings?" "y"; then
    discovery_ai_enabled="true"
  else
    discovery_ai_enabled="false"
  fi
fi

section "Agent install workflow" "These values control the optional web-driven agent installer and its worker queue."
agent_install_enabled="false"
if prompt_yes_no "Enable the web-driven agent install workflow?" "n"; then
  agent_install_enabled="true"
fi

agent_binary_default_version="v0.2.0"
agent_binary_store_root="$DEFAULT_AGENT_BINARY_STORE_ROOT"
if [[ "$agent_install_enabled" == "true" ]]; then
  agent_binary_default_version="$(prompt_text "Default agent binary version served during installs" "v0.2.0" "false" "false")"
fi

agent_install_queue_name="$(prompt_text "Queue name used for API-to-worker install jobs" "$DEFAULT_AGENT_INSTALL_QUEUE_NAME" "false" "false")"
agent_install_secret_ttl_sec=""
while true; do
  agent_install_secret_ttl_sec="$(prompt_text "TTL in seconds for temporary install secrets" "$DEFAULT_AGENT_INSTALL_SECRET_TTL_SEC" "false" "false")"
  if validate_positive_int "$agent_install_secret_ttl_sec"; then
    break
  fi
  echo "Please enter a positive integer."
done

section "Database and Redis endpoints" "Choose the URLs used by local pnpm services and by containers inside Docker Compose."
local_database_url="$(prompt_text "Local DATABASE_URL for apps/api and apps/worker" "$DEFAULT_LOCAL_DATABASE_URL" "false" "false")"
local_redis_url="$(prompt_text "Local REDIS_URL for apps/api and apps/worker" "$DEFAULT_LOCAL_REDIS_URL" "false" "false")"
compose_database_url="$(prompt_text "Compose DATABASE_URL used inside containers" "$DEFAULT_COMPOSE_DATABASE_URL" "false" "false")"
compose_redis_url="$(prompt_text "Compose REDIS_URL used inside containers" "$DEFAULT_COMPOSE_REDIS_URL" "false" "false")"

stamp="$(date +%Y%m%d%H%M%S)"

log "Writing environment files..."

begin_env_output "$API_ENV_FILE" "API" "$stamp"
append_env_line "$API_ENV_FILE" "NODE_ENV" "development"
append_env_line "$API_ENV_FILE" "PORT" "4000"
append_env_line "$API_ENV_FILE" "DATABASE_URL" "$local_database_url"
append_env_line "$API_ENV_FILE" "REDIS_URL" "$local_redis_url"
append_env_line "$API_ENV_FILE" "JWT_SECRET" "$jwt_secret"
append_env_line "$API_ENV_FILE" "JWT_EXPIRES_IN" "8h"
append_env_line "$API_ENV_FILE" "APP_MASTER_KEY" "$app_master_key"
append_env_line "$API_ENV_FILE" "OPENAI_MODEL" "$openai_model"
append_env_line "$API_ENV_FILE" "WEB_ORIGIN" "$web_origin"
append_env_line "$API_ENV_FILE" "RATE_LIMIT_TTL" "60"
append_env_line "$API_ENV_FILE" "RATE_LIMIT_LIMIT" "120"
append_env_line "$API_ENV_FILE" "AI_RETENTION_DAYS" "30"
append_env_line "$API_ENV_FILE" "RETENTION_DAYS" "30"
append_env_line "$API_ENV_FILE" "AGENT_INSTALL_ENABLED" "$agent_install_enabled"
append_env_line "$API_ENV_FILE" "AGENT_BINARY_STORE_ROOT" "$agent_binary_store_root"
append_env_line "$API_ENV_FILE" "AGENT_BINARY_DEFAULT_VERSION" "$agent_binary_default_version"
append_env_line "$API_ENV_FILE" "AGENT_INSTALL_QUEUE_NAME" "$agent_install_queue_name"
append_env_line "$API_ENV_FILE" "AGENT_INSTALL_SECRET_TTL_SEC" "$agent_install_secret_ttl_sec"
append_env_line "$API_ENV_FILE" "DISCOVERY_ENABLED" "$discovery_enabled"
append_env_line "$API_ENV_FILE" "DISCOVERY_AI_ENABLED" "$discovery_ai_enabled"
append_env_line "$API_ENV_FILE" "DISCOVERY_INTERVAL_SEC" "600"
append_env_line "$API_ENV_FILE" "DISCOVERY_AI_CATALOG_TTL_SEC" "86400"
append_env_line "$API_ENV_FILE" "DISCOVERY_MAX_HOSTS_PER_RUN" "120"
append_env_line "$API_ENV_FILE" "DISCOVERY_MAX_PROBES_PER_HOST" "12"
append_env_line "$API_ENV_FILE" "DISCOVERY_AUTO_UPSERT" "true"
append_env_line "$API_ENV_FILE" "DISCOVERY_CONFIDENCE_THRESHOLD" "0.75"
append_env_line "$API_ENV_FILE" "DISCOVERY_SUBNET_ENABLED" "false"
append_env_line "$API_ENV_FILE" "DISCOVERY_SUBNET_SCHEDULED" "false"
append_env_line "$API_ENV_FILE" "DISCOVERY_SUBNET_SCHEDULED_WRITE_APPROVED" "false"
append_env_line "$API_ENV_FILE" "DISCOVERY_SUBNET_DEFAULT_CIDRS" "10.0.0.0/24,172.16.0.0/24,192.168.1.0/24"
append_env_line "$API_ENV_FILE" "DISCOVERY_SUBNET_MAX_HOSTS" "512"
append_env_line "$API_ENV_FILE" "DISCOVERY_SUBNET_CONCURRENCY" "24"
append_env_line "$API_ENV_FILE" "DISCOVERY_SUBNET_CONNECT_TIMEOUT_MS" "750"
append_env_line "$API_ENV_FILE" "DISCOVERY_SUBNET_MCP_TOOL_TIMEOUT_MS" "120000"

begin_env_output "$WORKER_ENV_FILE" "Worker" "$stamp"
append_env_line "$WORKER_ENV_FILE" "DATABASE_URL" "$local_database_url"
append_env_line "$WORKER_ENV_FILE" "REDIS_URL" "$local_redis_url"
append_env_line "$WORKER_ENV_FILE" "RETENTION_DAYS" "30"
append_env_line "$WORKER_ENV_FILE" "APP_MASTER_KEY" "$app_master_key"

begin_env_output "$WEB_ENV_FILE" "Web" "$stamp"
append_env_line "$WEB_ENV_FILE" "VITE_API_BASE_URL" "$api_public_url"

begin_env_output "$COMPOSE_ENV_FILE" "Docker Compose" "$stamp"
append_env_line "$COMPOSE_ENV_FILE" "POSTGRES_PASSWORD" "$postgres_password"
append_env_line "$COMPOSE_ENV_FILE" "DATABASE_URL" "$compose_database_url"
append_env_line "$COMPOSE_ENV_FILE" "REDIS_URL" "$compose_redis_url"
append_env_line "$COMPOSE_ENV_FILE" "JWT_SECRET" "$jwt_secret"
append_env_line "$COMPOSE_ENV_FILE" "APP_MASTER_KEY" "$app_master_key"
append_env_line "$COMPOSE_ENV_FILE" "OPENAI_MODEL" "$openai_model"
append_env_line "$COMPOSE_ENV_FILE" "WEB_ORIGIN" "$web_origin"
append_env_line "$COMPOSE_ENV_FILE" "VITE_API_BASE_URL" "$api_public_url"
append_env_line "$COMPOSE_ENV_FILE" "AGENT_INSTALL_ENABLED" "$agent_install_enabled"
append_env_line "$COMPOSE_ENV_FILE" "AGENT_BINARY_STORE_ROOT" "$agent_binary_store_root"
append_env_line "$COMPOSE_ENV_FILE" "AGENT_BINARY_DEFAULT_VERSION" "$agent_binary_default_version"
append_env_line "$COMPOSE_ENV_FILE" "AGENT_INSTALL_QUEUE_NAME" "$agent_install_queue_name"
append_env_line "$COMPOSE_ENV_FILE" "AGENT_INSTALL_SECRET_TTL_SEC" "$agent_install_secret_ttl_sec"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_ENABLED" "$discovery_enabled"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_AI_ENABLED" "$discovery_ai_enabled"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_INTERVAL_SEC" "600"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_AI_CATALOG_TTL_SEC" "86400"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_MAX_HOSTS_PER_RUN" "120"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_MAX_PROBES_PER_HOST" "12"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_AUTO_UPSERT" "true"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_CONFIDENCE_THRESHOLD" "0.75"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_SUBNET_ENABLED" "false"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_SUBNET_SCHEDULED" "false"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_SUBNET_SCHEDULED_WRITE_APPROVED" "false"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_SUBNET_DEFAULT_CIDRS" "10.0.0.0/24,172.16.0.0/24,192.168.1.0/24"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_SUBNET_MAX_HOSTS" "512"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_SUBNET_CONCURRENCY" "24"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_SUBNET_CONNECT_TIMEOUT_MS" "750"
append_env_line "$COMPOSE_ENV_FILE" "DISCOVERY_SUBNET_MCP_TOOL_TIMEOUT_MS" "120000"
append_env_line "$COMPOSE_ENV_FILE" "RETENTION_DAYS" "30"

echo
log "Done."
if [[ "$DRY_RUN" != "true" ]]; then
  log "Wrote:"
  log "  - ${API_ENV_FILE}"
  log "  - ${WORKER_ENV_FILE}"
  log "  - ${WEB_ENV_FILE}"
  log "  - ${COMPOSE_ENV_FILE}"
fi
log "Admin password is configured from the web UI on first start."
log "Configure the OpenAI API key later in Settings if you want model-backed AI features."
log "Web origin: ${web_origin}"
log "Browser API URL: ${api_public_url}"
if [[ "$agent_install_enabled" == "true" ]]; then
  log "Agent install binaries are read from ${agent_binary_store_root}/<version>/labagent-<platform> inside the API container."
fi

if [[ "$DRY_RUN" != "true" ]]; then
  echo
  echo "Next steps:"
  echo "  1) docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml config"
  echo "  2) docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml up -d --build"
fi
