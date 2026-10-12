import type { EntityPermissions } from "@crossengin/auth";

const ALL_GOV = ["gov_admin", "case_worker", "permit_officer", "gov_auditor"];
const CASE_WORKERS = ["gov_admin", "case_worker"];
const PERMIT_STAFF = ["gov_admin", "permit_officer"];
const ADMIN_ONLY = ["gov_admin"];
// Derived from CASE_WORKERS rather than restated, so the field reads stay a
// superset of the field writes by construction instead of by inspection.
const CASE_WORKERS_WITH_AUDIT = [...CASE_WORKERS, "gov_auditor"];

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
      read: { roles: CASE_WORKERS_WITH_AUDIT },
      update: { roles: ADMIN_ONLY },
      // Set once at registration, corrected only by an admin. Until this arm
      // existed one `update` list answered both moments, so narrowing the
      // correction to an admin also narrowed the create — and `case_worker`
      // held the entity's `create` grant while being refused on a `required`
      // field, making a Citizen nobody but an admin could register
      // (403 `explicit_update_grant`, reproduced live; ADR-0348).
      create: { roles: CASE_WORKERS },
    },
    contact_email: {
      read: { roles: CASE_WORKERS_WITH_AUDIT },
      update: { roles: CASE_WORKERS },
    },
    contact_phone: {
      read: { roles: CASE_WORKERS_WITH_AUDIT },
      update: { roles: CASE_WORKERS },
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
  // The case worker is excluded: an assessed fee is the permit office's revenue
  // figure, and a case worker reaches the Permit record for its status alone.
  fields: {
    fee_amount: {
      read: { roles: [...PERMIT_STAFF, "gov_auditor"] },
      update: { roles: PERMIT_STAFF },
    },
  },
};

export const ERP_GOVERNMENT_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  Citizen: CITIZEN_PERMISSIONS,
  Case: CASE_PERMISSIONS,
  Permit: PERMIT_PERMISSIONS,
};
