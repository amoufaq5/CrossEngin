# ADR-0063: CLI `--pack` apply — the end-to-end loop (Phase 2 M7-wire)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0047 (kernel-pg), ADR-0051 (architect-cli), ADR-0058 (pack-erp-core) |

## Context

M5 shipped `crossengin apply` against the kernel meta-schema. M7 shipped `pack-erp-core` — a real Manifest with entities, workflows, jobs, permissions. Until M7-wire, the two were disconnected: the CLI knew about meta-schema DDL but not pack DDL; the pack package emitted nothing on its own. A developer who wanted ERP tables in Postgres had to write their own glue.

M7-wire closes the loop. **`crossengin apply --pack operate-erp/core` produces a working multi-tenant Postgres schema with the meta-schema + the four ERP entity tables in one command** — the first proper end-to-end demonstration that the substrate solves the problem.

Three constraints shaped the design:

1. **One transaction surface, two SQL sources.** The meta bootstrap DDL (119 tables in the `meta` schema) and the pack entity DDL (4 tables in `public` or operator-chosen schema) must apply atomically. Failing partway through leaves half a schema. The kernel-pg `MigrationApplier` already handles this via advisory-lock + per-statement transactions; the wiring just concatenates statement lists.

2. **Pack resolution stays type-safe + minimal.** The CLI knows about packs via a small registry mapping slug → `() => Manifest`. Today only `operate-erp/core` is registered; future packs (`pack-erp-healthcare`, `pack-erp-retail`) add entries. No dynamic loading — operators can't pass `--pack ./my-custom-pack.json` yet (Phase 3 feature).

3. **The validation gate fires before any DB write.** A pack that fails `tryValidateManifest` aborts at plan-build time, not after the meta-schema has already been applied. Exit 1 with a message naming the failed cross-references.

## Decision

Three small changes — one new module, one rewrite of `apply.ts`, two CLI flags:

### `apps/architect-cli/src/pack-registry.ts` — the registry

```ts
export const PACK_REGISTRY: Readonly<Record<string, PackEntry>> = {
  [ERP_CORE_PACK_SLUG]: {
    slug: ERP_CORE_PACK_SLUG,
    description: "Core ERP entities...",
    build: () => buildErpCorePack(),
  },
};

export function resolvePack(slug: string): PackEntry;
export function listAvailablePacks(): readonly string[];
export class UnknownPackError extends Error { ... }
```

The registry is a const map, not a runtime extension point. New packs appear by importing their `buildXxx()` function from the workspace and adding an entry. Static enough that TypeScript can verify slug coverage at compile time; explicit enough that an operator typing `crossengin apply --pack nonsense` gets a list of what's actually available.

### `apps/architect-cli/src/apply.ts` — plan-build → apply

`runApply` now follows a four-step shape:

1. **Resolve flags.** `--pack <slug>` (optional), `--pack-schema <name>` (default `"public"`), plus existing `--dry-run` / `--confirm` / `--format`.
2. **Build plan.** `buildPlan({packSlug, packSchema})` returns `{metaStatements, packStatements, pack, packSchema}`. If `packSlug === null`, `packStatements = []`. Otherwise: resolve the registry entry, build the manifest, `tryValidateManifest` (throws `PackValidationError` on failure), `emitManifestCreate(manifest, {schema: packSchema})`. Validation errors abort with exit 1; unknown packs abort with exit 2.
3. **Dry-run path.** Stream META statements + a `-- N pack statement(s) ...` separator + pack statements + a closing summary. JSON mode emits `{schema, tableCount, statementCount, metaStatementCount, packStatementCount, pack, availablePacks, statements}`.
4. **Live apply.** Same `MigrationApplier` as before, now with concatenated statement list (`[...meta, ...pack]`). Per-statement hash-skip means re-running with `--pack` only adds the pack tables on top of an existing meta-schema deployment.

### CLI flag wiring

`cli.ts` documents `--pack <slug>` and `--pack-schema <name>` in the help text. No special parser handling — both reuse `getStringFlag`.

## Cross-cutting invariants enforced

- **Validation precedes apply.** `tryValidateManifest` runs in `buildPlan` before any DB connection opens. A pack with bad cross-references can't half-apply.
- **Meta schema comes first.** `[...metaStatements, ...packStatements]` order is fixed. The kernel's meta tables exist before any pack table references can resolve. Topological sort within each section preserves FK ordering.
- **Idempotent re-runs.** `MigrationApplier` hashes each statement and skips ones already applied (via `_meta_migrations`). Re-running `apply --pack X` after a prior `apply` adds only the new pack statements. Re-running with the same pack is a no-op.
- **No dynamic loading.** Pack resolution is static — `PACK_REGISTRY` is a const object. Operators can't load arbitrary pack files; if they want a new pack, the workspace adds a package + a registry entry. This keeps the CLI's attack surface small (no `--pack=/path/to/untrusted.json`).
- **Schema choice is explicit.** `--pack-schema` defaults to `"public"` but operators can override (e.g., `tenant_data` for a separate schema). No magic schema-per-tenant logic — that's a higher-level deployment concern.
- **The dry-run output is reproducible.** Same pack + same schema → same statements every time. Kernel's `topologicalSort` is deterministic; pack manifests are pure data.

## Alternatives considered

