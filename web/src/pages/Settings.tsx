// Settings — platform config, notifications, API keys, agents, SNMP targets, system info.
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../state';
import { SEV, fmtBytes, fmtDuration, relTime } from '../format';
import {
  Modal, Field, Toggle, StatusPill, TableScroll, TableSkeleton, ListSkeleton, Skeleton, Busy, PageHeader, Input} from '../ui';
import { Select } from '../Select';
import type {
  AgentRow, ApiKeyRow, BillingStatus, PlanInfo, PlanLimits, PlansResponse,
  MaintenanceWindow, McpConnection, Settings as SettingsMap, SnmpTarget,
} from '../types';

const RANK: Record<string, number> = { analyst: 1, lead: 2, cto: 3, admin: 4 };

// one source of truth per table: head, rows and TableSkeleton all read these
const KEYS_GRID = '1fr 120px 140px 110px 120px 90px';
const AGENTS_GRID = '1fr 100px 140px 100px 80px 100px 90px 60px';
const TARGETS_GRID = '1fr 160px 70px 90px 110px 110px 80px';
const CONNECTIONS_GRID = '1fr 130px 120px 120px 90px';

interface SystemInfo {
  uptimeS?: number; dbBytes?: number; nodeVersion?: string;
  counts?: { logs?: number; events?: number; cases?: number; users?: number };
}
export interface SecretInfo { title: string; note: string; value: string; extra?: React.ReactNode; }

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
  const [connections, setConnections] = useState<McpConnection[] | null>(null);
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
  // Connections are the caller's OWN authorized MCP clients, not org config —
  // every role sees their own, so this is not behind the lead+ gate.
  const reloadConnections = () => api.get<McpConnection[]>('/api/admin/connections')
    .then(setConnections).catch(() => setConnections([]));

  useEffect(() => {
    api.get<SettingsMap>('/api/admin/settings').then(setSettings).catch(() => setSettings({}));
    reloadConnections();

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
        <Input type={opts?.type || 'text'} value={val(k)} placeholder={opts?.placeholder}
          className={opts?.mono ? 'mono' : undefined}
          onChange={(e) => setVal(k, e.target.value)} />
      ) : (
        <div className="row" style={{ gap: 8 }}>
          <Input disabled value="" placeholder={opts?.placeholder}
            style={{ opacity: 0.55 }} />
          <span className="text-xs text-text3" style={{ whiteSpace: 'nowrap' }}>admin only</span>
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
          : <span className="text-xs text-text3">admin only</span>}
      </Row>
    );
  };

  return (
    <div className="page">
      <PageHeader title="Settings" />

      {/* 0. Plan & Billing */}
      <BillingCard />

      {/* 1. Platform */}
      <div className="card">
        <div className="card-title">Platform</div>
        {settings === null
          ? <FormSkeleton rows={4} />
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
          ? <FormSkeleton rows={5} />
          : <>
              {textRow('alert_email_from', 'Alert email from',
                { placeholder: 'OpsCat Alerts <alerts@opscat.io>' })}
              {textRow('auth_email_from', 'Auth email from',
                { placeholder: 'OpsCat <auth@opscat.io>' })}
              {textRow('teams_webhook_url', 'Teams webhook URL',
                { mono: true, placeholder: 'https://outlook.office.com/webhook/…' })}
              {textRow('telegram_bot_token', 'Telegram bot token',
                { type: 'password', mono: true, placeholder: '123456:ABC-DEF…' })}
              {textRow('pushover_token', 'Pushover app token',
                { type: 'password', mono: true, placeholder: 'azGDORePK8gMaC0QOYAMyEEuzJnyUi' })}
            </>}
      </div>

      {/* save footer for key/value settings */}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 12 }}>
        {saved && <span className="text-base font-semibold" style={{ color: '#3fb950'}}>saved ✓</span>}
        <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      {/* 2c. AI endpoint (admin) */}
      {isAdmin && <AiCard />}
      {isAdmin && <VoiceCard />}

      {/* 2b. Maintenance windows */}
      <MaintenanceCard canEdit={leadPlus} />

      {/* 3. API Keys (lead+) */}
      {!keysHidden && (
        <div className="card">
          <div className="card-title" style={{ justifyContent: 'space-between' }}>
            <span>API Keys</span>
            <button className="btn btn-sm" onClick={() => setModal('key')}>+ Create key</button>
          </div>
          <TableScroll minWidth={720}>
          <div className="tbl-head" style={{ gridTemplateColumns: KEYS_GRID, padding: '8px 0' }}>
            <span>Name</span><span>Prefix</span><span>Scopes</span>
            <span>Created</span><span>Last used</span><span>Active</span>
          </div>
          {keys === null && <TableSkeleton cols={KEYS_GRID} rows={3} flush />}
          {keys?.length === 0 && <Empty>No API keys yet.</Empty>}
          {keys?.map((k) => (
            <div key={k.id} style={{ display: 'grid', gridTemplateColumns: KEYS_GRID,
              gap: 8, padding: 'var(--row-py) 0', borderBottom: '1px solid var(--bg3)', alignItems: 'center' }}>
              <span className="text-sm text-text0">{k.name}</span>
              <span className="mono text-sm text-text2">{k.prefix}…</span>
              <span className="mono text-xs text-text2">{k.scopes.join(', ')}</span>
              <span className="mono text-xs text-text2">{relTime(k.createdAt)}</span>
              <span className="mono text-xs text-text2">{relTime(k.lastUsedAt)}</span>
              <Toggle on={k.active}
                onClick={() => api.patch(`/api/admin/apikeys/${k.id}`, { active: !k.active }).then(reloadKeys)} />
            </div>
          ))}
          </TableScroll>
        </div>
      )}

      {/* 3b. Connected apps (MCP / OAuth grants) — the caller's own */}
      <div className="card">
        <div className="card-title"><span>Connected apps</span></div>
        <p className="text-sm text-text2" style={{ margin: '0 0 10px' }}>
          AI clients you authorized to act on your behalf in this organization. Revoking
          takes effect immediately.
        </p>
        <TableScroll minWidth={620}>
        <div className="tbl-head" style={{ gridTemplateColumns: CONNECTIONS_GRID, padding: '8px 0' }}>
          <span>Application</span><span>Permissions</span>
          <span>Connected</span><span>Last used</span><span></span>
        </div>
        {connections === null && <TableSkeleton cols={CONNECTIONS_GRID} rows={2} flush />}
        {connections?.length === 0 && <Empty>No connected apps.</Empty>}
        {connections?.map((c) => (
          <div key={c.clientId} style={{ display: 'grid', gridTemplateColumns: CONNECTIONS_GRID,
            gap: 8, padding: 'var(--row-py) 0', borderBottom: '1px solid var(--bg3)', alignItems: 'center' }}>
            <span className="text-sm text-text0">{c.name}</span>
            <span className="mono text-xs text-text2">{c.scopes.join(', ')}</span>
            <span className="mono text-xs text-text2">{relTime(c.createdAt)}</span>
            <span className="mono text-xs text-text2">{relTime(c.lastUsedAt)}</span>
            <button className="btn btn-sm"
              onClick={() => api.del(`/api/admin/connections/${c.clientId}`).then(reloadConnections)}>
              Revoke
            </button>
          </div>
        ))}
        </TableScroll>
      </div>

      {/* 4. Agents */}
      {!agentsHidden && (
        <div className="card">
          <div className="card-title" style={{ justifyContent: 'space-between' }}>
            <span>Agents</span>
            {leadPlus && <button className="btn btn-sm" onClick={() => setModal('agent')}>+ Register agent</button>}
          </div>
          <TableScroll minWidth={840}>
          <div className="tbl-head" style={{ gridTemplateColumns: AGENTS_GRID, padding: '8px 0' }}>
            <span>Name</span><span>Group</span><span>Hostname</span><span>Platform</span>
            <span>Status</span><span>Last seen</span><span>Auto-upd</span><span></span>
          </div>
          {agents === null && <TableSkeleton cols={AGENTS_GRID} rows={3} flush />}
          {agents?.length === 0 && <Empty>No agents registered.</Empty>}
          {agents?.map((a) => (
            <div key={a.id} style={{ display: 'grid', gridTemplateColumns: AGENTS_GRID,
              gap: 8, padding: 'var(--row-py) 0', borderBottom: '1px solid var(--bg3)', alignItems: 'center' }}>
              <span className="mono text-sm text-text0">{a.name}
                {a.version && <span className="text-text3"> v{a.version}</span>}</span>
              <span className="mono text-xs text-text2">{a.group}</span>
              <span className="mono text-xs text-text2" style={{ overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.hostname || '—'}</span>
              <span className="text-xs text-text2">{a.platform || '—'}</span>
              <StatusCell online={a.online} />
              <span className="mono text-xs text-text2">{relTime(a.lastSeenAt)}</span>
              <Toggle on={a.autoUpdate} disabled={!leadPlus}
                onClick={leadPlus ? () => api.patch(`/api/admin/agents/${a.id}`, { autoUpdate: !a.autoUpdate }).then(reloadAgents) : undefined} />
              <span>
                {leadPlus && (
                  <button className="text-lg" title="Delete agent" style={{ color: '#f85149'}}
                    onClick={() => {
                      if (confirm(`Delete agent "${a.name}"?`)) api.del(`/api/admin/agents/${a.id}`).then(reloadAgents);
                    }}>×</button>
                )}
              </span>
            </div>
          ))}
          </TableScroll>
        </div>
      )}

      {/* 5. SNMP Targets (lead+) */}
      {!targetsHidden && (
        <div className="card">
          <div className="card-title" style={{ justifyContent: 'space-between' }}>
            <span>SNMP Targets</span>
            <button className="btn btn-sm" onClick={() => setModal('target')}>+ Add target</button>
          </div>
          <TableScroll minWidth={780}>
          <div className="tbl-head" style={{ gridTemplateColumns: TARGETS_GRID, padding: '8px 0' }}>
            <span>Name</span><span>Host</span><span>Port</span><span>Interval</span>
            <span>Enabled</span><span>Last status</span><span></span>
          </div>
          {targets === null && <TableSkeleton cols={TARGETS_GRID} rows={3} flush />}
          {targets?.length === 0 && <Empty>No SNMP targets configured.</Empty>}
          {targets?.map((t) => (
            <div key={t.id} style={{ display: 'grid', gridTemplateColumns: TARGETS_GRID,
              gap: 8, padding: 'var(--row-py) 0', borderBottom: '1px solid var(--bg3)', alignItems: 'center' }}>
              <span className="text-sm text-text0">{t.name}</span>
              <span className="mono text-xs text-text2" style={{ overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.host}</span>
              <span className="mono text-xs text-text2">{t.port}</span>
              <span className="mono text-xs text-text2">{t.intervalS}s</span>
              <Toggle on={t.enabled}
                onClick={() => api.patch(`/api/admin/snmp/targets/${t.id}`, { enabled: !t.enabled }).then(reloadTargets)} />
              <span className="mono text-xs" style={{ color: snmpStatusColor(t.lastStatus) }}>
                {t.lastStatus || 'unknown'}
                <span className="text-text3"> · {relTime(t.lastSeenAt)}</span>
              </span>
              <span>
                <button className="text-lg" title="Delete target" style={{ color: '#f85149'}}
                  onClick={() => {
                    if (confirm(`Delete SNMP target "${t.name}"?`)) api.del(`/api/admin/snmp/targets/${t.id}`).then(reloadTargets);
                  }}>×</button>
              </span>
            </div>
          ))}
          </TableScroll>
        </div>
      )}

      {/* 6. System (admin) */}
      {!sysHidden && (
        <div className="card">
          <div className="card-title">System</div>
          {sys === null ? <FormSkeleton rows={4} /> : (
            <>
              <Row label="Uptime">
                <span className="mono text-sm text-text1">
                  {sys.uptimeS != null ? fmtDuration(sys.uptimeS * 1000) : '—'}</span>
              </Row>
              <Row label="Database size">
                <span className="mono text-sm text-text1">
                  {sys.dbBytes != null ? fmtBytes(sys.dbBytes) : '—'}</span>
              </Row>
              <Row label="Records">
                <span className="mono text-sm text-text1">
                  {sys.counts?.logs ?? 0} logs · {sys.counts?.events ?? 0} events · {sys.counts?.cases ?? 0} cases · {sys.counts?.users ?? 0} users
                </span>
              </Row>
              <Row label="Node version">
                <span className="mono text-sm text-text1">{sys.nodeVersion || '—'}</span>
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

// ---------------------------------------------------------------- AI endpoint

interface AiStatus {
  org: { baseUrl: string; model: string; hasKey: boolean };
  platformConfigured: boolean;
  effectiveSource: 'org' | 'platform' | null;
  effectiveModel: string | null;
}

// Org-level LLM override (OpenAI-compatible endpoint). The platform default —
// set by the super-admin — applies when these fields stay empty.
function AiCard() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState(''); // write-only; never echoed back
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api.get<AiStatus>('/api/admin/ai').then((s) => {
    setStatus(s); setBaseUrl(s.org.baseUrl); setModel(s.org.model);
  }).catch(() => setStatus(null));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      const body: Record<string, string> = { baseUrl, model };
      if (apiKey) body.apiKey = apiKey;
      await api.put('/api/admin/ai', body);
      setApiKey(''); setDirty(false);
      setMsg({ ok: true, text: 'saved ✓' });
      load();
    } catch (ex) { setMsg({ ok: false, text: ex instanceof ApiError ? ex.message : 'network error' }); }
    finally { setBusy(''); }
  };
  const clearKey = async () => {
    if (!confirm('Remove the stored API key? The platform default (if any) applies again.')) return;
    setBusy('save');
    try { await api.put('/api/admin/ai', { apiKey: '' }); setMsg({ ok: true, text: 'key removed' }); load(); }
    catch { setMsg({ ok: false, text: 'could not remove key' }); }
    finally { setBusy(''); }
  };
  const test = async () => {
    setBusy('test'); setMsg(null);
    try {
      const r = await api.post<{ ok: boolean; source: string; model: string; latencyMs: number }>(
        '/api/admin/ai/test', {});
      setMsg({ ok: true, text: `works — ${r.model} via ${r.source} config, ${r.latencyMs} ms` });
    } catch (ex) { setMsg({ ok: false, text: ex instanceof ApiError ? ex.message : 'network error' }); }
    finally { setBusy(''); }
  };

  const effective = status?.effectiveSource
    ? `Effective: ${status.effectiveModel} (${status.effectiveSource === 'org' ? 'this organization' : 'platform default'})`
    : 'No LLM configured — AI features (Scout suggestions) stay off.';

  return (
    <div className="card">
      <div className="card-title">AI</div>
      <div className="text-xs text-text3" style={{ marginBottom: 10 }}>
        Any OpenAI-compatible endpoint (OpenRouter, Ollama, vLLM, Azure, …). Leave empty to use
        the platform default{status?.platformConfigured === false ? ' (currently not configured)' : ''}.
        The API key is stored encrypted and never shown again.
      </div>
      {status === null ? <FormSkeleton rows={3} /> : (
        <>
          <Row label="Base URL">
            <Input className="mono" value={baseUrl} placeholder="https://openrouter.ai/api/v1"
              onChange={(e) => { setBaseUrl(e.target.value); setDirty(true); }} style={{ width: '100%' }} />
          </Row>
          <Row label="Model">
            <Input className="mono" value={model} placeholder="anthropic/claude-haiku-4.5"
              onChange={(e) => { setModel(e.target.value); setDirty(true); }} style={{ width: '100%' }} />
          </Row>
          <Row label={status.org.hasKey ? 'API key (stored)' : 'API key'}>
            <div className="row" style={{ gap: 8 }}>
              <Input type="password" className="mono" value={apiKey}
                placeholder={status.org.hasKey ? '•••••••• (set — enter to replace)' : 'sk-…'}
                onChange={(e) => { setApiKey(e.target.value); setDirty(true); }} style={{ flex: 1 }} />
              {status.org.hasKey && (
                <button className="btn btn-sm" onClick={clearKey} disabled={!!busy}>Remove</button>
              )}
            </div>
          </Row>
          <div className="row row-wrap" style={{ justifyContent: 'space-between', marginTop: 8, gap: 10 }}>
            <span className="text-xs text-text3">{effective}</span>
            <span className="row" style={{ gap: 10 }}>
              {msg && <span className="text-sm font-semibold" style={{
                color: msg.ok ? '#3fb950' : '#f85149' }}>{msg.text}</span>}
              <button className="btn btn-sm" onClick={test} disabled={!!busy || dirty}
                title={dirty ? 'Save first' : 'Send a one-line test prompt'}>
                {busy === 'test' ? 'Testing…' : 'Test'}
              </button>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || !!busy}>
                {busy === 'save' ? 'Saving…' : 'Save AI Settings'}
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- voice / STT

// Org-level voice provider for the Bridge's live transcript (docs/BRIDGE.md
// phase 2). Same contract as AiCard: OpenAI-compatible /audio/transcriptions,
// key write-only, platform default applies when empty.
function VoiceCard() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState(''); // write-only; never echoed back
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api.get<AiStatus>('/api/admin/voice').then((s) => {
    setStatus(s); setBaseUrl(s.org.baseUrl); setModel(s.org.model);
  }).catch(() => setStatus(null));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, string> = { baseUrl, model };
      if (apiKey) body.apiKey = apiKey;
      await api.put('/api/admin/voice', body);
      setApiKey(''); setDirty(false);
      setMsg({ ok: true, text: 'saved ✓' });
      load();
    } catch (ex) { setMsg({ ok: false, text: ex instanceof ApiError ? ex.message : 'network error' }); }
    finally { setBusy(false); }
  };
  const clearKey = async () => {
    if (!confirm('Remove the stored API key? The platform default (if any) applies again.')) return;
    setBusy(true);
    try { await api.put('/api/admin/voice', { apiKey: '' }); setMsg({ ok: true, text: 'key removed' }); load(); }
    catch { setMsg({ ok: false, text: 'could not remove key' }); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post<{ ok: boolean; source: string; model: string; latencyMs: number }>(
        '/api/admin/voice/test', {});
      setMsg({ ok: true, text: `works — ${r.model} via ${r.source} config, ${r.latencyMs} ms` });
    } catch (ex) { setMsg({ ok: false, text: ex instanceof ApiError ? ex.message : 'network error' }); }
    finally { setBusy(false); }
  };

  const effective = status?.effectiveSource
    ? `Effective: ${status.effectiveModel} (${status.effectiveSource === 'org' ? 'this organization' : 'platform default'})`
    : 'No voice provider configured — the Bridge live transcript stays off.';

  return (
    <div className="card">
      <div className="card-title">Voice / Transcription</div>
      <div className="text-xs text-text3" style={{ marginBottom: 10 }}>
        Speech-to-text for the Bridge live transcript. Any OpenAI-compatible transcription
        endpoint (OpenAI, Groq, a local Whisper server, …) — speech chunks go to
        <span className="mono"> /audio/transcriptions</span>. Leave empty to use the platform
        default{status?.platformConfigured === false ? ' (currently not configured)' : ''}.
        The API key is stored encrypted and never shown again.
      </div>
      {status === null ? <FormSkeleton rows={3} /> : (
        <>
          <Row label="Base URL">
            <Input className="mono" value={baseUrl} placeholder="https://api.openai.com/v1"
              onChange={(e) => { setBaseUrl(e.target.value); setDirty(true); }} style={{ width: '100%' }} />
          </Row>
          <Row label="Model">
            <Input className="mono" value={model} placeholder="gpt-4o-mini-transcribe"
              onChange={(e) => { setModel(e.target.value); setDirty(true); }} style={{ width: '100%' }} />
          </Row>
          <Row label={status.org.hasKey ? 'API key (stored)' : 'API key'}>
            <div className="row" style={{ gap: 8 }}>
              <Input type="password" className="mono" value={apiKey}
                placeholder={status.org.hasKey ? '•••••••• (set — enter to replace)' : 'sk-…'}
                onChange={(e) => { setApiKey(e.target.value); setDirty(true); }} style={{ flex: 1 }} />
              {status.org.hasKey && (
                <button className="btn btn-sm" onClick={clearKey} disabled={busy}>Remove</button>
              )}
            </div>
          </Row>
          <div className="row row-wrap" style={{ justifyContent: 'space-between', marginTop: 8, gap: 10 }}>
            <span className="text-xs text-text3">{effective}</span>
            <span className="row" style={{ gap: 10 }}>
              {msg && <span className="text-sm font-semibold" style={{
                color: msg.ok ? '#3fb950' : '#f85149' }}>{msg.text}</span>}
              <button className="btn btn-sm" onClick={test} disabled={busy || dirty}
                title={dirty ? 'Save first' : 'Round-trip a short test tone through the endpoint'}>
                Test
              </button>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || busy}>
                {busy ? 'Saving…' : 'Save Voice Settings'}
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- maintenance windows

function MaintenanceCard({ canEdit }: { canEdit: boolean }) {
  const [windows, setWindows] = useState<MaintenanceWindow[] | null>(null);
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [err, setErr] = useState('');
  const load = () => api.get<MaintenanceWindow[]>('/api/maintenance').then(setWindows).catch(() => setWindows([]));
  useEffect(() => { load(); }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    const startsAt = Date.parse(from);
    const endsAt = Date.parse(to);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
      setErr('end must be after start'); return;
    }
    try {
      await api.post('/api/maintenance', { name: name.trim(), startsAt, endsAt });
      setName(''); setFrom(''); setTo(''); load();
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'error'); }
  };
  const remove = async (w: MaintenanceWindow) => {
    if (!confirm(`Delete maintenance window "${w.name}"?`)) return;
    await api.del(`/api/maintenance/${w.id}`);
    load();
  };
  const fmt = (t: number) => new Date(t).toLocaleString();

  return (
    <div className="card">
      <div className="card-title">Maintenance Windows</div>
      <div className="text-xs text-text3" style={{ marginBottom: 10 }}>
        While a window is active, events keep recording but no alerts are sent
        (the notification log shows them as suppressed).
      </div>
      {windows === null && <ListSkeleton rows={2} lines={1} divided={false} />}
      {windows?.length === 0 && <Empty>No maintenance windows.</Empty>}
      {windows?.map((w) => (
        <div key={w.id} className="row" style={{ gap: 10, padding: '6px 0',
          borderBottom: '1px solid var(--bg3)' }}>
          <StatusPill text={w.active ? 'active' : (w.endsAt < Date.now() ? 'past' : 'planned')}
            color={w.active ? '#e3b341' : w.endsAt < Date.now() ? 'var(--text3)' : '#38b6ff'} />
          <span className="text-sm text-text0 font-semibold">{w.name}</span>
          <span className="mono text-xs text-text2" style={{ flex: 1 }}>
            {fmt(w.startsAt)} → {fmt(w.endsAt)}</span>
          {canEdit && <button className="text-md" title="Delete" style={{ color: '#f85149'}}
            onClick={() => remove(w)}>×</button>}
        </div>
      ))}
      {canEdit && (
        <form onSubmit={add} className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <Input required value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. core switch upgrade" style={{ flex: 2, minWidth: 160 }} />
          <Input required type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)}
            style={{ flex: 1, minWidth: 150 }} />
          <Input required type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)}
            style={{ flex: 1, minWidth: 150 }} />
          <button className="btn btn-sm">+ Add window</button>
          {err && <span className="text-sm" style={{ color: '#f85149'}}>{err}</span>}
        </form>
      )}
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

// used == null → the bar renders its own placeholder, keeping label + metrics row
function UsageBar({ label, used, limit }: { label: string; used: number | null; limit: number }) {
  const loading = used == null;
  const unlimited = limit < 0;
  const pct = loading || unlimited || limit === 0 ? 0 : Math.min(100, (used / limit) * 100);
  const color = unlimited ? '#3fb950' : pct >= 90 ? '#f85149' : pct >= 70 ? '#e3b341' : '#3fb950';
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <span className="text-xs text-text2">{label}</span>
        {loading ? <Skeleton w={48} h={9} /> : (
          <span className="mono text-xs text-text1">
            {used} / {unlimited ? 'Unlimited' : limit}
          </span>
        )}
      </div>
      {loading ? <Skeleton h={6} radius={3} /> : (
        <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${unlimited ? 100 : pct}%`, height: '100%', background: color,
            opacity: unlimited ? 0.3 : 1 }} />
        </div>
      )}
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
        <span className="text-md font-bold text-text0">{plan.name}</span>
        <StatusPill text={plan.key} color={c} />
      </div>
      <div style={{ margin: '8px 0 10px' }}>
        <span className="mono font-bold text-text0" style={{ fontSize: 24}}>€{price}</span>
        <span className="text-sm text-text3"> /{interval === 'month' ? 'mo' : 'yr'}</span>
      </div>
      {plan.features?.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', display: 'flex',
          flexDirection: 'column', gap: 4 }}>
          {plan.features.slice(0, 5).map((f) => (
            <li key={f} className="row text-sm text-text2" style={{ gap: 6}}>
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
    <div className="text-sm" style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 6,
      color: banner === 'success' ? '#3fb950' : '#e3b341',
      background: banner === 'success' ? 'rgba(63,185,80,0.12)' : 'rgba(227,179,65,0.12)',
      border: `1px solid ${banner === 'success' ? 'rgba(63,185,80,0.3)' : 'rgba(227,179,65,0.3)'}` }}>
      {banner === 'success'
        ? 'Subscription updated — thanks! Your plan will reflect the change shortly.'
        : 'Checkout was cancelled — no changes were made.'}
    </div>
  );

  // loading — same chrome as the loaded card: pill row + usage grid placeholders
  if (status === null && !failed) {
    return (
      <div className="card">
        <div className="card-title">Plan &amp; Billing</div>
        {bannerEl}
        <Skeleton w={92} h={18} radius={10} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))',
          gap: 14, marginTop: 16 }}>
          {USAGE_METRICS.map((m) => <UsageBar key={m.key} label={m.label} used={null} limit={0} />)}
        </div>
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
        <div className="text-base text-text2">
          Community Edition (CE) — all features unlocked.
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
            <span className="mono text-xs text-text2">{s.subscriptionStatus}</span>
          )}
        </div>
        <span className="text-sm text-text2">
          {trial ? `Trial ends ${trial}` : renew ? `Renews ${renew}` : ''}
        </span>
      </div>

      {/* usage grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))',
        gap: 14, marginTop: 16 }}>
        {USAGE_METRICS.map((m) => (
          <UsageBar key={m.key} label={m.label} used={s.usage[m.key]} limit={s.limits[m.key]} />
        ))}
        {s.usage.ingestLinesToday != null && s.limits.ingestLinesPerDay != null && (
          <UsageBar label="Log lines (today)" used={s.usage.ingestLinesToday}
            limit={s.limits.ingestLinesPerDay} />
        )}
      </div>

      {/* upgrade */}
      {s.billingEnabled && upgradePlans.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', margin: '20px 0 12px' }}>
            <span className="micro text-2xs">Upgrade</span>
            <span className="row" style={{ gap: 0, border: '1px solid var(--bg3)', borderRadius: 5,
              overflow: 'hidden' }}>
              {(['month', 'year'] as const).map((iv) => (
                <button key={iv} onClick={() => setBillingInterval(iv)}
                  style={{ padding: '4px 10px', fontSize: 'var(--t-xs)', fontWeight: 600,
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
            <div className="text-xs text-text3" style={{ marginTop: 8 }}>
              Only administrators can change the subscription.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- small helpers

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    // geometry lives in .form-row (tokens.css), not inline: on a phone the label has to
    // move ABOVE the field, and a media query cannot override an inline style.
    <div className="form-row">
      <span className="form-row-label text-sm text-text2">{label}</span>
      <div className="form-row-field">{children}</div>
    </div>
  );
}
// Built from the real <Row>, so label/field geometry can never drift apart.
function FormSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Busy>
      {Array.from({ length: rows }, (_, i) => (
        <Row key={i} label={<Skeleton w={`${58 + (i % 3) * 14}%`} />}>
          <Skeleton h={28} radius={5} />
        </Row>
      ))}
    </Busy>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-text3 text-base" style={{ padding: 20, textAlign: 'center'}}>{children}</div>;
}
function StatusCell({ online }: { online: boolean }) {
  return (
    <span className="row" style={{ gap: 5 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: online ? '#3fb950' : '#8b949e', boxShadow: online ? '0 0 6px #3fb950' : undefined }} />
      <span className="text-xs text-text2">{online ? 'online' : 'offline'}</span>
    </span>
  );
}
function snmpStatusColor(s: string | null): string {
  if (s === 'ok') return '#3fb950';
  if (s === 'unreachable') return '#f85149';
  return 'var(--text2)';
}

// ---------------------------------------------------------------- create API key

export function CreateKeyModal({ onClose, onCreated, onSecret }:
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
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="ingest-prod" />
        </Field>
        <div style={{ marginBottom: 10 }}>
          <span className="micro text-2xs">Scopes</span>
          <div className="row" style={{ gap: 14, marginTop: 6 }}>
            {['ingest', 'agent', 'probe'].map((s) => (
              <label key={s} className="row text-sm" style={{ gap: 5, cursor: 'pointer' }}>
                <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)}
                  style={{ width: 'auto' }} />{s}
              </label>
            ))}
          </div>
        </div>
        {err && <div className="text-sm" style={{ color: '#f85149', marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy || scopes.length === 0}>{busy ? '…' : 'Create'}</button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- register agent

export function RegisterAgentModal({ onClose, onCreated, onSecret }:
  { onClose: () => void; onCreated: () => void; onSecret: (s: SecretInfo) => void }) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState('default');
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api.post<{ token: string }>('/api/admin/agents', { name, group, autoUpdate });
      const install = `curl -fsSL ${location.origin}/agent/install.sh | sudo OPSCAT_URL=${location.origin} OPSCAT_AGENT_TOKEN=${r.token} sh`;
      onSecret({
        title: 'Agent registered', note: 'Copy the token now — it is shown only once.', value: r.token,
        extra: (
          <div className="mono text-xs text-text2" style={{ marginTop: 10,
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
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="web-01" />
        </Field>
        <Field label="Group">
          <Input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="default" />
        </Field>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <Toggle on={autoUpdate} onClick={() => setAutoUpdate(!autoUpdate)} />
          <span className="text-sm text-text1">Auto-update</span>
          <span className="text-xs text-text3">
            — agent updates itself when the server ships a newer version</span>
        </div>
        {err && <div className="text-sm" style={{ color: '#f85149', marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy}>{busy ? '…' : 'Register'}</button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- add SNMP target

export function AddTargetModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('161');
  const [version, setVersion] = useState<'2c' | '3'>('2c');
  const [community, setCommunity] = useState('');
  const [v3User, setV3User] = useState('');
  const [v3Level, setV3Level] = useState('authPriv');
  const [v3AuthProtocol, setV3AuthProtocol] = useState('sha');
  const [v3AuthKey, setV3AuthKey] = useState('');
  const [v3PrivProtocol, setV3PrivProtocol] = useState('aes');
  const [v3PrivKey, setV3PrivKey] = useState('');
  const [interval, setIntervalS] = useState('60');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api.post('/api/admin/snmp/targets', {
        name, host, port: Number(port) || 161, version, oids: [], intervalS: Number(interval) || 60,
        ...(version === '2c' ? { community } : {
          v3User, v3Level,
          ...(v3Level !== 'noAuthNoPriv' ? { v3AuthProtocol, v3AuthKey } : {}),
          ...(v3Level === 'authPriv' ? { v3PrivProtocol, v3PrivKey } : {}),
        }),
      });
      onCreated(); onClose();
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'error'); setBusy(false); }
  };
  return (
    <Modal title="Add SNMP target" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="core-switch-01" />
        </Field>
        <Field label="Host">
          <Input required value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.1" />
        </Field>
        <Field label="Port">
          <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="SNMP version">
          <Select title="SNMP version" value={version} onChange={(v) => setVersion(v as '2c' | '3')}
            options={[{ value: '2c', label: 'v2c (community)' },
              { value: '3', label: 'v3 (user-based security)' }]} />
        </Field>
        {version === '2c' ? (
          <Field label="Community">
            <Input type="password" value={community} onChange={(e) => setCommunity(e.target.value)} placeholder="public" />
          </Field>
        ) : (
          <>
            <Field label="Security user">
              <Input required value={v3User} onChange={(e) => setV3User(e.target.value)} placeholder="opscat-ro" />
            </Field>
            <Field label="Security level">
              <Select title="Security level" value={v3Level} onChange={setV3Level}
                options={['noAuthNoPriv', 'authNoPriv', 'authPriv'].map((l) => ({ value: l, label: l }))} />
            </Field>
            {v3Level !== 'noAuthNoPriv' && (
              <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <div style={{ width: 90 }}>
                  <Field label="Auth">
                    <Select title="Auth protocol" value={v3AuthProtocol} onChange={setV3AuthProtocol}
                      options={[{ value: 'sha', label: 'SHA' }, { value: 'md5', label: 'MD5' }]} />
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label="Auth key (min 8 chars)">
                    <Input type="password" required minLength={8} value={v3AuthKey}
                      onChange={(e) => setV3AuthKey(e.target.value)} />
                  </Field>
                </div>
              </div>
            )}
            {v3Level === 'authPriv' && (
              <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <div style={{ width: 90 }}>
                  <Field label="Privacy">
                    <Select title="Privacy protocol" value={v3PrivProtocol} onChange={setV3PrivProtocol}
                      options={[{ value: 'aes', label: 'AES' }, { value: 'des', label: 'DES' }]} />
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label="Privacy key (min 8 chars)">
                    <Input type="password" required minLength={8} value={v3PrivKey}
                      onChange={(e) => setV3PrivKey(e.target.value)} />
                  </Field>
                </div>
              </div>
            )}
          </>
        )}
        <Field label="Interval (seconds)">
          <Input value={interval} onChange={(e) => setIntervalS(e.target.value)} inputMode="numeric" />
        </Field>
        {err && <div className="text-sm" style={{ color: '#f85149', marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy}>{busy ? '…' : 'Add target'}</button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- one-time secret

export function OnceSecretModal({ title, note, value, extra, onClose }: SecretInfo & { onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="text-sm text-text2" style={{ marginBottom: 10 }}>{note}</div>
      <div className="mono text-md text-text0" style={{ background: 'var(--bg3)',
        border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', userSelect: 'all',
        wordBreak: 'break-all' }}>{value}</div>
      {extra}
      <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
        onClick={onClose}>Done</button>
    </Modal>
  );
}
