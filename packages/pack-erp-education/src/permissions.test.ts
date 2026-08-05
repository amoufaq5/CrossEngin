import { describe, expect, it } from "vitest";
import {
  ENROLLMENT_PERMISSIONS,
  ERP_EDUCATION_PERMISSIONS,
} from "./permissions.js";
import { ERP_EDUCATION_ROLES } from "./roles.js";
import { ENROLLMENT_LIFECYCLE_WORKFLOW } from "./workflows.js";

const KNOWN_ROLES = new Set(Object.keys(ERP_EDUCATION_ROLES));

describe("education permissions", () => {
  it("covers exactly the three education entities", () => {
    expect(Object.keys(ERP_EDUCATION_PERMISSIONS).sort()).toEqual([
      "Course",
      "Enrollment",
      "Student",
    ]);
  });

  it("only grants roles declared in the pack", () => {
    for (const perms of Object.values(ERP_EDUCATION_PERMISSIONS)) {
      const buckets = [perms.list, perms.read, perms.create, perms.update, perms.delete];
      for (const bucket of buckets) {
        for (const role of bucket?.roles ?? []) expect(KNOWN_ROLES.has(role)).toBe(true);
      }
      for (const grant of Object.values(perms.transitions ?? {})) {
        for (const role of grant.roles ?? []) expect(KNOWN_ROLES.has(role)).toBe(true);
      }
      for (const fieldPerm of Object.values(perms.fields ?? {})) {
        for (const role of [...(fieldPerm.read?.roles ?? []), ...(fieldPerm.update?.roles ?? [])]) {
          expect(KNOWN_ROLES.has(role)).toBe(true);
        }
      }
    }
  });

  it("restricts grade writes to registrar + instructor (excludes the auditor)", () => {
    const gradeWrite = ENROLLMENT_PERMISSIONS.fields?.grade?.update?.roles ?? [];
    expect(gradeWrite).not.toContain("ferpa_auditor");
    expect(gradeWrite).toContain("registrar");
    expect(gradeWrite).toContain("instructor");
  });

  it("grants the four Enrollment lifecycle transitions", () => {
    expect(Object.keys(ENROLLMENT_PERMISSIONS.transitions ?? {}).sort()).toEqual([
      "activate",
      "complete",
      "fail",
      "withdraw",
    ]);
  });

  it("each guarded transition has a matching grant; withdraw is registrar-only", () => {
    const grants = ENROLLMENT_PERMISSIONS.transitions ?? {};
    for (const t of ENROLLMENT_LIFECYCLE_WORKFLOW.transitions) {
      const guarded = (t.guards ?? []).some(
        (g) => g.kind === "permission" && g.permission === `Enrollment.transition.${t.name}`,
      );
      if (guarded) expect(grants[t.name]).toBeDefined();
    }
    expect(grants["withdraw"]?.roles).toEqual(["edu_admin", "registrar"]);
  });
});
