# ADR-0081: Gateway routes sync-pack (Phase 2 M4.8.y)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0080 (M4.8.x unregister-pack), ADR-0079 (M4.8 register-pack), ADR-0074 (M4.7.5 gateway routes subcommand), ADR-0068 (M7.6.5 extends resolver) |

## Context

M4.8 + M4.8.x ship a symmetric pair: `gateway routes register-pack <slug>` upserts every route a pack would generate; `gateway routes unregister-pack <slug>` deletes every route a pack's deterministic-ID hash would produce. Both invocations regenerate the route set from the pack manifest and either upsert or delete by row.

ADR-0080 Q3 noted the missing third command: a composite `sync-pack` that brings the stored set in line with the current generation. Operationally this answers questions like:

- "I edited the manifest. Which routes changed? Which got added? Which got dropped?"
- "After a pack version bump, is the stored set out of sync?"
- "Can I run this on a CI deploy step and trust it to be idempotent?"

M4.8.y ships `gateway routes sync-pack` — re-generate the desired set, diff against the stored set, upsert every generated route, report which stored routes are NOT part of this pack ("external").

The two design constraints:

- **Reuse `generatePackRoutes` + `routeIdFor` verbatim.** Same hash function as M4.8 / M4.8.x. The diff is purely a set operation over route IDs.
- **Don't delete external routes silently.** Without a `source_pack` column or a previous-manifest snapshot, we can't reliably distinguish "an old version of THIS pack" from "a route registered by a different pack" or "a hand-curated route." So sync-pack DOES NOT delete the external set — it reports it and lets the operator decide.

## Decision

One additive change to `apps/architect-cli/src/gateway-routes.ts` + matching CLI help + a new test block + this ADR.

### 1. New action: `sync-pack`

```
crossengin gateway routes sync-pack <slug> [--api-version v1] [--dry-run] [--created-by <uuid>]
```

Flow:

1. Resolve the pack via `resolvePack(slug)` from the M7.6.5 pack registry. Unknown slug → exit 2 with the available-packs list.
2. Run `resolveManifest(rawManifest, {registry: packManifestRegistry()})` — same merge step as register-pack.
3. Run `tryValidateManifest(resolvedManifest)` — same as register-pack (sync is an authoring tool; validation should pass).
4. Generate routes via `generatePackRoutes({manifest, packSlug, apiVersion?})`.
5. Call `registry.listAll()` to load the stored route set.
6. Compute three sets via Set operations on route IDs:
   - `added` = generated routes whose ID is NOT in stored
   - `persistent` = generated routes whose ID IS in stored (will be refreshed via upsert)
   - `external` = stored routes whose ID is NOT in generated (these are NOT touched)
7. If `--dry-run`: print the diff classification, exit 0, no DB writes.
8. Otherwise: loop `await registry.upsert(r.route, createdBy)` for every generated route (both `added` and `persistent`). Then print the summary.

### 2. Dispatcher: sync-pack ALWAYS needs PG

Unlike register-pack and unregister-pack, sync-pack cannot short-circuit the `--dry-run` path before resolving the registry — even in dry-run mode, sync-pack needs `registry.listAll()` to compute the diff. The dispatcher comment now reads:

```ts
// register-pack / unregister-pack --dry-run paths don't need PG. Short-circuit
// before resolving the registry so operators can preview routes without a DB.
// sync-pack ALWAYS needs PG (even --dry-run reads the stored set for the diff).
```

This is intentional: sync-pack is a diff tool, and a diff needs both sides.

### 3. Output shapes

**Human mode** (default):
```
synced 24 route(s) for pack 'operate-erp/core' (24 added, 0 refreshed).
```
or with persistent + external:
```
synced 24 route(s) for pack 'operate-erp/core' (0 added, 24 refreshed, 3 external — left alone).
external route id(s) (not part of 'operate-erp/core'):
  rt_a1b2c3d4e5f6g7h8
  rt_b2c3d4e5f6g7h8i9
  rt_c3d4e5f6g7h8i9j0
```

