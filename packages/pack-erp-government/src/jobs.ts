import type { JobDeclaration } from "@crossengin/jobs";

export const CASE_SLA_REMINDER_JOB: JobDeclaration = {
  id: "erp-government-case-sla-reminder",
  name: "Case SLA reminder",
  description:
    "Hourly sweep that finds open cases whose SLA due date is approaching or past and notifies the assigned case worker to advance them before the deadline.",
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
  onFailure: { strategy: "alert-and-dead-letter", alertChannel: "gov-ops" },
  idempotent: true,
  inputDataClass: "internal",
  outputDataClass: "internal",
};

export const PERMIT_ISSUED_HANDLER_JOB: JobDeclaration = {
  id: "erp-government-permit-issued-handler",
  name: "Permit issued handler",
  description:
    "Reacts to permit.issued events, records the issuance in the audit trail, and emails the citizen their permit confirmation and expiry reminders.",
  trigger: { kind: "event", eventName: "government.permit_issued" },
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

export const ERP_GOVERNMENT_JOBS: Readonly<Record<string, JobDeclaration>> = {
  "erp-government-case-sla-reminder": CASE_SLA_REMINDER_JOB,
  "erp-government-permit-issued-handler": PERMIT_ISSUED_HANDLER_JOB,
};
