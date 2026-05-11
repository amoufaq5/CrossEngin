# ADR-0010: Multi-Region and Data Residency

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0002, ADR-0006, ADR-0009, ADR-0014, ADR-0017, ADR-0024 |

## Context

CrossEngin's first region is the UAE / Middle East (Round 2 decision). Supabase has no native UAE region; the closest options are Frankfurt (`eu-central-1`), Mumbai (`ap-south-1`), and Singapore (`ap-southeast-1`). Round 8 picked Frankfurt for Year 1 with the understanding that a UAE-resident-data tenant triggers a different deployment path.

Beyond v1, the geography sequence is **ME → EU (Year 2) → US (Year 3)** (Round 10). Each region adds new compliance overlays (GDPR for EU, HIPAA for US, UAE PDPL when in-country, plus sector-specific rules like 21 CFR Part 11 for US pharma).

Multi-region and residency decisions affect:

- **Database hosting** — which Supabase project a tenant's data lives in.
- **File storage** — which R2 region holds tenant files.
- **LLM and embedding inference** — which provider/region serves AI Architect calls.
- **CDN / WAF** — Cloudflare's edge already covers all our target regions.
- **Backups and DR** — where backups physically live; cross-region replica strategy.
- **Compliance posture** — GDPR / PDPL / HIPAA each demand region-locked guarantees.
- **Tenant-facing UX** — region selection at signup, region migration if a tenant outgrows or relocates.

Getting this right matters because residency is a *trust commitment*. A pharma manufacturer's batch records cannot leave the EU; a UAE ministry's citizen data cannot leave the UAE; a US hospital's PHI cannot leave the US (under most HIPAA-bound contracts). Once we promise it, we must architecturally enforce it.

This ADR defines:

- The region taxonomy CrossEngin uses.
- The data-residency profile attached to each tenant.
- How region choice flows through every data-bearing component (Postgres, R2, LLM, audit logs, backups).
- The migration path when a tenant's residency requirements change.
- The Year-1 → Year-3 geography expansion plan.

## Decision

CrossEngin operates a small set of named regions and attaches a **residency profile** to every tenant. The kernel and integration mesh route data accordingly; cross-region data flow is forbidden unless the tenant opts in.

### Region taxonomy

| Region | Code | Cloud provider region | Year first available |
|---|---|---|---|
| **EU-Central** | `eu-central` | Supabase Frankfurt + R2 EU + Cloudflare EU + Fly EU | Year 1 |
| **EU-West** | `eu-west` | Supabase Ireland | Year 2 (added if EU-Central capacity demands) |
| **US-East** | `us-east` | Supabase Virginia + R2 ENAM | Year 3 |
| **APAC-Singapore** | `apac-sg` | Supabase Singapore | Year 2 (DR replica for EU-Central until Year 3 second-region tenant) |
| **ME-UAE** | `me-uae` | Self-hosted Supabase in UAE (AWS `me-south-1` or G42 / Etihad Atheeb / E& Enterprise) | Year 2-3 (triggered by UAE-resident-data tenant) |
| **GCC-Riyadh** | `gcc-ksa` | TBD (when first KSA tenant signs) | Year 3+ |

Year 1 has one region: EU-Central (Frankfurt). All other regions are either DR-replicas-only or wait for a first tenant to trigger deployment.

### Tenant residency profile

Every tenant has a `residency` setting in `meta.tenants`:

```jsonc
{
  "tenant_id": "t_8f2a9c1b",
  "residency": {
    "profile": "eu-only" | "us-only" | "me-only" | "unrestricted" | "custom",
    "primaryRegion": "eu-central",
    "allowedRegions": ["eu-central", "eu-west"],
    "forbiddenRegions": [],
    "allowedLlmProviders": ["fireworks:eu", "anthropic:eu", "self-hosted-bge:eu"],
    "dataClass": "phi" | "pii_strict" | "pii_basic" | "commercial_sensitive" | "public",
    "establishedAt": "2026-...",
    "validatedBy": "u_..."     // CrossEngin admin who confirmed compliance fit
  }
}
```

The profile drives:

- Which Supabase project hosts the tenant's `t_<id>` schema.
- Which R2 bucket holds tenant files.
- Which LLM providers (ADR-0006) are eligible.
- Where backups are stored (always in the same region by default).
- Whether DR cross-region replica is allowed.

### Default residency profile at v1

