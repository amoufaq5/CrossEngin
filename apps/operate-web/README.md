# `@crossengin/operate-web-app` — the `operate-web` binary

Serves a resolved CrossEngin manifest as a **redaction-aware UI layer**. Where
`operate-server` exposes the manifest's *data* over a REST API, `operate-web`
exposes the manifest's *views* — it compiles the manifest's entities, fields,
and view declarations into serializable view models (`WebAppModel` /
`TableModel` / `DetailModel` / `FormModel`) and serves them, plus the data
behind them, as JSON **and** as server-rendered, hydratable React pages. Every
model and every data row is compiled and redacted **per caller**, so the UI
never even describes — let alone receives — a field the caller can't read.

It is one of four apps under `apps/` (`architect-cli` authors manifests,
`operate-server` serves their data, `workflow-worker` advances their workflows,
`operate-web` renders their UI).

## How it works

The pure view-model compiler lives in `@crossengin/operate-web` (no React/DOM
dependency — every model is plain, JSON-serializable data):

- `compileWebApp(manifest, viewer)` → the app shell model (title + per-entity nav).
- `compileTableModel(manifest, entity, viewer)` → columns from the entity's
  `ListView`, else from `listConfigForEntity` (every readable field).
- `compileDetailModel(manifest, entity, viewer, record)` → sections from the
  `RecordView`, else one all-readable-fields section.
- `compileFormModel(manifest, entity, viewer, "create")` → fields from the
  `FormView`, else every writable field.

`@crossengin/operate-web-react` server-renders those models to hydratable HTML
(SSR markup + an embedded `WebPageState` blob + a deferred client `<script>`),
and `OperateWebServer.dispatch(req)` is the framework-neutral serving core that
authenticates each request, compiles the models, redacts the data, and returns
either JSON or HTML. The Node and edge adapters both wrap that one `dispatch`.

## Endpoints

All routes are `GET`. Auth via `x-api-key` or `Authorization: Bearer <key|jwt>`
(except the public static bundle).

### JSON view-model API (`/ui/...`)

| Route | Returns |
|---|---|
| `GET /ui/app` | the `WebAppModel` (title + per-entity nav) |
| `GET /ui/:entity` | `{ table, page: { data, nextCursor } }` — the `TableModel` + a redacted, keyset-paginated data page |
| `GET /ui/:entity/new` | `{ form }` — the create `FormModel` |
| `GET /ui/:entity/:id` | `{ detail, record }` — the `DetailModel` + the redacted record |

`/ui/:entity` honors the list query params driven by the entity's `ListView`:
`?limit`, `?cursor`, `?sort=field&order=asc|desc`, typed filters
(`?field[op]=value`), and `?fields` projection.

### SSR React HTML pages (`/app/...`)

| Route | Renders |
|---|---|
| `GET /app` | the app shell page |
| `GET /app/:entity` | the entity table page (model + a redacted data page) |
| `GET /app/:entity/:id` | the record detail page |
| `GET /app/:entity/new` | the create form page |

Each `/app/...` page server-renders the **same** compiled, redacted models the
`/ui/...` API returns, as a hydratable HTML document (`#root` + the embedded
`WebPageState` + a `<script src>` to the client bundle).

### Static client bundle

| Route | Returns |
|---|---|
| `GET /assets/operate-web-client.js` | the browser hydration bundle (`application/javascript`, `cache-control: public, max-age=3600`) |

This asset is served **before** auth: it carries no per-caller data (every model
and row is redacted before being embedded in the page). When the bundle hasn't
been built, the route responds `503` with a notice to run `build:client` — the
SSR pages still render (they're server-complete), they just won't hydrate.

## The redaction guarantee (headline)

This is the defining property of `operate-web`: **the compiled models, the data
rows, and the embedded hydration state are all redacted per caller** —
classification + RBAC — before they leave the server.

A field declared `pii` / `phi` / `regulated` / `commercial_sensitive` is dropped
from the model entirely (the column never appears in a `TableModel`, the field
never appears in a `DetailModel` / `FormModel`) unless the caller's role has an
explicit grant; the matching data value is stripped from the row by
`redactRecord`; and because the SSR embeds only the already-redacted state, the
hydration blob the browser receives can't contain a hidden field either. A
readable-but-not-writable field is included `readOnly` in the form. So a
`cashier` viewing `Product` never receives `unit_cost` — not in the JSON, not in
the HTML, not in the hydration state — while a `store_manager` does. The UI
never even describes a field the caller can't see.

Redaction reuses the auth layer's `computeClassifiedFieldRedaction` (read → field
inclusion) and `validateClassifiedWriteMask` (write → form `readOnly`), keyed off
the viewer's roles; it is fail-closed (an unknown role sees only public fields).

## Auth

- **API keys** (`--api-key key:role:tenant`, repeatable) — opaque tokens for
  dev / service auth, fail-closed (missing or unknown token → 401). Sent as an
  `x-api-key` header or `Authorization: Bearer <key>`.
