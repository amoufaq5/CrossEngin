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

---

## Addendum — the adversarial pass

Two read-only analyses ran against the commit: one aimed at every claim the increment's own code
and prose made, one asking whether the emitted document is a valid OpenAPI 3.1.0 document at all.
Between them they returned 19 findings. **Nine changed code**, and I verified every one of those
myself before acting on it — register P3.1's rule, which earns its third clause here: a correction
is exactly as liable to be wrong as the claim it replaces, and two of these were.

The validity pass is the cleanest result and is worth stating first: **zero MUST violations across
three documents**, with 33 of 33 injected violations caught by its own checker, so it is
non-vacuous. Every `$ref` resolves (1,399 occurrences, 155 distinct targets, 155 defined, no dead
components and no nested `$ref`), every templated path variable is declared `in: "path", required:
true` over 232 templated operations, all 305 `pattern` values compile under `/u`, and the whole
document round-trips `JSON.parse(JSON.stringify(…))` byte-identically with zero `undefined` across
33,455 keys. The one MUST it found reachable had **zero members in the shipped packs** and is fixed
below. The official 3.1 meta-schema still could not be *executed* — it is JSON Schema 2020-12 using
`$dynamicRef` and the only validator here is `ajv@6`, draft-07 — so the pass fetched it and
cross-checked the clause list by hand instead, which confirmed coverage and turned up one thing
worth keeping: `components.properties.schemas` carries **no key pattern**, so the
`^[a-zA-Z0-9.\-_]+$` requirement is prose-only and a schema-driven validator would not have caught
a violation of it. Checking it by hand was not redundant.

### The worst finding was this increment's own stated worst defect, in its own code

`buildOpenApiDocument`'s doc comment says a route silently missing from `paths` "is a document that
describes a different API, which is the falsely-complete direction (ADR-0337)" and that such a route
is **refused**. Three screens below it, `if (field === null) continue;` dropped a CONNECT route with
no refusal, no coverage gap and no trace. Verified: a schema-valid CONNECT route that the real
registry accepts gives **341 routes in, 340 operations out, `refused: null`**, `/v1/tunnel` absent
from `paths` and `tunnel.open` nowhere in the document.

The asymmetry was the finding rather than the drop. `wildcard_path` is refused on exactly the same
grounds — a *shape* refusal, zero members, one construction site — and this increment's own argument
for it ("the refusal has no member today, which is exactly when it is cheapest to be right") applies
without a word changed. `method_not_describable` is the third refusal, keyed on
`OPENAPI_PATH_ITEM_FIELD` answering `null` rather than on a named method, so the test is the same
one the Path Item Object imposes.

### The create schema understated the obligation, live, on every tenant's first invoice

`serverFillsOnCreate`'s settings arm read whether a settings **store** was wired.
`applySettingsDefaults` fills a currency field only when the tenant's `defaults.currency` is set and
`due_date` only when `finance.defaultPaymentTermsDays` is — so the obligation is a property of the
**tenant**, and `ResolvedStores.settingsStore` is not optional, so every deployment wires a store and
all three live fields were dropped from `required` for every tenant until its settings were
populated. Measured through the real handler on a real Postgres as the non-owner `serving` role:

| request | before | after |
|---|---|---|
| the document's `InvoiceCreate.required` | **422** `currency`, `due_date` | **201**, `invoice_number: "INV-2026-00001"` |
| that same body on a settings-populated tenant | 201 | 201 |

The members are `Invoice.currency`, `Invoice.due_date` and `Bill.due_date`. **The fix is to drop the
arm**, and the reason it cannot be repaired instead is structural: `/v1/meta/openapi` memoises one
document per compiled server and serves it to every tenant that reaches it, so a settings-dependent
`required` set is not expressible in this document at all. Overstating costs a caller nothing,
because a caller's value always wins over a default.

The sibling arm failed the other way. `if (kind === "sequence") return wiring.allocator;` sat four
lines under a comment saying `serverManaged` is "deliberately not consulted here: `validateBody`
skips such a field unconditionally, so it is never a client obligation whatever the wiring" — which
is exactly right and is what the line above it broke, on 14 of `erp-core`'s fields. Measured: a
create omitting `invoice_number` with **no** allocator wired answers 201 and stores `undefined`.

