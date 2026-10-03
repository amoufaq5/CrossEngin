# ADR-0320: The deletion flow is reachable, and the response is the receipt

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0288, ADR-0313, ADR-0316, ADR-0317, ADR-0318, ADR-0319 |

## Context

ADR-0319 made a tenant deletion atomic and left it unreachable. Four ADRs had now built a complete
GDPR Article 17 flow — erase, attest, assemble, anchor, store, all in one transaction — that nothing
could invoke.

`platform-admin.ts` had meanwhile excluded `deleted` from every entry in `TENANT_STATUS_TRANSITIONS`,
with the comment that "tenant deletion is the GDPR Article 17 flow in `tenant-lifecycle`, not a console
button". That was the right call and it left the state unreachable by *anything*, because the flow it
deferred to had no endpoint.

## Decision

**`POST /v1/platform/tenants/{id}/delete` runs the pipeline, and
`GET /v1/platform/tenants/{id}/tombstones` reads its receipts.** Behind `--tenant-deletion-routes`,
with `--tenant-deletion-role` defaulting to **nobody**. This is now the only route that reaches
`deleted`.

### Its own grant, separate from the erasure's

Erasing a schema destroys a tenant's business data. *Deleting the tenant* additionally ends the
relationship and issues a signed receipt for it. One contains the other, so sharing a grant would mean
anybody who can perform the step can perform the whole thing.

`--tenant-tombstone-read-role` is separable and defaults to the delete roles — anybody trusted to
destroy a tenant is trusted to read the receipt, but reading receipts is a reasonable thing to grant an
auditor who may not delete. Verified live: an `auditor` key reads tombstones and is refused the delete.

### The tenant row is retired *after* the pipeline commits

ADR-0316 found this ordering the hard way. The tombstone's chain anchor references `meta.tenants`, so
retiring the row first makes the deletion unrecordable — the 500 that ADR-0316's live run produced.

Committed in this order, a failure to retire leaves a correct, anchored tombstone and a tenant row that
still says `active`: visible, recoverable, and with the data correctly gone **and proven gone**. The
reverse leaves data destroyed with no provenance. So `retire` failing is logged and reported as
`tenantRetired: false` on a **200**, not turned into an error that implies the deletion did not happen.

### The response is the receipt

A 200 saying merely "deleted" would be ADR-0317's defect in response form. The body carries the
tombstone id, the scope, both digests, the anchors, the chain coordinates and who attested — because
that is the only thing which can later establish what was destroyed.

### Refusals distinguish "nothing happened" from "undone"

- An **erase** refusal returns `{ok: false}` from the pipeline → **409 `deletion_refused`**.
- A **`DeletionPipelineAborted`** means the drop executed and the transaction rolled back → **409
  `deletion_rolled_back`**, with the detail *"the tenant is unchanged"*.

Neither is a 500, because nothing is broken: the deletion was refused and correctly undone. A 500 would
suggest an unknown state in exactly the situation where the state is known.

### Two things refused before the drop rather than after

`data_subject_erasure` with no `relatedDeletionRequestId` is refused with a 400. The contract requires
it and the pipeline would abort *after* the drop had executed — correctly, but at the cost of a
rolled-back transaction over a tenant's data for a recoverable typo. Four-eyes is refused here too,
for the same reason, and again by the pipeline and the column (ADR-0318): three layers for the most
destructive act the platform performs.

### The only route in this app that requires an idempotency key

A retried delete generates a *new* tombstone id, erases nothing the second time (`alreadyAbsent`), and
the assembler refuses `scope_empty` — producing a **409 for a request that had already succeeded**,
which is the worst available answer to "did my deletion work?". `idempotencyRequired: true` makes the
retry return the first result.

### The recorder does not fail the request

Unlike the erasure's (ADR-0316, which 500s because its record is the *only* provenance), a deletion
already has a stored, anchored tombstone by the time the audit line is written. An unwritten line is
then a gap in the operational trail, not in the proof — so it is reported through `onRecordError`
rather than turned into a response implying the deletion did not happen.

### An unreadable tombstone is a 503, not an empty list

The store re-parses every row (ADR-0289), so a throw can mean a stored record no longer satisfies its
contract. Returning `[]` would read as "this tenant was never deleted", which is the opposite of true.

## Alternatives considered

- **Option A:** extend `platform-admin.ts`'s transition route to accept `deleted`.
  - **Pros:** no new route; one place for tenant state.
  - **Cons:** that route is a status setter. A deletion is a five-step transaction with four-eyes, a
    confirmation, a generated tombstone id, attestations and a receipt — none of which a status
    transition has anywhere to put.
  - **Why not:** the existing comment already rejected it, and nothing has changed except that the flow
    now exists.

- **Option B:** share the erasure's grant.
  - **Pros:** one role to configure; the erasure is the destructive part anyway.
  - **Cons:** the erasure is a *step*. Anybody granted it would also be able to end the relationship
    and issue a signed receipt.
  - **Why not:** a grant for a step should not confer the whole.

