// StatusPageAdmin — public status page management, in URL-addressable tabs:
// components + publish, branding & pages (logo/colours/theme/whitelabel/custom
// CSS/custom domain/private audience pages), e-mail subscribers, and anonymous
// user problem reports (Downdetector-style).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useTab } from '../state';
import { api, ApiError } from '../api';
import { alpha, relTime, STATUS_META } from '../format';
import { Card, Button, Toggle, GlowDot, Modal, Field, TableScroll, TableSkeleton, ListSkeleton, PageHeader,
  Input, Textarea, HostInput, ColorPicker, Tabs, Busy, Skeleton } from '../ui';
import { Select } from '../Select';
import type { Component, CompStatus, StatusPage, StatusPagesResponse, StatusReportsResponse } from '../types';
import {
  ExternalLinkIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react';

const GRID = '20px 1fr 100px 150px 150px 260px 70px';
// colors, ranks and the status list all come from the shared scale
// (format.ts STATUS_META — mirror of server/src/lib/status-scale.js)
const COMP_COLOR = Object.fromEntries(
  Object.entries(STATUS_META).map(([k, v]) => [k, v.color])) as Record<CompStatus, string>;
const COMP_STATUSES = Object.keys(STATUS_META) as CompStatus[];
const RANK = Object.fromEntries(
  Object.entries(STATUS_META).map(([k, v]) => [k, v.rank])) as Record<CompStatus, number>;
const OVERALL: Record<CompStatus, string> = {
  operational: 'All Systems Operational',
  maintenance: 'Scheduled Maintenance in Progress',
  degraded: 'Degraded Performance',
  partial: 'Partial Outage',
  major: 'Major Outage',
};
const ROLE_RANK: Record<string, number> = { analyst: 0, lead: 1, cto: 2, admin: 3 };

// uptime-strip cell color (maintenance shares the amber warning tone here)
function dayColor(w: CompStatus): string {
  if (w === 'operational') return alpha(STATUS_META.operational.color, 0.55);
  if (w === 'maintenance') return STATUS_META.degraded.color;
  return STATUS_META[w].color;
}

export default function StatusPageAdmin() {
  const app = useApp();
  const role = app.user?.role;
  const isAdmin = role === 'admin';
  const canEdit = (ROLE_RANK[role ?? ''] ?? 0) >= ROLE_RANK.lead; // lead+
  const [published, setPublished] = useState(app.settings.status_published === '1');

  useEffect(() => { setPublished(app.settings.status_published === '1'); }, [app.settings.status_published]);

  // Branding and subscribers are lead+ surfaces, so the TABS themselves come and
  // go with the role — an analyst never sees a tab that would only 403. useTab
  // falls back to the first id, so an analyst on a deep link to /branding lands
  // on Components rather than on a blank page.
  const tabs = useMemo(() => ([
    ['components', 'Components'] as const,
    ...(canEdit ? [['branding', 'Branding & pages'] as const, ['subscribers', 'Subscribers'] as const] : []),
    ['reports', 'User reports'] as const,
  ]), [canEdit]);
  const [tab, setTab] = useTab(tabs.map((t) => t[0]));

  const togglePublish = async () => {
    const next = !published;
    setPublished(next);
    try { await api.patch('/api/admin/settings', { status_published: next ? '1' : '0' }); }
    catch { setPublished(!next); }
  };

  return (
    <div className="page">
      <PageHeader title="Status Page">
        {isAdmin && (
          <span className="row" style={{ gap: 8 }}>
            <Toggle on={published} onClick={togglePublish} />
            <span className="micro text-2xs">{published ? 'Published' : 'Unpublished'}</span>
          </span>
        )}
        <a className="btn" href="/status" target="_blank" rel="noreferrer">
          View public page <ExternalLinkIcon size={13} /></a>
      </PageHeader>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'components' && <Components />}
      {tab === 'branding' && <Branding isAdmin={isAdmin} />}
      {tab === 'subscribers' && <Subscribers isAdmin={isAdmin} />}
      {tab === 'reports' && <UserReports isAdmin={isAdmin} />}
    </div>
  );
}

// ------------------------------------------------------------------ components

