# ADR-0350: The erasure that reached the wrong schema

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-09 |
| **Authors** | platform |
| **Reviewers** | platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0284, ADR-0285, ADR-0314, ADR-0316, ADR-0317, ADR-0319, ADR-0320, ADR-0321, ADR-0322, ADR-0323, ADR-0328, ADR-0329, ADR-0330, ADR-0334, ADR-0337, ADR-0338, ADR-0347, ADR-0349 |

## Context

On `--store pg-columns` with a boot manifest, a GDPR Article 17 deletion erased **none** of the
tenant's records, and what it did instead depended on something irrelevant.

The class is **a remit whose mechanism was half of it**. `DELETION_SUBSYSTEMS` has named
`shared_tables` since Phase 1, and the comment beside it read *"rows in the shared boot schema and
`meta.*`"*. The implementation reached `meta.*` alone, because `eraseSharedTablesWithin` derives its
targets from `META_TABLES` and **every entry there declares `schema: "meta"`**. A boot manifest's
typed entity tables are created by `ColumnMappedEntityStore.ensureSchema` in
`<--schema ?? "public">` and appear in no catalog, so the intersection of the erasure's target set
with the tenant's own records was empty.

The other subsystem could not cover it either. `eraseTenantSchemaWithin` drops exactly one schema,
the derived `t_<hex>` of ADR-0314 — which a tenant served by the **boot** manifest does not have —
so it took its `alreadyAbsent` path and attested `nothing_to_erase`.

Measured on the live cluster described under *Implementation notes*, two tenants each holding one
`Account` and one PHI `Patient` created over real HTTP:

| Question | Answer |
|---|---|
| `t_*` schemas in the database | **0** — so `tenant_schema` attests `nothing_to_erase` |
| `meta.*` tables carrying `tenant_id` | 115 |
| Rows for tenant alpha across all 115 | **10**, every one in `meta.forensic_chain_entries` |
| Is that table erasable? | **No** — one of the 16 `PLATFORM_RECORD_TABLES` |
| Where the tenant's records actually were | `public.patient` (`mrn` = `c30d04…` ciphertext), `public.account` |

### The defect has two faces, and which one a tenant gets is an accident

Reproduced live by running `deleteTenantAtomically` with an empty boot group, which **is** the
pre-ADR-0350 pipeline — the new delete loop iterates `[]`, so nothing else differs — against the
same tenants, in the same transaction, through the same attesters and the same assembler.

**A tenant holding *any* erasable platform row gets a signed, anchored proof over the wrong
tables.** One row inserted into `meta.operate_tenant_settings` for tenant beta was enough: the
pipeline returned `ok`, stored a `v3` tombstone anchored at chain sequence 8 whose signed scope is
exactly

```
scope.tables: ['meta.operate_tenant_settings']   rowCount: 1   storageBytes: 72
attestedBy:   tenant_schema:…, shared_tables:…
```

— and `public.patient` still held the PHI row (`mrn` = `c30d04…`) and `public.account` still held
its account. The proof is not *false about what it names*; it is false **by omission**, and the
omission is unreachable by every detector this platform has. `contentManifestOk`,
`tombstoneMatchesAttestations` and the forensic chain all commit to the scope that *was* composed,
and that scope is correct. ADR-0323's `scope_tampered` cannot fire, so neither can ADR-0324's paging
`sev1`. This is ADR-0317's original defect one level down: there a subsystem's *silence* read as
nothing to delete, here a subsystem's *answer* did.

**A tenant holding none gets the deletion refused.** With beta's one settings row absent, the same
invocation raises `DeletionPipelineAborted: assemble/scope_empty` — *"every subsystem reported
nothing erased and nothing retained; there is no deletion to attest"* — about a tenant whose
patient's medical record identifier is on disk. Deterministic, so ADR-0321's runner files it
`rejected`: the operator is told there is nothing to delete.

So there **was** a fence, and this is the part worth keeping: `scope_empty` fires exactly when the
catalogued half finds absolutely nothing, which is the *harmless* case to be wrong about and the
rarer one. One erasable platform row — a tenant setting, a numbering sequence, a notification
dispatch — moves the predicate from the refusal to the false proof. A fence whose predicate is one
unrelated row away from the dangerous answer is worse than no fence, because its existence is why
nobody looked.

