'use strict';
// Builds the per-session MCP server for one authenticated principal.
//
// Tools are registered SCOPE- AND ROLE-GATED: a principal that cannot use a tool
// does not see it in tools/list at all. Listing a tool that always fails wastes
// the model's attempts and reads as a broken server.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { TOOLS } = require('./tools');
const sec = require('../security');

const SERVER_NAME = 'opscat';
const SERVER_VERSION = '1.0.0';

// Kept deliberately small (<2 KB). This text is injected at EVERY session start,
// so only genuinely cross-tool rules belong here — per-tool behaviour lives in
// the tool descriptions and annotations, where a host can actually act on it.
const INSTRUCTIONS = `OpsCat is an infrastructure ops platform (log ingestion, event/case engine, synthetic checks, SNMP, incidents, public status page).

Start with opscat_get_dashboard for an overview, then drill down.

Severity is 0-100: >=80 critical, >=60 major, >=40 minor.
Events are deduplicated alerts; a case is the unit of on-call work opened from an event.

Your connection is bound to ONE organization, chosen when it was authorized — every tool is scoped to it and no tool takes an organization argument.

Log searches can return a lot of text: narrow with device and sinceMinutes.`;

const ROLE_RANK = sec.ROLE_RANK;

function toolAvailable(tool, principal) {
  if (!principal.scopes.has(tool.scope)) return false;
  return ROLE_RANK[principal.role] >= ROLE_RANK[tool.role];
}

function createMcpServer(principal) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
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
    }, async (args) => {
      try {
        return tool.handler(args || {}, principal);
      } catch (err) {
        console.error(`[mcp] ${tool.name} failed:`, err && err.message);
        return { content: [{ type: 'text', text: `Tool failed: ${err && err.message}` }], isError: true };
      }
    });
  }

  return server;
}

module.exports = { createMcpServer, SERVER_NAME, SERVER_VERSION, INSTRUCTIONS, toolAvailable };
