# OpsCat — Open Core Model

OpsCat is **open core**: a fully-featured, self-hostable monitoring platform under
the permissive **Apache-2.0** license, plus a commercially-licensed layer that
powers the hosted **OpsCat Cloud** SaaS.

## Naming (canonical)

- **OpsCat CE — Community Edition** (abbreviation: **CE**): the Apache-2.0 core.
- **OpsCat EE — Enterprise Edition** (abbreviation: **EE**): the commercial
  edition (core + `ee/`-licensed modules).
- **OpsCat Cloud**: the hosted SaaS at opscat.io — a *deployment* of the EE,
  not a third edition. Never call it "Cloud Edition" (its abbreviation would
  collide with CE).
- **Enterprise (plan)**: the top pricing tier — a plan *inside* the EE, not
  the edition. Write "Enterprise plan" when you mean the tier, "EE" when you
  mean the edition.

## Two editions, one codebase

| | CE — Community (default) | EE — Enterprise |
|---|---|---|
| License | Apache-2.0 | Apache-2.0 core + EE (`ee/LICENSE`) |
| Tenancy | Single organization | Multi-tenant (many organizations) |
| Users in multiple orgs + switcher | — (one org) | Yes (self-service new org, invite existing account) |
| First-run onboarding flow | — | Yes (full-screen setup for each new org) |
| Monitoring features | **All** (logs, OTLP, Sentry, events, cases, synthetics, SNMP, agents, alerts, incidents, status page, OpsCat Bridge (war room) incl. AI layer — BYO voice/LLM keys) | All |
| Status-page branding | **All** (logo, favicon, accent, light/dark, links — and the footer is yours to hide, since CE enforces nothing) | Identity on every plan incl. Free; hiding the "Powered by OpsCat" footer from Business |
| Status pages: custom domain · custom CSS · several/private pages | **All** (a self-hoster already serves its own hostname; nothing is enforced) | Custom domain from Pro, custom CSS from Business, additional + private audience pages on Enterprise |
| Plan limits | None — unlimited | Enforced per org (Free / Pro / Business / Enterprise) |
| Billing (Stripe) | — | Yes |
| Super-admin console | — | Yes |
| Social login | GitHub | GitHub + Google + Microsoft (SAML planned) |
| Sensor auto-provisioning | Manual (agent installer) | Automated per plan |
| Selected by | `OPSCAT_EDITION=community` | `OPSCAT_EDITION=cloud` (aliases: `enterprise`, `ee`) |

The edition is chosen at runtime by the `OPSCAT_EDITION` environment variable
(`server/src/edition.js`). In `community` mode (CE), plan enforcement is off and
the single default organization has everything. In `cloud` mode (EE), per-org
plans and the Enterprise modules under `server/src/ee/**` are active. The
internal runtime value for the EE stays `cloud` for compatibility with existing
deployments.

## Where the line is drawn

- **Apache-2.0 core** — the whole platform: `server/src` (except `server/src/ee/**`
  and files headed as EE), `web/`, `sdk/`, `agent/`. Self-host it, fork it, run it
  commercially internally — the Apache license permits it. The **OpsCat Bridge**
  (the incident situation room, `docs/BRIDGE.md`) is core in full — rooms, breakouts,
  monitor wall AND the transcription/insight pipeline; self-hosters bring their own
  voice/LLM provider keys. The hosted Cloud gates it by plan (`bridge`,
  Business+); its concept docs stay private, the code does not.
- **Enterprise Edition** — `server/src/ee/**`, the super-admin / billing / oauth /
  self-service-org (`routes/orgs.js`) routes, and the managed sensor fleet (superadmin
  fleet console + platform credentials). BYO-cloud provisioning (`server/src/providers/`,
  cloud credentials, the wizard) is Apache-2.0 core.
  On the **frontend**, the cloud-only UI is swapped for stubs at publish time so no
  cloud-feature source ships into the Apache-2.0 core: the super-admin console
  (`web/src/pages/SuperAdmin.tsx`), the workspace switcher (`web/src/OrgSwitcher.tsx`,
  → null), the first-run onboarding (`web/src/pages/Onboarding.tsx`, → null) and the
  component gallery (`web/src/pages/ComponentLab.tsx`). These
  are what OpsCat Cloud sells; they are covered by `ee/LICENSE` and live only in the
  private repository (see below). The tester-session telemetry loader
  (`web/src/testify.ts`, → no-op) is stubbed for a different reason — not licensing
  but hygiene: the community core loads no third-party script and contacts no
  external service (see `docs/OPERATIONS.md` §Tester sessions). What *does* stay in the core is the harmless membership
  *plumbing* — the `memberships` table and `GET /api/auth/orgs` session context;
  `POST /api/auth/switch-org` `403`s in community — where a community user simply has one
  membership.

