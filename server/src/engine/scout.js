'use strict';
// OpsCat Scout — mines rule suggestions from log lines no classifier matched.
//
// 1. Masking: variable parts (IPs, timestamps, numbers, …) become <TAG>
//    placeholders, so similar lines collapse into one string (the masking
//    library follows syslogfilterv2's drain3.ini, trimmed to the essentials).
// 2. Grouping: identical masked lines aggregate; a near-match against an
//    existing template of the same shape merges into it, differing tokens
//    become <*> (a lightweight take on the Drain algorithm).
// 3. Curation: the Pipeline → Scout tab lists templates by frequency; an
//    admin can ask the org's LLM (llm.js) for a suggested name/severity,
//    approve into a real classifier rule, or dismiss.
//
// Hot-path cost: masking regexes only run for UNMATCHED lines, counts are
// buffered in memory and flushed to scout_templates every few seconds.
const q = require('../db/shim');
const { now } = require('../util');
const pipeline = require('./pipeline');

// Masking rules, applied in order. Tags must stay in sync with MASK_VALUE
// below (regex generation on approve).
const MASKS = [
  { tag: 'TS', re: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g },
  { tag: 'DATE', re: /\b\d{4}[-/]\d{2}[-/]\d{2}\b/g },
  { tag: 'TIME', re: /\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g },
  { tag: 'MAC', re: /\b[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}\b/g },
  { tag: 'IP6', re: /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}\b/g },
  { tag: 'IP', re: /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:\/\d{1,2})?\b/g },
  { tag: 'UUID', re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
  { tag: 'EMAIL', re: /[\w.+-]+@[\w.-]+\.\w+/g },
  { tag: 'URL', re: /https?:\/\/\S+/g },
  { tag: 'PATH', re: /(?<![\w.])\/(?:[\w.@+-]+\/)+[\w.@+-]+/g },
  { tag: 'HEX', re: /\b0x[0-9a-fA-F]+\b/g },
  { tag: 'HID', re: /\b(?=[0-9a-fA-F]*[a-fA-F])(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{7,}\b/g },
  { tag: 'VER', re: /\b\d+(?:\.\d+){2,}\b/g },
  { tag: 'NUM', re: /\b\d+(?:\.\d+)?(?=[A-Za-z%]{1,3}\b)/g }, // number with unit: 320ms, 87%, 4GB
  { tag: 'NUM', re: /(?<![\w.])[+-]?\d+(?:\.\d+)?(?![\w.])/g },
];

// value pattern per tag for turning an approved template back into a regex
const MASK_VALUE = {
  TS: '\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?',
  DATE: '\\d{4}[-/]\\d{2}[-/]\\d{2}',
  TIME: '\\d{1,2}:\\d{2}:\\d{2}(?:[.,]\\d+)?',
  MAC: '[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}',
  IP6: '(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}',
  IP: '\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d{1,5})?(?:\\/\\d{1,2})?',
  UUID: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
  EMAIL: '[\\w.+-]+@[\\w.-]+\\.\\w+',
  URL: 'https?:\\/\\/\\S+',
  PATH: '\\/(?:[\\w.@+-]+\\/)+[\\w.@+-]+',
  HEX: '0x[0-9a-fA-F]+',
  HID: '[0-9a-fA-F]{7,}',
  VER: '\\d+(?:\\.\\d+){2,}',
  NUM: '[+-]?\\d+(?:\\.\\d+)?',
  '*': '\\S+',
};

function mask(line) {
  let out = line;
  for (const m of MASKS) out = out.replace(m.re, `<${m.tag}>`);
  // collapse repeated placeholders and whitespace so shapes stay stable
  return out.replace(/\s+/g, ' ').trim().slice(0, 400);
}

// similarity merge: same token count + same first token, ≥60% identical
// tokens -> same template family; differing tokens become <*>
const SIM_THRESHOLD = 0.6;
function tryMerge(tokens, existingTemplate) {
  const et = existingTemplate.split(' ');
  if (et.length !== tokens.length || et[0] !== tokens[0]) return null;
  let same = 0;
  const merged = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    if (et[i] === tokens[i]) { same++; merged[i] = et[i]; } else merged[i] = '<*>';
  }
  return same / tokens.length >= SIM_THRESHOLD ? merged.join(' ') : null;
}

