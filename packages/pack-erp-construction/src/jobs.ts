import type { JobDeclaration } from "@crossengin/jobs";

export const PROJECT_DEADLINE_REMINDER_JOB: JobDeclaration = {
  id: "erp-construction-project-deadline-reminder",
  name: "Project deadline reminder",
  description:
    "Daily sweep that finds active projects approaching or past their target end date and notifies the project manager.",
  trigger: { kind: "scheduled", cron: "0 7 * * *", timezone: "UTC" },
  concurrency: { limit: 5, key: "event.data.tenant_id" },
  retry: {
    maxAttempts: 3,
    backoff: { kind: "exponential", initialDelay: "PT1M", maxDelay: "PT30M", jitter: true },
  },
  onFailure: { strategy: "alert-and-dead-letter", alertChannel: "construction-ops" },
  idempotent: true,
  inputDataClass: "internal",
  outputDataClass: "internal",
};

export const CHANGE_ORDER_APPROVED_HANDLER_JOB: JobDeclaration = {
  id: "erp-construction-change-order-approved-handler",
  name: "Change order approved handler",
  description:
    "Reacts to change_order.approved events and posts the approved amount to the linked core Invoice for billing.",
  trigger: { kind: "event", eventName: "construction.change_order_approved" },
  concurrency: { limit: 20, key: "event.data.tenant_id" },
  retry: {
    maxAttempts: 5,
    backoff: { kind: "exponential", initialDelay: "PT5S", maxDelay: "PT5M", jitter: true },
  },
  onFailure: { strategy: "dead-letter" },
  idempotent: true,
  inputDataClass: "internal",
  outputDataClass: "internal",
};

export const ERP_CONSTRUCTION_JOBS: Readonly<Record<string, JobDeclaration>> = {
  "erp-construction-project-deadline-reminder": PROJECT_DEADLINE_REMINDER_JOB,
  "erp-construction-change-order-approved-handler": CHANGE_ORDER_APPROVED_HANDLER_JOB,
};
