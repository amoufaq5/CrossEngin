# ADR-0079: gateway request-body parsing + handler-returned outcome mapping (Phase 3 P1.5)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0078 (operate-runtime serving), ADR-0050 (api-gateway-runtime), ADR-0077 (Phase 3 plan) |

## Context

P1 (ADR-0078) composed a resolved manifest into a live API and, in doing so,
surfaced two honest gaps in `@crossengin/api-gateway-runtime` that blocked the
**write** path from running end-to-end through the real pipeline:

- **Q1 — no request-body parsing.** The `parse_request` stage hashed + sized the
  request body but never populated `ctx.parsedBody`. Handlers received `null`,
  so a `POST`/`PATCH` through the pipeline could not read its payload. The P1
  write path was therefore tested only at the handler level (where `parsedBody`
  is injected directly), while the gateway covered the read path end-to-end.
- **Q2 — handler 4xx/5xx recorded as `pass`.** The `dispatch_handler` stage
  recorded outcome `"pass"` regardless of the handler's status. A domain 4xx
  (RBAC 403, not-found 404, invalid-transition 409) produced a `PipelineExecution`
  with a `pass` final stage and a 4xx `finalResponseStatus`, tripping the
  schema's "pass outcome cannot have 4xx/5xx responseStatus" invariant —
  `handleRequest` threw rather than serving the error.

Both are general gateway correctness issues, not operate-runtime quirks; fixing
them in the runtime unblocks full CRUD + domain errors for any handler.

## Decision

Two scoped changes to `@crossengin/api-gateway-runtime`, behind the existing
interfaces:

- **`adapters.ts` — retain the raw body.** A new `RuntimeIncomingRequest extends
  IncomingRequest` carries `rawBody: Uint8Array | null` (the gateway contract's
  `IncomingRequest` only exposes the body's size + sha256; the raw bytes are a
  runtime-side payload, never persisted in the `PipelineExecution`).
  `buildIncomingRequest` now returns a `RuntimeIncomingRequest`, attaching
  `rawBody` alongside the existing `bodyBytes` (count) + `bodySha256`.
- **`runtime.ts` `stageParseRequest` — decode JSON into `parsedBody`.** When the
  request carries a non-empty body and a `content-type` containing
  `application/json`, the stage JSON-decodes the bytes and, only for a plain
  object (not an array or scalar), sets `ctx.parsedBody`. The stage records a
  precise reason (`body_parsed_json` / `body_unparseable_json` / `body_hashed` /
  `no_body`); a parse failure is non-fatal (the stage still passes — schema
  validation, not parsing, is where a malformed body is rejected).
- **`runtime.ts` `stageDispatchHandler` — map status class to stage outcome.**
  After the handler runs, a status `>= 400` is recorded as `deny` (4xx, tagged
  with a `handler-error` problem-type URI) or `error` (5xx), and the pipeline
  **halts** there — preserving the handler's own response body via the returned
  envelope. A `< 400` status keeps the prior `pass` record. The final stage
  outcome now matches the response status class, so the `PipelineExecution`
  invariant holds for every served request.

## Cross-cutting invariants enforced (by tests)

- **Write path end-to-end.** `operate-runtime`'s `server.test.ts` now `POST`s a
  product with a JSON body through the **real gateway** and reads it back from
  the store — `parsedBody` is populated by `parse_request`, not injected.
- **Domain errors are first-class outcomes.** A cashier `POST /v1/products` is a
  403 whose `dispatch_handler` stage outcome is `deny` and whose
  `finalOutcome` is `deny` — no thrown invariant. An invalid lifecycle re-fire
  (`place` from `placed`) is a 409 `deny`. The serving app's RBAC + lifecycle
  errors now flow through the gateway, not only the handler unit tests.
- **Backward compatible.** With no body or a non-JSON `content-type`,
  `parse_request` behaves exactly as before (`no_body` / `body_hashed`). All 114
  existing `api-gateway-runtime` tests pass unchanged; the 501
  not-implemented-handler and other pre-existing `< 400` handler paths still
  record `pass`.

## Alternatives considered

- **Parse the body inside the dispatcher (not `parse_request`).**
  - **Decision.** No — `parse_request` is the declared stage for exactly this;
    the dispatcher consumes `ctx.parsedBody`, keeping a single source of truth
    and the stage's audit reason honest.
- **Put `rawBody` on the gateway contract `IncomingRequest`.**
  - **Decision.** No — the contract intentionally exposes only the body's size +
    hash (the persisted shape). The raw bytes are a runtime concern; a
    `RuntimeIncomingRequest` subtype keeps the persisted `PipelineExecution`
    free of payload bytes.
- **Translate handler 4xx into RFC-9457 problem details in the dispatcher.**
  - **Decision.** Deferred. The dispatch stage halts with a generic
    `handler-error` problem type and the handler's own JSON body; mapping
    domain errors (403/404/409) to typed problem details is a follow-up
    (`operate-runtime` returns plain domain-error JSON today — ADR-0078's
    handler-error decision).
- **Reject a malformed JSON body at `parse_request`.**
  - **Decision.** No — keep parsing non-fatal and let `validate_schema` own
    rejection, so a handler that doesn't need a body isn't blocked by an
    unparseable one.

## Consequences

- **58 packages + 1 app, 122 meta-schema tables, 6,192 tests** (was 6,189; +3
  operate-runtime write-path server tests, 0 new packages/tables). The P1
  serving keystone now runs the **full** CRUD + lifecycle + RBAC surface through
  the real gateway, not just the read path.
- **ADR-0078 Q1 + Q2 are resolved.** Q3 (Postgres `EntityStore`), Q4
  (`apps/operate-server` binary), and Q5 (list pagination/filtering) remain the
  open P1 follow-ups.
- **Any handler benefits.** Body parsing + outcome mapping are gateway-wide, so
  future handlers (workflow-signal bridge, marketplace install) get readable
  bodies and correctly-classified audit outcomes for free.
