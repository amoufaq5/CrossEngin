# `@crossengin/operate-server` — the `operate-server` binary

Serves a resolved CrossEngin manifest as a live, multi-tenant HTTP API. It
compiles the manifest's entities + lifecycle into routes, runs every request
through the 17-stage API gateway (auth → RBAC → idempotency → rate-limit →
classification redaction → audit), and persists through a pluggable
`EntityStore`. The same framework-neutral `dispatch` core runs on Node **and**
any Fetch/WinterCG runtime (Cloudflare Workers, etc.).

It is one of three apps under `apps/` (`architect-cli` authors manifests,
`operate-server` serves them, `workflow-worker` advances their workflows).

## How it works

`compileOperateServer(manifest)` derives a `RouteSpec` per entity operation — 5
CRUD + one per `entityLifecycle` transition (camelCase operationIds, kebab-plural
paths). `buildOperateGateway` wires routes + RBAC-enforcing handlers +
a `redactionRegistryFromManifest` into a `GatewayRuntime`.
`OperateHttpServer.dispatch(raw, body)` maps a framework-neutral
`RawHttpRequest` → the gateway pipeline → a `RawHttpResponse`; the Node and edge
adapters both wrap that one core.

Per request the gateway: authenticates (API key or JWT), resolves the principal
+ tenant, matches the route, enforces RBAC, checks idempotency + rate limits,
runs the handler over the store, **redacts classified fields per-caller** at the
edge, applies security headers, and emits a queryable `PipelineExecution`.

## Routes

| route | purpose |
|---|---|
| `GET/POST /v1/<entities>` | list (keyset-paginated) / create |
| `GET/PATCH/DELETE /v1/<entities>/{id}` | read / update / delete |
| `POST /v1/<entities>/{id}/<transition>` | fire an `entityLifecycle` transition |
| `GET /v1/reports/{report}` | run a manifest report → executed `ReportData` (P3.25) |
| `GET /v1/openapi.json` | the API description — a minimal OpenAPI 3.1 doc (P3.26) |

Report data is aggregated by SQL pushdown under a Postgres store (`--store pg`
JSONB / `--store pg-columns` typed columns) or a bounded in-memory engine under
`--store memory`; an unknown report or a field the caller can't read is a
fail-closed `404`. `GET /v1/openapi.json` lists every operation + the report
catalog (under `x-reports`), projected from the compiled routes + manifest — it
rides the gateway, so it authenticates like any route (it is the published API
*shape*, not tenant data).

## Stores (`--store`)

| store | binding | use |
|---|---|---|
| `memory` | `InMemoryEntityStore` | dev / tests, no DB |
| `pg` | `PostgresEntityStore` | JSONB document store over `meta.operate_entity_records`, tenant RLS |
| `pg-columns` | `ColumnMappedEntityStore` | typed per-entity tables (DDL from the manifest): native-typed columns, FKs, m2m join tables, and **transparent at-rest encryption** of `phi`/`regulated` columns via pgcrypto |

Both Postgres stores confine every read/write to the caller's tenant via
`WHERE tenant_id = $1` **and** `withTenantContext` (the RLS policy
`tenant_id = current_setting('app.current_tenant_id')::UUID`). `--store
pg-columns` provisions its typed tables at boot (`ensureSchema`).

## Multi-tenancy, redaction, RBAC

- **Tenant isolation** — every store op is tenant-scoped; the RLS policy is the
  boundary (proven under a non-bypassing role), the `WHERE tenant_id` is
  defense-in-depth.
- **Classification redaction** — a field declared `pii`/`phi`/`regulated`/
  `commercial_sensitive` is dropped from a response unless the caller's role has
  an explicit grant (e.g. a cashier loses `unit_cost`, a manager keeps it). For
  the column store, `phi`/`regulated` columns are also **ciphertext at rest**.
- **RBAC** — each operation checks the principal's scopes/role against the
  manifest's permissions; an unauthorized write is `403`.
- **Pagination** — list endpoints use **keyset** cursors (`?limit`, `?cursor`,
  `?sort=field&order=`) + typed filters (`?field[op]=value`) + `?fields`
  projection, driven by the entity's `ListView`.

## Auth

- **API keys** (`--api-key key:role:tenant`, repeatable) — opaque tokens, dev/
  service auth, fail-closed (unknown token → 401).
