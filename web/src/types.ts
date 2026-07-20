// API types — mirror server responses (docs/API.md).

export type Role = 'admin' | 'cto' | 'lead' | 'analyst';
export interface User {
  id: number; email: string; name: string; role: Role;
  color: string; mustChangePassword?: boolean; isSuperAdmin?: boolean;
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
  case: { label: string; id: number; status: string } | null;
}
export interface LogRow { ts: number; device: string; line: string; sev: number; }

export interface CaseRow {
  id: number; label: string; eventId: number | null; name: string; device: string;
  severity: number; status: 'open' | 'assigned' | 'closed'; assigned: AssignedRef | null;
  rootCause: string | null; note: string | null; openedAt: number; closedAt: number | null;
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
  kind: 'agent' | 'snmp' | 'check' | 'heartbeat' | 'source';
  id: number | null; name: string; detail: string; status: string; lastSeen: number | null;
}

export interface IncidentUpdate { ts: number; status: string; message: string; }
export interface Incident {
  id: number; label: string; title: string; severity: number;
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  published: boolean; startedAt: number; resolvedAt: number | null; durationMs: number;
  updates: IncidentUpdate[];
  rca: { summary: string; impact: string; rootCause: string; resolution: string; actions: string };
}

export type CompStatus = 'operational' | 'degraded' | 'partial' | 'major' | 'maintenance';
export interface Component {
  id: number; name: string; group: string; status: CompStatus; uptimePct: string;
  days: { day: string; worst: CompStatus }[];
}

export interface SynthLocation { id: number; city: string; cc: string; kind: 'local' | 'remote'; online: boolean; }
export interface CheckAssertions { status?: number; keyword?: string; jsonPath?: string; jsonValue?: string; }
export interface SynthCheck {
  id: number; type: 'http' | 'icmp' | 'dns' | 'tcp' | 'traceroute'; target: string;
  intervalS: number; timeoutMs: number; enabled: boolean; passing: boolean; locations: number;
  assertions: CheckAssertions | null;
}
export interface SynthResult {
  checkId: number; locationId: number; ts: number; ok: boolean; latencyMs: number | null;
  meta: { status?: number; loss?: number; jitter?: number; hops?: { hop: number; ip: string; ms: number | null }[]; error?: string } | null;
}
export interface SynthSeriesPoint { ts: number; ok: boolean; latencyMs: number | null; }

export interface UserRow {
  id: number; email: string; name: string; role: string; color: string; active: boolean;
  lastSeenAt: number | null;
}
export interface ApiKeyRow {
  id: number; name: string; prefix: string; scopes: string[]; active: boolean;
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
export interface AgentRow {
  id: number; name: string; group: string; hostname: string | null; platform: string | null;
  version: string | null; active: boolean; lastSeenAt: number | null; online: boolean;
}
export type Settings = Record<string, string>;

// ---------------------------------------------------------------- cloud / billing

export interface PlanLimits {
  users: number; retentionDays: number; checks: number; sensors: number;
  snmpTargets: number; agents: number; apiKeys: number;
}
export interface PlanInfo {
  key: string; name: string; priceMonthly: number; priceYearly: number;
  limits: PlanLimits; features: string[];
}
export interface PlansResponse {
  edition: 'community' | 'cloud';
  plans: PlanInfo[];
  auth: { google: boolean; microsoft: boolean; github: boolean; signupsOpen: boolean };
}

export interface BillingUsage {
  users: number; checks: number; sensors: number; agents: number; apiKeys: number; snmpTargets: number;
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
