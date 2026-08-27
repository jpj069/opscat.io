'use strict';
/* Schema-first route registration.
 *
 * A route declared here is validated at runtime AND appears in the generated
 * OpenAPI document (lib/openapi.js). Because the same zod object does both, the
 * published spec cannot claim something the server does not enforce — which is
 * the whole reason the spec is generated rather than written.
 *
 * The contract already exists three times in this repo: the route handler, the
 * MCP tool schemas in mcp/tools.js, and the hand-written sdk/js client. Three
 * independent declarations of one shape is three chances to disagree, and
 * `eventShape` in tools.js is already maintained apart from what the routes
 * actually return. Schemas defined once in src/schemas/ and consumed by all
 * three is the point; the OpenAPI file falls out of the same work.
 *
 * Usage:
 *
 *   const router = express.Router();
 *   const route = createRouteRegistrar(router, '/v1');
 *
 *   route({
 *     method: 'post', path: '/ingest/logs',
 *     summary: 'Ingest log lines',
 *     tags: ['Ingest'], auth: 'apiKey',
 *     middleware: [sec.requireApiKey('ingest')],
 *     body: IngestLogsBody,
 *     responses: { 200: IngestLogsResponse, 400: ErrorResponse },
 *   }, async ({ body, req }) => pipeline.ingestLogs(body.logs, req.apiKey.name, req.orgId));
 *
 * The handler returns the RESPONSE BODY. Its status is the single 2xx in
 * `responses`, so "spec says 201, code sends 200" cannot happen.
 *
 * A route that genuinely answers with MORE THAN ONE 2xx — POST /api/oncall/alerts
 * is 201 created, 200 already-live, 202 suppressed, and each means something
 * different to the caller — declares them all, names the default in
 * `successStatus`, and returns `withStatus(202, body)` for the others. The
 * guarantee survives: the status must be one of the declared keys, and the body
 * is validated against THAT status's schema rather than the default one. What is
 * ruled out is not "more than one outcome", it is an undeclared one.
 *
 * Escape hatch: a handler that writes to `res` itself (stream, redirect, a
 * middleware that already answered) returns `undefined`. Nothing is validated
 * on that path — use it only where a JSON body genuinely is not the answer.
 */

const { httpError } = require('../util');

/**
 * @typedef {'get'|'post'|'put'|'patch'|'delete'} HttpMethod
 * @typedef {'none'|'session'|'apiKey'|'agentToken'|'probeKey'|'mcpToken'} RouteAuth
 *
 * @typedef {Object} RouteSpec
 * @property {HttpMethod} method
 * @property {string} path                       Path relative to the router's mount point.
 * @property {string} summary
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {RouteAuth} [auth]                  Drives `security` in the spec. Does NOT authenticate — `middleware` does.
 * @property {Function[]} [middleware]           Express middleware run before validation (auth, rate limits).
 * @property {any} [params]
 * @property {any} [query]
 * @property {any} [body]
 * @property {Record<number, any>} responses     status → zod schema. Exactly one 2xx.
 * @property {number} [successStatus]            Required when more than one 2xx is declared.
 * @property {boolean} [internal]                Keep out of the public spec.
 * @property {string} [contentType]              Media type of the SUCCESS response, when it is not JSON.
 *                                               Only meaningful for a handler that answers through `res`
 *                                               itself and returns undefined (the escape hatch below) —
 *                                               the registrar's own reply is always `res.json`. It exists
 *                                               so a route that serves something else can still be
 *                                               registered instead of staying raw: `/v1/agents/update`
 *                                               and `/v1/synthetics/agent` ship a JavaScript file, and
 *                                               declaring them `application/json` would put a lie in the
 *                                               spec, which is worse than being absent from it.
 *
 * @typedef {RouteSpec & { fullPath: string, successStatus: number }} RegisteredRoute
 */

/* A handler's way of choosing among several declared 2xx codes. Deliberately a
 * tagged object rather than a `res.status(...)` call: going through `res` skips
 * the response validation entirely (that is the escape hatch), and a route with
 * three success shapes is exactly where an unvalidated one is worth least. */
const STATUS_TAG = Symbol('opscat.status');
/** @param {number} status @param {any} body */
function withStatus(status, body) {
  return { [STATUS_TAG]: status, body };
}

/** Thrown by a handler to answer with this repo's error envelope: {error: message}. */
class ApiProblem extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = 'ApiProblem';
    this.status = status;
  }
}

/** @type {RegisteredRoute[]} */
const registry = [];

/** Every route registered so far, in registration order. */
function registeredRoutes() { return registry; }

