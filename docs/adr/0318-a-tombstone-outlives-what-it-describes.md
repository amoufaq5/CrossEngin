# ADR-0318: A tombstone outlives what it describes, and the chain witnesses it

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0255, ADR-0286, ADR-0289, ADR-0291, ADR-0300, ADR-0313, ADR-0316, ADR-0317 |

## Context

ADR-0317 made a `TombstoneRecord` composed from attestations rather than written by hand, and left it
nowhere to live. A verified record existed only in the response that produced it, and its `anchors`
were **supplied by the caller** — a claim whose witness the claimant chose.

ADR-0317's own open question said there was no table. That was wrong: `meta.tenant_tombstones` has
been in the catalog since Phase 1. Nothing had ever written it, and in that time it had drifted behind
`TombstoneRecordSchema` — the second instance of ADR-0300's finding, in the table where it matters
most:

- **`executed_by` and `approved_by` were `UUID` referencing `meta.users`.** The contract has them as
  free text, and the reference was self-defeating in two directions at once. A tenant deletion erases
  that tenant's users, so the tombstone would have pointed at rows it had just destroyed — and
  `ON DELETE RESTRICT` would have made those users *undeletable because a tombstone named them*. A
  `scheduled_purge`, a declared kind, has no human executor at all.
- **`related_deletion_request_id` was `UUID`**; `GdprDeletionRequestSchema.id` is `z.string().min(1)`.
- **There was nowhere to put the attestations** ADR-0317's scope is composed from, so a stored record
  could be checked only against itself.
- **RLS was tenant-isolation only.** A tombstone outlives its tenant, so after the deletion there is no
  tenant session left to satisfy the policy. The record existed for exactly the readers it excluded.

`tenant_id` was `UUID NOT NULL` with **no** reference, and that was always right — the tenant row is
retired after its data is erased, so a tombstone requiring it to exist could not describe a completed
deletion. One field had the principle correct; four did not.

## Decision

**The table is widened to match its contract, gains its evidence and its anchor, and gains a
platform read. `@crossengin/tenant-lifecycle-pg` is its first writer.**

### The table

| Change | Why |
|---|---|
| `executed_by`, `approved_by` → `TEXT`, references dropped | a tombstone names who acted, not a row that survives |
| `related_deletion_request_id` → `TEXT` | matches the contract's free-text ids |
| `attestations JSONB NOT NULL DEFAULT '[]'` | the claim keeps its evidence (ADR-0317) |
| `chain_entry_hash`, `chain_sequence_number` | the anchor, written in the same transaction |
| `tenant_tombstones_four_eyes_check` | `executed_by <> approved_by`, at the column |
| `tenant_tombstones_platform_audit_read`, `SELECT`-only | readable after the tenant is gone |

The four-eyes CHECK is the third layer for one rule, as ADR-0313 did for template approval: the
contract refuses it, the store refuses it, and the column refuses it — because the only way a
privileged act stays privileged is if the check holds where the write lands. The platform policy is
`SELECT`-only and split off for ADR-0313's reason: on an `ALL`-scope policy the `USING` also serves as
the `WITH CHECK`, and a read grant must not become the ability to forge a deletion receipt.

### The store

**The record and its anchor commit together.** `appendWithin(tx, …)` puts the chain entry in the
store's own transaction (ADR-0286), so there is no window in which a tombstone exists unanchored or an
anchor names a tombstone that was rolled back. The entry is appended **first** and its hash stored on
the row — the ordering `PostgresAuditEmitter` already uses, for the same reason: a row inserted first
would need an `UPDATE` to learn its coordinates, giving an append-only table a rewrite path.

**The anchor is derived, not accepted.** `write` ignores any `anchors` on the record it is handed and
replaces them with the chain entry it just appended. A tombstone's witness is the chain; letting a
caller name one makes the anchor a claim about a claim.

**The chain payload is the digests, not the record.** A scope can name every table a tenant held, and
the chain is append-only storage that every verification pass reads — committing the payload twice
would make chain verification scale with deleted data. The digests are what make the record
tamper-evident, so committing to them is committing to it.

**Refused before any write**: a record whose own hashes do not verify, one whose scope is not what its
attestations compose to, one whose executor approved it, and a non-UUID `tenantId` (named as a tenant
problem rather than discovered as a bind syntax error).

**No tenant context on the write.** The connection is platform-scoped and the insert deliberately does
not run under `withTenantContext`: a tombstone is written at the moment a tenant's data is gone, and
setting that tenant's context to write the record of its deletion is a dependency on the thing being
deleted. The row carries `tenant_id` and the isolation policy still confines any tenant-scoped reader.

**`verify` answers three questions and distinguishes "cannot say" from "disagrees".** The hashes, the
anchor, and — only because the row now stores its evidence — whether the scope still matches the
attestations. `matchesAttestations` is `null` with no evidence rather than `false`, because an auditor
must not read one as the other.

**`read` re-parses through `TombstoneRecordSchema`** (ADR-0289): a tombstone that no longer satisfies
its own contract is a finding, not a shorter answer.

## Alternatives considered

- **Option A:** keep the `meta.users` references and require a user row for every tombstone.
  - **Pros:** referential integrity; `executed_by` always resolves to a real person.
  - **Cons:** it is circular. A tenant deletion erases that tenant's users, so either the tombstone
    cannot be written or `ON DELETE RESTRICT` makes the users undeletable because the tombstone names
    them. And a `scheduled_purge` has no user to name.
  - **Why not:** the integrity it offers is integrity against the thing being deleted.

