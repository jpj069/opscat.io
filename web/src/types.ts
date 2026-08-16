// API types — mirror server responses (docs/API.md).

export type Role = 'admin' | 'cto' | 'lead' | 'analyst';
export interface User {
  id: number; email: string; name: string; role: Role;
  color: string; mustChangePassword?: boolean; isSuperAdmin?: boolean;
  // false for a link-invited account that has not set one yet — the app then
  // offers to set a password instead of asking for the current one.
  hasPassword?: boolean;
}
// one organization the signed-in user belongs to (multi-org switcher)
export interface OrgMembership {
  orgId: number; name: string; slug: string; plan: string; role: Role; onboardingDone: boolean;
}
export interface OrgsResponse { activeOrgId: number; orgs: OrgMembership[]; }
export interface AssignedRef { id: number; n: string; i: string; c: string; }

export interface EventRow {
  id: number; name: string; device: string; ip: string | null; target: string | null;
  description: string | null; severity: number; hits: number;
  status: 'active' | 'finished' | 'downgraded';
  firstSeen: number; lastSeen: number; assigned: AssignedRef | null; spark: number[];
}
export interface EventDetail extends EventRow {
  recentLogs: LogRow[];
  timeline: EventTimelineEntry[];
  case: { label: string; id: number; status: string } | null;
}
/** One line of an event's history. `user: null` = the platform acted, not a person. */
export interface EventTimelineEntry {
  ts: number;
  user: AssignedRef | null;
  action: 'detected' | 'assign' | 'downgrade' | 'finish' | 'note' | string;
  detail: string | null;
}
export interface LogRow { ts: number; device: string; line: string; sev: number; }

export interface CaseRow {
  id: number; label: string; eventId: number | null; name: string; device: string;
  severity: number; status: 'open' | 'assigned' | 'closed'; assigned: AssignedRef | null;
  rootCause: string | null; note: string | null; openedAt: number; closedAt: number | null;
  incident: { id: number; label: string } | null;
  durationMs: number;
}

export interface DashboardData {
  sevCounts: { critical: number; high: number; medium: number; low: number; info: number };
  openCases: number; mttrMs: number; logs24: number; events24: number;
  casesByAnalyst: { name: string; i: string; color: string; count: number }[];
}
export interface AnalyticsData {
  volume: { d: string; c: number; h: number; m: number; l: number }[];
  mttrDaily: { d: string; v: number }[];
  topTypes: { n: string; v: number }[];
  topServers: { n: string; v: number }[];
  totals: { events: number; mttrMs: number; resolutionRate: number; notifications: number; notificationsFailed: number };
}

export interface Rule {
  id: number; name: string; enabled: boolean;
  channel: 'email' | 'teams' | 'webhook' | 'slack' | 'telegram' | 'discord' | 'ntfy' | 'pushover';
  triggerName: string | null; severityMin: number; cooldownM: number; recipients: string[];
}
export interface NotificationRow { ts: number; rule: string; event: string; channel: string; ok: boolean; error?: string; }

export interface AssetRow {
  kind: 'agent' | 'snmp' | 'check' | 'heartbeat' | 'container' | 'source' | 'vendor' | 'reputation';
  id: number | null; name: string; detail: string; status: string; lastSeen: number | null;
}

// ---------------------------------------------------------------- vendor monitoring

export type VendorStatus = 'unknown' | 'operational' | 'degraded' | 'partial' | 'major' | 'maintenance';
export type VendorFeedType = 'statuspage' | 'instatus' | 'slack' | 'gcp' | 'aws' | 'heroku' | 'statusio' | 'rss';
export interface VendorRow {
  id: number; slug: string; name: string; feedType: VendorFeedType; feedUrl: string;
  pageUrl: string | null; intervalS: number; enabled: boolean; componentId: number | null;
  status: VendorStatus; lastCheckedAt: number | null; lastError: string | null;
  activeIncidents: number;
}
export interface VendorIncidentRow {
  id: number; remoteId: string; title: string; status: string | null; impact: string | null;
  url: string | null; startedAt: number | null; resolvedAt: number | null; updatedAt: number | null;
}
export interface VendorDetail extends VendorRow {
  components: { name: string; status: string; updatedAt: number }[];
  incidents: VendorIncidentRow[];
}
export interface VendorCatalogEntry {
  slug: string; name: string; feedType: VendorFeedType; feedUrl: string; pageUrl: string;
  domains: string[];
}

export interface IncidentUpdate { ts: number; status: string; message: string; }
export type Impact = 'degraded' | 'partial' | 'major';
export interface IncidentComponent { id: number; impact: Impact; name: string; }
export interface IncidentLink { kind: 'case' | 'event'; refId: number; label: string; }
export interface Incident {
  id: number; label: string; title: string; severity: number;
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  published: boolean; startedAt: number; resolvedAt: number | null; durationMs: number;
  assigneeId: number | null; assignee: string | null;
  components: IncidentComponent[];
  links: IncidentLink[];
  updates: IncidentUpdate[];
  rca: { summary: string; impact: string; rootCause: string; resolution: string; actions: string };
}