## Two repositories

| Repo | Visibility | Contents |
|---|---|---|
| `jpj069/opscat` | **private** | Source of truth: core **+** EE **+** deploy/ops (marketing site, sensor provisioning, CI deploy, internal docs, agent tooling in `.claude/`) |
| `jpj069/opscat.io` | **public** | The Apache-2.0 community core — a filtered snapshot of the private repo |

All development happens in the private repo. `scripts/publish-community.sh`
exports the tracked tree at `HEAD`, strips every EE/private path, swaps in the
community build files (`Dockerfile.community` → `Dockerfile` etc.) and the
cloud-only UI stubs (super-admin console, org switcher, onboarding), runs a
secret scan, and pushes one snapshot commit to the
public repo ("Sync community core from internal repo @ <sha>"). The EE code
never leaves the private repo; the public repo is always buildable and runs
standalone as the community edition.

**The public repo carries exactly one workflow, and it is generated.** `.github`
is on the exclusion list, and every sync replaces the whole tree — so a file
added to the public repo by hand survives until the next publish and no longer.
`scripts/publish/release-sdk.workflow.yml` is therefore copied in as
`.github/workflows/release-sdk.yml`, and it is what publishes `@opscat/sdk` to
npm on a `v*` tag. It lives there rather than beside the collector release in
the private repo because npm refuses to mint a provenance attestation unless
`package.json`'s `repository` matches — case-sensitively — the repository the
workflow runs in, and `sdk/js/package.json` points at `jpj069/opscat.io`. That
is the right way round: an attestation exists so a stranger can follow it to the
source, and a link into a private repository 404s for every one of them. The
public repo needs an `NPM_TOKEN` secret of its own for the same reason.

A release is therefore two tags in two repositories, one per artefact:

```
git tag v0.2.0 && git push origin v0.2.0     # ghcr.io/jpj069/opscat-collector
scripts/publish-community.sh --tag v0.2.0    # @opscat/sdk (syncs, then tags)
```

`--tag` refuses a tag that already exists and one that disagrees with
`sdk/js/package.json`, because a published npm version is immutable and a moved
tag would silently stop describing what is on the registry.

Keep the exclusion list in `scripts/publish-community.sh` in sync with this
document. Internal planning documents stay private — `docs/BACKLOG.md`,
`docs/BRIDGE.md`, `docs/INCIDENTS-V2.md`, `docs/AUTOMATION-V1.md`,
`docs/ONCALL-V1.md` and `docs/POSTGRES-MIGRATION-PLAN.md`. A planning doc names
problems, plan tiers and attack surfaces that a future change *would* open; none
of that belongs in a public repository, even when the code it discusses is core
— so a new design doc is an exclusion-list entry in the same commit that creates
it. Contributions to the public repo are ported into the private repo
(see `CONTRIBUTING.md`) and flow back out with the next sync.

## Why this split

The features that are hard/undesirable to give away for free in a SaaS business
(multi-tenant billing, the operator console, SSO, managed sensor fleets) are the
EE layer. Everything an SRE team needs to monitor their own infrastructure is in
the open core. Self-hosters get a genuinely complete tool; the hosted service adds
convenience and scale.

## Pricing (Cloud)

See [pricing](https://opscat.io/pricing). Summary:

| Plan | €/mo | Users | Retention | Checks | Sensors | SSO |
|---|---|---|---|---|---|---|
| Community (self-host) | free | ∞ | ∞ | ∞ | ∞ | — |
| Free (Cloud) | 0 | 3 | 7 d | 3 | 1 | — |
| Pro | 29 | 10 | 30 d | 25 | 5 | Google |
| Business | 99 | 30 | 90 d | 100 | ∞ | Google |
| Enterprise | custom | ∞ | 365 d | ∞ | ∞ | SAML/SCIM |

Plan definitions live in `server/src/plans.js` (single source of truth for limits
and feature flags).
