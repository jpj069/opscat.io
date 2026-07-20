'use strict';
// Public heartbeat ping endpoint — authenticated solely by the unguessable
// token in the URL (like healthchecks.io), so a one-line curl works from any
// cron job. GET and POST both count as a ping.
const express = require('express');
const { db } = require('./../db');
const { now, sha256, httpError } = require('../util');

const router = express.Router();

const findByToken = db.prepare('SELECT id FROM heartbeats WHERE token_hash = ? AND enabled = 1');
const ping = db.prepare('UPDATE heartbeats SET last_ping_at = ?, alerted_at = NULL WHERE id = ?');

router.all('/heartbeat/:token', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
    return httpError(res, 405, 'use GET or POST');
  }
  const row = findByToken.get(sha256(String(req.params.token || '')));
  if (!row) return httpError(res, 404, 'unknown heartbeat');
  ping.run(now(), row.id);
  res.json({ ok: true });
});

module.exports = router;