function Components() {
  const app = useApp();
  const [components, setComponents] = useState<Component[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = () => api.get<Component[]>('/api/admin/components').then(setComponents).catch(() => setComponents([]));
  useEffect(() => { load(); }, []);

  const role = app.user?.role;
  const isAnalyst = role === 'analyst';
  const canEdit = (ROLE_RANK[role ?? ''] ?? 0) >= ROLE_RANK.lead; // lead+

  const setStatus = async (id: number, status: CompStatus) => {
    await api.patch(`/api/admin/components/${id}`, { status });
    load();
  };
  const setOwner = async (id: number, v: string) => {
    await api.patch(`/api/admin/components/${id}`, { ownerId: v === '' ? null : Number(v) });
    load();
  };
  const remove = async (c: Component) => {
    if (!window.confirm(`Delete component “${c.name}”?`)) return;
    await api.del(`/api/admin/components/${c.id}`);
    load();
  };

  const worst: CompStatus = components && components.length
    ? components.reduce<CompStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'operational')
    : 'operational';
  const overallColor = COMP_COLOR[worst];

  return (
    <>
      {/* overall banner */}
      <Card style={{ borderColor: alpha(overallColor, 0.4), background: alpha(overallColor, 0.06) }}>
        <div className="row" style={{ gap: 10 }}>
          <GlowDot color={overallColor} size={10} />
          <span className="text-lg font-bold" style={{ color: overallColor }}>{OVERALL[worst]}</span>
        </div>
      </Card>

      {/* components table */}
      <Card style={{ padding: 0 }}>
        <div className="row row-wrap" style={{ justifyContent: 'space-between', padding: '12px 16px', gap: 8 }}>
          <span className="card-title" style={{ margin: 0 }}>Components</span>
          {canEdit && <Button size="sm" onClick={() => setShowAdd(true)}><PlusIcon size={13} /> Add component</Button>}
        </div>
        <div className="text-2xs text-text3" style={{ padding: '0 16px 10px' }}>
          Status follows the worst impact of open incidents — a manual change is
          recomputed away on the next incident transition. Owner feeds auto-assign.
        </div>
        <TableScroll stickyFirst minWidth={940}>
        <div className="tbl-head" style={{ gridTemplateColumns: GRID }}>
          <span />
          <span>Name</span>
          <span>Group</span>
          <span>Status</span>
          <span>Owner</span>
          <span>45-day uptime</span>
          <span style={{ textAlign: 'right' }}>Uptime</span>
        </div>
        {components === null && <TableSkeleton cols={GRID} rows={5} />}
        {components && components.length === 0 && (
          <div className="text-text3 text-sm" style={{ padding: 20}}>No components yet.</div>
        )}
        {components?.map((c) => {
          const pct = c.uptimePct.replace(/%/g, '');
          return (
            <div key={c.id} className="tbl-row" style={{ gridTemplateColumns: GRID }}>
              <GlowDot color={COMP_COLOR[c.status]} />
              <span className="text-base font-semibold text-text0">{c.name}</span>
              <span className="mono text-xs text-text2">{c.group}</span>
              <Select title="Component status" value={c.status} disabled={isAnalyst}
                onChange={(v) => setStatus(c.id, v as CompStatus)}
                options={COMP_STATUSES.map((s) => ({ value: s, label: STATUS_META[s].label }))} />
              <Select title="Component owner" placeholder="— no owner" aria-label="Component owner"
                value={c.ownerId ? String(c.ownerId) : ''} disabled={!canEdit}
                onChange={(v) => setOwner(c.id, v)}
                options={[{ value: '', label: '— no owner' },
                  ...app.users.map((u) => ({ value: String(u.id), label: u.name }))]} />
              <UptimeStrip days={c.days} />
              <span className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <span className="mono text-sm text-text1">{pct}%</span>
                {canEdit && (
                  <Button size="sm" variant="danger" title="Delete" aria-label="Delete component"
 onClick={() => remove(c)}><XIcon size={13} /></Button>
                )}
              </span>
            </div>
          );
        })}
        </TableScroll>
      </Card>

      {showAdd && <AddComponentModal onClose={() => setShowAdd(false)}
        onAdded={() => { setShowAdd(false); load(); }} />}
    </>
  );
}

// ------------------------------------------------------------------ branding & pages

const THEME_OPTIONS = [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }];
// Raster only — the server refuses SVG (a script-bearing document served from
// the status page's own origin), so the picker must not offer it either.
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/x-icon';

