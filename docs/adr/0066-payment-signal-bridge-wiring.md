# ADR-0066: Payment signal-bridge wiring (Phase 2 M7.8)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0052 (workflow-signal-bridge), ADR-0065 (pack-erp-payments), ADR-0049 (workflow-runtime) |

## Context

M7.5 shipped `pack-erp-payments` with a `payment_lifecycle` workflow and an `erp-payments-provider-webhook` job declaration. M6 shipped `@crossengin/workflow-signal-bridge` — the gateway-registered Handler that verifies webhook signatures, extracts a correlation key, and submits a signal to the workflow runtime. The two haven't been connected: the pack declared *what* the job is; nobody had wired *how* a real Stripe / Adyen / Braintree webhook turns into a `payment.captured` workflow signal.

M7.8 ships that wire. The pack now exports:
1. A canonical signal-name vocabulary (`payment.captured` / `.settled` / `.refunded` / `.failed` / `.cancelled`).
2. A correlation extractor that handles the three common provider payload shapes (Stripe's `data.object.id`, Adyen's `pspReference`, Braintree's `transaction.id`).
3. A factory that wraps M6's `WorkflowSignalBridge` with the right defaults.
4. A multi-event helper that builds one bridge per provider event type.
5. An end-to-end test: real HMAC-signed Stripe-shaped webhook → bridge → recorded `submitSignal` call.

Three constraints shaped the design:

1. **No new transport package.** The pack ships the wiring as TypeScript values — extractor, factory, event map. Operators import them into their existing gateway-runtime setup. No new package for "the Payment HTTP handler" because the gateway-runtime + workflow-signal-bridge already cover transport + verification + signal dispatch.

2. **Provider-agnostic correlation, provider-aware event mapping.** The correlation key (`provider_reference` in the Payment entity) is one value across providers. But the event-type → signal-name mapping is provider-specific — Stripe says `payment_intent.succeeded`, Adyen says `AUTHORISATION`, Braintree says `transaction_settled`. The pack ships the map; operators add new providers by extending the const.

3. **The bridge's existing API must accommodate the dotted-path extractor M7.8 needs.** M6's `FirstFieldExtractor` only handles top-level keys. The pack-level fix is a new `FirstMatchingPathExtractor` class that composes M6's existing `FieldPathExtractor` instances — no kernel-level change needed; the pack carries its own composition helper.

## Decision

One new module in pack-erp-payments — `src/signal-bridge.ts` — with five exports:

### `PAYMENT_SIGNAL_NAMES`

```ts
export const PAYMENT_SIGNAL_NAMES = {
  CAPTURED:  "payment.captured",
  SETTLED:   "payment.settled",
  REFUNDED:  "payment.refunded",
  FAILED:    "payment.failed",
  CANCELLED: "payment.cancelled",
} as const;
```

The 5 lifecycle signals matching the `payment_lifecycle` workflow's 5 transitions from M7.5. Constants ensure no string-typo drift between the workflow definition and the bridge configuration.

### `PROVIDER_EVENT_SIGNAL_MAP`

A const mapping provider-native event-type strings to canonical signal names. Covers Stripe's standard payment events (`payment_intent.succeeded` / `.payment_failed` / `.canceled`, `charge.succeeded` / `.refunded` / `.failed`) and Adyen's notification codes (`AUTHORISATION` / `CAPTURE` / `SETTLEMENT` / `REFUND` / `CANCELLATION`). `resolvePaymentSignalForEvent(eventType)` returns the mapped signal or `null`.

### `FirstMatchingPathExtractor` + `paymentReferenceExtractor()`

`FirstMatchingPathExtractor` composes `FieldPathExtractor` instances and returns the first non-empty match. Reusable beyond payments (any pack with multiple webhook shapes can build one).

`paymentReferenceExtractor()` constructs the payments-specific instance with the five paths covering the common providers:
- `data.object.id` (Stripe payment_intent / charge events)
- `data.object.payment_intent` (Stripe charge events; secondary fallback)
- `pspReference` (Adyen)
- `transaction.id` (Braintree)
- `provider_reference` (generic / operator-defined)

### `buildPaymentSignalBridge(opts)`

Single-signal factory:

```ts
export interface BuildPaymentSignalBridgeOptions
  extends Omit<WorkflowSignalBridgeOptions, "correlationExtractor" | "signalName"> {
  readonly signalName?: PaymentSignalName;
}

export function buildPaymentSignalBridge(opts): WorkflowSignalBridge {
  return new WorkflowSignalBridge({
    engine: opts.engine,
    secretResolver: opts.secretResolver,
    correlationExtractor: paymentReferenceExtractor(),
    signalName: opts.signalName ?? PAYMENT_SIGNAL_NAMES.CAPTURED,
  });
}
```

Operators with a single Stripe webhook endpoint use this directly with `signalName: PAYMENT_SIGNAL_NAMES.CAPTURED`.

### `buildPaymentBridgesByEvent({engine, secretResolver})`

Multi-event factory that returns `Readonly<Record<string, WorkflowSignalBridge>>` keyed by provider event type. Operators with a single webhook endpoint that dispatches based on event type ("if Stripe sends `payment_intent.succeeded`, fire `payment.captured`") use this map.

A higher-level dispatcher reads `event.type` from the parsed body, looks up the bridge in the map, and calls `bridge.handle(...)`. The pack ships the building blocks; the dispatcher lives in the operator's gateway handler.

## Cross-cutting invariants enforced

- **Signal name vocabulary stays consistent.** The workflow definitions use `payment_lifecycle` transitions named `capture` / `settle` / etc. The bridge fires signals named `payment.captured` / `payment.settled` / etc. The workflow's `submitSignal` matcher (M3's signal correlation) ties them. Both sides import `PAYMENT_SIGNAL_NAMES` so no string typo can break the connection.
- **Correlation is bound to `provider_reference`.** Every Payment entity has a `provider_reference` field (M7.5). Every signal carries a `correlationKey` matching that value. The runtime matches signal-to-instance by tenant + correlationKey, so a `pi_3ABC123` webhook routes to exactly the Payment row with `provider_reference = 'pi_3ABC123'`.
- **HMAC verification stays mandatory.** M6's bridge always calls `verifyWebhookDelivery` before dispatching the signal. M7.8 doesn't bypass this; tests prove a wrong-secret payload returns `signature_invalid` and never reaches the engine.
- **No engine bypass on correlation failure.** `correlation_missing` short-circuits before `engine.submitSignal` is called. Tests verify the recording submitter sees zero calls when the body lacks any of the five reference paths.
- **Idempotency key flows through.** Stripe sends `event.id` (e.g., `evt_xxx`); the gateway handler passes it as `idempotencyKey` on the bridge input; the bridge threads it to `submitSignal`; the workflow runtime's `exactly_once_idempotent` dedup uses it. Duplicate webhook deliveries don't double-advance the workflow.
- **Pack-level extractor doesn't need kernel changes.** `FirstMatchingPathExtractor` is built on M6's existing `FieldPathExtractor`. The bridge package keeps its existing simpler API; packs that need richer extraction patterns compose it themselves.

