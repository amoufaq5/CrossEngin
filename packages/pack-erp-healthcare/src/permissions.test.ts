import { EntityPermissionsSchema } from "@crossengin/auth";
import { describe, expect, it } from "vitest";

import {
  ENCOUNTER_PERMISSIONS,
  ERP_HEALTHCARE_PERMISSIONS,
  OBSERVATION_PERMISSIONS,
  PATIENT_PERMISSIONS,
} from "./permissions.js";

describe("PATIENT_PERMISSIONS", () => {
  it("parses against EntityPermissionsSchema", () => {
    expect(() => EntityPermissionsSchema.parse(PATIENT_PERMISSIONS)).not.toThrow();
  });

  it("only admins can delete a patient record (HIPAA tombstone discipline)", () => {
    expect(PATIENT_PERMISSIONS.delete?.roles).toEqual(["erp_admin"]);
  });

  it("front_desk + clinician can create + update patients", () => {
    expect(PATIENT_PERMISSIONS.create?.roles).toContain("erp_front_desk");
    expect(PATIENT_PERMISSIONS.create?.roles).toContain("erp_clinician");
    expect(PATIENT_PERMISSIONS.update?.roles).toContain("erp_front_desk");
  });
});

describe("ENCOUNTER_PERMISSIONS", () => {
  it("parses against EntityPermissionsSchema", () => {
    expect(() => EntityPermissionsSchema.parse(ENCOUNTER_PERMISSIONS)).not.toThrow();
  });

  it("declares all 5 lifecycle transitions", () => {
    expect(Object.keys(ENCOUNTER_PERMISSIONS.transitions ?? {}).sort()).toEqual([
      "cancel",
      "check_in",
      "complete",
      "mark_no_show",
      "start",
    ]);
  });

  it("start + complete are clinician-only writes (no front desk)", () => {
    const start = ENCOUNTER_PERMISSIONS.transitions?.["start"];
    expect(start?.roles).toContain("erp_clinician");
    expect(start?.roles).not.toContain("erp_front_desk");
    const complete = ENCOUNTER_PERMISSIONS.transitions?.["complete"];
    expect(complete?.roles).toContain("erp_clinician");
    expect(complete?.roles).not.toContain("erp_front_desk");
  });

  it("check_in is shared between clinical + scheduling roles", () => {
    const checkIn = ENCOUNTER_PERMISSIONS.transitions?.["check_in"];
    expect(checkIn?.roles).toContain("erp_front_desk");
    expect(checkIn?.roles).toContain("erp_clinician");
  });
});

describe("OBSERVATION_PERMISSIONS", () => {
  it("parses against EntityPermissionsSchema", () => {
    expect(() => EntityPermissionsSchema.parse(OBSERVATION_PERMISSIONS)).not.toThrow();
  });

  it("declares 3 transitions: finalize / amend / mark_in_error", () => {
    expect(Object.keys(OBSERVATION_PERMISSIONS.transitions ?? {}).sort()).toEqual([
      "amend",
      "finalize",
      "mark_in_error",
    ]);
  });

  it("only admins can mark_in_error (FHIR data-correction discipline)", () => {
    expect(OBSERVATION_PERMISSIONS.transitions?.["mark_in_error"]?.roles).toEqual(["erp_admin"]);
  });

  it("front_desk cannot create observations (clinical-only)", () => {
    expect(OBSERVATION_PERMISSIONS.create?.roles).not.toContain("erp_front_desk");
  });
});

describe("ERP_HEALTHCARE_PERMISSIONS", () => {
  it("registers exactly Patient, Encounter, Observation", () => {
    expect(Object.keys(ERP_HEALTHCARE_PERMISSIONS).sort()).toEqual([
      "Encounter",
      "Observation",
      "Patient",
    ]);
  });
});
