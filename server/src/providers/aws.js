'use strict';
// AWS EC2 adapter — dependency-free SigV4 signing against the EC2 Query API
// (XML responses, parsed with targeted regexes: EC2 XML is machine-generated
// and stable). Credentials are passed per call and never logged; every error
// is redacted before it surfaces.
//
// Credential payload (stored encrypted in cloud_credentials.key_enc):
//   { "accessKeyId": "AKIA…", "secretAccessKey": "…" }
const crypto = require('crypto');

const API_VERSION = '2016-11-15';
const HTTP_TIMEOUT_MS = 25000;
const CANONICAL_UBUNTU_OWNER = '099720109477';
const SSH_GROUP = 'opscat-sensor-ssh';

// tcp/22 from each range, in the shape the EC2 Query API wants.
const ingressParams = (cidrs) => Object.assign(
  { 'IpPermissions.1.IpProtocol': 'tcp', 'IpPermissions.1.FromPort': '22', 'IpPermissions.1.ToPort': '22' },
  ...cidrs.map((c, i) => ({
    [`IpPermissions.1.IpRanges.${i + 1}.CidrIp`]: c,
    [`IpPermissions.1.IpRanges.${i + 1}.Description`]: 'OpsCat break-glass',
  })),
);

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const hexHash = (data) => crypto.createHash('sha256').update(data, 'utf8').digest('hex');

function redact(msg, cred) {
  let s = String(msg == null ? '' : msg);
  if (cred?.secretAccessKey) s = s.split(cred.secretAccessKey).join('***');
  return s.slice(0, 400);
}

// SigV4-signed POST to the regional EC2 endpoint. `params` is a flat object of
// Query-API parameters (Action, Version included by the caller).
async function ec2(cred, region, params) {
  const host = `ec2.${region}.amazonaws.com`;
  const body = Object.keys(params).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const t = new Date();
  const amzDate = t.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/ec2/aws4_request`;
  const canonical = ['POST', '/', '',
    `content-type:application/x-www-form-urlencoded; charset=utf-8`,
    `host:${host}`, `x-amz-date:${amzDate}`, '',
    'content-type;host;x-amz-date', hexHash(body)].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hexHash(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${cred.secretAccessKey}`, dateStamp), region), 'ec2'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, `
    + `SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`;

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  let res, text = '';
  try {
    res = await fetch(`https://${host}/`, {
      method: 'POST', signal: ctrl.signal, body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'X-Amz-Date': amzDate, Authorization: auth },
    });
    text = await res.text();
  } catch (e) {
    throw new Error(`aws request failed: ${redact(e?.name === 'AbortError' ? 'timeout' : e?.message, cred)}`);
  } finally { clearTimeout(to); }
  if (!res.ok) {
    const m = /<Message>([^<]*)<\/Message>/.exec(text);
    throw new Error(`aws HTTP ${res.status}: ${redact(m ? m[1] : text, cred)}`);
  }
  return text;
}

const tag = (xml, name) => { const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml); return m ? m[1] : null; };

// Latest Canonical Ubuntu 24.04 amd64 AMI for the region.
async function resolveUbuntuAmi(cred, region) {
  const xml = await ec2(cred, region, {
    Action: 'DescribeImages', Version: API_VERSION,
    'Owner.1': CANONICAL_UBUNTU_OWNER,
    'Filter.1.Name': 'name',
    'Filter.1.Value.1': 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
    'Filter.2.Name': 'state', 'Filter.2.Value.1': 'available',
  });
  const images = [];
  const re = /<imageId>(ami-[a-f0-9]+)<\/imageId>[\s\S]*?<creationDate>([^<]+)<\/creationDate>/g;
  let m;
  while ((m = re.exec(xml))) images.push({ id: m[1], date: m[2] });
  if (!images.length) throw new Error(`aws: no Ubuntu 24.04 AMI found in ${region}`);
  images.sort((a, b) => (a.date < b.date ? 1 : -1));
  return images[0].id;
}

// -> { providerInstanceId, ip } (ip is usually null right after launch)
async function createInstance(cred, { region, instanceType, userData, locationId, securityGroupId }) {
  const imageId = await resolveUbuntuAmi(cred, region);
  const xml = await ec2(cred, region, Object.assign({
    Action: 'RunInstances', Version: API_VERSION,
    ImageId: imageId, InstanceType: instanceType, MinCount: '1', MaxCount: '1',
    UserData: Buffer.from(userData, 'utf8').toString('base64'),
    'TagSpecification.1.ResourceType': 'instance',
    'TagSpecification.1.Tag.1.Key': 'opscat-sensor', 'TagSpecification.1.Tag.1.Value': '1',
    'TagSpecification.1.Tag.2.Key': 'opscat-location', 'TagSpecification.1.Tag.2.Value': String(locationId),
    'MetadataOptions.HttpTokens': 'required', // IMDSv2 only
    // Without a group the instance lands in the VPC's default security group,
    // which allows no inbound from outside itself — that IS the no-SSH default,
    // and it stays that way unless break-glass access is configured.
  }, securityGroupId ? { 'SecurityGroupId.1': securityGroupId } : {}));
  const id = tag(xml, 'instanceId');
  if (!id) throw new Error('aws: RunInstances returned no instanceId');
  return { providerInstanceId: id, ip: tag(xml, 'ipAddress') };
}

