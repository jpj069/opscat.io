// Analytics — range-scoped trends: KPIs, volume by severity, MTTR, top types/servers.
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { SEV, fmtDuration } from '../format';
import { Card, KpiCard, StackedArea, LineChart, HBars, PageHeader, Segmented } from '../ui';
import type { AnalyticsData } from '../types';

type Range = '24h' | '7d' | '30d';
const RANGES = [['24h', '24h'], ['7d', '7d'], ['30d', '30d']] as const;

export default function Analytics() {
  const [range, setRange] = useState<Range>('7d');
  const [ana, setAna] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get<AnalyticsData>(`/api/analytics?range=${range}`)
      .then(setAna).catch(() => {}).finally(() => setLoading(false));
  }, [range]);

  const mttrPoints = ana?.mttrDaily.map((m) => m.v) ?? null;
  const mttrLabels = ana?.mttrDaily.map((m) => m.d.slice(5));

  return (
    <div className="page">
      <PageHeader title="Analytics">
        <Segmented label="Time range" value={range} onChange={setRange} options={RANGES} />
      </PageHeader>

      {/* The layout renders from the first paint; each card placeholders itself
          from `null` data. On a range switch the previous numbers stay visible
          at reduced opacity (stale-while-revalidating) instead of flashing. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, opacity: ana && loading ? 0.6 : 1 }}>
        {/* KPI row */}
        <div className="row" style={{ gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
          <KpiCard label="TOTAL EVENTS" value={ana && String(ana.totals.events)} color={SEV.high} />
          <KpiCard label="AVG MTTR" value={ana && fmtDuration(ana.totals.mttrMs)} color={SEV.medium} />
          <KpiCard label="RESOLUTION RATE" value={ana && `${ana.totals.resolutionRate}%`} color={SEV.green} />
          <KpiCard label="NOTIFICATIONS" value={ana && String(ana.totals.notifications)} color={SEV.purple}
            sub={ana && `${ana.totals.notificationsFailed} failed`} />
        </div>

        {/* Volume + MTTR */}
        <div className="row" style={{ gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
          <Card style={{ flex: 1, minWidth: 280 }}>
            <div className="card-title">Event Volume</div>
            <StackedArea data={ana?.volume ?? null} />
          </Card>
          <Card style={{ flex: 1, minWidth: 280 }}>
            <div className="card-title">MTTR</div>
            <LineChart points={mttrPoints} labels={mttrLabels} color={SEV.green}
              fmt={(v) => `${Math.round(v / 60000)}m`} />
          </Card>
        </div>

        {/* Top types + servers */}
        <div className="row" style={{ gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
          <Card style={{ flex: 1, minWidth: 280 }}>
            <div className="card-title">Top Event Types</div>
            <HBars items={ana?.topTypes ?? null} color={SEV.low} />
          </Card>
          <Card style={{ flex: 1, minWidth: 280 }}>
            <div className="card-title">Most Active Servers</div>
            <HBars items={ana?.topServers ?? null} color={SEV.cyan} />
          </Card>
        </div>
      </div>
    </div>
  );
}
