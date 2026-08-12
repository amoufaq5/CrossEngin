# ADR-0246: Serve-level certification lifecycle in operate-server (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0244 (certification-runtime), ADR-0245 (certification-runtime-pg), the DR-readiness + access-reviews serve lifecycles, ADR-0077 (Phase 4) |

## Context

`certification-runtime` (ADR-0244) certifies a framework from control-evidence and
`certification-runtime-pg` (ADR-0245) persists the sealed report, but nothing yet *drives* them from
a running server against live infra. This adds the serve-level wiring — a `--certification-config`
flag + scheduler in `operate-server` that, on an interval, collects live control-evidence, certifies
each configured framework, and persists a sealed report — mirroring the DR-readiness / access-reviews
/ metering serve lifecycles.

## Decision

- **`certification.ts`** — a config (`--certification-config`:
  `{tenantId?, intervalMs? (default daily), schema?, frameworks? (default SOC 2 + HIPAA),
  drReadiness?, accessReviews?}`), pluggable **evidence sources**, a `CertificationScheduler`
  (`unref`'d interval, runs on start + every interval), and `buildCertificationLifecycle(conn, config,
  opts)` → `{scheduler, certifyOnce}`.
- **Evidence sources** are a seam (`EvidenceSource.collect(framework, at)`), each best-effort and
  framework-aware. Three live sources wire what the platform can genuinely observe today:
  - `encryptionCoverageSource` — `EncryptionApplier.coverage(schema)` over the live catalog (always on,
    no tenant context — it introspects `pg_catalog`).
  - `drReadinessSource` — the latest persisted DR-readiness snapshot (`PostgresDrReadinessStore.latest()`;
    the DR-readiness lifecycle is the producer).
  - `accessReviewSource` — the latest **sealed** `access_review_evidence` row *for the framework*, read
    within the tenant's RLS context (`PostgresAccessReviewEvidenceReader` + `withTenantContext`); this is
    the one per-framework source, so the lifecycle **certifies per framework** (not `certifyAll`).
  Each source's dependency is an injected interface (a coverage provider / snapshot provider / evidence
  reader), so the source logic is unit-tested with stubs while the live glue is thin.
- **Fail-closed + best-effort.** A source that yields nothing (no snapshot, no sealed pack) leaves its
  control `not_assessed` → the framework is *not certifiable*, surfaced honestly rather than passed. A
  source that *throws* is caught (routed to `onSourceError`) and the pass continues with the evidence it
  did gather — one flaky source never fails the whole certification.
- **`serve()` wiring.** `--certification-config` (needs `--store pg`) builds the lifecycle over `conn`
  and starts/stops its scheduler alongside the others; each pass logs one line per framework
  (`certifiable`, satisfied/total, report id).

## Consequences

- The deployed server now produces a continuous, tamper-evident compliance signal: "as of the last
  pass, is this tenant SOC 2 / HIPAA certifiable, and which controls are deficient?" — sealed and durable
  in `meta.certification_reports`, queryable as history (ADR-0245).
- Completes the certification arc end-to-end: declare controls (ADR-0244) → assert them against evidence
  → persist (ADR-0245) → **drive from live infra on a schedule** (this ADR) — the same
  pure-runtime → -pg → serve pattern used for SLO, DR, access-reviews, and billing.
- The evidence-source seam is open: a deployment can inject additional sources (e.g. forensic
  hash-chain verification) via `opts.sources` without touching the lifecycle; the default set covers
  encryption + DR + access-reviews.
- +14 tests (config parse/load; the three evidence-source adapters incl. framework-awareness + empty
  handling; scheduler run-on-start / interval / stop / error routing; lifecycle per-framework certify +
  persist, not-certifiable on missing evidence, best-effort on a throwing source). No META tables (the
  table landed in ADR-0245), so no schema-count change. Full build + typecheck + workspace tests green.
  `serve()` stays offline-untestable, like the other serve lifecycles.
- Follow-ups (open): a live forensic-chain source (needs a persisted chain store); a per-tenant fan-out
  (certify every active tenant, like the job scheduler's `TenantSource`) rather than the config's single
  tenant; alerting on a `certifiable → false` transition.
