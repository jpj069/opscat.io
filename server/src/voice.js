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

function saveOrgConfig(orgId, { baseUrl, model, apiKey }) {
  if (baseUrl !== undefined) setOrgSetting(orgId, KEYS.base, String(baseUrl).trim());
  if (model !== undefined) setOrgSetting(orgId, KEYS.model, String(model).trim());
  if (apiKey !== undefined) {
    setOrgSetting(orgId, KEYS.key, apiKey ? encrypt(apiKey, config.secret) : '');
  }
}

function savePlatformConfig({ baseUrl, model, apiKey }) {
  if (baseUrl !== undefined) setSetting(KEYS.base, String(baseUrl).trim());
  if (model !== undefined) setSetting(KEYS.model, String(model).trim());
  if (apiKey !== undefined) setSetting(KEYS.key, apiKey ? encrypt(apiKey, config.secret) : '');
}

function platformStatus() {
  const p = readScope((k) => getSetting(k), []);
  return { baseUrl: p.baseUrl, model: p.model, hasKey: !!p.keyEnc };
}

// OpenAI-compatible transcription call. `audio` is a Buffer of one speech
// chunk (webm/opus, mp4/aac, ogg or wav — whatever MediaRecorder produced).
// Returns the transcript text (string, may be empty for silence). Throws with
// a safe message (no key material); err.unconfigured marks the no-provider
// case so the route can 503 instead of 502.
async function transcribe(orgId, audio, mime, { timeoutMs = 30000 } = {}) {
  const cfg = resolveConfig(orgId);
  if (!cfg) {
    throw Object.assign(new Error('no voice provider configured'), { unconfigured: true });
  }
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

module.exports = { resolveConfig, statusFor, saveOrgConfig, savePlatformConfig, platformStatus, transcribe };
