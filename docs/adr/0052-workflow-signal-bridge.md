# ADR-0052: Workflow signal bridge (Phase 2 M6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0046 (Phase 2 plan), ADR-0048 (crypto), ADR-0049 (workflow runtime), ADR-0050 (gateway runtime) |

## Context

After M4 (gateway runtime) + M3 (workflow runtime), the two pieces sit beside each other but don't talk. A POST request lands at the gateway and produces a `PipelineExecution`; a workflow instance running in the runtime advances on `submitSignal()` calls. The chain in between — verify the webhook signature, find the correlation key, route the signal to the right instance — is the job of every consumer that wants webhook → workflow.

Three reasons that piece needs to be a shared package, not consumer code:

1. **The signature scheme is shared.** Webhook senders use `sdk/webhook-signing`'s `t=<unix>,v1=<hex>` format. Every consumer would re-implement the same Bearer-like verification.
2. **The correlation logic is shared.** Every webhook handler needs the same chain: parse JSON body → pull a field → submit signal. Repeating it per consumer multiplies bugs.
3. **The outcome surface is shared.** `signature_invalid` → 401. `correlation_missing` → 400. `no_matching_instance` → 202 (not failure; signal accepted even if no instance correlates). `engine_error` → 503. Every consumer needs the same mapping.

M6 ships that piece.

## Decision

`@crossengin/workflow-signal-bridge` exports **five modules** plus an index:

1. **`outcomes.ts`.** `BridgeOutcome` discriminated union with 10 kinds: `advanced` / `deduplicated` / `no_matching_instance` (the three success cases), `secret_not_found` / `signature_invalid` / `timestamp_outside_tolerance` / `signature_malformed` (auth failures), `body_not_json` / `correlation_missing` (client errors), `engine_error`. `bridgeStatusFor(kind)` maps each to an HTTP status (202 for success, 401 for auth, 400 for client, 503 for engine). `BRIDGE_SUCCESS_KINDS` set lets consumers distinguish success from failure without enumerating.

2. **`correlation.ts`.** `CorrelationExtractor` interface with three built-ins:
   - `FieldPathExtractor("order.id")` — walks a dotted path.
   - `FixedExtractor("fixed-key")` — for testing.
   - `FirstFieldExtractor(["primary", "fallback"])` — first non-empty wins.
   Returns `string | null`. Coerces numbers to strings. Empty strings count as missing so consumers can't accidentally correlate everything to `""`.

3. **`secret-resolver.ts`.** `SecretResolver` interface with `resolve({tenantId, sourceSystem, hint})` → `{secretBytes, toleranceSeconds} | null`. The hint is for consumer-specific routing (e.g., a Stripe-Signature `whsec_...` prefix). `StaticSecretResolver` for tests + local dev. Production wires in a real backend (e.g., a Postgres-backed `webhook_endpoints` table from sdk/webhooks).

