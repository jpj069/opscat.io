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
