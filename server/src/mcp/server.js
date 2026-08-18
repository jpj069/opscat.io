'use strict';
// Builds the per-session MCP server for one authenticated principal.
//
// Tools are registered SCOPE- AND ROLE-GATED: a principal that cannot use a tool
// does not see it in tools/list at all. Listing a tool that always fails wastes
// the model's attempts and reads as a broken server.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const config = require('../config');
const q = require('../db/shim');
const { TOOLS } = require('./tools');
const sec = require('../security');

const SERVER_NAME = 'opscat';
const SERVER_VERSION = '1.1.0';

// Kept deliberately small (<2 KB). This text is injected at EVERY session start,
// so only genuinely cross-tool rules belong here — per-tool behaviour lives in
// the tool descriptions and annotations, where a host can actually act on it.
const INSTRUCTIONS = `OpsCat is an infrastructure ops platform (log ingestion, event/case engine, synthetic checks, SNMP, incidents, public status page).

Start with opscat_get_dashboard for an overview, then drill down.

Severity is 0-100: >=80 critical, >=60 major, >=40 minor.
Events are deduplicated alerts; a case is the unit of on-call work opened from an event.

Your connection is bound to ONE organization, chosen when it was authorized — every tool is scoped to it and no tool takes an organization argument.

Writes are attributed in the audit log to the person who authorized this connection. Publishing an incident puts it on a PUBLIC status page; deleting a maintenance window resumes alerting immediately. Both ask for confirmation.

Log searches can return a lot of text: narrow with device and sinceMinutes.`;

// SEP-973: one icon on the server implementation, so a client can identify
// OpsCat in a server list. Deliberately NOT one per tool — for a single-product
// surface that is noise, and the tool title already carries the meaning.
const SERVER_ICONS = [{
  src: `${config.baseUrl}/mcp/icon.svg`,
  mimeType: 'image/svg+xml',
  sizes: ['any'],
}];

const ROLE_RANK = sec.ROLE_RANK;

function toolAvailable(tool, principal) {
  if (!principal.scopes.has(tool.scope)) return false;
  return ROLE_RANK[principal.role] >= ROLE_RANK[tool.role];
}

// ── resources ──────────────────────────────────────────────────────────────
// Resources are for context an agent should be able to READ WITHOUT deciding to
// call a tool — the client can attach them to a conversation directly. Two are
// worth exposing: the live public status page for this org, and the currently
// open incidents.

function registerResources(server, principal) {
  server.registerResource(
    'status-page',
    `opscat://org/${principal.orgId}/status`,
    {
      title: 'Public status page',
      description: 'The organization\'s public status page payload: component health, uptime and published incidents.',
      mimeType: 'application/json',
    },
    async (uri) => {
      // Reuse the exact payload the public page renders, so the agent and the
      // public see the same thing. Since schema v18 that payload is per PAGE,
      // and the org's default page is the one this resource has always meant.
      const { statusData } = require('../routes/status');
      const statusPages = require('../lib/status-pages');
      const page = await statusPages.defaultPage(principal.orgId);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          // awaited: statusData became async when routes/status.js moved to the
          // storage shim (Phase 4). JSON.stringify of a native promise is "{}",
          // so without this the resource answers an empty object with a 200.
          text: JSON.stringify(page ? await statusData(page) : { error: 'no status page' }, null, 2),
        }],
      };
    },
  );

  server.registerResource(
    'open-incidents',
    `opscat://org/${principal.orgId}/incidents/open`,
    {
      title: 'Open incidents',
      description: 'Incidents that have not been resolved, with their update history.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const rows = await q.prepare(`SELECT * FROM incidents WHERE org_id = ? AND resolved_at IS NULL
        ORDER BY started_at DESC LIMIT 25`).all(principal.orgId);
      const incidents = await Promise.all(rows.map(async (i) => ({
        id: i.id, label: `INC-${1000 + i.id}`, title: i.title, severity: i.severity,
        status: i.status, published: !!i.published, startedAt: i.started_at,
        // awaited inside the object: JSON.stringify of a pending query renders
        // "{}", so an unawaited `updates` would ship an empty object with a 200
        // — the same failure `statusData` below carries a note about.
        updates: await q.prepare(`SELECT ts, status, message FROM incident_updates
          WHERE incident_id = ? ORDER BY ts DESC LIMIT 10`).all(i.id),
      })));
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ incidents, count: incidents.length }, null, 2),
        }],
      };
    },
  );
}

function createMcpServer(principal) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, icons: SERVER_ICONS },
    { instructions: INSTRUCTIONS },
  );

  for (const tool of TOOLS) {
    if (!toolAvailable(tool, principal)) continue;
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: { title: tool.title, ...tool.annotations },
    }, async (args, extra) => {
      try {
        // ctx carries what a handler needs to talk BACK to the client —
        // elicitation for destructive confirms.
        return await tool.handler(args || {}, principal, { server, extra });
      } catch (err) {
        console.error(`[mcp] ${tool.name} failed:`, err && err.message);
        // The literal annotation is load-bearing, not decoration: the SDK's
        // content type is a union discriminated on `type`, and JS widens
        // `'text'` to `string`, so without it this whole handler fails to match
        // the registerTool signature. It surfaces as a Promise-typed complaint —
        // the handler became async in Phase 4 — which reads exactly like a
        // missed await and is not one.
        return {
          content: [{ type: /** @type {'text'} */ ('text'), text: `Tool failed: ${err && err.message}` }],
          isError: true,
        };
      }
    });
  }

  registerResources(server, principal);

  return server;
}

module.exports = { createMcpServer, SERVER_NAME, SERVER_VERSION, INSTRUCTIONS, toolAvailable, SERVER_ICONS };
