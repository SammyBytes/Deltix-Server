#!/usr/bin/env bash
# ==============================================================================
# Deltix Enterprise Control Plane - Linux Production Installer
#
# Installs Bun, a version-pinned Dolt binary, and the systemd service in one
# run. Interactive by default (prompts for port/TLS choices on a real
# terminal); pass --unattended (or set UNATTENDED=true) for scripted/CI runs,
# where every choice falls back to its environment-variable default.
# Strictly English, zero emojis, hardened security defaults.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ------------------------------------------------------------------------------
# CLI Flags
# ------------------------------------------------------------------------------
UNATTENDED="${UNATTENDED:-false}"
for arg in "$@"; do
  case "${arg}" in
    --unattended) UNATTENDED="true" ;;
    --help|-h)
      echo "Usage: sudo ./install.sh [--unattended]"
      echo "  --unattended   Skip interactive prompts; use env-var defaults (HTTP_PORT, GRPC_PORT, TLS_MODE, ...)."
      exit 0
      ;;
  esac
done

# Only prompt when actually attached to a terminal — never hang a CI job.
if [ ! -t 0 ]; then
  UNATTENDED="true"
fi

# ------------------------------------------------------------------------------
# Configuration Variables (Overridable via environment)
# ------------------------------------------------------------------------------
APP_NAME="deltix"
SERVICE_NAME="deltix.service"
INSTALL_DIR="${INSTALL_DIR:-/opt/deltix}"
DATA_DIR="${DATA_DIR:-/var/lib/deltix}"
CONFIG_DIR="${CONFIG_DIR:-/etc/deltix}"
LOG_DIR="${LOG_DIR:-/var/log/deltix}"
SERVICE_USER="${SERVICE_USER:-deltix}"
SERVICE_GROUP="${SERVICE_GROUP:-deltix}"
HTTP_PORT="${HTTP_PORT:-9090}"
GRPC_PORT="${GRPC_PORT:-50051}"
BUN_BIN="${BUN_BIN:-}"
AUTO_START="${AUTO_START:-false}"

# ------------------------------------------------------------------------------
# Logging Helpers
# ------------------------------------------------------------------------------
log_info() {
  echo "[INFO]  $*"
}

log_success() {
  echo "[SUCCESS] $*"
}

log_warn() {
  echo "[WARN]  $*"
}

log_error() {
  echo "[ERROR] $*" >&2
}

# ------------------------------------------------------------------------------
# Pre-Flight Checks
# ------------------------------------------------------------------------------
log_info "Starting Deltix installation on Linux..."

# Check root privileges
if [ "$(id -u)" -ne 0 ]; then
  log_error "This script must be executed as root or with sudo privileges."
  exit 1
fi

# Check systemd availability
if [ ! -d /run/systemd/system ]; then
  log_error "systemd init system was not detected. This installer requires systemd."
  exit 1
fi

# Detect architecture
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64)
    log_info "Detected x86_64 architecture."
    ;;
  aarch64|arm64)
    log_info "Detected aarch64 (ARM64) architecture."
    ;;
  *)
    log_warn "Unverified architecture: ${ARCH}. Proceeding with standard installation."
    ;;
esac

# ------------------------------------------------------------------------------
# Bun Runtime Detection / Installation
# ------------------------------------------------------------------------------
if [ -z "${BUN_BIN}" ]; then
  if command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  elif [ -x /usr/local/bin/bun ]; then
    BUN_BIN="/usr/local/bin/bun"
  elif [ -x /root/.bun/bin/bun ]; then
    BUN_BIN="/root/.bun/bin/bun"
  fi
fi

if [ -z "${BUN_BIN}" ] || [ ! -x "${BUN_BIN}" ]; then
  log_info "Bun runtime not found in PATH. Installing Bun..."
  export BUN_INSTALL="/usr/local"
  curl -fsSL https://bun.sh/install | bash
  BUN_BIN="/usr/local/bin/bun"
fi

if [ ! -x "${BUN_BIN}" ]; then
  log_error "Failed to locate or install executable Bun binary."
  exit 1
fi

BUN_VER="$(${BUN_BIN} --version || echo "unknown")"
log_info "Using Bun runtime: ${BUN_BIN} (v${BUN_VER})"

