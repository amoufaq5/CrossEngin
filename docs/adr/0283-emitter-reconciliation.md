# ADR-0283: The served table is what the manifest says (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-26 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0282 (view field references), ADR-0281 (relation field validation), ADR-0003 (meta-schema and dynamic entity engine) |

## Context

ADR-0282 closed on a divergence it deliberately left open: two DDL emitters disagreed about
trait fields. The kernel's `emitCreateTable` emitted all of them; the column-mapped store's
`entity-ddl` emitted a fixed housekeeping set and expanded no traits, so `created_by`
resolved for validation and had no column in a served table.

Following that up found the divergence was not the interesting part.

**The kernel's entity emitter has no production consumer.** `emitCreateTable` → `emitEntity`
→ `emitManifestCreate` / `applyManifest` are reachable only from kernel tests. `crossengin
apply` emits the meta-schema bootstrap and never touches manifest entities; `operate-server`
builds its tables from `operate-runtime-pg`. And the kernel's emitter does not merely differ
on traits — it emits `id UUID PRIMARY KEY` with **no `tenant_id`, no RLS and no composite
key**, a single-tenant shape predating the tenancy model. It is stale by an architectural
generation. Validation was following it.

Two much larger defects surfaced underneath.

**The column-mapped store cannot evolve a schema at all.** `ensureSchema` issues
`CREATE TABLE IF NOT EXISTS` and nothing else. Add a field to a manifest, restart, and the
`CREATE` silently no-ops on the existing table — the column is never added, and the very next
statement (that column's trigram index) fails. Verified live: the server exits with
`fatal: column "triage_level" does not exist`. **Any manifest change that adds a field
bricks the server on restart.**

**`pack-erp-core` could not boot on `pg-columns` at all.** `isTrigramIndexable` accepted any
`CHAR`-prefixed type, but `gin_trgm_ops` accepts `text` and `varchar` and not `bpchar`. A
`country_code` field emits `CHAR(2)`, so the flagship pack died on
`operator class "gin_trgm_ops" does not accept data type character`. Confirmed pre-existing by
reproducing it on the unmodified tree.

## Decision

- **One resolver owns which fields become columns.** `resolvedFields(entity, customTraits)`
  joins the kernel's `resolvedFieldNames` in `ddl/resolution.ts`, and the store's column plan
  is derived from it. Validation and the serving store now read the same function, so
  validation cannot accept a field the served table has no column for. The implicit `id` is
  deliberately *not* a resolved field — it is a system column each emitter types for itself
  (the kernel UUID, the store TEXT) — while `resolvedFieldNames` still reports it, because
  for an existence question it plainly exists.
- **Trait fields become real columns.** Classifying, granting or listing `created_by` is
  meaningless if no column exists for it. They are ordinary domain columns: readable,
  filterable, sortable, projectable.
- **The plan wins over the housekeeping timestamps.** An `auditable` entity supplies
  `created_at`/`updated_at` as trait fields, so the emitter contributes them only when the
  plan does not. Exactly one of each is declared either way; the difference is that on an
  auditable entity they are now queryable rather than invisible.
- **Column defaults are carried into the plan** via the kernel's `emitDefault`, now exported
  so both emitters render a default identically. Without it the trait's NOT NULL
  `created_at DEFAULT now()` would emit bare and every insert omitting it would fail.
- **`ensureSchema` migrates additively.** An `ADD COLUMN IF NOT EXISTS` per planned column
  runs immediately after the `CREATE` and before anything referencing a column.
- **A newly required column arrives nullable unless it has a default.** Postgres rejects
  adding NOT NULL to a table with rows and nothing to backfill with. Failing the migration
  would be worse than admitting the column nullable: the manifest's requirement is still
  enforced on write by the serving layer (verified — `422 validation_failed`), and narrowing
  the existing rows is a data decision this emitter cannot make. A column created fresh in
  the `CREATE TABLE` keeps its full NOT NULL.
- **`CHAR(n)` is not trigram-indexable.** Only `TEXT` and `VARCHAR`.

## Consequences

- **`pack-erp-core` now boots on `pg-columns` for the first time** — 51 tables, all 51
  carrying `created_by` from the auditable trait — and an `Account` round-trips (`201`, then
  listed sorted by `created_at`).
- **A manifest that gains a field now migrates instead of bricking the boot.** Verified live
  end to end: v1 → v2 adds `triage_level` and the server starts and serves it, where the same
  step previously exited `fatal`. A required field added against an existing row lands
  nullable and the row survives; a required field *with* a default lands `NOT NULL DEFAULT 1`
  and the existing row is backfilled to `1`.
- **API responses for auditable entities now include `created_at` and `updated_at`**, and
  those fields can be sorted, filtered and projected on — all verified live. This is a
  visible change to every auditable entity's payload. It is the manifest's own declaration
  finally being served, but it is a change.
- The `updated_at = now()` stamp is skipped when a patch names `updated_at` itself, which on
  an auditable entity would otherwise assign the same column twice in one `UPDATE`.
- +26 tests (kernel **627**, operate-runtime-pg **167**; workspace **9,344**). Full workspace
  build + typecheck + test green.
- Follow-ups: **the kernel's `ddl/emit.ts` entity emitter is dead code that emits an
  untenanted table.** Nothing calls it, and calling it would produce a table with no
  `tenant_id` and no RLS — a tenancy breach waiting for a caller. It now shares the field
  resolver, so the *column set* can no longer drift, but deleting it (with
  `emitEntity`/`emitManifestCreate`/`emitManifestDiff`/`applyManifest` and their ~70 tests) is
  public-API removal and is left as a deliberate, separate call.
- Migration remains additive only: a removed field's column is never dropped, and a field
  whose type changed is never altered. Both need a decision about existing data that
  `ensureSchema` has no basis to make.
- Per-tenant activated manifests still never get DDL applied — the store is built from the
  boot manifest alone. Unrelated to this change and larger than it.