The default is `unrestricted` with `primaryRegion = "eu-central"`. Most v1 tenants are commercial entities that don't require residency. Tenants explicitly opt into a stricter profile at signup (or via tenant admin self-service).

Compliance packs auto-tighten residency:

- **HIPAA pack** → minimum profile `us-only` (or `eu-only` with BAA-friendly EU host); LLM providers restricted to those with BAA or zero-retention agreement.
- **UAE PDPL pack** → minimum profile `me-only` requires `me-uae` region (self-hosted UAE Supabase); blocks Fireworks and managed providers outside UAE; mandates self-hosted LLM (Year 3+).
- **EU GMP pack** → minimum profile `eu-only`; allows in-EU LLM providers.

### Tenant-to-region routing

Each Supabase project hosts one or more tenant schemas; the kernel's tenant-routing middleware (ADR-0002) consults `meta.tenants.residency.primaryRegion` to select the connection pool. Per-tenant Postgres roles within each project provide the additional isolation.

For multi-region deployments:

- **Single-region tenant:** all reads/writes go to the primary region. Failover triggers an in-region read replica.
- **Multi-region tenant** (rare; only when explicitly accepted): primary writes to `primaryRegion`; reads can served from any `allowedRegions` replica (eventual consistency).

The CrossEngin kernel does NOT do cross-region writes. If a tenant needs cross-region capability (e.g., a multinational pharma with operations in EU + US), the architecture is "two tenants, one logical organization" — sharing identity via SSO but with separate data stores.

### File storage residency

R2 supports per-bucket jurisdictions. CrossEngin maintains:

| R2 bucket | Region | Use |
|---|---|---|
| `crossengin-files-eu` | EU | Tenant files for EU-resident tenants |
| `crossengin-files-us` | US | Year 3+ |
| `crossengin-files-uae` | UAE | Year 2-3+ (self-hosted S3-compatible in-country) |
| `crossengin-backups-cold` | EU | Cold-tier audit + database backups |

The file integration (ADR-0014) reads `tenant.residency.primaryRegion` to pick the bucket.

### Audit log residency

Audit logs follow tenant data. Per-tenant audit-log mirror (`t_<id>.audit_log_local`) lives in the same Postgres project as the tenant's data. The central `meta.audit_log` is split per-region — each region has its own `meta.audit_log` (no cross-region replication of audit). Internal ops queries across regions go through ClickHouse (ADR-0013), which anonymizes / aggregates as needed.

### LLM residency (cross-link to ADR-0006)

`meta.tenants.residency.allowedLlmProviders` is the source of truth. The provider router (ADR-0006) reads it on every call and selects accordingly. Falling back across residency boundaries is forbidden.

For `me-only` tenants pre-self-hosted-LLM (Year 3-), the AI Architect is unavailable for compliance-graded reasoning — the tenant uses the visual workflow designer + manifest-CLI for changes until self-hosted UAE inference comes online.

### Cross-region replication and DR

- **Year 1:** EU-Central is the sole region. PITR + daily logical backups + Singapore replica for DR.
- **Year 2:** EU-Central (primary) + EU-West (overflow / DR). UAE region added if triggered.
- **Year 3:** US-East goes live for first US tenant. Each region has its own DR replica (EU↔EU-West; US↔ a TBD US-West).
- **DR drills:** quarterly per region. RPO 1 min (PITR), RTO 4 h Year 1 → 1 h Year 2.

### Migration between regions

When a tenant changes residency profile (e.g., signs a HIPAA-bound contract requiring `us-only`), the kernel offers a migration path:

1. Provision a new tenant schema in the target region.
2. `pg_dump` source schema; restore to target.
3. File migration: copy R2 objects from source bucket to target bucket.
4. Audit log migration: copy audit rows for the tenant.
5. Switch routing: `meta.tenants.primaryRegion` updated atomically; in-flight requests drain on the old region.
6. Verify integrity; purge source after 7-day verification window.

Migration is offline (tenant pauses operations) for v1; live migration is a future feature. Estimated downtime per GB of tenant data: ~1 min per GB.

### Region selection UX

Tenants choose at signup:

- **Auto** (default; based on IP geolocation; lands in EU-Central in v1).
- **Manual** (admin picks from available regions; gated by compliance-pack permissions).

