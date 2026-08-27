'use strict';
/* CI guard for the cloud provisioning permissions.  node scripts/check-cloud-policy.js
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `providers/aws.js` and `providers/gcp.js` call cloud APIs. Every one of those
 * calls needs a permission the CUSTOMER grants, out of a policy that lives in
 * documentation. Nothing connects the two, so adding an API call is a change
 * whose blast radius is a document nobody re-reads — and the failure lands in
 * production, on someone else's account, as a 403 mid-provision.
 *
 * That is not a hypothetical. It happened TWICE in one week, both times from a
 * green CI run:
 *
 *   aws HTTP 403: … not authorized to perform: ec2:CreateSecurityGroup
 *   gcp HTTP 403: Required 'compute.firewalls.create' permission for
 *                 'projects/opscat-sensors/global/firewalls/opscat-sensor-ssh'
 *
 * Both were break-glass SSH (docs/SENSOR-AGENTS.md §11) adding calls that the
 * documented policies predated. The rollback worked, the audit trail was clean,
 * the harnesses were green — because `e2e-sensors` stubs `providers.provider()`
 * on the module object and therefore asserts only that ensureSshAccess is CALLED
 * with the right arguments in the right order. What it does inside is exactly
 * the part that needs a grant.
 *
 * The lesson is the one `schema.sql` + a migration already taught: a feature and
 * the thing that permits it belong in the same commit, and something has to fail
 * when they drift. This is that something. It needs no cloud account, no
 * credentials and no network — it reads two source files and one document.
 *
 * ── What it compares ─────────────────────────────────────────────────────────
 *
 *   code  ← the API calls the adapters actually make, derived mechanically
 *   docs  ← the policy blocks in docs/SENSOR-AGENTS.md, marked with an
 *           HTML anchor so a reformat cannot silently detach them
 *
 * Both directions fail the build, and the second one is not tidiness:
 *
 *   needed but not granted → the 403 above, in production
 *   granted but not needed → a permission the product cannot justify, in a
 *                            policy whose entire selling point is "minimal".
 *                            An unexplained grant is how "minimal" rots into
 *                            "whatever accumulated".
 *
 * A grant that IS justified without a matching call gets an entry in
 * GRANTED_UNUSED with the reason, printed on every run — same discipline as
 * pg-sweep's DEFERRED list: listed, never filtered, because a silent skip is
 * worse than a red check.
 */

const fs = require('fs');
const path = require('path');
const { stripComments } = require('./lib/strip-comments');

const SRC = path.join(__dirname, '..', 'src', 'providers');
const DOC = path.join(__dirname, '..', '..', 'docs', 'SENSOR-AGENTS.md');

/* Permissions the documented policy grants on purpose without a call site.
 *
 * Every entry is a claim that the grant is REQUIRED, not merely harmless — a
 * read-only action nothing calls does not belong here, it belongs deleted. */
const GRANTED_UNUSED = {
  'ec2:CreateTags': 'RunInstances carries TagSpecification; EC2 checks CreateTags for it, '
    + 'and it is not a separate Action literal. Without it the launch fails, not the tagging.',
  'compute.networks.updatePolicy': 'GCP checks this on the NETWORK for any firewall write. '
    + 'It is not an API call of its own, so nothing in gcp.js can derive it.',
};

// ─── the code side ───────────────────────────────────────────────────────────

/* AWS is the easy one: the EC2 Query API names its operation in the request
 * body, so `Action: 'RunInstances'` IS `ec2:RunInstances`, one for one. */
function awsActions(src) {
  const out = new Set();
  const re = /\bAction:\s*'([A-Za-z]+)'/g;
  let m;
  while ((m = re.exec(src))) out.add(`ec2:${m[1]}`);
  return out;
}

/* GCP names nothing: the permission follows from the HTTP method and the shape
 * of the URL, so it has to be DERIVED. Deriving it (rather than listing the six
 * calls we have today) is the whole point — a seventh call gets a permission
 * demanded of the docs without anyone remembering this file exists.
 *
 * The derivation is Google's own URL grammar, which every Compute path obeys:
 *
 *   /projects/<p>/<scope>/<collection>[/<item>]
 *
 * with <scope> being `global`, `aggregated`, `zones/<z>` or `regions/<r>`. Peel
 * the scope off by its known arity and what is left says everything: one
 * segment is a collection, two is an item. Then
 *
 *   GET    on a collection → list      GET       on an item → get
 *   POST   on a collection → create    DELETE    on an item → delete
 *                                      PATCH/PUT on an item → update
 *
 * The first version of this guessed "item = the last segment is an
 * interpolation", which is the same answer for the six calls we have and wrong
 * in general: `${SSH_RULE}` resolves to a LITERAL, so the firewall GET read as
 * a collection and produced `compute.opscat-sensor-ssh.list`. Deriving from the
 * grammar instead makes the result independent of whether a name happened to be
 * written as a resolvable constant. */
