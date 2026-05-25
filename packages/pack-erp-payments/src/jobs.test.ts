import { JobDeclarationSchema } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";

import {
  ERP_PAYMENTS_JOBS,
  PAYMENT_PROVIDER_WEBHOOK_HANDLER_JOB,
  PAYMENT_SETTLEMENT_SWEEP_JOB,
} from "./jobs.js";

describe("PAYMENT_PROVIDER_WEBHOOK_HANDLER_JOB", () => {
  it("parses against JobDeclarationSchema", () => {
    expect(() => JobDeclarationSchema.parse(PAYMENT_PROVIDER_WEBHOOK_HANDLER_JOB)).not.toThrow();
  });

  it("is event-triggered on billing.payment_received", () => {
    expect(PAYMENT_PROVIDER_WEBHOOK_HANDLER_JOB.trigger.kind).toBe("event");
    if (PAYMENT_PROVIDER_WEBHOOK_HANDLER_JOB.trigger.kind !== "event") return;
    expect(PAYMENT_PROVIDER_WEBHOOK_HANDLER_JOB.trigger.eventName).toBe("billing.payment_received");
  });

  it("classifies input as commercial_sensitive (provider payload)", () => {
    expect(PAYMENT_PROVIDER_WEBHOOK_HANDLER_JOB.inputDataClass).toBe("commercial_sensitive");
  });

  it("dead-letters on failure (no auto-alert; manual review)", () => {
    expect(PAYMENT_PROVIDER_WEBHOOK_HANDLER_JOB.onFailure.strategy).toBe("dead-letter");
  });
});

describe("PAYMENT_SETTLEMENT_SWEEP_JOB", () => {
  it("parses against JobDeclarationSchema", () => {
    expect(() => JobDeclarationSchema.parse(PAYMENT_SETTLEMENT_SWEEP_JOB)).not.toThrow();
  });

  it("is a scheduled hourly cron", () => {
    expect(PAYMENT_SETTLEMENT_SWEEP_JOB.trigger.kind).toBe("scheduled");
    if (PAYMENT_SETTLEMENT_SWEEP_JOB.trigger.kind !== "scheduled") return;
    expect(PAYMENT_SETTLEMENT_SWEEP_JOB.trigger.cron).toBe("0 * * * *");
  });

  it("alert-and-dead-letters on failure (operators notified)", () => {
    expect(PAYMENT_SETTLEMENT_SWEEP_JOB.onFailure.strategy).toBe("alert-and-dead-letter");
  });
});

describe("ERP_PAYMENTS_JOBS", () => {
  it("exposes both jobs by their ids", () => {
    expect(Object.keys(ERP_PAYMENTS_JOBS).sort()).toEqual([
      "erp-payments-provider-webhook",
      "erp-payments-settlement-sweep",
    ]);
  });
});
