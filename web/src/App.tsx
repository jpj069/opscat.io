// App shell: login gate, sidebar, topbar, command palette, event slide-over.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { useApp } from './state';
import { SEV, alpha, sevColor, age, fmtTime, initials, logSevColor } from './format';
import { Avatar, BrandMark, GlowDot, Modal, SevBadge, Spark, Field, Skeleton, Busy, Input, Textarea} from './ui';
import { GoogleIcon, MicrosoftIcon, GitHubIcon } from './icons';
import { topLayer } from './toplayer';
import {
  ActivityIcon, TableIcon, LayoutDashboardIcon, BoxesIcon, InboxIcon, TriangleAlertIcon,
  GlobeIcon, RadarIcon, ScrollTextIcon, BellRingIcon, ChartColumnIcon, UsersIcon,
  SettingsIcon, GemIcon, Rows3Icon, Rows4Icon, SunIcon, MoonIcon, MenuIcon, SearchIcon,
  ChevronUpIcon, LayoutGridIcon, FilterIcon, Building2Icon, ZapIcon, ShieldAlertIcon,
  RadioIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CaseRow, EventDetail, User } from './types';
import Monitor from './pages/Monitor';
import Classic from './pages/Classic';
import Dashboard from './pages/Dashboard';
import Assets from './pages/Assets';
import Cases from './pages/Cases';
import Incidents from './pages/Incidents';
import StatusPageAdmin from './pages/StatusPageAdmin';
import Synthetics from './pages/Synthetics';
import Reputation from './pages/Reputation';
import Vendors from './pages/Vendors';
import LogsPage from './pages/LogsPage';
import Rules from './pages/Rules';
import Analytics from './pages/Analytics';
import Users from './pages/Users';
import Settings from './pages/Settings';
import Pipeline from './pages/Pipeline';
import Automation from './pages/Automation';
import SuperAdmin from './pages/SuperAdmin';
import ComponentLab from './pages/ComponentLab';
import Onboarding from './pages/Onboarding';
import OrgSwitcher from './OrgSwitcher';
import type { BillingStatus, PlansResponse } from './types';

const NAV: { id: string; label: string; icon: LucideIcon; sub?: boolean }[] = [
  { id: 'monitor', label: 'Monitor', icon: ActivityIcon },
  { id: 'classic', label: 'Classic View', icon: TableIcon, sub: true },
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboardIcon },
  { id: 'assets', label: 'Assets', icon: BoxesIcon },
  { id: 'cases', label: 'Cases', icon: InboxIcon },
  { id: 'incidents', label: 'Incidents', icon: TriangleAlertIcon },
  { id: 'bridge', label: 'Bridge', icon: RadioIcon, sub: true },
  { id: 'statuspage', label: 'Status Page', icon: GlobeIcon },
  { id: 'synthetics', label: 'Synthetics', icon: RadarIcon },
  { id: 'reputation', label: 'Reputation', icon: ShieldAlertIcon },
  { id: 'vendors', label: 'Vendors', icon: Building2Icon },
  { id: 'logs', label: 'Logs', icon: ScrollTextIcon },
  { id: 'rules', label: 'Alert Rules', icon: BellRingIcon },
  { id: 'analytics', label: 'Analytics', icon: ChartColumnIcon },
];
const ADMIN_NAV: { id: string; label: string; icon: LucideIcon }[] = [
  { id: 'users', label: 'Users', icon: UsersIcon },
  { id: 'pipeline', label: 'Pipeline', icon: FilterIcon },
  { id: 'automation', label: 'Automation', icon: ZapIcon },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];
const PLATFORM_NAV: { id: string; label: string; icon: LucideIcon }[] = [
  { id: 'platform', label: 'Platform', icon: GemIcon },
  { id: 'components', label: 'Component Lab', icon: LayoutGridIcon },
];
// Bridge is the one lazy page: it carries livekit-client (~large) into its own
// chunk, so the common bundle stays untouched for everyone who never opens it.
const Bridge = React.lazy(() => import('./pages/Bridge'));

