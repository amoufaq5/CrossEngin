# ADR-0359: A surface that cannot be served is ignored rather than refused

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0091, ADR-0288, ADR-0307, ADR-0314, ADR-0322, ADR-0334, ADR-0338, ADR-0340, ADR-0345, ADR-0349, ADR-0357 |

## Context

The register ADR-0357 wrote ranks three items under one sentence each. They turn out to be one
class with six members, and the class is written down in the repository's own prose, in the
doc comment on the function at the centre of it:

> Unknown / non-filterable params are ignored, so **an arbitrary query can't widen the result set**.
>
> — `packages/operate-runtime/src/list-query.ts`, `parseListQuery`

That sentence is true of the *surface* and **exactly backwards about the answer**. A caller cannot
filter on a column the manifest did not expose — correct. But ignoring `?tax_id=X` returns every
vendor, which is precisely the rows the caller asked to *exclude*, under a 200 indistinguishable
from a response where the filter had applied. Two readings of "widen", and the response is wrong in
the one the comment does not address.

The same shape is in five more places, and two of them are live on a shipped pack.

### 1. A filter on a column the store cannot compare

`ColumnMappedEntityStore`'s adapter answered `columnExpr → null` for an `encryptAtRest` column
(`column-store.ts:281`), `filterPredicate` propagated the null, and `buildListSql` dropped the
predicate with no record of having done so. The `WHERE` clause was then `"tenant_id" = $1` alone.

Measured across the seven resolved packs, **two (entity, encrypted field) pairs are reachable
through a declared query surface**: `Patient.mrn` is filterable, sortable **and** searchable on
`erp-healthcare`'s own list view, and `Observation.value_text` is searchable. So on
`--store pg-columns` + `erp-healthcare`, `GET /v1/patients?mrn=MRN-1` was the first page of **every
patient**, 200, which a caller and the UI alike read as a search result.

The repository's own test pinned this as a feature. Its title was *"excludes encrypted columns from
filter + sort (can't order ciphertext)"* and its last assertion was
`expect(sel.params).toEqual([TENANT, 6]); // no filter bound for mrn`. The premise is true —
`pgp_sym_encrypt` is non-deterministic, so there is nothing to compare in SQL — and the conclusion
is wrong, because excluding a filter does not narrow the answer, it widens it.

### 2. The same `null`, two more meanings, and two stores answering oppositely

`columnExpr` returned `null` for `m === undefined` as well, and that arm had a live member in a
different pack with no encryption involved at all.

`erp-construction` replaces core's manufacturing `WorkOrder` with a subcontractor order whose state
column is `status`; core's inherited `work_order_lifecycle` still named `state`. Nothing caught it:
`stateField` was `z.string().min(1)` and the only check on an `entityLifecycle` was that its
*entity* resolves. `withLifecycleStateFilter` then adds the state field to `filterableFields`
**unconditionally**, so `state` became a filterable column of an entity that has no such field.

The two Postgres stores answer that one request **oppositely**:

| store | `GET /v1/work-orders?state=draft` |
|---|---|
| `pg-columns` | no column → predicate dropped → **every row**, 200 |
| `pg` (JSONB) | `document ->> 'state' = $1` → NULL → **no rows**, 200 |

Neither is an error, and `store-parity.test.ts` declares no encrypted field, which is why neither
was ever compared.

### 3. `?q` at an entity with no searchable field

The same comment, one surface over: *"Ignored when the entity has no searchable fields, so an
arbitrary `?q` can't widen the result set."* An ignored `?q` matches every row.

### 4. The seek read a different key's cursor component

`seekPredicate` filtered the sort list to the keys the store can express and then indexed
`cursor.k` **by the filtered position**, while `keysetOf` renders one component per *declared* key.
So with `?sort=mrn,family_name` on the column store the seek compared the cursor's `mrn` value
against `family_name`, and page two returned rows from an arbitrary position. Not reachable through
a route today — `parseListQuery` takes one sort key and no shipped view declares a multi-key
default — and wrong independently of its caller.

### 5. The dispatch stage's error mapping is inverted

`runtime.ts:819` turned every handler throw into `gatewayTimeout({reason: err.message.slice(0,480)})`:
a **504**, which clients retry by convention, carrying the message to the client while the recorded
`StageResult.reason` was the bare constant `"handler_threw"`. Three defects, and the register named
two of them; the third is the sharpest. `StageResultSchema.reason` is `z.string().max(500)` — which
is what a 480-character slice is sized for — so the slice was applied to the one string that never
reached the record. The operator's row said nothing about why and the anonymous caller got
everything.

The register was wrong in four ways here, each corrected by measurement:

- It is **not** "every exception". All four write ops route through `writeTxn`, which returns
  `json(500, {detail: e.message})` — unsliced, `String(e)` for a non-Error, and not even an RFC 9457
  problem. Only reads reached the 504, and the write path's disclosure is strictly worse.
- The **480 slice never bites**: the three real messages measure 190, 391 and 438 characters, so
  each was disclosed in full. The body's own cap is 2000.
- **Field names with their classification do not reach a client.** Those live only in
  `ColumnEncryptionUnavailable`'s *constructor* message, raised at construction and caught by
  `TenantGatewayCache`. Entity names and tenant UUIDs do reach a caller.
- `ColumnSecretRefused` cannot reach the mapping at all; it is boot-only and carries byte counts.

And the reachability is narrower than claimed: `--column-key-mode` defaults to `derived` and the
compose passes none, the compose passes `--store pg` and no `--per-tenant-manifests`, and `erp-core`
declares no `phi`/`regulated` field — so **none of the four typed encryption classes is reachable on
the shipped compose.** The live member there is a raw Postgres error on the unwrapped read path,
disclosing schema metadata and the caller's own input.

### 6. A per-tenant gateway that cannot be built is served the deployment's gateway

`TenantGatewayCache.serverFor` returns `null` for two different facts and
`buildPerTenantDispatch` answers both with `opts.defaultDispatch`. The repository carries **both
words for this one behaviour**: `server.ts:322` says a tenant *"gets no gateway, which is the
fail-closed answer… because serving the rule unenforced is the defect"*, while
`tenant-gateway-cache.ts:81` — in the defective file — calls the same mechanism *"(fail open to the
default server)"*.

