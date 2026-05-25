import { EntitySchema } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  BLOOD_TYPES,
  ENCOUNTER_CLASSES,
  ENCOUNTER_ENTITY,
  ERP_HEALTHCARE_ENTITIES,
  OBSERVATION_CODE_SYSTEMS,
  OBSERVATION_ENTITY,
  OBSERVATION_STATUSES,
  PATIENT_ENTITY,
  SEX_ASSIGNED_AT_BIRTH,
} from "./entities.js";

describe("PATIENT_ENTITY", () => {
  it("parses against EntitySchema", () => {
    expect(() => EntitySchema.parse(PATIENT_ENTITY)).not.toThrow();
  });

  it("uses both auditable and tenant_owned traits", () => {
    expect(PATIENT_ENTITY.traits).toContain("auditable");
    expect(PATIENT_ENTITY.traits).toContain("tenant_owned");
  });

  it("references Account + Contact from pack-erp-core", () => {
    const acct = PATIENT_ENTITY.fields.find((f) => f.name === "account_id");
    if (acct?.type.kind !== "reference") throw new Error("account_id not a reference");
    expect(acct.type.target).toBe("Account");
    const contact = PATIENT_ENTITY.fields.find((f) => f.name === "contact_id");
    if (contact?.type.kind !== "reference") throw new Error("contact_id not a reference");
    expect(contact.type.target).toBe("Contact");
  });

  it("mrn is unique within an account_id scope", () => {
    const f = PATIENT_ENTITY.fields.find((f) => f.name === "mrn");
    if (typeof f?.unique !== "object" || f.unique === null) {
      throw new Error("mrn unique scope missing");
    }
    expect(f.unique.scope).toEqual(["account_id"]);
  });

  it("sex_assigned_at_birth includes the four documented options", () => {
    expect([...SEX_ASSIGNED_AT_BIRTH].sort()).toEqual(["female", "intersex", "male", "unknown"]);
  });

  it("blood_type covers the standard 8 + unknown", () => {
    expect(BLOOD_TYPES).toHaveLength(9);
    expect(BLOOD_TYPES).toContain("o_pos");
    expect(BLOOD_TYPES).toContain("unknown");
  });
});

describe("ENCOUNTER_ENTITY", () => {
  it("parses against EntitySchema", () => {
    expect(() => EntitySchema.parse(ENCOUNTER_ENTITY)).not.toThrow();
  });

  it("references Patient", () => {
    const f = ENCOUNTER_ENTITY.fields.find((f) => f.name === "patient_id");
    if (f?.type.kind !== "reference") throw new Error("patient_id not a reference");
    expect(f.type.target).toBe("Patient");
    expect(f.required).toBe(true);
  });

  it("state enum matches the documented 6-state lifecycle", () => {
    const f = ENCOUNTER_ENTITY.fields.find((f) => f.name === "state");
    if (f?.type.kind !== "enum") throw new Error("state not an enum");
    expect([...f.type.values].sort()).toEqual([
      "cancelled",
      "checked_in",
      "completed",
      "in_progress",
      "no_show",
      "scheduled",
    ]);
  });

  it("encounter_class covers ambulatory + emergency + inpatient + telephone + virtual + home", () => {
    expect(ENCOUNTER_CLASSES).toHaveLength(6);
    expect(ENCOUNTER_CLASSES).toContain("emergency");
    expect(ENCOUNTER_CLASSES).toContain("virtual");
  });

  it("indexes scheduled_at + (state, scheduled_at)", () => {
    const scheduledField = ENCOUNTER_ENTITY.fields.find((f) => f.name === "scheduled_at");
    expect(scheduledField?.indexed).toBe(true);
    const idx = ENCOUNTER_ENTITY.indexes ?? [];
    expect(idx.some((i) => i.fields.includes("state") && i.fields.includes("scheduled_at"))).toBe(
      true,
    );
  });
});

describe("OBSERVATION_ENTITY", () => {
  it("parses against EntitySchema", () => {
    expect(() => EntitySchema.parse(OBSERVATION_ENTITY)).not.toThrow();
  });

  it("references Encounter + Patient (patient denormalized for cross-encounter queries)", () => {
    const enc = OBSERVATION_ENTITY.fields.find((f) => f.name === "encounter_id");
    if (enc?.type.kind !== "reference") throw new Error("encounter_id not a reference");
    expect(enc.type.target).toBe("Encounter");
    const pat = OBSERVATION_ENTITY.fields.find((f) => f.name === "patient_id");
    if (pat?.type.kind !== "reference") throw new Error("patient_id not a reference");
    expect(pat.type.target).toBe("Patient");
  });

  it("code_system covers LOINC / SNOMED / ICD-10 / custom", () => {
    expect(OBSERVATION_CODE_SYSTEMS).toEqual(["loinc", "snomed_ct", "icd10", "custom"]);
  });

  it("status enum is the FHIR-standard 4 (preliminary / final / amended / entered_in_error)", () => {
    expect([...OBSERVATION_STATUSES].sort()).toEqual([
      "amended",
      "entered_in_error",
      "final",
      "preliminary",
    ]);
  });

  it("value_quantity is decimal(18,6) — wide enough for lab results across unit systems", () => {
    const f = OBSERVATION_ENTITY.fields.find((f) => f.name === "value_quantity");
    if (f?.type.kind !== "decimal") throw new Error("value_quantity not decimal");
    expect(f.type.precision).toBe(18);
    expect(f.type.scale).toBe(6);
  });
});

describe("ERP_HEALTHCARE_ENTITIES", () => {
  it("exports exactly Patient, Encounter, Observation in that order", () => {
    expect(ERP_HEALTHCARE_ENTITIES.map((e) => e.name)).toEqual([
      "Patient",
      "Encounter",
      "Observation",
    ]);
  });
});
