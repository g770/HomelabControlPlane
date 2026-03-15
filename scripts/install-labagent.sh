#!/usr/bin/env bash
# Copyright (c) 2026 Homelab Control Plane contributors
# SPDX-License-Identifier: MIT
#
# This script automates install labagent tasks for the project.
set -euo pipefail

# Installs and enrolls labagent on a host, then starts it (systemd by default).

PREBUILT_BINARY=""
UNINSTALL_MODE="false"
SERVICE_NAME_OVERRIDE=""
NON_INTERACTIVE="false"
RUN_MODE_OVERRIDE=""
CONTROL_PLANE_OVERRIDE=""
ENROLLMENT_TOKEN_OVERRIDE=""
MCP_BIND_OVERRIDE=""
MCP_PORT_OVERRIDE=""
MCP_ADVERTISE_URL_OVERRIDE=""
STATE_FILE_OVERRIDE=""
ALLOWED_ORIGINS_OVERRIDE=""
ALLOW_INSECURE_DEV_OVERRIDE=""
INSTALL_PATH_OVERRIDE=""
REPLACE_EXISTING_OVERRIDE="true"
TMP_BINARY=""

# Implements cleanup tmp binary.
cleanup_tmp_binary() {
  local path="${TMP_BINARY:-}"
  if [[ -n "$path" && -e "$path" ]]; then
    rm -f "$path"
  fi
}

# Implements prompt.
prompt() {
  local label="$1"
  local default_value="${2:-}"
  local value
  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " value
    echo "${value:-$default_value}"
  else
    read -r -p "$label: " value
    echo "$value"
  fi
}

# Implements prompt secret.
prompt_secret() {
  local label="$1"
  local value
  read -r -s -p "$label: " value
  echo
  echo "$value"
}

# Implements prompt yes no.
prompt_yes_no() {
  local label="$1"
  local default_choice="${2:-y}"
  local response
  local suffix="[y/N]"
  if [[ "$default_choice" == "y" ]]; then
    suffix="[Y/n]"
  fi

  read -r -p "$label $suffix: " response
  response="$(echo "$response" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$response" ]]; then
    response="$default_choice"
  fi
  [[ "$response" == "y" || "$response" == "yes" ]]
}

# Implements require cmd.
require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

# Implements normalize base url.
normalize_base_url() {
  local raw="$1"
  # Trim trailing slash so downstream URL joins are stable.
  echo "${raw%/}"
}

