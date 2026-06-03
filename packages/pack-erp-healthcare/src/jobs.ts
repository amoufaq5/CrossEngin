import type { JobDeclaration } from "@crossengin/jobs";

export const APPOINTMENT_REMINDER_JOB: JobDeclaration = {
  id: "erp-healthcare-appointment-reminder",
  name: "Appointment reminder",
  description:
    "Daily sweep that finds encounters scheduled within the next 24 hours and sends a reminder to the patient. Marks long-past scheduled encounters as no_show.",
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
  onFailure: { strategy: "alert-and-dead-letter", alertChannel: "clinic-ops" },
  idempotent: true,
  inputDataClass: "phi",
  outputDataClass: "internal",
};

export const LAB_RESULT_RECEIVED_HANDLER_JOB: JobDeclaration = {
  id: "erp-healthcare-lab-result-received-handler",
  name: "Lab result received handler",
  description:
    "Reacts to lab.result_received events from the lab integration, looks up the encounter, and records a final Observation with the reported value.",
  trigger: { kind: "event", eventName: "healthcare.lab_result_received" },
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
  inputDataClass: "phi",
  outputDataClass: "phi",
};

export const ERP_HEALTHCARE_JOBS: Readonly<Record<string, JobDeclaration>> = {
  "erp-healthcare-appointment-reminder": APPOINTMENT_REMINDER_JOB,
  "erp-healthcare-lab-result-received-handler": LAB_RESULT_RECEIVED_HANDLER_JOB,
};
