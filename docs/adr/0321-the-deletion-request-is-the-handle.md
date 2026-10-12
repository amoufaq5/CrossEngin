# ADR-0321: The deletion request is the handle, and a scheduler does the work

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0289, ADR-0300, ADR-0315, ADR-0316, ADR-0317, ADR-0318, ADR-0319, ADR-0320 |

## Context

ADR-0320 made the GDPR Article 17 flow reachable and named what that cost, in its own open
questions: the deletion holds `ACCESS EXCLUSIVE` on a whole tenant's tables plus a full `count(*)`
*inside an HTTP request*, so a large tenant can outlast a proxy timeout — and the client then never
learns the receipt it is obliged to keep. The idempotency key makes the retry safe. It does not make
the call bounded.

A longer timeout is not the fix. The fix is for the caller to hold a **handle** rather than an open
connection.

`meta.gdpr_deletion_requests` has existed since Phase 1 with nothing ever writing it — the third
instance of ADR-0300's finding, after `meta.feature_flags` and `meta.tenant_tombstones` — and its
state machine is exactly the one this needs: `submitted → verified → in_progress → completed`.

Three things it needed before it could be that handle, each a recurrence of a defect this repo has
already paid for once:

- **`request_id`**, free text with a `dreq_…` CHECK. `TombstoneRecord.relatedDeletionRequestId` is
  free text, so a tombstone must be able to name the request that caused it. The surrogate `id`
  stays as the primary key.
- **`verified_by` as TEXT with no reference.** It pointed at `meta.users` with `ON DELETE RESTRICT`,
  which would have made a verifier undeletable *because they verified the request to delete them* —
  ADR-0318's finding, in a second table.
- **`tombstone_id`.** `completion_sha256` commits to the proof and cannot find it, so a completed
  request and the deletion it asked for could not be joined.

## Decision

**The request is the handle. Four routes own it, a scheduler does the work, and the tombstone id
lands back on the request.**

```
POST /v1/platform/deletion-requests              submit → submitted
POST /v1/platform/deletion-requests/{id}/verify  verify → verified   (the runner's queue)
POST /v1/platform/deletion-requests/{id}/reject  reject → rejected
GET  /v1/platform/deletion-requests/{id}         poll   → status, and the tombstone once there is one
```

Behind `--deletion-request-routes` with its grants defaulting to **nobody**, and
`--deletion-runner-ms` for the scheduler, off unless set. `GdprDeletionRequest.tombstoneId` is a new
contract field, load-bearing in both directions: a `completed` request must name its tombstone, and
an uncompleted one must not.

### The claim is the lock, and it is taken before the pipeline runs

`PostgresDeletionRequestStore.transition` re-asserts the current status **inside the `UPDATE`
predicate**, so of two schedulers reading the same `verified` request exactly one `UPDATE` matches.
`rowCount === 0` is information — somebody else took it — not a failure. Nothing else serialises
this: there is no advisory lock, because the row *is* the lock. The same shape as ADR-0315's
`requestJobCancellation`.

### A rolled-back pipeline is `rejected`; anything else is left `in_progress`

This is the part the live run corrected, and the distinction is the decision.

`DeletionPipelineAborted` is raised by the pipeline **inside** `conn.transaction` (ADR-0319), so
receiving it *proves* the transaction rolled back: the tenant is untouched, and the refusal that
caused it — an unattested subsystem, an empty scope — will refuse identically on every retry. That
is a terminal, knowable refusal, so the request is marked `rejected` with the reason.

Anything *else* thrown — a connection lost at commit time — is genuinely unknown. Only that gets the
open-ended `aborted`, which leaves the request `in_progress` for a human, because
`DELETION_REQUEST_TRANSITIONS` offers no way back to `verified` and re-running on an assumption is
how a tenant gets deleted twice.

Found live, not by a test: a tenant with no schema of its own refused `assemble/scope_empty` and
left its request stuck `in_progress` — precisely the state ADR-0320's caller could learn nothing
from, reproduced inside the mechanism built to fix it.

### The scheduler does not run at boot

Every sibling scheduler in this app — `JobScheduler`, `PruneScheduler`, `DeliveryScheduler` — sweeps
once immediately on `start()`, because a missed prune or a late notification costs nothing. This one
waits a full interval. A boot is the moment a misconfiguration is most likely (wrong flags, wrong
actor, a manifest that did not load) and the work here irreversibly destroys a tenant's data; an
operator restarting the server to fix something gets an interval's grace, and nothing is lost by
waiting, because the deadline is weeks away.

### Four-eyes twice over, between different pairs