function Branding({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<StatusPagesResponse | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [showNew, setShowNew] = useState(false);

  const load = (keep?: number) => api.get<StatusPagesResponse>('/api/admin/status-pages')
    .then((d) => {
      setData(d);
      setSel((cur) => {
        const want = keep ?? cur;
        return d.pages.some((p) => p.id === want) ? want! : (d.pages[0]?.id ?? null);
      });
    })
    .catch(() => setData(null));
  useEffect(() => { load(); }, []);

  const page = data?.pages.find((p) => p.id === sel) ?? null;

  if (data === null) return <Busy><Card><Skeleton h={120} /></Card></Busy>;
  if (!page) return <Card>No status page yet.</Card>;

  return (
    <>
      {(data.pages.length > 1 || data.limits.canMultiPage) && (
        <Card>
          <div className="row row-wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
            <Field label="Status page">
              <Select title="Status page" value={String(page.id)}
                style={{ flex: '1 1 220px', maxWidth: 320 }}
                onChange={(v) => setSel(Number(v))}
                options={data.pages.map((p) => ({
                  value: String(p.id),
                  label: `${p.name}${p.isDefault ? ' (main)' : ''}${p.visibility === 'private' ? ' · private' : ''}`,
                }))} />
            </Field>
            {isAdmin && data.limits.canMultiPage && (
              <Button size="sm" style={{ marginBottom: 10 }} onClick={() => setShowNew(true)}>
                <PlusIcon size={13} /> New page</Button>
            )}
            <span style={{ flex: 1 }} />
            <a className="btn" style={{ marginBottom: 10 }} href={pagePath(page)}
              target="_blank" rel="noreferrer">Open <ExternalLinkIcon size={13} /></a>
          </div>
        </Card>
      )}

      <PageEditor key={page.id} page={page} limits={data.limits} isAdmin={isAdmin}
        defaultAccent={data.defaultAccent} onChanged={() => load(page.id)}
        onDeleted={() => { setSel(null); load(); }} onError={setErr} err={err} />

      {showNew && <NewPageModal onClose={() => setShowNew(false)}
        onCreated={(id) => { setShowNew(false); load(id); }} />}
    </>
  );
}

// The in-app link to a page. Private pages carry their secret, because that IS
// the link the admin is meant to hand out.
function pagePath(p: StatusPage): string {
  const base = p.isDefault ? '/status' : `/status/${p.slug}`;
  return p.visibility === 'private' && p.accessToken ? `${base}?k=${p.accessToken}` : base;
}

function PageEditor({ page, limits, isAdmin, defaultAccent, onChanged, onDeleted, onError, err }: {
  page: StatusPage;
  limits: StatusPagesResponse['limits'];
  isAdmin: boolean; defaultAccent: string;
  onChanged: () => void; onDeleted: () => void;
  onError: (m: string) => void; err: string;
}) {
  const [name, setName] = useState(page.name);
  const [desc, setDesc] = useState(page.description);
  const [support, setSupport] = useState(page.supportUrl);
  const [legal, setLegal] = useState(page.legalUrl);
  const [css, setCss] = useState(page.customCss);

  // One saver for every field: PATCH, then re-read so the preview shows what the
  // PUBLIC page will show rather than what this form hopes.
  const save = async (patch: Record<string, unknown>, revert?: () => void) => {
    onError('');
    try { await api.patch(`/api/admin/status-pages/${page.id}`, patch); onChanged(); }
    catch (e) { revert?.(); onError(e instanceof ApiError ? e.message : 'could not save'); }
  };

  const r = page.resolved;

  return (
    <>
      <Card title="Identity">
        <div className="text-2xs text-text3" style={{ marginBottom: 12 }}>
          Logo, colours and links are included on every plan — a status page is public,
          so it should look like yours from the first day.
        </div>
        <Field label="Page name">
          <Input value={name} width={260} disabled={!isAdmin} maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== page.name && save({ name })} />
        </Field>
        <AssetRow pageId={page.id} kind="logo" label="Logo"
          hint="PNG, JPEG, WebP or ICO · max 512 KB · shown at 32px tall"
          asset={page.logo} url={r.logoUrl} disabled={!isAdmin}
          onChanged={onChanged} onError={onError} />
        <AssetRow pageId={page.id} kind="favicon" label="Favicon"
          hint="Falls back to the logo when empty"
          asset={page.favicon} url={r.faviconUrl} disabled={!isAdmin}
          onChanged={onChanged} onError={onError} />

        <div className="row row-wrap" style={{ gap: 24, alignItems: 'flex-start', marginTop: 6 }}>
          <Field label="Accent colour">
            <ColorPicker value={page.accent || defaultAccent} disabled={!isAdmin}
              onChange={(v) => save({ accent: v })} />
          </Field>
          <Field label="Theme">
            <Select title="Theme" value={page.theme} disabled={!isAdmin}
              onChange={(v) => save({ theme: v })} options={THEME_OPTIONS} />
          </Field>
        </div>

        <Field label="Description (optional)">
          <Textarea value={desc} maxLength={300} disabled={!isAdmin} rows={2}
            placeholder="Live and historical status for the Acme platform."
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => desc !== page.description && save({ description: desc })} />
        </Field>
        <div className="row row-wrap" style={{ gap: 24, alignItems: 'flex-start' }}>
          <Field label="Support link (optional)">
            <HostInput value={support} width={260} disabled={!isAdmin}
              placeholder="https://acme.example/support"
              onChange={(e) => setSupport(e.target.value)}
              onBlur={() => support !== page.supportUrl && save({ supportUrl: support })} />
          </Field>
          <Field label="Legal / imprint link (optional)">
            <HostInput value={legal} width={260} disabled={!isAdmin}
              placeholder="https://acme.example/imprint"
              onChange={(e) => setLegal(e.target.value)}
              onBlur={() => legal !== page.legalUrl && save({ legalUrl: legal })} />
          </Field>
        </div>
        {err && <div className="text-sm" style={{ color: '#f85149' }}>{err}</div>}
      </Card>

      <Card title="Preview">
        <div style={{ background: r.palette.bg, border: `1px solid ${r.palette.borderStrong}`,
          borderRadius: 8, padding: 16 }}>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            {r.logoUrl
              ? <img src={r.logoUrl} alt="" style={{ height: 32, maxWidth: 220, objectFit: 'contain' }} />
              : <span style={{ width: 26, height: 26, borderRadius: 6, flexShrink: 0,
                background: `linear-gradient(135deg, ${r.accent}, ${r.accentDark})` }} />}
            <span className="text-lg font-bold" style={{ color: r.palette.heading }}>
              {page.name} Status</span>
          </div>
          {r.description && (
            <div className="text-sm" style={{ color: r.palette.muted, marginTop: 8 }}>{r.description}</div>)}
          <div className="row" style={{ gap: 10, marginTop: 12, padding: 12, borderRadius: 8,
            background: r.palette.surface, border: `1px solid ${r.palette.borderStrong}` }}>
            <GlowDot color={STATUS_META.operational.color} size={10} />
            <span className="text-sm font-semibold" style={{ color: r.palette.heading }}>
              All Systems Operational</span>
          </div>
          <div className="row" style={{ gap: 10, marginTop: 12, alignItems: 'center' }}>
            <span style={{ background: r.accent, color: r.accentInk, borderRadius: 6,
              padding: '6px 14px', fontWeight: 600 }} className="text-xs">Subscribe</span>
            <span className="text-2xs" style={{ color: r.palette.faint }}>
              {r.hidePowered ? '' : 'Powered by OpsCat · '}Atom feed
              {r.supportUrl ? ' · Support' : ''}{r.legalUrl ? ' · Legal' : ''}</span>
          </div>
        </div>
        <div className="text-2xs text-text3" style={{ marginTop: 8 }}>
          Rendered from the same values the public page uses. Custom CSS is not applied
          here — <a href={pagePath(page)} target="_blank" rel="noreferrer">open the page</a> to see it.
        </div>
      </Card>

      <VisibilityCard page={page} limits={limits} isAdmin={isAdmin} save={save}
        onChanged={onChanged} onError={onError} />

      <DomainCard page={page} canCustomDomain={limits.canCustomDomain} isAdmin={isAdmin}
        onChanged={onChanged} onError={onError} />

      <Card title="Whitelabel">
        <div className="row row-wrap" style={{ gap: 10, justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="text-sm text-text1">Hide “Powered by OpsCat” in the page footer</div>
            <div className="text-2xs text-text3" style={{ marginTop: 2 }}>
              {limits.canWhitelabel
                ? 'The footer keeps the machine-readable JSON and Atom links either way.'
                : 'Available from the Business plan. Everything else in Identity is included on your plan.'}
            </div>
          </div>
          <Toggle on={page.hidePowered && limits.canWhitelabel} disabled={!isAdmin || !limits.canWhitelabel}
            onClick={() => save({ hidePowered: !page.hidePowered })} />
        </div>
      </Card>

      <Card title="Custom CSS">
        <div className="text-2xs text-text3" style={{ marginBottom: 8 }}>
          {limits.canCustomCss
            ? 'Appended to the page’s own stylesheet, so any selector on the page can be overridden. A closing </style> tag is refused.'
            : 'Available from the Business plan.'}
        </div>
        <Textarea className="mono" value={css} rows={6} disabled={!isAdmin || !limits.canCustomCss}
          placeholder=".comp { border-radius: 12px }"
          onChange={(e) => setCss(e.target.value)}
          onBlur={() => css !== page.customCss && save({ customCss: css }, () => setCss(page.customCss))} />
      </Card>

      {isAdmin && !page.isDefault && (
        <Card title="Delete page">
          <div className="row row-wrap" style={{ gap: 10, justifyContent: 'space-between' }}>
            <span className="text-2xs text-text3" style={{ flex: 1, minWidth: 0 }}>
              Removes the page, its branding and its subscribers. The components themselves stay.
            </span>
            <Button size="sm" variant="danger" onClick={async () => {
              if (!window.confirm(`Delete the status page “${page.name}”?`)) return;
              try { await api.del(`/api/admin/status-pages/${page.id}`); onDeleted(); }
              catch (e) { onError(e instanceof ApiError ? e.message : 'could not delete'); }
            }}>Delete page</Button>
          </div>
        </Card>
      )}
    </>
  );
}

// ---- visibility + which components a page shows ----

function VisibilityCard({ page, limits, isAdmin, save, onChanged, onError }: {
  page: StatusPage; limits: StatusPagesResponse['limits']; isAdmin: boolean;
  save: (patch: Record<string, unknown>) => void;
  onChanged: () => void; onError: (m: string) => void;
}) {
  const [comps, setComps] = useState<Component[] | null>(null);
  useEffect(() => { api.get<Component[]>('/api/admin/components').then(setComps).catch(() => setComps([])); }, []);
  const all = page.componentIds === null;

  return (
    <Card title="Audience">
      {!page.isDefault && (
        <div className="row row-wrap" style={{ gap: 10, justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="text-sm text-text1">Private page</div>
            <div className="text-2xs text-text3" style={{ marginTop: 2 }}>
              Reachable only with the secret link below, and never indexed. Everyone who has
              the link is the audience — rotate it to revoke access.
            </div>
          </div>
          <Toggle on={page.visibility === 'private'} disabled={!isAdmin || !limits.canMultiPage}
            onClick={() => save({ visibility: page.visibility === 'private' ? 'public' : 'private' })} />
        </div>
      )}

      {page.visibility === 'private' && page.accessToken && (
        <div className="row row-wrap" style={{ gap: 8, marginBottom: 12 }}>
          <Input className="mono" readOnly value={`${location.origin}${pagePath(page)}`} width={380}
            onFocus={(e) => e.currentTarget.select()} aria-label="Private page link" />
          <Button size="sm" disabled={!isAdmin} onClick={async () => {
            if (!window.confirm('Rotate the link? Everyone who has the current one loses access.')) return;
            try { await api.post(`/api/admin/status-pages/${page.id}/rotate-token`); onChanged(); }
            catch (e) { onError(e instanceof ApiError ? e.message : 'could not rotate'); }
          }}>Rotate link</Button>
        </div>
      )}

      <div className="text-2xs micro" style={{ marginBottom: 6 }}>Components shown</div>
      {comps === null ? <ListSkeleton rows={3} lines={1} /> : (
        <>
          <label className="row" style={{ gap: 8, padding: '3px 0' }}>
            <input type="checkbox" checked={all} disabled={!isAdmin}
              onChange={() => save({ componentIds: all ? comps.map((c) => c.id) : [] })} />
            <span className="text-sm text-text1">All components</span>
            <span className="text-2xs text-text3">— including ones added later</span>
          </label>
          {!all && comps.map((c) => (
            <label key={c.id} className="row" style={{ gap: 8, padding: '3px 0 3px 22px' }}>
              <input type="checkbox" disabled={!isAdmin}
                checked={(page.componentIds || []).includes(c.id)}
                onChange={(e) => {
                  const cur = new Set(page.componentIds || []);
                  if (e.target.checked) cur.add(c.id); else cur.delete(c.id);
                  // an empty selection would mean "all" on the server, which is the
                  // opposite of what unticking the last box asks for
                  save({ componentIds: cur.size ? [...cur] : [-1] });
                }} />
              <span className="text-sm text-text1">{c.name}</span>
              <span className="mono text-2xs text-text3">{c.group}</span>
            </label>
          ))}
        </>
      )}
    </Card>
  );
}

// ---- custom domain ----

function DomainCard({ page, canCustomDomain, isAdmin, onChanged, onError }: {
  page: StatusPage; canCustomDomain: boolean; isAdmin: boolean;
  onChanged: () => void; onError: (m: string) => void;
}) {
  const [domain, setDomain] = useState(page.domain);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const verified = !!page.domainVerifiedAt;

  const claim = async () => {
    setBusy(true); setResult(''); onError('');
    try { await api.post(`/api/admin/status-pages/${page.id}/domain`, { domain }); onChanged(); }
    catch (e) { onError(e instanceof ApiError ? e.message : 'could not save the domain'); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setResult(''); onError('');
    try {
      await api.post(`/api/admin/status-pages/${page.id}/domain/verify`);
      setResult('Verified — the page is now served on your own domain.');
      onChanged();
    } catch (e) { setResult(e instanceof ApiError ? e.message : 'verification failed'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setResult(''); onError('');
    try { await api.del(`/api/admin/status-pages/${page.id}/domain`); setDomain(''); onChanged(); }
    catch (e) { onError(e instanceof ApiError ? e.message : 'could not remove the domain'); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Custom domain">
      <div className="text-2xs text-text3" style={{ marginBottom: 10 }}>
        {canCustomDomain
          ? 'Serve this page on your own hostname. The certificate is issued automatically once DNS is in place.'
          : 'Available from the Pro plan.'}
      </div>
      <div className="row row-wrap" style={{ gap: 8, alignItems: 'center' }}>
        <HostInput value={domain} width={260} disabled={!isAdmin || !canCustomDomain}
          placeholder="status.acme.com" onChange={(e) => setDomain(e.target.value)} />
        <Button size="sm" disabled={!isAdmin || !canCustomDomain || busy || !domain
          || domain === page.domain} onClick={claim}>Save</Button>
        {page.domain && (
          <>
            <Button size="sm" variant="primary" disabled={!isAdmin || busy} onClick={verify}>
              {verified ? 'Re-check DNS' : 'Verify'}</Button>
            <Button size="sm" variant="danger" disabled={!isAdmin || busy} onClick={remove}>Remove</Button>
          </>
        )}
        {page.domain && (
          <span className="text-2xs" style={{ color: verified ? STATUS_META.operational.color : 'var(--text3)' }}>
            {verified ? '● verified' : '○ not verified yet'}
          </span>
        )}
      </div>

      {page.dns && !verified && (
        <div style={{ marginTop: 12 }}>
          <div className="text-2xs micro" style={{ marginBottom: 4 }}>Add these two DNS records</div>
          <TableScroll minWidth={520}>
            <div className="tbl-head" style={{ gridTemplateColumns: DNS_GRID }}>
              <span>Type</span><span>Host</span><span>Value</span></div>
            {[page.dns.challenge, page.dns.routing].map((rec) => (
              <div key={rec.type} className="tbl-row" style={{ gridTemplateColumns: DNS_GRID }}>
                <span className="mono text-xs text-text2">{rec.type}</span>
                <span className="mono text-xs text-text1" style={{ overflowWrap: 'anywhere' }}>{rec.host}</span>
                <span className="mono text-xs text-text1" style={{ overflowWrap: 'anywhere' }}>{rec.value}</span>
              </div>
            ))}
          </TableScroll>
          <div className="text-2xs text-text3" style={{ marginTop: 6 }}>
            The TXT record proves you own the domain — we will not serve or request a
            certificate for it until it is there. The CNAME routes the traffic.
          </div>
        </div>
      )}
      {result && <div className="text-sm" style={{ marginTop: 10,
        color: verified ? STATUS_META.operational.color : '#f85149' }}>{result}</div>}
    </Card>
  );
}

const DNS_GRID = '70px 1fr 1fr';

// ---- new page ----

function NewPageModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const p = await api.post<StatusPage>('/api/admin/status-pages',
        { name, slug, visibility: priv ? 'private' : 'public' });
      onCreated(p.id);
    } catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); setBusy(false); }
  };

  return (
    <Modal title="New status page" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name">
          <Input required autoFocus value={name} maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
              if (!slug) setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
            }}
            placeholder="Partner Portal" />
        </Field>
        <Field label="URL slug">
          <Input required value={slug} className="mono" maxLength={41}
            onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="partners" />
        </Field>
        <label className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
          <span className="text-sm text-text1">Private — reachable only with a secret link</span>
        </label>
        {err && <div className="text-sm" style={{ color: '#f85149', marginBottom: 8 }}>{err}</div>}
        <Button variant="primary" block disabled={busy || !name || !slug}>
          {busy ? '…' : 'Create page'}</Button>
      </form>
    </Modal>
  );
}