# ------------------------------------------------------------------------------
# Dolt Binary — Version-Pinned Installation
#
# Deltix pins an exact Dolt release (never "latest") so a Dolt upstream
# change can never silently break a running Deltix instance on its next
# reinstall/upgrade. The pinned version lives in a single file (DOLT_VERSION)
# shipped alongside this script, so bumping it is a one-line change reviewed
# like any other release artifact.
# ------------------------------------------------------------------------------
DOLT_VERSION_FILE="${SCRIPT_DIR}/DOLT_VERSION"
if [ -f "${DOLT_VERSION_FILE}" ]; then
  PINNED_DOLT_VERSION="$(tr -d '[:space:]' < "${DOLT_VERSION_FILE}")"
else
  PINNED_DOLT_VERSION="${DOLT_VERSION:-2.3.1}"
  log_warn "DOLT_VERSION file not found next to install.sh; falling back to ${PINNED_DOLT_VERSION}."
fi

case "${ARCH}" in
  x86_64|amd64) DOLT_ARCH="amd64" ;;
  aarch64|arm64) DOLT_ARCH="arm64" ;;
  *)
    log_error "Dolt has no published release for architecture '${ARCH}'. Install Dolt ${PINNED_DOLT_VERSION} manually and re-run."
    exit 1
    ;;
esac

INSTALLED_DOLT_VERSION=""
if command -v dolt >/dev/null 2>&1; then
  INSTALLED_DOLT_VERSION="$(dolt version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "")"
fi

if [ "${INSTALLED_DOLT_VERSION}" = "${PINNED_DOLT_VERSION}" ]; then
  log_info "Dolt ${PINNED_DOLT_VERSION} already installed at $(command -v dolt) — skipping download."
else
  if [ -n "${INSTALLED_DOLT_VERSION}" ]; then
    log_warn "Found Dolt ${INSTALLED_DOLT_VERSION} in PATH, but Deltix pins ${PINNED_DOLT_VERSION}. Installing the pinned version alongside it."
  else
    log_info "Dolt binary not found. Installing pinned version ${PINNED_DOLT_VERSION}..."
  fi
  DOLT_TARBALL="dolt-linux-${DOLT_ARCH}.tar.gz"
  DOLT_URL="https://github.com/dolthub/dolt/releases/download/v${PINNED_DOLT_VERSION}/${DOLT_TARBALL}"
  DOLT_TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${DOLT_TMP_DIR}"' EXIT
  log_info "Downloading ${DOLT_URL}..."
  if ! curl -fsSL -o "${DOLT_TMP_DIR}/${DOLT_TARBALL}" "${DOLT_URL}"; then
    log_error "Failed to download Dolt ${PINNED_DOLT_VERSION} for linux-${DOLT_ARCH}."
    log_error "Check network access or install Dolt manually: https://github.com/dolthub/dolt/releases/tag/v${PINNED_DOLT_VERSION}"
    exit 1
  fi
  tar -xzf "${DOLT_TMP_DIR}/${DOLT_TARBALL}" -C "${DOLT_TMP_DIR}"
  install -d -m 755 "/opt/deltix-tools/dolt-${PINNED_DOLT_VERSION}/bin"
  install -m 755 "${DOLT_TMP_DIR}/dolt-linux-${DOLT_ARCH}/bin/dolt" "/opt/deltix-tools/dolt-${PINNED_DOLT_VERSION}/bin/dolt"
  ln -sf "/opt/deltix-tools/dolt-${PINNED_DOLT_VERSION}/bin/dolt" /usr/local/bin/dolt
  rm -rf "${DOLT_TMP_DIR}"
  trap - EXIT
  log_success "Installed Dolt ${PINNED_DOLT_VERSION} at /usr/local/bin/dolt (pinned copy in /opt/deltix-tools)."
fi

# ------------------------------------------------------------------------------
# Create Dedicated Service User & Group
# ------------------------------------------------------------------------------
if ! getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
  log_info "Creating system group '${SERVICE_GROUP}'..."
  groupadd --system "${SERVICE_GROUP}"
fi

if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  log_info "Creating system user '${SERVICE_USER}'..."
  useradd --system \
    --gid "${SERVICE_GROUP}" \
    --home-dir "${DATA_DIR}" \
    --no-create-home \
    --shell /sbin/nologin \
    --comment "Deltix Control Plane Service" \
    "${SERVICE_USER}"
