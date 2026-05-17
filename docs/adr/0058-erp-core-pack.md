# ADR-0058: First vertical pack — ERP Core (Phase 2 M7)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0003 (meta-schema), ADR-0004 (manifest spec), ADR-0007 (workflow engine), ADR-0008 (RBAC/ABAC), ADR-0046 (Phase 2 plan) |

## Context

After 18 milestones of contract + runtime + tooling work, the substrate has never been exercised by a real consumer. Every package was validated against its own contracts; no manifest has actually flowed end-to-end through entities → relations → roles → permissions → workflows → jobs → views with the kernel's cross-reference validators applied. The substrate could be silently broken in ways no individual package test would catch.

Three constraints shaped the design:

1. **It must be a real vertical, not a toy.** ERP Core means accounting and customer records — Account, Contact, Invoice, InvoiceLine. A pack of just `Widget { name }` wouldn't stress field types, references, decimals, enums, workflows, or permissions. Real billing data does.

2. **The pack must validate end-to-end.** `tryValidateManifest` runs the full cross-validator suite: entity uniqueness, FK target resolution, role graph cycles, permission grants referencing declared roles, workflow transitions matching permission transition entries, view entity references, job event-name shapes. The pack has to pass all of them — otherwise the abstractions don't hold up.

3. **The pack is a library, not a service.** It exports a `buildErpCorePack(opts)` function that returns a `Manifest`. Consumers wire it into their own context: ship it as-is for a default Operate tenant, or merge it with vertical-specific extensions (operate-erp/healthcare extends operate-erp/core). Phase 3 plug-in / extension semantics come later; for now, "consume the function" is the contract.

## Decision

`@crossengin/pack-erp-core` ships **8 modules** + index:

### Entities (`entities.ts`)

Four entities, all carrying the `auditable` built-in trait (which contributes `created_at`/`updated_at`/`created_by`/`updated_by`). No entity declares an `id` field — the kernel injects the implicit UUID primary key per ADR-0003.

- **`Account`** (10 user-fields). `status` enum: `prospect`/`active`/`suspended`/`churned`. `billing_email` required (kernel `email` field type). `country` is `country_code`. Indexed on `status` + `name`.
- **`Contact`** (7 user-fields). `account_id` references Account. Composite index on `(account_id, is_primary)` so the per-account primary contact lookup is one row.
- **`Invoice`** (12 user-fields). `state` enum mirrors the workflow's 5 states: `draft`/`sent`/`paid`/`overdue`/`void`. Money fields are `decimal(14, 2)` with `min: 0`. `invoice_number` is unique. Composite index on `(state, due_date)` for the overdue-sweep query.
- **`InvoiceLine`** (7 user-fields). `invoice_id` references Invoice. `tax_rate_pct` is `decimal(5, 2)` constrained to `[0, 100]`. `position` orders lines within an invoice.

### Relations (`relations.ts`)

Three relations declared at the manifest level:

- `Account → Contact` (one-to-many) with `onDelete: cascade` — removing an account removes its contacts.
- `Invoice → Account` (many-to-one) with `onDelete: restrict` — you can't delete an account that has invoices on the books.
- `Invoice → InvoiceLine` (one-to-many) with `onDelete: cascade` — voiding an invoice removes its lines.

### Roles (`roles.ts`) + Permissions (`permissions.ts`)

Three roles (no inheritance, no ABAC for the MVP):

- `erp_admin` — full CRUD + admin-only deletes + admin-only `void` transition.
- `erp_accountant` — read all, write account/contact/invoice/lines, but no deletes. Can execute `send`/`mark_paid`/`mark_overdue` transitions.
- `erp_viewer` — read-only across the four entities.

