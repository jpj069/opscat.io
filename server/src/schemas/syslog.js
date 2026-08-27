'use strict';
/* Shapes for the Syslog Collector API (routes/syslog.js).
 *
 * Same contract as schemas/ops.js: the schema DESCRIBES, the handler keeps
 * deciding. A field the handler validates is documented and lenient here, so
 * the runtime accepts exactly what it accepted before the schema existed.
 *
 * One thing is specific to this module: `key` appears in exactly one response
 * shape, and only on the two operations that mint it. Everything that merely
 * READS an endpoint returns `keyPrefix` — the first twelve characters, enough
 * to match a credential against a screenshot and useless as a credential.
 */
const { z } = require('zod');

const handled = (meta) => z.unknown().optional().meta(meta);
const handledRequired = (meta) => z.unknown().meta(meta);

const ErrorResponse = z.object({ error: z.string() });
const OkResponse = z.object({ ok: z.literal(true) });
const IdParam = z.object({ id: handledRequired({ type: 'string', description: 'Endpoint id.' }) });

const Snippet = z.object({
  label: z.string(),
  text: z.string(),
  lang: z.string(),
});

/** flavour → blocks. Open-ended on purpose: a flavour is added by the generator. */
const Snippets = z.record(z.string(), z.array(Snippet));

const Endpoint = z.object({
  id: z.number(),
  name: z.string(),
  peerPublicKey: z.string().nullable().meta({
    description: 'Tunnel mode: the relay\'s WireGuard PUBLIC key. Not a secret — it is in '
      + 'the customer\'s own config file. The private half never reaches OpsCat.',
  }),
  tunnelIp: z.string().nullable().meta({
    description: 'Tunnel mode: the inner address allocated to this endpoint. Inside the '
      + 'tunnel this address IS the tenant, so it is unique across every organisation.',
  }),
  mode: z.enum(['collector', 'managed', 'tunnel']).meta({
    description: '`collector` — the customer runs opscat-collector in their own network. '
      + '`managed` — their relay sends TLS straight to the OpsCat gateway and the key '
      + 'travels in each message\'s structured data. `tunnel` — a WireGuard tunnel, where '
      + 'the inner source address is the tenant and no credential travels in the message at '
      + 'all, which is what makes plain UDP usable. The mode decides which configuration is '
      + 'rendered.',
  }),
  devicePrefix: z.string().nullable(),
  enabled: z.boolean(),
  keyPrefix: z.string().nullable().meta({
    description: 'First 12 characters of the collector key, or null if it has been revoked.',
  }),
  /** From `api_keys.last_used_at` — the endpoint has no column of its own. */
  lastSeenAt: z.number().nullable(),
  createdAt: z.number(),
});

const EndpointWithConfig = Endpoint.extend({
  key: z.string().nullable().meta({
    description: 'The full collector key. Present ONLY in the response that mints it — '
      + 'creation and rotation. Never retrievable afterwards.',
  }),
  snippets: Snippets,
});

const CreateBody = z.object({
  name: handledRequired({ type: 'string', maxLength: 100, description: 'What this endpoint is called. Becomes the log `source` of every line it ingests.' }),
  mode: handled({ type: 'string', enum: ['collector', 'managed', 'tunnel'], description: 'Defaults to `collector`. `managed` and `tunnel` are refused when the instance has not configured them.' }),
  peerPublicKey: handled({ type: 'string', description: 'Required for `tunnel`: the relay\'s WireGuard public key (44 base64 characters).' }),
  devicePrefix: handled({ type: 'string', maxLength: 32, description: 'Prepended to every device name from this endpoint, e.g. "fra-".' }),
  collectorHost: handled({ type: 'string', maxLength: 255, description: 'Address of the collector as the relay will reach it — used only to render the snippets.' }),
});

const PatchBody = z.object({
  name: handled({ type: 'string', maxLength: 100 }),
  mode: handled({ type: 'string', enum: ['collector', 'managed', 'tunnel'] }),
  peerPublicKey: handled({ type: 'string', description: 'Replace the peer key, e.g. after the relay was rebuilt.' }),
  devicePrefix: handled({ type: ['string', 'null'], maxLength: 32 }),
  enabled: handled({ type: 'boolean' }),
});

const ThroughputQuery = z.object({
  days: handled({ type: 'number', description: 'How many days back, 1-90. Defaults to 14.' }),
});

const Throughput = z.object({
  days: z.number(),
  source: z.string().meta({ description: 'The `logs.source` this was read under — the endpoint\'s name.' }),
  buckets: z.array(z.object({
    day: z.number().meta({ description: 'UTC midnight of the day, in milliseconds.' }),
    lines: z.number(),
  })).meta({ description: 'Only days that HAVE lines. A gap is a day with none.' }),
});

const ConfigQuery = z.object({
  collectorHost: handled({ type: 'string', description: 'Address to render into the relay snippets.' }),
});

/** What the collector itself asks for at boot — see routes/ingest.js. */
const CollectorConfig = z.object({
  endpointId: z.number(),
  name: z.string(),
  devicePrefix: z.string().nullable(),
  enabled: z.boolean(),
  batchMax: z.number(),
  flushMs: z.number(),
});

/** What the tunnel gateway reconciles its WireGuard interface against. */
const TunnelPeers = z.object({
  net: z.string().meta({ description: 'The inner network, e.g. 10.79.0.0/16.' }),
  peers: z.array(z.object({
    endpointId: z.number(),
    ip: z.string(),
    publicKey: z.string(),
  })).meta({ description: 'Public keys and addresses only — nothing here is secret.' }),
});

const TunnelLogsBody = z.object({
  sourceIp: handledRequired({ type: 'string', description:
    'The INNER source address the packet arrived from. Asserted by the gateway, which is '
    + 'trusted infrastructure; the tenant is resolved from it server-side so the gateway '
    + 'never holds any tenant\'s credential.' }),
  logs: handledRequired({ type: 'array', description: 'Same shape and 500-line cap as /v1/ingest/logs.' }),
});

module.exports = {
  ErrorResponse, OkResponse, IdParam, Snippet, Snippets,
  Endpoint, EndpointWithConfig, CreateBody, PatchBody, ConfigQuery, CollectorConfig,
  ThroughputQuery, Throughput,
  TunnelPeers, TunnelLogsBody,
};