On the shipped `--store pg` the fallback store is the *same object* the boot gateway holds and
records are keyed `(tenant_id, entity, record_id)`, so the tenant gets **their own data under
someone else's rules**: their field-level grants, classification and the very ABAC obligation that
caused the refusal are absent, and the entity grant is unqualified. The `:136` comment's "usually
transient" premise is false for the two refusals this repository built deliberately
(`AbacObligationsUnevaluable`, `ColumnEncryptionUnavailable`), while the genuinely degradable case
never reaches that catch — `tenant-schema-apply.ts` converts it into a returned refusal the registry
memoises. The branch has **zero test coverage**.

## Decision

**One rule decides every member: a surface whose drop changes WHICH rows come back is refused; one
whose drop changes only their ORDER is reported.**

### The rule, in both layers

`UNSERVEABLE_SURFACE_REFUSES` is a total map over the three surfaces in `list-sql.ts`
(`filter: true`, `search: true`, `sort: false`), and `parseListQuery` makes the same split one layer
up with two reasons rather than three. Two mechanisms, one rule, stated in both places.

A dropped **filter** puts rows in the page that are not answers to the caller's question. A dropped
**sort** returns exactly the right rows under the remaining keys and the id tiebreaker: correct
data, in an order the caller did not choose, which they can see by looking at it. `search` is
refused and that is not an exception — `buildListSql` records a search surface only when the OR
group collapsed **entirely**, which matches every row; a *partial* collapse narrows, so it is served
and named per pair by the boot survey instead.

The sort asymmetry is argued from measurement, not taste. **243 of 375 entities across the seven
resolved packs have no list view and so declare no sortable field at all**, so refusing an
unsortable `?sort` would turn it into a 400 on nearly two thirds of every pack's collections — where
the rows were never wrong. ADR-0338's rule is to refuse where nothing worked before and leave alone
what did.

### The root cause gets a kernel rule