- **JWT / JWKS** (production) — when a JWKS is configured, a 3-part Bearer token
  is verified as an EdDSA JWT (signature + iss/aud/exp/nbf via
  `@crossengin/api-gateway-runtime`'s `verifyBearerJwt`) and its claims become
  the viewer statelessly: scopes → roles via `scopesToRoles` (a `roles` array
  claim wins, else the OIDC `scope` string, else `scp` array, else `[]`
  fail-closed), `sub` → a UUID, tenant from the `tenant_id` claim (else the
  `x-tenant-id` header — a null tenant fails closed). Keys via `--jwks-key
  kid:base64`, `--jwks-file`, or `--jwks-url` (a caching, rotation-aware remote
  provider), with `--jwt-issuer` / `--jwt-audience`.

A registered API key wins; otherwise the JWT path runs. Dev (API key) and prod
(JWT) auth coexist behind one resolver.

## Runtimes

- **Node** — `serve(options)` boots an `http` server over the `dispatch` core,
  returning a handle for graceful shutdown.
- **Edge / Workers** — `fetchToRaw` / `rawToFetchResponse` /
  `createFetchHandler` / `buildEdgeFetchHandler` / `asModuleWorker` adapt the
  same `dispatch` to the Fetch API, yielding a Cloudflare `{ fetch }`
  default-export shape. Edge runs over an in-memory store (socket-less runtimes
  can't open a node-postgres connection) and serves GET-only (no body read).

## Client interactivity

SSR + `hydrateRoot`: each `/app/...` page is server-complete HTML, and the
client bundle re-hydrates the *identical* `PageRoot` component tree against the
server markup. On the table page, sort-toggle column buttons and forward-only
keyset pagination (Prev / Next, walking a cursor stack) **refetch the read-only
`/ui/:entity` JSON endpoint** and swap rows + cursor in local state — no full
reload, no new server route. Detail / form / app pages hydrate to identical
static markup; row links remain normal navigations to the SSR detail pages.

Live hydration is a **browser-only** behavior: the bundle imports
`react-dom/client`, so it is deliberately kept off the `pnpm -r build` (tsc) and
vitest paths. Build it separately (esbuild, `platform: browser`):

```bash
pnpm --filter @crossengin/operate-web-app build:client   # emits dist/assets/operate-web-client.js
```

Until you run that, `/assets/operate-web-client.js` 503s and the pages render
server-side without hydrating.

## Flags

```
--pack <name>          serve a built-in vertical pack (erp-core | erp-retail |
                       erp-healthcare | erp-grocery), resolving its meta.extends lineage
--manifest <file>      serve a pre-resolved manifest JSON (exactly one of --pack/--manifest)
--port <n>             listen port (default 8788)
--api-key key:role:tenant  register an opaque API key (repeatable)
--jwks-key kid:base64  register an Ed25519 verification key (repeatable)
--jwks-file <file>     load JWKS keys from a JSON file
--jwks-url <url>       fetch JWKS from an IdP endpoint (cached, rotation-aware)
--jwt-issuer <iss>     required JWT issuer (when a JWKS is configured)
--jwt-audience <aud>   required JWT audience (when a JWKS is configured)
--help, -h
--version, -v
```

`--pack` and `--manifest` are mutually exclusive (exactly one required).
`--jwks-key` / `--jwks-file` / `--jwks-url` are mutually exclusive, and when any
is set both `--jwt-issuer` and `--jwt-audience` are required.

## Store / Postgres

`operate-web` defaults to an **in-memory** entity store, and the Node `serve()`
path exposes no `--store` flag — there is no `PG*` configuration to set out of
the box. A boot script can reach the `OperateWebServer` (via the returned
`webServer.entityStore`) to seed records into the in-memory store. A Postgres
`EntityStore` (`PostgresEntityStore` / `ColumnMappedEntityStore` from
`@crossengin/operate-runtime-pg`) can be injected programmatically through
`buildOperateWebServer({ store })` / `buildEdgeFetchHandler({ store })`, but it
is not wired to a CLI flag yet — see deferred items below.

## Deployment recipe

```bash
# build the client hydration bundle once (needed for live interactivity)
pnpm --filter @crossengin/operate-web-app build:client

# serve the retail pack on Node with a dev API key
operate-web --pack erp-retail --port 8788 --api-key dev:store_manager:<tenant-uuid>

# production JWT auth against an IdP's JWKS endpoint
operate-web --pack erp-healthcare --port 8788 \
  --jwks-url https://idp.example.com/.well-known/jwks.json \
  --jwt-issuer https://idp.example.com --jwt-audience crossengin-ui
```

The same server runs on the edge: `buildEdgeFetchHandler` / `asModuleWorker`
yield a Cloudflare `{ fetch }` default export over the identical `dispatch` core.

## Deferred

- **Form mutations / write endpoints.** The form model is compiled and rendered,
  but the server is read-only (all routes are `GET`); there is no create/update
  submission path yet.
- **Full client-side routing.** Hydration makes the table page interactive
  (sort + keyset pagination over the JSON API); detail / form / app navigations
  remain full SSR page loads rather than client-side route transitions.
- **A `--store` CLI flag for Postgres.** A Postgres store can be injected
  programmatically, but the binary defaults to in-memory with no store flag.

## Tests

Unit tests run offline over the in-memory store and stubbed fetchers; a real
loopback test boots `serve()` and proves an unprivileged caller's
`/ui/:entity/:id` JSON omits a classified column while a privileged caller's
includes it. The edge adapter is tested against genuine `Request` / `Response`
globals, and the JWT path against real Ed25519-signed tokens.

```bash
pnpm --filter @crossengin/operate-web-app test
```
