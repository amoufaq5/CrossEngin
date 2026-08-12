# ADR-0245: Certification report persistence (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0244 (certification-runtime), ADR-0061/0063 (SLO enforcement persistence siblings), ADR-0077 (Phase 4) |

## Context

`@crossengin/certification-runtime` (ADR-0244) produces sealed, per-framework certification reports but
holds them only in memory. An auditor asks for *history* — "show me every SOC 2 report this quarter and
whether it was certifiable" — which needs the reports durable and queryable. This adds the Postgres
persistence sibling, the same pure-runtime → -pg pattern used for the workflow, gateway, SLO, DR, and
billing runtimes.

## Decision

Ship **`@crossengin/certification-runtime-pg`**.

- **New META table `meta.certification_reports`** (table #134) — purpose-built, since the certification
  report emits a `cert_` TEXT id that has no home in the existing UUID-keyed contract tables. Columns:
  `report_id` (TEXT, unique, `^cert_[a-z0-9]{8,40}$`), `tenant_id` (nullable UUID FK), `framework`
  (TEXT, CHECK against the seven `COMPLIANCE_FRAMEWORKS` values), `certifiable`, the four control counts
  (`controls_total|satisfied|deficient|not_assessed`), `sealed_sha256` (`^[0-9a-f]{64}$`), the full
  `report` JSONB, and `generated_at`. **Platform-or-tenant RLS**
  (`tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID`) — a
  platform-wide certification (no tenant) is visible to operators, a tenant-scoped one only within its
  tenant. Indexes on `(tenant_id, generated_at)`, `(framework, generated_at)`, `(certifiable)`.
- **`records.ts`** — `CertificationReportRecord` zod schema + `certificationReportRecordFrom(report)`,
  the pure projection from a `CertificationReport` to a row (the report already carries `reportId`,
  `tenantId`, `framework`, `generatedAt`, the counts, and `sealedSha256`, so no new id is minted — the
  report's own id is the natural key). `tenantId` defaults to the report's tenant, overridable.
- **`report-store.ts`** — `PostgresCertificationReportStore` — `record` (`INSERT … ON CONFLICT
  (report_id) DO NOTHING`, append-only + idempotent), `getByReportId`, `listRecent`, `listByFramework`,
  `latestForFramework`. Platform-or-tenant table, so a plain INSERT (no `withTenantContext` wrapper —
  `tenant_id` rides as a bound column, exactly like the DR-readiness-snapshot store).
- **`persisting-engine.ts`** — `buildPersistentCertificationEngine(conn, options)` wraps a
  `CertificationEngine`; its `certify` / `certifyAll` run the pure assessment then persist the sealed
  report. Drop-in for the pure engine — same signatures, now durable.

## Consequences

- Certification history is queryable: "every SOC 2 report last quarter and whether it was certifiable"
  is `SELECT … WHERE framework = 'soc2_type2' ORDER BY generated_at DESC`; a specific report round-trips
  by `report_id` with its seal intact for tamper verification.
- The stored `report` JSONB is the full sealed report, so `verifyCertificationReportSeal` still holds
  after a round-trip — the persistence layer never rewrites the sealed payload, and the denormalized
  columns (framework, counts, certifiable) are index/filter shortcuts, not the source of truth.
- Reuses the pure-runtime → -pg contract exactly: `certification-runtime-pg` depends on
  `certification-runtime` + `kernel-pg` + `zod`; the pure package stays free of any Postgres dependency.
- Meta-schema grows to **134 tables** (+`meta-schema.test.ts` count + sorted-names + `apply.test.ts`
  `tableCount`). +12 tests (record projection incl. deficiency counts; store record/get/idempotent/
  list-recent/by-framework/latest/limit-guard over an in-memory PG fake; persisting engine certify +
  certifyAll + not-certifiable persistence). Full build + typecheck + workspace tests green. ADR-0245.
- Follow-up (open): serve-level wiring in `operate-server` — a `--certification` flag that, on a
  schedule, pulls the four evidence sources from live infra (encryption coverage over the live catalog,
  DR readiness, sealed access-review evidence, chain verification), certifies each framework, and
  persists the reports; a `certification-runtime` replayer for drift checks over the report stream.