`validateWorkflows` now checks that an `entityLifecycle`'s `stateField` is a field of its entity,
against `fieldsByEntity` (so a **trait**-supplied state field is accepted, because the served table
really has a column for it). `erp-construction` declares its own `work_order_lifecycle` over
`status` with its own transition grants, which the entity's `overrides: true` always implied.

A **validation error and not a boot refusal**, following ADR-0348: this is a property of the
manifest alone, so it is decidable by a pack author, by `crossengin validate`, by the pack's own
tests and by the reviewer approving what the Architect designed. A rule checkable earlier should be.

### Two refusals, two sentences, because the remedies differ

- `parseListQuery` reports `UnservedListSurface`, and the handler answers **400**
  `filter_not_served` / `search_not_served`. The *manifest* does not declare the surface.
- `buildListSql` reports `UnserveableListSurface`, the stores throw `ListSurfaceUnserveable`, and
  the handler answers **400** `filter_not_served_by_store`. The manifest declares it and this
  **store** cannot express it.

A caller told "not filterable" would ask for the column to be exposed, and on the second path it
already is.

`ListConfig` gains **`fields`** — every resolved field name plus `id`, required — for exactly one
question, and it is the question that separates a refusal from a shrug: `?utm_source=ad` names
nothing and is an ordinary unknown query parameter every HTTP surface ignores, while `?tax_id=X` on
an entity that *has* `tax_id` and declines to filter it is a caller asking for something this
deployment chose not to serve. Without the list the two are indistinguishable.

`ListSurfaceUnserveable` lives in `operate-runtime`'s `store.ts` and not beside the Postgres stores
that throw it. That is a layering requirement: the handler that turns it into a 400 is in that
package and cannot import `operate-runtime-pg`, so an error class declared there could only be
caught by name.

### The dispatch mapping is inverted back, and one string moves

