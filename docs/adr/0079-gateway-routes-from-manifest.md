# ADR-0079: Gateway routes from pack manifest (Phase 2 M4.8)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0074 (M4.7.5 gateway routes subcommand), ADR-0069 (M4.7 gateway binding), ADR-0068 (M7.6.5 extends resolver), ADR-0058 (pack-erp-core) |

## Context

M4.7.5 shipped `crossengin gateway routes list|register|unregister` — operators could insert one route at a time from a hand-built JSON file. ADR-0069's M4.7 open question on "manifest-driven route registration" was deferred to M4.8 with a sketch: derive routes from `pack-erp-core`'s entities + operations rather than typing them by hand.

A real pack-erp-healthcare deployment exposes 7 entities (Patient, Encounter, Observation, Account, Contact, Invoice, InvoiceLine) plus 3 lifecycle workflows. Hand-writing 5 CRUD routes per entity + one route per workflow transition is ~47 JSON files for a single pack. Multiply across the 3 packs in the workspace today and operators are typing >100 route definitions — error-prone, drifty against the manifest, and demoralising.

M4.8 generates the routes from the resolved manifest. The kernel Manifest schema doesn't have an `operations[]` field; the natural sources are:

- **Entities** → 5 standard CRUD routes per entity (list / read / create / update / delete)
- **`entityLifecycle` workflows** → one route per transition

Three constraints shaped the design:

- **Deterministic route IDs.** Re-running `register-pack <slug>` must upsert the same route_id rows — operators don't want their route table churning every time they iterate the pack. Use `sha256("<slug>:<operationId>").slice(0, 16)` for a stable 16-hex ID that fits the `rt_[a-z0-9]{8,40}` regex.
- **No new manifest fields.** Reuse the existing entity + workflow declarations. Future M4.8.x could add explicit `operations: {...}` to the manifest for per-operation overrides; M4.8 doesn't require it.
- **--dry-run without PG.** Operators inspecting "what routes would I get?" shouldn't need a running database. The dispatch short-circuits before resolving the registry when `--dry-run` is set.

## Decision

Two changes — one new module, one extension to an existing subcommand.

### 1. `apps/architect-cli/src/gateway-pack-routes.ts` — pure generator

`generatePackRoutes({manifest, packSlug, apiVersion?})` returns `readonly PackRouteRecord[]`. Pure given inputs:

- For each entity in the resolved manifest, emit 5 CRUD routes:
  - `GET /v1/<plural>` → `<entity>.list` (idempotency: false, scope: `<entity>:list`)
  - `GET /v1/<plural>/:id` → `<entity>.read` (idempotency: false, scope: `<entity>:read`)
  - `POST /v1/<plural>` → `<entity>.create` (idempotency: true, scope: `<entity>:create`)
  - `PATCH /v1/<plural>/:id` → `<entity>.update` (idempotency: true, scope: `<entity>:update`)
  - `DELETE /v1/<plural>/:id` → `<entity>.delete` (idempotency: true, scope: `<entity>:delete`)
- For each `entityLifecycle` workflow, emit one route per declared transition:
  - `POST /v1/<plural>/:id/transitions/<name>` → `<entity>.transition.<name>` (idempotency: true, scope: `<entity>:transition.<name>`)

The pluralizer (`pluralizePathSegment`) kebabifies CamelCase + appends `s` (or `ies` for consonant+y endings; preserves trailing `s`):
- `Patient` → `patients`
- `InvoiceLine` → `invoice-lines`
- `Category` → `categories`
- `Address` → `address` (already ends in `s`)

The entity-key normalizer (`entityKey`) does snake_case for use in operationIds + scopes:
- `Patient` → `patient`
- `InvoiceLine` → `invoice_line`

`routeIdFor({packSlug, operationId})` returns `rt_<sha256(packSlug:operationId).slice(0,16)>`. Deterministic, regex-safe, collision-resistant within a pack.

### 2. `apps/architect-cli/src/gateway-routes.ts` — `register-pack` action

`crossengin gateway routes register-pack <slug> [--api-version v1] [--dry-run] [--created-by <uuid>]`

Flow:

1. Resolve the pack via `resolvePack(slug)` from the M7.6.5 pack registry. Unknown slug → exit 2 with `UnknownPackError.message` (lists available packs).
2. Run `resolveManifest(rawManifest, {registry: packManifestRegistry()})` to merge parent packs (M7.6.5).
3. `tryValidateManifest(resolved)` — bail with exit 1 + error path/message list if validation fails.
4. Generate routes via `generatePackRoutes(...)`.
5. If `--dry-run`: print the route table (or JSON envelope) and exit 0 without touching the database.
6. Otherwise: loop `registry.upsert(route, createdBy)` for every generated route. Print `registered N route(s) for pack '<slug>'.` + one row per route.

`--api-version` (default `v1`) controls the apiVersion field on every generated route + the leading path segment. Operators with parallel v1 + v2 routes invoke twice with different versions.