const SCOPE_ARITY = { global: 1, aggregated: 1, zones: 2, regions: 2 };
const VERB = {
  'GET:collection': 'list', 'GET:item': 'get',
  'POST:collection': 'create', 'DELETE:item': 'delete',
  'PATCH:item': 'update', 'PUT:item': 'update',
};

/* Single-line `const NAME = <string|template|arrow returning one>`, so a call
 * written as `httpJson(url, …)` can be resolved back to its URL. Two of the six
 * are written that way, and a resolver that quietly skipped them would under-
 * report — which is the permissive direction, i.e. the dangerous one. */
function constMap(src) {
  const map = new Map();
  const re = /^\s*const\s+(\w+)\s*=\s*(?:\([^)]*\)\s*=>\s*)?([`'"])([\s\S]*?)\2\s*;?\s*$/gm;
  let m;
  while ((m = re.exec(src))) map.set(m[1], m[3]);
  return map;
}

/* Substitute known consts into `${…}` until nothing known is left, then blank
 * every remaining interpolation to `*`. Bounded so a self-referential const
 * cannot spin. */
function resolveUrl(raw, consts) {
  let s = raw;
  for (let pass = 0; pass < 5; pass++) {
    const before = s;
    s = s.replace(/\$\{\s*(\w+)\s*(?:\([^)]*\))?\s*\}/g, (whole, name) =>
      (consts.has(name) ? consts.get(name) : whole));
    if (s === before) break;
  }
  return s.replace(/\$\{[^}]*\}/g, '*');
}

/* Text of the call's argument list, paren-balanced and quote-aware. A regex
 * stopping at the first `)` would cut `JSON.stringify(rule)` in half and read
 * the NEXT call's method — silently attributing PATCH to a POST. */
function argsOf(src, openParenIdx) {
  let depth = 0, quote = null;
  for (let i = openParenIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openParenIdx + 1, i); }
  }
  return src.slice(openParenIdx + 1);
}

function gcpPermissions(src) {
  const consts = constMap(src);
  const out = new Set();
  const unknown = [];
  const re = /\bhttpJson\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const args = argsOf(src, m.index + m[0].length - 1);
    // first argument, up to the comma that is not inside a string/template
    const firstArg = argsOf(`(${args})`, 0).split(/,(?![^`'"]*[`'"]\s*\))/)[0].trim();
    const litOrIdent = /^[`'"]([\s\S]*)[`'"]$/.exec(firstArg);
    const raw = litOrIdent ? litOrIdent[1]
      : (consts.has(firstArg) ? consts.get(firstArg) : firstArg);
    const url = resolveUrl(raw, consts);
    if (!url.includes('compute.googleapis.com')) continue; // the OAuth token endpoint

    const method = (/\bmethod:\s*'([A-Z]+)'/.exec(args) || [, 'GET'])[1];
    const after = url.split('/compute/v1/projects/')[1];
    if (!after) continue;
    const segs = after.split('?')[0].split('/').filter(Boolean).slice(1); // drop the project
    const rest = segs.slice(SCOPE_ARITY[segs[0]] || 0);
    const verb = VERB[`${method}:${rest.length === 1 ? 'collection' : 'item'}`];
    if (!SCOPE_ARITY[segs[0]] || rest.length < 1 || rest.length > 2 || !verb) {
      unknown.push(`${method} ${url}`); continue;
    }
    out.add(`compute.${rest[0]}.${verb}`);
  }
  return { perms: out, unknown };
}

// ─── the document side ───────────────────────────────────────────────────────

/* A fenced JSON block introduced by `<!-- policy:aws -->`. The anchor is what
 * makes this robust: "the first json block after the heading" breaks the day
 * someone adds an example above it, and breaks SILENTLY — into whichever block
 * happened to be first. */
function policyBlock(md, name) {
  const anchor = `<!-- policy:${name} -->`;
  const at = md.indexOf(anchor);
  if (at === -1) throw new Error(`docs/SENSOR-AGENTS.md: no ${anchor} anchor`);
  const open = md.indexOf('```json', at);
  const close = md.indexOf('```', open + 7);
  if (open === -1 || close === -1) throw new Error(`docs/SENSOR-AGENTS.md: no json block after ${anchor}`);
  const body = md.slice(open + 7, close);
  try { return JSON.parse(body); }
  catch (e) { throw new Error(`docs/SENSOR-AGENTS.md: ${anchor} block is not valid JSON — ${e.message}`); }
}

