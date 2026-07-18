#!/bin/sh
# OpsCat agent installer (POSIX sh). Idempotent — safe to re-run for upgrades.
#
# Installs opscat-agent.js to /opt/opscat-agent/, writes /etc/opscat-agent.env
# (chmod 600) from the OPSCAT_* environment variables, installs + enables the
# systemd unit, and (re)starts the service.
#
# Usage:
#   sudo OPSCAT_URL=https://opscat.io \
#        OPSCAT_AGENT_TOKEN=agt_xxx \
#        OPSCAT_PROBE_KEY=prb_xxx \
#        OPSCAT_AGENT_FLAGS="--logs --probe" \
#        sh install.sh
#
# On upgrade, re-run without the OPSCAT_* vars to just refresh the script:
#   sudo sh install.sh          # keeps existing /etc/opscat-agent.env
set -eu

INSTALL_DIR=/opt/opscat-agent
ENV_FILE=/etc/opscat-agent.env
UNIT_DEST=/etc/systemd/system/opscat-agent.service
SERVICE=opscat-agent

# resolve the directory this script lives in (so it works from anywhere)
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "$(id -u)" != "0" ]; then
  echo "install.sh must be run as root (use sudo)." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found in PATH. Install Node >= 18 first." >&2
  exit 1
fi

echo "==> Installing agent to ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
cp "${SRC_DIR}/opscat-agent.js" "${INSTALL_DIR}/opscat-agent.js"
chmod 0755 "${INSTALL_DIR}/opscat-agent.js"

# --- environment file ------------------------------------------------------
# Write a fresh env file only if any OPSCAT_* var was provided; otherwise keep
# the existing one (upgrade-safe). Individual provided vars override.
if [ -n "${OPSCAT_URL:-}${OPSCAT_AGENT_TOKEN:-}${OPSCAT_PROBE_KEY:-}${OPSCAT_AGENT_FLAGS:-}" ]; then
  echo "==> Writing ${ENV_FILE}"

  # start from existing values so a partial invocation preserves the rest
  OLD_URL=""; OLD_TOKEN=""; OLD_PROBE=""; OLD_FLAGS=""
  if [ -f "${ENV_FILE}" ]; then
    # shellcheck disable=SC1090
    OLD_URL=$(sed -n 's/^OPSCAT_URL=//p' "${ENV_FILE}" | head -n1)
    OLD_TOKEN=$(sed -n 's/^OPSCAT_AGENT_TOKEN=//p' "${ENV_FILE}" | head -n1)
    OLD_PROBE=$(sed -n 's/^OPSCAT_PROBE_KEY=//p' "${ENV_FILE}" | head -n1)
    OLD_FLAGS=$(sed -n 's/^OPSCAT_AGENT_FLAGS=//p' "${ENV_FILE}" | head -n1)
  fi

  URL=${OPSCAT_URL:-$OLD_URL}
  TOKEN=${OPSCAT_AGENT_TOKEN:-$OLD_TOKEN}
  PROBE=${OPSCAT_PROBE_KEY:-$OLD_PROBE}
  FLAGS=${OPSCAT_AGENT_FLAGS:-$OLD_FLAGS}

  umask 077
  cat > "${ENV_FILE}" <<EOF
# OpsCat agent configuration — managed by install.sh
OPSCAT_URL=${URL}
OPSCAT_AGENT_TOKEN=${TOKEN}
OPSCAT_PROBE_KEY=${PROBE}
OPSCAT_AGENT_FLAGS=${FLAGS}
EOF
  chmod 600 "${ENV_FILE}"
else
  if [ ! -f "${ENV_FILE}" ]; then
    echo "==> Creating empty ${ENV_FILE} (fill in OPSCAT_* values before starting)"
    umask 077
    cat > "${ENV_FILE}" <<EOF
# OpsCat agent configuration — fill these in
OPSCAT_URL=
OPSCAT_AGENT_TOKEN=
OPSCAT_PROBE_KEY=
OPSCAT_AGENT_FLAGS=
EOF
    chmod 600 "${ENV_FILE}"
  else
    echo "==> Keeping existing ${ENV_FILE}"
  fi
fi

# --- systemd unit ----------------------------------------------------------
echo "==> Installing systemd unit to ${UNIT_DEST}"
cp "${SRC_DIR}/opscat-agent.service" "${UNIT_DEST}"
chmod 0644 "${UNIT_DEST}"

echo "==> Reloading systemd and enabling ${SERVICE}"
systemctl daemon-reload
systemctl enable "${SERVICE}" >/dev/null 2>&1 || true
systemctl restart "${SERVICE}"

echo "==> Done. Status:"
systemctl --no-pager --lines=0 status "${SERVICE}" || true
echo
echo "Logs:   journalctl -u ${SERVICE} -f"
echo "Config: ${ENV_FILE}"
