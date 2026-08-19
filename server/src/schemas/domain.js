'use strict';
/* Domain shapes shared by the REST routes and the MCP tools.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * One `events` row had three public descriptions, none of which knew about the
 * others:
 *
 *   routes/ops.js  publicEvent()  → 12 fields (adds ip, target, assigned)
 *   mcp/tools.js   eventShape     → 9 fields, declared separately
 *   mcp/tools.js   the handlers   → the same 9-field mapping written out by
 *                                   hand TWICE, in list_events and get_event
 *
 * Nothing connected them, so renaming a column meant finding four places and
 * the compiler could not tell you which one you missed. That is the drift this
 * module removes — the OpenAPI document is a by-product of fixing it.
 *
 * The MCP projection is DERIVED from the REST one with `.pick()`, deliberately
 * rather than declared beside it: add a field to the REST shape and the MCP
 * subset still holds; RENAME one and it throws instead of the two quietly
 * describing different things. Verified: renaming `hits` here makes
 * mcp/tools.js fail to load with `Unrecognized key: "hits"`.
 *
 * That guarantee is LOAD-TIME only because tools.js reads `McpEventSchema.shape`
 * at module scope. zod validates a pick lazily, on first `.shape` access — a
 * `.pick()` whose result is never touched throws nothing. So do not "simplify"
 * that access away: the shape read is what turns a rename into a crash at boot
 * instead of a wrong answer at runtime.
 *
 * Behaviour is unchanged on purpose. Both surfaces emit exactly the fields they
 * emitted before; only the number of places that decide what those are changed.
 */

const { z } = require('zod');

/**
 * A resolved user reference, as routes/ops.js assignedView() emits it.
 *
 * The short keys are the wire format the UI has always received — `n` name,
 * `i` initials, `c` colour. They are terse because an event list carries one
 * per row; renaming them here would rename them on the wire.
 */
const AssignedSchema = z.object({
  id: z.string(),
  n: z.string().describe('Display name.'),
  i: z.string().describe('Initials, for the avatar chip.'),
  c: z.string().nullable().describe('Avatar colour.'),
}).nullable();

/** The public projection of an `events` row — what routes/ops.js publicEvent() emits. */
const EventSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  device: z.string().nullable(),
  ip: z.string().nullable().optional(),
  target: z.string().nullable().optional(),
  description: z.string().nullable(),
  severity: z.number().int().describe('0-100; >=80 critical, >=60 major, >=40 minor.'),
  hits: z.number().int().describe('How many log lines have folded into this event.'),
  status: z.string().describe('active | finished | downgraded'),
  firstSeen: z.number().describe('Epoch ms — from events.first_seen.'),
  lastSeen: z.number().describe('Epoch ms — from events.last_seen.'),
  assigned: AssignedSchema.optional().describe('Resolved assignee, or null.'),
}).describe('A deduplicated event.');

/** The subset the MCP tools expose. Derived, never re-declared — see the header. */
const McpEventSchema = EventSchema.pick({
  id: true, name: true, device: true, severity: true,
  hits: true, status: true, firstSeen: true, lastSeen: true, description: true,
});

/** The MCP projection of an `events` DB row. The single mapper for both tools. */
function toMcpEvent(e) {
  return {
    id: e.id, name: e.name, device: e.device, severity: e.severity, hits: e.hits,
    status: e.status, firstSeen: e.first_seen, lastSeen: e.last_seen, description: e.description,
  };
}

module.exports = { AssignedSchema, EventSchema, McpEventSchema, toMcpEvent };
