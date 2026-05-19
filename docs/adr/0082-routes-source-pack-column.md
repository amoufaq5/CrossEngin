# ADR-0082: routes.source_pack column (Phase 2 M4.10)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0081 (M4.8.y sync-pack), ADR-0080 (M4.8.x unregister-pack), ADR-0079 (M4.8 register-pack), ADR-0074 (M4.7.5 gateway routes subcommand) |

## Context

ADR-0079 Q3, ADR-0080 Q3, and ADR-0081 Q3/Q6 all converge on the same missing piece: there's no authoritative way to tell which routes came from which pack. M4.8/M4.8.x rely on the deterministic-ID hash (`sha256("<slug>:<operationId>").slice(0, 16)`), which works perfectly while the manifest is unchanged but degrades when:

- An entity is removed from the manifest → the route_id changes but the old route still sits in the table. `register-pack` doesn't see it (it only upserts what's in the current generation); `unregister-pack` doesn't see it either (it deletes what the CURRENT generation hashes to). M4.8.y `sync-pack` exposed this as the "external" bucket — but it conflated "from THIS pack's previous version" with "from a DIFFERENT pack" with "operator-curated via `register <route.json>`", making safe deletion impossible.

- An operator inherits a database from another team and wants to know "which routes belong to which pack?" without manually mapping route IDs to slug:operationId pairs.

- A future audit / source-tracking story needs to filter rows by their originating pack without re-running the route generator for every pack.

The simplest fix is also the right one: store the slug on the row. This is a single nullable TEXT column with a slug-pattern check + an index.

## Decision

Six coordinated changes across the kernel, the gateway contracts, the gateway-pg adapter, the pack-route generator, the sync-pack CLI handler, and the test fixtures.

### 1. Kernel meta-schema

`META_GATEWAY_ROUTES` gains:

```ts
{
  name: "source_pack",
  type: "TEXT",
  check: "source_pack IS NULL OR source_pack ~ '^[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)*$'",
}
```

plus a matching index `idx_gateway_routes_source_pack`. The column is nullable — pre-M4.10 rows + operator-curated routes registered via `gateway routes register <route.json>` legitimately have no associated pack. The slug check matches the format used by the pack registry (`<family>/<name>` with kebab-case segments).

### 2. RouteDefinitionSchema

`@crossengin/api-gateway`'s `RouteDefinitionSchema` gains:

```ts
sourcePack: z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/)
  .max(120)
  .nullable()
  .default(null),
```

