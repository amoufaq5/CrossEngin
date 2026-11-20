# ADR-0462: The API description declares the residency gate it is served behind, and the AI provider's residency refusal is a registered problem

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-20 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0457 (one residency refusal shape; this closes both of its open questions), ADR-0451 (the post-auth residency gate), ADR-0392 (the OpenAPI document), ADR-0450 (the AI designer's provider residency check), ADR-0337 (the falsely-complete direction) |

## Context

ADR-0457 left two open questions.

**1. The document says nothing about the residency gate.** With `--region` set, every request can be
refused on residency grounds, and `GET /v1/meta/openapi` declared none of those answers. Two checks
produce them, and they do not cover the same operations:

- The **post-auth gate** (`applyResidencyGate`) wraps every registered handler except the
  `platform.*` ones. It answers 421, 403, and 503 when the directory cannot be read.
- The **advisory pre-auth check** (`OperateHttpServer.checkResidency`) runs ahead of route matching
  on every request that carries the tenant hint header (`x-tenant-id` by default). It answers 421
  and 403, never 503: since ADR-0457's addendum it passes an unreadable directory on to the gate.
  It has no exemption, so a `platform.*` operation answers a 421 when the caller sends a hint naming
  a profiled tenant. `x-tenant-id` is also the header the gateway reads to pick the tenant, so real
  clients do send it.

So the gate's coverage alone is not what the document has to describe. The 421 and the 403 can
come from **every** routed operation, and the 503 only from the gated ones.

The document is built per compiled server by `buildOpenApiDocument`, through a `describe` thunk
that `compileOperateServer` registers. The gate is applied in `buildOperateHttpServer` *after*
`buildOperateGateway` returns, so the fact the document needs does not exist when the thunk is
created. `openApiCoverage` already solves this ordering for the out-of-registry surfaces: a thunk
read on the first request.

**2. The AI designer refuses with its own body vocabulary.** `buildAiProviderResidencyGate` answers
whether a tenant's residency profile admits the AI provider. The design routes turn a refusal into
`application/json` `{error, detail}` with three codes: `ai_provider_residency_forbidden` (403),
`ai_provider_residency_undeclared` (403) and `ai_residency_unresolved` (503). It is an HTTP response
(`POST /v1/ai/design` and the async job route), not a boot refusal, so it is in scope.

Measuring the console's reader turned up a live defect beside it. `operate-web`'s
`throwDesignError` read every 503 as "No AI provider is configured on the server." That included
`ai_residency_unresolved`, whose real cause is an unreadable profile and whose remedy is to retry.
So a tenant whose residency directory was down was told the deployment had no AI provider.

## Decision

**1. The document declares the residency responses iff a gate is configured, from what the gate
reported.**

- `OpenApiEmitInput.residency: OpenApiResidencyDeclaration | null` is **required**. `null` is a
  claim, not silence: no gate is configured, so no operation can answer a residency refusal and the
  document declares none.
- The declaration is `{gatedOperationIds, tenantHintHeader}`. `gatedOperationIds` is what
  `applyResidencyGate` **returned**. That function now returns the operations it wrapped instead of
  a count. The document therefore reads the gate's own decision rather than a second reading of the
  `platform.` exemption rule.
- `buildOperateHttpServer` holds the declaration in a local that starts at `null`, fills it after
  `applyResidencyGate` runs, and passes `openApiResidency: () => residencyDeclaration` to
  `buildOperateGateway`. It passes the thunk **unconditionally**, not inside a conditional spread,
  so the forwarding cannot drop it (ADR-0386, ADR-0391). Every gateway the binary builds, the boot
  one and each per-tenant one, gets this with no change to `node.ts`.
- When a gate is configured, the emitter adds three response components and one schema component:
  - `ResidencyMisdirected` (421): carries the required `x-crossengin-region` header. It is
    referenced on **every** routed operation. Its description says that on a gate-exempt operation
    only the pre-auth check answers it, and only when the request carries the named hint header.
    The header name is the configured one, not a hard-coded default.
  - `UnavailableOrResidencyUnresolved` (503): referenced **only** on operations in
    `gatedOperationIds`. It is the 403's treatment and not a residency-only response, because the
    gate is one of several 503 producers on a gated operation (see the addendum): its
    `application/problem+json` schema is `anyOf [Problem, ResidencyProblem]`, it keeps
    `application/json` → `HandlerError`, and `retry-after` is declared but not required.
  - `ForbiddenOrResidencyViolation` (403): replaces the role-refusal 403 entry and admits both
    shapes. Its `application/problem+json` schema is `anyOf [Problem, ResidencyProblem]`, and it
    keeps `application/json` → `HandlerError`.
  - All three reference one schema, `ResidencyProblem`, for their residency arm. Its
    `type`, `status` and `extensions.reason` enumerations are read off `RESIDENCY_REFUSALS`, the
    builder's own map, so a change to the builder moves the document with it.

**2. The AI provider's refusal is an RFC 9457 problem under types of its own.**

- `PROBLEM_TYPES` gains `ai_provider_residency_forbidden`, `ai_provider_residency_undeclared` and
  `ai_provider_residency_unresolved`, under the registry's `https://crossengin.io/errors/` base.
- `aiProviderResidencyRefusal(input)` in `@crossengin/api-gateway-runtime`'s `problems.ts` builds
  the envelope through the same `buildEnvelope` as every other gateway problem.
  - `AI_PROVIDER_RESIDENCY_REFUSALS` maps each decision to its type, status and code, with the same
    `satisfies Record<…>` tie to the input union that `RESIDENCY_REFUSALS` has.
  - The code is kept verbatim at `extensions.error`, so a client keyed on the string finds the same
    string.
  - The 503 carries a fixed sentence and `retry-after: 5` (header and `extensions.retryAfterSeconds`).
    It is the same directory read failing as the gate's 503, so it is the same wait.
- `AiProviderAdmission`'s refusal arm is now `{allowed: false, refusal: AiProviderResidencyRefusalInput}`.
  The design routes build the answer through the builder, so status, type and code have one
  spelling instead of one per producer of an admission.
- It **does not** reuse any region-gate type or status. That question is which instance answers;
  this one is where the provider runs.
  - A 421 would send the client to another region, which would refuse it the same way, because the
    provider is a deployment-wide choice.
  - `residency-unresolved`'s fixed detail says "whether this region may serve it is unknown". That
    is false of a request this region did serve.
- `operate-web`'s `throwDesignError` reads the code from `extensions.error` when the top level has
  none. A 503 is "No AI provider is configured" only when its body says `ai_unavailable` or names
  nothing at all; a problem document, or a body carrying `reason` or `extensions.reason`, keeps the
  server's own sentence (corrected in the addendum).

## Alternatives considered

- **Declare the residency responses only on the operations the gate covers.**
  - **Pros:** it is what the open question asked for, and it is one set.
  - **Cons:** the pre-auth check answers 421 and 403 on gate-exempt operations too, when the hint
    header is sent.
  - **Why not:** a reachable answer left out of the document is the falsely-complete direction
    (ADR-0337). The sets are split by status instead: 421 and 403 everywhere, 503 where the gate is.
- **Declare them whenever `--region` could be set, or always.**
  - **Pros:** one document shape on every deployment.
  - **Cons:** on a deployment with no region gate there is no code path to a 421 or a residency 503.
  - **Why not:** a declared response that cannot occur is the falsely-complete direction in reverse.
    A generated client is made to handle it, and an operator reading the document is told it can
    happen. The document is per compiled server so that it can describe that server.
- **Re-derive the gated set in the emitter from the `platform.` prefix.**
  - **Pros:** no plumbing.
  - **Cons:** it is a second spelling of the gate's exemption rule, in a package that cannot import
    it (the rule lives in `operate-server`).
  - **Why not:** the gate reporting what it wrapped makes the document and the gate one fact.
- **Leave the residency 403 undeclared, since no shipped directory can produce it.**
  - **Pros:** ADR-0457 measured the `deny` arm unreachable from any profile `ResidencyProfileSchema`
    accepts.
  - **Cons:** `RegionGuardConfig` takes any `TenantResidencyDirectory`. The in-memory directory
    takes an unparsed profile, and `server.test.ts` reaches the 403 through it. The emitter cannot
    see which directory a server holds.
  - **Why not:** 403 was already declared, for the role refusal, so no status is added that the
    deployment cannot answer. The entry names the residency body as a second shape, and its
    description says the arm is unreachable from the shipped directories.
- **Keep the AI refusal as `{error, detail}`, the shape every other design-route refusal uses.**
  - **Pros:** one body shape within the route family, and no client change.
  - **Cons:** a residency refusal outside the registry is the divergence ADR-0457 removed, in a
    third place.
  - **Why not:** the registry is where residency answers are declared. The cost is one moved code
    and one client reader, both in this change.
- **Carry the AI code both at the top level and in `extensions`.**
  - **Pros:** no client keyed on `body.error` breaks.
  - **Why not:** ADR-0457 refused the same double carriage for the region code. Two body positions
    mean the next producer has to remember both.
- **Name the AI extension `reason`, as the region refusal does.**
  - **Pros:** one extension name across all residency problems.
  - **Why not:** these codes have been `error` in their route family since ADR-0450. Keeping the
    name makes a client's change a path change only.

## Consequences

- **Positive:**
  - A deployment serving behind a region gate publishes the 421, the 403 shape and the 503 it can
    answer, with the headers a client must read. One without a gate publishes none of them.
  - Measured with the real emitter over a bare `erp-core` compile (342 routed operations): with no
    gate, 0 operations declare 421 or 503 and the document is 970,019 bytes. With a gate covering
    all 342, 342 declare 421 and 342 declare 503, and the document is 955,504 bytes. It is
    **smaller**, because the 403 becomes a `$ref` instead of the inline two-producer entry. (The
    first measurement read 970,010 and 950,591; the addendum's longer 503 component name accounts
    for 13 bytes × 342 references.)
  - The AI provider's refusal parses under `ProblemDetailsResponseSchema` and carries
    `content-type: application/problem+json`.
  - The console no longer reports an unreadable residency profile as a missing AI provider —
    neither the AI provider check's own 503 nor, on a deployment with `--region`, the region gate's
    503, which answers first on the design routes and carries no `error` key (see the addendum).
- **Negative:**
  - A client reading `body.error` on the three AI residency refusals must read
    `body.extensions.error`. The value is unchanged.
  - The AI 503 gains `retry-after: 5`.
  - `JsonSchema.enum` widens from `string[]` to `(string | number)[]`, to carry the status enum.
    Nothing in the workspace reads it as strings.
- **Neutral:**
  - `PROBLEM_TYPES` goes from 18 to 21 entries.
  - `applyResidencyGate` returns the wrapped operation ids, not their count.
  - `DEFAULT_TENANT_HINT_HEADER` is the one spelling of `x-tenant-id` in `server.ts`, read by the
    pre-auth check and by the declaration.
- **Reversibility:** code only, no stored data. Reverting restores the undeclared document and the
  `{error, detail}` body.

## Implementation notes

- **Changed:**
  - `packages/api-gateway/src/responses.ts` (+ test): the three AI problem types.
  - `packages/api-gateway-runtime/src/problems.ts` (+ test): titles,
    `AI_PROVIDER_RESIDENCY_REFUSALS` and `aiProviderResidencyRefusal`.
  - `packages/operate-runtime/src/openapi.ts` (+ test): `OpenApiResidencyDeclaration`, the
    components and the per-operation wiring. Also `openapi-schema.ts` (the `enum` type) and
    `compile.ts` (the `openApiResidency` option, read in `describe`).
  - `apps/operate-server/src/residency-gate.ts` (+ test), `server.ts` (+ test),
    `ai-provider-residency.ts` (+ test), `ai-design-routes.ts` (+ test), `openapi-packs.test.ts`
    (fixtures gain `residency: null`).
  - `apps/operate-web/lib/design.ts`.
- **`server.test.ts` drives the real gate and the real document handler.** It builds one server with
  a region gate, an empty directory, `tenantHeader: "x-hint"` and an injected `platform.ping` route,
  and fetches `GET /v1/meta/openapi` through `dispatch`. It asserts:
  - every operation declares the 421;
  - every operation except `platform.ping` declares the 503 (`UnavailableOrResidencyUnresolved`);
  - the description names `x-hint`.

  The same server without a gate declares neither. Mutating the thunk to `() => null` fails two of
  the three cases.
- **`openapi.test.ts`** compares the real `erp-core` document both ways. It checks that every added
  `$ref` resolves, and pins the component enumerations against the builder's map.
- **Not run:** the full workspace sweep and a live server. A later stage verifies live.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The tenant-status gate (`--tenant-status-gate`, on the shipped compose) also answers a 403 problem and a retryable 503 on every non-platform route. On a region-gated document its 503 is now admitted by the 503 component's `Problem` arm; on a document with no region gate, and for its 403's `reason` field, nothing declares it. The same thunk shape would close it. | CrossEngin platform | _unscheduled_ |
| A gated operation declares its 503 and an ungated one does not, although the write audit's `audit_unavailable` reaches both. A 503 component on every write is the honest fix, and it is outside this ADR's question. | CrossEngin platform | _unscheduled_ |
| The AI design routes are registry routes with no `RouteSpec`. Their 403 and 503 residency problems are covered by the generic 403 and by `undeclared_success_response`, not by a declared 503. | CrossEngin platform | _unscheduled_ |
| The pre-auth hint check answers 421 on `platform.*` operations, which the gate exempts so that an operator's own profile cannot lock them out of the console. ADR-0451's exemption reasoning does not reach the hint check. This ADR documents that behaviour rather than changing it. | CrossEngin platform | _unscheduled_ |
| The role-refusal 403 is still inline on a gate-free document, and that inline entry is why the gated document came out smaller. Making it a component everywhere is a size change worth taking on its own. | CrossEngin platform | _unscheduled_ |

## References

- RFC 9457 (Problem Details for HTTP APIs). RFC 9110 §15.5.20 (421 Misdirected Request). OpenAPI
  3.1 Components Object (`responses`, `headers`).
- ADR-0457, ADR-0451, ADR-0450, ADR-0392, ADR-0386, ADR-0391, ADR-0337.

## Addendum: what review found

An adversarial review found four defects. Three are fixed and one was a missed step.

- **The gated 503 described every 503 as residency-only.** `addResidencyResponses` replaced the
  gated operations' 503 with a response whose only schema was `ResidencyProblem` — `type` enumerated
  to the three `residency-*` URIs, `extensions.reason` required — and whose description said
  "Retryable: nothing was done". Three other producers answer 503 on those operations: the write
  audit's `auditUnavailable` (`application/json` `{error, detail}`, whose detail after a link or
  unlink says "the write was made"), the tenant-status gate's problem, and the AI design routes.
  Before this ADR those 503s were undeclared. With this ADR as first written they were declared
  with a shape they do not match and a sentence that is false of one of them, which is the
  falsely-complete direction this ADR argues against. The response is now
  `UnavailableOrResidencyUnresolved`. It is shaped like the 403: `anyOf [Problem, ResidencyProblem]`
  plus `HandlerError`, a description that tells the client to read `detail` rather than assume, and
  `retry-after` declared but not required (the audit 503 sends none). A test checks that
  `auditUnavailable`'s real body satisfies the declared `application/json` arm.
