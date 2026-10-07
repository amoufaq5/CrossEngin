import { FIELD_WRITE_OPERATIONS, fieldWriteGrant, type FieldPermission } from "@crossengin/auth";
import { isFieldSensitive } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";
import { ERP_HEALTHCARE_ENTITIES } from "./entities.js";
import {
  ENCOUNTER_PERMISSIONS,
  ERP_HEALTHCARE_PERMISSIONS,
  OBSERVATION_PERMISSIONS,
  PATIENT_PERMISSIONS,
} from "./permissions.js";
import { ERP_HEALTHCARE_ROLES } from "./roles.js";

const KNOWN_ROLES = new Set(Object.keys(ERP_HEALTHCARE_ROLES));

/**
 * The sensitive-classified fields, derived from the entity declarations rather than listed, so a
 * classified field added later lands in these assertions instead of slipping past a stale list.
 */
const SENSITIVE_FIELDS = ERP_HEALTHCARE_ENTITIES.flatMap((entity) =>
  entity.fields
    .filter(isFieldSensitive)
    .map((field) => ({ entity: entity.name, field: field.name, required: field.required === true })),
);

/** Every declared field grant, keyed back to its entity. */
const DECLARED_FIELD_GRANTS = Object.entries(ERP_HEALTHCARE_PERMISSIONS).flatMap(
  ([entity, perms]) =>
    Object.entries((perms.fields ?? {}) as Record<string, FieldPermission>).map(
      ([field, perm]) => ({ entity, field, perm }),
    ),
);

function entityGrant(entity: string, op: "read" | "create" | "update"): readonly string[] {
  return ERP_HEALTHCARE_PERMISSIONS[entity]?.[op]?.roles ?? [];
}

function fieldPermFor(entity: string, field: string): FieldPermission | undefined {
  return (ERP_HEALTHCARE_PERMISSIONS[entity]?.fields ?? {})[field];
}

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

describe("healthcare per-field grants", () => {
  it("declares read and update for every sensitive-classified field", () => {
    // A floor, so a filter that stopped matching fails here rather than passing on an empty set.
    expect(SENSITIVE_FIELDS.length).toBe(10);
    for (const { entity, field } of SENSITIVE_FIELDS) {
      const perm = fieldPermFor(entity, field);
      expect(perm, `${entity}.${field} has no field grant`).toBeDefined();
      expect(perm?.read?.roles, `${entity}.${field}.read`).toBeDefined();
      expect(perm?.update?.roles, `${entity}.${field}.update`).toBeDefined();
    }
  });

  it("R2: update is a subset of read — no role may blind-overwrite", () => {
    expect(DECLARED_FIELD_GRANTS.length).toBeGreaterThanOrEqual(10);
    for (const { entity, field, perm } of DECLARED_FIELD_GRANTS) {
      const readable = new Set(perm.read?.roles ?? []);
      for (const role of perm.update?.roles ?? []) {
        expect(readable.has(role), `${entity}.${field}: ${role} may update but not read`).toBe(true);
      }
    }
  });

  it("R3: no field grant exceeds its entity grant", () => {
    for (const { entity, field, perm } of DECLARED_FIELD_GRANTS) {
      for (const role of perm.read?.roles ?? []) {
        const allowed = new Set(entityGrant(entity, "read"));
        expect(allowed.has(role), `${entity}.${field}.read: ${role} cannot read the record`).toBe(
          true,
        );
      }
      for (const op of FIELD_WRITE_OPERATIONS) {
        const allowed = new Set(entityGrant(entity, op));
        for (const role of fieldWriteGrant(perm, op)?.roles ?? []) {
          expect(allowed.has(role), `${entity}.${field}.${op}: ${role} cannot ${op}`).toBe(true);
        }
      }
    }
  });

  it("R1: a required classified field is creatable by every role holding entity create", () => {
    const required = SENSITIVE_FIELDS.filter((f) => f.required);
    expect(required.length).toBe(5);
    for (const { entity, field } of required) {
      const creators = new Set(fieldWriteGrant(fieldPermFor(entity, field), "create")?.roles ?? []);
      for (const role of entityGrant(entity, "create")) {
        expect(
          creators.has(role),
          `${entity} is uncreatable by ${role}: required field ${field} is not theirs to set`,
        ).toBe(true);
      }
    }
  });

  it("lets the front desk set an MRN once, never read it and never change it", () => {
    const mrn = fieldPermFor("Patient", "mrn");
    expect(fieldWriteGrant(mrn, "create")?.roles).toContain("front_desk");
    expect(fieldWriteGrant(mrn, "update")?.roles).not.toContain("front_desk");
    expect(mrn?.read?.roles).not.toContain("front_desk");
  });

  it("gives Patient.sex the same set-once shape", () => {
    const sex = fieldPermFor("Patient", "sex");
    expect(fieldWriteGrant(sex, "create")?.roles).toContain("front_desk");
    expect(fieldWriteGrant(sex, "update")?.roles).not.toContain("front_desk");
    expect(sex?.read?.roles).not.toContain("front_desk");
  });

  it("keeps the front desk on both arms of the demographics it works from", () => {
    for (const field of ["given_name", "family_name", "date_of_birth", "email", "phone"]) {
      const perm = fieldPermFor("Patient", field);
      expect(perm?.read?.roles, field).toContain("front_desk");
      expect(fieldWriteGrant(perm, "update")?.roles, field).toContain("front_desk");
    }
  });

  it("only grants roles that are declared in the pack", () => {
    for (const { perm } of DECLARED_FIELD_GRANTS) {
      for (const grant of [perm.read, perm.update, perm.create]) {
        for (const role of grant?.roles ?? []) expect(KNOWN_ROLES.has(role)).toBe(true);
      }
    }
  });
});
