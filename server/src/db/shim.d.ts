/* Typed surface for the async storage shim.
 *
 * This file is the FIRST of the three layers described in shim.js, and the one
 * that catches the most: `tsc --checkJs` reads it and reports a missed await as
 * a compile error across every file at once, without executing anything.
 *
 *   const rows = q.all('SELECT …');
 *   rows.map(r => r.id);
 *   //   ^ Property 'map' does not exist on type 'Promise<Row[]>'.
 *
 * The row type is deliberately `any`-valued rather than generic. The codebase
 * reads columns dynamically (`row.org_id`, `row.last_seen_at`), and inventing
 * per-table interfaces would be a second copy of the schema, and the copy that
 * drifts is always the one nobody reruns. What matters here is the PROMISE
 * wrapper, not the column types.
 */
export type Row = Record<string, any>;

/**
 * The result of a write. `changes` is what every at-most-once gate decides on.
 *
 * There is deliberately no `lastInsertRowid`: node-postgres has no such field,
 * and `undefined` written into a foreign key is a NULL nobody notices until a
 * join comes back empty. Use `Stmt.insert()`, which uses `RETURNING id`.
 * Reading it through the shim throws.
 */
export interface RunResult { changes: number; rows?: Row[]; }

/**
 * A prepared statement handle. Lazy — it holds the SQL, not a compiled
 * statement, so requiring a module does not require a database.
 */
export interface Stmt {
  readonly source: string;
  /** SELECT returning one row, or undefined. */
  get(...args: any[]): Promise<Row | undefined>;
  /** SELECT returning many rows. */
  all(...args: any[]): Promise<Row[]>;
  /** INSERT / UPDATE / DELETE. */
  run(...args: any[]): Promise<RunResult>;
  /** INSERT returning the new integer `id`. Not for users/organizations, whose keys are uuids minted in JS. */
  insert(...args: any[]): Promise<number | undefined>;
}

/** Holds the SQL; compiles nothing until a call. */
export function prepare(sql: string): Stmt;

/** Multi-statement DDL (schema.sql, migration files). Takes no parameters. */
export function exec(sql: string): Promise<void>;

/** SELECT returning many rows. For SQL built at runtime; prefer `prepare`. */
export function all(sql: string, ...args: any[]): Promise<Row[]>;
/** SELECT returning one row, or undefined. For SQL built at runtime; prefer `prepare`. */
export function get(sql: string, ...args: any[]): Promise<Row | undefined>;
/** INSERT / UPDATE / DELETE. For SQL built at runtime; prefer `prepare`. */
export function run(sql: string, ...args: any[]): Promise<RunResult>;

/**
 * Runs fn inside a transaction, with the connection carried in
 * AsyncLocalStorage. Nesting joins the outer transaction rather than opening a
 * second one.
 */
export function withTx<T>(fn: () => Promise<T> | T): Promise<T>;

/** The open transaction marker, or null. For assertions, not for control flow. */
export function inTx(): object | null;

/** Wraps a promise so that anything but awaiting it throws. Exported for tests. */
export function strict<T>(p: Promise<T>, what: string): Promise<T>;

/** Takes a row lock on the organisation, gating a per-org cap. Must be inside withTx. */
export function lockOrg(orgId: string): Promise<void>;
