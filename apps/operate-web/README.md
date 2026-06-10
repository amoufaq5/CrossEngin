# `@crossengin/operate-web-app` — the `operate-web` binary

Serves a resolved CrossEngin manifest as a **redaction-aware UI layer**. Where
`operate-server` exposes the manifest's *data* over a REST API, `operate-web`
exposes the manifest's *views* — it compiles the manifest's entities, fields,
and view declarations into serializable view models and serves them, plus the
data behind them, as JSON **and** as server-rendered, hydratable React pages.
Every model and every data row is compiled and redacted **per caller**, so the
UI never even describes — let alone receives — a field the caller can't read.

It is one of four apps under `apps/` (`architect-cli` authors manifests,
`operate-server` serves their data, `workflow-worker` advances their workflows,
`operate-web` renders their UI).

## How it works

The pure view-model compiler lives in `@crossengin/operate-web` (no React/DOM
dependency — every model is plain, JSON-serializable data). It compiles **all 8
manifest view kinds**, each redaction-aware and fail-closed:

| Compiler | View kind | Model | Fallback |
|---|---|---|---|
| `compileWebApp` | — | `WebAppModel` (title + per-entity nav) | — |
| `compileTableModel` | `list` | `TableModel` (columns) | `listConfigForEntity` (every readable field) |
| `compileDetailModel` | `record` | `DetailModel` (sections) | one all-readable-fields section |
| `compileFormModel` | `form` | `FormModel` (fields) | every writable field |
| `compileKanbanModel` | `kanban` | `KanbanModel` (state field + columns + cards + RBAC-gated transitions) | none (→ `null`) |
| `compileCalendarModel` | `calendar` | `CalendarModel` (start/end/title/color) | none |
| `compileMapModel` | `map` | `MapModel` (geo field + marker fields + layers) | none |
| `compileDashboardModel` | `dashboard` | `DashboardModel` (grid layout + widgets) | none |
| `compilePivotModel` | `pivot` | `PivotModel` (report ref + reshape flag) | none |

`list`/`record`/`form` fall back to a sensible default when the pack declares no
explicit view; the other five return `null` (a board needs an authored state
field, a calendar a date field, a map a geo field, a dashboard/pivot a report).
`@crossengin/operate-web-react` server-renders the models to hydratable HTML, and
`OperateWebServer.dispatch(req)` is the framework-neutral serving core that
authenticates each request, compiles the models, redacts the data, routes reads
+ writes, and returns JSON or HTML. The Node and edge adapters both wrap that one
`dispatch`.

## Endpoints

Auth via `x-api-key` or `Authorization: Bearer <key|jwt>` (except the public
static bundle).

### JSON view-model API (`/ui/...`)

| Method · Route | Returns |
|---|---|
| `GET /ui/app` | the `WebAppModel` (title + per-entity nav — only the view kinds the caller can see) |
| `GET /ui/_describe` | the `WebApiDescriptor` — per-caller route discovery (entities × available view routes + global routes) |
| `GET /ui/:entity` | `{ table, page: { data, nextCursor } }` — `TableModel` + a redacted, keyset-paginated data page |
| `GET /ui/:entity/kanban` | `{ kanban, page }` — board model + cards (404 if no kanban view) |
| `GET /ui/:entity/calendar` | `{ calendar, page }` — calendar model + events (404 if none) |
| `GET /ui/:entity/map` | `{ map, page }` — map model + markers (404 if none) |
| `GET /ui/:entity/dashboard` | `{ dashboard }` — grid layout + widget descriptors (404 if none) |
| `GET /ui/:entity/pivot` | `{ pivot }` — report ref + reshape flag (404 if none) |
| `GET /ui/:entity/new` | `{ form }` — the create `FormModel` |
| `GET /ui/:entity/:id` | `{ detail, record }` — `DetailModel` + the redacted record |
| `POST /ui/:entity` | create → `201 { record }` (RBAC `create` + per-field write-mask) |
| `POST /ui/:entity/:id/transition` | fire a lifecycle transition → `200 { record }` (body `{ transition }`; RBAC + from-state) |
| `PATCH /ui/:entity/:id` | update → `200 { record }` (RBAC `update` + write-mask) |
| `DELETE /ui/:entity/:id` | delete → `204` (RBAC `delete`) |