const PAGES: Record<string, React.ElementType> = {
  monitor: Monitor, classic: Classic, dashboard: Dashboard, assets: Assets, cases: Cases,
  incidents: Incidents, bridge: Bridge, statuspage: StatusPageAdmin, synthetics: Synthetics,
  reputation: Reputation, vendors: Vendors,
  logs: LogsPage, rules: Rules, analytics: Analytics, users: Users, pipeline: Pipeline,
  automation: Automation, settings: Settings, platform: SuperAdmin, components: ComponentLab,
};

// Suspense fallback while a lazy page chunk loads — skeleton, per the rules.
function PageLoading() {
  return (
    <div className="page">
      <Busy>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} h={180} />)}
        </div>
      </Busy>
    </div>
  );
}

function planPillColor(plan: string): string {
  if (plan === 'pro') return SEV.purple;
  if (plan === 'business') return SEV.green;
  if (plan === 'enterprise') return SEV.cyan;
  return SEV.info; // free / unknown
}

// The MCP OAuth consent screen sends an unauthenticated visitor here with
// ?next=<authorize url>. Once they are signed in, hand them straight back so the
// connection flow continues instead of dead-ending in the dashboard.
//
// Captured at MODULE LOAD, into sessionStorage, because the param does not
// survive long enough to be read from an effect: the magic-link path calls
// history.replaceState('/app/login') before it sets the user, and social sign-in
// navigates the whole page away to /api/auth/<provider>. Only the password login
// would still have it in the URL.
//
// Only same-origin `/oauth/` paths are honoured — re-checked on read, since
// sessionStorage is attacker-writable — so this can never become an open redirect.
const NEXT_KEY = 'opscat-oauth-next';

function isSafeNext(v: string | null): v is string {
  return !!v && v.startsWith('/oauth/');
}

(function captureNextParam() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (isSafeNext(next)) sessionStorage.setItem(NEXT_KEY, next);
})();

function consumeNextParam(): string | null {
  const next = sessionStorage.getItem(NEXT_KEY);
  if (!isSafeNext(next)) return null;
  sessionStorage.removeItem(NEXT_KEY);
  return next;
}

export default function App() {
  const app = useApp();
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    api.get<{ user: User; csrf: string }>('/api/auth/me')
      .then((r) => app.setUser(r.user, r.csrf))
      .catch(() => {})
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (!app.user) return;
    const next = consumeNextParam();
    if (next) window.location.replace(next);
  }, [app.user]);

  if (booting) return <Splash />;
  if (!app.user) return <Login />;
  // wait until the caller's orgs are known before choosing onboarding vs. the app
  if (app.activeOrgId == null) return <Splash />;
  const activeOrg = app.orgs.find((o) => o.orgId === app.activeOrgId);
  // a freshly-created cloud org greets its admin with the full-screen setup flow
  if (app.edition === 'cloud' && app.user.role === 'admin' && activeOrg && !activeOrg.onboardingDone) {
    return <Onboarding />;
  }
  return <Shell />;
}

// Boot gate: we do not know yet whether the app shell or the login form comes
// next, so this stays a neutral placeholder rather than a fake shell.
function Splash() {
  return (
    <div className="screen-center" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <Busy>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 220 }}>
          <Skeleton h={14} w="55%" />
          <Skeleton h={10} />
          <Skeleton h={10} w="80%" />
        </div>
      </Busy>
    </div>
  );
}

// ---------------------------------------------------------------- login

type LoginMode = 'password' | 'magic' | 'signup';
const OAUTH_ERRORS: Record<string, string> = {
  oauth: 'Social sign-in failed. Please try again.',
  email: 'We could not verify the e-mail address of that account.',
  disabled: 'Your account is disabled — contact your administrator.',
  nosignup: 'Sign-ups are currently closed for this instance.',
};

type AuthFlags = { google: boolean; microsoft: boolean; github: boolean; signupsOpen: boolean };
const NO_AUTH: AuthFlags = { google: false, microsoft: false, github: false, signupsOpen: false };
const OAUTH_PROVIDERS: { key: 'google' | 'microsoft' | 'github'; label: string;
  Icon: React.ComponentType<{ size?: number }> }[] = [
  { key: 'google', label: 'Continue with Google', Icon: GoogleIcon },
  { key: 'microsoft', label: 'Continue with Microsoft', Icon: MicrosoftIcon },
  { key: 'github', label: 'Continue with GitHub', Icon: GitHubIcon },
];

