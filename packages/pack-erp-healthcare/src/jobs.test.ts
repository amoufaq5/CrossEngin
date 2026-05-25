import { JobDeclarationSchema } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";

import {
  ENCOUNTER_REMINDER_JOB,
  ERP_HEALTHCARE_JOBS,
  FHIR_EXPORT_JOB,
  NO_SHOW_SWEEP_JOB,
} from "./jobs.js";

describe("ENCOUNTER_REMINDER_JOB", () => {
  it("parses against JobDeclarationSchema", () => {
    expect(() => JobDeclarationSchema.parse(ENCOUNTER_REMINDER_JOB)).not.toThrow();
  });

  it("runs at 08:00 UTC daily", () => {
    if (ENCOUNTER_REMINDER_JOB.trigger.kind !== "scheduled") {
      throw new Error("not a scheduled trigger");
    }
    expect(ENCOUNTER_REMINDER_JOB.trigger.cron).toBe("0 8 * * *");
    expect(ENCOUNTER_REMINDER_JOB.trigger.timezone).toBe("UTC");
  });

  it("declares phi as both input and output data class", () => {
    expect(ENCOUNTER_REMINDER_JOB.inputDataClass).toBe("phi");
    expect(ENCOUNTER_REMINDER_JOB.outputDataClass).toBe("phi");
  });
});

describe("NO_SHOW_SWEEP_JOB", () => {
  it("parses against JobDeclarationSchema", () => {
    expect(() => JobDeclarationSchema.parse(NO_SHOW_SWEEP_JOB)).not.toThrow();
  });

  it("runs every 15 minutes UTC", () => {
    if (NO_SHOW_SWEEP_JOB.trigger.kind !== "scheduled") {
      throw new Error("not a scheduled trigger");
    }
    expect(NO_SHOW_SWEEP_JOB.trigger.cron).toBe("*/15 * * * *");
  });
});

describe("FHIR_EXPORT_JOB", () => {
  it("parses against JobDeclarationSchema", () => {
    expect(() => JobDeclarationSchema.parse(FHIR_EXPORT_JOB)).not.toThrow();
  });

  it("triggers on healthcare.encounter.completed events", () => {
    if (FHIR_EXPORT_JOB.trigger.kind !== "event") {
      throw new Error("not an event trigger");
    }
    expect(FHIR_EXPORT_JOB.trigger.eventName).toBe("healthcare.encounter.completed");
  });

  it("retries up to 5 times with exponential backoff", () => {
    expect(FHIR_EXPORT_JOB.retry?.maxAttempts).toBe(5);
    expect(FHIR_EXPORT_JOB.retry?.backoff?.kind).toBe("exponential");
  });

  it("uses dead-letter as the failure strategy (consumer downstream)", () => {
    expect(FHIR_EXPORT_JOB.onFailure.strategy).toBe("dead-letter");
  });
});

describe("ERP_HEALTHCARE_JOBS", () => {
  it("registers exactly the three documented job ids", () => {
    expect(Object.keys(ERP_HEALTHCARE_JOBS).sort()).toEqual([
      "erp-healthcare-encounter-reminder",
      "erp-healthcare-fhir-export",
      "erp-healthcare-no-show-sweep",
    ]);
  });
});
