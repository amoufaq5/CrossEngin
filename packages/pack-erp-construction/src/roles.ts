import type { RoleDefinition } from "@crossengin/auth";

export const ROLE_CONSTRUCTION_ADMIN: RoleDefinition = {
  name: "construction_admin",
  label: { en: "Construction Administrator" },
  description: "Full CRUD on projects, cost codes, change orders, and logs, including contract values.",
};

export const ROLE_PROJECT_MANAGER: RoleDefinition = {
  name: "project_manager",
  label: { en: "Project Manager" },
  description: "Manages a project's lifecycle, budgets, and change orders; sees the contract value.",
};

export const ROLE_SITE_SUPERVISOR: RoleDefinition = {
  name: "site_supervisor",
  label: { en: "Site Supervisor" },
  description: "Files daily logs and reads project info, but not the negotiated contract value.",
};

export const ROLE_ESTIMATOR: RoleDefinition = {
  name: "estimator",
  label: { en: "Estimator" },
  description: "Reads projects + cost codes for estimating and reporting; sees the contract value.",
};

export const ERP_CONSTRUCTION_ROLES: Readonly<Record<string, RoleDefinition>> = {
  construction_admin: ROLE_CONSTRUCTION_ADMIN,
  project_manager: ROLE_PROJECT_MANAGER,
  site_supervisor: ROLE_SITE_SUPERVISOR,
  estimator: ROLE_ESTIMATOR,
};
