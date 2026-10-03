# ADR-0322: A stranded deletion is reconciled from evidence, and an absence is not evidence

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0286, ADR-0288, ADR-0289, ADR-0315, ADR-0319, ADR-0320, ADR-0321 |

## Context

ADR-0321 made a tenant deletion asynchronous and left two of its own open questions as the top of the
list:

> Nothing moves a request out of `in_progress` after an `aborted` run. A human reads whether a
> tombstone exists for that tenant and transitions it by hand — there is no route for that, so they do
> it in SQL.

> `dueForExecution` orders by deadline and takes the first N. A tenant whose deletion refuses
> deterministically is now `rejected` and leaves the queue, but one that aborts stays `in_progress` and
> is simply never seen again — neither retried nor surfaced anywhere but a log line.

Both are real, and the second makes the first worse: a stranded request is invisible. The runner's
`aborted` and `completed_unrecorded` outcomes are correct about what *that process* can know — it
cannot prove whether the pipeline committed, and re-running on an assumption is how a tenant gets
deleted twice — but "a human will look at it in SQL" is not a mechanism, and nothing told the human
there was anything to look at.

ADR-0321's own live run left one behind: `dreq_eccf50f4…` sat `in_progress` from the moment the
pre-fix `scope_empty` case stranded it, and nothing in the system would ever have mentioned it again.

## Decision

**A stranded request is resolved from evidence in the database, and the two directions of that
evidence are not symmetric.**

The pipeline writes the tombstone in the **same transaction** as the `DROP SCHEMA` (ADR-0319), and
ADR-0321 put the request's id on the tombstone as `relatedDeletionRequestId`. Therefore:

> **a tombstone naming the request exists ⟺ that request's deletion committed.**

So nothing here infers from the tenant's schema being absent, from a log line, or from how long ago
the run was. It asks the tombstone table one question. A process that died between the commit and the
status write left the answer behind in the database.

`DeletionReconciler` returns one of five verdicts:

| Verdict | Means | Applied |
|---|---|---|
| `completed_by_evidence` | exactly one tombstone names it | **always**, at any age |
| `never_committed` | no tombstone, and stranded past the window | only on an operator's explicit authorisation |
| `ambiguous_evidence` | more than one tombstone names it | **never** |
| `too_recent` | no tombstone, inside the window | never |
| `not_stranded` | not `in_progress` | never |

### Presence is conclusive; absence is an inference

A tombstone is conclusive **the moment it exists**, whatever the request's age — recording a deletion
that demonstrably happened destroys nothing, and the case worth repairing fastest is exactly the
recent one (`completed_unrecorded`, where the pipeline committed and the status write failed).

An *absence* is only an inference, because "not committed" and "not committed **yet**" look identical:
a pipeline running right now has written no tombstone either. So `never_committed` is gated behind
`--deletion-stranded-after-ms` (floor 60s, default 1h — deliberately far longer than any pipeline
run), is never applied by a scheduler, and is reported as its own verdict so a caller can see it is
reasoning from silence rather than from a record.

This is the same shape as ADR-0315's two answers to "what if we cannot tell?" — each correct for its
position, and deliberately not reconciled into one rule.

### The caller asks for a resolution; they do not supply the answer

`POST /v1/platform/deletion-requests/{id}/reconcile` takes no verdict. The only thing a body may say
is `acceptNeverCommitted`, which authorises applying the inference — not choosing it. The evidence
still decides, so an operator cannot mark a deletion complete by hand through this route, and
`acceptNeverCommitted` on a `too_recent` or `ambiguous_evidence` verdict writes nothing (verified
live).

A verdict that was not applied answers **409**, not 200: the caller asked for a resolution and did not
get one, and a 200 would read as "resolved".

### The scheduler repairs, and the list reports

The `DeletionScheduler` tick now runs `reconcileStranded` after `runDue`, in a **separate** `try`, so a
repair pass still happens on a tick whose run threw — the most likely reason a request is stranded is
that a run failed.

