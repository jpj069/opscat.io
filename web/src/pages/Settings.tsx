// Settings — everything that configures the organization, in six tabs.
//
// This page used to be ONE scroll of twelve unrelated cards: billing, platform
// fields, five notification providers, two LLM endpoints, maintenance windows,
// API keys, OAuth grants, agents, SNMP targets and system info, with nothing
// between them. Each tab is one job now, and the tab lives in the URL — so
// /app/settings/notifications is a link somebody can send.
import React, { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp, useTab } from '../state';
import { SEV, fmtBytes, fmtDuration, relTime } from '../format';
import { Card, Button, Spark,
  Modal, Flyout, Field, Toggle, StatusPill, TableScroll, TableSkeleton, ListSkeleton, Skeleton, Busy,
  PageHeader, Tabs, Segmented, Input, HostInput, DateTime, COL, FormRow, CardNote, SwitchRow,
  Avatar, ImageUpload, Skeleton as Shimmer } from '../ui';
import { Select } from '../Select';
import type {
  AgentRow, ApiKeyRow, BillingStatus, PlanInfo, PlanLimits, PlansResponse,
  MaintenanceWindow, McpConnection, Settings as SettingsMap, SnmpTarget,
  SyslogEndpoint, SyslogEndpointWithConfig, SyslogMode, SyslogSnippets, SyslogThroughput,
  TelephonyConfig, OrgAvatar,
} from '../types';
import {
  CheckIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from 'lucide-react';
import { useOverlayParam } from '../state';

const RANK: Record<string, number> = { analyst: 1, lead: 2, cto: 3, admin: 4 };

// one source of truth per table: head, rows and TableSkeleton all read these
// Name | Prefix | Scopes | Created | Last used | Active
const KEYS_GRID = [COL.text, COL.label, COL.textWide, COL.age, COL.age, COL.toggle].join(' ');
// Name | Group | Hostname | Platform | Status | Last seen | Auto-upd | delete
const AGENTS_GRID = [COL.text, COL.label, COL.textWide, COL.label, COL.status, COL.age, COL.toggle, COL.actions].join(' ');
// Name | Host | Port | Interval | Enabled | Last status | delete
const TARGETS_GRID = [COL.text, COL.textWide, COL.num, COL.num,
  COL.toggle, COL.status, COL.actions].join(' ');
// Name | Key | Device prefix | Last seen | Enabled | rotate+delete
/* Name · Mode · Key · Device prefix · Last seen · Enabled · actions.
 *
 * `minWidth` is 950 and not 820 because the seventh track has to come from
 * somewhere: seven tracks floor at 762px, so at 820 the slack left for the
 * three 0.6fr labels is 58px and each resolves to ~102px — narrower than
 * "Straight to OpsCat" renders, and the phone type scale is one step larger
 * again. 950 restores the ~130px the two label tracks have today. */
const SYSLOG_GRID = [COL.text, COL.label, COL.label, COL.label, COL.age, COL.toggle,
  COL.actionsWide].join(' ');

/* ONE vocabulary for the three modes, read by the Add dialog's Segmented AND by
 * the table. A shorter second wording for the column is precisely the third
 * noun for one thing that this repo's rules warn about — and the column is
 * where a reader meets it FIRST, so it is the copy that would win. */
const SYSLOG_MODE_LABELS: Record<SyslogMode, string> = {
  collector: 'Own collector',
  managed: 'Straight to OpsCat',
  tunnel: 'Through a tunnel',
};
// Application | Permissions | Connected | Last used | revoke
const CONNECTIONS_GRID = [COL.text, COL.textWide, COL.age, COL.age, COL.actions].join(' ');

// Grouped by the job, not by the API that happens to serve them: the two cards
// that PATCH /api/admin/settings sit in the two tabs their fields belong to.
const SETTINGS_TABS = [
  ['general', 'General'],
  ['notifications', 'Notifications'],
  ['ai', 'AI & Voice'],
  ['access', 'API & Access'],
  ['collectors', 'Agents, SNMP & Syslog'],
  ['billing', 'Billing'],
] as const;
type Tab = (typeof SETTINGS_TABS)[number][0];

interface SystemInfo {
  uptimeS?: number; dbBytes?: number; nodeVersion?: string;
  counts?: { logs?: number; events?: number; cases?: number; users?: number };
}
export interface SecretInfo { title: string; note: string; value: string; extra?: React.ReactNode; }

const on403 = (setHidden: (v: boolean) => void, fallback: () => void) => (e: unknown) => {
  if (e instanceof ApiError && e.status === 403) setHidden(true); else fallback();
};

// Stripe sends the customer back to /app/settings/billing?billing=success|cancel.
// Read during RENDER, not from an effect: useTab normalises the URL on mount and
// the tab has to be picked before that. Old links without the tab segment still
// land right, which is why this exists at all.
function billingReturnTab(): Tab | undefined {
  const p = new URLSearchParams(location.search).get('billing');
  return p === 'success' || p === 'cancel' ? 'billing' : undefined;
}

// ---------------------------------------------------------------- page

export default function Settings() {
  const app = useApp();
  const rank = RANK[app.user?.role || ''] || 0;
  const leadPlus = rank >= 2;
  const isAdmin = app.user?.role === 'admin';

  // /api/admin/ai and /api/admin/voice are admin-only end to end, so the tab is
  // not offered to anyone else — an empty tab is worse than no tab.
  const tabs = useMemo(() => SETTINGS_TABS.filter(([id]) => id !== 'ai' || isAdmin), [isAdmin]);
  const ids = useMemo(() => tabs.map((t) => t[0]), [tabs]);
  const [tab, setTab] = useTab<Tab>(ids, billingReturnTab());

  // One draft for both settings tabs: they write the same endpoint, so switching
  // tabs must not drop an edit and one save has to persist all of them.
  const draft = useSettingsDraft();

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'general' && <GeneralTab d={draft} isAdmin={!!isAdmin} />}
      {tab === 'notifications' && <NotificationsTab d={draft} isAdmin={!!isAdmin} canEdit={leadPlus} />}
      {tab === 'ai' && isAdmin && <><AiCard /><VoiceCard /></>}
      {tab === 'access' && <AccessTab leadPlus={leadPlus} />}
      {tab === 'collectors' && <CollectorsTab leadPlus={leadPlus} />}
      {tab === 'billing' && <BillingCard />}
    </div>
  );
}

// ---------------------------------------------------------------- key/value settings

interface SettingsDraft {
  settings: SettingsMap | null;
  val: (k: string) => string;
  setVal: (k: string, v: string) => void;
  has: (k: string) => boolean;
  dirty: boolean; saving: boolean; saved: boolean; err: string;
  save: () => void;
}

