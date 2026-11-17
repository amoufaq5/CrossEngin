# ADR-0438: A migration waits a bounded time for a lock, a plan takes none, and a flag it does not know is refused

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0290 (reconciliation, not replay), ADR-0292 (expressions compared by asking Postgres to deparse them), ADR-0338 (refuse only what breaks nothing correct, or announce a hatch), ADR-0363 (the quiesce lock in the guard blocks), ADR-0423 (the `document-indexes` step), ADR-0424 (the confined serving role), ADR-0047 (`drift` as the CI guard rail) |

## Context

**H-23**: *migrations lock large tables, have no down path, and "plan" mode is not read-only*. The
verified report graded it true and open at `f6faf05`: non-concurrent index builds, no
`lock_timeout`, a drift/plan probe that takes ACCESS EXCLUSIVE per expression and swallows its
errors, a `crossengin-pg` that silently drops unknown and `=`-form flags, and `apply` on every
compose `up` with no down path. Measured live on PG 16.15 before any change:

- **`apply --plan` was not read-only in effect.** It made a plain `SELECT` on `meta.audit_log` wait
  **6.03 s** (the plan itself took 8.57 s). The cause was the expression probe: ADR-0292 deparses a
  declared expression by attaching it as `ALTER TABLE … ADD CONSTRAINT … NOT VALID` to the **real**
  table inside a savepoint, and that statement takes ACCESS EXCLUSIVE.
- **An apply could hold every reader behind it without bound.** A `replace_index` waiting behind one
  open reader made a later `SELECT` wait **6.04 s**, and nothing ended the wait.
- **A mistyped flag applied changes.** `crossengin-pg apply --plan=true` and `apply --paln`, and
  architect-cli `apply --paln` / `--plan yes` / `--plan=yes`, all applied. An unknown command
  (`aply`) printed help and exited 0.
- **A failed concurrent build read as healthy.** A real failed `CREATE INDEX CONCURRENTLY` left an
  invalid index that introspection read as present and matching, so plan and drift said nothing.

## Decision

**Every transactional statement the applier runs is bounded.** It runs under
`SET LOCAL lock_timeout` (default **5 s**) and `SET LOCAL statement_timeout` (default **10 min**). A
lock timeout is retried twice, after 1 s and 2 s pauses; a statement timeout is not retried. A
failure names the table and the remedy, and `formatApplyReport` says how many statements gave up on
a lock. `--lock-timeout-ms`, `--statement-timeout-ms` and `--lock-retries` set them on both CLIs.

**The bound is a behaviour change, so it has an announced hatch** (ADR-0338): an upgrade that used
to block until its lock arrived now exits 1 after three bounded attempts. `--lock-timeout-ms 0` and
`--statement-timeout-ms 0` restore the old unbounded wait.

**An index on a populated table is built `CONCURRENTLY`, outside any transaction.**
`statementRunsOutsideTransaction` recognises `CREATE`/`DROP INDEX CONCURRENTLY` and
`REINDEX … CONCURRENTLY`, and the applier runs them bare. A `create_index` is planned concurrent
unless the probe saw the table empty — asked with `SELECT EXISTS`, and never on an RLS-confined
session, which would see a populated table as empty. A fresh bootstrap therefore still uses plain
DDL.

**An invalid index is not a present one.** Introspection reads `indisvalid AND indisready`; an
invalid index is a new diff reason, `invalid`, planned as `rebuild_invalid_index`:
`DROP INDEX CONCURRENTLY IF EXISTS` then `CREATE INDEX CONCURRENTLY`.

**The expression probe takes no lock a reader waits on.** It deparses against a
`CREATE TEMP TABLE … (LIKE t)` copy, which takes ACCESS SHARE on the real table, under its own
`lock_timeout`. Its errors are classified: SQLSTATE class 42 (except 42501), class 22 and `0A000`
mean the declared expression cannot be applied; anything else (`42501`, `55P03`, `57014`, no
SQLSTATE) means the expression was **not compared** — never that it drifted.

**An expression not compared is a failure, not an all-clear.** `driftExitCode` and `applyExitCode`
exit 1 when anything is uncompared (`--exit-zero-on-drift` still overrides drift). `drift` prints a
`NOT VERIFIED — N … not compared` header; both `apply` commands print the list and the remedy per
cause (`55P03`: re-run or raise `--lock-timeout-ms`; `42501`: run as the schema owner). This refuses
nothing correct: a non-owner apply already exited 1 under the old probe, and `migrate` runs as the
owner, so it meets this only on a lock timeout, which a re-run clears.

