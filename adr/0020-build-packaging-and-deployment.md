# ADR-0020: Build, Packaging, and Deployment

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0002, ADR-0009, ADR-0010, ADR-0017, ADR-0024 |

## Context

CrossEngin's monorepo (per ADR-0024) contains apps (`web`, `marketing`, `docs-site`, `ops`), packages (kernel, ai-architect, integrations, etc.), manifests, infra, and tooling. Building and deploying this stack reliably is its own engineering work — get it wrong and either deployments break frequently or shipping becomes slow enough to throttle the team.

The system spans multiple runtime profiles:

- **Serverless edge:** apps/web Next.js routes on Vercel.
- **Serverless functions:** apps/web API routes on Vercel + Inngest functions.
- **Long-running services:** apps/cdc-shipper, apps/hl7-listener, apps/virus-scanner, GPU inference container — all on Fly Machines.
- **Managed services:** Supabase (Postgres + Storage + Auth + Vault), Typesense Cloud, ClickHouse Cloud, R2 (Cloudflare), Inngest Cloud, Sentry, Better Stack.
- **CDN/WAF:** Cloudflare edge.

Each runtime profile has different deployment cadence, rollback semantics, and observability needs.

The build system also serves two later-stage editions:

- **On-prem** (Year 3+): Helm charts package the kernel + apps for customer Kubernetes clusters.
- **BYOC** (Year 4+): Terraform modules deploy the kernel + apps into customer cloud accounts.

Round 2 set the **closed-source posture**: no public CI artifacts, no public Docker images, no community-facing build documentation.

ADR-0024's monorepo decision uses **pnpm + Turborepo**; this ADR defines the build, test, package, and deploy pipeline on top of that.

## Decision

CrossEngin uses a layered build + deploy stack:

```
┌──────────────────────────────────────────────────────────────┐
│ Source: amoufaq5/CrossEngin monorepo                          │
│   /apps + /packages + /manifests + /infra + /tools            │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│ Build & test: GitHub Actions + Turborepo                      │
│   - Per-PR: typecheck, lint, unit, integration, build         │
│   - Per-PR preview deploys (Vercel + Fly preview machines)    │
│   - Eval gates (AI Architect, compliance pack tests)          │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│ Artifact registry                                              │
│   - Vercel build cache                                         │
│   - GHCR private (apps/cdc-shipper, virus-scanner, hl7,       │
│     BGE inference container)                                   │
│   - Helm charts → private OCI registry (Year 3+)              │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│ Deploy targets                                                 │
│   - Vercel (apps/web, marketing, docs-site, ops)              │
│   - Fly Machines (long-running services)                       │
│   - Supabase / Cloudflare / Typesense / Inngest / ClickHouse  │
│     (managed; configured via Terraform + dashboards)           │
└──────────────────────────────────────────────────────────────┘
```

### Repository structure (recap; cross-link ADR-0024)

```
CrossEngin/
├── docs/                   # vision + ADRs (CC-BY 4.0 subtree)
├── apps/                   # Deployable applications
├── packages/               # Reusable libraries
├── manifests/              # Declarative app packs
├── infra/                  # Terraform + Helm + Docker definitions
├── tools/                  # CLIs + codemods
├── turbo.json              # Turborepo pipeline definitions
├── pnpm-workspace.yaml
└── package.json
```

### Turborepo pipeline

```jsonc
// turbo.json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**", ".turbo/**"]
    },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {},
    "test": { "dependsOn": ["build"] },
    "test:integration": { "dependsOn": ["build"] },
    "test:e2e": { "dependsOn": ["build"] },
    "eval:architect": { "dependsOn": ["build"] }
  },
  "remoteCache": { "enabled": true }
}
```

Turborepo's remote cache (Vercel-hosted) speeds incremental builds. A typo-fix PR builds in <30 seconds; a kernel package change rebuilds dependents in 2-3 minutes.

### Per-PR CI

GitHub Actions workflow `.github/workflows/ci.yml`:

```
jobs:
  install      → pnpm install --frozen-lockfile
  typecheck    → turbo typecheck --filter=...affected
  lint         → turbo lint --filter=...affected
  unit-test    → turbo test --filter=...affected
  build        → turbo build --filter=...affected
  security-scan → gitleaks + pnpm audit + Socket.dev
  integration  → spin up test Postgres + Inngest + Typesense; run integration tests
  e2e-smoke    → Playwright against preview Vercel deploy
  eval         → AI Architect eval suite (only when packages/ai-architect changed)
  compliance   → all compliance pack tests
```

