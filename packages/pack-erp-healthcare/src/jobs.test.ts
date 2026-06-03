import { JobDeclarationSchema } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_REMINDER_JOB,
  ERP_HEALTHCARE_JOBS,
  LAB_RESULT_RECEIVED_HANDLER_JOB,
} from "./jobs.js";

describe("healthcare jobs", () => {
  it("all parse against the JobDeclarationSchema", () => {
    for (const job of Object.values(ERP_HEALTHCARE_JOBS)) {
      expect(() => JobDeclarationSchema.parse(job)).not.toThrow();
    }
  });

  it("the appointment reminder is a scheduled cron sweep over PHI", () => {
    expect(APPOINTMENT_REMINDER_JOB.trigger).toMatchObject({ kind: "scheduled" });
    expect(APPOINTMENT_REMINDER_JOB.inputDataClass).toBe("phi");
    expect(APPOINTMENT_REMINDER_JOB.idempotent).toBe(true);
  });

  it("the lab handler is event-driven and PHI in + PHI out", () => {
    expect(LAB_RESULT_RECEIVED_HANDLER_JOB.trigger).toMatchObject({
      kind: "event",
      eventName: "healthcare.lab_result_received",
    });
    expect(LAB_RESULT_RECEIVED_HANDLER_JOB.inputDataClass).toBe("phi");
    expect(LAB_RESULT_RECEIVED_HANDLER_JOB.outputDataClass).toBe("phi");
  });

  it("keys each job by its id", () => {
    for (const [key, job] of Object.entries(ERP_HEALTHCARE_JOBS)) {
      expect(job.id).toBe(key);
    }
  });
});
