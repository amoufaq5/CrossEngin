import type { JobDeclaration } from "@crossengin/jobs";

export const OVERDUE_INVOICE_REMINDER_JOB: JobDeclaration = {
  id: "erp-core-overdue-invoice-reminder",
  name: "Overdue invoice reminder",
  description:
    "Daily sweep that finds invoices past their due date in 'sent' state and transitions them to 'overdue'. Sends a reminder email to the account's billing contact.",
  trigger: { kind: "scheduled", cron: "0 6 * * *", timezone: "UTC" },
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

export const PAYMENT_RECEIVED_HANDLER_JOB: JobDeclaration = {
  id: "erp-core-payment-received-handler",
  name: "Payment received handler",
  description:
    "Reacts to payment.received events from the payments integration, looks up the invoice, and submits a workflow signal to transition it to paid.",
  trigger: { kind: "event", eventName: "billing.payment_received" },
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
  inputDataClass: "commercial_sensitive",
  outputDataClass: "internal",
};

export const ERP_CORE_JOBS: Readonly<Record<string, JobDeclaration>> = {
  "erp-core-overdue-invoice-reminder": OVERDUE_INVOICE_REMINDER_JOB,
  "erp-core-payment-received-handler": PAYMENT_RECEIVED_HANDLER_JOB,
};
