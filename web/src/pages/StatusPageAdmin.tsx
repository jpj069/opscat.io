// StatusPageAdmin — public status page management, in URL-addressable tabs:
// components + publish, branding & pages (logo/colours/theme/whitelabel/custom
// CSS/custom domain/private audience pages), e-mail subscribers, and anonymous
// user problem reports (Downdetector-style).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useOverlayParam, useTab } from '../state';
import { api, ApiError } from '../api';
import { alpha, relTime, SEV, STATUS_META } from '../format';
import { Card, Button, Toggle, GlowDot, Modal, Field, TableScroll, TableSkeleton, ListSkeleton, PageHeader,
  Input, Textarea, HostInput, ColorPicker, Tabs, Busy, Skeleton, COL,
  FormRow, CardNote, SwitchRow, CopyField, ErrorNote, StatusPill, ImageUpload } from '../ui';
import { Select } from '../Select';
import type { Component, CompStatus, StatusPage, StatusPagesResponse, StatusReportsResponse } from '../types';
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronLeftIcon,
  ExternalLinkIcon,
  EyeIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react';

// (dot) | Name | Group | Status | Owner | 45-day uptime | Uptime %. The heat bar
// is the widest thing in the row and the only one that benefits from more space.
// Group / Status / Owner are SELECTS, so they take COL.control — not COL.label or
// COL.status, which are sized for text and a pill and truncated them to
// "Operatio…". The uptime percentage and the delete button are two columns, not
// one: sharing COL.num clipped "100.00%" down to "00.00%".
const GRID = [COL.tiny, COL.text, COL.control, COL.control, COL.control,
  COL.textWide, COL.num, COL.actions].join(' ');
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
// Sentinel option value. It cannot collide with a real group: a group is a name
// somebody typed, and this one is not typeable into the field that produces them.
const NEW_GROUP = '\u0000new-group';

/**
 * Pick an existing group or start a new one.
 *
 * A group has no table of its own — it is the set of values the components
 * carry. That is deliberate: "define a group" and "put something in it" are one
 * act, and a second entity would need its own CRUD, ordering and rename story to
 * earn its keep. What the free-text field got wrong was not the model but the
 * INPUT: it invited a typo to create a silent second group ("Core" vs "core"),
 * and it offered no way to see what already exists.
 */
