'use strict';
// Core cloud-init payload for auto-provisioned sensor agents (BYO-cloud and
// the managed fleet). Self-contained variant of deploy/sensors/cloud-init
// (which is not part of the community core): installs Node, downloads the
// dependency-free agent from this OpsCat instance and runs it as an
// unprivileged systemd service in --probe mode. The probe key is scoped to one
// location and revocable; provider credentials never reach the box.

function renderCloudInit({ opscatUrl, probeKey }) {
  if (!opscatUrl) throw new Error('renderCloudInit: opscatUrl required');
  if (!probeKey) throw new Error('renderCloudInit: probeKey required');
  const url = String(opscatUrl).replace(/\/+$/, '');
  return `#cloud-config
package_update: true
packages:
  - curl
  - ca-certificates
users:
  - name: opscat
    system: true
    shell: /usr/sbin/nologin
write_files:
  - path: /etc/opscat-agent.env
    permissions: '0600'
    owner: root:root
    content: |
      OPSCAT_URL=${url}
      OPSCAT_PROBE_KEY=${probeKey}
      OPSCAT_AGENT_FLAGS=--probe
  - path: /etc/systemd/system/opscat-agent.service
    permissions: '0644'
    content: |
      [Unit]
      Description=OpsCat sensor agent (probe mode)
      After=network-online.target
      Wants=network-online.target
      [Service]
      User=opscat
      EnvironmentFile=/etc/opscat-agent.env
      ExecStart=/usr/bin/node /opt/opscat-agent/opscat-agent.js $OPSCAT_AGENT_FLAGS
      Restart=always
      RestartSec=10
      NoNewPrivileges=true
      ProtectSystem=strict
      ProtectHome=true
      AmbientCapabilities=CAP_NET_RAW
      CapabilityBoundingSet=CAP_NET_RAW
      [Install]
      WantedBy=multi-user.target
runcmd:
  - |
    set -e
    if ! command -v node >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs || apt-get install -y nodejs
    fi
    sysctl -w net.ipv4.ping_group_range="0 2147483647" || true
    mkdir -p /opt/opscat-agent
    curl -fsSL ${url}/agent/opscat-agent.js -o /opt/opscat-agent/opscat-agent.js
    systemctl daemon-reload
    systemctl enable --now opscat-agent
`;
}

module.exports = { renderCloudInit };
