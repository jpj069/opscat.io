// Global app state: auth, theme/density, live events + logs via SSE.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, openStream, setCsrf } from './api';
import type { EventRow, LogRow, User, UserRow } from './types';

function lsGet(k: string, d: string): string { try { return localStorage.getItem(k) || d; } catch { return d; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* sandboxed */ } }

export interface AppState {
  user: User | null;
  setUser: (u: User | null, csrf?: string) => void;
  theme: string; setTheme: (t: string) => void;
  density: string; setDensity: (d: string) => void;
  nav: string; setNav: (n: string) => void;
  events: EventRow[];
  logs: LogRow[];
  refreshEvents: () => void;
  connected: boolean;
  selectedEvent: number | null; setSelectedEvent: (id: number | null) => void;
  users: UserRow[];
  settings: Record<string, string>;
  logout: () => void;
}

const Ctx = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(Ctx);

const PAGES = ['monitor', 'classic', 'dashboard', 'cases', 'incidents', 'statuspage',
  'synthetics', 'logs', 'rules', 'analytics', 'users', 'settings', 'platform'];

function navFromPath(): string {
  const m = /^\/app\/?([a-z]*)/.exec(location.pathname);
  return m && PAGES.includes(m[1]) ? m[1] : 'monitor';
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [theme, setThemeState] = useState(lsGet('opscat-theme', 'dark'));
  const [density, setDensityState] = useState(lsGet('opscat-density', 'comfortable'));
  const [nav, setNavState] = useState(navFromPath());
  const [events, setEvents] = useState<EventRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const streamStop = useRef<(() => void) | null>(null);

  useEffect(() => { document.body.dataset.theme = theme; lsSet('opscat-theme', theme); }, [theme]);
  useEffect(() => { document.body.dataset.density = density; lsSet('opscat-density', density); }, [density]);

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
    api.get<EventRow[]>('/api/events').then(setEvents).catch(() => { /* session gone */ });
  };

  const setUser = (u: User | null, csrf?: string) => {
    if (csrf) setCsrf(csrf);
    setUserState(u);
  };

  useEffect(() => {
    if (!user) { streamStop.current?.(); streamStop.current = null; setConnected(false); return; }
    refreshEvents();
    api.get<LogRow[]>('/api/logs?hours=2&limit=200').then((rows) => setLogs(rows.reverse())).catch(() => {});
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
  }, [user?.id]);

  const logout = () => {
    api.post('/api/auth/logout').catch(() => {}).finally(() => setUser(null));
  };

  const value = useMemo<AppState>(() => ({
    user, setUser, theme, setTheme: setThemeState, density, setDensity: setDensityState,
    nav, setNav, events, logs, refreshEvents, connected, selectedEvent, setSelectedEvent,
    users, settings, logout,
  }), [user, theme, density, nav, events, logs, connected, selectedEvent, users, settings]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