function Login() {
  const app = useApp();
  const [mode, setMode] = useState<LoginMode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState<AuthFlags>(NO_AUTH);

  // public plans/auth flags
  useEffect(() => {
    api.get<PlansResponse>('/api/plans')
      .then((r) => setAuth({ ...NO_AUTH, ...(r.auth || {}) }))
      .catch(() => {});
  }, []);

  // magic-link token / oauth error in URL?
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    const oauthErr = params.get('error');
    if (token) {
      history.replaceState(null, '', '/app/login');
      api.post<{ user: User; csrf: string }>('/api/auth/magic-login', { token })
        .then((r) => app.setUser(r.user, r.csrf))
        .catch((e) => setErr(e.message));
    } else if (oauthErr) {
      history.replaceState(null, '', '/app/login');
      setErr(OAUTH_ERRORS[oauthErr] || 'Sign-in failed. Please try again.');
    }
  }, []);

  const tabs: LoginMode[] = auth.signupsOpen ? ['password', 'magic', 'signup'] : ['password', 'magic'];
  const tabLabel = (m: LoginMode) => m === 'password' ? 'Password' : m === 'magic' ? 'Magic Link' : 'Sign up';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setMsg(''); setBusy(true);
    try {
      if (mode === 'password') {
        const r = await api.post<{ user: User; csrf: string }>('/api/auth/login', { email, password });
        app.setUser(r.user, r.csrf);
      } else if (mode === 'signup') {
        const body: Record<string, string> = { email, name, password };
        if (orgName.trim()) body.orgName = orgName.trim();
        const r = await api.post<{ user: User; csrf: string }>('/api/auth/signup', body);
        app.setUser(r.user, r.csrf);
      } else {
        await api.post('/api/auth/magic-link', { email });
        setMsg('If this address has an account, a sign-in link is on its way.');
      }
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : 'network error');
    } finally { setBusy(false); }
  };

  return (
    <div className="screen-center" style={{ padding: 16 }}>
      <form onSubmit={submit} className="card" style={{ width: '100%', maxWidth: 340, margin: 'auto', padding: 28 }}>
        <div className="row" style={{ gap: 10, marginBottom: 18 }}>
          <BrandMark size={30} />
          <div>
            <div className="font-bold text-text0" style={{ fontSize: 'var(--t-xl)'}}>OpsCat</div>
            <div className="text-xs text-text2">Infrastructure Ops Platform</div>
          </div>
        </div>
        <div className="row" style={{ gap: 0, marginBottom: 14, borderBottom: '1px solid var(--bg3)' }}>
          {tabs.map((m) => (
            <button key={m} type="button" onClick={() => { setMode(m); setErr(''); setMsg(''); }}
              style={{ padding: '6px 12px', fontSize: 'var(--t-sm)', fontWeight: 600,
                color: mode === m ? 'var(--text0)' : 'var(--text2)',
                borderBottom: mode === m ? '2px solid #388bfd' : '2px solid transparent' }}>
              {tabLabel(m)}
            </button>
          ))}
        </div>
        {mode === 'signup' && (
          <Field label="Name">
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
          </Field>
        )}
        <Field label="E-Mail">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com" autoFocus />
        </Field>
        {(mode === 'password' || mode === 'signup') && (
          <Field label={mode === 'signup' ? 'Password (min. 12 characters)' : 'Password'}>
            <Input type="password" required minLength={mode === 'signup' ? 12 : undefined}
              value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" />
          </Field>
        )}
        {mode === 'signup' && (
          <Field label="Organization name (optional)">
            <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Inc." />
          </Field>
        )}
        {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
        {msg && <div className="text-sm" style={{ color: SEV.green, marginBottom: 8 }}>{msg}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
          {busy ? '…' : mode === 'password' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send sign-in link'}
        </button>
        {(auth.google || auth.microsoft || auth.github) && (
          <>
            <div className="row text-text3 text-xs" style={{ gap: 8, margin: '14px 0 12px'}}>
              <span style={{ flex: 1, height: 1, background: 'var(--bg3)' }} />
              <span>or</span>
              <span style={{ flex: 1, height: 1, background: 'var(--bg3)' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {OAUTH_PROVIDERS.filter((p) => auth[p.key]).map((p) => (
                <button key={p.key} type="button" className="btn"
                  style={{ width: '100%', justifyContent: 'center', gap: 8 }}
                  onClick={() => { window.location.href = `/api/auth/${p.key}`; }}>
                  <p.Icon size={15} />
                  {p.label}
                </button>
              ))}
            </div>
          </>
        )}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- shell

function Shell() {
  const app = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false); // phone: sidebar as slide-in drawer
  const [showPalette, setShowPalette] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showPwModal, setShowPwModal] = useState(!!app.user?.mustChangePassword);
  const [edition, setEdition] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const Page = PAGES[app.nav] || Monitor;

  useEffect(() => {
    api.get<PlansResponse>('/api/plans').then((r) => setEdition(r.edition)).catch(() => {});
    api.get<BillingStatus>('/api/billing/status').then(setBilling).catch(() => {});
  }, []);

  const planLabel = (billing?.plan || 'free').toUpperCase();
  const planColor = planPillColor(billing?.plan || 'free');
  const nearLimit = !!billing && billing.plan === 'free'
    && (['users', 'checks', 'sensors', 'snmpTargets', 'agents', 'apiKeys'] as const).some((k) => {
      const lim = billing.limits[k]; const used = billing.usage[k];
      return lim > 0 && used / lim >= 0.9;
    });

  const sevCounts = useMemo(() => {
    const c = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const e of app.events) {
      if (e.severity >= 80) c.critical++;
      else if (e.severity >= 60) c.high++;
      else if (e.severity >= 40) c.medium++;
      else if (e.severity >= 20) c.low++;
    }
    return c;
  }, [app.events]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        // A modal owns the screen while it is open. showModal() makes everything
        // outside the dialog INERT — and the top layer changes painting, not
        // inertness — so a palette opened now would be visible and dead. (Before
        // the dialog it was merely painted underneath, which was no better.)
        if (document.querySelector('dialog[open]')) return;
        setShowPalette((s) => !s);
      } else if (e.key === 'Escape') {
        setShowPalette(false); setShowProfile(false); app.setSelectedEvent(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const activeCases = useMemo(() => app.events.filter((e) => e.severity >= 60).length, [app.events]);

  return (
    <div className="shell">
      {/* sidebar — on phones a slide-in drawer (.shell-rail in tokens.css) */}
      {drawer && <div className="overlay-dim" onClick={() => setDrawer(false)} />}
      <aside className={`shell-rail ${drawer ? 'open' : ''}`}
        style={{ width: collapsed ? 48 : 196, transition: 'width 0.2s', flexShrink: 0,
        background: 'var(--bg1)', borderRight: '1px solid var(--bg3)', display: 'flex',
        flexDirection: 'column', padding: '10px 8px' }}>
        <div className="row" style={{ justifyContent: collapsed ? 'center' : 'space-between',
          padding: '2px 4px 12px', flexDirection: collapsed ? 'column' : 'row', gap: 8 }}>
          <div className="row" style={{ gap: 8 }}>
            <BrandMark size={26} />
            {!collapsed && <span className="text-base font-bold text-text0">OpsCat</span>}
          </div>
          <button onClick={() => setCollapsed(!collapsed)} className="tb-hide-m"
            style={{ color: 'var(--text3)', fontSize: 'var(--t-sm)' }}>
            {collapsed ? '»' : '«'}
          </button>
        </div>
        {!collapsed && <div className="micro text-2xs" style={{ letterSpacing: '0.12em', padding: '4px 10px' }}>
          OPERATIONS</div>}
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${n.sub && !collapsed ? 'sub' : ''} ${app.nav === n.id ? 'active' : ''}`}
            onClick={() => { app.setNav(n.id); setDrawer(false); }} title={n.label}
            style={collapsed ? { justifyContent: 'center', paddingLeft: 10 } : undefined}>
            <span style={{ width: 16, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
              <n.icon size={14} /></span>
            {!collapsed && <span style={{ flex: 1 }}>{n.label}</span>}
            {!collapsed && n.id === 'monitor' && app.events.length > 0 && (
              <span className="mono text-2xs font-semibold" style={{ padding: '1px 6px',
                borderRadius: 8, background: sevCounts.critical ? alpha(SEV.critical, 0.15) : 'var(--bg3)',
                color: sevCounts.critical ? SEV.critical : 'var(--text2)' }}>{app.events.length}</span>
            )}
            {!collapsed && n.id === 'cases' && activeCases > 0 && (
              <span className="mono text-2xs font-semibold text-text2" style={{ padding: '1px 6px',
                borderRadius: 8, background: 'var(--bg3)'}}>{activeCases}</span>
            )}
          </button>
        ))}
        {!collapsed && <div className="micro text-2xs" style={{ letterSpacing: '0.12em',
          padding: '12px 10px 4px' }}>ADMIN</div>}
        {ADMIN_NAV.map((n) => (
          <button key={n.id} className={`nav-item ${app.nav === n.id ? 'active' : ''}`}
            onClick={() => { app.setNav(n.id); setDrawer(false); }} title={n.label}
            style={collapsed ? { justifyContent: 'center', paddingLeft: 10 } : undefined}>
            <span style={{ width: 16, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
              <n.icon size={14} /></span>
            {!collapsed && <span>{n.label}</span>}
          </button>
        ))}
        {app.user?.isSuperAdmin && edition === 'cloud' && <>
          {!collapsed && <div className="micro text-2xs" style={{ letterSpacing: '0.12em',
            padding: '12px 10px 4px' }}>PLATFORM</div>}
          {PLATFORM_NAV.map((n) => (
            <button key={n.id} className={`nav-item ${app.nav === n.id ? 'active' : ''}`}
              onClick={() => { app.setNav(n.id); setDrawer(false); }} title={n.label}
              style={collapsed ? { justifyContent: 'center', paddingLeft: 10 } : undefined}>
              <span style={{ width: 16, display: 'flex', justifyContent: 'center', flexShrink: 0,
                color: SEV.purple }}><n.icon size={14} /></span>
              {!collapsed && <span>{n.label}</span>}
            </button>
          ))}
        </>}
        <div style={{ flex: 1 }} />
        {/* account menu — the single place for profile actions (no topbar duplicate) */}
        <div style={{ position: 'relative', borderTop: '1px solid var(--bg3)' }}>
          <button onClick={() => setShowProfile(!showProfile)} className="row" title="Account"
            style={{ padding: '8px 6px', width: '100%', textAlign: 'left',
              justifyContent: collapsed ? 'center' : 'flex-start' }}>
            <span style={{ position: 'relative' }}>
              <Avatar i={initials(app.user!.name)} c={app.user!.color || '#7c3aed'} />
              <span style={{ position: 'absolute', right: -1, bottom: -1, width: 8, height: 8,
                borderRadius: '50%', background: SEV.green, border: '2px solid var(--bg1)' }} />
            </span>
            {!collapsed && (
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="text-sm font-semibold text-text0" style={{ whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis' }}>{app.user!.name}</div>
                <div className="mono text-2xs text-text3">{app.user!.role}</div>
              </div>
            )}
            {!collapsed && <span className="text-text3"><ChevronUpIcon size={12} /></span>}
          </button>
          {showProfile && (
            <div style={{ position: 'absolute', left: 6, bottom: 50, width: 200, zIndex: 'var(--z-rail-pop)',
              background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0,0,0,0.4)', padding: 6 }}>
              <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--bg3)', marginBottom: 4 }}>
                <div className="text-sm font-semibold text-text0" style={{ overflow: 'hidden',
                  textOverflow: 'ellipsis' }}>{app.user!.email}</div>
                <div className="mono text-2xs text-text3">{app.user!.role}</div>
              </div>
              <button className="nav-item" onClick={() => { setShowProfile(false); setShowPwModal(true); }}>
                Change password</button>
              <button className="nav-item" onClick={app.logout} style={{ color: SEV.critical }}>Sign out</button>
            </div>
          )}
        </div>
      </aside>

      {/* main column */}
      <div className="shell-main">
        {/* topbar — sticky on phones, where the document itself scrolls */}
        <header className="shell-top">
          <button className="shell-burger" onClick={() => setDrawer(true)} title="Menu">
            <MenuIcon size={17} /></button>
          <OrgSwitcher edition={edition} />
          <span className="row tb-hide-m" style={{ gap: 6 }}>
            <span className={app.connected ? 'pulse' : ''} style={{ width: 7, height: 7, borderRadius: '50%',
              background: app.connected ? SEV.green : SEV.critical }} />
            <span className="mono text-2xs font-semibold" style={{
              color: app.connected ? SEV.green : SEV.critical }}>
              {app.connected ? 'IN SYNC' : 'OFFLINE'}
            </span>
          </span>
          <span className="pill tb-hide-m" style={{ color: SEV.green, background: alpha(SEV.green, 0.12),
            border: `1px solid ${alpha(SEV.green, 0.3)}` }}>
            {app.settings.backend_label || 'nbg1 · PRIMARY'}
          </span>
          {edition === 'cloud' && (
            <span className="row tb-hide-m" style={{ gap: 6 }}>
              <span className="pill" style={{ color: planColor, background: alpha(planColor, 0.12),
                border: `1px solid ${alpha(planColor, 0.3)}` }} title="Current plan">
                {planLabel}
              </span>
              {nearLimit && (
                <button className="mono" onClick={() => app.setNav('settings')} title="Approaching a plan limit"
                  style={{ fontSize: 'var(--t-2xs)', fontWeight: 700, color: SEV.medium }}>Upgrade →</button>
              )}
            </span>
          )}
          <button onClick={() => setShowPalette(true)} className="row tb-hide-m" style={{ width: 220,
            justifyContent: 'space-between', background: 'var(--bg2)', border: '1px solid var(--bg3)',
            borderRadius: 6, padding: '5px 10px', color: 'var(--text3)', fontSize: 'var(--t-sm)' }}>
            <span>Search events, cases…</span><kbd>⌘K</kbd>
          </button>
          <div style={{ flex: 1 }} />
          <button className="shell-burger" onClick={() => setShowPalette(true)} title="Search">
            <SearchIcon size={15} /></button>
          <span className="row mono tb-hide-m text-xs font-semibold" style={{ gap: 10}}>
            {([['critical', sevCounts.critical], ['high', sevCounts.high], ['medium', sevCounts.medium],
              ['low', sevCounts.low]] as const).map(([band, count]) => (
              <span key={band} className="row" style={{ gap: 4, color: count ? SEV[band] : 'var(--text3)' }}>
                <span className="sev-dot" style={{ background: count ? SEV[band] : 'var(--text3)' }} />{count}
              </span>
            ))}
          </span>
          <span className="row tb-hide-m" style={{ gap: 0, border: '1px solid var(--bg3)', borderRadius: 5, overflow: 'hidden' }}>
            {(['comfortable', 'compact'] as const).map((d) => (
              <button key={d} onClick={() => app.setDensity(d)} title={d}
                style={{ padding: '4px 8px',
                  background: app.density === d ? 'var(--bg3)' : 'transparent',
                  color: app.density === d ? 'var(--text0)' : 'var(--text3)' }}>
                {d === 'comfortable' ? <Rows3Icon size={13} /> : <Rows4Icon size={13} />}
              </button>
            ))}
          </span>
          <button onClick={() => app.setTheme(app.theme === 'dark' ? 'light' : 'dark')}
            title="Toggle theme" style={{ color: 'var(--text2)' }}>
            {app.theme === 'dark' ? <MoonIcon size={14} /> : <SunIcon size={14} />}
          </button>
        </header>

        <main className="shell-body">
          <React.Suspense fallback={<PageLoading />}>
            <Page />
          </React.Suspense>
        </main>
      </div>

      {showPalette && <Palette onClose={() => setShowPalette(false)} />}
      {app.selectedEvent !== null && <EventSlideOver id={app.selectedEvent} />}
      {showPwModal && <ChangePassword onClose={() => setShowPwModal(false)}
        forced={!!app.user?.mustChangePassword} />}
    </div>
  );
}

// ---------------------------------------------------------------- change password

function ChangePassword({ onClose, forced }: { onClose: () => void; forced: boolean }) {
  const app = useApp();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (next !== repeat) { setErr('passwords do not match'); return; }
    try {
      await api.post('/api/auth/change-password',
        forced ? { newPassword: next } : { currentPassword: cur, newPassword: next });
      app.setUser({ ...app.user!, mustChangePassword: false });
      onClose();
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'error'); }
  };
  return (
    <Modal title={forced ? 'Set a new password' : 'Change password'} onClose={forced ? () => {} : onClose}
      hideClose={forced}>
      {forced && <div className="text-sm text-text2" style={{ marginBottom: 10 }}>
        Your password was issued by an administrator — please set your own before continuing.</div>}
      <form onSubmit={submit}>
        {!forced && <Field label="Current password">
          <Input type="password" required value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>}
        <Field label="New password (min. 12 characters)">
          <Input type="password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Repeat new password">
          <Input type="password" required minLength={12} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </Field>
        {err && <div className="text-sm" style={{ color: SEV.critical, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>Save</button>
        {forced && <button type="button" className="btn" onClick={app.logout}
          style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}>Sign out</button>}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- command palette

function Palette({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [q, setQ] = useState('');
  const [cases, setCases] = useState<CaseRow[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { api.get<CaseRow[]>('/api/cases').then(setCases).catch(() => {}); }, []);
  // Cmd-K works while a Modal is open, and a modal shown with showModal() makes the
  // whole rest of the document INERT — so a palette left in the page would be visible
  // and dead. It goes into the top layer with everything else that floats.
  useLayoutEffect(() => {
    const el = layerRef.current;
    topLayer(el, true);
    return () => topLayer(el, false);
  }, []);

  const ql = q.toLowerCase();
  const navHits = NAV.concat(ADMIN_NAV).filter((n) => !q || n.label.toLowerCase().includes(ql));
  const eventHits = q ? app.events.filter((e) =>
    `${e.name} ${e.device} ${e.description}`.toLowerCase().includes(ql)).slice(0, 6) : [];
  const caseHits = q ? cases.filter((c) =>
    `${c.label} ${c.name} ${c.device}`.toLowerCase().includes(ql)).slice(0, 4) : [];

  return (
    <div className="top-layer" ref={layerRef}>
      <div className="overlay-dim" onClick={onClose} />
      <div className="palette">
        <Input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search pages, events, cases…"
          style={{ width: '100%', border: 'none', borderBottom: '1px solid var(--bg3)',
            borderRadius: 0, background: 'transparent', padding: '12px 16px', fontSize: 'var(--t-md)' }} />
        <div style={{ maxHeight: 380, overflowY: 'auto', padding: 6 }}>
          {!q && <div className="micro text-2xs" style={{ padding: '6px 10px'}}>PAGES</div>}
          {navHits.map((n) => (
            <button key={n.id} className="nav-item" onClick={() => { app.setNav(n.id); onClose(); }}>
              <span style={{ width: 16, display: 'flex', justifyContent: 'center' }}>
                <n.icon size={14} /></span>{n.label}
            </button>
          ))}
          {eventHits.length > 0 && <div className="micro text-2xs" style={{ padding: '6px 10px'}}>EVENTS</div>}
          {eventHits.map((e) => (
            <button key={e.id} className="nav-item"
              onClick={() => { app.setNav('monitor'); app.setSelectedEvent(e.id); onClose(); }}>
              <span className="sev-dot" style={{ background: sevColor(e.severity), width: 6, height: 6 }} />
              <span className="mono text-sm">{e.name}</span>
              <span className="text-text3 text-xs">{e.device}</span>
            </button>
          ))}
          {caseHits.length > 0 && <div className="micro text-2xs" style={{ padding: '6px 10px'}}>CASES</div>}
          {caseHits.map((c) => (
            <button key={c.id} className="nav-item" onClick={() => { app.setNav('cases'); onClose(); }}>
              <span className="mono text-sm" style={{ color: SEV.low }}>{c.label}</span>
              <span className="text-sm">{c.name}</span>
              <span className="text-text3 text-xs">{c.device}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- event slide-over

function EventSlideOver({ id }: { id: number }) {
  const app = useApp();
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const load = () => api.get<EventDetail>(`/api/events/${id}`).then(setDetail).catch(() => app.setSelectedEvent(null));
  useEffect(() => { load(); }, [id]);

  if (!detail) return null;
  const c = sevColor(detail.severity);
  const act = async (action: string, extra?: object) => {
    await api.post(`/api/events/${id}/action`, { action, ...extra });
    app.refreshEvents(); load();
  };

  return (
    <>
      <div className="overlay-dim" onClick={() => app.setSelectedEvent(null)} />
      <div className="slide-over">
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--bg3)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <SevBadge score={detail.severity} />
            <button onClick={() => app.setSelectedEvent(null)} style={{ color: 'var(--text2)', fontSize: 'var(--t-xl)' }}>×</button>
          </div>
          <div className="mono font-semibold text-text0" style={{ fontSize: 18, margin: '10px 0 4px' }}>
            {detail.name}
          </div>
          <div className="mono text-sm text-text2">
            {detail.device}{detail.ip ? ` · ${detail.ip}` : ''}
          </div>
        </div>
        <div style={{ padding: '14px 20px', display: 'flex', gap: 10 }}>
          {[['SCORE', String(detail.severity)], ['HITS', String(detail.hits)],
            ['AGE', age(Date.now() - detail.firstSeen)]].map(([l, v]) => (
            <div key={l} className="card" style={{ flex: 1, padding: '10px 12px', textAlign: 'center' }}>
              <div className="micro" style={{ fontSize: 'var(--t-2xs)' }}>{l}</div>
              <div className="mono font-bold" style={{ fontSize: 22, color: c }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ padding: '0 20px 14px' }}>
          <div className="micro text-2xs" style={{ marginBottom: 6 }}>HIT TREND</div>
          <Spark data={detail.spark || []} w={470} h={36} color={c} />
        </div>
        <div style={{ padding: '0 20px 14px' }}>
          <div className="micro text-2xs" style={{ marginBottom: 6 }}>DETAILS</div>
          {([['Description', detail.description || '—'], ['Target', detail.target || '—'],
            ['Status', detail.status], ['First seen', fmtTime(detail.firstSeen)],
            ['Last seen', fmtTime(detail.lastSeen)],
            ['Case', detail.case ? `${detail.case.label} (${detail.case.status})` : '—'],
            ['Assigned', detail.assigned ? detail.assigned.n : 'unassigned']] as const).map(([k, v]) => (
            <div key={k} className="row" style={{ padding: '4px 0', borderBottom: '1px solid var(--bg3)' }}>
              <span className="text-xs text-text3" style={{ width: 90}}>{k}</span>
              <span className="mono text-sm text-text1" style={{ wordBreak: 'break-all' }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ padding: '0 20px 14px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" style={{ color: SEV.purple }} onClick={() => act('assign')}>
            Assign to me</button>
          <button className="btn btn-sm" style={{ color: SEV.medium }} onClick={() => act('downgrade')}>
            ↓ Downgrade</button>
          <button className="btn btn-sm" style={{ color: SEV.green }} onClick={() => act('finish')}>
            ✓ Finish Case</button>
          <button className="btn btn-sm" style={{ color: SEV.cyan }} onClick={() => setShowNote(!showNote)}>
            Add Note</button>
        </div>
        {showNote && (
          <div style={{ padding: '0 20px 14px' }}>
            <Textarea className="rca" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Note for the case…" />
            <button className="btn btn-primary btn-sm" style={{ marginTop: 6 }}
              onClick={() => { act('note', { note }); setShowNote(false); setNote(''); }}>Save note</button>
          </div>
        )}
        <div style={{ padding: '0 20px 20px' }}>
          <div className="micro text-2xs" style={{ marginBottom: 6 }}>RECENT SYSLOGS · {detail.device}</div>
          {detail.recentLogs.length === 0 && <div className="text-sm text-text3">no recent logs</div>}
          {detail.recentLogs.map((l, i) => (
            <div key={i} style={{ padding: 'var(--log-py) 0', borderBottom: '1px solid var(--bg3)',
              display: 'flex', gap: 8 }}>
              <span className="mono text-xs text-text3" style={{ flexShrink: 0 }}>
                {fmtTime(l.ts)}</span>
              <span className="mono text-xs" style={{ color: logSevColor(l.sev), wordBreak: 'break-all' }}>
                {l.line}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