With both arms gone, `CreateWiring` had no reader and is **deleted**, and the function is renamed
`omittableOnCreate` — because the name was the cause. "Does the server fill it" and "may a client
omit it" differ in precisely the two places that went wrong, and only the second is what a request
schema's `required` array means. The document's obligation is now **139 of 395 declared**, uniformly,
and the figure is exactly *the required fields that carry no default*, which a reader can check.

### Both 401 shapes are live on one route, so the document declares both

`errorResponses()` declared `application/problem+json` + `Problem` for 401 and 403, three lines under
`problemSchema`'s own description stating the rule correctly. On an entity route both are **handler**
refusals, and `runtime.ts` preserves a handler's body verbatim — so the wire shape is
`application/json` with `{error, detail}`, the document's own `HandlerError`.

Declaring `HandlerError` instead would have been the same defect reversed, and the live run shows why
in two lines on the same path:

```
GET /v1/invoices, no credential        → 401 application/json          {"error":"tenant_required",…}
GET /v1/invoices, x-api-key: nope      → 401 application/problem+json  {"type":"…/authentication-required",…}
```

The first is the handler, the second the gateway. Both statuses now declare both media types, which
is also robust to the one configuration that moves the 403: the gateway's `forbidden` arm is gated on
`route.requiredScopes.length > 0`, and that is `[]` on every route in the workspace.

### 400 was declared on 287 operations that cannot produce one

All four of its producers in `handlers.ts` sit inside `case "list":` and the association module emits
none, so the declaration carried a false sentence — its description names a query-surface mechanism a
read, a create or a transition does not have. Measured: a read with junk query parameters answers
**200**, a delete of a missing id **404**, a failed create **422**, a unique violation **409**.
`listErrorResponses()` adds it back on the 51 list operations, where the sentence is true, and the
test that asserted it on *every* operation is replaced by one asserting it on the list operations and
nowhere else — **ADR-0372's class**, the defect written down as the specification.

### A transition name reaches a path segment, and nothing validated it

