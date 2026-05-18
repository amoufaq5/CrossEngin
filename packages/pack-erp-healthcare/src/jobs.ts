import type { JobDeclaration } from "@crossengin/jobs";

export const ENCOUNTER_REMINDER_JOB: JobDeclaration = {
  id: "erp-healthcare-encounter-reminder",
  name: "Encounter reminder",
  description:
    "Daily sweep that finds encounters scheduled in the next 24 hours and sends reminder notifications " +
    "to the patient's preferred contact channel. Pairs with @crossengin/notifications once M9 ships.",
  trigger: { kind: "scheduled", cron: "0 8 * * *", timezone: "UTC" },
  concurrency: { limit: 10, key: "event.data.tenant_id" },
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
  outputDataClass: "phi",
};

export const NO_SHOW_SWEEP_JOB: JobDeclaration = {
  id: "erp-healthcare-no-show-sweep",
  name: "No-show sweep",
  description:
    "15-minute sweep that finds scheduled / checked_in encounters whose scheduled_at is more than " +
    "30 minutes in the past and transitions them to 'no_show'. Backstop for missed manual transitions.",
  trigger: { kind: "scheduled", cron: "*/15 * * * *", timezone: "UTC" },
  concurrency: { limit: 5, key: "event.data.tenant_id" },
  retry: {
    maxAttempts: 3,
    backoff: {
      kind: "exponential",
      initialDelay: "PT30S",
      maxDelay: "PT5M",
      jitter: true,
    },
  },
  onFailure: { strategy: "alert-and-dead-letter", alertChannel: "clinic-ops" },
  idempotent: true,
  inputDataClass: "phi",
  outputDataClass: "internal",
};

export const FHIR_EXPORT_JOB: JobDeclaration = {
  id: "erp-healthcare-fhir-export",
  name: "FHIR R4 export",
  description:
    "Event-triggered job that converts an Encounter + its Observations into FHIR R4 Bundle JSON " +
    "and emits it on the 'healthcare.encounter.completed' channel. Consumers include downstream " +
    "EHR integrations and the patient portal data-export pipeline.",
  trigger: { kind: "event", eventName: "healthcare.encounter.completed" },
  concurrency: { limit: 20, key: "event.data.tenant_id" },
  retry: {
    maxAttempts: 5,
    backoff: {
      kind: "exponential",
      initialDelay: "PT5S",
      maxDelay: "PT10M",
      jitter: true,
    },
  },
  onFailure: { strategy: "dead-letter" },
  idempotent: true,
  inputDataClass: "phi",
  outputDataClass: "phi",
};

export const ERP_HEALTHCARE_JOBS: Readonly<Record<string, JobDeclaration>> = {
  "erp-healthcare-encounter-reminder": ENCOUNTER_REMINDER_JOB,
  "erp-healthcare-no-show-sweep": NO_SHOW_SWEEP_JOB,
  "erp-healthcare-fhir-export": FHIR_EXPORT_JOB,
};
