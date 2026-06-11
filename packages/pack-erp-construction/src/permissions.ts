import type { EntityPermissions } from "@crossengin/auth";

const ALL = ["construction_admin", "project_manager", "site_supervisor", "estimator"];
const MANAGERS = ["construction_admin", "project_manager"];
const COST_ROLES = ["construction_admin", "project_manager", "estimator"];
const FIELD_ROLES = ["construction_admin", "project_manager", "estimator"];
const LOGGERS = ["construction_admin", "project_manager", "site_supervisor"];
const ADMIN_ONLY = ["construction_admin"];

export const PROJECT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL },
  read: { roles: ALL },
  create: { roles: MANAGERS },
  update: { roles: MANAGERS },
  delete: { roles: ADMIN_ONLY },
  // The classification default already redacts contract_value from a site
  // supervisor; this explicit grant documents who may read it.
  fields: {
    contract_value: {
      read: { roles: FIELD_ROLES },
      update: { roles: MANAGERS },
    },
  },
  transitions: {
    start: { roles: MANAGERS },
    hold: { roles: MANAGERS },
    resume: { roles: MANAGERS },
    complete: { roles: MANAGERS },
    cancel: { roles: ADMIN_ONLY },
  },
};

export const COST_CODE_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL },
  read: { roles: ALL },
  create: { roles: COST_ROLES },
  update: { roles: COST_ROLES },
  delete: { roles: MANAGERS },
};

export const CHANGE_ORDER_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL },
  read: { roles: ALL },
  create: { roles: MANAGERS },
  update: { roles: MANAGERS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    // Separation of duties: a PM submits, but only an admin approves/rejects.
    submit: { roles: MANAGERS },
    approve: { roles: ADMIN_ONLY },
    reject: { roles: ADMIN_ONLY },
  },
};

export const DAILY_LOG_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL },
  read: { roles: ALL },
  create: { roles: LOGGERS },
  update: { roles: LOGGERS },
  delete: { roles: MANAGERS },
};

export const ERP_CONSTRUCTION_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  Project: PROJECT_PERMISSIONS,
  CostCode: COST_CODE_PERMISSIONS,
  ChangeOrder: CHANGE_ORDER_PERMISSIONS,
  DailyLog: DAILY_LOG_PERMISSIONS,
};
