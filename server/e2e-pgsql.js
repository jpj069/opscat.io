'use strict';
/* The placeholder rewriter, fuzzed.
 *
 * ── Why this one gets a fuzz test when nothing else in the repo does ────────
 *
 * `rewritePlaceholders` runs on EVERY statement the app executes after the
 * cutover — all ~773 of them, plus the five that are built at runtime. It is the
 * single piece of code with the widest blast radius in the whole port, and its
 * failure mode is the worst kind:
 *
 *     WHERE org_id = ? AND severity >= ?     →   WHERE org_id = $2 AND severity >= $1
 *
 * That is still valid SQL. It still runs. It still returns rows. They are the
 * wrong rows, for the wrong tenant, with a 200 and no log line. Off-by-one in a
 * renumbering pass is invisible to every functional test that does not happen to
 * use two parameters of different types.
 *
 * A hand-written table of examples cannot cover that: the mistakes live in the
 * interaction between a parameter and the thing next to it — a literal
 * containing a question mark, an escaped quote that flips the scanner's idea of
 * where the literal ends, a comment. So the generator builds statements from
 * pieces and **knows the answer by construction**: it emits the expected output
 * at the same time as the input. There is no second implementation to drift.
 *
 * ── What this file does NOT prove ───────────────────────────────────────────
 *
 * That the rewritten SQL is valid PostgreSQL. That is `scripts/pg-sweep.js`,
 * which PREPAREs the real corpus against a real server in CI — and which now
 * imports THIS rewriter rather than keeping its own copy, so the sweep is also
 * the corpus-level test of this function. Two copies would drift, and the copy
 * that drifts is the one that runs in production.
 *
 * Boots no server and needs no port.  cd server && node e2e-pgsql.js
 */
const crypto = require('crypto');

const { chk, report, die } = require('./e2e-lib').harness();
const { rewritePlaceholders, bindArgs, MixedPlaceholders } = require('./src/db/pg-sql');

const rw = (sql) => rewritePlaceholders(sql).text;

// ── 1. the shapes that have a right answer worth writing down ───────────────
function known() {
  chk('a bare parameter becomes $1',
    rw('SELECT * FROM events WHERE id = ?') === 'SELECT * FROM events WHERE id = $1');

  chk('parameters are numbered left to right, not by type or position in a clause',
    rw('WHERE org_id = ? AND severity >= ? LIMIT ?')
    === 'WHERE org_id = $1 AND severity >= $2 LIMIT $3');

  // The one that motivates the whole file: a question mark inside a literal is
  // DATA. Rewritten, this query stops searching for a question mark and starts
  // binding a parameter nobody passes.
  chk('a ? inside a string literal is left alone',
    rw("WHERE body LIKE '%?%' AND id = ?") === "WHERE body LIKE '%?%' AND id = $1");

  // '' is SQL's escape for a literal quote. This check does NOT defend the
  // explicit branch that handles it — deleting that branch keeps every check
  // here green, because a copy-through scanner reaches the same state via two
  // toggles. Measured, and said in pg-sql.js so nobody "simplifies" it later on
  // the strength of a green suite. What the check does defend is the OUTCOME:
  // a parameter after an escaped quote is numbered from outside the literal.
  chk('an escaped quote does not end the literal',
    rw("SET note = 'it''s ? fine' WHERE id = ?")
    === "SET note = 'it''s ? fine' WHERE id = $1");

  chk('a quoted identifier is a literal too',
    rw('SELECT "col?name" FROM t WHERE id = ?') === 'SELECT "col?name" FROM t WHERE id = $1');

  chk('a ? in a line comment is not a parameter',
    rw('SELECT 1 -- why? because\nWHERE id = ?') === 'SELECT 1 -- why? because\nWHERE id = $1');

  chk('…including one that runs to the end of the statement',
    rw('WHERE id = ? -- trailing? yes') === 'WHERE id = $1 -- trailing? yes');

  chk('a ? in a block comment is not a parameter either',
    rw('SELECT /* ? not a param */ 1 WHERE id = ?')
    === 'SELECT /* ? not a param */ 1 WHERE id = $1');

  chk('an unterminated block comment does not swallow the rest as parameters',
    rw('SELECT 1 /* ? ?') === 'SELECT 1 /* ? ?');

  // better-sqlite3's named form. bridge.js's upsertParticipant binds @ts three
  // times; three separate $n would need the value passed three times, which the
  // caller does not do.
  const named = rewritePlaceholders(
    'INSERT INTO t (a, b, c) VALUES (@x, @y, @ts) ON CONFLICT DO UPDATE SET b = @y, seen = @ts');
  chk('a repeated @name reuses its index rather than claiming a new one',
    named.text === 'INSERT INTO t (a, b, c) VALUES ($1, $2, $3) ON CONFLICT DO UPDATE SET b = $2, seen = $3',
    named.text);
  chk('…and the names come back in index order',
    JSON.stringify(named.names) === '["x","y","ts"]', JSON.stringify(named.names));

  chk('an email in a literal is not a named parameter',
    rw("WHERE email = 'ops@example.com' AND id = ?")
    === "WHERE email = 'ops@example.com' AND id = $1");

  chk('a statement with no parameters is returned unchanged',
    rw('SELECT COUNT(*) FROM events') === 'SELECT COUNT(*) FROM events');

  // Positional args and a named object are different call shapes; a statement
  // that wants both cannot be called at all. Refuse rather than invent one.
  let mixed = null;
  try { rewritePlaceholders('WHERE a = ? AND b = @x'); } catch (e) { mixed = e; }
  chk('a statement mixing ? and @name is refused, not silently numbered',
    mixed instanceof MixedPlaceholders, String(mixed));
}