- **With `--region`, the console still said "No AI provider is configured".** The region gate wraps
  the design routes and reads the same directory first, so an unreadable profile answers with the
  gate's 503. That body is a problem with `extensions.reason` and no `error` key, so `code` stayed
  null and `kind` stayed `ai_unavailable`. The Positive bullet's claim held only on deployments with
  no region gate. The tenant-status gate's 503 (top-level `reason`) went the same way.
  `throwDesignError` now treats a 503 as a missing provider only when its body says `ai_unavailable`
  or names nothing at all. Any problem document, or any body carrying `reason`/`extensions.reason`,
  keeps the server's `detail`. `operate-web` has no test runner (register P1.3), so a scratch harness
  ran the real function over six bodies: the region gate, tenant-status and AI-residency 503s read
  `http` with the server's detail; `ai_unavailable` and an empty body read the missing-provider
  sentence; and `async_unavailable` reads its own sentence.
- **`DEFAULT_TENANT_HINT_HEADER` was inserted between `RegionGuardConfig`'s doc comment and the
  interface**, which detached that documentation from the interface. It now sits above the comment.
- **The ADR index was not regenerated.** It has been now.

The 503 component's longer name re-measures the gated document at 955,504 bytes. It is still
smaller than the ungated one.


## Verified live

The run used PG 16 in compose order: `apply`, `app-role` and `eraser-role` (a no-op with
`DELETION_PGUSER` unset), then `document-indexes`, plus `column-schema` for the pg-columns arms. The
API connected as `crossengin_app` (NOSUPERUSER, NOBYPASSRLS). The build came from the tree as
reviewed and no source was edited. T has the eu-only profile; U has no profile.

