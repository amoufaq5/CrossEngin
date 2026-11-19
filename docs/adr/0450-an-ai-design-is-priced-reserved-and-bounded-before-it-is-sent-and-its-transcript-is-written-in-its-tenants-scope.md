# ADR-0450: An AI design is priced, reserved and bounded before it is sent, and its transcript is written in its tenant's scope

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0311 (the per-request estimate and `StreamCostMeter`), ADR-0330 (the durable estimator correction), ADR-0306 (the in-production Architect, local provider first), ADR-0338 (refuse only when nothing correct breaks), ADR-0348 (the field grant's `create` arm and the kernel coherence rules), ADR-0397 (where P2.2 was recorded: the spec teaches classification and withholds grant syntax), ADR-0333 (a store that sets no tenant context), ADR-0389 (a fake `transaction` that discards its callback), ADR-0373 (`pg-unreadable-rows.ts` declarations), ADR-0424 (the API connects as `crossengin_app`) |

## Context

The external due-diligence audit ranked two findings on the Architect medium, and the register
carried a third:

- **M-16** — *AI cost controls: per-request ceiling unwired, check-then-spend, no timeouts, stale
  pricing.* Verified at `f6faf05` as true and open, and called a falsely-true control on the shipped
  compose: `--ai-max-request-dollars` is passed under a comment claiming enforcement and was wired to
  nothing.
- **M-17** — *AI transcripts without tenant context; residency ignored for provider.* True and open,
  and reachable on the shipped stack once a cloud key is configured.
- **Register P2.2** — the design spec teaches field classification and gives no grant syntax, so an
  AI-designed manifest declares classified fields with no field grants.

Measured before the change:

- **The per-request ceiling was `null` in production.** The flag never reached the designer, and the
  budget field it was meant to fill (`maxUsdPerRequest`) was read by nothing.
- **The monthly ceiling was check-then-spend.** The route read the month's headroom, the designer
  called the provider, and `budget.record` charged it afterwards — so any number of concurrent
  requests could read the same headroom and all spend it. `record` also swallowed write failures, so
  a design whose charge failed was never charged.
- **No timeout anywhere.** No provider passed an abort signal to `fetch`, and the stream reader was
  never cancelled.
- **Pricing was wrong in both directions.** One catalogued model was priced at $15/$75 per million
  tokens against a catalogue price of $5/$25 (checked 2026-11-03) — 3× too high, so a ceiling refused
  requests it should have admitted. Any model behind an OpenAI custom base URL was priced at **$0**,
  and so was the local provider, so both ceilings admitted every request.
- **Every provider request carried the constant tenant id `"operate-design"`.**
- **None of the four transcript stores in `ai-architect-pg` set a tenant context.** Each table has
  one isolation policy, so as the non-owner `serving` role with no context an INSERT failed with
  `new row violates row-level security policy`, an UPDATE reported `UPDATE 0` while the owner saw the
  row, and a SELECT returned 0 rows.
- **`isLlmProviderAllowed` had zero non-test callers**, so a tenant's residency profile never
  affected which provider received its prompt.
- **P2.2.** The design spec mentioned `permissions.<Entity>.fields` **0** times, and its worked
  example carried **2** classified fields and **0** grants. The prompt was 8,749 characters (7,237
  for the spec alone).

Four documented claims were false and are corrected rather than repeated: `node.ts` said both cloud
providers gate `--ai-model` on a pricing catalogue, and the OpenAI custom-base-URL path does not; the
compose comment said `--ai-max-request-dollars` is *"refused before the call"*, which was wired to
nothing (it is true now, so the comment was left); `budget.record` was described as best-effort,
when a failed write meant an uncharged design; and three `pg-unreadable-rows.ts` declarations said
the transcript lists are *"served to the design-review surface"*, when those list reads have no
non-test caller. The audit's *"stale pricing"* is true and points the wrong way for one model: the
stale price over-charged, which refuses rather than admits.

## Decision

**Before a design request is sent, its model has a price, its estimate fits the per-request ceiling,
its month has been charged the estimate in one conditional statement, and the tenant's residency
profile admits the provider. Every provider call is aborted when it stops sending. Every transcript
statement runs in its tenant's context.**

- **Per-request ceiling.** `--ai-max-request-dollars` is wired into the designer in `node.ts`. A
  request estimated over it is refused before the call, and the stream cost meter aborts a stream
  that runs past it.
- **Monthly ceiling: reserve, then settle.** `reserveMonthly`
  (`packages/ai-architect-runtime-pg/src/cost-store.ts`) charges the month in one
  `INSERT … ON CONFLICT DO UPDATE … WHERE` statement before the call; a refused reservation is
  **402 `ai_budget_exceeded`**. After the call the reservation is settled against the actual cost
  into the reservation's own month. `budget.record` is deleted. The result field `total` is renamed
  `dollarsUsed`, so the workspace name rule passes by agreement rather than by a declared exception.
- **Timeout.** An inactivity watchdog in `ai-providers` (`inactivity.ts`) aborts the `fetch` and
  cancels the reader. It defaults to 120 s and is set with `--ai-provider-timeout-ms`
  (1000–3600000). It is an **inactivity** timeout, not a wall-clock limit: a slow stream that keeps
  sending is not cut off. All four provider fetch sites carry the signal.
- **Pricing.** The catalogue carries check dates (Anthropic 2026-11-03, OpenAI 2026-08-26) and the
  boot line warns once one is more than 90 days old. Each model has a pricing source — catalogue,
  declared, self-hosted free, or unpriced. **An unpriced model refuses to boot** unless
  `--ai-model-price <in>:<out>[:<cached>]` or `--ai-allow-unpriced-model` is passed; this is a named,
  announced hatch on ADR-0338's argument, since an unpriced model under a ceiling was never bounded.
  A self-hosted model — the shipped AI overlay — is warned about and still boots. A declared `0:0`
  price warns that the ceilings bound nothing rather than claiming they are enforced.
- **Tenant id.** The real tenant id is set on every provider `CompletionRequest`.
- **Residency.** `--ai-provider-ref <provider:qualifier>` declares where the provider runs, and a
  gate (`ai-provider-residency.ts`) is consulted before the budget: no profile → allowed; a profile
  and an undeclared ref → **403 `ai_provider_residency_undeclared`**; a forbidden provider → **403
  `ai_provider_residency_forbidden`**; a directory error → **503 `ai_residency_unresolved`**. A boot
  line says which state applies.
- **Transcripts.** Every statement in the four stores runs inside a tenant context
  (`tenant-context.ts`), and the reads also carry a tenant predicate (`getById` and `listForSession`
  take the tenant). Timestamps come back as ISO strings; before, the record carried a `Date` typed as
  a string.
- **P2.2.** Two spec lines teach the field-grant syntax and the three kernel coherence rules, and the
  worked example grants both of its classified fields. The adversarial review found that this alone
  made every spec-following design refused: `ensureRolesInManifest` adds the deployment's operator
  role to each entity `create` grant and not to field grants, so the kernel refused the manifest with
  *"makes 'Customer' uncreatable by 'erp_admin'"*, for a role the model is never told about.
  `graftFieldCreateArms` (`ai-design.ts`) therefore adds the deployment roles to a field grant's
  **`create` arm only** — never `read` or `update`, so a grafted role gains no read and no right to
  change a value later. When the arm is absent and built from `update`, it keeps only roles the
  entity's own `create` grant names, and a grant carrying an ABAC obligation is left alone.

The rule behind the cost half: **a ceiling that is checked after the money is spent, or against a
price of zero, is not a ceiling.** Reserving before the call is the only order in which two
concurrent requests cannot both pass on the same headroom.

## Alternatives considered

- **Keep check-then-record, with the charge after the call.**
  - **Pros:** charges the actual cost, never an estimate.
  - **Cons:** concurrent requests read one headroom and all spend it, and a failed charge leaves the
    design uncharged.
  - **Why not:** it is the defect; the live arm below is five parallel designs against a budget for
    two.
- **A total wall-clock timeout instead of an inactivity one.**
  - **Pros:** bounds one call's duration absolutely.
  - **Why not:** it cuts off a slow stream that is still delivering a design. The inactivity form
    aborts only a provider that has gone silent.
- **Refuse every unpriced model, self-hosted included.**
  - **Pros:** one rule.
  - **Why not:** the shipped AI overlay serves a self-hosted model and boots today; refusing it breaks
    a working deployment (ADR-0338). Self-hosted is warned about instead.
- **Treat a profiled tenant with an undeclared provider location as allowed.**
  - **Pros:** no new refusal.
  - **Why not:** it sends a tenant with a residency profile to a provider whose location nobody
    stated. Undeclared is a 403 that names the flag; a tenant with no profile is unaffected.
- **Teach grant syntax and leave field grants untouched by `ensureRolesInManifest`.**
  - **Why not:** measured by the review — every design that followed the spec was refused on every
    attempt.
- **Build a missing `create` arm by copying `update`.**
  - **Why not:** copying `update` roles that the entity's own `create` grant does not name trips a
    different kernel rule; the review's first fix did exactly that and a probe caught it. Such a role
    could never create the record anyway, so dropping it changes no access.

## Consequences

- **Positive:** the shipped `--ai-max-request-dollars` is enforced before the call; concurrent
  designs cannot overspend the month; a silent provider is aborted; an unpriced model no longer makes
  both ceilings vacuous; a residency profile constrains the provider; transcripts can be written and
  read by the non-owner role; and an AI-designed manifest carries field grants.
- **Negative:** a design can now be refused 402 under concurrency, 403 on residency, and refused
  before the call over the per-request ceiling. A deployment on the OpenAI custom-base-URL path
  refuses to boot until it declares a price (`deploy/VERCEL-SUPABASE.md` names both remedies). The
  prompt grew to 9,972 characters (8,460 for the spec), and the prompt-size budget test was raised
  from 9,668 to 10,500 with the reason stated. **The settle step does not work live** (open question
  1), so every design currently leaves its full estimate charged to the month.
- **Neutral:** the grafted `create` arm gives the operator role the right to supply a classified
  field at create and nothing more; residency is declarative, not observed.
- **Reversibility:** each part is a flag or a call site. Reservations already written stand in the
  ledger.

## Implementation notes

Where the reports disagree: the review supersedes the implementer, and the live runs supersede both.
Two claims are corrected by the live run. The review's *"the settlement delta can be negative
safely"* is refuted (open question 1). The implementer's *"the real tenant id now goes on every
provider request"* holds inside the process only (open question 2).

In-process, per package (after the review's fix): operate-server's ten AI-related test files 731
(was 727), `@crossengin/testing` 906, ai-providers 69, ai-providers-anthropic 74,
ai-providers-openai 83, ai-providers-local 39, ai-router 54, ai-architect-runtime 149,
ai-architect-runtime-pg 62, ai-architect-pg 30, architect-cli 275; typecheck clean throughout. The
transcript stores' fake now runs transaction callbacks and checks bind arity.

Mutation-checked, each reversed: removing the designer ceiling wiring in `node.ts`; removing the
conditional `WHERE` in `reserveMonthly`; skipping the residency gate; restoring the constant tenant
id; removing the settle call; removing the example field grant; weakening the spec's grant line;
removing the tenant context from a transcript store; removing the abort signal from Anthropic's
streaming call, OpenAI's call and the local provider's call; bypassing the unpriced refusal;
disabling the declared-$0 branch. Removing the abort signal from Anthropic's **non-streaming** call
first passed all 73 tests; a test was added and that mutation now fails 1. The review's fixes:
removing the graft call fails 4 tests, removing the entity-`create` role filter fails 1, removing
the ABAC guard fails 1.

Live, by the implementer, on a throwaway PG 16 cluster as the non-owner `serving` role:

- `reserveMonthly`: $0.40 then $0.50 against a $1 limit were granted (0.9); a further $0.20 was
  refused; a new month's first $2 against $1 was refused; 20 parallel $0.10 reservations against $1
  granted exactly 10, total exactly 1.00, no errors.
- Transcripts: a full session lifecycle (start, message, tool call, proposal, end) wrote, and
  `getById` returned the session for its own tenant and `null` for another. The old shape failed as
  described in Context.

Live, in compose order on PG 16, `--store pg`, the API connecting as `crossengin_app`, against a fake
OpenAI-compatible provider (`OPENAI_BASE_URL`, `--ai-model house-model`):

- No declared price: boot refused, exit 1, naming `--ai-model-price` and `--ai-allow-unpriced-model`.
- `--ai-model-price 500000:500000`: 422 `design_failed` with the issue *"estimated at $5555.0000,
  over the per-request ceiling of $2.0000"*; **0** provider calls. Control at `1:2`: the provider was
  called once.
- A stalled provider with `--ai-provider-timeout-ms 2000`: 422 after 6.03 s, *"provider sent nothing
  for 2000ms; the request was aborted"*, 3 attempts.
- A monthly ceiling sized for two reservations, five parallel designs: **2** provider calls and
  **3 × 402** `ai_budget_exceeded`; the ledger stayed at or below the limit (0.193020 against
  0.2027).
- A tenant whose profile does not allow `openai:us` (`--ai-provider-ref openai:us`): 403
  `ai_provider_residency_forbidden`, *"nothing was sent to the provider"*. A tenant with no profile:
  the provider was called.
- **Settle failed on every call:** `could not settle the monthly charge; the reservation stands`,
  violating `architect_tenant_cost_dollars_used_check`; reproduced by hand.

Not run live: the stream cost meter's mid-stream abort, the transcripts in the compose-order pass,
and P2.2 — the fake provider returned non-manifest JSON, so no design reached validation; the graft
is verified in-process only.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| ~~**Settle fails live on every design.**~~ **Closed in the commit that landed this ADR.** `addMonthly` routes a negative delta through `UPDATE … SET dollars_used = GREATEST(0, dollars_used + $3)` on the reservation row, since Postgres checks the proposed `INSERT` row against `dollars_used >= 0` before conflict resolution; the test fake now models that CHECK, which is why the unit tests had passed. A refund for a month with no row answers 0 rather than inventing a negative month. | CrossEngin platform | closed |
| The tenant id reaches the internal `CompletionRequest` only; the OpenAI-compatible body carries no `user` field, so nothing on the provider wire names the tenant. | CrossEngin platform | _unscheduled_ |
| If the cost ledger is unreachable at reservation, the route answers 402 `ai_budget_exceeded` rather than 503 — fail-closed, naming the wrong cause. | CrossEngin platform | _unscheduled_ |
| The per-request ceiling and the timeout apply per attempt, so one design can spend up to three times the ceiling across its retries, and a 2 s timeout took 6.03 s. | CrossEngin platform | _unscheduled_ |
| Residency is declarative: nothing verifies `--ai-provider-ref` against where the provider runs; the gate runs when a design job is queued, not again when it runs; the CLI's provider router is not covered; and the shipped compose passes no residency flags, so the gate is not consulted there (the boot line says so). | CrossEngin platform | _unscheduled_ |
| `--ai-model-price` applies only to the default model. | CrossEngin platform | _unscheduled_ |
| Catalogue prices are dated, not checked; the code can only warn after 90 days. | CrossEngin platform | _unscheduled_ |
| The transcript list reads are not migrated to the report-and-carry-on primitive and are declared `unmigrated`: a stored `infinity` timestamp throws and takes the list with it. Latent — they have no non-test caller. | CrossEngin platform | _unscheduled_ |
| A provider with no pricing, recorded spend and no ceiling reports `monthly_budget_exhausted` (402); no path to it was found. | CrossEngin platform | _unscheduled_ |
| A `node.ts` comment says an open question is recorded in the repository's assistant notes; nobody checked that it is. | CrossEngin platform | _unscheduled_ |

## References

- `apps/operate-server/src/ai-design.ts` (`graftFieldCreateArms`), `ai-design-routes.ts`,
  `design-runner.ts`, `ai-design-budget.ts`, `ai-design-pricing.ts`, `ai-provider-residency.ts`,
  `cli.ts`, `node.ts`
- `packages/ai-providers/src/inactivity.ts`; the pricing, streaming and request-building modules of
  `ai-providers-anthropic`, `ai-providers-openai` and `ai-providers-local`
- `packages/ai-architect-runtime-pg/src/cost-store.ts` (`reserveMonthly`)
- `packages/ai-architect-pg/src/tenant-context.ts` and the four transcript stores
- `packages/testing/src/strategy/pg-unreadable-rows.ts`; `deploy/VERCEL-SUPABASE.md`
- External due-diligence audit, findings M-16 and M-17; register item P2.2
