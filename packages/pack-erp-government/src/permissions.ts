import type { EntityPermissions } from "@crossengin/auth";

const ALL_GOV = ["gov_admin", "case_worker", "permit_officer", "gov_auditor"];
const CASE_WORKERS = ["gov_admin", "case_worker"];
const PERMIT_STAFF = ["gov_admin", "permit_officer"];
const ADMIN_ONLY = ["gov_admin"];

export const CITIZEN_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_GOV },
  read: { roles: ALL_GOV },
  create: { roles: CASE_WORKERS },
  update: { roles: CASE_WORKERS },
  delete: { roles: ADMIN_ONLY },
  // The classification default already redacts the regulated national_id; this
  // explicit grant documents that admins, case workers, and auditors may read it
  // (the permit officer is deliberately excluded).
  fields: {
    national_id: {
      read: { roles: ["gov_admin", "case_worker", "gov_auditor"] },
      update: { roles: ADMIN_ONLY },
    },
  },
};

export const CASE_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_GOV },
  read: { roles: ALL_GOV },
  create: { roles: CASE_WORKERS },
  update: { roles: CASE_WORKERS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    submit_for_review: { roles: CASE_WORKERS },
    approve: { roles: CASE_WORKERS },
    deny: { roles: CASE_WORKERS },
    close: { roles: ADMIN_ONLY },
  },
};

export const PERMIT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_GOV },
  read: { roles: ALL_GOV },
  create: { roles: PERMIT_STAFF },
  update: { roles: PERMIT_STAFF },
  delete: { roles: ADMIN_ONLY },
};

export const ERP_GOVERNMENT_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  Citizen: CITIZEN_PERMISSIONS,
  Case: CASE_PERMISSIONS,
  Permit: PERMIT_PERMISSIONS,
};
