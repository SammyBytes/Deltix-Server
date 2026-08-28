#!/usr/bin/env bash
# ==============================================================================
# Deltix Enterprise Control Plane - Linux Production Installer
#
# Unattended installation and systemd service configuration for Bun v1.4.
# Strictly English, zero emojis, hardened security defaults.
# ==============================================================================

set -euo pipefail

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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log_info "Syncing application files from ${SCRIPT_DIR} to ${INSTALL_DIR}..."

if [ -d "${SCRIPT_DIR}/src" ]; then
  cp -r "${SCRIPT_DIR}/src" "${INSTALL_DIR}/"
  cp -r "${SCRIPT_DIR}/package.json" "${INSTALL_DIR}/" 2>/dev/null || true
  cp -r "${SCRIPT_DIR}/tsconfig.json" "${INSTALL_DIR}/" 2>/dev/null || true
  cp -r "${SCRIPT_DIR}/scripts" "${INSTALL_DIR}/" 2>/dev/null || true
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
# Generate Configuration Files
# ------------------------------------------------------------------------------
CONFIG_FILE="${CONFIG_DIR}/config.json"
ENV_FILE="${CONFIG_DIR}/deltix.env"

if [ ! -f "${CONFIG_FILE}" ]; then
  log_info "Generating initial configuration: ${CONFIG_FILE}"
  cat <<EOF > "${CONFIG_FILE}"
{
  "environment": "production",
  "server": {
    "host": "0.0.0.0",
    "port": ${HTTP_PORT},
    "grpcPort": ${GRPC_PORT},
    "dynamicPort": false,
    "tls": {
      "enabled": false,
      "autoGenerate": false
    }
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
echo "=================================================================="
echo "Next Steps:"
echo " 1. Start the service:          systemctl start ${SERVICE_NAME}"
echo " 2. Check service status:       systemctl status ${SERVICE_NAME}"
echo " 3. View service logs:          journalctl -u ${SERVICE_NAME} -f"
echo " 4. Run system diagnostics:     cd ${INSTALL_DIR} && ${BUN_BIN} run src/cli/commands.ts doctor"
echo "=================================================================="
