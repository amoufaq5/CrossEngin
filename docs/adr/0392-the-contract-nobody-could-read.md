# ADR-0392: The contract nobody could read

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-30 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0288, ADR-0301, ADR-0307, ADR-0314, ADR-0334, ADR-0337, ADR-0338, ADR-0345, ADR-0348, ADR-0357, ADR-0359, ADR-0361, ADR-0367, ADR-0384, ADR-0386, ADR-0391 |

## Context

This platform serves 341 HTTP routes derived from a manifest and **described nowhere**. There is no
OpenAPI document, no JSON Schema, no published contract of any kind: a client integrating against
it reads TypeScript or guesses. The register's P1.17 names it as *"the cheapest high-leverage
piece, derivable from `CompiledOperateServer.routeSpecs`"*.

**That remedy is refuted, and the entry is this register's own wrong-when-written class.** Measured
against the committed tree:

| Source | Count |
|---|---|
| `CompiledOperateServer.routeSpecs` | 334 |
| `InMemoryRouteRegistry.list()`, bare compile | 338 |
| the same, `--store pg` | 340 |
| the same, plus `--credential-login` | 341 |
| paths served **outside every registry** | 5 |

`routeSpecs` is a strict subset of the registry, missing the meta routes and every injected
`extraRoutes` entry. A document derived from it would omit 7 of 341 routes **with no refusal and no
note** — the falsely-complete direction (ADR-0337), in a document whose entire job is to be the
account of what is served.

The class matters because the remedy differs, and it is **wrong when written** rather than
correct-then-drifted: `git log -S"no OpenAPI" -- CLAUDE.md` puts the register entry in `2b98f46`
(2026-10-13), while `git log -S"InMemoryRouteRegistry" -- packages/operate-runtime/src/compile.ts`
puts the wider source in `3ed174e` (2026-08-11) — an ancestor, two months earlier, confirmed with
`git merge-base --is-ancestor`. So the thing the entry should have named already existed when it
named the narrower one. That wants re-measurement discipline, not anchoring by heading.

**And the first correction to it was also incomplete**, which is register P3.1's clause about
aiming a refuter at the corrections, landing on the author. Saying "the complete enumeration already
exists: `InMemoryRouteRegistry.list()`" is false by five: three interceptor wrappers in `node.ts`
and one `WebhookRoute` matched inside `OperateHttpServer.dispatch` serve `/health`, `/readyz`,
`POST /v1/auth/token`, the bounce webhook and the Stripe webhook, and **none of them is in any
registry, any matcher or any handler map**. One of those five is the **login** — the first route any
client calls.

Three more facts shaped the work and each was measured before it was designed against.