const grantedAws = (policy) => new Set(
  (policy.Statement || []).flatMap((s) => [].concat(s.Action || [])));
const grantedGcp = (role) => new Set(role.includedPermissions || []);

// ─── the diff ────────────────────────────────────────────────────────────────

const problems = [];
const report = [];

function compare(label, needed, granted, doc) {
  const missing = [...needed].filter((p) => !granted.has(p)).sort();
  const extra = [...granted].filter((p) => !needed.has(p) && !GRANTED_UNUSED[p]).sort();
  const justified = [...granted].filter((p) => GRANTED_UNUSED[p]).sort();

  report.push(`${label}: ${needed.size} call${needed.size === 1 ? '' : 's'} in the adapter, `
    + `${granted.size} permission${granted.size === 1 ? '' : 's'} in ${doc}`);
  for (const p of justified) report.push(`     granted, no call site: ${p}\n       ↳ ${GRANTED_UNUSED[p]}`);

  if (missing.length) {
    problems.push(`${label} — the adapter calls these and ${doc} does NOT grant them:\n`
      + missing.map((p) => `    ${p}`).join('\n')
      + '\n  This is a 403 mid-provision on every customer account that follows the docs.');
  }
  if (extra.length) {
    problems.push(`${label} — ${doc} grants these and no adapter call needs them:\n`
      + extra.map((p) => `    ${p}`).join('\n')
      + '\n  Remove them, or add an entry to GRANTED_UNUSED in this file saying why the\n'
      + '  grant is required without a call site.');
  }
}

let awsSrc, gcpSrc, md;
try {
  awsSrc = stripComments(fs.readFileSync(path.join(SRC, 'aws.js'), 'utf8'));
  gcpSrc = stripComments(fs.readFileSync(path.join(SRC, 'gcp.js'), 'utf8'));
  md = fs.readFileSync(DOC, 'utf8');
} catch (e) {
  console.error(`check:cloud FAILED — ${e.message}`);
  process.exit(1);
}

const aws = awsActions(awsSrc);
const gcp = gcpPermissions(gcpSrc);

/* `--list` prints what the adapters need and stops, WITHOUT touching the docs.
 * It is what you run while writing a new provider call — the answer to "what do
 * I have to grant now?" comes from the code, before there is a policy to diff. */
if (process.argv.includes('--list')) {
  for (const p of [...aws, ...gcp.perms].sort()) console.log(p);
  for (const u of gcp.unknown) console.log(`?? no mapping: ${u}`);
  process.exit(0);
}

try {
  compare('aws', aws, grantedAws(policyBlock(md, 'aws')), 'docs/SENSOR-AGENTS.md §4 (policy:aws)');
  compare('gcp', gcp.perms, grantedGcp(policyBlock(md, 'gcp')), 'docs/SENSOR-AGENTS.md §4 (policy:gcp)');
} catch (e) {
  console.error(`check:cloud FAILED — ${e.message}`);
  process.exit(1);
}

/* An adapter call whose permission cannot be derived is a hole in the check, and
 * a check with a hole it does not mention is worse than no check: it reports a
 * pass over a call nobody verified. Fail, and say which call. */
if (gcp.unknown.length) {
  problems.push('gcp — these calls have no permission mapping, so nothing verified them:\n'
    + gcp.unknown.map((u) => `    ${u}`).join('\n')
    + '\n  Teach VERB in this file what that method/shape means, and grant it in the docs.');
}

/* An adapter that produced NO calls is the failure this check is least likely
 * to survive on its own: a refactor renaming `Action:` or `httpJson(` leaves
 * both sides empty and every comparison trivially passes. */
if (!aws.size || !gcp.perms.size) {
  problems.push(`derivation produced nothing (aws ${aws.size}, gcp ${gcp.perms.size}) — the parser `
    + 'stopped matching the adapters. Fix the parser; do not lower the expectation.');
}

console.log('check:cloud — provisioning permissions, adapter vs documented policy');
for (const line of report) console.log(`  ${line}`);
if (problems.length) {
  console.error(`\ncheck:cloud FAILED\n\n${problems.join('\n\n')}\n\n`
    + 'A cloud API call and the permission that allows it belong in the same commit —\n'
    + 'see docs/SENSOR-AGENTS.md §4. Nothing else in the build can see this: the sensor\n'
    + 'harness stubs the provider, so a missing grant surfaces as a 403 in production.');
  process.exit(1);
}
console.log('check:cloud — OK, both adapters are covered by the documented policies');
process.exit(0);
