# ADR-0175: Durable due-timer claim (FOR UPDATE SKIP LOCKED) — first P2 primitive

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (Phase 3 plan — P2 distributed execution), ADR-0049 (workflow-runtime), ADR-0050/0035 (workflow-runtime-pg persistence) |

## Context

The workflow runtime (M3) fires timers in-process via `tickTimers`. Phase 3 P2 makes execution
**distributed** — a fleet of workers, `SELECT … FOR UPDATE SKIP LOCKED` off a Postgres queue, at
least-once, crash-recoverable. The foundational primitive under all of that is a durable **claim**:
let N workers pull due timers concurrently without any two grabbing the same one. This ADR ships
that primitive (the worker loop + job side follow).

## Decision

- **Lease columns on `meta.workflow_timers`.** `claimed_by TEXT` + `claim_expires_at TIMESTAMPTZ`
  (nullable), plus an `idx_workflow_timers_due (status, fire_at)` for the due scan. No new table.
- **`claimDueTimers(conn, {workerId, now, limit, leaseMs, schema})`** (`workflow-runtime-pg`).
  A single statement: a CTE selects up to `limit` `scheduled` timers with `fire_at <= now` **and**
  no live claim (`claimed_by IS NULL OR claim_expires_at < now`), `ORDER BY fire_at`, `FOR UPDATE
  SKIP LOCKED`; the outer `UPDATE … FROM due` stamps `claimed_by` + a precomputed `claim_expires_at`
  (`now + leaseMs`, computed in JS — no SQL interval math) and `RETURNING` the claimed rows as
  `ClaimedTimer[]`. `SKIP LOCKED` gives each concurrent worker a **disjoint** batch; the lapsed-lease
  predicate recovers a crashed worker's timers. Firing a timer flips its status to `fired`, which
  drops it from the `scheduled` claim set — so the lease is advisory, not the source of truth.
- **`releaseTimerClaim(conn, {timerId, workerId})`** hands a claimed-but-unprocessed timer straight
  back (clears the claim) for immediate re-claim, scoped to the owning worker + a still-`scheduled`
  row.
- The worker connection is **platform-scoped** (RLS-bypassing, like the replayer's bulk sweeps), so
  one fleet serves every tenant; `tenant_id` rides back on each claimed row for the worker to set
  context when it advances the instance.

## Consequences

- The queue-claim semantics P2 needs exist and are proven: concurrent workers never double-claim
  (SKIP LOCKED), crashed-worker timers are recoverable (lease expiry), and a failed claim can be
  released for retry — the substrate for the worker loop.
- No behavior change to existing code: the columns are additive/nullable, the projection writers
  and in-process `tickTimers` are untouched. A live claim is invisible to anything that doesn't
  read the new columns.
- Schema identifier is validated; every value is bound (worker id, now, limit, lease all
  parameterized) — no interpolation.
- 6,801 tests pass (+6: the claim SQL shape (SKIP LOCKED / due predicate / lapsed-lease reclaim),
  param binding + precomputed lease, row mapping incl. null transition, limit/lease/schema guards,
  and the scoped release). Full build + typecheck green; kernel meta-schema unchanged in count.
- Follow-ups: `@crossengin/workflow-worker` (the poll → claim → fire → ack loop over this primitive);
  the same claim pattern for scheduled **activities** and `jobs` (cron + event triggers); dead-letter
  after max retries; the P2 exit-criterion end-to-end test (kill worker A mid-flight → resume on B).
