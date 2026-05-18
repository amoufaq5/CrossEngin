# ADR-0065: Second vertical pack — ERP Payments (Phase 2 M7.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0058 (pack-erp-core), ADR-0063 (CLI --pack apply), ADR-0064 (pack tenant scoping), ADR-0052 (workflow-signal-bridge) |

## Context

M7 shipped `pack-erp-core` as the first vertical pack. M7-wire connected it to the CLI. M7.7 made it production-grade with per-tenant isolation. What we hadn't yet proved was the cross-pack composition story: can a second pack extend a first, share entity references, and apply atomically as a unified manifest?

M7.5 ships `pack-erp-payments` to answer that. The pack:

1. **Adds a Payment entity** with a `reference` field to `Invoice` (defined in pack-erp-core). The cross-pack FK has to validate, emit, and apply correctly.
2. **Declares a payment lifecycle workflow** that integrates with M6's `@crossengin/workflow-signal-bridge`. A payment-provider webhook (Stripe / Adyen / Braintree) arrives at the gateway, the bridge verifies + correlates by `provider_reference`, submits a signal, the workflow transitions captured → settled → refunded.
3. **Composes cleanly with core** — operators run `crossengin apply --pack=operate-erp/payments` and get both core (Account / Contact / Invoice / InvoiceLine) and payment tables in one atomic apply.

Three constraints shaped the design:

1. **Cross-pack references must work without kernel changes.** The kernel's `tryValidateManifest` requires every `reference.target` to point to an entity in the same manifest. M7.5 satisfies this by merging the manifests — `buildErpPaymentsPack()` calls `buildErpCorePack()` and adds its own entities/relations/etc. The validator sees one combined manifest with both `Invoice` and `Payment`; cross-references resolve internally.

2. **The pack must declare `extends`.** Even though the merge happens at build time, `meta.extends: ["operate-erp/core"]` documents the dependency. Future marketplace tooling (Phase 3) reads this to drive UI lineage, migration ordering, and conflict detection.

3. **No new roles.** Pack-erp-core already defines `erp_admin / erp_accountant / erp_viewer`. M7.5 grants Payment permissions to those existing roles instead of introducing a parallel `erp_payments_*` hierarchy. Operators administering an ERP install learn one role set, not two.

## Decision

`@crossengin/pack-erp-payments` exports **6 modules** plus an index, all small:

### `entities.ts` — Payment

One entity, both `auditable` + `tenant_owned` traits, 13 user-fields:

- `invoice_id` — reference to `Invoice` (cross-pack FK; required + indexed)
- `state` — enum (pending / captured / settled / refunded / failed / cancelled) matching the workflow
- `amount` + `refund_amount` — decimal(14,2) min:0
- `currency` — text(3)
- `provider` — enum of `PAYMENT_PROVIDERS` (stripe / adyen / braintree / manual / bank_transfer)
- `provider_reference` — unique-within-provider scope (so a `pi_xxx` from Stripe doesn't collide with a `pid_xxx` from Adyen)
- `captured_at` / `settled_at` / `refunded_at` — datetime
- `failure_code` / `failure_message` — text + long_text
- `metadata` — JSONB (operator-defined per-provider extras)

Composite index on `(invoice_id, state)` for the "all captured payments for invoice X" query.

### `relations.ts` — Invoice → Payments

One relation: `Invoice → Payment` (one-to-many, ON DELETE RESTRICT — you can't delete an invoice with payments against it).

### `permissions.ts` — Payment grants

Per-entity matrix for `Payment`. Refund + delete are admin-only (privileged operations). Capture / settle / fail / cancel are accountant-level. Viewers can list + read.

### `workflows.ts` — payment_lifecycle

`entityLifecycle` on `Payment.state`:

- **6 states**: `pending` (initial) → `captured` → `settled` (all active) → `refunded` (terminal). Plus `failed` (terminal) and `cancelled` (terminal). `settled` stays active because a refund must remain possible — refunds can transition from either `captured` or `settled`.
- **5 transitions**: `capture` (automatic, on provider confirmation), `settle` (automatic, on bank settlement), `refund` (userAction, [captured, settled] → refunded), `fail` (automatic, on provider error), `cancel` (userAction, only from pending).
- **2 SLAs**: `pending → captured` within `P1D`, `captured → settled` within `P5D`. Both escalate to `notify_billing_ops`.

### `jobs.ts` — Webhook handler + settlement sweep

- `erp-payments-provider-webhook` — event-triggered on `billing.payment_received`. Per-tenant concurrency 50; 5-attempt exponential retry; dead-letter on failure. Input class `commercial_sensitive` (provider payload contains card-network data).
- `erp-payments-settlement-sweep` — hourly cron. Finds captured-state payments past the provider's typical settlement window (default 3-5 business days) and transitions them to settled. Backstop for missed webhooks.

### `views.ts` — payment.list

One list view with columns covering the operationally important fields (invoice, state, amount, currency, provider, provider_reference, captured/settled timestamps).

### `pack.ts` — `buildErpPaymentsPack()`

The composition function:

```ts
export function buildErpPaymentsPack(opts = {}): Manifest {
  const core = buildErpCorePack();
  return {
    manifestVersion: "1.0",
    meta: {
      name: "CrossEngin Operate — ERP Payments",
      slug: "operate-erp/payments",
      version: "0.1.0",
      description: opts.description ?? "...",
      extends: ["operate-erp/core"],
      ...
    },
    entities:    [...(core.entities ?? []),    ...ERP_PAYMENTS_ENTITIES],
    relations:   [...(core.relations ?? []),   ...ERP_PAYMENTS_RELATIONS],
    roles:       { ...(core.roles ?? {}) },
    permissions: { ...(core.permissions ?? {}), ...ERP_PAYMENTS_PERMISSIONS },
    workflows:   { ...(core.workflows ?? {}),   ...ERP_PAYMENTS_WORKFLOWS },
    jobs:        { ...(core.jobs ?? {}),        ...ERP_PAYMENTS_JOBS },
    views:       { ...(core.views ?? {}),       ...ERP_PAYMENTS_VIEWS },
  };
}
```

`tryValidateManifest` runs against the merged manifest. Every reference (Payment.invoice_id → Invoice, all the core entity refs, etc.) resolves. The cross-pack story is one merge function.

### Registry wiring

`apps/architect-cli/src/pack-registry.ts` gains a second entry:

```ts
[ERP_PAYMENTS_PACK_SLUG]: {
  slug: ERP_PAYMENTS_PACK_SLUG,
  description: "Payment entity + lifecycle workflow on top of operate-erp/core...",
  build: () => buildErpPaymentsPack(),
},
```

`crossengin apply --pack=operate-erp/payments --dry-run` now produces 4 core entity tables + 1 Payment table, all with `tenant_id` + FK + RLS from M7.7.

## Cross-cutting invariants enforced

- **`extends` is informational, not behavioral.** The CLI's `apply` reads the merged manifest directly; `meta.extends` doesn't trigger any auto-load. Phase 3 marketplace tooling consumes the field for UI lineage + migration ordering.
- **Roles are shared, not parallel.** Pack-erp-payments uses `erp_admin / erp_accountant / erp_viewer` from core. New roles would require operators to re-grant principals; sharing roles means upgrading a tenant from core to payments is just `apply --pack=operate-erp/payments`.
- **Settled is active, not terminal.** Refund must remain possible from settled. The kernel's workflow validator forbids transitions from terminal states; M7.5 honors that by keeping settled active. Only `refunded`, `failed`, and `cancelled` are terminal.
- **Provider_reference uniqueness is scoped.** `unique: { scope: ["provider"] }` makes a Stripe `pi_abc` and an Adyen `pi_abc` non-colliding. Cross-provider reconciliation lives in higher-level ops.
- **Webhook integration uses M6's bridge.** The `erp-payments-provider-webhook` job pairs with `@crossengin/workflow-signal-bridge`: gateway receives a webhook → bridge verifies HMAC + correlates by `provider_reference` → submits `payment.captured` or `payment.settled` signal → workflow advances. The pack ships the declarative shape; the deployment wires the bridge handler (operator concern, not pack concern).
- **`tenant_owned` carries through.** Payment uses the trait, so M7.7's auto-injection emits `tenant_id` + FK + RLS for the table. Cross-pack composition doesn't lose tenant isolation.

## Alternatives considered

- **Make pack-erp-payments standalone (no merge).**
  - **Pros.** Smaller manifest. `apply --pack=operate-erp/payments` only emits Payment DDL.
  - **Cons.** Validation fails — Payment.invoice_id references Invoice, which isn't in the standalone manifest. Operators would have to apply core first then payments separately; the kernel doesn't currently support that ordering with cross-pack FK resolution.
  - **Decision.** Merge in `buildErpPaymentsPack`. Phase 3 ships a real `extends` resolver in the CLI that loads parent manifests by slug; M7.5's approach is the same outcome via a simpler implementation.

- **Use a new `erp_payments_*` role hierarchy.**
  - **Considered.** Cleaner separation; payments admins ≠ core admins.
  - **Decision.** Reuse existing roles. ERP environments tend to have one operations team; splitting roles makes principal management harder, not easier.

- **Skip the settlement sweep job and rely solely on webhooks.**
  - **Considered.** Simpler jobs surface.
  - **Decision.** Webhooks fail. Stripe's docs explicitly recommend a reconciliation sweep. The sweep is the backstop that keeps `captured → settled` from getting stuck if a webhook delivery is missed.

- **Add a refund window — refunds only allowed within N days of settlement.**
  - **Considered.** A `refund_deadline_at` field + a guard on the refund transition.
  - **Decision.** Out of scope for M7.5. Refund policy is provider-specific and merchant-specific. The pack ships the workflow; the deployment enforces refund-window policy via guards or an ABAC predicate.

- **Make `provider` extensible per deployment (a free-form text field instead of an enum).**
  - **Considered.** Operators using unlisted providers (Square, Razorpay) shouldn't have to fork the pack.
  - **Decision.** Enum for now. Adding providers is a 1-line PR to pack-erp-payments. Free-form text loses type safety in downstream code (workflow guards, role checks).

- **Ship payment-method-specific fields (card_last_four, bank_routing, etc.).**
  - **Considered.** Richer entity shape.
  - **Decision.** Out of scope. PCI-scoped data belongs in tokenization layers, not the manifest. The `metadata` JSONB field handles operator-specific extras when needed.

- **Auto-link Payment.invoice_id ON DELETE CASCADE so deleting an invoice deletes its payments.**
  - **Considered.** Symmetric with Invoice → InvoiceLine in core.
  - **Decision.** `ON DELETE RESTRICT`. Deleting an invoice with payments against it is operationally dangerous — payments are financial records. Force the operator to handle payment cleanup explicitly before invoice deletion.

## Consequences

- **53 packages + 1 app, 119 meta-schema tables, 5,964 tests** (was 52 / 119 / 5,914; +1 package, +50 tests, 0 new META_ tables).
- **The cross-pack composition story is proven.** Pack B extends Pack A by calling A's builder and merging. Validation passes; DDL emits; tenant scoping inherits via M7.7. Pattern set for `pack-erp-healthcare`, `pack-erp-retail`, etc.
- **`crossengin apply --pack=operate-erp/payments` produces a deployable Postgres schema** covering Account / Contact / Invoice / InvoiceLine + Payment, all with `tenant_id` + FK + RLS, with Payment FK'd to Invoice via standard same-schema FK.
- **The M6 signal bridge has its first realistic consumer.** A future deployment task wires the `erp-payments-provider-webhook` job to a gateway route that invokes the bridge, completing the webhook → workflow → entity-state chain end-to-end with one of the most common real-world integration patterns (payment processor webhooks).
- **Pattern set for `meta.extends` resolution.** Today the CLI hard-codes pack resolution via the registry; Phase 3 marketplace will accept `crossengin apply --pack=operate-erp/payments` and the CLI walks `extends` to load the chain. The on-disk shape (a function calling a parent function) is the same as the future serialized shape (JSON manifest with extends), so the migration is mechanical.

## Open questions

- **Q1:** Should pack-erp-payments include a Refund entity separate from Payment?
  - _Current direction:_ Not in M7.5. Refunds are state transitions on Payment, with `refund_amount` + `refunded_at` capturing the relevant data. A separate Refund entity becomes useful when you need partial refunds against a single payment; defer to M7.5.5 if patterns emerge.
- **Q2:** How does this interact with the `billing` package (which defines its own Invoice + Payment record types)?
  - _Current direction:_ `billing` is platform-level (subscriptions, metered usage, dunning). `pack-erp-payments` is tenant-level (per-tenant accounts-receivable). The two coexist — `billing` charges tenants for using the platform; `pack-erp-payments` lets a tenant track payments their own customers make.
- **Q3:** Does the settlement sweep job need to know each provider's settlement window?
  - _Current direction:_ The pack ships a generic hourly sweep; the actual sweep logic (deployment-time) reads per-provider config from a settings table. The pack's job declaration just runs the sweep; the implementation is operator code.
- **Q4:** What about partial captures + multi-currency settlement?
  - _Current direction:_ The 13 user-fields cover the basics. Partial captures are a Phase 3 concern (split-payment state machine); multi-currency reconciliation needs FX rate tracking, also Phase 3.
- **Q5:** Should the pack ship a default webhook signing secret rotation policy?
  - _Current direction:_ Out of scope for M7.5. `@crossengin/sdk` has webhook signing primitives (HMAC-SHA256 with replay window); the pack just declares the consuming job. Secret rotation is per-tenant deployment config.
