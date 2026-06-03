import { describe, expect, it } from "vitest";
import {
  ENCOUNTER_PERMISSIONS,
  ERP_HEALTHCARE_PERMISSIONS,
  OBSERVATION_PERMISSIONS,
  PATIENT_PERMISSIONS,
} from "./permissions.js";
import { ERP_HEALTHCARE_ROLES } from "./roles.js";

const KNOWN_ROLES = new Set(Object.keys(ERP_HEALTHCARE_ROLES));

describe("healthcare permissions", () => {
  it("covers exactly the three healthcare entities", () => {
    expect(Object.keys(ERP_HEALTHCARE_PERMISSIONS).sort()).toEqual([
      "Encounter",
      "Observation",
      "Patient",
    ]);
  });

  it("only grants roles that are declared in the pack", () => {
    for (const perms of Object.values(ERP_HEALTHCARE_PERMISSIONS)) {
      const buckets = [perms.list, perms.read, perms.create, perms.update, perms.delete];
      for (const bucket of buckets) {
        for (const role of bucket?.roles ?? []) {
          expect(KNOWN_ROLES.has(role)).toBe(true);
        }
      }
      for (const grant of Object.values(perms.transitions ?? {})) {
        for (const role of grant.roles ?? []) {
          expect(KNOWN_ROLES.has(role)).toBe(true);
        }
      }
    }
  });

  it("restricts PHI Observation writes to clinical staff", () => {
    expect(OBSERVATION_PERMISSIONS.create?.roles).toEqual(["clinical_admin", "clinician"]);
    expect(OBSERVATION_PERMISSIONS.delete?.roles).toEqual(["clinical_admin"]);
  });

  it("lets front desk schedule patients + encounters but not write observations", () => {
    expect(PATIENT_PERMISSIONS.create?.roles).toContain("front_desk");
    expect(ENCOUNTER_PERMISSIONS.create?.roles).toContain("front_desk");
    expect(OBSERVATION_PERMISSIONS.create?.roles).not.toContain("front_desk");
  });

  it("grants the four Encounter lifecycle transitions", () => {
    expect(Object.keys(ENCOUNTER_PERMISSIONS.transitions ?? {}).sort()).toEqual([
      "cancel",
      "check_in",
      "complete",
      "mark_no_show",
    ]);
  });
});