`/ui/:entity` honors the list query params driven by the entity's `ListView`:
`?limit`, `?cursor`, `?sort=field&order=asc|desc`, typed filters
(`?field[op]=value`), and `?fields` projection. `dashboard` / `pivot` are
report-backed: their widgets/cells carry **executed report data**. Under a
Postgres store the aggregation is pushed down to a `GROUP BY` over the full
dataset — `--store pg` aggregates the JSONB document store, `--store pg-columns`
aggregates the typed per-entity tables — while `--store memory` runs the pure
in-memory engine over a bounded page. A field a caller can't read withholds the
report; an encrypted (`phi`/`regulated`) column can't be aggregated.

### SSR React HTML pages (`/app/...`)

| Route | Renders |
|---|---|
| `GET /app` | the app shell page |
| `GET /app/:entity` | the entity table page (sort + keyset pagination on hydrate) |
| `GET /app/:entity/kanban` | the kanban board page (drag a card → fire a transition) |
| `GET /app/:entity/calendar` | the calendar agenda page |
| `GET /app/:entity/new` | the create form page (submits `POST /ui/:entity`) |
| `GET /app/:entity/:id` | the record detail page (Edit / Delete when authorized) |
| `GET /app/:entity/:id/edit` | the edit form page (submits `PATCH /ui/:entity/:id`) |

Each `/app/...` page server-renders the **same** compiled, redacted models the
`/ui/...` API returns, as a hydratable HTML document. Appending `?__state=1` to
any `/app/*` route returns its `WebPageState` as JSON instead of HTML — the
client router fetches that for in-page navigation (see *Client interactivity*).
`map` / `dashboard` / `pivot` have JSON routes but no SSR HTML page yet (a tile
map / widget grid needs a client renderer — a deferred item).

### Static client bundle

`GET /assets/operate-web-client.js` — the browser hydration bundle, served
**before** auth (it carries no per-caller data; every model + row is redacted
before being embedded in the page). When unbuilt, the route `503`s with a notice
to run `build:client` — the SSR pages still render, they just won't hydrate.

## The redaction guarantee (headline)

The defining property of `operate-web`: **the compiled models, the data rows,
the embedded hydration state, and every write are all redaction- and
RBAC-checked per caller** before anything leaves the server.

- **Reads.** A field declared `pii` / `phi` / `regulated` / `commercial_sensitive`
  is dropped from the model entirely (the column never appears in a `TableModel`,
  the field never in a detail/form/card model) unless the caller's role has an
  explicit grant; the matching value is stripped from the row by `redactRecord`;
  and the SSR embeds only the already-redacted state, so the hydration blob can't
  carry a hidden field either. A `cashier` viewing `Product` never receives
  `unit_cost` — not in JSON, HTML, or hydration state — while a `store_manager`
  does.
- **Writes.** `POST`/`PATCH` enforce the entity-level RBAC grant (`403`) **and**
  the per-field write mask (`422` listing any field the viewer can't set — a
  read-only/redacted field, or a non-manifest key). `DELETE` enforces the delete
  grant. A transition enforces its per-transition grant + the lifecycle
  from-state (`409`). The returned record is redacted for the caller.
- **Affordances are gated, not just hidden.** The detail page's Edit/Delete
  buttons and the kanban board's drag-transitions only appear when the
  server-computed grants allow them — and the server re-checks on the request
  regardless (defense in depth).
- **Aggregate views.** A `dashboard` whose `permissions` exclude the viewer is
  withheld entirely; a report-backed widget (or a `pivot`) whose report's grant
  the viewer lacks is dropped / withheld.

Fail-closed throughout: an unknown role sees only public fields and holds no
write/transition grants. Redaction reuses the auth layer's
`computeClassifiedFieldRedaction` / `validateClassifiedWriteMask` / `rbacCheck`.

## Auth

- **API keys** (`--api-key key:role:tenant`, repeatable) — opaque tokens for
  dev / service auth, fail-closed (missing or unknown → 401). Sent as `x-api-key`
  or `Authorization: Bearer <key>`.
