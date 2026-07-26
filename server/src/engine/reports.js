'use strict';
// Downdetector-style user reports: visitors of the public status page can
// report a problem; when reports in the last 15 minutes reach the org's
// threshold, raise ONE user_reports_spike event (re-raised at most every
// 10 minutes while the spike lasts) — often the earliest outage signal.
const { db, getOrgSetting } = require('../db');
const { now } = require('../util');
const pipeline = require('./pipeline');

const WINDOW_MS = 15 * 60 * 1000;
const REALERT_MS = 10 * 60 * 1000;

const countRecent = db.prepare(
  'SELECT org_id, COUNT(*) c FROM status_reports WHERE ts >= ? GROUP BY org_id');
const countGridRecent = db.prepare(
  'SELECT slug, COUNT(*) c FROM vendor_reports WHERE ts >= ? GROUP BY slug');

const alertedUntil = new Map(); // orgId -> ts until which the current spike is considered reported
const gridAlertedUntil = new Map(); // vendor slug -> ts (public grid community reports)

const GRID_WINDOW_MS = 60 * 60 * 1000;
const GRID_THRESHOLD = 5;

function tick() {
  const t = now();
  for (const row of countRecent.all(t - WINDOW_MS)) {
    const threshold = Math.max(1, parseInt(getOrgSetting(row.org_id, 'status_reports_threshold', '5'), 10) || 5);
    if (row.c < threshold) continue;
    if ((alertedUntil.get(row.org_id) || 0) > t) continue;
    alertedUntil.set(row.org_id, t + REALERT_MS);
    pipeline.ingestEvent({
      name: 'user_reports_spike', device: 'status-page', target: null,
      severity: row.c >= threshold * 3 ? 85 : 75,
      description: `user_reports_spike — ${row.c} user reports on the status page in 15 min (threshold ${threshold})`,
    }, 'reports', false, row.org_id);
  }
  // community reports on the public vendor grid — surfaced to the platform org
  // (org 1): the crowd often notices before the vendor's status page does
  for (const row of countGridRecent.all(t - GRID_WINDOW_MS)) {
    if (row.c < GRID_THRESHOLD) continue;
    if ((gridAlertedUntil.get(row.slug) || 0) > t) continue;
    gridAlertedUntil.set(row.slug, t + REALERT_MS);
    pipeline.ingestEvent({
      name: 'vendor_reports_spike', device: row.slug, target: null,
      severity: row.c >= GRID_THRESHOLD * 3 ? 80 : 70,
      description: `vendor_reports_spike ${row.slug} — ${row.c} community reports on the public grid in 60 min`,
    }, 'reports', false, 1);
  }
}

function start() {
  const iv = setInterval(tick, 60 * 1000);
  iv.unref();
}

module.exports = { start, tick };
