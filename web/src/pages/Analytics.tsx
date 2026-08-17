// Analytics — range-scoped trends. Two tabs, both URL-bound: the pipeline
// numbers (events, MTTR, top types) and the ON-CALL numbers (MTTA, escalation,
// who is being woken), which are a different question asked by different people.
import React, { useCallback, useEffect, useState } from 'react';
import { useTab } from '../state';
import { api } from '../api';
import { SEV, fmtDuration, initials } from '../format';
import {
  Card, KpiCard, StackedArea, LineChart, HBars, PageHeader, Segmented, Tabs,
  TableScroll, TableSkeleton, StatusPill, Avatar, COL,
} from '../ui';
import type { AnalyticsData, OnCallAnalytics } from '../types';

const TABS = [['pipeline', 'Pipeline'], ['oncall', 'On-Call']] as const;
type Tab = typeof TABS[number][0];

type Range = '24h' | '7d' | '30d';
const RANGES = [['24h', '24h'], ['7d', '7d'], ['30d', '30d']] as const;
const OC_RANGES = [['7d', '7d'], ['30d', '30d'], ['90d', '90d']] as const;
type OcRange = typeof OC_RANGES[number][0];

// Person | Alerts | Out of hours | Nights | Timezone
const PERSON_COLS = [COL.text, COL.num, COL.num, COL.num, COL.label].join(' ');