- **JWT / JWKS** (production) — a 3-part Bearer token is verified as an EdDSA JWT
  (signature + iss/aud/exp/nbf) and its claims become the viewer statelessly:
  scopes → roles via `scopesToRoles` (a `roles` array claim wins, else the OIDC
  `scope` string, else `scp` array, else `[]` fail-closed), `sub` → a UUID,
  tenant from the `tenant_id` claim (else `x-tenant-id`; a null tenant fails
  closed). Keys via `--jwks-key kid:base64`, `--jwks-file`, or `--jwks-url` (a
  caching, rotation-aware remote provider with an optional `--jwks-refresh-ms`
  background poller), plus `--jwt-issuer` / `--jwt-audience`.

A registered API key wins; otherwise the JWT path runs. Dev + prod auth coexist.

## Stores (`--store`)

| `--store` | Backing | Notes |
|---|---|---|
| `memory` (default) | `InMemoryEntityStore` | no PG; seed via `webServer.entityStore` |
| `pg` | `PostgresEntityStore` | JSONB document store over `meta.operate_entity_records`, tenant-RLS |
| `pg-columns` | `ColumnMappedEntityStore` | typed per-entity tables, transparent PHI encryption (pgcrypto), `ensureSchema()` on boot |

`--schema <name>` overrides the Postgres schema. The `pg` / `pg-columns` stores
read the same persisted data `operate-server` writes (standard `PG*` env vars).
The connection is closed on graceful shutdown.

## Runtimes

- **Node** — `serve(options)` boots an `http` server over `dispatch`, reads the
  request body for writes, returns a graceful-shutdown handle (closing the PG
  conn + stopping the JWKS poller).
- **Edge / Workers** — `fetchToRaw` / `rawToFetchResponse` / `createFetchHandler`
  / `buildEdgeFetchHandler` / `asModuleWorker` adapt the same `dispatch` to the
  Fetch API (reading `arrayBuffer()` for writes), yielding a Cloudflare
  `{ fetch }` default export. Edge defaults to the in-memory store (socket-less
  runtimes can't open node-postgres) and refreshes a remote JWKS lazily (no
  long-lived poller).

## Client interactivity

The client bundle `hydrateRoot`s an `AppRouter` that renders the *same*
`PageRoot` component tree the SSR did (so hydration attaches cleanly), then turns
the pages live:

- **Table** — sort-toggle columns + forward-only keyset pagination, refetching
  the read-only `/ui/:entity` JSON.
- **Forms** — the create / edit form collects its fields, coerces them to a typed
  payload, and `POST`/`PATCH`es `/ui/:entity[/:id]`; a write-mask `422` (or any
  4xx) surfaces inline; on success it navigates to the record detail.
- **Detail** — Edit link + Delete button (gated by server-computed grants);
  delete `DELETE`s and returns to the table.
- **Kanban** — draggable cards; dropping a card on a column resolves the bridging
  transition (`planCardTransition`) and `POST`s `/ui/:entity/:id/transition`,
  moving the card on success.
- **SPA routing** — internal `/app` link clicks + Back/Forward + write redirects
  fetch the target's `?__state=1` `WebPageState` and swap the page in place (no
  full reload), `pushState`-ing history. External / non-`/app` links fall through
  to the browser; with JS disabled the SSR pages still work.

Live DOM behavior (hydration, drag, navigation) is **browser-only**: the bundle
imports `react-dom/client`, so it's deliberately kept off the `pnpm -r build`
(tsc) and vitest paths. Build it separately (esbuild, `platform: browser`):

```bash
pnpm --filter @crossengin/operate-web-app build:client   # → dist/assets/operate-web-client.js
```

Until then, `/assets/operate-web-client.js` 503s and the pages render server-side
without hydrating.

## Flags

```
--pack <name>          built-in pack: erp-core | erp-retail | erp-healthcare | erp-grocery
--manifest <file>      a pre-resolved manifest JSON (exactly one of --pack/--manifest)
--port <n>             listen port (default 8788)
--store <kind>         memory (default) | pg (JSONB) | pg-columns (typed + encrypted)
--schema <name>        Postgres schema for the entity store
--api-key key:role:tenant   register an opaque API key (repeatable)
--jwks-key kid:base64  register an Ed25519 verification key (repeatable)
--jwks-file <file>     load JWKS keys from a JSON file
--jwks-url <url>       fetch JWKS from an IdP endpoint (cached, rotation-aware)
--jwks-refresh-ms <n>  background JWKS refresh interval (with --jwks-url; >=1000)
--jwt-issuer <iss>     required JWT issuer (when a JWKS is configured)
--jwt-audience <aud>   required JWT audience (when a JWKS is configured)
--help, -h  ·  --version, -v
```

