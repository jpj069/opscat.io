// Dashboard — at-a-glance ops overview: KPIs, live severity map, volume + MTTR.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import { api } from '../api';
import { SEV, alpha, fmtDuration, initials } from '../format';
import { Card, Avatar, KpiCard, StackedArea, LineChart, HBars, Skeleton, BarsSkeleton, PageHeader, StatusPill, ListSkeleton } from '../ui';
import type { DashboardData, AnalyticsData, OnCallNowRow } from '../types';

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
  const [onCall, setOnCall] = useState<OnCallNowRow[] | null>(null);

  useEffect(() => {
    api.get<DashboardData>('/api/dashboard').then(setDash).catch(() => {});
    api.get<AnalyticsData>('/api/analytics?range=7d').then(setAna).catch(() => {});
    api.get<{ schedules: OnCallNowRow[] }>('/api/oncall/now')
      .then((r) => setOnCall(r.schedules)).catch(() => setOnCall([]));
  }, []);

  // Live severity bands derived from the streaming events.
  const bands = useMemo(() => (['critical', 'high', 'medium', 'low'] as const).map((k) => {
    const [lo, hi] = BANDS[k];
    const count = app.events.filter((e) => e.severity >= lo && e.severity < hi).length;
    return { k, count, color: SEV[k], weight: WEIGHTS[k] };
  }).filter((b) => b.count > 0), [app.events]);

  // The page always renders its real structure — every card below feeds its own
  // placeholder from `null` data, so the skeleton IS the layout and cannot drift.
  const maxCases = Math.max(...(dash?.casesByAnalyst ?? []).map((a) => a.count), 1);
  const mttrPoints = ana?.mttrDaily.map((m) => m.v) ?? null;
  const mttrLabels = ana?.mttrDaily.map((m) => m.d.slice(5));

  return (
    <div className="page">
      <PageHeader title="Dashboard" />

      {/* KPI row */}
      <div className="row" style={{ gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <KpiCard label="ACTIVE CRITICAL" value={dash && String(dash.sevCounts.critical)} color={SEV.critical}
          spark={ana?.volume.map((v) => v.c)} />
        <KpiCard label="OPEN CASES" value={dash && String(dash.openCases)} color={SEV.medium} />
        <KpiCard label="AVG MTTR 7D" value={dash && fmtDuration(dash.mttrMs)} color={SEV.green} spark={mttrPoints} />
        <KpiCard label="LOGS 24H" value={dash && String(dash.logs24)} color={SEV.low} />
      </div>

      {/* Who has the duty — the first question of every handover. Hidden until a
          schedule exists, so an org that has not set up On-Call sees no empty box. */}
      {onCall === null ? <ListSkeleton rows={1} /> : onCall.length > 0 && (
        <Card>
          <div className="card-title">On call now</div>
          <div className="row row-wrap" style={{ gap: 18 }}>
            {onCall.map((r) => (
              <span key={r.scheduleId} className="row" style={{ gap: 8, minWidth: 0 }}>
                <span className="micro text-2xs text-text3">{r.name}</span>
                {r.user ? (
                  <span className="row" style={{ gap: 6 }}>
                    <Avatar i={initials(r.user.name)} c={r.user.color} size={22} />
                    <span className="text-sm text-text1">{r.user.name}</span>
                  </span>
                ) : (
                  <StatusPill text={r.configured ? 'Nobody' : 'Not set up'}
                    color={r.configured ? SEV.critical : SEV.info} />
                )}
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Severity Impact Map */}
      <Card>
        <div className="card-title">Severity Impact Map</div>
        {app.eventsLoading ? (
          <Skeleton h={64} radius={6} />
        ) : bands.length === 0 ? (
          <div className="text-text3 text-sm">no active events — all quiet.</div>
        ) : (
          <>
            <div style={{ display: 'flex', height: 64, gap: 4 }}>
              {bands.map((b) => (
                <div key={b.k} style={{
                  flex: b.count * b.weight, minWidth: 44, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', borderRadius: 6,
                  background: alpha(b.color, 0.18), border: `1px solid ${alpha(b.color, 0.4)}`,
                }}>
                  <span className="mono text-xl font-bold" style={{ color: b.color }}>{b.count}</span>
                  <span className="text-2xs text-text2" style={{ textTransform: 'uppercase',
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
      </Card>

      {/* Volume + MTTR */}
      <div className="row" style={{ gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <Card style={{ flex: 1, minWidth: 280 }}>
          <div className="card-title">Event Volume 7d</div>
          <StackedArea data={ana?.volume ?? null} />
        </Card>
        <Card style={{ flex: 1, minWidth: 280 }}>
          <div className="card-title">MTTR 7d</div>
          <LineChart points={mttrPoints} labels={mttrLabels} color={SEV.green}
            fmt={(v) => `${Math.round(v / 60000)}m`} />
        </Card>
      </div>

      {/* Top types + cases by analyst */}
      <div className="row" style={{ gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <Card style={{ flex: 1, minWidth: 280 }}>
          <div className="card-title">Top Event Types</div>
          <HBars items={ana?.topTypes ?? null} color={SEV.low} />
        </Card>
        <Card style={{ flex: 1, minWidth: 280 }}>
          <div className="card-title">Cases by Analyst</div>
          {!dash ? (
            <BarsSkeleton rows={4} labelW={110} />
          ) : dash.casesByAnalyst.length === 0 ? (
            <div className="text-text3 text-sm">no cases yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {dash.casesByAnalyst.map((a) => (
                <div key={a.name} className="row" style={{ gap: 8 }}>
                  <Avatar i={a.i} c={a.color} size={20} />
                  <span className="text-sm text-text1" style={{ width: 110, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <div style={{ flex: 1, height: 8, background: 'var(--bg3)', borderRadius: 4,
                    overflow: 'hidden' }}>
                    <div style={{ width: `${(a.count / maxCases) * 100}%`, height: '100%',
                      background: a.color }} />
                  </div>
                  <span className="mono text-sm text-text2" style={{ width: 32,
                    textAlign: 'right' }}>{a.count}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
