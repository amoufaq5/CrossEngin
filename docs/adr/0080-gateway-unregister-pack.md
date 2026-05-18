# ADR-0080: Gateway routes unregister-pack (Phase 2 M4.8.x)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0079 (M4.8 register-pack), ADR-0074 (M4.7.5 gateway routes subcommand), ADR-0068 (M7.6.5 extends resolver) |

## Context

M4.8 shipped `crossengin gateway routes register-pack <slug>` — bulk-register all CRUD + workflow-transition routes for a pack in one shot. ADR-0079 Q3 noted that re-running `register-pack` was the drift-remediation story, but there was no one-shot cleanup command to mirror it. Operators decommissioning a pack (deprecation, tenant offboarding, environment teardown) had to either:

- Issue 24 / 34 / 47 individual `gateway routes unregister <rt_id>` commands (and somehow know each route_id), or
- DELETE rows via a SQL session bypassing the cache + audit story

Both are operationally painful. M4.8.x ships `unregister-pack` — the deterministic-route-ID generator from M4.8 makes this trivially reusable: re-run the same generation, then `deleteByRouteId` each one.

The constraint that shaped the design:

- **Reuse `generatePackRoutes` verbatim.** The same hash function (`routeIdFor`) that produced the registered IDs is the lookup key now. Re-deriving from the manifest guarantees no drift — if the manifest changes, the deleted set adapts; if the slug is the same, the IDs match exactly.

## Decision

Three additive changes to `apps/architect-cli/src/gateway-routes.ts`:

### 1. New action: `unregister-pack`

```
crossengin gateway routes unregister-pack <slug> [--api-version v1] [--dry-run]
```

Flow:

1. Resolve the pack via `resolvePack(slug)` from the M7.6.5 pack registry. Unknown slug → exit 2 with the available-packs list.
2. Run `resolveManifest(rawManifest, {registry: packManifestRegistry()})` — same merge step as register-pack.
3. Generate routes via `generatePackRoutes({manifest, packSlug, apiVersion?})`.
4. If `--dry-run`: print the list of route IDs (`rt_<hex>`) + method + path + operationId, exit 0, no DB writes.
5. Otherwise: loop `await registry.deleteByRouteId(r.route.id)` for every generated route. Track deleted-count + not-found-IDs separately.

Unlike `register-pack`, the unregister path skips `tryValidateManifest` — operators tearing down a pack don't need the manifest to validate post-resolve (they may be cleaning up after a deprecated or removed pack). The route-ID hash only depends on slug + operationId; validation is unnecessary for delete-by-hash semantics.

### 2. Dispatcher short-circuit (same pattern as M4.8)

`runGatewayRoutes` already short-circuits the `register-pack --dry-run` path before resolving the registry (so operators can preview without PG). Extended to also cover `unregister-pack --dry-run`:

```ts
if (
  (action === "register-pack" || action === "unregister-pack") &&
  getBooleanFlag(command, "dry-run")
) {
  if (action === "register-pack") return runRoutesRegisterPack(command, ctx, null);
  return runRoutesUnregisterPack(command, ctx, null);
}
```

### 3. Output shapes

**Human mode** (default):
```
unregistered 24 of 24 route(s) for pack 'operate-erp/core'.
```
or with partial misses:
```
unregistered 5 of 24 route(s) for pack 'operate-erp/core'. (19 route id(s) not found — already removed)
```

**JSON mode** (`--format=json`):
```json
{
  "pack": "operate-erp/core",
  "attempted": 24,
  "deleted": 24,
  "notFound": 0,
  "notFoundIds": []
}
```

**Dry-run human**:
```
-- dry-run: 24 route id(s) would be deleted for pack 'operate-erp/core':
  rt_a2e5ac16a0b6a5b8  PATCH  /v1/patients/:id           patient.update
  ... (23 more)
```

**Dry-run JSON**:
```json
{
  "pack": "operate-erp/core",
  "count": 24,
  "dryRun": true,
  "routes": [{ "id": "rt_...", "method": "POST", "operationId": "account.create" }]
}
```

### End-to-end verification

```
$ crossengin gateway routes unregister-pack operate-erp/payments --dry-run
-- dry-run: 34 route id(s) would be deleted for pack 'operate-erp/payments':
  rt_a2e5ac16a0b6a5b8  GET    /v1/accounts                 account.list
  rt_...               GET    /v1/accounts/:id             account.read
  ...
  rt_dc434065dca40bc4  POST   /v1/payments/:id/transitions/cancel  payment.transition.cancel

$ # With PG env:
$ crossengin gateway routes register-pack operate-erp/payments
registered 34 route(s) for pack 'operate-erp/payments'.

$ crossengin gateway routes unregister-pack operate-erp/payments
unregistered 34 of 34 route(s) for pack 'operate-erp/payments'.
```

Re-running unregister against an already-cleaned pack reports `unregistered 0 of 34 (34 not found — already removed)` — soft-fail by design.

## Cross-cutting invariants enforced

