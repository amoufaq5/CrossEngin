# ADR-0103: Declarative document numbering + tenant admin settings (Phase 3 P1.23)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0078 (operate-runtime), ADR-0086 (operate-runtime-pg), ADR-0087 (operate-server), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.23).

## Context

ERP documents (invoices, vendor bills, payments, purchase orders, journal
entries, goods receipts) require auto-generated, human-meaningful, sequential
numbers (`INV-2026-00001`). The kernel field `default` supported only `literal`
and `expression`; document numbering was a manual required text field. There was
also no surface for an operator to configure company profile, defaults, or the
numbering scheme — the first two of the user's five enterprise-quality asks
(auto-numbering + admin settings).

## Decision

### Phase 1 — declarative document numbering

- **`types/meta-schema/field.ts`** — a third `DefaultValue` kind, `sequence`:
  `{ kind, sequence, format?, resetPeriod?, start? }`. `SEQUENCE_RESET_PERIODS =
  never | yearly | monthly | daily`. Numbering is a *runtime* concern, so:
- **`kernel/ddl/column.ts`** — `emitDefault` returns `null` for a sequence
  default (no SQL `DEFAULT` clause); the column is emitted as a plain typed
  column. `diff.ts` renders it as `sequence:<name>`.
- **`operate-runtime/sequences.ts`** — `SequenceAllocator` (allocate one
  monotonic value per `(tenant, name, periodKey)`), `InMemorySequenceAllocator`,
  pure `derivePeriodKey` / `formatSequenceNumber` (tokens `{SEQ:N}`, `{YYYY}`,
  `{YY}`, `{MM}`, `{DD}`), `sequenceFieldPlans(entity)`, and
  `applySequenceDefaults` — fills only *blank* sequence fields, so a
  caller-supplied value (legacy import) is preserved.
- **`operate-runtime/handlers.ts`** — the `create` handler applies sequence
  defaults before `store.create`, allocating + formatting each blank
  sequence-defaulted field. Plans are precomputed per entity at compile time.
- **`operate-runtime-pg/sequence-store.ts`** — `PostgresSequenceAllocator` over
  `meta.operate_sequences` via a single atomic `INSERT … ON CONFLICT DO UPDATE …
  RETURNING` inside `withTenantContext` (RLS-confined, tenant id bound, sequence
  name + period key identifier-validated).

### Phase 2 — tenant admin settings

- **`operate-runtime/settings.ts`** — `TenantSettings` (company profile,
  operational defaults, per-sequence `numbering` overrides), `SettingsStore` +
  `InMemorySettingsStore`, and `sequenceSpecResolver(settings)` — overlays a
  sequence's manifest spec with a matching numbering override so an admin can
  change the format/start/reset without a redeploy.
- **`operate-runtime/admin-handlers.ts`** — `GET`/`PUT /v1/admin/settings`,
  RBAC-gated to `adminRoles` (fail-closed), validated on write.
- **`operate-runtime/compile.ts`** — registers the admin routes + threads the
  allocator / settings store / clock into the handler context when supplied.
- **`operate-runtime-pg/settings-store.ts`** — `PostgresSettingsStore` over
  `meta.operate_tenant_settings` (singleton JSONB row per tenant, RLS).
- **`apps/operate-server`** — `resolveStore` builds the matching allocator +
  settings store per `--store` (in-memory ↔ Postgres) and wires them into the
  gateway.
- **`apps/operate-web`** — an `/admin/settings` page (company profile +
  numbering table) over the proxy, linked from the sidebar.

### Meta-schema

Two tables (#124, #125): `meta.operate_sequences` (tenant-scoped counter, unique
on `(tenant_id, sequence_name, period_key)`, RLS) and
`meta.operate_tenant_settings` (singleton JSONB per tenant, RLS).

### Pack

`pack-erp-core` document numbers are now sequence-defaulted: `INV-`, `BILL-`,
`PAY-`, `PO-`, `JE-`, `EXP-`, `GRN-` — all `{YYYY}-{SEQ:5}`, yearly reset.

## Consequences

- Creating an invoice with no `invoice_number` yields `INV-2026-00001`,
  `INV-2026-00002`, … gap-free per allocation, resetting each year.
- Admins reconfigure numbering + company profile live; overrides apply to new
  documents only.
- A sequence default emits a plain column — existing DDL/diff/migration paths are
  unaffected; the allocator is the only writer of the value.
- 125 meta tables; +72 tests (6,455 total), zero type errors.