ADR-0316's own live-verification notes contain the sharpest evidence that this was invisible rather
than unexamined. They record *"`meta` (144 tables) and `public` are untouched"* as a **success**
criterion — checked for *collateral* damage, which was the right check for that increment, and the
identical observation to the one this defect produces. A passing check and a missing erasure were
the same sentence.

## Decision

**`shared_tables` erases two named groups: the catalogue's tenant-scoped tables, and the boot
manifest's own entity tables, which the caller names.** Five parts.

**1. The target list is derived by the package that creates the tables.**
`operate-runtime-pg`'s new `bootSchemaErasurePlan(manifest, {schema})` returns every table
`ensureSchema` creates — entity tables from `columnPlansForManifest`, join tables from
`joinTablePlansForManifest` — and `tenant-lifecycle-pg` receives them. Derived from the **manifest**,
never from introspection: "every table in this schema with a `tenant_id` column" would make the
target list whatever happens to be in the shared schema, and there is no table-level marker to
narrow it with, since the emitter writes classification only as `COMMENT ON COLUMN`.

**2. One subsystem, not a seventh.** `shared_tables` already claimed this remit; the figures fold
into one attestation because `duplicate_attestation` allows a subsystem exactly one.

**3. The order is over the *blocking* graph, not the reference graph.** The emitter writes composite
`ON DELETE RESTRICT` keys unless a relation says otherwise, so a parent whose child rows remain
refuses the delete. `topologicalEntityOrder` orders the **reference** graph and deliberately
tolerates a cycle, appending its members in *insertion order* (ADR-0285, because `ensureSchema` adds
foreign keys in a second pass) — and insertion order has no ordering property at all. So the plan
orders a weighted graph: `restrict` is non-negotiable, `cascade` is honoured wherever the graph
admits it, `set_null` is given up first when a cycle must be broken, and a cycle of nothing but
`restrict` edges is named in `blockingCycle` for the erasure to refuse by name.

**4. The two groups are one target list, one probe, one refusal pass.** Every refusal is established
for every target in both groups before the first `DELETE`, so ADR-0330's *"a returned refusal means
nothing was destroyed"* holds across both.

**5. Said at boot, refused at the act.** `formatBootErasureCoverage` prints what this deployment
will erase of a tenant's own records on every boot, including when the figure is zero.

Four new refusals guard it, each converting a mid-transaction raise — which rolls back, so nothing
is destroyed, and which ADR-0321's runner files `aborted` and leaves `in_progress` for a human —
into a deterministic `rejected`:

| Refusal | What it catches |
|---|---|
| `target_collides_with_catalog` | a boot target resolving to a catalogued relation, or named twice |
| `boot_schema_target_invalid` | a schema or table name that is not an identifier |
| `boot_schema_order_unrunnable` | a `restrict` cycle: no order of per-table `DELETE`s can run |
| `target_lacks_tenant_scope` | a target the database has, with no `tenant_id` column to scope by |
| `boot_schema_table_undeclared` | the boot schema holds a column-store table the targets do not name |

## Alternatives considered

- **Option A: a seventh `DELETION_SUBSYSTEMS` member, `entity_tables`.**
  - **Pros:** the distinction lands in the proof's **signed bytes** — ADR-0329's v2 argument,
    separating "we have no entity tables" from "we have them and nobody looked". A declaration in
    `--deletion-capabilities` would make the group's presence an operator's statement.
  - **Cons:** `TombstoneCapabilityDeclarationSchema` is a `.strict()` total six-key object parsed on
    **read**, so a seventh key makes every stored v2/v3 tombstone fail to parse and report
    `scope_tampered` — firing ADR-0324's paging `sev1` on honest proofs. It needs a
    `crossengin.tombstone.content.v4` tag, and it refuses every existing `--deletion-capabilities`
    file at boot.
  - **Why not:** the remit was already right. `SharedTableTarget.qualified` is already
    `schema.table` *precisely so a bare name "would not say whose"*, so the existing vocabulary
    carries the second group with no new tag, no migration and no re-signing. The v2 distinction is
    the one thing this costs, and it is **stated** rather than claimed closed: an empty boot group
    and no boot group compose byte-identical scopes. See *Open questions*.

