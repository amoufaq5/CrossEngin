import { describe, expect, it } from "vitest";
import {
  CASE_PERMISSIONS,
  CITIZEN_PERMISSIONS,
  ERP_GOVERNMENT_PERMISSIONS,
} from "./permissions.js";
import { ERP_GOVERNMENT_ROLES } from "./roles.js";
import { CASE_LIFECYCLE_WORKFLOW } from "./workflows.js";

const KNOWN_ROLES = new Set(Object.keys(ERP_GOVERNMENT_ROLES));

describe("government permissions", () => {
  it("covers exactly the three government entities", () => {
    expect(Object.keys(ERP_GOVERNMENT_PERMISSIONS).sort()).toEqual([
      "Case",
      "Citizen",
      "Permit",
    ]);
  });

  it("only grants roles declared in the pack", () => {
    for (const perms of Object.values(ERP_GOVERNMENT_PERMISSIONS)) {
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

  it("excludes the permit officer from reading the national id", () => {
    const idRead = CITIZEN_PERMISSIONS.fields?.national_id?.read?.roles ?? [];
    expect(idRead).not.toContain("permit_officer");
    expect(idRead).toContain("gov_auditor");
  });

  it("grants the four Case lifecycle transitions", () => {
    expect(Object.keys(CASE_PERMISSIONS.transitions ?? {}).sort()).toEqual([
      "approve",
      "close",
      "deny",
      "submit_for_review",
    ]);
  });

  it("each guarded transition has a matching grant; close is admin-only", () => {
    const grants = CASE_PERMISSIONS.transitions ?? {};
    for (const t of CASE_LIFECYCLE_WORKFLOW.transitions) {
      const guarded = (t.guards ?? []).some(
        (g) => g.kind === "permission" && g.permission === `Case.transition.${t.name}`,
      );
      if (guarded) expect(grants[t.name]).toBeDefined();
    }
    expect(grants["close"]?.roles).toEqual(["gov_admin"]);
  });
});
