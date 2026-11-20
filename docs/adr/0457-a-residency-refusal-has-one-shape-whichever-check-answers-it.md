# ADR-0457: A residency refusal has one shape, whichever check answers it

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-20 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0451 (the post-auth residency gate; this closes the first clause of its open-question row), ADR-0359 (500 bodies name nothing; the problem registry gained `internal_server_error`), ADR-0398 (early refusals carried no security headers) |

## Context

Two checks can refuse a request on residency grounds, and a client cannot tell which one answered.

- The **pre-auth hint check** (`OperateHttpServer.checkResidency`) reads the unverified `x-tenant-id`
  header before the gateway. It is advisory routing only (ADR-0451).
- The **post-auth gate** (`withResidency` in `residency-gate.ts`) reads the tenant the auth stage
  established. It is the residency decision.

Each built its own problem document, and they disagreed on every axis a client could key on. Measured
on the tree before this change, for the same tenant and the same route, with the hint and then without
it:

| | pre-auth hint check | post-auth gate |
|---|---|---|
| `type` (421) | `https://crossengin.io/problems/misdirected-region` | `https://crossengin.dev/problems/misdirected-region` |
| home region in the body | `extensions.correctRegion` | top-level `correctRegion` |
| stable code | none | top-level `reason` |
| `x-crossengin-region` | yes | yes |
| security headers, `x-request-id` | no | yes (added by the gateway) |

Neither host matched the gateway's own problem registry. `PROBLEM_TYPES` in `@crossengin/api-gateway`
puts every type under `https://crossengin.io/errors/`, and it had no residency entry, so each producer
wrote its own URI. 421 was also missing from `PROBLEM_STATUS_CODES`, so neither body would have parsed
under `ProblemDetailsResponseSchema`.

A client keyed on the body could not handle the 421 from both checks. One keyed on `type` saw two
URIs. One reading `extensions.correctRegion` found nothing on the gate's 421. One reading top-level
`correctRegion` found nothing on the hint check's 421. Only the header was common to both.

## Decision

**One builder produces every residency refusal, from the problem registry.**

1. `PROBLEM_TYPES` gains `residency_misdirected`, `residency_violation` and `residency_unresolved`
   under the registry's existing base, `https://crossengin.io/errors/`. `PROBLEM_STATUS_CODES` gains
   421. `ProblemDetailsResponseSchema` refuses a 421 without `extensions.correctRegion`, in the same
   way it already requires an extension for 401, 410 and 429. `RESIDENCY_REGION_HEADER` is the one
   spelling of `x-crossengin-region`.
2. `residencyRefusal(input)` in `@crossengin/api-gateway-runtime`'s `problems.ts` builds the
   envelope. `RESIDENCY_REFUSALS` maps each decision to the registry key, the status and the stable
   `reason`. The input is a discriminated union, so a 421 cannot be built without a region, and the
   map `satisfies Record<ResidencyRefusalInput["decision"], …>`, so an input arm without an entry and
   an entry without an input arm are both compile errors. It is total over that union and no wider:
   mapping `decideRegionRouting`'s actions onto it is each caller's job.
3. **A 421 carries the home region twice**: `extensions.correctRegion` in the body and
   `x-crossengin-region` in the headers. Both producers already sent the header (the table above);
   they disagreed on where the body put the region. `extensions.correctRegion` is now the one body
   position, and the header is kept unchanged on both paths, so a client keyed on either keeps
   working. The `reason` code moves into `extensions` as well, because the registry's
   body shape keeps extension members there.
4. **The 403 follows the same rule.** It uses the registry's type and `extensions.reason`, and names
   no region in the body or the headers, because the profile allows no region it could name. The
   gate's 503 (directory unreadable) takes the third entry. It carries a fixed sentence and
   `retry-after: 5`, both as a header and as `extensions.retryAfterSeconds`.
5. Both producers call the builder. The gate turns the envelope into a `HandlerOutput`. The hint
   check turns it into a `RawHttpResponse`, and **also** adds the six default security headers and
   `x-request-id`. Before, those were added only to the gate's response, by the gateway. Now the two
   refusals are the same bytes and carry the same set of headers.

Nothing in the body depends on the request, so the two bodies are byte-identical rather than
identical apart from an id.

## Alternatives considered