Once chosen, region is locked unless the tenant requests migration. The signup flow shows residency implications: "Your data will be stored in Frankfurt, Germany. This complies with GDPR. If your compliance requirements require UAE-resident data, please contact sales."

### Geography expansion plan (per Round 10)

- **Year 1 (Q1-Q4):** EU-Central operational. ME tenants are routed to EU-Central with explicit consent (Frankfurt is closer than US, but not in-region). UAE PDPL Data Officer registration prepared but not filed until first PDPL-bound tenant.
- **Year 2 (Q1-Q2):** EU-West added as DR + overflow. First UAE-resident-data tenant evaluation triggers `me-uae` deployment work; expect 2-3 months of self-hosted-Supabase setup before go-live.
- **Year 2 (Q3-Q4):** `me-uae` operational if a UAE-resident-data contract is signed.
- **Year 3:** US-East operational for first US tenant. HITRUST work begins if a HIPAA-covered-entity customer signs.
- **Year 4+:** GCC-KSA, APAC-Singapore production (currently DR-only), additional EU regions as needed.

## Alternatives considered

### Option A — Single global region for v1 (US East or US West)

Pick US for everyone. Defer multi-region until Year 3.

- **Pros:** Lowest cost per tenant. Simplest operations. Largest Supabase compute capacity.
- **Cons:** Conflicts with Round 2 first-region decision (UAE / ME). EU/UAE tenants pay latency cost (200+ ms). Some compliance-bound EU/ME tenants outright reject US-hosted data.
- **Why not:** Round 2 picked ME-first. EU-Central (Frankfurt) is the closest Supabase region.

### Option B — Multi-region from day one (EU + ME + US simultaneously)

Provision all three regions at v1.

- **Pros:** No expansion friction.
- **Cons:** 3× the operational footprint with no revenue justification. UAE region requires self-hosted Supabase (not a v1 lift for a solo team). Per-region maintenance toil.
- **Why not:** Wait for tenants to drive expansion. Provisioned-empty regions are pure cost.

### Option C — Per-tenant Postgres clusters always (database-per-tenant)

Skip the shared-schema model; every tenant gets its own Postgres.

- **Pros:** Region selection per tenant is trivial.
- **Cons:** ADR-0002 already rejects database-per-tenant for the small-tenant majority. Cost economics fail.
- **Why not:** Schema-per-tenant in regional shared clusters is the right balance.

### Option D — Cloudflare D1 / Workers as the database (edge-distributed by default)

Use Cloudflare's edge SQL.

- **Pros:** Latency-aware data placement globally.
- **Cons:** D1 is SQLite under the hood; the manifest-driven DDL model and OPA Rego policies are Postgres-shaped, not SQLite-shaped. Migration cost is enormous.
- **Why not:** Postgres is the commitment (ADR-0002).

### Option E — Edge proxy with origin-routing (Cloudflare Workers proxying Supabase calls)

Run all Supabase calls through Cloudflare Workers that pick origin region.

- **Pros:** Centralized routing logic.
- **Cons:** Adds a hop. The kernel needs to know the routing decisions anyway for audit + ABAC. The middleware is the right place for routing.
- **Why not:** Origin selection lives in the kernel; Cloudflare handles only CDN + WAF.

### Option F — Bring-your-own-host (BYOC) from v1

Every tenant brings their own Postgres + storage + LLM.

- **Pros:** Maximum residency control.
- **Cons:** BYOC is a Year 4 deliverable (Round 10). SaaS first.
- **Why not:** Wrong v1 model.

## Consequences

### Positive

- **Residency is an explicit, queryable property** of every tenant. Audits ("show me all tenants storing PHI in EU") are SQL queries against `meta.tenants`.
- **Compliance packs drive residency automatically.** Tenants opting into HIPAA / UAE PDPL / EU GMP get correct routing without admin steering.
- **Failover and DR planned per region.** RPO 1 min, RTO 4 h Year 1, 1 h Year 2+.
- **Geography expansion path is explicit.** EU Year 1 → ME Year 2-3 → US Year 3, each gated by tenant demand.
- **No surprise cross-region data flow.** Provider router (ADR-0006) and file integration enforce residency boundaries.

### Negative

