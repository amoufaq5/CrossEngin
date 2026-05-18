import type { EntityPermissions } from "@crossengin/auth";

const ALL_ROLES = [
  "erp_admin",
  "erp_clinician",
  "erp_front_desk",
  "erp_viewer",
];
const CLINICAL_WRITE_ROLES = ["erp_admin", "erp_clinician"];
const SCHEDULING_ROLES = ["erp_admin", "erp_clinician", "erp_front_desk"];
const ADMIN_ONLY = ["erp_admin"];

export const PATIENT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_ROLES },
  read: { roles: ALL_ROLES },
  create: { roles: SCHEDULING_ROLES },
  update: { roles: SCHEDULING_ROLES },
  delete: { roles: ADMIN_ONLY },
};

export const ENCOUNTER_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_ROLES },
  read: { roles: ALL_ROLES },
  create: { roles: SCHEDULING_ROLES },
  update: { roles: SCHEDULING_ROLES },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    check_in: { roles: SCHEDULING_ROLES },
    start: { roles: CLINICAL_WRITE_ROLES },
    complete: { roles: CLINICAL_WRITE_ROLES },
    cancel: { roles: SCHEDULING_ROLES },
    mark_no_show: { roles: SCHEDULING_ROLES },
  },
};

export const OBSERVATION_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_ROLES },
  read: { roles: ALL_ROLES },
  create: { roles: CLINICAL_WRITE_ROLES },
  update: { roles: CLINICAL_WRITE_ROLES },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    finalize: { roles: CLINICAL_WRITE_ROLES },
    amend: { roles: CLINICAL_WRITE_ROLES },
    mark_in_error: { roles: ADMIN_ONLY },
  },
};

export const ERP_HEALTHCARE_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  Patient: PATIENT_PERMISSIONS,
  Encounter: ENCOUNTER_PERMISSIONS,
  Observation: OBSERVATION_PERMISSIONS,
};
