// Global app state: auth, theme/density, live events + logs via SSE.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, openStream, setCsrf } from './api';
import type { EventRow, LogRow, OrgMembership, OrgsResponse, User, UserRow } from './types';

function lsGet(k: string, d: string): string { try { return localStorage.getItem(k) || d; } catch { return d; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* sandboxed */ } }

export interface AppState {
  user: User | null;
  setUser: (u: User | null, csrf?: string) => void;
  orgs: OrgMembership[];
  activeOrgId: number | null;
  switchOrg: (orgId: number) => Promise<void>;
  createOrg: (orgName: string) => Promise<number>;
  reloadOrgs: () => Promise<void>;
  edition: string | null;
  theme: string; setTheme: (t: string) => void;
  density: string; setDensity: (d: string) => void;
  nav: string; setNav: (n: string) => void;
  events: EventRow[];
  logs: LogRow[];
  // first load per org still in flight — consumers show skeletons instead of
  // claiming "nothing here" before the data has arrived
  eventsLoading: boolean;
  logsLoading: boolean;
  refreshEvents: () => void;
  connected: boolean;
  selectedEvent: number | null; setSelectedEvent: (id: number | null) => void;
  // OpsCat Bridge: which incident's war room the Bridge page shows (set from
  // Incidents, same cross-page channel as selectedEvent).
  bridgeIncident: number | null; setBridgeIncident: (id: number | null) => void;
  users: UserRow[];
  settings: Record<string, string>;
  logout: () => void;
}

const Ctx = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(Ctx);

// Every id in App.tsx's NAV must be listed here, or a reload / deep link on that
// page silently drops the user back to Monitor (nav clicks still work, because
// setNav pushes the URL itself — which is why this is easy to miss).
const PAGES = ['monitor', 'classic', 'dashboard', 'assets', 'cases', 'incidents', 'bridge', 'statuspage',
  'synthetics', 'reputation', 'vendors', 'logs', 'rules', 'analytics', 'users', 'pipeline',
  'automation',
  'settings', 'platform', 'components'];

function navFromPath(): string {
  const m = /^\/app\/?([a-z]*)/.exec(location.pathname);
  return m && PAGES.includes(m[1]) ? m[1] : 'monitor';
}

/** The tab segment of `/app/<page>/<tab>`, or '' when there is none. */
function tabFromPath(): string {
  const m = /^\/app\/[a-z]*\/([a-z0-9-]+)/.exec(location.pathname);
  return m ? m[1] : '';
}

/**
 * A page's tab, in the URL — `/app/pipeline/classifiers` rather than state nobody
 * can link to. Every tabbed page uses this; a tab that lives only in useState
 * cannot be shared, bookmarked, or reached by the back button, and reloading the
 * page silently drops you back on the first one.
 *
 * Push, not replace: stepping back through tabs is what a browser's back button is
 * expected to do once they are addressable at all.
 */
