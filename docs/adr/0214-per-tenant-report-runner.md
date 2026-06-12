# ADR-0214: per-tenant report runner (Phase 3 P5.8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0211 (per-tenant dispatch), ADR-0180 (report routes), ADR-0210 (route composition) |

## Context

P5.5's per-tenant composed gateways (`buildFor`) served CRUD + lifecycle for the
tenant's installed packs, but not their **reports/dashboards** — `serve()` built one
report runner over the *base* manifest and passed it only to the base server. An
installed pack's `GET /v1/reports/:report` would 404 (`report_unavailable`) because the
runner's `manifest.reports` lookup didn't know the pack's reports. ADR-0211 flagged this.

## Decision

Build the report runner **per-manifest** so the composed gateway gets one over its own
(base + installed packs) manifest.

- **`node.ts`** factors the runner construction into `makeReportRunner(target: Manifest)`
  (and a `makeReportExecutor(target)`): the base server uses `makeReportRunner(manifest)`;
  `buildFor(packs)` uses `makeReportRunner(composeTenantManifest(manifest, packs))`. The
  `principalRoles` bridge is hoisted and shared.
- The JSONB (`--store pg`) and in-memory executors are store-shape-agnostic, so they
  aggregate an installed pack's entity records without change; the column executor
  (`--store pg-columns`) is given the **composed** manifest for the typed entity-table
  plans. (Per-tenant *column-store* serving still needs the pack's tables provisioned —
  out of scope here, as is per-tenant CRUD over the column store; JSONB / in-memory are
  the realistic per-tenant stores today.)
- Redaction is unchanged: the runner derives the caller's field-readability gate from
  the same `EntityFieldResolver` over the (now composed) manifest, so an installed
  pack's classified field (e.g. education's `regulated` `Enrollment.grade`) is
  fail-closed exactly as a base field.

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables.** New tests in `reports.test.ts`: a
  runner over `composeTenantManifest(retail, [education])` resolves education's
  `courseCapacity` KPI (two seeded courses → capacity 100), while a runner over the base
  retail manifest returns `null` for the same report (fail-closed). No new META_ tables.
- An installed pack's reports/dashboards now serve for the installing tenant, alongside
  its entity routes — the per-tenant served surface is feature-complete for CRUD +
  lifecycle + reports over the JSONB / in-memory stores. Per-tenant column-store table
  provisioning on install is the remaining store-coverage follow-up.
