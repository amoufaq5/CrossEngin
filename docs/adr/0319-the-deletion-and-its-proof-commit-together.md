# ADR-0319: The deletion and its proof commit together

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0286, ADR-0292, ADR-0316, ADR-0317, ADR-0318 |

## Context

Three ADRs built the pieces of a tenant deletion and none of them ran in order. ADR-0316 erases a
tenant's own schema and measures it; ADR-0317 composes a `TombstoneRecord` from per-subsystem
attestations; ADR-0318 stores it and anchors it in the forensic chain. A caller had to invoke all
three and carry the results between them by hand — which is the shape of mistake every one of those
ADRs was written about.

Worse than the ergonomics: run separately, there is a **window in which the data is gone and the proof
of its deletion is not.** ADR-0316's own live verification hit exactly this — the schema was erased,
the audit record failed on a foreign key, and the response had to say *"do not issue a tombstone from
this response"*. That 500 is the correct handling of a state that should not be reachable at all. For
a deletion that is cryptographically attested, "irreversible and unaccounted for" is the worst state
the system can be in.

## Decision

**`deleteTenantAtomically` runs erase → attest → assemble → anchor → store in one transaction.**

Postgres DDL is transactional, and this codebase already depends on that: ADR-0316's
`probeCascadeCollateral` drops a schema inside a savepoint and rolls it back, and its live run showed
a view and 25 rows surviving. So the `DROP SCHEMA`, the chain append and the tombstone insert can
share one transaction.

The guarantee, stated precisely:

> **There is no outcome in which a tenant's data is destroyed without a stored, anchored, verified
> tombstone describing it. Either both, or neither.**

It does **not** make the deletion reversible. Once committed the data is gone; what is all-or-nothing
is the commit.

### Two `-Within` variants, following `appendWithin`'s precedent

`eraseTenantSchemaWithin(tx, …)` and `PostgresTombstoneStore.writeWithin(tx, …)` do the same work
inside a transaction the caller owns. `eraseTenantSchema` and `write` remain, each wrapping its
`-Within` form, so nothing that used them changes.

The erase takes its per-tenant advisory lock as an *xact* lock, so it is now the **caller's** commit
that releases it — nothing can re-create the schema between the drop and the tombstone landing beside
it.

`writeWithin` raises every refusal **before** touching the caller's transaction, so a refused write
leaves whatever else the caller had done intact and rollback-able on its own terms.

### Refusals are returned or thrown depending on whether anything was dropped

This is the one subtle part. An **erase** refusal (`external_dependents`, a wrong schema name) happens
before anything is dropped, so it is *returned* as `{ok: false, refusals}` and the transaction rolls
back with nothing to undo.

An **assembly** refusal happens after the drop has executed in this transaction, so it **throws**
`DeletionPipelineAborted`. Returning would commit a deletion with no tombstone, which is the state
this pipeline exists to make unreachable. The exception carries the refusals so a caller can report
why without having to distinguish it from a connection failure.

### The scope is measured, not accepted

`tenant_schema`'s attestation is produced *here*, from the erasure that just ran in this transaction,
and a caller-supplied one for that subsystem is **dropped**. An attestation about work this
transaction is about to perform is not evidence, it is a prediction — which is ADR-0317's whole
argument, applied to the one subsystem the pipeline can speak for itself.

`tenant_schema` is also always added to `requiredSubsystems`: a caller cannot declare it out of scope
and then have it erased anyway.

### The anchor is not a parameter

ADR-0318 established that a tombstone's witness is the chain, not its author. The pipeline passes the
assembler a placeholder anchor — `reference: "pending-chain-append"` — purely because
`TombstoneRecordSchema` requires at least one anchor to parse, and `writeWithin` replaces the whole
array with the entry it appends. The placeholder is named so that a row somehow carrying it is
obviously wrong rather than plausibly real.

## Alternatives considered

- **Option A:** run the three steps in separate transactions and handle partial failure.
  - **Pros:** no cross-package transaction; each step independently retryable; the smallest change.
  - **Cons:** the window is the defect. ADR-0316 already met it in practice and had to invent a 500
    that says "do not issue a tombstone from this response" — a correct answer to a question that
    should not arise.
  - **Why not:** transactional DDL means the window is avoidable, so leaving it is a choice.

- **Option B:** write the tombstone first, then erase.
  - **Pros:** a tombstone never missing for destroyed data.
  - **Cons:** the inverse failure — a signed, anchored tombstone asserting a deletion that did not
    happen. That is strictly worse: unaccounted data is a gap, but an attested false claim is a lie,
    and ADR-0316/0317 exist because of exactly that.
  - **Why not:** of the two one-sided orderings, this is the harmful one. Atomicity avoids choosing.