4. **`bridge.ts`.** `WorkflowSignalBridge.handle({bodyBytes, signatureHeader, nowSeconds, tenantId, sourceSystem?, idempotencyKey?, hint?})` is the main orchestrator:
   1. Resolve the secret via `SecretResolver`. Bail with `secret_not_found` if no match.
   2. Verify the signature via `@crossengin/sdk.verifyWebhookDelivery` (which uses crypto's constant-time HMAC compare). Bail with `signature_malformed` / `timestamp_outside_tolerance` / `signature_invalid`.
   3. Parse the body as JSON. Bail with `body_not_json` for non-object payloads.
   4. Extract the correlation key. Bail with `correlation_missing` if null/empty.
   5. Call `engine.submitSignal(...)`. On throw: `engine_error`. On success: `advanced` / `deduplicated` / `no_matching_instance` based on the result.

   Takes a `SignalSubmitter` interface (structurally compatible with `WorkflowEngine`), so the bridge doesn't import the full engine class — anything with `submitSignal()` works (including a mock for tests, or a remote proxy for cross-process deployments).

5. **`gateway-handler.ts`.** `createSignalBridgeHandler({bridge, signatureHeaderName?, idempotencyHeaderName?, sourceSystem?, nowSeconds?})` returns a `Handler` for `@crossengin/api-gateway-runtime`'s `HandlerRegistry`. Pulls headers from the gateway's `IncomingRequest`, resolves tenant from `principal.tenantId` or falls back to `request.tenantHint`, calls `bridge.handle()`, converts `BridgeOutcome` to `HandlerOutput` with the right status + JSON body.

## Cross-cutting invariants enforced

- **No-instance is not an error.** When `engine.submitSignal()` returns zero matched instances, the bridge returns `no_matching_instance` with status 202. A webhook for an event nobody's waiting on is a normal occurrence — the gateway shouldn't 5xx the sender + cause retries.
- **Constant-time signature verification.** Bridge always uses `@crossengin/sdk.verifyWebhookDelivery` (which uses crypto's `timingSafeEqual` under the hood). Bridge never compares signatures with `===`.
- **Tenant boundary at the bridge.** The tenant is required input. The bridge passes it to `engine.submitSignal({tenantId})`, which the engine uses for cross-tenant isolation. The bridge doesn't extract tenant from the body (untrusted) — only from the principal or `X-Tenant-Id` header (both trusted).
- **Body must be a JSON object.** Arrays / scalars / null are rejected with `body_not_json`. The correlation extractors work on `Record<string, unknown>` only.
- **Idempotency-Key threads through.** When the client supplies an `Idempotency-Key` header, the bridge forwards it to `submitSignal` for `exactly_once_idempotent` dedup. Duplicate submissions return `deduplicated` (202, not 4xx) so the sender doesn't retry.

## Alternatives considered

- **Inline the bridge into `@crossengin/api-gateway-runtime`.**
  - **Pros.** One less package.
  - **Cons.** The gateway runtime would gain a dep on workflow-runtime, blowing up its surface. Consumers who want gateway-only or workflow-only would pull in both.
  - **Why not.** A separate package keeps each runtime focused on its own contract.

- **Make the bridge a function, not a class.**
  - **Considered.** `bridgeSignal({engine, secretResolver, ...})` taking everything per-call.
  - **Decision.** Class instance with constructor-pinned `signalName` + `correlationExtractor` matches the common case (one bridge per signal kind) and keeps per-request invocation lean (just `bridge.handle(input)`).

- **Bake in a built-in correlation extractor for nested arrays (e.g. `events[0].order.id`).**
  - **Considered.** A small JMESPath / JSONPath subset.
  - **Decision.** Out of scope for M6. Three extractors cover the common cases. Consumers who need array indexing or filters write their own `CorrelationExtractor` — the interface is one method.

- **Auto-detect tenant from the body.**
  - **Considered.** `body.tenant_id` as a fallback.
  - **Decision.** No. The tenant is a security boundary — pulling it from an attacker-controlled body would let any signature-verified sender claim any tenant. Tenant always comes from the principal or a server-controlled header.

- **Build the gateway handler as a generic webhook handler that consumers customize.**
  - **Considered.** A `createWebhookHandler({verify, parse, handle})` higher-order that doesn't know about workflows.
  - **Decision.** The bridge is the value-add. Without it, every consumer reimplements the verify → parse → correlate → submit chain. Generic handlers are a separate concern.

- **Persist incoming signals to META_WORKFLOW_SIGNALS via the bridge.**
  - **Considered.** Have the bridge directly upsert signal rows.
  - **Decision.** No — the bridge calls `engine.submitSignal()` and the engine (wrapped in `ProjectingEventLog` from M3.6) handles persistence. Bypassing the engine would let signals into the database without going through the event-sourced state machine.

## Consequences

- **Fifth runtime package, but a small one.** Bridge depends on `@crossengin/sdk` (webhook signing), `@crossengin/workflow-runtime` (the `SignalSubmitter` interface), and `@crossengin/api-gateway-runtime` (the `Handler` interface). No new META_ tables.
- **End-to-end chain works.** `HTTP webhook → gateway pipeline → bridge handler → workflow signal → instance advances → projection upserts`. Every loop in the substrate is now closed; M7 (first vertical pack) can exercise the full path.
- **One signal per bridge instance.** Multi-signal endpoints register multiple handlers in the gateway's `HandlerRegistry`, each backed by its own bridge. Simpler than dispatching from one handler.
- **No-instance is a normal outcome.** Operators see `no_matching_instance` outcomes in `META_GATEWAY_PIPELINE_EXECUTIONS` with status 202; the gateway replayer can summarize the ratio for capacity planning.

## Open questions

- **Q1:** How should the bridge surface partial failures (signal accepted by 3 of 5 matching instances)?
  - _Current direction:_ `submitSignal()` already returns the list of matched instances + dedup flag. The bridge reports `advanced` whenever ≥1 matched. Per-instance failures inside `submitSignal()` are the engine's concern.
- **Q2:** Should the bridge support GraphQL / non-JSON bodies?
  - _Current direction:_ Out of scope. M6 is JSON-only. A `BinaryBridge` for protobuf / msgpack is a Phase 3 concern.
- **Q3:** Where do production webhook secrets live?
  - _Current direction:_ The `SecretResolver` interface is the boundary. M6.5 (Phase 3) adds a `PostgresSecretResolver` backed by `META_WEBHOOK_ENDPOINTS` from sdk.
- **Q4:** Should the bridge auto-decrypt body fields (e.g., when a sender encrypts PII before sending)?
  - _Current direction:_ No. Decryption is the consumer's job. Bridge sees raw bytes + parses JSON.

## References

- **RFC 8725** — JWT BCP, applied by analogy to webhook signing
- **ADR-0046** — Phase 2 plan
- **ADR-0048** — Real cryptography (the verifyWebhookDelivery primitive)
- **ADR-0049** — Workflow runtime (the submitSignal contract)
- **ADR-0050** — Gateway runtime (the Handler interface)