- **The document under a gate** (`--region us-east --residency-file`, `--store pg`).
  `GET /v1/meta/openapi` answered 200 `application/openapi+json;version=3.1.0`, 972,875 bytes,
  over 362 operations, 18 of them `platform.*`.
  - **421**: on 362 of 362, each a `$ref` to `ResidencyMisdirected`. That component's
    `x-crossengin-region` header is `required: true`, and its description names `` `x-tenant-id` ``.
  - **503**: on 344 (362 − 18), each a `$ref` to `UnavailableOrResidencyUnresolved`, which declares
    `retry-after` and does not require it. No `platform.*` operation carries one.
  - **403**: on 362 of 362, each a `$ref` to `ForbiddenOrResidencyViolation`.
  - `ResidencyProblem` enumerates exactly the three `residency-*` type URIs and `[421, 403, 503]`.
  - `--store pg-columns` gave the same counts.
- **The same document with no region gate.** 989,720 bytes. 0 operations with a 421 or a 503, no
  `components.responses`, no `ResidencyProblem`, and `residency-` occurs 0 times. `pg-columns` gave
  the same.
- **Behaviour matches the document** (`--residency-store`, read as `crossengin_app`).
  - `GET /v1/vendors` as T answered 421 with `x-crossengin-region: eu-central`. Its type, status and
    `reason` are all in the document's enumerations.
  - `GET /v1/platform/tenants` with `x-tenant-id: T` answered 421 from the pre-auth check. Without
    the hint it answered 200.
  - With `SELECT` on `meta.tenant_residency_profiles` revoked:
    - `/v1/vendors` answered 503 with `retry-after: 5`;
    - a platform key whose tenant is T, sending the hint, answered 200 on
      `/v1/platform/tenants`, matching the absent 503 there;
    - a platform key on the placeholder tenant answered a declared 401 `tenant_mismatch`, not
      a 503.
  - After the grant was restored, the next request answered 421 again with no restart.
