// Platform (super-admin) console — Enterprise Edition.
// This is the community-edition stub: the full cross-tenant console (org
// management, MRR overview, impersonation, audit) ships with OpsCat Cloud.
// See docs/OPEN-CORE.md for where the open-core line is drawn.
import React from 'react';

export default function SuperAdmin() {
  return (
    <div style={{ padding: 32, maxWidth: 560 }}>
      <h2 style={{ marginBottom: 12 }}>Platform console</h2>
      <p style={{ color: 'var(--text2)', lineHeight: 1.6 }}>
        The cross-tenant platform console is part of the OpsCat Enterprise
        Edition and is not included in the community core. Self-hosted
        community deployments are single-organization and do not need it —
        every feature of the monitoring platform itself is available under{' '}
        <span className="mono">Settings</span>.
      </p>
      <p style={{ color: 'var(--text3)', marginTop: 12, fontSize: 12 }}>
        Managed multi-tenant hosting is available at{' '}
        <a href="https://opscat.io" target="_blank" rel="noreferrer">opscat.io</a>.
      </p>
    </div>
  );
}