function GroupPicker({ value, groups, onChange, disabled, title = 'Group' }: {
  value: string; groups: string[]; onChange: (g: string) => void;
  disabled?: boolean; title?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  if (creating) {
    return (
      <span className="row" style={{ gap: 6 }}>
        <Input autoFocus value={draft} maxLength={100} placeholder="Core Services"
          aria-label="New group name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (draft.trim()) onChange(draft.trim()); setCreating(false); }
            if (e.key === 'Escape') { setCreating(false); setDraft(''); }
          }}
          onBlur={() => { if (draft.trim()) onChange(draft.trim()); setCreating(false); }} />
      </span>
    );
  }
  return (
    <Select title={title} aria-label={title} value={value} disabled={disabled}
      onChange={(v) => { if (v === NEW_GROUP) { setDraft(''); setCreating(true); } else onChange(v); }}
      options={[
        ...(value && !groups.includes(value) ? [{ value, label: value }] : []),
        ...groups.map((g) => ({ value: g, label: g })),
        // no leading "+": a plain ASCII plus in a label is text, not an icon —
        // it takes the font's baseline and cannot be sized or coloured like one
        { value: NEW_GROUP, label: 'New group…' },
      ]} />
  );
}

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

  // The public URL is per PAGE, not per install: only org 1's page lives at
  // /status — everyone else is at /status/<slug>, and a page with a verified
  // custom domain is at that hostname entirely. A hardcoded "/status" here sent
  // every workspace to the FIRST org's status page, which is both wrong and a
  // cross-tenant link. The server already resolves it (pageDTO.url), so ask it.
  const [publicUrl, setPublicUrl] = useState('');
  useEffect(() => {
    if (!canEdit) return;
    api.get<StatusPagesResponse>('/api/admin/status-pages')
      .then((d) => setPublicUrl(d.pages.find((p) => p.isDefault)?.url || ''))
      .catch(() => setPublicUrl(''));
  }, [canEdit, app.activeOrgId]);

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
        <a className="btn" href={publicUrl || '/status'} target="_blank" rel="noreferrer">
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

  // Groups are not their own entity — they are whatever the components say they
  // are, so the picker is built from the values in use plus a way to start a new
  // one. That keeps "define a group" and "put a component in it" the same act,
  // which is what a free-text field was already doing badly.
  const groups = useMemo(
    () => [...new Set((components || []).map((c) => c.group).filter(Boolean))].sort(),
    [components]);

  const load = () => api.get<Component[]>('/api/admin/components').then(setComponents).catch(() => setComponents([]));
  useEffect(() => { load(); }, []);

  const role = app.user?.role;
  const isAnalyst = role === 'analyst';
  const canEdit = (ROLE_RANK[role ?? ''] ?? 0) >= ROLE_RANK.lead; // lead+

  const setStatus = async (id: number, status: CompStatus) => {
    await api.patch(`/api/admin/components/${id}`, { status });
    load();
  };
  const setGroup = async (id: number, group: string) => {
    await api.patch(`/api/admin/components/${id}`, { group });
    load();
  };
  const setOwner = async (id: number, v: string) => {
    // uuid since migration 21 — Number() would make it NaN, JSON null, and the
    // endpoint reads null as "clear the owner"
    await api.patch(`/api/admin/components/${id}`, { ownerId: v === '' ? null : v });
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
        <TableScroll cols={GRID} stickyFirst minWidth={940}>
        <div className="tbl-head">
          <span />
          <span>Name</span>
          <span>Group</span>
          <span>Status</span>
          <span>Owner</span>
          <span>45-day uptime</span>
          <span style={{ textAlign: 'right' }}>Uptime</span>
          <span />
        </div>
        {components === null && <TableSkeleton rows={5} />}
        {components && components.length === 0 && (
          <div className="text-text3 text-sm" style={{ padding: 20}}>No components yet.</div>
        )}
        {components?.map((c) => {
          const pct = c.uptimePct.replace(/%/g, '');
          return (
            <div key={c.id} className="tbl-row">
              <GlowDot color={COMP_COLOR[c.status]} />
              <span className="text-base font-semibold text-text0">{c.name}</span>
              <GroupPicker value={c.group} groups={groups} disabled={!canEdit}
                onChange={(g) => setGroup(c.id, g)} />
              <Select title="Component status" value={c.status} disabled={isAnalyst}
                onChange={(v) => setStatus(c.id, v as CompStatus)}
                options={COMP_STATUSES.map((s) => ({ value: s, label: STATUS_META[s].label }))} />
              <Select title="Component owner" placeholder="— no owner" aria-label="Component owner"
                value={c.ownerId ? String(c.ownerId) : ''} disabled={!canEdit}
                onChange={(v) => setOwner(c.id, v)}
                options={[{ value: '', label: '— no owner' },
                  ...app.users.map((u) => ({ value: String(u.id), label: u.name }))]} />
              <UptimeStrip days={c.days} />
              <span className="mono text-sm text-text1" style={{ textAlign: 'right' }}>{pct}%</span>
              <span className="row" style={{ justifyContent: 'flex-end' }}>
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

      {showAdd && <AddComponentModal groups={groups} onClose={() => setShowAdd(false)}
        onAdded={() => { setShowAdd(false); load(); }} />}
    </>
  );
}

// ------------------------------------------------------------------ branding & pages

const THEME_OPTIONS = [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }];
// Raster only — the server refuses SVG (a script-bearing document served from
// the status page's own origin), so the picker must not offer it either.

/**
 * Branding & pages — a LIST of the org's status pages, and one page's settings
 * opened from it.
 *
 * It shipped as a dropdown at the top of the settings themselves, which reads as
 * "these settings, for whichever page this select happens to be on" — the page
 * being edited was a control, not a place. A list makes the pages the subject:
 * you see how many there are, what each is called, where it lives and who may see
 * it, before you open one. The opened page is in the URL (`?page=<id>`), so it is
 * linkable and the back button closes it (state.tsx § URL state).
 */
function Branding({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<StatusPagesResponse | null>(null);
  const [sel, setSel] = useOverlayParam('page');
  const [err, setErr] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [preview, setPreview] = useState(false);

  const load = () => api.get<StatusPagesResponse>('/api/admin/status-pages')
    .then(setData).catch(() => setData(null));
  useEffect(() => { load(); }, []);

  if (data === null) {
    return <Busy><Card><Skeleton h={40} /><Skeleton h={40} /><Skeleton h={40} /></Card></Busy>;
  }
  const page = data.pages.find((p) => p.id === sel) ?? null;

  if (!page) {
    return (
      <>
        <ErrorNote onDismiss={() => setErr('')}>{err}</ErrorNote>
        <PageList pages={data.pages} limits={data.limits} isAdmin={isAdmin}
          onOpen={setSel} onNew={() => setShowNew(true)} />
        {showNew && <NewPageModal onClose={() => setShowNew(false)}
          onCreated={(id) => { setShowNew(false); load(); setSel(id); }} />}
      </>
    );
  }

  return (
    <>
      <div className="row row-wrap" style={{ gap: 10, marginBottom: 12 }}>
        <Button size="sm" onClick={() => setSel(null)}>
          <ChevronLeftIcon size={13} /> All status pages</Button>
        <span className="text-base font-semibold text-text0" style={{ alignSelf: 'center' }}>
          {page.name}{page.isDefault && <span className="text-xs text-text3"> · main</span>}
        </span>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={() => setPreview(true)}><EyeIcon size={13} /> Preview</Button>
        <a className="btn btn-sm" href={pageHref(page)} target="_blank" rel="noreferrer">
          Open <ExternalLinkIcon size={13} /></a>
      </div>

      <ErrorNote onDismiss={() => setErr('')}>{err}</ErrorNote>

      <PageEditor key={page.id} page={page} limits={data.limits} isAdmin={isAdmin}
        defaultAccent={data.defaultAccent} onChanged={load}
        onDeleted={() => { setSel(null); load(); }} onError={setErr} />

      {preview && <PreviewPanel page={page} onClose={() => setPreview(false)} />}
    </>
  );
}

// Name | Address | Visibility | Components | open
const PAGES_GRID = [COL.text, COL.textWide, COL.status, COL.label, COL.actions].join(' ');

function PageList({ pages, limits, isAdmin, onOpen, onNew }: {
  pages: StatusPage[]; limits: StatusPagesResponse['limits']; isAdmin: boolean;
  onOpen: (id: number) => void; onNew: () => void;
}) {
  return (
    <Card style={{ padding: 0 }} title="Status pages" actions={
      isAdmin && limits.canMultiPage
        ? <Button size="sm" onClick={onNew}><PlusIcon size={13} /> New page</Button>
        : <span className="text-xs text-text3">Additional pages: Enterprise plan</span>
    }>
      <TableScroll cols={PAGES_GRID} minWidth={760}>
        <div className="tbl-head">
          <span>Name</span><span>Public address</span><span>Visibility</span>
          <span>Components</span><span style={{ textAlign: 'right' }}>Actions</span>
        </div>
        {pages.map((p) => (
          <div key={p.id} className="tbl-row" style={{ cursor: 'pointer' }}
            onClick={() => onOpen(p.id)}>
            <span style={{ minWidth: 0 }}>
              <span className="text-base font-semibold text-text0" style={{ display: 'block',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <span className="mono text-2xs text-text3">{p.slug}{p.isDefault ? ' · main' : ''}</span>
            </span>
            <span className="mono text-xs text-text2" style={{ overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.url}>
              {p.url.replace(/^https?:\/\//, '')}
              {p.domainVerifiedAt && p.domain
                && <span className="text-text3"> · own domain</span>}
            </span>
            <StatusPill text={p.visibility === 'private' ? 'private' : (p.published ? 'public' : 'unpublished')}
              color={p.visibility === 'private' ? SEV.purple
                : (p.published ? STATUS_META.operational.color : SEV.info)} />
            <span className="text-xs text-text2">
              {p.componentIds === null ? 'all' : `${p.componentIds.length} selected`}</span>
            <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
              <Button size="sm" onClick={(e) => { e.stopPropagation(); onOpen(p.id); }}>Edit</Button>
              <a className="btn btn-sm" href={pageHref(p)} target="_blank" rel="noreferrer"
                onClick={(e) => e.stopPropagation()} aria-label={`Open ${p.name}`}>
                <ExternalLinkIcon size={13} /></a>
            </span>
          </div>
        ))}
      </TableScroll>
    </Card>
  );
}

/**
 * The link to a page, from the admin UI.
 *
 * The address itself comes from the SERVER (`page.url`) — it is the only side that
 * knows whether a dedicated status host is configured, whether a custom domain is
 * verified, and which of those wins. Building it here from the slug produced a
 * `/status/<slug>` that was merely usually right. The private link secret is added
 * here, because that IS the link the admin is meant to hand out.
 */
function pageHref(p: StatusPage): string {
  return p.visibility === 'private' && p.accessToken ? `${p.url}?k=${p.accessToken}` : p.url;
}

/**
 * The preview, in a slide-over rather than inline.
 *
 * Inline it sat between the settings that feed it and the ones that do not, which
 * made it read as another form section; it is not, it is the OUTPUT. On demand,
 * over the page, it can also be looked at while scrolling the form underneath.
 */
function PreviewPanel({ page, onClose }: { page: StatusPage; onClose: () => void }) {
  const r = page.resolved;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="overlay-dim" onClick={onClose} />
      <div className="slide-over" role="dialog" aria-label="Status page preview">
        <div className="row" style={{ gap: 10, padding: '14px 16px',
          borderBottom: '1px solid var(--bg3)' }}>
          <span className="text-base font-semibold text-text0">Preview</span>
          <span style={{ flex: 1 }} />
          <a className="btn btn-sm" href={pageHref(page)} target="_blank" rel="noreferrer">
            Open the real page <ExternalLinkIcon size={13} /></a>
          <Button size="sm" onClick={onClose} aria-label="Close preview"><XIcon size={13} /></Button>
        </div>
        <div style={{ padding: 16 }}>
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
            <div className="row row-wrap" style={{ gap: 10, marginTop: 12, alignItems: 'center' }}>
              <span style={{ background: r.accent, color: r.accentInk, borderRadius: 6,
                padding: '6px 14px', fontWeight: 600 }} className="text-xs">Subscribe</span>
              <span className="text-2xs" style={{ color: r.palette.faint }}>
                {r.hidePowered ? '' : 'Powered by OpsCat · '}Atom feed
                {r.supportUrl ? ' · Support' : ''}{r.legalUrl ? ' · Legal' : ''}</span>
            </div>
          </div>
          <CardNote>
            Rendered from the same values the public page uses — but it is a mock-up of
            the header, not the page: it shows no components, no incidents, and
            <strong> custom CSS is not applied here</strong>. Open the real page to see those.
          </CardNote>
        </div>
      </div>
    </>
  );
}

function PageEditor({ page, limits, isAdmin, defaultAccent, onChanged, onDeleted, onError }: {
  page: StatusPage;
  limits: StatusPagesResponse['limits'];
  isAdmin: boolean; defaultAccent: string;
  onChanged: () => void; onDeleted: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(page.name);
  const [desc, setDesc] = useState(page.description);
  const [support, setSupport] = useState(page.supportUrl);
  const [legal, setLegal] = useState(page.legalUrl);
  const [css, setCss] = useState(page.customCss);
  const [cssOn, setCssOn] = useState(!!page.customCss);
  // Which field was refused, and why. A rejected value used to revert to the stored
  // one with nothing said — the accent field snapped back to the default and the
  // person was left guessing whether they had mistyped or the feature was broken.
  // The draft now STAYS so it can be corrected, and the reason sits under the field.
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const clearErr = (k: string) => setFieldErr((c) => { const n = { ...c }; delete n[k]; return n; });

  /**
   * One saver for every field: PATCH, then re-read so the form shows what the PUBLIC
   * page will show rather than what this form hopes.
   *
   * `field` names the control the failure belongs to. Without it the only report was
   * a page-level line, which for a refused colour or a refused stylesheet is nowhere
   * near the thing that needs fixing.
   */
  const save = async (patch: Record<string, unknown>, field?: string) => {
    onError('');
    if (field) clearErr(field);
    try { await api.patch(`/api/admin/status-pages/${page.id}`, patch); onChanged(); return true; }
    catch (e) {
      const msg = e instanceof ApiError ? e.message : 'could not save';
      if (field) setFieldErr((c) => ({ ...c, [field]: msg })); else onError(msg);
      return false;
    }
  };

  const r = page.resolved;

  return (
    <>
      <Card title="Identity">
        <CardNote>Logo, colours and links are included on every plan — a status page is
          public, so it should look like yours from the first day.</CardNote>
        <FormRow label="Page name">
          <Input value={name} disabled={!isAdmin} maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== page.name && save({ name }, 'name')} />
          <FieldError msg={fieldErr.name} />
        </FormRow>
        <FormRow label="Logo" hint="PNG, JPEG, WebP or ICO · max 512 KB · shown at 32px tall">
          <AssetField pageId={page.id} kind="logo" asset={page.logo} url={r.logoUrl}
            disabled={!isAdmin} onChanged={onChanged} onError={onError} />
        </FormRow>
        <FormRow label="Favicon" hint="Falls back to the logo when empty">
          <AssetField pageId={page.id} kind="favicon" asset={page.favicon} url={r.faviconUrl}
            disabled={!isAdmin} onChanged={onChanged} onError={onError} />
        </FormRow>
        <FormRow label="Accent colour" hint="#rrggbb — the page derives its tints from it">
          <ColorPicker value={page.accent || defaultAccent} disabled={!isAdmin}
            onChange={(v) => save({ accent: v }, 'accent')} />
          <FieldError msg={fieldErr.accent} />
        </FormRow>
        <FormRow label="Theme">
          <Select title="Theme" value={page.theme} disabled={!isAdmin}
            onChange={(v) => save({ theme: v })} options={THEME_OPTIONS} />
        </FormRow>
        <FormRow label="Description" hint="Optional — shown under the page title">
          <Textarea value={desc} maxLength={300} disabled={!isAdmin} rows={2}
            placeholder="Live and historical status for the Acme platform."
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => desc !== page.description && save({ description: desc }, 'description')} />
          <FieldError msg={fieldErr.description} />
        </FormRow>
        <FormRow label="Support link" hint="Optional — linked in the footer">
          <HostInput value={support} disabled={!isAdmin}
            placeholder="https://acme.example/support"
            onChange={(e) => setSupport(e.target.value)}
            onBlur={() => support !== page.supportUrl && save({ supportUrl: support }, 'supportUrl')} />
          <FieldError msg={fieldErr.supportUrl} />
        </FormRow>
        <FormRow label="Legal / imprint link" hint="Optional — linked in the footer">
          <HostInput value={legal} disabled={!isAdmin}
            placeholder="https://acme.example/imprint"
            onChange={(e) => setLegal(e.target.value)}
            onBlur={() => legal !== page.legalUrl && save({ legalUrl: legal }, 'legalUrl')} />
          <FieldError msg={fieldErr.legalUrl} />
        </FormRow>
      </Card>

      <VisibilityCard page={page} limits={limits} isAdmin={isAdmin} save={save}
        onChanged={onChanged} onError={onError} />

      <DomainCard page={page} canCustomDomain={limits.canCustomDomain} isAdmin={isAdmin}
        onChanged={onChanged} onError={onError} />

      {/* One card, because both halves answer the same question — how far the page
          may move away from OpsCat's own look — and both are gated on the same plan.
          They shipped as two cards holding one control each. */}
      <Card title="Whitelabel">
        <CardNote>
          {limits.canWhitelabel
            ? 'Everything in Identity is included on every plan; these two take the page the rest of the way to being yours.'
            : 'Available from the Business plan. Everything in Identity is included on your plan.'}
        </CardNote>
        <SwitchRow label="Hide “Powered by OpsCat”"
          hint="The footer keeps the JSON and Atom links either way"
          on={page.hidePowered && limits.canWhitelabel}
          disabled={!isAdmin || !limits.canWhitelabel}
          note={limits.canWhitelabel ? undefined : 'Business plan'}
          onClick={() => save({ hidePowered: !page.hidePowered })} />
        {/* Behind a switch: an always-open code box implies the page WANTS custom CSS,
            which is the opposite of true — it is the escape hatch for the one rule the
            settings above cannot express. Switching it off clears the stylesheet, so
            "off" means the page is running our CSS and nothing else. */}
        <SwitchRow label="Custom CSS" hint="Override any rule the settings above cannot reach"
          on={cssOn && limits.canCustomCss} disabled={!isAdmin || !limits.canCustomCss}
          note={limits.canCustomCss ? undefined : 'Business plan'}
          onClick={() => {
            const next = !cssOn;
            setCssOn(next);
            if (!next && page.customCss) { setCss(''); save({ customCss: '' }, 'customCss'); }
          }} />
        {cssOn && limits.canCustomCss && (
          <FormRow label="Stylesheet" wide
            hint={<>Appended to the page’s own &lt;style&gt; block · max 20 KB · a closing
              &lt;/style&gt; tag is refused</>}>
            <Textarea className="mono" value={css} rows={8} disabled={!isAdmin}
              placeholder={'.comp { border-radius: 12px }\n.sp-head { padding: 32px 0 }'}
              onChange={(e) => setCss(e.target.value)}
              onBlur={async () => {
                if (css === page.customCss) return;
                if (!await save({ customCss: css }, 'customCss')) return;  // keep the draft
              }} />
            <FieldError msg={fieldErr.customCss} />
            <CssClassReference />
          </FormRow>
        )}
      </Card>

      {isAdmin && !page.isDefault && (
        <Card title="Delete page">
          <div className="row row-wrap" style={{ gap: 10, justifyContent: 'space-between' }}>
            <span className="text-xs text-text3" style={{ flex: 1, minWidth: 0 }}>
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

/** A refused value, reported under the control that holds it (never a toast). */
function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return (
    <div role="alert" className="row text-xs" style={{ gap: 5, marginTop: 5, color: '#f85149' }}>
      <AlertTriangleIcon size={12} style={{ flexShrink: 0, marginTop: 1 }} />
      <span style={{ minWidth: 0 }}>{msg}</span>
    </div>
  );
}

/**
 * The selectors the public page actually renders, so custom CSS is written against
 * the real markup instead of View-Source archaeology.
 *
 * The list is short on purpose and mirrors `routes/status.js`. It is a REFERENCE,
 * not a contract: renaming a class there means updating it here in the same commit,
 * which is cheaper than the alternative — a documented selector we then cannot
 * rename because somebody's stylesheet depends on it.
 */
const CSS_CLASSES: [string, string][] = [
  ['.wrap', 'the page column (max width, padding)'],
  ['.brand / .logo / .tagline', 'header: mark, image, description'],
  ['.banner', 'the overall-status bar at the top'],
  ['.card', 'each panel — components, incidents, subscribe'],
  ['.grp', 'a component group heading'],
  ['.comp / .comp-head / .name / .dot', 'one component row'],
  ['.strip / .sq', 'the 45-day uptime strip and its cells'],
  ['.pct', 'the uptime percentage'],
  ['.inc / .inc-head / .upd', 'an incident and its updates'],
  ['.report / .report-form / .rcount', 'the "report a problem" block'],
  ['.hp', 'the footer (powered-by, feed, links)'],
];

function CssClassReference() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <Button size="sm" type="button" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} the classes this page uses
      </Button>
      {open && (
        <div style={{ marginTop: 8, border: '1px solid var(--bg3)', borderRadius: 6, padding: '8px 10px' }}>
          {CSS_CLASSES.map(([sel, what]) => (
            <div key={sel} className="row row-wrap" style={{ gap: 8, padding: '2px 0' }}>
              <span className="mono text-xs text-text0" style={{ minWidth: 190 }}>{sel}</span>
              <span className="text-xs text-text3" style={{ minWidth: 0 }}>{what}</span>
            </div>
          ))}
          <div className="text-xs text-text3" style={{ marginTop: 6 }}>
            The page's own custom properties are there to build on, so a rule stays in
            the palette you picked: <span className="mono">--accent</span>,
            {' '}<span className="mono">--accent-dark</span>, <span className="mono">--accent-ink</span>,
            {' '}<span className="mono">--bg</span>, <span className="mono">--surface</span>,
            {' '}<span className="mono">--border</span>, <span className="mono">--text</span>,
            {' '}<span className="mono">--heading</span>, <span className="mono">--muted</span>,
            {' '}<span className="mono">--faint</span>.
          </div>
        </div>
      )}
    </div>
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
      <CardNote>Who may see this page, and which components it lists.</CardNote>
      {!page.isDefault && (
        <SwitchRow label="Private page"
          hint="Reachable only with the secret link, never indexed — rotate it to revoke access"
          on={page.visibility === 'private'} disabled={!isAdmin || !limits.canMultiPage}
          note={limits.canMultiPage ? undefined : 'Enterprise plan'}
          onClick={() => save({ visibility: page.visibility === 'private' ? 'public' : 'private' })} />
      )}

      {page.visibility === 'private' && page.accessToken && (
        // `wide`: the link is ~80 characters and the 420px field showed about 55 of
        // them — the half that mattered was the half cut off.
        <FormRow label="Secret link" wide
          hint="Anyone with this link can read the page — rotating it revokes every copy">
          <div className="row row-wrap" style={{ gap: 8 }}>
            <CopyField label="Private page link" value={pageHref(page)} />
            <Button size="sm" disabled={!isAdmin} onClick={async () => {
              if (!window.confirm('Rotate the link? Everyone who has the current one loses access.')) return;
              try { await api.post(`/api/admin/status-pages/${page.id}/rotate-token`); onChanged(); }
              catch (e) { onError(e instanceof ApiError ? e.message : 'could not rotate'); }
            }}>Rotate link</Button>
          </div>
        </FormRow>
      )}

      <FormRow label="Components shown" hint={all ? undefined : `${(page.componentIds || []).length} selected`}>
        {comps === null ? <ListSkeleton rows={3} lines={1} /> : (
          <>
            <label className="row" style={{ gap: 8, padding: '3px 0' }}>
              <input type="checkbox" checked={all} disabled={!isAdmin}
                onChange={() => save({ componentIds: all ? comps.map((c) => c.id) : [] })} />
              <span className="text-sm text-text1">All components</span>
              <span className="text-xs text-text3">— including ones added later</span>
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
                <span className="text-sm text-text1" style={{ minWidth: 0 }}>{c.name}</span>
                <span className="mono text-xs text-text3">{c.group}</span>
              </label>
            ))}
          </>
        )}
      </FormRow>
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
      <CardNote>
        {canCustomDomain
          ? 'Serve this page on your own hostname. The certificate is issued automatically once DNS is in place.'
          : 'Available from the Pro plan.'}
      </CardNote>
      <FormRow label="Hostname" hint={page.domain
        ? (verified ? 'Verified — the page is served here' : 'Not verified yet')
        : undefined}>
        <div className="row row-wrap" style={{ gap: 8 }}>
          <HostInput value={domain} width={200} disabled={!isAdmin || !canCustomDomain}
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
            <span className="row text-xs" style={{ gap: 5, flexShrink: 0,
              color: verified ? STATUS_META.operational.color : 'var(--text3)' }}>
              <GlowDot color={verified ? STATUS_META.operational.color : 'var(--text3)'} size={7} />
              {verified ? 'verified' : 'not verified'}
            </span>
          )}
        </div>
      </FormRow>

      {page.dns && !verified && (
        <div style={{ marginTop: 12 }}>
          <div className="text-xs micro" style={{ marginBottom: 4 }}>Add these two DNS records</div>
          <TableScroll cols={DNS_GRID} minWidth={520}>
            <div className="tbl-head">
              <span>Type</span><span>Host</span><span>Value</span></div>
            {[page.dns.challenge, page.dns.routing].map((rec) => (
              <div key={rec.type} className="tbl-row">
                <span className="mono text-xs text-text2">{rec.type}</span>
                <span className="mono text-xs text-text1" style={{ overflowWrap: 'anywhere' }}>{rec.host}</span>
                <span className="mono text-xs text-text1" style={{ overflowWrap: 'anywhere' }}>{rec.value}</span>
              </div>
            ))}
          </TableScroll>
          <div className="text-xs text-text3" style={{ marginTop: 6 }}>
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

// Type | Host | Value — a TXT challenge value is the longest thing here by far
const DNS_GRID = [COL.label, COL.text, COL.textWide].join(' ');

// ---- new page ----

interface SlugCheck { slug: string; available: boolean; reason: string }

function NewPageModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // The slug is checked WHILE it is typed. It used to be checked by the submit — so
  // the way to find out a name was taken was to fill the whole form and be refused,
  // and the slug is the one field somebody has to invent rather than know.
  const [check, setCheck] = useState<SlugCheck | null>(null);
  useEffect(() => {
    if (!slug) { setCheck(null); return undefined; }
    setCheck(null);
    // debounce: a keystroke is not a question, a pause is
    const t = setTimeout(() => {
      api.get<SlugCheck>(`/api/admin/status-pages/slug-available?slug=${encodeURIComponent(slug)}`)
        // ignore an answer that arrived after the field moved on
        .then((r) => setCheck((cur) => (r.slug === slug ? r : cur)))
        .catch(() => setCheck(null));
    }, 300);
    return () => clearTimeout(t);
  }, [slug]);

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
          <span className="row text-xs" style={{ gap: 5, marginTop: 5, minHeight: 18,
            color: !check ? 'var(--text3)' : check.available ? SEV.green : '#f85149' }}>
            {slug && !check && 'checking…'}
            {check && check.available && <><CheckIcon size={12} /> free</>}
            {check && !check.available && <><AlertTriangleIcon size={12} /> {check.reason}</>}
          </span>
        </Field>
        <label className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
          <span className="text-sm text-text1">Private — reachable only with a secret link</span>
        </label>
        <ErrorNote>{err}</ErrorNote>
        {/* disabled until the slug is known to be free: the submit is the expensive
            way to learn what the field above already says */}
        <Button variant="primary" block disabled={busy || !name || !slug || !check?.available}>
          {busy ? '…' : 'Create page'}</Button>
      </form>
    </Modal>
  );
}

// The status page's logo/favicon, on the shared ImageUpload (ui.tsx). This
// used to be a local `AssetField` holding its own FileReader, busy state and
// same-file-twice reset; the org avatar needed the identical interaction, so
// the mechanics moved into ui.tsx and this is the preview plus the two calls.
function AssetField({ pageId, kind, asset, url, disabled, onChanged, onError }: {
  pageId: number;
  kind: 'logo' | 'favicon';
  asset: { mime: string; updatedAt: number } | null;
  url: string; disabled: boolean;
  onChanged: () => void; onError: (m: string) => void;
}) {
  return (
    <ImageUpload
      label={kind}
      hasAsset={!!asset}
      disabled={disabled}
      preview={(
        <div className="row" style={{ width: 96, height: 40, flexShrink: 0, justifyContent: 'center',
          alignItems: 'center', border: '1px solid var(--bg3)', borderRadius: 6, overflow: 'hidden' }}>
          {asset && url ? <img src={url} alt="" style={{ maxHeight: 32, maxWidth: 88, objectFit: 'contain' }} />
            : <span className="text-xs text-text3">none</span>}
        </div>
      )}
      onUpload={async (data) => {
        onError('');
        try { await api.put(`/api/admin/status-pages/${pageId}/asset/${kind}`, { data }); onChanged(); }
        catch (e) { throw new Error(e instanceof ApiError ? e.message : 'upload failed'); }
      }}
      onRemove={async () => {
        onError('');
        try { await api.del(`/api/admin/status-pages/${pageId}/asset/${kind}`); onChanged(); }
        catch (e) { throw new Error(e instanceof ApiError ? e.message : 'could not remove'); }
      }}
    />
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

function AddComponentModal({ groups, onClose, onAdded }:
  { groups: string[]; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState(groups[0] || '');
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
          <GroupPicker value={group} groups={groups} onChange={setGroup} />
        </Field>
        {err && <div className="text-sm" style={{ color: '#f85149', marginBottom: 8 }}>{err}</div>}
        <Button variant="primary" block
 disabled={busy || !name}>{busy ? '…' : 'Add component'}</Button>
      </form>
    </Modal>
  );
}