- **Keep the gate's shape and move the hint check onto it.**
  - **Pros:** clients written against ADR-0451's gate need no change.
  - **Cons:** it keeps a type URI outside the registry and top-level extension members that
    `ProblemDetailsResponseSchema` does not describe. Every other refusal from this gateway nests
    extensions.
  - **Why not:** the registry is the one place a problem type is declared. A third spelling sitting
    beside it is the defect this ADR removes, not a fix for it.
- **Carry `correctRegion` and `reason` at both the top level and in `extensions`.**
  - **Pros:** no client keyed on either body position breaks.
  - **Cons:** the body would carry the same fact twice under two shapes, and the top-level copy is
    outside the schema.
  - **Why not:** the header already gives a client that read the gate's top-level field a position
    that is unchanged. Two body positions would mean the next producer has to remember both.
- **Make the hint check a 307 or drop it.** Out of scope. ADR-0451 kept it as advisory routing, and
  this ADR only changes the shape of its answer.

## Consequences

- **Positive:**
  - One route answers its 421 in one shape, whichever check refused. A client keyed on `type`, on
    `extensions.correctRegion` or on `x-crossengin-region` handles both.
  - The pre-auth refusal now carries the security headers and an `x-request-id`, as every gateway
    refusal does.
  - A residency body now parses under `ProblemDetailsResponseSchema`.
- **Negative:**
  - A client reading the gate's **top-level** `correctRegion` or `reason` (shipped in ADR-0451, one
    day earlier) must read `extensions` instead. The header is unchanged on that path.
  - Every residency `type` URI changes. Both old hosts are gone.
- **Neutral:** `PROBLEM_TYPES` goes from 15 to 18 entries and `PROBLEM_STATUS_CODES` from 15 to 16.
  No other producer emits 421.
- **Reversibility:** code only, with no stored data. Reverting restores the two shapes.

## Implementation notes

- Changed: `packages/api-gateway/src/responses.ts` (+ test);
  `packages/api-gateway-runtime/src/problems.ts` (+ test); `apps/operate-server/src/residency-gate.ts`
  (+ test); `apps/operate-server/src/server.ts` (+ test). `regionProblem` and the three local type
  constants are deleted rather than kept beside the builder.
- `server.test.ts` sends the same tenant through both checks. Each arm is pinned to its producer,
  because a hint equal to a valid credential's tenant would let the gate answer a disabled pre-auth
  check with the same bytes (found in review): the `pre` arm carries an unregistered api-key, which
  the gateway could only answer 401, and must run no pipeline (`onExecution` count 0); the `post`
  arm sends no hint and must run exactly one. Mutating the pre-auth redirect arm to `return null`
  fails the comparison. It asserts the two bodies are equal byte for byte, and that
  the header maps are equal apart from `x-request-id`. This is tested for the 421 and for the 403.
  Two further mutations were checked. Dropping the security headers from the pre-auth arm fails both
  comparisons. Adding a top-level field to the gate's body fails both comparisons and the gate's own
  test.
