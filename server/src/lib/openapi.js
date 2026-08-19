'use strict';
/* OpenAPI 3.0 document, derived from the route registry (lib/route-schema.js).
 *
 * Nothing here is written per endpoint: a route appears because it was
 * registered, and its shapes come from the very zod objects that validate the
 * traffic. The document is therefore INCOMPLETE while routes are migrated — and
 * that is the point. An incomplete document that is true beats a complete one
 * that lies; what is missing is counted by scripts/check-api-schema.js so the
 * gap is visible rather than assumed.
 */

const { z } = require('zod');
const config = require('../config');
const { INFO } = require('../version');
const { registeredRoutes } = require('./route-schema');

/** Express ':id' → OpenAPI '{id}'. @param {string} p */
function toOpenApiPath(p) { return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}'); }

/** @param {string} p */
function pathParamNames(p) { return [...p.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]); }

/* Which credential the route accepts. This mirrors the three token families the
 * /v1 surface actually uses (docs/API.md): ock_ api keys, oca_ agent tokens,
 * ocp_ probe keys — plus the browser session for /api. */
const SECURITY_SCHEMES = {
  apiKey: {
    type: 'http', scheme: 'bearer',
    description: 'Organization API key (`ock_…`). Also accepted as `X-Api-Key` or `?key=`.',
  },
  agentToken: {
    type: 'http', scheme: 'bearer',
    description: 'Agent token (`oca_…`) — issued per installed agent.',
  },
  probeKey: {
    type: 'http', scheme: 'bearer',
    description: 'Remote probe key (`ocp_…`) — issued per synthetic probe.',
  },
  mcpToken: {
    type: 'http', scheme: 'bearer',
    description: 'MCP OAuth access token; acts as its user with their membership role.',
  },
  sessionCookie: {
    type: 'apiKey', in: 'cookie', name: 'opscat_sid',
    description: 'Browser session. State-changing requests also need `X-OpsCat-CSRF`.',
  },
};

/** @param {string|undefined} auth */
function securityFor(auth) {
  if (!auth || auth === 'none') return undefined;
  return [{ [auth]: [] }];
}

/* zod → JSON Schema.
 * `io` matters: a request body is described as it is ACCEPTED (before defaults
 * and transforms), a response as it is EMITTED. One setting for both is how a
 * spec starts quietly disagreeing with the wire.
 * @param {any} schema @param {'input'|'output'} io */
function jsonSchema(schema, io) {
  return z.toJSONSchema(schema, { target: 'openapi-3.0', io, unrepresentable: 'any' });
}

/** @param {any} route */
function operationFor(route) {
  /** @type {any[]} */
  const parameters = [];

  const declaredParams = route.params ? (jsonSchema(route.params, 'input').properties || {}) : {};
  for (const name of pathParamNames(route.path)) {
    parameters.push({ name, in: 'path', required: true, schema: declaredParams[name] || { type: 'string' } });
  }

  if (route.query) {
    const q = jsonSchema(route.query, 'input');
    const props = q.properties || {};
    const required = new Set(q.required || []);
    for (const [name, schema] of Object.entries(props)) {
      parameters.push({ name, in: 'query', required: required.has(name), schema });
    }
  }

  /** @type {Record<string, any>} */
  const responses = {};
  for (const [status, schema] of Object.entries(route.responses)) {
    const code = Number(status);
    responses[status] = {
      description: code >= 200 && code < 300 ? 'Success' : 'Error',
      content: { 'application/json': { schema: jsonSchema(schema, 'output') } },
    };
  }

  /** @type {any} */
  const op = {
    summary: route.summary,
    operationId: route.method + toOpenApiPath(route.fullPath)
      .replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')),
    responses,
  };
  if (route.description) op.description = route.description;
  if (route.tags && route.tags.length) op.tags = route.tags;
  if (parameters.length) op.parameters = parameters;
  if (route.body) {
    op.requestBody = { required: true, content: { 'application/json': { schema: jsonSchema(route.body, 'input') } } };
  }
  const security = securityFor(route.auth);
  if (security) op.security = security;
  return op;
}

/** Build the OpenAPI document from everything registered so far. */
function buildOpenApiDocument() {
  /** @type {Record<string, any>} */
  const paths = {};
  for (const route of registeredRoutes()) {
    if (route.internal) continue;
    const p = toOpenApiPath(route.fullPath);
    if (!paths[p]) paths[p] = {};
    paths[p][route.method] = operationFor(route);
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'OpsCat API',
      version: INFO.version || '0.0.0',
      description:
        'Generated from the zod schemas that validate this API at runtime — the server enforces exactly what is '
        + 'described here. Routes still being migrated to schema-first registration are absent rather than guessed at.',
    },
    servers: [{ url: config.baseUrl }],
    components: { securitySchemes: SECURITY_SCHEMES },
    paths,
  };
}

