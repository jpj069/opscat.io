// Type definitions for @opscat/sdk 0.1.0

export interface OpsCatOptions {
  /** Base URL of the OpsCat server, e.g. "https://opscat.io". */
  endpoint: string;
  /** Ingest API key (Bearer token), e.g. "ock_...". */
  apiKey: string;
  /** Default device/service name attached to logs & events. */
  device?: string;
  /** Auto-flush interval in ms (default 3000). Set 0 to disable the timer. */
  flushIntervalMs?: number;
  /** Max log entries per batch, 1..500 (default 100). */
  maxBatch?: number;
  /** Max queued items before drop-oldest kicks in (default 5000). */
  maxQueue?: number;
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
  /** Backoff delays (ms) between retries (default [1000, 4000, 10000]). */
  retryDelays?: number[];
  /** Called with any transport/queue error. Never throws into your code. */
  onError?: (err: Error) => void;
  /** Custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
}

export interface LogOptions {
  /** Syslog severity 0..7 (default 6). */
  sev?: number;
  /** Override the default device for this line. */
  device?: string;
  /** Arbitrary structured metadata (stored as JSON). */
  meta?: Record<string, unknown>;
  /** Timestamp in unix ms (or seconds); defaults to now. */
  ts?: number;
}

export interface EventInput {
  name: string;
  /** Event severity 0..100 (default 50). */
  severity?: number;
  device?: string;
  target?: string;
  description?: string;
  ip?: string;
  ts?: number;
}

export default class OpsCat {
  constructor(options: OpsCatOptions);
  log(line: string, opts?: LogOptions): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  critical(msg: string, meta?: Record<string, unknown>): void;
  event(ev: EventInput): void;
  /** Patch console.* to also ship to OpsCat. Returns a restore function. */
  captureConsole(targetConsole?: Console): () => void;
  restoreConsole(): void;
  /** Force-send the queue. Never rejects. */
  flush(): Promise<void>;
  /** Flush + stop timers/listeners. */
  close(): Promise<void>;
}
