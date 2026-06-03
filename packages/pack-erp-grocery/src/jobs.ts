import type { JobDeclaration } from "@crossengin/jobs";

export const EXPIRING_LOTS_REMINDER_JOB: JobDeclaration = {
  id: "erp-grocery-expiring-lots-reminder",
  name: "Expiring lots reminder",
  description:
    "Daily sweep that finds on-shelf perishable lots within three days of their expiration date and notifies the grocery admin to mark them down or pull them.",
  trigger: { kind: "scheduled", cron: "0 5 * * *", timezone: "UTC" },
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
  onFailure: { strategy: "alert-and-dead-letter", alertChannel: "grocery-ops" },
  idempotent: true,
  inputDataClass: "internal",
  outputDataClass: "internal",
};

export const ERP_GROCERY_JOBS: Readonly<Record<string, JobDeclaration>> = {
  "erp-grocery-expiring-lots-reminder": EXPIRING_LOTS_REMINDER_JOB,
};