CI gates:

- Typecheck + lint + unit tests must pass.
- Build must succeed.
- Security scan must show 0 Critical / High advisories.
- Integration tests must pass.
- E2E smoke must pass.
- Eval regression > 5% blocks the PR (per ADR-0005).
- Compliance pack tests must pass with no skipped tests on production packs.

PRs run within ~6 minutes for the typo-fix case; ~15 minutes for full-stack changes.

### Per-PR preview deploys

- **apps/web preview:** Vercel automatically deploys every PR to a unique URL (`<pr-num>-<branch>.crossengin.vercel.app`).
- **Fly Machines preview:** for PRs that touch `apps/cdc-shipper`, `apps/hl7-listener`, `apps/virus-scanner`, or `apps/gpu-inference`, a CI job deploys a preview Fly machine.
- **Database for previews:** each preview uses an ephemeral Supabase branch (per Supabase's branching feature). Created on PR open; destroyed on PR close.

### Production deploy

- **Trigger:** merge to `main` branch.
- **Vercel apps:** auto-deploy on `main` push. Atomic deploys (no partial rollout). Rollback = redeploy previous build (1-click).
- **Fly Machines:** deploy via GHA job (`fly deploy --strategy rolling`). Per-app config; rolling deploy with health checks.
- **Database migrations:** Supabase migrations (SQL files in `infra/migrations/`) applied via GHA before app deploy. Manifest-driven DDL flows separately (kernel apply pipeline) per ADR-0003.
- **Inngest functions:** registered on app boot via Inngest's HTTP endpoint; per-tenant variants applied at manifest apply time.
- **Configuration changes:** Terraform-managed (Supabase project config, Cloudflare WAF rules, Typesense collection settings); applied via GHA `terraform apply` on `main` merge.

### Atomic vs. progressive

- **Vercel** is atomic (all-or-nothing per deploy). Tenants either see old or new; no half-state.
- **Fly Machines** is rolling. The kernel API tolerates a brief mixed-version window (clients see either old or new instance).
- **Database** migrations are forward-compatible: each migration must work with the prior app version AND the new app version. Rolling app deploy can finish during the migration window without breaking either version.

### Feature flags

`packages/feature-flags` provides per-tenant + per-user + per-environment feature flag evaluation:

- Backed by `meta.feature_flags` Postgres table (no external vendor v1; consider GrowthBook / LaunchDarkly when scale demands).
- Used for gated rollouts of new manifest sections, new renderer types, AI Architect prompt versions, new compliance packs.
- Audited: every flag toggle for a tenant emits an audit row.

### Rollback strategy

- **App rollback:** Vercel previous deploy + Fly previous machine. ~2 min to swap.
- **Database rollback:** never automatic. Migrations are forward-only. Reverting a bad migration = forward migration that compensates. Pre-migration backup snapshot (Supabase PITR) is the safety net.
- **Manifest apply rollback:** the kernel keeps prior manifests (per ADR-0004 lifecycle); apply the prior manifest to rewind. Destructive manifest changes need careful planning (data may not survive a reverse-DDL).
- **Inngest function rollback:** redeploy the prior version's Inngest function registration. In-flight runs continue under their original version.

### Versioning

- **App versions:** semantic versioning at the monorepo level. `v0.1.0` end of Phase 1; `v0.x` through Year 1; `v1.0.0` at first paying customer.
- **Kernel API versioning:** every API endpoint under `/api/v1/`. Breaking changes go to `/api/v2/` with a deprecation period.
- **Manifest spec versioning:** per ADR-0004 (`manifestVersion: "1.0"` ...).
- **Compliance pack versioning:** per ADR-0012 (semver).
- **SDK versioning** (Year 5+ if a public SDK ships): semver, decoupled from kernel.

### Environments

| Environment | Purpose |
|---|---|
| `local` | Developer laptops; uses Supabase local CLI or shared dev project |
| `preview` | Per-PR ephemeral; Vercel + Fly Machines + Supabase branch |
| `staging` | Persistent pre-production; full stack mirroring production |
| `production` | Per-region (EU-Central v1; ME-UAE Year 2-3; US-East Year 3) |

Staging hosts:

- Internal test tenants (synthetic data only).
- Eval-suite runs.
- Pen-test target (per ADR-0009).
- AI Architect prompt iteration sandbox.

### Secrets and config

- **Vercel env vars** for app secrets (Supabase keys, Sentry DSN, etc.).
- **Fly Machines secrets** for service-specific keys.
- **Supabase Vault** for tenant integration secrets (per ADR-0004).
- **Terraform-managed config:** non-secret config (region, capacity, rate limits) in version-controlled Terraform files.

No secrets in repo. CI enforces via `gitleaks` + custom regex scanner.

### Build artifacts

- **Vercel build cache** stored in Vercel infrastructure (encrypted; Vercel SOC 2).
- **Docker images** (apps/cdc-shipper, hl7-listener, virus-scanner, BGE) published to GitHub Container Registry (private; closed-source posture).
- **Helm charts** (Year 3+) published to a private OCI registry (likely GHCR OCI).
- **Source maps** uploaded to Sentry on every deploy.
- **Generated docs** (apps/docs-site Nextra build) deployed to Vercel.

### On-prem / BYOC packaging (Year 3+)

- **On-prem:** Helm chart `infra/helm/crossengin` packages the kernel + apps. Bundles Postgres + Inngest + Typesense + R2-compatible storage (Minio or customer S3-compatible) + Fireworks-compatible LLM proxy. Customer brings hardware; CrossEngin support delivers via a license server.
- **BYOC:** Terraform module `infra/terraform/byoc` deploys CrossEngin into customer AWS / GCP / Azure account. Control plane (operations + telemetry) runs on CrossEngin infrastructure; data plane runs in customer account. Customer's KMS / VPC.

Both editions reuse 95% of the same code; the deployment shape and configuration differ. Per ADR-0024, both are Year 3+ deliverables.

### Mobile (Capacitor) packaging

Cross-link ADR-0019:

- iOS via Capacitor + Xcode → App Store (Year 3+).
- Android via Capacitor + Gradle → Google Play (Year 3+).
- PWA via standard service worker is the v1 mobile path.

### Documentation site

`apps/docs-site` is built with Nextra (Year 1) and deployed to `docs.crossengin.com` via Vercel. Source comments from `/packages` feed API reference generation. Hand-written guides cover manifest authoring, AI Architect prompts, compliance packs.

### Monorepo discipline

- **No package depends on apps.** apps depend on packages; packages do not import from apps.
- **No circular dependencies** between packages.
- **Public API per package** in `index.ts`; internal modules under `_internal/`.
- **ESLint custom rules** enforce these.

## Alternatives considered

### Option A — Self-hosted CI (GitLab CI or Buildkite on-prem)

- **Pros:** Maximum control over build environment.
- **Cons:** Operational overhead pre-revenue.
- **Why not:** GitHub Actions is the right v1; reconsider when scale or compliance demands.

### Option B — Per-package separate repositories

- **Pros:** Independent versioning.
- **Cons:** Conflicts with ADR-0024 monorepo decision.
- **Why not:** Already decided against.

### Option C — Custom container orchestration on AWS Fargate / GKE / AKS

- **Pros:** More control over runtime.
- **Cons:** Heavy ops for serverless workloads. Fly Machines covers the long-running cases with less overhead.
- **Why not:** Use Vercel + Fly Machines for v1; reconsider when ARR justifies dedicated SRE.

### Option D — Skip on-prem / BYOC pipeline; SaaS only forever

- **Pros:** Simpler pipeline.
- **Cons:** Conflicts with Round 10 decision (on-prem Year 3, BYOC Year 4). Some enterprise + ministry deals require on-prem.
- **Why not:** Decision already made.

### Option E — Continuous deployment to production (no manual promotion)

- **Pros:** Faster feedback loop.
- **Cons:** Inappropriate for compliance-bound workload pre-revenue. Need manifest-apply-style approval gates for production-impacting changes.
- **Why not:** Auto-deploy on `main` merge is our model; PRs are the manual promotion step.

## Consequences

### Positive

- **Fast iteration.** Per-PR previews + Turborepo caching enable rapid feedback.
- **Per-app deployment cadence.** Marketing site can ship 5× daily; apps/web ships on demand; long-running services rolling-deploy without downtime.
- **Forward-compatible migrations** allow rolling deploys without database freeze.
- **One repo, one CI** simplifies mental model.
- **Closed-source artifacts** kept in private registries, consistent with Round 2 posture.

### Negative

- **GitHub Actions cost** at scale. Mitigation: filter `turbo --filter=...affected` cuts noise.
- **Multi-platform deploys** (Vercel + Fly + Terraform + Inngest) require coordinated runbooks. Mitigation: Phase 4 documentation; later automation.
- **Closed-source posture** complicates outside developer contributions. Mitigation: not a v1 concern; Year 5+ at most.
- **Per-region production complexity** increases as Year 2-3 regions go live. Mitigation: Terraform-managed region config; templated GHA per region.

### Neutral

- **Vercel + Fly + GitHub** is the modern serverless stack for TypeScript monorepos.
- **Manual Helm/Terraform packaging** is real engineering work in Year 3+ but expected.

### Reversibility

**Low cost** to swap Vercel for Cloudflare Pages or Netlify; Next.js portable. Migration cost is one deployment-window.

**Moderate cost** to swap Fly Machines for AWS Fargate or Cloudflare Containers. Service-specific configs need rewriting.

**High cost** to abandon the monorepo + Turborepo pipeline. Would require splitting all packages — months of work.

## Implementation notes

- **GHA workflow files** in `.github/workflows/`:
  - `ci.yml` — per-PR pipeline.
  - `deploy-vercel.yml` — auto on `main`.
  - `deploy-fly.yml` — rolling on `main` for apps that changed.
  - `terraform-apply.yml` — config changes (manual approve in Phase 1; auto from Phase 4).
  - `eval-architect.yml` — eval-suite runs.
  - `release.yml` — semver tag + changelog generation.
- **Turborepo remote cache:** Vercel-hosted; team token in GHA secrets.
- **Per-PR Supabase branch:** Supabase CLI in GHA creates `branch-<pr-num>` on open; destroys on close.
- **Fly Machines auto-scaling:** per-service rules; CPU > 70% → scale up; idle 5 min → scale down to min count.
- **Health checks:** every Fly Machines service exposes `/healthz`; Fly rolling deploy blocks on health-check failure.
- **Sentry source-map upload:** automated in deploy job; tied to release tag.
- **Lock file integrity:** `pnpm install --frozen-lockfile` in CI; `pnpm install` only via approved PRs touching `pnpm-lock.yaml`.
- **Cache invalidation:** Turborepo's hash-based caching catches most cases; manual `turbo --force` for edge cases.
- **Branch protection on `main`:** required CI passes; required PR review (founder self-review with explicit checklist while solo); signed commits where harness permits.
- **Release notes:** `release-please` or similar generates changelog from conventional commits.
- **Production access:** Vercel SSO + Fly Machines SSO + Supabase 2FA + Cloudflare 2FA. Yubikey for founder. Year 2 hire adds second principal.
- **Deploy notifications:** Slack channel (or alt) with deploy events + post-deploy health summary.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| GitHub Actions vs. self-hosted runners — at what monthly minute volume does self-hosted save money? Likely Year 3+. | amoufaq5 | Year 2 |
| Per-region deploy orchestration — terraform apply per region run serially or in parallel? Trade-off: speed vs. blast radius. | amoufaq5 | Year 2 |
| On-prem license server design — Year 3 deliverable; what does the license format look like, and how do we enforce term + tenant count? | amoufaq5 | Year 3 |
| Vercel vs. Cloudflare Pages — Cloudflare Pages' edge runtime is improving; at what point is migration cost worth the bandwidth savings? | amoufaq5 | Year 2 |
| Feature flag service evolution — Postgres-backed v1 → GrowthBook / LaunchDarkly when justified. Trigger conditions? | amoufaq5 | Year 2 |
| Release cadence — daily for app code? weekly for kernel package changes? Discrete release windows for compliance-pack changes? | amoufaq5 | Phase 5 |
| Mobile (Capacitor) CI pipeline — when does iOS/Android build cost justify infrastructure? Year 3+. | amoufaq5 | Year 3 |
| Helm chart distribution — public registry (closed-source compatible?) vs. customer-specific signed URLs at delivery. | amoufaq5 | Year 3 |

## References

- ADR-0002 (Multi-tenancy model) — defines per-tenant database scope migrations respect.
- ADR-0009 (Security model) — defines secret management used in deploys.
- ADR-0010 (Multi-region and data residency) — defines per-region deploy targets.
- ADR-0017 (Observability and SLOs) — defines deploy notification + Sentry release tracking.
- ADR-0024 (Repository and migration strategy) — defines monorepo structure.
- Turborepo docs; Vercel Next.js deployment; Fly Machines docs; GitHub Actions docs.
