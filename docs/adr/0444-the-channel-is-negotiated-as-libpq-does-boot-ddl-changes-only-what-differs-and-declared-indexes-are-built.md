# ADR-0444: The channel is negotiated as libpq does, boot DDL changes only what differs, and declared indexes are built

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0357 (channel assurances; `verify-ca` was refused and nothing accepted CA material), ADR-0425 (the serving pool's 60 s `lock_timeout` and `--pg-*` bounds), ADR-0438 (a migration waits a bounded time), ADR-0423 (the owner's `document-indexes` one-shot), ADR-0424 (the API connects as `crossengin_app`), ADR-0400 (restrictive `DELETE` fences), ADR-0389 (the job queue), ADR-0338 (refuse only when nothing correct breaks) |

## Context

The external due-diligence audit's database-operations findings, verified at `f6faf05`, were all
open or partly fixed:

- **M-11, `PGSSLMODE` semantics differ from libpq and there is no CA.** Measured before this
  change, node-postgres read `PGSSLMODE` itself: an explicit `prefer` became mandatory, fully
  verified TLS, an unset variable meant no TLS ever, `verify-ca` was refused at parse, and
  `PGSSLROOTCERT` was never read. (The verified report says "default/prefer never attempts TLS";
  the implementer's measurement of an *explicit* `prefer` differs, and is the one used here.)
- **M-12, no partitioning or retention.** `meta.job_runs`, `meta.gateway_pipeline_executions`,
  `meta.rate_limit_decisions` and `meta.notification_dispatches` grow with no sweep. The finding's
  "no retention anywhere" is partly false: the idempotency table already had a reaper.
- **M-14, column-store boot DDL.** Every `--store pg-columns` boot dropped and re-added each foreign
  key, re-validating the child table under `SHARE ROW EXCLUSIVE`; each policy was dropped and
  re-created in two autocommit statements, so between them RLS was on with no policy and a
  non-owner was denied everything; and nothing bounded how long a boot statement waited for a lock.
  "Unbounded" was true of the boot path only: the serving pool already had ADR-0425's 60 s
  `lock_timeout`.
- **M-15, indexes do not match queries.** Resolved `erp-core` declares **163** indexed fields
  (including all 79 references) and **64** entity indexes, and nothing emitted any of them. The
  "redundant tenant index" is the column store's `idx_<table>_tenant`; the JSONB table's equivalent
  is never chosen by the planner.

## Decision

**The channel is negotiated in libpq's order and reports what it got.** `allow` and `prefer` are
negotiated once per pool and the outcome is printed on the `[pg]` boot line. `PGSSLROOTCERT` is read
as a file or `system`; with a file, node trusts only that root. `verify-ca` is a fourth assurance,
`chain_validated`, and needs a root — without one it is refused at parse. `PGSSLMODE` set but empty
is refused at parse, as libpq does; unset means `prefer`.

**`verify-full` checks the certificate against `PGHOST`.** Found live while doing the above:
node-postgres passes a `servername` only for a non-IP host, so with `PGHOST=127.0.0.1` node's own
check compared the certificate against `localhost` and accepted a certificate naming only
`localhost`. `pgTlsPlan` supplies a `checkServerIdentity` that checks against `PGHOST` itself.

**Operational rows age out, opt-in.** `--retention-sweep` plus `--retention <table>=<days|off>`
cover the four tables above, defaulting to `job_runs` 90 days, `gateway_pipeline_executions` 30,
`rate_limit_decisions` 30, `notification_dispatches` 365. The sweep is hourly, per tenant under
`withTenantContext`, in batches. It never deletes an unfinished run, and keeps each job's newest
run, because the cron scheduler re-derives a deterministic `run_id` from it and would otherwise run
the job twice. None of the four is in `PLATFORM_RECORD_TABLES` or `RETAINED_SHARED_TABLES`, none
carries an ADR-0400 `DELETE` fence (checked in `pg_policy`), and nothing references the first three.
Refused: `rate_limit_decisions` pruned sooner than `gateway_pipeline_executions`; `--retention`
without `--retention-sweep`; `--retention-sweep` on `--store memory`. It is **opt-in on ADR-0338's
rule read the other way**: turning it on deletes rows a working deployment keeps today, and when it
is off the boot line says so.

**Boot DDL changes only what differs, within a bound.** Each foreign key and each policy is one `DO`
block guarded by the catalog. A foreign key is replaced only if `confrelid`, `confdeltype`,
`confupdtype`, `confmatchtype`, `convalidated`, `condeferrable` or the key columns differ (plus
`confdelsetcols` for `set_null` only, since that column does not exist on PG 14). A policy is
replaced only if its deparsed expression differs from what this server would write, a rendering
asked of Postgres through a temp table. Every boot statement runs under `SET LOCAL lock_timeout` /
`statement_timeout`, and a `55P03` is retried with backoff.

**A statement that would change nothing does not run.** Found by review: under the bound, the
no-op statements that still lock the table on every boot — `ADD COLUMN IF NOT EXISTS`,
`ENABLE ROW LEVEL SECURITY` on a table that has it, `ALTER COLUMN SET DEFAULT`, and
`CREATE INDEX IF NOT EXISTS` — made boot fail behind any open transaction, where before it waited.
Each is wrapped in a `DO` block that checks the catalog first (`SchemaDdlOptions.catalogGuards`);
the `SET DEFAULT` check compares against Postgres's own rendering of the default, and the block's
quote tag is chosen so it cannot occur in the statement it wraps. With the option absent the output
is byte-identical, so the per-tenant applier is unchanged.

**Declared indexes are built.** On the column store, 159 indexes, each `(tenant_id, …)`. A
declaration is dropped when a longer one starts with it or when the primary key or a unique index
already serves it; a reference column is indexed even if undeclared. No index is emitted for a field
encrypted at rest, a gin/gist index kind, or an entity index marked `unique`, and the boot line says
what was skipped and why. Built `CONCURRENTLY`; an invalid index is dropped and rebuilt on the next
run. The redundant `idx_<table>_tenant` is no longer emitted; tables that have it keep it. On the
document store, 158 partial indexes `(tenant_id, (document->>'f')…) WHERE entity='E'`, with 3 fields
skipped because they are compared through a guarded cast; the owner's `document-indexes` one-shot
builds them, and the API only checks for them at boot and reports `absent` / `present`.

## Alternatives considered

- **Partition the four tables.** Refused: the unique keys would have to include the partition key,
  the reconciler cannot convert a populated table, and dropping a partition is owner-only and
  cross-tenant.
- **Retention on by default.** Refused under ADR-0338: it deletes rows a working deployment keeps.
- **Bound the boot DDL and leave the no-op statements unguarded.** Refused on measurement (review):
  boot then failed `55P03` behind an ordinary open transaction — after ~712 ms at 500 ms / 0
  retries, ~18 s at the defaults (5 s, 2 retries) — and no option avoided it.
- **Build the document-store indexes from the API.** Refused: the API is not the owner. Measured as
  the non-owner `serving` role, all 158 report `not_owner`.
- **Drop `meta.idx_operate_entity_records_tenant_entity`.** Refused: the planner never chose it and
  it is 1.3 MB against the unique key's 18 MB, but removing it from the catalog would leave an
  undeclared-index finding on every existing deployment's drift report.

## Consequences

- **Positive:** a TLS mode means what libpq means and a private CA can be trusted; `verify-full`
  over an IP host is checked against that host; the four operational tables can be bounded; a
  second boot changes nothing; a boot behind ordinary traffic succeeds and one behind an exclusive
  lock fails in bounded time; lookups, filtered lists and FK triggers use an index.
- **Negative:**
  - An explicit `prefer` that used to mean mandatory verified TLS now negotiates and can fall back
    to the clear against a plaintext server; the boot line says which.
  - A trigram or foreign-key build longer than 10 minutes at boot now fails boot, because the
    default `statement_timeout` applies to it.
  - Under `require` with a CA set, this binding does not verify the chain, where libpq would; the
    boot line says the CA is unused.
- **Neutral:** `deploy/README.md` gains the `[indexes]` and `[retention]` bullets, a revised `[pg]`
  bullet, and a note on dropping a stale `idx_<table>_tenant`. On the document store a lookup index
  that is no longer declared is reported `[indexes] runtime lookup index … no longer declared`
  rather than as an enforced unique index.
- **Reversibility:** the retention sweep is a flag; the catalog guards and the index set are
  additive, and dropping an emitted index is one statement.

## Implementation notes

- Changed: `packages/kernel-pg/src/` (`connection.ts`, `node-pg.ts`);
  `packages/operate-runtime-pg/src/` (new `boot-ddl.ts`, `declared-indexes.ts`; `entity-ddl.ts`,
  `column-store.ts`, `entity-store.ts`, `document-integrity.ts`, `index.ts`);
  `apps/operate-server/src/` (new `operational-retention.ts`; `cli.ts`, `node.ts`);
  `deploy/README.md`. `meta-schema.ts` is untouched.
- In process: kernel-pg 945; operate-runtime-pg 885 (29 files) with typecheck 0; testing 909
  (24 files); operate-server typecheck 0 and the `operational-retention`, `cli` and `node` tests
  392. The implementer's full operate-server run was 6091 passed, 4 failed, all in
  `abac-obligations`, `sensitive-field-policy` and `manifest-view`, from another lane's uncommitted
  pack and classification changes; review did not run the full suite.
- Mutation-checked, each reversed: the `job_runs` newest-per-job clause; decisions ≥ executions;
  `--retention` without the sweep; the FK guard's `convalidated` and `confdeltype` conditions; the
  policy expression comparison; both arms of the prefix dedupe; the `cast_predicate` skip; the
  `encrypted_at_rest` skip; the lock-timeout-only retry; the invalid-index drop and valid-index
  skip; `verify-full` against `PGHOST`; the add-column guard (2 fail); `DOCUMENT_LOOKUP_INDEX_PREFIX`
  without `ix_` (1 fails).
- **TLS, live (implementer)**, a cluster with ssl on and a plaintext-only one: `prefer` gets TLS
  from the first and falls back, saying so, on the second; `require` against plaintext fails;
  `verify-full` with the right root and host `localhost` connects, with a wrong CA or no root
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, and with host `127.0.0.1` was **connected** and is now
  `ERR_TLS_CERT_ALTNAME_INVALID`; `verify-ca` connects across a hostname mismatch, fails on a wrong
  CA, and without a root is refused at parse.
- **TLS, independent live run**, the API as `crossengin_app`: `verify-full` with a private CA and
  host `localhost` 200 over TLSv1.3; with an IP host or a wrong CA, fatal (hostname mismatch /
  "unable to verify"); `verify-ca` with the right CA 200, with a wrong CA, no CA, or `system` fatal;
  `prefer` 200 and said; `require` with a CA 200, the CA said unused; empty `PGSSLMODE` and a CA
  file missing or not PEM fatal; `crossengin apply --plan` behaves the same in each mode.
- **Retention, live as the non-owner `serving` role (implementer):** it deleted exactly the 3
  eligible `job_runs`, keeping each job's newest, the pending run and job `y`'s only run, with
  batches of 1 draining correctly; 1 tenant gateway row, 2 tenant rate-limit decisions, 2 terminal
  dispatches with the queued one kept; platform-scope rows reported `confined` and kept, then
  deleted by an owner control; a second pass deleted nothing. The independent run removed exactly
  the 4 old finished runs it seeded, kept pending, recent and each job's newest, and exited 2 on
  each of 5 bad retention flags.
- **Boot DDL, live on `erp-core` (implementer, as owner, since `--store pg-columns` could not boot
  as `crossengin_app` at the time):** a second boot left the OIDs of all 79 FKs and 51 policies
  unchanged; an FK changed to CASCADE, and a `NOT VALID` one, were each replaced alone; a
  `USING (true)` policy was replaced alone. Behind a held lock, unbounded the boot hung and a plain
  `SELECT` timed out at 4 s queued behind it; bounded, the boot threw `55P03` after 1.6 s and the
  `SELECT` ran in 29 ms.
- **Review, live:** a boot behind an open reader and an open writer succeeded (644 ms); a catalog
  broken on purpose (dropped column, RLS off, changed default, dropped trigram and unique index) was
  repaired; a second boot kept every table, index and policy OID.
- **Independent live run (supersedes the two above where they differ):** an owner boot while
  another session held a writer or reader lock answered 200 in 1.57 s; with an exclusive lock held,
  fatal "lock timeout" after 19.4 s.
- **Indexes, `EXPLAIN` on populated tables (implementer):** journal-line lookup over 200k rows
  16.2 ms seq scan → 0.12 ms; invoice list filtered and sorted over 100k 14.0 → 0.28 ms; parent
  delete FK trigger 13.4 → 0.17 ms; document store filtered and sorted with the entity as a bound
  `$2`, 100k Invoice + 100k other, 22.3 → 0.35–0.56 ms. An equality filter at 1% selectivity with
  no sort still walks the unique key (1.1 ms), the cheaper plan for `LIMIT` ordered by id.
  Document-store build: as `serving` 158 `not_owner`; as owner 158 built in 4.3 s and 158 `present`
  in 63 ms on rerun; a real boot as `serving` reported `158 present`. The independent run's setup
  built 158 lookup indexes and 32/32 unique ones.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A tenant's own activated schema (`applyTenantManifestSchema`) gets neither the declared indexes nor the catalog guards; its FK and policy statements are atomic `DO` blocks that replace unconditionally, now inside one transaction. | CrossEngin platform | _unscheduled_ |
| Retention hardcodes `meta.`, while `PostgresNotificationStore` honours `--schema`, so under a non-default schema it prunes the wrong `notification_dispatches` table. Latent. | CrossEngin platform | _unscheduled_ |
| Platform-scope gateway and rate-limit rows cannot be pruned by the confined role and still grow unless the owner deletes them. | CrossEngin platform | _unscheduled_ |
| `job_runs` keeps each job's newest run by `started_at`, which a retry shifts; comparing on the fire time would be exact. | CrossEngin platform | _unscheduled_ |
| `CREATE INDEX CONCURRENTLY` has no lock bound and waits for older transactions; a trigram or FK build over 10 minutes fails boot. | CrossEngin platform | _unscheduled_ |
| A boot behind an exclusive lock fails with "lock timeout" naming no table or statement. | CrossEngin platform | _unscheduled_ |
| When TLS fails on a hostname mismatch the boot first prints `[search] unaccent: REFUSED … CREATE EXTENSION`, a false remedy; the real cause appears only in parentheses before the fatal. | CrossEngin platform | _unscheduled_ |
| Under `require` with a CA set, the chain is not verified where libpq would verify it (said on the boot line). | CrossEngin platform | _unscheduled_ |
| Document-store btree indexes cannot serve `DESC NULLS LAST` sorts, and document-store `?q=` search is still unindexed. | CrossEngin platform | _unscheduled_ |
| `deploy/ORACLE.md` and `deploy/VERCEL-SUPABASE.md` still say `verify-ca` is refused and `PGSSLROOTCERT` is never read. | CrossEngin platform | _unscheduled_ |

## References

- `packages/kernel-pg/src/connection.ts`, `node-pg.ts` (`pgTlsPlan`)
- `packages/operate-runtime-pg/src/boot-ddl.ts`, `declared-indexes.ts`, `entity-ddl.ts`,
  `column-store.ts`, `document-integrity.ts`
- `apps/operate-server/src/operational-retention.ts`, `cli.ts`, `node.ts`
- ADR-0357, ADR-0425, ADR-0438, ADR-0423, ADR-0424, ADR-0400, ADR-0389, ADR-0338
