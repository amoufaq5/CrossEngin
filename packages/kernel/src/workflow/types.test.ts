import { describe, expect, it } from "vitest";
import { WorkflowSchema } from "./types.js";

describe("WorkflowSchema — entityLifecycle", () => {
  it("parses a minimal valid workflow", () => {
    const w = {
      kind: "entityLifecycle" as const,
      entity: "Prescription",
      stateField: "status",
      states: [{ name: "pending" }, { name: "done", category: "terminal" as const }],
      initialState: "pending",
      transitions: [{ name: "complete", from: "pending", to: "done" }],
    };
    expect(() => WorkflowSchema.parse(w)).not.toThrow();
  });

  it("parses a transition with array-form 'from'", () => {
    const w = {
      kind: "entityLifecycle" as const,
      entity: "Prescription",
      stateField: "status",
      states: [
        { name: "pending" },
        { name: "verified" },
        { name: "cancelled", category: "terminal" as const },
      ],
      initialState: "pending",
      transitions: [{ name: "cancel", from: ["pending", "verified"], to: "cancelled" }],
    };
    expect(() => WorkflowSchema.parse(w)).not.toThrow();
  });

  it("parses guards and effects", () => {
    const w = {
      kind: "entityLifecycle" as const,
      entity: "Prescription",
      stateField: "status",
      states: [{ name: "pending" }, { name: "verified", category: "terminal" as const }],
      initialState: "pending",
      transitions: [
        {
          name: "verify",
          from: "pending",
          to: "verified",
          trigger: { kind: "userAction" as const },
          guards: [
            { kind: "permission" as const, permission: "prescription.transitions.verify" },
            { kind: "rego" as const, rego: "data.x.allow" },
          ],
          preEffects: [{ kind: "requireESignature", method: "totp" }],
          postEffects: [{ kind: "audit", event: "prescriptionVerified" }],
        },
      ],
    };
    expect(() => WorkflowSchema.parse(w)).not.toThrow();
  });

  it("rejects unknown trigger kind", () => {
    const w = {
      kind: "entityLifecycle" as const,
      entity: "Prescription",
      stateField: "status",
      states: [{ name: "x", category: "terminal" as const }],
      initialState: "x",
      transitions: [{ name: "t", from: "x", to: "x", trigger: { kind: "magicWand" } }],
    };
    expect(() => WorkflowSchema.parse(w)).toThrow();
  });

  it("rejects empty states array", () => {
    const w = {
      kind: "entityLifecycle" as const,
      entity: "Prescription",
      stateField: "status",
      states: [],
      initialState: "x",
      transitions: [],
    };
    expect(() => WorkflowSchema.parse(w)).toThrow();
  });
});

describe("WorkflowSchema — orchestration", () => {
  it("parses a minimal orchestration", () => {
    const w = {
      kind: "orchestration" as const,
      steps: [{ id: "review", kind: "humanTask" }],
    };
    expect(() => WorkflowSchema.parse(w)).not.toThrow();
  });
});

describe("WorkflowSchema — scheduled", () => {
  it("parses a cron-scheduled workflow", () => {
    const w = {
      kind: "scheduled" as const,
      schedule: "0 6 * * * Asia/Dubai",
      action: { kind: "runJob", job: "dailyExpiryCheck" },
    };
    expect(() => WorkflowSchema.parse(w)).not.toThrow();
  });

  it("parses an event-triggered + delayed workflow", () => {
    const w = {
      kind: "scheduled" as const,
      trigger: {
        kind: "event" as const,
        name: "vaccinationDoseAdministered",
        filter: "$event.doseNumber == 1",
      },
      delay: "P28D",
      action: { kind: "notify", template: "doseTwoReminder" },
    };
    expect(() => WorkflowSchema.parse(w)).not.toThrow();
  });
});
