import { JobDeclarationSchema } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";
import {
  ENROLLMENT_REMINDER_JOB,
  ERP_EDUCATION_JOBS,
  GRADE_POSTED_HANDLER_JOB,
} from "./jobs.js";

describe("education jobs", () => {
  it("all parse against the JobDeclarationSchema", () => {
    for (const job of Object.values(ERP_EDUCATION_JOBS)) {
      expect(() => JobDeclarationSchema.parse(job)).not.toThrow();
    }
  });

  it("the enrollment reminder is a scheduled cron sweep", () => {
    expect(ENROLLMENT_REMINDER_JOB.trigger).toMatchObject({ kind: "scheduled" });
    expect(ENROLLMENT_REMINDER_JOB.idempotent).toBe(true);
  });

  it("the grade-posted handler is event-driven over PII (grades)", () => {
    expect(GRADE_POSTED_HANDLER_JOB.trigger).toMatchObject({
      kind: "event",
      eventName: "education.grade_posted",
    });
    expect(GRADE_POSTED_HANDLER_JOB.inputDataClass).toBe("pii");
  });

  it("keys each job by its id", () => {
    for (const [key, job] of Object.entries(ERP_EDUCATION_JOBS)) {
      expect(job.id).toBe(key);
    }
  });
});