- **Option B: introspect the schema for tenant-scoped tables.**
  - **Pros:** total by construction, and it would reach a previous manifest's leftover tables.
  - **Cons:** the default boot schema is `public`, which a deployment may share with tables that are
    none of our business; a `tenant_id`-keyed census would aim `DELETE … WHERE tenant_id = $1` at
    them.
  - **Why not:** the function that creates a table is the only thing entitled to name it
    (ADR-0284/0285). Introspection is used in **one** place and for the opposite purpose: as a
    both-ways *detector* (`censusBootSchemaTables`), narrowed to the signature this emitter writes
    and nothing else does — a policy named `<relname>_tenant_isolation` — which refuses rather than
    deletes.

- **Option C: order the deletion by reversing `topologicalEntityOrder`.**
  - **Pros:** no new graph code; the create order is already the emitter's.
  - **Cons:** **it does not work on any shipped pack.** Measured: 18 of `erp-core`'s 51 entities are
    cycle leftovers appended in insertion order, and reversing puts the parent before the child on 3
    edges, 2 of them `ON DELETE RESTRICT`. The cycle is contributed entirely by edges that constrain
    no deletion — `Employee.department_id -> Department` is declared `onDelete: "set_null"` and
    completes `Employee -> Department -> Employee`. Verified on PostgreSQL 16.13 against the emitted
    DDL: emptying `employee` first is refused with `update or delete on table "employee" violates
    foreign key constraint "fk_department_manager_id" on table "department"`, while `expense`,
    `department`, `employee` commits.
  - **Why not:** the two graphs are not the same graph. `erp-core` has 40 order-constraining
    `restrict` edges (37 cross-entity) and the restrict-only subgraph is **acyclic**, so ordering on
    the blocking edges only is both correct and sufficient. Re-measured against the shipped plan:
    **0** `restrict` edges are violated by the order this ADR ships, against 2 by the reverse of the
    create order.

- **Option D: break a cycle by dropping any edge.**
  - **Pros:** one weight class, no map.
  - **Cons:** a dropped `cascade` edge means the parent's statement destroys child rows the child's
    own `DELETE` then undercounts — a wrong **figure** in a signed proof.
  - **Why not:** `set_null` destroys nothing early and moves no figure, so it is strictly cheaper to
    give up. `DELETE_ORDER_WEIGHT` is a total map over `OnDelete`, which is also what makes a fourth
    member a compile error beside `onDeleteClause`'s switch. Measured across all seven packs: **no
    `cascade` edge is relaxed anywhere**, every `blockingCycle` is empty, and the only relaxations at
    all are `erp-core`'s two `set_null` references (`Employee.department_id -> Department` and
    `Employee.position_id -> Position`). So the figure-undercount arm is live code with no shipped
    member, which is why it is reported rather than refused.

- **Option E: refuse the boot for a `restrict` cycle.**
  - **Pros:** one answer, nothing to carry.
  - **Why not:** such a manifest *serves* perfectly well; only its Article 17 deletion cannot run.
    A boot refusal would break a deployment that works. So the surface that destroys data refuses
    and the surface that serves it says so — which is also why the plan carries `blockingCycle` as
    data rather than throwing.

- **Option F: make `boot_schema_table_undeclared` conditional on the leftover table holding rows for
  *this* tenant.**
  - **Pros:** a leftover empty table blocks nobody.
  - **Why not:** it makes the deployment's correctness tenant-dependent and discovered late — the
    first tenant whose rows happen to be absent gets a proof blessing a schema that will mislead the
    next one. An unconditional refusal is a *configuration* refusal, and it is now also a boot
    warning, so the deadline-free moment comes first.

- **Option G: two passes, one per group.**
  - **Why not:** the second pass's refusals would have to be known before the first wrote anything —
    a survey-then-erase handshake across two packages, which is a worse version of what broke.

- **Option H: strengthen `assemble/scope_empty` instead — refuse a deletion whose scope looks too
  small for the tenant.**
  - **Pros:** it is the fence that already exists, it is where both faces of this defect meet, and
    it would have caught this without knowing anything about entity tables.
  - **Cons:** "too small" has no definition. A tenant that genuinely holds one row is
    indistinguishable from one whose erasure missed a schema, so any threshold either refuses honest
    deletions or passes this one. And the refusal would be *reported* at the one moment it is most
    expensive — mid-pipeline, under an Article 12(3) deadline — rather than fixed.
  - **Why not:** the remedy for an erasure that cannot see a place is to let it see the place, not to
    make it suspicious of its own figures. `scope_empty` keeps its exact predicate, which is now
    honest: after this change, every subsystem reporting nothing really does mean there was nothing.

