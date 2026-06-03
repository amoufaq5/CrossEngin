import { EntitySchema } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";
import {
  ENCOUNTER_ENTITY,
  ERP_HEALTHCARE_ENTITIES,
  OBSERVATION_ENTITY,
  PATIENT_ENTITY,
} from "./entities.js";

describe("healthcare entities", () => {
  it("all parse against the kernel EntitySchema", () => {
    for (const e of ERP_HEALTHCARE_ENTITIES) {
      expect(() => EntitySchema.parse(e)).not.toThrow();
    }
  });

  it("are all on the auditable trait", () => {
    for (const e of ERP_HEALTHCARE_ENTITIES) {
      expect(e.traits).toContain("auditable");
    }
  });

  it("Patient references the core Account and has a unique MRN", () => {
    const account = PATIENT_ENTITY.fields.find((f) => f.name === "account_id");
    expect(account?.type).toEqual({ kind: "reference", target: "Account" });
    const mrn = PATIENT_ENTITY.fields.find((f) => f.name === "mrn");
    expect(mrn?.unique).toBe(true);
  });

  it("Encounter references Patient (required) and Invoice (optional, core)", () => {
    const patient = ENCOUNTER_ENTITY.fields.find((f) => f.name === "patient_id");
    expect(patient?.required).toBe(true);
    const invoice = ENCOUNTER_ENTITY.fields.find((f) => f.name === "invoice_id");
    expect(invoice?.type).toEqual({ kind: "reference", target: "Invoice" });
    expect(invoice?.required).toBeUndefined();
  });

  it("Observation references Encounter and carries a value + category", () => {
    const enc = OBSERVATION_ENTITY.fields.find((f) => f.name === "encounter_id");
    expect(enc?.required).toBe(true);
    expect(OBSERVATION_ENTITY.fields.some((f) => f.name === "value_quantity")).toBe(true);
    const category = OBSERVATION_ENTITY.fields.find((f) => f.name === "category");
    expect(category?.required).toBe(true);
  });

  it("Encounter.state enumerates the five lifecycle states", () => {
    const state = ENCOUNTER_ENTITY.fields.find((f) => f.name === "state");
    expect(state?.type).toMatchObject({
      kind: "enum",
      values: ["scheduled", "in_progress", "completed", "cancelled", "no_show"],
    });
  });

  it("classifies the MRN as PHI and demographics as PII", () => {
    expect(PATIENT_ENTITY.fields.find((f) => f.name === "mrn")?.classification).toBe("phi");
    expect(PATIENT_ENTITY.fields.find((f) => f.name === "date_of_birth")?.classification).toBe("pii");
    expect(PATIENT_ENTITY.fields.find((f) => f.name === "email")?.classification).toBe("pii");
  });

  it("classifies Observation clinical values as PHI", () => {
    expect(OBSERVATION_ENTITY.fields.find((f) => f.name === "value_quantity")?.classification).toBe("phi");
    expect(OBSERVATION_ENTITY.fields.find((f) => f.name === "value_text")?.classification).toBe("phi");
  });

  it("keeps every PHI-bearing entity on the auditable trait", () => {
    for (const e of ERP_HEALTHCARE_ENTITIES) {
      const hasPhi = e.fields.some((f) => f.classification === "phi");
      if (hasPhi) expect(e.traits).toContain("auditable");
    }
  });
});