- Two `server.test.ts` assertions pinned the old shapes (top-level `reason` and `correctRegion` on
  the gate's 421 and 503). They now read `extensions`.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The OpenAPI document declares no 421, 403 or 503 for the residency gate, which covers every non-platform route when `--region` is set. | CrossEngin platform | _unscheduled_ |
| `ai-provider-residency.ts` refuses with its own `error` codes (`ai_provider_residency_forbidden`). It answers a different question (where the provider runs), but uses a different body vocabulary on a residency refusal. | CrossEngin platform | _unscheduled_ |

## References

- RFC 9457 (Problem Details for HTTP APIs); RFC 9110 §15.5.20 (421 Misdirected Request).
- ADR-0451, ADR-0359, ADR-0398.

## Verified live

Run on PG 16 in compose order: `apply` and `app-role` as the owner, then `document-indexes`. The API
connected as `crossengin_app` (NOSUPERUSER NOBYPASSRLS) with `--store pg --region us-east`. Tenant T
had the eu-only profile and tenant U had no profile. The route was `GET /v1/vendors`.

- **421, file-backed directory.** T's api-key was sent once with `x-tenant-id: T` (pre-auth) and
  once without the header (post-auth gate).
  - Both answered 421 with `x-crossengin-region: eu-central`, the six security headers and an
    `x-request-id`.
  - Both bodies were the same 242 bytes (`cmp` exit 0):
    `{"type":"https://crossengin.io/errors/residency-misdirected",…,"extensions":{"reason":"residency_misdirected","correctRegion":"eu-central"}}`.
  - The two header sets were identical apart from `x-request-id`, `date` and the connection headers.
  - Neither old type host appeared in either body.
  - **Non-vacuity check.** `--gateway-execution-capture 1` recorded exactly one
    `meta.gateway_pipeline_executions` row: `dispatch_handler`, `deny`, 421, for the request without
    the header. The request with the header recorded none, so it was answered before the gateway.
- **421, Postgres-backed directory.** With `--residency-store`, read as the confined role, the same
  two requests produced the same bytes. The bodies were also byte-identical to the file-backed run.
- **Controls.**
  - Unprofiled tenant U: 200.
  - The same two requests on `--region eu-central`: 200 and 200.
  - A header naming U with T's api-key: 401 `tenant_mismatch`.
- **503 from the gate.** A stored profile was edited to violate the schema, and in a second run
  `SELECT` on the table was revoked from the role. Both answered 503 with `retry-after: 5`, the
  security headers and the `residency-unresolved` body, which names neither host nor tenant. The two
  bodies were byte-identical. After the fix was reversed, the next request answered 421 without a
  restart.
- **Both bodies parse.** The 421 and 503 bodies parse under `ProblemDetailsResponseSchema`.
- **The 403 cannot be produced live.**
  - Both directories parse profiles through `ResidencyProfileSchema`. Its refinement requires
    `primaryRegion` to be in `allowedRegions` and forbids overlap between the allowed and forbidden
    lists.
  - `decideRegionRouting`'s `deny` arm therefore cannot be reached from a stored profile. A residency
    file that tries it is refused at boot (exit 1), and a stored row that tries it answers 503.
  - The 403 equivalence is covered only by the stub-directory unit tests.
- **Open question 1 measured.** With the profile unreadable and `x-tenant-id` present, the pre-auth
  check answers 500. Its type is `https://crossengin.io/problems/internal-server-error`, which is
  outside the registry's `/errors/` base. Without the header the same fault answers 503.

## Addendum: the hint check's directory error, and the pre-gateway 500's type

Open question 1 is closed, and so is the one adjacent divergence the live run found.

- **The pre-auth hint check no longer turns an unreadable directory into a 500.** It is advisory
  (its own comment says so: it is not the residency decision), so a directory that cannot answer is
  no answer there, and the request goes on to the post-auth gate, which is the decision and refuses
  an unreadable profile with its retryable 503 through `residencyRefusal`. Measured live before the
  change: the same fault answered 500 with the hint and 503 without it. ADR-0451 kept the 500 only
  because the fault-logging test used that path as its vehicle for a pre-gateway throw; that test
  now throws from a webhook handler instead, and two cases pin 503 with and without the hint.
- **A 500 the serving core answers before the gateway carries the registry's type.**
  `internalErrorResponse` spelled `https://crossengin.io/problems/internal-server-error` while
  `PROBLEM_TYPES.internal_server_error` is `https://crossengin.io/errors/internal-server-error`, so a
  pre-gateway 500 and a gateway 500 differed in `type`. It reads the registry constant now, and the
  fault-logging test asserts the URI. This is the same one-shape rule on the 500 (ADR-0449's).

## Addendum: both open questions are closed by ADR-0462

- **The OpenAPI document now declares the residency answers, and only when a gate is configured.**
  `applyResidencyGate` returns the operations it wrapped. `buildOperateHttpServer` hands that set to
  the document through a thunk read on the first request. The 421 (with `x-crossengin-region`) and
  the 403 shape are declared on **every** routed operation, because the pre-auth hint check has no
  exemption. The 503 is declared only on the gated ones, because the hint check passes an unreadable
  directory on to the gate (this ADR's first addendum). Like the 403, it admits the other producers'
  shapes as well as this ADR's, because the region gate is not the only 503 a gated write can answer
  (ADR-0462's addendum). A server with no gate declares none of them.
- **The AI provider's residency refusal is a registered problem with types of its own.**
  `aiProviderResidencyRefusal` builds it through the same envelope. It reuses none of this ADR's
  three types, because it answers where the provider runs rather than which instance answers. Its
  old `error` code is kept at `extensions.error`.
