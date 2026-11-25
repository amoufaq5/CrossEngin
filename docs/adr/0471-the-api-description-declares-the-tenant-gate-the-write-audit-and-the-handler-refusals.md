# ADR-0471: The API description declares the tenant-status gate, the write audit and the handler's own refusals, on exactly the operations that can answer them

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0392 (the OpenAPI document), ADR-0462 (the residency gate's responses), ADR-0468 (payment allocation refusals), ADR-0428 (the write audit), ADR-0334 (the tenant-status gate), ADR-0359 (a refusal one layer out), ADR-0337 (falsely-complete documents), ADR-0372 (tests that pin a defect) |

## Context

`GET /v1/meta/openapi` is the document a generated client is built from. ADR-0392 made it complete
over **routes**. ADR-0462 made it describe the region gate's 421, 403 and 503. What it still did not
describe were the refusals most clients actually receive:

- **The tenant-status gate.** `--tenant-status-gate` is on in the shipped compose (ADR-0376). It
  answers a 403 problem (`tenant_writes_blocked`, `tenant_reads_blocked`, `tenant_not_provisioned`,
  with top-level `tenantStatus` and `reason`) and a retryable 503 with `retry-after: 5` on every
  non-platform operation. On a document with no region gate, neither was declared. On a region-gated
  document, the gate's 503 matched only by accident, through the generic `Problem` arm. This is
  ADR-0462's first open question.
- **The write audit.** `audit_unavailable` (503, `application/json` `{error, detail}`) is answered on
  every entity create, update, delete and transition, and on association link and unlink, whenever a
  recorder is wired (ADR-0428). It was declared nowhere, except that ADR-0462's composed 503 happened
  to admit it on region-gated operations. This is ADR-0462's second open question.
- **The handler's own 404, 409 and 422.** These were declared on no operation at all, which is
  ADR-0468's open question 8. The 400 was list-only (ADR-0392). The handler arms answer:
  - 404 on read, update, delete and transition.
  - 409 on create (`id_conflict`, and from `writeTxn` `unique_violation` and
    `server_reference_unresolved`), on update (`conflict` for a stale `expectedUpdatedAt`,
    `unique_violation`, `state_changed`), on delete (`state_changed` from `removeIf`,
    `record_referenced` from a referenced row) and on transition (`invalid_transition`,
    `transition_conflict`).
  - 422 on create and update (`validation_failed` with `{error, fields: [{field, code, message}]}`,
    `field_not_declared`, `field_server_owned`, `record_id_malformed`, `reference_not_found`).
  - Every write guard, posting effect and segregation-of-duties refusal is 409 or 422. Re-measured in
    review over the tree as it stood: the literal-status `new PostingRefused(` sites in
    `inventory.ts`, `write-effects.ts` and `posting-period.ts` are 409 ×12 and 422 ×14, and the three
    that pass a status through (`tax-determination.ts`, `refuseRemittance`) take it from 409/422
    tables. The guard `status:` literals in the four files that define guards (`write-guards.ts`,
    `compile.ts`, `inventory.ts`, `payment-allocation.ts`) are 409 ×2 and 422 ×27. The first draft
    quoted different guard figures (409 ×3, 422 ×26 over two files) that the review could not
    reproduce; the counts move with every guard added, and the claim that matters is "no other
    status".
- **The role refusal's size.** ADR-0462's fifth open question: the role-refusal 403 and the 401 were
  inlined on every operation. ADR-0462 recorded that this inline copy was why the gated document came
  out *smaller* than the ungated one.

Measured on `erp-core` before this change: 343 operations, 971,941 bytes, and zero operations
declaring 404, 409, 422 or any 503 on a deployment without a region gate.

## Decision

**A refusal is declared on an operation if and only if something wired on this server can answer it
there.** The emitter is never asked to infer that. Each producer hands over the fact it already owns:

1. **The tenant-status gate.** `applyTenantStatusGate` returns the `ReadonlySet<string>` of the
   operation ids it wrapped, instead of a count. `tenantStatusOpenApiDeclaration(set)` builds
   `OpenApiTenantStatusDeclaration` from the gate's own constants: the two problem types,
   `TENANT_STATE_REFUSAL_REASONS`, `TENANT_STATUS_UNAVAILABLE_REASON`,
   `TENANT_STATUS_RETRY_AFTER_SECONDS`, and the states `blocksWrites` or `blocksReads` refuses in,
   in lifecycle order. The gate's bodies are built from those same constants, so the published enums
   and the bodies actually sent come from one source. `buildOperateHttpServer` passes it through the
   new `openApiTenantStatus` thunk, which the compiler reads on the first request. That is
   `openApiResidency`'s shape (ADR-0462), and it is needed for the same reason: the gate is applied
   after the compile returns.
2. **The write audit.** `writeAudit` is non-null exactly when `options.entityAudit` is wired. It
   carries the association write operation ids, because those have no `RouteSpec`. The 503 is
   declared on entity create, update, delete and transition, and on those ids. It is never declared
   under `--store memory`, where no recorder exists.
3. **The handler's refusals.** `ACTION_HANDLER_REFUSALS` is a **total map over `RouteAction`**. For
   each action it lists the codes the arm answers itself, the conditional codes, and whether write
   checks and the audit run. A seventh action is a compile error.
   - 404 is declared on read, update, delete and transition.
   - 409 is declared on create, update and transition. On delete it is declared only where
     something can refuse: `state_changed` when the entity is lifecycle-driven (from the handler
     context's own `lifecycleStateFields`), and `record_referenced` when some resolved reference
     field targets it.
   - 422 is declared on create and update always, and on delete and transition only when write
     checks are wired. It is never declared on read or list.
   - `writeRefusals.checks` is true when guards, effects or segregation of duties are configured.
     It adds a sentence to the 409 and 422 saying that a guard or effect may refuse with its own
     code. A guard's reach is decided inside a closure, so this is a declared **upper bound** and the
     sentence says so.
4. **Responses are components named by their arms.** Every response is composed from one arm per
   producer, and the arms are the component name: `ForbiddenOrResidencyViolationOrTenantStateRefused`,
   `UnavailableOrAuditUnrecorded`, `ConflictDeleteStateConditionedReferenced`. One deduplicated entry
   then serves every operation with the same producers. A merged header is required only if every arm
   sends it.
5. **A declared 503 is never one producer's** (added in review). Every 503 entry also admits the
   gateway pipeline's own RFC 9457 `Problem`, and on an operation with no `RouteSpec` (an injected
   route: the AI design routes, read state, job invoke) that route's own `application/json`
   `{error, detail}` 503 as well, under the extra name segment `OrRouteOwn`. So `retry-after` is
   declared on the tenant gate's 503 with its figure and is not required, since the gateway's 503
   does not always send it. ADR-0462's two names are kept as they were. Only referenced
   components and schemas are emitted, so a gate that is off leaves no trace in the document.

## Alternatives

- **Declare everything everywhere.** Rejected. That is the falsely-complete direction ADR-0337
  argues against. A 503 the deployment cannot produce tells a client to write a retry loop for
  nothing, and a 409 on a read sends it looking for a conflict that cannot happen.
- **Re-derive the gate's exemptions in the emitter.** Rejected. That would be a second spelling of
  `DEFAULT_EXEMPT_OPERATION_PREFIXES` and would drift on the first configured
  `exemptOperationPrefixes`. The returned set is derived from the wrapping itself.
- **Enumerate guard codes per entity.** Rejected for now. The codes live in closures
  (`lockedDocumentGuard`, `journalPostingGuard`, the inventory and payment-allocation guards), so
  enumerating them per entity means each guard declaring its reach. That is a contract change across
  every guard and belongs in its own increment.
- **Inline per operation, as before.** Measured below: inlining is ~18% larger for the same content.
- **Let the tenant gate's 503 entry admit only the gate's body.** That was the first draft, and the
  review refuted it on the shipped compose: `--ai-design` is on and, with no provider configured,
  `POST /v1/ai/design` answers `503 application/json {"error":"ai_unavailable"}`, while the entry the
  document declared on that operation admitted only `application/problem+json`
  `TenantStatusUnavailableProblem`. A generated client validating responses would reject the real
  one. ADR-0462 had kept the generic arms on the residency 503 for exactly this reason. The same
  holds on every gated operation for the gateway's own 503s, which are `Problem` documents.

## Consequences

**Positive.**
- A client generated from the document now has a typed shape for:
  - the 403 and 503 every tenant-status-gated deployment sends;
  - the 503 an audited write sends, with both of its sentences (rolled back, or "the write was
    made" after a link or unlink);
  - the 422 validation body, distinguishable from a coded refusal by `fields`;
  - 404 and 409.
- Measured on `erp-core` (343 operations, no gates, no checks): 237 operations declare 404, 223
  declare 409, and 102 declare 422. With checks, audit and the gate on: 237 / 237 / 237, and 343
  declare a 503. (Re-measured in review: unchanged.)
- The document went from 971,941 bytes (before, declaring none of this; the implementer's figure,
  not re-derived in review) to 819,894 bytes (no checks) or 833,704 bytes (checks, as the tests emit
  it), re-measured after the review's sentence changes. It is smaller while declaring more, because
  the 401 and 403 are shared components. Inlining the same two entries on every operation measures
  1,021,325 bytes against 833,704: a drop of 187,621 bytes, 18.4% of the inlined document, about 547
  bytes per operation. A test re-derives the figure and floors it at 500 bytes per operation.

**Negative / cost.**
- The 409 and 422 under `checks` are an upper bound. On a deployment with any guard, every delete
  and transition declares a 422 even where no guard covers that entity. The sentence says so.
- `record_referenced` is also an upper bound. It is derived from reference fields, so it ignores
  cascade edges, and `--store memory` never raises it.
- `OpenApiEmitInput` gained three **required** fields, so every caller states what is wired
  (ADR-0331). `openapi-packs.test.ts` and the operate-runtime tests pass explicit "ungated" values.

## Implementation notes

- `packages/operate-runtime/src/openapi.ts`:
  - `ResponseArm` and `composeResponse`, plus the arms for 401, the role refusal, the residency
    pair, the tenant-state 403, the tenant-status 503, the audit 503 and the 404.
  - `actionRefusalArm` and `ACTION_HANDLER_REFUSALS`.
  - The lazy `TenantStateProblem`, `TenantStatusUnavailableProblem` and `ValidationFailed` schemas.
    `TenantStateProblem`'s `tenantStatus` is `oneOf [string enum, null]` and `reason` is top-level,
    as the gate sends it.
  - `components.responses`.
- `packages/operate-runtime/src/compile.ts`: the `openApiTenantStatus` option, and forwarding of
  `tenantStatus`, `writeAudit` and `writeRefusals` into the describe thunk.
- `apps/operate-server/src/tenant-status-gate.ts`: the set return value, the reason and retry-after
  constants, and `tenantStatusOpenApiDeclaration`. The doc comment had named `node.ts` as the one
  caller; it is `buildOperateHttpServer`.
- `apps/operate-server/src/server.ts`: the `tenantStatusDeclaration` thunk, filled from the gate's
  return value.

## Verification

- `@crossengin/operate-runtime` (before review): build, typecheck and test green, 1,839 tests. `openapi.test.ts` has
  60 tests (17 new). They check both directions:
  - gated operations carry the gate's 403 and 503 and the exempt one carries neither;
  - an ungated document has no tenant schema or text;
  - the region-plus-tenant composition admits all three 403 bodies, and `retry-after` stops being
    required;
  - the audit 503 is declared on exactly the audited operations, including a fixture association
    link, and on none without a recorder;
  - 404, 409 and 422 follow the action map, the `checks` flag and the delete conditions.
  Two further checks: the widest document (every gate on) has no dead component, no unresolvable
  `$ref` and unique `(name, in)` pairs; and `meta.openapi.read` on a real compiled server is driven
  through its handlers. A missing read, `{}`, an undeclared key, a duplicate id, an illegal
  transition and a refusing recorder each answer a status the document declares, with a schema whose
  required keys the body carries.
- `@crossengin/operate-server`: typecheck shows no error in this slice's files. The only errors are
  in `design-review-*.test.ts`, `ai-design-budget.test.ts` and `node.ts:4481`, which another
  concurrent slice is editing. `tenant-status-gate.test.ts` checks the returned set (two wrapped,
  exempt absent, empty when every operation is exempt) and checks every 403 and 503 body the gate
  sends against the declaration: reasons equal to those sent, states equal to those refused,
  `active` absent, retry-after equal. `server.test.ts`'s ungated-residency test is narrowed from "no
  response components" to "no residency components", because 401 and 403 are now components on every
  document. The full suite ran 6,579 passed and 43 failed, all 43 in the three design-review files
  (reproduced on rerun).
- **Mutation check.** Removing the audit arm from the 503 composition fails 3 tests: the
  both-direction declaration test, the shape test and the compiled-server test. Restoring it was
  confirmed by grep.
- No live server was booted. The slice needs no Postgres, and the compiled-server test exercises the
  same handler and thunk path that `GET /v1/meta/openapi` uses.

### Adversarial review

The review read every handler arm against `ACTION_HANDLER_REFUSALS` and found four defects, all
fixed:

1. **A declared 503 admitted one producer's body.** On an operation with no `RouteSpec` the tenant
   gate's 503 entry admitted only `TenantStatusUnavailableProblem`, while the shipped compose's
   `POST /v1/ai/design` answers `503 application/json` (`ai_unavailable`) and every gated operation
   can receive the gateway's own `Problem` 503. Fixed by decision 5. Mutation-checked: dropping the
   gateway arm fails 2 `openapi.test.ts` tests, and dropping the route-own arm fails 2.
2. **The server wiring was fenced by nothing.** Every new test drove the emitter or
   `compileOperateServer`; deleting the `tenantStatusDeclaration =` assignment in `server.ts`, which
   is the closure on the shipped compose, left the suite green. `server.test.ts` now builds
   `buildOperateHttpServer` with and without `tenantStatusGate`, fetches `/v1/meta/openapi`, and
   asserts both directions; the same mutation fails it (1 of 42).
3. **The delete 409 test asserted one direction.** It required a 409 where an entity is lifecycle-
   driven or referenced and asserted nothing otherwise, so the "only" in decision 3 was unfenced. It
   now asserts equality over resolved fields, with a non-vacuity floor that some `erp-core` delete
   has no 409.
4. **The 409/422 sentences claimed codes on every entity.** `ACTION_HANDLER_REFUSALS`' doc said the
   listed codes are answered "whatever this server wires", which is false for `unique_violation` (a
   unique field), `reference_not_found` (a reference field) and `conflict` (`expectedUpdatedAt`).
   `CODE_CONDITION` now puts each condition in the sentence.

After the fixes: `@crossengin/operate-runtime` typecheck clean and `openapi.test.ts` 60 of 60;
`@crossengin/operate-server` `server.test.ts`, `openapi-packs.test.ts` and
`tenant-status-gate.test.ts` 101 of 101. `operate-server` typecheck's one remaining error is in
`notification-store.ts`, another slice's file.

## Open questions

1. The tenant gate's problem types are `https://crossengin.dev/problems/...` while the registry uses
   `https://crossengin.io/errors/` (ADR-0457 converged residency onto the registry). The document now
   publishes the gate's URIs as they are sent. Moving them is a client-visible change, which is why
   this ADR leaves them alone.
2. Guard and effect codes are declared as a sentence, not an enum. A per-guard reach declaration
   would make them exact.
3. The entitlement 402 (`withEntitlement`) is still undeclared. The AI design routes' and other
   injected routes' 503 bodies are now *admitted* where a 503 is declared (decision 5), but only as
   the generic `HandlerError`; their codes are not enumerated, and on a deployment with no tenant gate,
   no region gate and no audit their 503 is not declared at all.
5. The gateway pipeline's own 503 (`Problem`) is admitted wherever a 503 is declared, and is not
   declared on its own where nothing else declares one. That is the older, incomplete direction.
6. A create's 409 and 422 lists are shared per action, so `unique_violation` and
   `reference_not_found` appear on entities that declare no unique or reference field, with their
   condition in the sentence rather than per-entity components.
4. `record_referenced` ignores cascade edges and the memory store. An exact per-store declaration
   would need `onDelete` resolution here.

## References

- OpenAPI 3.1 Components Object (`responses`). RFC 9457.
- ADR-0392, ADR-0462 (open questions 1, 2 and 5 closed), ADR-0468 (open question 8 closed),
  ADR-0428, ADR-0334, ADR-0376, ADR-0337, ADR-0331.
