import { describe, expect, it } from "vitest";
import { ENCOUNTER_PERMISSIONS } from "./permissions.js";
import { ENCOUNTER_LIFECYCLE_WORKFLOW } from "./workflows.js";

describe("ENCOUNTER_LIFECYCLE_WORKFLOW", () => {
  it("is an entityLifecycle on Encounter.state", () => {
    expect(ENCOUNTER_LIFECYCLE_WORKFLOW.kind).toBe("entityLifecycle");
    expect(ENCOUNTER_LIFECYCLE_WORKFLOW.entity).toBe("Encounter");
    expect(ENCOUNTER_LIFECYCLE_WORKFLOW.stateField).toBe("state");
    expect(ENCOUNTER_LIFECYCLE_WORKFLOW.initialState).toBe("scheduled");
  });

  it("every transition target is a declared state", () => {
    const states = new Set(ENCOUNTER_LIFECYCLE_WORKFLOW.states.map((s) => s.name));
    for (const t of ENCOUNTER_LIFECYCLE_WORKFLOW.transitions) {
      expect(states.has(t.to)).toBe(true);
      const froms = Array.isArray(t.from) ? t.from : [t.from];
      for (const f of froms) expect(states.has(f)).toBe(true);
    }
  });

  it("each permission-guarded transition has a matching transition grant", () => {
    const grants = ENCOUNTER_PERMISSIONS.transitions ?? {};
    for (const t of ENCOUNTER_LIFECYCLE_WORKFLOW.transitions) {
      const guarded = (t.guards ?? []).some(
        (g) => g.kind === "permission" && g.permission === `Encounter.transition.${t.name}`,
      );
      if (guarded) {
        expect(grants[t.name]).toBeDefined();
      }
    }
  });

  it("marks no_show automatically (no user permission needed)", () => {
    const noShow = ENCOUNTER_LIFECYCLE_WORKFLOW.transitions.find((t) => t.name === "mark_no_show");
    expect(noShow?.trigger).toEqual({ kind: "automatic" });
  });

  it("declares a same-day completion SLA", () => {
    const sla = ENCOUNTER_LIFECYCLE_WORKFLOW.slas?.[0];
    expect(sla?.deadline).toBe("P1D");
    expect(sla?.to).toBe("completed");
  });
});