fi

# ------------------------------------------------------------------------------
# Interactive Configuration Wizard
#
# Everything below has an env-var default so `--unattended` (or piping the
# script through a non-interactive shell) reproduces the exact same result
# as today with zero prompts. On a real terminal we ask instead of silently
# picking defaults, so an operator never has to hand-edit deltix.env or
# config.json after the fact for the choices that matter most: ports and
# whether this process terminates TLS itself.
# ------------------------------------------------------------------------------
TLS_MODE="${TLS_MODE:-none}"   # none | self-signed | existing
TLS_HOSTNAME="${TLS_HOSTNAME:-}"
TLS_CERT_PATH="${TLS_CERT_PATH:-}"
TLS_KEY_PATH="${TLS_KEY_PATH:-}"

if [ "${UNATTENDED}" != "true" ]; then
  echo ""
  echo "=================================================================="
  echo " Deltix Server — Interactive Setup"
  echo "=================================================================="
  read -rp "HTTP control plane port [${HTTP_PORT}]: " ANSWER
  HTTP_PORT="${ANSWER:-${HTTP_PORT}}"

  read -rp "gRPC transfer engine port [${GRPC_PORT}]: " ANSWER
  GRPC_PORT="${ANSWER:-${GRPC_PORT}}"

  echo ""
  echo "TLS for the HTTP control plane and Admin Web UI:"
  echo "  1) None — plain HTTP (fine behind a reverse proxy that already terminates TLS)"
  echo "  2) Self-signed certificate — generated now for a hostname or IP you provide"
  echo "  3) Existing certificate — point at a cert/key you already have"
  read -rp "Choose [1]: " ANSWER
  case "${ANSWER:-1}" in
    2)
      TLS_MODE="self-signed"
      read -rp "Hostname or IP this server will be reached at: " TLS_HOSTNAME
      ;;
    3)
      TLS_MODE="existing"
      read -rp "Path to certificate file (.crt/.pem): " TLS_CERT_PATH
      read -rp "Path to private key file (.key/.pem): " TLS_KEY_PATH
      ;;
    *)
      TLS_MODE="none"
      ;;
  esac

  echo ""
  read -rp "Start the deltix.service now after installation? [y/N]: " ANSWER
  case "${ANSWER:-n}" in
    y|Y|yes|Yes) AUTO_START="true" ;;
    *) AUTO_START="${AUTO_START:-false}" ;;
  esac
  echo "=================================================================="
  echo ""
fi

if [ "${TLS_MODE}" = "self-signed" ] && [ -z "${TLS_HOSTNAME}" ]; then
  log_error "TLS_MODE=self-signed requires TLS_HOSTNAME (hostname or IP) to be set."
  exit 1
fi
if [ "${TLS_MODE}" = "existing" ] && { [ -z "${TLS_CERT_PATH}" ] || [ -z "${TLS_KEY_PATH}" ]; }; then
  log_error "TLS_MODE=existing requires both TLS_CERT_PATH and TLS_KEY_PATH to be set."
  exit 1
fi

# ------------------------------------------------------------------------------
# Directory Setup & Hardening
# ------------------------------------------------------------------------------
log_info "Creating directory layout..."

mkdir -p "${INSTALL_DIR}"
mkdir -p "${DATA_DIR}"/{keys,db,staging,repos,certs}
mkdir -p "${CONFIG_DIR}"
mkdir -p "${LOG_DIR}"

# Set permissions
chmod 755 "${INSTALL_DIR}"
chmod 750 "${DATA_DIR}" "${DATA_DIR}/keys" "${DATA_DIR}/db" "${DATA_DIR}/staging" "${DATA_DIR}/repos" "${DATA_DIR}/certs"
chmod 750 "${CONFIG_DIR}"
chmod 750 "${LOG_DIR}"

chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${DATA_DIR}" "${CONFIG_DIR}" "${LOG_DIR}"

# ------------------------------------------------------------------------------
# Copy Application Files
# ------------------------------------------------------------------------------
log_info "Syncing application files from ${SCRIPT_DIR} to ${INSTALL_DIR}..."

