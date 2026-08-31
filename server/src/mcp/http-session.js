'use strict';
// Streamable HTTP plumbing for the MCP endpoint (MCP revision 2025-11-25).
//
// The four invariants below are not theoretical — each is a defect that shipped
// in a production MCP server and had to be fixed afterwards. Keep them together
// in one module so a fix lands once, not once per endpoint.

const { randomUUID } = require('crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const SESSION_IDLE_TTL_MS = 60 * 60 * 1000; // 1h without a request
const SESSION_SWEEP_MS = 10 * 60 * 1000;

// Per-endpoint cache of live sessions.
//
// The idle TTL is measured from the LAST request on a session, not from when it
// was created. Sweeping on creation age tears a session down exactly at the TTL
// no matter how busy it is, forcing a client to re-initialize mid-task.
class McpSessionStore {
  constructor(label, idleTtlMs = SESSION_IDLE_TTL_MS) {
    this.label = label;
    this.idleTtlMs = idleTtlMs;
    this.sessions = new Map();
    this.timer = setInterval(() => this.prune(), SESSION_SWEEP_MS);
    if (this.timer.unref) this.timer.unref();
  }

  // Resolve a live session and mark it just-used (refreshes the idle TTL).
  touch(sessionId) {
    if (!sessionId) return undefined;
    const s = this.sessions.get(sessionId);
    if (s) s.lastSeenAt = Date.now();
    return s;
  }

  // `ref` is the LIVE principal holder, not a copy of the principal. An MCP
  // session outlives the request that opened it, so anything the session closed
  // over is a snapshot — and a snapshot of "which organizations may I act in?"
  // keeps answering yes for one somebody was removed from, until the session
  // idles out. The middleware re-resolves that set on every request; this is
  // what carries the fresh answer into a server object built once.
  add(sessionId, transport, userId, orgId, ref) {
    const t = Date.now();
    this.sessions.set(sessionId, { transport, userId, orgId, ref, createdAt: t, lastSeenAt: t });
  }

  remove(sessionId) { this.sessions.delete(sessionId); }

  get size() { return this.sessions.size; }

  prune() {
    const t = Date.now();
    for (const [id, s] of this.sessions) {
      if (t - s.lastSeenAt > this.idleTtlMs) {
        Promise.resolve(s.transport.close()).catch(() => undefined);
        this.sessions.delete(id);
      }
    }
  }
}

// `initialize` is the one method allowed to open a session. The body may be a
// single message or a batch.
function isInitializeRequest(body) {
  if (Array.isArray(body)) return body.some(isInitializeRequest);
  return !!body && typeof body === 'object' && body.method === 'initialize';
}

// Reject browser requests carrying an untrusted Origin.
//
// The transport requires Origin validation; 2025-11-25 spells out 403 for an
// invalid one. A missing Origin passes — that is what every native MCP client
// (Claude Desktop, Cursor, CLI, server-to-server) sends. The SDK's own
// enableDnsRebindingProtection / allowedOrigins options are deprecated in favour
// of exactly this external middleware.
function mcpOriginGuard(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || allowed.has(origin)) return next();
    res.status(403).json({ error: 'forbidden_origin', error_description: 'Origin not allowed for this MCP endpoint.' });
  };
}

// Handle one request: POST (client→server messages), GET (server→client SSE) and
// DELETE (close session). Expects the principal to already be resolved.
async function handleMcpRequest(req, res, opts) {
  const { label, store, createServer } = opts;
  const principal = req.mcp;
  const sessionId = req.headers['mcp-session-id'];
  const cached = store.touch(sessionId);

  // The token already authenticated the caller; this only stops a session id
  // from being replayed across accounts or organizations. The org test is
  // "does the caller still cover the org this session was opened for?" rather
  // than equality: a multi-org connection whose primary membership was revoked
  // legitimately keeps its other organizations, and equality would end the
  // session instead of shrinking it.
  const covers = (p, orgId) => p.orgId === orgId
    || !!(p.orgs && p.orgs.some((o) => o.id === orgId));
  if (cached && (cached.userId !== principal.user.id || !covers(principal, cached.orgId))) {
    res.status(403).json({ error: 'session_owned_by_other_principal' });
    return;
  }

  // Point the session's holder at THIS request's principal before anything is
  // dispatched. Tool handlers read through it, so a membership revoked a second
  // ago is gone from the next call rather than from the next session.
  const ref = cached ? cached.ref : { current: principal };
  ref.current = principal;

  // Only `initialize` may allocate. Anything else that does not resolve to a
  // live session is answered 404 so the client re-initializes — and, critically,
  // WITHOUT building a transport for it. Guarding this on `sessionId && !cached`
  // instead lets a request carrying NO session header fall through to the
  // allocation path below, where it builds a transport plus a full McpServer
  // that handleRequest then rejects. Because `onsessioninitialized` only fires
  // for `initialize`, such a server is never tracked, `onclose` never runs, and
  // nothing prunes it: an unbounded leak any authenticated client can drive in a
  // loop.
  if (!cached && !isInitializeRequest(req.body)) {
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found — reinitialize' },
      id: null,
    });
    return;
  }

  let active;
  if (cached) {
    active = cached.transport;
  } else {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => store.add(id, transport, principal.user.id, principal.orgId, ref),
    });
    transport.onclose = () => { if (transport.sessionId) store.remove(transport.sessionId); };
    transport.onerror = (err) => console.error(`[${label}] transport error:`, err.message);

    const server = createServer(ref);
    await server.connect(transport);
    active = transport;
  }

  try {
    await active.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[${label}] handleRequest error:`, err instanceof Error ? err.message : err);
    if (!res.headersSent) res.status(500).json({ error: 'mcp_internal_error' });
  }
}

module.exports = { McpSessionStore, isInitializeRequest, mcpOriginGuard, handleMcpRequest };
