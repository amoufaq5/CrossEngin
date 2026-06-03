# ADR-0075: ERP Retail vertical pack (Phase 2 M7.9)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0065 (pack-erp-healthcare), ADR-0058 (pack-erp-core), ADR-0066 (field classification), ADR-0001 (meta.extends) |

## Context

M7 (ADR-0058) shipped `pack-erp-core`; M7.5 (ADR-0065) shipped `pack-erp-healthcare`, the first pack to use `meta.extends` lineage. The healthcare pack exercised the full classification arc with **PHI** (audit-required, encryption-hinted). What hadn't been shown: the same arc on a domain whose sensitive data is **not** PHI — `commercial_sensitive` + `pii` fields that are redaction-worthy but not encryption-mandated. M7.9 ships `pack-erp-retail` for that, and confirms the pack-extension mechanism generalizes to a third vertical.

## Decision

`@crossengin/pack-erp-retail` mirrors the healthcare pack's module shape (`entities` / `relations` / `roles` / `permissions` / `workflows` / `jobs` / `views` / `pack`), declares `meta.extends: ["operate-erp/core"]`, and references core entities (`Account`, `Invoice`) — so it cross-validates only after `resolveManifest` merges core in.

### Content

- **4 entities** (all `auditable`): `Product` (unique `sku`, public `unit_price`, `unit_cost` classified **`commercial_sensitive`**), `Store` (references core `Account`), `SalesOrder` (references `Store` + optionally core `Invoice`; `customer_email` classified **`pii`**; a 5-state lifecycle), `OrderLine` (references `SalesOrder` + `Product`).
- **5 relations**, two **cross-pack**: `Account → Stores` (from a *core* entity) and `SalesOrder → Invoice` (to a *core* entity); plus `Store → SalesOrders`, `SalesOrder → OrderLines`, `Product → OrderLines`.
- **4 roles** (`retail_admin` / `store_manager` / `cashier` / `retail_analyst`). The `cashier` is explicitly *excluded* from reading `Product.unit_cost` — both by the classification default (commercial_sensitive redacted unless privileged) and by an explicit `fields.unit_cost.read` grant that documents which roles see cost.
- **1 `entityLifecycle` workflow** for `SalesOrder` (`cart → placed → fulfilled → returned`, `cancel` from cart/placed; `fulfilled` is *active* — it has an outgoing `mark_returned` — with a 2-day fulfillment SLA).
- **2 jobs**: a scheduled `low-stock-reminder` (internal) and an event-driven `order-placed-handler` (`inputDataClass: pii` — it emails the customer).
- **2 list views**, `compliancePacks: ["pci"]`.

### `buildErpRetailPack(opts?)`

Returns the standalone (extends-bearing) `Manifest`; tests resolve it against a core `ManifestRegistry` and pass `tryValidateManifest`.

## Cross-cutting invariants enforced (by tests)

- **Standalone fails, resolved passes.** `tryValidateManifest(buildErpRetailPack())` → `ok: false` (references `Account`/`Invoice`); after `resolveManifest` against core, `ok: true` — 8 entities (4 + 4), 8 relations (3 + 5), merged roles (3 + 4), both lifecycle workflows.
- **Classification without PHI.** `Product.unit_cost` → `commercial_sensitive`, `SalesOrder.customer_email` → `pii`; a test asserts **no** `phi`/`regulated` class appears, so the audit-required + encryption-hint invariants don't fire — the redaction arc works on a non-PHI domain.
- **Cost is hidden from cashiers.** The `fields.unit_cost.read` grant excludes `cashier`; combined with the classification default, a cashier reading a `Product` gets `unit_cost` redacted — the M7.7/M7.7.5 redaction on commercial-sensitive data, demonstrated.
- **Terminal-state discipline.** `fulfilled` is `active` (not terminal) because it has an outgoing `mark_returned`; the workflow validator (which forbids transitions out of terminal states) passes — a real constraint the pack had to satisfy.
- **Lineage recorded.** The resolved manifest's `meta.manifestResolution.parents` carries core's slug/version/`manifestHash`; `meta.extends` is stripped.

## Alternatives considered

- **Add a card/payment entity with `regulated` fields.**
  - **Decision.** No — PCI says *don't store* the PAN. Modeling card data would invite the wrong pattern. Retail's sensitive data is wholesale cost (`commercial_sensitive`) + customer contact (`pii`); the pack reflects that, and intentionally has no `phi`/`regulated` field, which is the point (the arc works without encryption).
- **Reuse core `Contact` as the retail customer.**
  - **Decision.** Kept the customer as a `customer_email` field on `SalesOrder` (a lightweight PII attribute) rather than a full entity — retail orders capture an email at checkout without a CRM contact. A full `LoyaltyMember` entity is a later addition if loyalty is modeled.
- **Make `Store` standalone (no `Account` reference).**
  - **Decision.** `Store → Account` is the cross-pack tie that proves extension (a retail relation whose `from` is a core entity). Standalone stores would weaken the demonstration.
- **A third compliance pack value beyond `pci`.**
  - **Decision.** `["pci"]` default, overridable. PCI is the canonical retail posture even though no card data is stored (the *processing* is in scope).

## Consequences

- **56 packages + 1 app, 122 meta-schema tables, 6,150 tests** (was 55 / 122 / 6,120; +1 package, +30 tests, 0 new tables). `meta.extends` now has **two** independent consumers (healthcare, retail), proving the mechanism generalizes.
- **The classification arc is domain-proven twice.** Healthcare exercised PHI (mask + audit + encryption); retail exercises `commercial_sensitive` + `pii` (mask only) — the same declaration drives the right behavior per data class, with encryption correctly *not* engaged for non-PHI.
- **A second extension template.** `pack-erp-retail` is the model for `pack-erp-construction` / `-education` etc.: declare domain entities, cross-reference core, classify sensitive fields, set `meta.extends`, resolve + validate.
- **The Architect agent gains a third worked example** — a non-healthcare vertical showing classification on commercial/PII data, alongside core and healthcare.

## Open questions

- **Q1:** Should retail model inventory (on-hand quantity, reorder point) as a real entity?
  - _Current direction:_ Out of scope — the `low-stock-reminder` job references inventory conceptually; an `InventoryLevel` entity (per Store × Product) is a natural M7.9.x addition if stock tracking is modeled.
- **Q2:** Loyalty / customer as a first-class entity?
  - _Current direction:_ `customer_email` PII field for now; a `LoyaltyMember` entity (more PII, a points balance) follows the same classification pattern when loyalty is in scope.
- **Q3:** A retail-specific redaction registry wired into a demo gateway?
  - _Current direction:_ `redactionRegistryFromManifest(resolvedRetailManifest, …)` (M7.7.6) already builds one from the pack's classified fields; a worked gateway example using it is a docs/demo follow-up.
- **Q4:** Multi-parent composition (a pack extending both core *and* retail)?
  - _Current direction:_ Not yet exercised. `resolveManifest` handles multiple parents; a pack like `pack-erp-retail-grocery` extending `["operate-erp/core", "operate-erp/retail"]` would prove the multi-parent merge — a future milestone.