The **verifier may not be the submitter**: verification is the platform attesting that the subject's
identity was checked, and the person who typed the request in cannot also be the one who attests the
check passed. That is *not* the pipeline's four-eyes, which is between the executor and the approver
of the deletion itself — the runner supplies both (`system:deletion-runner` /
`system:retention-policy`, refused at CLI parse time if they match, and again at the runner's
construction). A data subject asking for erasure is neither party.

### The request id is generated server-side, and the submit requires an idempotency key

The store is idempotent on `request_id`, so a caller-chosen id would be the natural handle — but a
caller who picked an id another tenant's request already held would be *handed that request back*,
turning an id collision into a cross-tenant disclosure. Generated here it cannot collide, and the
gateway's idempotency layer is what makes the retry return the same handle. The same reasoning
ADR-0320 used to refuse a caller-supplied tombstone id.

### The deadline is computed from the deployment, not accepted from the body

Article 12(3) gives one month, extendable to three; the contract caps it and would refuse a longer
one. A body field could therefore only let a caller ask for a *shorter* deadline than the platform
committed to, or trip a contract refusal on a typo. `--deletion-request-deadline-days` (1..90,
default 30) sets it per deployment.

### An unreadable request is a 503, never a 404

The store re-parses every row (ADR-0289), so a throw can mean a stored request no longer satisfies
its contract. This is the route a caller polls to learn whether a deletion happened; answering 404
would read as "no such request", which is the opposite of true.

## Alternatives considered

- **Option A:** raise the proxy timeout and keep the synchronous route as the only path.
  - **Pros:** nothing new to build; one endpoint.
  - **Cons:** the bound is unknowable — it is a function of the tenant's row count, which is the one
    thing a deletion cannot measure before committing to it. And a timeout is not the only way a
    connection dies.
  - **Why not:** it makes the window smaller without making it closed. ADR-0320's route stays for a
    caller who wants the receipt in the response; this adds the path for one who cannot wait.

- **Option B:** let the caller choose the `request_id`, so the store's idempotency is the handle.
  - **Pros:** no idempotency key to manage; the caller's own id is the handle, which is the simplest
    possible retry story.
  - **Cons:** `ON CONFLICT (request_id) DO NOTHING` followed by a read returns *the existing row* —
    so a colliding id hands a caller another tenant's deletion request. A cross-tenant disclosure
    out of a convenience.
  - **Why not:** it could be guarded (compare the stored tenant to the submitted one and refuse),
    but generating the id removes the class instead of checking for it.

- **Option C:** have the scheduler claim with an advisory lock rather than the row.
  - **Pros:** familiar; the rest of this repo reaches for `withAdvisoryLock` readily.
  - **Cons:** a second mechanism to agree with the status column, and the column is already
    authoritative. A lock held by a process that dies is released; a claimed row is not, which is the
    behaviour wanted here.
  - **Why not:** the row is the lock, and it is also the audit trail of who claimed what when.

- **Option D:** return `verified` on a rolled-back pipeline so the next tick retries it.
  - **Pros:** self-healing for a transient failure.
  - **Cons:** `DELETION_REQUEST_TRANSITIONS` does not allow it, deliberately, and a deterministic
    refusal would loop forever — `scope_empty` refuses every tick, as the live run showed.
  - **Why not:** a refusal that cannot succeed should be terminal, and one whose outcome is unknown
    should not be retried at all. Both are now distinguished by the exception's type.

- **Option E:** run the pipeline on the `workflow-worker` job infrastructure rather than a scheduler.
  - **Pros:** leases, retries, dead letters and cancellation already exist there (ADR-0315).
  - **Cons:** a job's retry is the wrong default for this: the one thing a failed deletion must not do
    is retry itself. And the job would need the whole serving wiring — the tombstone store, the chain,
    the registry — inside a handler registry.
  - **Why not:** worth revisiting if deletions ever need to run on a worker fleet rather than the API
    process. The claim semantics would be unchanged, since they live in the row.

## Consequences

- **Positive:** a caller holds a handle instead of a connection, the deletion runs out of band at
  whatever pace the database allows, and the tombstone id lands on the request so the receipt is
  findable after the fact. A refused deletion now reaches a terminal state the caller can read.
- **Negative:** the receipt is no longer *in* the response. A caller must poll, and the handle gives
  them the tombstone id rather than the full receipt — they read that from
  `GET /v1/platform/tenants/{id}/tombstones`, which is a separate grant. Two round trips where the
  synchronous route needed one.
- **Negative:** the runner always deletes as `data_subject_erasure` with no attestations beyond the
  schema's own. A tenant wind-down, or a deletion that must cover object storage, still goes through
  ADR-0320's synchronous route where a person supplies the attestations.
- **Neutral:** `--deletion-runner-ms` and `--deletion-request-routes` are independent. A deployment
  can expose the handle without running deletions (requests queue), or run deletions without the
  routes (requests arrive another way). Neither is a mistake, so neither is refused.
