import type { RoleDefinition } from "@crossengin/auth";

export const ROLE_CONSTRUCTION_ADMIN: RoleDefinition = {
  name: "construction_admin",
  label: { en: "Construction Administrator" },
  description:
    "Full CRUD on projects, subcontractors, and work orders, including budgets and costs.",
};

export const ROLE_PROJECT_MANAGER: RoleDefinition = {
  name: "project_manager",
  label: { en: "Project Manager" },
  description:
    "Runs a project's lifecycle + work orders; sees budgets and cost estimates.",
};

export const ROLE_FOREMAN: RoleDefinition = {
  name: "foreman",
  label: { en: "Foreman" },
  description:
    "Schedules and updates work orders on site; reads projects but not their budget.",
};

export const ROLE_COST_ANALYST: RoleDefinition = {
  name: "cost_analyst",
  label: { en: "Cost Analyst" },
  description:
    "Read-only access to projects, work orders, and costs for reporting.",
};

export const ERP_CONSTRUCTION_ROLES: Readonly<Record<string, RoleDefinition>> = {
  construction_admin: ROLE_CONSTRUCTION_ADMIN,
  project_manager: ROLE_PROJECT_MANAGER,
  foreman: ROLE_FOREMAN,
  cost_analyst: ROLE_COST_ANALYST,
};
