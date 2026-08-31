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

# Node/gRPC and Bun refuse to use an IP address as a TLS server name (SNI), so
# a server reached only by its bare IP would be unverifiable by the CLI. When
# that happens we put a *real*, machine-specific DNS-style name in the
# certificate's SAN that every client can present as its server-name override.
# We never hard-code one: we auto-detect this host's FQDN (falling back to the
# short hostname) -- unique per server, available on every company's box with
# zero configuration -- and let an operator override it via
# TLS_SERVER_NAME_OVERRIDE when their network has a specific name in mind.
TLS_SERVER_NAME_OVERRIDE="${TLS_SERVER_NAME_OVERRIDE:-$(hostname -f 2>/dev/null || hostname)}"

is_ip() {
  # matches IPv4 (a.b.c.d) or anything containing ':' (IPv6)
  [ -z "$1" ] && return 1
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || [[ "$1" == *:* ]]
}

# ------------------------------------------------------------------------------
# Persisted TLS choice — so an upgrade re-run does not ask for the certificate
# paths all over again. The first time TLS credentials are configured we write
# a small state file ($CONFIG_DIR/.tls-state) recording the mode and the cert
# paths. On later runs the wizard can offer those same paths as the default,
# avoiding the manual path re-entry on every update.
# ------------------------------------------------------------------------------
TLS_STATE_FILE="${CONFIG_DIR}/.tls-state"
declare -A PREV_TLS
load_tls_state() {
  PREV_TLS=()
  if [ -f "${TLS_STATE_FILE}" ]; then
    # shellcheck disable=SC2155
    local mode; mode="$(sed -n 's/^TLS_MODE=//p' "${TLS_STATE_FILE}" 2>/dev/null | head -n1)"
    local cert; cert="$(sed -n 's/^TLS_CERT_PATH=//p' "${TLS_STATE_FILE}" 2>/dev/null | head -n1)"
    local key; key="$(sed -n 's/^TLS_KEY_PATH=//p' "${TLS_STATE_FILE}" 2>/dev/null | head -n1)"
    local host; host="$(sed -n 's/^TLS_HOSTNAME=//p' "${TLS_STATE_FILE}" 2>/dev/null | head -n1)"
    [ -n "${mode}" ] && PREV_TLS[mode]="${mode}"
    [ -n "${host}" ] && PREV_TLS[hostname]="${host}"
    [ -n "${cert}" ] && PREV_TLS[cert]="${cert}"
    [ -n "${key}" ] && PREV_TLS[key]="${key}"
  fi
}

# Leave the persisted choice as-is by default on upgrades, so re-running the
# installer never silently tears down an existing TLS setup. Only an explicit
# user (or env-var) selection overrides it.
if [ -f "${TLS_STATE_FILE}" ]; then
  load_tls_state
  if [ -z "${TLS_MODE}" ] || [ "${TLS_MODE}" = "none" ]; then
    TLS_MODE="${PREV_TLS[mode]:-none}"
  fi
  [ -n "${PREV_TLS[hostname]:-}" ] && TLS_HOSTNAME="${TLS_HOSTNAME:-${PREV_TLS[hostname]}}"
  [ -n "${PREV_TLS[cert]:-}" ] && TLS_CERT_PATH="${TLS_CERT_PATH:-${PREV_TLS[cert]}}"
  [ -n "${PREV_TLS[key]:-}" ] && TLS_KEY_PATH="${TLS_KEY_PATH:-${PREV_TLS[key]}}"