- **Reversibility:** both flags default off and every grant defaults to nobody, so a deployment that
  does not configure them cannot reach any of this.

## Implementation notes

- `packages/tenant-lifecycle-pg/src/deletion-request-store.ts` and `deletion-runner.ts`;
  `apps/operate-server/src/deletion-request-routes.ts` and `deletion-scheduler.ts`. The route and
  scheduler files hold structural mirrors of what they drive, so the HTTP layer imports neither the
  contracts package nor `tenant-lifecycle-pg`.
- `META_GDPR_DELETION_REQUESTS` gained `request_id` (unique, CHECK), `tombstone_id` (CHECK),
  `verified_by` widened to TEXT with its reference dropped, a partial index
  `idx_gdpr_deletion_due (status, deadline_at) WHERE status = 'verified'` for the runner's query, and
  a `SELECT`-only `gdpr_deletion_requests_platform_audit_read` policy — the **third** table to need
  that shape (ADR-0313), and the third exception line in `kernel-pg`'s `NARROWED_POLICIES`.
- `--deletion-request-routes` and `--deletion-runner-ms` are the **fifth and sixth** flags to join
  `needsAuditEmitter` (ADR-0288, ADR-0313, ADR-0316, ADR-0320). The named predicate and its per-flag
  test caught them both again.
- The runner's `onRun` does the bookkeeping the synchronous route's handler does: retires the tenant
  row *after* the pipeline commits (ADR-0316's ordering, found the hard way) and emits
  `platform.tenant_deleted` naming the request that caused it.
- Verified live against a real Postgres and the real server. The migration reconciled exactly as
  planned on an existing database (`add_column request_id`, `add_column tombstone_id`,
  `drop_foreign_key`, `alter_column_type verified_by` guarded, `create_index`,
  `add_unique_constraint` guarded, `create_policy` — 8 statements, 0 failed). Then end to end: a
  `support` key submitted (and was refused the verify); a `platform_admin` key verified (and was
  refused the submit) and got a **202**; the runner's first tick erased the tenant's 17 invoices,
  stored tombstone `tomb_1c9d…` at chain sequence 48 with `related_deletion_request_id` naming the
  request, retired the tenant row, and the handle read `completed` with its `tombstoneId` and
  `completionSha256`. The audit trail held four anchored rows: submitted, verified, `tenant_deleted`
  with `tenantRetired: true`, then the read. A request whose verifier was its own submitter was
  refused **403 four_eyes_required**; verifying an already-completed request was **409
  illegal_transition**. A tenant with nothing to erase was **rejected** with
  `rolled back: assemble/scope_empty` and left `active` — the case that was stuck `in_progress`
  before the fix. And a verified request sat untouched through a boot with a ten-minute interval,
  which is the no-sweep-at-boot rule.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Nothing moves a request out of `in_progress` after an `aborted` run. A human reads whether a tombstone exists for that tenant and transitions it by hand — there is no route for that, so they do it in SQL. | amoufaq5 | _unscheduled_ |
| The runner deletes as `data_subject_erasure` with no attestations but the schema's. Object storage, backups, search and caches still cannot attest (ADR-0317), so an unattended deletion declares them out of scope by omission — the same gap, now on a schedule. | amoufaq5 | _unscheduled_ |
| `dueForExecution` orders by deadline and takes the first N. A tenant whose deletion refuses deterministically is now `rejected` and leaves the queue, but one that aborts stays `in_progress` and is simply never seen again — neither retried nor surfaced anywhere but a log line. | amoufaq5 | _unscheduled_ |
| A request is submitted for a tenant, not for a subject within one: the pipeline erases the whole tenant schema. `subjectIdentifier` is recorded and not acted on, so a single data subject inside a multi-user tenant cannot be erased by this path at all. | amoufaq5 | _unscheduled_ |
| Two replicas both running `--deletion-runner-ms` is safe but wasteful: each tick reads the same due list and all but one claim fails. Harmless at this cadence; a lease would be needed at a fleet. | amoufaq5 | _unscheduled_ |

## References

- ADR-0320 (the open question this answers, verbatim), ADR-0319 (the atomic pipeline and why
  `DeletionPipelineAborted` proves a rollback), ADR-0318 (the tombstone store, and `verified_by`'s
  defect in its sibling table), ADR-0317 (attestations and `scope_empty`), ADR-0316 (erase before
  retire), ADR-0315 (re-asserting a premise inside the `UPDATE` predicate), ADR-0313 (the
  `SELECT`-only platform read policy), ADR-0300 (a table declared and never written), ADR-0289 (a
  store that re-parses what it reads).
- GDPR Article 17; Article 12(3) for the deadline and its three-month cap.