if [ -d "${SCRIPT_DIR}/src" ]; then
  cp -r "${SCRIPT_DIR}/src" "${INSTALL_DIR}/"
  cp -r "${SCRIPT_DIR}/package.json" "${INSTALL_DIR}/" 2>/dev/null || true
  cp -r "${SCRIPT_DIR}/tsconfig.json" "${INSTALL_DIR}/" 2>/dev/null || true
  cp -r "${SCRIPT_DIR}/scripts" "${INSTALL_DIR}/" 2>/dev/null || true
  cp -r "${SCRIPT_DIR}/DOLT_VERSION" "${INSTALL_DIR}/" 2>/dev/null || true
  if [ -f "${SCRIPT_DIR}/bun.lock" ]; then
    cp "${SCRIPT_DIR}/bun.lock" "${INSTALL_DIR}/"
  fi
  if [ -d "${SCRIPT_DIR}/packages" ]; then
    cp -r "${SCRIPT_DIR}/packages" "${INSTALL_DIR}/"
  fi
  if [ -d "${SCRIPT_DIR}/proto" ]; then
    cp -r "${SCRIPT_DIR}/proto" "${INSTALL_DIR}/"
  fi
fi

# Install dependencies if node_modules missing
if [ ! -d "${INSTALL_DIR}/node_modules" ]; then
  log_info "Installing production dependencies with Bun..."
  (cd "${INSTALL_DIR}" && "${BUN_BIN}" install --production)
fi

chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}"

# ------------------------------------------------------------------------------
# TLS Certificate (only if the wizard/env selected self-signed or existing)
# ------------------------------------------------------------------------------
RESOLVED_TLS_CERT_PATH=""
RESOLVED_TLS_KEY_PATH=""
if [ "${TLS_MODE}" = "self-signed" ]; then
  log_info "Generating a self-signed TLS certificate for '${TLS_HOSTNAME}'..."
  (cd "${INSTALL_DIR}" && "${BUN_BIN}" run scripts/generate-server-tls-cert.ts "${TLS_HOSTNAME}" "${DATA_DIR}/certs")
  RESOLVED_TLS_CERT_PATH="${DATA_DIR}/certs/server.crt"
  RESOLVED_TLS_KEY_PATH="${DATA_DIR}/certs/server.key"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${RESOLVED_TLS_CERT_PATH}" "${RESOLVED_TLS_KEY_PATH}"
  chmod 640 "${RESOLVED_TLS_CERT_PATH}" "${RESOLVED_TLS_KEY_PATH}"
elif [ "${TLS_MODE}" = "existing" ]; then
  RESOLVED_TLS_CERT_PATH="${TLS_CERT_PATH}"
  RESOLVED_TLS_KEY_PATH="${TLS_KEY_PATH}"
fi

# ------------------------------------------------------------------------------
# Generate Configuration Files
# ------------------------------------------------------------------------------
CONFIG_FILE="${CONFIG_DIR}/config.json"
ENV_FILE="${CONFIG_DIR}/deltix.env"

if [ ! -f "${CONFIG_FILE}" ]; then
  log_info "Generating initial configuration: ${CONFIG_FILE}"
  if [ "${TLS_MODE}" != "none" ]; then
    TLS_JSON_BLOCK="{
      \"enabled\": true,
      \"certPath\": \"${RESOLVED_TLS_CERT_PATH}\",
      \"keyPath\": \"${RESOLVED_TLS_KEY_PATH}\",
      \"autoGenerate\": false
    }"
  else
    TLS_JSON_BLOCK="{
      \"enabled\": false,
      \"autoGenerate\": false
    }"
  fi
  cat <<EOF > "${CONFIG_FILE}"
{
  "environment": "production",
  "server": {
    "host": "0.0.0.0",
    "port": ${HTTP_PORT},
    "grpcPort": ${GRPC_PORT},
    "dynamicPort": false,
    "tls": ${TLS_JSON_BLOCK}
  },
  "storage": {
    "dataDir": "${DATA_DIR}",
    "stagingRootPath": "${DATA_DIR}/staging",
    "doltReposRootPath": "${DATA_DIR}/repos",
    "nasSimPath": "${DATA_DIR}/nas-sim"
  },
  "database": {
    "userDbPath": "${DATA_DIR}/db/users.db",
    "repoDbPath": "${DATA_DIR}/db/repos.db",
    "ticketDbPath": "${DATA_DIR}/db/transfer-tickets.db",
    "transferJobDbPath": "${DATA_DIR}/db/transfer-jobs.db",
    "addonTrustDbPath": "${DATA_DIR}/db/addon-trust.db",
    "sessionDbPath": "${DATA_DIR}/db/sessions.db"
  },
  "auth": {
    "sessionTtlSeconds": 120,
    "accessTokenTtlSeconds": 900,
    "corsAllowedOrigins": [],
    "adminUiEnabled": true
  },
  "logging": {
    "level": "info",
    "pretty": false
  }
}
EOF
  chmod 640 "${CONFIG_FILE}"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${CONFIG_FILE}"
