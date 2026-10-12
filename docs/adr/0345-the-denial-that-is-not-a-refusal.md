# ADR-0345: The denial that is not a refusal

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0344, ADR-0343, ADR-0342, ADR-0340, ADR-0338, ADR-0334, ADR-0331 |

## Context

ADR-0342 made record availability part of the ABAC contract and refused three grant positions at
boot. ADR-0343 retired one of them, `field_read`, after finding its stated reason was true about the
implementation and false about the question — *a structural refusal that was really a wiring one*.
It left `never` as the exact set `{entity_create, entity_list}` and drew the line it thought
remained:

> **a field policy filters columns within a row, which a response can express per record; an
> entity-list policy would filter rows**, leaving the page's cursor describing a set the caller was
> not shown.

**That sentence is true.** This is the opposite case from ADR-0343: one refusal was imaginary and
one was real, and the real one is closed not by discovering there was no price but by paying it.

The class is **a denial that is not a refusal**. Every ABAC position until now answered a denial the
same way — refuse the request, or withhold a field from a record that still comes back. Entity
`list` is the position where the honest answer to "you may not have this row" is to not send the
row, and that changes what the *response means*, not just what it contains.

### The crux is the cursor

`encodeKeyset` is `base64url(JSON.stringify({k: [...sort values], id}))` — plainly reversible — and
`ListPage.nextCursor` is derived from the **last row of the store's slice**, non-null iff the store
had more rows. Filtering rows out of a page therefore has to answer: what does the cursor describe?

Three candidates, and two of them are unsound:

- **The last visible row.** A fully-denied page has no visible row, so the cursor either does not
  advance — the walk loops forever — or comes back null, and the walk stops early, silently
  truncating a result the caller is entitled to. The second is a wrong answer, which this repo ranks
  below a refusal (ADR-0336's `IdempotencyStore.get` rule).
- **Re-fill to `limit`** by fetching further pages until enough rows survive. This makes the work per
  request a function of the *policy's selectivity*: a caller who may see 1% of rows costs ~100 store
  calls for one page. A denial of service reachable from a manifest declaration.
- **The store's cursor, untouched.** Sound: every row is examined exactly once, the total work across
  a walk is unchanged, nothing is skipped or repeated. The price is that a page can come back with
  fewer than `limit` rows, or with none, while `nextCursor` is non-null.

## Decision

**A record-bearing obligation on an entity's `list` grant filters rows out of the page, the store's
cursor passes through untouched, and the caller may not address rows by a field they may not read.**

### `entity_list` is `always`, and `never` is now a one-member set

`ABAC_RECORD_AVAILABILITY.entity_list` flips from `never` to `always`, and `never` is pinned as the
exact set `{entity_create}` — a create's record does not exist until the write commits, and no
amount of loading fixes that. `actionCanSupplyRecord` reads through that map, so the list handler's
existing `obligationOutstanding` flag starts being set with no edit to the flag: the machinery
ADR-0342 built for the re-ask is the machinery the filter runs on.

ADR-0343's distinction between `field_read` and `entity_list` survives but moves axis. Both have the
record and both always did; what separates them is what a **denial does** — a field-read policy
withholds columns within a row, so the record comes back shorter, while a list policy withholds
whole rows, so the page does. Reading that as an *availability* difference is what kept both refused
at boot longer than the facts warranted.

### The second axis: `ABAC_DENIAL_EFFECT`

```ts
export const ABAC_DENIAL_EFFECTS = ["refuses_request", "withholds_field", "filters_rows"] as const;
export const ABAC_DENIAL_EFFECT: Readonly<Record<AbacGrantPosition, AbacDenialEffect>>;
export const ABAC_DENIAL_EFFECT_DESCRIPTIONS: Readonly<Record<AbacDenialEffect, string>>;
```

`entity_list → filters_rows`, `field_read → withholds_field`, the other six `refuses_request`.

Availability answers *can this position be asked*. Until row filtering existed that was the only
axis worth having, because the answer to a denial was the same everywhere. It is not any more, and
the new axis is the one a manifest author actually feels: declaring a record policy on `list` 403s
nobody — it silently shortens their pages. The descriptions are keyed per **effect**, three strings
rather than eight, because the effect's name already carries the position-specific part.

`entity_create` is `refuses_request` even though a boot refusal makes it unreachable: that is what it
would do if reached, and a total map with a hole is the thing a total map exists to prevent.

### `nextCursor` passes through, and a short page is the correct answer

Termination is **`nextCursor === null` and nothing else**. A page may hold fewer than `limit` rows,
or none, with a non-null cursor. Verified against every in-repo consumer: `apps/operate-web` pages
on `nextCursor === null`; `packages/sdk`'s pagination contract is a separate, unwired
`{nextCursor, hasMore}` shape with a biconditional between them.

The reasoning lives in a comment at the pass-through, because the next reader's instinct will be to
"fix" the short page, and the fix is the bug.

### No withheld count

The response does not say how many rows were dropped. A count is an inference channel the caller can
narrow with a filter, and the contrast with ADR-0342 is instructive: there a record-level denial is a
**403 and not a 404**, accepting that the caller learns the id exists, because *they had named it*
and the population that can name it already holds the entity grant. Here they named nothing. Who
named the record is what decides whether telling them it exists costs anything.

### One rule over three query surfaces

> **While rows are being withheld, a caller may not address rows by a field they may not read.**

`withheldAddressing(query, withheldFields)` returns the first offending use, checking `sort`, then
`filter`, then `search`, so a query offending twice names the same one every time. Under an
outstanding obligation a hit is a **400** — the caller may list; this query is the problem — with one
code per surface (`sort_addresses_withheld_field`, `filter_…`, `search_…`) and the field in the body.
It runs **before the store call**: a query that may not be answered must not be run.

Two different reasons, one rule:

- **`sort`** is the sharp one, and it is the cursor. Ordering by a classified field puts that field's
  value, for a row the caller is never shown, into a string handed straight back.
- **`filter` and `search`** are a chosen-predicate oracle: the caller picks a value and the response
  distinguishes match from no-match — through the cursor's presence if nothing else — so a withheld
  row's contents can be tested one value at a time. That channel does not exist today, because
  without a record policy a caller who can predicate on a row simply *sees* it.

The withheld set is the entity's **classified** fields, not this caller's actual redaction set, which
the gateway computes after the handler returns. So it is wider than strictly necessary — a privileged
caller's classified `?sort` is refused too, while an obligation is outstanding. Conservative, wrong
only in the refusing direction, and making it exact would mean resolving `SensitiveFieldPolicy` and
the per-field read grants a second time inside the handler, which is a second place for the read and
write halves to drift (ADR-0329, ADR-0339).

### A classified **default** sort is refused at boot

`parseListQuery` falls back to the view's `defaultSort` when the request names no `?sort`, so the
request-time guard already covers it — and that is precisely why it belongs at boot instead. A view
whose default sort names a classified field on an entity under a record-bearing `list` obligation
makes **every** request to that collection a 400, with no query string and no per-request fix, because
the sort came from the manifest and not from the caller. `list_sort_addresses_withheld_field` is the
fourth refusal, last in the order for the same reason `record_unavailable` is third: it is computed
from `recordBearingKeys`, so with no evaluator declared it would be vacuously silent, and the refusal
reported must be the one whose remedy is true. ADR-0334's conversion, applied again — a failure
certain at boot belongs at boot.

It is **not** a leak the refusal prevents; the guard already stops the value reaching a cursor. It is
a certain page-one failure converted into a boot failure that names the view, the field, its
classification and three remedies.

### Association routes split, and the count needed no code

The association **list** filters through the same `rbacCheckForRecords`. Its cursor is a plain
**offset into the owner's links**, not a keyset, and the route has no `?sort`, `?filter` or `?q` at
all — so none of the disclosure applies and it needs no addressing guard. The offset is computed from
the full link list, so filtering cannot disturb it, which is the same property the entity arm holds by
leaving the store's cursor alone.

The association **count** keeps refusing, with **no logic change**: a record-bearing policy answers
`deferred`, `ABAC_OUTCOME_ALLOWS.deferred` is false, and the existing `!decision.allowed` arm refuses.
A count answers for the whole set with one number, so there are no rows to drop and no record to
answer against, and fetching every linked record to count the admitted ones would be unbounded. What
it did need is its own sentence in the 403: `ABAC_RECORD_AVAILABILITY_REASONS.entity_list` now reads
*"a denial drops that row from the page rather than refusing the request"*, so borrowing the shared
structural prose would have printed the opposite of what that route does.

### `rbacCheckForRecords`, and the reader ADR-0344 did not have

```ts
export function rbacCheckForRecords(
  input: Omit<RbacCheckInput, "record">,
  records: readonly Readonly<Record<string, unknown>>[],
): readonly AuthorizationDecision[];
```

One decision per record, positionally aligned. The entity, grant and **role** arms resolve once —
none depends on the record — and only the obligation is asked per row, pooled into exactly one
`dischargeAbacBatch`. Each element is identical to what `rbacCheck` would return for that record,
reason and `abac` included, which the handler depends on; it is held by construction, because both
readers go through one `lookupGrant` and one `decideFromDischarge` rather than two functions agreeing.

`Omit<RbacCheckInput, "record">` is ADR-0344's rule: the records travel in the array, so supplying
one twice is structurally impossible. `RbacCheckInput` gains `abacBatchEvaluator?`, which `rbacCheck`
ignores — it asks one question — and which lives on the shared input so a caller cannot hand the
single evaluator to one form and the batch to the other.

**This corrects ADR-0344.** That ADR said the handler path had no reader with a fan-out, and wrote
`rbac.ts`'s comment to say `RbacCheckInput` "therefore gains no batch field". True of the readers that
existed; row filtering adds the one that was missing, since `list` decides one grant for a whole page —
exactly the fan-out the redaction registry had. So `abacBatchEvaluator` now reaches the handler context
as well, and the filter is one evaluator call per page rather than one per row.

The filter deliberately does **not** go through `resolveObligation`, the helper ADR-0342 added for the
re-ask: that turns a refusal into a 403, which is right where the act decides about one named record
and wrong here, because the whole point of this position is that a denial is not an error.

## Alternatives considered

- **Option A: derive `nextCursor` from the last visible row.**
  - **Pros:** the cursor describes what the caller was shown, so nothing about a withheld row leaks
    through it.
  - **Cons:** a fully-denied page has no visible row, so the walk loops or truncates.
  - **Why not:** truncation is a wrong answer and looping is worse. The fully-denied page is not a
    corner case — it is what a selective policy produces routinely, and it is the case the live
    verification below turns on.

- **Option B: re-fill the page until `limit` rows survive.**
  - **Pros:** `limit` keeps meaning "up to this many rows", and no client integration changes.
  - **Cons:** work per request scales with the inverse of the policy's selectivity.
  - **Why not:** a manifest declaration should not be able to turn one store call into a hundred. The
    bound on work per request must not depend on how much the caller is allowed to see.

- **Option C: push the predicate into SQL.**
  - **Pros:** one query, correct `limit`, no short pages, no cursor question at all.
  - **Cons:** impossible. ADR-0340 made `abac` an **opaque policy key** resolved by a
    deployment-supplied synchronous JS function; there is nothing to translate.
  - **Why not:** it would mean giving up the opaque key, which is the decision that let `abac` mean
    anything a deployment's policy layer can express.

- **Option D: report the withheld count.**
  - **Pros:** a client could render "3 of 50 shown" and a short page would stop looking like a bug.
  - **Cons:** an inference channel the caller narrows with a filter, down to single-row existence.
  - **Why not:** it hands back exactly what the filter exists to withhold, and unlike ADR-0342's
    403-not-404 the caller never named a record, so there is nothing they already knew.

- **Option E: encrypt the cursor.**
  - **Pros:** closes the residual disclosure completely — the cursor would carry the store's position
    with nothing readable in it.
  - **Cons:** needs a symmetric cipher. `packages/crypto` deliberately has none, pinned three ways
    (`KEY_ALGORITHMS`, `KEY_PURPOSES`, `CRYPTO_OPERATIONS`, the last with a test asserting
    `isCryptoOperation("encrypt") === false`), and ADR-0338 kept it that way on purpose.
  - **Why not here:** it is the right fix and it belongs to the increment that adds AES-256-GCM for
    ADR-0338's DEK envelope, which is already the named top follow-up there. Doing it now would
    reopen that decision for a weaker reason than the one driving it.

- **Option F: leave `entity_list` refused.**
  - **Pros:** no disclosure, no short pages, no new rule.
  - **Cons:** "only your own rows" is the single most common ABAC policy there is, and it stays
    inexpressible.
  - **Why not:** the refusal was honest but it was a refusal to build the feature, and ADR-0343
    already named row filtering as the shape it should take.

- **Option G: exempt the view's default sort from the addressing guard.**
  - **Pros:** `erp-healthcare`'s `Patient` list view keeps working under a record policy.
  - **Cons:** the leak is real whether the caller asked for the sort or the manifest did — on the bare
    collection GET the cursor genuinely carries a withheld row's family name.
  - **Why not:** the exemption would apply to exactly the request nobody has to opt into. The boot
    refusal is the honest version of the same concern.

## Consequences

- **Positive:** the most common ABAC policy shape is expressible and enforced. The walk is sound —
  every row examined once, nothing skipped or repeated, work per request unchanged. One evaluator call
  per page, not per row (ADR-0344's seam reaching the handler). The association list gets the same
  treatment for free, and the count route's refusal turned out to be correct already.
- **Negative:** a page can be short or empty with a non-null cursor, so a client that stops on empty
  `data` stops early — stated at boot, in three places, because it is not guessable. `?sort`/`?filter`/
  `?q` on a classified field are refused while an obligation is outstanding, which costs a deployment
  the ability to search a `pii` name field on a filtered list. A classified default sort is a boot
  refusal, so declaring a record policy on `Patient` requires repointing that view's sort first. And
  the cursor still discloses the **position** of withheld rows.
- **Neutral:** no schema change, no table, no flag. Nothing in the shipped packs declares a
  record-bearing `list` obligation, so **no shipped deployment's behaviour changes** — every new path is
  gated on `obligationOutstanding`, which needs such a policy declared.
- **Reversibility:** moderate. Flipping `entity_list` back to `never` restores the boot refusal and
  makes the filter unreachable, and the handler arm would be dead rather than wrong. The three 400
  codes and the boot refusal are caller-visible and would have to be withdrawn as API surface.

### The residual disclosure, stated plainly

The cursor names the **position** of withheld rows: the sort key and the `id`. That is irreducible for
any sound stateless paging over a filtered set, because advancing past a withheld row means naming
where it was. The addressing rule holds it to position rather than contents — the default sort key and
an `id` rather than a value the caller chose to order by. At `limit=1` a caller can walk the collection
and collect one id per page, including ids of rows they cannot read, which is an enumeration this repo
did not previously permit. Option E is the fix.

## Implementation notes

- `packages/auth/src/abac.ts` — the availability flip and its reason, the `never` set, and
  `ABAC_DENIAL_EFFECT{,S,_DESCRIPTIONS}`. Three further statements became false and were corrected
  rather than left: `AbacBatchEvaluator`'s bullet list carried the *same* "gains no batch field" claim
  as `rbac.ts` (duplicated in two files, which is how it would have been missed),
  `dischargeAbacBatch`'s rule 2 said "the one reader that could use the batch" (now two), and the
  reader counts are gone, since a count there breaks on the next reader.
- `packages/auth/src/rbac.ts` — `rbacCheckForRecords`, `RbacCheckInput.abacBatchEvaluator`, and the two
  private helpers (`lookupGrant`, `decideFromDischarge`) that make the elementwise property structural.
- `packages/operate-runtime/src/list-query.ts` — `withheldAddressing`.
- `packages/operate-runtime/src/handlers.ts` — `HandlerContext.abacBatchEvaluator`, one
  `entityCheck: Omit<RbacCheckInput, "record">` built once and used three ways (record-free ask,
  re-ask, batch) so they differ in nothing but the record, the guard, and the filter.
- `packages/operate-runtime/src/association.ts` — the list filter, the count's own 403 reason, and the
  stale comment asserting `entity_list` is `never`.
- `packages/operate-runtime/src/compile.ts` — `abacBatchEvaluator` into the handler context; the
  association handlers share that object, so one thread covers both.
- `apps/operate-server/src/abac-obligations.ts` — `rowFiltered` (derived through `ABAC_DENIAL_EFFECT`,
  never by naming `entity_list`), `listSortConflicts`, the fourth refusal, and the two messages.

### Measured

Across the seven **resolved** packs: **132** `list` views, every one carrying a non-empty default
sort, **28** distinct by `(entity, sort)`, and **one** whose default sort names a classified field —
`erp-healthcare`'s `Patient`, sorting by `family_name`.

That field is **`pii`**, not `phi`, and it is **not** one of the five fields ADR-0338 made ciphertext
at rest (`Patient.mrn`, `Encounter.chief_complaint`, `Observation.value_quantity`,
`Observation.value_text`, `Citizen.national_id`). An earlier draft of this ADR claimed the encryption
tie; it is false, and the rule fires because the field is classified, which is the predicate both the
boot refusal and the request-time guard use. `mrn` *is* phi and *is* sortable and searchable on that
same view, which is how the entity would trip the guard on an explicit query as well as on its default.

### Verified live

PG 16, non-owner role `app_rw`, one tenant with two memberships holding the **same** role and
different `department`, policy `same_dept=department:eq_record:department`. Seven charts, labels
`l1..l7`, departments `C O O O C C O`.

**The boot refusal**, on a manifest whose list view sorts by the classified `mrn`:

```
fatal: 1 list view(s) sort by default on a classified field of an entity whose `list` grant carries
a record-bearing abac policy … : Chart.mrn (pii) under abac policy 'same_dept'. The cursor is
base64url(JSON.stringify({k: [...sort values], id})) and is derived from the last row of the store's
slice, which under row filtering may be a row the caller was not shown — and no caller can opt out,
because the sort came from the manifest and not from the request. Change that view's `sort` to an
unclassified field, drop the classification from the field, or remove the `abac` key …
```

**The full keyset walk at `limit=2` as A (cardiology)** — the case the whole design turns on is
page 2:

```
page 1: rows=1 [l1]    nextCursor=set -> decodes to k=["l2"]
page 2: rows=0 []      nextCursor=set -> decodes to k=["l4"]
page 3: rows=2 [l5,l6] nextCursor=set -> decodes to k=["l6"]
page 4: rows=0 []      nextCursor=null
visible to A: [l1,l5,l6]
```

A fully-denied page returns **zero rows with a non-null cursor**, the walk terminates, and every row
A is entitled to arrives. The decoded cursors are the residual disclosure made concrete: `k=["l2"]`
and `k=["l4"]` name rows A never saw — their **position** in the sort order, under an unclassified
key, which is exactly what the addressing rule guarantees and no more.

**The addressing guard**, with the classified `mrn` as a sortable and filterable column:

```
?sort=mrn    -> 400 sort_addresses_withheld_field
?mrn=MRN-1   -> 400 filter_addresses_withheld_field
?q=MRN       -> 400 search_addresses_withheld_field
?sort=label  -> 200
```

**The mirror**, which is the proof that the record decides and not the role — both principals hold
`clinician`:

```
visible to A (cardiology): [l1,l5,l6]
visible to B (oncology):   [l2,l3,l4,l7]
```

An exact complement over all seven rows.

Workspace: **17,244 tests**, build and typecheck green.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The cursor discloses withheld rows' positions; at `limit=1` that is an id enumeration. The fix is an encrypted cursor, which needs the cipher ADR-0338 deliberately does not have. | Platform | — |
| The withheld set is the entity's classified fields rather than this caller's redaction set, so a privileged caller's classified `?sort` is refused too. Exact would mean a second resolution of the field grants in the handler. | Platform | — |
| Association link/unlink is now an **unclosed** position rather than a structural one: the grant is `update` on the owner, the owner's id is in the path, and the record could be loaded and the decision re-asked exactly as entity `update` does. Vacuous today — zero `many_to_many` across the packs. | Platform | — |
| A deployment supplying its own `RedactionRegistry` or its own evaluator gets no check that its list grants' policies are record-bearing in the way the boot report assumes. | Platform | — |
| `?sort` on a classified field is refused only while an obligation is outstanding. Whether sorting by a field you cannot read should be refused generally is unexamined. | Platform | — |

## References

- ADR-0344 — the batch seam, and the claim about the handler path this corrects.
- ADR-0343 — per-record field redaction, and the sentence that named row filtering as this shape.
- ADR-0342 — `deferred`, `ABAC_RECORD_AVAILABILITY`, and 403-not-404.
- ADR-0340 — `abac` as an opaque policy key, and the role-check-first ordering.
- ADR-0338 — the at-rest classified set, and why `packages/crypto` has no cipher.
- ADR-0334 — a failure certain at boot belongs at boot.