// ── 2. the real statement that made named parameters necessary ──────────────
function binding() {
  const { names } = rewritePlaceholders(
    'INSERT INTO bridge_participants (room_id, user_id, group_id, connected, joined_at, last_seen)'
    + ' VALUES (@room_id, @user_id, @group_id, @connected, @ts, @ts)');

  const vals = bindArgs(names, [{ room_id: 7, user_id: 'u1', group_id: null, connected: 1, ts: 1000 }]);
  chk('a named statement binds its object into positional order',
    JSON.stringify(vals) === '[7,"u1",null,1,1000]', JSON.stringify(vals));

  chk('a positional statement passes its arguments straight through',
    JSON.stringify(bindArgs([], [1, 'a', null])) === '[1,"a",null]');

  // undefined is a hard error on better-sqlite3 and a silent NULL on
  // node-postgres. On THIS statement a silent NULL group_id moves a participant
  // to the lobby — a presence bug with no exception to find it by.
  let missing = null;
  try { bindArgs(names, [{ room_id: 7, user_id: 'u1', connected: 1, ts: 1000 }]); } catch (e) { missing = e; }
  chk('a missing named parameter throws rather than binding NULL',
    missing && /missing parameter @group_id/.test(missing.message), String(missing));

  let wrongShape = null;
  try { bindArgs(names, [7, 'u1']); } catch (e) { wrongShape = e; }
  chk('a named statement called positionally is refused',
    wrongShape !== null, String(wrongShape));
}