// The /api/admin/settings key/value pairs, plus the edit draft over them. Lives
// in the page so the General and Notifications tabs share one draft and one save.
function useSettingsDraft(): SettingsDraft {
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<SettingsMap>('/api/admin/settings').then(setSettings).catch(() => setSettings({}));
  }, []);

  const save = async () => {
    if (!Object.keys(draft).length) return;
    setSaving(true); setErr('');
    try {
      await api.patch('/api/admin/settings', draft);
      setSettings((s) => ({ ...(s || {}), ...draft }));
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (ex) {
      // keep the draft so the user can retry — but say so, instead of swallowing it
      setErr(ex instanceof ApiError ? ex.message : 'network error');
    } finally { setSaving(false); }
  };

  return {
    settings,
    val: (k) => draft[k] ?? settings?.[k] ?? '',
    setVal: (k, v) => setDraft((cur) => ({ ...cur, [k]: v })),
    // a key the server did not return is one this role may not read
    has: (k) => settings != null && k in settings,
    dirty: Object.keys(draft).length > 0,
    saving, saved, err, save,
  };
}

// Editing needs admin (PATCH /api/admin/settings is requireRole('admin')). Everyone
// else reads: the value when the server sends it, "—" when it is admin-only.
function TextRow({ d, k, label, hint, isAdmin, type, placeholder, mono }: {
  d: SettingsDraft; k: string; label: string; hint?: string; isAdmin: boolean;
  type?: string; placeholder?: string; mono?: boolean;
}) {
  const secret = type === 'password';
  return (
    <Row label={label} hint={hint}>
      {isAdmin && d.has(k) ? (
        <Input type={type || 'text'} value={d.val(k)} placeholder={placeholder}
          className={mono ? 'mono' : undefined}
          onChange={(e) => d.setVal(k, e.target.value)} />
      ) : (
        <div className="row" style={{ gap: 8, minWidth: 0 }}>
          <span className={`text-sm text-text2${mono && !secret ? ' mono' : ''}`}
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {d.has(k) && d.val(k) ? (secret ? '••••••••' : d.val(k)) : '—'}
          </span>
          <span className="text-xs text-text3" style={{ whiteSpace: 'nowrap' }}>admin only</span>
        </div>
      )}
    </Row>
  );
}
function ToggleRow({ d, k, label, hint, isAdmin }: {
  d: SettingsDraft; k: string; label: string; hint?: string; isAdmin: boolean;
}) {
  const isOn = d.val(k) === '1';
  const editable = isAdmin && d.has(k);
  return (
    <SwitchRow label={label} hint={hint} on={isOn} disabled={!editable}
      note={editable ? undefined : 'admin only'}
      onClick={() => d.setVal(k, isOn ? '0' : '1')} />
  );
}