fi

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
  if [ -n "${TLS_CERT_PATH}" ] && [ -n "${TLS_KEY_PATH}" ]; then
    echo "  (Previously used certificate paths are remembered)"
  fi
  echo "  1) None — plain HTTP (fine behind a reverse proxy that already terminates TLS)"
  echo "  2) Self-signed certificate — generated now for a hostname or IP you provide"
  echo "  3) Existing certificate — point at a cert/key you already have"
  TLS_OPT_DEFAULT="${TLS_MODE}"
  case "${TLS_OPT_DEFAULT}" in
    self-signed) TLS_OPT_DEFAULT="2" ;;
    existing) TLS_OPT_DEFAULT="3" ;;
    *) TLS_OPT_DEFAULT="1" ;;
  esac
  read -rp "Choose [${TLS_OPT_DEFAULT}]: " ANSWER
  case "${ANSWER:-${TLS_OPT_DEFAULT}}" in
    2)
      TLS_MODE="self-signed"
      if [ -n "${TLS_HOSTNAME}" ]; then
        read -rp "Hostname or IP this server will be reached at [${TLS_HOSTNAME}]: " ANSWER
        TLS_HOSTNAME="${ANSWER:-${TLS_HOSTNAME}}"
      else
        read -rp "Hostname or IP this server will be reached at: " TLS_HOSTNAME
      fi
      ;;
    3)
      TLS_MODE="existing"
      if [ -n "${TLS_CERT_PATH}" ] && [ -n "${TLS_KEY_PATH}" ]; then
        echo "  Reusing previously configured certificate credentials:"
        echo "    Cert: ${TLS_CERT_PATH}"
        echo "    Key : ${TLS_KEY_PATH}"
        read -rp "Reuse these paths, or enter new ones? [r/N]: " ANSWER
        case "${ANSWER:-n}" in
          r|R|reuse|Reuse|yes|Yes|y|Y)
            TLS_CERT_PATH="${PREV_TLS[cert]}"
            TLS_KEY_PATH="${PREV_TLS[key]}"
            ;;
          *)
            read -rp "Path to certificate file (.crt/.pem) [${TLS_CERT_PATH}]: " CERT_ANSWER
            TLS_CERT_PATH="${CERT_ANSWER:-${TLS_CERT_PATH}}"
            read -rp "Path to private key file (.key/.pem) [${TLS_KEY_PATH}]: " KEY_ANSWER
            TLS_KEY_PATH="${KEY_ANSWER:-${TLS_KEY_PATH}}"
            ;;
        esac
      else
        read -rp "Path to certificate file (.crt/.pem): " TLS_CERT_PATH
        read -rp "Path to private key file (.key/.pem): " TLS_KEY_PATH
      fi
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
# Ensure the service user has a global Dolt identity.
#
# Why this lives outside the first-install block below: every `dolt init`
# the server runs (most importantly `RepoProvisioningService` when an operator
# creates a repo through the API) refuses to proceed without a configured
# `user.name`/`user.email` and exits 1 with "empty ident name not allowed".
# That surfaced as a generic 500 "Failed to provision repo" on the client.
#
# Two earlier mistakes combined to produce the bug:
#   1. The two `dolt config --global` calls lived INSIDE the
#      `if [ ! -f "${ENV_FILE}" ]` block, so they only ran on first install
#      — reinstall/upgrade paths never re-asserted the identity.
#   2. They ran as root (install.sh's UID), so the identity landed in
#      /root/.doltconfig, NOT in /var/lib/deltix/.doltconfig where the
#      systemd service actually looks for it (it runs as the service user).
#
# Run as the service user with `-H` so HOME is forced to /var/lib/deltix;
# `dolt config --global --add` is idempotent so it's safe on every run.
# ------------------------------------------------------------------------------
ensure_dolt_identity_for_service_user() {
  local as_user="${SERVICE_USER}"
  sudo -u "${as_user}" -H dolt config --global --add user.name deltix-server 2>/dev/null || true
  sudo -u "${as_user}" -H dolt config --global --add user.email deltix-server@localhost 2>/dev/null || true
}
ensure_dolt_identity_for_service_user

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
  # A small number of transitive dependencies (e.g. protobufjs, pulled in by
  # @grpc/proto-loader) run a `postinstall` script that shells out to a
  # literal `node` binary, not `bun`. On a machine where only Bun was ever
  # installed (the whole point of this installer), `node` does not exist and
  # `bun install` fails with "node: command not found" / "exited with 127".
  # Bun is a drop-in `node` replacement for this purpose, so if there is no
  # real Node.js already on PATH, point a throwaway `node` shim at Bun just
  # for the duration of this install -- it is not left behind afterward.
  NODE_SHIM=""
  if ! command -v node >/dev/null 2>&1; then
    NODE_SHIM="$(mktemp -d)/node"
    ln -s "${BUN_BIN}" "${NODE_SHIM}"
    log_info "No system Node.js found; using Bun as a temporary 'node' shim for postinstall scripts (e.g. protobufjs)."
  fi

  log_info "Installing production dependencies with Bun..."
  (
    if [ -n "${NODE_SHIM}" ]; then
      export PATH="$(dirname "${NODE_SHIM}"):${PATH}"
    fi
    cd "${INSTALL_DIR}" && "${BUN_BIN}" install --production
  )

  if [ -n "${NODE_SHIM}" ]; then
    rm -rf "$(dirname "${NODE_SHIM}")"
  fi