export default function Analytics() {
  const [tab, setTab] = useTab(TABS.map((t) => t[0]) as readonly Tab[]);
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

  if (tab === 'oncall') {
    return (
      <div className="page">
        <PageHeader title="Analytics" />
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
        <OnCallAnalyticsTab />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Analytics">
        <Segmented label="Time range" value={range} onChange={setRange} options={RANGES} />
      </PageHeader>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

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

// ---------------------------------------------------------------------------
/**
 * The on-call numbers (docs/ONCALL-V1.md §8, slice 5).
 *
 * Four questions, deliberately in this order, because it is the order somebody
 * asks them after a bad week: how fast does anyone answer, how often is the
 * first person not enough, **who is paying for that in sleep**, and where does
 * the noise come from.
 */
function OnCallAnalyticsTab() {
  const [range, setRange] = useState<OcRange>('30d');
  const [d, setD] = useState<OnCallAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.get<OnCallAnalytics>(`/api/oncall/analytics?range=${range}`)
      .then(setD).catch(() => setD(null)).finally(() => setLoading(false));
  }, [range]);
  useEffect(() => { load(); }, [load]);

  const mttaPoints = d?.mtta.daily.map((m) => m.v) ?? null;
  const mttaLabels = d?.mtta.daily.map((m) => m.d.slice(5));
  // Micros are millionths; two decimals is what a per-message price looks like.
  const money = (micros: number) => (micros / 1e6).toFixed(2);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, opacity: d && loading ? 0.6 : 1 }}>
      <div className="row row-wrap" style={{ justifyContent: 'flex-end' }}>
        <Segmented label="Time range" value={range} onChange={setRange} options={OC_RANGES} />
      </div>

      <div className="row" style={{ gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
        {/* MTTA is the headline: MTTR says how long a problem lasted, MTTA says
            how long it took anybody to say "I have it". */}
        <KpiCard label="MTTA" value={d && fmtDuration(d.mtta.avgMs)} color={SEV.green}
          sub={d && `${d.mtta.acked} acknowledged · ${d.mtta.unacked} never were`} />
        <KpiCard label="ALERTS RAISED" value={d && String(d.escalation.raised)} color={SEV.high}
          sub={d && `${d.escalation.acked + d.escalation.resolved} answered`} />
        <KpiCard label="ESCALATION RATE" value={d && `${d.escalation.rate}%`} color={SEV.medium}
          sub={d && `${d.escalation.escalated} left rung one`} />
        <KpiCard label="REACHED NOBODY" value={d && String(d.escalation.exhausted)}
          color={d && d.escalation.exhausted > 0 ? SEV.critical : SEV.info}
          sub={d && `${d.escalation.exhaustedRate}% of alerts`} />
      </div>

      <div className="row" style={{ gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <Card style={{ flex: 1, minWidth: 280 }}>
          <div className="card-title">Time to acknowledge</div>
          <LineChart points={mttaPoints} labels={mttaLabels} color={SEV.green}
            fmt={(v) => `${Math.round(v / 60000)}m`} />
        </Card>
        <Card style={{ flex: 1, minWidth: 280 }}>
          <div className="card-title">Alerts per schedule</div>
          <HBars items={d?.perSchedule.map((s) => ({ n: s.name, v: s.alerts })) ?? null} color={SEV.cyan} />
          {d && d.perSchedule.length > 0 && (
            <div className="text-xs text-text3" style={{ marginTop: 8 }}>
              {d.perSchedule.map((s) => `${s.name}: ${s.perWeek}/week`).join(' · ')}
            </div>
          )}
        </Card>
      </div>

      <Card style={{ padding: 0 }}>
        <div className="card-title" style={{ padding: '14px 16px 0' }}>Who is being woken</div>
        <div className="text-sm text-text2" style={{ padding: '4px 16px 10px' }}>
          Counted in each person&rsquo;s own local time — out of hours is before 08:00, from
          18:00, or a weekend; a night is 22:00 to 06:00. A rotation can look fair on the
          calendar and still land every night on one person.
        </div>
        <TableScroll cols={PERSON_COLS} stickyFirst minWidth={620}>
          <div className="tbl-head">
            <span>Person</span>
            <span style={{ textAlign: 'right' }}>Alerts</span>
            <span style={{ textAlign: 'right' }}>Out of hours</span>
            <span style={{ textAlign: 'right' }}>Nights</span>
            <span>Timezone</span>
          </div>
          {!d ? (
            <TableSkeleton rows={4} />
          ) : d.perPerson.length === 0 ? (
            <div className="text-text3 text-sm" style={{ padding: 32, textAlign: 'center' }}>
              nobody has been alerted in this window
            </div>
          ) : d.perPerson.map((p) => (
            <div key={p.user.id} className="tbl-row">
              <span className="row" style={{ gap: 6, minWidth: 0 }}>
                <Avatar i={initials(p.user.name)} c={p.user.color} size={20} />
                <span className="text-sm text-text1" style={{ overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.user.name}</span>
              </span>
              <span className="mono text-sm text-text1" style={{ textAlign: 'right' }}>{p.total}</span>
              <span className="mono text-sm" style={{ textAlign: 'right',
                color: p.outOfHours ? SEV.medium : 'var(--text3)' }}>{p.outOfHours}</span>
              <span className="mono text-sm" style={{ textAlign: 'right',
                color: p.nights ? SEV.critical : 'var(--text3)' }}>{p.nights}</span>
              {/* Where the zone came from, because a number computed in the wrong
                  timezone is worse than no number — it is arguable. */}
              <span className="mono text-xs text-text3" title={p.tzSource === 'user' ? 'from this person’s profile'
                : p.tzSource === 'schedule' ? 'from the schedule that reached them — they have no timezone set'
                  : 'no timezone anywhere — counted in UTC'}>
                {p.timezone}{p.tzSource !== 'user' ? ' *' : ''}
              </span>
            </div>
          ))}
        </TableScroll>
        {d && d.perPerson.some((p) => p.tzSource !== 'user') && (
          <div className="text-xs text-text3" style={{ padding: '8px 16px', borderTop: '1px solid var(--bg3)' }}>
            * this person has no timezone on their profile, so their local time was taken
            from the schedule that reached them (or UTC).
          </div>
        )}
        {d && d.truncated && (
          <div className="text-sm" style={{ padding: '8px 16px', borderTop: '1px solid var(--bg3)',
            color: SEV.medium }}>
            More notifications than can be folded in one pass — the per-person figures above
            are a sample of the most recent ones, not a total.
          </div>
        )}
      </Card>

      {d && d.cost.messages > 0 && (
        <Card>
          <div className="card-title" style={{ marginBottom: 4 }}>Metered channels</div>
          <div className="row row-wrap" style={{ gap: 10, alignItems: 'baseline' }}>
            <span className="mono text-base text-text0">{money(d.cost.micros)}</span>
            <span className="text-sm text-text2">
              across {d.cost.messages} SMS and calls in the last {d.range}
            </span>
            <StatusPill text="sms + voice only" color={SEV.purple} />
          </div>
        </Card>
      )}
    </div>
  );
}
