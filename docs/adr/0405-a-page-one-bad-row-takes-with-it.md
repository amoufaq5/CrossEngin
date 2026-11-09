# ADR-0405: A page one bad row takes with it

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Authors** | Claude |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0373, ADR-0374, ADR-0403, ADR-0372, ADR-0375, ADR-0289, ADR-0313, ADR-0359, ADR-0364, ADR-0368 |

## Context

ADR-0373 established the rule and built the primitive: a multi-row read that converts rows through
a contract must **report** a row the contract refuses rather than throwing the page away or dropping
the row in silence. `kernel-pg`'s `read-rows.ts` has two shapes — `readRows` **forwards** a reporter
(right where the consumer is a scheduler or a route) and `readRowsWithUnreadable` returns the
refused rows **beside** the records (right where the consumer is a verifier, because there the
unreadable row is part of the answer rather than a note on the side) — and
`packages/testing/src/strategy/pg-unreadable-rows.ts` is the twelfth workspace rule over the class.

What it left was the migration. Measured by calling the rule over the committed tree at the start of
this increment: **112 sites, 65 needing a declaration, 42 of them parked as `unmigrated`**, each
declaration naming what a refused row costs today. Two more were parked as
`row_dropped_deliberately` — the reason that *endorsed* the silence, with a required `consumedBy`
naming the party the silence was about.

Two facts about that backlog shaped this increment, and both are corrections to the plan it was
scoped from.

**The scope was 44 sites, not 42.** The two `row_dropped_deliberately` members are the same class
by a different route and the plan counted only the `unmigrated` ones. They are also the sharper
pair: a throwing read loses the page loudly, while these two lose the row and report success.

**`readRows`' identity helpers refused a typed row.** `readRows` is generic in the row type so a
store that declares its rows can use it, and `textIdentity`/`numericIdentity` took
`Record<string, unknown>`, which a declared `interface Row` with no index signature is not
assignable to. ADR-0403 closed that first; without it, four of this increment's sites would have had
to spell a local `rowKey` by hand, which one package had already been forced into.

## Decision

**Migrate every site where a refused row is a loss, and give each remaining one a reason that says
what it is.** 37 of the 44 are migrated; the rest are declared, and the declarations say which kind
of thing they are rather than all reading `unmigrated`.

Three dispositions, chosen per site by **who consumes the page** and not by what is convenient:

1. **Forward the reporter** (`readRows`) where the consumer is a drain, a scheduler, a fleet worker
   or a sweep. The refused row is a note an operator needs; the page carries on.
2. **Return the pair** (`readRowsWithUnreadable`) where the consumer is a verifier, or where there
   is no consumer yet — because with nobody to forward to, the pair is the shape that does not
   decide the question on a future caller's behalf.
3. **Keep the throw and name it at the route** (`page_refusal_declared`). Six list routes in
   `apps/operate-server` keep their stores throwing and answer a named code, because for those
   pages a *short* page is the wrong answer and the refusal is the useful one.

The third is the one worth stating plainly, because it reads as not doing the work. A page served
short is a page an operator reads as complete: for the platform console's tenant list a missing row
reads as a tenant that was never provisioned, and for a membership list — which has no sibling count
tile to cross-check against — it is undetectable from the console. So the store keeps throwing and
the handler catches the **store call alone** and answers a code: `tenant_page_unreadable`,
`user_page_unreadable`, `membership_page_unreadable`, `design_review_page_unreadable`,
`inbox_page_unreadable`, `manifest_page_unreadable`. That is the shape ADR-0313 already chose for
five sites and the vocabulary already had a reason for; what was missing was the catch.

**And `row_dropped_deliberately` is deleted.** Both its members migrated, so the reason has no case
left — which is ADR-0375's rule (*a judgement with no case left is not a judgement*), and the rule's
own test already encoded it by asserting that no reason is a dead branch of the vocabulary. The
**verdict** `record_dropping` stays, because it is the opposite shape: the scanner can still detect
a silently dropping conversion and the next one written must read as *that* rather than as
`record_total` or as nothing. What changed is what such a site may be declared as — only
`unmigrated`, which demands its consequence. A new dropper can be parked with its cost stated and
can no longer be blessed.