fi

if [ ! -f "${ENV_FILE}" ]; then
  log_info "Generating environment variables file: ${ENV_FILE}"
  cat <<EOF > "${ENV_FILE}"
# Deltix Environment Configuration
NODE_ENV=production
APP_ENV=production
APP_CONFIG_PATH=${CONFIG_FILE}
APP_DATA_DIR=${DATA_DIR}
APP_PORT=${HTTP_PORT}
APP_GRPC_PORT=${GRPC_PORT}
APP_ADMIN_UI_ENABLED=true
APP_LOG_LEVEL=info
APP_LOG_PRETTY=false
EOF
  chmod 600 "${ENV_FILE}"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${ENV_FILE}"
fi

# ------------------------------------------------------------------------------
# Generate systemd Service Unit
# ------------------------------------------------------------------------------
SYSTEMD_UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}"
log_info "Installing systemd service unit: ${SYSTEMD_UNIT_PATH}"

cat <<EOF > "${SYSTEMD_UNIT_PATH}"
[Unit]
Description=Deltix Enterprise Control Plane
Documentation=https://github.com/SammyBytes/Deltix-Server
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-${ENV_FILE}
ExecStart=${BUN_BIN} run src/index.ts
Restart=always
RestartSec=5s
KillMode=process
TimeoutStopSec=30s

# Security Hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictRealtime=true
LimitNOFILE=65536

# Output Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=deltix

[Install]
WantedBy=multi-user.target
EOF

chmod 644 "${SYSTEMD_UNIT_PATH}"

log_info "Reloading systemd daemon..."
systemctl daemon-reload

log_info "Enabling ${SERVICE_NAME} to start on boot..."
systemctl enable "${SERVICE_NAME}"

if [ "${AUTO_START}" = "true" ]; then
  log_info "Starting ${SERVICE_NAME}..."
  systemctl start "${SERVICE_NAME}"
fi

# ------------------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------------------
log_success "Deltix installation completed successfully."
echo "=================================================================="
echo " Deltix Enterprise Control Plane - Installation Summary"
echo "=================================================================="
echo " Service Name:        ${SERVICE_NAME}"
echo " Bun Executable:      ${BUN_BIN}"
echo " Install Directory:   ${INSTALL_DIR}"
echo " Data Directory:      ${DATA_DIR}"
echo " Config Directory:    ${CONFIG_DIR}"
echo " Config File:         ${CONFIG_FILE}"
echo " Environment File:    ${ENV_FILE}"
echo " Service User/Group:  ${SERVICE_USER}:${SERVICE_GROUP}"
echo " HTTP Port:           ${HTTP_PORT}"
echo " gRPC Port:           ${GRPC_PORT}"
echo " Dolt Version:        ${PINNED_DOLT_VERSION} (pinned)"
echo " TLS:                 ${TLS_MODE}"
echo "=================================================================="
echo "Next Steps:"
if [ "${AUTO_START}" = "true" ]; then
  echo " 1. Service is already running. Check status: systemctl status ${SERVICE_NAME}"
else
  echo " 1. Start the service:          systemctl start ${SERVICE_NAME}"
fi
echo " 2. Open the Admin Web UI:      http$( [ "${TLS_MODE}" != "none" ] && echo "s" )://<this-host>:${HTTP_PORT}/admin"
echo "    (first visit creates the initial administrator account)"
echo " 3. View service logs:          journalctl -u ${SERVICE_NAME} -f"
echo " 4. Run system diagnostics:     cd ${INSTALL_DIR} && ${BUN_BIN} run src/cli/commands.ts doctor"
echo "=================================================================="
