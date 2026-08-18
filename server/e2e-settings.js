'use strict';
/* The settings write-through cache in `src/db.js`.
 *
 * ── Why this needs a harness, and why it needs CHILD PROCESSES ──────────────
 *
 * `getSetting`/`getOrgSetting` have 62 call sites and most of them are boolean
 * guards, so the Postgres port cannot make them async: a missed `await` there is
 * `!Promise`, which is `false`, which no type system and no proxy can trap. They
 * stay synchronous, backed by a cache loaded once at boot and kept current by
 * `setSetting`/`setOrgSetting` — the only writers of those two tables anywhere
 * in the codebase.
 *
 * The half that needs a harness of its own is the BOOT PRELOAD, and it needs one
 * because of how every other harness is shaped. They each start on a fresh
 * database and write their settings through `setSetting` **in the same process**,
 * so the cache is populated by those writes and the preload never runs for
 * anything that is later read. Measured: deleting the preload entirely leaves all
 * 22 harnesses green at 1555/1555.
 *
 * What that would actually be is a server that forgets every setting when it
 * restarts. Not a subtle degradation — `app_secret` is stored in this table, so
 * a restart would MINT A NEW ONE: every SNMP community encrypted with the old
 * secret becomes undecryptable and every existing session is invalidated, once,
 * silently, on a deploy. Classifiers would revert to built-ins, a published
 * status page would go unpublished, and every org setting would read as its
 * default.
 *
 * A restart is the only thing that exercises it, and `db.js` is a singleton that
 * cannot be re-required — so the checks below fork. Same reason `e2e-reputation`
 * runs its migration test in a child.
 *
 * Boots no server and needs no port.  cd server && node e2e-settings.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { chk, report, onExit, die } = require('./e2e-lib').harness();
const q = require('./src/db/shim');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-settings-'));
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

/** Run `code` in a fresh node process against the shared data dir, and return
 *  whatever it printed as JSON. A new process means a new `db.js`, which is the
 *  entire point: this is what a deploy does. */
function inFreshProcess(body) {
  // OPSCAT_SECRET is deliberately REMOVED from the child's environment. With it
  // set, `config.secret` is already truthy and db.js never persists `app_secret`
  // at all — so the restart check below would pass against a value that was
  // never stored, i.e. test nothing. Unset is the production path: generate on
  // first boot, store, and read the SAME one back forever after.
  const env = { ...process.env, OPSCAT_DATA_DIR: tmp, NODE_ENV: 'test' };
  delete env.OPSCAT_SECRET;
  // `await d.init()` first, always: the settings preload and the app-secret
  // bootstrap live there now (db.js § two boot paths), and they are the two
  // things every check below is about. A child that skipped it would read an
  // empty cache and report the DEFAULT for everything — which looks exactly
  // like the bug this harness exists to catch, from the wrong cause.
  // DATABASE_URL rides along in `process.env` above — the child talks to the
  // same database as the parent, which is the whole point of the two-process
  // shape.
  // The pool is closed when the body is done, and that is not tidiness: a pg Pool
  // keeps an idle client — and therefore the event loop — alive for its 30s idle
  // timeout, so every child would sit there for half a minute after printing its
  // answer and `execFileSync` would wait for all of it.
  const code = `const q = require('${__dirname}/src/db/shim');\n(async () => {\n${body}\n})()`
    + `.then(() => require('${__dirname}/src/db/pg').close())`
    + `.catch((e) => { console.error(e); process.exit(1); });`;
  const out = execFileSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
  const line = out.trim().split('\n').pop();
  return JSON.parse(line);
}