`--pack` / `--manifest` are mutually exclusive (exactly one). `--jwks-key` /
`--jwks-file` / `--jwks-url` are mutually exclusive; when any is set,
`--jwt-issuer` + `--jwt-audience` are required.

## Deployment recipe

```bash
# build the client hydration bundle once (needed for live interactivity)
pnpm --filter @crossengin/operate-web-app build:client

# serve the retail pack on Node, in-memory, dev API key
operate-web --pack erp-retail --port 8788 --api-key dev:store_manager:<tenant-uuid>

# serve from Postgres (JSONB), production JWT auth against an IdP's JWKS
operate-web --pack erp-retail --store pg --port 8788 \
  --jwks-url https://idp.example.com/.well-known/jwks.json --jwks-refresh-ms 300000 \
  --jwt-issuer https://idp.example.com --jwt-audience crossengin-ui

# typed per-entity tables + at-rest PHI encryption (healthcare)
operate-web --pack erp-healthcare --store pg-columns --schema public --port 8788 \
  --api-key dev:clinician:<tenant-uuid>
```

The same server runs on the edge: `buildEdgeFetchHandler` / `asModuleWorker`
yield a Cloudflare `{ fetch }` default export over the identical `dispatch` core.

## Deferred

- **Report-data execution.** `dashboard` / `pivot` compile their *layout* (grid +
  widget descriptors / report ref + reshape flag), redaction-gated by the
  report's RBAC grant — but the report aggregation itself isn't executed; the
  routes return the descriptors, not computed widget data.
- **SSR HTML pages for `map` / `dashboard` / `pivot`.** These have JSON routes but
  no `/app/*` HTML page yet (a tile map / widget grid needs a client renderer).
- **Richer client form-state.** Forms submit + navigate, but there's no rich
  client validation / dirty-tracking beyond the server's `422`.

## Tests

Offline unit + loopback tests run over the in-memory store and stubbed fetchers
(the bundle/browser stay off the vitest path). The compiler's redaction +
fail-closed behavior is asserted per view kind; the React components + SSR markup
are tested via `react-dom/server` (no jsdom); the JWT path against real
Ed25519-signed tokens; the edge adapter against genuine `Request` / `Response`.

A **gated real-Postgres** suite (`CROSSENGIN_PG_TEST=1`, 7 cases) drives the
`/ui/...` routes + the write path + transitions over a `PostgresEntityStore` —
detail read-back, tenant isolation, per-caller redaction, keyset pagination, the
kanban board, a create→update→delete round-trip, and a place/fulfill transition,
all end-to-end against a live database.

```bash
pnpm --filter @crossengin/operate-web-app test                       # offline
CROSSENGIN_PG_TEST=1 PGHOST=… PGUSER=… PGPASSWORD=… PGDATABASE=… \
  PGSSLMODE=disable pnpm --filter @crossengin/operate-web-app test   # + gated PG
```

### Manual browser smoke (the deferred DOM behaviors)

The live hydration/drag/SPA behavior isn't exercised by the hermetic suite. To
smoke it by hand after `build:client`:

1. Boot `operate-web --pack erp-retail --api-key dev:store_manager:<uuid>`, seed a
   few `Product`s, and open `http://localhost:8788/app/Product` (wire the
   `x-api-key` header via a dev proxy / extension).
2. **Table** — click a sort button + Prev/Next; rows swap with no full reload.
3. **Create** — `/app/Product/new`, submit; you land on the new record's detail.
4. **Edit/Delete** — on a detail page, Edit (prefilled) → Save; Delete → back to
   the table. Confirm a `cashier` sees neither affordance.
5. **Kanban** — author a kanban view, drag a card between columns; it fires the
   transition and the card moves (a forbidden move surfaces an inline error).
6. **SPA** — click nav links + Back/Forward; the URL changes and the page swaps
   without a full reload (watch the network tab for `?__state=1` fetches).