# Implements validate base url format.
validate_base_url_format() {
  local url="$1"
  if [[ ! "$url" =~ ^https?://[^[:space:]]+$ ]]; then
    return 1
  fi
  return 0
}

# Implements verify control plane url.
verify_control_plane_url() {
  local base_url="$1"
  local timeout_seconds=8
  local url code
  local candidates=("${base_url}/api" "${base_url}/api/auth/login" "${base_url}")

  for url in "${candidates[@]}"; do
    code="$(curl -k -sS -o /dev/null -m "$timeout_seconds" -w '%{http_code}' "$url" || true)"
    if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then
      echo "Control plane reachable at: $url (HTTP $code)"
      return 0
    fi
  done

  echo "Control plane URL is not reachable: $base_url" >&2
  echo "Tried: ${candidates[*]}" >&2
  echo "Verify DNS/routing/firewall and that the API is running, then retry." >&2
  return 1
}

# Implements detect default advertise host.
detect_default_advertise_host() {
  if command -v hostname >/dev/null 2>&1; then
    local ips
    ips="$(hostname -I 2>/dev/null || true)"
    if [[ -n "$ips" ]]; then
      for ip in $ips; do
        if [[ "$ip" != "127.0.0.1" && "$ip" != "::1" ]]; then
          echo "$ip"
          return
        fi
      done
    fi
  fi
  echo "127.0.0.1"
}

# Implements usage.
usage() {
  cat <<EOF
Install and enroll labagent.

Options:
  --binary <path>      Required: path to prebuilt labagent binary
  --control-plane <u>  Non-interactive control plane URL
  --enrollment-token <t> Non-interactive enrollment token
  --mcp-bind <addr>    Non-interactive MCP bind address
  --mcp-port <port>    Non-interactive MCP port
  --mcp-advertise-url <u> Non-interactive MCP advertise URL
  --state-file <p>    Non-interactive persisted agent state file path
  --allowed-origins <csv> Non-interactive allowed origins list
  --allow-insecure-dev Enable non-localhost bind without TLS
  --replace-existing   Replace any existing labagent install before enroll (default)
  --keep-existing      Skip pre-install cleanup and keep existing install artifacts
  --install-path <p>   Non-interactive binary install path
  --run-mode <mode>    One of: systemd, background
  --yes                Non-interactive mode (fail if required options are missing)
  --uninstall          Uninstall existing labagent (systemd or expected binary paths)
  --service-name <n>   Service name to uninstall (default auto-detect, fallback: labagent)
  -h, --help           Show help
EOF
}

# Implements run root.
run_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    if [[ -n "${SUDO_PASSWORD:-}" ]]; then
      printf '%s\n' "${SUDO_PASSWORD}" | sudo -S -p '' "$@"
    else
      sudo "$@"
    fi
    return
  fi
  "$@"
}

# Implements remove path if exists.
remove_path_if_exists() {
  local path="$1"
  if [[ -e "$path" ]]; then
    run_root rm -f "$path"
    echo "Removed: $path"
  fi
}

# Implements uninstall agent.
uninstall_agent() {
  echo "LabAgent uninstall"

  local found_any="false"
  local service_names=()

  if [[ -n "$SERVICE_NAME_OVERRIDE" ]]; then
    service_names+=("$SERVICE_NAME_OVERRIDE")
  fi

  if command -v systemctl >/dev/null 2>&1; then
    if [[ ${#service_names[@]} -eq 0 ]]; then
      while IFS= read -r unit_name; do
        [[ -z "$unit_name" ]] && continue
        service_names+=("${unit_name%.service}")
      done < <(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -E 'labagent.*\.service$|.*labagent.*\.service$' || true)
      if [[ -f "/etc/systemd/system/labagent.service" ]]; then
        service_names+=("labagent")
      fi
    fi

    if [[ ${#service_names[@]} -gt 0 ]]; then
      local deduped=()
      local seen=""
      local s
      for s in "${service_names[@]}"; do
        [[ -z "$s" ]] && continue
        if [[ ",$seen," != *",$s,"* ]]; then
          deduped+=("$s")
          seen="${seen},${s}"
        fi
      done
      service_names=("${deduped[@]}")
    fi

    local service_name service_file env_file exec_line exec_bin
    for service_name in "${service_names[@]}"; do
      service_file="/etc/systemd/system/${service_name}.service"
      if ! systemctl status "${service_name}" >/dev/null 2>&1 && [[ ! -f "$service_file" ]]; then
        continue
      fi

      found_any="true"
      echo "Uninstalling systemd service: ${service_name}"

      run_root systemctl disable --now "${service_name}" >/dev/null 2>&1 || true

      env_file=""
      exec_bin=""
      if [[ -f "$service_file" ]]; then
        env_file="$(awk -F= '/^EnvironmentFile=/{print $2}' "$service_file" | tail -n1 || true)"
        exec_line="$(awk -F= '/^ExecStart=/{print $2}' "$service_file" | tail -n1 || true)"
        exec_bin="$(awk '{print $1}' <<<"$exec_line" || true)"
      fi

      remove_path_if_exists "$service_file"
      if [[ -n "$env_file" ]]; then
        remove_path_if_exists "$env_file"
        local env_dir
        env_dir="$(dirname "$env_file")"
        if [[ -d "$env_dir" ]]; then
          run_root rmdir "$env_dir" >/dev/null 2>&1 || true
        fi
      fi
      if [[ -n "$exec_bin" && "$exec_bin" == *labagent* ]]; then
        remove_path_if_exists "$exec_bin"
      fi
    done

    run_root systemctl daemon-reload >/dev/null 2>&1 || true
    run_root systemctl reset-failed >/dev/null 2>&1 || true
  fi

  # Remove known default binary paths.
  local path
  for path in /usr/local/bin/labagent /usr/bin/labagent /opt/labagent/labagent; do
    if [[ -e "$path" ]]; then
      found_any="true"
      remove_path_if_exists "$path"
    fi
  done

  # Stop best-effort non-systemd background runs.
  if pgrep -f 'labagent run' >/dev/null 2>&1; then
    found_any="true"
    run_root pkill -f 'labagent run' >/dev/null 2>&1 || true
    echo "Stopped background labagent run processes."
  fi

  if [[ "$found_any" == "true" ]]; then
    echo "Uninstall complete."
  else
    echo "No labagent installation was detected."
  fi
}

# Implements main.
main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --binary)
        PREBUILT_BINARY="${2:-}"
        shift 2
        ;;
      --control-plane)
        CONTROL_PLANE_OVERRIDE="${2:-}"
        shift 2
        ;;
      --enrollment-token)
        ENROLLMENT_TOKEN_OVERRIDE="${2:-}"
        shift 2
        ;;
      --mcp-bind)
        MCP_BIND_OVERRIDE="${2:-}"
        shift 2
        ;;
      --mcp-port)
        MCP_PORT_OVERRIDE="${2:-}"
        shift 2
        ;;
      --mcp-advertise-url)
        MCP_ADVERTISE_URL_OVERRIDE="${2:-}"
        shift 2
        ;;
      --state-file)
        STATE_FILE_OVERRIDE="${2:-}"
        shift 2
        ;;
      --allowed-origins)
        ALLOWED_ORIGINS_OVERRIDE="${2:-}"
        shift 2
        ;;
      --allow-insecure-dev)
        ALLOW_INSECURE_DEV_OVERRIDE="true"
        shift
        ;;
      --replace-existing)
        REPLACE_EXISTING_OVERRIDE="true"
        shift
        ;;
      --keep-existing)
        REPLACE_EXISTING_OVERRIDE="false"
        shift
        ;;
      --install-path)
        INSTALL_PATH_OVERRIDE="${2:-}"
        shift 2
        ;;
      --run-mode)
        RUN_MODE_OVERRIDE="${2:-}"
        shift 2
        ;;
      --yes)
        NON_INTERACTIVE="true"
        shift
        ;;
      --uninstall)
        UNINSTALL_MODE="true"
        shift
        ;;
      --service-name)
        SERVICE_NAME_OVERRIDE="${2:-}"
        shift 2
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

  if [[ "$UNINSTALL_MODE" == "true" ]]; then
    require_cmd awk
    uninstall_agent
    exit 0
  fi

  require_cmd awk
  require_cmd install
  require_cmd curl

  if [[ -z "$PREBUILT_BINARY" ]]; then
    echo "--binary is required. Provide path to a prebuilt labagent binary." >&2
    usage
    exit 1
  fi

  echo "LabAgent installer"
  echo "Binary source: $PREBUILT_BINARY"
  echo

  local control_plane_url
  control_plane_url="${CONTROL_PLANE_OVERRIDE:-}"
  if [[ -z "$control_plane_url" ]]; then
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      echo "--control-plane is required in --yes mode." >&2
      exit 1
    fi
    control_plane_url="$(prompt "Control plane base URL (must be reachable from this host)" "http://control-plane.local:4000")"
  fi
  if [[ -z "$control_plane_url" ]]; then
    echo "Control plane URL is required." >&2
    exit 1
  fi
  control_plane_url="$(normalize_base_url "$control_plane_url")"
  if ! validate_base_url_format "$control_plane_url"; then
    echo "Control plane URL must start with http:// or https:// and contain no spaces." >&2
    exit 1
  fi
  if ! verify_control_plane_url "$control_plane_url"; then
    exit 1
  fi
  echo "Using control plane URL: $control_plane_url"

  local enrollment_token
  enrollment_token="${ENROLLMENT_TOKEN_OVERRIDE:-}"
  if [[ -z "$enrollment_token" ]]; then
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      echo "--enrollment-token is required in --yes mode." >&2
      exit 1
    fi
    enrollment_token="$(prompt "Enrollment token")"
  fi
  if [[ -z "$enrollment_token" ]]; then
    echo "Enrollment token is required." >&2
    exit 1
  fi

  local mcp_bind
  mcp_bind="${MCP_BIND_OVERRIDE:-}"
  if [[ -z "$mcp_bind" ]]; then
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      mcp_bind="0.0.0.0"
    else
      mcp_bind="$(prompt "MCP bind address" "0.0.0.0")"
    fi
  fi
  local mcp_port
  mcp_port="${MCP_PORT_OVERRIDE:-}"
  if [[ -z "$mcp_port" ]]; then
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      mcp_port="8081"
    else
      mcp_port="$(prompt "MCP port" "8081")"
    fi
  fi
  local default_host
  default_host="$(detect_default_advertise_host)"
  local mcp_advertise_url
  mcp_advertise_url="${MCP_ADVERTISE_URL_OVERRIDE:-}"
  if [[ -z "$mcp_advertise_url" ]]; then
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      echo "--mcp-advertise-url is required in --yes mode." >&2
      exit 1
    fi
    mcp_advertise_url="$(prompt "MCP advertise URL (what API should call)" "http://${default_host}:${mcp_port}")"
  fi

  local allowed_origins
  allowed_origins="${ALLOWED_ORIGINS_OVERRIDE:-}"
  if [[ -z "$allowed_origins" ]]; then
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      allowed_origins="http://localhost:5173"
    else
      allowed_origins="$(prompt "Allowed browser origins (comma-separated)" "http://localhost:5173")"
    fi
  fi

  local allow_insecure_dev="false"
  if [[ "$ALLOW_INSECURE_DEV_OVERRIDE" == "true" ]]; then
    allow_insecure_dev="true"
  elif [[ "$NON_INTERACTIVE" != "true" ]]; then
    if prompt_yes_no "Allow non-localhost bind without TLS (dev/homelab only)" "y"; then
      allow_insecure_dev="true"
    fi
  fi

  local install_path
  install_path="${INSTALL_PATH_OVERRIDE:-}"
  if [[ -z "$install_path" ]]; then
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      install_path="/usr/local/bin/labagent"
    else
      install_path="$(prompt "Install binary path" "/usr/local/bin/labagent")"
    fi
  fi

  local service_name
  service_name="${SERVICE_NAME_OVERRIDE:-}"
  if [[ -z "$service_name" ]]; then
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      service_name="labagent"
    else
      service_name="$(prompt "Service name" "labagent")"
    fi
  fi

  local run_mode="${RUN_MODE_OVERRIDE:-}"
  if [[ -z "$run_mode" ]]; then
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      run_mode="systemd"
    else
      if prompt_yes_no "Install and run as systemd service" "y"; then
        run_mode="systemd"
      else
        run_mode="background"
      fi
    fi
  fi

  local use_systemd="false"
  if [[ "$run_mode" == "systemd" ]]; then
    use_systemd="true"
    require_cmd systemctl
    if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
      require_cmd sudo
    fi
  elif [[ "$run_mode" != "background" ]]; then
    echo "--run-mode must be one of: systemd, background" >&2
    exit 1
  fi

  local replace_existing
  replace_existing="${REPLACE_EXISTING_OVERRIDE:-true}"
  if [[ "$replace_existing" != "true" && "$replace_existing" != "false" ]]; then
    echo "--replace-existing/--keep-existing options produced invalid state: ${replace_existing}" >&2
    exit 1
  fi

  if [[ "$replace_existing" == "true" ]]; then
    echo
    echo "Replacing existing labagent installation (if present)..."
    local previous_service_override
    previous_service_override="${SERVICE_NAME_OVERRIDE:-}"
    SERVICE_NAME_OVERRIDE="$service_name"
    if ! uninstall_agent; then
      echo "Warning: pre-install cleanup failed; continuing with install flow."
    fi
    SERVICE_NAME_OVERRIDE="$previous_service_override"
  fi

  local state_file
  state_file="${STATE_FILE_OVERRIDE:-}"
  if [[ -z "$state_file" ]]; then
    if [[ "$use_systemd" == "true" || "${EUID:-$(id -u)}" -eq 0 ]]; then
      state_file="/var/lib/homelab/agent/state.json"
    else
      local state_home
      state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
      state_file="${state_home}/homelab/agent-state.json"
    fi
  fi

  TMP_BINARY="$(mktemp /tmp/labagent.XXXXXX)"
  trap cleanup_tmp_binary EXIT

  if [[ ! -x "$PREBUILT_BINARY" ]]; then
    echo "Provided --binary is not executable: $PREBUILT_BINARY" >&2
    exit 1
  fi
  cp "$PREBUILT_BINARY" "$TMP_BINARY"

  echo "Installing binary to $install_path ..."
  if [[ "$use_systemd" == "true" ]]; then
    run_root install -m 0755 "$TMP_BINARY" "$install_path"
  else
    install -m 0755 "$TMP_BINARY" "$install_path"
  fi

  echo
  echo "Enrolling agent..."
  local enroll_args=(
    enroll
    --control-plane "$control_plane_url"
    --token "$enrollment_token"
    --mcp-bind "$mcp_bind"
    --mcp-port "$mcp_port"
    --mcp-advertise-url "$mcp_advertise_url"
    --state-file "$state_file"
    --allowed-origins "$allowed_origins"
  )
  if [[ "$allow_insecure_dev" == "true" ]]; then
    enroll_args+=(--allow-insecure-dev)
  fi

  local enroll_output
  if [[ "$use_systemd" == "true" ]]; then
    if ! enroll_output="$(run_root "$install_path" "${enroll_args[@]}" 2>&1)"; then
      echo "$enroll_output" >&2
      exit 1
    fi
  elif ! enroll_output="$("$install_path" "${enroll_args[@]}" 2>&1)"; then
    echo "$enroll_output" >&2
    exit 1
  fi
  echo "$enroll_output"

  local allow_insecure_flag=""
  if [[ "$allow_insecure_dev" == "true" ]]; then
    allow_insecure_flag="--allow-insecure-dev"
  fi

  if [[ "$use_systemd" == "true" ]]; then
    local env_dir="/etc/${service_name}"
    local env_file="${env_dir}/${service_name}.env"
    local service_file="/etc/systemd/system/${service_name}.service"
    local env_tmp
    local service_tmp
    local existing_env_control_plane
    existing_env_control_plane=""

    if [[ -f "$env_file" ]]; then
      existing_env_control_plane="$(awk -F= '/^CONTROL_PLANE=/{print $2}' "$env_file" | tail -n1 || true)"
    fi

    echo
    echo "Configuring systemd service..."
    run_root mkdir -p "$env_dir"
    if [[ -n "$existing_env_control_plane" ]]; then
      echo "Existing CONTROL_PLANE in environment file: $existing_env_control_plane"
    else
      echo "Existing CONTROL_PLANE in environment file: <not set>"
    fi
    env_tmp="$(mktemp "/tmp/${service_name}.env.XXXXXX")"
    service_tmp="$(mktemp "/tmp/${service_name}.service.XXXXXX")"

    cat >"$env_tmp" <<EOF