function main() {
  // ── 1. a write is visible to the process that made it ─────────────────────
  // The two probe orgs are inserted for real: `org_settings.org_id` is a foreign
  // key, so a made-up id is rejected rather than silently stored — which is the
  // constraint working, and worth keeping rather than testing around.
  const mkOrgs = `
    const mk = q.prepare("INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)");
    await mk.run('${ORG_A}', 'Probe A', 'probe-a', Date.now());
    await mk.run('${ORG_B}', 'Probe B', 'probe-b', Date.now());`;
  const first = inFreshProcess(`
    const d = require('${__dirname}/src/db'); await d.init();
    ${mkOrgs}
    await d.setSetting('probe_global', 'alpha');
    await d.setOrgSetting('${ORG_A}', 'probe_org', 'a-value');
    await d.setOrgSetting('${ORG_B}', 'probe_org', 'b-value');
    console.log(JSON.stringify({
      global: d.getSetting('probe_global'),
      orgA: d.getOrgSetting('${ORG_A}', 'probe_org'),
      orgB: d.getOrgSetting('${ORG_B}', 'probe_org'),
      secret: d.getSetting('app_secret'),
    }));`);
  chk('a setting written in this process reads back', first.global === 'alpha', String(first.global));
  chk('…and an org setting does too', first.orgA === 'a-value', String(first.orgA));
  chk('…scoped per organization, not shared', first.orgB === 'b-value', String(first.orgB));

  // ── 2. THE restart. This is the check the preload exists for ──────────────
  const second = inFreshProcess(`
    const d = require('${__dirname}/src/db'); await d.init();
    console.log(JSON.stringify({
      global: d.getSetting('probe_global'),
      orgA: d.getOrgSetting('${ORG_A}', 'probe_org'),
      orgB: d.getOrgSetting('${ORG_B}', 'probe_org'),
      missing: d.getSetting('never_written', 'the-default'),
      missingOrg: d.getOrgSetting('${ORG_A}', 'never_written', 'org-default'),
      secret: d.getSetting('app_secret'),
    }));`);
  chk('a NEW process sees a setting the previous one wrote — the boot preload',
    second.global === 'alpha', String(second.global));
  chk('…and the org settings, both of them, still apart',
    second.orgA === 'a-value' && second.orgB === 'b-value',
    `${second.orgA} / ${second.orgB}`);

  /* The one that turns a silent restart bug into a loud one. `app_secret` is
   * generated on first boot and stored here; if the preload does not run, the
   * second boot finds nothing and mints a REPLACEMENT — which is how every
   * encrypted SNMP community in the database becomes undecryptable. Asserting
   * the value is stable across processes is asserting that never happens. */
  chk('app_secret survives a restart rather than being regenerated',
    typeof second.secret === 'string' && second.secret.length > 0 && second.secret === first.secret,
    `${String(first.secret).slice(0, 8)}… vs ${String(second.secret).slice(0, 8)}…`);

  // ── 3. an absent key is the default, not undefined ────────────────────────
  // The cache is COMPLETE, so a miss means "not in the table" — but only if a
  // miss is distinguished from a stored empty string, which `undefined` is how.
  chk('an unset setting returns the supplied default', second.missing === 'the-default', String(second.missing));
  chk('…and so does an unset org setting', second.missingOrg === 'org-default', String(second.missingOrg));

  // ── 4. a stored EMPTY STRING is a value, not an absence ───────────────────
  // `settings.value` is NOT NULL but '' is legal, and several callers store it
  // to mean "explicitly cleared". A cache that used `|| def` instead of an
  // undefined check would hand back the default for a key the admin cleared on
  // purpose — the setting would silently re-enable itself.
  const third = inFreshProcess(`
    const d = require('${__dirname}/src/db'); await d.init();
    await d.setSetting('probe_empty', '');
    await d.setOrgSetting('${ORG_A}', 'probe_empty', '');
    console.log(JSON.stringify({ now: d.getSetting('probe_empty', 'FALLBACK') }));`);
  chk('a setting stored as an empty string stays empty in the writing process',
    third.now === '', JSON.stringify(third.now));
  const fourth = inFreshProcess(`
    const d = require('${__dirname}/src/db'); await d.init();
    console.log(JSON.stringify({
      g: d.getSetting('probe_empty', 'FALLBACK'),
      o: d.getOrgSetting('${ORG_A}', 'probe_empty', 'FALLBACK'),
    }));`);
  chk('…and after a restart — an explicitly cleared setting must not fall back',
    fourth.g === '' && fourth.o === '', `${JSON.stringify(fourth.g)} / ${JSON.stringify(fourth.o)}`);

  // ── 5. keys cannot collide across orgs ────────────────────────────────────
  // The cache key joins org id and setting key. With a printable separator,
  // `('a:b', 'c')` and `('a', 'b:c')` are the same entry — one org reading
  // another's value. The separator is NUL, which cannot occur in either part.
  /* The colon-bearing org is created HERE rather than beside the other two, and
   * the child is allowed to DIE: `organizations.id` is TEXT on SQLite and `uuid`
   * on Postgres, and only one of those can hold `<uuid>:x` — Postgres refuses it
   * outright (22P02), so the fixture this collision needs cannot be written on
   * that engine at all. Containing it here costs THIS check and not the four
   * above it, and the failure is reported with the engine's own message rather
   * than skipped. The invariant itself lives in db.js's `orgKey` and is
   * engine-independent; what Postgres removes is the ability to construct a
   * colliding pair through the real write path.
   */
  let fifth;
  try {
    fifth = inFreshProcess(`
      const d = require('${__dirname}/src/db'); await d.init();
      await q.prepare("INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
        .run('${ORG_A}:x', 'Probe Colon', 'probe-colon', Date.now());
      await d.setOrgSetting('${ORG_A}', 'x:y', 'colon-in-key');
      await d.setOrgSetting('${ORG_A}:x', 'y', 'colon-in-org');
      console.log(JSON.stringify({
        a: d.getOrgSetting('${ORG_A}', 'x:y'),
        b: d.getOrgSetting('${ORG_A}:x', 'y'),
      }));`);
  } catch (e) {
    fifth = { a: null, b: null, why: String((e.stderr || e.message || '').split('\n')[0]).slice(0, 120) };
  }
  /* Two engines, two different reasons the collision cannot happen — and the
   * check says which one it is measuring rather than skipping the awkward half.
   *
   * On SQLite an org id is TEXT, so `<uuid>:x` is storable and the colliding
   * pair can be built for real: `('a:b','c')` and `('a','b:c')` are one cache
   * entry under a printable separator, i.e. one org reading another's settings.
   * That is the invariant, and this is where it is exercised.
   *
   * On Postgres `organizations.id` is a `uuid` COLUMN, so the fixture is refused
   * at the write (22P02) and the pair cannot exist at all. That is a stronger
   * guarantee than the NUL separator, not a gap in it — but it is a guarantee
   * from the schema, not from `orgKey`, so asserting the refusal is the honest
   * claim to make here. The NUL separator in `orgKey` stays regardless: it is
   * what makes the CACHE key unambiguous, and the cache does not know the column
   * is a uuid.
   */
  chk('an org id containing the separator cannot exist at all — the column is a uuid',
    fifth.a === null && /invalid input syntax for type uuid/.test(String(fifth.why)),
    fifth.why || `${fifth.a} / ${fifth.b}`);

  // ── 6. the cache is not a second source of truth ──────────────────────────
  // Every read goes through the cache, so a write that updated the cache and
  // NOT the table would be invisible until the next restart — which is the
  // worst shape a bug can have: correct all day, wrong after a deploy.
  const sixth = inFreshProcess(`
    const d = require('${__dirname}/src/db'); await d.init();
    await d.setSetting('probe_durable', 'written-once');
    const row = await q.prepare('SELECT value FROM settings WHERE key = ?').get('probe_durable');
    console.log(JSON.stringify({ inTable: row ? row.value : null }));`);
  chk('a write reaches the TABLE, not only the cache', sixth.inTable === 'written-once', String(sixth.inTable));

  report();
}

try { main(); } catch (e) { die(e); }