## Consequences

- **Positive.** An Article 17 deletion on `--store pg-columns` erases the tenant's records, counts
  them, confirms their absence and commits that figure to the proof in the same transaction. Live on
  tenant alpha: `erasedSharedTables` names `public.patient` and `public.account`, `rowCount: 2`,
  `storageBytes: 312`; the stored tombstone's signed `v3` scope names both tables, anchored at chain
  sequence 14; alpha's rows are gone and tenant beta's are intact — an exact complement. On the final
  binary (tenant gamma, after the census landed) the same figures come back with `examinedTables` =
  **151**, which is the arithmetic that says both groups travel in one pass: the 54 the boot line
  reported plus the 97 catalogued erasable ones (115 tenant-scoped − 16 `PLATFORM_RECORD_TABLES` − 2
  `STATUTORY_RETENTION_TABLES`).
- **Positive.** Five refusals that each convert a stranded request into a named one, and a boot line
  that states this deployment's coverage whether or not there is anything to erase.
- **Positive.** `assemble/scope_empty` becomes an honest predicate rather than an accidental one:
  every subsystem reporting nothing now really does mean there was nothing, where before it meant
  the tenant happened to hold no erasable platform row.
- **Negative.** `bootSchema` is a **required** parameter on `DeleteTenantInput` and
  `SharedTableErasureOptions`, so every caller is a compile error until it says what it holds. That
  is the fence: a forgotten optional parameter is the exact shape of the defect being closed.
- **Negative.** A leftover table from a previous manifest now **refuses** the deletion until an
  operator drops it. Loud, with the remedy named, and preferred over the alternative, which is the
  original defect.
- **Negative.** The boot-schema group is subject to **neither retention set**, because both are
  constants over `META_TABLES`. A statutory obligation over a tenant's *own* records stays
  inexpressible — a pre-existing gap this increment makes newly relevant and now prints at boot.
- **Neutral.** `probeSharedTableErasability` changed shape (`{missing, confined, unscoped}`, and a
  third output column) and no longer takes a schema parameter, reading it from each target.
- **Reversibility.** High. No schema change, no migration, no new table, no proof-format tag: the
  tombstone bytes are `crossengin.tombstone.content.v3` exactly as before, and a proof written
  before this increment verifies after it. Reverting is removing a parameter.

## Implementation notes

- `packages/operate-runtime-pg/src/boot-schema-targets.ts` — `bootSchemaErasurePlan`,
  `bootSchemaErasureTargets`, `COLUMN_STORE_DEFAULT_SCHEMA`. The constant is **exported** because a
  second spelling of `"public"` is this defect's own shape: `column-store.ts` spelled it inline at
  both its call sites and `apps/operate-server` held a third copy.
- The order is one weighted Kahn's in the *deletion* direction over three tiers (`weight >= 0`, then
  `>= 1`, then `>= 2`), each tier restarting on the previous tier's stuck set and recording the
  edges it stops honouring. Unconstrained entities come out in **manifest declaration order**, which
  is a determinism choice and not a constraint — the figures go into a signed proof, so two runs must
  not name the tables in two orders.
- A **self**-reference is excluded from the graph, measured rather than assumed: on PostgreSQL
  16.13, with the erasure's own single-statement CTE shape, a self-referencing `ON DELETE RESTRICT`
  key does not refuse the bulk delete — both rows go and the constraint is not triggered.
- `packages/tenant-lifecycle-pg/src/shared-table-erasure.ts` — `bootSchema: BootSchemaErasureInput`
  groups the targets with the order's verdict, following `BuildOperateHttpServerOptions.abac`
  (ADR-0342): most pairings that can be formed apart are silently wrong, and targets-without-verdict
  is the dangerous one.
- `apps/operate-server/src/node.ts` computes the plan **once at boot** and threads it to both
  `deleteTenantAtomically` call sites (the synchronous route and `DeletionRunner`). Computed only for
  `pg-columns`: asking for a plan on `--store pg` would **throw** for a manifest with a `duration`
  field, which the JSONB store serves perfectly well.
- The boot census is swallowed on failure rather than fatal — a failed read establishes nothing, and
  the deletion-time refusal is the fence.

### The live cluster