fi

chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}"

# ------------------------------------------------------------------------------
# TLS Certificate (only if the wizard/env selected self-signed or existing)
# ------------------------------------------------------------------------------
RESOLVED_TLS_CERT_PATH=""
RESOLVED_TLS_KEY_PATH=""
if [ "${TLS_MODE}" = "self-signed" ]; then
  log_info "Generating a self-signed TLS certificate for '${TLS_HOSTNAME}'..."
  if is_ip "${TLS_HOSTNAME}"; then
    # A bare-IP host needs a DNS-style name in the SAN so the CLI (gRPC/Node)
    # can verify the server with a non-IP server-name override.
    (cd "${INSTALL_DIR}" && "${BUN_BIN}" run scripts/generate-server-tls-cert.ts "${TLS_HOSTNAME}" "${TLS_SERVER_NAME_OVERRIDE}" "${DATA_DIR}/certs")
  else
    (cd "${INSTALL_DIR}" && "${BUN_BIN}" run scripts/generate-server-tls-cert.ts "${TLS_HOSTNAME}" "${DATA_DIR}/certs")
  fi
  RESOLVED_TLS_CERT_PATH="${DATA_DIR}/certs/server.crt"
  RESOLVED_TLS_KEY_PATH="${DATA_DIR}/certs/server.key"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${RESOLVED_TLS_CERT_PATH}" "${RESOLVED_TLS_KEY_PATH}"
  chmod 640 "${RESOLVED_TLS_CERT_PATH}" "${RESOLVED_TLS_KEY_PATH}"
elif [ "${TLS_MODE}" = "existing" ]; then
  RESOLVED_TLS_CERT_PATH="${TLS_CERT_PATH}"
  RESOLVED_TLS_KEY_PATH="${TLS_KEY_PATH}"
fi

# Persist the chosen TLS mode and certificate paths so the next install/upgrade
# run can offer them back as the default instead of prompting for the paths
# again. Only written when TLS credentials were actually configured.
if [ "${TLS_MODE}" != "none" ]; then
  {
    echo "# Deltix TLS state -- written by scripts/install.sh, read on the next run"
    echo "# to offer previously used certificate paths (so upgrades don't re-prompt)."
    echo "TLS_MODE=${TLS_MODE}"
    [ -n "${TLS_HOSTNAME}" ] && echo "TLS_HOSTNAME=${TLS_HOSTNAME}"
    [ -n "${TLS_SERVER_NAME_OVERRIDE:-}" ] && echo "TLS_SERVER_NAME_OVERRIDE=${TLS_SERVER_NAME_OVERRIDE}"
    [ -n "${RESOLVED_TLS_CERT_PATH}" ] && echo "TLS_CERT_PATH=${RESOLVED_TLS_CERT_PATH}"
    [ -n "${RESOLVED_TLS_KEY_PATH}" ] && echo "TLS_KEY_PATH=${RESOLVED_TLS_KEY_PATH}"
  } > "${TLS_STATE_FILE}"
  chmod 640 "${TLS_STATE_FILE}"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${TLS_STATE_FILE}"
fi

# ------------------------------------------------------------------------------
# Generate Configuration Files
# ------------------------------------------------------------------------------
CONFIG_FILE="${CONFIG_DIR}/config.json"
ENV_FILE="${CONFIG_DIR}/deltix.env"
JWT_KEYPAIR_SNIPPET="${DATA_DIR}/keys/.jwt-env-snippet"
LICENSE_SNIPPET="${DATA_DIR}/keys/.license-env-snippet"
DOLT_LICENSE_LOG_PATH="${DATA_DIR}/dolt-license-log"
GRPC_CERTS_DIR="${DATA_DIR}/certs/grpc"

