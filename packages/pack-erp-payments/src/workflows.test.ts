import { WorkflowSchema } from "@crossengin/kernel/workflow";
import { describe, expect, it } from "vitest";

import {
  ERP_PAYMENTS_WORKFLOWS,
  PAYMENT_LIFECYCLE_WORKFLOW,
} from "./workflows.js";

describe("PAYMENT_LIFECYCLE_WORKFLOW", () => {
  it("parses against WorkflowSchema", () => {
    expect(() => WorkflowSchema.parse(PAYMENT_LIFECYCLE_WORKFLOW)).not.toThrow();
  });

  it("targets Payment.state and starts at pending", () => {
    if (PAYMENT_LIFECYCLE_WORKFLOW.kind !== "entityLifecycle") return;
    expect(PAYMENT_LIFECYCLE_WORKFLOW.entity).toBe("Payment");
    expect(PAYMENT_LIFECYCLE_WORKFLOW.stateField).toBe("state");
    expect(PAYMENT_LIFECYCLE_WORKFLOW.initialState).toBe("pending");
  });

  it("has 5 transitions matching the permission grants", () => {
    if (PAYMENT_LIFECYCLE_WORKFLOW.kind !== "entityLifecycle") return;
    const names = PAYMENT_LIFECYCLE_WORKFLOW.transitions.map((t) => t.name).sort();
    expect(names).toEqual(["cancel", "capture", "fail", "refund", "settle"]);
  });

  it("refund can fire from captured or settled (both must be active)", () => {
    if (PAYMENT_LIFECYCLE_WORKFLOW.kind !== "entityLifecycle") return;
    const refund = PAYMENT_LIFECYCLE_WORKFLOW.transitions.find(
      (t) => t.name === "refund",
    );
    const froms = Array.isArray(refund?.from) ? refund?.from : [refund?.from];
    expect(froms?.sort()).toEqual(["captured", "settled"]);
  });

  it("declares two SLAs: pending→captured 1d, captured→settled 5d", () => {
    if (PAYMENT_LIFECYCLE_WORKFLOW.kind !== "entityLifecycle") return;
    expect(PAYMENT_LIFECYCLE_WORKFLOW.slas).toHaveLength(2);
    const deadlines = PAYMENT_LIFECYCLE_WORKFLOW.slas?.map((s) => s.deadline);
    expect(deadlines).toEqual(["P1D", "P5D"]);
  });

  it("settle and capture are automatic transitions (driven by webhooks / sweep)", () => {
    if (PAYMENT_LIFECYCLE_WORKFLOW.kind !== "entityLifecycle") return;
    const capture = PAYMENT_LIFECYCLE_WORKFLOW.transitions.find(
      (t) => t.name === "capture",
    );
    const settle = PAYMENT_LIFECYCLE_WORKFLOW.transitions.find(
      (t) => t.name === "settle",
    );
    expect(capture?.trigger?.kind).toBe("automatic");
    expect(settle?.trigger?.kind).toBe("automatic");
  });
});

describe("ERP_PAYMENTS_WORKFLOWS", () => {
  it("exposes payment_lifecycle", () => {
    expect(Object.keys(ERP_PAYMENTS_WORKFLOWS)).toEqual(["payment_lifecycle"]);
  });
});