**Flags are parsed strictly.** `crossengin-pg` has a per-command parser accepting `--x=v` and
`--x v`, with booleans bare or `=true`/`=false`; an unknown or repeated flag, a stray positional or
an unknown command exits 2. architect-cli's `apply` reads its flags through `readApplyFlags`, which
refuses an unknown flag and an unrecognised boolean value.

**There is no down path, and the documents say why.** Migration is reconciliation against the live
schema (ADR-0290), so a rollback is the previous catalog reconciled or a restore. `deploy/README.md`
says to dump before `up -d --build`, how to preview with `--plan`, and documents the bounds, their
hatches and the concurrent-index behaviour. The compose `migrate` command is unchanged and carries a
comment.

## Alternatives considered

- **Keep probing the real table, inside a savepoint.** Refused: the savepoint scopes the change, not
  the lock — ACCESS EXCLUSIVE is held until the statement ends, which is what made a `SELECT` wait
  6.03 s behind a plan.
- **A `READ ONLY` probe transaction.** Not possible: Postgres refuses `CREATE TEMP TABLE` in a
  read-only transaction. The temp copy is what makes the probe lock-free, and it costs read-only-ness.
- **Treat every probe error as drift.** Refused: a lock timeout or a missing privilege says nothing
  about the expression, and reporting it as drift would send an operator to change a correct
  catalog.
- **Treat an uncompared expression as no drift.** Refused after review, on a live measurement: as the
  non-owner `serving` role with `TEMPORARY` revoked, all **1,072** expressions were uncompared, a
  tenant-isolation policy edited to `USING (true)` went unreported, and `drift` printed "(no drift)";
  only an unrelated index difference kept that run at exit 1. `drift` is the CI guard rail, so a 0
  there is a false all-clear.
- **`replace_index` as a concurrent build-and-swap.** Refused: under the applier's continue past
  failure default, a failure between the build and the swap leaves two indexes or none. It stays one
  blocking transaction, bounded by the timeouts.
- **No hatch: always bounded.** Refused under ADR-0338: a deployment whose upgrade blocked and then
  succeeded today would exit 1 instead, so the old behaviour must stay reachable by name.

## Consequences

- **Positive:** a plan and a drift check no longer hold readers; an apply's stall is bounded at about
  5 s per attempt; a populated table gains an index without blocking writes; a failed concurrent
  build is seen and repaired; a typo cannot apply changes; `drift` cannot report clean over
  expressions it never compared.
- **Negative:** a busy table can make an upgrade exit 1 where it used to wait; a concurrent build
  runs with no timeout; `replace_index` still blocks writes for the rebuild; the probe needs `TEMP` on
  the database.
- **Neutral:** a fresh bootstrap is unchanged (plain DDL, 984/984 executed).
- **Reversibility:** the two `0` hatches restore the old waits per invocation; the rest is CLI and
  planner code with no schema change.

## Implementation notes

In-process: kernel-pg 928/928, architect-cli 275/275, testing 796/796, operate-server
`deployment-defaults.test.ts` 82/82; both typechecks clean. Eleven fences were mutated and each was
caught: concurrent selection (4 tests), the `invalid` diff reason (2), 42501 classification (2), the
confined-session skip (1), the applier `SET LOCAL` (3), the probe `SET LOCAL` (2), outside-transaction
detection (10), unknown-flag refusal (4), strict boolean in `apply` (2), and `uncompared` dropped from
each exit function. Review found two mutations the suite did not catch — `valid: true` in
`parseLiveSchema` and `true AS is_valid` in `INDEX_QUERY` — and added a test for each, including one
fencing the decision to read a missing validity column as valid.

Live, PG 16.15, by the implementation:

- `apply --plan` against the same held reader: the `SELECT` took **0.03 s**, the plan **1.3 s**; a
  converged catalog still reads "nothing to do" and "no drift".
- `replace_index` against a 20 s reader: three attempts, exit 1 after 19.4 s naming
  `meta.audit_log`. A concurrent `SELECT` still waited **4.9 s** — the stall is bounded, not removed.
- 2,000 rows: the index was built `[concurrent]` outside a transaction and is valid; on an empty
  table it stayed plain. A real failed concurrent build shows as `[invalid]` and the next apply
  repairs it.
- Every flag refusal above exits 2, and `--plan=true` plans.

Live, by review: a concurrent `SELECT` waited **0.04 s** behind a plan; the temp-copy probe still
reported a CHECK drift, a policy drift and a partial-index drift, as owner and as a non-owner with
grants; `replace_policy` behind an 8 s reader timed out naming `meta.invoices`, exited 1 having
changed nothing, and a re-run converged; a unique concurrent build over duplicates left an invalid
index planned `rebuild_invalid_index [concurrent]` and repaired once the duplicates went (and, against
the expectation, left `indisvalid = f, indisready = f` with updates and inserts still succeeding); the
`NOT VERIFIED` drift arm exits 1, and 0 under `--exit-zero-on-drift`.

