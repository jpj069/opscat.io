'use strict';
// The MCP endpoint: POST/GET/DELETE /mcp (Streamable HTTP, MCP 2025-11-25).
//
// Pipeline:  origin guard → bearer auth → transport
//               403           401/403      200 / 404 / 500

const path = require('path');
const { Router } = require('express');
const config = require('../config');
const { requireMcpAuth } = require('../mcp/auth');
const { createMcpServer } = require('../mcp/server');
const { McpSessionStore, mcpOriginGuard, handleMcpRequest } = require('../mcp/http-session');

const router = Router();
const SESSIONS = new McpSessionStore('mcp');

// Agent-facing tool reference, pointed at by the RFC 9728 metadata's
// `resource_documentation`. It lives next to the MCP code rather than in
// marketing/, which the community sync strips — a self-hosted instance must
// serve its own tool reference too.
const LLMS_TXT = path.join(__dirname, '..', 'mcp', 'llms.txt');

router.get('/mcp/llms.txt', (_req, res) => {
  res.type('text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(LLMS_TXT);
});

// Browser origins allowed to drive the endpoint. A native MCP client sends no
// Origin at all and is unaffected; this only constrains browser-based clients.
const ALLOWED_ORIGINS = [config.baseUrl, 'https://claude.ai', 'https://claude.com'];

router.all('/mcp', mcpOriginGuard(ALLOWED_ORIGINS), requireMcpAuth, async (req, res) => {
  await handleMcpRequest(req, res, {
    label: 'mcp',
    store: SESSIONS,
    createServer: (principal) => createMcpServer(principal),
  });
});

module.exports = router;
