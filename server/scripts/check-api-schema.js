'use strict';
/* CI guard for the API contract.  node scripts/check-api-schema.js
 *
 * The point is not to convert 278 routes today — it is that the number of
 * routes bypassing the schema layer can only ever go DOWN. A migration without
 * this ratchet stalls at whatever percentage the first pass reached, because
 * nothing notices when the next PR adds one more raw route.
 *
 *   schema-first : registered via createRouteRegistrar  (`method: 'post'`)
 *   raw          : `router.post(...)` — no validation, absent from /openapi.json
 *
 * Fails when raw exceeds the committed baseline; lowers the baseline when you
 * convert. Same shape as the type gate: a number that only moves one way.
 */

const fs = require('fs');
const path = require('path');
// One stripper, shared with check-cloud-policy.js — the reasoning that shaped
// it (line comments before block comments, `https://` left intact) lives there.
const { stripComments } = require('./lib/strip-comments');

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');
const BASELINE = path.join(__dirname, '..', '.api-schema-baseline.json');

const RAW_RE = /\b\w*[Rr]outer\.(get|post|put|patch|delete)\s*\(/g;
const SCHEMA_RE = /\bmethod:\s*['"](get|post|put|patch|delete)['"]/g;


let files;
try {
  files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(ROUTES_DIR, f));
} catch {
  console.log('check:api — no src/routes dir, nothing to check');
  process.exit(0);
}

let raw = 0, schemaFirst = 0;
const perFile = [];
for (const file of files) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const r = (src.match(RAW_RE) || []).length;
  const s = (src.match(SCHEMA_RE) || []).length;
  raw += r; schemaFirst += s;
  if (r || s) perFile.push({ file: path.basename(file), raw: r, schemaFirst: s });
}

const total = raw + schemaFirst;
const pct = total === 0 ? 100 : Math.round((schemaFirst / total) * 100);

let baseline = null;
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).rawRoutes; } catch { /* first run */ }

console.log(`check:api — ${schemaFirst}/${total} routes schema-first (${pct}%), ${raw} still raw`);
for (const f of perFile.filter((f) => f.raw > 0).sort((a, b) => b.raw - a.raw)) {
  console.log(`  ${String(f.raw).padStart(3)} raw  src/routes/${f.file}`);
}

if (baseline === null) {
  fs.writeFileSync(BASELINE, JSON.stringify({ rawRoutes: raw }, null, 2) + '\n');
  console.log(`\ncheck:api — baseline seeded at ${raw}. Commit .api-schema-baseline.json.`);
  process.exit(0);
}
if (raw > baseline) {
  console.error(`\ncheck:api FAILED — raw routes went UP: ${baseline} → ${raw}.\n`
    + 'New routes must be registered with createRouteRegistrar (src/lib/route-schema.js)\n'
    + 'so they are validated at runtime and appear in /openapi.json.\n'
    + 'See docs/API-CONTRACT.md.');
  process.exit(1);
}
if (raw < baseline) {
  fs.writeFileSync(BASELINE, JSON.stringify({ rawRoutes: raw }, null, 2) + '\n');
  console.log(`\ncheck:api — baseline lowered ${baseline} → ${raw}. Commit .api-schema-baseline.json.`);
}
process.exit(0);