Live, at `71ab21e` in compose order (migrate as owner, `app-role.sql`, `document-indexes`):
`crossengin apply --plan` with a reader on `meta.audit_log` — the `SELECT` waited **0.038 s** and the
plan listed `replace_policy` without changing the policy; `apply --confirm` behind a 30 s transaction
on `meta.invoices` exited 1 after 19.3 s ("lock timeout on meta.invoices: waited 5000 ms, 3 time(s) …
changed nothing", executed 0), and the re-run executed 1 and `drift` then read "(no drift)", exit 0; a
dropped index on a populated table was rebuilt `[concurrent]` with `indisvalid = t`;
`crossengin-pg apply --paln`, `crossengin apply --paln` and `--plan=yes` each exited 2; `drift` as
`crossengin_app` read no drift and 0 uncompared.

**The uncompared counts disagree across the three runs, and they measure different roles.** The
implementation reported 1,068 uncompared with `42501` as `serving`; review got 1,072 only after
revoking `TEMPORARY`, and **0** with `SELECT` granted and default `TEMP`; the live run got 0 as
`crossengin_app`. This ADR uses review's 1,072 as the measured failure, because it names its
precondition. `42501` needs `TEMP` (or `SELECT`) to be missing, so it is not the default case.

The review also corrected one README instruction: `tail -1` of a PG 16.15 dump is a blank line under
`\unrestrict …`, not `-- PostgreSQL database dump complete`; the check is now
`tail -5 <file> | grep -q 'PostgreSQL database dump complete'`, tried against a complete and a
truncated dump.

**Claims found false.** "Plan and drift take `tableQuiesceLock`" — they do not; that lock is only in
the guard blocks the apply path emits, and the probe was the only ACCESS EXCLUSIVE in plan and drift.
"`proveDeclarationWidens` and `proveWideningSafe` are not read-only" — both already run `READ ONLY`.
"The `migrate` job is idempotent (hash-tracked in `_meta_migrations`)" in the README — both CLIs use
`skipApplied: false`, so idempotency comes from reconciliation against the live schema; corrected.
"architect-cli drops `--flag=value`" — it parsed those already; its gaps were accepting unknown flags
and reading an unrecognised boolean as false. "Plan and drift swallow errors" was true.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `replace_index` still blocks writes for the rebuild, bounded only by the statement timeout. | platform | _open_ |
| A concurrent build has no timeout and can wait indefinitely for old transactions; it blocks only `migrate`. | platform | _open_ |
| A queued DDL statement still delays reads for up to `lock_timeout` per attempt. | platform | _open_ |
| The same lock waits remain outside this slice, measured live: `CREATE INDEX IF NOT EXISTS` on an existing index waits for `SHARE` (4.5 s behind a writer), and `ADD COLUMN IF NOT EXISTS` on an existing column takes ACCESS EXCLUSIVE (a `SELECT` waited 4.0 s). So `document-indexes` (every `up`, no lock timeout, deliberately non-concurrent per ADR-0423) and `ensureSchema` / `applyTenantManifestSchema` on `pg-columns` can still stall a table. | platform | _open_ |
| When `migrate` exits 1, the old `api` keeps serving a schema the applier left partially migrated, because it continues past failures. Predates this slice. That compose does not start the new `api` after a failed `migrate` is reasoned, not run under Docker. | platform | _open_ |
| architect-cli's shared parser lets a repeated flag win by last value (`--plan --plan=false` applies); `crossengin apply --help` now exits 2 rather than running apply, but help is not wired; its help text does not list the three new flags. | platform | _open_ |
| The README's "See the plan first" command omits `--confirm`, so it exits 2 when `POSTGRES_DB` looks like production. | platform | _open_ |
| The probe copy is `_crossengin_probe_N`, so an expression qualifying a column by its own table name (`invoices.x`) would fail with a class-42 error and read as false drift. No such expression exists today. | platform | _open_ |
| No down-migration system, by design (ADR-0290). | platform | _open_ |

## References

- `packages/kernel-pg/src/applier.ts`, `reconcile.ts` (`driftExitCode`, `applyExitCode`,
  `formatUncomparedApplyOutcome`), `expression-render.ts`, `diff.ts`, `introspection.ts`,
  `cli-flags.ts`, `crossengin-pg-args.ts`; `packages/kernel-pg/bin/crossengin-pg.ts`
- `apps/architect-cli/src/apply.ts` (`readApplyFlags`)
- `deploy/README.md`, `deploy/docker-compose.yml` (`migrate`)
- The external due-diligence audit, finding H-23 (R04-02…R04-07)
