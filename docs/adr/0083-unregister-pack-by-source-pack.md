# ADR-0083: unregister-pack --by-source-pack (Phase 2 M4.10.x)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0082 (M4.10 source_pack column), ADR-0080 (M4.8.x unregister-pack), ADR-0079 (M4.8 register-pack), ADR-0081 (M4.8.y sync-pack) |

## Context

M4.8.x's `unregister-pack` relies on the manifest pipeline (`resolvePack` → `resolveManifest` → `generatePackRoutes`) to derive the deterministic IDs to delete. This works perfectly when the manifest is recoverable and the pack is registered, but breaks down in three real operational scenarios:

1. **Decommissioned pack.** Operator wants to remove all routes from `operate-erp/old-deprecated-thing`. The pack is no longer in the CLI's `PACK_REGISTRY`. `resolvePack(slug)` throws `UnknownPackError`; exit 2.

2. **Broken manifest.** Pack still exists in the registry but `tryValidateManifest` fails on the resolved manifest (downstream change, transitive parent removal, etc.). M4.8.x skips validation, but `resolveManifest` can still throw on `ExtendsCycleError` / `UnknownParentManifestError`. Operator can't unregister until they fix the manifest.

3. **Forgotten old version.** A pack used to generate routes A, B, C. Manifest changed; current generation produces D, E, F. M4.8.x `unregister-pack <slug>` deletes D, E, F (the current generated set) — leaves A, B, C orphaned. Operator wanted "delete everything from this pack."

ADR-0082 Q3 noted the gap: with the new `source_pack` column, we can issue a single `DELETE WHERE source_pack = $1` that doesn't depend on the manifest. M4.10's `deleteByPackSlug` API made the registry layer ready; M4.10.x exposes it on the CLI.

The design constraint:

- **Don't break the existing M4.8.x semantics.** Operators relying on the deterministic-ID path (precise control, dry-run preview of generated IDs, --api-version sensitivity) shouldn't see any behavior change.

So `--by-source-pack` is opt-in, not the default.

## Decision

Five coordinated changes to `apps/architect-cli/src/gateway-routes.ts` + matching CLI help + tests + this ADR.

### 1. New `--by-source-pack` flag on `unregister-pack`

```
crossengin gateway routes unregister-pack <slug> [--api-version v1] [--dry-run] [--by-source-pack]
```

When set, the entire manifest pipeline is skipped:

```ts
if (bySourcePack) {
  if (!PACK_SLUG_REGEX.test(slug)) {
    printError(ctx.io, "invalid slug format...");
    return 2;
  }
  return runUnregisterPackBySourcePack(command, ctx, registry, slug);
}
// existing manifest-driven path
```

The flag deletes by stored attribution, not by re-derived hash. No `resolvePack`, no `resolveManifest`, no `tryValidateManifest`, no `generatePackRoutes`.

### 2. Slug validation (replaces resolvePack)

Without `resolvePack` available, the handler needs to validate slug format on its own. The regex `^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$` matches the DB CHECK constraint from M4.10 + the pack-registry's slug format. Invalid slug → exit 2 with a clear error.

The slug does NOT need to be in the pack registry. Operators tearing down decommissioned packs unregister them by slug even when the registry has forgotten them.

### 3. Two code paths: dry-run reads, live deletes

```ts
async function runUnregisterPackBySourcePack(command, ctx, registry, slug) {
  if (dryRun) {
    const matching = await registry.listByPackSlug(slug);
    // emit table of rt_<hex> + method + path + operationId
    return 0;
  }
  const deleted = await registry.deleteByPackSlug(slug);
  // report "deleted N route(s) where source_pack = '<slug>'"
  return 0;
}
```

Both branches return 0 even for empty result sets — there's nothing to fail on. Idempotent by design.

### 4. Dispatcher short-circuit excludes --by-source-pack

The M4.8 / M4.8.x dispatcher short-circuits `register-pack --dry-run` and `unregister-pack --dry-run` BEFORE resolving the registry, so operators can preview without PG. `--by-source-pack` breaks that assumption because the dry-run path reads from PG via `listByPackSlug`. Updated dispatcher:

```ts
if (
  (action === "register-pack" ||
    (action === "unregister-pack" && !getBooleanFlag(command, "by-source-pack"))) &&
  getBooleanFlag(command, "dry-run")
) {
  ...
}
```

Now `unregister-pack --by-source-pack --dry-run` falls through to the normal registry-resolution path and gets PG access.

### 5. Output shapes

**Human mode** (live, default):
```
deleted 24 route(s) where source_pack = 'operate-erp/core'.
```

**JSON mode** (live):
```json
{
  "pack": "operate-erp/core",
  "bySourcePack": true,
  "deleted": 24,
  "dryRun": false
}
```

**Human mode** (dry-run):
```
-- dry-run: 24 route(s) would be deleted (by source_pack = 'operate-erp/core'):
  rt_aaaaaaaaaaaaaaaa  GET    /v1/accounts                 account.list
  ...
```

**JSON mode** (dry-run):
```json
{
  "pack": "operate-erp/core",
  "bySourcePack": true,
  "count": 24,
  "dryRun": true,
  "routes": [{ "id": "rt_...", "method": "GET", "operationId": "account.list" }]
}
```

`bySourcePack: true` is the schema marker that tells consumers "this is the M4.10.x shape." M4.8.x's existing JSON output had no equivalent field; the absence of `bySourcePack` in M4.8.x output is the discriminator.

## Cross-cutting invariants enforced

- **`--by-source-pack` does NOT use deterministic IDs.** It uses the row attribution. The two paths produce equivalent results when the manifest is unchanged from registration time; they diverge when the manifest has drifted.
- **No manifest dependency.** `--by-source-pack` works even when `resolvePack(slug)` throws or `resolveManifest` fails.
- **Slug format enforced at the CLI boundary.** The DB CHECK + zod regex are still in place as defense in depth, but the handler catches malformed input early.
- **`--dry-run` is read-only.** Verified by test: zero DELETE statements issued.
- **No `tryValidateManifest`.** The default unregister-pack path skips validation (per M4.8.x); --by-source-pack doesn't even resolve a manifest.
- **Behavior unchanged without the flag.** Verified by test: `unregister-pack <slug>` issues 24 per-ID DELETEs (same as M4.8.x); `unregister-pack <slug> --by-source-pack` issues 1 bulk DELETE.

## End-to-end semantics

```
# Scenario 1: decommissioned pack
$ crossengin gateway routes unregister-pack operate-erp/deprecated-thing --by-source-pack
deleted 18 route(s) where source_pack = 'operate-erp/deprecated-thing'.

# Scenario 2: broken manifest
$ crossengin gateway routes unregister-pack operate-erp/broken-extends --by-source-pack
deleted 12 route(s) where source_pack = 'operate-erp/broken-extends'.

# Scenario 3: clean idempotent re-run
$ crossengin gateway routes unregister-pack operate-erp/core --by-source-pack
deleted 24 route(s) where source_pack = 'operate-erp/core'.
$ crossengin gateway routes unregister-pack operate-erp/core --by-source-pack
deleted 0 route(s) where source_pack = 'operate-erp/core'.

# Scenario 4: preview before destructive op
$ crossengin gateway routes unregister-pack operate-erp/core --by-source-pack --dry-run
-- dry-run: 24 route(s) would be deleted (by source_pack = 'operate-erp/core'):
  rt_a2e5ac16a0b6a5b8  GET    /v1/accounts                 account.list
  ...
```

## Alternatives considered

- **Make `--by-source-pack` the default for unregister-pack.**
  - **Pros.** Simpler — one path instead of two.
  - **Cons.** Breaks M4.8.x semantics. Operators relying on `--api-version` sensitivity or dry-run-without-PG would silently change behavior.
  - **Decision.** Opt-in flag.

- **Auto-fall back to `--by-source-pack` when resolvePack fails.**
  - **Considered.** Operators wouldn't have to know about the flag for decommissioned packs.
  - **Cons.** "Failed to resolve manifest, silently switching to source_pack mode" is operationally surprising. Explicit opt-in is better.
  - **Decision.** Require explicit flag.

