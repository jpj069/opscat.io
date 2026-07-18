'use strict';
const crypto = require('crypto');

const now = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randHex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

// --- scrypt password hashing ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(expectedHash, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// --- AES-256-GCM for secrets at rest (SNMP communities) ---
function encrypt(plain, secretHex) {
  const key = crypto.createHash('sha256').update(secretHex).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
function decrypt(b64, secretHex) {
  const buf = Buffer.from(b64, 'base64');
  const key = crypto.createHash('sha256').update(secretHex).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

// --- token-bucket rate limiter (in-memory) ---
class RateLimiter {
  constructor({ perMinute, burst }) {
    this.rate = perMinute / 60000; // tokens per ms
    this.burst = burst || perMinute;
    this.buckets = new Map();
    // periodic cleanup so idle keys don't leak
    this.cleaner = setInterval(() => {
      const cutoff = now() - 10 * 60 * 1000;
      for (const [k, b] of this.buckets) if (b.ts < cutoff) this.buckets.delete(k);
    }, 5 * 60 * 1000);
    this.cleaner.unref();
  }
  allow(key, cost = 1) {
    const t = now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.burst, ts: t }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.burst, b.tokens + (t - b.ts) * this.rate);
    b.ts = t;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }
}

// --- SSE hub for live streams (org-scoped) ---
class SseHub {
  constructor() { this.clients = new Set(); }
  handler(req, res, orgId = 1) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');
    const client = { res, orgId };
    this.clients.add(client);
    const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch { /* closed */ } }, 25000);
    req.on('close', () => { clearInterval(ping); this.clients.delete(client); });
  }
  // Only clients belonging to `orgId` receive the message (tenant isolation).
  broadcast(type, data, orgId = 1) {
    if (!this.clients.size) return;
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      if (c.orgId !== orgId) continue;
      try { c.res.write(payload); } catch { this.clients.delete(c); }
    }
  }
}

// --- validation helpers ---
const isStr = (v, max = 500) => typeof v === 'string' && v.length > 0 && v.length <= max;
const optStr = (v, max = 500) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);
const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const isEmail = (v) => typeof v === 'string' && /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(v);

function httpError(res, status, message) { res.status(status).json({ error: message }); }

module.exports = {
  now, sha256, randHex, hashPassword, verifyPassword, encrypt, decrypt,
  RateLimiter, SseHub, isStr, optStr, clampInt, isEmail, httpError,
};