**JSON mode** (`--format=json`):
```json
{
  "pack": "operate-erp/core",
  "dryRun": false,
  "total": 24,
  "added": 0,
  "persistent": 24,
  "external": 3,
  "externalIds": ["rt_a1b2c3d4e5f6g7h8", "rt_b2c3d4e5f6g7h8i9", "rt_c3d4e5f6g7h8i9j0"]
}
```

**Dry-run human**:
```
-- dry-run: pack 'operate-erp/core' would sync 24 route(s) (12 added, 12 refreshed, 1 external — left alone).
added:
  rt_aaaaaaaaaaaaaaaa  GET    /v1/accounts                 account.list
  ... (11 more)
refreshed:
  rt_bbbbbbbbbbbbbbbb  POST   /v1/invoices                 invoice.create
  ... (11 more)
external (not part of this pack, left alone):
  rt_externaleeeeeeee  GET    /v1/other                    other.foo
```

**Dry-run JSON**: same shape as the live JSON, with `dryRun: true`.

### End-to-end semantic

```
$ crossengin gateway routes sync-pack operate-erp/core
synced 24 route(s) for pack 'operate-erp/core' (24 added, 0 refreshed).

$ crossengin gateway routes sync-pack operate-erp/core
synced 24 route(s) for pack 'operate-erp/core' (0 added, 24 refreshed).

$ crossengin gateway routes register operate-curated.json  # operator-curated route
$ crossengin gateway routes sync-pack operate-erp/core
synced 24 route(s) for pack 'operate-erp/core' (0 added, 24 refreshed, 1 external — left alone).
external route id(s) (not part of 'operate-erp/core'):
  rt_curatedrouteeeee
```

The operator-curated route is untouched. To delete it, the operator either uses `gateway routes unregister <rt_id>` for that specific row, or `gateway routes unregister-pack <other-slug>` if they know which other pack owns it.

## Cross-cutting invariants enforced

- **Same hash semantics as M4.8 + M4.8.x.** Same `routeIdFor({packSlug, operationId})` produces the diff keys.
- **`--api-version` symmetry.** Operators who registered with `--api-version v2` sync with the same flag. Mismatched flag produces a different generated set; the previously-registered v2 IDs become "external" in a v1 sync (and vice versa).
- **`--dry-run` is read-only.** Verified by test: zero INSERT statements issued when the flag is set, but `registry.listAll()` still runs.
- **Idempotent.** Second invocation against an unchanged manifest reports `0 added, N refreshed, 0 external` and writes N upserts (which are no-ops in content but bump the `updated_at` timestamp).
- **PG connection always closed.** Same try/finally as the rest of the gateway-routes dispatcher.
- **External routes are NOT deleted.** sync-pack reports them and exits 0. Operators must explicitly choose to clean them up.
- **`tryValidateManifest` runs post-resolve.** Operators using sync-pack are in active authoring mode; an invalid manifest should fail fast, like register-pack.

## Alternatives considered

- **Delete external routes by default.**
  - **Pros.** Simpler mental model: "sync makes stored match generated."
  - **Cons.** Without a `source_pack` column we can't know if an external route is from a previous version of THIS pack, from a different pack, or from operator-curated routes registered via `register <route.json>`. Silent deletion would be operationally dangerous.
  - **Decision.** Report external. Operators must opt in to cleanup via explicit `unregister` / `unregister-pack`.

- **Add `--prune-external` flag for opt-in deletion.**
  - **Considered.** Operators who know the stored set is owned entirely by one pack could opt into deletion.
  - **Cons.** Still ambiguous: "this pack only" assumes a single-pack deployment; the moment a second pack registers, the flag's semantics become subtly wrong.
  - **Decision.** Out of scope. Future M4.8.z could add it if a clear single-pack use case emerges.

