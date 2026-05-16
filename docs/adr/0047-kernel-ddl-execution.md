# ADR-0047: Kernel DDL execution (Phase 2 M1)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0003 (meta-schema), ADR-0024 (repo strategy), ADR-0046 (Phase 2 plan) |

## Context

The kernel's `emitMetaBootstrapSql()` produces a deterministic array of 500+ SQL strings (CREATE SCHEMA, CREATE TABLE × 113, CREATE INDEX × ~400, ALTER TABLE ENABLE RLS × ~80, CREATE POLICY × ~120). Phase 1 stopped at producing those strings. Phase 2 M1 actually executes them against a real Postgres.

Three concrete requirements drive this milestone:

1. **Idempotent re-apply.** Running the applier against an already-applied database must be a no-op, not an error. The schema is the source of truth; the applier converges live state toward it.
2. **Drift detection.** Removing a column from `meta-schema.ts` and running `drift report` against a live database must show the column as a deletion candidate. The applier does NOT auto-drop; it reports.
3. **Safe concurrent runs.** Two CI runs of the applier against the same database must not corrupt state. One waits; the other proceeds.

There's also a practical constraint: many `META_*` tables use `uuid_generate_v7()` as a default value. That's not in core Postgres — it comes from the `pg_uuidv7` extension. The applier needs to surface that as a clear precondition error, not let it manifest as a confusing "function does not exist" at row-insert time.

This ADR establishes the applier contract, the migration log table, the locking model, and the introspection / diff approach for drift. It does **not** specify the migration *language* for ALTER TABLE migrations across schema versions — that's a Phase 3 concern. M1 only handles "bring an empty (or partial) database to current meta-schema."

## Decision

`@crossengin/kernel-pg` ships with **seven modules** + a binary:

1. **`connection.ts`.** `PgConnection` interface defines the four operations the applier needs: `query(sql, params)`, `transaction(fn)`, `withAdvisoryLock(lockKey, fn)`, `close()`. The interface is what tests consume; the production binding is `node-postgres` Pool. `parsePgEnvConfig()` reads `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` / `PGSSLMODE` with sane defaults.

2. **`statement-hash.ts`.** Pure SHA-256 of normalized SQL. Normalization collapses runs of whitespace and trims — minor reformatting in `kernel/emit.ts` won't break idempotency. The hash is the migration log's primary key.

3. **`migration-log.ts`.** `_meta_migrations` is the applier's own bookkeeping table (deliberately *not* in `META_TABLES` — it belongs to the applier, not the platform). Columns: `statement_hash` CHAR(64) PK, `statement_sha256` regex-checked, `statement_sql_excerpt` first 200 chars, `executed_at` TIMESTAMPTZ, `duration_ms` INTEGER, `succeeded` BOOLEAN, `error_message` TEXT NULL. The applier creates this table first if missing, then checks each upcoming statement's hash before executing.

4. **`preconditions.ts`.** Checks before any DDL: `pg_uuidv7` extension installed (errors with `CREATE EXTENSION pg_uuidv7;` instruction if not); Postgres ≥ 14 (RLS + UUID + INET types are fine on 13 but `IF NOT EXISTS` on `CREATE POLICY` came in 14); current role has CREATE on the target schema.

