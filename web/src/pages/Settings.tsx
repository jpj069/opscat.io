// Settings — platform config, notifications, API keys, agents, SNMP targets, system info.
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../state';
import { SEV, fmtBytes, fmtDuration, relTime } from '../format';
import { Modal, Field, Toggle, StatusPill } from '../ui';
import type {
  AgentRow, ApiKeyRow, BillingStatus, PlanInfo, PlanLimits, PlansResponse,
  Settings as SettingsMap, SnmpTarget,
} from '../types';

const RANK: Record<string, number> = { analyst: 1, lead: 2, cto: 3, admin: 4 };

interface SystemInfo {
  uptimeS?: number; dbBytes?: number; nodeVersion?: string;
  counts?: { logs?: number; events?: number; cases?: number; users?: number };
}
interface SecretInfo { title: string; note: string; value: string; extra?: React.ReactNode; }

// ---------------------------------------------------------------- page

export default function Settings() {
  const app = useApp();
  const rank = RANK[app.user?.role || ''] || 0;
  const leadPlus = rank >= 2;
  const isAdmin = app.user?.role === 'admin';

  // key/value settings + edit draft
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // sub-resources
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [keysHidden, setKeysHidden] = useState(false);
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [agentsHidden, setAgentsHidden] = useState(false);
  const [targets, setTargets] = useState<SnmpTarget[] | null>(null);
  const [targetsHidden, setTargetsHidden] = useState(false);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [sysHidden, setSysHidden] = useState(false);

  // modals
  const [modal, setModal] = useState<'key' | 'agent' | 'target' | null>(null);
  const [secret, setSecret] = useState<SecretInfo | null>(null);

  const on403 = (setHidden: (v: boolean) => void, fallback: () => void) => (e: unknown) => {
    if (e instanceof ApiError && e.status === 403) setHidden(true); else fallback();
  };
  const reloadKeys = () => api.get<ApiKeyRow[]>('/api/admin/apikeys').then(setKeys).catch(() => {});
  const reloadAgents = () => api.get<AgentRow[]>('/api/admin/agents').then(setAgents).catch(() => {});
  const reloadTargets = () => api.get<SnmpTarget[]>('/api/admin/snmp/targets').then(setTargets).catch(() => {});

  useEffect(() => {
    api.get<SettingsMap>('/api/admin/settings').then(setSettings).catch(() => setSettings({}));

    if (leadPlus) {
      api.get<ApiKeyRow[]>('/api/admin/apikeys').then(setKeys)
        .catch(on403(setKeysHidden, () => setKeys([])));
      api.get<SnmpTarget[]>('/api/admin/snmp/targets').then(setTargets)
        .catch(on403(setTargetsHidden, () => setTargets([])));
    } else { setKeysHidden(true); setTargetsHidden(true); }

    api.get<AgentRow[]>('/api/admin/agents').then(setAgents)
      .catch(on403(setAgentsHidden, () => setAgents([])));

    if (isAdmin) {
      api.get<SystemInfo>('/api/admin/system').then(setSys)
        .catch(on403(setSysHidden, () => setSysHidden(true)));
    } else setSysHidden(true);
  }, []);

  // key/value helpers
  const val = (k: string) => draft[k] ?? settings?.[k] ?? '';
  const setVal = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const has = (k: string) => settings != null && k in settings;
  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      await api.patch('/api/admin/settings', draft);
      setSettings((s) => ({ ...(s || {}), ...draft }));
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* keep draft so the user can retry */ }
    finally { setSaving(false); }
  };

  const textRow = (k: string, label: string,
    opts?: { type?: string; placeholder?: string; mono?: boolean }) => (
    <Row key={k} label={label}>
      {has(k) ? (
        <input type={opts?.type || 'text'} value={val(k)} placeholder={opts?.placeholder}
          className={opts?.mono ? 'mono' : undefined} style={{ width: '100%' }}
          onChange={(e) => setVal(k, e.target.value)} />
      ) : (
        <div className="row" style={{ gap: 8 }}>
          <input disabled value="" placeholder={opts?.placeholder}
            style={{ width: '100%', opacity: 0.55 }} />
          <span style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap' }}>admin only</span>
        </div>
      )}
    </Row>
  );
  const toggleRow = (k: string, label: string) => {
    const isOn = val(k) === '1';
    return (
      <Row key={k} label={label}>
        {has(k)
          ? <Toggle on={isOn} onClick={() => setVal(k, isOn ? '0' : '1')} />
          : <span style={{ fontSize: 10, color: 'var(--text3)' }}>admin only</span>}
      </Row>
    );
  };

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>

      {/* 0. Plan & Billing */}
      <BillingCard />

      {/* 1. Platform */}
      <div className="card">
        <div className="card-title">Platform</div>
        {settings === null
          ? <Loading />
          : <>
              {textRow('org_name', 'Organization name')}
              {textRow('backend_label', 'Backend label')}
              {textRow('retention_logs_days', 'Log retention (days)')}
              {toggleRow('status_published', 'Status page published')}
            </>}
      </div>

      {/* 2. Notifications */}
      <div className="card">
        <div className="card-title">Notifications</div>
        {settings === null
          ? <Loading />
          : <>
              {textRow('alert_email_from', 'Alert email from',
                { placeholder: 'OpsCat Alerts <alerts@opscat.io>' })}
              {textRow('auth_email_from', 'Auth email from',
                { placeholder: 'OpsCat <auth@opscat.io>' })}
              {textRow('teams_webhook_url', 'Teams webhook URL',
                { mono: true, placeholder: 'https://outlook.office.com/webhook/…' })}
            </>}
      </div>

      {/* save footer for key/value settings */}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 12 }}>
        {saved && <span style={{ color: '#3fb950', fontSize: 12, fontWeight: 600 }}>saved ✓</span>}
        <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      {/* 3. API Keys (lead+) */}
      {!keysHidden && (
        <div className="card">
          <div className="card-title" style={{ justifyContent: 'space-between' }}>
            <span>API Keys</span>
            <button className="btn btn-sm" onClick={() => setModal('key')}>+ Create key</button>
          </div>
          <div className="tbl-head" style={{ gridTemplateColumns: '1fr 120px 140px 110px 120px 90px', padding: '8px 0' }}>
            <span>Name</span><span>Prefix</span><span>Scopes</span>
            <span>Created</span><span>Last used</span><span>Active</span>
          </div>
          {keys === null && <Loading />}
          {keys?.length === 0 && <Empty>No API keys yet.</Empty>}
          {keys?.map((k) => (
            <div key={k.id} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 140px 110px 120px 90px',
              gap: 8, padding: 'var(--row-py) 0', borderBottom: '1px solid var(--bg3)', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text0)' }}>{k.name}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text2)' }}>{k.prefix}…</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text2)' }}>{k.scopes.join(', ')}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text2)' }}>{relTime(k.createdAt)}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text2)' }}>{relTime(k.lastUsedAt)}</span>
              <Toggle on={k.active}
                onClick={() => api.patch(`/api/admin/apikeys/${k.id}`, { active: !k.active }).then(reloadKeys)} />
            </div>
          ))}
        </div>
      )}

      {/* 4. Agents */}
      {!agentsHidden && (
        <div className="card">
          <div className="card-title" style={{ justifyContent: 'space-between' }}>
            <span>Agents</span>
            {leadPlus && <button className="btn btn-sm" onClick={() => setModal('agent')}>+ Register agent</button>}
          </div>
          <div className="tbl-head" style={{ gridTemplateColumns: '1fr 110px 140px 110px 90px 110px 80px', padding: '8px 0' }}>
            <span>Name</span><span>Group</span><span>Hostname</span><span>Platform</span>
            <span>Status</span><span>Last seen</span><span></span>
          </div>
          {agents === null && <Loading />}
          {agents?.length === 0 && <Empty>No agents registered.</Empty>}
          {agents?.map((a) => (
            <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 140px 110px 90px 110px 80px',
              gap: 8, padding: 'var(--row-py) 0', borderBottom: '1px solid var(--bg3)', alignItems: 'center' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text0)' }}>{a.name}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text2)' }}>{a.group}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text2)', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.hostname || '—'}</span>
              <span style={{ fontSize: 10, color: 'var(--text2)' }}>{a.platform || '—'}</span>
              <StatusCell online={a.online} />
              <span className="mono" style={{ fontSize: 10, color: 'var(--text2)' }}>{relTime(a.lastSeenAt)}</span>
              <span>
                {leadPlus && (
                  <button title="Delete agent" style={{ color: '#f85149', fontSize: 14 }}
                    onClick={() => {
                      if (confirm(`Delete agent "${a.name}"?`)) api.del(`/api/admin/agents/${a.id}`).then(reloadAgents);
                    }}>×</button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 5. SNMP Targets (lead+) */}
      {!targetsHidden && (
        <div className="card">
          <div className="card-title" style={{ justifyContent: 'space-between' }}>
            <span>SNMP Targets</span>
            <button className="btn btn-sm" onClick={() => setModal('target')}>+ Add target</button>
          </div>
          <div className="tbl-head" style={{ gridTemplateColumns: '1fr 160px 70px 90px 110px 110px 80px', padding: '8px 0' }}>
            <span>Name</span><span>Host</span><span>Port</span><span>Interval</span>
            <span>Enabled</span><span>Last status</span><span></span>
          </div>
          {targets === null && <Loading />}
          {targets?.length === 0 && <Empty>No SNMP targets configured.</Empty>}
          {targets?.map((t) => (
            <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '1fr 160px 70px 90px 110px 110px 80px',
              gap: 8, padding: 'var(--row-py) 0', borderBottom: '1px solid var(--bg3)', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text0)' }}>{t.name}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text2)', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.host}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text2)' }}>{t.port}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text2)' }}>{t.intervalS}s</span>
              <Toggle on={t.enabled}
                onClick={() => api.patch(`/api/admin/snmp/targets/${t.id}`, { enabled: !t.enabled }).then(reloadTargets)} />
              <span className="mono" style={{ fontSize: 10, color: snmpStatusColor(t.lastStatus) }}>
                {t.lastStatus || 'unknown'}
                <span style={{ color: 'var(--text3)' }}> · {relTime(t.lastSeenAt)}</span>
              </span>
              <span>
                <button title="Delete target" style={{ color: '#f85149', fontSize: 14 }}
                  onClick={() => {
                    if (confirm(`Delete SNMP target "${t.name}"?`)) api.del(`/api/admin/snmp/targets/${t.id}`).then(reloadTargets);
                  }}>×</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 6. System (admin) */}
      {!sysHidden && (
        <div className="card">
          <div className="card-title">System</div>
          {sys === null ? <Loading /> : (
            <>
              <Row label="Uptime">
                <span className="mono" style={{ fontSize: 11, color: 'var(--text1)' }}>
                  {sys.uptimeS != null ? fmtDuration(sys.uptimeS * 1000) : '—'}</span>
              </Row>
              <Row label="Database size">
                <span className="mono" style={{ fontSize: 11, color: 'var(--text1)' }}>
                  {sys.dbBytes != null ? fmtBytes(sys.dbBytes) : '—'}</span>
              </Row>
              <Row label="Records">
                <span className="mono" style={{ fontSize: 11, color: 'var(--text1)' }}>
                  {sys.counts?.logs ?? 0} logs · {sys.counts?.events ?? 0} events · {sys.counts?.cases ?? 0} cases · {sys.counts?.users ?? 0} users
                </span>
              </Row>
              <Row label="Node version">
                <span className="mono" style={{ fontSize: 11, color: 'var(--text1)' }}>{sys.nodeVersion || '—'}</span>
              </Row>
            </>
          )}
        </div>
      )}

      {modal === 'key' && <CreateKeyModal onClose={() => setModal(null)} onCreated={reloadKeys} onSecret={setSecret} />}
      {modal === 'agent' && <RegisterAgentModal onClose={() => setModal(null)} onCreated={reloadAgents} onSecret={setSecret} />}
      {modal === 'target' && <AddTargetModal onClose={() => setModal(null)} onCreated={reloadTargets} />}
      {secret && <OnceSecretModal {...secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- plan & billing

const USAGE_METRICS: { key: keyof BillingStatus['usage'] & keyof PlanLimits; label: string }[] = [
  { key: 'users', label: 'Users' },
  { key: 'checks', label: 'Checks' },
  { key: 'sensors', label: 'Sensors' },
  { key: 'snmpTargets', label: 'SNMP Targets' },
  { key: 'agents', label: 'Agents' },
  { key: 'apiKeys', label: 'API Keys' },
];

function planColor(key: string): string {
  if (key === 'pro') return SEV.purple;
  if (key === 'business') return SEV.green;
  if (key === 'enterprise') return SEV.cyan;
  return SEV.info;
}
function fmtBillingDate(v: number | string | null): string {
  if (v == null || v === '') return '';
  let ms: number;
  if (typeof v === 'number') ms = v < 1e12 ? v * 1000 : v;
  else { const p = Date.parse(v); if (isNaN(p)) return ''; ms = p; }
  const d = new Date(ms);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const unlimited = limit < 0;
  const pct = unlimited || limit === 0 ? 0 : Math.min(100, (used / limit) * 100);
  const color = unlimited ? '#3fb950' : pct >= 90 ? '#f85149' : pct >= 70 ? '#e3b341' : '#3fb950';
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: 'var(--text2)' }}>{label}</span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--text1)' }}>
          {used} / {unlimited ? 'Unlimited' : limit}
        </span>
      </div>
      <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${unlimited ? 100 : pct}%`, height: '100%', background: color,
          opacity: unlimited ? 0.3 : 1 }} />
      </div>
    </div>
  );
}

function PlanUpgradeCard({ plan, interval, current, canBuy, busy, onBuy }: {
  plan: PlanInfo; interval: 'month' | 'year'; current: boolean; canBuy: boolean;
  busy: boolean; onBuy: () => void;
}) {
  const price = interval === 'month' ? plan.priceMonthly : plan.priceYearly;
  const c = planColor(plan.key);
  return (
    <div className="card" style={{ flex: 1, minWidth: 200, background: 'var(--bg1)',
      borderColor: current ? c : 'var(--bg3)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text0)' }}>{plan.name}</span>
        <StatusPill text={plan.key} color={c} />
      </div>
      <div style={{ margin: '8px 0 10px' }}>
        <span className="mono" style={{ fontSize: 24, fontWeight: 700, color: 'var(--text0)' }}>€{price}</span>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}> /{interval === 'month' ? 'mo' : 'yr'}</span>
      </div>
      {plan.features?.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', display: 'flex',
          flexDirection: 'column', gap: 4 }}>
          {plan.features.slice(0, 5).map((f) => (
            <li key={f} className="row" style={{ gap: 6, fontSize: 11, color: 'var(--text2)' }}>
              <span style={{ color: '#3fb950' }}>✓</span>{f}
            </li>
          ))}
        </ul>
      )}
      {current ? (
        <button className="btn btn-sm" disabled style={{ width: '100%', justifyContent: 'center', opacity: 0.6 }}>
          Current plan
        </button>
      ) : (
        <button className="btn btn-primary btn-sm" style={{ width: '100%', justifyContent: 'center' }}
          disabled={!canBuy || busy} title={canBuy ? undefined : 'Admin only'} onClick={onBuy}>
          {busy ? '…' : 'Upgrade'}
        </button>
      )}
    </div>
  );
}

function BillingCard() {
  const app = useApp();
  const isAdmin = app.user?.role === 'admin';
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [edition, setEdition] = useState<'community' | 'cloud' | null>(null);
  const [failed, setFailed] = useState(false);
  const [interval, setBillingInterval] = useState<'month' | 'year'>('month');
  const [busy, setBusy] = useState('');
  const [banner, setBanner] = useState<'success' | 'cancel' | null>(null);

  useEffect(() => {
    const p = new URLSearchParams(location.search).get('billing');
    if (p === 'success' || p === 'cancel') {
      setBanner(p);
      history.replaceState(null, '', '/app/settings');
    }
    api.get<PlansResponse>('/api/plans')
      .then((r) => { setPlans(r.plans || []); setEdition(r.edition); }).catch(() => {});
    api.get<BillingStatus>('/api/billing/status').then(setStatus).catch(() => setFailed(true));
  }, []);

  const checkout = async (plan: string) => {
    setBusy(plan);
    try {
      const r = await api.post<{ url: string }>('/api/billing/checkout', { plan, interval });
      window.location.href = r.url;
    } catch { setBusy(''); }
  };
  const portal = async () => {
    setBusy('portal');
    try {
      const r = await api.post<{ url: string }>('/api/billing/portal', {});
      window.location.href = r.url;
    } catch { setBusy(''); }
  };

  const bannerEl = banner && (
    <div style={{ fontSize: 11, marginBottom: 12, padding: '8px 12px', borderRadius: 6,
      color: banner === 'success' ? '#3fb950' : '#e3b341',
      background: banner === 'success' ? 'rgba(63,185,80,0.12)' : 'rgba(227,179,65,0.12)',
      border: `1px solid ${banner === 'success' ? 'rgba(63,185,80,0.3)' : 'rgba(227,179,65,0.3)'}` }}>
      {banner === 'success'
        ? 'Subscription updated — thanks! Your plan will reflect the change shortly.'
        : 'Checkout was cancelled — no changes were made.'}
    </div>
  );

  // loading
  if (status === null && !failed) {
    return (
      <div className="card">
        <div className="card-title">Plan &amp; Billing</div>
        {bannerEl}
        <Loading />
      </div>
    );
  }

  // community edition / billing disabled
  const showBilling = !!status && (status.billingEnabled || edition === 'cloud');
  if (!showBilling) {
    return (
      <div className="card">
        <div className="card-title">Plan &amp; Billing</div>
        {bannerEl}
        <div style={{ fontSize: 12, color: 'var(--text2)' }}>
          Community edition — all features unlocked.
        </div>
      </div>
    );
  }

  const s = status as BillingStatus;
  const trial = fmtBillingDate(s.trialEndsAt);
  const renew = fmtBillingDate(s.currentPeriodEnd);
  const upgradePlans = plans.filter((p) => p.key === 'pro' || p.key === 'business');

  return (
    <div className="card">
      <div className="card-title" style={{ justifyContent: 'space-between' }}>
        <span>Plan &amp; Billing</span>
        {s.hasBilling && s.billingEnabled && isAdmin && (
          <button className="btn btn-sm" onClick={portal} disabled={busy === 'portal'}>
            {busy === 'portal' ? '…' : 'Manage billing'}
          </button>
        )}
      </div>
      {bannerEl}

      {/* current plan header */}
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div className="row" style={{ gap: 10 }}>
          <StatusPill text={s.planName || s.plan} color={planColor(s.plan)} />
          {s.subscriptionStatus && (
            <span className="mono" style={{ fontSize: 10, color: 'var(--text2)' }}>{s.subscriptionStatus}</span>
          )}
        </div>
        <span style={{ fontSize: 11, color: 'var(--text2)' }}>
          {trial ? `Trial ends ${trial}` : renew ? `Renews ${renew}` : ''}
        </span>
      </div>

      {/* usage grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))',
        gap: 14, marginTop: 16 }}>
        {USAGE_METRICS.map((m) => (
          <UsageBar key={m.key} label={m.label} used={s.usage[m.key]} limit={s.limits[m.key]} />
        ))}
      </div>

      {/* upgrade */}
      {s.billingEnabled && upgradePlans.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', margin: '20px 0 12px' }}>
            <span className="micro" style={{ fontSize: 9 }}>Upgrade</span>
            <span className="row" style={{ gap: 0, border: '1px solid var(--bg3)', borderRadius: 5,
              overflow: 'hidden' }}>
              {(['month', 'year'] as const).map((iv) => (
                <button key={iv} onClick={() => setBillingInterval(iv)}
                  style={{ padding: '4px 10px', fontSize: 10, fontWeight: 600,
                    background: interval === iv ? 'var(--bg3)' : 'transparent',
                    color: interval === iv ? 'var(--text0)' : 'var(--text3)' }}>
                  {iv === 'month' ? 'Monthly' : 'Annual'}
                </button>
              ))}
            </span>
          </div>
          <div className="row" style={{ gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
            {upgradePlans.map((p) => (
              <PlanUpgradeCard key={p.key} plan={p} interval={interval} current={s.plan === p.key}
                canBuy={!!isAdmin} busy={busy === p.key} onBuy={() => checkout(p.key)} />
            ))}
          </div>
          {!isAdmin && (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 8 }}>
              Only administrators can change the subscription.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- small helpers

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' }}>
      <span style={{ width: 200, flexShrink: 0, fontSize: 11, color: 'var(--text2)' }}>{label}</span>
      <div style={{ flex: 1, maxWidth: 420 }}>{children}</div>
    </div>
  );
}
function Loading() {
  return <div className="mono" style={{ padding: 20, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>loading…</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>{children}</div>;
}
function StatusCell({ online }: { online: boolean }) {
  return (
    <span className="row" style={{ gap: 5 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: online ? '#3fb950' : '#8b949e', boxShadow: online ? '0 0 6px #3fb950' : undefined }} />
      <span style={{ fontSize: 10, color: 'var(--text2)' }}>{online ? 'online' : 'offline'}</span>
    </span>
  );
}
function snmpStatusColor(s: string | null): string {
  if (s === 'ok') return '#3fb950';
  if (s === 'unreachable') return '#f85149';
  return 'var(--text2)';
}

// ---------------------------------------------------------------- create API key

function CreateKeyModal({ onClose, onCreated, onSecret }:
  { onClose: () => void; onCreated: () => void; onSecret: (s: SecretInfo) => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['ingest']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const toggle = (s: string) => setScopes((cur) => cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api.post<{ key: string }>('/api/admin/apikeys', { name, scopes });
      onSecret({ title: 'API key created', note: 'Copy now — this key is not retrievable later.', value: r.key });
      onCreated(); onClose();
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'error'); setBusy(false); }
  };
  return (
    <Modal title="Create API key" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name">
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="ingest-prod" />
        </Field>
        <div style={{ marginBottom: 10 }}>
          <span className="micro" style={{ fontSize: 9 }}>Scopes</span>
          <div className="row" style={{ gap: 14, marginTop: 6 }}>
            {['ingest', 'agent', 'probe'].map((s) => (
              <label key={s} className="row" style={{ gap: 5, fontSize: 11, cursor: 'pointer' }}>
                <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)}
                  style={{ width: 'auto' }} />{s}
              </label>
            ))}
          </div>
        </div>
        {err && <div style={{ color: '#f85149', fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy || scopes.length === 0}>{busy ? '…' : 'Create'}</button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- register agent

function RegisterAgentModal({ onClose, onCreated, onSecret }:
  { onClose: () => void; onCreated: () => void; onSecret: (s: SecretInfo) => void }) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState('default');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api.post<{ token: string }>('/api/admin/agents', { name, group });
      const install = `OPSCAT_URL=https://opscat.io OPSCAT_AGENT_TOKEN=${r.token} sh agent/install.sh`;
      onSecret({
        title: 'Agent registered', note: 'Copy the token now — it is shown only once.', value: r.token,
        extra: (
          <div className="mono" style={{ fontSize: 10, color: 'var(--text2)', marginTop: 10,
            background: 'var(--bg2)', border: '1px solid var(--bg3)', borderRadius: 6, padding: '8px 10px',
            wordBreak: 'break-all', userSelect: 'all' }}>{install}</div>
        ),
      });
      onCreated(); onClose();
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'error'); setBusy(false); }
  };
  return (
    <Modal title="Register agent" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name">
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="web-01" />
        </Field>
        <Field label="Group">
          <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="default" />
        </Field>
        {err && <div style={{ color: '#f85149', fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy}>{busy ? '…' : 'Register'}</button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- add SNMP target

function AddTargetModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('161');
  const [community, setCommunity] = useState('');
  const [interval, setIntervalS] = useState('60');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api.post('/api/admin/snmp/targets', {
        name, host, port: Number(port) || 161, community, oids: [], intervalS: Number(interval) || 60,
      });
      onCreated(); onClose();
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'error'); setBusy(false); }
  };
  return (
    <Modal title="Add SNMP target" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name">
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="core-switch-01" />
        </Field>
        <Field label="Host">
          <input required value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.1" />
        </Field>
        <Field label="Port">
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Community (v2c)">
          <input type="password" value={community} onChange={(e) => setCommunity(e.target.value)} placeholder="public" />
        </Field>
        <Field label="Interval (seconds)">
          <input value={interval} onChange={(e) => setIntervalS(e.target.value)} inputMode="numeric" />
        </Field>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>SNMP v2c.</div>
        {err && <div style={{ color: '#f85149', fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy}>{busy ? '…' : 'Add target'}</button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- one-time secret

function OnceSecretModal({ title, note, value, extra, onClose }: SecretInfo & { onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 10 }}>{note}</div>
      <div className="mono" style={{ fontSize: 13, color: 'var(--text0)', background: 'var(--bg3)',
        border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', userSelect: 'all',
        wordBreak: 'break-all' }}>{value}</div>
      {extra}
      <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
        onClick={onClose}>Done</button>
    </Modal>
  );
}
