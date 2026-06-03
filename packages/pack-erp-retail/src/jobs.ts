import type { JobDeclaration } from "@crossengin/jobs";

export const LOW_STOCK_REMINDER_JOB: JobDeclaration = {
  id: "erp-retail-low-stock-reminder",
  name: "Low stock reminder",
  description:
    "Hourly sweep that finds active products whose on-hand quantity has dropped below their reorder point and notifies the store manager to reorder.",
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
  onFailure: { strategy: "alert-and-dead-letter", alertChannel: "retail-ops" },
  idempotent: true,
  inputDataClass: "internal",
  outputDataClass: "internal",
};

export const ORDER_PLACED_HANDLER_JOB: JobDeclaration = {
  id: "erp-retail-order-placed-handler",
  name: "Order placed handler",
  description:
    "Reacts to order.placed events, decrements inventory for each order line, and (for online channels) emails the customer an order confirmation.",
  trigger: { kind: "event", eventName: "retail.order_placed" },
  concurrency: { limit: 20, key: "event.data.tenant_id" },
  retry: {
    maxAttempts: 5,
    backoff: {
      kind: "exponential",
      initialDelay: "PT5S",
      maxDelay: "PT5M",
      jitter: true,
    },
  },
  onFailure: { strategy: "dead-letter" },
  idempotent: true,
  inputDataClass: "pii",
  outputDataClass: "internal",
};

export const ERP_RETAIL_JOBS: Readonly<Record<string, JobDeclaration>> = {
  "erp-retail-low-stock-reminder": LOW_STOCK_REMINDER_JOB,
  "erp-retail-order-placed-handler": ORDER_PLACED_HANDLER_JOB,
};
