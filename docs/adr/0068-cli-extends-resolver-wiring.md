# ADR-0068: Kernel `extends` resolver wiring (Phase 2 M7.6.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0065 (pack-erp-payments), ADR-0058 (pack-erp-core), ADR-0063 (CLI pack apply), ADR-0064 (pack tenant scoping) |

## Context

M7.5 shipped `@crossengin/pack-erp-payments` — the second vertical pack, proving cross-pack composition. The implementation took a pragmatic shortcut: `buildErpPaymentsPack()` directly called `buildErpCorePack()` and merged its additions into one Manifest before returning. The combined manifest declared `meta.extends: ["operate-erp/core"]` for documentation, but the resolver-style "load parent by slug from a registry, merge content" path lived inside the pack-erp-payments code rather than the kernel.

The kernel already has `resolveManifest(manifest, context)` in `packages/kernel/src/manifest/extends.ts` — a generic resolver with cycle detection (`ExtendsCycleError`), unknown-parent errors (`UnknownParentManifestError`), and full content-merge semantics (entities + traits by key, relations concat, roles/permissions/workflows/jobs/views by name, deep-merge i18n + search + theme). It just wasn't called from anywhere downstream — packs were doing their own merge.

M7.6.5 wires the kernel resolver into the CLI and refactors pack-erp-payments to be a pure child manifest. Future packs declare what they add via `meta.extends`; the resolver does the merge work; the pack code never imports its parent's `build*Pack()`.

Three reasons this matters:

1. **Single source of truth.** Today the merge happens in pack-erp-payments. If a hypothetical `pack-erp-payments-stripe` extends payments, it would either duplicate the merge logic, transitively call `buildErpPaymentsPack()` (and pay the inline-merge cost twice), or — the right answer — declare `extends: ["operate-erp/payments"]` and let the resolver walk the chain.
2. **Cycle detection.** The pack-side inline merge can't detect cycles. A future pack chain A → B → A would silently produce a manifest with duplicated entities or stack-overflow. The kernel resolver explicitly tracks the parent chain and throws `ExtendsCycleError`.
3. **Marketplace lineage queries.** The marketplace package (M4-era contract) needs to enumerate "what packs does X depend on?" cheaply. With explicit `extends`, that's `meta.extends` recursive resolution — no need to call the pack's builder to discover dependencies.

## Decision

Three small changes:

### 1. `packages/pack-erp-payments/src/pack.ts` — refactor to child-only

`buildErpPaymentsPack()` returns a Manifest with **only the payments additions** (1 entity, 1 relation, 1 permission set, 1 workflow, 2 jobs, 1 view) plus `meta.extends: [ERP_CORE_PACK_SLUG]`. No more `buildErpCorePack()` import; no more inline merge.

```ts
import { ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";

export function buildErpPaymentsPack(opts: BuildErpPaymentsPackOptions = {}): Manifest {
  return {
    manifestVersion: "1.0",
    meta: {
      name: "CrossEngin Operate — ERP Payments",
      slug: ERP_PAYMENTS_PACK_SLUG,
      version: ERP_PAYMENTS_PACK_VERSION,
      description: opts.description ?? "...",
      extends: [ERP_CORE_PACK_SLUG],
      ...(opts.compliancePacks !== undefined ? { compliancePacks: [...opts.compliancePacks] } : {}),
    },
    entities: [...ERP_PAYMENTS_ENTITIES],
    relations: [...ERP_PAYMENTS_RELATIONS],
    permissions: { ...ERP_PAYMENTS_PERMISSIONS },
    workflows: { ...ERP_PAYMENTS_WORKFLOWS },
    jobs: { ...ERP_PAYMENTS_JOBS },
    views: { ...ERP_PAYMENTS_VIEWS },
  };
}
```

This manifest does NOT pass `tryValidateManifest` standalone — `Payment.invoice_id` references `Invoice` which isn't in the entities list. That's intentional: a child manifest's cross-references resolve through the resolver, not through the standalone validator.

### 2. `apps/architect-cli/src/pack-registry.ts` — `packManifestRegistry()` factory

New exported function that wraps `PACK_REGISTRY` as a `ManifestRegistry`:

```ts
export function packManifestRegistry(
  registry: Readonly<Record<string, PackEntry>> = PACK_REGISTRY,
): ManifestRegistry {
  return {
    async getManifest(slug: string): Promise<Manifest | null> {
      const entry = registry[slug];
      return entry !== undefined ? entry.build() : null;
    },
  };
}
```

Future enhancement: when packs ship as installable extensions via `@crossengin/marketplace`, the registry implementation reads from the marketplace's signed-pack store instead of from a hardcoded record. The `ManifestRegistry` interface stays the same.

### 3. `apps/architect-cli/src/apply.ts` — wire `resolveManifest` into `buildPlan`

`buildPlan` is now `async`; it calls `resolveManifest(rawManifest, { registry: packManifestRegistry() })` before `tryValidateManifest`. The resolved manifest carries the merged content; the validator runs over the fully-merged shape, so cross-pack FKs are caught.

```ts
async function buildPlan(input: {...}): Promise<ResolvedPlan> {
  const metaStatements = emitMetaBootstrapSql();
  if (input.packSlug === null) { return { metaStatements, packStatements: [], pack: null, packSchema: input.packSchema }; }
  const pack = resolvePack(input.packSlug);
  const rawManifest = pack.build();
  const manifest = await resolveManifest(rawManifest, { registry: packManifestRegistry() });
  const result = tryValidateManifest(manifest);
  if (!result.ok) throw new PackValidationError(input.packSlug, result.errors);
  const packStatements = emitManifestCreate(manifest, { schema: input.packSchema });
  return { metaStatements, packStatements, pack, packSchema: input.packSchema };
}
```

`runApply` awaits `buildPlan(...)` and gains two new error branches: `ExtendsCycleError` → "pack extends-chain cycle: <msg>" and `UnknownParentManifestError` → "pack references unknown parent: <msg>. Available: <list>".

End-to-end verified: `crossengin apply --dry-run --pack=operate-erp/payments` still emits all 5 entity tables (account, contact, invoice, invoice_line, payment) with M7.7 tenant scoping intact. The resolver merges; the emitter sees a single unified manifest.

## Cross-cutting invariants enforced

- **Resolver always runs before validation.** A child manifest's cross-references can't resolve in isolation; running `tryValidateManifest` on `pack.build()` directly would falsely reject every valid extending pack. The CLI always resolves first.
- **`extends` chain is bounded.** The kernel's resolver tracks the parent chain in a `Set<string>` and throws on revisit. No silent infinite loops.
- **Registry is async.** `getManifest` returns `Promise<Manifest | null>` so future implementations can hit Postgres, the marketplace HTTP API, or a disk cache without changing the contract.
- **Standalone tests target the child manifest.** Tests of pack-erp-payments' identity (slug, version, extends, child entity count) use `buildErpPaymentsPack()` directly. Tests of merged composition (5 entities, 4 relations, cross-pack FK) call `resolveManifest(buildErpPaymentsPack(), {registry: makeRegistry()})` via a `buildResolvedPayments()` helper.
- **Backward-compat with the apply pipeline.** The `emitManifestCreate(manifest, {schema})` call sees the same shape it always saw — one resolved manifest. The resolver is invisible from the emitter's perspective.

## Alternatives considered

- **Keep the inline merge in pack-erp-payments.**
  - **Pros.** No CLI changes. Simpler import graph (no `ManifestRegistry` in the CLI). One fewer concept for pack authors to learn.
  - **Cons.** Every multi-pack chain duplicates the merge logic. Cycle detection has to be implemented per-pack or skipped. Marketplace lineage queries require running the builders.
  - **Decision.** Reject. The merge is a kernel concern, and the kernel already has the resolver. Wire it in.

- **Run the resolver inside `tryValidateManifest`.**
  - **Pros.** One call site for "validate a manifest, resolving extends as needed". Builders that consume `Manifest` get the resolution for free.
  - **Cons.** `tryValidateManifest` becomes async (breaks every caller). `tryValidateManifest` would need a default registry (what does "no registry" mean for a manifest with `extends`?). The validator and the resolver have different failure modes (cycle vs. schema; unknown parent vs. structural error).
  - **Decision.** Reject. The validator stays pure + sync + structural. Callers that need resolution call `resolveManifest` first.