The recorded `StageResult.reason` carries `handler_threw: <message.slice(0,480)>` (15 + 480 = 495
against the schema's 500) and the body carries a fixed sentence plus the correlation id. **504 →
500**: an uncaught throw is by definition unclassified, and 500 is the one status claiming neither
"retry this" nor "your request was wrong". `PROBLEM_TYPES` gains `internal_server_error` — 500 was
already in `PROBLEM_STATUS_CODES` with nothing to name it. `writeTxn` stops putting `e.message` in
its body.

That single move is simultaneously the disclosure fix and what makes the status change safe, which
is why the two halves land together: fixing the status alone leaves the full message in a
non-retryable body, and fixing the disclosure alone leaves a permanent fault advertised as
retryable.

### A refused per-tenant gateway gets 503, never the deployment's gateway

`serverFor` answers a discriminated `{kind:"server"} / {kind:"none"} / {kind:"refused", reason,
retryAfterSeconds}`. `none` — no stored manifest, or one failing `ManifestSchema` /
`tryValidateManifest` — still falls back and is still cached exactly as before: **that is the
feature, not the defect.** A manifest that passes both gates and cannot be compiled is `refused`,
and `buildPerTenantDispatch` answers an `application/problem+json` 503 carrying the tenant and the
refusal kind and nothing else.

**503, and the same 503 for permanent and transient.** ADR-0334 settled this split for
`--tenant-status-gate`: a state that *forbids* the request is 403, a state that could not be
*established* is 503. Here there is no authorization answer at all, because the gateway that would
produce one does not exist. Not 404, which would say the route is not served while the tenant's
manifest says it is. Not 500, since nothing failed in *this* request. The status deliberately does
not encode permanence: the client's correct action is identical either way, the remedy is an
operator action picked up without any client change, and `ManifestActivationPoller` can invalidate
mid-flight, so "retry shortly" is frequently true even for a cause that is permanent right now.
`Retry-After` is taken from the cache's own refusal window, so the client's backoff and the server's
retry are one number rather than two guesses.

`GATEWAY_BUILD_REFUSALS` is a total map over three declared kinds deciding permanence, with
`unknown` a **member** rather than a fall-through. Only permanent causes are memoised, with the
60s `refusalRetryMs` copied from `TenantColumnStoreRegistry` including its reasoning. The ordering
is stated at the catch because it must not be got wrong: **the fallback fix lands before or with
the memo, never after** — before it, memoising a refusal extends the wrong-answer window from one
request to a whole TTL, which is exactly what the old comment was protecting against, and in that
narrow sense the original code was the lesser of the two bugs.

`onBuildRefused` is a new callback, split from `onInvalidManifest` because that one's sentence is
**false** here: the manifest passed both gates, so "stored manifest invalid" names the wrong thing
and its implied remedy — edit the manifest — is the wrong remedy. Logged under `[tenant-gateway]`,
the accurate narrowing beside the sibling's `[tenant-schema]`, where it used to be `[ai-design]`.

### The boot survey reports and never refuses

`surveyListSurfaces` names every (entity, field) pair whose declared surface this store cannot
express, with `LIST_SURFACE_MAY_SERVE` every member `true`.

ADR-0338's argument *does* hold — nothing served this correctly today, so a refusal would break
nothing that worked — and what stops it is the **remedy**: the surface is declared by a *builtin
pack's* view, so an operator meeting a boot refusal could not clear it without editing this
repository, and "a remedy that cannot work is worse than none" (ADR-0334). The honest reason a
report suffices is that **the wrong answer is already gone** — the store refuses the request before
the statement — so a boot refusal would buy no correctness and cost a deployment its boot. The
line's job is to make the 400 a clinician will eventually meet predictable rather than a surprise.

It is a fact about a **store choice** and not about a manifest: the same manifest has members on
`pg-columns` and none on `pg`, which is why this cannot be a kernel validation rule and why
`erp-healthcare` is not wrong to declare `mrn` filterable.

## Alternatives considered

- **Leave `parseListQuery` as it is; the comment is a convention, not a defect.**
  - **Pros:** ignoring unknown query parameters is ordinary HTTP behaviour; no client breaks.
  - **Why not:** the convention is right for a parameter that names *nothing* and wrong for one that
    names a field of the entity. `ListConfig.fields` is what makes the two separable, and with it
    the conventional behaviour is kept exactly where it belongs.

- **Refuse an unsortable `?sort` too, for symmetry with the filter.**
  - **Pros:** one rule with no exception; `?sort=` is a value the caller chose.
  - **Why not:** measured, 243 of 375 pack entities declare no sortable field, so this 400s two
    thirds of every pack's collections over an answer that was never wrong. Caught by this
    increment's own test suite rather than by reasoning: `handlers.test.ts`'s *"an entity with no
    classified field is never refused"* started failing with `?sort=label`.

- **Make the encrypted filter work: `pgp_sym_decrypt(col, key) = $1`.**
  - **Pros:** restores the capability instead of removing it; the key is already in the session GUC
    and `selectList` already emits the decrypt.
  - **Why not:** a sequential scan with a decrypt per row, triggered by a manifest declaration — the
    performance cliff ADR-0345 refused for the same reason (work per request becoming a function of
    a declaration's selectivity). The defect is the *silence*, not the capability gap; this is named
    as the open follow-up with its cost.

- **Refuse at boot instead of per request.**
  - **Pros:** the facts are all knowable at boot; ADR-0334's conversion of a page-one failure into a
    boot refusal is this repository's own precedent.
  - **Why not:** the declaration is in a builtin pack's view, so the remedy requires editing this
    repository. And it buys no correctness once the store refuses the request. Survey reports.

- **Per-error permanent/transient map at the gateway, keyed on the error class.**
  - **Pros:** a permanent fault would get 500 and a transient one 503.
  - **Why not:** the gateway must not import `operate-runtime-pg` or `crypto`, no error class
    declares a disposition today, and keying on `err.name` is ADR-0288's maintained list — wrong
    three times in this repository. A comment names it so nobody attempts it from the wrong end.

- **Rethrow from `writeTxn` so the gateway's catch records the message.**
  - **Pros:** the diagnosis would be moved rather than dropped.
  - **Why not:** it changes four handlers' semantics — the rollback is already complete by there, and
    the throw would travel as if it were not. The honest fix is a recorder seam on `HandlerContext`,
    named as the follow-up, and the comment says plainly that the diagnosis is lost on this path.

- **Cache the refused per-tenant gateway without fixing the fallback.**
  - **Pros:** stops `checkAbacObligations` re-running over the whole manifest every request.
  - **Why not:** it *extends* the wrong-answer window from one request to a whole TTL. Stated as an
    ordering constraint at the catch.

- **An activate-time build check, so a manifest that cannot be served is never activated.**
  - **Pros:** the real "refuse before serving" answer. `ai-design-routes.ts` returns **200** today
    and calls `onActivated` with no build check, so a reviewer approves, activation succeeds, and
    the failure is reported to nobody.
  - **Why not:** it needs the activate handler to hold the build closure and changes that route's
    contract from 200 to a possible 409/422. Named, not built.

## Consequences

- **Positive.** A filter the deployment cannot serve is a 400 naming the field and three remedies
  rather than a page of every row. The two stores can no longer answer one request oppositely. A
  thrown handler discloses nothing and the operator's row carries the diagnosis for the first time.
  A tenant whose own manifest cannot be compiled is refused rather than served someone else's rules
  over their own data. A lifecycle naming a field no entity has is a validation error.
- **Negative.** `parseListQuery`'s signature changed from `ListQuery` to `ParsedListQuery` (one
  non-test caller). `ListConfig` gained a required field (two construction sites). Five tests that
  pinned the dropped surfaces as correct were rewritten, and eight kernel fixtures declaring a
  phantom `stateField` were corrected. `?sort=<encrypted field>` is still served in an order the
  caller did not ask for. `writeTxn`'s 500 now carries no diagnosis anywhere.
- **Neutral.** `gatewayTimeout` has no non-test caller on the request path. It stays, with a doc
  comment saying why: it is a legitimate helper for a real upstream timeout, and no rule fires on it
  because ADR-0337 measured and refused a general function-shaped fence.

## Verified live

A throwaway PG 16.13 cluster, both store flavours.

**`--store pg-columns`, `erp-healthcare`**, served as `app_rw`. That is not a shortcut: ADR-0349
finding (b) established that a `pg-columns` deployment's serving role must be able to run
`ensureSchema` on every boot, so a strictly confined role cannot serve this store at all — verified
again here, `permission denied for database postgres`. The refusal under test lands *before* any
statement, so ownership is not load-bearing for it.

- The boot line: `[list] declared surfaces: surfaces_refused on --store pg-columns`, naming
  `Patient.mrn: declared filter, sort, search` and `Observation.value_text: declared search`, with
  the three remedies.
- PHI is really ciphertext: `public.patient.mrn` begins `c30d04`.
- `GET /v1/patients?mrn=MRN-1` → **400** `filter_not_served_by_store`, naming the field, the reason
  `encrypted_at_rest` and the three remedies. It was the first page of every patient, 200.
- `GET /v1/patients?family_name=F1` → **1 row**. The refusal is about the surface the caller named,
  not about the entity.
- `GET /v1/patients?sort=mrn` → **200**. Degraded, not refused — the rule holds in both directions.

**`--store pg`, `erp-construction`**, served as the **non-owner** `app_user`
(`rolsuper = f`, `rolbypassrls = f`, owning nothing).

- `[list] declared surfaces: all serveable on --store pg` — the same class of manifest, no members
  on this store.
- `?status=draft` → 2 rows, the field that really exists.
- `?description=d1` → **400** `filter_not_served`: a real field the view does not expose.
- `?utm_source=ad` → **200**. The distinction between a field and an unknown parameter works.
- `?state=draft` → 200 with every row, and that is now correct: the kernel refusal removed the
  phantom, so `state` names nothing and falls to the unknown-parameter rule. The remedy for the
  phantom was the validation, not the filter.

Full sweep green: build, typecheck and the whole suite. `operate-web` is outside the vitest
workspace and unaffected.

## Implementation notes

- **`?sort=id` was only working by accident on the column store.** `columnExpr` indexed the
  entity's *domain* fields, and `id` is a system column this store types for itself — so it
  resolved to nothing, was dropped, and the id tiebreaker `buildListSql` appends to every ORDER BY
  produced the right order for the wrong reason. `?id=<value>` was a filter that matched every row.
  It resolves explicitly now, which is what the JSONB store has always done with `document ->> 'id'`.
- **`build` passed and `typecheck` caught it — ADR-0307 in its exact original form.** A test read
  `out.body` on a `HandlerOutput`, a discriminated union where only `kind: "json"` carries `body`.
  `tsconfig.json` excludes `**/*.test.ts`, so `build` was clean and `typecheck` reported four
  `TS2339`. Anyone verifying with `build` and `test` alone is running two of this repository's three
  gates.
- **Six 504 prose sites, not one.** Changing the status made a *boot line's own words* false —
  `envelope-tenant-readiness.ts` builds a line reading *"the client sees an HTTP 504, a retryable
  status for a permanent fault"* and its test asserted `/504/`. Two more were found afterwards, in
  `auth-token-route.ts` (whose conclusion survives on stronger grounds than its stated premise) and
  in `node.ts`. All updated.
- **A fake `PgConnection` cannot see any of this, and neither could a real one for member 2.** The
  statements are well-formed, the columns exist and every bound value is admitted by its CHECK; what
  is wrong is which *question* was asked. The nine strategy rules in `packages/testing` ask whether
  a column exists, whether an `INSERT` is complete, whether a live database admits a value, whether
  a CHECK and a contract enumerate the same members, whether a declaration names the bound symbol
  and whether a property names the column it is read from — and a query missing a predicate
  satisfies all nine.

## Open questions

1. **Decrypt-and-compare would restore the capability.** `pgp_sym_decrypt(col, key) = $1` is
   correct and unindexed, so an `eq` lookup on a unique MRN is a sequential scan with a decrypt per
   row — reachable from a manifest declaration, which is the shape ADR-0345 refused. Worth it for
   `eq` on a unique field and not for `contains`; it wants a per-surface decision and a measurement
   first.
2. **A partially-narrowed `?q` is silent at request time.** `Patient`'s search spans
   `mrn, given_name, family_name`; a clinician searching for an MRN gets an empty page and concludes
   the patient does not exist. The rows are right, so the store does not refuse, and only the boot
   line says so. A `page.unsearchedFields` on the list envelope would say it per response and is a
   response-shape change no client reads yet.
3. **`writeTxn`'s 500 carries no diagnosis anywhere.** The handler layer has no recorder, so this
   fix *drops* the string rather than moving it. A recorder seam on `HandlerContext` — somewhere a
   handler can put an operator-only string the dispatch stage folds into the stage reason — is the
   shape, and it is a contract change this did not make.
4. **A source throw in `TenantGatewayCache` still falls back.** It resolves `none` and serves the
   deployment's gateway, which is the same class of wrong answer the build arm was just fixed for —
   merely rarer and uncached. A source throw means it is *unknown* whether the tenant has a
   manifest, so the honest answer is probably a third disposition (refuse, uncached) rather than a
   fallback. An existing test pins today's behaviour.
5. **Activate-time build checking.** `ai-design-routes.ts` returns 200 and calls `onActivated` with
   no build check, so a tenant can activate a manifest this deployment cannot serve and learn about
   it from a 503 on their next request.
6. **The per-tenant path is still not surveyed.** `surveyListSurfaces` runs over the boot manifest;
   a tenant's own activated manifest can declare a surface on a classified field and nothing says
   so. This is ADR-0339's Q5 and ADR-0357's Q1 for the third time, and the three want one answer:
   where a per-tenant *report* goes when the tenant is not the operator reading the log.
7. **`parseListQuery` reports every offending filter and the handler answers the first.** That is
   `withheldAddressing`'s precedent (a stable refusal rather than a list that changes with
   parameter order), but it means a caller fixing one parameter meets the next 400 rather than
   being told both at once.
8. **The same silent-drop shape is unaudited elsewhere.** `?fields=` names a projection and
   `parseFields` validates nothing against the entity, so `?fields=nope` projects an empty record
   rather than refusing. It narrows rather than widens, which is why it is not in this increment —
   but it is the same comment's reasoning one surface over.