- **Make `--pack` accept a file path or a registry slug.**
  - **Pros.** Operators can experiment with custom packs without modifying the CLI.
  - **Cons.** Wider attack surface (file paths could be untrusted), more error paths (file not found, JSON malformed, manifest not validating). For M7-wire, the static registry covers the demonstrated case.
  - **Decision.** Slug-only for M7-wire. Phase 3 marketplace will introduce signed packs with a resolve-from-disk path that goes through the same validator.

- **Auto-discover packs by scanning `packages/pack-*`.**
  - **Considered.** Scan `node_modules/@crossengin/pack-*` at runtime, register each one's `build()` function.
  - **Decision.** Too magical. Explicit registry is small, type-safe, and obvious from grep. When pack count grows past ~10, revisit.

- **Apply meta-schema and pack DDL in separate `MigrationApplier` runs.**
  - **Considered.** Cleaner separation; the meta apply could finish before the pack apply starts.
  - **Decision.** Single combined statement list. Two appliers means two advisory-lock acquisitions, two `_meta_migrations` write points, and a window where meta is partially applied and pack isn't started. One combined run is simpler and atomic per the kernel-pg semantics.

- **Add a `crossengin pack list` / `crossengin pack show <slug>` subcommand.**
  - **Considered.** Inspect available packs without running `apply`.
  - **Decision.** Defer. `apply --dry-run --pack=unknown` already prints the available list via the error. A dedicated subcommand can land in M7.7 if patterns emerge.

- **Allow multiple `--pack` flags (apply N packs in one run).**
  - **Considered.** `--pack=operate-erp/core --pack=operate-erp/payments` for layered packs.
  - **Decision.** Single pack for M7-wire. Multi-pack composition belongs in a manifest `meta.extends` resolver (Phase 3) that builds a single merged Manifest from a parent chain. Once that lands, one `--pack=child` builds the full lineage.

- **Inject per-tenant `tenant_id` + RLS automatically on pack entities.**
  - **Considered.** Pack entities currently use the `auditable` trait, not `tenant_owned`. The kernel recognizes `tenant_owned` but doesn't add column or RLS automatically (built-in trait with empty `fields`).
  - **Decision.** Out of scope for M7-wire. The pack-erp-core entities are demo-quality on this dimension; M7.7 ("pack tenant scoping") can extend the `tenant_owned` trait to inject `tenant_id` + RLS, then update pack-erp-core to use it. M7-wire focuses on the integration plumbing; the entity-shape fix is a separate concern.

## Consequences

- **The end-to-end story works for the first time.** `crossengin init m.json && crossengin validate m.json && crossengin apply --dry-run --pack=operate-erp/core` produces real, applicable SQL covering both the platform substrate and the ERP vertical. Against a real Postgres (PGHOST/PGDATABASE set), `apply --pack=operate-erp/core` materializes 119 meta tables + 4 ERP entity tables atomically.
- **+11 tests (5,896 → 5,907).** 6 in `pack-registry.test.ts` (registry shape invariants, resolvePack happy + unknown paths, listAvailablePacks). 5 in `apply.test.ts` (--dry-run --pack emits ERP DDL, --pack-schema honored, unknown pack exit 2, JSON envelope shape with + without --pack).
- **730 SQL statements produced** (vs M5's 3,061 stmts for the meta schema alone, plus ~600 for the pack: CREATE TABLE × 4, ALTER TABLE for FKs, CREATE INDEX × ~10, all with topologically-correct ordering). Hash-stable: same pack + same schema → identical statement bytes.
- **Pattern set for future packs.** `pack-erp-healthcare`, `pack-erp-retail`, etc. all add a single entry to `PACK_REGISTRY`. The CLI surface doesn't change.
- **Demonstrates the substrate works.** Five years of contract work (Phase 1) + nine months of runtime work (Phase 2 M1-M7) culminate in a working binary that ships a working schema. The next ADR can quote `crossengin apply --pack=operate-erp/core` as the artifact rather than relying on theoretical descriptions.

## Open questions

- **Q1:** Should `--pack` validate against the connected database's existing meta-schema first?
  - _Current direction:_ Not in M7-wire. `MigrationApplier`'s hash-skip handles "already applied" cleanly; a separate pre-check would duplicate that logic. If pack DDL references META tables that aren't there yet, the live apply fails fast with a Postgres error.
- **Q2:** How are pack-side migrations versioned over time? When `pack-erp-core` adds a `Note` entity in v0.2, what happens?
  - _Current direction:_ `MigrationApplier` is hash-keyed; new statements get applied, old ones skip. The pack version bump is informational. Phase 3 marketplace adds explicit pack-version pinning per tenant.
- **Q3:** Does the `--pack-schema` setting persist anywhere?
  - _Current direction:_ Not in M7-wire. Each `apply` call is stateless. The operator's deployment scripts choose the schema. A future `crossengin status` could surface what's applied where, but that needs schema-tracking metadata that doesn't exist yet.
- **Q4:** What about RLS for the pack entities?
  - _Current direction:_ The kernel emits RLS only for entities using the `tenant_owned` trait (which currently injects no fields). Pack-erp-core entities use `auditable`, not `tenant_owned`, so no RLS is emitted. M7.7 fixes this either by adding `tenant_owned` to the entities OR extending the trait's emit semantics. Until then, applying a pack produces tables that work for single-tenant dev but need RLS added before multi-tenant prod use.
- **Q5:** Should the dry-run output be writeable to a file via `--out`?
  - _Current direction:_ Out of scope. Operators can redirect stdout (`crossengin apply --dry-run --pack=X > schema.sql`) — same result without a new flag.