// One uploaded image: preview, replace, remove. The file never touches a
// multipart parser — it is read to a data URI in the browser and PUT as JSON,
// which is why the server strips the `data:...;base64,` prefix.
function AssetRow({ pageId, kind, label, hint, asset, url, disabled, onChanged, onError }: {
  pageId: number;
  kind: 'logo' | 'favicon';
  label: string; hint: string;
  asset: { mime: string; updatedAt: number } | null;
  url: string; disabled: boolean;
  onChanged: () => void; onError: (m: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = (f: File | undefined) => {
    if (!f) return;
    setBusy(true); onError('');
    const rd = new FileReader();
    rd.onerror = () => { setBusy(false); onError('could not read that file'); };
    rd.onload = async () => {
      try {
        await api.put(`/api/admin/status-pages/${pageId}/asset/${kind}`, { data: String(rd.result) });
        onChanged();
      } catch (e) {
        onError(e instanceof ApiError ? e.message : 'upload failed');
      } finally {
        setBusy(false);
        if (fileRef.current) fileRef.current.value = ''; // same file twice must re-fire
      }
    };
    rd.readAsDataURL(f);
  };

  const remove = async () => {
    setBusy(true); onError('');
    try { await api.del(`/api/admin/status-pages/${pageId}/asset/${kind}`); onChanged(); }
    catch (e) { onError(e instanceof ApiError ? e.message : 'could not remove'); }
    finally { setBusy(false); }
  };

  return (
    <div className="row row-wrap" style={{ gap: 12, alignItems: 'center', marginBottom: 12 }}>
      <div style={{ width: 120, flexShrink: 0 }}>
        <div className="micro text-2xs">{label}</div>
        <div className="text-2xs text-text3">{hint}</div>
      </div>
      <div className="row" style={{ width: 96, height: 40, flexShrink: 0, justifyContent: 'center',
        alignItems: 'center', border: '1px solid var(--bg3)', borderRadius: 6, overflow: 'hidden' }}>
        {asset && url ? <img src={url} alt="" style={{ maxHeight: 32, maxWidth: 88, objectFit: 'contain' }} />
          : <span className="text-2xs text-text3">none</span>}
      </div>
      <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} hidden
        onChange={(e) => pick(e.target.files?.[0])} />
      <Button size="sm" type="button" disabled={disabled || busy}
        onClick={() => fileRef.current?.click()}>{asset ? 'Replace' : 'Upload'}</Button>
      {asset && (
        <Button size="sm" type="button" variant="danger" disabled={disabled || busy}
          onClick={remove}>Remove</Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ subscribers

interface SubsData {
  available: boolean; enabled: boolean; confirmed: number; pending: number;
  rows: { id: number; email: string; confirmedAt: number | null; createdAt: number }[];
}

function Subscribers({ isAdmin }: { isAdmin: boolean }) {
  const app = useApp();
  const [data, setData] = useState<SubsData | null>(null);
  const [enabled, setEnabled] = useState(app.settings.status_subscribers_enabled !== '0');
  useEffect(() => { setEnabled(app.settings.status_subscribers_enabled !== '0'); },
    [app.settings.status_subscribers_enabled]);

  const load = () => api.get<SubsData>('/api/admin/status-subscribers')
    .then(setData).catch(() => setData({ available: false, enabled: false, confirmed: 0, pending: 0, rows: [] }));
  useEffect(() => { load(); }, []);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    try { await api.patch('/api/admin/settings', { status_subscribers_enabled: next ? '1' : '0' }); }
    catch { setEnabled(!next); }
  };
  const remove = async (id: number, email: string) => {
    if (!window.confirm(`Remove subscriber ${email}?`)) return;
    await api.del(`/api/admin/status-subscribers/${id}`);
    load();
  };

  return (
    <Card style={{ padding: 0 }}>
      <div className="row row-wrap" style={{ justifyContent: 'space-between', padding: '12px 16px', gap: 10 }}>
        <span className="card-title" style={{ margin: 0 }}>
          E-mail subscribers{data ? ` (${data.confirmed} confirmed${data.pending ? `, ${data.pending} pending` : ''})` : ''}
        </span>
        {isAdmin && (
          <span className="row" style={{ gap: 6 }}>
            <Toggle on={enabled} onClick={toggle} />
            <span className="micro text-2xs">Accept subscriptions</span>
          </span>
        )}
      </div>
      <div style={{ padding: '0 16px 12px' }}>
        {data === null ? (
          <ListSkeleton rows={3} lines={1} />
        ) : !data.available ? (
          <div className="text-sm text-text3" style={{ paddingBottom: 4 }}>
            {data.enabled
              ? 'no mail transport configured — the subscribe form is hidden on the public page until one is set up (Settings → Notifications)'
              : 'subscriptions are switched off — the subscribe form is hidden on the public page'}
          </div>
        ) : data.rows.length === 0 ? (
          <div className="text-sm text-text3" style={{ paddingBottom: 4 }}>
            no subscribers yet — visitors can subscribe on the public status page (double-opt-in);
            published incident updates go out by mail and via the Atom feed</div>
        ) : data.rows.map((r) => (
          <div key={r.id} className="row" style={{ gap: 8, padding: '4px 0', borderBottom: '1px solid var(--bg3)' }}>
            <span className="text-sm text-text1" style={{ minWidth: 0, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{r.email}</span>
            <span className="mono text-xs" style={{ flexShrink: 0,
              color: r.confirmedAt ? 'var(--text2)' : 'var(--text3)' }}>
              {r.confirmedAt ? `confirmed ${relTime(r.confirmedAt)}` : 'pending'}</span>
            <Button size="sm" variant="danger" title="Remove subscriber" aria-label="Remove subscriber"
              onClick={() => remove(r.id, r.email)}><XIcon size={13} /></Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ user reports

function UserReports({ isAdmin }: { isAdmin: boolean }) {
  const app = useApp();
  const [data, setData] = useState<StatusReportsResponse | null>(null);
  const [enabled, setEnabled] = useState(app.settings.status_reports_enabled !== '0');
  const [publicCount, setPublicCount] = useState(app.settings.status_reports_public === '1');
  const [threshold, setThreshold] = useState(app.settings.status_reports_threshold || '5');

  useEffect(() => {
    setEnabled(app.settings.status_reports_enabled !== '0');
    setPublicCount(app.settings.status_reports_public === '1');
    setThreshold(app.settings.status_reports_threshold || '5');
  }, [app.settings]);

  const load = () => api.get<StatusReportsResponse>('/api/status-reports?hours=24')
    .then(setData).catch(() => setData({ total: 0, reports: [] }));
  useEffect(() => {
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, []);

  const save = async (patch: Record<string, string>) => {
    try { await api.patch('/api/admin/settings', patch); } catch { /* revert via settings reload */ }
  };

  return (
    <Card style={{ padding: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '12px 16px', flexWrap: 'wrap', gap: 10 }}>
        <span className="card-title" style={{ margin: 0 }}>
          User reports (last 24h: {data ? data.total : '…'})</span>
        {isAdmin && (
          <span className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <span className="row" style={{ gap: 6 }}>
              <Toggle on={enabled} onClick={() => { setEnabled(!enabled); save({ status_reports_enabled: !enabled ? '1' : '0' }); }} />
              <span className="micro text-2xs">Accept reports</span>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <Toggle on={publicCount} onClick={() => { setPublicCount(!publicCount); save({ status_reports_public: !publicCount ? '1' : '0' }); }} />
              <span className="micro text-2xs">Show count publicly</span>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className="micro text-2xs">Alert at</span>
              <Input className="text-sm" type="number" min={1} max={1000} value={threshold} width={60} style={{ padding: '3px 6px' }}
                onChange={(e) => setThreshold(e.target.value)}
                onBlur={() => save({ status_reports_threshold: String(Math.max(1, parseInt(threshold, 10) || 5)) })} />
              <span className="micro text-2xs">/ 15 min</span>
            </span>
          </span>
        )}
      </div>
      <div style={{ padding: '0 16px 12px' }}>
        {!data || data.reports.length === 0 ? (
          <div className="text-sm text-text3" style={{ paddingBottom: 4 }}>
            no reports in the last 24 hours — visitors can report problems on the public status page;
            a spike raises a <span className="mono">user_reports_spike</span> event</div>
        ) : data.reports.slice(0, 30).map((r, i) => (
          <div key={i} className="row" style={{ gap: 8, padding: '4px 0', borderBottom: '1px solid var(--bg3)' }}>
            <span className="mono text-xs text-text3" style={{ flexShrink: 0 }}>{relTime(r.ts)}</span>
            {r.component && <span className="mono text-xs text-text2" style={{ flexShrink: 0 }}>[{r.component}]</span>}
            <span className="text-sm text-text1" style={{ overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap' }}>{r.message || <span className="text-text3">no message</span>}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ uptime strip

function UptimeStrip({ days }: { days: Component['days'] }) {
  const shown = days.slice(-45);
  const pad = Math.max(0, 45 - shown.length);
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center', height: 18 }}>
      {Array.from({ length: pad }).map((_, i) => (
        <div key={`p${i}`} style={{ flex: 1, minWidth: 0, height: 18, borderRadius: 1,
          background: 'var(--bg3)', opacity: 0.4 }} />
      ))}
      {shown.map((d, i) => (
        <div key={i} title={`${d.day} · ${d.worst}`} style={{ flex: 1, minWidth: 0, height: 18,
          borderRadius: 1, background: dayColor(d.worst) }} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ add modal

function AddComponentModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.post('/api/admin/components', { name, group }); onAdded(); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : 'error'); setBusy(false); }
  };

  return (
    <Modal title="Add component" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name">
          <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder="API Gateway" />
        </Field>
        <Field label="Group">
          <Input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Core Services" />
        </Field>
        {err && <div className="text-sm" style={{ color: '#f85149', marginBottom: 8 }}>{err}</div>}
        <Button variant="primary" block
 disabled={busy || !name}>{busy ? '…' : 'Add component'}</Button>
      </form>
    </Modal>
  );
}
