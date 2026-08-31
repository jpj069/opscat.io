'use strict';
// Builds the per-session MCP server for one authenticated principal.
//
// Tools are registered SCOPE- AND ROLE-GATED: a principal that cannot use a tool
// does not see it in tools/list at all. Listing a tool that always fails wastes
// the model's attempts and reads as a broken server.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
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

A connection covers one or more organizations, chosen when it was authorized. With one, tools take no organization argument. With several, EVERY tool takes \`organization\` (the name) and you must pass it — there is no default and nothing is guessed. Call opscat_list_organizations to see them; your role can differ per organization.

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
  // The BEST role held across the connection's organizations. A tool listed on
  // that basis can still be refused for a particular one — which is the check in
  // the dispatcher below, and the reason listing may be the more generous of the
  // two: hiding a tool an admin has in the org they are asking about, because
  // they are an analyst in another, is the worse failure.
  return ROLE_RANK[principal.listRole || principal.role] >= ROLE_RANK[tool.role];
}

// ── which organization is this call about? ─────────────────────────────────
// One place, called once per tool call, so the 42 handlers keep reading
// `p.orgId` and cannot individually get this wrong.
//
// Deliberately WITHOUT a default when the connection covers several: picking
// "the first one" for a call that named none would be a silent write into the
// wrong tenant, and opscat_update_case / opscat_post_incident_status (which puts
// text on a PUBLIC page) are among the tools this would decide for.
//
// Matched on the NAME, because a name is what a model can carry out of a
// conversation and a uuid is not. `organizations.name` is not unique, so the
// slug and the id are accepted as tie-breakers and an ambiguous name is an
// error naming them rather than a guess.
function resolveOrg(principal, named) {
  const orgs = principal.orgs && principal.orgs.length
    ? principal.orgs
    : [{ id: principal.orgId, name: principal.org.name, slug: principal.org.slug, role: principal.role }];
  const list = orgs.map((o) => o.name).join(', ');
  const wanted = String(named == null ? '' : named).trim();

  if (!wanted) {
    if (orgs.length === 1) return orgs[0];
    throw new Error(`This connection covers ${orgs.length} organizations, so `
      + `\`organization\` is required. One of: ${list}`);
  }
  const lower = wanted.toLowerCase();
  const byName = orgs.filter((o) => o.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  const exact = orgs.find((o) => o.slug === wanted || o.id === wanted);
  if (exact) return exact;
  if (byName.length > 1) {
    throw new Error(`"${wanted}" matches ${byName.length} organizations in this connection. `
      + `Use the slug instead: ${byName.map((o) => o.slug).join(', ')}`);
  }
  throw new Error(`This connection does not cover an organization called "${wanted}". `
    + `It covers: ${list}`);
}

// ── resources ──────────────────────────────────────────────────────────────
// Resources are for context an agent should be able to READ WITHOUT deciding to
// call a tool — the client can attach them to a conversation directly. Two are
// worth exposing: the live public status page for this org, and the currently
// open incidents.

