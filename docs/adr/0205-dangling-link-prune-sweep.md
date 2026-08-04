# ADR-0205: Dangling-link prune sweep on the JSONB store (Phase 3 P3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0204 (link-integrity planner), ADR-0203 (JSONB-store associations), ADR-0095 (store link/unlink), ADR-0077 (P3) |

## Context

The JSONB entity store's association links live in the generic `meta.operate_entity_links` table
(ADR-0203), which — consistent with the schemaless document posture — has **no foreign key** to the
document rows. So deleting a record leaves its association links behind as dangling rows. The column
store doesn't have this problem: its per-relation join tables carry composite `ON DELETE CASCADE` FKs,
so a deleted record's links vanish automatically. ADR-0204 shipped the *reasoning* half of the fix — a
pure `planLinkPrune({links, existingLeftIds, existingRightIds}) → {keep, drop}` — and explicitly left
"wiring it to real reads/deletes" as the follow-up. This is that follow-up.

## Decision

- **`PostgresEntityStore.pruneDanglingLinks(tenantId, leftEntity, rightEntity) → {pruned, kept}`**
  (`operate-runtime-pg`). For one `many_to_many` relation, in **one tenant-scoped transaction**
  (`withTenantContext`, so RLS confines every read and delete to the caller's tenant):
  1. `SELECT left_id, right_id` — all links for the relation.
  2. `SELECT record_id` from `operate_entity_records` for `leftEntity`, and (unless it's a self-relation,
     where the set is reused) for `rightEntity` — the surviving endpoint ids.
  3. `planLinkPrune(...)` — the pure ADR-0204 planner decides which links dangle.
  4. `DELETE` each dropped link.
  Returns the `{pruned, kept}` counts.
- **JSONB-store-only.** The method lives on `PostgresEntityStore`, not `ColumnMappedEntityStore` — the
  column store's cascading FKs already prevent dangling links, so a sweep there would be dead code.
- **A capability, not a route.** Pruning is a maintenance operation, not a per-request one, so it's a
  store method a scheduled job / admin CLI drives (iterating the manifest's m2m relations), not an HTTP
  endpoint. This mirrors how the pure planner shipped as a capability in ADR-0204.

## Consequences

- The ADR-0203/0204 "JSONB links have no cascading FK" follow-up is closed: dangling links are now not
  just *reasoned about* but *removable*, with the tested pure planner in the loop and the reads/deletes
  RLS-confined to one tenant.
- The two stores keep their distinct integrity models — the column store enforces it structurally
  (cascading FKs), the JSONB store reconciles it periodically (this sweep) — behind the same association
  seams, so the runtime stays oblivious to which is mounted.
- The sweep loads a relation's full link set + both sides' surviving ids into memory (fine for moderate
  cardinalities); a set-based `DELETE … WHERE NOT EXISTS` variant that avoids the load is the scalability
  follow-up, as is the scheduled job that invokes this across every m2m relation.
- 7,059 tests pass (+3: drops missing-left/missing-right endpoints while keeping valid links; no-op when
  all endpoints exist; RLS-confined to the caller's tenant). Full build + typecheck green.
