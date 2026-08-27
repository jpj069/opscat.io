'use strict';
/**
 * Break-glass SSH for auto-provisioned sensor nodes.
 *
 * The wizard's nodes were unreachable by construction: `renderCloudInit` took
 * only a URL and a probe key, `RunInstances` passed no `KeyName`, and the one
 * user cloud-init created has `/usr/sbin/nologin`. That is a defensible default
 * — a box with no login cannot have its key stolen — but it also means a node
 * that misbehaves can only be destroyed, never looked at, and a load test that
 * needs `htop` on the sensor cannot be run at all.
 *
 * So access is OPT-IN and needs two things together, per organisation: a public
 * key, and the addresses allowed to use it. Neither is useful alone, which is
 * why they are validated as a pair.
 *
 * Both values end up in a YAML document (cloud-init) and in a provider API call
 * (a security-group rule). Both are therefore validated as STRICTLY as the
 * format allows rather than passed through: a newline inside the "public key"
 * is an arbitrary cloud-init payload on a machine we then open port 22 on.
 */

// One line, one of the four key types OpenSSH actually emits, base64 body, and
// an optional comment that may not contain a line break. Deliberately no
// tolerance for leading/trailing whitespace beyond a trim: "it looked fine when
// I pasted it" is how the newline gets in.
const KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]{32,1000}={0,3}( [\x20-\x7e]{1,100})?$/;

// Returns the normalised key, or throws with a message the UI shows verbatim.
function validateSshKey(raw) {
  const key = String(raw == null ? '' : raw).trim();
  if (!key) throw new Error('ssh key required');
  if (key.length > 1200) throw new Error('ssh key too long');
  if (/[\r\n]/.test(key)) throw new Error('ssh key must be a single line (paste the .pub file, not the private key)');
  if (/PRIVATE KEY/i.test(key)) throw new Error('that is a PRIVATE key — paste the .pub file instead');
  if (!KEY_RE.test(key)) throw new Error('not a valid OpenSSH public key (expected "ssh-ed25519 AAAA… comment")');
  return key;
}

// "1.2.3.4/32, 10.0.0.0/8" -> ['1.2.3.4/32', '10.0.0.0/8']
// A bare address is accepted and read as /32, because that is what everyone
// means by "the office IP" and turning it into a silent /0 would be the one
// mistake with real consequences here.
function parseCidrs(raw) {
  const parts = String(raw == null ? '' : raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('at least one source address is required');
  if (parts.length > 8) throw new Error('at most 8 source ranges');
  return parts.map((p) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(p);
    if (!m) throw new Error(`"${p}" is not an IPv4 address or CIDR`);
    const octets = m.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) throw new Error(`"${p}" is not a valid IPv4 address`);
    const bits = m[5] === undefined ? 32 : Number(m[5]);
    if (bits > 32) throw new Error(`"${p}" has an invalid prefix length`);
    // The whole point of the pair is that the key is only usable from
    // somewhere. /0 is not a restriction, it is the absence of one, and an
    // "allow all" that has to be typed as 0.0.0.0/0 gets typed eventually.
    if (bits < 16) throw new Error(`"${p}" is too wide — /16 or narrower (a sensor is not a jump host for the internet)`);
    return `${octets.join('.')}/${bits}`;
  });
}

// The pair as the provisioning path wants it: null when SSH is simply not
// configured, an object when it is, and a throw when it is half-configured —
// a key with nowhere to connect from is a security decision made by accident.
function sshAccessFor(getSetting, orgId) {
  const key = String(getSetting(orgId, 'sensor_ssh_key', '') || '').trim();
  const cidrs = String(getSetting(orgId, 'sensor_ssh_cidrs', '') || '').trim();
  if (!key && !cidrs) return null;
  if (!key) throw new Error('sensor SSH source ranges are set but no public key is — add the key or clear both');
  if (!cidrs) throw new Error('a sensor SSH key is set but no source range is — add one or clear both');
  return { sshKey: validateSshKey(key), cidrs: parseCidrs(cidrs) };
}

module.exports = { validateSshKey, parseCidrs, sshAccessFor, KEY_RE };
