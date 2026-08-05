# ADR-0206: `prune-links` maintenance command (Phase 3 P3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0205 (dangling-link prune sweep), ADR-0087 (operate-server binary), ADR-0203 (JSONB-store associations), ADR-0077 (P3) |

## Context

ADR-0205 shipped `PostgresEntityStore.pruneDanglingLinks(tenant, left, right)` — a per-relation sweep
that removes association links whose endpoints were deleted — but as a bare store capability with no
invoker. It couldn't be run. This adds the operator entry point: an `operate-server prune-links`
subcommand that sweeps every m2m relation for a tenant in one invocation, turning the ADR-0205
capability into something a cron job / admin can actually execute.

## Decision

- **`operate-server prune-links` subcommand** (`apps/operate-server`). The bin dispatches on the first
  argv token: `prune-links` routes to the prune path, anything else stays the default `serve` path
  (backward compatible). `parsePruneArgs` accepts `--pack | --manifest` (exactly one), `--tenant <uuid>`
  (required, shape-validated), `--schema`, `--help`; there is **no `--store`** flag because the sweep is
  JSONB-store-only (the column store's join-table FKs cascade, so it never dangles).
- **`runPruneLinks(options)`** (`node.ts`) loads + resolves the manifest, opens a Postgres connection
  from the standard `PG*` env vars, builds a JSONB `PostgresEntityStore`, and sweeps — closing the
  connection in a `finally`.
- **`link-sweep.ts`** holds the testable core, decoupled from Postgres via a structural
  `DanglingLinkPruner` seam: `relationPairsFromManifest` de-dupes the manifest's m2m relations to one
  canonical `(left, right)` pair each (derived from `manifestAssociationRoutes`, so no new
  `operate-runtime` surface); `sweepDanglingLinks(pruner, pairs, tenant)` prunes each relation and
  aggregates the `{pruned, kept}` counts into a `SweepReport`; `formatSweepReport` renders the
  per-relation + total summary. Because the pruner is structural, the CLI runner and the tests drive the
  exact same orchestration.

## Consequences

- The ADR-0205 sweep is now runnable: `operate-server prune-links --pack erp-retail --tenant <uuid>`
  reconciles that tenant's JSONB association links against its surviving records and prints what it did.
  A scheduled invocation (cron / k8s Job) closes the loop the schemaless link table opened.
- The command is a thin dispatcher over a fully unit-tested core; the only untestable-offline part is
  `runPruneLinks`' real Postgres connection, exactly like `serve()` — the established operate-server
  pattern. `relationPairsFromManifest`, `sweepDanglingLinks`, `formatSweepReport`, and `parsePruneArgs`
  are all covered.
- No new `operate-runtime` API: the relation pairs come from the already-exported
  `manifestAssociationRoutes`, keeping the change confined to `apps/operate-server`.
- 7,074 tests pass (+15: relation-pair derivation incl. self-relation + non-m2m filtering + empty;
  sweep aggregation + empty-no-op; report formatting; `parsePruneArgs` source/tenant/schema parsing +
  required-flag + malformed-tenant + unknown-arg + help validation). Full build + typecheck green.
- Follow-ups: an all-tenants sweep (`--all-tenants` over the DB-backed tenant source, mirroring the
  scheduler); a `--dry-run` that reports without deleting; the set-based `DELETE … WHERE NOT EXISTS`
  scalability variant (ADR-0205).
