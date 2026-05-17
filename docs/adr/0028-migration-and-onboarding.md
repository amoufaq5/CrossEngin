# ADR-0028: Migration and onboarding

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0004, ADR-0011, ADR-0014, ADR-0015, ADR-0024, ADR-0026 |

## Context

New tenants arrive with data already in another system: Salesforce CRM, ServiceNow ITSM, a Postgres dump, a CSV export from a spreadsheet, an HL7 v2 feed from a hospital EHR. Onboarding has to take that data and shape it into CrossEngin's manifest model — entities, fields, references — without a developer touching the new tenant's database.

Two onboarding paths must be first-class:

1. **Bring my data.** Tenant picks a source, the platform infers a schema, the tenant maps fields, previews the import, and commits a backfill. The first import is gated by a dry-run that surfaces validation failures so the tenant can fix mappings before processing the whole dataset.
2. **Vertical template.** Tenant installs a marketplace pack (ADR-0026, `vertical_template` kind) that supplies entity definitions + seed data. They can optionally bring their own data later.

A third path — **blank workspace** — is also valid for tenants who build from scratch.

The backfill must be **idempotent**. Tenants will run imports multiple times (test runs, partial failures, refreshes). Each source row hashes to a deterministic idempotency key (or the tenant declares one); the ledger records (key, outcome) so reruns skip already-processed rows.

PHI imports require a HIPAA-active tenant. FHIR R4 sources are first-class because healthcare verticals are core (CrossEngin Heal). Salesforce + ServiceNow are first-class because most professional-services and ITSM tenants come from them.

## Decision

The migration contract has **six modules** in `@crossengin/migration`:

1. **`sources.ts`.** Twelve source kinds (csv, jsonl, json, excel_xlsx, parquet, salesforce, servicenow, sql_dump_postgres, sql_dump_mysql, http_api, hl7_v2, fhir_r4) × 7 auth kinds × 4 schedules (one_shot / interval / cron / webhook_driven). Structured sources (salesforce, servicenow, FHIR, SQL dumps) require declaring `primaryEntity`. Salesforce/ServiceNow/FHIR require authenticated access.

2. **`schemas.ts`.** Thirteen inferred types (string, integer, decimal, boolean, date, datetime, uuid, email, url, phone, json, binary, unknown) × 12 semantic hints (primary_key_candidate, foreign_key_candidate, pii_email, pii_phone, phi, monetary, geo_lat_long, timestamp, etc.). `inferTypeFromSample()` is a pure regex-based classifier. `consolidateTypes()` widens integer+decimal → decimal, date+datetime → datetime, mixed → string fallback. PK-candidate columns must have zero nulls and zero duplicates.

3. **`mappings.ts`.** Fourteen transform kinds (identity, trim, lowercase, uppercase, date_parse, datetime_parse, number_parse, boolean_parse, split, concat, lookup, default_if_null, regex_extract, redact). `FieldMapping` enforces required→non-nullable and no skipIfNull combined with required. `EntityMapping` enforces unique source + target field names, idempotency-key fields must reference declared targets. `isTypeCoercionAllowed()` encodes the lossless coercion table.

4. **`previews.ts`.** Five-status preview lifecycle. `PreviewRun` enforces counter sums ≤ rowsRead and rowsRead ≤ sampleSize, no duplicate rowIndex, valid outcomes have no issues. `summarizePreview()` produces a `readyToCommit` verdict against an acceptable failure rate.

5. **`backfill.ts`.** Seven-status job lifecycle (queued → running → paused → completed / completed_with_errors / failed / cancelled) × 4 conflict-resolution strategies (skip_duplicate / overwrite_existing / fail_on_conflict / merge_fields). `BackfillLedgerEntry` (5 outcomes: inserted / updated / skipped / failed / merged) records per-source-row outcomes with `(backfill_job_id, idempotency_key)` uniqueness for replay protection. `completed` requires zero failures; `completed_with_errors` requires >0.

