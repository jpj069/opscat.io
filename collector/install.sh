#!/bin/sh
# OpsCat syslog collector installer (POSIX sh). Idempotent — safe to re-run for upgrades.
#
# Installs opscat-collector.js + syslog.js to /opt/opscat-collector/, writes
# /etc/opscat-collector.env (chmod 600) from the OPSCAT_* environment variables,
# installs + enables the systemd unit, and (re)starts the service.
#
# Usage:
#   curl -fsSL https://opscat.io/collector/install.sh | sudo \
#     OPSCAT_URL=https://opscat.io \
#     OPSCAT_COLLECTOR_KEY=ocl_xxx \
#     sh
#
# On upgrade, re-run without the OPSCAT_* vars to just refresh the code:
#   sudo sh install.sh          # keeps existing /etc/opscat-collector.env
set -eu

INSTALL_DIR=/opt/opscat-collector
ENV_FILE=/etc/opscat-collector.env
UNIT_DEST=/etc/systemd/system/opscat-collector.service
SERVICE=opscat-collector
RUN_USER=opscat-collector

SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd 2>/dev/null || echo /nonexistent)

if [ "$(id -u)" != "0" ]; then
  echo "install.sh must be run as root (use sudo)." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found in PATH. Install Node >= 18 first." >&2
  exit 1
fi

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else echo "need curl or wget to download $1" >&2; exit 1; fi
}

# Where the three files come from, and why this is not just "are they next to me".
#
# `syslog.js` is NEVER next to this script in the repository: it has exactly one
# copy, at server/src/lib/syslog.js, and the instance serves it from there. So a
# check on opscat-collector.js alone reports "everything is here", and the copy
# below then fails with `cp: cannot stat .../syslog.js` — which is what running
# this from a checkout did, on a real host, until it was tested.
#
# Three sources, in order: a complete directory next to the script, a repository
# checkout (this file lives in collector/, the parser two levels up), and the
# instance itself for the piped install.
NEED_DOWNLOAD=0
[ -f "${SRC_DIR}/opscat-collector.js" ] || NEED_DOWNLOAD=1
[ -f "${SRC_DIR}/opscat-collector.service" ] || NEED_DOWNLOAD=1
if [ ! -f "${SRC_DIR}/syslog.js" ]; then
  if [ "${NEED_DOWNLOAD}" = "0" ] && [ -f "${SRC_DIR}/../server/src/lib/syslog.js" ]; then
    # Running from a checkout: take the one copy that exists, so the installed
    # parser is the file this repository's own test suite pins.
    echo "==> Using the parser from this checkout (server/src/lib/syslog.js)"
    CHECKOUT_PARSER="${SRC_DIR}/../server/src/lib/syslog.js"
  else
    NEED_DOWNLOAD=1
  fi
fi

if [ "${NEED_DOWNLOAD}" = "1" ]; then
  if [ -z "${OPSCAT_URL:-}" ]; then
    echo "collector files not found next to install.sh — set OPSCAT_URL so they can be downloaded." >&2
    exit 1
  fi
  SRC_DIR=$(mktemp -d)
  trap 'rm -rf "${SRC_DIR}"' EXIT
  CHECKOUT_PARSER=""
  echo "==> Downloading collector files from ${OPSCAT_URL%/}/collector/"
  fetch "${OPSCAT_URL%/}/collector/opscat-collector.js" "${SRC_DIR}/opscat-collector.js"
  fetch "${OPSCAT_URL%/}/collector/syslog.js" "${SRC_DIR}/syslog.js"
  fetch "${OPSCAT_URL%/}/collector/opscat-collector.service" "${SRC_DIR}/opscat-collector.service"
fi

echo "==> Installing collector to ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
cp "${SRC_DIR}/opscat-collector.js" "${INSTALL_DIR}/opscat-collector.js"
cp "${CHECKOUT_PARSER:-${SRC_DIR}/syslog.js}" "${INSTALL_DIR}/syslog.js"
chmod 0755 "${INSTALL_DIR}/opscat-collector.js"
chmod 0644 "${INSTALL_DIR}/syslog.js"

# A process that parses unauthenticated network bytes does not run as root.
# CAP_NET_BIND_SERVICE in the unit is what lets it hold port 514 anyway.
if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
  echo "==> Creating system user ${RUN_USER}"
  useradd --system --no-create-home --shell /usr/sbin/nologin "${RUN_USER}" 2>/dev/null \
    || adduser --system --no-create-home --shell /usr/sbin/nologin "${RUN_USER}" 2>/dev/null \
    || echo "could not create ${RUN_USER}; the unit will fail until it exists" >&2
fi

# --- environment file ------------------------------------------------------
if [ -n "${OPSCAT_URL:-}${OPSCAT_COLLECTOR_KEY:-}${OPSCAT_TLS_CERT:-}${OPSCAT_TLS_KEY:-}" ]; then
  echo "==> Writing ${ENV_FILE}"
  OLD_URL=""; OLD_KEY=""; OLD_CERT=""; OLD_TLSKEY=""
  if [ -f "${ENV_FILE}" ]; then
    OLD_URL=$(sed -n 's/^OPSCAT_URL=//p' "${ENV_FILE}" | head -n1)
    OLD_KEY=$(sed -n 's/^OPSCAT_COLLECTOR_KEY=//p' "${ENV_FILE}" | head -n1)
    OLD_CERT=$(sed -n 's/^OPSCAT_TLS_CERT=//p' "${ENV_FILE}" | head -n1)
    OLD_TLSKEY=$(sed -n 's/^OPSCAT_TLS_KEY=//p' "${ENV_FILE}" | head -n1)
  fi
  URL=${OPSCAT_URL:-$OLD_URL}
  KEY=${OPSCAT_COLLECTOR_KEY:-$OLD_KEY}
  CERT=${OPSCAT_TLS_CERT:-$OLD_CERT}
  TLSKEY=${OPSCAT_TLS_KEY:-$OLD_TLSKEY}

  # The key is interpolated into a shell-sourced file, so it is validated first:
  # a value containing a newline would write a variable of its own, and
  # OPSCAT_URL is two lines below it. Same rule as the cloud-init renderer.
  if ! printf '%s' "${KEY}" | grep -Eq '^(ocl_)[a-f0-9]{16,128}$'; then
    echo "OPSCAT_COLLECTOR_KEY does not look like a collector key (ocl_…)." >&2
    exit 1
  fi

  umask 077
  cat > "${ENV_FILE}" <<EOF
# OpsCat collector configuration — managed by install.sh
OPSCAT_URL=${URL}
OPSCAT_COLLECTOR_KEY=${KEY}
OPSCAT_TLS_CERT=${CERT}
OPSCAT_TLS_KEY=${TLSKEY}
EOF
  chmod 600 "${ENV_FILE}"
  chown "${RUN_USER}" "${ENV_FILE}" 2>/dev/null || true
elif [ ! -f "${ENV_FILE}" ]; then
  echo "==> Creating empty ${ENV_FILE} (fill in OPSCAT_* values before starting)"
  umask 077
  printf '# OpsCat collector configuration\nOPSCAT_URL=\nOPSCAT_COLLECTOR_KEY=\n' > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi

echo "==> Installing systemd unit"
cp "${SRC_DIR}/opscat-collector.service" "${UNIT_DEST}"
systemctl daemon-reload
systemctl enable "${SERVICE}" >/dev/null 2>&1 || true
systemctl restart "${SERVICE}"

echo "==> Done. Follow it with:  journalctl -u ${SERVICE} -f"