Default `null` so the field is optional in INPUT (operators registering a hand-curated route via JSON file don't need to specify it) but always present in OUTPUT (downstream code can rely on the field being there).

### 3. PostgresRouteRegistry

Five changes:

- `RouteRow` gains `source_pack: string | null`.
- `rowToRoute` maps it to `sourcePack`.
- `upsert` adds `source_pack` to the column list, becomes a 16-param INSERT (was 15); `EXCLUDED.source_pack` flows in the ON CONFLICT update clause.
- All three SELECT call sites (`listAll`, `loadCompiled`, the new `listByPackSlug`) factor through a shared `SELECT_COLUMNS` constant for consistency.
- Two new methods: `listByPackSlug(packSlug): Promise<readonly RouteDefinition[]>` and `deleteByPackSlug(packSlug): Promise<number>` (returns rows affected; invalidates the cache).

### 4. generatePackRoutes

Both `buildCrudRoute` and `buildTransitionRoute` set `sourcePack: input.packSlug` on every generated `RouteDefinition`. The slug flows from the CLI `runRoutesRegisterPack` / `runRoutesSyncPack` handlers into the generator and onto every row.

### 5. sync-pack obsolete vs external

The diff classification in `runRoutesSyncPack` now produces FOUR buckets instead of three:

```ts
const added = records.filter((r) => !storedIds.has(r.route.id));
const persistent = records.filter((r) => storedIds.has(r.route.id));
const obsolete = stored.filter(
  (r) => r.sourcePack === slug && !generatedIds.has(r.id),
);
const external = stored.filter(
  (r) => r.sourcePack !== slug && !generatedIds.has(r.id),
);
```

- **added** — in generated, not in stored. Will be inserted.
- **persistent** — in both. Will be refreshed (upsert with current content).
- **obsolete** — stored with `sourcePack === slug` AND ID not in current generation. Means: "this pack registered this route in a previous generation, but the manifest has dropped it." SAFE to delete with operator opt-in via `--prune-obsolete`.
- **external** — stored with `sourcePack !== slug` (different pack OR null). NOT touched by sync-pack regardless of flags.

New flag `--prune-obsolete`: when set, sync-pack issues a `deleteByRouteId` per obsolete route after upserting the generated set. Reports `pruned` count separately so partial misses surface.

### 6. JSON output shape

```json
{
  "pack": "operate-erp/core",
  "dryRun": false,
  "pruneObsolete": true,
  "total": 24,
  "added": 0,
  "persistent": 24,
  "obsolete": 2,
  "obsoleteIds": ["rt_obsolete1abc1234", "rt_obsolete2def5678"],
  "pruned": 2,
  "external": 1,
  "externalIds": ["rt_legacycabc1234"]
}
```

Backwards compatibility: the keys from M4.8.y (`added`, `persistent`, `external`, `externalIds`, `total`, `dryRun`) are unchanged. New keys (`obsolete`, `obsoleteIds`, `pruneObsolete`, `pruned`) are additive. Consumers parsing M4.8.y output continue to work; new code can opt into the richer shape.

### Human output

```
synced 24 route(s) for pack 'operate-erp/core' (0 added, 24 refreshed, 2 obsolete — left alone (use --prune-obsolete to delete), 1 external — left alone).
obsolete route id(s) (from this pack, no longer generated):
  rt_obsolete1abc1234
  rt_obsolete2def5678
external route id(s) (not part of 'operate-erp/core'):
  rt_legacycabc1234
```

With `--prune-obsolete`:
```
synced 24 route(s) for pack 'operate-erp/core' (0 added, 24 refreshed, 2 of 2 obsolete pruned, 1 external — left alone).
external route id(s) (not part of 'operate-erp/core'):
  rt_legacycabc1234
```

## Cross-cutting invariants enforced

- **`sourcePack` is set by generatePackRoutes; never by operators.** Operators using `gateway routes register <route.json>` MAY include `sourcePack` in their JSON, but the schema default of `null` makes the field optional. Most operator-curated routes will have null.
- **`unregister-pack` is unchanged.** It still uses deterministic-ID lookup (`deleteByRouteId(routeIdFor(...))`) — that path is symmetric with register-pack and doesn't need source_pack to work. The future could add a `unregister-pack --by-source-pack` flag using `deleteByPackSlug` for one-shot cleanup, but the M4.10 scope keeps unregister-pack stable.
- **Cache invalidation on deleteByPackSlug.** Same pattern as `deleteByRouteId` — the registry cache is invalidated so subsequent `lookup` calls re-read.
- **Slug regex is enforced at three layers.** The DB CHECK constraint, the zod schema, and the slug already validates upstream in the pack registry. Defense in depth.
- **--prune-obsolete works in --dry-run mode.** Reports what WOULD be deleted; issues zero DELETE statements. Operators can preview before destructive runs.
- **External routes are NEVER deleted.** Same guarantee as M4.8.y, just more precisely scoped now that obsolete is its own bucket.

## Migration story

For existing deployments:

1. Run `crossengin apply` (or `crossengin-pg apply`) — picks up the new column + index via `kernel-pg`'s migration applier. Existing rows have `source_pack: NULL`.
2. Optionally backfill: `crossengin gateway routes register-pack <slug>` re-upserts the routes that pack would have generated. The ON CONFLICT DO UPDATE clause now writes the new `source_pack` column, so previously-NULL rows for this pack get backfilled.
3. Or accept the null state — sync-pack treats NULL as "external" which is the safe default (no auto-deletion).

The migration is non-breaking: pre-M4.10 code constructing `RouteDefinition` objects without `sourcePack` will fail TypeScript compilation against the new schema, but at runtime the database happily accepts NULL. The test suite update adds `sourcePack: null` to every fixture (11 sites across 9 files).

## Alternatives considered

- **Keep deterministic IDs, no schema change; encode pack lineage IN the ID hash.**
  - **Considered.** Could embed pack-version metadata in the hash, e.g. `sha256("<slug>:<version>:<operationId>")`. But then changing the version invalidates every ID, breaking the M4.8.x deletion path. And operators can't query "all routes for a slug" without a full table scan + hash comparison.
  - **Decision.** Schema column is cleaner. The hash stays content-addressed; source_pack is metadata.

- **One source_pack column AND one source_pack_version column.**
  - **Considered.** Track which manifest version registered each route, enabling "rollback this pack to v1.2.3."
  - **Cons.** Manifest versions are still TBD as a first-class concept; M4.10's scope is the "which pack" question. Version tracking is M4.11+ territory.
  - **Decision.** One column for now. Version tracking is an additive future ADR.

- **Compound source_pack JSON like `{slug: "operate-erp/core", apiVersion: "v1"}`.**
  - **Considered.** Captures the (slug, version) tuple in one column.
  - **Cons.** Loses the SQL-level filtering (`WHERE source_pack = 'x'`) that's natural with TEXT + index. Querying JSONB for slug works but adds operator complexity.
  - **Decision.** Plain TEXT slug. apiVersion is already on the route row.

- **Make source_pack NOT NULL with a sentinel like `'__operator__'` for hand-curated routes.**
  - **Considered.** Cleaner schema; sync-pack's "external" bucket becomes "different slug."
  - **Cons.** Breaks backwards compat with pre-M4.10 rows. And the sentinel is an arbitrary string — operators might pick conflicting values.
  - **Decision.** Nullable. NULL means "no pack attribution."

- **Add a separate `gateway_route_attributions` join table.**
  - **Considered.** Normalizes the relationship; one route could theoretically be attributed to multiple packs.
  - **Cons.** Massively overcomplicates the simple case (every route has at most one source pack). The 1:1 relationship is fine as a column.
  - **Decision.** Column on the routes table.

- **Use `gateway routes register-pack` to ALWAYS unregister obsolete routes (no opt-in).**
  - **Considered.** Eliminates the obsolete bucket — register-pack reconciles automatically.
  - **Cons.** register-pack's documented semantics in M4.8 are additive (upsert-only). Adding deletion makes it surprising for operators who run it incrementally. sync-pack's `--prune-obsolete` is explicit + opt-in.
  - **Decision.** register-pack stays additive. sync-pack is the reconcile verb.

- **Auto-prune obsolete by default in sync-pack.**
  - **Considered.** Operators want sync-pack to "make the DB match the manifest."
  - **Cons.** A typo in `--api-version` would silently nuke the v1 route set when re-syncing for v2. Opt-in via `--prune-obsolete` makes the destruction explicit.
  - **Decision.** Opt-in.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,496 tests** (+16 from M4.10). All green, zero type errors.
- **Three open questions closed at once.** ADR-0079 Q3, ADR-0080 Q3, ADR-0081 Q3/Q6 all answered by the same column.
- **sync-pack is finally safe to use as a deploy step.** Pre-M4.10, operators feared "external" might include routes they didn't realize were owned by a different pack. Post-M4.10, the obsolete/external split makes ownership explicit and pruning safe.
- **listByPackSlug + deleteByPackSlug unlock future commands.** `gateway routes unregister-pack --by-source-pack <slug>` becomes a one-line addition (deferred to M4.10.x if demand surfaces). Bulk migration tooling (move routes from one pack to another) is also unlocked.
- **Pattern set for future "which subsystem owns this row?" questions.** Future tables that need source-attribution can adopt the same `source_<thing>` TEXT + check pattern.
- **Operator workflow improves.** Instead of running register-pack + unregister-pack-of-old-version + register-pack-of-new-version, a manifest upgrade is now `sync-pack <slug> --prune-obsolete`.

## Open questions

- **Q1:** Should we backfill the source_pack column for existing routes during the migration?
  - _Current direction:_ No automatic backfill. Operators run `register-pack <slug>` for each pack to populate. Tools can be built later if mass backfill is needed.
- **Q2:** Should `register <route.json>` reject non-null sourcePack values that don't match a registered pack slug?
  - _Current direction:_ No validation against the pack registry — operators can register routes "owned" by future packs. The DB check constraint enforces format only.
- **Q3:** Should `unregister-pack` get a `--by-source-pack` mode that uses `deleteByPackSlug` instead of deterministic-ID re-derivation?
  - _Current direction:_ Defer to M4.10.x if needed. The deterministic-ID path still works perfectly when the manifest is recoverable; the `--by-source-pack` mode is only needed when the manifest is broken or missing.
- **Q4:** Should sync-pack's `--prune-obsolete` ALSO prune NULL-source-pack routes that happen to have IDs matching the regenerator's hash space?
  - _Current direction:_ No. NULL means "no pack attribution"; we never assume those are obsolete versions of this pack.
- **Q5:** Multi-tenant per-pack source attribution (a future tenant_id column on routes)?
  - _Current direction:_ Out of scope. Routes table is platform-wide. Per-tenant route override is M4.9+.
- **Q6:** What about a `source_manifest_hash` column to detect manifest drift below the slug granularity?
  - _Current direction:_ Out of scope. The hash function already encodes operationId + slug; manifest-hash tracking is future M4.10.x.