function SaveBar({ d }: { d: SettingsDraft }) {
  return (
    <div className="row row-wrap" style={{ justifyContent: 'flex-end', gap: 12 }}>
      {d.err && <span className="text-sm" style={{ color: SEV.critical }}>{d.err}</span>}
      {d.dirty && !d.err && <span className="text-sm text-text3">Unsaved changes</span>}
      {d.saved && <span className="row text-base font-semibold" style={{ color: SEV.green, gap: 4 }}>
        <CheckIcon size={13} /> saved</span>}
      <Button variant="primary" onClick={d.save} disabled={!d.dirty || d.saving}>
        {d.saving ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- general

/**
 * The organisation's avatar.
 *
 * There is no "none" state to render: with no upload the default is initials
 * over a colour derived from the org id, resolved server-side
 * (server/src/lib/org-avatar.js) so the preview here, the workspace switcher,
 * the platform console and the alert mail cannot show one org four ways.
 * Removing an upload therefore does not clear the avatar, it reverts it — and
 * the button says exactly that.
 *
 * `reloadOrgs()` after a change is not a nicety: the switcher in the shell
 * renders from `app.orgs`, so without it the new logo appears here and nowhere
 * else until the next reload, which reads as the upload not having worked.
 */
function OrgAvatarField({ isAdmin, orgName }: { isAdmin: boolean; orgName: string }) {
  const app = useApp();
  const [av, setAv] = useState<OrgAvatar | null>(null);
  const load = () => api.get<OrgAvatar>('/api/admin/org/avatar').then(setAv).catch(() => {});
  useEffect(() => { load(); }, []);

  const after = async (next: OrgAvatar) => { setAv(next); await app.reloadOrgs(); };

  return (
    <FormRow label="Avatar" hint={av?.url
      ? 'Shown in the workspace switcher, the platform console and every alert e-mail. PNG, JPEG, WebP or ICO, up to 512 KB.'
      : 'Initials on a colour derived from this organisation, until you upload something. Shown in the workspace switcher, the platform console and every alert e-mail.'}>
      {av === null ? <Shimmer w={200} h={34} /> : (
        <ImageUpload
          label="organization avatar"
          hasAsset={!!av.url}
          disabled={!isAdmin}
          preview={<Avatar size={34} square i={av.initials} c={av.color} src={av.url} alt={orgName} />}
          onUpload={async (data) => {
            try { after(await api.put<OrgAvatar>('/api/admin/org/avatar', { data })); }
            catch (e) { throw new Error(e instanceof ApiError ? e.message : 'upload failed'); }
          }}
          onRemove={async () => {
            try { after(await api.del<OrgAvatar>('/api/admin/org/avatar')); }
            catch (e) { throw new Error(e instanceof ApiError ? e.message : 'could not remove'); }
          }}
        />
      )}
    </FormRow>
  );
}

function GeneralTab({ d, isAdmin }: { d: SettingsDraft; isAdmin: boolean }) {
  return (
    <>
      <Card title="Organization">
        <CardNote>Who this tenant is, how long its data is kept, and whether the
          public status page is served.</CardNote>
        {d.settings === null ? <FormSkeleton rows={4} /> : (
          <>
            <TextRow d={d} isAdmin={isAdmin} k="org_name" label="Organization name" />
            <OrgAvatarField isAdmin={isAdmin} orgName={d.val('org_name') || 'Organization'} />
            <TextRow d={d} isAdmin={isAdmin} k="backend_label" label="Backend label"
              hint="Free-text label for this deployment, e.g. nbg1 · PRIMARY" />
            {/* The hint states the PLAN's ceiling, because that is the number the
                field is actually bounded by. Leaving it blank is how the old field
                looked while it silently did nothing at all. */}
            <TextRow d={d} isAdmin={isAdmin} k="retention_logs_days" label="Log retention (days)"
              type="number" placeholder={d.val('retention_logs_days_effective') || undefined}
              hint={d.val('retention_logs_days_max')
                ? `Logs older than this are dropped by the hourly cleanup. Your plan keeps up to ${d.val('retention_logs_days_max')} days — set a shorter value to keep less.`
                : 'Logs older than this are dropped by the hourly cleanup.'} />
            <ToggleRow d={d} isAdmin={isAdmin} k="status_published" label="Status page published"
              hint="Serves the public status page at /status" />
          </>
        )}
      </Card>
      {isAdmin && <SaveBar d={d} />}
      {isAdmin && <SystemCard />}
    </>
  );
}

// Admin-only read-out of the running instance (/api/admin/system).
function SystemCard() {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    api.get<SystemInfo>('/api/admin/system').then(setSys)
      .catch(on403(setHidden, () => setHidden(true)));
  }, []);
  if (hidden) return null;
  return (
    <Card title="System">
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
              {/* `?? 0` claimed "0 logs" for a response that carried no counts at all —
                  an em dash says "not reported", which is the actual fact. The loading
                  case is already handled above by FormSkeleton. */}
              {sys.counts?.logs ?? '—'} logs · {sys.counts?.events ?? '—'} events · {sys.counts?.cases ?? '—'} cases · {sys.counts?.users ?? '—'} users
            </span>
          </Row>
          <Row label="Node version">
            <span className="mono text-sm text-text1">{sys.nodeVersion || '—'}</span>
          </Row>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- notifications

function NotificationsTab({ d, isAdmin, canEdit }:
  { d: SettingsDraft; isAdmin: boolean; canEdit: boolean }) {
  return (
    <>
      <Card title="Sender addresses">
        <CardNote>From addresses for outgoing mail. Auth mail falls back to the alert
          address when it is left empty.</CardNote>
        {d.settings === null ? <FormSkeleton rows={2} /> : (
          <>
            <TextRow d={d} isAdmin={isAdmin} k="alert_email_from" label="Alert email from"
              placeholder="OpsCat Alerts <alerts@opscat.io>" />
            <TextRow d={d} isAdmin={isAdmin} k="auth_email_from" label="Auth email from"
              hint="Sign-in and magic-link mail" placeholder="OpsCat <auth@opscat.io>" />
          </>
        )}
      </Card>

      <Card title="Channel credentials">
        <CardNote>Org-wide credentials the alert channels need. WHO gets an alert is
          decided per rule under Alert Rules — a Telegram chat id, a Pushover user key
          or a Slack, Discord, ntfy or webhook URL is a recipient and lives there.</CardNote>
        {d.settings === null ? <FormSkeleton rows={3} /> : (
          <>
            <TextRow d={d} isAdmin={isAdmin} k="msteams_webhook_url" label="Microsoft Teams webhook URL"
              mono hint="Fallback for Microsoft Teams rules that carry no webhook of their own"
              placeholder="https://outlook.office.com/webhook/…" />
            <TextRow d={d} isAdmin={isAdmin} k="telegram_bot_token" label="Telegram bot token"
              type="password" mono placeholder="123456:ABC-DEF…" />
            <TextRow d={d} isAdmin={isAdmin} k="pushover_token" label="Pushover app token"
              type="password" mono placeholder="azGDORePK8gMaC0QOYAMyEEuzJnyUi" />
          </>
        )}
      </Card>

      {isAdmin && <TelephonyCard />}
      {isAdmin && <SaveBar d={d} />}
      <MaintenanceCard canEdit={canEdit} />
    </>
  );
}

// ---------------------------------------------------------------- API & access

function AccessTab({ leadPlus }: { leadPlus: boolean }) {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [keysHidden, setKeysHidden] = useState(!leadPlus);
  const [connections, setConnections] = useState<McpConnection[] | null>(null);
  const [modal, setModal] = useState(false);
  const [secret, setSecret] = useState<SecretInfo | null>(null);

  const reloadKeys = () => api.get<ApiKeyRow[]>('/api/admin/apikeys').then(setKeys)
    .catch(on403(setKeysHidden, () => setKeys([])));
  // Connections are the caller's OWN authorized MCP clients, not org config —
  // every role sees their own, so this is not behind the lead+ gate.
  const reloadConnections = () => api.get<McpConnection[]>('/api/admin/connections')
    .then(setConnections).catch(() => setConnections([]));

  useEffect(() => {
    if (leadPlus) reloadKeys();
    reloadConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {!keysHidden && (
        <Card title="API Keys"
          actions={<Button size="sm" onClick={() => setModal(true)}><PlusIcon size={13} /> Create key</Button>}>
          <CardNote>Machine credentials for log ingest, server agents and remote probes.
            A key is shown once, at creation.</CardNote>
          <TableScroll cols={KEYS_GRID} minWidth={720}>
            <div className="tbl-head" style={{ padding: '8px 0' }}>
              <span>Name</span><span>Prefix</span><span>Scopes</span>
              <span>Created</span><span>Last used</span><span>Active</span>
            </div>
            {keys === null && <TableSkeleton rows={3} flush />}
            {keys?.length === 0 && <Empty>No API keys yet.</Empty>}
            {keys?.map((k) => (
              <div key={k.id} className="tbl-row" style={{ padding: 'var(--row-py) 0' }}>
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
        </Card>
      )}

      <Card title="Connected apps">
        <CardNote>AI clients you authorized to act on your behalf in this organization.
          Revoking takes effect immediately.</CardNote>
        <TableScroll cols={CONNECTIONS_GRID} minWidth={620}>
          <div className="tbl-head" style={{ padding: '8px 0' }}>
            <span>Application</span><span>Permissions</span>
            <span>Connected</span><span>Last used</span><span></span>
          </div>
          {connections === null && <TableSkeleton rows={2} flush />}
          {connections?.length === 0 && <Empty>No connected apps.</Empty>}
          {connections?.map((c) => (
            <div key={c.clientId} className="tbl-row" style={{ padding: 'var(--row-py) 0' }}>
              <span className="text-sm text-text0">{c.name}</span>
              <span className="mono text-xs text-text2">{c.scopes.join(', ')}</span>
              <span className="mono text-xs text-text2">{relTime(c.createdAt)}</span>
              <span className="mono text-xs text-text2">{relTime(c.lastUsedAt)}</span>
              <Button size="sm"
                onClick={() => api.del(`/api/admin/connections/${c.clientId}`).then(reloadConnections)}>
                Revoke
              </Button>
            </div>
          ))}
        </TableScroll>
      </Card>

      {modal && <CreateKeyModal onClose={() => setModal(false)} onCreated={reloadKeys} onSecret={setSecret} />}
      {secret && <OnceSecretModal {...secret} onClose={() => setSecret(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- agents & SNMP

function CollectorsTab({ leadPlus }: { leadPlus: boolean }) {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [agentsHidden, setAgentsHidden] = useState(false);
  const [targets, setTargets] = useState<SnmpTarget[] | null>(null);
  const [targetsHidden, setTargetsHidden] = useState(!leadPlus);
  const [modal, setModal] = useState<'agent' | 'target' | null>(null);
  const [secret, setSecret] = useState<SecretInfo | null>(null);

  const reloadAgents = () => api.get<AgentRow[]>('/api/admin/agents').then(setAgents)
    .catch(on403(setAgentsHidden, () => setAgents([])));
  const reloadTargets = () => api.get<SnmpTarget[]>('/api/admin/snmp/targets').then(setTargets)
    .catch(on403(setTargetsHidden, () => setTargets([])));

  useEffect(() => {
    reloadAgents();
    if (leadPlus) reloadTargets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {!agentsHidden && (
        <Card title="Agents"
          actions={leadPlus && <Button size="sm" onClick={() => setModal('agent')}><PlusIcon size={13} /> Register agent</Button>}>
          <CardNote>Server agents shipping metrics, containers and logs. Registering one
            hands out an install one-liner with a token shown only once.</CardNote>
          <TableScroll cols={AGENTS_GRID} minWidth={840}>
            <div className="tbl-head" style={{ padding: '8px 0' }}>
              <span>Name</span><span>Group</span><span>Hostname</span><span>Platform</span>
              <span>Status</span><span>Last seen</span><span>Auto-upd</span><span></span>
            </div>
            {agents === null && <TableSkeleton rows={3} flush />}
            {agents?.length === 0 && <Empty>No agents registered.</Empty>}
            {agents?.map((a) => (
              <div key={a.id} className="tbl-row" style={{ padding: 'var(--row-py) 0' }}>
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
                    <button title="Delete agent" style={{ color: SEV.critical, display: 'inline-flex' }}
                      onClick={() => {
                        if (confirm(`Delete agent "${a.name}"?`)) api.del(`/api/admin/agents/${a.id}`).then(reloadAgents);
                      }}><XIcon size={15} /></button>
                  )}
                </span>
              </div>
            ))}
          </TableScroll>
        </Card>
      )}

      {!targetsHidden && (
        <Card title="SNMP Targets"
          actions={<Button size="sm" onClick={() => setModal('target')}><PlusIcon size={13} /> Add target</Button>}>
          <CardNote>Devices polled over SNMP v2c or v3. Credentials are stored encrypted
            and never read back.</CardNote>
          <TableScroll cols={TARGETS_GRID} minWidth={780}>
            <div className="tbl-head" style={{ padding: '8px 0' }}>
              <span>Name</span><span>Host</span><span>Port</span><span>Interval</span>
              <span>Enabled</span><span>Last status</span><span></span>
            </div>
            {targets === null && <TableSkeleton rows={3} flush />}
            {targets?.length === 0 && <Empty>No SNMP targets configured.</Empty>}
            {targets?.map((t) => (
              <div key={t.id} className="tbl-row" style={{ padding: 'var(--row-py) 0' }}>
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
                  <button title="Delete target" style={{ color: SEV.critical, display: 'inline-flex' }}
                    onClick={() => {
                      if (confirm(`Delete SNMP target "${t.name}"?`)) api.del(`/api/admin/snmp/targets/${t.id}`).then(reloadTargets);
                    }}><XIcon size={15} /></button>
                </span>
              </div>
            ))}
          </TableScroll>
        </Card>
      )}

      {leadPlus && <SyslogCard />}

      {modal === 'agent' && <RegisterAgentModal onClose={() => setModal(null)} onCreated={reloadAgents} onSecret={setSecret} />}
      {modal === 'target' && <AddTargetModal onClose={() => setModal(null)} onCreated={reloadTargets} />}
      {secret && <OnceSecretModal {...secret} onClose={() => setSecret(null)} />}
    </>
  );
}


// ------------------------------------------------------- syslog collectors

/**
 * Syslog endpoints — one per relay a customer points at OpsCat.
 *
 * Two shapes, and which is which follows the rule rather than the amount of
 * content: **creating** an endpoint is a task with a commit point, so it is a
 * `Modal`; an endpoint itself is a record you LOOK at — you come back to it to
 * re-read the relay config — so it is a `Flyout` with its id in the URL. "Which
 * endpoint is on your screen" is answerable with a link.
 *
 * The key is held in memory and only ever after the request that minted it.
 * Re-opening a stored endpoint shows the snippets with a placeholder, which is
 * why the flyout takes `minted` separately from the row: the screen stays useful
 * without becoming a place where a secret can be read a second time.
 */
function SyslogCard() {
  const [rows, setRows] = useState<SyslogEndpoint[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useOverlayParam('endpoint');
  // The freshly-minted credential, if the open flyout is the one we just made.
  const [minted, setMinted] = useState<SyslogEndpointWithConfig | null>(null);

  const reload = () => api.get<SyslogEndpoint[]>('/api/syslog/endpoints').then(setRows).catch(() => setRows([]));
  useEffect(() => { reload(); }, []);

  const openRow = (id: number) => { setMinted(null); setOpen(id); };
  const afterMint = (e: SyslogEndpointWithConfig) => {
    setMinted(e); setOpen(e.id); reload();
  };

  const row = rows?.find((r) => r.id === open) || null;

  return (
    <>
      <Card title="Syslog Endpoints"
        actions={<Button size="sm" onClick={() => setCreating(true)}><PlusIcon size={13} /> Add endpoint</Button>}>
        <CardNote>One endpoint per site. Your relay keeps every input it has — this is one
          more destination on it. If the relay can reach the internet over TLS it sends
          straight here; if it cannot, a small collector runs in your network and does the
          outward half for it.</CardNote>
        <TableScroll cols={SYSLOG_GRID} minWidth={950}>
          <div className="tbl-head" style={{ padding: '8px 0' }}>
            <span>Name</span><span>Mode</span><span>Key</span><span>Device prefix</span>
            <span>Last seen</span><span>Enabled</span><span></span>
          </div>
          {rows === null && <TableSkeleton rows={2} flush />}
          {rows?.length === 0 && <Empty>No syslog endpoints yet.</Empty>}
          {rows?.map((e) => (
            <div key={e.id} className="tbl-row" style={{ padding: 'var(--row-py) 0', cursor: 'pointer' }}
              onClick={() => openRow(e.id)}>
              <span className="text-sm text-text0">{e.name}</span>
              <span className="text-xs text-text2">{SYSLOG_MODE_LABELS[e.mode] || e.mode}</span>
              <span className="mono text-xs text-text2">{e.keyPrefix ? `${e.keyPrefix}…` : 'revoked'}</span>
              <span className="mono text-xs text-text2">{e.devicePrefix || '—'}</span>
              <span className="mono text-xs text-text2">{relTime(e.lastSeenAt)}</span>
              <Toggle on={e.enabled}
                onClick={() => api.patch(`/api/syslog/endpoints/${e.id}`, { enabled: !e.enabled }).then(reload)} />
              <span className="row" style={{ gap: 6 }} onClick={(ev) => ev.stopPropagation()}>
                <Button size="sm" title="Issue a new key; the current one stops working"
                  onClick={() => {
                    if (!confirm(`Rotate the key for "${e.name}"? The current key stops working immediately.`)) return;
                    api.post<SyslogEndpointWithConfig>(`/api/syslog/endpoints/${e.id}/rotate`, {}).then(afterMint);
                  }}><RefreshCwIcon size={13} /> Rotate</Button>
                <button title="Delete endpoint" style={{ color: SEV.critical, display: 'inline-flex' }}
                  onClick={() => {
                    if (confirm(`Delete "${e.name}"? Its collector key is revoked immediately.`)) {
                      api.del(`/api/syslog/endpoints/${e.id}`).then(reload);
                    }
                  }}><XIcon size={15} /></button>
              </span>
            </div>
          ))}
        </TableScroll>
      </Card>

      {creating && <AddSyslogEndpointModal onClose={() => setCreating(false)} onCreated={afterMint} />}
      {open !== null && row && (
        <SyslogEndpointFlyout row={row} minted={minted && minted.id === row.id ? minted : null}
          onClose={() => { setMinted(null); setOpen(null); }} onChanged={reload} />
      )}
    </>
  );
}

function AddSyslogEndpointModal({ onClose, onCreated }: {
  onClose: () => void; onCreated: (e: SyslogEndpointWithConfig) => void;
}) {
  const { syslogManaged, syslogTunnel } = useApp();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<SyslogMode>('collector');
  const [peerKey, setPeerKey] = useState('');
  const [devicePrefix, setDevicePrefix] = useState('');
  const [collectorHost, setCollectorHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    setBusy(true); setErr('');
    api.post<SyslogEndpointWithConfig>('/api/syslog/endpoints',
      { name: name.trim(), mode,
        peerPublicKey: mode === 'tunnel' ? peerKey.trim() : undefined,
        devicePrefix: devicePrefix.trim() || undefined,
        collectorHost: collectorHost.trim() || undefined })
      .then((e) => { onClose(); onCreated(e); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'could not create endpoint'))
      .finally(() => setBusy(false));
  };

  return (
    <Modal title="Add syslog endpoint" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="RZ Frankfurt" autoFocus width="100%" />
        </Field>
        <CardNote>This name becomes the log <span className="mono">source</span> of every line
          from this site, so it is what you filter and search by later.</CardNote>
        {(syslogManaged || syslogTunnel) && (
          <>
            <Field label="How this site sends">
              {/* `Field` is a column flex, so a bare child is a stretched flex item —
                  which blockifies `.seg` from inline-flex to flex and leaves an empty
                  bordered track after the last segment (31px at 390px, 127px at
                  1280px). The row wrapper puts it back in a context where it sizes to
                  its segments. Measured, not reasoned: the computed `display` is the
                  only visible symptom. */}
              <div className="row row-wrap">
                <Segmented<SyslogMode> value={mode} onChange={setMode} options={[
                  ['collector', SYSLOG_MODE_LABELS.collector],
                  ...(syslogManaged ? [['managed', SYSLOG_MODE_LABELS.managed] as const] : []),
                  ...(syslogTunnel ? [['tunnel', SYSLOG_MODE_LABELS.tunnel] as const] : []),
                ]} />
              </div>
            </Field>
            <CardNote>{mode === 'collector'
              ? 'You run a small collector inside your network. Your relay keeps sending plain '
                + 'syslog on the LAN, and only the collector talks to the internet — the right '
                + 'answer when the relay cannot do TLS.'
              : mode === 'managed'
                ? 'Your relay sends TLS straight to OpsCat and you install nothing. It needs to '
                  + 'reach the internet on port 6514 and to speak RFC 5424 over TLS.'
                : 'A WireGuard tunnel from your relay to OpsCat. Inside it you can send plain '
                  + 'UDP — which is what your devices already speak — because the tunnel itself '
                  + 'proves who is sending. Nothing of ours ends up in your relay\u2019s config.'}</CardNote>
          </>
        )}
        {mode === 'tunnel' && (
          <>
            <Field label="Relay public key">
              <Input className="mono" value={peerKey} onChange={(e) => setPeerKey(e.target.value)}
                placeholder="wg genkey | wg pubkey" width="100%" />
            </Field>
            <CardNote>Run <span className="mono">wg genkey | sudo tee /etc/wireguard/opscat.key
              | wg pubkey</span> on the relay and paste what it prints. The private half stays
              on that machine \u2014 we neither need it nor want it.</CardNote>
          </>
        )}
        {mode === 'collector' && (
          <>
            <Field label="Collector address (optional)">
              <HostInput value={collectorHost} onChange={(e) => setCollectorHost(e.target.value)}
                placeholder="10.10.0.42" width="100%" />
            </Field>
            <CardNote>Where your relay will reach the collector. Used only to fill in the
              configuration shown next — you can change it there.</CardNote>
          </>
        )}
        <Field label="Device prefix (optional)">
          <Input value={devicePrefix} onChange={(e) => setDevicePrefix(e.target.value)}
            placeholder="fra-" width="100%" />
        </Field>
        <CardNote>Prepended to every device name from this endpoint, so two sites with a
          <span className="mono"> core-sw-01</span> each stay apart.</CardNote>
        {err && <div className="text-sm" style={{ color: SEV.critical, marginTop: 8 }}>{err}</div>}
        <Button type="submit" variant="primary" block
          disabled={busy || name.trim().length === 0 || (mode === 'tunnel' && peerKey.trim().length === 0)}
          style={{ marginTop: 12 }}>{busy ? '…' : 'Create endpoint'}</Button>
      </form>
    </Modal>
  );
}

/* A label per flavour the generator can return. The TAB LIST itself is derived
 * from the response rather than written here: the two modes offer different
 * flavours, and a hardcoded list would either show a tab with nothing behind it
 * or hide one the server rendered. An unknown key falls back to its own name,
 * so adding a flavour server-side needs no frontend release. */
const SYSLOG_FLAVOUR_LABELS: Record<string, string> = {
  docker: 'Docker', systemd: 'systemd',
  rsyslog: 'rsyslog', 'syslog-ng': 'syslog-ng', test: 'Test it',
  wireguard: 'WireGuard', verify: 'Verify',
};

function SyslogEndpointFlyout({ row, minted, onClose, onChanged }: {
  row: SyslogEndpoint; minted: SyslogEndpointWithConfig | null;
  onClose: () => void; onChanged: () => void;
}) {
  const [snippets, setSnippets] = useState<SyslogSnippets | null>(minted ? minted.snippets : null);
  const [flavour, setFlavour] = useState<string>('');
  const [tp, setTp] = useState<SyslogThroughput | null>(null);

  useEffect(() => {
    if (minted) { setSnippets(minted.snippets); return; }
    setSnippets(null);
    api.get<SyslogSnippets>(`/api/syslog/endpoints/${row.id}/config`).then(setSnippets).catch(() => setSnippets({}));
  }, [row.id, minted]);

  useEffect(() => {
    setTp(null);
    api.get<SyslogThroughput>(`/api/syslog/endpoints/${row.id}/throughput?days=14`)
      .then(setTp).catch(() => setTp(null));
  }, [row.id]);

  const flavours = snippets ? Object.keys(snippets) : [];
  // The selection is only reset when it no longer exists — switching endpoints
  // between two of the same mode should not walk the reader back to tab one.
  const active = flavours.includes(flavour) ? flavour : (flavours[0] || '');
  const blocks = snippets ? snippets[active] || [] : null;

  return (
    <Flyout title={row.name} onClose={onClose}
      badges={<StatusPill text={row.enabled ? 'enabled' : 'disabled'}
        color={row.enabled ? SEV.green : SEV.medium} />}
      /* The mode leads, in every case. It decides what the customer installs and
       * it is changeable through PATCH, so a panel that only implies it — by
       * which config tabs happen to render — makes the reader infer the one
       * fact the screen exists to state. */
      sub={`${SYSLOG_MODE_LABELS[row.mode] || row.mode} · ${row.mode === 'tunnel'
        ? `${row.tunnelIp ?? '—'} · last seen ${relTime(row.lastSeenAt)}`
        : row.keyPrefix ? `${row.keyPrefix}… · last seen ${relTime(row.lastSeenAt)}` : 'key revoked'}`}
      actions={
        <Button size="sm" onClick={() => {
          if (!confirm(`Rotate the key for "${row.name}"? The current key stops working immediately.`)) return;
          api.post(`/api/syslog/endpoints/${row.id}/rotate`, {}).then(onChanged);
        }}><RefreshCwIcon size={13} /> Rotate key</Button>
      }>
      {minted?.key && (
        <div style={{ marginBottom: 14 }}>
          <div className="text-sm font-semibold text-text2" style={{ marginBottom: 6 }}>
            Collector key — shown once</div>
          <div className="mono text-md text-text0" style={{ background: 'var(--bg3)',
            border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px',
            userSelect: 'all', wordBreak: 'break-all' }}>{minted.key}</div>
          <CardNote>Copy the block below now — it already contains this key. Afterwards the
            configuration is still here, but the key is not: rotate to get a new one.</CardNote>
        </div>
      )}

      <ThroughputStrip tp={tp} />

      <Tabs value={active} onChange={setFlavour}
        tabs={flavours.map((f) => [f, SYSLOG_FLAVOUR_LABELS[f] || f] as const)} />
      {blocks === null && <ListSkeleton rows={2} />}
      {blocks?.map((b) => <SnippetBlock key={b.label} label={b.label} text={b.text} />)}

      <CardNote>Start with a single facility as shown, confirm the lines arrive under
        Logs, then widen the filter. A relay switched straight to <span className="mono">*.*</span> can
        use up a daily allowance before anyone has looked at the result.</CardNote>
    </Flyout>
  );
}

/**
 * Fourteen days of line counts for one endpoint.
 *
 * `logs.source` has held the key's name since the first collector shipped, and
 * the write-up said "which site is sending too much is answerable with no new
 * column anywhere". It was answerable in PRINCIPLE and nowhere on screen, which
 * is the same distance as not answerable.
 *
 * The gaps matter more than the line. A day with no lines is absent from the
 * response, so it is filled with a zero here rather than skipped: a relay that
 * stopped for two days is a flat gap in the middle of the series, and a chart
 * that quietly closed it up would draw a healthy endpoint.
 */
function ThroughputStrip({ tp }: { tp: SyslogThroughput | null }) {
  if (!tp) return <Skeleton w="100%" h={34} />;
  const DAY = 86400000;
  const end = Math.floor(Date.now() / DAY) * DAY;
  const byDay = new Map(tp.buckets.map((b) => [b.day, b.lines]));
  const series = Array.from({ length: tp.days },
    (_, i) => byDay.get(end - (tp.days - 1 - i) * DAY) ?? 0);
  const total = series.reduce((a, b) => a + b, 0);
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="row row-wrap" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <span className="micro text-2xs">LINES · LAST {tp.days} DAYS</span>
        <span className="mono text-sm text-text1"
          style={{ fontVariantNumeric: 'tabular-nums' }}>{total.toLocaleString()}</span>
      </div>
      <Spark data={series} fluid h={34} fill color={SEV.green} />
      {total === 0 && (
        <CardNote>Nothing has arrived yet. The configuration below is what the relay
          needs; check it there before looking anywhere else.</CardNote>
      )}
    </div>
  );
}

/** A copy-paste block. Same shape as the onboarding snippets, deliberately. */
function SnippetBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6, gap: 10 }}>
        <span className="text-sm font-semibold text-text2" style={{ minWidth: 0 }}>{label}</span>
        <Button size="sm" onClick={() => {
          navigator.clipboard?.writeText(text);
          setCopied(true); window.setTimeout(() => setCopied(false), 1500);
        }}>{copied ? <>Copied <CheckIcon size={13} /></> : 'Copy'}</Button>
      </div>
      <pre style={{ margin: 0, background: 'var(--bg1)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '12px 14px', overflowX: 'auto' }}>
        <code className="mono text-sm" style={{ lineHeight: 1.7, whiteSpace: 'pre' }}>
          {text.split('\n').map((ln, i) => (
            <span key={i} style={{ display: 'block',
              color: ln.trimStart().startsWith('#') ? 'var(--text3)' : 'var(--text1)' }}>{ln || ' '}</span>
          ))}
        </code>
      </pre>
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
// ------------------------------------------------------------- SMS / voice
/**
 * The telephony provider for On-Call (docs/ONCALL-V1.md §13.2).
 *
 * Deliberately an ADAPTER rather than one vendor: which provider OpsCat runs
 * itself is undecided, and a self-hoster with a GSM modem uses `webhook` and
 * waits for nobody. The credential is stored encrypted and never returned — the
 * same contract the AI and Voice cards use.
 */
function TelephonyCard() {
  const [cfg, setCfg] = useState<TelephonyConfig | null>(null);
  const [provider, setProvider] = useState<TelephonyConfig['provider']>('');
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [secret, setSecret] = useState('');      // write-only; never echoed back
  const [priceSms, setPriceSms] = useState('0');
  const [priceVoice, setPriceVoice] = useState('0');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api.get<TelephonyConfig>('/api/admin/telephony').then((c) => {
    setCfg(c); setProvider(c.provider); setAccount(c.account); setFrom(c.from);
    setWebhookUrl(c.webhookUrl);
    setPriceSms(String(c.priceSmsMicros || 0)); setPriceVoice(String(c.priceVoiceMicros || 0));
  }).catch(() => setCfg(null));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = {
        provider, account, from, webhookUrl,
        priceSmsMicros: Number(priceSms) || 0, priceVoiceMicros: Number(priceVoice) || 0,
      };
      if (secret) body.secret = secret;
      await api.put('/api/admin/telephony', body);
      setSecret(''); setDirty(false); setMsg({ ok: true, text: 'saved' });
      load();
    } catch (ex) { setMsg({ ok: false, text: ex instanceof ApiError ? ex.message : 'network error' }); }
    finally { setBusy(false); }
  };

  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); };

  return (
    <Card title="SMS &amp; voice (On-Call)">
      <CardNote>The loudest channels, and the only metered ones. Whoever is on call adds
        their own number under On-Call &rsaquo; My on-call and verifies it by SMS; a number
        that is not verified is never rung. A voice call speaks the alert and then waits
        for the key 1, which acknowledges it — without that it would be a robocall.</CardNote>
      {cfg === null ? <FormSkeleton rows={3} /> : (
        <>
          <Row label="Provider">
            <Select title="Provider" value={provider}
              onChange={(v) => touch(setProvider)(v as TelephonyConfig['provider'])}
              options={[
                { value: '', label: 'None — SMS and voice stay off' },
                { value: 'twilio', label: 'Twilio' },
                { value: 'vonage', label: 'Vonage' },
                { value: 'webhook', label: 'Your own gateway (webhook)' },
              ]} />
          </Row>
          {provider === 'webhook' ? (
            <Row label="Gateway URL" hint="POSTed {kind, to, text, ackUrl}; answer 2xx when accepted">
              <HostInput className="mono" value={webhookUrl} placeholder="https://sms-gw.internal/send"
                onChange={(e) => touch(setWebhookUrl)(e.target.value)} width="100%" />
            </Row>
          ) : provider ? (
            <>
              <Row label={provider === 'twilio' ? 'Account SID' : 'API key'}>
                <Input className="mono" value={account}
                  placeholder={provider === 'twilio' ? 'AC…' : 'a1b2c3d4'}
                  onChange={(e) => touch(setAccount)(e.target.value)} width="100%" />
              </Row>
              <Row label={cfg.hasSecret
                ? (provider === 'twilio' ? 'Auth token (stored)' : 'API secret (stored)')
                : (provider === 'twilio' ? 'Auth token' : 'API secret')}>
                <Input type="password" className="mono" value={secret}
                  placeholder={cfg.hasSecret ? '•••••••• (set — enter to replace)' : ''}
                  onChange={(e) => touch(setSecret)(e.target.value)} width="100%" />
              </Row>
              <Row label="Send from" hint="The number people see at 03:00. International format.">
                <HostInput className="mono" value={from} placeholder="+4915112345678"
                  onChange={(e) => touch(setFrom)(e.target.value)} width="100%" />
              </Row>
            </>
          ) : null}
          {provider && (
            <>
              {/* Providers differ on when they know a price — Vonage returns one
                  with the SMS, Twilio only after the call completes. These are
                  what the delivery log falls back to, so "what did last night
                  cost" has an answer either way. */}
              <Row label="Price per SMS" hint="In millionths of your currency — 7500 = 0.0075">
                <Input type="number" width={140} value={priceSms}
                  onChange={(e) => touch(setPriceSms)(e.target.value)} />
              </Row>
              <Row label="Price per call" hint="Used when the provider reports none at dial time">
                <Input type="number" width={140} value={priceVoice}
                  onChange={(e) => touch(setPriceVoice)(e.target.value)} />
              </Row>
            </>
          )}
          <div className="row row-wrap" style={{ justifyContent: 'space-between', marginTop: 8, gap: 10 }}>
            <span className="text-xs text-text3">
              {cfg.configured
                ? 'Configured — numbers can be verified and rung.'
                : 'Not configured — SMS and voice contact methods cannot be verified or used.'}
            </span>
            <span className="row" style={{ gap: 10 }}>
              {msg && <span className="text-sm font-semibold" style={{
                color: msg.ok ? SEV.green : SEV.critical }}>{msg.text}</span>}
              <Button variant="primary" size="sm" onClick={save} disabled={!dirty || busy}>
                {busy ? 'Saving…' : 'Save SMS & Voice'}
              </Button>
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

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
      setMsg({ ok: true, text: 'saved' });
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
    <Card title="AI">
      <CardNote>Any OpenAI-compatible endpoint (OpenRouter, Ollama, vLLM, Azure, …). Leave
        empty to use the platform default{status?.platformConfigured === false ? ' (currently not configured)' : ''}.
        The API key is stored encrypted and never shown again.</CardNote>
      {status === null ? <FormSkeleton rows={3} /> : (
        <>
          <Row label="Base URL">
            <HostInput className="mono" value={baseUrl} placeholder="https://openrouter.ai/api/v1"
              onChange={(e) => { setBaseUrl(e.target.value); setDirty(true); }} width="100%" />
          </Row>
          <Row label="Model">
            <Input className="mono" value={model} placeholder="anthropic/claude-haiku-4.5"
              onChange={(e) => { setModel(e.target.value); setDirty(true); }} width="100%" />
          </Row>
          <Row label={status.org.hasKey ? 'API key (stored)' : 'API key'}>
            <div className="row" style={{ gap: 8 }}>
              <Input type="password" className="mono" value={apiKey}
                placeholder={status.org.hasKey ? '•••••••• (set — enter to replace)' : 'sk-…'}
                onChange={(e) => { setApiKey(e.target.value); setDirty(true); }} style={{ flex: 1 }} />
              {status.org.hasKey && (
                <Button size="sm" onClick={clearKey} disabled={!!busy}>Remove</Button>
              )}
            </div>
          </Row>
          <div className="row row-wrap" style={{ justifyContent: 'space-between', marginTop: 8, gap: 10 }}>
            <span className="text-xs text-text3">{effective}</span>
            <span className="row" style={{ gap: 10 }}>
              {msg && <span className="text-sm font-semibold" style={{
                color: msg.ok ? SEV.green : SEV.critical }}>{msg.text}</span>}
              <Button size="sm" onClick={test} disabled={!!busy || dirty}
                title={dirty ? 'Save first' : 'Send a one-line test prompt'}>
                {busy === 'test' ? 'Testing…' : 'Test'}
              </Button>
              <Button variant="primary" size="sm" onClick={save} disabled={!dirty || !!busy}>
                {busy === 'save' ? 'Saving…' : 'Save AI Settings'}
              </Button>
            </span>
          </div>
        </>
      )}
    </Card>
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
      setMsg({ ok: true, text: 'saved' });
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
    <Card title="Voice / Transcription">
      <CardNote>Speech-to-text for the Bridge live transcript. Any OpenAI-compatible
        transcription endpoint (OpenAI, Groq, a local Whisper server, …) — speech chunks go
        to <span className="mono">/audio/transcriptions</span>. Leave empty to use the platform
        default{status?.platformConfigured === false ? ' (currently not configured)' : ''}.
        The API key is stored encrypted and never shown again.</CardNote>
      {status === null ? <FormSkeleton rows={3} /> : (
        <>
          <Row label="Base URL">
            <HostInput className="mono" value={baseUrl} placeholder="https://api.openai.com/v1"
              onChange={(e) => { setBaseUrl(e.target.value); setDirty(true); }} width="100%" />
          </Row>
          <Row label="Model">
            <Input className="mono" value={model} placeholder="gpt-4o-mini-transcribe"
              onChange={(e) => { setModel(e.target.value); setDirty(true); }} width="100%" />
          </Row>
          <Row label={status.org.hasKey ? 'API key (stored)' : 'API key'}>
            <div className="row" style={{ gap: 8 }}>
              <Input type="password" className="mono" value={apiKey}
                placeholder={status.org.hasKey ? '•••••••• (set — enter to replace)' : 'sk-…'}
                onChange={(e) => { setApiKey(e.target.value); setDirty(true); }} style={{ flex: 1 }} />
              {status.org.hasKey && (
                <Button size="sm" onClick={clearKey} disabled={busy}>Remove</Button>
              )}
            </div>
          </Row>
          <div className="row row-wrap" style={{ justifyContent: 'space-between', marginTop: 8, gap: 10 }}>
            <span className="text-xs text-text3">{effective}</span>
            <span className="row" style={{ gap: 10 }}>
              {msg && <span className="text-sm font-semibold" style={{
                color: msg.ok ? SEV.green : SEV.critical }}>{msg.text}</span>}
              <Button size="sm" onClick={test} disabled={busy || dirty}
                title={dirty ? 'Save first' : 'Round-trip a short test tone through the endpoint'}>
                Test
              </Button>
              <Button variant="primary" size="sm" onClick={save} disabled={!dirty || busy}>
                {busy ? 'Saving…' : 'Save Voice Settings'}
              </Button>
            </span>
          </div>
        </>
      )}
    </Card>
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
    <Card title="Maintenance Windows">
      <CardNote>While a window is active, events keep recording but no alerts are sent
        (the notification log shows them as suppressed).</CardNote>
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
          {canEdit && <button title="Delete" style={{ color: SEV.critical, display: 'inline-flex' }}
            onClick={() => remove(w)}><XIcon size={15} /></button>}
        </div>
      ))}
      {canEdit && (
        <form onSubmit={add} className="row row-wrap" style={{ gap: 12, marginTop: 12,
          alignItems: 'flex-end' }}>
          {/* Labelled, because "e.g. core switch upgrade" next to two identical
              date boxes leaves you guessing which one is the start. A placeholder
              is not a label — it disappears the moment you type. */}
          <Field label="Window name">
            <Input required value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. core switch upgrade" width={220} />
          </Field>
          <Field label="Starts">
            <DateTime required value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Ends">
            <DateTime required value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button size="sm" style={{ marginBottom: 2 }}><PlusIcon size={13} /> Add window</Button>
          {err && <span className="text-sm" style={{ color: SEV.critical }}>{err}</span>}
        </form>
      )}
    </Card>
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
    <Card style={{ flex: 1, minWidth: 200, background: 'var(--bg1)',
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
              <CheckIcon size={13} style={{ color: '#3fb950', flexShrink: 0 }} />{f}
            </li>
          ))}
        </ul>
      )}
      {current ? (
        <Button size="sm" disabled block style={{ opacity: 0.6 }}>
          Current plan
        </Button>
      ) : (
        <Button variant="primary" size="sm" block
          disabled={!canBuy || busy} title={canBuy ? undefined : 'Admin only'} onClick={onBuy}>
          {busy ? '…' : 'Upgrade'}
        </Button>
      )}
    </Card>
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
      // drop the query, keep the tab — the page is addressed by its tab now
      history.replaceState(null, '', '/app/settings/billing');
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
      <Card title="Plan &amp; Billing">
        {bannerEl}
        <Skeleton w={92} h={18} radius={10} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))',
          gap: 14, marginTop: 16 }}>
          {USAGE_METRICS.map((m) => <UsageBar key={m.key} label={m.label} used={null} limit={0} />)}
        </div>
      </Card>
    );
  }

  // community edition / billing disabled
  const showBilling = !!status && (status.billingEnabled || edition === 'cloud');
  if (!showBilling) {
    return (
      <Card title="Plan &amp; Billing">
        {bannerEl}
        <div className="text-base text-text2">
          Community Edition (CE) — all features unlocked.
        </div>
      </Card>
    );
  }

  const s = status as BillingStatus;
  const trial = fmtBillingDate(s.trialEndsAt);
  const renew = fmtBillingDate(s.currentPeriodEnd);
  const upgradePlans = plans.filter((p) => p.key === 'pro' || p.key === 'business');

  return (
    <Card title="Plan &amp; Billing"
      actions={s.hasBilling && s.billingEnabled && isAdmin && (
        <Button size="sm" onClick={portal} disabled={busy === 'portal'}>
          {busy === 'portal' ? '…' : 'Manage billing'}
        </Button>
      )}>
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
    </Card>
  );
}

// ---------------------------------------------------------------- small helpers

// `Row` and `CardNote` moved to ui.tsx so the Status Page's branding form is the
// same component and not a lookalike. Row stays aliased here: this file names it
// ~90 times and a rename would be noise in the diff for no reader's benefit.
const Row = FormRow;
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
        <Button variant="primary" block
          disabled={busy || scopes.length === 0}>{busy ? '…' : 'Create'}</Button>
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
        <Button variant="primary" block
          disabled={busy}>{busy ? '…' : 'Register'}</Button>
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
          <HostInput required value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.1" />
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
            <Input type="password" autoComplete="off" data-1p-ignore data-lpignore="true"
              value={community} onChange={(e) => setCommunity(e.target.value)} placeholder="public" />
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
        <Button variant="primary" block
          disabled={busy}>{busy ? '…' : 'Add target'}</Button>
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
      <Button variant="primary" block style={{ marginTop: 12 }}
        onClick={onClose}>Done</Button>
    </Modal>
  );
}
