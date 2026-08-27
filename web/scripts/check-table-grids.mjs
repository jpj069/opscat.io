#!/usr/bin/env node
/**
 * A table grid must be able to use the width it is given.
 *
 * Every table in the app is a CSS grid whose track list lives in one constant per
 * table (~30 of them). The recurring bug is not a wrong number, it is a track list
 * made almost entirely of FIXED tracks: the grid then cannot grow, one flexible
 * column absorbs every pixel of slack, and the column with the longest content
 * truncates while there is free space on screen. The managed sensor fleet shipped as
 * `minmax(120px,1fr) 110px 150px 92px 64px 70px 90px` — six fixed of seven.
 *
 * So: at least one flexible track (`fr`) per grid. Compose from `COL` in ui.tsx
 * rather than picking pixels — the entry names say what belongs in the column.
 *
 * SECOND rule, and the more subtle one: a track list shared between a header and
 * its rows may contain NO intrinsic track (`max-content`, `min-content`, `auto`,
 * `fit-content`). `.tbl-head` and `.tbl-row` are separate CSS grids — each has its
 * own `display: grid` in tokens.css — so an intrinsic track resolves against each
 * element's OWN contents. `COL.actions` was `max-content`, which on Platform ›
 * Organizations at 1990px meant 55px in the header ("ACTIONS") and 272px in the row
 * (a Select and three buttons). The 217px difference lands in the flexible track, so
 * every column label stood 217px right of its own data — while the shared constant
 * was, character for character, identical. Sharing the string is not sharing the
 * geometry; only a content-independent track gives you that.
 *
 * THIRD rule, cheapest and the one that shipped a visible defect: an inline
 * `gridTemplateColumns` on an element that is not a grid. The property is dead
 * CSS — the children lay themselves out inline — and nothing about the JSX looks
 * wrong, which is why it survived review twice on Platform › Managed Fleet (the
 * details block rendered "RegionNorth America") and in three more places where
 * KPI cards silently stopped being a responsive grid. Either the style object
 * carries `display: 'grid'`, or the element's className does (`tbl-row`,
 * `detail-list`, …) — otherwise the track list is doing nothing.
 *
 * Runs in `npm run check:ui`, therefore in the build, therefore in the deploy.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) files.push(p);
  }
})(SRC);

// `const X_GRID = '...'` / `const COLS = '...'` — the one-constant-per-table convention
const DECL = /^\s*const\s+([A-Z][A-Z0-9_]*(?:GRID|COLS))\s*=\s*(['"`])([^'"`]*)\2/gm;
const findings = [];

const INTRINSIC = /\b(max-content|min-content|fit-content)\b|(^|\s)auto(\s|$)/;

// Rule 2 first, and on COL itself: every grid in the app composes from it, so one
// intrinsic entry there misaligns every table that uses it. This is the check that
// would have caught `actions: 'max-content'` the day it was written.
{
  const ui = readFileSync(join(SRC, 'ui.tsx'), 'utf8');
  const block = ui.match(/export const COL = \{([\s\S]*?)\n\} as const;/);
  if (!block) {
    findings.push('src/ui.tsx  could not find `export const COL = { … } as const;` — '
      + 'the track vocabulary moved, and this check is now inspecting nothing');
  } else {
    for (const m of block[1].matchAll(/^\s*(\w+):\s*'([^']*)'/gm)) {
      const [, key, value] = m;
      if (!INTRINSIC.test(value)) continue;
      findings.push(`src/ui.tsx  COL.${key} = "${value}" is an INTRINSIC track — `
        + `it resolves against each element's own contents, so .tbl-head and .tbl-row\n`
        + `      (separate grids) disagree and the header drifts off its data. Use a px width.`);
    }
  }
}

for (const f of files) {
  if (f.endsWith('ui.tsx')) continue;                  // COL itself is checked above
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(DECL)) {
    const [, name, , value] = m;
    const line = src.slice(0, m.index).split('\n').length;
    const exempt = src.includes(`grid-exempt ${name}`); // opt out, with a stated reason
    if (INTRINSIC.test(value) && !exempt) {
      findings.push(`${f.replace(SRC, 'src/')}:${line}  ${name} has an INTRINSIC track — `
        + `"${value}"\n      head and rows are separate grids, so it resolves differently in each. `
        + `Use a px width (see COL.actions).`);
      continue;
    }
    if (value.includes('fr')) continue;                // has a flexible track — fine
    if (INTRINSIC.test(value)) continue;               // exempt, and already reported above
    if (exempt) continue;
    findings.push(`${f.replace(SRC, 'src/')}:${line}  ${name} has no flexible track — `
      + `"${value}"\n      compose from COL (ui.tsx), or add a "grid-exempt ${name}: <why>" comment`);
  }
}

// Rule 3: a track list on something that is not a grid.
const GRID_CLASSES = /\b(tbl-row|tbl-head|detail-list|grid)\b/;   // classes that supply display:grid
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/style=\{\{([\s\S]*?)\}\}/g)) {
    const body = m[1];
    if (!/gridTemplateColumns/.test(body)) continue;
    if (/display:\s*['"]grid['"]/.test(body)) continue;
    // the className on the same element may be what makes it a grid
    const tagStart = src.lastIndexOf('<', m.index);
    const cls = src.slice(tagStart, m.index).match(/className="([^"]*)"/);
    if (cls && GRID_CLASSES.test(cls[1])) continue;
    const line = src.slice(0, m.index).split('\n').length;
    findings.push(`${f.replace(SRC, 'src/')}:${line}  gridTemplateColumns on an element that is `
      + `NOT a grid\n      — add display: 'grid' (or use DetailList/TableScroll). As written the `
      + `property is dead CSS and the children lay out inline.`);
  }
}

if (findings.length) {
  console.error(`table-grid check: ${findings.length} finding(s)\n`);
  for (const x of findings) console.error(`  ✗ ${x}`);
  process.exit(1);
}
console.log('table-grid check: ok (every grid can use its width, and none is content-sized)');