export interface StatusReportRow { ts: number; component: string | null; message: string | null; }
export interface StatusReportsResponse { total: number; reports: StatusReportRow[]; }

// GET /api/admin/status-pages. `resolved` is the SAME object the public page
// renders with (server/src/lib/status-branding.js brandingFor) — the admin
// preview reads it instead of re-deriving the palette, so the preview cannot
// drift away from the page it previews.
export interface StatusBrandingAsset { mime: string; updatedAt: number }
export interface StatusBrandingResolved {
  theme: 'dark' | 'light';
  palette: { bg: string; surface: string; border: string; borderStrong: string;
    text: string; heading: string; muted: string; faint: string; field: string; okStrip: string };
  accent: string; accentDark: string; accentInk: string;
  logoUrl: string; faviconUrl: string; faviconMime: string;
  description: string; supportUrl: string; legalUrl: string;
  hidePowered: boolean; customCss: string;
}
export interface StatusDnsRecord { host: string; type: string; value: string }
export interface StatusPage {
  id: number; slug: string; name: string; isDefault: boolean;
  published: boolean; visibility: 'public' | 'private';
  url: string; accessToken: string | null;
  domain: string; domainVerifiedAt: number | null;
  dns: { challenge: StatusDnsRecord; routing: StatusDnsRecord } | null;
  accent: string; theme: 'dark' | 'light'; description: string;
  supportUrl: string; legalUrl: string; hidePowered: boolean; customCss: string;
  componentIds: number[] | null;   // null = every component of the org
  logo: StatusBrandingAsset | null;
  favicon: StatusBrandingAsset | null;
  resolved: StatusBrandingResolved;
}
export interface StatusPagesResponse {
  pages: StatusPage[];
  limits: { canWhitelabel: boolean; canCustomCss: boolean;
    canCustomDomain: boolean; canMultiPage: boolean };
  maxAssetBytes: number;
  maxCssBytes: number;
  defaultAccent: string;
}

export type CompStatus = 'operational' | 'degraded' | 'partial' | 'major' | 'maintenance';
export interface Component {
  id: number; name: string; group: string; status: CompStatus; ownerId: number | null;
  uptimePct: string;
  days: { day: string; worst: CompStatus }[];
}

export interface SynthLocation {
  id: number; city: string; cc: string;
  kind: 'local' | 'customer' | 'managed';
  region: string | null; isPremium: boolean; booked: boolean;
  provider: string | null; nodeStatus: 'provisioning' | 'online' | 'draining' | 'dead' | null;
  online: boolean;
}
export interface CloudCredential {
  id: number; provider: 'aws' | 'gcp'; label: string; hint: string | null;
  createdAt: number; lastUsedAt: number | null;
}
export interface CatalogEntry { code: string; city: string; cc: string; region: string; }
export interface ProviderCatalog { catalog: { aws: CatalogEntry[]; gcp: CatalogEntry[] }; instanceClasses: string[]; }
export interface CheckAssertions { status?: number; keyword?: string; jsonPath?: string; jsonValue?: string; }
export interface SynthCheck {
  id: number; type: 'http' | 'icmp' | 'dns' | 'tcp' | 'traceroute'; target: string;
  intervalS: number; timeoutMs: number; enabled: boolean; passing: boolean; locations: number;
  locationIds: number[]; // empty = all agents incl. future
  assertions: CheckAssertions | null;
}
export interface SynthResult {
  checkId: number; locationId: number; ts: number; ok: boolean; latencyMs: number | null;
  meta: { status?: number; loss?: number; jitter?: number; hops?: { hop: number; ip: string; ms: number | null }[]; error?: string } | null;
}
export interface SynthSeriesPoint { ts: number; ok: boolean; latencyMs: number | null; }
export interface SynthHistoryEntry {
  checkId: number;
  buckets: { s: 'ok' | 'warn' | 'bad' | 'na'; ms: number | null }[];
  uptimePct: number | null;
}
export interface SynthHistory { since: number; bucketMs: number; checks: SynthHistoryEntry[]; }

