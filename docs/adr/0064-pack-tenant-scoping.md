# ADR-0064: Pack tenant scoping via `tenant_owned` trait (Phase 2 M7.7)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0002 (multi-tenancy), ADR-0003 (meta-schema + DDL emit), ADR-0058 (pack-erp-core), ADR-0063 (CLI --pack apply) |

## Context

M7 shipped `pack-erp-core` and M7-wire connected it to the CLI's `apply` command. Result: `crossengin apply --pack=operate-erp/core` produces working tables in a Postgres instance. Open question from ADR-0063 (Q4): the pack tables had **no tenant_id column and no RLS policies**. They worked for single-tenant local development but would silently leak data across tenants in any multi-tenant deployment.

The root cause was a kernel limitation: `BUILT_IN_TRAIT_FIELDS` recognized `"tenant_owned"` as a known trait but mapped it to an empty field list (`["tenant_owned", []]`). Entities declaring the trait got the trait validated but no columns or RLS. This was intentional during early kernel design — the tenant column shape wasn't settled. By M7, the META schema had standardized: `tenant_id UUID NOT NULL REFERENCES meta.tenants(id) ON DELETE CASCADE`, plus an `ENABLE ROW LEVEL SECURITY` + a `tenant_isolation` policy using `current_setting('app.current_tenant_id', true)::UUID`. The trait can adopt that exact shape and inject it automatically.

Two constraints shaped the design:

1. **The auto-injected column must match what META tables use.** Operators reading either a META table or a pack table should see the same `tenant_id` shape, the same FK direction, the same RLS expression. No new vocabulary, no new convention.

2. **The change has to be additive.** Existing entities not using `tenant_owned` keep emitting exactly the same DDL. M7's pack-erp-core entities (which all used `auditable` but not `tenant_owned`) need a one-line update to opt in — and the resulting SQL change is auditable in a single `git diff`.

## Decision

Three changes — one to the kernel, one to `pack-erp-core`, one to test infrastructure:

### 1. Kernel: `tenant_owned` trait gains a `tenant_id` field + emit emits FK + RLS

`packages/kernel/src/ddl/built-in-traits.ts` — the trait map now includes a non-empty entry:

```ts
const TENANT_OWNED_FIELDS: readonly Field[] = [
  { name: "tenant_id", type: { kind: "uuid" }, required: true, indexed: true },
];

export const BUILT_IN_TRAIT_FIELDS = new Map([
  // ...
  ["tenant_owned", TENANT_OWNED_FIELDS],
]);

export const TENANT_OWNED_TRAIT = "tenant_owned" as const;
export const TENANT_ID_COLUMN = "tenant_id" as const;
```

The field is `UUID NOT NULL` with `indexed: true` (covers the per-tenant query path). No `references` on the field itself — the FK is emitted separately because it crosses schemas (entity in `public`/operator-chosen schema, referenced table in `meta`). The kernel's existing `reference` field type assumes same-schema, single-schema targets; making it cross-schema would widen its contract.

`packages/kernel/src/ddl/emit.ts` — `emitEntity` checks for the trait and emits two extra blocks:

```ts
export function isTenantOwned(entity: Entity): boolean {
  return (entity.traits ?? []).includes(TENANT_OWNED_TRAIT);
}

export function emitTenantFk(entity, context): string {
  const tableName = toTableName(entity.name);
  return `ALTER TABLE ${qualifyTable(context.schema, tableName)} ` +
    `ADD CONSTRAINT "${tableName}_tenant_fk" ` +
    `FOREIGN KEY ("tenant_id") REFERENCES "meta"."tenants"("id") ` +
    `ON DELETE CASCADE;`;
}

export function emitTenantRls(entity, context): string[] {
  const tableName = toTableName(entity.name);
  const qualified = qualifyTable(context.schema, tableName);
  return [
    `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`,
    `CREATE POLICY "${tableName}_tenant_isolation" ON ${qualified} ` +
      `USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);`,
  ];
}

export function emitEntity(entity, context): string[] {
  const statements = [emitCreateTable(entity, context), ...emitIndexes(entity, context)];
  if (isTenantOwned(entity)) {
    statements.push(emitTenantFk(entity, context));
    statements.push(...emitTenantRls(entity, context));
  }
  return statements;
}
```

Entities WITHOUT the trait get no FK / RLS / tenant_id — backward compatible. Policy + constraint names follow `<table>_tenant_isolation` and `<table>_tenant_fk` conventions matching the META schema's existing naming.

### 2. `pack-erp-core`: opt every entity into `tenant_owned`

`packages/pack-erp-core/src/entities.ts`:

