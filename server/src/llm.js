'use strict';
// LLM client (OpenAI-compatible chat completions). Resolution order for the
// effective config: org override (org_settings) -> platform default (global
// settings, set by a super-admin) -> not configured. Base URL points at the
// API root (e.g. https://openrouter.ai/api/v1); we append /chat/completions.
// API keys are stored AES-256-GCM-encrypted (util.encrypt) and never leave
// the server — status endpoints only ever report hasKey booleans.
const { getSetting, setSetting, getOrgSetting, setOrgSetting } = require('./db');
const config = require('./config');
const { encrypt, decrypt } = require('./util');

const KEYS = { base: 'ai_base_url', model: 'ai_model', key: 'ai_api_key_enc' };

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

// Platform scope only — no org fallback. For the super-admin's "does the
// platform default work" test button; orgs keep resolveConfig's chain.
function resolvePlatform() {
  const p = readScope((k) => getSetting(k), []);
  if (!(p.baseUrl && p.model && p.keyEnc)) return null;
  try { return { baseUrl: p.baseUrl, model: p.model, apiKey: decrypt(p.keyEnc, config.secret), source: 'platform' }; }
  catch { return null; }
}

// OpenAI-compatible chat call. Returns the assistant message content (string).
// Throws with a safe message (no key material) on any failure.
async function chat(orgId, messages, opts) {
  const cfg = resolveConfig(orgId);
  if (!cfg) throw new Error('no LLM configured (set one in Settings → AI & Voice, or ask the platform admin)');
  return callChat(cfg, messages, opts);
}

async function chatPlatform(messages, opts) {
  const cfg = resolvePlatform();
  if (!cfg) throw new Error('no platform LLM configured');
  return callChat(cfg, messages, opts);
}

async function callChat(cfg, messages, { maxTokens = 512, temperature = 0, timeoutMs = 30000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: maxTokens, temperature }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`LLM endpoint answered ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('LLM response carried no message content');
    return content;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`LLM endpoint timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { resolveConfig, resolvePlatform, statusFor, saveOrgConfig, savePlatformConfig, platformStatus, chat, chatPlatform };