6. **`onboarding.ts`.** Seven-stage pipeline (workspace_setup → plan_selection → schema_design → user_invites → first_import → validate → go_live) × 5 stage statuses × 3 paths. Only `user_invites` and `first_import` are skippable. Path-specific requirements: `vertical_template` requires `sourcePackId`, `bring_my_data` with active import requires `sourceImportId`. `completedAt` only when `currentStage='go_live'`. `abandonedAt ⊕ completedAt` (mutually exclusive).

Four meta-schema tables (all RLS): `META_IMPORT_SOURCES`, `META_BACKFILL_JOBS`, `META_BACKFILL_LEDGER`, `META_ONBOARDING_RUNS`.

## Alternatives considered

- **Option A:** Use a generic ETL tool (Airbyte, Fivetran).
  - **Pros:** Existing connectors, mature.
  - **Cons:** Adds a third-party dependency; doesn't model CrossEngin's manifest target. Can't enforce per-row idempotency against our schema.
  - **Why not:** Migration is integral to onboarding UX; outsourcing it leaves the most important part of new-tenant experience to a vendor.

- **Option B:** "Bring your own SQL" — tenants write transformation SQL.
  - **Pros:** Maximum flexibility.
  - **Cons:** Excludes non-technical tenants entirely. Salesforce admins are the buyers, not DBAs.
  - **Why not:** Self-service onboarding is the buyer's actual job-to-be-done.

- **Option C:** Skip schema inference; require tenant to declare the target schema first.
  - **Pros:** Cleaner mental model.
  - **Cons:** Tenant doesn't always know their own data. Inference gives a starting point they can refine.
  - **Why not:** Real migrations start with "what's in this CSV?".

- **Option D:** Single-pass import (no preview).
  - **Pros:** Faster.
  - **Cons:** Half-imported state from validation failures is painful; tenants can't fix mappings without a dry-run.
  - **Why not:** Preview-then-commit is industry standard for a reason.

## Consequences

- **Positive.** Tenants self-serve onboarding. Idempotent backfills tolerate retries. Schema inference reduces manual work. Verticals can ship as templates that double as both seed-data and reference-implementation.
- **Negative.** Schema inference is heuristic — it will sometimes guess wrong (e.g., a column of all-numeric strings is `integer` not `string`, but might semantically be a SKU). Tenants must verify before committing.
- **Neutral.** Source-kind list will grow over time. Adding kinds is additive (no breaking changes for existing imports).
- **Reversibility.** Schema changes for `EntityMapping` are tractable in Phase 1; once tenants depend on saved mappings, changes need migration scripts.

## Implementation notes

- **Schema inference details.** Per-column type guess from samples, consolidated via `consolidateTypes`. Confidence = matching-samples / total-samples; PK-candidate columns must be unique + non-null.
- **Lossless coercion table.** Integer→decimal allowed; date→datetime allowed; decimal→integer NOT allowed (lossy); datetime→date NOT allowed (lossy).
- **Backfill checkpoint token.** Opaque string the worker uses to resume from where it left off after a pause/retry. Format is engine-specific.
- **Onboarding gating.** `isReadyForGoLive()` requires workspace_setup + plan_selection + schema_design + validate all completed. user_invites and first_import are skippable but still must reach `completed` or `skipped` before go_live.
- **FHIR R4.** Treated as a structured source with `primaryEntity` like `Patient` or `Observation`. Mapping bridges FHIR resource types into CrossEngin entities; an external compliance pack ships the canonical mappings.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Streaming source kinds (Kafka, Kinesis) — defer to ADR-0011 integration mesh | _pending_ | Phase 2 |
| Schema-inference ML model vs pure regex — when does heuristic-only stop scaling | _pending_ | Phase 3 |
| Bidirectional sync (CrossEngin → Salesforce write-back) | _pending_ | Phase 3 |

## References

- ADR-0011 (integration mesh) for the long-running connector layer.
- ADR-0014 (files and storage) for the upload pipeline backing CSV/Excel sources.
- ADR-0026 (marketplace) for `vertical_template` pack kind shared with this path.
- `packages/migration/src/` for the zod schemas and helpers.
