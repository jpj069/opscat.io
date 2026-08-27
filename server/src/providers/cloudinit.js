'use strict';
// Core cloud-init payload for auto-provisioned sensor agents (BYO-cloud and
// the managed fleet). Self-contained variant of deploy/sensors/cloud-init
// (which is not part of the community core): installs Node, downloads the
// dependency-free agent from this OpsCat instance and runs it as an
// unprivileged systemd service in --probe mode. The sensor key is scoped to one
// location and revocable; provider credentials never reach the box.

const { validateSshKey } = require('../lib/sshaccess');
const tokens = require('../lib/tokens');

// `sshKey` is OPTIONAL and, when present, has already been through
// `lib/sshaccess.validateSshKey` at the call site — it is validated AGAIN here
// because this is the function that writes it into a YAML document, and a
// second caller (a script, a future ops path) must not be able to skip that.
// The admin user is separate from the `opscat` service user on purpose: the
// agent keeps its nologin shell and its systemd hardening either way.
function renderCloudInit({ opscatUrl, probeKey, sshKey, agentToken }) {
  if (!opscatUrl) throw new Error('renderCloudInit: opscatUrl required');
  if (!probeKey) throw new Error('renderCloudInit: probeKey required');
  /* Both credentials are written into `/etc/opscat-agent.env` by string
   * interpolation, which is the same class of document as the cloud-init YAML
   * around it: a value carrying a newline writes a VARIABLE OF ITS OWN, and
   * `OPSCAT_URL` two lines down is the one worth stealing.
   *
   * Both are server-minted, so neither is reachable from a request today — this
   * is the same "a second caller must not be able to skip the check" reasoning
   * the ssh key gets above, and the probe key had been going in unchecked while
   * the agent token was guarded.
   *
   * `tokens.pattern('sensorKey')` accepts the legacy `ocp_` prefix as well as
   * `ocs_`: a key minted before the rename is still a valid key, and a
   * validator that refuses a credential this product issued is a worse bug
   * than the one it prevents. */
  if (!tokens.pattern('sensorKey').test(String(probeKey))) {
    throw new Error('renderCloudInit: probeKey is not a sensor key');
  }
  // One binary, two roles: the sensor key runs synthetic checks, the agent token
  // adds the host side (heartbeat, CPU/RAM/disk) so the node appears under
  // Assets like any other server we run. Optional — a node without a token is
  // exactly the sensor-only box this file has always produced.
  if (agentToken && !tokens.pattern('agentToken').test(String(agentToken))) {
    throw new Error('renderCloudInit: agentToken is not an agent token');
  }
  const url = String(opscatUrl).replace(/\/+$/, '');
  const key = sshKey ? validateSshKey(sshKey) : null;
  const admin = key ? `  - name: opscat-admin
    groups: [sudo]
    shell: /bin/bash
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    ssh_authorized_keys:
      - ${key}
` : '';
  return `#cloud-config
ssh_pwauth: false
package_update: true
packages:
  - curl
  - ca-certificates
users:
  - name: opscat
    system: true
    shell: /usr/sbin/nologin
${admin}
write_files:
  - path: /etc/opscat-agent.env
    permissions: '0600'
    owner: root:root
    content: |
      OPSCAT_URL=${url}
      OPSCAT_PROBE_KEY=${probeKey}${agentToken ? `
      OPSCAT_AGENT_TOKEN=${agentToken}` : ''}
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