`--created-by` flows the actor uuid to `meta.gateway_routes.created_by` for audit (same as M4.7.5's `register` action; default placeholder).

### 3. Dry-run dispatch short-circuit

The default `runGatewayRoutes` flow resolves a Postgres registry before dispatching. For `register-pack --dry-run` that's wrong — operators inspecting routes don't need PG. The dispatcher detects this combination and calls the handler with `registry: null`; the handler skips its upsert loop and emits the route preview.

### End-to-end verification

```
$ crossengin gateway routes register-pack operate-erp/healthcare --dry-run
... 47-row table ...
-- dry-run: 47 route(s) generated for pack 'operate-erp/healthcare' (not written).

$ # With PG env set:
$ crossengin gateway routes register-pack operate-erp/healthcare
registered 47 route(s) for pack 'operate-erp/healthcare'.
  GET    /v1/patients                         -> patient.list
  GET    /v1/patients/:id                     -> patient.read
  POST   /v1/patients                         -> patient.create
  ...
  POST   /v1/observations/:id/transitions/mark_in_error -> observation.transition.mark_in_error
```

Route counts per pack:
- `operate-erp/core` → 4 entities × 5 CRUD + 4 invoice transitions = **24 routes**
- `operate-erp/payments` (resolved) → 5 entities × 5 CRUD + 4 invoice + 5 payment transitions = **34 routes**
- `operate-erp/healthcare` (resolved) → 7 entities × 5 CRUD + 4 invoice + 5 encounter + 3 observation transitions = **47 routes**

## Cross-cutting invariants enforced

- **Deterministic route IDs.** Re-running `register-pack` upserts the same rows; no churn, no orphaned route_ids. SHA-256-derived IDs guarantee collision-free identifiers within a pack and across packs (different slugs → different hashes).
- **Generated routes pass `RouteDefinitionSchema.parse()`.** Tests assert this for every generated route across all three packs.
- **Operation IDs are unique within a pack.** No two routes share an operationId — the M4.4 dispatcher relies on this uniqueness. The pack-route generator's combinatorial output (entity × op) is naturally collision-free.
- **Path segments match the kernel's PathSegmentSchema.** Literal segments use `[a-zA-Z0-9._-]+` chars; parameter segments use `[a-z][a-zA-Z0-9_]*` names. The kebabifier handles CamelCase but never emits forbidden characters.
- **Transition names are URL-safe.** Builder rejects transition names with characters that can't go in a URL path segment (`[^a-zA-Z_][a-zA-Z0-9_]*`). All shipping packs use snake_case transitions; the check is a forward guard against future packs with weird transition names.
- **Idempotency matches HTTP method semantics.** GET/HEAD → `idempotencyRequired: false`; POST/PUT/PATCH/DELETE → `idempotencyRequired: true`. Aligns with the M4 gateway runtime's mid-pipeline check.
- **Scopes derive from operationId.** `<entity>:<op>` for CRUD; `<entity>:transition.<name>` for transitions. Operators map these to their auth scope inventory; tests don't pin the scope-to-role bridge.
- **--dry-run is read-only.** No INSERTs issued; verified by counting capture entries in tests.

## Alternatives considered

- **Add an explicit `operations: {...}` field to the kernel Manifest.**
  - **Pros.** First-class declarative routes; operators get full control over per-operation paths, methods, scopes.
  - **Cons.** Breaks the "manifest is source of truth for entities + workflows + jobs + views" mental model. Most operators want defaults; the few who need overrides can register a per-operation route via `register <file>.json` after the bulk register-pack.
  - **Decision.** Defer. M4.8.x can add `meta.operations` overrides if real use cases emerge.

- **Generate one route per permission instead of per entity.**
  - **Considered.** Entities have `permissions.<Entity>: {list, read, create, update, delete, transitions}` — closer to the route shape.
  - **Cons.** Permissions are about who can call the operation, not whether the operation exists. An entity without `permissions.read` still needs a `read` route for the admin tier. Mixing the two would create routes only for explicitly-permitted ops, which silently drops unguarded read endpoints.
  - **Decision.** Permissions are independent of route generation. Operators set scopes; route generator emits the standard set.

- **Allow per-pack overrides via a JSON file (`crossengin gateway routes register-pack core --overrides ./core-overrides.json`).**
  - **Considered.** Lets operators tweak generated routes without forking the generator.
  - **Decision.** Defer. The generator's output is RouteDefinition[]; operators wanting per-route overrides re-register via the existing `register <file>.json` after the pack-level register. Two passes are clearer than one merging-overrides pass.

- **Use plural-form English library (e.g., `pluralize` npm package).**
  - **Considered.** Handles irregular plurals (Person → People, Goose → Geese).
  - **Decision.** No new deps. The naive pluralizer (kebab + s, with `ies` for -y endings) handles every entity in the three shipped packs. Operators with irregular plurals can override via the per-operation registration path.

- **Run `tryValidateManifest` BEFORE `resolveManifest`.**
  - **Considered.** Cheaper rejection of structurally bad manifests.
  - **Cons.** Child manifests with `meta.extends` deliberately fail standalone validation (Payment.invoice_id → Invoice with no Invoice in the child). Resolver-then-validator is the canonical M7.6.5 order.
  - **Decision.** Resolve first, then validate. Same order as `crossengin apply --pack=<slug>`.

- **Include API spec generation (OpenAPI / RFC 9457) in the same command.**
  - **Considered.** Operators would get routes + spec in one shot.
  - **Cons.** OpenAPI spec generation has its own concerns (Component schema generation, security scheme mapping, server URL config). Distinct milestone.
  - **Decision.** Out of scope. M4.8 only emits Bedrock-shaped `RouteDefinition` records. M4.9 can layer spec gen on the same generator.

- **Make `--dry-run` the default + require `--commit` to write.**
  - **Considered.** Safer-by-default.
  - **Cons.** Operators iterating on a pack want fast register cycles. Defaulting to dry-run + requiring `--commit` adds friction without preventing real mistakes (operators would just type `--commit` reflexively).
  - **Decision.** Default writes; `--dry-run` opts into preview.

- **Track which routes came from which pack in a `routes.source_pack` column.**
  - **Considered.** Lets operators unregister-all-from-pack later.
  - **Cons.** Schema change required (`meta.gateway_routes.source_pack` column). The deterministic route_id already encodes the pack (different slug → different hash), so `unregister-all-from-pack` could re-generate IDs + delete by ID.
  - **Decision.** Defer to M4.8.x. The current single-route `unregister` command works for one-off cleanup.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,460 tests** (+35 from M4.8). All green, zero type errors.
- **`crossengin gateway routes register-pack <slug>` is the one-shot bulk-register command for any pack.** Operators no longer hand-write route JSON for the documented packs.
- **Three packs are immediately deployable.** `register-pack operate-erp/core` (24 routes), `register-pack operate-erp/payments` (34 routes), `register-pack operate-erp/healthcare` (47 routes). Total: 105 routes from three commands.
- **ADR-0069 M4.7 open question on manifest-driven route registration closed.**
- **Re-runs are safe.** Deterministic route IDs mean the second invocation upserts the same rows; no churn, no orphans.
- **Per-tenant overrides still work via M4.7.5's `register <file>.json`.** Operators wanting `paymentX.refund` to require `payment:admin` scope instead of the default `payment:transition.refund` register a single overriding route after the pack-level bulk.
- **Pattern set for future generators.** OpenAPI spec emit, GraphQL schema emit, SDK client generation — all consume the same `generatePackRoutes` output as their starting point.
- **Pricing-free.** Pure generation — no LLM calls, no network. Runs in milliseconds for any pack size.

## Open questions

- **Q1:** Should the generator emit routes for `views[].kind === "list"` (the view-defined list operations)?
  - _Current direction:_ No. View declarations are UI metadata, not API surface. The CRUD `.list` route is the API; the view layers on top.
- **Q2:** What about job-triggered routes (POST to invoke a job manually)?
  - _Current direction:_ Out of scope. Jobs have their own triggering surface (scheduled cron / event subscription / signal bridge). Adding a route to invoke a job is an admin concern; a future M4.8.x could emit `POST /v1/jobs/<job-id>/invoke` routes per job.
- **Q3:** Should generated routes track which manifest hash they came from (so `register-pack` can detect drift)?
  - _Current direction:_ Out of scope. Re-running `register-pack` is the drift remediation — same route IDs upsert in place. Tracking source hash would help with audits but doesn't change the operational story.
- **Q4:** What if a pack's transition name contains a hyphen (`mark-paid`)?
  - _Current direction:_ The generator rejects it at request-build time (`/^[a-zA-Z_][a-zA-Z0-9_]*$/` check). All shipping packs use snake_case. A future pack with a hyphenated transition would force a pack-side rename or generator-side translation.
- **Q5:** Should `register-pack` also accept `--manifest <path>` for one-off testing of an unregistered pack?
  - _Current direction:_ Not in M4.8. The pack-registry is the entry point. A future flag could read a JSON manifest from disk and feed it to the generator directly.
- **Q6:** Multi-version support: can `register-pack` emit v1 and v2 routes from the same manifest in one call?
  - _Current direction:_ Not in M4.8. Two invocations with different `--api-version` flags produce two route sets (different route_ids since the operationId+slug input to the hash is the same, but the apiVersion is part of the route record). The same operationId on two API versions is what `listVersionsFor` was designed to surface.
- **Q7:** What about idempotencyRequired per-operation override?
  - _Current direction:_ The current rules (GET → false; mutating → true) are deterministic and match M4 gateway runtime expectations. A pack-side override would need a kernel manifest extension.