It logs **only what it wrote**. An unapplied verdict is a standing fact about a row, so reporting it
from a scheduler would repeat it every single tick for as long as the row exists; that is what
`GET /v1/platform/deletion-requests/stranded` is for. Found by watching the real server log
`too_recent` every three seconds.

### `/stranded` is a literal route declared before `{id}`

`matchRoute` returns the first declaration-order match with **no** preference for a literal over a
parameter, so after the `{id}` route this would be read as a request whose id is "stranded". The
ordering is pinned by a test against the real matcher rather than by a comment.

## Alternatives considered

- **Option A:** have the runner retry a stranded request instead of reconciling it.
  - **Pros:** no new concept; self-healing.
  - **Cons:** it is the thing ADR-0321 refused for a reason. A retry of a deletion whose first attempt
    may have committed is a second deletion, and `DELETION_REQUEST_TRANSITIONS` has no path back to
    `verified` precisely so this cannot be written by accident.
  - **Why not:** the question is not "run it again", it is "what already happened" — and the database
    knows.

- **Option B:** infer from the tenant's schema being gone rather than from the tombstone.
  - **Pros:** no join; it is the thing the deletion actually destroys.
  - **Cons:** absence of a schema proves far less than it appears to. A tenant on the JSONB fallback
    never had one (ADR-0314), an earlier erasure may have removed it (ADR-0316), and a tenant deleted
    by the synchronous route has no schema either — none of which says anything about *this* request.
  - **Why not:** the tombstone is the record that commits to what was destroyed, and it is the only
    artifact tied to the request by id.

- **Option C:** let the reconcile route accept the verdict from the caller.
  - **Pros:** an operator who has investigated can simply state the outcome; no window to tune.
  - **Cons:** it makes "mark this deletion completed" an API call. The completion digest would then be
    supplied rather than read off the proof, and the join ADR-0321 added becomes a claim instead of a
    fact.
  - **Why not:** the one judgement an operator genuinely holds is whether to trust an absence, so that
    is the only thing the body carries.

- **Option D:** apply `never_committed` automatically once past the window.
  - **Pros:** fully automatic; no stranded rows at all.
  - **Cons:** the window is a guess about the longest possible pipeline run, and a deletion of a very
    large tenant could exceed any value chosen. Being wrong means a request marked `rejected` while its
    deletion was still committing — a request and a tombstone that contradict each other.
  - **Why not:** the cost of waiting is a row on a list; the cost of being wrong is a false record of a
    GDPR erasure. Only a human should spend the second one.

- **Option E:** a separate interval for reconciliation.
  - **Pros:** independently tunable; a repair pass could run far less often than the runner.
  - **Cons:** two knobs describing one queue. A stranded request is the residue of the work this
    scheduler does.
  - **Why not:** same tick, separate `try`, which gets the independence that actually matters.

## Consequences

- **Positive:** ADR-0321's top two open questions are closed. A committed deletion whose status write
  failed now repairs itself, with the request's `completionSha256` taken from the stored proof rather
  than recomputed. A stranded request is visible on a list with a verdict beside it, and resolving one
  is an audited route rather than hand-written SQL.
- **Negative:** `never_committed` still needs a human, by design. A deployment that never looks at
  `GET .../stranded` accumulates rows that nothing resolves — fewer than before, since the conclusive
  half is automatic, but the list is only as good as the habit of reading it.
- **Negative:** the window is a tuned constant standing in for "longer than any pipeline run". There is
  no way to derive it, and a deployment with very large tenants should raise it.
- **Neutral:** reconciliation needs the forensic chain, because the tombstone table is its evidence. A
  deployment with `--deletion-request-routes` and no `--audit-chain-config` mounts the routes, writes
  **unanchored** audit rows, and answers **501** on the two reconciliation routes. That path existed
  silently — the audit emitter does not require the chain — and now warns at boot.
- **Reversibility:** the grant defaults to nobody, so the two routes are unreachable until granted; the
  scheduler's repair pass is inert when no reconciler is wired.

