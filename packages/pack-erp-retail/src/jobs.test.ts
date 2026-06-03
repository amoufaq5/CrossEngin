import { JobDeclarationSchema } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";
import {
  ERP_RETAIL_JOBS,
  LOW_STOCK_REMINDER_JOB,
  ORDER_PLACED_HANDLER_JOB,
} from "./jobs.js";

describe("retail jobs", () => {
  it("all parse against the JobDeclarationSchema", () => {
    for (const job of Object.values(ERP_RETAIL_JOBS)) {
      expect(() => JobDeclarationSchema.parse(job)).not.toThrow();
    }
  });

  it("the low-stock reminder is a scheduled cron sweep", () => {
    expect(LOW_STOCK_REMINDER_JOB.trigger).toMatchObject({ kind: "scheduled" });
    expect(LOW_STOCK_REMINDER_JOB.idempotent).toBe(true);
  });

  it("the order-placed handler is event-driven over PII (customer email)", () => {
    expect(ORDER_PLACED_HANDLER_JOB.trigger).toMatchObject({
      kind: "event",
      eventName: "retail.order_placed",
    });
    expect(ORDER_PLACED_HANDLER_JOB.inputDataClass).toBe("pii");
  });

  it("keys each job by its id", () => {
    for (const [key, job] of Object.entries(ERP_RETAIL_JOBS)) {
      expect(job.id).toBe(key);
    }
  });
});