/** Test-only: drop the registry so a harness can register in isolation. */
function resetRegistry() { registry.length = 0; }

/* Response validation policy.
 *
 * A declared-but-unchecked response schema is exactly the second source of
 * truth this module removes: the handler drifts, the spec keeps promising. So
 * it is checked — loudly where a developer sees it, quietly where a customer
 * would otherwise eat a 500 over a cosmetic mismatch.
 *
 *   dev / test  → throw. The mismatch surfaces in the e2e run.
 *   production  → log and send anyway. OPSCAT_VALIDATE_RESPONSES=1 to throw. */
function strictResponses() {
  return process.env.NODE_ENV !== 'production' || process.env.OPSCAT_VALIDATE_RESPONSES === '1';
}

/** First zod issue as "field: message", for the error body. @param {any} err */
function firstIssue(err) {
  const first = err && err.issues && err.issues[0];
  if (!first) return 'invalid request';
  const where = first.path && first.path.length ? first.path.join('.') : null;
  return where ? `${where}: ${first.message}` : first.message;
}

/** @param {Record<number, any>} responses @param {string} path @param {number} [declared] */
function successStatusOf(responses, path, declared) {
  const ok = Object.keys(responses).map(Number).filter((s) => s >= 200 && s < 300);
  if (!ok.length) {
    throw new Error(`route ${path}: declare at least one 2xx response.`);
  }
  if (ok.length === 1) {
    if (declared !== undefined && declared !== ok[0]) {
      throw new Error(`route ${path}: successStatus ${declared} is not the declared 2xx (${ok[0]}).`);
    }
    return ok[0];
  }
  if (declared === undefined || !ok.includes(declared)) {
    throw new Error(
      `route ${path}: ${ok.join(', ')} are all declared as success. Name the default in ` +
      '`successStatus` and return withStatus(code, body) for the others, so code and spec cannot disagree.');
  }
  return declared;
}

/**
 * Bind a registrar to one Express router and its mount prefix.
 * `basePath` is where the router is mounted in index.js ('/v1', '/api'); it
 * only affects the paths written into the spec.
 * @param {any} router @param {string} basePath
 */
function createRouteRegistrar(router, basePath) {
  /** @param {RouteSpec} spec @param {(input: {params: any, query: any, body: any, req: any, res: any}) => any} handler */
  return function route(spec, handler) {
    const fullPath = `${basePath.replace(/\/$/, '')}${spec.path}`;
    const successStatus = successStatusOf(spec.responses, fullPath, spec.successStatus);

    registry.push(Object.assign({}, spec, { fullPath, successStatus }));

    const wrapped = async (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
      try {
        let params, query, body;
        try {
          params = spec.params ? spec.params.parse(req.params) : undefined;
          query = spec.query ? spec.query.parse(req.query) : undefined;
          body = spec.body ? spec.body.parse(req.body === undefined ? {} : req.body) : undefined;
        } catch (err) {
          return httpError(res, 400, firstIssue(err));
        }

        let result = await handler({ params, query, body, req, res });

        // withStatus(): one of the OTHER declared 2xx codes.
        let status = successStatus;
        if (result && typeof result === 'object' && result[STATUS_TAG] !== undefined) {
          status = result[STATUS_TAG];
          result = result.body;
          if (!spec.responses[status]) {
            throw new Error(
              `${spec.method.toUpperCase()} ${fullPath} answered ${status}, which it does not declare`);
          }
        }

        // Escape hatch: the handler (or its middleware) already answered.
        if (result === undefined) {
          if (!res.headersSent) {
            console.error(`[api] ${spec.method.toUpperCase()} ${fullPath} returned undefined and sent nothing`);
            httpError(res, 500, 'internal error');
          }
          return undefined;
        }

        const schema = spec.responses[status];
        const parsed = schema.safeParse(result);
        if (!parsed.success) {
          const detail = firstIssue(parsed.error);
          if (strictResponses()) {
            throw new Error(
              `response does not match schema for ${spec.method.toUpperCase()} ${fullPath} — ${detail}`);
          }
          console.warn(`[api] response schema mismatch on ${spec.method.toUpperCase()} ${fullPath}: ${detail}`);
        }

        res.status(status).json(result);
        return undefined;
      } catch (err) {
        if (err instanceof ApiProblem) return httpError(res, err.status, err.message);
        return next(err);
      }
    };

    const chain = (spec.middleware || []).concat([wrapped]);
    router[spec.method](spec.path, ...chain);
  };
}

module.exports = { createRouteRegistrar, registeredRoutes, resetRegistry, ApiProblem, withStatus };
