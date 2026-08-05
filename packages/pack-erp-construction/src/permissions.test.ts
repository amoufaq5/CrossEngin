import { describe, expect, it } from "vitest";
import {
  ERP_CONSTRUCTION_PERMISSIONS,
  PROJECT_PERMISSIONS,
  WORK_ORDER_PERMISSIONS,
} from "./permissions.js";
import { ERP_CONSTRUCTION_ROLES } from "./roles.js";
import { PROJECT_LIFECYCLE_WORKFLOW } from "./workflows.js";

const KNOWN_ROLES = new Set(Object.keys(ERP_CONSTRUCTION_ROLES));

describe("construction permissions", () => {
  it("covers exactly the three construction entities", () => {
    expect(Object.keys(ERP_CONSTRUCTION_PERMISSIONS).sort()).toEqual([
      "Project",
      "Subcontractor",
      "WorkOrder",
    ]);
  });

  it("only grants roles declared in the pack", () => {
    for (const perms of Object.values(ERP_CONSTRUCTION_PERMISSIONS)) {
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

  it("excludes the foreman from reading the project budget and work-order cost", () => {
    const budgetRead = PROJECT_PERMISSIONS.fields?.budget_amount?.read?.roles ?? [];
    expect(budgetRead).not.toContain("foreman");
    expect(budgetRead).toContain("cost_analyst");
    const costRead = WORK_ORDER_PERMISSIONS.fields?.cost_estimate?.read?.roles ?? [];
    expect(costRead).not.toContain("foreman");
    expect(costRead).toContain("project_manager");
  });

  it("grants the five Project lifecycle transitions", () => {
    expect(Object.keys(PROJECT_PERMISSIONS.transitions ?? {}).sort()).toEqual([
      "cancel",
      "complete",
      "hold",
      "resume",
      "start_work",
    ]);
  });

  it("each guarded transition has a matching grant; cancel is admin-only", () => {
    const grants = PROJECT_PERMISSIONS.transitions ?? {};
    for (const t of PROJECT_LIFECYCLE_WORKFLOW.transitions) {
      const guarded = (t.guards ?? []).some(
        (g) => g.kind === "permission" && g.permission === `Project.transition.${t.name}`,
      );
      if (guarded) expect(grants[t.name]).toBeDefined();
    }
    expect(grants["cancel"]?.roles).toEqual(["construction_admin"]);
  });
});
