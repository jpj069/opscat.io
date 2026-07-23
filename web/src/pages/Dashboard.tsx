// Dashboard — at-a-glance ops overview: KPIs, live severity map, volume + MTTR.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { SEV, alpha, fmtDuration } from '../format';
import { Avatar, KpiCard, StackedArea, LineChart, HBars } from '../ui';
import type { DashboardData, AnalyticsData } from '../types';

const BANDS: Record<'critical' | 'high' | 'medium' | 'low', [number, number]> = {
  critical: [80, 101], high: [60, 80], medium: [40, 60], low: [20, 40],
};
const WEIGHTS: Record<'critical' | 'high' | 'medium' | 'low', number> = {
  critical: 4, high: 2, medium: 1.5, low: 1,
};

export default function Dashboard() {
  const app = useApp();
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [ana, setAna] = useState<AnalyticsData | null>(null);

  useEffect(() => {
    api.get<DashboardData>('/api/dashboard').then(setDash).catch(() => {});
    api.get<AnalyticsData>('/api/analytics?range=7d').then(setAna).catch(() => {});
  }, []);

  // Live severity bands derived from the streaming events.
  const bands = useMemo(() => (['critical', 'high', 'medium', 'low'] as const).map((k) => {
    const [lo, hi] = BANDS[k];
    const count = app.events.filter((e) => e.severity >= lo && e.severity < hi).length;
    return { k, count, color: SEV[k], weight: WEIGHTS[k] };
  }).filter((b) => b.count > 0), [app.events]);

  if (!dash || !ana) {
    return (
      <div className="page">
        <h1 className="page-title">Dashboard</h1>
        <div style={{ color: 'var(--text3)', fontSize: 12 }}>loading…</div>
      </div>
    );
  }

  const maxCases = Math.max(...dash.casesByAnalyst.map((a) => a.count), 1);
  const mttrPoints = ana.mttrDaily.map((m) => m.v);
  const mttrLabels = ana.mttrDaily.map((m) => m.d.slice(5));

  return (
    <div className="page">
      <h1 className="page-title">Dashboard</h1>

      {/* KPI row */}
      <div className="row" style={{ gap: 12, alignItems: 'stretch' }}>
        <KpiCard label="ACTIVE CRITICAL" value={String(dash.sevCounts.critical)} color={SEV.critical}
          spark={ana.volume.map((v) => v.c)} />
        <KpiCard label="OPEN CASES" value={String(dash.openCases)} color={SEV.medium} />
        <KpiCard label="AVG MTTR 7D" value={fmtDuration(dash.mttrMs)} color={SEV.green} spark={mttrPoints} />
        <KpiCard label="LOGS 24H" value={String(dash.logs24)} color={SEV.low} />
      </div>

      {/* Severity Impact Map */}
      <div className="card">
        <div className="card-title">Severity Impact Map</div>
        {bands.length === 0 ? (
          <div style={{ color: 'var(--text3)', fontSize: 11 }}>no active events — all quiet.</div>
        ) : (
          <>
            <div style={{ display: 'flex', height: 64, gap: 4 }}>
              {bands.map((b) => (
                <div key={b.k} style={{
                  flex: b.count * b.weight, minWidth: 44, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', borderRadius: 6,
                  background: alpha(b.color, 0.18), border: `1px solid ${alpha(b.color, 0.4)}`,
                }}>
                  <span className="mono" style={{ fontSize: 16, fontWeight: 700, color: b.color }}>{b.count}</span>
                  <span style={{ fontSize: 9, color: 'var(--text2)', textTransform: 'uppercase',
                    letterSpacing: '0.06em' }}>{b.k}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', height: 6, gap: 2, marginTop: 8 }}>
              {bands.map((b) => (
                <div key={b.k} style={{ flex: b.count * b.weight, background: b.color, borderRadius: 2 }} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Volume + MTTR */}
      <div className="row" style={{ gap: 12, alignItems: 'stretch' }}>
        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          <div className="card-title">Event Volume 7d</div>
          <StackedArea data={ana.volume} />
        </div>
        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          <div className="card-title">MTTR 7d</div>
          <LineChart points={mttrPoints} labels={mttrLabels} color={SEV.green}
            fmt={(v) => `${Math.round(v / 60000)}m`} />
        </div>
      </div>

      {/* Top types + cases by analyst */}
      <div className="row" style={{ gap: 12, alignItems: 'stretch' }}>
        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          <div className="card-title">Top Event Types</div>
          <HBars items={ana.topTypes} color={SEV.low} />
        </div>
        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          <div className="card-title">Cases by Analyst</div>
          {dash.casesByAnalyst.length === 0 ? (
            <div style={{ color: 'var(--text3)', fontSize: 11 }}>no cases yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {dash.casesByAnalyst.map((a) => (
                <div key={a.name} className="row" style={{ gap: 8 }}>
                  <Avatar i={a.i} c={a.color} size={20} />
                  <span style={{ width: 110, fontSize: 11, color: 'var(--text1)', overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <div style={{ flex: 1, height: 8, background: 'var(--bg3)', borderRadius: 4,
                    overflow: 'hidden' }}>
                    <div style={{ width: `${(a.count / maxCases) * 100}%`, height: '100%',
                      background: a.color }} />
                  </div>
                  <span className="mono" style={{ width: 32, fontSize: 11, color: 'var(--text2)',
                    textAlign: 'right' }}>{a.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
