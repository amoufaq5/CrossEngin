import type { JobDeclaration } from "@crossengin/jobs";

export const ADD_DROP_DEADLINE_REMINDER_JOB: JobDeclaration = {
  id: "erp-education-add-drop-deadline-reminder",
  name: "Add/drop deadline reminder",
  description:
    "Daily sweep that reminds students of upcoming add/drop and withdrawal deadlines for their active enrollments.",
  trigger: { kind: "scheduled", cron: "0 8 * * *", timezone: "UTC" },
  concurrency: { limit: 5, key: "event.data.tenant_id" },
  retry: {
    maxAttempts: 3,
    backoff: { kind: "exponential", initialDelay: "PT1M", maxDelay: "PT30M", jitter: true },
  },
  onFailure: { strategy: "alert-and-dead-letter", alertChannel: "registrar-ops" },
  idempotent: true,
  inputDataClass: "pii",
  outputDataClass: "internal",
};

export const ENROLLMENT_COMPLETED_HANDLER_JOB: JobDeclaration = {
  id: "erp-education-enrollment-completed-handler",
  name: "Enrollment completed handler",
  description:
    "Reacts to enrollment.completed events, posts the final grade to the student's transcript, and updates degree-progress counters.",
  trigger: { kind: "event", eventName: "education.enrollment_completed" },
  concurrency: { limit: 20, key: "event.data.tenant_id" },
  retry: {
    maxAttempts: 5,
    backoff: { kind: "exponential", initialDelay: "PT5S", maxDelay: "PT5M", jitter: true },
  },
  onFailure: { strategy: "dead-letter" },
  idempotent: true,
  inputDataClass: "regulated",
  outputDataClass: "regulated",
};

export const ERP_EDUCATION_JOBS: Readonly<Record<string, JobDeclaration>> = {
  "erp-education-add-drop-deadline-reminder": ADD_DROP_DEADLINE_REMINDER_JOB,
  "erp-education-enrollment-completed-handler": ENROLLMENT_COMPLETED_HANDLER_JOB,
};