5. **`applier.ts`.** `MigrationApplier` orchestrates: acquire advisory lock → check preconditions → ensure migration log → emit statements via `emitMetaBootstrapSql()` → for each, compute hash → skip if applied → execute in a per-statement transaction → record success/failure to log → release lock. Returns `ApplyReport { totalStatements, executed, skipped, failed, durationMs }`. Failure semantics: stop on first failure (don't half-apply). Recovery is "fix the failure and re-apply" — the log shows where to resume.

6. **`introspection.ts`.** Queries `pg_catalog.pg_tables`, `pg_attribute`, `pg_constraint`, `pg_index`, `pg_policy` and produces a typed `LiveSchema` shape that mirrors `TableDefinition[]`. Pure parsing function takes pg_catalog rows → returns `LiveTable[]`. The SQL queries live as constants for testability.

7. **`diff.ts`.** Pure function `diffSchema(target: TableDefinition[], live: LiveSchema): SchemaDiff`. Reports:
   - **Added tables** (in target, not in live)
   - **Removed tables** (in live, not in target — drift!)
   - **Modified tables** with added/removed/changed columns, added/removed indexes, added/removed RLS policies
   - **Unchanged tables** (omitted from the report unless verbose)

Plus binary `bin/crossengin-pg` with commands:
- `crossengin-pg apply` — applies meta-schema, prints `ApplyReport`. Refuses to run without `--confirm` if `PGDATABASE` matches a production-looking pattern.
- `crossengin-pg apply --dry-run` — emits SQL, doesn't execute, prints what *would* run.
- `crossengin-pg drift` — runs introspection + diff against `META_TABLES`, prints `SchemaDiff` in human form.
- `crossengin-pg inspect` — dumps `LiveSchema` (introspection only).
- `crossengin-pg version` — prints applier version + count of `META_TABLES`.

## Cross-cutting invariants enforced

- **Advisory lock key is deterministic** — `pg_advisory_lock(8675309)` (a fixed integer constant). Concurrent runners block; no race condition.
- **Each statement runs in its own transaction.** A failure halts the run but doesn't poison earlier-applied statements. This is critical for `CREATE EXTENSION` precondition checks, which can fail before any meta-schema work.
- **The applier never DROPs.** Drift detection reports removed tables/columns but never auto-removes. Schema removal is an explicit human-driven migration (Phase 3 concern).
- **Hash-based skip is the idempotency primitive.** Reformatting `emit.ts` output won't cause re-execution; semantic SQL changes will produce a new hash and re-run.
- **`_meta_migrations` is applier-owned.** It is created automatically. It is not in `META_TABLES`. It does not have RLS. It is platform-private bookkeeping.

## Alternatives considered

- **Use Knex / TypeORM / Prisma migrations.**
  - **Pros.** Battle-tested.
  - **Cons.** Each carries opinions about how schemas are *defined* — Knex wants a migrations directory, TypeORM wants entity decorators, Prisma wants its own DSL. We already have the schema as `META_TABLES`; we just need an executor. Any ORM-based migrator would require restating the schema in their format.
  - **Why not.** The kernel is already the source of truth; we just need to execute its output.

- **Use `CREATE TABLE IF NOT EXISTS` everywhere instead of hash-based skip.**
  - **Pros.** Simpler — no need for a migration log.
  - **Cons.** Idempotent for CREATE TABLE, but for CREATE INDEX (also IF NOT EXISTS works), ENABLE RLS (no IF NOT EXISTS — always runs), CREATE POLICY (no IF NOT EXISTS until PG 14, and even then it tells you it didn't run, doesn't error). The mixed-idempotency story is messier than hash-tracking.
  - **Why not.** Hash-tracking is uniform across statement types and gives auditability for free.

- **Skip the migration log; rely entirely on pg_catalog introspection.**
  - **Pros.** Smaller surface.
  - **Cons.** Loses the "when was this applied, by which version, did it succeed?" audit. The migration log is cheap (one row per statement, ~600 rows total at current scale) and very useful for debugging "why is table X missing in tenant Y's database?"
  - **Why not.** The audit utility is worth one small table.

- **Apply all statements in one big transaction.**
  - **Pros.** All-or-nothing atomicity.
  - **Cons.** Postgres limits some DDL operations from being mixed in one transaction with data operations. `CREATE EXTENSION` and `ENABLE ROW LEVEL SECURITY` work in transactions but interact badly with prepared statements. Per-statement TX is safer.
  - **Why not.** Per-statement TX + halt-on-failure gives a clean recovery model: see the log, fix the bad statement, re-apply.

- **Auto-create `pg_uuidv7` extension if missing.**
  - **Pros.** One-step onboarding.
  - **Cons.** `CREATE EXTENSION` requires superuser on most managed Postgres deployments (Supabase, RDS, Aurora). Failing softly with a clear "ask your DBA to run this" message is friendlier than failing with a permission error and a long stack trace.
  - **Why not.** Surface the precondition, don't try to work around it.

- **Build the CLI in `tools/cli` (separate package).**
  - **Pros.** Cleaner separation.
  - **Cons.** M5 (architect CLI) is the real `tools/cli`. Adding a `tools/cli` now would force a rename later. Shipping the bin inside `@crossengin/kernel-pg` is simpler and matches how dotenv, prisma, drizzle ship their CLIs.
  - **Why not.** Defer `tools/cli` to M5.

## Consequences

- **First impure package in the workspace.** Has a runtime dep on `pg`. Cannot be imported in browser/edge environments. The 40 existing pure packages are unaffected.
- **Tests are bimodal.** Pure-logic modules (`statement-hash`, `diff`, introspection parsers) have unit tests. The applier itself has a mocked-connection unit test path + an integration test that skips when `PGHOST` is unset.
- **One new "applier" table outside META_TABLES.** `_meta_migrations` is conceptually a peer of `pg_catalog` for the applier — not a tenant/business concern, not in the kernel's authoritative table list.
- **Re-apply safety becomes a property of the workspace.** Any developer/CI runner can run `apply` repeatedly without thinking about state.
- **The exit criterion from ADR-0046 is met.** A clean Postgres goes to 113 tables in one command; re-run is a no-op; column removal shows up in drift.

## Open questions

- **Q1:** Should `_meta_migrations` track which row of `META_TABLES` (table name) a CREATE TABLE corresponded to?
  - _Current direction:_ Statement excerpt is enough. If we ever need richer per-table audit, that's an Article 15 sub-package concern, not the applier's.
- **Q2:** Should `drift` exit non-zero when drift exists?
  - _Current direction:_ Yes, by default. CI uses `drift` as a guard rail; a developer modifying the schema should make sure their PR includes the apply. `--exit-zero-on-drift` overrides for inspection use.
- **Q3:** How do we handle Postgres major version upgrades that change `pg_catalog` shape?
  - _Current direction:_ Out of scope. Postgres maintains backward compatibility for pg_catalog views across majors; we test against PG 14 / 15 / 16 in CI.
- **Q4:** What about the role-grant / role-creation needed to grant tenant connections?
  - _Current direction:_ Out of scope for M1. M1 creates the schema. A future M1.5 will add `crossengin-pg roles` for per-tenant role provisioning per ADR-0002.
- **Q5:** Should the applier auto-detect Supabase vs Aurora vs vanilla Postgres and adjust?
  - _Current direction:_ No. Same statements work across all. Connection-string parsing handles the deployment-specific URL formats.

## References

- **PostgreSQL `pg_advisory_lock`** documentation
- **`pg_uuidv7` extension** (UUIDv7 generator, RFC 9562)
- **node-postgres** (pg) — connection pool + parametrized queries
- **RFC 9562** — UUIDv7 (chronological UUIDs for primary keys)
- ADR-0003, ADR-0024, ADR-0046