// ---------------------------------------------------------------- reputation
// Blocklist monitoring. `status` is what a table row renders from; note that
// `unknown` means a list could not be queried — explicitly NOT the same as clean.
export type ReputationTier = 'critical' | 'standard' | 'informational';
export type ReputationStatus = 'listed' | 'informational' | 'clean' | 'unknown' | 'pending';
// One episode of being listed. `firstSeen` is why reputation has its own tables:
// "on Spamhaus since the 3rd" is the first question after a listing, and it
// cannot be recovered from a series of samples. `resolvedAt` non-null = delisted.
export interface ReputationListing {
  name: string; zone: string; tier: ReputationTier; codes: string[]; url: string | null;
  // null = the asset itself is listed. Otherwise the mail server behind one of
  // its MX records, e.g. "mail4.link11.com [85.131.131.20]" — a different problem
  // with a different fix, so it is never merged with the domain's own verdict.
  subject: string | null;
  firstSeen: number; lastSeen: number; resolvedAt: number | null;
}
// One mail server behind a domain's MX records. `provider` non-null means it is
// delegated to a mail platform (Microsoft 365, Google Workspace …) and is NOT
// queried: a DNSBL is consulted by the receiving server against the SENDING
// address, and a cloud MX only accepts — a listing there is neither actionable
// nor meaningful for deliverability, and querying it would spend the address
// budget that the org's own relays need.
export interface ReputationMxHost {
  host: string; ip: string | null; provider: string | null;
  listed: number; covered: boolean;
}
export interface ReputationAsset {
  id: number; target: string; kind: 'ip' | 'domain' | null; rdns: string | null;
  enabled: boolean; intervalS: number; status: ReputationStatus;
  worstTier: ReputationTier | null;
  listings: ReputationListing[];        // currently open only; history has its own endpoint
  policy: string[]; unavailable: string[]; errored: string[];
  zonesQueried: number | null; zonesTotal: number | null;
  error: string | null; lastCheckedAt: number | null; lastDurationMs: number | null;
  mxHosts: ReputationMxHost[];   // domain assets only
}
export interface ReputationCoverage {
  queried: number | null;   // lists that actually answered
  total: number | null;     // lists we try for this kind (31 ip / 8 domain)
  unavailable: number;      // refused/timed out — why a verdict may be partial
}
export interface ReputationZone { name: string; zone: string; tier: ReputationTier }
// The curated catalog, GET /api/reputation/zones. Static config — fetched once
// and diffed against an asset's findings to render every list's state.
export interface ReputationZones { ip: ReputationZone[]; domain: ReputationZone[] }

// SPF discovery: GET the senders out of a domain's SPF record instead of asking
// the operator to transcribe them. `source` says which mechanism produced the
// candidate (`ip4`, `a:mail01.example.com`, `mx:…`, `domain`).
export interface SpfCandidate {
  target: string; kind: 'ip' | 'domain'; source: string; alreadyMonitored: boolean;
}
// A third-party `include:` — the provider's shared pool, thousands of addresses
// they monitor themselves. Shown so the delegation is visible, never offered as
// an asset. `lookups` is what it costs against the RFC 7208 budget of 10.
export interface SpfPool { include: string; via: string; lookups: number }
export interface SpfRange { range: string; via: string }
export interface ReputationDiscovery {
  domain: string;
  spf: string | null;
  lookups: { used: number; limit: number; permerror: boolean };
  candidates: SpfCandidate[];
  pools: SpfPool[];
  ranges: SpfRange[];     // CIDR blocks wider than /32 — not queryable per address
  warnings: string[];
  queries: number;
}
export interface BulkAddResult {
  added: string[];
  skipped: { target: string; reason: string }[];
}

export interface ReputationOverview {
  total: number; ip: number; domain: number;
  listed: number; informational: number; clean: number; unknown: number; pending: number;
  // per kind: the denominators differ, so a single merged number would lie
  coverage: { ip: ReputationCoverage; domain: ReputationCoverage };
}

export interface UserRow {
  id: number; email: string; name: string; role: string; color: string; active: boolean;
  lastSeenAt: number | null;
  // invited but never activated — an unused, unexpired activation link is out there
  pending?: boolean;
}
export interface ApiKeyRow {
  id: number; name: string; prefix: string; scopes: string[]; active: boolean;
  createdAt: number; lastUsedAt: number | null;
}
export interface McpConnection {
  clientId: string; name: string; scopes: string[];
  createdAt: number; lastUsedAt: number | null;
}
export interface SnmpTarget {
  id: number; name: string; host: string; port: number; version: string;
  oids: { oid: string; label: string }[]; intervalS: number; enabled: boolean;
  lastStatus: string | null; lastSeenAt: number | null;
  v3User?: string | null; v3Level?: string | null;
}
export interface HeartbeatRow {
  id: number; name: string; intervalS: number; graceS: number; enabled: boolean;
  lastPingAt: number | null; status: string;
}
export interface MaintenanceWindow {
  id: number; name: string; startsAt: number; endsAt: number; active: boolean;
}
export interface AgentRow {
  id: number; name: string; group: string; hostname: string | null; platform: string | null;
  version: string | null; active: boolean; autoUpdate: boolean; lastSeenAt: number | null; online: boolean;
}
export type Settings = Record<string, string>;

// ---------------------------------------------------------------- log pipeline