PostgreSQL 16.13, port 5492, `--pack erp-healthcare --store pg-columns`. Two roles: `postgres`
(applied the 964-statement catalog; 147 `meta` relations, the catalog's 146 plus `_meta_migrations`)
and `app_rw`, which owns no `meta` table. Both tenants were seeded over real HTTP as `erp_admin` and
`front_desk`, so `public.patient.mrn` is genuine `bytea` beginning `c30d04`.

`boot_schema_table_undeclared` was exercised end to end on a third tenant, with a hand-made
`public.legacy_chart` carrying `tenant_id` and the emitter's own `legacy_chart_tenant_isolation`
policy — the exact shape `ensureSchema`'s additive migration leaves when a manifest stops declaring
an entity. Boot printed the warning; the deletion answered
`erase/boot_schema_table_undeclared` naming the table; all three of that tenant's rows (patient,
account and the leftover note) were **still present** afterwards; and after the named remedy — one
`DROP TABLE` — the identical request returned `deleted: true` with `rowCount: 2`. That round trip is
also the demonstration that a refusal destroys nothing across both groups.
`target_collides_with_catalog`, `boot_schema_target_invalid`, `target_lacks_tenant_scope` and
`boot_schema_order_unrunnable` are covered by tests rather than live: each needs a manifest or a
schema the live cluster would have to be corrupted to produce.

Two facts the live run produced that nothing offline could:

1. **As a plain non-owner the whole deletion is refused**, not the boot-schema part of it:
   `rls_would_confine_this_session` names **99** `meta` tables. ADR-0329 established that refusal and
   it fires here unchanged, which means the serving role performing a deletion needs `BYPASSRLS` or
   ownership — so for `--store pg-columns` the `tenant_id` predicates are the confinement for that
   role and not RLS, which is ADR-0349's finding (b) reached from the deletion end.
2. **`active -> deleted` is reported `transitionLegal: false`.** `TENANT_LIFECYCLE_TRANSITIONS`
   routes a deletion through `pending_deletion`, and the synchronous route of ADR-0320 goes straight
   to `deleted`. Pre-existing, recorded rather than changed: the lifecycle event is *reported* and
   the deletion is the authoritative act (ADR-0320's `tenantRetired` rule).

Beside it, ADR-0349's live finding (a) is wired: `surveyEnvelopeTenantReadiness` runs at boot under
`--column-key-mode envelope` and names api-key tenants with no `meta.tenants` row, whose every PHI
read and write is otherwise refused by `tenant_data_keys_tenant_id_fkey` as an HTTP **504**.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| An empty boot group and no boot group compose byte-identical scopes, so ADR-0329's v2 distinction is closed in the mechanism and open in the proof. Closing it needs a `content.v4` tag and the migration Option A was rejected for. | platform | — |
| Statutory retention over a tenant's **own** records is inexpressible: both retention sets are constants over `META_TABLES`. A per-entity retention declaration is the shape, and ADR-0330's rule says it must not be caller-supplied. | platform | — |
| A deployment that served `pg-columns` and now serves `pg` passes `[]`, so its leftover entity tables are censused by nothing. The boot schema would have to be declared independently of the targets. | platform | — |
| A relaxed `cascade` edge undercounts the proof's `rowCount`. Vacuous on all seven packs; closing it needs the child's rows counted before the parent's statement. | platform | — |
| The per-tenant activated-manifest path (ADR-0314) is covered by `tenant_schema` dropping `t_<hex>`, so its *own* entity tables need no targets — but a tenant whose DDL application was **refused** is served from the JSONB fallback, and nothing says which tenants are in that state at deletion time. | platform | — |
| `--schema` feeds two stores with two different defaults (`meta` for JSONB, `public` for columns). `target_collides_with_catalog` refuses the dangerous case; the flag still means two things. | platform | — |

## References

- GDPR Article 17 (right to erasure); Article 12(3) (one-month response deadline).
- ADR-0316 (tenant-schema erasure), ADR-0317 (attestation-composed tombstones), ADR-0319 (one
  transaction), ADR-0320 (the synchronous route), ADR-0321 (the asynchronous runner), ADR-0328
  (declared capabilities), ADR-0329 (shared-table erasure, `content.v2`), ADR-0330 (the two retention
  reasons), ADR-0334 (converting a run-time failure into a boot refusal).
- ADR-0284/0285 (who emits entity DDL and in what order), ADR-0314 (per-tenant schemas).
- ADR-0342 (grouping inputs that must agree), ADR-0347/0349 (the column key and its rekey).
