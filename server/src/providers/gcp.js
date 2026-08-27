'use strict';
// GCP Compute Engine adapter — dependency-free OAuth2 service-account JWT flow
// (RS256 via node:crypto) + the Compute REST API (JSON). Credentials are the
// service-account JSON key, passed per call and never logged.
//
// Credential payload (stored encrypted in cloud_credentials.key_enc): the
// service-account JSON as issued by GCP — { client_email, private_key,
// project_id, … }. Instances live in zone `<region>-b` and are addressed as
// provider_ref `<zone>/<name>` for teardown.
const crypto = require('crypto');

const HTTP_TIMEOUT_MS = 25000;
const SOURCE_IMAGE = 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function redact(msg, cred) {
  let s = String(msg == null ? '' : msg);
  if (cred?.private_key) s = s.split(cred.private_key).join('***');
  return s.slice(0, 400);
}

async function httpJson(url, opts, cred) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  let res, text = '';
  try {
    res = await fetch(url, Object.assign({ signal: ctrl.signal }, opts));
    text = await res.text();
  } catch (e) {
    throw new Error(`gcp request failed: ${redact(e?.name === 'AbortError' ? 'timeout' : e?.message, cred)}`);
  } finally { clearTimeout(to); }
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON */ } }
  if (!res.ok) {
    throw new Error(`gcp HTTP ${res.status}: ${redact(data?.error?.message || text, cred)}`);
  }
  return data || {};
}

// Service-account JWT → short-lived access token.
async function accessToken(cred) {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: cred.client_email, scope: 'https://www.googleapis.com/auth/compute',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(cred.private_key))}`;
  const data = await httpJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  }, cred);
  if (!data.access_token) throw new Error('gcp: token exchange returned no access_token');
  return data.access_token;
}

const SSH_TAG = 'opscat-sensor';
const SSH_RULE = 'opscat-sensor-ssh';

const zoneOf = (region) => `${region}-b`;
const compute = (project) => `https://compute.googleapis.com/compute/v1/projects/${project}`;

// -> { providerInstanceId ("<zone>/<name>"), ip: null }
async function createInstance(cred, { region, instanceType, userData, locationId }) {
  const token = await accessToken(cred);
  const zone = zoneOf(region);
  const name = `opscat-sensor-${locationId}`;
  await httpJson(`${compute(cred.project_id)}/zones/${zone}/instances`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      machineType: `zones/${zone}/machineTypes/${instanceType}`,
      disks: [{ boot: true, autoDelete: true,
        initializeParams: { sourceImage: SOURCE_IMAGE, diskSizeGb: '10' } }],
      networkInterfaces: [{ network: 'global/networks/default',
        accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }] }],
      metadata: { items: [{ key: 'user-data', value: userData }] },
      labels: { 'opscat-sensor': '1', 'opscat-location': String(locationId) },
      // The tag is what the break-glass firewall rule targets. It is set
      // unconditionally: a rule that exists but matches nothing is the failure
      // mode where SSH "is configured" and the box is still unreachable.
      tags: { items: [SSH_TAG] },
    }),
  }, cred);
  return { providerInstanceId: `${zone}/${name}`, ip: null };
}

async function destroyInstance(cred, { providerInstanceId }) {
  const token = await accessToken(cred);
  const [zone, name] = String(providerInstanceId).split('/');
  await httpJson(`${compute(cred.project_id)}/zones/${zone}/instances/${name}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  }, cred);
  return { ok: true };
}

// Idempotent: one project-wide `opscat-sensor-ssh` rule on the default network,
// scoped to the sensor tag and to the configured ranges. GCP firewall rules are
// global, so unlike AWS's per-region groups this runs once per project — and it
// PATCHes an existing rule, so narrowing the list in OpsCat closes the door
// rather than leaving yesterday's range open.
async function ensureSshAccess(cred, { cidrs }) {
  if (!Array.isArray(cidrs) || !cidrs.length) throw new Error('gcp: ensureSshAccess needs at least one CIDR');
  const token = await accessToken(cred);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const url = `${compute(cred.project_id)}/global/firewalls/${SSH_RULE}`;
  const rule = {
    name: SSH_RULE, network: 'global/networks/default', direction: 'INGRESS', priority: 1000,
    description: 'OpsCat sensor break-glass SSH', targetTags: [SSH_TAG], sourceRanges: cidrs,
    allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
  };
  let current = null;
  try { current = await httpJson(url, { headers }, cred); }
  catch (e) { if (!/HTTP 404/.test(e.message)) throw e; }
  if (!current) {
    await httpJson(`${compute(cred.project_id)}/global/firewalls`,
      { method: 'POST', headers, body: JSON.stringify(rule) }, cred);
    return SSH_RULE;
  }
  const same = JSON.stringify([...(current.sourceRanges || [])].sort()) === JSON.stringify([...cidrs].sort());
  if (!same) await httpJson(url, { method: 'PATCH', headers, body: JSON.stringify(rule) }, cred);
  return SSH_RULE;
}

// All opscat-sensor instances across zones: [{ providerInstanceId, locationId, state }]
async function listInstances(cred) {
  const token = await accessToken(cred);
  const data = await httpJson(
    `${compute(cred.project_id)}/aggregated/instances?filter=${encodeURIComponent('labels.opscat-sensor=1')}`,
    { headers: { Authorization: `Bearer ${token}` } }, cred);
  const out = [];
  for (const scope of Object.values(data.items || {})) {
    for (const inst of scope.instances || []) {
      const zone = String(inst.zone || '').split('/').pop();
      out.push({
        providerInstanceId: `${zone}/${inst.name}`,
        locationId: inst.labels?.['opscat-location'] ? Number(inst.labels['opscat-location']) : null,
        state: String(inst.status || '').toLowerCase(),
      });
    }
  }
  return out;
}

module.exports = { key: 'gcp', createInstance, destroyInstance, listInstances, ensureSshAccess };