The increment claimed the render is unambiguous "by the schema rather than by convention: a literal's
value is `/^[a-zA-Z0-9._-]+$/`". The schema says so and **is parsed nowhere** — `RouteDefinitionSchema`
has two occurrences in the workspace, its own declaration and the `z.infer` beside it — so the
refinement is one nobody runs (ADR-0362's class). And it is reachable: `TransitionSchema.name` is
`z.string().min(1)` and `entityRouteSpecs` does `lit(t.name)`. On a deep copy of the real `erp-core`,
four shapes all cross-validated:

| transition name | rendered template | cost |
|---|---|---|
| `a/b` | `/v1/invoices/{id}/a/b` | a four-component template the matcher cannot serve |
| `{id}` | `/v1/invoices/{id}/{id}` | two template expressions, one Parameter Object — OAS 3.1 forbids it |
| `has space` | a raw space in a path | not a valid URI segment unencoded |
| `üñî` | unencoded non-ASCII | — |

The fix is **one level up**, in the kernel, because the broken route exists whether or not anybody
emits a document (ADR-0348's split: a property of the manifest alone is decidable by a pack author,
by `crossengin validate` and by the reviewer approving what the Architect designed). Cost measured
zero: **107 declared transitions over 59 distinct names** across the seven source packs, every one
matching, with `[a-y_]` the entire character set in use. Verified through the real CLI:

```
crossengin validate <core with transitions[0] renamed>
  "{id}"        exit=1  transition name '{id}' is not usable as a URL path segment…
  "a/b"         exit=1  transition name 'a/b' …
  "has space"   exit=1  transition name 'has space' …
  "send"        exit=0  ACCEPTED
```

The regex is a second spelling of the gateway's, pinned by a test that reads that file as text — and
the reason is **not** the cycle one would assume. Measured: neither package depends on the other, and
`api-gateway`'s entire dependency set is `config`, `testing`, `typescript`, `vitest` and `zod`. So an
import would not be cyclic; it would be a new edge from the manifest layer to the request edge, which
is backwards and would spend the one property that makes `api-gateway` embeddable.

### Five smaller ones, each with its measurement

- **A filterable field named `limit`, `cursor`, `fields`, `sort`, `order` or `q`** emitted a
  duplicate `(name, in)` pair, which OAS 3.1 forbids — and the duplicate was worse than two names
  for one thing, because `parseListQuery` tests `RESERVED_PARAMS.has(key)` on the **raw** key, so
  `?limit=5` is read as the page size and the filter is dropped with no `unserved` entry. A
  generated client keeping the second entry would send a filter value as a pagination bound. Zero
  members across the packs (375 list configs, 1,270 filterable instances) and reachable from a
  manifest, since `FIELD_NAME_REGEX` admits all six and `RESERVED_ENTITY_FIELD_NAMES` is only
  `id`/`tenant_id`. The bare form is omitted for such a field and every bracketed operator — which
  **is** served — says so.
- **Six operations declared only their denials**, including this document's own route, so the
  document could not describe its own success response and hid its non-default media type. Not a
  spec violation (the MUST is "at least one response") but a real generator defect, and
  falsely-*in*complete rather than falsely-complete, which is why it is a declared gap
  (`undeclared_success_response`, naming the set) rather than a refusal. `meta.openapi.read` gets
  its real 200, because it is the one of the six whose response this module owns.
- **The published `bearer_jwt` description claimed `nbf` is required and relaxable by name.**
  `REQUIRED_JWT_CLAIM_COSTS` is keyed on `exp | iss | aud`, and `--jwt-optional-claim nbf` is
  refused **by name** in `cli.ts` with its reason. A false security statement in client-facing
  prose, contradicted by an explicit refusal in the same repository, copied from
  `AUTH_SCHEME_SUPPORT.bearer_jwt.reason` — which carried it too and is corrected with it, so what
  was an internal inaccuracy did not become a published one. `nbf` **is** checked when present, so
  the description says that instead. This was the one finding **nothing caught** in the first
  mutation pass, and it now has a fence in `api-gateway-runtime`, the package where both facts are
  visible.
- **`per_tenant_surface` had no producer** — one occurrence, its own enum member, which is this
  repository's most-found class, committed in the increment that named it — **and**
  `openApiCoverage` was dropped at the per-tenant `buildOperateHttpServer` call site, so a tenant's
  own gateway served a document declaring none of the five out-of-registry paths, the login among
  them. The two halves are one fix: the per-tenant site forwards the thunk and declares the gap,
  which gives the enum member the producer it never had. The drop was safe in *direction* — the
  generic `surface_outside_registry` gap still fires, which is what `compile.ts`'s "the drop cannot
  lie" argument buys — and was still a capability loss on the one serving path where coverage is
  weakest. ADR-0386's and ADR-0391's class, for the third time, in the increment that cites them.
- **The list response's `page` omitted `limit` and was not required.** The real response is
  `page: {"limit":100,"nextCursor":null}` and `page` is always present, so a client branching on
  `page === undefined` would be writing a branch the server never takes.

### Two claims corrected, and the figures re-derived

`FIELD_REQUEST_SCHEMAS`' justification listed the over-precise `"10.555"` among what a
`decimal(10,2)` accepts. It is a **422** — `precision: amount must have at most 2 decimal place(s)`
— and `validation.ts`'s own comment states the rule that a client literal carrying more precision
than the field holds is refused rather than rounded. What the draft conflated is that
`toDecimalWire` *would* render `"10.56"` for it: what the converter can emit is not what a request
may send. The other three examples reproduce exactly, so the two-map decision stands on them.

`serverFillsOnCreate`'s own doc said "only ~139 [of 630] carry no default at all". 139 is the
**required**-and-no-default count; the 630-scoped figure is **374**. And the `$ref`-dedupe refusal
cited "70 KiB = 7.7%" where the saving re-measured on this document is **73.7 KiB = 7.8%** — the
factor is 2.21 on every measurement and the refusal rests on "a second place a reader must look for
an 8% saving", which holds at any of the three, but a refusal argued from a measurement should not
understate what it refuses.

The byte figures moved because the document grew (two media types per denial, a longer complement
note, the document's own response). Re-measured per pack: core **948.4 KiB / 338 routes**, retail
997.2 / 352, healthcare 1008.5 / 357, grocery **1033.4 / 365** (the widest), construction 963.8 /
343, education 1000.4 / 357, government 1003.5 / 357 — zero refusals and zero undescribable fields
on all seven. And the route-count denominators are two configurations rather than a contradiction:
334 `routeSpecs` against the registry's **338** on a bare compile, and against the shipped compose's
**375**, because `routeSpecs` is manifest-derived and does not grow with a flag. Both sites now say
which deployment they mean.

### What the pass did not refute

Thirteen figures reproduce exactly (630 / 426 / 395 / 204; 375 entities, 243 with no sortable field,
23 with no searchable, 0 `duration`; 2,006 parameter objects; 155 schemas; the 2.21 dedupe factor;
both named `limit`-parser divergences; `routeSpecs` a strict subset with 0 orphans). The transition
route taking no body is confirmed against the real handler — `POST invoice.send` with
`{state:"HACKED", invoice_number:"OVERWRITTEN"}` answers 200 with the state the workflow declares
and the number untouched — so emitting no `requestBody` is right. `entitySchemas` reading
`resolvedFields` is confirmed as one aperture with no second read. Both implemented refusals are
confirmed empty on the real route sets, and `pathTemplateCollisions`' anonymisation is confirmed as
OAS 3.1's path-template equivalence rule correctly applied.

### Live verification

Against the throwaway PG 16.13 cluster as the non-owner `serving` role, through the real binary at
`--pack erp-core --store pg --credential-login`:

| check | result |
|---|---|
| boot line | `describing 341 of 341 registered routes; 5 served path(s) sit outside every route registry` |
| `GET /v1/meta/openapi` | **200**, `content-type: application/openapi+json;version=3.1.0`, 975,031 bytes, 187 paths / 341 operations / 155 schemas |
| its own 200 | declared, content key `application/openapi+json;version=3.1.0` |
| 401 + 403 content | both media types on **341 of 341** operations, 0 wrong |
| 400 | on **51** list operations, **0** elsewhere, 0 list operations missing it |
| success-response gap | names the 6 spec-less routes; `meta.openapi.read` correctly absent from the no-2xx set |
| `page` | `{limit: integer, nextCursor: [string,null]}`, both required, `page` required |
| `InvoiceCreate.required` | `[account_id, currency, due_date, issue_date]` |
| create with that body | **201**, `invoice_number` server-allocated |
| create with the pre-fix body | **422** naming `currency` and `due_date` |
| `bearerAuth.description` | `…then exp, iss and aud — each required… A \`nbf\` claim is honoured when present and is never required.` |

**Thirteen mutations, thirteen caught**, each reversed by the same string replacement that made it
after asserting the mutation was present: the CONNECT refusal removed; the settings arm restored;
the sequence arm made wiring-dependent again; 400 restored everywhere; `problem+json` alone on
401/403; `page.limit` dropped; the shadowed bare filter re-emitted; the success-response gap
removed; the transition-name refusal removed; its regex widened to admit a brace; `nbf` restored as
required-and-relaxable; `nbf` dropped entirely; and the per-tenant `openApiCoverage` dropped.

### What this leaves

| Question | Owner | Deadline |
|---|---|---|
| `undeclared_success_response` names six routes and describes none. Four are `operate-server`'s own and their shapes are known — closing it means either a second spec kind for a non-entity route or hand-written response schemas at the registration site. | Platform | 2026-12-15 |
| The `x-crossengin-coverage` array carries `surface_outside_registry` **six times** on a real boot — once generically from the emitter, five times from `coverageFromMountedSurfaces`, one per mounted path. That is by design (the generic entry explains the class, the five name the members) and it reads as duplication. A `members` field on one gap would be cleaner and is a contract change. | Platform | _N/A_ |
| A general `RouteDefinitionSchema` parse at registration, which would make the literal-segment regex true of every producer rather than of the one that takes a name from a manifest. `routes.register` is on the hot path of nothing, so the cost is a boot-time parse per route. | Platform | 2026-12-15 |
| The `in` filter's description no longer promises the repeated-parameter spelling its `{type: "string"}` schema forbids, which understates the server by one equivalent form. Emitting `{type: "array", items: …}` for that one arm would need `style`/`explode` stated and is the alternative. | Platform | _N/A_ |
| With no allocator wired, a `sequence`-defaulted field is created as `undefined` and **nothing refuses it** — the document is now honest about not requiring it, and the record is still written without the number its own uniqueness declaration is about. | Platform | 2026-12-15 |
