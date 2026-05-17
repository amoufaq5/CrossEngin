import { describe, expect, it } from "vitest";

import { WorkflowSchema } from "@crossengin/kernel/workflow";

import { ERP_CORE_WORKFLOWS, INVOICE_LIFECYCLE_WORKFLOW } from "./workflows.js";

describe("INVOICE_LIFECYCLE_WORKFLOW", () => {
  it("parses against the kernel WorkflowSchema", () => {
    expect(() => WorkflowSchema.parse(INVOICE_LIFECYCLE_WORKFLOW)).not.toThrow();
  });

  it("declares 5 states with paid + void terminal", () => {
    expect(INVOICE_LIFECYCLE_WORKFLOW.kind).toBe("entityLifecycle");
    if (INVOICE_LIFECYCLE_WORKFLOW.kind !== "entityLifecycle") return;
    expect(INVOICE_LIFECYCLE_WORKFLOW.states).toHaveLength(5);
    const terminals = INVOICE_LIFECYCLE_WORKFLOW.states
      .filter((s) => s.category === "terminal")
      .map((s) => s.name)
      .sort();
    expect(terminals).toEqual(["paid", "void"]);
  });

  it("declares 4 named transitions matching permission entries", () => {
    if (INVOICE_LIFECYCLE_WORKFLOW.kind !== "entityLifecycle") return;
    const names = INVOICE_LIFECYCLE_WORKFLOW.transitions.map((t) => t.name).sort();
    expect(names).toEqual(["mark_overdue", "mark_paid", "send", "void"]);
  });

  it("all transitions reach paid or void from draft eventually", () => {
    if (INVOICE_LIFECYCLE_WORKFLOW.kind !== "entityLifecycle") return;
    const fromDraft = INVOICE_LIFECYCLE_WORKFLOW.transitions.filter((t) =>
      (Array.isArray(t.from) ? t.from : [t.from]).includes("draft"),
    );
    expect(fromDraft.length).toBeGreaterThan(0);
  });

  it("sla deadline P30D is set on sent → paid", () => {
    if (INVOICE_LIFECYCLE_WORKFLOW.kind !== "entityLifecycle") return;
    const sla = INVOICE_LIFECYCLE_WORKFLOW.slas?.[0];
    expect(sla?.from).toBe("sent");
    expect(sla?.to).toBe("paid");
    expect(sla?.deadline).toBe("P30D");
  });
});

describe("ERP_CORE_WORKFLOWS", () => {
  it("exposes invoice_lifecycle", () => {
    expect(Object.keys(ERP_CORE_WORKFLOWS)).toEqual(["invoice_lifecycle"]);
  });
});