## Alternatives considered

- **Extend `@crossengin/workflow-signal-bridge` with a `FirstMatchingPathExtractor`.**
  - **Pros.** Reusable by other packs.
  - **Cons.** Bridge package would need a workspace-wide version bump and re-test cycle. The composition is small enough to live in the pack.
  - **Decision.** Pack-local for M7.8. When a second pack (e.g., a future `pack-erp-shipping` with multi-carrier webhook payloads) needs the same pattern, move it up. Premature generalization is worse than mild duplication.

- **One bridge per pack, dispatching internally on event type.**
  - **Considered.** A `PaymentBridge` class that holds the event map + a single underlying `WorkflowSignalBridge` and routes internally.
  - **Decision.** The map-of-bridges approach is simpler and reuses M6's bridge API directly. Operators can wire `bridges[eventType].handle(...)` in their gateway dispatcher with one map lookup. Internal dispatch would re-implement what's already there.

- **Ship a default `gateway-handler.ts` that operators register on the gateway runtime.**
  - **Considered.** A `createPaymentWebhookHandler({engine, secretResolver})` returning the gateway-runtime `Handler` type, parsing the event-type from `body.type` and calling the right bridge.
  - **Decision.** Out of scope for M7.8. The dispatcher logic depends on the deployment's choice of gateway (Hono, Express, Edge runtime), header parsing conventions, error-response shape, etc. The pack ships the building blocks; the deployment wires the handler. A future `apps/example-server` could ship a reference implementation.