- **Option B:** put the store in `tenant-lifecycle` rather than a new package.
  - **Pros:** no new package to scaffold.
  - **Cons:** `tenant-lifecycle` is a contracts package — zod and crypto only, no sockets, no SQL.
  - **Why not:** the layering convention exists for this. `tenant-lifecycle-pg` follows `crypto-pg`,
    `forensics-pg` and `feature-flags-pg`: a contracts package with a `-pg` sibling and no runtime.

- **Option C:** accept the caller's `anchors` and let them decide the witness.
  - **Pros:** a deployment that anchors to an RFC 3161 service or a public ledger can say so.
  - **Cons:** the claimant choosing their own witness is the problem, not a feature. The chain is the
    platform's own tamper-evident log and it is already running.
  - **Why not:** derived, not accepted. A deployment wanting an *additional* external anchor can add
    one later alongside the chain entry rather than instead of it.

- **Option D:** commit the whole record to the chain, not just its digests.
  - **Pros:** the chain alone would reconstruct the tombstone; no dependence on the table surviving.
  - **Cons:** chain verification already reads every entry, and a deletion scope is unbounded in size
    — one tenant with 500 tables would put 500 table names into append-only storage that every
    integrity pass rereads forever.
  - **Why not:** the digests are the tamper-evidence. The record is in a table that the digests prove.

- **Option E:** widen the columns and leave the foreign keys, dropping them later.
  - **Pros:** a smaller change.
  - **Cons:** not possible — the references block the type change, so they come out either way.
  - **Why not:** ADR-0291 already drops a foreign key that blocks a retype, as a visible step. Which is
    why this needed no `allowLoosening` (ADR-0308) at all, contrary to what I expected.

## Consequences

- **Positive:** a tombstone is durable, witnessed by the chain rather than by its author, stored with
  the evidence its scope was composed from, readable after the tenant is gone, and refused at three
  layers if one person tries to both execute and approve it. A system actor can execute one, which the
  old column could not express.
- **Negative:** a new package. And the two `meta.users` foreign keys are now *gone* from a table that
  had them, which on an existing deployment is a real loosening — correct here for the reasons above,
  but it means nothing checks that `executed_by` names anybody at all. The field is free text by
  contract, so that is the contract's position, not a regression introduced here.
- **Neutral:** the chain payload commits to digests, so a chain entry cannot be used to reconstruct a
  tombstone whose row was lost. The row is the record; the chain proves it was not altered.
- **Reversibility:** the columns and policy are additive except the two dropped references, which
  ADR-0291 would refuse to re-add without proving every row satisfies them. The store is new code
  nothing yet calls from a route.

## Implementation notes

- `packages/tenant-lifecycle-pg/` — `PostgresTombstoneStore`, `tombstoneChainPayload`,
  `rowToStoredTombstone`. `TombstoneAnchorer` is a structural mirror of the one
  `PostgresChainLogStore` method it needs, so a test needs no chain and no signer.
- `TOMBSTONE_LOG_KIND` is `deletion_event`, which `LOG_KINDS` already declared.
- Verified live against the throwaway cluster, migrating an **existing** database that held the old
  table: the reconciler planned all ten statements by itself — three `add_column`, two
  `drop_foreign_key`, three guarded `alter_column_type`, the guarded `add_table_constraint` and the
  `create_policy` — applied them, and re-planned to empty. The live table then showed the three
  columns as `text`, zero foreign keys, `tenant_id` still `uuid`, and both policies with the platform
  one as `SELECT`.
- Then end to end with a real `PostgresChainLogStore` and an Ed25519 signer: a tombstone written and
  anchored at chain sequence 30, with the caller's `rfc3161_timestamp` anchor **replaced** by the chain
  entry's hash; read back and re-parsed; `verify` reporting all four facts true; a
  `system:purge-scheduler` executor stored successfully, which the old `UUID` + FK column could not
  hold; a direct `INSERT` bypassing the store refused by
  `tenant_tombstones_four_eyes_check`; and after a `jsonb_set` tamper of the stored scope, `verify`
  returning `contentManifestOk: false`, `proofOk: true`, `matchesAttestations: false` — both detection
  paths firing, each on its own class of tamper.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Nothing calls the store from a route. The erase surface produces an attestation and the assembler produces a record; no endpoint writes one. | amoufaq5 | _unscheduled_ |
| `executed_by` is free text with no referential check, so a tombstone can name an actor that never existed. Should a `user:<uuid>` form be validated against `meta.users` when it uses that shape? | amoufaq5 | _unscheduled_ |
| `read` and `listForTenant` elevate with `app.platform_audit` unconditionally, so the store grants itself the cross-tenant view. A route above it must do the role check; nothing enforces that it did. | amoufaq5 | _unscheduled_ |
| A tombstone whose row is lost cannot be reconstructed from the chain, by design. Is a periodic row↔anchor sweep wanted here, as ADR-0287 does for audit entries? | amoufaq5 | _unscheduled_ |

## References

- ADR-0255 (tombstones and proof hashes), ADR-0286 (`appendWithin`, a record and its anchor committing
  together), ADR-0289 (re-parse on read; a column narrower than its contract), ADR-0291 (a foreign key
  that blocks a retype is dropped as a visible step), ADR-0300 (a table declared and never written,
  drifted behind its contract), ADR-0313 (a `SELECT`-only platform read; four-eyes at three layers),
  ADR-0316 (the erasure), ADR-0317 (the assembler, and the open question this closes).