// escape regex specials in the literal parts of a template
function escapeLiteral(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Turn an approved template into an anchored-ish regex. `targetIndex` (1-based
// over the template's placeholders) makes that placeholder a capture group.
function templateToPattern(template, targetIndex = 0) {
  let idx = 0;
  const pattern = template.split(/(<[A-Z*]+>)/).map((part) => {
    const m = /^<([A-Z*]+)>$/.exec(part);
    if (!m) return escapeLiteral(part);
    const value = MASK_VALUE[m[1]] || MASK_VALUE['*'];
    idx++;
    return idx === targetIndex ? `(${value})` : `(?:${value})`;
  }).join('');
  return { pattern, captureGroup: targetIndex >= 1 && targetIndex <= idx ? 1 : null };
}

/**
 * The most selective SUBSTRING of a template — what to hand the Logs page so it
 * can narrow server-side before its own regex filter runs.
 *
 * The template itself is useless as a search string: `<IP>` and `<NUM>` appear in
 * no raw log line, so searching for the masked text finds exactly nothing. The
 * literal runs between the placeholders are the parts that really occur, and the
 * longest of them is the one that narrows most.
 */
function templateFilter(template) {
  const literals = String(template).split(/<[A-Z*]+>/).map((p) => p.trim()).filter(Boolean);
  if (!literals.length) return '';
  return literals.reduce((a, b) => (b.length > a.length ? b : a)).slice(0, 120);
}

// ---- mining buffer ----

const MAX_TEMPLATES_PER_ORG = 500;
const FLUSH_MS = 5000;
let buffer = new Map(); // orgId -> Map<maskedLine, {count, sample, lastSeen}>
let flushTimer = null;

const findByTemplate = q.prepare('SELECT id, count FROM scout_templates WHERE org_id = ? AND template = ?');
const findCandidates = q.prepare(`SELECT id, template FROM scout_templates
  WHERE org_id = ? AND status = 'pending' ORDER BY count DESC LIMIT 500`);
// `findByTemplate` above still decides whether to look for a MERGE candidate —
// that is a behavioural choice, not a uniqueness gate. The uniqueness gate is
// `UNIQUE (org_id, template)`, and this used to race it: async, two flushes miss
// the same template and the second INSERT raises 23505 under Postgres, aborting
// the whole org's flush transaction and losing every count in it. Cooperating
// with the constraint folds the second one onto the first row instead, which is
// exactly what the read-then-bump branch would have done.
const insTemplate = q.prepare(`INSERT INTO scout_templates
  (org_id, template, count, sample, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (org_id, template) DO UPDATE SET
    count = scout_templates.count + excluded.count,
    last_seen = excluded.last_seen
  RETURNING id`);
const bumpTemplate = q.prepare(
  'UPDATE scout_templates SET count = count + ?, last_seen = ? WHERE id = ?');
const renameTemplate = q.prepare(
  'UPDATE scout_templates SET template = ?, count = count + ?, last_seen = ? WHERE id = ?');
const orgTemplateCount = q.prepare(
  "SELECT COUNT(*) c FROM scout_templates WHERE org_id = ? AND status = 'pending'");
const evictSmallest = q.prepare(`DELETE FROM scout_templates WHERE id IN (
  SELECT id FROM scout_templates WHERE org_id = ? AND status = 'pending'
  ORDER BY count ASC, last_seen ASC LIMIT ?)`);

function onLog(l) {
  if (l.matched) return;
  const masked = mask(l.line);
  if (!masked || masked.length < 4) return;
  let orgBuf = buffer.get(l.orgId);
  if (!orgBuf) { orgBuf = new Map(); buffer.set(l.orgId, orgBuf); }
  const e = orgBuf.get(masked);
  if (e) { e.count++; e.lastSeen = l.ts; }
  else if (orgBuf.size < 5000) orgBuf.set(masked, { count: 1, sample: l.line.slice(0, 400), lastSeen: l.ts });
}

async function flush() {
  // Swap the buffer out BEFORE the first statement runs, never clear it after.
  // Phase 4 puts awaits inside the loop below, and `buffer.clear()` at the end
  // would then throw away every line onLog() counted while the flush was
  // suspended — silently: no error, no counter, and the templates simply look
  // rarer than they are, which is the number the Scout tab ranks by.
  const batch = buffer;
  buffer = new Map();
  for (const [orgId, orgBuf] of batch) {
    // `q.withTx`, never `db.transaction`: better-sqlite3 COMMITs when the callback
    // RETURNS, so an async callback returns a pending promise, COMMIT fires at once
    // and every awaited write below lands OUTSIDE the transaction — no error, and a
    // rollback that covers nothing. db.js throws on a thenable now.
    // eslint-disable-next-line no-await-in-loop
    await q.withTx(async () => {
      let candidates = null; // lazy: only load when an exact match misses
      for (const [masked, e] of orgBuf) {
        const exact = await findByTemplate.get(orgId, masked);
        if (exact) { await bumpTemplate.run(e.count, e.lastSeen, exact.id); continue; }
        if (candidates === null) candidates = await findCandidates.all(orgId);
        const tokens = masked.split(' ');
        let merged = false;
        for (const c of candidates) {
          const mergedTemplate = tryMerge(tokens, c.template);
          if (!mergedTemplate) continue;
          if (mergedTemplate !== c.template) {
            // merged shape may collide with a third row: fold into it instead
            const clash = await findByTemplate.get(orgId, mergedTemplate);
            if (clash && clash.id !== c.id) {
              await bumpTemplate.run(e.count, e.lastSeen, clash.id);
            } else {
              await renameTemplate.run(mergedTemplate, e.count, e.lastSeen, c.id);
              c.template = mergedTemplate;
            }
          } else {
            await bumpTemplate.run(e.count, e.lastSeen, c.id);
          }
          merged = true;
          break;
        }
        if (!merged) {
          const row = await insTemplate.get(orgId, masked, e.count, e.sample, e.lastSeen, e.lastSeen);
          candidates.push({ id: row.id, template: masked });
        }
      }
      const over = (await orgTemplateCount.get(orgId)).c - MAX_TEMPLATES_PER_ORG;
      if (over > 0) await evictSmallest.run(orgId, over);
    });
  }
}

function start() {
  pipeline.on('log', onLog);
  flushTimer = setInterval(() => {
    // flush() is async now, so a throw inside it is a rejection: a try/catch around
    // the call would catch nothing and the failure would become an
    // unhandledRejection (non-zero exit under NODE_ENV=test) instead of this line.
    flush().catch((e) => console.error('scout flush error:', e.message));
  }, FLUSH_MS);
  flushTimer.unref();
}

module.exports = { start, flush, mask, templateToPattern, templateFilter, MASK_VALUE };
