import { describe, expect, it } from "vitest";
import {
  availableTransitions,
  canPerform,
  ENTITY_OPERATIONS,
  isFieldRedacted,
  isFieldWriteMasked,
  PermissionDecisionSetSchema,
} from "./permissions.js";

const now = "2026-05-13T10:00:00.000Z";

const decisions = PermissionDecisionSetSchema.parse({
  principalId: "u_1",
  evaluatedAt: now,
  entities: {
    Prescription: {
      operations: {
        list: { allowed: true },
        read: { allowed: true },
        create: { allowed: true },
        update: { allowed: false, reason: "role:technician cannot update" },
        delete: { allowed: false },
      },
      redactedFields: ["patient.ssn"],
      writeMaskedFields: ["status"],
      availableTransitions: ["verify"],
    },
  },
  instanceOverrides: [
    {
      entityName: "Prescription",
      instanceId: "p_42",
      verdict: {
        operations: {
          list: { allowed: true },
          read: { allowed: true },
          create: { allowed: false },
          update: { allowed: false },
          delete: { allowed: false, reason: "controlled substance" },
        },
        redactedFields: ["patient.ssn", "internal_notes"],
        writeMaskedFields: ["status", "qty"],
        availableTransitions: [],
      },
    },
  ],
});

describe("canPerform", () => {
  it("returns the entity verdict when no instance is given", () => {
    expect(canPerform(decisions, "Prescription", "read").allowed).toBe(true);
    expect(canPerform(decisions, "Prescription", "update").allowed).toBe(false);
  });

  it("uses the instance override when one matches", () => {
    expect(canPerform(decisions, "Prescription", "delete", "p_42").allowed).toBe(false);
    expect(canPerform(decisions, "Prescription", "delete", "p_42").reason).toBe(
      "controlled substance",
    );
  });

  it("falls back to entity verdict when instance has no override", () => {
    expect(canPerform(decisions, "Prescription", "read", "other").allowed).toBe(true);
  });

  it("rejects unknown entities", () => {
    const verdict = canPerform(decisions, "Unknown", "read");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/no permission entry/);
  });

  it("ENTITY_OPERATIONS lists list/read/create/update/delete", () => {
    expect(ENTITY_OPERATIONS).toEqual(["list", "read", "create", "update", "delete"]);
  });
});

describe("isFieldRedacted / isFieldWriteMasked", () => {
  it("entity-level redacted field returns true", () => {
    expect(isFieldRedacted(decisions, "Prescription", "patient.ssn")).toBe(true);
  });

  it("instance override adds extra redacted fields", () => {
    expect(isFieldRedacted(decisions, "Prescription", "internal_notes", "p_42")).toBe(true);
    expect(isFieldRedacted(decisions, "Prescription", "internal_notes")).toBe(false);
  });

  it("entity-level write-masked field returns true", () => {
    expect(isFieldWriteMasked(decisions, "Prescription", "status")).toBe(true);
  });

  it("instance override extends write mask", () => {
    expect(isFieldWriteMasked(decisions, "Prescription", "qty", "p_42")).toBe(true);
    expect(isFieldWriteMasked(decisions, "Prescription", "qty")).toBe(false);
  });
});

describe("availableTransitions", () => {
  it("returns entity transitions when no instance override", () => {
    expect(availableTransitions(decisions, "Prescription")).toEqual(["verify"]);
  });

  it("returns instance override transitions when one matches", () => {
    expect(availableTransitions(decisions, "Prescription", "p_42")).toEqual([]);
  });

  it("returns empty for an unknown entity", () => {
    expect(availableTransitions(decisions, "Unknown")).toEqual([]);
  });
});