**The aperture is the trap** (ADR-0361's class, one layer out). An entity's own `fields` is not the
set its table has: across `erp-core`'s 51 entities, `entity.fields` totals **426** and
`resolvedFields` **630**, and **51 of 51 entities differ** — the 204 difference being exactly
51 × 4 `auditable` trait fields. `ui-schema.ts` reads the narrow set, which is why
`created_at`/`updated_at` reach no view while the API response carries them. A document built over
`entity.fields` would be wrong about every entity in the pack.

**A create request's obligations are overstated 2.9x by the manifest alone.** Of 630 resolved
fields, 395 are `required` — and of those, only **136** must be supplied by the caller under any
wiring. **242** are filled by the server whatever the deployment, and **17** depend on whether a
settings store and a sequence allocator are wired. 395 / 136 = **2.90**. So the honest `required`
set is a property of the manifest **and** the deployment, and a document ignoring that would promise
a server-filled field on a deployment that cannot fill it.

*(An earlier draft of this paragraph said "153 are filled by no wiring and 136 are filled whatever
the deployment" — a figure carried from a prior session's notes with its labels transposed and its
first number wrong. Both halves were refuted by re-running `serverFillsOnCreate` over the real pack
at both wiring extremes. The 2.9x conclusion survives because it is 395/136 either way, which is
the shape register P3.1 keeps finding: the reasoning outlives the figures, so the figures have to
be measured rather than quoted.)*

**Publishing the document discloses strictly less than a route already serves.**
`GET /v1/meta/schema` is registered ungated and serves every authenticated principal a `UiSchema`
carrying per-entity role lists with no per-role filtering. So the comparison, not caution, settles
the authorization.

## Decision

**Emit an OpenAPI 3.1 document from the deployment's own route registry, read at request time, and
serve it at `GET /v1/meta/openapi`.**

Four decisions carry it.

**1. The registry, read through a thunk, and never a snapshot.** `openapi.read` is registered inside
`compileOperateServer` beside `meta.schema.read`, and its handler closes over a `describe()` thunk
that calls `routes.list()` on the **first request**. That makes registration order irrelevant *by
construction*: `extraRoutes` are registered forty lines below, and on a `pg` deployment those are
3 of 341 routes, which a snapshot taken at registration would omit silently. The result is memoised,
so the 915 KiB assembly happens once and never per request. Each per-tenant compiled server
(ADR-0314) answers from its own registry, so the boot/tenant divergence is structurally impossible
rather than checked.

**2. Report a declared structural absence; refuse a renderable-route failure.** A fact the format
cannot carry — which role may call an operation — is an `x-crossengin-coverage` gap carrying its
`reach`, borrowed from `pg-unreachable-stores.ts` because that is the distinction deciding what the
next reader should do (`ordering` closes by wiring, `shape` by a format change or not at all). A
*route* that cannot be rendered is a **500 refusal naming the operation ids**, because a route
silently absent from `paths` is a document describing a different API. Both refusals are measured
**empty** across all seven packs at both flag sets, so refusing breaks nothing that worked
(ADR-0338's rule).

**The collision refusal is empty today and reachable from a manifest**, which is what makes it worth
having rather than dead weight — and the reachable member is not hypothetical. An entity named
`Notification` with a lifecycle transition named `read` derives
`POST /v1/notifications/{id}/read`, which collides under OpenAPI's path-template equivalence with
the read-state route's `POST /v1/notifications/{dispatchId}/read`. Verified by hand: the two *named*
templates differ, the anonymised ones are both `POST /v1/notifications/{}/read`, and
`buildOpenApiDocument` refuses naming both operation ids. **The shipped compose mounts the
read-state half**, so a tenant whose Architect designs that entity trips it — and when it trips, it
surfaces a live matcher defect the document did not create: `InMemoryRouteRegistry.lookup` returns
the first match, so the entity route is served and `notifications.read_state.mark` stays registered
and **unreachable**. Measured over the real route sets, there are **zero** collisions at both the
shipped flag set (375 routes over 218 distinct templates) and the maximal one (421 over 262).

Both refusals are measured empty across **all seven resolved packs**, which is the licence for
refusing rather than reporting:

| pack | entities | routes | wildcards | collisions | undescribable fields | document |
|---|---|---|---|---|---|---|
| core | 51 | 338 | 0 | 0 | 0 | 916.6 KiB |
| retail | 54 | 352 | 0 | 0 | 0 | 963.5 KiB |
| healthcare | 54 | 357 | 0 | 0 | 0 | 975.0 KiB |
| grocery | 56 | 365 | 0 | 0 | 0 | 998.5 KiB |
| construction | 52 | 343 | 0 | 0 | 0 | 931.4 KiB |
| education | 54 | 357 | 0 | 0 | 0 | 966.9 KiB |
| government | 54 | 357 | 0 | 0 | 0 | 969.9 KiB |

**3. The security schemes are derived from `AUTH_SCHEME_SECURITY_DOC`**, a total map over
`AuthScheme` to a scheme object or `null`, fenced against `AUTH_SCHEME_SUPPORT`'s treatment in both
directions. The two halves fail oppositely and the dangerous one is the second: a served scheme with
no entry is a credential no client is told about, while a **refused** scheme *with* an entry is a
`securitySchemes` **definition** — which a generator reads as supported and emits a client method
for — so publishing one for `api_key_query` would invite exactly the request ADR-0384 refuses, in
the document that exists to describe the refusal.

**4. Nine query parameters per filterable field, enumerated.** The bare `eq` shorthand plus one per
`FILTER_OPS` member, because `parseListQuery` reads exactly that grammar, and because OpenAPI
forbids two parameters sharing `(name, in)` so a `deepObject` named `filter` cannot coexist with the
bare form — and would describe a surface the server does not serve.

## Alternatives considered

- **Option A: derive from `CompiledOperateServer.routeSpecs`, as the register prescribes.**
  - **Pros:** carries the entity attribution and the `ListConfig`, which the registry does not.
  - **Cons:** 334 of 341 routes, silently.
  - **Why not:** refuted by measurement. It is taken as a *second* input for the two things only it
    carries, and the registry is the route set.

- **Option B: snapshot `routes.list()` at registration time.**
  - **Pros:** no thunk, no memo, one less moving part.
  - **Cons:** omits every route registered after this one, with no refusal.
  - **Why not:** measured at 3 routes on a `pg` deployment and 7 against `routeSpecs`. It would also
    make correctness a property of *where* the registration sits in a 1,100-line function —
    invisible at the call site, and exactly the kind of ordering constraint this repo has been wrong
    about before.

- **Option C: a `deepObject` `filter` parameter instead of the enumeration.**
  - **Pros:** 1 parameter per list operation instead of ~35; a far smaller document.
  - **Cons:** describes `?filter[tax_id][gt]=x`, which the server does not read.
  - **Why not:** **wrong**, not merely lossy. `parseFilterKey` reads `?tax_id[gt]=x`, so a generated
    client would emit requests this API ignores — and ignoring a filter *widens* the answer to the
    rows the caller asked to exclude (ADR-0359), under a 200.

- **Option D: drop the eight bracketed operators and declare only the bare form, naming the bracket
  grammar in prose.**
  - **Pros:** saves ~1,300 parameter objects and most of the 309 KiB they cost.
  - **Cons:** a generated client cannot express `gt`, `in` or `contains` at all.
  - **Why not:** the document would describe strictly less than the service, which is the safe
    direction but loses the capability for every machine reader — and a machine-readable document
    whose grammar lives in prose is not machine-readable. Refused on the size measurement below
    rather than on taste.

- **Option E: `components/parameters` with `$ref` dedupe.**
  - **Pros:** same content, fewer bytes.
  - **Cons:** a second place a reader must look.
  - **Why not:** **refused on measurement.** 2,006 parameter objects reduce to 906 distinct — a
    dedupe factor of **2.21**, saving 70 KiB, which is **7.7%** of the document. Noise against
    915 KiB for a structural complication. The measurement also confirmed something from the other
    direction: the most-repeated object is the `{"name":"id","in":"path"}` path parameter (×232),
    not a filter, and `limit` repeats ×46 rather than ×51 — so five list operations carry a
    different `maxLimit` and `limit` genuinely cannot be shared, which is the same conclusion
    `openapi-list-params.ts` reached from the two parsers' disagreement.

- **Option F: publish the document without a credential, as many APIs do.**
  - **Pros:** a client can read the contract before it has a key.
  - **Cons:** names every entity and field of the manifest.
  - **Why not:** under per-tenant manifests (ADR-0314) that is a tenant's own business model. The
    deciding fact is the comparison rather than the risk: `meta.schema.read` sits beside it, is
    already served to every authenticated principal, and discloses **more**. Treating the weaker
    surface differently would be a distinction neither surface supports.

- **Option G: thread the out-of-registry enumeration as a value rather than a thunk.**
  - **Pros:** an ordinary option.
  - **Cons:** three of the four mounts run *after* `buildOperateHttpServer` returns
    (`node.ts:4852`, `:4973`, `:5015` against `:3863`), so a value could only be computed from the
    flags a second time — and two of those conditions are compound.
  - **Why not:** a re-derivation is where the declaration and the mount drift. A thunk over a set
    each mount site adds itself to keeps them one fact. **Proven live:** the gap count moved 4 → 5
    when `--credential-login` was added, and that mount is one of the three.

## Consequences

- **Positive.** The API has a machine-readable contract for the first time, derived from the
  deployment that serves it rather than hand-written. `info.version` is the manifest hash, so it
  moves exactly when the described contract does. Every registered route is described or the
  document is refused — verified in both directions, live, at 341 of 341.
- **Positive, incidentally.** `served-surface.ts` gains two real callers (the document's coverage and
  the boot survey), closing a callerless module that commit `b330f92` — this increment's own —
  created. And `x-api-key` has one spelling: it was a bare literal in the request path plus a prose
  copy in `AUTH_SCHEME_SUPPORT`, so a document would have been the third.
- **Negative.** 942,326 bytes on the wire, 2,006 parameter objects, with `payment.list` carrying 87
  parameters. That is in range for a real published API (Stripe's is ~6 MB, GitHub's ~10 MB) but it
  is not small, and a Swagger UI over it will be slow.
- **Negative.** The memo is **per compiled server**, so under per-tenant manifests a deployment
  holds roughly a megabyte per tenant *that has fetched its own document* — not per tenant, because
  the memo is populated on first request and a tenant that never asks never pays. That is the lazy
  half doing real work rather than an accident, and it is the cost of the alternative being a
  915 KiB assembly on every poll. It is bounded by whatever evicts a tenant's gateway and is not
  separately reclaimable.
- **Negative.** The document cannot say which role may call an operation, which is the single thing
  a client most wants after the path. `RouteDefinition` carries no role field and `requiredScopes` is
  `[]` on every route in the workspace, so the facts are in the manifest's `permissions` and reach
  `rbacCheck` inside each handler without passing the registry. Declared as `ordering`, because the
  facts exist and this emitter is not given them.
- **Negative.** Five served paths are declared rather than described, including the login. A client
  reading the document learns `POST /v1/auth/token` exists, where it is, and what mounts it — and not
  its request body.
- **Neutral.** `OperateRuntimeOptions` gains one option and `BuildOperateHttpServerOptions` one, on
  a forwarding-literal hop of exactly the shape ADR-0386 and ADR-0391 each found a field dropped
  from. The field is designed so the drop **cannot lie**: the emitter declares
  `surface_outside_registry` generically whatever the option carries, so forgetting it degrades the
  document to a weaker true statement. ADR-0391's `server.test.ts` fence covers the hop anyway, since
  it is over the intersection of the two interfaces' field names.
- **Reversibility.** High. Deleting the route and the three modules leaves the registry, the
  manifest and every handler untouched. The two gateway additions (`API_KEY_HEADER`,
  `AUTH_SCHEME_SECURITY_DOC`) are independently useful and would survive.

## Implementation notes

**Four modules and one route.**

- `packages/api-gateway/src/routes.ts` — `renderPathTemplate(segments, grammar)` over
  `PATH_SEGMENT_RENDER`, a total map from grammar to segment kind to `rendered`/`refused`; `openapi`
  refuses `wildcard` because a path variable matches one segment and a wildcard matches any number.
  `pathTemplateCollisions` anonymises `{x}` → `{}`, because OpenAPI treats two templates differing
  only in a variable's name as the same path while `matchRoute` separates them by registration
  order. `OPENAPI_PATH_ITEM_FIELD` is a total map over `HttpMethod` with `CONNECT → null`, the Path
  Item Object having no field for it.
- `packages/operate-runtime/src/openapi-schema.ts` — `entitySchemas(entity, traits, wiring)` over
  **`resolvedFields`**, producing a response, create and update schema per entity.
  `serverFillsOnCreate(field, wiring)` takes the wiring and not the field alone, for the 2.9x reason
  above. `UNDESCRIBABLE_FIELD_KINDS` has one member, `duration`, and it is a **shape** answer: its
  wire type is undecided on purpose (ADR-0334), so inventing one would be the document deciding a
  question four ADRs left open. Measured zero `duration` fields across all seven packs.
- `packages/operate-runtime/src/openapi-list-params.ts` — the query grammar, with the four shapes
  that are forced rather than chosen recorded at the site.
- `packages/operate-runtime/src/openapi.ts` — the assembler, and
  `openapi-handler.ts` — the thunk, the memo and the 401 backstop.

**`OPENAPI_PATH_SEGMENTS` / `OPENAPI_PATH` / `OPENAPI_OPERATION_ID` are one spelling each.** The path
was briefly a `["v1","meta","openapi"]` array in `compile.ts` and a `/v1/meta/openapi` string in
`node.ts`'s boot line, which is the same second-spelling shape this increment had already fixed once
for `x-api-key` — caught by a `TS2304` rather than by looking.

**`auditOutOfRegistrySurfaces` is deliberately not called at boot.** It compares the declaration
against the mounting source *as text*, and the source is not shipped: in the built output
`import.meta.url` names `dist/node.js`, so a boot-time call would read the compiler's rendering of
`node.ts` and report drift on a correct deployment. It is a test fence, and
`served-surface.test.ts` already reads the real `node.ts` and `server.ts` from disk for it. The
first draft of the boot survey called it and was wrong.

**The media type is supplied and the adapter was checked.** `outgoingResponseFromJson` fills
`content-type` **only when absent**, so `application/openapi+json;version=3.1.0` survives — verified
on the wire. A second header set would have been silently discarded.

**Verified live** as the non-owner `serving` role on PostgreSQL 16.13, through the real binary and
real HTTP, at **the shipped compose's own 22-flag set** (`--pack erp-core --store pg
--platform-admin --platform-user-routes --idempotency-store pg --credential-login --ai-design
--require-design-review --notification-drain-ms --read-state-routes --tenant-status-gate`, …):

| Check | Result |
|---|---|
| anonymous `GET /v1/meta/openapi` | **401** `credential_required` |
| with `x-api-key` | **200**, `application/openapi+json;version=3.1.0`, 990,514 bytes |
| boot line | `describing 376 of 376 registered routes; 5 served path(s) sit outside every route registry` |
| paths / operations / schemas | 219 / 376 (all unique) / 155 |
| registry routes absent from the document | **0** |
| document operations absent from the registry | **0** |
| `$ref`s / unresolved | 155 / **0** |
| duplicate `(name, in)` within an operation | **0** |
| path variables not declared as a `path` parameter | **0** |
| the document describes itself | yes (`meta.openapi.read`) |
| `components.securitySchemes` | `{bearerAuth: {type:"http",scheme:"bearer"}, apiKeyAuth: {type:"apiKey",in:"header",name:"x-api-key"}}` |
| `security` | `[{bearerAuth:[]},{apiKeyAuth:[]}]` — OpenAPI's OR, not one AND object |
| coverage gaps | 3 generic + 5 named `(method, path)` pairs, including `POST /v1/auth/token` |

**376 is 375 + the document's own route**, which independently confirms the 375 figure measured for
the shipped flag set by a different method. The last three structural rows are the three OpenAPI
clauses most likely to be violated by a derived document, and all three are clean.

The thunk's proof is the gap count on a narrower invocation: with only the health interceptor up it
is **4**, and `--credential-login` takes it to **5** — and that mount is at `node.ts:4973`, after
`buildOperateHttpServer` returned at `:3863`.

**The per-tenant caveat is live on the shipped compose rather than hypothetical**:
`cli.ts:2138` is `perTenantManifests: perTenantManifests || aiDesign` and the compose passes
`--ai-design`, so the boot line reads *"per-tenant manifests are served from their own registries,
which this document does not enumerate"* on every shipped deployment. The document describes the
boot manifest and says so.

**This increment pushed a red typecheck and did not notice for four commits**, which is the process
failure worth recording above any of the code. `packages/api-gateway/src/routes.test.ts` assigned a
`readonly PathSegment[]` into `RouteDefinition.pathSegments`, which `z.array()` infers **mutable**,
so `pnpm --filter @crossengin/api-gateway typecheck` exited 2 at `5f4b46c` while
`pnpm --filter @crossengin/api-gateway test` was green on all 33 of that file's tests — ADR-0307's
split verbatim, because vitest transpiles through esbuild and never typechecks. Two reasons nothing
caught it: the pre-commit hook deliberately runs only `pnpm --filter @crossengin/testing test`, so
it cannot see a typecheck failure in another package; and CI's `pnpm -r typecheck` (ADR-0382) is the
thing that *would* have, so this branch's CI was red from that commit until this one. The rule is
already in CLAUDE.md and was not followed: **run both, per package, before committing.**

**A second spelling of `x-api-key` survived in the request path**, found by the same review and not
by the fix: `apps/operate-server/src/tenant-gateway-cache.ts:30`'s `requestToken()` hardcoded it,
and that site decides **which tenant's gateway serves the request**. So the claim that the request
path reads the constant held for `api-gateway-runtime` and not for `operate-server`. Fixed; the
three remaining occurrences in the workspace are each independent by design (Anthropic's own
outbound header, a redaction denylist of header names, and the out-of-workspace dev demo).

**Four of this increment's own doc-comment claims were refuted by its own review**, and two of them
misled in the dangerous direction. Register P3.1's clause about aiming a refuter at the corrections,
landing on the author twice over:

- *"recognised and refused at pipeline stage 4/5, **seven stages before** `match_route`"* — the
  stages are right and the distance is not. `PIPELINE_STAGES` has 17 members with
  `parse_auth_credential` at index 3, `authenticate` at 4 and `match_route` at 6, so the gap is
  **3 and 2** stages. Seven before index 6 is index −1. `match_route`'s own 1-based ordinal
  transposed into a distance.
- **`LIST_PARAMETER_COMPLEMENT_NOTE` enumerated three outcomes and there are four.** `?q=term` on
  an entity declaring no searchable field is a **400 `search_not_served`** — and this operation
  omits `q` from its parameter list for exactly those entities, while `q` is **not a field**, so the
  note's own first rule ("a name this entity does not declare as a field is ignored") told such a
  reader the omission meant it was ignored. Live on `erp-core`'s `BomLine`, `PriceListItem` and
  `ExchangeRate`. **The note written to stop a document's silence reading as permission had the same
  defect it names**, which is the sharpest thing the review found.
- *"An unsortable `?sort` falls back to the **declared default order**"* — true for a minority.
  `defaultSort` is `[]` on **34 of `erp-core`'s 51** list configs (243 of 375 across the packs), so
  there is no declared order and the store's own is served. That is the same majority the paragraph
  above it cites as the reason *not* to refuse an unsortable sort, which is what made the slip easy.
- *"the two parsers disagree on 6 of 14 probed inputs"* — unverifiable as stated, the probe set
  being named nowhere, and **understating** it: 8 of 18 with both bounds held equal so only the
  parser can differ, and 14 of 18 against the real `Invoice` config. Both named examples reproduce
  exactly.

All four are corrected at their sites with the measurement. **The two tests that found them had
pinned the defects as the intended behaviour** — `expect(NOTE).not.toContain("search_not_served")` —
so fixing the prose broke them, which is ADR-0372's class arriving inside the review that produced
it; both are inverted into fences.

**The security scheme objects were invalid before review.** The first draft typed them
`Record<string, JsonSchema>` and emitted `{"type":"object","description":"..."}` — a valid JSON
Schema and an **invalid** OpenAPI Security Scheme Object, `object` not being one of the five legal
`type` values. So the document would have been unparseable at the one key describing its own
authentication, which is the falsely-true direction in the increment whose subject is a
falsely-complete document. The fix moved the map into `api-gateway` beside `AUTH_SCHEME_SUPPORT`,
where the correspondence is a compile-time obligation rather than two packages' worth of distance.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Describe the five out-of-registry surfaces' bodies rather than only declaring them. All five carry `describable: true`, and the login is the one a client cannot work without. | Platform | 2026-12-15 |
| Which role may call an operation. Needs either a role field on `RouteDefinition` or the emitter given the manifest's `permissions` index — the second is cheap and is probably right, since the index already exists for the write mask. | Platform | 2026-12-15 |
| A per-tenant deployment's document describes the boot manifest and says so. Enumerating the N tenant registries means enumerating tenants, which no surface does. | Platform | _N/A_ |
| **No OpenAPI 3.1 validator ran.** There is none in the workspace (`ajv` is transitive at 6.x, draft-07) and adding a dependency was not authorised, so the document is checked by hand — the three clauses a derived document is most likely to violate (every `$ref` resolves, `(name, in)` unique per operation, every path variable declared as a `path` parameter) are all **0 violations** live at the shipped flag set, and the rest of the specification is unchecked. A real validator in CI is the follow-up. | Platform | 2026-12-15 |
| `json()` is spelled three times in `operate-runtime` (`handlers.ts`, `ui-schema.ts`, `openapi-handler.ts`). Deliberate — there is no *fact* in a two-line response builder that two copies could disagree about — but it is three. | Platform | _N/A_ |

## References

- OpenAPI Specification 3.1.0 — Paths Object, Parameter Object, Security Scheme Object, Reference
  Object.
- RFC 9457 (Problem Details), which this API emits for gateway denials and **not** for handler
  refusals — the document says so, because RFC 9457 is the minority error shape here.
- ADR-0337 (a falsely-true control is the compliance failure), ADR-0338 (refusing breaks nothing
  that was right), ADR-0359 (which-rows versus order), ADR-0361 (the aperture class), ADR-0384
  (`AUTH_SCHEME_SUPPORT`), ADR-0386 and ADR-0391 (a field dropped from a forwarding literal).
