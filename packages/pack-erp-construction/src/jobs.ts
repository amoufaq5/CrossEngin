import type { JobDeclaration } from "@crossengin/jobs";

export const MILESTONE_REMINDER_JOB: JobDeclaration = {
  id: "erp-construction-milestone-reminder",
  name: "Milestone reminder",
  description:
    "Daily sweep that finds active projects whose target completion date is approaching and notifies the project manager of upcoming milestones and at-risk schedules.",
  trigger: { kind: "scheduled", cron: "0 7 * * *", timezone: "UTC" },
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
  onFailure: { strategy: "alert-and-dead-letter", alertChannel: "construction-ops" },
  idempotent: true,
  inputDataClass: "internal",
  outputDataClass: "internal",
};

export const INSPECTION_COMPLETED_HANDLER_JOB: JobDeclaration = {
  id: "erp-construction-inspection-completed-handler",
  name: "Inspection completed handler",
  description:
    "Reacts to inspection.completed events, advances the related work order, and (on a passed inspection) notifies the assigned subcontractor and project manager.",
  trigger: { kind: "event", eventName: "construction.inspection_completed" },
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
  inputDataClass: "internal",
  outputDataClass: "internal",
};

export const ERP_CONSTRUCTION_JOBS: Readonly<Record<string, JobDeclaration>> = {
  "erp-construction-milestone-reminder": MILESTONE_REMINDER_JOB,
  "erp-construction-inspection-completed-handler": INSPECTION_COMPLETED_HANDLER_JOB,
};