# ------------------------------------------------------------------------------
# Cryptographic Material & Anti-Tamper Log (only generated once, never
# regenerated on an upgrade re-run -- this is what previously made
# deltix.env boot-broken: it only ever contained APP_* variables the
# server does not read, never the DELTIX_* secrets src/shared/env.ts
# requires at boot (license, JWT signing keys, gRPC mTLS cert, the Dolt
# anti-tamper commit log). None of this can be deferred to "edit .env by
# hand later" without breaking the installer's own promise of zero
# manual configuration steps.
# ------------------------------------------------------------------------------
if [ ! -f "${ENV_FILE}" ]; then
  log_info "Generating JWT signing keypair (Ed25519)..."
  (cd "${INSTALL_DIR}" && "${BUN_BIN}" run scripts/generate-jwt-keypair.ts) > "${JWT_KEYPAIR_SNIPPET}"

  log_info "Generating a self-signed Community license..."
  (cd "${INSTALL_DIR}" && "${BUN_BIN}" run scripts/generate-community-license.ts "$(hostname -f 2>/dev/null || hostname)") > "${LICENSE_SNIPPET}"

  log_info "Initializing the Dolt anti-tamper commit log at ${DOLT_LICENSE_LOG_PATH}..."
  mkdir -p "${DOLT_LICENSE_LOG_PATH}"
  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${DOLT_LICENSE_LOG_PATH}"
  # The identity needed for `dolt init` here is root's (this shell), so set
  # it inline rather than depending on the service-user identity written by
  # `ensure_dolt_identity_for_service_user` (that one is for the systemd
  # service process). Idempotent.
  dolt config --global --add user.name deltix-server >/dev/null 2>&1 || true
  dolt config --global --add user.email deltix-server@localhost >/dev/null 2>&1 || true
  (cd "${DOLT_LICENSE_LOG_PATH}" && dolt init) >/dev/null

  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${DOLT_LICENSE_LOG_PATH}" "${DATA_DIR}/keys"
  chmod 600 "${JWT_KEYPAIR_SNIPPET}" "${LICENSE_SNIPPET}"
fi

# The gRPC transfer engine's TLS certificate is generated whenever it is
# missing -- not just on first install. Data-plane certs live under
# ${DATA_DIR}/certs/grpc, which an operator may legitimately wipe (along with
# the HTTP certs) to force fresh ones without touching deltix.env; if that
# happens the server would otherwise fail to boot with
# 'ENOENT .../certs/grpc/server.crt'. Regenerating it only when absent keeps
# upgrades from churning a valid cert while recovering from a deleted one.
#
# In self-signed mode the gRPC engine reuses the *same* certificate as the
# HTTP control plane. The CLI trusts a single cert (fetched from the gRPC
# port) and validates the HTTP control plane with that same CA (see
# http-tls.ts), so both ports must present the identical certificate -- if
# they differ, `deltix login` fails with "self signed certificate". Existing
# installs that generated two separate certs are healed here too: whenever the
# gRPC cert is missing or differs from the HTTP cert, it is resynced to match.
GRPC_TLS_HOSTNAME="${GRPC_TLS_HOSTNAME:-${TLS_HOSTNAME:-$(hostname -f 2>/dev/null || hostname)}}"
GRPC_CERTS_NEED_REGEN=false
if [ ! -f "${GRPC_CERTS_DIR}/server.crt" ] || [ ! -f "${GRPC_CERTS_DIR}/server.key" ]; then
  GRPC_CERTS_NEED_REGEN=true
fi
if [ "${TLS_MODE}" = "self-signed" ] \
  && [ -f "${RESOLVED_TLS_CERT_PATH}" ] && [ -f "${RESOLVED_TLS_KEY_PATH}" ] \
  && ! cmp -s "${RESOLVED_TLS_CERT_PATH}" "${GRPC_CERTS_DIR}/server.crt" 2>/dev/null; then
  GRPC_CERTS_NEED_REGEN=true