CONTROL_PLANE=${control_plane_url}
AGENT_STATE_FILE=${state_file}
MCP_BIND=${mcp_bind}
MCP_PORT=${mcp_port}
MCP_ADVERTISE_URL=${mcp_advertise_url}
ALLOWED_ORIGINS=${allowed_origins}
ALLOW_INSECURE_FLAG=${allow_insecure_flag}
EOF
    run_root install -m 600 "$env_tmp" "$env_file"

    cat >"$service_tmp" <<EOF
[Unit]
Description=Homelab LabAgent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${env_file}
ExecStart=${install_path} run --control-plane \${CONTROL_PLANE} --mcp-bind \${MCP_BIND} --mcp-port \${MCP_PORT} --mcp-advertise-url \${MCP_ADVERTISE_URL} --state-file \${AGENT_STATE_FILE} --allowed-origins \${ALLOWED_ORIGINS} \${ALLOW_INSECURE_FLAG}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    run_root install -m 644 "$service_tmp" "$service_file"
    rm -f "$env_tmp" "$service_tmp"

    run_root systemctl daemon-reload
    run_root systemctl enable --now "$service_name"
    echo "Service started."
    echo "Check status: sudo systemctl status ${service_name}"
    echo "View logs: sudo journalctl -u ${service_name} -f"
  else
    echo
    echo "Starting labagent in background..."
    local log_file="./${service_name}.log"
    nohup "$install_path" run \
      --control-plane "$control_plane_url" \
      --mcp-bind "$mcp_bind" \
      --mcp-port "$mcp_port" \
      --mcp-advertise-url "$mcp_advertise_url" \
      --state-file "$state_file" \
      --allowed-origins "$allowed_origins" \
      ${allow_insecure_flag} >"$log_file" 2>&1 &
    echo "Started. Logs: $log_file"
  fi

  echo
  echo "Install complete."
  echo "State file: $state_file"
  echo "Advertised MCP endpoint: ${mcp_advertise_url%/}/mcp"
}

main "$@"
