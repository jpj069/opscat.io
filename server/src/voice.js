'use strict';
// Voice / STT client (OpenAI-compatible audio transcriptions) — the speech
// sibling of llm.js, same resolution order: org override (org_settings) ->
// platform default (global settings, super-admin) -> not configured. Base URL
// points at the API root (e.g. https://api.openai.com/v1); we append
// /audio/transcriptions. API keys are stored AES-256-GCM-encrypted
// (util.encrypt) and never leave the server — status endpoints only report
// hasKey booleans. Consumed by the Bridge (docs/BRIDGE.md phase 2): browsers
// post VAD-cut speech chunks, this turns them into transcript feed lines.
const { getSetting, setSetting, getOrgSetting, setOrgSetting } = require('./db');
const config = require('./config');
const { encrypt, decrypt } = require('./util');

const KEYS = { base: 'voice_base_url', model: 'voice_model', key: 'voice_api_key_enc' };

function readScope(get, scopeArgs) {
  const baseUrl = get(...scopeArgs, KEYS.base) || '';
  const model = get(...scopeArgs, KEYS.model) || '';
  const keyEnc = get(...scopeArgs, KEYS.key) || '';
  return { baseUrl: baseUrl.replace(/\/+$/, ''), model, keyEnc };
}

// Effective config for an org: {baseUrl, model, apiKey, source} or null.
function resolveConfig(orgId) {
  for (const [source, scope] of [
    ['org', readScope((o, k) => getOrgSetting(o, k), [orgId])],
    ['platform', readScope((k) => getSetting(k), [])],
  ]) {
    if (scope.baseUrl && scope.model && scope.keyEnc) {
      let apiKey;
      try { apiKey = decrypt(scope.keyEnc, config.secret); } catch { continue; }
      return { baseUrl: scope.baseUrl, model: scope.model, apiKey, source };
    }
  }
  return null;
}

// Public (key-free) view for settings UIs: what is set, not the secrets.
function statusFor(orgId) {
  const org = readScope((o, k) => getOrgSetting(o, k), [orgId]);
  const platform = readScope((k) => getSetting(k), []);
  const effective = resolveConfig(orgId);
  return {
    org: { baseUrl: org.baseUrl, model: org.model, hasKey: !!org.keyEnc },
    platformConfigured: !!(platform.baseUrl && platform.model && platform.keyEnc),
    effectiveSource: effective ? effective.source : null,
    effectiveModel: effective ? effective.model : null,
  };
}

async function saveOrgConfig(orgId, { baseUrl, model, apiKey }) {
  if (baseUrl !== undefined) await setOrgSetting(orgId, KEYS.base, String(baseUrl).trim());
  if (model !== undefined) await setOrgSetting(orgId, KEYS.model, String(model).trim());
  if (apiKey !== undefined) {
    await setOrgSetting(orgId, KEYS.key, apiKey ? encrypt(apiKey, config.secret) : '');
  }
}

async function savePlatformConfig({ baseUrl, model, apiKey }) {
  if (baseUrl !== undefined) await setSetting(KEYS.base, String(baseUrl).trim());
  if (model !== undefined) await setSetting(KEYS.model, String(model).trim());
  if (apiKey !== undefined) await setSetting(KEYS.key, apiKey ? encrypt(apiKey, config.secret) : '');
}

function platformStatus() {
  const p = readScope((k) => getSetting(k), []);
  return { baseUrl: p.baseUrl, model: p.model, hasKey: !!p.keyEnc };
}

// Platform scope only — no org fallback (super-admin test button).
function resolvePlatform() {
  const p = readScope((k) => getSetting(k), []);
  if (!(p.baseUrl && p.model && p.keyEnc)) return null;
  try { return { baseUrl: p.baseUrl, model: p.model, apiKey: decrypt(p.keyEnc, config.secret), source: 'platform' }; }
  catch { return null; }
}

// 0.6 s / 440 Hz / 16 kHz mono WAV, synthesized in-process — enough for a
// real provider round-trip: a tone transcribes to (near-)empty text, but URL,
// key and model name are all validated by the call itself.
function testWav() {
  const rate = 16000;
  const n = Math.floor(rate * 0.6);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.4 * 32767), 44 + i * 2);
  }
  return buf;
}

// OpenAI-compatible transcription call. `audio` is a Buffer of one speech
// chunk (webm/opus, mp4/aac, ogg or wav — whatever MediaRecorder produced).
// Returns the transcript text (string, may be empty for silence). Throws with
// a safe message (no key material); err.unconfigured marks the no-provider
// case so the route can 503 instead of 502.
async function transcribe(orgId, audio, mime, opts) {
  const cfg = resolveConfig(orgId);
  if (!cfg) {
    throw Object.assign(new Error('no voice provider configured'), { unconfigured: true });
  }
  return transcribeWith(cfg, audio, mime, opts);
}

async function transcribePlatform(audio, mime, opts) {
  const cfg = resolvePlatform();
  if (!cfg) {
    throw Object.assign(new Error('no platform voice provider configured'), { unconfigured: true });
  }
  return transcribeWith(cfg, audio, mime, opts);
}

async function transcribeWith(cfg, audio, mime, { timeoutMs = 30000 } = {}) {
  const ext = /mp4|m4a/.test(mime || '') ? 'm4a' : /ogg/.test(mime || '') ? 'ogg'
    : /wav/.test(mime || '') ? 'wav' : 'webm';
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: mime || 'audio/webm' }), `chunk.${ext}`);
  fd.append('model', cfg.model);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: fd,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`voice endpoint answered ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = await resp.json();
    if (typeof data?.text !== 'string') throw new Error('voice response carried no text');
    return data.text.trim();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`voice endpoint timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { resolveConfig, resolvePlatform, statusFor, saveOrgConfig, savePlatformConfig, platformStatus, transcribe, transcribePlatform, testWav };
