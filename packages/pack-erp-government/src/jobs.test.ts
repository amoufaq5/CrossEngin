import { JobDeclarationSchema } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";
import {
  CASE_SLA_REMINDER_JOB,
  ERP_GOVERNMENT_JOBS,
  PERMIT_ISSUED_HANDLER_JOB,
} from "./jobs.js";

describe("government jobs", () => {
  it("all parse against the JobDeclarationSchema", () => {
    for (const job of Object.values(ERP_GOVERNMENT_JOBS)) {
      expect(() => JobDeclarationSchema.parse(job)).not.toThrow();
    }
  });

  it("the case SLA reminder is a scheduled cron sweep", () => {
    expect(CASE_SLA_REMINDER_JOB.trigger).toMatchObject({ kind: "scheduled" });
    expect(CASE_SLA_REMINDER_JOB.idempotent).toBe(true);
  });

  it("the permit-issued handler is event-driven over PII (citizen contact)", () => {
    expect(PERMIT_ISSUED_HANDLER_JOB.trigger).toMatchObject({
      kind: "event",
      eventName: "government.permit_issued",
    });
    expect(PERMIT_ISSUED_HANDLER_JOB.inputDataClass).toBe("pii");
  });

  it("keys each job by its id", () => {
    for (const [key, job] of Object.entries(ERP_GOVERNMENT_JOBS)) {
      expect(job.id).toBe(key);
    }
  });
});
