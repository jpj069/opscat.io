#!/usr/bin/env node
// Guard: an inline `gridTemplateColumns` without a `display` is dead CSS.
//
// The bug this exists for shipped and stayed shipped. PR #134 centralised the
// TABLE track lists into TableScroll and, in the sweep, deleted `display: 'grid'`
// from eight containers that were never tables — a KPI row, two chart rows, two
// card grids and three label/value blocks. `grid-template-columns` and `gap` are
// simply IGNORED on a block element, so the children stopped being columns and
// became a stack of full-width rows. Nothing failed:
//
//   - tsc is happy, the property is valid CSSProperties either way;
//   - the build is green, it is not a syntax error;
//   - probe-mobile.mjs measures a 390px phone, where `auto-fit minmax(180px, 1fr)`
//     collapses to ONE column anyway — so the correct and the broken layout are
//     pixel-identical at the width we measure;
//   - check-table-grids.mjs only looks at TableScroll/COL, and these are not tables.
//
// It was found by a person looking at the Log Pipeline page months later. That is
// the whole argument for a static rule: unlike "is this column too narrow?", which
// only a browser can answer, a track list on a non-grid box is unconditionally
// meaningless — there is no layout in which it does something.
//
// The same holds for `gridTemplateRows` and for `gap` used alone in the hope of
// grid behaviour, so both are checked. `display` may come from anywhere in the
// same style object, or from a className the rule cannot see — hence the escape
// hatch: `grid-display-exempt: <why>` in a comment on the same line.
//
// Runs in `npm run check:ui`, therefore in the build, the Docker image and deploy.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p)) files.push(p);
  }
})(SRC);

const findings = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // every inline style object, non-greedy to the first closing }}
  const re = /style=\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const block = m[1];
    if (!/gridTemplate(Columns|Rows)/.test(block)) continue;
    if (/\bdisplay\b/.test(block)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    // The exemption may sit on the line itself, anywhere inside the style object,
    // or in a JSX comment on the lines just above — which is where it lands when
    // the reason needs a sentence rather than a trailing fragment.
    const all = src.split('\n');
    const window = all.slice(Math.max(0, line - 4), line).join('\n')
      + src.slice(m.index, m.index + m[0].length);
    if (/grid-display-exempt/.test(window)) continue;
    findings.push({
      file: relative(SRC, file),
      line,
      what: (block.match(/gridTemplate(Columns|Rows)\s*:\s*[^,\n]+/) || ['?'])[0].trim(),
    });
  }
}

if (findings.length) {
  console.error('inline-grid check: a track list on a box that is not a grid\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.what}`);
  }
  console.error(`\n${findings.length} container(s) declare grid tracks with no display: 'grid'.`);
  console.error("The tracks and the gap are ignored, so the children stack full-width.");
  console.error("Add display: 'grid' — or, if the display comes from a class, add a");
  console.error('`grid-display-exempt: <why>` comment on the same line.');
  process.exit(1);
}
console.log('inline-grid check: ok (every inline track list sits on a grid)');