## Alternatives considered

- **Option A: migrate all 44 uniformly to `readRows`** (what the plan said).
  - **Pros:** one shape, no judgement per site, no declarations left to keep true.
  - **Cons:** it is the wrong answer for six of them.
  - **Why not:** a short page presented as a complete one is ADR-0372's class — an absence reported
    as success — and for the six list routes that is strictly worse than a named 500. The route
    *already* holds the page and can name the condition; the store cannot. The rule's own
    `page_refusal_declared` reason exists for exactly this and had five members already, so this is
    convergence rather than an exemption.

- **Option B: keep `row_dropped_deliberately` as a reserved reason with no member.**
  - **Pros:** symmetric with `record_dropping`, costs nothing today, available if a case appears.
  - **Cons:** it is an available endorsement of the one shape this increment exists to end.
  - **Why not:** this repo distinguishes a **refusal** with no member (cheapest to be right —
    ADR-0384's `wildcard_path`) from a **judgement** with no case (ADR-0375's
    `anchoringWouldBury`), and the test that fails on a dead reason is the rule stating which side
    this falls on. A hatch is justified where the degraded state is coherent (ADR-0338's plaintext
    PHI) and not where it *is* the defect (ADR-0340's unevaluated obligation). A silently dropped
    row is the second.

- **Option C: return the pair everywhere, so no caller can forget to forward.**
  - **Pros:** one shape; the refused rows are structurally impossible to discard at the store.
  - **Cons:** it moves the decision to every caller and makes the common case worse.
  - **Why not:** a drain's caller has nothing to do with a refused row but log it, so the pair makes
    eleven call sites each decide what the store already knows. The reporter being **required** is
    what prevents forgetting; the shape is a statement about the consumer.

- **Option D: migrate `digest-store`/`template-store` by making `tryXFromRow` report.**
  - **Pros:** smallest diff; the single-row callers keep their `null`.
  - **Cons:** two spellings of the reporting rule, in a function whose name says it swallows.
  - **Why not:** `readRows` already turns a throw into a report, so the migration is to call the
    *throwing* mapper and let the primitive do it. `tryDigestFromRow`/`tryTemplateFromRow` survive
    for their single-row callers, where answering `null` is the right answer to *is there one* —
    which is the distinction ADR-0289 draws and which this keeps rather than blurring.

## Consequences

- **Positive:** 37 reads that lost a page or a row now report it and carry on. The backlog is
  **5 of 32** declared sites, of which two are not losses at all (a second spelling of the reporting
  rule), one is latent on a declared-callerless store, and two are real. The six route refusals turn
  an unclassified 500 — or, for `ai.manifests.list`, **no catch at all** — into a named code with no
  detail. `record_dropping` has no members anywhere in the workspace.
- **Negative:** three required parameters widen three seams (`DeliveryDrainOptions`,
  `DigestAssemblyOptions`, `buildStripeUsageSync`), so every test literal over them had to name a
  reporter. That is the cost of *required*, and it is the cost that buys the guarantee: an optional
  reporter defaulting to *say nothing* is the dropped row restated as a default (ADR-0364).
- **Negative:** six routes answer 500 where they used to answer a short page or an unclassified 500.
  A caller who was being served a partial list now gets none of it. That is the decision, not a
  side effect: for these six a partial list is a wrong answer and a refusal is a correct one.
- **Neutral:** `claimQueued`'s mapping moved **before** its claiming `UPDATE`. Same statements, new
  order, and it is what makes the fix safe rather than merely non-fatal — see the implementation
  notes.
- **Reversibility:** per site. Reverting one means putting its declaration back, which the rule
  demands and which cannot be done silently.

## Implementation notes

**`claimQueued`'s ordering is load-bearing.** A mechanical `readRows` there would have been *worse*
than the throw it replaced: the `.map` sat after the claiming `UPDATE`, so a dropped row would be
left in `sending` with nobody to deliver it and no retry selecting it — permanently stuck, where the
throw at least rolled the claim back. The mapping runs first now and the `UPDATE` claims only the
rows that read, so a refused row stays `queued` and the next tick sees it again. Two tests pin it:
one asserts the `UPDATE`'s parameters exclude the refused row's id, the other that the row's status
is still `queued`.

**Six route catches are scoped to the store call alone**, which is the half a wider `try` loses.
`design-review-routes` calls `ctx.assessRisk` after the read and `notification-routes` issues two
more store reads inside a `Promise.all`; a wider catch would launder those into the page refusal.
Both have a test. Writing the notification one **refuted a comment I had just written**: the join
catches its own throw and answers `proposal: null` on the standing decision that a notice missing
its copy beats no inbox, so the two conditions are distinguished in *both* directions — the comment
said the throw propagated, which it does not, and it is corrected at the site.

**`UnreadableDefinitionRowsError` is a new exported class** in `workflow-runtime-pg`, which refutes
the plan's claim that a publication must choose a named refusal: `DefinitionWriteResult.refusal`
answers about the *proposal*, and an unreadable stored row is a broken premise the caller neither
authored nor can repair. `gatherForPublication` throws it; `summariesForKey` and `listByKey` return
the pair.

**`TenantDeletionEvent.unreadableCount` is optional**, unlike the three required reporters, and for
a measured reason: the two delete paths read no rows, so a required field would make them claim
*we looked and found none* where nothing looked (ADR-0331, at an audit record).

Three measurements worth keeping. `@crossengin/billing` declares `const Uuid = z.string().min(1)` in
six modules, so a fixture built from `record("not-a-uuid")` parses clean — a name standing in for a
check (ADR-0362's class) and the reason one fixture had to be rebuilt on a different field.
`key_ed25519_BAD0000000000000000000000` is 25 characters against a 26-character Crockford-base32
regex, so a fixture meant to break one clause broke a different one; `unreadableDetail` sorts,
de-duplicates and comma-joins its issues, which is what made that visible. And
`stripe-usage-sync.test.ts`' fake keyed on `/SELECT record/i` while the statement had widened to
`SELECT id, record`, so the fake silently stopped serving rows and three tests read as *no usage was
reported* — the fake keys on the **table** now, with ADR-0370's lesson at the site.

### Verified live

PG 16.15, a throwaway cluster, every read issued as the **non-owner** `serving` role, one arm per
disposition with its own non-vacuity control — because an arm that only ever reports is
indistinguishable from a reporter that fires unconditionally. Every probe writes its readable row
through the store's **own writer** and then corrupts one copy in place with an `UPDATE`, which is
the technique the first run forced: a hand-built fixture is a fixture, and arm 1's first one was
refused on `notificationChannel` rather than on the field under test. 19 assertions, all passing.

*Forwards the reporter* — `lifecycle-event-store::readTrailAsPlatform`, `reason := ''` (TEXT with no
CHECK against `z.string().min(1)`): the readable event is still served (`records=1`), the refused row
is reported once, the detail is exactly `reason: too_small`, and the stored value does not appear.
Control: repaired in place, `records=2 reported=0`.

*Returns the pair* — `crypto-pg::key-registry::listKeys`, `public_key_base64 := ''`: `records=1`
beside `unreadable=1`, the refused key named by its business key
(`key_ed25519_0123456789ABCDEFGHJKMNP0TW`), detail `publicKeyBase64: too_small`, and no key material
in the report. Control: `records=2 unreadable=0`.

*The store throws and the route names it* — `platform-admin::list` with `meta.tenants.name := ''`:
the store throws rather than shortening the page, the route answers **500**
`{"error":"tenant_page_unreadable"}` with no `detail` and no store text, and the same route answers
**200** once every tenant row parses.

Two things the run taught that no offline test could. `listForTenant` is a bare `this.conn.query`,
so as the non-owner with no tenant context this table's isolation policy answers **0 rows** — the
first version of arm 1 read `records=0 reported=0`, which is byte-identical to the reporter never
having been called, and the arm was vacuous rather than failing. `readTrailAsPlatform` opens its own
transaction and claims `app.platform_audit`, so it is the read that exercises the forwarding *and*
returns rows to a least-privilege session. And both controls originally **deleted** the corrupted
row, which matched nothing: `meta.tenant_lifecycle_events` and `meta.crypto_keys` are both
`PLATFORM_RECORD_TABLES` members, so since ADR-0400 each carries a restrictive
`FOR DELETE USING (false)` policy and a tenant-context `DELETE` answers `DELETE 0` with no error
code — that ADR's own open question 3, met head-on. Repairing is the better control regardless,
because the clean read is then over the same population as the dirty one rather than a smaller one.

One measurement worth keeping from arm 2: `public_key_base64 := ''` is the **only**
catalog-admitted / contract-refused value on `meta.crypto_keys`. `key_id`, `algorithm`, `purpose`,
`fingerprint_sha256`, `key_version` and `status` all carry a CHECK; that one column carries none
while the record declares `z.string().min(1).nullable()`. The first attempt wrote
`'not base64 at all !!!'`, which the contract **admits** — nothing in the record asserts
base64-ness — so the arm reported `unreadable=0` and read as the pair being broken. A corruption the
contract accepts is not a corruption, which is register P2.12b's population measured from the inside
on one table.

### The sweep

`pnpm -r build && pnpm -r typecheck && pnpm -r test`, serially, one at a time. The rule's own
workspace test re-pins three floors that this migration legitimately moved (`needing` 65 → 32,
`record_throwing` 50 → 19, `guarded_by_primitive` 16 → 50) with the figures and the reason written
in; a floor that tracks the measurement is still a floor, and the primitive's is now the **high**
one because 50 of 112 sites depend on that matcher.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `column-store::listPageOn` is the sharpest remaining member — every tenant list request against the typed column store — and a refused record still makes the whole page a 500. It is the most-travelled conversion in the product and its migration is its own increment. | platform | 2026-12-31 |
| Nothing fences a **consumer** that reads `.records` and drops `.unreadable`. That is one level up from a conversion and so outside the twelfth rule by construction. | platform | 2027-01-31 |
| Two spellings of *forward the reporter* survive — positional, and an options field — each matching its own call site's existing signature, with nothing deciding which. | platform | 2027-01-31 |
| `access-reviews-runtime-pg`' four `rowKey` sites can take ADR-0403's typed-row helpers now and still spell it locally. | platform | 2027-01-31 |
| A new required field on a `.strict()` stored shape now turns every pre-existing row into a paging `sev1`, where the same change used to be silent. The remedy belongs to the contract change (`.optional()`, or a version tag) rather than to the read. | platform | 2027-02-28 |

## References

- ADR-0373 — the rule, the primitive and its two shapes.
- ADR-0374 — the anchor table's refused row, and the second instance of the selection rule.
- ADR-0403 — `readRows`' identity helpers accepting a typed row, the prerequisite for four sites.
- ADR-0372 — an absence reported as success, which is why six routes refuse rather than shorten.
- ADR-0375 — a judgement with no case left is not a judgement (`row_dropped_deliberately`).
- ADR-0289 — a single-row read that throws is correct, so its caller must not be served past.
- ADR-0313 — `page_refusal_declared`'s five existing members and the shape they chose.
- ADR-0364 — an optional reporter defaulting to *say nothing* is the defect restated as a default.
- ADR-0400 — the `DELETE` fence both live controls met, and its silent `DELETE 0`.
- ADR-0318 — why `readTrailAsPlatform` exists, which is why it is arm 1's read.
