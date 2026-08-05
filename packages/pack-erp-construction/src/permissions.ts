import type { EntityPermissions } from "@crossengin/auth";

const ALL_CONSTRUCTION = [
  "construction_admin",
  "project_manager",
  "foreman",
  "cost_analyst",
];
const MANAGERS = ["construction_admin", "project_manager"];
const FIELD_CREW = ["construction_admin", "project_manager", "foreman"];
const ADMIN_ONLY = ["construction_admin"];
const COST_READERS = ["construction_admin", "project_manager", "cost_analyst"];

export const PROJECT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_CONSTRUCTION },
  read: { roles: ALL_CONSTRUCTION },
  create: { roles: MANAGERS },
  update: { roles: MANAGERS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    start_work: { roles: MANAGERS },
    hold: { roles: MANAGERS },
    resume: { roles: MANAGERS },
    complete: { roles: MANAGERS },
    cancel: { roles: ADMIN_ONLY },
  },
  // The classification default already redacts budget_amount from a foreman; this
  // explicit grant documents that managers + cost analysts may read the budget.
  fields: {
    budget_amount: {
      read: { roles: COST_READERS },
      update: { roles: MANAGERS },
    },
  },
};

export const SUBCONTRACTOR_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_CONSTRUCTION },
  read: { roles: ALL_CONSTRUCTION },
  create: { roles: MANAGERS },
  update: { roles: MANAGERS },
  delete: { roles: ADMIN_ONLY },
  fields: {
    tax_id: {
      read: { roles: COST_READERS },
      update: { roles: MANAGERS },
    },
  },
};

export const WORK_ORDER_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_CONSTRUCTION },
  read: { roles: ALL_CONSTRUCTION },
  create: { roles: FIELD_CREW },
  update: { roles: FIELD_CREW },
  delete: { roles: MANAGERS },
  fields: {
    cost_estimate: {
      read: { roles: COST_READERS },
      update: { roles: MANAGERS },
    },
  },
};

export const ERP_CONSTRUCTION_PERMISSIONS: Readonly<
  Record<string, EntityPermissions>
> = {
  Project: PROJECT_PERMISSIONS,
  Subcontractor: SUBCONTRACTOR_PERMISSIONS,
  WorkOrder: WORK_ORDER_PERMISSIONS,
};
