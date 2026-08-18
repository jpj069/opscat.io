'use strict';
/* The SQLite → PostgreSQL placeholder rewriter, and the argument binder that
 * goes with it. No driver, no connection, no dependencies — so it can be
 * fuzz-tested in the ordinary harness suite (`e2e-pgsql.js`) on a machine with
 * no database at all, rather than only in the CI job that has one.
 *
 * ── Why this is a module and not 40 lines inside the adapter ────────────────
 *
 * SQLite uses `?`, Postgres uses `$1..$n`. Rewriting ~773 prepared statements by
 * hand is the largest "mechanical" line item in every survey of this port, and
 * it carries a bug class no test would catch: swap two parameters and the query
 * still runs, still returns rows, and returns the WRONG ones. Done once here it
 * is one function — and the five runtime-BUILT SQL strings (ops.js, status.js,
 * superadmin.js, synthetics.js, mcp/tools.js) keep working without being touched
 * at all, which hand-conversion could not have managed.
 *
 * ── What it must not do ─────────────────────────────────────────────────────
 *
 * A `?` inside a string literal is DATA — `WHERE body LIKE '%?%'` searches for a
 * question mark. Rewriting it produces a query that is still valid SQL and
 * silently searches for something else. Same for a `?` in a comment. Both are
 * skipped.
 *
 * The doubled-quote escape (`'it''s'`) is handled explicitly, and honesty about
 * what that buys: **it is not currently load-bearing.** A naive scanner reads
 * `''` as "literal ends, literal begins", and because this pass only COPIES
 * characters through, the double toggle lands in exactly the same state — same
 * output, byte for byte. Measured: deleting the branch leaves all 25 checks in
 * e2e-pgsql.js green. It stays because the equivalence depends on the scanner
 * doing nothing at a literal boundary, and the first change that makes a
 * boundary meaningful turns a silent no-op into a silent inversion of
 * inside/outside for the whole rest of the statement. Do not delete it on the
 * grounds that no test defends it; the test cannot.
 *
 * Postgres dollar-quoting (`$tag$ … $tag$`) does not appear in this codebase and
 * is NOT handled. If it ever does, this function has to learn it, and the fuzz
 * test will not tell you — it generates the shapes we know about. Stated here
 * because a silent gap is worse than a missing feature.
 */

// A statement mixing `?` and `@name` would number them in one sequence, and the
// caller has no way to express that: positional args and a named object are
// different call shapes. Nothing in the codebase does it; refuse rather than
// invent a convention nobody will remember.
class MixedPlaceholders extends Error {}

/**
 * `?` → `$1..$n`, and `@name` → `$n` with a repeated name reusing its index.
 *
 * Returns `{ text, names }`. `names` is empty for a positional statement and
 * carries the parameter names, in index order, for a named one.
 */
function rewritePlaceholders(sql) {
  let out = '';
  let n = 0;
  let positional = 0;
  const named = new Map();

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];

    // ── string literals and quoted identifiers ──────────────────────────────
    if (c === '\'' || c === '"') {
      const quote = c;
      out += c;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          // '' inside a literal is an escaped quote, not the end of it
          if (sql[i + 1] === quote) { out += quote + quote; i += 2; continue; }
          out += quote;
          break;
        }
        out += sql[i];
        i++;
      }
      continue;
    }

    // ── comments: a ? in one is not a parameter ─────────────────────────────
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const stop = nl === -1 ? sql.length : nl;
      out += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const stop = close === -1 ? sql.length : close + 2;
      out += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }

    if (c === '?') { positional++; out += '$' + (++n); continue; }

    if (c === '@' && /[A-Za-z_]/.test(sql[i + 1] || '')) {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (!named.has(m[1])) named.set(m[1], ++n);
      out += '$' + named.get(m[1]);
      i += m[0].length - 1;
      continue;
    }

    out += c;
  }

  if (positional && named.size) {
    throw new MixedPlaceholders(
      `statement mixes ? and @name placeholders, which have different call shapes: ${sql.slice(0, 120)}`);
  }
  return { text: out, names: [...named.keys()] };
}

const isPlainObject = (v) => v !== null && typeof v === 'object'
  && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date);

/**
 * better-sqlite3 takes named parameters as ONE object argument
 * (`stmt.run({ room_id, user_id, ts })`); node-postgres takes an array. This is
 * the only place that difference exists.
 *
 * A missing key is passed as `undefined` on better-sqlite3 → a hard error, and
 * on node-postgres → NULL, silently. The explicit check keeps the loud
 * behaviour: one statement in this codebase is named (`bridge.js`
 * upsertParticipant), and it writes presence — a NULL group_id there moves a
 * participant to the lobby rather than failing.
 */
function bindArgs(names, args) {
  if (!names.length) return args;
  if (args.length !== 1 || !isPlainObject(args[0])) {
    throw new Error(`named statement wants one object argument, got ${args.length} (${typeof args[0]})`);
  }
  const o = args[0];
  return names.map((k) => {
    if (!(k in o)) throw new Error(`named statement is missing parameter @${k}`);
    return o[k];
  });
}

module.exports = { rewritePlaceholders, bindArgs, MixedPlaceholders };
