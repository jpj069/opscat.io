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

for (const f of files) {
  if (f.endsWith('ui.tsx')) continue;                  // COL itself lives there
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(DECL)) {
    const [, name, , value] = m;
    if (value.includes('fr')) continue;                // has a flexible track — fine
    if (/max-content|auto/.test(value)) continue;      // intrinsically sized, also fine
    if (src.includes(`grid-exempt ${name}`)) continue; // opt out, with a stated reason
    const line = src.slice(0, m.index).split('\n').length;
    findings.push(`${f.replace(SRC, 'src/')}:${line}  ${name} has no flexible track — `
      + `"${value}"\n      compose from COL (ui.tsx), or add a "grid-exempt ${name}: <why>" comment`);
  }
}

if (findings.length) {
  console.error(`table-grid check: ${findings.length} finding(s)\n`);
  for (const x of findings) console.error(`  ✗ ${x}`);
  process.exit(1);
}
console.log('table-grid check: ok (every table grid can use the width it is given)');
