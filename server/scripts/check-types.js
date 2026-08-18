'use strict';
/* The type gate, filtered to the thing it exists to catch.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 *
 * `tsc --checkJs` over plain JavaScript reports two very different kinds of
 * thing, and only one of them is a bug:
 *
 *   1. A MISSED AWAIT.  `Property 'map' does not exist on type 'Promise<Row[]>'`.
 *      This is the entire reason the shim has a .d.ts. Phase 4 converts ~700
 *      call sites, and a missed await does not throw — it yields a Promise, and
 *      a Promise is truthy, so `rows.filter(r => r.org_id === x)` keeps every
 *      row and answers 200 with another tenant's data.
 *
 *   2. INFERENCE NOISE.  `listed: []` is inferred as `never[]`, so pushing into
 *      it is an error; an object literal built in two steps is missing the
 *      properties added later. None of it is wrong at runtime, none of it is
 *      new, and none of it has anything to do with this port.
 *
 * Every unconverted file carries `@ts-nocheck` for exactly that reason, and the
 * pragma is the conversion checklist. But taking it OFF a converted file
 * currently means importing its share of class 2 — reputation.js alone produced
 * twelve — and a gate that reports twelve harmless errors beside one real one is
 * a gate people learn to skim. The signal has to survive contact with the noise.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * FATAL: the Promise is being USED AS A VALUE — a property read off one, or an
 * iteration of one, or the shim's own row types appearing anywhere. See the
 * comment on `isAwaitBug` below for why that is narrower than "mentions a
 * Promise", and what over-reaching cost. Verified by mutation: removing an
 * `await` in a converted file turns this script red (see the Phase 4 section of
 * docs/POSTGRES-MIGRATION-PLAN.md).
 *
 * It cannot catch TRUTHINESS, and that is where the leak is: `if (!isMember(u, o))`
 * with a missing await is `if (!Promise)` — always false, guard never fires.
 * Measured, in routes/oncall.js: a participant from another org was accepted
 * with a 200 while this gate stayed green. Only a harness catches that.
 *
 * ADVISORY: everything else, printed with a count and a per-file tally so it is
 * visible rather than suppressed. It is pre-existing JS looseness in files that
 * were never typed; fixing it is a real piece of work with its own value, and
 * it is not this port's.
 *
 * Deliberately NOT a baseline file of accepted errors. A baseline needs
 * regenerating, and the regeneration is where a real error gets accepted by
 * accident — the mechanism that lets it in is the same one meant to keep it out.
 *
 *   npm run check:server
 */
const { spawnSync } = require('child_process');
const path = require('path');

const tsc = spawnSync(process.execPath,
  [path.join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', path.join(__dirname, '..', 'tsconfig.json')],
  { encoding: 'utf8' });

const out = `${tsc.stdout || ''}${tsc.stderr || ''}`;
const lines = out.split('\n').filter((l) => /error TS\d+:/.test(l));

// A tsc error can span several lines; only the first carries `file(l,c):`, and
// the continuation lines are indented. Keep continuations with their header so
// a Promise mentioned in the detail is not missed.
const errors = [];
for (const raw of out.split('\n')) {
  if (/^\S.*error TS\d+:/.test(raw)) errors.push(raw);
  else if (errors.length && /^\s+\S/.test(raw)) errors[errors.length - 1] += `\n${raw}`;
}

/* What a missed await actually looks like, as opposed to what merely mentions a
 * Promise. Every real one observed in this phase is the Promise being USED as a
 * value — read a property off it, iterate it, destructure it:
 *
 *   Property 'map' does not exist on type 'Promise<Row[]>'
 *   Property 'opened' does not exist on type 'Promise<{ opened: any[]; … }>'   (transitive)
 *   Type 'Promise<Row[]>' must have a '[Symbol.iterator]()' method             (for..of)
 *   Property 'changes' does not exist on type 'Promise<RunResult>'
 *
 * The rule was "any error mentioning a Promise", which is not the same set. It
 * false-positived on `mcp/server.js`: a tool handler became async in Phase 4, and
 * the SDK's `registerTool` wants a union discriminated on a string LITERAL that
 * JS widens — so the whole handler signature fails to assign, the message quotes
 * the `Promise<…>` return type, and it reads exactly like a missed await while
 * being a library type mismatch with nothing wrong at runtime.
 *
 * A gate that cries wolf once gets skimmed thereafter, which costs more than the
 * case it was over-reaching to cover. So: the Promise must be the SUBJECT — a
 * property read off one, or an iteration of one — or the shim's own row types
 * must appear anywhere in the message, which no library signature produces.
 */
// `Promise<` and not merely `Promise`: `Promise.allSettled` yields
// `PromiseFulfilledResult<T>`, and reading `.reason` off one is a narrowing
// complaint about a perfectly ordinary idiom — it begins with the same seven
// letters and is not a missed await. Caught by including the harnesses, which
// is the sort of thing including them was for.
/* And every TS1xxx, unconditionally.
 *
 * TypeScript numbers SYNTACTIC errors in the 1000s and semantic ones in the
 * 2000s. A TS1xxx file cannot run at all — `require` throws — which makes it
 * strictly worse than anything in the missed-await class, and it has no business
 * being advisory.
 *
 * It was. TS1308, "'await' expressions are only allowed within async functions",
 * is exactly what you get half-way through converting a handler, and its text
 * mentions no Promise — so this gate printed "no missed awaits" and exited 0
 * over a file that would have crashed the server on boot. Found by an agent
 * reading raw tsc output rather than trusting the gate, which is the only way
 * anyone finds a gate's blind spot.
 */
const isHardError = (e) => /error TS1\d{3}:/.test(e);

const isAwaitBug = (e) => isHardError(e)
  || /does not exist on type '[^']*Promise</.test(e)
  || (/Promise</.test(e) && /Symbol\.iterator/.test(e))
  || /Promise<Row|Promise<RunResult/.test(e);
const fatal = errors.filter(isAwaitBug);
const advisory = errors.filter((e) => !isAwaitBug(e));

if (advisory.length) {
  const byFile = new Map();
  for (const e of advisory) {
    const m = /^(.*?)\(\d+,\d+\)/.exec(e);
    const f = m ? m[1] : '(unknown)';
    byFile.set(f, (byFile.get(f) || 0) + 1);
  }
  console.log(`${advisory.length} pre-existing type complaint(s), none about a Promise — not gated:`);
  for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${f}`);
  console.log('');
}

if (fatal.length) {
  const hard = fatal.filter(isHardError).length;
  console.error(`${fatal.length} FATAL type error(s)`
    + (hard ? ` — ${hard} of them syntactic (TS1xxx: the file cannot run at all)` : '')
    + ':\n');
  for (const e of fatal) console.error(e);
  console.error(hard
    ? '\nA TS1xxx file throws on require. Everything else here is a missed await: '
      + 'a Promise is truthy, so unfixed it is a silent wrong answer rather than a crash.'
    : '\nA Promise is truthy. Unfixed, each of these is a silent wrong answer, not a crash.');
  process.exit(1);
}

// tsc can fail for reasons that are not diagnostics at all (a bad tsconfig, a
// missing dependency). Those exit non-zero with no `error TS` line to classify,
// and silently passing them would retire the gate without anyone noticing.
if (tsc.status !== 0 && !lines.length) {
  console.error(`tsc failed without diagnostics (exit ${tsc.status}):\n${out}`);
  process.exit(1);
}

console.log(`type gate: no missed awaits across server/src (${errors.length} total diagnostics, `
  + `${advisory.length} advisory)`);