- **Add a `routes.source_pack` column to the META schema.**
  - **Considered.** Would make external-vs-internal classification authoritative.
  - **Cons.** Kernel meta-schema change + migration + route-registry rewrite + backfill story for existing rows. M4.8.x's deterministic-ID approach already provides the same operational outcome for the common case.
  - **Decision.** Out of scope. Revisit if multi-pack sync becomes a recurring operational pain point.

- **Diff at the `requiredScopes` / `idempotencyRequired` level instead of just by ID.**
  - **Considered.** Could detect "this route exists but its scopes changed."
  - **Cons.** The upsert already writes the new scopes — a content diff would inform the human-readable output but doesn't change semantics. Adds complexity without operational value (the upsert is the source of truth).
  - **Decision.** ID-only diff. The upsert handles content reconciliation.

- **Single transaction for all upserts.**
  - **Considered.** All-or-nothing atomicity.
  - **Cons.** Same trade-off as M4.8.x: sequential upserts + per-row error surfacing is simpler. The upserts are idempotent individually.
  - **Decision.** Sequential upserts.

- **Make sync-pack a flag on register-pack (`register-pack --sync`).**
  - **Considered.** Reduces verb count.
  - **Cons.** sync has fundamentally different semantics (it reads the stored set; register-pack doesn't). Distinct verbs document the difference cleanly.
  - **Decision.** Distinct verb. `register-pack` + `unregister-pack` + `sync-pack` form a coherent vocabulary.

- **Support multiple slugs in one invocation.**
  - **Considered.** `sync-pack core payments healthcare`.
  - **Cons.** External classification becomes ambiguous across packs — a route in pack B is "external" from pack A's perspective and vice versa. Single-slug semantics are simpler.
  - **Decision.** One slug per invocation. Shell composition (`for s in ...; do sync-pack "$s"; done`) handles bulk.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,480 tests** (+12 from M4.8.y). All green, zero type errors.
- **Three-verb vocabulary complete.** `register-pack` (add new), `unregister-pack` (remove), `sync-pack` (reconcile). Operators have one verb per intent.
- **CI-grade idempotency.** `sync-pack <slug>` can be re-run on every deploy without surprises — same generated set produces same upsert behavior; external routes are surfaced not silently mutated.
- **External-route reporting is the on-ramp to schema-level source tracking.** When operators consistently see "X external routes" across packs, that's the signal to invest in a `source_pack` column (future M4.8.z).
- **--dry-run with PG required is documented + tested.** A small departure from M4.8/M4.8.x where --dry-run was PG-free; the diff semantics necessitate it.

## Open questions

- **Q1:** Should sync-pack support `--strict-external` that fails (exit 1) when external routes exist?
  - _Current direction:_ Out of scope. Operators wanting a strict gate parse the JSON output (`.external`) and fail in shell.
- **Q2:** Should sync-pack also report routes whose content changed (same ID, different scopes/method)?
  - _Current direction:_ Out of scope. The upsert reconciles content; surfacing per-row diffs adds complexity. Future M4.8.z could add a `--verbose-diff` flag.
- **Q3:** What about a `--prune-by-slug-prefix` flag that deletes external routes whose ID hash matches the slug's expected prefix?
  - _Current direction:_ The hash function doesn't actually produce a slug-recoverable prefix (the hash mixes slug + operationId); this would require a `source_pack` column.
- **Q4:** Should sync-pack emit per-route audit events to a future audit table?
  - _Current direction:_ Same as M4.8 / M4.8.x — no audit-row writes today. Future audit-table package would slot in here.
- **Q5:** Multi-tenant sync (current command is platform-wide; routes table has no tenant_id today)?
  - _Current direction:_ Out of scope. The route registry is platform-wide. Per-tenant route override is a future M4.9+.
- **Q6:** Should sync-pack accept an explicit manifest file (`--manifest path.json`) instead of always resolving from the pack registry?
  - _Current direction:_ Out of scope. The pack registry is the source of truth for pack-shaped manifests. Operators with custom routes use `register <route.json>` directly.