- **Option C:** a two-phase commit with the tombstone in `pending` state, confirmed after the erase.
  - **Pros:** works even if the two stores were in different databases.
  - **Cons:** they are in the same database, so this adds a state machine and a reconciler to solve a
    problem one `BEGIN` already solves. A `pending` tombstone is also a record that asserts nothing,
    which `TombstoneRecordSchema` has no representation for and should not gain.
  - **Why not:** unnecessary machinery. Worth revisiting only if object storage or backups land, since
    those genuinely cannot join this transaction.

- **Option D:** have the pipeline accept `tenant_schema`'s attestation from the caller.
  - **Pros:** symmetric with every other subsystem; one code path.
  - **Cons:** the caller would be asserting figures for a drop that has not happened yet. Verified in
    a test: a caller claiming `rowCount: 1` is overridden by the measured 26.
  - **Why not:** symmetry is not worth re-opening the hole ADR-0317 closed.

- **Option E:** put the pipeline in `operate-server` rather than `tenant-lifecycle-pg`.
  - **Pros:** it is orchestration, and the app already owns the route that would call it.
  - **Cons:** the atomicity is the contract, and it belongs with the store that enforces it rather than
    with one of several possible callers. `SchemaEraserWithin` is a structural mirror, so
    `tenant-lifecycle-pg` takes no dependency on `operate-runtime-pg`.
  - **Why not:** a guarantee implemented in a caller is a guarantee the next caller will not have.

## Consequences

- **Positive:** the window is gone. A failure anywhere — an unattested subsystem, a failed insert, a
  dropped connection — rolls the `DROP SCHEMA` back with it and the tenant is exactly as it was. The
  scope is measured by the transaction that does the destroying, so it cannot be a guess.
- **Negative:** the transaction holds the per-tenant advisory lock and an `ACCESS EXCLUSIVE` lock on
  every table in the schema for its whole duration, which now includes the chain append and the
  tombstone insert. Longer than the drop alone, though still bounded by a single tenant's schema.
  `count(*)` over a large tenant (ADR-0316) is the dominant cost and it is inside this window.
- **Neutral:** `tenant-lifecycle-pg` now depends on nothing new — `SchemaEraserWithin` is structural,
  so the erasure is injected and the package stays unaware of `operate-runtime-pg`.
- **Reversibility:** the `-Within` variants are additive and the original entry points are unchanged,
  so a caller wanting the three steps separately still has them. Nothing calls the pipeline from a
  route yet.

## Implementation notes

- `packages/tenant-lifecycle-pg/src/deletion-pipeline.ts`;
  `eraseTenantSchemaWithin` in `packages/operate-runtime-pg/src/tenant-schema-erase.ts`;
  `PostgresTombstoneStore.writeWithin`.
- Factoring the erase moved its non-UUID check inside the transaction, which cost a `BEGIN`/`ROLLBACK`
  for a request that could never proceed. `eraseTenantSchema` now calls `resolveTenantSchema` before
  opening the transaction to restore the fail-fast. Caught by an existing test asserting it "throws on
  a non-UUID tenant id **before touching the database**" — fixed in the code rather than the test.
- Verified live, against a populated tenant schema with a composite foreign key and RLS:
  - a `requiredSubsystems: ["object_storage"]` that nothing attests for aborted at
    `assemble/subsystem_unattested`, and **the `DROP SCHEMA` was rolled back** — the schema still
    present, its 25 invoices intact, zero tombstone rows, and **no orphaned chain entry** (the
    `deletion_event` count stayed at 2 rather than becoming 3);
  - the same call with the subsystem out of scope committed: 26 rows / 65,536 bytes erased, anchored
    by chain sequence 32, `isAnchoredByChain` true;
  - afterwards the schema was gone **and** the tombstone present, in one commit, and
    `store.verify` reported `found`, both hashes, `anchored` and `matchesAttestations` all true.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Nothing calls the pipeline from a route. The orchestration exists; no endpoint runs it. | amoufaq5 | _unscheduled_ |
| Object storage, backups, search and caches cannot join this transaction — they are not Postgres. When their erasures exist, the atomicity argument needs an answer for them (Option C becomes relevant). | amoufaq5 | _unscheduled_ |
| The transaction holds `ACCESS EXCLUSIVE` on the tenant's tables for the whole pipeline, including a full `count(*)`. For a very large tenant that is a long lock on tables nobody should be reading — but "nobody should be" is not "nobody is". | amoufaq5 | _unscheduled_ |
| `meta.tenants` is still not retired by the pipeline, and ADR-0316's erase-before-retire ordering remains unenforced. | amoufaq5 | _unscheduled_ |

## References

- ADR-0286 (`appendWithin`; a record and its anchor committing together — the precedent this
  generalises), ADR-0292 (asking Postgres rather than modelling it), ADR-0316 (the erasure, the
  transactional-DDL dependency, and the 500 that proved the window was real), ADR-0317 (attestations,
  and why a prediction is not evidence), ADR-0318 (the store, and the chain as the witness).
- PostgreSQL: DDL is transactional; `pg_advisory_xact_lock` releases at commit; `DROP SCHEMA` takes
  `ACCESS EXCLUSIVE` on each relation it removes.