- **Validate event payloads against a per-provider zod schema before extraction.**
  - **Considered.** Catch malformed Stripe payloads before the bridge tries to extract.
  - **Decision.** Defer. The bridge already returns `correlation_missing` cleanly for unrecognized shapes. Schema validation per provider is a future hardening pass.

- **Make signal-name mapping driven by a zod-defined `compliancePackParameters` field on the manifest.**
  - **Considered.** Operators override the event → signal map without modifying the pack source.
  - **Decision.** Const map for M7.8. Phase 3 marketplace adds per-tenant pack parameter resolution; until then, a 1-line PR to the pack source is fine.

- **Auto-decode and forward the entire webhook body to the workflow as the signal payload.**
  - **Considered.** Pass the parsed JSON body as `submitSignal({..., payload})`.
  - **Decision.** M6's bridge already does this (line 120 of bridge.ts: `payload: parsed`). M7.8 inherits the behavior. Workflows that need the raw event data have it.

## Consequences

- **The pack's webhook story is end-to-end demonstrable.** Test fixture: a Stripe-shaped event body, HMAC-signed with a real secret, fed through `buildPaymentSignalBridge`, produces a `submitSignal` call with the correct signal name + correlation key + tenant + idempotency key. The chain from "external webhook arrives" to "Payment workflow advances" is wired end-to-end with real cryptography.
- **53 packages + 1 app, 119 meta-schema tables, 5,983 tests** (+19 from M7.8; no new packages or META tables).
- **Pattern set for other webhook-driven packs.** A future `pack-erp-shipping` with FedEx + UPS + DHL carrier webhooks follows the same shape: signal-name constants, multi-path correlation extractor, event-type map, factory function, dispatch map. The bridge wiring is one module per pack.
- **The M6 signal bridge has its first realistic operator-facing consumer.** Before M7.8, the bridge package was tested in isolation. M7.8 proves it composes cleanly with a vertical pack and real provider payload shapes.
- **No new META_ tables.** Webhook payloads + signal dispatches are runtime data; persistence already lives in the workflow-runtime-pg event log via the M3 chain.
- **The pack's `erp-payments-provider-webhook` job declaration now has matching code-side wiring.** Job (what runs) + signal-bridge module (how it runs) line up. A deployment combines them with the gateway handler + a secret resolver against `META_WEBHOOK_ENDPOINTS`.

## Open questions

- **Q1:** Should the pack ship a default `SecretResolver` that reads from `META_WEBHOOK_ENDPOINTS`?
  - _Current direction:_ No. `META_WEBHOOK_ENDPOINTS` lives in the sdk package; a `PostgresSecretResolver` is a Phase 3 concern (M6.5 noted it as deferred). For M7.8, operators wire their own resolver — `StaticSecretResolver` for tests, a database-backed one for prod.
- **Q2:** How should the operator's gateway dispatcher know the tenant?
  - _Current direction:_ From the URL path (`/webhooks/:tenantId/payments/stripe`) or a custom header set by an upstream router. The pack doesn't dictate; the M6 bridge takes `tenantId` as an explicit input.
- **Q3:** What about Stripe's `livemode: false` test events that ride the same endpoint?
  - _Current direction:_ The pack doesn't filter — all events go through. Operators add a livemode filter in the gateway handler before dispatching to the bridge if needed.
- **Q4:** Does the pack need a way to dispatch on Adyen's structured `notificationItems[]` array (multiple events per webhook)?
  - _Current direction:_ Not in M7.8. The current model is one event per webhook. Adyen-style batched notifications need an unrolling layer; a future M7.8.1 can add a `dispatchNotificationItems(body, bridges)` helper.
- **Q5:** Should the signal-bridge module expose hooks for tracing/metrics?
  - _Current direction:_ M6's bridge returns a typed `BridgeOutcome` per call. M8 (`@crossengin/observability-runtime`) will wrap that with OTel spans; M7.8 doesn't need observability-specific hooks.
