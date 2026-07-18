// Analytics — range-scoped trends: KPIs, volume by severity, MTTR, top types/servers.
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { SEV, fmtDuration } from '../format';
import { KpiCard, StackedArea, LineChart, HBars } from '../ui';
import type { AnalyticsData } from '../types';

type Range = '24h' | '7d' | '30d';

export default function Analytics() {
  const [range, setRange] = useState<Range>('7d');
  const [ana, setAna] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get<AnalyticsData>(`/api/analytics?range=${range}`)
      .then(setAna).catch(() => {}).finally(() => setLoading(false));
  }, [range]);

  const mttrPoints = ana ? ana.mttrDaily.map((m) => m.v) : [];
  const mttrLabels = ana ? ana.mttrDaily.map((m) => m.d.slice(5)) : [];

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 className="page-title">Analytics</h1>
        <div className="row" style={{ gap: 6 }}>
          {(['24h', '7d', '30d'] as Range[]).map((r) => (
            <button key={r} className={`chip ${range === r ? 'active' : ''}`}
              onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
      </div>

      {!ana ? (
        <div style={{ color: 'var(--text3)', fontSize: 12 }}>loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, opacity: loading ? 0.6 : 1 }}>
          {/* KPI row */}
          <div className="row" style={{ gap: 12, alignItems: 'stretch' }}>
            <KpiCard label="TOTAL EVENTS" value={String(ana.totals.events)} color={SEV.high} />
            <KpiCard label="AVG MTTR" value={fmtDuration(ana.totals.mttrMs)} color={SEV.medium} />
            <KpiCard label="RESOLUTION RATE" value={`${ana.totals.resolutionRate}%`} color={SEV.green} />
            <KpiCard label="NOTIFICATIONS" value={String(ana.totals.notifications)} color={SEV.purple}
              sub={`${ana.totals.notificationsFailed} failed`} />
          </div>

          {/* Volume + MTTR */}
          <div className="row" style={{ gap: 12, alignItems: 'stretch' }}>
            <div className="card" style={{ flex: 1, minWidth: 0 }}>
              <div className="card-title">Event Volume</div>
              <StackedArea data={ana.volume} />
            </div>
            <div className="card" style={{ flex: 1, minWidth: 0 }}>
              <div className="card-title">MTTR</div>
              <LineChart points={mttrPoints} labels={mttrLabels} color={SEV.green}
                fmt={(v) => `${Math.round(v / 60000)}m`} />
            </div>
          </div>

          {/* Top types + servers */}
          <div className="row" style={{ gap: 12, alignItems: 'stretch' }}>
            <div className="card" style={{ flex: 1, minWidth: 0 }}>
              <div className="card-title">Top Event Types</div>
              <HBars items={ana.topTypes} color={SEV.low} />
            </div>
            <div className="card" style={{ flex: 1, minWidth: 0 }}>
              <div className="card-title">Most Active Servers</div>
              <HBars items={ana.topServers} color={SEV.cyan} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