## Implementation notes

- `packages/tenant-lifecycle-pg/src/deletion-reconciliation.ts`, plus two reads the evidence needed:
  `PostgresTombstoneStore.findForRequest` (no `LIMIT`, so two tombstones for one request are *visible*
  rather than silently resolved to the first) and `PostgresDeletionRequestStore.stranded`.
- `assess` is the verdict alone and writes nothing; `reconcileOne` fetches the evidence **once** and
  reuses it, so the digest written to the request is the one read from the proof.
- A failure to retire the tenant row leaves the completion recorded: the request is already correct
  against a real tombstone, and failing the whole reconciliation over the row's status would undo the
  part that was worth doing. `tenantRetired` is `null` rather than `false` when not attempted —
  "cannot say" and "matched nothing" are different answers (ADR-0318's habit).
- `typecheck` caught both wiring mistakes before anything ran: a `DeletionReconcilerLike` name
  collision between the route and scheduler mirrors, and the route mirror drifting from the store it
  mirrors. Exactly ADR-0307's argument for typechecking tests and mirrors.
- Verified live against a real Postgres and the real server, in both directions.
  **Evidence:** a real deletion of a tenant with 9 invoices completed with tombstone `tomb_59408969…`;
  the request row was then forced back to `in_progress` with its tombstone id, digest and
  `completed_at` cleared — exactly the row `completed_unrecorded` leaves — and the **scheduler repaired
  it unprompted on the next tick**, writing `completed`, the tombstone id, and
  `completion_sha256 = 153b37ce…`, byte-identical to the stored `proof_sha256`, with the tenant row
  `deleted`. It did so *inside* the one-hour window, which is the asymmetry working.
  **Absence:** ADR-0321's genuinely stranded `dreq_eccf50f4…` read `too_recent` at 31 minutes and
  `acceptNeverCommitted: true` was **refused (409)** anyway; restarted with
  `--deletion-stranded-after-ms 60000` the same request read `never_committed`, was refused **409**
  without authorisation, and with it returned **200** `rejected` —
  `"reconciled: no tombstone names this request, so its transaction did not commit"` — leaving tenant
  `t-b` `active`. Three anchored `platform.deletion_request_reconciled` rows record it, distinguishing
  `assessed:` from `applied:`. An `auditor` key was refused the stranded listing (403), and the
  no-chain deployment answered **501**.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `ambiguous_evidence` is detected and never resolved. Two tombstones naming one request means the pipeline's one-transaction premise was broken; nothing raises an incident for it, and it is reported only to whoever reads the list. | amoufaq5 | _unscheduled_ |
| The staleness window is a tuned constant standing in for "longer than any pipeline run", with no way to derive it. A deletion of a very large tenant could exceed any chosen value. | amoufaq5 | _unscheduled_ |
| Nothing notices a *stranded* request the way `--integrity-proof-config` notices a broken chain: there is no alert, only a list and a log line for applied repairs. A deployment that never reads the list never learns. | amoufaq5 | _unscheduled_ |
| A reconciliation that completes a request does not re-verify the tombstone it reads (`store.verify` exists and is not called), so a tampered proof would be copied onto the request as-is. | amoufaq5 | _unscheduled_ |
| The reverse stranding is unhandled: a request `completed` against a tombstone that no longer exists would be found by nothing, since reconciliation only looks at `in_progress`. | amoufaq5 | _unscheduled_ |

## References

- ADR-0321 (the two open questions this closes, and the id on the tombstone that makes it possible),
  ADR-0319 (one transaction, which is what makes the tombstone's existence conclusive), ADR-0320 (the
  erase-before-retire ordering reused here), ADR-0315 (two answers to "what if we cannot tell?"),
  ADR-0289 (a store that re-parses what it reads), ADR-0288 (a feature degrading quietly at boot),
  ADR-0307 (typechecking the mirrors, which caught two mistakes here).
- GDPR Article 17: a request that reads `in_progress` forever is an unanswered erasure request.
