import { EntitySchema } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";
import {
  ERP_CONSTRUCTION_ENTITIES,
  PROJECT_ENTITY,
  SUBCONTRACTOR_ENTITY,
  WORK_ORDER_ENTITY,
} from "./entities.js";

describe("construction entities", () => {
  it("all parse against the kernel EntitySchema", () => {
    for (const e of ERP_CONSTRUCTION_ENTITIES) {
      expect(() => EntitySchema.parse(e)).not.toThrow();
    }
  });

  it("are all on the auditable trait", () => {
    for (const e of ERP_CONSTRUCTION_ENTITIES) {
      expect(e.traits).toContain("auditable");
    }
  });

  it("classifies the project budget as commercial_sensitive", () => {
    expect(PROJECT_ENTITY.fields.find((f) => f.name === "budget_amount")?.classification).toBe(
      "commercial_sensitive",
    );
    // the project code is NOT sensitive
    expect(PROJECT_ENTITY.fields.find((f) => f.name === "project_code")?.classification).toBeUndefined();
  });

  it("classifies the subcontractor contact email as PII and tax id as commercial_sensitive", () => {
    expect(SUBCONTRACTOR_ENTITY.fields.find((f) => f.name === "contact_email")?.classification).toBe(
      "pii",
    );
    expect(SUBCONTRACTOR_ENTITY.fields.find((f) => f.name === "tax_id")?.classification).toBe(
      "commercial_sensitive",
    );
  });

  it("Project references the core Account; WorkOrder references Project + Subcontractor", () => {
    expect(PROJECT_ENTITY.fields.find((f) => f.name === "account_id")?.type).toEqual({
      kind: "reference",
      target: "Account",
    });
    expect(WORK_ORDER_ENTITY.fields.find((f) => f.name === "project_id")?.type).toEqual({
      kind: "reference",
      target: "Project",
    });
    const sub = WORK_ORDER_ENTITY.fields.find((f) => f.name === "subcontractor_id");
    expect(sub?.type).toEqual({ kind: "reference", target: "Subcontractor" });
    expect(sub?.required).toBeUndefined();
  });

  it("does not require auditing for commercial_sensitive/pii (no phi/regulated)", () => {
    const classes = ERP_CONSTRUCTION_ENTITIES.flatMap((e) =>
      e.fields.map((f) => f.classification).filter((c) => c !== undefined),
    );
    expect(classes).not.toContain("phi");
    expect(classes).not.toContain("regulated");
  });
});
