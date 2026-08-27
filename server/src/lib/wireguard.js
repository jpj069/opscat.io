'use strict';
/**
 * The tunnel's two primitives: what a peer key may look like, and which inner
 * address it gets.
 *
 * ── Why a peer key is validated as strictly as an SSH key ───────────────────
 *
 * It is interpolated into a configuration file, on both sides. On ours it
 * becomes an argument to `wg set`; on the customer's it lands in a
 * `[Peer]` stanza. `e2e-sensors` exists in large part because the same shape —
 * a user-supplied key reaching cloud-init by interpolation — is a remote code
 * execution rather than a broken feature, since a "key" containing a newline
 * simply continues the document. A WireGuard key has exactly one legal form and
 * there is no reason to accept anything else:
 *
 *   32 bytes, base64, therefore 43 characters of alphabet plus a single `=`.
 *
 * So the check is anchored, length-exact, AND decoded — the regex alone would
 * pass a string that is the right shape but not 32 bytes, and `wg` would then
 * refuse it at the far end of a support ticket.
 *
 * ── Why the address is the identity ────────────────────────────────────────
 *
 * Inside a WireGuard tunnel a packet's source address is not a claim, it is a
 * consequence: the kernel drops anything whose source is not in the sending
 * peer's `AllowedIPs`, and only the holder of that peer's private key can send
 * at all. That is the entire reason this mode can accept plain UDP where the
 * managed endpoint cannot — there is no token in the message, and there does
 * not need to be one.
 *
 * It also means the allocation has to be exact. Two endpoints sharing an inner
 * address is two tenants sharing a mailbox, so the uniqueness lives in a
 * database index (migration 031) and this module only ever PROPOSES the next
 * one. Never trust the proposal: write it, and let the index refuse a collision.
 */

/* 32 bytes of base64. Nothing else is a WireGuard key.
 *
 * The last character class is the part worth getting right, and it was wrong
 * first: 32 bytes is ten full base64 groups plus two bytes, so the 43rd
 * character carries only six of its bits and the low TWO must be zero — index a
 * multiple of four, which is sixteen characters, not thirteen. Dropping `0`,
 * `4` and `8` from the set refused 19% of genuine keys (measured over 2000
 * generated ones), and every one of those refusals would have looked to the
 * customer like "OpsCat says my key is malformed" for a key `wg` had just
 * printed. A validator that is wrong 19% of the time is worse than none,
 * because it is wrong unpredictably. */
const KEY_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

/**
 * @param {unknown} k
 * @returns {boolean} true only for a real 32-byte base64 key
 */
function isPeerKey(k) {
  if (typeof k !== 'string' || k.length !== 44 || !KEY_RE.test(k)) return false;
  /* The decode is not belt-and-braces: the regex constrains the alphabet and
   * the final character's low bits, which is what makes a 44-character string
   * decodable at all — but Buffer.from is the only thing that proves it came
   * back out as 32 bytes rather than as something Node silently truncated. */
  try { return Buffer.from(k, 'base64').length === 32; } catch { return false; }
}

/**
 * Parse `10.79.0.0/16` into the numeric range it covers.
 * @param {string} cidr
 * @returns {{base:number, size:number, bits:number}|null}
 */
function parseCidr(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr || ''));
  if (!m) return null;
  const octets = [+m[1], +m[2], +m[3], +m[4]];
  if (octets.some((o) => o > 255)) return null;
  const bits = +m[5];
  // /31 and /32 hold no usable hosts, and anything below /8 is a configuration
  // mistake rather than an intention.
  if (bits < 8 || bits > 30) return null;
  const addr = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  const size = 2 ** (32 - bits);
  const base = Math.floor(addr / size) * size;   // normalise to the network address
  return { base, size, bits };
}

const toIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** The address the gateway itself answers on: the first host in the pool. */
function serverIp(cidr) {
  const r = parseCidr(cidr);
  return r ? toIp(r.base + 1) : null;
}

/**
 * The next inner address to try, given the ones already handed out.
 *
 * It is the lowest FREE host rather than "the highest plus one", so an address
 * released by a deleted endpoint is reused instead of the pool marching
 * upwards forever. `.1` is ours; the broadcast address is skipped.
 *
 * @param {string} cidr
 * @param {string[]} taken already-allocated addresses
 * @returns {string|null} null when the pool is exhausted
 */
function nextIp(cidr, taken) {
  const r = parseCidr(cidr);
  if (!r) return null;
  const used = new Set(taken.filter(Boolean));
  for (let i = 2; i < r.size - 1; i += 1) {
    const ip = toIp(r.base + i);
    if (!used.has(ip)) return ip;
  }
  return null;
}

/**
 * Is this address inside the pool at all?
 *
 * The gateway asks before it believes an inner source address, because the
 * answer decides which tenant a line is written to. A packet whose source is
 * outside the pool did not come through the tunnel — and on a correctly bound
 * interface it cannot exist, which is exactly why it must be refused loudly
 * rather than guessed at.
 */
function inPool(cidr, ip) {
  const r = parseCidr(cidr);
  if (!r || typeof ip !== 'string') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = [+m[1], +m[2], +m[3], +m[4]];
  if (o.some((x) => x > 255)) return false;
  const n = ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  return n > r.base + 1 && n < r.base + r.size - 1;
}

module.exports = { KEY_RE, isPeerKey, parseCidr, serverIp, nextIp, inPool };