fi
if [ "${GRPC_CERTS_NEED_REGEN}" = "true" ]; then
  if [ "${TLS_MODE}" = "self-signed" ] \
    && [ -f "${RESOLVED_TLS_CERT_PATH}" ] && [ -f "${RESOLVED_TLS_KEY_PATH}" ]; then
    log_info "Reusing the HTTP control plane TLS certificate for the gRPC transfer engine..."
    mkdir -p "${GRPC_CERTS_DIR}"
    cp "${RESOLVED_TLS_CERT_PATH}" "${GRPC_CERTS_DIR}/server.crt"
    cp "${RESOLVED_TLS_KEY_PATH}" "${GRPC_CERTS_DIR}/server.key"
  else
    log_info "Generating the mandatory gRPC transfer engine TLS certificate..."
    if is_ip "${GRPC_TLS_HOSTNAME}"; then
      (cd "${INSTALL_DIR}" && "${BUN_BIN}" run scripts/generate-server-tls-cert.ts "${GRPC_TLS_HOSTNAME}" "${TLS_SERVER_NAME_OVERRIDE}" "${GRPC_CERTS_DIR}")
    else
      (cd "${INSTALL_DIR}" && "${BUN_BIN}" run scripts/generate-server-tls-cert.ts "${GRPC_TLS_HOSTNAME}" "${GRPC_CERTS_DIR}")
    fi
  fi
  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${GRPC_CERTS_DIR}"
  chmod 640 "${GRPC_CERTS_DIR}/server.crt" "${GRPC_CERTS_DIR}/server.key"
fi

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
  {
    echo "# Deltix Environment Configuration -- generated once by scripts/install.sh."
    echo "# Do not regenerate by hand; re-running the installer preserves this file."
    echo "NODE_ENV=production"
    echo "APP_CONFIG_PATH=${CONFIG_FILE}"
    echo "APP_PORT=${HTTP_PORT}"
    echo ""
    echo "# --- Licensing (self-signed Community tier; no internet dependency) ---"
    cat "${LICENSE_SNIPPET}"
    echo "DELTIX_DOLT_REPO_PATH=${DOLT_LICENSE_LOG_PATH}"
    echo ""
    echo "# --- Session/access token signing ---"
    cat "${JWT_KEYPAIR_SNIPPET}"
    echo ""
    echo "# --- Data storage (all under ${DATA_DIR}, kept separate from ${INSTALL_DIR}) ---"
    echo "DELTIX_USER_DB_PATH=${DATA_DIR}/db/users.db"
    echo "DELTIX_SESSION_DB_PATH=${DATA_DIR}/db/sessions.db"
    echo "DELTIX_TICKET_DB_PATH=${DATA_DIR}/db/transfer-tickets.db"
    echo "DELTIX_TRANSFER_JOB_DB_PATH=${DATA_DIR}/db/transfer-jobs.db"
    echo "DELTIX_ADDON_TRUST_DB_PATH=${DATA_DIR}/db/addon-trust.db"
    echo "DELTIX_REPO_DB_PATH=${DATA_DIR}/db/repos.db"
    echo "DELTIX_STAGING_ROOT_PATH=${DATA_DIR}/staging"
    echo "DELTIX_DOLT_REPOS_ROOT_PATH=${DATA_DIR}/repos"
    echo "DELTIX_NAS_SIM_PATH=${DATA_DIR}/nas-sim"
    echo ""
    echo "# --- gRPC transfer engine (mandatory mTLS, self-signed cert generated above) ---"
    echo "DELTIX_GRPC_PORT=${GRPC_PORT}"
    echo "DELTIX_GRPC_TLS_CERT_PATH=${GRPC_CERTS_DIR}/server.crt"
    echo "DELTIX_GRPC_TLS_KEY_PATH=${GRPC_CERTS_DIR}/server.key"
    echo ""
    echo "# --- Admin Web UI / HTTP control plane ---"
    echo "DELTIX_ADMIN_UI_ENABLED=true"
    echo "DELTIX_CORS_ALLOWED_ORIGINS="
    if [ "${TLS_MODE}" != "none" ]; then
      echo "DELTIX_HTTP_TLS_CERT_PATH=${RESOLVED_TLS_CERT_PATH}"
      echo "DELTIX_HTTP_TLS_KEY_PATH=${RESOLVED_TLS_KEY_PATH}"
    fi
  } > "${ENV_FILE}"
  rm -f "${JWT_KEYPAIR_SNIPPET}" "${LICENSE_SNIPPET}"
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
  # `systemctl start` is a no-op when the unit is already active, which meant a
  # reinstall/upgrade left the OLD process running the previous version on disk
  # while the new files sat dormant until the next manual restart. Detect the
  # already-running case and restart so the freshly written code actually loads.
  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    log_info "Restarting running ${SERVICE_NAME} to load updated application files..."
    systemctl restart "${SERVICE_NAME}"
  else
    log_info "Starting ${SERVICE_NAME}..."
    systemctl start "${SERVICE_NAME}"
  fi
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