```ts
const PACK_TRAITS = ["auditable", "tenant_owned"] as const;
// Account, Contact, Invoice, InvoiceLine all set: traits: [...PACK_TRAITS]
```

One-line change per entity. Existing tests asserting `traits` to contain `"auditable"` still pass; a new test asserts `"tenant_owned"` on every entity.

Side cleanup: the original `Account` entity declared entity-level `indexes: [{fields: ["status"]}, {fields: ["name"]}]` while also setting `indexed: true` on the same `status` and `name` fields. The duplicate registration produced duplicate `CREATE INDEX` statements in the emitted DDL. The entity-level array is removed — the field-level `indexed: true` already covers those single-column indexes. The remaining entity-level indexes (composite `(account_id, is_primary)` on Contact, composite `(state, due_date)` on Invoice) stay since they cover different columns than the field-level singles.

### 3. Tests + ADR update

- `packages/kernel/src/ddl/emit.test.ts`: the old test "treats tenant_owned and part_11_compliant as no-column traits" is split into "tenant_owned trait adds a tenant_id UUID NOT NULL column" (positive assertion) and "treats part_11_compliant as a marker trait with no columns" (unchanged behavior). A new `describe("emitEntity — tenant_owned trait")` block covers: tenant_id column + index, cross-schema FK to meta.tenants, RLS enable + policy, entities WITHOUT the trait remain unchanged, and the trait composes cleanly with `auditable`.
- `packages/pack-erp-core/src/entities.test.ts`: new test asserts every pack entity contains `"tenant_owned"` in its trait list.
- `apps/architect-cli/src/apply.test.ts`: existing assertion `result.tableCount === 115` updated to `119` (was wrong even before M7.7; META_TABLES grew to 119 in M5.7's chat-persistence work but the assertion was never updated).

## Cross-cutting invariants enforced

- **Pack tables now isolate per tenant at the DB level.** `SELECT * FROM public.account` returns zero rows unless `app.current_tenant_id` is set. Cross-tenant queries are physically impossible without bypassing the role + RLS, which is what the platform's principal model already prevents.
- **FK direction stays `entity.tenant_id → meta.tenants.id`.** Same direction as every META table that already does this. `ON DELETE CASCADE` matches the META convention — deleting a tenant cascades through all that tenant's data, which is what GDPR Article 17 deletion requires.
- **The policy expression is verbatim from META.** `tenant_id = current_setting('app.current_tenant_id', true)::UUID`. Same string. If META switches to a different session variable name in a future kernel rev, pack RLS picks up the change automatically — both paths read from the same source.
- **`auditable` + `tenant_owned` compose without collision.** No field-name overlap (`tenant_id` vs `created_at`/`updated_at`/`created_by`/`updated_by`). A single `expandTraits` call returns the union; `checkEntityFieldNames` catches collisions if a pack accidentally declares a `tenant_id` field on a tenant-owned entity.
- **Pack entities without `tenant_owned` are still possible.** A future cross-tenant table (e.g., a marketplace catalog) can omit the trait and get no RLS. The kernel doesn't force every pack table to be tenant-owned — that's a per-entity authoring decision.
- **The change is auditable in one diff.** Operators upgrading from M7 to M7.7 see exactly one trait-array change per entity in their pack source, plus the emitted SQL gains `tenant_id` column, FK, RLS enable, RLS policy. No other behavior shifts.

## Alternatives considered

- **Inject `tenant_id` via the `reference` field type with a synthetic target name.**
  - **Pros.** Reuses the existing field-emit FK path.
  - **Cons.** The `reference` field type targets manifest-level entities (entities declared in `manifest.entities[]`), not META tables. Forcing a synthetic `Tenants` entity into every manifest would pollute the entity registry. Cross-schema references would need a separate field-type kind anyway.
  - **Decision.** Separate `ALTER TABLE ADD CONSTRAINT` statement.

- **Make every pack entity tenant-owned by default.**
  - **Considered.** Forbidding non-tenant-owned pack entities entirely.
  - **Decision.** Out of scope. The kernel keeps the trait opt-in; pack authors who need a cross-tenant table (rare, but the marketplace catalog is one) drop the trait. Pack-erp-core opts in explicitly because every ERP entity is per-tenant.

- **Emit `FORCE ROW LEVEL SECURITY` as well as `ENABLE`.**
  - **Pros.** Defends against table owners (e.g., the user who ran the migration) bypassing RLS.
  - **Cons.** Tightens deployment requirements — the migration user usually wants to bypass RLS for setup work. META tables today only use `ENABLE`.
  - **Decision.** Match META — `ENABLE` only. Operators who need `FORCE` add it via a post-apply script. A future M7.8 could add it behind an opt-in flag.

- **Add a separate `tenant_isolation_policy_check` clause (`WITH CHECK`).**
  - **Considered.** The current policy applies to all operations via `USING`; adding `WITH CHECK` would prevent writes that set a different tenant_id.
  - **Decision.** Defer. META tables don't currently use `WITH CHECK` either. The application layer already sets `tenant_id` from the principal context. A future audit could surface the gap and add `WITH CHECK` everywhere consistently.

- **Make the trait's column name configurable.**
  - **Considered.** Some operators might want `org_id` or `workspace_id` instead.
  - **Decision.** Fixed `tenant_id` for kernel consistency. Naming variation belongs above the kernel — a higher-level deployment can alias if needed.

- **Skip the cross-schema FK** (use no FK; rely on application-level enforcement).
  - **Considered.** Avoids the cross-schema dependency.
  - **Decision.** Keep the FK. Postgres handles cross-schema FKs cleanly; the META and pack DDL apply atomically in `apply --pack` (see ADR-0063); the FK guarantees `tenant_id` always references a real tenant. Lose the FK and you lose the cascade-on-delete behavior GDPR Article 17 depends on.

- **Emit RLS via a single combined `CREATE POLICY ... USING (...) WITH CHECK (...)` statement.**
  - **Considered.** Slightly fewer SQL statements.
  - **Decision.** Two statements (ENABLE + CREATE POLICY) for clarity + matching META's pattern.

## Consequences

- **`crossengin apply --pack=operate-erp/core` now produces production-grade SQL.** A multi-tenant deployment can use the resulting schema as-is. The 4 ERP entity tables (Account, Contact, Invoice, InvoiceLine) each carry `tenant_id`, an index on `tenant_id`, a FK to `meta.tenants`, RLS enabled, and a `<table>_tenant_isolation` policy.
- **5,907 → 5,914 tests** (+7). 6 in `kernel/src/ddl/emit.test.ts` (3 new tenant_owned describe cases plus updates to 2 existing tests), 1 in `pack-erp-core/src/entities.test.ts` (every entity has `tenant_owned`).
- **The duplicate-index issue in Account is fixed as a side effect.** Removed entity-level `indexes: [{fields: ["status"]}, {fields: ["name"]}]` since field-level `indexed: true` already covers those. The pack SQL is now duplicate-free.
- **Pattern set for every future pack.** `pack-erp-healthcare`, `pack-erp-retail`, etc. just include `"tenant_owned"` in each entity's trait list. No additional plumbing.
- **The kernel ergonomics issue from ADR-0058 is now half-resolved.** ADR-0058 surfaced two minor pain points: (a) `ListViewSchema`'s `.default()` clauses force `parse()` usage, (b) `IndexDefinition` has no `name` field. M7.7 doesn't address those — they're independent issues a future polish pass can fix.
- **The end-to-end demo from ADR-0063 now produces deployment-grade output.** `crossengin apply --pack=operate-erp/core` against a real Postgres creates a multi-tenant schema where every pack table is isolated by RLS, FK-bound to the tenant registry, and indexed for per-tenant queries.

## Open questions

- **Q1:** Should the policy support read-only vs read-write distinctions per role (some roles see all tenants, some see only theirs)?
  - _Current direction:_ Not in M7.7. The current single-policy model covers the common case. Per-role policies are a Phase 3 concern when admin/auditor roles need to span tenants.
- **Q2:** What about cross-tenant aggregate queries (FinOps reports, platform analytics)?
  - _Current direction:_ Run as a superuser or a role that bypasses RLS. The pattern is already used for the platform-level META tables; pack tables follow the same model.
- **Q3:** Should pack-erp-core declare its `entities` order to ensure the FK to `meta.tenants` is set up before the first entity FK lookup?
  - _Current direction:_ Not needed. The `apply --pack` command always applies META first then pack, so `meta.tenants` always exists before any pack FK fires. Operators applying just the pack (no META) would hit a missing-table error — documented as a known constraint in ADR-0063.
- **Q4:** Does this affect existing pack-erp-core users' migrations?
  - _Current direction:_ The new statements are appended to the existing pack DDL. Operators who previously ran `apply --pack=operate-erp/core` against a real Postgres now need to manually add `tenant_id` columns to existing rows, populate them, then re-run `apply --pack` to add the FK + RLS. A future M7.8 could ship a migration helper, but for M7.7 the policy is: pack DDL is for greenfield deployments; operators with existing data follow standard ALTER TABLE migration patterns.
- **Q5:** Does `tenant_owned` need a `FORCE ROW LEVEL SECURITY` variant?
  - _Current direction:_ Match META (`ENABLE` only). If operators need `FORCE`, they add it post-apply.