- **UAE region cost / complexity.** Self-hosted Supabase in UAE is months of work; the trigger condition is a real customer commitment. Without a contract in hand, this is on-paper only.
- **DR drill cost.** Quarterly drills × N regions = real ops time. Mitigation: automate the drill via Terraform-driven test deployments.
- **Migration downtime.** Offline migration for v1 means tenants accept a brief outage if they move regions. Mitigation: live migration is a Year 2+ feature.
- **Audit log fragmentation across regions.** Querying audit across regions requires going through ClickHouse. Aggregations are clean but per-row drill-down requires a region routing.

### Neutral

- **Single-region for v1** is the operationally simplest choice and matches the actual customer base.
- **Cloudflare WAF + CDN** is region-agnostic and adds latency benefits everywhere.

### Reversibility

**High flexibility within the region model.** Adding regions, adjusting residency profiles, migrating tenants — all are config-level changes.

**Moderate cost to evolve the residency-profile schema.** Migrations to `meta.tenants.residency` need to handle existing rows; default values for new fields handle most cases.

**High cost to swap Supabase as the host.** Region choice is intertwined with the Postgres host choice (ADR-0002). Switching hosts changes the entire region taxonomy.

## Implementation notes

- **Package locations:**
  - `packages/kernel-supabase` — region-aware connection pool selection.
  - `packages/files` — region-aware R2 bucket selection (cross-link ADR-0014).
  - `packages/ai-providers` — region-aware provider selection (cross-link ADR-0006).
  - `infra/terraform/regions/` — one Terraform module per region.
- **Region config:** `meta.regions` table lists active regions, their endpoints, and capacity. Hot-reloadable via admin endpoint.
- **Tenant routing middleware:** middleware in `apps/web/middleware.ts` consults `meta.tenants` on every request to pick the Supabase project + Postgres connection pool.
- **R2 bucket policy:** signed-URL generation includes the bucket region in the URL; clients fetch directly from the regional R2 edge.
- **Backup retention by region:** primary region holds 7-day PITR; cold backups in `crossengin-backups-cold` (EU) for compliance retention. UAE-resident tenants need an in-UAE cold-backup bucket once the region exists.
- **DR runbook (`docs/RUNBOOK_DR.md`):** per-region failover steps, Terraform commands to promote replicas, communication templates for tenants.
- **Migration tool:** `tools/tenant-migrate` runs the seven-step migration above with progress reporting and rollback. Restricted to CrossEngin admin role.
- **Compliance pack hooks:** when a tenant activates a pack with residency implications, the pack's validator checks `tenant.residency`; if incompatible, the apply pipeline rejects the manifest with a clear error.
- **Public status page:** per-region status indicators. A tenant on EU-Central sees only EU-Central status; CrossEngin staff see all regions.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| UAE self-hosted Supabase target: AWS `me-south-1` (Bahrain — closest AWS region) vs. local provider (G42, Etihad Atheeb, E& Enterprise). Trade-offs: latency to UAE, sovereign-data acceptance, cost. | amoufaq5 | Year 2 (when first UAE-resident-data lead pipelines) |
| Live migration vs. offline — what's the engineering cost of live migration with cutover, and at what customer-size does it become required? | amoufaq5 | Phase 5 |
| GCC region — when first KSA / Qatar / Oman tenant signs, do we provision a separate region or accept UAE-region hosting? PDPL-equivalent laws vary by GCC country. | _pending compliance hire_ | Year 2-3 |
| Cross-region read replicas for analytics-only reads — does ClickHouse handle it sufficiently, or do we expose Postgres replicas as well? | amoufaq5 | Phase 5 |
| Per-region pricing — does a tenant pay more for `me-uae` than `eu-central` to cover self-hosted cost? List pricing transparency. | amoufaq5 + commercial hire | Year 2 |
| Sovereign-cloud requirements for ministry tenants — beyond region, ministries may require specific certifications (e.g., UAE TRA certification for telecom data hosts). | _pending compliance hire_ | Year 3 |

## References

- ADR-0002 (Multi-tenancy model) — defines per-tenant Postgres connections that this ADR routes by region.
- ADR-0006 (LLM provider router) — defines the residency-aware provider selection.
- ADR-0009 (Security model) — defines cross-region encryption and key management.
- ADR-0014 (Files and storage) — defines R2 bucket selection per region.
- ADR-0017 (Observability and SLOs) — defines per-region SLO tracking.
- ADR-0024 (Repository and migration strategy) — defines Terraform infra layout.
- GDPR Article 44-50 (international transfers); UAE PDPL; HIPAA §164.502; Schrems II implications for EU → US data transfers.
