import { JobDeclarationSchema } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";
import {
  ERP_CONSTRUCTION_JOBS,
  INSPECTION_COMPLETED_HANDLER_JOB,
  MILESTONE_REMINDER_JOB,
} from "./jobs.js";

describe("construction jobs", () => {
  it("all parse against the JobDeclarationSchema", () => {
    for (const job of Object.values(ERP_CONSTRUCTION_JOBS)) {
      expect(() => JobDeclarationSchema.parse(job)).not.toThrow();
    }
  });

  it("the milestone reminder is a scheduled cron sweep", () => {
    expect(MILESTONE_REMINDER_JOB.trigger).toMatchObject({ kind: "scheduled" });
    expect(MILESTONE_REMINDER_JOB.idempotent).toBe(true);
  });

  it("the inspection-completed handler is event-driven", () => {
    expect(INSPECTION_COMPLETED_HANDLER_JOB.trigger).toMatchObject({
      kind: "event",
      eventName: "construction.inspection_completed",
    });
  });

  it("keys each job by its id", () => {
    for (const [key, job] of Object.entries(ERP_CONSTRUCTION_JOBS)) {
      expect(job.id).toBe(key);
    }
  });
});