// ── 3. the generator ────────────────────────────────────────────────────────
// Every piece knows both what it contributes to the INPUT and what it must
// contribute to the OUTPUT, so the expected string is built alongside rather
// than computed by a second scanner that could share the same bug.
function fuzz(rounds) {
  // Deterministic: a fuzz test that fails only on Tuesdays is a fuzz test
  // nobody can act on. The seed is printed, so a real failure is reproducible.
  const SEED = process.env.OPSCAT_FUZZ_SEED || 'opscat-pgsql-1';
  let state = crypto.createHash('sha256').update(SEED).digest();
  let off = 0;
  const byte = () => {
    if (off >= state.length) { state = crypto.createHash('sha256').update(state).digest(); off = 0; }
    return state[off++];
  };
  const pick = (arr) => arr[byte() % arr.length];

  // Fragments that contain the characters the scanner has to reason about —
  // question marks, at-signs, quotes, comment openers — in places where they
  // are DATA and must survive untouched.
  const inert = [
    " AND body LIKE '%?%'",
    " AND note = 'it''s ? fine'",
    ' AND "weird?col" IS NOT NULL',
    ' -- a comment with ? and @name\n',
    ' /* block ? @x */',
    " AND email = 'ops@example.com'",
    " AND path = '/a/b?c=d'",
    ' AND x = 1',
    "\n  AND label = ''",
    " AND j = '{\"k\": \"?\"}'",
  ];
  const params = [' AND id = ?', ' AND sev >= ?', ' LIMIT ?', ' OFFSET ?', ' AND org_id = ?'];

  let failures = 0;
  let totalParams = 0;
  for (let r = 0; r < rounds; r++) {
    let sql = 'SELECT * FROM events WHERE 1 = 1';
    let want = sql;
    let n = 0;
    const pieces = 1 + (byte() % 12);
    for (let p = 0; p < pieces; p++) {
      if (byte() % 2) {
        const frag = pick(params);
        n++;
        sql += frag;
        want += frag.replace('?', '$' + n);
      } else {
        const frag = pick(inert);
        sql += frag;
        want += frag;              // must come back byte-identical
      }
    }
    totalParams += n;
    const got = rw(sql);
    if (got !== want) {
      failures++;
      if (failures === 1) {
        console.error(`  seed ${SEED} round ${r}\n  in:   ${sql}\n  want: ${want}\n  got:  ${got}`);
      }
    }
  }
  chk(`${rounds} generated statements (${totalParams} parameters) rewrite exactly as constructed`,
    failures === 0, `${failures} mismatches`);

  // The property that actually kills the renumbering bug class, stated
  // independently of the generator: the parameters must come out as $1..$n in
  // source order, each exactly once.
  let orderFailures = 0;
  for (let r = 0; r < rounds; r++) {
    let sql = 'SELECT 1';
    let n = 0;
    const pieces = 1 + (byte() % 10);
    for (let p = 0; p < pieces; p++) {
      if (byte() % 3) { sql += ' AND c = ?'; n++; } else { sql += pick(inert); }
    }
    const seen = (rw(sql).match(/\$\d+/g) || []).map((t) => Number(t.slice(1)));
    if (seen.length !== n || seen.some((v, i) => v !== i + 1)) orderFailures++;
  }
  chk(`${rounds} more come out as $1..$n in source order, each exactly once`,
    orderFailures === 0, `${orderFailures} out of order`);
}

// ── 4. the statements the app really executes ───────────────────────────────
// Read from source rather than by requiring the modules: requiring them starts
// the engines, and this harness has no database and needs no port. The five
// runtime-BUILT statements are not here — those are the sweep's job, which sees
// them because the harnesses execute them.
function corpus() {
  const fs = require('fs');
  const path = require('path');
  const found = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/prepare\(\s*(`[^`]*`|'[^']*')/g)) found.push(m[1].slice(1, -1));
      }
    }
  })(path.join(__dirname, 'src'));

  // A corpus that quietly collapsed to nothing would let every check below pass
  // while testing zero statements — the failure mode CLAUDE.md names for the
  // vendor grid. Assert the size before asserting anything about the contents.
  chk('the source yields a real corpus of prepared statements',
    found.length > 600, `${found.length} statements`);

  let threw = 0;
  let mangled = 0;
  let withParams = 0;
  for (const sql of found) {
    let out;
    try { out = rewritePlaceholders(sql); } catch { threw++; continue; }
    const ns = (out.text.match(/\$\d+/g) || []).map((t) => Number(t.slice(1)));
    if (ns.length) withParams++;
    // Same order property, on real SQL this time.
    if (out.names.length === 0 && ns.some((v, i) => v !== i + 1)) mangled++;
    // Nothing but a parameter may change. Length is a crude invariant but a
    // real one: only `?`→`$n` and `@name`→`$n` may alter it.
    const delta = out.text.length - sql.length;
    if (delta < 0 && out.names.length === 0) mangled++;
  }
  chk('every one of them rewrites without throwing', threw === 0, `${threw} threw`);
  chk('…and none is mangled', mangled === 0, `${mangled} mangled`);
  chk(`…and ${withParams} of them actually carry parameters`, withParams > 400, `${withParams}`);

  // No statement may still contain a bare `?` outside a literal after the
  // rewrite. Checking that directly would need a second scanner; instead,
  // rewrite the OUTPUT again — a correct pass leaves nothing to do.
  let residual = 0;
  for (const sql of found) {
    let once;
    try { once = rewritePlaceholders(sql); } catch { continue; }
    if (once.names.length) continue;   // @name → $n is not idempotent by design
    if (rewritePlaceholders(once.text).text !== once.text) residual++;
  }
  chk('rewriting an already-rewritten statement changes nothing (no ? left behind)',
    residual === 0, `${residual} not idempotent`);
}

try {
  known();
  binding();
  fuzz(4000);
  corpus();
  report();
} catch (e) {
  die(e);
}