export interface PipelineBucket { bucket: number; lines: number; bytes: number; events: number; }
export interface PipelineStats {
  range: '24h' | '7d' | '30d'; step: number;
  buckets: PipelineBucket[];
  totals: { lines: number; bytes: number; events: number };
}
// custom rule as stored (org_settings key 'classifiers'); builtin rows use the same shape.
// `enabled: false` = DRAFT: stored, listed and dry-runnable, but out of the chain.
// Absent means live — rules written before drafts existed keep classifying.
export interface ClassifierRule {
  pattern: string; flags?: string; name: string; severity: number; targetGroup?: number | null;
  enabled?: boolean;
}
// what a rule WOULD have done over the stored logs (POST .../dryrun)
export interface DryRun {
  hours: number; scanned: number; matched: number;
  shadowed: number; takeover: number; fresh: number;
  events: number; cases: number;
  samples: { ts: number; device: string; line: string; target: string | null;
    replaces: { name: string; source: string } | null }[];
  truncated: boolean; timedOut: boolean;
  // scout dry-run only: the regex the server generated from the template
  pattern?: string; captureGroup?: number | null; tooLong?: boolean;
}
export interface ClassifiersResponse { builtin: ClassifierRule[]; custom: ClassifierRule[]; }
export interface ScoutTemplate {
  id: number; template: string; count: number; sample: string | null;
  status: 'pending' | 'approved' | 'dismissed';
  suggestion: { name: string; severity: number; skip: boolean; reason: string } | null;
  firstSeen: number; lastSeen: number;
}
export interface ClassifyTestResult {
  match: { name: string; severity: number; target: string | null;
    source: 'custom' | 'builtin' | 'syslog'; pattern: string | null } | null;
  caseThreshold: number;
}

// ---------------------------------------------------------------- cloud / billing

export interface PlanLimits {
  users: number; retentionDays: number; checks: number; sensors: number;
  snmpTargets: number; agents: number; apiKeys: number; ingestLinesPerDay: number;
}
export interface PlanInfo {
  key: string; name: string; priceMonthly: number; priceYearly: number;
  limits: PlanLimits; features: string[];
}
export interface PlansResponse {
  edition: 'community' | 'cloud';
  plans: PlanInfo[];
  auth: { google: boolean; microsoft: boolean; github: boolean; signupsOpen: boolean;
    // this instance can send mail at all — no magic-link tab and no invitation without it
    mail: boolean };
}

export interface BillingUsage {
  users: number; checks: number; sensors: number; agents: number; apiKeys: number; snmpTargets: number;
  ingestLinesToday: number;
}
export interface BillingStatus {
  plan: string; planName: string;
  limits: PlanLimits;
  features: string[];
  status: string;
  subscriptionStatus: string | null;
  currentPeriodEnd: number | string | null;
  trialEndsAt: number | string | null;
  hasBilling: boolean;
  billingEnabled: boolean;
  usage: BillingUsage;
}

// ---------------------------------------------------------------- super-admin

export interface Overview {
  orgs: number; activeOrgs: number; users: number; paidOrgs: number;
  logs24h: number; events24h: number; byPlan: { plan: string; c: number }[]; mrrCents: number;
}
export interface SuperAdminOrg {
  id: number; name: string; slug: string; plan: string; status: string;
  subscriptionStatus: string | null; currentPeriodEnd: number | string | null;
  trialEndsAt: number | string | null; stripeCustomerId: string | null;
  userCount: number; checkCount: number; logCount: number; createdAt: number;
}
export interface AuditRow {
  ts: number; org_id: number; action: string; detail: string;
  email: string | null; org_name: string | null;
}

// -------------------------------------------- OpsCat Bridge (docs/BRIDGE.md)
// groups/participants/feed mirror the server's SQLite rows — snake_case.

export interface BridgeRoom {
  id: number; incidentId: number; status: 'open' | 'closed';
  transcription: boolean; createdAt: number; closedAt: number | null;
}
export interface BridgeGroup {
  id: number; room_id: number; name: string; color: string; sort: number;
  created_by: number | null; created_at: number; closed_at: number | null;
}
export interface BridgeParticipant {
  user_id: number; group_id: number | null; connected: number;
  joined_at: number; last_seen: number;
  name: string | null; email: string; color: string | null;
}
export interface BridgeFeedItem {
  id: number; room_id: number; group_id: number | null; user_id: number | null;
  kind: 'system' | 'transcript' | 'insight';
  severity: 'info' | 'notable' | 'critical';
  body: string; meta: Record<string, unknown>; created_at: number;
}
export interface BridgeState {
  room: BridgeRoom | null;
  groups?: BridgeGroup[];
  participants?: BridgeParticipant[];
  livekit?: { url: string; room: string };
  stt?: boolean; // a voice provider is configured (org or platform)
}
