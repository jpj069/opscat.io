'use strict';
// The app-wide status scale (docs/INCIDENTS-V2.md §2 "One status scale"):
//
//   operational < maintenance < degraded < partial < major
//
// ONE ordering for components, vendors, the day rollups and incident impact.
// `maintenance` deliberately ranks below every impact level, so an active
// incident always outranks a maintenance state in worst-wins comparisons.
// Display labels and colors live in web/src/format.tsx (STATUS_META) — stored
// values never carry a second spelling of the same fact; boundary formats
// (Statuspage feeds etc.) translate in engine/vendor-feeds.js.

const ORDER = ['operational', 'maintenance', 'degraded', 'partial', 'major'];
const RANK = Object.fromEntries(ORDER.map((s, i) => [s, i]));

// Incident impact = the non-operational, non-maintenance levels of the scale.
const IMPACTS = ['degraded', 'partial', 'major'];

// Worst-wins over a list of scale values; empty list → fallback.
function worst(list, fallback = 'operational') {
  return list.reduce((a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a), fallback);
}

// The same ordering as a SQL CASE over a column reference, so the rollup
// upserts in engine/retention.js derive their comparisons from this constant
// instead of keeping hand-written copies. Unknown values compare as major.
function rankCaseSql(colRef) {
  const whens = ORDER.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ');
  return `(CASE ${colRef} ${whens} ELSE ${ORDER.length - 1} END)`;
}

module.exports = { ORDER, RANK, IMPACTS, worst, rankCaseSql };
