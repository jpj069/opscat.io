#!/usr/bin/env node
// Guard: no ad-hoc "loading…" placeholders in the UI.
//
// Loading states belong to the design system (web/src/ui.tsx): Skeleton,
// TableSkeleton, TextSkeleton, ChartSkeleton, BarsSkeleton, ListSkeleton,
// CardsSkeleton — plus the atoms that placeholder themselves from `null` data
// (KpiCard, StackedArea, LineChart, HBars). Hand-written loading text drifts
// away from the layout it is supposed to stand in for, which is exactly what
// this check prevents.
//
// Runs as part of `npm run build` (and therefore in the Docker build / CI).
// Escape hatch for a deliberate text-only case: put `skeleton-exempt` in a
// comment on the same line.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
// ui.tsx owns the primitives (incl. their screen-reader "Loading…" labels)
const ALLOWED_FILES = new Set(['ui.tsx']);
const PATTERN = /loading\s*(?:…|\.\.\.)/i;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const offenders = [];
for (const file of walk(SRC)) {
  if (!/\.(tsx|ts)$/.test(file)) continue;
  const rel = relative(SRC, file);
  if (ALLOWED_FILES.has(rel)) continue;
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!PATTERN.test(line)) return;
    if (/skeleton-exempt/.test(line)) return;
    offenders.push(`  src/${rel}:${i + 1}  ${line.trim()}`);
  });
}

// ── a TableSkeleton must sit INSIDE its TableScroll ──────────────────────────
// A skeleton stands in for the rows, so it has to live where the rows live. Left
// outside the scroller, a 620px grid on a 390px phone pushes the whole PAGE
// sideways for exactly as long as the fetch takes — reported as the page "jumping"
// when you open a tab, and gone before you can look at it. Two shipped that way.
const stray = [];
for (const file of walk(SRC)) {
  if (!/\.tsx$/.test(file)) continue;
  const rel = relative(SRC, file);
  const src = readFileSync(file, 'utf8');
  // The boundary matters: without it `<TableSkeletonDemo` — a wrapper component in
  // the Component Lab — reads as a bare TableSkeleton and the guard fires on a file
  // that is doing exactly the right thing. A check that cries wolf gets switched off.
  for (const m of src.matchAll(/<TableSkeleton(?![A-Za-z0-9_])/g)) {
    const before = src.slice(0, m.index);
    // TableScroll is the component; `.tbl-scroll` is the same scroller hand-rolled
    // where a table also needs its own vertical window (LogsPage). Both count.
    const open = (before.match(/<TableScroll|className="tbl-scroll"/g) || []).length;
    const close = (before.match(/<\/TableScroll>/g) || []).length;
    if (open > close) continue;                       // inside a scroller — fine
    const line = before.split('\n').length;
    // the reason belongs in a comment, which is above the JSX, not on it
    const lines = src.split('\n');
    if (lines.slice(Math.max(0, line - 6), line).some((l) => /skeleton-exempt/.test(l))) continue;
    stray.push(`  src/${rel}:${line}`);
  }
}
if (stray.length) {
  console.error(
    '\n<TableSkeleton> outside its <TableScroll> — the skeleton must sit where the\n'
    + 'rows sit, or a wide grid pushes the page sideways while the data loads:\n\n'
    + stray.join('\n')
    + '\n\n  put the head, the skeleton and the rows inside ONE <TableScroll>.'
    + '\n  A grid that genuinely fits a phone can opt out with a `skeleton-exempt` comment.\n',
  );
  process.exit(1);
}

if (offenders.length) {
  console.error(
    '\nAd-hoc loading placeholder(s) found — use the skeleton components from src/ui.tsx\n'
    + 'instead (they derive their shape from the layout they replace):\n\n'
    + offenders.join('\n')
    + '\n\n  tables → <TableSkeleton cols={THE_SAME_GRID_CONST} />'
    + '\n  charts/KPIs → pass null data (KpiCard, StackedArea, LineChart, HBars placeholder themselves)'
    + '\n  anything else → Skeleton / TextSkeleton / ListSkeleton / CardsSkeleton / ChartSkeleton'
    + '\n  deliberate text-only case → add a `skeleton-exempt` comment on that line\n',
  );
  process.exit(1);
}

console.log(`loading-state check: ok (${offenders.length} findings)`);