- **Combine `--by-source-pack` with `--api-version` for filtered cleanup.**
  - **Considered.** `DELETE WHERE source_pack = $1 AND api_version = $2`.
  - **Cons.** Adds a second method (`deleteByPackSlugAndApiVersion`) without a clear operational need today. apiVersion filtering can be added later if requested.
  - **Decision.** Out of scope. Future M4.10.y could add it.

- **Allow `--by-source-pack` on `sync-pack` (in addition to `unregister-pack`).**
  - **Considered.** `sync-pack --by-source-pack` could mean "treat the entire source_pack set as the canonical, not the generated set."
  - **Cons.** sync-pack's purpose is to RECONCILE generated vs stored. If you only want to delete-by-source, that's unregister-pack. Mixing the verbs adds confusion.
  - **Decision.** Single-verb scoping. `sync-pack --prune-obsolete` is the reconciliation path; `unregister-pack --by-source-pack` is the tear-down path.

- **`unregister --source-pack-slug <slug>` as a sibling to `unregister <rt_id>`.**
  - **Considered.** `unregister` (singular) takes either a route id or a slug.
  - **Cons.** The verb's noun changes. `unregister <id>` deletes one row by id; `unregister --source-pack-slug <slug>` deletes many rows by attribute. Operators would need to remember which positional means what. The `unregister-pack` verb already implies "bulk," so it's a more natural home.
  - **Decision.** Flag on `unregister-pack`, not a new sibling verb.

- **Support multiple slugs in one invocation (`--by-source-pack <slug1>,<slug2>`).**
  - **Considered.** Bulk cleanup of multiple decommissioned packs.
  - **Cons.** Shell composition handles it: `for s in slug1 slug2; do crossengin gateway routes unregister-pack "$s" --by-source-pack; done`. No need for in-binary support.
  - **Decision.** One slug per invocation.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,505 tests** (+9 from M4.10.x). All green, zero type errors.
- **Three operational scenarios unblocked.** Decommissioned packs, broken manifests, and forgotten old versions all have a clean remediation path.
- **`deleteByPackSlug` is now exercised end-to-end from the CLI.** The M4.10 registry method had unit tests; M4.10.x adds the CLI integration layer.
- **Slug validation is now a CLI-layer concern.** The handler enforces format without depending on the pack registry. This pattern extends to future slug-accepting commands.
- **ADR-0082 Q3 closed.** The future M4.10.x path it described is now M4.10.x.
- **The two paths diverge when the manifest has drifted.** Operators who want "delete exactly what register-pack would have created today" use the default path; operators who want "delete everything this pack EVER registered" use `--by-source-pack`. Both are valid, both are documented.

## Open questions

- **Q1:** Should the live mode also emit the deleted route IDs in JSON?
  - _Current direction:_ No — `deleteByPackSlug` returns rowCount only; surfacing IDs would require an extra SELECT before the DELETE. The dry-run path already provides the preview.
- **Q2:** Should `--by-source-pack` work with a slug glob like `operate-erp/*` for family-wide cleanup?
  - _Current direction:_ Out of scope. Shell composition handles it; glob support adds complexity (the slug regex doesn't naturally accommodate wildcards).
- **Q3:** Audit row written to a future audit table when --by-source-pack issues a bulk delete?
  - _Current direction:_ Same as M4.8.x — no audit yet. Audit-table package is future M4.11+.
- **Q4:** Should the dry-run path also separately count "would delete from this pack" vs "would delete that operator-registered manually" (i.e., differentiate NULL source_pack rows)?
  - _Current direction:_ No. NULL source_pack rows aren't matched by `WHERE source_pack = $1`. They're invisible to --by-source-pack by design.
- **Q5:** Add the same `--by-source-pack` flag to `gateway routes list` for filtered listings?
  - _Current direction:_ Out of scope. `gateway routes list` could grow filtering flags (`--source-pack <slug>`, `--api-version <v>`, etc.) as a future M4.10.y if multi-pack deployments make this painful.
- **Q6:** Permission / RBAC gating for bulk deletes?
  - _Current direction:_ Out of scope. CLI access is itself the authorization boundary today. Future per-tenant RBAC on routes is M4.9+.
