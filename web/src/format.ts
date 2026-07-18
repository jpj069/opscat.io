// Shared formatting + severity helpers (mapping from the design handoff).
export const SEV = {
  critical: '#f85149', high: '#f0883e', medium: '#e3b341', low: '#388bfd', info: '#8b949e',
  green: '#3fb950', purple: '#bc8cff', cyan: '#38b6ff', teams: '#5865f2',
};

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
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n; let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}
