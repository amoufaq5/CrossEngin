import type { JobDeclaration } from "@crossengin/jobs";

export const PAYMENT_PROVIDER_WEBHOOK_HANDLER_JOB: JobDeclaration = {
  id: "erp-payments-provider-webhook",
  name: "Payment provider webhook handler",
  description:
    "Verifies a payment-provider webhook (Stripe/Adyen/Braintree) via @crossengin/sdk webhook signing, " +
    "looks up the Payment by provider + provider_reference, and submits a workflow signal " +
    "(payment_captured / payment_settled / payment_failed) so the payment_lifecycle workflow advances. " +
    "Pairs with the M6 workflow-signal-bridge as the gateway-registered Handler.",
  trigger: { kind: "event", eventName: "billing.payment_received" },
  concurrency: { limit: 50, key: "event.data.tenant_id" },
  retry: {
    maxAttempts: 5,
    backoff: {
      kind: "exponential",
      initialDelay: "PT2S",
      maxDelay: "PT5M",
      jitter: true,
    },
  },
  onFailure: { strategy: "dead-letter" },
  idempotent: true,
  inputDataClass: "commercial_sensitive",
  outputDataClass: "internal",
};

export const PAYMENT_SETTLEMENT_SWEEP_JOB: JobDeclaration = {
  id: "erp-payments-settlement-sweep",
  name: "Payment settlement sweep",
  description:
    "Hourly sweep that finds payments in 'captured' state older than the provider's typical " +
    "settlement window and transitions them to 'settled'. Backstop for missed webhooks.",
  trigger: { kind: "scheduled", cron: "0 * * * *", timezone: "UTC" },
  concurrency: { limit: 5, key: "event.data.tenant_id" },
  retry: {
    maxAttempts: 3,
    backoff: {
      kind: "exponential",
      initialDelay: "PT1M",
      maxDelay: "PT30M",
      jitter: true,
    },
  },
  onFailure: { strategy: "alert-and-dead-letter", alertChannel: "billing-ops" },
  idempotent: true,
  inputDataClass: "internal",
  outputDataClass: "internal",
};

export const ERP_PAYMENTS_JOBS: Readonly<Record<string, JobDeclaration>> = {
  "erp-payments-provider-webhook": PAYMENT_PROVIDER_WEBHOOK_HANDLER_JOB,
  "erp-payments-settlement-sweep": PAYMENT_SETTLEMENT_SWEEP_JOB,
};