- **Option C:** retire the tenant row inside the pipeline's transaction.
  - **Pros:** genuinely all-or-nothing including the row.
  - **Cons:** the chain anchor references `meta.tenants`, so a `status = 'deleted'` row is fine but
    *removing* it inside the transaction would break the anchor it was written with. More importantly
    the pipeline lives in `tenant-lifecycle-pg` and `meta.tenants` is `platform-admin`'s table — the
    pipeline would have to know about a table it has no business in.
  - **Why not:** the after-ordering is safe in the direction that matters, and the failure is visible.
    Worth revisiting if the row is ever deleted rather than marked.

- **Option D:** no idempotency requirement, like every other route here.
  - **Pros:** consistent; no key to manage.
  - **Cons:** the retry of a *successful* delete returns 409 `scope_empty`. A client that retried on a
    timeout would conclude its deletion failed when it had succeeded.
  - **Why not:** this is the one route where a duplicate request cannot be made harmless by
    construction, because the first one destroyed the thing the second would measure.

- **Option E:** let the caller pass the tombstone id.
  - **Pros:** a caller could make the operation idempotent themselves by reusing the id.
  - **Cons:** a caller-chosen id can collide with a stored one, and the unique constraint would then
    fail the deletion *after* the drop. Generated here it cannot collide.
  - **Why not:** the gateway's idempotency layer is the right place for retry semantics.

## Consequences

- **Positive:** the GDPR Article 17 flow is reachable, role-gated with its own grant, four-eyes at
  three layers, atomic, and it hands back the receipt. `deleted` is reachable again — by the one path
  that earns it.
- **Negative:** a long-running transaction now sits behind an HTTP request. ADR-0319 noted it holds
  `ACCESS EXCLUSIVE` on the tenant's tables plus a full `count(*)`; a large tenant could exceed a
  proxy's timeout, and the client would then not learn the outcome it must record. The idempotency key
  makes the retry safe, which is the mitigation, not a fix.
- **Neutral:** `tenantRetired: false` on a 200 is an unusual shape. It is correct — the deletion
  happened, the bookkeeping did not — but a client that ignores the field will think the tenant row was
  updated.
- **Reversibility:** a flag defaulting to off with no role granted, so a deployment that does not
  configure it cannot reach the route at all.

## Implementation notes

- `apps/operate-server/src/tenant-deletion-routes.ts`. `TenantDeleterLike` is a structural mirror of
  the three calls it needs, so the route layer imports neither `tenant-lifecycle-pg` nor the contracts
  package.
- The tombstone store is handed `auditChainProducer` — the chain the audit log already anchors into,
  not a second one. One tamper-evident trail per tenant is the point (ADR-0286).
- The registry's `forget` runs **only** on success: a rolled-back deletion left the schema in place,
  and forgetting it would send that tenant to the JSONB fallback for no reason.
- `--tenant-deletion-routes` is the **fourth** flag to join `needsAuditEmitter` (ADR-0288, ADR-0313,
  ADR-0316). The named predicate and its per-flag test caught it again, which is the third time it has
  paid for itself.
- Two shell-quoting notes for anyone editing `cli.ts`: the help text is a template literal, so a
  backtick in it terminates the string — `tsc` reports it as a stray `','` several lines later. And a
  commit message written in a heredoc needs backticks escaped or they are command-substituted.
- Verified live through the real server: an `auditor` key refused the delete (403) and allowed the
  read (200); `requiredSubsystems: ["object_storage"]` that nothing attested for returned **409
  `deletion_rolled_back`** with the schema's 25 invoices and the tenant's `active` status **untouched**;
  the real call returned the full receipt — tombstone id, both digests, chain entry hash, sequence 37,
  and `attestedBy` naming `tenant_schema:tenant-lifecycle-pg/deletion:…` rather than a caller — after
  which the schema was gone, the tenant row read `deleted` and the tombstone was stored, together. The
  audit trail held two anchored rows: `platform.tenant_delete_refused` then `platform.tenant_deleted`
  naming its tombstone with `tenantRetired: true`.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A large tenant's deletion may exceed an HTTP timeout, and the client then does not learn the receipt it must keep. A job-backed variant that returns a handle would fix it; the idempotency key only makes the retry safe. | amoufaq5 | _unscheduled_ |
| Object storage, backups, search and caches still cannot attest, so every deletion today declares them out of scope by omission. The route accepts attestations for them, and nothing produces one. | amoufaq5 | _unscheduled_ |
| `retire` sets `status = 'deleted'` and leaves the row. Nothing removes it, so a deleted tenant's `meta.tenants` row, users and audit entries persist — correctly, for the audit trail, but no policy says for how long. | amoufaq5 | _unscheduled_ |
| `tenantRetired: false` on a 200 is easy for a client to ignore. Should the response be a 207, or should a failed retire be retried in-process? | amoufaq5 | _unscheduled_ |

## References

- ADR-0288, ADR-0313, ADR-0316 (the three prior `needsAuditEmitter` omissions), ADR-0316 (the
  erase-before-retire ordering, found live), ADR-0317 (a response that reports no scope is the same
  defect), ADR-0318 (the store, and four-eyes at the column), ADR-0319 (the atomic pipeline this
  exposes).
- GDPR Article 17; `platform-admin.ts`'s `TENANT_STATUS_TRANSITIONS`, which deferred to this flow
  before it existed.
