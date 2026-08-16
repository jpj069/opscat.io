#!/usr/bin/env node
// Guard: no hand-rolled graphics, and no SVG that scales itself.
//
// Two rules, both born from the same bug — the Pipeline throughput chart was
// drawn as `<svg viewBox="0 0 460 140" width="100%">`, which does not FIT the
// drawing to its box, it MAGNIFIES it. In an 1800px card that is a ~4x blow-up:
// a 1.5px stroke lands at 6px, a 2px dot at 8px, an 8px axis label at 31px, and
// with no `height` the card grows to 548px tall.
//
// Nothing caught it: the build was green, the API was fine, and probe-mobile.mjs
// measures a 390px phone — where the same viewBox scales DOWN and nothing
// overflows. The failure only exists on a wide screen, so a static rule is the
// honest guard here. Unlike sizing rules ("is this control too wide?"), which
// only the browser can answer, `viewBox` + `width="100%"` is unconditionally a
// magnifier — there is no layout in which it means anything else.
//
// Runs as part of `npm run build` (therefore in the Docker build and the deploy).
// Escape hatch: `chart-exempt` in a comment on the same line.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
// The two files allowed to contain an <svg> at all: ui.tsx owns the chart atoms
// (Spark, LineChart, StackedArea, Avatar), icons.tsx owns the brand marks that
// lucide-react does not ship. Everything else consumes them.
const DRAWERS = new Set(['ui.tsx', 'icons.tsx']);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const handRolled = [];
const scaled = [];

for (const file of walk(SRC)) {
  if (!/\.tsx$/.test(file)) continue;
  const rel = relative(SRC, file);
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  if (!DRAWERS.has(rel)) {
    lines.forEach((line, i) => {
      if (!/<svg[\s>]/.test(line) || /chart-exempt/.test(line)) return;
      handRolled.push(`  src/${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
    continue;
  }

  // Inside the drawers, catch the magnifier itself. An <svg> tag may span lines,
  // so match the whole opening tag rather than a single line.
  for (const m of src.matchAll(/<svg\b[^>]*>/g)) {
    const tag = m[0];
    if (!/viewBox/.test(tag)) continue;
    const scales = /width\s*=\s*["{]\s*['"]?100%/.test(tag)
      || /preserveAspectRatio\s*=\s*["{]\s*['"]?none/.test(tag);
    if (!scales) continue;                       // a viewBox with a fixed w/h is fine
    const line = src.slice(0, m.index).split('\n').length;
    if (/chart-exempt/.test(lines[line - 1] || '')) continue;
    scaled.push(`  src/${rel}:${line}  ${tag.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
}

if (handRolled.length) {
  console.error(
    '\nHand-rolled <svg> outside the design system:\n\n'
    + handRolled.join('\n')
    + '\n\n  Charts and sparklines come from src/ui.tsx (Spark, LineChart, StackedArea,'
    + '\n  KpiCard); icons come from lucide-react or src/icons.tsx. A one-off SVG in a'
    + '\n  page is how a second, unmeasured chart implementation starts.'
    + '\n  Genuinely one-off decoration → add a `chart-exempt` comment on that line.\n',
  );
}

if (scaled.length) {
  console.error(
    '\nSelf-scaling <svg> (viewBox + width="100%" / preserveAspectRatio="none"):\n\n'
    + scaled.join('\n')
    + '\n\n  That does not fit the drawing to its box, it magnifies it — every stroke,'
    + '\n  dot and label scales with the card, and the height follows the aspect ratio'
    + '\n  (a 460x140 chart in an 1800px card came out 548px tall with 31px labels).'
    + '\n  Measure the box instead: useBoxWidth() + width={width} height={h}, plus'
    + '\n  max-width:100% so the SVG can never widen the box it is measuring.'
    + '\n  See docs/ARCHITECTURE.md § Frontend charts.\n',
  );
}

if (handRolled.length || scaled.length) process.exit(1);
console.log('chart check: ok (0 findings)');