export function useTab<T extends string>(ids: readonly T[], fallback?: T): [T, (t: T) => void] {
  const pick = React.useCallback(() => {
    const raw = tabFromPath();
    return (ids as readonly string[]).includes(raw) ? (raw as T) : (fallback ?? ids[0]);
  }, [ids, fallback]);
  const [tab, setTabState] = useState<T>(pick);

  // the back/forward buttons move between tabs, so re-read on popstate
  useEffect(() => {
    const onPop = () => setTabState(pick());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [pick]);

  // A deep link lands with the tab already in the path; a click on the page's own
  // nav does not, so normalise once on mount — otherwise the first tab is active
  // while the URL still says nothing.
  useEffect(() => {
    if (!tabFromPath()) {
      history.replaceState(null, '', `/app/${navFromPath()}/${tab}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTab = React.useCallback((t: T) => {
    setTabState(t);
    history.pushState(null, '', `/app/${navFromPath()}/${t}`);
  }, []);
  return [tab, setTab];
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [orgs, setOrgs] = useState<OrgMembership[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<number | null>(null);
  const [edition, setEdition] = useState<string | null>(null);
  const [theme, setThemeState] = useState(lsGet('opscat-theme', 'dark'));
  const [density, setDensityState] = useState(lsGet('opscat-density', 'comfortable'));
  const [nav, setNavState] = useState(navFromPath());
  const [events, setEvents] = useState<EventRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null);
  const [bridgeIncident, setBridgeIncident] = useState<number | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const streamStop = useRef<(() => void) | null>(null);

  useEffect(() => { document.body.dataset.theme = theme; lsSet('opscat-theme', theme); }, [theme]);
  useEffect(() => { document.body.dataset.density = density; lsSet('opscat-density', density); }, [density]);
  useEffect(() => { api.get<{ edition: string }>('/api/plans').then((r) => setEdition(r.edition)).catch(() => {}); }, []);

  const setNav = (n: string) => {
    setNavState(n);
    history.pushState(null, '', `/app/${n}`);
  };
  useEffect(() => {
    const onPop = () => setNavState(navFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const refreshEvents = () => {
    api.get<EventRow[]>('/api/events').then(setEvents)
      .catch(() => { /* session gone */ })
      .finally(() => setEventsLoading(false));
  };

  const setUser = (u: User | null, csrf?: string) => {
    if (csrf) setCsrf(csrf);
    setUserState(u);
  };

  const reloadOrgs = () => api.get<OrgsResponse>('/api/auth/orgs')
    .then((r) => { setOrgs(r.orgs); setActiveOrgId(r.activeOrgId); })
    .catch(() => { /* session gone */ });

  // switch the org this session acts in; the data effect below reloads for it
  const switchOrg = async (orgId: number) => {
    if (orgId === activeOrgId) return;
    await api.post('/api/auth/switch-org', { orgId });
    setActiveOrgId(orgId);
    setUserState((u) => (u ? { ...u, role: orgs.find((o) => o.orgId === orgId)?.role || u.role } : u));
  };

  // self-service: create a new org and land in it (server switches the session)
  const createOrg = async (orgName: string) => {
    const r = await api.post<{ orgId: number }>('/api/orgs', { orgName });
    await reloadOrgs();
    setActiveOrgId(r.orgId);
    setUserState((u) => (u ? { ...u, role: 'admin' } : u));
    return r.orgId;
  };

  // load the caller's organizations once per login (clears them on logout)
  useEffect(() => {
    if (!user) { setOrgs([]); setActiveOrgId(null); return; }
    reloadOrgs();
  }, [user?.id]);

  // org-scoped data + live stream — reruns whenever the active org changes
  useEffect(() => {
    if (!user || activeOrgId == null) { streamStop.current?.(); streamStop.current = null; setConnected(false); return; }
    setEventsLoading(true); setLogsLoading(true);
    refreshEvents();
    api.get<LogRow[]>('/api/logs?hours=2&limit=200').then((rows) => setLogs(rows.reverse()))
      .catch(() => {})
      .finally(() => setLogsLoading(false));
    // lightweight roster for assignee pickers (works for every role; the full
    // user table with emails stays behind lead+ on the Users page).
    api.get<{ id: number; name: string; color: string; role: string }[]>('/api/team')
      .then((team) => setUsers(team.map((u) => ({
        id: u.id, name: u.name, color: u.color, role: u.role,
        email: '', active: true, lastSeenAt: null,
      }))))
      .catch(() => {});
    api.get<Record<string, string>>('/api/admin/settings').then(setSettings).catch(() => {});
    setConnected(true);
    streamStop.current = openStream({
      onLog: (l: LogRow) => setLogs((prev) => [...prev.slice(-499), l]),
      onEvent: (e: EventRow) => setEvents((prev) => {
        const spark = prev.find((p) => p.id === e.id)?.spark;
        const merged = { ...e, spark: spark ? [...spark.slice(1), e.hits] : Array(10).fill(e.hits) };
        const rest = prev.filter((p) => p.id !== e.id);
        const next = e.status === 'active' ? [...rest, merged] : rest;
        return next.sort((a, b) => b.severity - a.severity || b.lastSeen - a.lastSeen);
      }),
    });
    return () => { streamStop.current?.(); streamStop.current = null; };
  }, [user?.id, activeOrgId]);

  const logout = () => {
    api.post('/api/auth/logout').catch(() => {}).finally(() => setUser(null));
  };

  const value = useMemo<AppState>(() => ({
    user, setUser, orgs, activeOrgId, switchOrg, createOrg, reloadOrgs, edition,
    theme, setTheme: setThemeState, density, setDensity: setDensityState,
    nav, setNav, events, logs, eventsLoading, logsLoading, refreshEvents, connected,
    selectedEvent, setSelectedEvent, bridgeIncident, setBridgeIncident, users, settings, logout,
  }), [user, orgs, activeOrgId, edition, theme, density, nav, events, logs, eventsLoading,
    logsLoading, connected, selectedEvent, bridgeIncident, users, settings]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
