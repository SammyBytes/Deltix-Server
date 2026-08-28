#!/usr/bin/env bash
# ==============================================================================
# Deltix-Server one-line bootstrap installer.
#
# Downloads the source tarball for a Deltix-Server release (the latest one
# by default) and runs scripts/install.sh against it, so a brand-new machine
# with nothing installed can go from zero to a running service with a single
# command:
#
#   curl -fsSL https://raw.githubusercontent.com/SammyBytes/Deltix-Server/main/scripts/get-deltix.sh | sudo bash
#
# To pin a specific version instead of the latest release:
#
#   curl -fsSL https://raw.githubusercontent.com/SammyBytes/Deltix-Server/main/scripts/get-deltix.sh | sudo VERSION=0.5.0 bash
#
# This script only downloads and extracts; scripts/install.sh (run
# afterwards) is the one that installs Bun, the pinned Dolt version, creates
# the service account, and runs the configuration wizard. Pass --unattended
# through to it via UNATTENDED=true if you want a fully non-interactive run.
# ==============================================================================

set -euo pipefail

REPO="SammyBytes/Deltix-Server"
VERSION="${VERSION:-}"
UNATTENDED="${UNATTENDED:-false}"

log_info()  { echo "[INFO]  $*"; }
log_error() { echo "[ERROR] $*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  log_error "This script must be run as root or with sudo (it installs a system service)."
  exit 1
fi

for cmd in curl tar; do
  command -v "${cmd}" >/dev/null 2>&1 || { log_error "Required command '${cmd}' not found."; exit 1; }
done

if [ -z "${VERSION}" ]; then
  log_info "No VERSION set, resolving latest release tag..."
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/')"
  if [ -z "${VERSION}" ]; then
    log_error "Could not resolve the latest release tag. Set VERSION=x.y.z explicitly and retry."
    exit 1
  fi
fi

TAG="v${VERSION#v}"
VERSION="${TAG#v}"
ASSET="deltix-server-${VERSION}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

log_info "Downloading ${ASSET} (${TAG})..."
if ! curl -fsSL -o "${WORK_DIR}/${ASSET}" "${URL}"; then
  log_error "Failed to download ${URL}"
  log_error "Check available releases at https://github.com/${REPO}/releases"
  exit 1
fi

log_info "Extracting..."
tar -xzf "${WORK_DIR}/${ASSET}" -C "${WORK_DIR}"

SOURCE_DIR="${WORK_DIR}/deltix-server-${VERSION}"
if [ ! -f "${SOURCE_DIR}/scripts/install.sh" ]; then
  log_error "Extracted archive is missing scripts/install.sh -- unexpected tarball layout."
  exit 1
fi

log_info "Running the installer from ${SOURCE_DIR}..."
chmod +x "${SOURCE_DIR}/scripts/install.sh"
if [ "${UNATTENDED}" = "true" ]; then
  UNATTENDED=true "${SOURCE_DIR}/scripts/install.sh" --unattended
else
  "${SOURCE_DIR}/scripts/install.sh"
fi