/* ── HTML reference ─────────────────────────────────────────────────────────
 *
 * Server-rendered on purpose: no external script, no CDN, no client-side JS. A
 * docs page that fetches a third-party bundle at view time is blank in any
 * restricted network and one CDN outage away from being blank in public, and it
 * forces a CSP hole for a foreign origin. A self-hosted OpsCat runs in networks
 * nobody described in advance, so it renders its own HTML.
 *
 * This renders the DOCUMENT, not the registry, so the page cannot disagree with
 * the spec it describes. Anyone wanting a richer UI points Scalar, Redoc or
 * Insomnia at /openapi.json. Collapsing is <details>, not script. */

/** @param {unknown} v */
function esc(v) {
  return String(v).replace(/[&<>"]/g, (c) => /** @type {any} */({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[c]);
}

const DOCS_CSS = `
:root{color-scheme:light dark;--fg:#111;--dim:#666;--line:#e3e3e3;--bg:#fff;--code:#f6f6f7}
@media(prefers-color-scheme:dark){:root{--fg:#e8e8e8;--dim:#9a9a9a;--line:#2c2c2e;--bg:#151517;--code:#1e1e21}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem 4rem;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:52rem;margin:0 auto}
h1{font-size:1.6rem;margin:0 0 .25rem}
h2{font-size:1.05rem;margin:2.5rem 0 .75rem;padding-bottom:.35rem;border-bottom:1px solid var(--line)}
.lede{color:var(--dim);margin:0 0 1.5rem}
.op{border:1px solid var(--line);border-radius:8px;padding:.85rem 1rem;margin:.6rem 0}
.sig{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
.m{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;padding:.35rem .5rem;border-radius:4px;color:#fff;background:#666}
.m.get{background:#2563eb}.m.post{background:#16a34a}.m.put,.m.patch{background:#d97706}.m.delete{background:#dc2626}
code,.path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px}
.summary{margin:.5rem 0 0}
.desc{color:var(--dim);margin:.35rem 0 0;font-size:14px}
.meta{color:var(--dim);font-size:12.5px;margin:.5rem 0 0}
table{border-collapse:collapse;width:100%;margin:.6rem 0 0;font-size:13.5px}
th,td{text-align:left;padding:.3rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600}
details{margin:.55rem 0 0}summary{cursor:pointer;font-size:13.5px;color:var(--dim)}
pre{background:var(--code);padding:.75rem;border-radius:6px;overflow:auto;font-size:12.5px;margin:.5rem 0 0}
a{color:inherit}
`;

/** Server-rendered HTML reference for the generated document. @param {any} doc */
function renderDocsPage(doc) {
  const info = doc.info || {};
  const paths = doc.paths || {};

  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(/** @type {any} */(methods))) {
      const o = /** @type {any} */ (op);
      const tag = (o.tags && o.tags[0]) || 'Other';
      const authNames = (o.security || []).flatMap((/** @type {any} */ s) => Object.keys(s));

      const paramRows = (o.parameters || []).map((/** @type {any} */ p) =>
        `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.in)}</td>`
        + `<td>${p.required ? 'required' : 'optional'}</td>`
        + `<td>${esc((p.schema && p.schema.description) || '')}</td></tr>`).join('');

      const bodySchema = o.requestBody
        ? (o.requestBody.content['application/json'] || {}).schema || null : null;

      const responses = Object.entries(o.responses || {}).map(([status, r]) => {
        const content = /** @type {any} */ (r).content;
        const schema = content && content['application/json'] && content['application/json'].schema;
        return `<details><summary>Response <code>${esc(status)}</code></summary>`
          + `<pre>${esc(JSON.stringify(schema || {}, null, 2))}</pre></details>`;
      }).join('');

      const html = `<div class="op"><div class="sig">`
        + `<span class="m ${esc(method)}">${esc(method.toUpperCase())}</span>`
        + `<span class="path">${esc(path)}</span></div>`
        + `<p class="summary">${esc(o.summary || '')}</p>`
        + (o.description ? `<p class="desc">${esc(o.description)}</p>` : '')
        + `<p class="meta">Auth: ${authNames.length ? esc(authNames.join(' or ')) : 'none'}</p>`
        + (paramRows ? `<table><tr><th>Parameter</th><th>In</th><th></th><th>Description</th></tr>${paramRows}</table>` : '')
        + (bodySchema ? `<details><summary>Request body</summary><pre>${esc(JSON.stringify(bodySchema, null, 2))}</pre></details>` : '')
        + responses + `</div>`;

      const list = groups.get(tag) || [];
      list.push(html);
      groups.set(tag, list);
    }
  }

  const sorted = [...groups.entries()].sort(([a], [b]) =>
    (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)));
  const sections = sorted.map(([tag, ops]) => `<h2>${esc(tag)}</h2>${ops.join('')}`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(info.title || 'API')} reference</title><style>${DOCS_CSS}</style></head><body><main>`
    + `<h1>${esc(info.title || 'API')}</h1>`
    + `<p class="lede">${esc(info.description || '')}</p>`
    + `<p class="meta">Machine-readable: <a href="/openapi.json"><code>/openapi.json</code></a>`
    + ` — point Scalar, Redoc or Insomnia at it for a richer UI.</p>`
    + (sections || `<h2>No routes registered yet</h2>`)
    + `</main></body></html>`;
}

module.exports = { buildOpenApiDocument, renderDocsPage };