- **Add a `--no-resolve` flag for debugging.**
  - **Considered.** Lets an author run the validator over the raw child manifest to see what's missing.
  - **Decision.** Defer to M7.6.6 if needed. For now, the resolver always runs; a child manifest that fails to resolve produces a clear error.

- **Cache the resolved manifest in the registry.**
  - **Considered.** Avoid re-merging on every apply.
  - **Decision.** Premature. `resolveManifest` runs once per `crossengin apply` invocation and the merge cost is < 1ms. Cache when there's a real call site that runs it in a loop.

- **Move `packManifestRegistry()` into the kernel.**
  - **Considered.** Anyone using `resolveManifest` needs a registry; making the kernel ship one would centralize.
  - **Decision.** The kernel can't know about pack-erp-core / pack-erp-payments — those are downstream packages. The registry construction is a CLI-layer concern. The kernel ships the interface; downstream code ships the implementation.

## Consequences

- **53 packages + 1 app, 119 meta-schema tables, 6,004 tests** (+1 from M7.6.5 — the new child-manifest shape test; existing pack-erp-payments tests refactored to use `buildResolvedPayments()` helper where they need the merged manifest).
- **The kernel's `resolveManifest` is now exercised by a real call site.** Previously the function existed and had unit tests; now it runs every time `crossengin apply --pack=<slug>` executes. Bugs in the resolver surface immediately in the CLI's apply pipeline.
- **Pack authoring is simpler.** A future `pack-erp-healthcare` declares `extends: ["operate-erp/core"]` and adds only healthcare-specific entities. The author never imports `buildErpCorePack` and never thinks about how to merge — the resolver handles it.
- **Marketplace lineage queries don't require running pack builders.** `getDependencies(slug) = (await getManifest(slug)).meta.extends ?? []` — a cheap, build-free traversal of the pack graph.
- **Test pattern set for future packs.** Tests of identity use the child manifest directly; tests of merged composition go through a `buildResolved*()` helper that wraps `resolveManifest` with a local registry stub. The pattern scales to deeper chains (A → B → C) because the helper's registry can hold the whole chain.
- **Error messages improve.** `UnknownParentManifestError` now includes the list of available pack slugs, so a typo in `extends` (`operate-erp/cor`) produces "pack references unknown parent: operate-erp/cor. Available: operate-erp/core, operate-erp/payments". `ExtendsCycleError` includes the cycle.

## Open questions

- **Q1:** Should the resolver run during `validate` too, not just `apply`?
  - _Current direction:_ Not in M7.6.5. `crossengin validate` operates on a manifest file path — there's no registry of named packs available at that level. A future `crossengin validate --resolve-against=<pack-slug>` could opt in.
- **Q2:** What happens when a pack's `extends` list has multiple parents (diamond inheritance)?
  - _Current direction:_ The kernel resolver supports multiple parents — `extends: [A, B]` merges A then B then the child's additions. Conflicting keys (same entity name in A and B) follow the resolver's existing precedence rules (later-listed parent wins, child wins over all parents). No real packs hit this yet; behavior may evolve once a use case emerges.
- **Q3:** Should pack-erp-payments still export `buildErpCorePack` re-export for convenience?
  - _Current direction:_ No. The new pattern is "child manifests don't know about parents at build time". A pack author wanting both manifests imports each builder explicitly.
- **Q4:** Should the registry support pinned versions (e.g., `extends: ["operate-erp/core@1.2.0"]`)?
  - _Current direction:_ Out of scope for M7.6.5. The `extends` field is `string[]` — the slug carries no version. Marketplace versioning is a Phase 3 concern (signed packs with semver ranges).
- **Q5:** Should `buildResolvedPayments()` move into the package's public surface as `buildResolvedErpPaymentsPack()`?
  - _Current direction:_ Test-helper only for now. Promoting it to public API would couple consumers to a default registry shape; better to have consumers call `resolveManifest` themselves with their chosen registry.
