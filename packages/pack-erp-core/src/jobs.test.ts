import { JobDeclarationSchema } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";

import {
  ERP_CORE_JOBS,
  OVERDUE_INVOICE_REMINDER_JOB,
  PAYMENT_RECEIVED_HANDLER_JOB,
} from "./jobs.js";

describe("OVERDUE_INVOICE_REMINDER_JOB", () => {
  it("parses against JobDeclarationSchema", () => {
    expect(() => JobDeclarationSchema.parse(OVERDUE_INVOICE_REMINDER_JOB)).not.toThrow();
  });

  it("is a scheduled daily cron", () => {
    expect(OVERDUE_INVOICE_REMINDER_JOB.trigger.kind).toBe("scheduled");
    if (OVERDUE_INVOICE_REMINDER_JOB.trigger.kind !== "scheduled") return;
    expect(OVERDUE_INVOICE_REMINDER_JOB.trigger.cron).toBe("0 6 * * *");
  });

  it("is idempotent and alert-and-dead-letters on failure", () => {
    expect(OVERDUE_INVOICE_REMINDER_JOB.idempotent).toBe(true);
    expect(OVERDUE_INVOICE_REMINDER_JOB.onFailure.strategy).toBe("alert-and-dead-letter");
  });
});

describe("PAYMENT_RECEIVED_HANDLER_JOB", () => {
  it("parses against JobDeclarationSchema", () => {
    expect(() => JobDeclarationSchema.parse(PAYMENT_RECEIVED_HANDLER_JOB)).not.toThrow();
  });

  it("is event-triggered on billing.payment_received", () => {
    expect(PAYMENT_RECEIVED_HANDLER_JOB.trigger.kind).toBe("event");
    if (PAYMENT_RECEIVED_HANDLER_JOB.trigger.kind !== "event") return;
    expect(PAYMENT_RECEIVED_HANDLER_JOB.trigger.eventName).toBe("billing.payment_received");
  });

  it("is classified as commercial_sensitive (input) → internal (output)", () => {
    expect(PAYMENT_RECEIVED_HANDLER_JOB.inputDataClass).toBe("commercial_sensitive");
    expect(PAYMENT_RECEIVED_HANDLER_JOB.outputDataClass).toBe("internal");
  });
});

describe("ERP_CORE_JOBS", () => {
  it("exposes both jobs by their ids", () => {
    expect(Object.keys(ERP_CORE_JOBS).sort()).toEqual([
      "erp-core-overdue-invoice-reminder",
      "erp-core-payment-received-handler",
    ]);
  });
});
