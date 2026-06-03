# ADR-0076: ERP Grocery pack — transitive pack lineage (Phase 2 M7.9.1)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0075 (pack-erp-retail), ADR-0065 (pack-erp-healthcare), ADR-0058 (pack-erp-core), ADR-0001 (meta.extends) |

## Context

`meta.extends` had been exercised at one level only: healthcare (M7.5) and retail (M7.9) each extend `operate-erp/core` directly — a single parent, one hop. The kernel's `resolveManifest` (ADR-0001) supports *nested* resolution (a parent that itself extends a grandparent), but no pack proved it end-to-end. ADR-0075 Q4 named the gap.

M7.9.1 ships `pack-erp-grocery`, which extends `operate-erp/retail` — a pack that *itself* extends core — forming a **three-level lineage** `grocery → retail → core`. Resolving it requires `resolveManifest` to recurse through retail into core and merge all three. The grocery entities reference both a *retail* entity (`Product`) and a *core* entity (`Account`), so the pack cross-validates only when the whole chain is present.

## Decision

`@crossengin/pack-erp-grocery` (depends on `pack-erp-retail` + `pack-erp-core`) declares `meta.extends: ["operate-erp/retail"]` and adds a grocery domain on top.

### Content

- **2 entities** (both `auditable`): `Supplier` (references **core** `Account`; `contact_email` classified `pii`) and `PerishableLot` (references **retail** `Product` + own `Supplier`; `cost_per_unit` classified `commercial_sensitive`; a 4-state lifecycle).
- **3 relations**, two cross-pack across *different* levels: `Account → Suppliers` (from a **core** entity, two hops up) and `Product → Lots` (from a **retail** entity, one hop up); plus `Supplier → Lots`.
- **2 roles** (`grocery_admin` / `receiving_clerk`); the clerk is excluded from `PerishableLot.cost_per_unit` (classification default + explicit grant).
- **1 `entityLifecycle`** for `PerishableLot` (`received → on_shelf → depleted | expired`, `expire` automatic; `received → on_shelf` 1-day SLA).
- **1 job** (expiring-lots-reminder), **1 view**, `compliancePacks: ["haccp"]`.

### Resolution

`buildErpGroceryPack()` returns the standalone (extends-bearing) manifest. A `ManifestRegistry` that serves **both** `operate-erp/retail` and `operate-erp/core` is required: `resolveManifest(grocery, {registry})` resolves grocery's parent (retail), which recursively resolves retail's parent (core), and merges core → retail → grocery into one manifest.

## Cross-cutting invariants enforced (by tests)

- **Transitive resolution works.** Resolving grocery against the full chain registry produces a manifest with **10 entities** (4 core + 4 retail + 2 grocery), **9 roles**, **3 workflows**, **11 relations** (3 + 5 + 3) — and `tryValidateManifest` passes.
- **The whole chain is required.** Resolving grocery against a registry that has retail but **not** core *throws* (retail's own `extends: [core]` can't resolve) — proving the resolution recurses, not just reads the immediate parent.
- **Cross-level references resolve.** `PerishableLot.product_id → Product` (a retail entity) and `Supplier.account_id → Account` (a core entity) both resolve in the merged manifest — references reaching one and two hops up the lineage.
- **Lineage records both ancestors.** `meta.manifestResolution.parents` contains **retail and core** (the nested parent surfaces in the lineage), and `meta.extends` is stripped from the resolved output.
- **Classifications survive the deeper merge.** `manifestClassifiedFields(resolved)` includes grocery's (`PerishableLot.cost_per_unit`, `Supplier.contact_email`) *and* retail's (`Product.unit_cost`) — the classification metadata propagates through two merge levels intact.

## Alternatives considered

- **Extend `["operate-erp/core", "operate-erp/retail"]` directly (sibling multi-parent).**
  - **Considered.** Literally the ADR-0075 Q4 phrasing.
  - **Decision.** Rejected — because retail already extends core, listing both makes core merge *twice*; `mergeContent` dedups entities by name but `concatOrUndefined` does **not** dedup relations, so core's relations would appear twice in the resolved array (messy assertions, redundant lineage). Extending only `["operate-erp/retail"]` gives a clean three-level chain with no double-merge — and exercises the genuinely-new path (nested/transitive resolution). True independent-sibling multi-parent has no real case here (core is the only base); it's covered by the kernel's `extends.test.ts`.
- **Make grocery a flat pack extending core directly.**
  - **Decision.** No — that would be a third sibling of healthcare/retail, not a new capability. The point is depth: a pack on a pack.
- **Reference only retail entities (not core).**
  - **Decision.** Reference both (`Product` from retail, `Account` from core) so the pack genuinely depends on the *full* depth, not just the immediate parent — strengthening the "whole chain required" demonstration.

## Consequences

- **57 packages + 1 app, 122 meta-schema tables, 6,170 tests** (was 56 / 122 / 6,150; +1 package, +20 tests, 0 new tables). `meta.extends` is now proven at **two depths** (single-parent: healthcare/retail; transitive three-level: grocery).
- **Deep vertical specialization is real.** A pack can specialize a vertical that specializes the base (`grocery` is a kind of `retail` is a kind of ERP `core`), with references and classifications flowing through every level — the "verticals all the way down" story.
- **Classification composes with depth.** The redaction/encryption arc declared on a field at any level survives arbitrary merge depth, so a deeply-nested pack inherits its ancestors' data-protection posture automatically.
- **The pack-extension story is complete.** Single-parent (×2 consumers) and multi-level lineage are both demonstrated with passing cross-validation; `pack-erp-construction` / `-education` (flat) and deeper specializations (`grocery-organic`?) follow the same shapes.

## Open questions

- **Q1:** True independent-sibling multi-parent (`extends: [A, B]` where A, B share no ancestor)?
  - _Current direction:_ No real case yet (core is the sole base). When two independent base packs exist, a pack extending both will exercise the sibling-merge + relation-dedup question (relations concat without dedup — a `mergeRelations`-with-dedup may be warranted then).
- **Q2:** Should `resolveManifest` dedup concatenated relations across a diamond lineage?
  - _Current direction:_ Not needed for the linear chain (no diamonds here). If a diamond (`D → B, C → A`) ever arises, relations from `A` would duplicate; a dedup keyed on `(kind, from, field, to)` is the fix. Flagged for the multi-parent milestone.
- **Q3:** A four-level pack (`grocery-organic → grocery → retail → core`)?
  - _Current direction:_ The mechanism is depth-agnostic; M7.9.1 proves three levels. Deeper nesting is more of the same and isn't worth a dedicated pack unless a product need appears.
- **Q4:** Inventory/stock as a shared entity between retail and grocery?
  - _Current direction:_ Out of scope (ADR-0075 Q1). If an `InventoryLevel` entity lands in retail, grocery's `PerishableLot` could reference it — another cross-level tie.