- **The per-tenant gateway.** U has an activated manifest that adds `Widget` (368 operations).
  Under the gate, the 421 is on 368, the 503 on 350 and the 403 `$ref` on 368, and `widget.list`
  carries 421 and 503. With no gate, none of them. No `node.ts` change was needed.
- **The AI provider refusal.** These servers ran `--region eu-central`, T's home region, because a
  residency directory cannot be configured without `--region`. The provider was a local stub.
  - With `--ai-provider-ref anthropic:us`, `POST /v1/ai/design` and `/v1/ai/design/jobs` as T
    answered byte-identical 403 `application/problem+json` bodies:
    - type `…/ai-provider-residency-forbidden`, with
      `extensions {"error":"ai_provider_residency_forbidden"}` and no top-level `error`;
    - the body parses under `ProblemDetailsResponseSchema`;
    - 0 provider calls and no design-job row.
  - With no `--ai-provider-ref`: 403 `…/ai-provider-residency-undeclared`, with
    `extensions.error ai_provider_residency_undeclared` and 0 calls.
  - Controls: U, and T under `anthropic:eu`, were each admitted with 1 provider call.
- **The AI provider's own 503 is unreachable through the CLI.**
  - With the directory unreadable, both design routes answered the region gate's 503
    `residency-unresolved`, byte-identical, with 0 calls.
  - The region gate wraps the design routes and reads the same directory first.
  - So `ai-provider-residency-unresolved` can only answer when that directory's second read, in the
    same request, fails after the first succeeded. Unit tests cover it.
- **The console's `throwDesignError`**, run against the live bodies:
  - the region gate's 503 keeps the server's residency sentence (`kind=http`);
  - both AI 403s read their codes from `extensions.error`;
  - a live `ai_unavailable` 503 alone reads "No AI provider is configured on the server."