// The org-scoped pair, registered once per organization the connection covers.
// `suffix` names which one in the title — with several orgs, three resources all
// called "Public status page" are indistinguishable in a client's list.
function registerOrgResources(server, principal, suffix) {
  server.registerResource(
    `status-page${suffix ? `-${principal.orgId}` : ''}`,
    `opscat://org/${principal.orgId}/status`,
    {
      title: `Public status page${suffix}`,
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
    `open-incidents${suffix ? `-${principal.orgId}` : ''}`,
    `opscat://org/${principal.orgId}/incidents/open`,
    {
      title: `Open incidents${suffix}`,
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

/* The REST contract, as a resource.
 *
 * An agent connected to this MCP server can then read the HTTP API without
 * anyone pasting a URL into a prompt — which is the whole reason the spec is
 * generated rather than written: it is only useful if it is reachable from
 * where the agent already is. Org-INDEPENDENT, so it is registered exactly once
 * however many organizations the connection covers — a second registration
 * under the same name and URI is a duplicate, not a second document.
 *
 * Public information (shapes, never data), so it needs no scope of its own. */
function registerFlatResources(server) {
  server.registerResource(
    'openapi',
    'opscat://openapi',
    {
      title: 'OpenAPI document',
      description: 'The REST API contract, generated from the zod schemas that validate the traffic. '
        + 'Also served unauthenticated at /openapi.json, with a rendered reference at /docs.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(require('../lib/openapi').buildOpenApiDocument(), null, 2),
      }],
    }),
  );
}

/* Takes the session's LIVE principal holder, not a principal.
 *
 * An MCP server object is built once, when the session is opened, and then
 * serves every later request on that session. Everything it closes over is
 * therefore a snapshot — which is fine for "which tools exist" and emphatically
 * not fine for "which organizations may this caller act in", because the answer
 * changes the moment a membership is revoked and the session may live for
 * hours. `ref.current` is repointed at each request's freshly-resolved
 * principal by http-session.js, so a tool call reads the set as it is NOW.
 *
 * Registration-time decisions still read the principal as it was at
 * `initialize` — that only affects which tools are listed and how the argument
 * is described. Nothing is enforced there: every call re-resolves. */
function createMcpServer(principalRef) {
  const ref = principalRef && principalRef.current ? principalRef : { current: principalRef };
  const principal = ref.current;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, icons: SERVER_ICONS },
    { instructions: INSTRUCTIONS },
  );

  // The argument exists only when there is a choice to make. A connection with
  // one organization keeps exactly the tool surface it had before multi-org —
  // no extra parameter to explain, nothing new for a model to get wrong.
  const multi = !!(principal.orgs && principal.orgs.length > 1);
  const orgArg = multi
    ? { organization: z.string().describe(
        `Which organization this call is about. Required — this connection covers: `
        + principal.orgs.map((o) => o.name).join(', ')) }
    : null;

  for (const tool of TOOLS) {
    if (!toolAvailable(tool, principal)) continue;
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: orgArg && !tool.orgless ? { ...orgArg, ...tool.inputSchema } : tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: { title: tool.title, ...tool.annotations },
    }, async (args, extra) => {
      try {
        const a = args || {};
        // `ref.current`, never the captured `principal`: this is the read that
        // makes a revoked membership take effect on the next call instead of at
        // the next session.
        const live = ref.current;
        // Resolve first, then re-check the role AGAINST THAT ORG. `toolAvailable`
        // above answered for the best role anywhere in the connection, which is
        // not a permission to act in the org this call named.
        const org = tool.orgless ? null : resolveOrg(live, a.organization);
        if (org && ROLE_RANK[org.role] < ROLE_RANK[tool.role]) {
          throw new Error(`Your role in ${org.name} is ${org.role}; this needs ${tool.role} or higher.`);
        }
        // The per-call principal. Overriding these three is what lets every
        // handler keep saying `p.orgId` — there is no second place that decides.
        const p = org
          ? { ...live, orgId: org.id, org: { ...live.org, ...org }, role: org.role }
          : live;
        // ctx carries what a handler needs to talk BACK to the client —
        // elicitation for destructive confirms.
        return await tool.handler(a, p, { server, extra });
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

  // One pair of resources per organization. The URI already carried the org id,
  // so this needs no new shape — but with several orgs a single pair would be
  // "the status page", silently meaning one of them.
  for (const o of (principal.orgs && principal.orgs.length
    ? principal.orgs : [{ id: principal.orgId, name: principal.org.name }])) {
    registerOrgResources(server, { ...principal, orgId: o.id, org: { ...principal.org, ...o } },
      multi ? ` (${o.name})` : '');
  }
  registerFlatResources(server);

  return server;
}

module.exports = { createMcpServer, SERVER_NAME, SERVER_VERSION, INSTRUCTIONS, toolAvailable,
  resolveOrg, SERVER_ICONS };