async function destroyInstance(cred, { region, providerInstanceId }) {
  await ec2(cred, region, {
    Action: 'TerminateInstances', Version: API_VERSION, 'InstanceId.1': providerInstanceId,
  });
  return { ok: true };
}

// All non-terminated instances tagged opscat-sensor in the region:
// -> [{ providerInstanceId, locationId, state }]
async function listInstances(cred, { region }) {
  const xml = await ec2(cred, region, {
    Action: 'DescribeInstances', Version: API_VERSION,
    'Filter.1.Name': 'tag-key', 'Filter.1.Value.1': 'opscat-sensor',
    'Filter.2.Name': 'instance-state-name',
    'Filter.2.Value.1': 'pending', 'Filter.2.Value.2': 'running', 'Filter.2.Value.3': 'stopped',
  });
  const out = [];
  // one <item> per instance inside instancesSet; each carries its own tagSet
  const re = /<instanceId>(i-[a-f0-9]+)<\/instanceId>[\s\S]*?<name>([a-z-]+)<\/name>[\s\S]*?(<tagSet>[\s\S]*?<\/tagSet>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const loc = /<key>opscat-location<\/key>\s*<value>(\d+)<\/value>/.exec(m[3]);
    out.push({ providerInstanceId: m[1], state: m[2], locationId: loc ? Number(loc[1]) : null });
  }
  return out;
}

// Idempotent: one `opscat-sensor-ssh` group per region, holding exactly the
// ranges the org configured. Returns its id for RunInstances.
//
// Called on EVERY provision rather than once, because the group is the only
// thing enforcing "port 22 from these addresses" — if an operator widens or
// deletes it by hand, the next node provisioned puts it back, and a narrowed
// list takes effect without anyone remembering this group exists.
async function ensureSshAccess(cred, { region, cidrs }) {
  if (!Array.isArray(cidrs) || !cidrs.length) throw new Error('aws: ensureSshAccess needs at least one CIDR');
  const found = await ec2(cred, region, {
    Action: 'DescribeSecurityGroups', Version: API_VERSION,
    'Filter.1.Name': 'group-name', 'Filter.1.Value.1': SSH_GROUP,
  });
  let groupId = tag(found, 'groupId');
  if (!groupId) {
    // Sensors launch into the default VPC (RunInstances picks its subnet), so
    // the group has to live there or the launch fails with a mismatch.
    const vpcs = await ec2(cred, region, {
      Action: 'DescribeVpcs', Version: API_VERSION,
      'Filter.1.Name': 'isDefault', 'Filter.1.Value.1': 'true',
    });
    const vpcId = tag(vpcs, 'vpcId');
    if (!vpcId) throw new Error(`aws: no default VPC in ${region} — create one or disable sensor SSH`);
    const created = await ec2(cred, region, {
      Action: 'CreateSecurityGroup', Version: API_VERSION, GroupName: SSH_GROUP,
      GroupDescription: 'OpsCat sensor break-glass SSH', VpcId: vpcId,
    });
    groupId = tag(created, 'groupId');
    if (!groupId) throw new Error('aws: CreateSecurityGroup returned no groupId');
  }
  // Revoke what is there and authorise what is configured, so removing a range
  // in OpsCat actually closes it. Both calls tolerate "nothing to do".
  const existing = [];
  const desc = await ec2(cred, region, {
    Action: 'DescribeSecurityGroups', Version: API_VERSION, 'GroupId.1': groupId,
  });
  const re = /<cidrIp>([^<]+)<\/cidrIp>/g;
  let m;
  while ((m = re.exec(desc))) existing.push(m[1]);
  const stale = existing.filter((c) => !cidrs.includes(c));
  if (stale.length) {
    await ec2(cred, region, Object.assign({
      Action: 'RevokeSecurityGroupIngress', Version: API_VERSION, GroupId: groupId,
    }, ingressParams(stale))).catch((e) => {
      if (!/InvalidPermission\.NotFound/.test(e.message)) throw e;
    });
  }
  const missing = cidrs.filter((c) => !existing.includes(c));
  if (missing.length) {
    try {
      await ec2(cred, region, Object.assign({
        Action: 'AuthorizeSecurityGroupIngress', Version: API_VERSION, GroupId: groupId,
      }, ingressParams(missing)));
    } catch (e) {
      // two provisions racing into the same fresh group is not an error
      if (!/InvalidPermission\.Duplicate/.test(e.message)) throw e;
    }
  }
  return groupId;
}

module.exports = { key: 'aws', createInstance, destroyInstance, listInstances, ensureSshAccess };