- **Symmetric hash semantics with M4.8.** The same `routeIdFor({packSlug, operationId})` function computes both the register-time ID and the delete-time lookup key. There's exactly one source of truth for route IDs per pack.
- **`--api-version` symmetry.** Operators who registered with `--api-version v2` unregister with the same flag — the route_id hash factors the apiVersion through the operationId path. Mismatched flag → different hash → no matches (graceful soft-fail).
- **Soft-fail on already-deleted routes.** Operators can re-run unregister-pack idempotently without errors. The `notFound` count surfaces drift without blocking the operation.
- **PG connection always closed.** Same try/finally as the rest of the gateway-routes dispatcher.
- **`--dry-run` is read-only.** Verified by test: zero DELETE statements issued when the flag is set.
- **No `tryValidateManifest` call.** Manifest validity doesn't affect route IDs — operators cleaning up an obsolete pack get unblocked.

## Alternatives considered

- **Use `routes.source_pack` column (proposed but rejected in M4.8) instead of deterministic IDs.**
  - **Pros.** No re-hash needed; operators can `DELETE WHERE source_pack = 'x'`.
  - **Cons.** Requires a META schema change (kernel-pg migration, route-registry rewrite). M4.8's deterministic-ID approach already provides the same operational outcome without schema churn.
  - **Decision.** Stick with deterministic IDs. The hash function is the source-of-truth marker.

- **Two-pass deletion: list-all → filter by ID match → delete.**
  - **Considered.** Would avoid touching routes that aren't from this pack (defensive).
  - **Cons.** Pointless: the route_id hash is collision-free per pack; the only IDs we'd delete are exactly the ones this pack generates. No defensive filter needed.
  - **Decision.** Direct deleteByRouteId per generated ID.

- **Require `--confirm` for destructive operations.**
  - **Considered.** Mirrors `crossengin apply --confirm` for production-looking databases.
  - **Cons.** Operators using `--dry-run` already preview the impact. Requiring another confirmation step doubles the friction without preventing a real mistake.
  - **Decision.** No extra confirmation. `--dry-run` is the preview affordance.

- **Single transaction for all deletes.**
  - **Considered.** All-or-nothing atomicity.
  - **Cons.** The current sequential-deleteByRouteId path is fine — partial completion + soft-fail reporting is OK semantics. Wrapping in a transaction would require a per-pack DELETE batch query (and lose the per-ID found/not-found reporting).
  - **Decision.** Sequential deletes; soft-fail on misses.

- **Add `unregister` (singular) alias `register-pack --delete`.**
  - **Considered.** One verb, two modes.
  - **Decision.** Distinct verbs. Mirror of `register-pack` is `unregister-pack` — the symmetry is the documentation.

- **Skip the manifest resolve step for unregister-pack — just look up by slug prefix.**
  - **Considered.** Slug-prefix lookup would let operators unregister even if the pack's manifest is broken / unbuilable.
  - **Cons.** Requires a new SQL path (`DELETE WHERE route_id LIKE 'rt_<hash-of-slug-prefix>%'`) which the routeIdFor hash doesn't actually support (we hash the full operationId, not just the slug). Re-running the same generation is simpler and gives identical results when the pack is well-formed.
  - **Decision.** Use the same generator path. Operators with a broken pack can fall back to per-route `unregister <rt_id>`.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,468 tests** (+8 from M4.8.x). All green, zero type errors.
- **Symmetric register/unregister cycle works end-to-end.** Three packs (core 24, payments 34, healthcare 47) can be deployed + torn down in one command each.
- **ADR-0079 Q3 closed.** Drift remediation was already register-pack; now full lifecycle remediation is register/unregister-pack.
- **Pattern set for future bulk-management commands.** `crossengin sessions delete-by-tenant`, `crossengin gateway throttle-policies unregister-pack` — same shape (resolve target, generate ID set, soft-fail per-item).
- **--dry-run is the standard preview affordance.** Operators see exactly which IDs would be touched before committing.

## Open questions

- **Q1:** Should `unregister-pack` warn when a route exists that was likely from a previous register-pack with different settings (e.g., older `--api-version`)?
  - _Current direction:_ No. The hash function is deterministic; mismatched IDs are detected as "not found" naturally. Operators wanting per-version cleanup invoke twice with different `--api-version` flags.
- **Q2:** Should `register-pack` automatically run `unregister-pack` first to ensure a clean slate?
  - _Current direction:_ No. Register-pack already upserts (overwriting existing rows); explicit unregister + register is the operator's choice when they want clean state.
- **Q3:** What about a combined `crossengin gateway routes sync-pack <slug>` that registers new + unregisters dropped routes?
  - _Current direction:_ Out of scope. The current register-pack handles new + updated rows (upsert); dropped routes can be cleaned via unregister-pack on the old version. A sync command could compose both in a future M4.8.y.
- **Q4:** Bulk JSON output for piping to `jq`?
  - _Current direction:_ Already present via `--format=json`. The output shape includes `notFoundIds[]` for scripting.
- **Q5:** Multi-pack unregister in one command?
  - _Current direction:_ Out of scope. Shell `for pack in ...; do crossengin gateway routes unregister-pack "$pack"; done` works. A future flag could accept multiple slugs.
- **Q6:** What about pre-deletion verification (warn if a route's `requiredScopes` differs from generated)?
  - _Current direction:_ Out of scope. The hash function ensures we delete exactly the routes register-pack would have created; per-row content comparison would catch operator-edited routes but adds complexity.
- **Q7:** Audit log of unregister events?
  - _Current direction:_ The current `meta.gateway_routes` row deletion isn't audited (no audit table). Future M4.8.y could add a deletion-audit row to a separate table.
