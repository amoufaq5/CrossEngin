import type { JobDeclaration } from "@crossengin/jobs";

export const ENROLLMENT_REMINDER_JOB: JobDeclaration = {
  id: "erp-education-enrollment-reminder",
  name: "Enrollment reminder",
  description:
    "Daily sweep that finds students with open enrollment holds or upcoming registration deadlines and emails them a reminder to complete enrollment.",
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
  onFailure: { strategy: "alert-and-dead-letter", alertChannel: "registrar-ops" },
  idempotent: true,
  inputDataClass: "internal",
  outputDataClass: "pii",
};

export const GRADE_POSTED_HANDLER_JOB: JobDeclaration = {
  id: "erp-education-grade-posted-handler",
  name: "Grade posted handler",
  description:
    "Reacts to grade.posted events, updates the student's transcript, and (when the term closes) notifies the student that a grade is available.",
  trigger: { kind: "event", eventName: "education.grade_posted" },
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
  outputDataClass: "pii",
};

export const ERP_EDUCATION_JOBS: Readonly<Record<string, JobDeclaration>> = {
  "erp-education-enrollment-reminder": ENROLLMENT_REMINDER_JOB,
  "erp-education-grade-posted-handler": GRADE_POSTED_HANDLER_JOB,
};