Per-entity permissions follow the matrix `list / read / create / update / delete / transitions{}`. Invoice declares 4 transitions whose names match the workflow exactly (the kernel's `validatePermissions` cross-validator enforces this).

### Workflow (`workflows.ts`)

`invoice_lifecycle`: `entityLifecycle` workflow on `Invoice.state`. 5 states (`draft` → `sent` → `paid|overdue|void`, with `mark_paid` reachable from both `sent` and `overdue`). 4 transitions; `paid` + `void` are terminal. One SLA: `sent → paid` within 30 days (`P30D`), escalating to `notify_accountant`.

### Jobs (`jobs.ts`)

Two declarations:

- **`erp-core-overdue-invoice-reminder`** — scheduled cron `0 6 * * *` (UTC). Sweeps sent-state invoices past their due date and transitions them to `overdue`. Per-tenant concurrency 5, 3-attempt exponential retry, alert-and-dead-letter on failure.
- **`erp-core-payment-received-handler`** — event-triggered on `billing.payment_received`. Looks up the invoice and submits a workflow signal to transition it to `paid`. Higher concurrency (20), more retries (5), input data class `commercial_sensitive`.

### Views (`views.ts`)

Two list views: `account.list` (sorted by name) and `invoice.list` (sorted by due_date). Both have realistic column sets and export formats. The list-view schema has `.default()` clauses for `sortable/filterable/hidden/truncate`, so the consts are constructed via `ListViewSchema.parse(...)` to apply those defaults at module load.

### Pack builder (`pack.ts`)

`buildErpCorePack(opts?)` returns the full `Manifest`. Optional `description` + `compliancePacks` overrides. `ERP_CORE_PACK_SLUG = "operate-erp/core"`, `ERP_CORE_PACK_VERSION = "0.1.0"`. The returned manifest validates against `ManifestSchema` (zod) + `tryValidateManifest` (cross-validator).

## Cross-cutting invariants enforced

- **All four entities use the `auditable` trait.** Per-row audit columns are uniform. Verified by `entities.test.ts`.
- **No entity declares `id`.** The kernel injects an implicit UUID primary key (`ReservedFieldNameError` if a pack ships `id`). Verified.
- **All `reference` fields resolve to entities declared in the same pack.** `Contact.account_id → Account`, `Invoice.account_id → Account`, `InvoiceLine.invoice_id → Invoice`. The kernel's `validateEntitiesTraitsRelations` cross-validator enforces this.
- **Permission transitions match workflow transitions.** Invoice declares `send / mark_paid / mark_overdue / void` in both `permissions.Invoice.transitions` and `workflows.invoice_lifecycle.transitions`. The kernel's `validatePermissions` cross-validator enforces 1:1.
- **All grants reference roles declared in `manifest.roles`.** Every `roles: [...]` entry in a permission grant matches one of `erp_admin / erp_accountant / erp_viewer`. The kernel enforces this; pack tests rely on `tryValidateManifest`.
- **Workflow reachability holds.** Every state in `invoice_lifecycle` is reachable from `draft`. The kernel's workflow validator enforces this.
- **Money fields are non-negative.** `subtotal / tax_total / total / quantity / unit_price / tax_rate_pct / line_total` all have `min: 0` (and `tax_rate_pct` also `max: 100`). The DDL emit produces real Postgres check constraints.
- **Pack hash is deterministic.** Two consecutive `buildErpCorePack()` calls produce identical `manifestHash` outputs. Tests verify.

## Alternatives considered

- **Ship a YAML manifest file instead of a TypeScript builder.**
  - **Pros.** Editable without rebuilding. Could be loaded by any tool.
  - **Cons.** Loses type safety. The builder function lets vertical extensions (e.g., `pack-erp-healthcare`) merge / override pieces programmatically.
  - **Decision.** TypeScript builder. Phase 3 can emit a YAML serialization for `crossengin init --from-pack operate-erp/core`.

- **Include compliance-pack bindings (HIPAA / SOC2) by default.**
  - **Considered.** Pre-bind every Account/Contact as PII, every Invoice as commercial_sensitive.
  - **Decision.** Out of scope for M7. The `compliancePacks` field is optional on the builder; consumers wire compliance at their tenant level. M7's pack is the substrate, not the policy.

- **Add a customer-facing Payment entity (one-to-many to Invoice).**
  - **Considered.** Closes the billing loop in-pack.
  - **Decision.** Defer to M7.5 (`pack-erp-payments`). Payment lifecycle has its own workflow (initiated → captured → settled / refunded / failed) and integration concerns. Keeping M7 focused on the receivables side is better than half-modeling payments.

- **Add a Tax entity for jurisdiction-specific tax rates.**
  - **Considered.** A real ERP needs this.
  - **Decision.** Out of scope. M7's `InvoiceLine.tax_rate_pct` is a literal — for a real deployment, tax computation is a vertical-specific extension (US sales tax, EU VAT, KSA VAT, GST). The base pack stays jurisdiction-agnostic.

- **Wire activity handlers for the workflow runtime (e.g., `send_invoice_email`).**
  - **Considered.** The workflow refers to abstract transitions; the runtime needs handlers registered to actually do something.
  - **Decision.** Out of scope for M7. Handlers are deployment-time wiring (which email provider? which template?). The pack ships the declarative shape; the consumer registers the handlers in their `WorkflowEngine` instance.

- **Ship a gateway route registry too.**
  - **Considered.** REST endpoints for `/accounts`, `/invoices`, etc.
  - **Decision.** Out of scope. The substrate (api-gateway-runtime + api-gateway-pg) can route operations against entities, but the route specification is a consumer concern. M7.5 (HTTP layer) is where this lands.

- **Use slugified PascalCase for entity names.**
  - **Considered.** `account_entity` instead of `Account`.
  - **Decision.** PascalCase matches the kernel's `EntityNameSchema` (must start with uppercase letter). Field names stay `snake_case` per the kernel field-name regex.

- **Make the pack a runtime construct (instances at process start) instead of static exports.**
  - **Considered.** `const pack = new ErpCorePack(); pack.entities()`.
  - **Decision.** Static exports + a builder function. Stateless. Easier to test, easier to merge with extensions, no lifecycle to manage.

## Consequences

- **50 packages + 1 app, 119 meta-schema tables, 5,717 tests** (was 49 / 119 / 5,671; +1 package, +46 tests, 0 new META_ tables since pack-erp-core uses existing tenant-data tables — the kernel emits per-pack DDL via `entitiesAddedToTenant`).
- **The substrate is proven.** The pack passes `tryValidateManifest`: every cross-reference resolves, every role grant validates, every workflow transition has a matching permission grant. The abstractions hold up under a realistic schema.
- **Pattern set for future packs.** `pack-erp-healthcare`, `pack-erp-construction`, `pack-erp-retail` all follow the same shape: `entities.ts` + `relations.ts` + `roles.ts` + `permissions.ts` + `workflows.ts` + `jobs.ts` + `views.ts` + `pack.ts` builder. Each can `extends: ["operate-erp/core"]` and override slice by slice.
- **The Architect agent has a target.** A developer can now say "build me an ERP for a small accounting firm" and Claude can start from `buildErpCorePack({description: "..."})` and propose extensions. M5.8's `propose_manifest_edit` writes the result.
- **No new META_ tables.** Pack entities map to per-tenant tables emitted at apply-time, not platform-level META_ tables. The pack is **declarative data**, not infrastructure.
- **Gaps surfaced.** Building the pack revealed that:
  - The kernel's `ListViewSchema` has `.default()` clauses that force consts to use `.parse(...)` rather than literal typing — small ergonomic issue, captured here for a future kernel review.
  - The `IndexDefinitionSchema` has no `name` field — index names are auto-generated. Documented in CLAUDE.md.

## Open questions

- **Q1:** Should the pack ship an `extends`-able variant ID so descendants can declare lineage?
  - _Current direction:_ The `meta.extends` array already supports parent slugs. Phase 3 marketplace adds signing + versioning on top.
- **Q2:** Should the SLA's `escalation: "notify_accountant"` reference a declared notification template?
  - _Current direction:_ Out of scope for M7. The notifications package declares templates; this pack would need to also ship a template, which expands scope. M7.5 can wire it.
- **Q3:** How does a tenant override the cron schedule on `erp-core-overdue-invoice-reminder`?
  - _Current direction:_ Future feature — pack-level config / override file. For now the cron is fixed; downstream packs duplicate the job declaration with a different schedule.
- **Q4:** Should we add data-lineage `LineageNode` declarations so GDPR Article 15 traversals work out-of-the-box?
  - _Current direction:_ Yes eventually — when the pack moves out of M7 "first draft" status, lineage nodes for Account / Contact (the PII-bearing entities) should be declared. Defer to M7.6.
- **Q5:** Should `buildErpCorePack` accept entity overrides (e.g., remove `legal_name` for a specific tenant)?
  - _Current direction:_ Not in M7. Consumers who need to override compose by spreading: `{...buildErpCorePack(), entities: [...customAccount, ...rest]}`. A typed override API can ship in M7.5 if patterns emerge.
