// Shared formatting + severity helpers (mapping from the design handoff).
export const SEV = {
  critical: '#f85149', high: '#f0883e', medium: '#e3b341', low: '#388bfd', info: '#8b949e',
  green: '#3fb950', purple: '#bc8cff', cyan: '#38b6ff', msteams: '#5865f2',
};

// Alert channels — mirror of RULE_CHANNELS in server/src/routes/ops.js and the
// CHECK on alert_rules.channel. `label` is the display spelling; the stored
// value is what the API takes. `msteams` is Microsoft Teams, spelled out
// because On-Call has a Team object of its own (docs/ONCALL-V1.md §2).
export const CHANNEL_META = {
  email: { label: 'E-mail', color: '#388bfd' },
  msteams: { label: 'Microsoft Teams', color: '#5865f2' },
  slack: { label: 'Slack', color: '#e01e5a' },
  telegram: { label: 'Telegram', color: '#29a9eb' },
  discord: { label: 'Discord', color: '#7289da' },
  ntfy: { label: 'ntfy', color: '#3fb950' },
  pushover: { label: 'Pushover', color: '#249df1' },
  webhook: { label: 'Webhook', color: '#3fb950' },
} as const;
export type Channel = keyof typeof CHANNEL_META;
export const channelLabel = (c: string) => CHANNEL_META[c as Channel]?.label ?? c;
export const channelColor = (c: string) => CHANNEL_META[c as Channel]?.color ?? SEV.info;

// The app-wide status scale — mirror of server/src/lib/status-scale.js
// (docs/INCIDENTS-V2.md §2 "One status scale"). Insertion order = rank order;
// `label` is the display spelling, stored values never carry a second one.
export const STATUS_META = {
  operational: { label: 'Operational', color: SEV.green, rank: 0 },
  maintenance: { label: 'Maintenance', color: SEV.purple, rank: 1 },
  degraded: { label: 'Degraded', color: SEV.medium, rank: 2 },
  partial: { label: 'Partial Outage', color: SEV.high, rank: 3 },
  major: { label: 'Major Outage', color: SEV.critical, rank: 4 },
} as const;
export type ScaleStatus = keyof typeof STATUS_META;
// incident impact = the non-operational, non-maintenance levels of the scale
export const IMPACTS = ['degraded', 'partial', 'major'] as const;
export type Impact = typeof IMPACTS[number];

export function sevBand(score: number): keyof typeof SEV {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  if (score >= 20) return 'low';
  return 'info';
}
export function sevLabel(score: number): string {
  const b = sevBand(score);
  return b.charAt(0).toUpperCase() + b.slice(1);
}
export function sevColor(score: number): string { return SEV[sevBand(score)]; }
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// syslog severity → log line color
export function logSevColor(sev: number): string {
  if (sev <= 2) return SEV.critical;
  if (sev === 3) return SEV.high;
  if (sev === 4) return SEV.medium;
  return 'var(--text2)';
}

export function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 8)}`;
}
/**
 * A timestamp for a HISTORY: the time of day for something that happened today, the
 * date and time for anything older.
 *
 * `fmtTime` alone is wrong here and looks like a sorting bug rather than a formatting
 * one — a fleet location provisioned three days ago rendered as "09:47:14" directly
 * above today's "09:47:25", so a correctly ordered list read as shuffled. A history
 * is the one place where entries routinely span days.
 */
export function fmtHistory(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const hhmmss = d.toTimeString().slice(0, 8);
  if (sameDay) return hhmmss;
  // local date, not toISOString() — that is UTC and would show the wrong day near midnight
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${day} ${hhmmss.slice(0, 5)}`;
}
export function age(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(2)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(2)}h`;
  return `${(h / 24).toFixed(2)}d`;
}
export function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
export function relTime(ts: number | null): string {
  if (!ts) return 'never';
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}
export function initials(name: string): string {
  return name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}
export function fmtBytes(n: number): string {
  // rounded: a byte count is an integer, but a DERIVED one (bytes per line, half a
  // chart's axis maximum) is not — and `94.17753303964757 B` shipped to a KPI line
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n; let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}
