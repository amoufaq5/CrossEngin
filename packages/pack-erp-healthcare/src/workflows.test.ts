import { WorkflowSchema } from "@crossengin/kernel/workflow";
import { describe, expect, it } from "vitest";

import {
  ENCOUNTER_LIFECYCLE_WORKFLOW,
  ERP_HEALTHCARE_WORKFLOWS,
  OBSERVATION_LIFECYCLE_WORKFLOW,
} from "./workflows.js";

describe("ENCOUNTER_LIFECYCLE_WORKFLOW", () => {
  it("parses against WorkflowSchema", () => {
    expect(() => WorkflowSchema.parse(ENCOUNTER_LIFECYCLE_WORKFLOW)).not.toThrow();
  });

  it("has exactly 6 states: scheduled / checked_in / in_progress + 3 terminals", () => {
    const wf = ENCOUNTER_LIFECYCLE_WORKFLOW;
    if (wf.kind !== "entityLifecycle") throw new Error("not entityLifecycle");
    expect(wf.states).toHaveLength(6);
    const terminals = wf.states
      .filter((s) => s.category === "terminal")
      .map((s) => s.name)
      .sort();
    expect(terminals).toEqual(["cancelled", "completed", "no_show"]);
    expect(wf.initialState).toBe("scheduled");
  });

  it("only no_show transition is automatic (used by the sweep job)", () => {
    const wf = ENCOUNTER_LIFECYCLE_WORKFLOW;
    if (wf.kind !== "entityLifecycle") throw new Error("not entityLifecycle");
    const automatic = wf.transitions.filter((t) => t.trigger?.kind === "automatic");
    expect(automatic.map((t) => t.name)).toEqual(["mark_no_show"]);
  });

  it("cancel reachable from both scheduled and checked_in", () => {
    const wf = ENCOUNTER_LIFECYCLE_WORKFLOW;
    if (wf.kind !== "entityLifecycle") throw new Error("not entityLifecycle");
    const cancel = wf.transitions.find((t) => t.name === "cancel");
    expect(cancel?.from).toEqual(["scheduled", "checked_in"]);
  });

  it("every transition that needs permission carries a permission guard", () => {
    const wf = ENCOUNTER_LIFECYCLE_WORKFLOW;
    if (wf.kind !== "entityLifecycle") throw new Error("not entityLifecycle");
    for (const t of wf.transitions) {
      const hasPermission = (t.guards ?? []).some((g) => g.kind === "permission");
      expect(hasPermission).toBe(true);
    }
  });

  it("declares 2 SLAs (checked_in→in_progress 30m + in_progress→completed P1D)", () => {
    const wf = ENCOUNTER_LIFECYCLE_WORKFLOW;
    if (wf.kind !== "entityLifecycle") throw new Error("not entityLifecycle");
    expect(wf.slas).toHaveLength(2);
    const deadlines = (wf.slas ?? []).map((s) => s.deadline).sort();
    expect(deadlines).toEqual(["P1D", "PT30M"]);
  });
});

describe("OBSERVATION_LIFECYCLE_WORKFLOW", () => {
  it("parses against WorkflowSchema", () => {
    expect(() => WorkflowSchema.parse(OBSERVATION_LIFECYCLE_WORKFLOW)).not.toThrow();
  });

  it("uses Observation.status as the state field", () => {
    const wf = OBSERVATION_LIFECYCLE_WORKFLOW;
    if (wf.kind !== "entityLifecycle") throw new Error("not entityLifecycle");
    expect(wf.entity).toBe("Observation");
    expect(wf.stateField).toBe("status");
    expect(wf.initialState).toBe("preliminary");
  });

  it("entered_in_error is the only terminal state (FHIR amendment discipline)", () => {
    const wf = OBSERVATION_LIFECYCLE_WORKFLOW;
    if (wf.kind !== "entityLifecycle") throw new Error("not entityLifecycle");
    const terminals = wf.states
      .filter((s) => s.category === "terminal")
      .map((s) => s.name);
    expect(terminals).toEqual(["entered_in_error"]);
  });

  it("amend transitions from final back to amended (loop allowed)", () => {
    const wf = OBSERVATION_LIFECYCLE_WORKFLOW;
    if (wf.kind !== "entityLifecycle") throw new Error("not entityLifecycle");
    const amend = wf.transitions.find((t) => t.name === "amend");
    expect(amend?.from).toEqual(["final", "amended"]);
    expect(amend?.to).toBe("amended");
  });

  it("mark_in_error reachable from any non-terminal state", () => {
    const wf = OBSERVATION_LIFECYCLE_WORKFLOW;
    if (wf.kind !== "entityLifecycle") throw new Error("not entityLifecycle");
    const markErr = wf.transitions.find((t) => t.name === "mark_in_error");
    expect(markErr?.from).toEqual(["preliminary", "final", "amended"]);
  });
});

describe("ERP_HEALTHCARE_WORKFLOWS", () => {
  it("registers encounter_lifecycle + observation_lifecycle", () => {
    expect(Object.keys(ERP_HEALTHCARE_WORKFLOWS).sort()).toEqual([
      "encounter_lifecycle",
      "observation_lifecycle",
    ]);
  });
});