- **JWT / JWKS** (production) — EdDSA-verified `bearer_jwt`, resolved statelessly
  from claims; a JWT's `tenant_id` claim is authoritative over the spoofable
  `x-tenant-id` header (mismatch → 401). Keys via `--jwks-key kid:base64` /
  `--jwks-file` / `--jwks-url` (caching remote provider with rotation +
  background refresh), with `--jwt-issuer` / `--jwt-audience`.

Dev (API key) and prod (JWT) auth coexist.

## Flags

```
--pack <alias>             serve a built-in vertical pack (erp-core | erp-retail |
                           erp-healthcare | erp-grocery), resolving its meta.extends lineage
--manifest <file>          serve a pre-resolved manifest JSON (exactly one of --pack/--manifest)
--port <n>                 listen port
--store <memory|pg|pg-columns>   entity store (default memory)
--schema <name>            Postgres schema (pg / pg-columns)
--scheme <http|https>      request scheme for the gateway
--api-key key:role:tenant  register an opaque API key (repeatable)
--jwks-key kid:base64      register an Ed25519 verification key (repeatable)
--jwks-file <file>         load JWKS keys from a JSON file
--jwks-url <url>           fetch JWKS from an IdP endpoint (cached, rotating)
--jwks-refresh-ms <n>      background JWKS refresh interval
--jwt-issuer <iss>         required JWT issuer (when a JWKS is configured)
--jwt-audience <aud>       required JWT audience
--help / --version
```

## Postgres

Connects via the standard `PG*` env vars. Apply the meta-schema first
(`crossengin-pg apply`). The serving role is tenant-scoped (RLS-enforced), not a
BYPASSRLS role — the gateway sets the tenant context per request.

## Deployment recipe

```bash
# apply the schema (once)
crossengin-pg apply

# serve the retail pack from the JSONB store, JWT auth
PGHOST=… PGUSER=app PGPASSWORD=… PGDATABASE=crossengin \
  operate-server --pack erp-retail --store pg --port 8080 \
    --jwks-url https://idp.example.com/.well-known/jwks.json \
    --jwt-issuer https://idp.example.com --jwt-audience crossengin-api

# typed tables + at-rest encryption (healthcare)
operate-server --pack erp-healthcare --store pg-columns --port 8080 --api-key dev:clinician:<tenant>
```

The same server also runs on the edge: `buildEdgeFetchHandler` / `asModuleWorker`
yield a Cloudflare `{fetch}` default export over the identical `dispatch` core.

## `incidents` subcommand (one-shot query)

Read/transition the `meta.incidents` audit table from the shell. With `--slo`
the serving app declares availability incidents into it; this subcommand
queries and operates on them without switching binaries. `operate-server
incidents …` runs a single query and exits:

```bash
# incidents that are still open (status not resolved/closed/cancelled)
operate-server incidents open [--limit N] [--format human|json]

# every incident declared within a window
operate-server incidents period --from <iso> --to <iso> [--limit N] [--format json]

# timeline drift sweep over a window — exits 1 if any incident's timeline
# drifted from declared -> (escalated)* -> resolved (gate CI on it)
operate-server incidents verify --from <iso> --to <iso> [--format json]

# operational KPIs over a window: MTTP / MTTA / MTTM / MTTR (mean/p50/p95/max),
# open/resolved counts, per-severity gauges, escalation totals
operate-server incidents metrics --from <iso> --to <iso> [--limit N] [--format json]

# record the ack / mitigate milestones (drives MTTA / MTTM). Idempotent:
# a no-op (absent / already past that state) still exits 0.
operate-server incidents ack      <incident-id> [--actor <uuid>]
operate-server incidents mitigate <incident-id> [--actor <uuid>]
```

All commands honor `--schema` (default `meta`). This is the same subcommand
surface `workflow-worker` ships — both binaries query the same
`@crossengin/incident-response-pg` layer over `meta.incidents`.

## Tests

Unit tests run offline over the in-memory store. A gated real-Postgres
integration suite drives HTTP → gateway → Postgres for both stores — CRUD,
tenant isolation, redaction, RBAC, keyset pagination, at-rest encryption, m2m
links, all FK `ON DELETE` modes, and the RLS policy under a non-bypassing role:

```bash
CROSSENGIN_PG_TEST=1 PGHOST=localhost PGUSER=… PGPASSWORD=… PGDATABASE=… \
  PGSSLMODE=disable pnpm --filter @crossengin/operate-server test
```
